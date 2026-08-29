import path from "node:path";
import process from "node:process";

export type ServiceManagerKind = "systemd" | "launchd" | "wsl-systemd" | "wsl-fallback";

export interface ServiceGeneratorOptions {
  serviceName?: string;
  description?: string;
  daemonPath?: string;
  nodePath?: string;
  args?: string[];
  homeDir?: string;
  resinHome?: string;
  logDir?: string;
  stateDir?: string;
  env?: Record<string, string | undefined>;
  restartSec?: number;
  enableHardening?: boolean;
}
export interface ServiceValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Escapes strings for XML attributes/nodes.
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Escapes values for systemd unit file Environment directives.
 */
function escapeSystemdEnv(val: string): string {
  if (/[\s"'\\]/.test(val)) {
    return `"${val.replace(/["\\]/g, "\\$&")}"`;
  }
  return val;
}

/**
 * Generates a systemd user service unit file content for Linux and WSL (systemd).
 */
export function generateSystemdUnit(options: ServiceGeneratorOptions = {}): string {
  const serviceName = options.serviceName ?? "resin";
  const description = options.description ?? "Resin Background Observer and Evolution Daemon";
  const homeDir = options.homeDir ?? process.env.HOME ?? "";
  const resinHome = options.resinHome ?? path.join(homeDir, ".resin");
  const daemonPath = options.daemonPath ?? path.join(resinHome, "bin", "resin-daemon");
  const nodePath = options.nodePath ?? process.execPath;
  const restartSec = options.restartSec ?? 3;
  const enableHardening = options.enableHardening ?? false;

  const extraArgs = options.args && options.args.length > 0 ? ` ${options.args.join(" ")}` : "";
  const execStart = `${nodePath} ${daemonPath}${extraArgs}`;

  const envEntries: string[] = [
    `Environment="NODE_ENV=production"`,
    `Environment="RESIN_HOME=${resinHome}"`,
  ];

  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      if (value !== undefined) {
        envEntries.push(`Environment="${key}=${escapeSystemdEnv(value)}"`);
      }
    }
  }

  const hardeningDirectives = enableHardening
    ? [
        "# Security and Sandbox Hardening",
        "NoNewPrivileges=yes",
        "PrivateTmp=true",
        "ProtectSystem=strict",
        `ReadWritePaths=${resinHome}`,
      ]
    : [];

  const lines = [
    "[Unit]",
    `Description=${description}`,
    "Documentation=https://github.com/Resin-AI/resin",
    "After=network.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${execStart}`,
    "Restart=always",
    `RestartSec=${restartSec}`,
    "TimeoutStopSec=15",
    "StandardOutput=journal",
    "StandardError=journal",
    `WorkingDirectory=${resinHome}`,
    ...envEntries,
    ...hardeningDirectives,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ];

  return lines.join("\n");
}

/**
 * Generates a launchd user agent plist file for macOS.
 */
