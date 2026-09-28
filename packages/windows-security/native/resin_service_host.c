// Resin service host for the per-user Windows Scheduled Task.
//
// Task Scheduler starts this windowless (/SUBSYSTEM:WINDOWS) program at logon.
// It starts the Resin service supervisor (node.exe <cli> __service-supervisor
// ...) without a console window, inside a Job object that kills every process
// in the tree when the job handle closes. Ending the task terminates this host,
// which closes the handle, so the supervisor, the daemon and everything they
// spawned stop with it. The host waits for the supervisor: a clean exit (0,
// which includes a tripped circuit breaker) ends the host with exit code 0; a
// failure is restarted after --restart-delay-seconds (default 60), at most
// --restart-limit times (default 999; reset after ten minutes of uptime), and
// then the host exits with the supervisor's exit code.
//
// The runtime also uses it to replay learned programs (--restart-limit 0
// --inherit-stdio): the program's whole tree lives in the job, so killing the
// host at the time budget stops descendants that a parent-PID walk cannot see
// (for example MSYS children of Git Bash).
//
// Usage:
//   resin-service-host.exe [--stdout <file>] [--stderr <file>] [--inherit-stdio]
//       [--env NAME=VALUE]... [--path-prepend <dir>] [--cwd <dir>]
//       [--restart-delay-seconds <n>] [--restart-limit <n>]
//       -- <program> [args...]

#define WIN32_LEAN_AND_MEAN
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <shellapi.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#pragma comment(lib, "kernel32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "user32.lib")

// Exit codes reserved for failures of the host itself.
#define HOST_EXIT_USAGE 0x52450001
#define HOST_EXIT_SETUP 0x52450002
#define HOST_EXIT_SPAWN 0x52450003

typedef struct {
  wchar_t* data;
  size_t length;
  size_t capacity;
} wide_buffer;

static int buffer_reserve(wide_buffer* buffer, size_t extra) {
  size_t needed = buffer->length + extra + 1;
  if (needed <= buffer->capacity) return 1;
  size_t capacity = buffer->capacity == 0 ? 256 : buffer->capacity;
  while (capacity < needed) capacity *= 2;
  wchar_t* grown = (wchar_t*)realloc(buffer->data, capacity * sizeof(wchar_t));
  if (!grown) return 0;
  buffer->data = grown;
  buffer->capacity = capacity;
  return 1;
}

static int buffer_append_char(wide_buffer* buffer, wchar_t ch, size_t count) {
  if (!buffer_reserve(buffer, count)) return 0;
  for (size_t i = 0; i < count; i++) buffer->data[buffer->length++] = ch;
  buffer->data[buffer->length] = L'\0';
  return 1;
}

// Quotes one argument so CommandLineToArgvW and the MSVC runtime (node.exe)
// read it back unchanged.
static int append_quoted_argument(wide_buffer* buffer, const wchar_t* argument) {
  if (buffer->length > 0 && !buffer_append_char(buffer, L' ', 1)) return 0;
  if (argument[0] != L'\0' && wcspbrk(argument, L" \t\n\v\"") == NULL) {
    size_t length = wcslen(argument);
    if (!buffer_reserve(buffer, length)) return 0;
    memcpy(buffer->data + buffer->length, argument, length * sizeof(wchar_t));
    buffer->length += length;
    buffer->data[buffer->length] = L'\0';
    return 1;
  }
  if (!buffer_append_char(buffer, L'"', 1)) return 0;
  for (const wchar_t* cursor = argument;; cursor++) {
    size_t backslashes = 0;
    while (*cursor == L'\\') {
      cursor++;
      backslashes++;
    }
    if (*cursor == L'\0') {
      if (!buffer_append_char(buffer, L'\\', backslashes * 2)) return 0;
      break;
    }
    if (*cursor == L'"') {
      if (!buffer_append_char(buffer, L'\\', backslashes * 2 + 1)) return 0;
      if (!buffer_append_char(buffer, L'"', 1)) return 0;
    } else {
      if (!buffer_append_char(buffer, L'\\', backslashes)) return 0;
      if (!buffer_append_char(buffer, *cursor, 1)) return 0;
    }
  }
  return buffer_append_char(buffer, L'"', 1);
}

