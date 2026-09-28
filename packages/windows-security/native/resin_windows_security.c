// Resin Windows security helper (N-API).
//
// Node's `net` module creates named pipes with the default named-pipe
// security descriptor, which grants read access to Everyone and cannot be
// changed before the first client can connect. This helper owns the pipe
// server instead: every instance is created with an explicit owner-only DACL,
// rejects remote clients, and the first instance claims the name exclusively
// so another user cannot squat it. It also applies and inspects owner-only
// DACLs on Resin's private files, and lets clients verify that a pipe server is
// owned by the current user before sending anything to it.
//
// Pure C against the stable Node-API so one binary works across Node >= 22.

#define WIN32_LEAN_AND_MEAN
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#include <node_api.h>

#pragma comment(lib, "advapi32.lib")

// The import library generated from node-api-headers binds Node-API symbols to
// NODE.EXE. Delay-load it and resolve it to the host executable so the addon
// also loads when Node is embedded or renamed (the same trick node-gyp uses).
#pragma warning(push)
#pragma warning(disable : 4201)
#include <delayimp.h>
#pragma warning(pop)
static FARPROC WINAPI resin_delay_load_hook(unsigned int event, DelayLoadInfo* info) {
  if (event != dliNotePreLoadLibrary) return NULL;
  if (_stricmp(info->szDll, "node.exe") != 0) return NULL;
  return (FARPROC)GetModuleHandleW(NULL);
}
const PfnDliHook __pfnDliNotifyHook2 = resin_delay_load_hook;

#define PIPE_BUFFER_BYTES 65536
#define READ_CHUNK_BYTES 65536

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

static napi_value throw_win32(napi_env env, const char* what, DWORD code) {
  char message[512];
  char system_text[256] = {0};
  FormatMessageA(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, NULL, code, 0,
                 system_text, (DWORD)sizeof(system_text), NULL);
  size_t len = strlen(system_text);
  while (len > 0 && (system_text[len - 1] == '\r' || system_text[len - 1] == '\n' ||
                     system_text[len - 1] == ' ' || system_text[len - 1] == '.')) {
    system_text[--len] = '\0';
  }
  _snprintf_s(message, sizeof(message), _TRUNCATE, "%s failed (win32 error %lu: %s)", what,
              (unsigned long)code, system_text);
  char code_text[32];
  _snprintf_s(code_text, sizeof(code_text), _TRUNCATE, "WIN32_%lu", (unsigned long)code);
  napi_throw_error(env, code_text, message);
  return NULL;
}

static wchar_t* utf8_to_wide(const char* text) {
  int needed = MultiByteToWideChar(CP_UTF8, 0, text, -1, NULL, 0);
  if (needed <= 0) return NULL;
  wchar_t* wide = (wchar_t*)malloc(sizeof(wchar_t) * (size_t)needed);
  if (!wide) return NULL;
  MultiByteToWideChar(CP_UTF8, 0, text, -1, wide, needed);
  return wide;
}

static napi_value wide_to_js(napi_env env, const wchar_t* text) {
  napi_value result;
  napi_create_string_utf16(env, (const char16_t*)text, NAPI_AUTO_LENGTH, &result);
  return result;
}

static wchar_t* get_string_arg(napi_env env, napi_value value) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok) {
    napi_throw_type_error(env, NULL, "expected a string argument");
    return NULL;
  }
  char* utf8 = (char*)malloc(length + 1);
  if (!utf8) return NULL;
  napi_get_value_string_utf8(env, value, utf8, length + 1, &length);
  wchar_t* wide = utf8_to_wide(utf8);
  free(utf8);
  return wide;
}

// Returns a LocalAlloc'd copy of the current process user's SID.
static PSID current_user_sid(DWORD* error_out) {
  HANDLE token = NULL;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
    *error_out = GetLastError();
    return NULL;
  }
  DWORD size = 0;
  GetTokenInformation(token, TokenUser, NULL, 0, &size);
  TOKEN_USER* user = (TOKEN_USER*)malloc(size);
  if (!user || !GetTokenInformation(token, TokenUser, user, size, &size)) {
    *error_out = GetLastError();
    free(user);
    CloseHandle(token);
    return NULL;
  }
  DWORD sid_len = GetLengthSid(user->User.Sid);
  PSID copy = (PSID)LocalAlloc(LPTR, sid_len);
  if (copy) CopySid(sid_len, copy, user->User.Sid);
  free(user);
  CloseHandle(token);
  if (!copy) *error_out = ERROR_NOT_ENOUGH_MEMORY;
  return copy;
}

static PSID process_user_sid(DWORD pid, DWORD* error_out) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) {
    *error_out = GetLastError();
    return NULL;
  }
  HANDLE token = NULL;
  if (!OpenProcessToken(process, TOKEN_QUERY, &token)) {
    *error_out = GetLastError();
    CloseHandle(process);
    return NULL;
  }
  DWORD size = 0;
  GetTokenInformation(token, TokenUser, NULL, 0, &size);
  TOKEN_USER* user = (TOKEN_USER*)malloc(size);
  PSID copy = NULL;
  if (user && GetTokenInformation(token, TokenUser, user, size, &size)) {
    DWORD sid_len = GetLengthSid(user->User.Sid);
    copy = (PSID)LocalAlloc(LPTR, sid_len);
    if (copy) CopySid(sid_len, copy, user->User.Sid);
  } else {
    *error_out = GetLastError();
  }
  free(user);
  CloseHandle(token);
  CloseHandle(process);
  return copy;
}

// Builds "D:P(D;;GA;;;NU)(A;;GA;;;<sid>)" — deny network logons, allow only the
// current user, and protect against inherited ACEs. `inherit` adds OI/CI so
// children of a directory receive the same owner-only access.
static PSECURITY_DESCRIPTOR owner_only_descriptor(PSID user, BOOL inherit, BOOL deny_network,
                                                  DWORD* error_out) {
  LPWSTR sid_text = NULL;
  if (!ConvertSidToStringSidW(user, &sid_text)) {
    *error_out = GetLastError();
    return NULL;
  }
  wchar_t sddl[512];
  const wchar_t* flags = inherit ? L"OICI" : L"";
  if (deny_network) {
    _snwprintf_s(sddl, 512, _TRUNCATE, L"O:%sD:P(D;%s;GA;;;NU)(A;%s;FA;;;%s)", sid_text, flags,
                 flags, sid_text);
  } else {
    _snwprintf_s(sddl, 512, _TRUNCATE, L"O:%sD:P(A;%s;FA;;;%s)", sid_text, flags, sid_text);
  }
  LocalFree(sid_text);
  PSECURITY_DESCRIPTOR sd = NULL;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &sd, NULL)) {
    *error_out = GetLastError();
    return NULL;
  }
  return sd;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

static napi_value js_current_user_sid(napi_env env, napi_callback_info info) {
  (void)info;
  DWORD error = 0;
  PSID sid = current_user_sid(&error);
  if (!sid) return throw_win32(env, "OpenProcessToken", error);
  LPWSTR text = NULL;
  if (!ConvertSidToStringSidW(sid, &text)) {
    error = GetLastError();
    LocalFree(sid);
    return throw_win32(env, "ConvertSidToStringSid", error);
  }
  napi_value result = wide_to_js(env, text);
  LocalFree(text);
  LocalFree(sid);
  return result;
}

// ---------------------------------------------------------------------------
// File ACLs
// ---------------------------------------------------------------------------

static void throw_coded(napi_env env, const char* code, const char* message) {
  napi_throw_error(env, code, message);
}

static BOOL is_well_known_sid(PSID sid, WELL_KNOWN_SID_TYPE type) {
  return sid != NULL && IsWellKnownSid(sid, type);
}

// Owners whose objects the current user may take over when its DACL grants
// WRITE_OWNER: itself, and the machine principals that own files created by an
// elevated installer (BUILTIN\Administrators, LocalSystem). Anyone else could
// have planted the object, so it is refused rather than adopted.
static BOOL owner_may_be_replaced(PSID owner, PSID me) {
  if (owner == NULL) return FALSE;
  return EqualSid(owner, me) || is_well_known_sid(owner, WinBuiltinAdministratorsSid) ||
         is_well_known_sid(owner, WinLocalSystemSid);
}

