#!/bin/sh
# Resin Standalone Installer Bootstrap Script
# Portable POSIX sh script for Linux, macOS, and Windows WSL2.
#
# Helper URL: https://dist.resin.sh/releases/v1/installers/install-helper-v1.mjs
# Pinned SHA-256: 3218802b9a9f5ca18398b1cb56705e0b28ea3eb831c6b15d6af70a1db4705ac6
#
# Inspect-First Workflow:
#   sh install.sh --download-only ./install-helper.mjs
#   node ./install-helper.mjs [options]

set -eu

# Enforce secure umask
umask 077

# Constants
PINNED_HELPER_URL="https://dist.resin.sh/releases/v1/installers/install-helper-v1.mjs"
PINNED_HELPER_SHA256="3218802b9a9f5ca18398b1cb56705e0b28ea3eb831c6b15d6af70a1db4705ac6"
REQUIRED_NODE_MAJOR=22

# Temporary directory management
TMP_DIR=""
cleanup() {
  EXIT_CODE=$?
  if [ -n "${TMP_DIR:-}" ] && [ -d "${TMP_DIR:-}" ]; then
    rm -rf "$TMP_DIR" 2>/dev/null || true
  fi
  exit "$EXIT_CODE"
}
trap cleanup EXIT INT TERM HUP

# Preflight: OS Support Check
check_os() {
  OS="$(uname -s 2>/dev/null || echo "Unknown")"
  case "$OS" in
    Linux)
      # Linux and WSL are supported
      ;;
    Darwin)
      # macOS is supported
      ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT*)
      echo "Error: Native Windows shell environments (cmd.exe, PowerShell, Git Bash) are not supported directly." >&2
      echo "Resin requires WSL2 (Windows Subsystem for Linux 2) on Windows." >&2
      echo "" >&2
      echo "To install Resin on Windows:" >&2
      echo "  1. Install WSL2 by running 'wsl --install' in PowerShell as Administrator." >&2
      echo "  2. Open your WSL2 Linux terminal (e.g. Ubuntu)." >&2
      echo "  3. Run the installer inside WSL2: curl -fsSL https://resin.sh/install.sh | sh" >&2
      exit 1
      ;;
    *)
      echo "Error: Operating system '$OS' is not supported by Resin." >&2
      echo "Resin supports 64-bit Linux, macOS, and Windows WSL2." >&2
      exit 1
      ;;
  esac
}

# Preflight: Architecture Support Check
check_arch() {
  ARCH="$(uname -m 2>/dev/null || echo "Unknown")"
  case "$ARCH" in
    x86_64|amd64|arm64|aarch64)
      # Supported 64-bit architectures
      ;;
    *)
      echo "Error: CPU architecture '$ARCH' is not supported by Resin." >&2
      echo "Resin requires 64-bit x86_64 or arm64/aarch64." >&2
      exit 1
      ;;
  esac
}

# Preflight: Node.js Version Check
check_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "Error: Node.js is required to install Resin, but 'node' was not found in PATH." >&2
    echo "Resin requires Node.js >= ${REQUIRED_NODE_MAJOR}.0.0." >&2
    echo "Please install Node.js >= 22 (https://nodejs.org or via nvm/fnm) and try again." >&2
    exit 1
  fi

  NODE_CHECK="$(node --no-warnings -e '
    const version = process.versions.node || "";
    const major = parseInt(version.split(".")[0], 10);
    if (isNaN(major) || major < 22) {
      process.stdout.write("FAIL:" + version);
    } else {
      process.stdout.write("OK:" + version);
    }
  ' 2>/dev/null || echo "FAIL:unknown")"

  case "$NODE_CHECK" in
    OK:*)
      ;;
    FAIL:*)
      FOUND_VER="${NODE_CHECK#FAIL:}"
      echo "Error: Node.js >= ${REQUIRED_NODE_MAJOR}.0.0 is required, but found ${FOUND_VER}." >&2
      echo "Please upgrade Node.js to version 22 or later (https://nodejs.org) and try again." >&2
      exit 1
      ;;
    *)
      echo "Error: Failed to verify Node.js version." >&2
      exit 1
      ;;
  esac
}