static HANDLE open_log(const wchar_t* path) {
  SECURITY_ATTRIBUTES inherit = {sizeof(inherit), NULL, TRUE};
  HANDLE handle = CreateFileW(path, FILE_APPEND_DATA | SYNCHRONIZE,
                              FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, &inherit,
                              OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  return handle;
}

static HANDLE open_null_input(void) {
  SECURITY_ATTRIBUTES inherit = {sizeof(inherit), NULL, TRUE};
  return CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &inherit,
                     OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
}

static int set_environment_assignment(const wchar_t* assignment) {
  const wchar_t* equals = wcschr(assignment, L'=');
  if (equals == NULL || equals == assignment) return 0;
  size_t name_length = (size_t)(equals - assignment);
  wchar_t* name = (wchar_t*)calloc(name_length + 1, sizeof(wchar_t));
  if (!name) return 0;
  memcpy(name, assignment, name_length * sizeof(wchar_t));
  BOOL ok = SetEnvironmentVariableW(name, equals + 1);
  free(name);
  return ok ? 1 : 0;
}

static int prepend_path(const wchar_t* directory) {
  DWORD current_length = GetEnvironmentVariableW(L"PATH", NULL, 0);
  size_t directory_length = wcslen(directory);
  size_t total = directory_length + 1 + (size_t)current_length + 1;
  wchar_t* value = (wchar_t*)calloc(total, sizeof(wchar_t));
  if (!value) return 0;
  memcpy(value, directory, directory_length * sizeof(wchar_t));
  if (current_length > 0) {
    value[directory_length] = L';';
    GetEnvironmentVariableW(L"PATH", value + directory_length + 1, current_length);
  }
  BOOL ok = SetEnvironmentVariableW(L"PATH", value);
  free(value);
  return ok ? 1 : 0;
}

typedef struct {
  const wchar_t* stdout_path;
  const wchar_t* stderr_path;
  const wchar_t* working_directory;
  wchar_t* command_line;
  BOOL inherit_stdio;
} child_launch;

// The host's own standard handle, made inheritable for the child; NULL device when absent.
static HANDLE inheritable_std_handle(DWORD which, BOOL* opened) {
  *opened = FALSE;
  HANDLE handle = GetStdHandle(which);
  if (handle == NULL || handle == INVALID_HANDLE_VALUE ||
      !SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) {
    handle = open_null_input();
    *opened = handle != INVALID_HANDLE_VALUE;
  }
  return handle;
}

// Runs the child once inside a fresh kill-on-close job and returns its exit code.
static DWORD run_child_once(const child_launch* launch) {
  HANDLE job = CreateJobObjectW(NULL, NULL);
  if (job == NULL) return HOST_EXIT_SETUP;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  ZeroMemory(&limits, sizeof(limits));
  limits.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits,
                               sizeof(limits))) {
    CloseHandle(job);
    return HOST_EXIT_SETUP;
  }

  STARTUPINFOW startup;
  ZeroMemory(&startup, sizeof(startup));
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESHOWWINDOW;
  startup.wShowWindow = SW_HIDE;
  HANDLE input = INVALID_HANDLE_VALUE;
  HANDLE output = INVALID_HANDLE_VALUE;
  HANDLE error = INVALID_HANDLE_VALUE;
  if (launch->inherit_stdio) {
    BOOL opened_input = FALSE;
    BOOL opened_output = FALSE;
    BOOL opened_error = FALSE;
    startup.dwFlags |= STARTF_USESTDHANDLES;
    startup.hStdInput = inheritable_std_handle(STD_INPUT_HANDLE, &opened_input);
    startup.hStdOutput = inheritable_std_handle(STD_OUTPUT_HANDLE, &opened_output);
    startup.hStdError = inheritable_std_handle(STD_ERROR_HANDLE, &opened_error);
    // Only handles opened here are closed after the spawn; the host's own stay with it.
    if (opened_input) input = startup.hStdInput;
    if (opened_output) output = startup.hStdOutput;
    if (opened_error) error = startup.hStdError;
  } else if (launch->stdout_path != NULL || launch->stderr_path != NULL) {
    input = open_null_input();
    output = launch->stdout_path != NULL ? open_log(launch->stdout_path) : INVALID_HANDLE_VALUE;
    error = launch->stderr_path != NULL ? open_log(launch->stderr_path) : output;
    if (output == INVALID_HANDLE_VALUE) output = error;
    startup.dwFlags |= STARTF_USESTDHANDLES;
    startup.hStdInput = input;
    startup.hStdOutput = output;
    startup.hStdError = error;
  }

  PROCESS_INFORMATION process;
  ZeroMemory(&process, sizeof(process));
  // Suspended until it is inside the job, so nothing it spawns can escape.
  BOOL created = CreateProcessW(NULL, launch->command_line, NULL, NULL,
                                (startup.dwFlags & STARTF_USESTDHANDLES) ? TRUE : FALSE,
                                CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
                                NULL, launch->working_directory, &startup, &process);
  if (input != INVALID_HANDLE_VALUE) CloseHandle(input);
  if (output != INVALID_HANDLE_VALUE) CloseHandle(output);
  if (error != INVALID_HANDLE_VALUE && error != output) CloseHandle(error);
  if (!created) {
    CloseHandle(job);
    return HOST_EXIT_SPAWN;
  }
  if (!AssignProcessToJobObject(job, process.hProcess)) {
    TerminateProcess(process.hProcess, HOST_EXIT_SETUP);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    CloseHandle(job);
    return HOST_EXIT_SETUP;
  }
  ResumeThread(process.hThread);
  CloseHandle(process.hThread);

  WaitForSingleObject(process.hProcess, INFINITE);
  DWORD exit_code = HOST_EXIT_SPAWN;
  GetExitCodeProcess(process.hProcess, &exit_code);
  CloseHandle(process.hProcess);
  // Closing the job kills anything the child left behind.
  CloseHandle(job);
  return exit_code;
}