// setOwnerOnlyAcl(path, isDirectory): make the current user the owner and
// replace the DACL with a protected DACL granting only that user (inheritable
// for directories). Refuses (code EFOREIGNOWNER) objects owned by another
// principal, and never leaves a foreign owner behind: the DACL-only fallback
// for a missing WRITE_OWNER right is used only when the user already owns the
// object.
static napi_value js_set_owner_only_acl(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 2) {
    napi_throw_type_error(env, NULL, "setOwnerOnlyAcl(path, isDirectory)");
    return NULL;
  }
  wchar_t* path = get_string_arg(env, argv[0]);
  if (!path) return NULL;
  bool is_directory = false;
  napi_get_value_bool(env, argv[1], &is_directory);

  DWORD error = 0;
  PSID user = current_user_sid(&error);
  if (!user) {
    free(path);
    return throw_win32(env, "OpenProcessToken", error);
  }
  PSID owner = NULL;
  PSECURITY_DESCRIPTOR current = NULL;
  DWORD status = GetNamedSecurityInfoW(path, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION, &owner,
                                       NULL, NULL, NULL, &current);
  if (status != ERROR_SUCCESS) {
    LocalFree(user);
    free(path);
    return throw_win32(env, "GetNamedSecurityInfo", status);
  }
  BOOL already_owner = owner != NULL && EqualSid(owner, user);
  BOOL replaceable = owner_may_be_replaced(owner, user);
  LocalFree(current);
  if (!replaceable) {
    LocalFree(user);
    free(path);
    throw_coded(env, "EFOREIGNOWNER",
                "refusing to adopt an object owned by another principal");
    return NULL;
  }

  PSECURITY_DESCRIPTOR sd = owner_only_descriptor(user, is_directory, FALSE, &error);
  if (!sd) {
    LocalFree(user);
    free(path);
    return throw_win32(env, "ConvertStringSecurityDescriptor", error);
  }
  BOOL present = FALSE, defaulted = FALSE;
  PACL dacl = NULL;
  GetSecurityDescriptorDacl(sd, &present, &dacl, &defaulted);
  status = SetNamedSecurityInfoW(path, SE_FILE_OBJECT,
                                 DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION |
                                     OWNER_SECURITY_INFORMATION,
                                 user, NULL, dacl, NULL);
  if ((status == ERROR_ACCESS_DENIED || status == ERROR_INVALID_OWNER) && already_owner) {
    // Re-asserting ownership needs WRITE_OWNER, which an owner-only DACL of an
    // older release may not grant; the owner's implicit WRITE_DAC suffices.
    status = SetNamedSecurityInfoW(
        path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        NULL, NULL, dacl, NULL);
  }
  LocalFree(sd);
  LocalFree(user);
  free(path);
  if ((status == ERROR_ACCESS_DENIED || status == ERROR_INVALID_OWNER) && !already_owner) {
    throw_coded(env, "EFOREIGNOWNER",
                "cannot take ownership of an object owned by another principal");
    return NULL;
  }
  if (status != ERROR_SUCCESS) return throw_win32(env, "SetNamedSecurityInfo", status);
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

// Security attributes carrying "owner = current user, protected DACL granting
// only that user" for objects created by this process.
static PSECURITY_DESCRIPTOR private_create_descriptor(BOOL inherit, DWORD* error_out) {
  PSID user = current_user_sid(error_out);
  if (!user) return NULL;
  PSECURITY_DESCRIPTOR sd = owner_only_descriptor(user, inherit, FALSE, error_out);
  LocalFree(user);
  return sd;
}

// writePrivateFileExclusive(path, buffer): creates a new file (never opens an
// existing one) whose owner-only protected DACL is part of the create call, so
// there is no moment in which the file exists with a broader DACL, then writes
// and flushes `buffer`. Throws EEXIST when the path exists.
static napi_value js_write_private_file_exclusive(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 2) {
    napi_throw_type_error(env, NULL, "writePrivateFileExclusive(path, buffer)");
    return NULL;
  }
  void* data = NULL;
  size_t length = 0;
  if (napi_get_buffer_info(env, argv[1], &data, &length) != napi_ok) {
    napi_throw_type_error(env, NULL, "expected a Buffer");
    return NULL;
  }
  wchar_t* path = get_string_arg(env, argv[0]);
  if (!path) return NULL;
  DWORD error = 0;
  PSECURITY_DESCRIPTOR sd = private_create_descriptor(FALSE, &error);
  if (!sd) {
    free(path);
    return throw_win32(env, "ConvertStringSecurityDescriptor", error);
  }
  SECURITY_ATTRIBUTES sa = {sizeof(SECURITY_ATTRIBUTES), sd, FALSE};
  HANDLE file = CreateFileW(path, GENERIC_WRITE, 0, &sa, CREATE_NEW,
                            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  error = file == INVALID_HANDLE_VALUE ? GetLastError() : 0;
  LocalFree(sd);
  if (file == INVALID_HANDLE_VALUE) {
    free(path);
    if (error == ERROR_FILE_EXISTS || error == ERROR_ALREADY_EXISTS) {
      throw_coded(env, "EEXIST", "file already exists");
      return NULL;
    }
    return throw_win32(env, "CreateFile", error);
  }
  size_t offset = 0;
  BOOL ok = TRUE;
  while (ok && offset < length) {
    DWORD chunk = (DWORD)((length - offset) > 0x40000000 ? 0x40000000 : (length - offset));
    DWORD written = 0;
    ok = WriteFile(file, (const char*)data + offset, chunk, &written, NULL);
    offset += written;
    if (ok && written == 0) ok = FALSE;
  }
  if (ok) ok = FlushFileBuffers(file);
  error = ok ? 0 : GetLastError();
  CloseHandle(file);
  if (!ok) {
    DeleteFileW(path);
    free(path);
    return throw_win32(env, "WriteFile", error);
  }
  free(path);
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

// createPrivateDirectory(path): creates a new directory whose inheritable,
// protected owner-only DACL is part of the create call. Throws EEXIST when the
// path exists.
static napi_value js_create_private_directory(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) {
    napi_throw_type_error(env, NULL, "createPrivateDirectory(path)");
    return NULL;
  }
  wchar_t* path = get_string_arg(env, argv[0]);
  if (!path) return NULL;
  DWORD error = 0;
  PSECURITY_DESCRIPTOR sd = private_create_descriptor(TRUE, &error);
  if (!sd) {
    free(path);
    return throw_win32(env, "ConvertStringSecurityDescriptor", error);
  }
  SECURITY_ATTRIBUTES sa = {sizeof(SECURITY_ATTRIBUTES), sd, FALSE};
  BOOL created = CreateDirectoryW(path, &sa);
  error = created ? 0 : GetLastError();
  LocalFree(sd);
  free(path);
  if (!created) {
    if (error == ERROR_ALREADY_EXISTS || error == ERROR_FILE_EXISTS) {
      throw_coded(env, "EEXIST", "directory already exists");
      return NULL;
    }
    if (error == ERROR_PATH_NOT_FOUND) {
      throw_coded(env, "ENOENT", "parent directory does not exist");
      return NULL;
    }
    return throw_win32(env, "CreateDirectory", error);
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value describe_descriptor(napi_env env, PSECURITY_DESCRIPTOR sd, PSID owner,
                                      PACL dacl) {
  napi_value result;
  napi_create_object(env, &result);

  LPWSTR owner_text = NULL;
  if (owner && ConvertSidToStringSidW(owner, &owner_text)) {
    napi_set_named_property(env, result, "owner", wide_to_js(env, owner_text));
    LocalFree(owner_text);
  } else {
    napi_value null_value;
    napi_get_null(env, &null_value);
    napi_set_named_property(env, result, "owner", null_value);
  }

  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0;
  GetSecurityDescriptorControl(sd, &control, &revision);
  napi_value protected_value;
  napi_get_boolean(env, (control & SE_DACL_PROTECTED) != 0, &protected_value);
  napi_set_named_property(env, result, "protected", protected_value);

  napi_value dacl_present;
  napi_get_boolean(env, dacl != NULL, &dacl_present);
  napi_set_named_property(env, result, "daclPresent", dacl_present);

  napi_value entries;
  napi_create_array(env, &entries);
  if (dacl) {
    ACL_SIZE_INFORMATION size_info;
    GetAclInformation(dacl, &size_info, sizeof(size_info), AclSizeInformation);
    for (DWORD i = 0; i < size_info.AceCount; i++) {
      LPVOID ace = NULL;
      if (!GetAce(dacl, i, &ace)) continue;
      ACE_HEADER* header = (ACE_HEADER*)ace;
      const char* type = "other";
      PSID ace_sid = NULL;
      ACCESS_MASK mask = 0;
      if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
        type = "allow";
        ace_sid = (PSID)&((ACCESS_ALLOWED_ACE*)ace)->SidStart;
        mask = ((ACCESS_ALLOWED_ACE*)ace)->Mask;
      } else if (header->AceType == ACCESS_DENIED_ACE_TYPE) {
        type = "deny";
        ace_sid = (PSID)&((ACCESS_DENIED_ACE*)ace)->SidStart;
        mask = ((ACCESS_DENIED_ACE*)ace)->Mask;
      }
      napi_value entry;
      napi_create_object(env, &entry);
      napi_value type_value;
      napi_create_string_utf8(env, type, NAPI_AUTO_LENGTH, &type_value);
      napi_set_named_property(env, entry, "type", type_value);
      napi_value mask_value;
      napi_create_uint32(env, (uint32_t)mask, &mask_value);
      napi_set_named_property(env, entry, "mask", mask_value);
      napi_value inherited;
      napi_get_boolean(env, (header->AceFlags & INHERITED_ACE) != 0, &inherited);
      napi_set_named_property(env, entry, "inherited", inherited);
      napi_value inherit_only;
      napi_get_boolean(env, (header->AceFlags & INHERIT_ONLY_ACE) != 0, &inherit_only);
      napi_set_named_property(env, entry, "inheritOnly", inherit_only);
      LPWSTR sid_text = NULL;
      if (ace_sid && ConvertSidToStringSidW(ace_sid, &sid_text)) {
        napi_set_named_property(env, entry, "sid", wide_to_js(env, sid_text));
        LocalFree(sid_text);
      } else {
        napi_value null_value;
        napi_get_null(env, &null_value);
        napi_set_named_property(env, entry, "sid", null_value);
      }
      napi_set_element(env, entries, i, entry);
    }
  }
  napi_set_named_property(env, result, "entries", entries);
  return result;
}

// readAcl(path): { owner, protected, daclPresent, entries: [{type, sid, mask, inherited}] }
static napi_value js_read_acl(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) {
    napi_throw_type_error(env, NULL, "readAcl(path)");
    return NULL;
  }
  wchar_t* path = get_string_arg(env, argv[0]);
  if (!path) return NULL;
  PSID owner = NULL;
  PACL dacl = NULL;
  PSECURITY_DESCRIPTOR sd = NULL;
  DWORD status =
      GetNamedSecurityInfoW(path, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                            &owner, NULL, &dacl, NULL, &sd);
  free(path);
  if (status != ERROR_SUCCESS) return throw_win32(env, "GetNamedSecurityInfo", status);
  napi_value result = describe_descriptor(env, sd, owner, dacl);
  LocalFree(sd);
  return result;
}

