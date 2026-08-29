# ADR 0001: V1 Topology - Single Local MCP Gateway and Cloud Proxy

- **Status**: accepted
- **Date**: 2026-08-17
- **Deciders**: Resin Core Architecture Team
- **Consulted**: Security, Developer Experience, Platform Engineering

## Context and Problem Statement

Modern AI coding agents and harnesses (such as Claude Code, Codex CLI, and Oh My Pi) interact with external tools using the Model Context Protocol (MCP). As tools evolve autonomously—generating specialized implementations, optimizing latency, and caching query sequences—the developer workstation requires an architecture that bridges local execution speed and data privacy with centralized, collective tool intelligence.

We need a V1 topology that:
1. Enables multiple developer harnesses to consume locally generated, project-specific, and team-shared tools without per-harness reconfiguration.
2. Maintains single-millisecond routing latency for local tool invocations.
3. Provides a clean boundary where local private data stays on the machine while non-sensitive tool schemas, telemetry, and candidate artifacts can be synthesized and synchronized with the cloud plane.
4. Avoids exposing every harness directly to cloud endpoints or managing multiple competing MCP server instances per workspace.

## Decision Drivers

- **Zero-Friction Harness Integration**: Harnesses must point to a single, stable local MCP endpoint rather than juggling dozens of disparate tool servers.
- **Latency & Reliability**: Local tool invocations must not depend on cloud network round-trips or internet availability.
- **Unified Observation & Mediation**: Tool telemetry, capability validation, and lifecycle transitions (canary, promotion, rollback) require a single mediation point.
- **Security & Sandboxing**: Untrusted or candidate tool executions must be mediated locally through a controlled gateway before accessing system resources.

## Considered Options

1. **Option 1: Direct Cloud MCP Endpoints (Harnesses connect directly to Cloud)**
   - *Pros*: Simple local footprint, zero local daemon management.
   - *Cons*: High invocation latency (100–300ms network round-trip), failure when offline, privacy violations by routing all tool arguments through the cloud, incompatible with local filesystem operations.

2. **Option 2: Multi-Server Local Sprawl (Each tool family or harness runs its own MCP server)**
   - *Pros*: Isolated server binaries.
   - *Cons*: Port exhaustion, configuration drift across harnesses, no centralized telemetry or observer, complex lifecycle management, high memory overhead.

3. **Option 3: Single Local MCP Gateway with Upstream Cloud Proxy (Selected)**
   - *Pros*: Single endpoint configuration per harness; sub-millisecond local routing; transparent proxying of remote/team tools; centralized observation, audit, and capability enforcement; works offline for all local tools.
   - *Cons*: Requires running a supervised local background daemon.

## Decision

We decide that the V1 architecture will be organized around a **Single Local MCP Gateway** per developer machine and user session:

1. **Single Entry Point**: All local AI harnesses (Claude Code, Codex CLI, OMP) configure a single local MCP connection (via stdio, local Unix domain socket, or localhost HTTP/SSE) pointing to the Local Gateway.
2. **Local Tool Execution**: The Local Gateway hosts and serves locally generated tools, project-scoped tools, and cached tool bundles directly on the workstation.
3. **Transparent Cloud Proxying**: When a harness requests a tool hosted in the cloud tool plane (e.g., global organizational tools or remote compute operations), the Local Gateway securely proxies the request upstream over an authenticated mTLS/HTTPS session, caching definitions and handling retries.
4. **No Direct Harness-to-Cloud Bypass**: Harnesses never connect directly to the cloud tool plane. All invocations, capabilities, and telemetry pass through the Local Gateway.

```
+-------------------------------------------------------------+
| Developer Workstation (Local Machine)                       |
|                                                             |
|  +-------------+  +-----------+  +-------------+            |
|  | Claude Code |  | Codex CLI |  |     OMP     |            |
|  +------+------+  +-----+-----+  +------+------+            |
|         |               |               |                   |
|         +---------------+---------------+                   |
|                         | (Local MCP Transport)             |
|                         v                                   |
|             +-----------------------+                       |
|             |   Local MCP Gateway   |                       |
|             | +-------------------+ |                       |
|             | | Capability Broker | |                       |
|             | +-------------------+ |                       |
|             +---+---------------+---+                       |
|                 |               |                           |
|       (Local)   |               | (Proxy Upstream)          |
|                 v               v                           |
|  +--------------------+   +-------------------------------+ |
|  | Local Deno Workers |   | Cloud Tool Plane & Registry   | |
|  | (Local Execution)  |   | (Authenticated HTTPS/mTLS)    | |
|  +--------------------+   +-------------------------------+ |
+-------------------------------------------------------------+
```

## Consequences

### Positive
- Harness configuration is trivial: one MCP server entry per harness.
- Local tool execution incurs minimal overhead (<2ms gateway routing latency).
- Full offline support: local tools remain fully operational without internet connectivity.
- A single point of enforcement for capability envelopes, rate limits, and audit logs.

### Negative / Trade-offs
- Requires a persistent local background daemon process (`resin` daemon).
- The Local Gateway is a single point of failure on the workstation; if the daemon crashes, harnesses lose tool access until the supervisor restarts it.

### Mitigations
- Implement a lightweight, zero-dependency process supervisor for the daemon that restarts within 500ms on unexpected exit.
- Provide a CLI fallback mode (`resin gateway --standalone`) for ad-hoc debugging.

## Compliance and Verification

- The boundary checker (`scripts/check-boundaries.mjs`) ensures harness adapters only depend on `@resin/protocol` and `@resin/contracts`.
- Gateway benchmarks verify local invocation overhead is below 5ms p95.
- Integration tests verify that remote tool calls route via the gateway proxy without direct cloud connections from adapters.