# Help documentation
show_help() {
  cat <<'EOF'
Resin Standalone Installer for POSIX (Linux, macOS, WSL2)

Usage:
  curl -fsSL https://resin.sh/install.sh | sh
  sh install.sh [options]

Inspect-First Workflow:
  You can download and verify the installer helper script before running it:
    sh install.sh --download-only ./install-helper.mjs
    # Inspect the helper script in your editor, then execute:
    node ./install-helper.mjs [options]

  Or manually download and verify using curl:
    curl -fsSL https://dist.resin.sh/releases/v1/installers/install-helper-v1.mjs -o install-helper.mjs
    # Verify SHA-256: 3218802b9a9f5ca18398b1cb56705e0b28ea3eb831c6b15d6af70a1db4705ac6
    node ./install-helper.mjs

Options:
  --download-only <path>     Download and verify the install helper to <path> without executing
  --channel <name>           Release channel to install (default: stable)
  --channel-url <url>        Custom channel metadata URL
  --resin-home, --home <dir> Custom Resin installation directory (default: ~/.resin)
  -v, --verbose              Enable detailed installation logs
  --no-path-update           Do not configure PATH in shell profiles
  --json                     Output JSON result on completion
  --allow-insecure-loopback  Allow loopback HTTP during testing (requires RESIN_INSTALL_TEST_ONLY=1)
  -h, --help                 Show this help message

Prerequisites:
  - Node.js >= 22.0.0
  - 64-bit Linux, macOS, or Windows WSL2
EOF
}

# Parse and validate arguments
DOWNLOAD_ONLY=""
ALLOW_LOOPBACK="0"
JSON_OUTPUT="0"

# Inspect arguments without mutating "$@"
for ARG in "$@"; do
  case "$ARG" in
    -h|--help)
      show_help
      exit 0
      ;;
    -v|--verbose|--no-path-update|--skip-path-setup|--no-onboarding|--skip-onboarding|--auto-onboard|--local-only|--non-interactive)
      ;;
    --json)
      JSON_OUTPUT="1"
      ;;
    --download-only)
      # Checked in positional loop below
      ;;
    --download-only=*)
      DOWNLOAD_ONLY="${ARG#--download-only=}"
      if [ -z "$DOWNLOAD_ONLY" ]; then
        echo "Error: Missing value for argument: --download-only" >&2
        exit 1
      fi
      ;;
    --channel|--channel-url|--resin-home|--home)
      # Value follows in next argument, checked in positional loop
      ;;
    --channel=*|--channel-url=*|--resin-home=*|--home=*)
      VAL="${ARG#*=}"
      if [ -z "$VAL" ]; then
        echo "Error: Missing value for argument: ${ARG%%=*}" >&2
        exit 1
      fi
      ;;
    --allow-insecure-loopback)
      ALLOW_LOOPBACK="1"
      ;;
    -*)
      echo "Error: Unknown option: $ARG" >&2
      echo "Run 'sh install.sh --help' for usage instructions." >&2
      exit 1
      ;;
    *)
      # If previous was an option expecting value, it is checked below. Otherwise unexpected positional arg.
      ;;
  esac
done