// ---------------------------------------------------------------------------
// Pipe client verification
// ---------------------------------------------------------------------------

// verifyPipeServer(name): opens the pipe, confirms the pipe object and the
// server process both belong to the current user, then disconnects.
// Returns { ok, reason?, serverPid?, ownerSid?, serverSid? }.
static napi_value js_verify_pipe_server(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) {
    napi_throw_type_error(env, NULL, "verifyPipeServer(name)");
    return NULL;
  }
  wchar_t* name = get_string_arg(env, argv[0]);
  if (!name) return NULL;

  napi_value result;
  napi_create_object(env, &result);
  napi_value ok_value;

  HANDLE pipe = INVALID_HANDLE_VALUE;
  for (int attempt = 0; attempt < 20; attempt++) {
    pipe = CreateFileW(name, READ_CONTROL | FILE_READ_ATTRIBUTES, 0, NULL, OPEN_EXISTING,
                       SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, NULL);
    if (pipe != INVALID_HANDLE_VALUE) break;
    if (GetLastError() != ERROR_PIPE_BUSY) break;
    WaitNamedPipeW(name, 250);
  }
  free(name);
  if (pipe == INVALID_HANDLE_VALUE) {
    DWORD error = GetLastError();
    napi_get_boolean(env, false, &ok_value);
    napi_set_named_property(env, result, "ok", ok_value);
    napi_value reason;
    napi_create_string_utf8(env,
                            error == ERROR_FILE_NOT_FOUND ? "not-running"
                            : error == ERROR_ACCESS_DENIED ? "access-denied"
                                                           : "open-failed",
                            NAPI_AUTO_LENGTH, &reason);
    napi_set_named_property(env, result, "reason", reason);
    napi_value code;
    napi_create_uint32(env, error, &code);
    napi_set_named_property(env, result, "win32Error", code);
    return result;
  }

  DWORD error = 0;
  PSID me = current_user_sid(&error);
  PSID owner = NULL;
  PSECURITY_DESCRIPTOR sd = NULL;
  DWORD status = GetSecurityInfo(pipe, SE_KERNEL_OBJECT, OWNER_SECURITY_INFORMATION, &owner, NULL,
                                 NULL, NULL, &sd);
  ULONG server_pid = 0;
  BOOL have_pid = GetNamedPipeServerProcessId(pipe, &server_pid);
  PSID server_sid = have_pid ? process_user_sid(server_pid, &error) : NULL;

  BOOL owner_matches = me && owner && status == ERROR_SUCCESS && EqualSid(me, owner);
  BOOL server_matches = me && server_sid && EqualSid(me, server_sid);

  LPWSTR text = NULL;
  if (owner && ConvertSidToStringSidW(owner, &text)) {
    napi_set_named_property(env, result, "ownerSid", wide_to_js(env, text));
    LocalFree(text);
  }
  if (server_sid && ConvertSidToStringSidW(server_sid, &text)) {
    napi_set_named_property(env, result, "serverSid", wide_to_js(env, text));
    LocalFree(text);
  }
  if (have_pid) {
    napi_value pid_value;
    napi_create_uint32(env, server_pid, &pid_value);
    napi_set_named_property(env, result, "serverPid", pid_value);
  }
  napi_get_boolean(env, owner_matches && server_matches, &ok_value);
  napi_set_named_property(env, result, "ok", ok_value);
  if (!(owner_matches && server_matches)) {
    napi_value reason;
    napi_create_string_utf8(env, !owner_matches ? "foreign-owner" : "foreign-server",
                            NAPI_AUTO_LENGTH, &reason);
    napi_set_named_property(env, result, "reason", reason);
  }
  if (sd) LocalFree(sd);
  if (me) LocalFree(me);
  if (server_sid) LocalFree(server_sid);
  CloseHandle(pipe);
  return result;
}

// readPipeAcl(name): security descriptor of an existing pipe (for tests and
// `resin doctor`).
static napi_value js_read_pipe_acl(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) {
    napi_throw_type_error(env, NULL, "readPipeAcl(name)");
    return NULL;
  }
  wchar_t* name = get_string_arg(env, argv[0]);
  if (!name) return NULL;
  HANDLE pipe = INVALID_HANDLE_VALUE;
  for (int attempt = 0; attempt < 20; attempt++) {
    pipe = CreateFileW(name, READ_CONTROL, 0, NULL, OPEN_EXISTING, 0, NULL);
    if (pipe != INVALID_HANDLE_VALUE) break;
    if (GetLastError() != ERROR_PIPE_BUSY) break;
    WaitNamedPipeW(name, 250);
  }
  free(name);
  if (pipe == INVALID_HANDLE_VALUE) return throw_win32(env, "CreateFile(pipe)", GetLastError());
  PSID owner = NULL;
  PACL dacl = NULL;
  PSECURITY_DESCRIPTOR sd = NULL;
  DWORD status = GetSecurityInfo(pipe, SE_KERNEL_OBJECT,
                                 OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner,
                                 NULL, &dacl, NULL, &sd);
  CloseHandle(pipe);
  if (status != ERROR_SUCCESS) return throw_win32(env, "GetSecurityInfo(pipe)", status);
  napi_value result = describe_descriptor(env, sd, owner, dacl);
  LocalFree(sd);
  return result;
}

