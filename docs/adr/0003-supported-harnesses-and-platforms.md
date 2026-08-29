# ADR 0003: Supported AI Harnesses and Operating System Platforms

- **Status**: accepted
- **Date**: 2026-08-17
- **Deciders**: Resin Core Architecture Team
- **Consulted**: Developer Tooling, CI/CD Team, Platform Engineering

## Context and Problem Statement

Developer workflows utilize a variety of AI coding agents and CLI harnesses. To maximize adoption and utility in V1, Resin must establish unambiguous target support tiers for client harnesses and host operating systems. Supporting too broad a matrix in V1 risks fracturing test coverage, while supporting too narrow a matrix hinders real-world developer adoption.

We must define the explicit matrix of supported AI harnesses and operating systems for the V1 release, along with adapter abstraction boundaries.

## Decision Drivers

- **Ecosystem Focus**: Prioritize the dominant, developer-facing AI coding harnesses that support standard MCP tool protocols.
- **Platform Parity**: Provide consistent execution, sandboxing, and performance across mainstream developer development environments.
- **Engineering Feasibility**: Avoid complex Win32-specific low-level process sandboxing and path idiosyncrasies in V1.
- **Hermetic Adapter Architecture**: Ensure adding future harnesses requires only implementing a clean adapter contract without modifying core gateway logic.

## Considered Options

1. **Option 1: Universal Platform Matrix (Linux, macOS, Native Windows Win32, Web/Browser)**
   - *Pros*: Maximum theoretical market reach.
   - *Cons*: High maintenance cost; native Windows process isolation and POSIX signal handling differ drastically; browser environments lack local filesystem access.

2. **Option 2: Linux & macOS Only (Excluding Windows entirely)**
   - *Pros*: Simplest POSIX-only codebase.
   - *Cons*: Excludes the large population of Windows developers utilizing WSL for development.

3. **Option 3: Focused Tier-1 Harnesses with Linux, macOS, and WSL2 (Selected)**
   - *Pros*: Covers >95% of active AI coding agent developers; maintains pure POSIX runtime consistency; cleanly abstracts harness variations into dedicated adapter packages.
   - *Cons*: Windows developers must run within WSL2.

## Decision

We decide on the following explicit harness and platform matrix for V1:

### 1. Supported AI Coding Harnesses (Tier 1)

Resin provides first-class, verified adapters for three AI harnesses:

1. **Claude Code**: Anthropic's CLI coding agent via stdio / MCP configuration integration.
2. **Codex CLI**: OpenAI Codex CLI environment via MCP bridge.
3. **Oh My Pi (OMP)**: Multi-agent coding harness with native subagent orchestration and tool invocation.

All harness interactions are mediated through dedicated adapter packages (`@resin/adapter-claude-code`, `@resin/adapter-codex`, `@resin/adapter-omp`), which implement the common `@resin/harness-contracts` interface.

### 2. Supported Operating System Platforms

Resin V1 officially supports:

| Operating System | Architectures | Support Level | Notes |
| :--- | :--- | :--- | :--- |
| **Linux** (glibc >= 2.31) | `x86_64`, `arm64` (aarch64) | Tier 1 (Primary) | Ubuntu, Debian, Fedora, Arch, Alpine |
| **macOS** (>= 13.0 Ventura) | `arm64` (Apple Silicon), `x86_64` | Tier 1 (Primary) | Native launchd integration |
| **Windows via WSL2** | `x86_64`, `arm64` | Tier 1 (Primary) | Ubuntu / Debian on WSL2 |
| **Native Windows (Win32)** | `x86_64`, `arm64` | **Out of Scope (V1)** | Deferred to V2; use WSL2 |

```
+---------------------------------------------------------------+
| Harness Adapter Abstraction Layer                             |
|                                                               |
|  +------------------------+  +------------------------------+ |
|  | @resin/         |  | @resin/               | |
|  | adapter-claude-code    |  | adapter-codex                | |
|  +-----------+------------+  +--------------+---------------+ |
|              |                              |                 |
|              |   +-----------------------+  |                 |
|              +-->| @resin/        |<--+                 |
|                  | adapter-omp           |                    |
|                  +-----------+-----------+                    |
|                              |                                |
|                              v                                |
|  +----------------------------------------------------------+ |
|  | @resin/harness-contracts (Standard Normalized API)| |
|  +---------------------------+------------------------------+ |
|                              |                                |
|                              v                                |
|  +----------------------------------------------------------+ |
|  | @resin/gateway (Local MCP Gateway Engine)         | |
|  +----------------------------------------------------------+ |
+---------------------------------------------------------------+
```

## Consequences

### Positive
- Unified POSIX runtime semantics simplify path normalization, permission enforcement, signal propagation (`SIGTERM`, `SIGKILL`), and Deno worker spawning.
- Each harness has a dedicated adapter package tested against that harness's specific MCP transport and session formats.
- Clear scope boundaries prevent regressions from edge-case native Windows Win32 API differences.

### Negative / Trade-offs
- Windows users who do not use WSL2 cannot run Resin natively in V1.

### Mitigations
- Clear documentation and CLI error messages detect native Windows execution and guide users to launch within WSL2.
- The CLI provides an automatic configuration command (`resin setup <harness>`) that auto-detects installed harnesses and writes the appropriate MCP configuration snippet.

## Compliance and Verification

- CI pipeline runs automated test suites across Ubuntu Linux (`x86_64`), macOS (`arm64`), and Ubuntu on WSL2.
- Monorepo package boundary rules ensure that harness-specific adapters remain decoupled and only interact via `@resin/harness-contracts`.