# Detailed positional validation
ARGC=$#
I=1
while [ "$I" -le "$ARGC" ]; do
  eval "CURRENT=\"\${$I}\""
  case "$CURRENT" in
    -v|--verbose|--json|--no-path-update|--skip-path-setup|--no-onboarding|--skip-onboarding|--auto-onboard|--local-only|--non-interactive)
      ;;
    --download-only)
      I=$((I + 1))
      if [ "$I" -gt "$ARGC" ]; then
        echo "Error: Missing value for argument: --download-only" >&2
        exit 1
      fi
      eval "DOWNLOAD_ONLY=\"\${$I}\""
      if [ -z "$DOWNLOAD_ONLY" ] || [ "${DOWNLOAD_ONLY#-}" != "$DOWNLOAD_ONLY" ]; then
        echo "Error: Missing value for argument: --download-only" >&2
        exit 1
      fi
      ;;
    --channel|--channel-url|--resin-home|--home)
      OPT="$CURRENT"
      I=$((I + 1))
      if [ "$I" -gt "$ARGC" ]; then
        echo "Error: Missing value for argument: $OPT" >&2
        exit 1
      fi
      eval "OPT_VAL=\"\${$I}\""
      if [ -z "$OPT_VAL" ] || [ "${OPT_VAL#-}" != "$OPT_VAL" ]; then
        echo "Error: Missing value for argument: $OPT" >&2
        exit 1
      fi
      ;;
    --download-only=*|--channel=*|--channel-url=*|--resin-home=*|--home=*|--allow-insecure-loopback|-h|--help)
      # Valid flag
      ;;
    -*)
      echo "Error: Unknown option: $CURRENT" >&2
      exit 1
      ;;
    *)
      # Check if this positional argument was the value for a prior flag; if not, reject
      PREV_IDX=$((I - 1))
      if [ "$PREV_IDX" -ge 1 ]; then
        eval "PREV_ARG=\"\${$PREV_IDX}\""
        case "$PREV_ARG" in
          --download-only|--channel|--channel-url|--resin-home|--home)
            ;;
          *)
            echo "Error: Unexpected argument: $CURRENT" >&2
            exit 1
            ;;
        esac
      else
        echo "Error: Unexpected argument: $CURRENT" >&2
        exit 1
      fi
      ;;
  esac
  I=$((I + 1))
done

# Execute preflight checks before any temporary allocation or network activity
check_os
check_arch
check_node

# Determine target URL and expected checksum
IS_TEST_MODE="0"
if [ "${RESIN_INSTALL_TEST_ONLY:-0}" = "1" ] || [ "${RESIN_INSTALL_TEST_ONLY:-}" = "true" ]; then
  IS_TEST_MODE="1"
fi
CUSTOM_HELPER_URL="${RESIN_HELPER_URL:-${RESIN_INSTALL_HELPER_URL:-}}"
if [ "$IS_TEST_MODE" = "1" ]; then
  TARGET_HELPER_URL="${CUSTOM_HELPER_URL:-$PINNED_HELPER_URL}"
  EXPECTED_SHA256="${RESIN_TEST_HELPER_SHA256:-$PINNED_HELPER_SHA256}"
  ALLOW_LOOPBACK_FLAG="1"
else
  if [ -n "$CUSTOM_HELPER_URL" ] && [ "$CUSTOM_HELPER_URL" != "$PINNED_HELPER_URL" ]; then
    echo "Error: Custom helper URL is not permitted when RESIN_INSTALL_TEST_ONLY is disabled." >&2
    exit 1
  fi
  if [ "$ALLOW_LOOPBACK" = "1" ]; then
    echo "Error: --allow-insecure-loopback requires RESIN_INSTALL_TEST_ONLY=1." >&2
    exit 1
  fi
  TARGET_HELPER_URL="$PINNED_HELPER_URL"
  EXPECTED_SHA256="$PINNED_HELPER_SHA256"
  ALLOW_LOOPBACK_FLAG="0"
fi

# Allocate secure 0700 temporary directory
SYS_TMP="${TMPDIR:-/tmp}"
SYS_TMP="${SYS_TMP%/}"
TMP_DIR="$(mktemp -d "${SYS_TMP}/resin-install.XXXXXX" 2>/dev/null || true)"
if [ -z "$TMP_DIR" ] || [ ! -d "$TMP_DIR" ]; then
  TMP_DIR="${SYS_TMP}/resin-install.$$"
  mkdir -m 0700 -p "$TMP_DIR" 2>/dev/null || {
    echo "Error: Failed to create temporary directory in '$SYS_TMP'." >&2
    exit 1
  }