// ---------------------------------------------------------------------------
// Pipe endpoints (server and verified client)
// ---------------------------------------------------------------------------
//
// JS contract (wrapped by src/pipe.ts):
//   const server = createPipeServer(name, onEvent)
//   pipeConnect(name, timeoutMs, onEvent, callback(error, result))
//     result: { ok: true, handle, serverPid } | { ok: false, reason, win32Error }
//   onEvent("connection", id, clientPid)   (servers only)
//   onEvent("data", id, Buffer)
//   onEvent("end", id)
//   onEvent("error", id | 0, message)
//   pipeWrite(endpoint, id, Buffer, callback(errMessage | null))
//   pipeClose(endpoint, id, graceful)       -- once per connection id
//   pipeServerClose(endpoint)               -- stop accepting, drop every connection
//
// A client endpoint holds exactly one connection (id 1) on a pipe handle whose
// owner and server process were verified on that very handle.
//
// Lifetimes:
//   * endpoint->refs: the JS external, the accept thread and every connection.
//     The endpoint is freed when the last of them lets go.
//   * connection->refs: the endpoint's list, its reader thread and every
//     pending write. Freeing a connection releases its endpoint reference.
//   * The threadsafe function starts with one reference owned by the main
//     thread (released by pipeServerClose or the finalizer). The accept thread
//     and every reader acquire their own reference before they start and
//     release it as their very last action, so no thread ever calls into a
//     released threadsafe function.

typedef struct connection_s connection_t;
typedef struct endpoint_s endpoint_t;

struct connection_s {
  endpoint_t* endpoint;
  uint32_t id;
  HANDLE pipe;
  HANDLE write_event;
  CRITICAL_SECTION write_lock;
  volatile LONG refs;
  volatile LONG closed;
  volatile LONG end_reported;
  connection_t* next;
};

struct endpoint_s {
  BOOL is_client;
  wchar_t* name;
  PSECURITY_DESCRIPTOR sd;
  SECURITY_ATTRIBUTES sa;
  napi_threadsafe_function tsfn;
  BOOL owner_released;  // main thread only
  HANDLE accept_thread;
  HANDLE stop_event;
  HANDLE pending_pipe;
  CRITICAL_SECTION lock;
  connection_t* connections;
  uint32_t next_id;
  volatile LONG stopping;
  volatile LONG refs;
};

typedef enum { EVENT_CONNECTION, EVENT_DATA, EVENT_END, EVENT_ERROR } event_kind_t;

typedef struct {
  event_kind_t kind;
  uint32_t id;
  uint32_t client_pid;
  char* data;
  size_t length;
  char* message;
} pipe_event_t;

static void endpoint_unref(endpoint_t* endpoint) {
  if (InterlockedDecrement(&endpoint->refs) != 0) return;
  if (endpoint->pending_pipe && endpoint->pending_pipe != INVALID_HANDLE_VALUE) {
    CloseHandle(endpoint->pending_pipe);
  }
  if (endpoint->accept_thread) CloseHandle(endpoint->accept_thread);
  if (endpoint->stop_event) CloseHandle(endpoint->stop_event);
  DeleteCriticalSection(&endpoint->lock);
  if (endpoint->sd) LocalFree(endpoint->sd);
  free(endpoint->name);
  free(endpoint);
}

static endpoint_t* endpoint_new(const wchar_t* name, BOOL is_client) {
  endpoint_t* endpoint = (endpoint_t*)calloc(1, sizeof(endpoint_t));
  if (!endpoint) return NULL;
  endpoint->is_client = is_client;
  endpoint->name = _wcsdup(name);
  endpoint->refs = 1;  // the JS external (or the creator until it exists)
  InitializeCriticalSection(&endpoint->lock);
  endpoint->stop_event = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (!endpoint->name || !endpoint->stop_event) {
    endpoint_unref(endpoint);
    return NULL;
  }
  return endpoint;
}

// Callers must hold their own reference to `tsfn`.
static void post_event(napi_threadsafe_function tsfn, event_kind_t kind, uint32_t id,
                       uint32_t client_pid, const char* data, size_t length,
                       const char* message) {
  pipe_event_t* event = (pipe_event_t*)calloc(1, sizeof(pipe_event_t));
  if (!event) return;
  event->kind = kind;
  event->id = id;
  event->client_pid = client_pid;
  if (data && length > 0) {
    event->data = (char*)malloc(length);
    if (event->data) {
      memcpy(event->data, data, length);
      event->length = length;
    }
  }
  if (message) event->message = _strdup(message);
  if (napi_call_threadsafe_function(tsfn, event, napi_tsfn_blocking) != napi_ok) {
    free(event->data);
    free(event->message);
    free(event);
  }
}

static void call_js_event(napi_env env, napi_value js_callback, void* context, void* data) {
  (void)context;
  pipe_event_t* event = (pipe_event_t*)data;
  if (env && js_callback) {
    napi_value undefined;
    napi_get_undefined(env, &undefined);
    napi_value argv[3];
    const char* kind = event->kind == EVENT_CONNECTION ? "connection"
                       : event->kind == EVENT_DATA     ? "data"
                       : event->kind == EVENT_END      ? "end"
                                                       : "error";
    napi_create_string_utf8(env, kind, NAPI_AUTO_LENGTH, &argv[0]);
    napi_create_uint32(env, event->id, &argv[1]);
    if (event->kind == EVENT_CONNECTION) {
      napi_create_uint32(env, event->client_pid, &argv[2]);
    } else if (event->kind == EVENT_DATA) {
      void* buffer_data = NULL;
      napi_create_buffer_copy(env, event->length, event->data, &buffer_data, &argv[2]);
    } else if (event->kind == EVENT_ERROR && event->message) {
      napi_create_string_utf8(env, event->message, NAPI_AUTO_LENGTH, &argv[2]);
    } else {
      napi_get_undefined(env, &argv[2]);
    }
    napi_call_function(env, undefined, js_callback, 3, argv, NULL);
  }
  free(event->data);
  free(event->message);
  free(event);
}

static void connection_unref(connection_t* connection) {
  if (InterlockedDecrement(&connection->refs) != 0) return;
  endpoint_t* endpoint = connection->endpoint;
  CloseHandle(connection->pipe);
  if (connection->write_event) CloseHandle(connection->write_event);
  DeleteCriticalSection(&connection->write_lock);
  free(connection);
  endpoint_unref(endpoint);
}

// Creates a connection holding one endpoint reference; `refs` references are
// handed to the caller.
static connection_t* connection_new(endpoint_t* endpoint, HANDLE pipe, LONG refs) {
  connection_t* connection = (connection_t*)calloc(1, sizeof(connection_t));
  if (!connection) return NULL;
  connection->write_event = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (!connection->write_event) {
    free(connection);
    return NULL;
  }
  connection->endpoint = endpoint;
  connection->pipe = pipe;
  connection->refs = refs;
  InitializeCriticalSection(&connection->write_lock);
  InterlockedIncrement(&endpoint->refs);
  return connection;
}

// Forceful close disconnects a server-side client immediately and discards
// anything it has not read yet. Graceful close only stops reading; the handle
// closes once the last reference (pending write, reader) goes away, so the
// peer can still drain what was written.
static void close_connection(connection_t* connection, BOOL graceful) {
  if (InterlockedExchange(&connection->closed, 1) != 0) return;
  CancelIoEx(connection->pipe, NULL);
  if (!graceful && !connection->endpoint->is_client) DisconnectNamedPipe(connection->pipe);
}

typedef struct {
  connection_t* connection;
  napi_threadsafe_function tsfn;  // acquired for this reader
} reader_start_t;

