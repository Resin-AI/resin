# Troubleshooting Guide

This guide provides diagnostic recipes that match the current CLI. Prefer `resin status`, `resin doctor`, and `resin repair` over undocumented flags.

---

## 1. Quick Diagnostic Checklist

```bash
resin status
resin doctor
resin repair
```

`status` is the live snapshot (service / IPC / cloud / safety gate / locked meta-tools / harnesses). `doctor` diagnoses. `repair` (or `doctor --fix`) remediates directories, lockfile, user service, harness MCP, and the local safety attestation.

---

## 2. Common Troubleshooting Recipes

### Recipe 1: Daemon Fails To Start

**Symptom**: `resin status` reports `[Daemon Service] State: STOPPED (inactive)` or `NOT INSTALLED`.

**Causes & solutions**:

1. **Service not installed or inactive**. `resin repair` installs the non-root user unit with autostart, or starts an installed inactive unit.
2. **Stale lockfile**. Doctor warns when the lockfile exists while the process is not running. Repair deletes that lockfile (not a manual `daemon.pid` dance).
3. **Gateway URL mismatch**. Confirm harness MCP entries use the URL you passed as `--gateway-url`. The default is `http://127.0.0.1:9400/mcp/sse` only when that flag was omitted.

```bash
resin status
resin doctor
resin repair
```

---

### Recipe 2: MCP Connection Refused In An AI Harness

**Symptom**: Claude Code, Codex, or OMP reports the Resin MCP server disconnected or connection refused.

**Causes & solutions**:

1. Confirm the daemon is `RUNNING` and IPC is `CONNECTED`:
   ```bash
   resin status
   resin repair
   ```
2. Confirm the harness file contains the gateway URL you installed with (default `http://127.0.0.1:9400/mcp/sse` if `--gateway-url` was omitted):
   - Claude Code: `~/.claude.json` or `~/.claude/claude.json`
   - Codex CLI: `~/.codex/config.toml`
   - Oh My Pi: `~/.omp/agent/mcp.json` (legacy `~/.omp/config.json`)
3. Reattach MCP entries:
   ```bash
   resin repair
   ```

Do not run `resin init --auto-approve` as a restart shortcut. That re-enters install/pairing. Use `resin repair`.

---

### Recipe 3: Pairing, Login, Or Expired Cloud Credentials

**Symptom**: Cloud section is `NOT AUTHENTICATED`, `EXPIRED`, invalid, or missing, or you need to re-pair.

`resin status` evaluates credentials locally without querying the remote cloud origin; revoked tokens with valid formats appear locally authenticated until an authenticated cloud request is rejected by the server.

```bash
resin login --force
resin status
```

- `resin login` reuses existing valid credentials by default; use `--force` to initiate a fresh device pairing flow.
- Interactive login opens the complete verification URL (unless `--no-browser`) and prints the URL + user code (or emits structured JSON in `--json` mode).
- Non-interactive init requires both an authorization grant (`--auto-approve` or `--capabilities-file`) and a pairing mechanism (valid pre-provisioned `~/.resin/state/device-token.json` or `--local-only`).
- After `resin login` credential replacement, restart a running daemon so it reloads the token file (`resin init` pairing restarts a running service automatically).
- `resin logout` revokes remotely when possible, then purges the owner-only file and optional ancillary vault. Local MCP continues.

---

### Recipe 4: Sandbox Permission Denied

**Symptom**: Tool returns `EACCES` or a capability-envelope denial.

Stay inside the authorized workspace root. Denied paths include `.git`, `.ssh`, `.aws`, `.gnupg`, and `.env*`. Re-run `npx resin init` (or pass `--capabilities-file`) only if you intend to change the authorized envelope; device approval does not broaden it.

---

### Recipe 5: Tools Missing After Logout Or Offline

**Symptom**: Cloud is down or you signed out; the harness still needs tools.

The locked local meta-tools stay on the gateway: `search_tools`, `get_tool_schema`, `invoke_tool`, `manage_tools`. Confirm IPC `CONNECTED` with `resin status`. There is no `resin status --all-tools` or `resin repair --promote-tool` flag; catalog promotion is a `manage_tools` MCP action, not a CLI repair flag.

---

## 3. Diagnostics Without A Support-Bundle Flag

`resin doctor --export-bundle` does not exist. Capture a sanitized machine report with:

```bash
resin doctor --json
resin status --json
```

Those reports include platform, service, IPC, harness, and cloud *status* without access or refresh tokens.

---

## Related Documentation

- [Getting Started](getting-started.md)
- [Doctor & Repair Guide](doctor-and-repair.md)
- [Security & Privacy](security-and-privacy.md)
- [Configuration Reference](configuration.md)
- [Vulnerability Reporting](../security/vulnerability-reporting.md)