export function generateLaunchdPlist(options: ServiceGeneratorOptions = {}): string {
  const serviceName = options.serviceName ?? "com.resin.daemon";
  const homeDir = options.homeDir ?? process.env.HOME ?? "";
  const resinHome = options.resinHome ?? path.join(homeDir, ".resin");
  const daemonPath = options.daemonPath ?? path.join(resinHome, "bin", "resin-daemon");
  const nodePath = options.nodePath ?? process.execPath;
  const logDir = options.logDir ?? path.join(homeDir, "Library", "Logs", "resin");

  const stdoutPath = path.join(logDir, "daemon.log");
  const stderrPath = path.join(logDir, "daemon.err.log");

  const programArguments = [nodePath, daemonPath, ...(options.args ?? [])];

  const envEntries: [string, string][] = [
    ["NODE_ENV", "production"],
    ["RESIN_HOME", resinHome],
  ];
  if (options.env) {
    for (const [k, v] of Object.entries(options.env)) {
      if (v !== undefined) {
        envEntries.push([k, v]);
      }
    }
  }

  const programArgsXml = programArguments
    .map((arg) => `      <string>${escapeXml(arg)}</string>`)
    .join("\n");

  const envXml = envEntries
    .map(
      ([k, v]) =>
        `      <key>${escapeXml(k)}</key>\n      <string>${escapeXml(String(v))}</string>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(serviceName)}</string>

  <key>ProgramArguments</key>
  <array>
${programArgsXml}
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
    <key>Crashed</key>
    <true/>
  </dict>

  <key>ProcessType</key>
  <string>Standard</string>

  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutPath)}</string>

  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrPath)}</string>

  <key>WorkingDirectory</key>
  <string>${escapeXml(resinHome)}</string>

  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
</dict>
</plist>
`;
}

/**
 * Generates a WSL supervisor fallback script for environments without systemd.
 */
export function generateWslFallbackScript(options: ServiceGeneratorOptions = {}): string {
  const homeDir = options.homeDir ?? process.env.HOME ?? "";
  const resinHome = options.resinHome ?? path.join(homeDir, ".resin");
  const daemonPath = options.daemonPath ?? path.join(resinHome, "bin", "resin-daemon");
  const nodePath = options.nodePath ?? process.execPath;
  const stateDir = options.stateDir ?? path.join(resinHome, "state");
  const logDir = options.logDir ?? path.join(resinHome, "logs");
  const pidFile = path.join(stateDir, "daemon.pid");
  const stdoutLog = path.join(logDir, "daemon.out.log");
  const stderrLog = path.join(logDir, "daemon.err.log");

  const envExports = Object.entries(options.env ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `export ${k}="${String(v).replace(/"/g, '\\"')}"`)
    .join("\n");

  return `#!/usr/bin/env bash
# Resin WSL Supervisor Fallback Daemon Runner
# Provides process supervisor, autostart, and health tracking in WSL environments without systemd.

set -euo pipefail

RESIN_HOME="${resinHome}"
NODE_PATH="${nodePath}"
DAEMON_PATH="${daemonPath}"
STATE_DIR="${stateDir}"
LOG_DIR="${logDir}"
PID_FILE="${pidFile}"
OUT_LOG="${stdoutLog}"
ERR_LOG="${stderrLog}"

mkdir -p "$STATE_DIR" "$LOG_DIR" "$RESIN_HOME"

${envExports}
export NODE_ENV="production"
export RESIN_HOME="$RESIN_HOME"

is_running() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

start_daemon() {
  if is_running; then
    echo "Resin daemon is already running with PID $(cat "$PID_FILE")."
    return 0
  fi

  echo "Starting Resin daemon in WSL fallback supervisor mode..."
  nohup "$NODE_PATH" "$DAEMON_PATH" >> "$OUT_LOG" 2>> "$ERR_LOG" &
  local new_pid=$!
  echo "$new_pid" > "$PID_FILE"
  echo "Resin daemon started (PID: $new_pid)."
}

stop_daemon() {
  if ! is_running; then
    echo "Resin daemon is not running."
    rm -f "$PID_FILE"
    return 0
  fi

  local pid
  pid=$(cat "$PID_FILE")
  echo "Stopping Resin daemon (PID: $pid)..."
  kill "$pid" 2>/dev/null || true

  # Wait up to 10 seconds for graceful shutdown
  for _ in {1..20}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    sleep 0.5
  done

  if kill -0 "$pid" 2>/dev/null; then
    echo "Force killing daemon (PID: $pid)..."
    kill -9 "$pid" 2>/dev/null || true
  fi

  rm -f "$PID_FILE"
  echo "Resin daemon stopped."
}

status_daemon() {
  if is_running; then
    echo "active (running) - PID: $(cat "$PID_FILE")"
    return 0
  else
    echo "inactive (dead)"
    return 3
  fi
}

case "\${1:-status}" in
  start)
    start_daemon
    ;;
  stop)
    stop_daemon
    ;;
  restart)
    stop_daemon
    sleep 1
    start_daemon
    ;;
  status)
    status_daemon
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}"
    exit 1
    ;;
esac
`;
}

/**
 * Validates generated service definitions for syntax and completeness.
 */
export function validateServiceDefinition(
  type: ServiceManagerKind,
  content: string,
): ServiceValidationResult {
  const errors: string[] = [];

  if (!content || content.trim().length === 0) {
    return { valid: false, errors: ["Service content is empty."] };
  }

  if (type === "systemd" || type === "wsl-systemd") {
    if (!content.includes("[Unit]")) errors.push("Missing [Unit] section in systemd service.");
    if (!content.includes("[Service]"))
      errors.push("Missing [Service] section in systemd service.");
    if (!content.includes("[Install]"))
      errors.push("Missing [Install] section in systemd service.");
    if (!content.includes("ExecStart="))
      errors.push("Missing ExecStart directive in systemd service.");
  } else if (type === "launchd") {
    if (!content.includes("<!DOCTYPE plist"))
      errors.push("Missing XML DOCTYPE header in launchd plist.");
    if (!content.includes("<key>Label</key>"))
      errors.push("Missing <key>Label</key> in launchd plist.");
    if (!content.includes("<key>ProgramArguments</key>"))
      errors.push("Missing <key>ProgramArguments</key> in launchd plist.");
    if (!content.includes("<key>RunAtLoad</key>"))
      errors.push("Missing <key>RunAtLoad</key> in launchd plist.");
  } else if (type === "wsl-fallback") {
    if (!content.startsWith("#!/usr/bin/env bash"))
      errors.push("Missing bash shebang in WSL fallback script.");
    if (!content.includes("start_daemon()"))
      errors.push("Missing start_daemon function in WSL fallback script.");
    if (!content.includes("stop_daemon()"))
      errors.push("Missing stop_daemon function in WSL fallback script.");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