static DWORD WINAPI reader_main(LPVOID param) {
  reader_start_t* start = (reader_start_t*)param;
  connection_t* connection = start->connection;
  napi_threadsafe_function tsfn = start->tsfn;
  free(start);
  char* buffer = (char*)malloc(READ_CHUNK_BYTES);
  OVERLAPPED overlapped;
  HANDLE read_event = CreateEventW(NULL, TRUE, FALSE, NULL);
  while (buffer && read_event && !connection->closed) {
    ZeroMemory(&overlapped, sizeof(overlapped));
    overlapped.hEvent = read_event;
    ResetEvent(read_event);
    DWORD transferred = 0;
    BOOL ok = ReadFile(connection->pipe, buffer, READ_CHUNK_BYTES, NULL, &overlapped);
    DWORD error = ok ? ERROR_SUCCESS : GetLastError();
    if (ok || error == ERROR_IO_PENDING || error == ERROR_MORE_DATA) {
      ok = GetOverlappedResult(connection->pipe, &overlapped, &transferred, TRUE);
      error = ok ? ERROR_SUCCESS : GetLastError();
      if (!ok && error == ERROR_MORE_DATA) ok = TRUE;
    }
    if (!ok) {
      if (error != ERROR_BROKEN_PIPE && error != ERROR_PIPE_NOT_CONNECTED &&
          error != ERROR_OPERATION_ABORTED && error != ERROR_NO_DATA && !connection->closed) {
        char message[64];
        _snprintf_s(message, sizeof(message), _TRUNCATE, "ReadFile failed (win32 error %lu)",
                    (unsigned long)error);
        post_event(tsfn, EVENT_ERROR, connection->id, 0, NULL, 0, message);
      }
      break;
    }
    if (transferred > 0) {
      post_event(tsfn, EVENT_DATA, connection->id, 0, buffer, transferred, NULL);
    }
  }
  if (read_event) CloseHandle(read_event);
  free(buffer);
  if (InterlockedExchange(&connection->end_reported, 1) == 0) {
    post_event(tsfn, EVENT_END, connection->id, 0, NULL, 0, NULL);
  }
  connection_unref(connection);
  // Last action: after this the threadsafe function may be finalized.
  napi_release_threadsafe_function(tsfn, napi_tsfn_release);
  return 0;
}

// Starts a reader for `connection`, which must already hold the reader's
// reference. Consumes `tsfn_ref` (an acquired reference) in every case.
static BOOL start_reader(connection_t* connection, napi_threadsafe_function tsfn) {
  reader_start_t* start = (reader_start_t*)malloc(sizeof(reader_start_t));
  HANDLE thread = NULL;
  if (start) {
    start->connection = connection;
    start->tsfn = tsfn;
    thread = CreateThread(NULL, 0, reader_main, start, 0, NULL);
  }
  if (thread) {
    CloseHandle(thread);
    return TRUE;
  }
  free(start);
  if (InterlockedExchange(&connection->end_reported, 1) == 0) {
    post_event(tsfn, EVENT_END, connection->id, 0, NULL, 0, NULL);
  }
  connection_unref(connection);
  napi_release_threadsafe_function(tsfn, napi_tsfn_release);
  return FALSE;
}

static HANDLE create_instance(endpoint_t* server, BOOL first) {
  DWORD open_mode = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED;
  if (first) open_mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
  return CreateNamedPipeW(server->name, open_mode,
                          PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT |
                              PIPE_REJECT_REMOTE_CLIENTS,
                          PIPE_UNLIMITED_INSTANCES, PIPE_BUFFER_BYTES, PIPE_BUFFER_BYTES, 0,
                          &server->sa);
}

static void post_win32_error(napi_threadsafe_function tsfn, const char* what, DWORD code) {
  char message[96];
  _snprintf_s(message, sizeof(message), _TRUNCATE, "%s failed (win32 error %lu)", what,
              (unsigned long)code);
  post_event(tsfn, EVENT_ERROR, 0, 0, NULL, 0, message);
}

typedef struct {
  endpoint_t* server;
  napi_threadsafe_function tsfn;
} accept_start_t;

// Invariant: while the server runs it always owns at least one listening
// instance, so the name never lapses and nobody else can claim it. A connected
// instance is handed to a reader only after its replacement exists; if the
// replacement cannot be created the client is disconnected and the instance is
// reused.
static DWORD WINAPI accept_main(LPVOID param) {
  accept_start_t* start = (accept_start_t*)param;
  endpoint_t* server = start->server;
  napi_threadsafe_function tsfn = start->tsfn;
  free(start);
  HANDLE connect_event = CreateEventW(NULL, TRUE, FALSE, NULL);
  HANDLE pipe = server->pending_pipe;  // first instance, created synchronously
  server->pending_pipe = NULL;
  while (connect_event && !server->stopping) {
    OVERLAPPED overlapped;
    ZeroMemory(&overlapped, sizeof(overlapped));
    ResetEvent(connect_event);
    overlapped.hEvent = connect_event;
    BOOL connected = ConnectNamedPipe(pipe, &overlapped);
    DWORD error = connected ? ERROR_SUCCESS : GetLastError();
    if (!connected && error == ERROR_IO_PENDING) {
      HANDLE waits[2] = {connect_event, server->stop_event};
      DWORD which = WaitForMultipleObjects(2, waits, FALSE, INFINITE);
      if (which != WAIT_OBJECT_0) {
        CancelIoEx(pipe, &overlapped);
        DWORD ignored = 0;
        GetOverlappedResult(pipe, &overlapped, &ignored, TRUE);
        break;
      }
      DWORD ignored = 0;
      connected = GetOverlappedResult(pipe, &overlapped, &ignored, FALSE);
      error = connected ? ERROR_SUCCESS : GetLastError();
    }
    if (!connected && error == ERROR_PIPE_CONNECTED) connected = TRUE;
    if (!connected) {
      // The client vanished before the connection completed: reset and reuse
      // this instance (closing it could free the name).
      DisconnectNamedPipe(pipe);
      if (error != ERROR_NO_DATA &&
          WaitForSingleObject(server->stop_event, 50) == WAIT_OBJECT_0) {
        break;
      }
      continue;
    }

    HANDLE next = create_instance(server, FALSE);
    if (next == INVALID_HANDLE_VALUE) {
      post_win32_error(tsfn, "CreateNamedPipe", GetLastError());
      DisconnectNamedPipe(pipe);
      if (WaitForSingleObject(server->stop_event, 250) == WAIT_OBJECT_0) break;
      continue;
    }

    ULONG client_pid = 0;
    GetNamedPipeClientProcessId(pipe, &client_pid);
    // References: endpoint list + reader.
    connection_t* connection = connection_new(server, pipe, 2);
    if (!connection) {
      // Out of memory: drop this client; `next` keeps the name claimed.
      DisconnectNamedPipe(pipe);
      CloseHandle(pipe);
      pipe = next;
      continue;
    }
    pipe = next;
    napi_threadsafe_function reader_tsfn = tsfn;
    if (napi_acquire_threadsafe_function(reader_tsfn) != napi_ok) {
      // The event callback is shutting down: so is the server.
      close_connection(connection, FALSE);
      connection->refs = 1;
      connection_unref(connection);
      break;
    }

    EnterCriticalSection(&server->lock);
    BOOL accepted = !server->stopping;
    if (accepted) {
      connection->id = ++server->next_id;
      connection->next = server->connections;
      server->connections = connection;
    }
    LeaveCriticalSection(&server->lock);
    if (!accepted) {
      close_connection(connection, FALSE);
      connection_unref(connection);  // the list reference it never got
      start_reader(connection, reader_tsfn);
      break;
    }
    post_event(tsfn, EVENT_CONNECTION, connection->id, client_pid, NULL, 0, NULL);
    start_reader(connection, reader_tsfn);
  }
  if (pipe && pipe != INVALID_HANDLE_VALUE) CloseHandle(pipe);
  if (connect_event) CloseHandle(connect_event);
  endpoint_unref(server);
  napi_release_threadsafe_function(tsfn, napi_tsfn_release);
  return 0;
}

// Returns the connection with an extra reference, or NULL.
static connection_t* acquire_connection(endpoint_t* endpoint, uint32_t id) {
  EnterCriticalSection(&endpoint->lock);
  connection_t* current = endpoint->connections;
  while (current && current->id != id) current = current->next;
  if (current) InterlockedIncrement(&current->refs);
  LeaveCriticalSection(&endpoint->lock);
  return current;
}

