# Compatibility Matrix

This document describes how Resin client releases are versioned and which platforms, harnesses and protocol features each release covers. It is not tied to one release: the version a given artifact carries is in its signed release manifest.

---

## 1. Versioning

- **Product and CLI**: the product is **Resin**; the CLI command is `resin`.
- **Release versions**: releases are tagged `v1.0.<patch>` and published through the signed release channel (`https://dist.resin.sh/releases/v1/channels.json`). `resin upgrade` installs only versions that channel authenticates.
- **One commit per release**: every artifact of a release is built from the same commit and carries the same version.
- **Workspace packages**: internal packages use the `@resin/*` scope. Their wire contracts (`@resin/contracts`, `@resin/protocol`, `@resin/harness-contracts`) evolve additively; schema versions are carried in the payloads themselves.

---

## 2. Platforms

Every release candidate qualifies seven lanes before it can be published (see [ADR 0014](../adr/0014-native-windows-support.md)). Linux and Windows lanes install and run the packaged artifact natively; the macOS and WSL lanes check the artifact's digest and layout on a Linux runner and are not run on those operating systems in CI.

| Lane            | Artifact                                | Service manager               | Daemon endpoint             | Release candidate check                       |
| --------------- | --------------------------------------- | ----------------------------- | --------------------------- | --------------------------------------------- |
| `linux-x64`     | `resin-v<version>-linux-x64.tar.gz`     | `systemd --user`              | Unix socket (`0600`)        | Native on `ubuntu-24.04`                      |
| `linux-arm64`   | `resin-v<version>-linux-arm64.tar.gz`   | `systemd --user`              | Unix socket (`0600`)        | Native on `ubuntu-24.04-arm`                  |
| `darwin-x64`    | `resin-v<version>-darwin-x64.tar.gz`    | `launchd`                     | Unix socket (`0600`)        | Artifact validation only                      |
| `darwin-arm64`  | `resin-v<version>-darwin-arm64.tar.gz`  | `launchd`                     | Unix socket (`0600`)        | Artifact validation only                      |
| `wsl`           | `resin-v<version>-wsl.tar.gz`           | `systemd --user` / supervisor | Unix socket (`0600`)        | Artifact validation only                      |
| `windows-x64`   | `resin-v<version>-windows-x64.tar.gz`   | Per-user logon Scheduled Task | Named pipe, owner-only DACL | Native on `windows-latest`, second-user probe |
| `windows-arm64` | `resin-v<version>-windows-arm64.tar.gz` | Per-user logon Scheduled Task | Named pipe, owner-only DACL | Native on `windows-11-arm`, second-user probe |

Minimum operating system and Node.js requirements are listed in [Limitations](../user/limitations.md#1-supported-platform-matrix).

Native Windows installs from Windows PowerShell 5.1 or PowerShell 7+ with `irm https://resin.sh/install.ps1 | iex`. Each Windows artifact carries its architecture's `@resin/windows-security` native helper and windowless service host.

### Shell dialects

| Shell                                     | Dialect id     | Captured | Learnable / replayable       |
| ----------------------------------------- | -------------- | -------- | ---------------------------- |
| bash, sh, dash, zsh                       | POSIX dialects | ✅       | ✅                           |
| Windows PowerShell 5.1 (`powershell.exe`) | `powershell`   | ✅       | ✅ (only as `powershell`)    |
| PowerShell 7+ (`pwsh`)                    | `pwsh`         | ✅       | ✅ (only as `pwsh`)          |
| cmd.exe                                   | `cmd`          | ✅       | ❌ Reported as not learnable |

A recording is checked and replayed only under the dialect it was recorded in. PowerShell is learnable only when the recording proves the edition (e.g. Codex's recorded argv names `powershell.exe` or `pwsh.exe`); Claude Code's PowerShell tool does not record its edition, so its calls are captured and reported as not learnable.

---

## 3. AI Coding Harnesses

Resin ships adapters for Claude Code, Codex CLI, Oh My Pi (OMP), Pi, Cursor CLI, Grok Build, Muse Code, OpenCode and GitHub Copilot CLI. Every harness is registered as a stdio MCP server (`<resin home>/bin/resin mcp`). The versions each adapter has recorded-session coverage for are listed in [Limitations](../user/limitations.md#2-supported-ai-coding-harnesses) and, with configuration paths and capture methods, in the [Harness Integration Guide](../user/harness-guide.md).

---

## 4. MCP Features

| MCP Feature                        | Supported | Notes                                                       |
| ---------------------------------- | --------- | ----------------------------------------------------------- |
| `tools/list`                       | ✅ Yes    | Locked meta-tools plus the workspace's learned tools        |
| `tools/call`                       | ✅ Yes    | Enforces the capability envelope                            |
| `notifications/tools/list_changed` | ✅ Yes    | Sent when the catalog changes, to clients that support it   |
| `resources/*`, `prompts/*`         | ❌ No     | Not served                                                  |

---

## Related Documentation

- [Rollback Procedures](rollback-procedure.md)
- [Release Signing Trust](signing-trust.md)
- [Support Policy](../security/support-policy.md)
