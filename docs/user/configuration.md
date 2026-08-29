# Configuration Reference

This guide details configuration files, directory layouts, environment variables, and policy parameters used by Resin.

---

## 1. Directory Structure

CLI cloud credentials always use `~/.resin/` under the active home (`--home` or `$HOME`):

| Path | Purpose | Persistence |
|------|---------|-------------|
| `~/.resin/state/device-token.json` | Canonical owner-only cloud device credentials (mode `0600`) | Persistent until logout |
| `~/.resin/vault/` | Optional ancillary secret-store copy of access/refresh token and cloud origin (when SecretManager is configured) | Persistent until logout |
| `~/.resin/config/` | Daemon configuration and policy overrides | Persistent |
| `~/.resin/data/` | Tool bundle artifacts, sandboxed execution caches | Persistent |
| `~/.resin/state/` | Install journal, daemon lock/pid helpers, cloud token file | Local state |
| `~/.resin/logs/` | Daemon and CLI/installer logs | Local |
| `~/.resin/bin/` | Installed binaries | Persistent |
| `~/.resin/safety-attestation.json` | Local production safety attestation written by `repair` | Persistent |

For fresh installations (`npx resin init`), the service runs with `RESIN_HOME=~/.resin`, placing daemon configuration, logs, and state directly under `~/.resin/config/`, `~/.resin/logs/`, and `~/.resin/state/`. When `RESIN_HOME` is unset, the daemon resolves platform paths (Linux XDG, macOS Library, Windows AppData) for config, data, logs, the IPC socket, and the **IPC token** (`auth.token` in the daemon state directory). That IPC token authenticates local socket clients. It is not the cloud device token and is never a substitute for `device-token.json`.

### Workspace-Specific Project Files

The first Git workspace the gateway sees creates stable files at the repository root. Later sessions reuse them:

```text
my-project/
├── .resin/
│   ├── project.json         # Stable project identity
│   └── resin.lock           # Locked tool catalog for this project
├── package.json
└── src/
```

These files do not contain cloud access or refresh tokens.

---

## 2. Credentials And Tokens

| Secret | Location | Who uses it |
|--------|----------|-------------|
| Cloud device credentials | `~/.resin/state/device-token.json` (mode `0600`) plus optional ancillary vault keys `cloud_device_access_token`, `cloud_device_refresh_token`, `cloud_device_origin` (when SecretManager is configured) | CLI pairing/`login`/`logout`/`status`; daemon authenticated catalog/observation/project sync after valid pairing |
| Local IPC token | Daemon state `auth.token` | Local CLI/daemon socket auth only |

Cloud tokens are not copied into harness MCP configs, `.resin/project.json`, `.resin/resin.lock`, doctor JSON, or status output.

---

## 3. Environment Variables

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `RESIN_CLOUD_URL` | `string` | `https://api.resin.sh` | Cloud origin for pairing. HTTPS or loopback HTTP only. |
| `RESIN_HOME` | `string` | `~/.resin` for init installs; unset otherwise | When set, daemon config/data/state/log roots reside under this directory (`<home>/config`, `<home>/logs`, etc.). CLI cloud token path still follows `--home`/`$HOME` + `/.resin/state/device-token.json` unless `--token-file` is used on `login`. |
| `RESIN_CONFIG_DIR` | `string` | platform default | Daemon configuration directory. |
| `RESIN_STATE_DIR` | `string` | platform default | Daemon state directory (socket, lock, IPC token). |
| `RESIN_LOG_DIR` | `string` | platform default | Daemon log directory. |
| `RESIN_SOCKET_PATH` | `string` | platform default | Override IPC socket. Also `resin status --socket`. |
| `RESIN_RELEASE_MODE` | `string` | `production` outside tests | `production` verifies the signed channel; `local-test` is for fixtures. |
| `RESIN_RELEASE_CHANNEL_URL` | `string` | signed production channel | Override the release channel URL. |

`--gateway-url` is a `resin init` flag, not an environment variable. Default when omitted: `http://127.0.0.1:9400/mcp/sse`.

`--auto-approve` is a CLI flag (also `-y` / `--yes`), not `RESIN_AUTO_APPROVE`.

---

## 4. Capability Envelope Configuration

Each tool execution runs inside a **Capability Envelope**. Defaults can be adjusted in daemon `config.json`:

```json
{
  "capabilities": {
    "fs": {
      "allowWorkspaceRoot": true,
      "allowTemp": true,
      "denyPaths": [
        "**/.git/**",
        "**/.ssh/**",
        "**/.aws/**",
        "**/.gnupg/**",
        "**/.env*"
      ],
      "maxFileSizeBytes": 10485760
    },
    "net": {
      "allowOutbound": false,
      "allowedHosts": ["127.0.0.1", "localhost"],
      "allowedPorts": [9400, 9401],
      "denyPrivateRanges": true
    },
    "command": {
      "allowShellExecution": false,
      "allowedCommands": ["git", "node", "pnpm", "deno"],
      "forbiddenPatterns": ["sudo", "rm -rf /", "shutdown", "reboot"]
    },
    "secrets": {
      "denyDirectRead": true,
      "injectAsEnv": true
    }
  }
}
```

Privacy defaults presented at `init`: local-only on, cloud sync off, telemetry off, redaction `mask`. Device approval cannot turn those on by itself.

---

## Related Documentation

- [Getting Started](getting-started.md)
- [Security & Privacy](security-and-privacy.md)
- [Harness Guide](harness-guide.md)
- [Meta-Tools Reference](meta-tools.md)