// Removes the connection from the list; returns it (still holding the list
// reference) or NULL.
static connection_t* detach_connection(endpoint_t* endpoint, uint32_t id) {
  EnterCriticalSection(&endpoint->lock);
  connection_t** link = &endpoint->connections;
  while (*link && (*link)->id != id) link = &(*link)->next;
  connection_t* found = *link;
  if (found) *link = found->next;
  LeaveCriticalSection(&endpoint->lock);
  return found;
}

// Main thread. Stops accepting, joins the accept thread and drops every
// connection. Readers finish on their own and release their references.
static void stop_endpoint(endpoint_t* endpoint) {
  if (InterlockedExchange(&endpoint->stopping, 1) != 0) return;
  SetEvent(endpoint->stop_event);
  if (endpoint->accept_thread) {
    // The accept thread never waits on the main thread, so this join is bounded.
    WaitForSingleObject(endpoint->accept_thread, INFINITE);
  }
  EnterCriticalSection(&endpoint->lock);
  connection_t* list = endpoint->connections;
  endpoint->connections = NULL;
  LeaveCriticalSection(&endpoint->lock);
  while (list) {
    connection_t* next = list->next;
    close_connection(list, FALSE);
    connection_unref(list);
    list = next;
  }
}

// Main thread: drop the main thread's threadsafe-function reference once.
static void release_owner_reference(endpoint_t* endpoint, napi_threadsafe_function_release_mode mode) {
  if (endpoint->owner_released || !endpoint->tsfn) return;
  endpoint->owner_released = TRUE;
  napi_release_threadsafe_function(endpoint->tsfn, mode);
}

static void endpoint_finalize(napi_env env, void* data, void* hint) {
  (void)env;
  (void)hint;
  endpoint_t* endpoint = (endpoint_t*)data;
  stop_endpoint(endpoint);
  release_owner_reference(endpoint, napi_tsfn_release);
  endpoint_unref(endpoint);
}

static napi_status create_tsfn(napi_env env, napi_value callback, endpoint_t* endpoint) {
  napi_value resource_name;
  napi_create_string_utf8(env, "ResinPipe", NAPI_AUTO_LENGTH, &resource_name);
  return napi_create_threadsafe_function(env, callback, NULL, resource_name, 0, 1, NULL, NULL,
                                         NULL, call_js_event, &endpoint->tsfn);
}

// createPipeServer(name, onEvent) -> external
static napi_value js_create_pipe_server(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 2) {
    napi_throw_type_error(env, NULL, "createPipeServer(name, onEvent)");
    return NULL;
  }
  wchar_t* name = get_string_arg(env, argv[0]);
  if (!name) return NULL;
  if (wcsncmp(name, L"\\\\.\\pipe\\", 9) != 0) {
    free(name);
    napi_throw_type_error(env, NULL, "pipe name must start with \\\\.\\pipe\\");
    return NULL;
  }
  endpoint_t* server = endpoint_new(name, FALSE);
  free(name);
  if (!server) {
    napi_throw_error(env, NULL, "out of memory");
    return NULL;
  }
  DWORD error = 0;
  PSID user = current_user_sid(&error);
  if (!user) {
    endpoint_unref(server);
    return throw_win32(env, "OpenProcessToken", error);
  }
  server->sd = owner_only_descriptor(user, FALSE, TRUE, &error);
  LocalFree(user);
  if (!server->sd) {
    endpoint_unref(server);
    return throw_win32(env, "ConvertStringSecurityDescriptor", error);
  }
  server->sa.nLength = sizeof(SECURITY_ATTRIBUTES);
  server->sa.lpSecurityDescriptor = server->sd;
  server->sa.bInheritHandle = FALSE;

  // Claim the name synchronously and exclusively so callers learn about a
  // squatter or a second daemon immediately.
  server->pending_pipe = create_instance(server, TRUE);
  if (server->pending_pipe == INVALID_HANDLE_VALUE) {
    error = GetLastError();
    server->pending_pipe = NULL;
    endpoint_unref(server);
    return throw_win32(env,
                       error == ERROR_ACCESS_DENIED ? "CreateNamedPipe (name already in use)"
                                                    : "CreateNamedPipe",
                       error);
  }

  if (create_tsfn(env, argv[1], server) != napi_ok) {
    endpoint_unref(server);
    napi_throw_error(env, NULL, "napi_create_threadsafe_function failed");
    return NULL;
  }
  accept_start_t* start = (accept_start_t*)malloc(sizeof(accept_start_t));
  if (!start || napi_acquire_threadsafe_function(server->tsfn) != napi_ok) {
    free(start);
    release_owner_reference(server, napi_tsfn_abort);
    endpoint_unref(server);
    napi_throw_error(env, NULL, "cannot start the pipe server");
    return NULL;
  }
  start->server = server;
  start->tsfn = server->tsfn;
  InterlockedIncrement(&server->refs);  // the accept thread's reference
  server->accept_thread = CreateThread(NULL, 0, accept_main, start, 0, NULL);
  if (!server->accept_thread) {
    error = GetLastError();
    free(start);
    napi_release_threadsafe_function(server->tsfn, napi_tsfn_release);
    InterlockedDecrement(&server->refs);
    release_owner_reference(server, napi_tsfn_abort);
    endpoint_unref(server);
    return throw_win32(env, "CreateThread", error);
  }

  napi_value external;
  napi_create_external(env, server, endpoint_finalize, NULL, &external);
  return external;
}

static endpoint_t* get_endpoint(napi_env env, napi_value value) {
  void* data = NULL;
  if (napi_get_value_external(env, value, &data) != napi_ok || !data) {
    napi_throw_type_error(env, NULL, "expected a pipe handle");
    return NULL;
  }
  return (endpoint_t*)data;
}

// --- Verified client -------------------------------------------------------

typedef struct {
  napi_async_work work;
  napi_ref on_event;
  napi_ref callback;
  wchar_t* name;
  DWORD timeout_ms;
  HANDLE pipe;
  DWORD error;
  const char* reason;
  ULONG server_pid;
} connect_request_t;

// Threadpool: open the pipe, then check the owner of the pipe object and the
// user of the server process on this exact handle before anything is sent.
// SECURITY_IDENTIFICATION keeps the server from impersonating the client.
static void connect_execute(napi_env env, void* data) {
  (void)env;
  connect_request_t* request = (connect_request_t*)data;
  ULONGLONG deadline = GetTickCount64() + request->timeout_ms;
  HANDLE pipe = INVALID_HANDLE_VALUE;
  DWORD error = 0;
  for (;;) {
    pipe = CreateFileW(request->name, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING,
                       FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                       NULL);
    if (pipe != INVALID_HANDLE_VALUE) break;
    error = GetLastError();
    ULONGLONG now = GetTickCount64();
    if (error != ERROR_PIPE_BUSY || now >= deadline) break;
    ULONGLONG remaining = deadline - now;
    WaitNamedPipeW(request->name, (DWORD)(remaining < 250 ? remaining : 250));
  }
  if (pipe == INVALID_HANDLE_VALUE) {
    request->error = error;
    request->reason = error == ERROR_FILE_NOT_FOUND ? "not-running"
                      : error == ERROR_ACCESS_DENIED ? "access-denied"
                                                     : "open-failed";
    return;
  }
  PSID me = current_user_sid(&error);
  PSID owner = NULL;
  PSECURITY_DESCRIPTOR sd = NULL;
  DWORD status = GetSecurityInfo(pipe, SE_KERNEL_OBJECT, OWNER_SECURITY_INFORMATION, &owner, NULL,
                                 NULL, NULL, &sd);
  ULONG server_pid = 0;
  BOOL have_pid = GetNamedPipeServerProcessId(pipe, &server_pid);
  PSID server_sid = have_pid ? process_user_sid(server_pid, &error) : NULL;
  BOOL owner_matches = me && owner && status == ERROR_SUCCESS && EqualSid(me, owner);
  BOOL server_matches = me && server_sid && EqualSid(me, server_sid);
  if (sd) LocalFree(sd);
  if (me) LocalFree(me);
  if (server_sid) LocalFree(server_sid);
  if (!(owner_matches && server_matches)) {
    CloseHandle(pipe);
    request->reason = !owner_matches ? "foreign-owner" : "foreign-server";
    return;
  }
  request->pipe = pipe;
  request->server_pid = server_pid;
}

