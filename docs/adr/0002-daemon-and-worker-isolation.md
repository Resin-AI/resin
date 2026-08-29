# ADR 0002: Daemon Architecture and Deno Worker Sandboxing

- **Status**: accepted
- **Date**: 2026-08-17
- **Deciders**: Resin Core Architecture Team
- **Consulted**: Security, Runtime Engineering, Core Platform

## Context and Problem Statement

The Resin local architecture must support two distinct operational requirements:
1. **Control Plane Stability**: The local background daemon hosts long-lived coordination services including the Local MCP Gateway, Observer, Local Registry, Cloud Sync Manager, and Cryptographic Audit Logger. This daemon must remain robust, maintain open MCP connections with developer harnesses, and never crash due to faulty tool code.
2. **Untrusted Tool Execution**: Dynamically synthesized tools, candidate versions, and community tools may contain infinite loops, memory leaks, unhandled exceptions, or subtle safety defects. Executing generated code directly inside the daemon process creates severe stability and security vulnerabilities.

We must define the local process model and isolation mechanism for executing tool code.

## Decision Drivers

- **Fault Isolation**: A crashing, hanging, or panicking tool execution must never terminate or stall the primary daemon.
- **Resource Containment**: Tools must operate under strict CPU, memory, and timeout limits.
- **Fast Startup Latency**: Worker cold start must remain below 35ms to ensure responsive tool execution.
- **Deterministic Sandboxing**: The runtime must enforce fine-grained capability restrictions (filesystem paths, network endpoints, child processes).
- **Hermetic Reproducibility**: Execution behavior must be identical across developer workstations regardless of ambient Node/npm version variations.

## Considered Options

1. **Option 1: In-Process Node.js `vm` / `AsyncLocalStorage`**
   - *Pros*: Zero process spawn overhead, minimal memory footprint.
   - *Cons*: Node.js `vm` module is explicitly not a security sandbox; memory leaks and native crashes (`SIGSEGV`) crash the entire daemon; impossible to enforce hard CPU time limits reliably.

2. **Option 2: Docker / Container-Based Isolation**
   - *Pros*: Total OS-level isolation, cgroups resource controls.
   - *Cons*: High startup overhead (500ms–2s), heavyweight dependencies (Docker daemon required), incompatible with lightweight developer environments and CI runners.

3. **Option 3: WebAssembly (Wasm) Runtime (e.g., Wasmtime / Wasmer)**
   - *Pros*: Instant instantiation, memory safety.
   - *Cons*: Tool authoring ecosystem in TypeScript/JavaScript becomes complex; difficult debugging; bridging complex asynchronous I/O and subprocess calls requires complex ABI bindings.

4. **Option 4: Supervised Node Daemon with Pinned Deno Worker Subprocesses (Selected)**
   - *Pros*: Native TypeScript support without transpilation step; built-in granular security permissions (`--allow-read`, `--allow-net`, etc.); sub-35ms cold starts; hard memory limits; crash isolation; hermetic pinned binary version.
   - *Cons*: Requires bundling/managing a pinned Deno binary alongside the daemon.

## Decision

We decide to implement a **Two-Tier Local Process Architecture**:

1. **Supervised User-Level Daemon (Control Plane)**:
   - Implemented in TypeScript running on Node.js (>=22 LTS).
   - Runs as a persistent background service managed by a user-level process supervisor (launchd on macOS, systemd user service on Linux/WSL, or a built-in supervisor fallback).
   - Responsible for MCP protocol handling (Local Gateway), transcript observation (Observer), metadata and metrics storage (Local SQLite), cloud synchronization (Sync Manager), and audit logging (Audit Logger).
   - **Never executes tool payload code directly**.

2. **Isolated Tool Worker Sandboxes (Execution Plane)**:
   - Tool invocations are dispatched to isolated, pinned **Deno worker sub-processes**.
   - The Deno runtime binary is version-pinned and managed by the Resin toolchain, guaranteeing identical behavior across platforms.
   - Deno workers are launched with strict default sandbox flags (`--no-prompt`, `--deny-all` by default), granting explicit capabilities dynamically via the Capability Broker.
   - Each worker runs under a hard memory limit (30MB default heap limit) and hard execution timeout (default 30s configurable per tool spec).
   - Workers are pooled for warm execution (reducing overhead to <5ms) and recycled immediately upon failure, timeout, or suspect behavior.

```
+---------------------------------------------------------------+
| Local Daemon (Node.js LTS - Control Plane)                   |
|                                                               |
|  +---------------------+   +--------------------------------+ |
|  |  Local MCP Gateway  |   | Observer & Audit Logger        | |
|  +----------+----------+   +---------------+----------------+ |
|             |                              |                  |
|             v                              v                  |
|  +---------------------+   +--------------------------------+ |
|  |  Capability Broker  |   | Local SQLite (WAL Mode)        | |
|  +----------+----------+   +--------------------------------+ |
|             | (IPC via stdin/stdout / Unix Domain Socket)     |
+-------------+-------------------------------------------------+
              |
              v (Process Boundary)
+---------------------------------------------------------------+
| Deno Worker Sandbox Pool (Execution Plane)                    |
|                                                               |
|  +-----------------------+       +--------------------------+ |
|  | Deno Worker 1 (Active)|       | Deno Worker 2 (Warm Pool)| |
|  | - Sandboxed Memory    |       | - Pinned Deno Binary     | |
|  | - Brokered I/O        |       | - Restrictive Perms      | |
|  | - Hard Timeout (30s)  |       | - Ready for Dispatch     | |
|  +-----------------------+       +--------------------------+ |
+---------------------------------------------------------------+
```

## Consequences

### Positive
- A bug or crash in a tool never brings down the gateway or disconnects developer harnesses.
- Native TypeScript execution in Deno eliminates separate build/transpilation steps for generated candidates.
- Granular capability enforcement at the OS process level via Deno security flags.
- Deterministic, hermetic runtime environment across all supported operating systems.

### Negative / Trade-offs
- Managing a worker pool introduces minor IPC serialization/deserialization overhead (~1–3ms).
- Distributing or downloading a pinned Deno binary increases initial installation size (~40MB).

### Mitigations
- Use compact binary IPC protocols (JSON-RPC over pipes or shared memory buffers) to minimize serialization latency.
- Automate pinned Deno binary verification and fetching during first-time CLI/daemon setup.

## Compliance and Verification

- Unit tests in `@resin/runtime` verify that worker crashes (`process.exit(1)`, syntax errors, infinite loops) are caught and reported as tool execution errors without affecting the gateway daemon.
- Benchmark tests enforce worker cold start time <35ms and warm invocation overhead <5ms.
- Sandbox security tests verify that unbrokered filesystem, network, and subprocess access attempts are rejected by Deno.
