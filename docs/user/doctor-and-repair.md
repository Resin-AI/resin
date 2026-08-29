# Doctor & Repair Guide

Resin includes built-in diagnostic and self-healing commands to inspect system health and remediate service, filesystem, harness, and attestation issues.

---

## 1. `resin status`

`resin status` reports the user service, IPC ping, cloud credential load result, production safety gate, the four locked meta-tools, and harness MCP attachment.

```bash
resin status
```

Human output uses boxed sections. Typical states:

| Section | Observable states |
|---------|-------------------|
| Daemon Service | `RUNNING (active)`, `STOPPED (inactive)`, `NOT INSTALLED` |
| IPC & Subsystems | `CONNECTED` (latency, daemon version, uptime) or `DISCONNECTED` |
| Cloud Authentication | `AUTHENTICATED`, `LOCAL ONLY (Cloud Unconfigured)` (derived from install journal), `NOT AUTHENTICATED` (reason). Authenticated rows may show `EXPIRED`. |
| Production Safety Gate | `PASS (open)`, `BLOCKED (fail-closed)`, `OVERRIDE (unsafe dev mode)` |
| Tools & MCP Catalog | `System Tools: 4` (`search_tools`, `get_tool_schema`, `invoke_tool`, `manage_tools`) |
| Agent Harness Connections | Installed/Not Installed and Configured (MCP Attached)/Not Configured |

JSON mode:

```bash
resin status --json
```

`--home` selects the home used for `~/.resin/state/device-token.json`. `--socket` overrides the IPC socket. Note that `resin status` checks credentials locally and does not proactively query the server to discover remote token revocation in real time.

---

## 2. `resin doctor`

`resin doctor` runs diagnostics only. Exit `0` when there are no `fail` items; `--strict` also fails on warnings.

```bash
resin doctor
resin doctor --json
resin doctor --strict
```

Checks actually evaluated:

| id | Category | What is verified |
|----|----------|------------------|
| `platform_supported` | platform | OS (Linux, macOS, WSL2) and Node.js `>= 22` |
| `fs_directories` | filesystem | Resin home, config, data, logs, state, and `bin` directories |
| `service_installed` | service | Non-root user autostart unit installed and active |
| `stale_lockfile` | ipc | Lockfile present while the daemon is not running |
| `ipc_ping` | ipc | Socket exists and answers `ping` |
| `db_state` | database | SQLite file exists under the data directory (`state.db`). Missing is a warning until first daemon run. |
| `harness_*` | harness | Detected Claude Code, Codex CLI, and OMP configs mention `resin` |
| `cloud_auth` | auth | Load of `device-token.json`: valid, expired, offline, revoked, invalid, or missing (local offline) |
| `safety_gate` | security | Production safety attestation verified |

There is no `--export-bundle` or `--inspect-audit-log` flag. For a machine-readable report use `--json`. Tokens are not printed.

---

## 3. `resin repair` / `resin doctor --fix`

`resin repair` is `doctor` with remediations applied first, then the same diagnostics.

```bash
resin repair
resin doctor --fix
```

Remediations that actually run:

- Create missing directories (`config`, `data`, `logs`, `state`, `bin`, `run`, and `vault` if configured).
- Remove a stale daemon lockfile when the service is not active.
- Install the non-root user service if missing (with autostart) or start it if installed but inactive.
- Reattach MCP entries for detected Claude Code, Codex CLI, and Oh My Pi installs.
- Generate or refresh the local production safety attestation under `~/.resin/`.

`repair` does not vacuum SQLite, pick alternate gateway ports, restart workers, promote tools, or export a support bundle. Those flags do not exist.

---

## 4. Recovery Recipes

### Pairing or credentials failed

Cancelled, denied, expired, or failed pairing leaves the previous credential snapshot (or cleans up local state). If service installation fails after pairing a new device, the newly paired token is best-effort remotely revoked before local credential rollback/purge. Retry:

```bash
npx resin init
# or, after a completed install:
resin login --force
```

Non-interactive installs must pass one authorization mechanism (`--auto-approve` or valid `--capabilities-file`) and one pairing mechanism (valid pre-provisioned `~/.resin/state/device-token.json` or `--local-only`).
### Daemon not running

```bash
resin status
resin repair
```

### Cloud token replaced, daemon still using the old session

`resin init` pairing restarts a running user service. `resin login` reuses valid cached credentials unless `--force`. If the service is already active after a credential change, restart it (or run `resin repair` when it is inactive) so the daemon reloads `~/.resin/state/device-token.json`.

### Logout / revocation

```bash
resin logout
resin status
```

Local MCP continues. Cloud status becomes not authenticated. Re-pair with `resin login` or `npx resin init`.

### Roll back a failed install

```bash
npx resin init --rollback-install
```

Signed in-place binary rollback uses `resin upgrade` against the signed channel (`--target-version`, `--force`, `--no-rollback`). There is no `resin repair --rollback-tool` command.

---

## Related Documentation

- [Getting Started](getting-started.md)
- [Troubleshooting Guide](troubleshooting.md)
- [Configuration Reference](configuration.md)
- [Security & Privacy](security-and-privacy.md)