static void connect_complete(napi_env env, napi_status status, void* data) {
  connect_request_t* request = (connect_request_t*)data;
  napi_value callback, on_event, undefined, result, value;
  napi_get_reference_value(env, request->callback, &callback);
  napi_get_reference_value(env, request->on_event, &on_event);
  napi_get_undefined(env, &undefined);
  napi_create_object(env, &result);
  const char* failure = status == napi_ok ? request->reason : "open-failed";
  if (failure && request->pipe && request->pipe != INVALID_HANDLE_VALUE) {
    CloseHandle(request->pipe);
  }
  endpoint_t* endpoint = NULL;
  if (!failure) {
    endpoint = endpoint_new(request->name, TRUE);
    connection_t* connection = endpoint ? connection_new(endpoint, request->pipe, 2) : NULL;
    napi_threadsafe_function reader_tsfn = NULL;
    BOOL ready = connection != NULL && create_tsfn(env, on_event, endpoint) == napi_ok;
    if (ready) {
      reader_tsfn = endpoint->tsfn;
      ready = napi_acquire_threadsafe_function(reader_tsfn) == napi_ok;
      if (!ready) release_owner_reference(endpoint, napi_tsfn_abort);
    }
    if (!ready) {
      if (connection) {
        connection->refs = 1;
        connection_unref(connection);  // closes the pipe, drops its endpoint ref
      } else {
        CloseHandle(request->pipe);
      }
      if (endpoint) endpoint_unref(endpoint);
      endpoint = NULL;
      failure = "open-failed";
    } else {
      connection->id = 1;
      endpoint->connections = connection;
      endpoint->next_id = 1;
      start_reader(connection, reader_tsfn);
    }
    request->pipe = NULL;
  }
  napi_get_boolean(env, failure == NULL, &value);
  napi_set_named_property(env, result, "ok", value);
  if (failure) {
    napi_create_string_utf8(env, failure, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, result, "reason", value);
    napi_create_uint32(env, request->error, &value);
    napi_set_named_property(env, result, "win32Error", value);
  } else {
    napi_create_external(env, endpoint, endpoint_finalize, NULL, &value);
    napi_set_named_property(env, result, "handle", value);
    napi_create_uint32(env, request->server_pid, &value);
    napi_set_named_property(env, result, "serverPid", value);
  }
  napi_delete_reference(env, request->callback);
  napi_delete_reference(env, request->on_event);
  napi_delete_async_work(env, request->work);
  free(request->name);
  free(request);
  napi_value null_value;
  napi_get_null(env, &null_value);
  napi_value argv[2] = {null_value, result};
  napi_call_function(env, undefined, callback, 2, argv, NULL);
}

// pipeConnect(name, timeoutMs, onEvent, callback)
static napi_value js_pipe_connect(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 4) {
    napi_throw_type_error(env, NULL, "pipeConnect(name, timeoutMs, onEvent, callback)");
    return NULL;
  }
  wchar_t* name = get_string_arg(env, argv[0]);
  if (!name) return NULL;
  if (wcsncmp(name, L"\\\\.\\pipe\\", 9) != 0) {
    free(name);
    napi_throw_type_error(env, NULL, "pipe name must start with \\\\.\\pipe\\");
    return NULL;
  }
  uint32_t timeout_ms = 0;
  napi_get_value_uint32(env, argv[1], &timeout_ms);
  connect_request_t* request = (connect_request_t*)calloc(1, sizeof(connect_request_t));
  if (!request) {
    free(name);
    napi_throw_error(env, NULL, "out of memory");
    return NULL;
  }
  request->name = name;
  request->timeout_ms = timeout_ms;
  napi_create_reference(env, argv[2], 1, &request->on_event);
  napi_create_reference(env, argv[3], 1, &request->callback);
  napi_value resource_name;
  napi_create_string_utf8(env, "ResinPipeConnect", NAPI_AUTO_LENGTH, &resource_name);
  napi_create_async_work(env, NULL, resource_name, connect_execute, connect_complete, request,
                         &request->work);
  napi_queue_async_work(env, request->work);
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

// --- Writes and closing ----------------------------------------------------

typedef struct {
  napi_async_work work;
  napi_ref callback;
  napi_ref buffer_ref;
  connection_t* connection;
  char* data;
  size_t length;
  DWORD error;
} write_request_t;

static void write_execute(napi_env env, void* data) {
  (void)env;
  write_request_t* request = (write_request_t*)data;
  connection_t* connection = request->connection;
  if (!connection || connection->closed) {
    request->error = ERROR_PIPE_NOT_CONNECTED;
    return;
  }
  EnterCriticalSection(&connection->write_lock);
  size_t offset = 0;
  while (offset < request->length && !connection->closed) {
    OVERLAPPED overlapped;
    ZeroMemory(&overlapped, sizeof(overlapped));
    ResetEvent(connection->write_event);
    overlapped.hEvent = connection->write_event;
    size_t remaining = request->length - offset;
    DWORD chunk = (DWORD)(remaining < PIPE_BUFFER_BYTES ? remaining : PIPE_BUFFER_BYTES);
    DWORD written = 0;
    BOOL ok = WriteFile(connection->pipe, request->data + offset, chunk, NULL, &overlapped);
    DWORD error = ok ? ERROR_SUCCESS : GetLastError();
    if (ok || error == ERROR_IO_PENDING) {
      ok = GetOverlappedResult(connection->pipe, &overlapped, &written, TRUE);
      error = ok ? ERROR_SUCCESS : GetLastError();
    }
    if (!ok) {
      request->error = error;
      break;
    }
    offset += written;
  }
  if (offset < request->length && request->error == 0) request->error = ERROR_PIPE_NOT_CONNECTED;
  LeaveCriticalSection(&connection->write_lock);
}

static void write_complete(napi_env env, napi_status status, void* data) {
  (void)status;
  write_request_t* request = (write_request_t*)data;
  if (request->connection) connection_unref(request->connection);
  napi_value callback;
  napi_get_reference_value(env, request->callback, &callback);
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  napi_value arg;
  if (request->error) {
    char message[64];
    _snprintf_s(message, sizeof(message), _TRUNCATE, "WriteFile failed (win32 error %lu)",
                (unsigned long)request->error);
    napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &arg);
  } else {
    napi_get_null(env, &arg);
  }
  napi_delete_reference(env, request->buffer_ref);
  napi_delete_reference(env, request->callback);
  napi_delete_async_work(env, request->work);
  free(request);
  napi_call_function(env, undefined, callback, 1, &arg, NULL);
}

// pipeWrite(endpoint, id, buffer, callback)
static napi_value js_pipe_write(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 4) {
    napi_throw_type_error(env, NULL, "pipeWrite(endpoint, id, buffer, callback)");
    return NULL;
  }
  endpoint_t* endpoint = get_endpoint(env, argv[0]);
  if (!endpoint) return NULL;
  uint32_t id = 0;
  napi_get_value_uint32(env, argv[1], &id);
  void* data = NULL;
  size_t length = 0;
  if (napi_get_buffer_info(env, argv[2], &data, &length) != napi_ok) {
    napi_throw_type_error(env, NULL, "expected a Buffer");
    return NULL;
  }
  write_request_t* request = (write_request_t*)calloc(1, sizeof(write_request_t));
  if (!request) {
    napi_throw_error(env, NULL, "out of memory");
    return NULL;
  }
  request->connection = acquire_connection(endpoint, id);
  request->data = (char*)data;
  request->length = length;
  napi_create_reference(env, argv[3], 1, &request->callback);
  napi_create_reference(env, argv[2], 1, &request->buffer_ref);
  napi_value resource_name;
  napi_create_string_utf8(env, "ResinPipeWrite", NAPI_AUTO_LENGTH, &resource_name);
  napi_create_async_work(env, NULL, resource_name, write_execute, write_complete, request,
                         &request->work);
  napi_queue_async_work(env, request->work);
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

