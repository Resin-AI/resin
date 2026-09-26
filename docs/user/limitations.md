# System Scope & Limitations (V1)

This document specifies the supported scope, platform matrix, resource boundaries, and intentional non-goals for the Resin V1 release.

---

## 1. Supported Platform Matrix

| Platform | Architecture | Status | Minimum Requirements |
|----------|--------------|--------|----------------------|
| **Linux** | `x86_64` | Supported | Kernel 5.4+, Node.js >= 22.0.0, glibc 2.31+ |
| **Linux** | `arm64` | Supported | Kernel 5.4+, Node.js >= 22.0.0, glibc 2.31+ |
| **macOS** | Apple Silicon (`arm64`) | Supported | macOS 12+ (Monterey or later), Node.js >= 22.0.0 |
| **macOS** | Intel (`x86_64`) | Supported | macOS 12+ (Monterey or later), Node.js >= 22.0.0 |
| **Windows Subsystem for Linux** | `WSL2` (Ubuntu 22.04+) | Supported | WSL2 with systemd enabled, Node.js >= 22.0.0 |
| **Windows Native (Win32)** | `x86_64` | Unsupported in V1 | Recommended to run inside WSL2 |

---

## 2. Supported AI Coding Harnesses

| Harness | Version Compatibility | Tested Versions | Supported Protocols |
|---------|-----------------------|-----------------|---------------------|
| **Claude Code CLI** | `>= 0.1.0` | `0.2.29`, `1.0.0` | MCP SSE / JSONL observation |
| **Codex CLI** | `>= 0.1.0` | `0.1.0`, `0.2.0` | MCP SSE / TOML session observation |
| **Oh My Pi (OMP)** | `>= 0.1.0` | `0.1.0`, `0.2.0` | MCP SSE / Hub IPC observation |
---

## 3. Runtime Boundaries & Default Limits

| Resource Limit | Default Value | Max Configurable | Description |
|----------------|---------------|------------------|-------------|
| **Execution Timeout** | 30 seconds | 300 seconds | Maximum time a single tool invocation may run |
| **Worker Memory** | 512 MB | 2048 MB | Maximum RSS memory allocated per tool sandbox |
| **Output Size** | 2 MB | 10 MB | Maximum stdout/return payload size per invocation |
| **Max Concurrent Workers**| 4 workers | 16 workers | Concurrent tool execution sandbox instances |
| **Max Evolution Candidates**| 20 / day | 100 / day | Daily quota for autonomous tool synthesis |
| **File Read Size** | 10 MB | 50 MB | Maximum single file size a tool may read |

### Recorded-workflow validation

Validation executes nothing recorded. For every recorded step (shell/process, program,
tool-protocol, harness tool, composed invoke) the gateway resolves the step's call exactly as an
invocation would and compares it with the call this device recorded for that step: the same
callable (name, connection, program kind/argument) and every argument equal to the recorded value,
with program templates compared after resolving the private original. A match lets the recorded
output answer the step; a mismatch or a step with no recorded call is missed and the plan is not
verified. No recorded program is spawned, no tool call is dispatched, and no project is copied.

Recorded values are read only from the local private store, under references the device
recomputes from sessions its own harness adapters discovered and the plan's call ids, and only from
entries owned by this workspace. References or literals carried in a plan are never trusted as the
recording. Consequences:

- Recordings captured before Resin stored per-call identity entries cannot be validated.
- Held-out repeats need their harness call ids (`heldOut.calls`); without them, or when calls
  cannot be identified locally, the result is unavailable, never verified.
- When session discovery is unavailable, the ask is deferred.
- A step that still carries, as literal recorded text, a value the recording shows flowing from an
  earlier step's output is not verified until the plan binds that position. A closed plan whose
  literal matches an earlier output only by coincidence is therefore refused (fails closed).

Passing validation does not make a tool safe to run: an invoked tool still runs its recorded
commands with the user's own permissions.

Python Eval recordings retain their adapter-established result semantics: explicit stdout and the
final expression's representation contribute to the observed result, with Eval's edge-whitespace
projection. A trailing semicolon does not suppress that expression. Ordinary Python process
recordings still return stdout unchanged; callable names alone never select Eval behavior.
Invocation uses a fresh process and the recorded, closed setup sequence, not the live kernel.
Unsupported host-prelude operations and unresolved state do not become supported merely because
the recording carries an Eval marker.

JavaScript Eval recordings likewise retain an adapter-established result interface. Invocation
preserves console output and synchronous script completion values; top-level `await`, `return`, and
static imports use asynchronous evaluation with a final-expression result. Scalars render as text
and cloneable objects use Eval's numbered display representation, followed by edge-whitespace
projection. Static named, default, namespace, and side-effect imports are supported; export
declarations and import attributes are not. Ordinary JavaScript process recordings still return
stdout unchanged. This interface does not capture a live JavaScript kernel or make unresolved state
and host-prelude operations supported.

Derivation steps (model-written Python) are the only code validation runs; they run in a sandbox
at validation and at invocation (see [SECURITY.md](../../SECURITY.md#derivation-steps)).

### Generated code imports

Sandboxed code artifacts may import only `@resin/runtime` and bundled relative
TypeScript/JavaScript modules. Relative imports must name an exact file with its
extension and remain inside the artifact; extensionless/index fallback resolution,
symlinks, asset imports, and non-literal dynamic imports are not supported.
Node built-ins (including `node:crypto`), arbitrary packages, and remote modules
are rejected before worker execution. Use standard Web Crypto for hashing and
the capability brokers for host operations; an import-policy failure is not a
reason to widen sandbox permissions or rewrite a signed artifact.
CommonJS artifacts (`.cjs` or `package.json` with `"type": "commonjs"`) are
unsupported; code artifacts must use ES modules.

---

## 4. Explicit Non-Goals for V1

The following capabilities are deliberately excluded from the V1 architecture:

1. **Raw Transcript Cloud Exfiltration**: Resin will never upload raw user prompts, reasoning thoughts, or proprietary source code to cloud endpoints.
2. **Unmediated Root/Sudo Execution**: Evolved tools run as standard user processes inside restricted sandboxes and cannot invoke `sudo` or modify system files.
3. **Arbitrary Internet Scraping**: Tools cannot initiate unrestricted WAN network requests without explicit domain allowlisting in the capability envelope.
4. **Kernel-Level Drivers or Hooks**: System observation relies exclusively on userspace session logs and standard file system tailing.
5. **Interactive GUI Automation**: Resin focuses exclusively on CLI tools, MCP endpoints, code refactoring scripts, and developer workflow automation.
6. **Cloud-Optional Local MCP**: `--local-only` (recorded in the install journal for `resin status`) and post-logout operation keep the four locked meta-tools (`search_tools`, `get_tool_schema`, `invoke_tool`, `manage_tools`) on the local gateway. Authenticated catalog/observation/project sync requires valid `~/.resin/state/device-token.json`.
7. **Non-Interactive Initialization**: Unattended `init` requires both an authorization grant (`--auto-approve` or valid `--capabilities-file`) and a pairing mechanism (valid pre-provisioned credentials or `--local-only`). `--auto-approve` skips the capability/privacy prompt; it does not skip pairing or synthesize credentials.


---

## Related Documentation

- [Getting Started](getting-started.md)
- [Configuration Reference](configuration.md)
- [Security & Privacy](security-and-privacy.md)
- [Support Policy](../security/support-policy.md)
- [Compatibility Matrix](../release/compatibility-matrix.md)
