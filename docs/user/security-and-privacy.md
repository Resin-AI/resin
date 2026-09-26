# Security & Privacy Model

Resin is built on strict **Local-First**, **Zero Raw Data Exfiltration**, and **Principle of Least Privilege** guarantees. This document details the security architecture, capability boundaries, and privacy protections enforced by the runtime.

---

## 1. Core Security Guarantees

1. **Local-Only Originals**: Raw prompts, assistant reasoning, thinking blocks, original private program source, and private store entries remain local. When cloud sync is enabled, sanitized evidence may include secret-redacted recorded-program views that retain non-secret code and literal values.
2. **Capability Envelopes**: Each tool declares its capabilities in a manifest, checked against workspace policy before activation and dispatch. The envelope is a policy check, not process isolation. Invoking a published tool runs its recorded commands directly, by design; the calling harness's own permission policy governs that tool call, as for any MCP tool, and Resin adds no approval or consent step of its own.
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
Arbitrary shell execution (`/bin/sh`, `/bin/bash`, `cmd.exe`) is prohibited for generated code artifacts, which may only invoke pre-approved binaries from the envelope. Learned tools that run recorded commands are different. Invoking a published tool runs its recorded commands directly, by design; the calling harness's own permission policy governs that tool call, as for any MCP tool, and Resin adds no approval or consent step of its own.

### Derivation Steps
A learned tool may carry a derivation step: short Python written by the cloud model that computes a value a recording had hard-coded. It is the only plan code no local recording produced, so it is never trusted. A binding to its output is accepted only after the derivation, run locally, reproduces every recorded value it claims to compute. Every run, at validation and at tool invocation, executes the derivation as Python in Pyodide (CPython compiled to WebAssembly) inside a Deno process whose only permission is read access to Resin's pinned local Pyodide assets: network, environment, subprocesses, FFI, system information, file writes, and remote or npm imports are all denied, and no other file can be read. A derivation therefore sees only its inputs, which are written into its source; it cannot read the project, the home directory, or any secret on the device. It may import a fixed allowlist of pure modules (`json`, `csv`, `math`, `statistics`, `collections`, `datetime`, `re`, `decimal`, and similar); importing anything else fails the step even if the derivation catches the error. The allowlist guards against mistakes; it is not a security boundary, since Python inside the interpreter can reach the original import machinery (for example through `__import__.__closure__`), and running out of WebAssembly memory raises a `MemoryError` the derivation can catch. What actually bounds a derivation is the Deno sandbox permissions and the time limit, which kills the process regardless. Its result is the JSON object of its final expression, bounded in size and time (the Deno process is killed at the time bound) and in memory by V8 heap and WebAssembly memory limits. The Pyodide release is pinned by version and by the SHA-256 of each asset, ships inside the Resin package, and is never downloaded at run time. Deno reads private, per-process copies of the assets and its driver, re-verified before every run. If Deno or the pinned assets are missing or altered, the derivation step fails with an error rather than running any other way.

### Workflow Validation
Validation executes nothing recorded. Each plan step's resolved call must equal the call this device recorded for it, read from the local private store under references the device recomputes itself; the recorded output then answers the step. Plan-carried references and literals are never trusted as the recording, and decisions carry only step ids, verdicts and fixed reason strings. Invoking a published tool runs its recorded commands directly, by design; the calling harness's own permission policy governs that tool call, as for any MCP tool, and Resin adds no approval or consent step of its own. See [Limitations](limitations.md#recorded-workflow-validation).

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

Fresh and cached `resin login` automatically restart an installed, running user service and verify that the new daemon responds with the saved cloud origin and account/workspace/device/user identity. No access or refresh token is returned by this health check, and it does not independently check remote revocation. A daemon-refresh failure exits `1` while preserving authenticated credentials and reports authentication success separately. Login leaves absent or inactive services untouched. With `RESIN_NO_SERVICE=1`, restart the daemon through its own supervisor; login does not manipulate user services or claim external daemon readiness.

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
- If cloud synchronization is enabled for candidate evolution, sanitized evidence may include engine-redacted JavaScript, TypeScript, and Python program views with non-secret code and literals. Their original source stays in the local private store; redaction-sensitive token positions cannot be parameterized, and execution never falls back to the public view. Raw prompts and tool outputs are not uploaded.

When the cloud is unreachable or after logout, the local MCP gateway continues to serve `search_tools`, `get_tool_schema`, `invoke_tool`, and `manage_tools`.

---

## Related Documentation

- [Getting Started](getting-started.md)
- [Configuration Reference](configuration.md)
- [Doctor & Repair Guide](doctor-and-repair.md)
- [Threat Model (Security)](../security/threat-model.md)
- [Privacy Inventory](../security/privacy-inventory.md)