// pipeClose(endpoint, id, graceful): stop serving the connection and release
// it. `graceful` keeps already-written data readable by the peer.
static napi_value js_pipe_close(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 2) {
    napi_throw_type_error(env, NULL, "pipeClose(endpoint, id, graceful)");
    return NULL;
  }
  endpoint_t* endpoint = get_endpoint(env, argv[0]);
  if (!endpoint) return NULL;
  uint32_t id = 0;
  napi_get_value_uint32(env, argv[1], &id);
  bool graceful = false;
  if (argc >= 3) napi_get_value_bool(env, argv[2], &graceful);
  connection_t* connection = detach_connection(endpoint, id);
  if (connection) {
    close_connection(connection, graceful ? TRUE : FALSE);
    connection_unref(connection);
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

// pipeServerClose(endpoint): stop accepting, disconnect every connection and
// drop the main thread's event-callback reference.
static napi_value js_pipe_server_close(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  endpoint_t* endpoint = get_endpoint(env, argv[0]);
  if (!endpoint) return NULL;
  stop_endpoint(endpoint);
  release_owner_reference(endpoint, napi_tsfn_release);
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

// ---------------------------------------------------------------------------
// Test probe: access as "anyone but the current user"
// ---------------------------------------------------------------------------
//
// probeOpenWithUserSidDisabled(path, desiredAccess) -> { ok, win32Error }
//
// Builds a restricted copy of the process token in which the current user's
// SID is deny-only, impersonates it on this thread, and tries CreateFile. Every
// group the user belongs to (Everyone, Users, Authenticated Users, INTERACTIVE,
// the logon SID, ...) stays enabled, so this answers "could another local
// principal open this object?" without creating a second Windows account. It
// exists for tests and diagnostics only and never changes any object.
static napi_value js_probe_open_with_user_sid_disabled(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 2) {
    napi_throw_type_error(env, NULL, "probeOpenWithUserSidDisabled(path, desiredAccess)");
    return NULL;
  }
  wchar_t* path = get_string_arg(env, argv[0]);
  if (!path) return NULL;
  uint32_t desired_access = 0;
  napi_get_value_uint32(env, argv[1], &desired_access);

  DWORD error = 0;
  HANDLE process_token = NULL;
  if (!OpenProcessToken(GetCurrentProcess(),
                        TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_IMPERSONATE,
                        &process_token)) {
    error = GetLastError();
    free(path);
    return throw_win32(env, "OpenProcessToken", error);
  }
  PSID user = current_user_sid(&error);
  if (!user) {
    CloseHandle(process_token);
    free(path);
    return throw_win32(env, "OpenProcessToken", error);
  }
  SID_AND_ATTRIBUTES disable;
  disable.Sid = user;
  disable.Attributes = 0;
  HANDLE restricted = NULL;
  if (!CreateRestrictedToken(process_token, 0, 1, &disable, 0, NULL, 0, NULL, &restricted)) {
    error = GetLastError();
    LocalFree(user);
    CloseHandle(process_token);
    free(path);
    return throw_win32(env, "CreateRestrictedToken", error);
  }
  LocalFree(user);
  CloseHandle(process_token);
  if (!ImpersonateLoggedOnUser(restricted)) {
    error = GetLastError();
    CloseHandle(restricted);
    free(path);
    return throw_win32(env, "ImpersonateLoggedOnUser", error);
  }
  HANDLE handle = CreateFileW(path, desired_access, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                              NULL, OPEN_EXISTING,
                              FILE_FLAG_BACKUP_SEMANTICS | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                              NULL);
  DWORD open_error = handle == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_SUCCESS;
  if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
  BOOL reverted = RevertToSelf();
  DWORD revert_error = reverted ? 0 : GetLastError();
  CloseHandle(restricted);
  free(path);
  if (!reverted) return throw_win32(env, "RevertToSelf", revert_error);

  napi_value result;
  napi_create_object(env, &result);
  napi_value ok_value;
  napi_get_boolean(env, open_error == ERROR_SUCCESS, &ok_value);
  napi_set_named_property(env, result, "ok", ok_value);
  napi_value code;
  napi_create_uint32(env, open_error, &code);
  napi_set_named_property(env, result, "win32Error", code);
  return result;
}

// squatPipeForTesting(name, sddl) -> external: claims `name` with one listening
// instance protected by an arbitrary security descriptor, to stand in for a
// pipe planted by another principal. releaseSquattedPipe(external) frees it.
// Test/diagnostic probe only.
static void squat_finalize(napi_env env, void* data, void* hint) {
  (void)env;
  (void)hint;
  HANDLE* slot = (HANDLE*)data;
  if (*slot && *slot != INVALID_HANDLE_VALUE) CloseHandle(*slot);
  free(slot);
}

static napi_value js_squat_pipe_for_testing(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 2) {
    napi_throw_type_error(env, NULL, "squatPipeForTesting(name, sddl)");
    return NULL;
  }
  wchar_t* name = get_string_arg(env, argv[0]);
  if (!name) return NULL;
  wchar_t* sddl = get_string_arg(env, argv[1]);
  if (!sddl) {
    free(name);
    return NULL;
  }
  PSECURITY_DESCRIPTOR sd = NULL;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &sd, NULL)) {
    DWORD error = GetLastError();
    free(name);
    free(sddl);
    return throw_win32(env, "ConvertStringSecurityDescriptor", error);
  }
  SECURITY_ATTRIBUTES sa;
  sa.nLength = sizeof(sa);
  sa.lpSecurityDescriptor = sd;
  sa.bInheritHandle = FALSE;
  HANDLE pipe = CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                                 PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT, 1, 4096, 4096,
                                 0, &sa);
  DWORD error = pipe == INVALID_HANDLE_VALUE ? GetLastError() : 0;
  LocalFree(sd);
  free(name);
  free(sddl);
  if (pipe == INVALID_HANDLE_VALUE) return throw_win32(env, "CreateNamedPipe", error);
  HANDLE* slot = (HANDLE*)malloc(sizeof(HANDLE));
  if (!slot) {
    CloseHandle(pipe);
    napi_throw_error(env, NULL, "out of memory");
    return NULL;
  }
  *slot = pipe;
  napi_value external;
  napi_create_external(env, slot, squat_finalize, NULL, &external);
  return external;
}

static napi_value js_release_squatted_pipe(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  void* data = NULL;
  if (argc < 1 || napi_get_value_external(env, argv[0], &data) != napi_ok || !data) {
    napi_throw_type_error(env, NULL, "releaseSquattedPipe(handle)");
    return NULL;
  }
  HANDLE* slot = (HANDLE*)data;
  if (*slot && *slot != INVALID_HANDLE_VALUE) {
    CloseHandle(*slot);
    *slot = NULL;
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"currentUserSid", NULL, js_current_user_sid, NULL, NULL, NULL, napi_default, NULL},
      {"setOwnerOnlyAcl", NULL, js_set_owner_only_acl, NULL, NULL, NULL, napi_default, NULL},
      {"writePrivateFileExclusive", NULL, js_write_private_file_exclusive, NULL, NULL, NULL,
       napi_default, NULL},
      {"createPrivateDirectory", NULL, js_create_private_directory, NULL, NULL, NULL,
       napi_default, NULL},
      {"readAcl", NULL, js_read_acl, NULL, NULL, NULL, napi_default, NULL},
      {"verifyPipeServer", NULL, js_verify_pipe_server, NULL, NULL, NULL, napi_default, NULL},
      {"readPipeAcl", NULL, js_read_pipe_acl, NULL, NULL, NULL, napi_default, NULL},
      {"createPipeServer", NULL, js_create_pipe_server, NULL, NULL, NULL, napi_default, NULL},
      {"pipeConnect", NULL, js_pipe_connect, NULL, NULL, NULL, napi_default, NULL},
      {"pipeWrite", NULL, js_pipe_write, NULL, NULL, NULL, napi_default, NULL},
      {"pipeClose", NULL, js_pipe_close, NULL, NULL, NULL, napi_default, NULL},
      {"pipeServerClose", NULL, js_pipe_server_close, NULL, NULL, NULL, napi_default, NULL},
      {"probeOpenWithUserSidDisabled", NULL, js_probe_open_with_user_sid_disabled, NULL, NULL,
       NULL, napi_default, NULL},
      {"squatPipeForTesting", NULL, js_squat_pipe_for_testing, NULL, NULL, NULL, napi_default,
       NULL},
      {"releaseSquattedPipe", NULL, js_release_squatted_pipe, NULL, NULL, NULL, napi_default,
       NULL},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
