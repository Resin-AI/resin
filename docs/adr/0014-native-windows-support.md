# ADR 0014: Supported Harnesses and Platforms, Including Native Windows

- **Status**: accepted
- **Date**: 2026-09-28
- **Deciders**: Resin Core Architecture Team
- **Consulted**: Developer Tooling, CI/CD Team, Platform Engineering, Security (Resin-AI/resin#209)
- **Supersedes**: [ADR 0003](0003-supported-harnesses-and-platforms.md)

## Context and Problem Statement

[ADR 0003](0003-supported-harnesses-and-platforms.md) scoped V1 to Linux, macOS and WSL2 and put native Windows (Win32) out of scope, so every native Windows run was refused with "please run within WSL2". Coding agents that run natively on Windows (OMP, Claude Code, Codex and others) execute their commands in Windows PowerShell 5.1, PowerShell 7+ or cmd.exe, so none of their work could be captured, learned or replayed.

The reasons ADR 0003 gave for excluding Win32 were concrete: no POSIX service manager, POSIX-only socket and file permission enforcement, POSIX-only shell grammar, and Win32 path differences. Each now has a Windows answer (below). This ADR restates the V1 harness and platform matrix with native Windows as a Tier 1 platform. Everything ADR 0003 decided about harnesses and the adapter boundary is carried over unchanged.

## Decision Drivers

- **Meet Windows developers where their agents run**: agents on Windows default to PowerShell; WSL2 captures none of that work.
- **Same product on every platform**: a service that starts at login and restarts after a crash, capture, learned tools and correct replay, with the same privacy guarantees.
- **Security parity**: only the installing user may reach the daemon or read Resin's private files, and this is tested, not assumed.
- **Never silently mis-parse**: a shell grammar Resin does not model must be reported, not guessed.
- **Release gating**: a platform is supported only if the release candidate qualifies it natively and blocks the release when it fails.
- **Hermetic Adapter Architecture** (unchanged from ADR 0003): new harnesses implement the adapter contract without changing core gateway logic.

## Considered Options

1. **Option 1: Keep native Windows out of scope (ADR 0003 as is)**
   - *Pros*: No new platform surface.
   - *Cons*: Work done by native Windows agents is invisible to Resin; Windows users must move their agents into WSL2.

2. **Option 2: Native Windows through POSIX emulation (Git Bash / MSYS2 / Cygwin)**
   - *Pros*: Reuses the POSIX grammar and service assumptions.
   - *Cons*: Agents do not run their commands there; replaying PowerShell work under bash would be wrong; emulated permissions do not protect a named pipe.

3. **Option 3: First-class native Windows with Windows-native mechanisms (Selected)**
   - *Pros*: Captures what Windows agents actually run; uses the OS's own service, IPC and ACL mechanisms; qualified in the release candidate like every other platform.
   - *Cons*: A small native helper to build and ship per architecture, a PowerShell grammar to maintain, two more release lanes.

## Decision

### 1. Supported AI Coding Harnesses (Tier 1)

Unchanged from ADR 0003: Claude Code, Codex CLI and Oh My Pi (OMP) are first-class, each behind a dedicated adapter package (`@resin/adapter-claude-code`, `@resin/adapter-codex`, `@resin/adapter-omp`) that implements `@resin/harness-contracts`. Further harnesses join through the same contract. On native Windows every adapter discovers the harness's Windows executables (`.exe` / `.cmd`) and reads its sessions from their Windows locations.

### 2. Supported Operating System Platforms

| Operating System | Architectures | Support Level | Qualification lane | Service |
| :--- | :--- | :--- | :--- | :--- |
| **Linux** (glibc >= 2.31) | `x86_64`, `arm64` | Tier 1 | `linux-x64`, `linux-arm64` (native) | `systemd --user` |
| **macOS** (>= 13.0) | `arm64`, `x86_64` | Tier 1 | `darwin-arm64`, `darwin-x64` (artifact) | `launchd` |
| **Windows via WSL2** | `x86_64`, `arm64` | Tier 1 | `wsl` (artifact) | `systemd --user` or supervisor |
| **Native Windows 10/11** | `x86_64`, `arm64` | **Tier 1** | `windows-x64`, `windows-arm64` (native) | per-user Scheduled Task |

Native Windows is `process.platform === "win32"`; its artifacts carry `platform: "win32"` and its lanes are `windows-x64` and `windows-arm64`. WSL2 is unchanged and remains a Linux install; a native install and a WSL2 install on the same machine use separate homes, services and endpoints and do not interfere.

### 3. Native Windows mechanisms

- **Install**: `irm https://resin.sh/install.ps1 | iex` from Windows PowerShell 5.1 or PowerShell 7+, with Node.js >= 22. Resin home stays `%USERPROFILE%\.resin` (respecting `RESIN_HOME`) with the same layout as POSIX. `-UseWsl` keeps the legacy WSL2 install.
- **Service**: a per-user Scheduled Task with a logon trigger, the current user, least privilege and no execution time limit, launching a windowless service host that supervises the daemon and restarts it after a crash. Not a Windows Service (would need elevation and run as another account) and not a Run key (no restart on crash). `resin uninstall` removes the task and everything Resin created.
- **IPC and private files**: a small N-API helper, `@resin/windows-security`, creates the daemon's named pipe `\\.\pipe\resin-daemon-<hash of user SID and Resin home>` with an owner-only protected DACL (network logons denied, remote clients rejected, first-instance squat protection), verifies the pipe's owner and server process before a client trusts it, and applies owner-only DACLs to private files and directories. Prebuilt binaries ship per architecture in the release artifact.
- **Shells**: Windows PowerShell 5.1 (`powershell`) and PowerShell 7+ (`pwsh`) are separate, learnable dialects, never mixed with each other or with POSIX shells. A PowerShell recording is learnable only when the recording itself proves the edition (for example Codex's recorded command argv naming `powershell.exe` or `pwsh.exe`); a call whose edition is unrecorded, such as Claude Code's PowerShell tool, is captured and reported as not learnable. The dialect is never inferred from the host. cmd.exe commands are captured and reported as not learnable; they are never parsed, split, parameterized or replayed. A recording is only checked or replayed under the dialect it was recorded in.
- **Privacy**: secret scrubbing covers Windows forms (`C:\Users\<name>\…`, `%VAR%`, `$env:VAR`, `USERPROFILE`), under the same boundaries as [ADR 0005](0005-privacy-data-boundaries.md).

### 4. Harness adapter layer

The adapter abstraction layer from ADR 0003 is unchanged:

```
+------------------------------------------------------------+
| Harness Adapter Abstraction Layer                          |
|                                                            |
|  @resin/adapter-claude-code   @resin/adapter-codex         |
|              \                     /                       |
|               +-> @resin/adapter-omp <-+                   |
|                          |                                 |
|                          v                                 |
|  @resin/harness-contracts (Standard Normalized API)        |
|                          |                                 |
|                          v                                 |
|  @resin/gateway (Local MCP Gateway Engine)                 |
+------------------------------------------------------------+
```

## Consequences

### Positive
- Windows developers install and use Resin natively; work their agents do in PowerShell becomes capturable, learnable and replayable.
- The daemon endpoint and private files are protected by OS ACLs, proven by a second-user test in the release candidate.
- Every platform in the table is qualified on the exact release commit before signing.

### Negative / Trade-offs
- A native helper must be built with MSVC for each Windows architecture and shipped with the release.
- Two more release-candidate lanes on Windows runners, which are slower than Linux runners.
- A PowerShell grammar to maintain alongside the POSIX one.

### Mitigations
- The native helper is small, uses only Node-API and Win32, builds without node-gyp, and its bytes are recorded by the qualifying lane and re-checked by the signing job.
- The Windows lanes run in parallel with the other qualification jobs and add no work to the pull-request path.
- The cmd.exe dialect is explicitly non-learnable, so the grammar surface is limited to PowerShell.

## Migration Plan

- **Existing WSL2 installs**: unchanged. `install.sh` inside WSL2 and `install.ps1 -UseWsl` keep installing the Linux build; nothing is migrated.
- **Native Windows users who were refused**: run the PowerShell one-liner. No state existed before, so there is nothing to convert.
- **Both on one machine**: native and WSL2 installs keep separate homes (`%USERPROFILE%\.resin` vs `~/.resin` inside the distribution), services and endpoints; neither detects nor modifies the other.
- **Code**: the `win32` rejection (`UnsupportedPlatformError` for Win32 and the `nativeWindows` limitation) is removed; `SupportedPlatform` gains `windows` and the qualification lanes gain `windows-x64` and `windows-arm64`.
- **Release**: `release-candidate.yml` adds the native Windows lanes and the signing job requires their evidence; releases cut before this change are unaffected.

## Compliance and Verification

- `release-candidate.yml` runs `windows-latest` (x64) and `windows-11-arm` (arm64) lanes on the exact commit: native prebuild build, packaging, `scripts/platform-qualification.mjs --mode=native` (artifact layout, launchers, named pipe ownership, owner-only ACLs), the Windows test suites, an `install.ps1` install under Windows PowerShell 5.1, `scripts/platform-qualification.mjs --windows-service` against the installed home (`resin init`, Scheduled Task registration, healthy `resin status`, crash restart, stop/start), a second-local-user isolation probe, and `resin uninstall` with a check that nothing remains. The signing job needs these lanes, verifies the prebuilds it packages are the qualified bytes, and `scripts/generate-production-qualification-evidence.mjs` refuses evidence without native Windows qualification.
- `scripts/platform-qualification.test.mjs`, `scripts/generate-production-qualification-evidence.test.mjs` and `scripts/windows-lane.test.mjs` cover lane detection, artifact layout and the evidence rules.
- Monorepo package boundary rules continue to keep harness adapters decoupled behind `@resin/harness-contracts`.