static int parse_count(const wchar_t* text, DWORD* out) {
  wchar_t* end = NULL;
  unsigned long value = wcstoul(text, &end, 10);
  if (end == text || *end != L'\0' || value > 0x7fffffffUL) return 0;
  *out = (DWORD)value;
  return 1;
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR command_line, int show) {
  (void)instance;
  (void)previous;
  (void)command_line;
  (void)show;
  // Never block on error dialogs; the service runs unattended.
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);

  int argc = 0;
  wchar_t** argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (argv == NULL) return HOST_EXIT_USAGE;

  child_launch launch = {NULL, NULL, NULL, NULL, FALSE};
  DWORD restart_delay_seconds = 60;
  DWORD restart_limit = 999;
  int program_index = -1;
  for (int index = 1; index < argc; index++) {
    const wchar_t* argument = argv[index];
    if (wcscmp(argument, L"--") == 0) {
      program_index = index + 1;
      break;
    }
    if (wcscmp(argument, L"--inherit-stdio") == 0) {
      launch.inherit_stdio = TRUE;
      continue;
    }
    if (index + 1 >= argc) return HOST_EXIT_USAGE;
    const wchar_t* value = argv[++index];
    if (wcscmp(argument, L"--stdout") == 0) {
      launch.stdout_path = value;
    } else if (wcscmp(argument, L"--stderr") == 0) {
      launch.stderr_path = value;
    } else if (wcscmp(argument, L"--cwd") == 0) {
      launch.working_directory = value;
    } else if (wcscmp(argument, L"--env") == 0) {
      if (!set_environment_assignment(value)) return HOST_EXIT_USAGE;
    } else if (wcscmp(argument, L"--path-prepend") == 0) {
      if (!prepend_path(value)) return HOST_EXIT_SETUP;
    } else if (wcscmp(argument, L"--restart-delay-seconds") == 0) {
      if (!parse_count(value, &restart_delay_seconds) || restart_delay_seconds > 86400) {
        return HOST_EXIT_USAGE;
      }
    } else if (wcscmp(argument, L"--restart-limit") == 0) {
      if (!parse_count(value, &restart_limit)) return HOST_EXIT_USAGE;
    } else {
      return HOST_EXIT_USAGE;
    }
  }
  if (program_index < 0 || program_index >= argc) return HOST_EXIT_USAGE;

  wide_buffer child_command_line = {0};
  for (int index = program_index; index < argc; index++) {
    if (!append_quoted_argument(&child_command_line, argv[index])) return HOST_EXIT_SETUP;
  }
  launch.command_line = child_command_line.data;

  // Task Scheduler's RestartOnFailure ignores a non-zero action exit code, so
  // the host restarts a failed supervisor itself. A clean exit (0) — including
  // a tripped circuit breaker — ends the task without a restart loop.
  DWORD restarts = 0;
  DWORD exit_code = 0;
  for (;;) {
    ULONGLONG started = GetTickCount64();
    exit_code = run_child_once(&launch);
    if (exit_code == 0 || exit_code == HOST_EXIT_SPAWN) break;
    // A run that stayed up for ten minutes resets the restart budget.
    if (GetTickCount64() - started >= 600000ULL) restarts = 0;
    if (restarts >= restart_limit) break;
    restarts++;
    Sleep(restart_delay_seconds * 1000);
  }
  LocalFree(argv);
  free(child_command_line.data);
  return (int)exit_code;
}
