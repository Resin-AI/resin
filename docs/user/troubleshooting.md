# Troubleshooting Guide

This guide provides diagnostic recipes that match the current CLI. Prefer `resin status`, `resin doctor`, and `resin repair` over undocumented flags.

---

## 1. Quick Diagnostic Checklist

```bash
resin status
resin doctor
resin repair
```

`status` gives a short health summary with any problems and next steps. Use `resin status --verbose` for the full diagnostic snapshot or `resin status --json` for machine-readable output. `doctor` diagnoses. `repair` (or `doctor --fix`) remediates directories, lockfile, user service, harness MCP, and the local safety attestation.

---

## 2. Common Troubleshooting Recipes

### Recipe 1: Daemon Fails To Start

**Symptom**: `resin status` reports `Daemon Stopped` or `Daemon Not installed`.

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

An explicitly standalone connection (`resin mcp --standalone`) does not require a daemon. It initializes its owner-only local state database, including invocation records, even after `init --no-service`; database initialization errors stop startup rather than silently disabling recording.

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
- Fresh and cached `resin login` automatically restart and verify an installed, running user service. Status/restart/readiness failures exit `1` while preserving credentials; JSON reports `authenticationSucceeded: true` with the failed `daemonRefresh` stage. Follow the remediation and retry login. Absent or inactive services remain untouched.
- With `RESIN_NO_SERVICE=1`, login reports external management without touching user services. Restart the foreground or externally managed daemon through its own supervisor and check `resin status`; login does not claim external daemon readiness.
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

### Recipe 6: Worker IPC Failure

**Symptom**: A tool invocation returns `write_error`, possibly mentioning `EPIPE`.

The host could not write an RPC frame to the worker. Treat the invocation as failed, not as evidence of success; inspect execution receipts before retrying because side effects may already have occurred. Worker disposal closes IPC before termination. Late pipe errors do not replace an already-settled result such as `OUTPUT_LIMIT_EXCEEDED` or a timeout.

---

### Recipe 7: Validation Reports A Step As Missed

Validation compares each plan step's resolved call with the call this device recorded for it; it runs nothing recorded. A step whose callable or any argument differs, or that has no locally recorded call, is missed and the plan is not verified. A plan whose step still carries, as literal text, a value the recording shows came from an earlier step's output is also refused until that position is bound to the earlier result. A demonstration that ran the tool once per item (for example several items handled in one request, as `for_each` does) is checked one item at a time: each item's run must match that item's recorded calls in order, and a step whose number of recorded calls differs from the number of items is missed.

Recordings captured before Resin stored per-call identity entries cannot be validated; record the workflow again. If this device's harness sessions cannot be discovered, the ask is deferred; if its calls cannot be identified locally, the result is unavailable, never verified.

---

### Recipe 8: Codex Source Depends On Harness APIs

Codex `exec` bodies can reference APIs supplied by the Codex host. Resin's JavaScript runtime provides standard VM globals and the `text` output channel, not Codex's tool dispatcher or historical process sessions.

Standalone capture checks lexical dependencies against that interface. Bodies with unresolved host dependencies remain native harness calls; they are not relabeled as ordinary JavaScript.

Each completed process Codex records is captured separately under its native execution ID, with the exact `/bin/bash -lc` command, working directory, and output kept on the recording machine. Only a process's own exact output answers its step; a wrapper's printed result object is never substituted. A process claimed by an audited single-command wrapper remains covered by that wrapper and is not a separate step.

A launch response or terminal poll containing a process handle is not the process's completed output. Reuse requires supported execution dependencies and independently verified command outcomes; connecting Resin MCP does not supply Codex's internal APIs.

---

## 3. Diagnostics Without A Support-Bundle Flag

`resin doctor --export-bundle` does not exist. Capture a sanitized machine report with:

```bash
resin doctor --json
resin status --json
```

Those reports include platform, service, IPC, harness, and cloud *status* without access or refresh tokens.

---

### Error reports

When a command fails or a Resin process crashes, a sanitized error report is sent to the Resin team automatically unless you opted out (see [Security & Privacy](security-and-privacy.md#7-error-reports-and-usage-events)). It never contains prompts, source or argument values, so it is not a substitute for a support request: include `resin doctor --json` output when you contact `hello@resin.sh`, or send a short note with `resin feedback <message>`. Reporting is best-effort and never changes a command's result or exit code; if a slow network seems to delay command exit, set `RESIN_ERROR_REPORTING=0`.

---

## Related Documentation

- [Getting Started](getting-started.md)
- [Doctor & Repair Guide](doctor-and-repair.md)
- [Security & Privacy](security-and-privacy.md)
- [Configuration Reference](configuration.md)
- [Vulnerability Reporting](../security/vulnerability-reporting.md)