fi
chmod 0700 "$TMP_DIR" 2>/dev/null || true

# Determine helper file destination
if [ -n "$DOWNLOAD_ONLY" ]; then
  HELPER_DEST_PATH="$DOWNLOAD_ONLY"
else
  HELPER_DEST_PATH="$TMP_DIR/install-helper-v1.mjs"
fi

# Secure helper acquisition and cryptographic verification via Node.js
# Unset ambient proxy environment variables for anonymous direct connection
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY NO_PROXY no_proxy 2>/dev/null || true

node --no-warnings --input-type=module -e '
import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import process from "node:process";

const [targetFile, expectedSha, targetUrl, allowLoopbackStr] = process.argv.slice(1);
const allowLoopback = allowLoopbackStr === "1";

const MAX_HELPER_BYTES = 1024 * 1024; // 1 MiB
const MAX_HEADER_BYTES = 64 * 1024;   // 64 KiB
const SOCKET_TIMEOUT_MS = 15000;      // 15s connect / idle timeout
const ABSOLUTE_TIMEOUT_MS = 60000;    // 60s absolute request deadline

function isRestrictedIp(ip) {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
      return true;
    }
    const [a, b, c, d] = parts;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
    if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24
    if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 198 && b >= 18 && b <= 19) return true; // 198.18.0.0/15
    if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24
    if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24
    if (a >= 224 && a <= 239) return true; // 224.0.0.0/4 (multicast)
    if (a >= 240) return true; // 240.0.0.0/4 (reserved)
    return false;
  }
  if (net.isIPv6(ip)) {
    const clean = ip.toLowerCase();
    if (clean === "::1" || clean === "0:0:0:0:0:0:0:1") return true;
    if (clean === "::" || clean === "0:0:0:0:0:0:0:0") return true;

    const canonical = new URL(`http://[${clean}]/`).hostname.slice(1, -1);
    const mappedPrefix = "::ffff:";
    if (canonical.startsWith(mappedPrefix)) {
      const [high, low] = canonical
        .slice(mappedPrefix.length)
        .split(":")
        .map((word) => parseInt(word, 16));
      const mappedIpv4 = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
      return isRestrictedIp(mappedIpv4);
    }

    if (/^f[cd][0-9a-f]{2}:/i.test(clean)) return true; // ULA fc00::/7
    if (/^fe[89ab][0-9a-f]:/i.test(clean)) return true; // Link-local fe80::/10
    if (/^ff[0-9a-f]{2}:/i.test(clean)) return true; // Multicast ff00::/8
    if (/^2001:0?db8:/i.test(clean)) return true; // Documentation
    return false;
  }
  return true;
}

