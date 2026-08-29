# Getting Started with Resin

Resin finds recurring patterns in sessions from Claude Code, Codex CLI, and Oh My Pi. It compiles stable work into qualified tools that use less inference, lower inference cost, and complete matching work faster, then activates eligible versions automatically within each project's Capability Envelope.

---

## Prerequisites

Before installing Resin, ensure your environment meets the following requirements:

- **Node.js**: Version `>= 22.0.0` (LTS recommended)
- **Operating System**:
  - Linux (x86_64, arm64)
  - macOS (Apple Silicon arm64, Intel x86_64)
  - Windows Subsystem for Linux (WSL2, Ubuntu 22.04+)
- **Coding Harnesses** (at least one installed):
  - [Claude Code CLI](https://claude.ai/code)
  - [Codex CLI](https://github.com/openai/codex)
  - [Oh My Pi (OMP)](https://github.com/canary-laboratories/omp)
- **Optional**: [Deno runtime](https://deno.com) (`>= 2.0.0`) for hardened worker isolation (falls back to Node.js subprocess sandbox if unavailable).

---

## 1. Single-Command Installation & Automatic Onboarding

Install Resin with the standalone bootstrap script:

```bash
curl -fsSL https://resin.sh/install.sh | sh
```

PowerShell:

```powershell
irm https://resin.sh/install.ps1 | iex
```

During a fresh interactive installation, Resin automatically initiates **machine-level device linking** and completes global setup in a single step:

1. Runs **preflight** checks (platform, architecture, and Node.js `>= 22.0.0`).
2. Verifies the **signed release** (binaries, runtime, MCP shim) against the production channel.
3. Creates local state, daemon configuration, and logs under `~/.resin/` (e.g. `~/.resin/config/`, `~/.resin/logs/`, `~/.resin/state/`).
4. Automatically approves the default least-privilege capability envelope and local-only privacy plan for the installation. Raw transcripts, prompts, and code are never uploaded.
5. **Automatically opens the browser for device linking** (RFC 8628) to pair your machine with Resin Cloud (unless `--local-only` or running non-interactively). Sign in or review your machine pairing in the Resin Console.
6. Discovers installed coding harnesses (Claude Code, Codex CLI, Oh My Pi).
7. Configures harness MCP registrations globally.
8. Installs, starts, and health-checks the **non-root user service**.
9. Records the install journal (no secrets).

### Global Setup & Project Autonomy

Once device linking and machine-level onboarding complete, **all projects work automatically without per-project initialization**. When an AI harness runs in any Git repository or directory, the local Resin gateway dynamically identifies the project and manages local metadata (`.resin/project.json` and `.resin/resin.lock`) automatically in the background. No `init` command is required inside individual project folders.

### Manual Fallback: `resin init`

If you ever need to re-run initial setup, reconfigure harness integrations, or manually initialize the daemon on an existing installation, use `resin init`:

```bash
npx resin init
# or with the globally installed binary:
resin init
```

### Non-Interactive, CI, and Local-Only Skip Behavior

To prevent hanging in automated pipelines or headless environments, the onboarding browser prompt is automatically skipped when:
- Running in **CI or non-interactive environments** (`CI=true`, non-TTY stdin/stdout, or passing `--non-interactive`).
- Running under **root/sudo** (where browser opening and user daemon setup are suppressed).
- Passing **`--local-only`** (operates entirely offline without cloud pairing; `resin status` reports `LOCAL ONLY`).
- The machine is **already initialized** with valid credentials at `~/.resin/state/device-token.json`.

Cloud device credentials are written owner-only to `~/.resin/state/device-token.json` (mode `0600`) with an optional ancillary vault copy when a `SecretManager` is configured. They are distinct from the local IPC token (`auth.token` on the daemon socket path). Access and refresh tokens are not written to harness config, project metadata, logs, or support output.

If a user service is already running when pairing replaces credentials, the daemon restarts automatically to reload the token file.
---

## 2. Flags You Will Actually Use

| Flag | Behavior |
|------|----------|
| `--gateway-url <url>` | MCP URL written into every configured harness. Default `http://127.0.0.1:9400/mcp/sse` only when omitted. |
| `--local-only` | Skip cloud pairing. Local MCP stays available; `resin status` reports `LOCAL ONLY` (derived from the install journal). |
| `--non-interactive` | No prompts. Requires one authorization mechanism (`--auto-approve` or valid `--capabilities-file`) and one pairing mechanism (valid pre-provisioned credentials or `--local-only`). Never silently claims cloud connectivity. |
| `--auto-approve` / `-y` / `--yes` | Approves the capability/privacy plan without an interactive prompt. **Does not skip pairing.** |
| `--cloud-url <url>` | Cloud origin (default `https://api.resin.sh`, or `RESIN_CLOUD_URL`). HTTPS or loopback HTTP only. |
| `--dry-run` | Print the plan; write nothing. |
| `--rollback-install` | Roll back the previous installation using the saved journal. |
| `--home <path>` | Treat `<path>` as `$HOME` (token file at `<path>/.resin/state/device-token.json`). |

Non-interactive examples:

```bash
# CI / unattended: local MCP only (authorization + local-only pairing)
npx resin init --non-interactive --local-only --auto-approve

# CI / unattended: pre-approved capability file + local-only pairing
npx resin init --non-interactive --local-only --capabilities-file ./capabilities.json

# CI / unattended: reuse pre-provisioned ~/.resin/state/device-token.json
npx resin init --non-interactive --auto-approve
```

Non-interactive init requires both an authorization option (`--auto-approve` or `--capabilities-file`) and a pairing option (valid pre-provisioned credentials or `--local-only`). `--json` mode emits a structured pairing verification record during pairing and a final summary upon completion, rather than streaming progress records.

Inspect the mutation plan without installing:

```bash
npx resin init --dry-run
```

---

## 3. Capability And Privacy Authorization

Resin operates under least privilege. During interactive initialization, Resin displays the formatted workspace **capability envelope** and **privacy plan** and prompts for explicit yes/no confirmation. If denied, the installation cancels immediately before pairing or modifying files. In non-interactive mode, `--auto-approve` or a pre-approved `--capabilities-file` (and optional `--privacy-config`) is required. The displayed plan includes filesystem, network, command, secret, redaction, local-only, cloud-sync, and telemetry bounds. Default privacy is local-only with cloud sync and telemetry off.

---

## 4. Verify, Relogin, Logout, Recover

After `npx resin init`, check observed service/IPC/cloud state:

```bash
resin status
```

`resin status` prints boxed sections. Service is `RUNNING (active)`, `STOPPED (inactive)`, or `NOT INSTALLED`. IPC is `CONNECTED` or `DISCONNECTED`. Cloud is `AUTHENTICATED`, `LOCAL ONLY (Cloud Unconfigured)` (derived from the completed install journal), or `NOT AUTHENTICATED` (with a reason). Authenticated rows may include `EXPIRED`. Note that `resin status` validates credentials locally and does not proactively query the server to discover remote token revocation in real time. The four locked meta-tools are listed under Tools & MCP Catalog.

Diagnostics and repair:

```bash
resin doctor
resin doctor --fix
resin repair
```

`repair` / `doctor --fix` create missing directories (including vault if configured), remove a stale daemon lockfile, install or start the user service, reattach harness MCP entries, and rewrite a local production safety attestation. There is no `--export-bundle`, `--restart-daemon`, or `--fix-harness-configs` flag.

Replace credentials later:

```bash
resin login
resin login --force
```

`resin login` reuses valid cached same-origin credentials without initiating a new browser flow unless `--force` is supplied. It opens the complete verification URL (unless `--no-browser`) and prints the URL plus code (or emits a structured JSON verification event in `--json` mode). After a replacement while the daemon is already running, restart the user service so it reloads `device-token.json` (`resin repair` starts an inactive service; `resin init` pairing restarts a running service itself).

Logout revokes the device token remotely when possible, then purges the owner-only file and optional ancillary vault. Local tools, SQLite state, harness MCP config, and the four locked meta-tools remain:

```bash
resin logout
```

---

## 5. Offline Local MCP

If the cloud is unreachable or you signed out, the local gateway continues to serve the locked meta-tools:

- `search_tools`
- `get_tool_schema`
- `invoke_tool`
- `manage_tools`

Ask the harness to search the catalog:

```text
> Search for tools to inspect repository structure
```

---

## Next Steps

- [Configuration Reference](configuration.md)
- [Meta-Tools Specification](meta-tools.md)
- [Harness Integration Guide](harness-guide.md)
- [Doctor & Repair Guide](doctor-and-repair.md)
- [Security & Privacy Model](security-and-privacy.md)
