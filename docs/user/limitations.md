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

### Recorded-workflow replay inputs

The gateway runs recorded programs with a disposable working directory, never the live project as
their current directory. Local validation binds private recording references to host-discovered
sessions and their project roots before copying current safe, non-hidden project files into that
directory while preserving relative paths. It never chooses a root supplied by a cloud plan or
substitutes the polling MCP process's unrelated project.
It does not reuse an old snapshot. Hidden entries, paths excluded by Resin's sensitive-path policy,
and `node_modules`, `dist`, `build`, `coverage`, `__pycache__`, and `venv` directories are omitted.
Symlinks and non-regular files are not copied or followed.

Each snapshot is limited to 128 MiB total, 10 MiB per file, 10,000 copied regular files, and 20,000
enumerated filesystem entries. Reaching a limit exactly is allowed. Exceeding a bound or encountering
an unsafe, inaccessible, or changing source fails snapshot preparation; the partial copy is removed
and no validation decision is submitted, so the ask can be retried later. Missing, ambiguous, or
conflicting local recording-to-project bindings likewise remain pending. Mixed program/tool-protocol
replays additionally require the polling host to be in the recorded project before dispatching its
tools. Before the trusted workspace context is ready, validation remains pending.

Snapshotting supplies current file bytes; it does not relax verification. Recorded outputs are still
compared with the plan's expected observations, so changed inputs that produce different results do
not verify. The temporary working directory is not a filesystem sandbox: a child process still runs
with the daemon user's filesystem permissions and may access files by absolute path.

Python Eval recordings retain their adapter-established result semantics: explicit stdout and the
final expression's representation contribute to the observed result, with Eval's edge-whitespace
projection. A trailing semicolon does not suppress that expression. Ordinary Python process
recordings still return stdout unchanged; callable names alone never select Eval behavior.
Replay uses a fresh process and the recorded, closed setup sequence, not the live kernel. Unsupported
host-prelude operations and unresolved state do not become supported merely because the recording
carries an Eval marker. Output comparison remains unchanged.

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