async function run() {
  const parsedUrl = new URL(targetUrl);
  const isHttps = parsedUrl.protocol === "https:";
  const isHttp = parsedUrl.protocol === "http:";

  if (!isHttps) {
    if (!isHttp || !allowLoopback) {
      throw new Error(`Insecure protocol "${parsedUrl.protocol}" is forbidden. Anonymous HTTPS is required.`);
    }
  }

  const hostname = parsedUrl.hostname;
  let pinnedIp = hostname;

  if (!net.isIP(hostname)) {
    const addresses = [];
    try {
      const v4 = await dns.resolve4(hostname).catch(() => []);
      addresses.push(...v4);
    } catch {}
    try {
      const v6 = await dns.resolve6(hostname).catch(() => []);
      addresses.push(...v6);
    } catch {}

    if (addresses.length === 0) {
      const lookupAll = await dns.lookup(hostname, { all: true }).catch(() => []);
      addresses.push(...lookupAll.map((e) => e.address));
    }

    if (addresses.length === 0) {
      throw new Error(`DNS resolution failed for host "${hostname}".`);
    }

    for (const addr of addresses) {
      const restricted = isRestrictedIp(addr);
      if (restricted) {
        if (!allowLoopback || (addr !== "127.0.0.1" && addr !== "::1")) {
          throw new Error(`Host "${hostname}" resolved to prohibited address "${addr}". Helper acquisition rejected.`);
        }
      }
    }

    pinnedIp = addresses[0];
  } else {
    if (isRestrictedIp(hostname)) {
      if (!allowLoopback || (hostname !== "127.0.0.1" && hostname !== "::1")) {
        throw new Error(`Target IP "${hostname}" is in a prohibited range. Helper acquisition rejected.`);
      }
    }
  }

  const port = parsedUrl.port ? parseInt(parsedUrl.port, 10) : (isHttps ? 443 : 80);
  const client = isHttps ? https : http;

  const requestOptions = {
    host: pinnedIp,
    port: port,
    path: parsedUrl.pathname + parsedUrl.search,
    method: "GET",
    headers: {
      Host: hostname,
      "User-Agent": "resin-installer/1.0",
      Accept: "*/*",
    },
    maxHeaderSize: MAX_HEADER_BYTES,
  };

  if (isHttps) {
    requestOptions.servername = hostname;
    requestOptions.rejectUnauthorized = true;
  }

  const buffer = await new Promise((resolve, reject) => {
    let settled = false;
    let resRef = null;
    let absoluteTimer = null;

    function cleanup() {
      if (absoluteTimer) {
        clearTimeout(absoluteTimer);
        absoluteTimer = null;
      }
    }

    function destroyAndReject(err) {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        req.destroy();
      } catch {}
      if (resRef) {
        try {
          resRef.destroy();
        } catch {}
      }
      reject(err);
    }

    absoluteTimer = setTimeout(() => {
      destroyAndReject(new Error(`Download exceeded absolute deadline of ${ABSOLUTE_TIMEOUT_MS / 1000} seconds.`));
    }, ABSOLUTE_TIMEOUT_MS);

    const req = client.request(requestOptions, (res) => {
      resRef = res;

      res.setTimeout(SOCKET_TIMEOUT_MS, () => {
        destroyAndReject(new Error(`Connection or socket timed out after ${SOCKET_TIMEOUT_MS / 1000} seconds of inactivity.`));
      });

      const statusCode = res.statusCode || 0;
      if (statusCode >= 300 && statusCode < 400) {
        destroyAndReject(new Error(`HTTP redirect (status ${statusCode}) rejected. Production downloads forbid redirects.`));
        return;
      }
      if (statusCode !== 200) {
        destroyAndReject(new Error(`HTTP request failed with status code ${statusCode}.`));
        return;
      }

      let expectedContentLength = null;
      const clHeader = res.headers["content-length"];
      if (clHeader !== undefined) {
        if (typeof clHeader !== "string" && typeof clHeader !== "number") {
          destroyAndReject(new Error(`Invalid Content-Length header format: ${clHeader}`));
          return;
        }
        const clStr = String(clHeader).trim();
        if (!/^\d+$/.test(clStr)) {
          destroyAndReject(new Error(`Invalid Content-Length header value: "${clHeader}"`));
          return;
        }
        const clVal = parseInt(clStr, 10);
        if (!Number.isSafeInteger(clVal) || clVal < 0) {
          destroyAndReject(new Error(`Invalid Content-Length integer value: ${clHeader}`));
          return;
        }
        if (clVal > MAX_HELPER_BYTES) {
          destroyAndReject(new Error(`Content-Length ${clVal} exceeds maximum allowed size of 1 MiB (${MAX_HELPER_BYTES} bytes).`));
          return;
        }
        expectedContentLength = clVal;
      }

      let receivedBytes = 0;
      const chunks = [];

      res.on("data", (chunk) => {
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_HELPER_BYTES) {
          destroyAndReject(new Error(`Response body exceeded maximum allowed size of 1 MiB (${MAX_HELPER_BYTES} bytes).`));
          return;
        }
        chunks.push(chunk);
      });

      res.on("end", () => {
        if (settled) return;
        if (expectedContentLength !== null && receivedBytes !== expectedContentLength) {
          destroyAndReject(new Error(`Received payload size (${receivedBytes} bytes) does not match Content-Length header (${expectedContentLength} bytes).`));
          return;
        }
        cleanup();
        settled = true;
        resolve(Buffer.concat(chunks, receivedBytes));
      });

      res.on("aborted", () => {
        destroyAndReject(new Error("HTTP response was aborted prematurely by server."));
      });

      res.on("error", (err) => {
        destroyAndReject(err);
      });
    });

    req.setTimeout(SOCKET_TIMEOUT_MS, () => {
      destroyAndReject(new Error(`Connection or socket timed out after ${SOCKET_TIMEOUT_MS / 1000} seconds of inactivity.`));
    });

    req.on("error", (err) => {
      destroyAndReject(err);
    });

    req.end();
  });

  const actualHash = crypto.createHash("sha256").update(buffer).digest("hex");
  if (actualHash.toLowerCase() !== expectedSha.toLowerCase()) {
    throw new Error(`SHA-256 checksum mismatch!\nExpected: ${expectedSha}\nActual:   ${actualHash}\nHelper script may have been tampered with or corrupted.`);
  }

  const resolvedTarget = path.resolve(targetFile);
  const targetDir = path.dirname(resolvedTarget);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o755 });
  }

  const tmpFile = `${resolvedTarget}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpFile, buffer, { mode: 0o600 });
  fs.renameSync(tmpFile, resolvedTarget);
}

run().catch((err) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
' "$HELPER_DEST_PATH" "$EXPECTED_SHA256" "$TARGET_HELPER_URL" "$ALLOW_LOOPBACK_FLAG"

# If --download-only was requested, report verified path and exit cleanly without execution
if [ -n "$DOWNLOAD_ONLY" ]; then
  RESOLVED_PATH="$(node --input-type=module -e 'import path from "node:path"; console.log(path.resolve(process.argv[1]))' "$DOWNLOAD_ONLY")"
  echo "✔ Successfully downloaded and verified Resin install helper."
  echo "  Location: $RESOLVED_PATH"
  echo "  SHA-256:  $EXPECTED_SHA256"
  echo ""
  echo "To inspect the script before running:"
  echo "  cat \"$RESOLVED_PATH\""
  echo ""
  echo "To execute the verified installer:"
  echo "  node \"$RESOLVED_PATH\""
  exit 0
fi

# Execute the verified standalone installer helper with forwarded arguments
# Require one valid JSON success result instead of blind zero-exit acceptance
HELPER_STDOUT="$(node "$HELPER_DEST_PATH" "$@")"
HELPER_EXIT_CODE=$?

if [ "$HELPER_EXIT_CODE" -ne 0 ]; then
  exit "$HELPER_EXIT_CODE"
fi

# Verify that helper emitted a valid JSON success result
if ! printf '%s' "$HELPER_STDOUT" | node --no-warnings --input-type=module -e '
import fs from "node:fs";
const raw = fs.readFileSync(0, "utf8").trim();
if (!raw) {
  process.exit(1);
}
try {
  const result = JSON.parse(raw);
  if (!result || typeof result !== "object" || Array.isArray(result) || result.success !== true) {
    process.exit(1);
  }
} catch {
  process.exit(1);
}
'; then
  echo "Error: Installer helper completed with exit code 0 but did not emit a valid JSON success result." >&2
  exit 1
fi

if [ "$JSON_OUTPUT" = "1" ]; then
  printf '%s\n' "$HELPER_STDOUT"
fi
exit 0
