# Security & Privacy Model

Resin is built on strict **Local-First**, **Zero Raw Data Exfiltration**, and **Principle of Least Privilege** guarantees. This document details the security architecture, capability boundaries, and privacy protections enforced by the runtime.

---

## 1. Core Security Guarantees

1. **Local-Only Raw Transcripts**: Raw prompts, assistant reasoning, thinking blocks, and workspace code never leave your local machine unless the install privacy plan separately and explicitly enables cloud sync.
2. **Capability Envelopes**: Evolved tools execute in restricted sandboxes with explicitly declared and authorized permissions.
3. **Mediated Secret Access**: Tools never have raw read access to API keys, passwords, or cloud credentials.
4. **Automated Secret Redaction**: All normalized events, logs, and telemetry pass through real-time entropy and regex pattern masking.
5. **Owner-Only Cloud Credentials**: Device tokens live in `~/.resin/state/device-token.json` (mode `0600`) with an optional ancillary vault copy when a `SecretManager` is configured. They are distinct from the local IPC token.
6. **Tamper-Evident Local Audit**: Tool execution and lifecycle decisions are recorded in the local SQLite store. Access tokens are not written to that log.

---

## 2. The Capability Envelope

Every tool version bundled and deployed by Resin includes a strict **Capability Envelope** defining its permissible runtime surface:

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
      "allowedHosts": ["127.0.0.1"],
      "denyPrivateRanges": true
    },
    "command": {
      "allowShellExecution": false,
      "allowedCommands": ["git", "node", "pnpm"],
      "forbiddenPatterns": ["sudo", "rm -rf /", "mkfs"]
    },
    "secrets": {
      "denyDirectRead": true,
      "injectAsEnv": true
    },
    "limits": {
      "maxExecutionTimeMs": 30000,
      "maxMemoryMb": 512,
      "maxOutputSizeBytes": 2097152
    }
  }
}
```

### Filesystem Boundary
Tools may only read/write files within the active workspace root or designated temporary directories. Sensitive paths such as `.git`, `.ssh`, `.aws`, and `.env` files are blocked unconditionally.

### Network Isolation
Outbound internet access is disabled by default. When outbound network access is explicitly granted for specific domains, private IP ranges (RFC 1918, link-local, loopback except gateway) are strictly rejected.

### Command Execution
Arbitrary shell execution (`/bin/sh`, `/bin/bash`, `cmd.exe`) is prohibited. Tools may only invoke pre-approved binaries from the envelope.

---

## 3. Install Privacy Plan And Device Approval

Interactive `npx resin init` presents the signed-release install plus the workspace capability/privacy plan and requires explicit yes/no confirmation **before** pairing or mutating harness files. If the user denies consent, installation terminates immediately without side effects. In non-interactive environments, `--auto-approve` or a valid pre-approved `--capabilities-file` is required. Defaults: local-only on, cloud sync off, telemetry off, redaction `mask`.

RFC 8628 device approval then shows the selected Resin identity and workspace in the Console. Approving one identity cannot bind credentials to another account or workspace. Device approval cannot silently enable raw transcript or source upload.

Cancelled, denied, expired, or failed pairing leaves the previous credential snapshot (or no file). If installation fails after pairing a new device, the newly paired token is best-effort remotely revoked before local rollback and credential purge.

---

## 4. Cloud Credentials Versus IPC

| Boundary | Path | Scope |
|----------|------|-------|
| Cloud device token | `~/.resin/state/device-token.json` (mode `0600`) | Account, workspace, device, and issuing cloud origin for authenticated catalog/observation/project sync |
| Ancillary vault | `~/.resin/vault/` (`cloud_device_access_token`, `cloud_device_refresh_token`, `cloud_device_origin`) | Optional duplicate of the same cloud secrets via `SecretManager` |
| Local IPC token | Daemon state `auth.token` | Unix-socket/local client auth only |

`resin logout` attempts remote revocation, then deletes the owner-only file and optional vault keys. Harness MCP config, project files, and the four locked local meta-tools remain.

Access and refresh tokens must not appear in logs, harness configuration, `.resin/project.json`, `.resin/resin.lock`, `resin status`, or `resin doctor --json`.

After credential replacement, a running daemon must reload the token file. `resin init` pairing restarts an already-running user service. After `resin login`, restart the service if it is already active (`resin repair` starts an inactive unit).

---

## 5. Secret Mediation & Redaction

### Vault Storage
Cloud device secrets use the owner-only file plus optional ancillary vault storage (OS keychain / encrypted local keystore when a `SecretManager` is configured).

### Mediated Injection
Tools requiring authentication tokens receive them exclusively as mediated environment variables injected at sandbox launch time. Direct disk reads of token files are prevented.

### Entropy & Regex Redaction
All logs, error messages, and telemetry streams pass through a continuous redaction filter detecting:
- AWS, GitHub, OpenAI, Anthropic, and generic API keys.
- JWT tokens and bearer credentials.
- High-entropy base64 and hex strings.
- Passwords and SSH private keys.

---

## 6. Local-Only Raw Transcripts And Offline MCP

AI coding harnesses generate rich session transcripts. Resin guarantees:

- Session files in `~/.claude/projects/`, `~/.codex/sessions/`, or `~/.omp/` are parsed **locally** by the observer daemon.
- Raw text is distilled into **Normalized Session Events** (e.g. `tool_discovery`, `tool_call`, `durationMs`, `exitCode`).
- If cloud synchronization is enabled for candidate evolution, only sanitized, abstract opportunity descriptors are transmitted; raw prompts are discarded.

When the cloud is unreachable or after logout, the local MCP gateway continues to serve `search_tools`, `get_tool_schema`, `invoke_tool`, and `manage_tools`.

---

## Related Documentation

- [Getting Started](getting-started.md)
- [Configuration Reference](configuration.md)
- [Doctor & Repair Guide](doctor-and-repair.md)
- [Threat Model (Security)](../security/threat-model.md)
- [Privacy Inventory](../security/privacy-inventory.md)
