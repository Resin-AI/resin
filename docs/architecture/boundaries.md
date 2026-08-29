# Trust Boundaries, Process Model, and Network Architecture

## Overview

This document specifies the trust boundaries, process isolation model, inter-process communication (IPC) mechanisms, and network security boundaries across the Resin V1 architecture.

## 1. Trust Boundaries

Resin defines five distinct, non-overlapping trust zones:

```
+-----------------------------------------------------------------------------------------+
| Zone 1: External Client Zone (AI Coding Harnesses: Claude Code, Codex CLI, OMP)         |
| - Communicates over standard MCP (JSON-RPC 2.0)                                         |
+--------------------------------------------+--------------------------------------------+
                                             | [Trust Boundary A: MCP Protocol Boundary]
                                             v
+-----------------------------------------------------------------------------------------+
| Zone 2: Local Control Plane (Supervised Node.js Daemon)                                 |
| - High trust: Manages SQLite, configuration, routing, and capability tokens             |
+--------------------------------------------+--------------------------------------------+
                                             | [Trust Boundary B: Sandbox Process Boundary]
                                             v
+-----------------------------------------------------------------------------------------+
| Zone 3: Local Execution Plane (Deno Worker Subprocess Pool)                             |
| - Low trust / Untrusted: Runs generated tool code and candidate versions                |
| - Zero ambient OS permissions; all I/O mediated via Capability Broker                   |
+--------------------------------------------+--------------------------------------------+
                                             | [Trust Boundary C: Capability Envelope]
                                             v
+-----------------------------------------------------------------------------------------+
| Zone 4: Host Operating System Resources (Filesystem, Network Interfaces, Subprocesses)  |
| - Protected by strict allow/deny path and endpoint policies                             |
+--------------------------------------------+--------------------------------------------+
                                             | [Trust Boundary D: Cloud Network Boundary]
                                             v
+-----------------------------------------------------------------------------------------+
| Zone 5: Cloud Evolution Plane (PostgreSQL, S3, Evolution Engine, Task Queue)            |
| - Multi-tenant cloud environment; receives sanitized/redacted observations only         |
+-----------------------------------------------------------------------------------------+
```

### Trust Boundary Details

1. **Boundary A (MCP Protocol Boundary)**:
   - Separates external client harnesses from the internal control plane.
   - Enforces JSON-RPC 2.0 schema validation, message size limits (default: 10MB), and request timeouts.
   - Prevents malformed harness requests from corrupting daemon state.

2. **Boundary B (Sandbox Process Boundary)**:
   - Separates the trusted Node.js daemon from the untrusted Deno execution workers.
   - Enforces OS-level process separation; memory spaces are completely disjoint.
   - A crash, memory leak, or infinite loop in a tool worker cannot compromise the daemon ([ADR 0002](../adr/0002-daemon-and-worker-isolation.md)).

3. **Boundary C (Capability Broker Boundary)**:
   - Separates Deno workers from direct host OS resources.
   - Enforces the workspace's pre-authorized **Capability Envelope** ([ADR 0007](../adr/0007-capability-envelope-and-security.md)).
   - Filesystem reads/writes, network sockets, and command execution must pass broker validation.

4. **Boundary D (Cloud Network Boundary)**:
   - Separates the private developer workstation from the multi-tenant cloud evolution plane.
   - All outbound traffic is strictly sanitized locally to strip secrets, raw code, and PII ([ADR 0005](../adr/0005-privacy-data-boundaries.md)).
   - Cloud plane has zero inbound access to developer workstations (all connections are client-initiated outbound HTTPS/mTLS).

## 2. Process Model

```
+---------------------------------------------------------------+
| OS Process Supervisor (launchd / systemd user / supervisor)   |
|   |                                                           |
|   +---> Spawns & Monitors                                     |
|         |                                                     |
|         v                                                     |
|  +----------------------------------------------------------+ |
|  | PID 10240: Resin Daemon (Node.js LTS)             | |
|  |  - Gateway Server (MCP transports)                       | |
|  |  - Observer Pipeline & Sanitizer                         | |
|  |  - Embedded SQLite Engine (WAL Mode)                     | |
|  |  - Worker Pool Manager & Capability Broker               | |
|  +---+--------------------+-----------------------------+---+ |
|      |                    |                             |     |
|      v (fork/spawn)       v (fork/spawn)                v     |
|  +----------------+  +----------------+  +----------------+   |
|  | PID 10251:     |  | PID 10252:     |  | PID 10253:     |   |
|  | Deno Worker 1  |  | Deno Worker 2  |  | Deno Worker 3  |   |
|  | (Active Tool)  |  | (Warm Pool)    |  | (Warm Pool)    |   |
|  +----------------+  +----------------+  +----------------+   |
+---------------------------------------------------------------+
```

### 1. Supervisor Layer
- Runs at user privilege level (non-root).
- Uses native OS service managers (`launchd` on macOS, `systemd --user` on Linux/WSL2).
- Automatically restarts the daemon process within 500ms on unexpected exit ([ADR 0009](../adr/0009-nfr-and-performance-targets.md)).

### 2. Daemon Process (Node.js LTS)
- Single instance per user session.
- Low resource footprint: idle RSS < 65MB, peak memory < 150MB.
- Maintains SQLite connection pool in Write-Ahead Logging (WAL) mode.
- Manages the lifecycle of Deno worker child processes.

### 3. Deno Worker Subprocess Pool
- Launched with pinned Deno binary with `--no-prompt --deny-all` flags.
- Worker pool maintains 1–2 pre-warmed idle workers to eliminate cold-start overhead (<5ms warm execution).
- Worker recycle policy:
  - Recycled immediately after any execution failure, unhandled promise rejection, or timeout.
  - Recycled after handling 100 successful invocations (preventing latent memory drift).
  - Hard memory cap of 30MB enforced via V8 heap limit.

## 3. IPC & Transports

| Channel | Transport Mechanism | Protocol | Direction | Security Controls |
| :--- | :--- | :--- | :--- | :--- |
| **Harness <-> Gateway** | `stdio` (pipes) or Unix Domain Socket (`~/.resin/gateway.sock`) | Model Context Protocol (MCP / JSON-RPC 2.0) | Bidirectional | Socket permissions (`0600`), message size validation |
| **Gateway <-> Deno Worker** | Dedicated anonymous OS pipes (`stdin`/`stdout`/`fd 3`) | Internal JSON-RPC / Binary Framing | Bidirectional | Isolated descriptors, memory bounds, timeout timers |
| **Worker <-> Capability Broker** | Controlled IPC over dedicated IPC channel | Typed Capability Request / Response | Bidirectional | Token verification, path canonicalization, domain whitelist |
| **Daemon <-> Local SQLite** | In-process native C bindings | SQLite WAL Engine | Bidirectional | `synchronous=NORMAL`, busy timeout (5000ms), file mode `0600` |

## 4. Network Boundaries

### 1. Inbound Network Traffic
- **Local Workstation**: The Local Gateway binds only to loopback (`127.0.0.1`) or Unix domain sockets. It never binds to `0.0.0.0` or public network interfaces.
- **Cloud Plane**: Cloud API Gateways expose TLS 1.3 endpoints with mandatory authentication (mTLS or cryptographic bearer tokens).

### 2. Outbound Local-to-Cloud Synchronization
- All communication is initiated outbound from the local daemon to the cloud API over HTTPS (port 443).
- Payloads are restricted exclusively to sanitized observation summaries, aggregate latency metrics, and candidate verification receipts ([ADR 0005](../adr/0005-privacy-data-boundaries.md)).
- Raw code and full transcripts are blocked at the serialization layer unless explicit opt-in flags are enabled.

### 3. Tool Execution Outbound Network Access
- Tools executing in Deno workers have zero ambient network access.
- Network requests must route through the `NetBroker`, which enforces:
  - Whitelisted destination domains (e.g., `api.github.com`).
  - Blocked loopback / private IP ranges (127.0.0.0/8, 10.0.0.0/8, 192.168.0.0/16) to prevent Server-Side Request Forgery (SSRF).
  - Protocol restrictions (HTTPS only; raw TCP/UDP disallowed).


## 5. Cross-Boundary Protocol Architecture & Invariants

All data structures crossing the boundary between open local components and the private cloud evolution plane adhere to strict machine-enforced invariants implemented in `@resin/protocol`.

### 1. Explicit Schema Versioning & SemVer Compatibility Policy
- **Protocol Major Version**: The current Resin V1 protocol is SemVer 2.0.0 compliant, supporting major version 1 (`1.x.x`, baseline: `1.0.0`).
- **Explicit Version Requirement**: Wire parsers strictly require explicit schema versions on incoming wire messages. Missing versions are rejected immediately with `ValidationError` rather than silently defaulted.
- **Forward Compatibility**: Minor and patch increments within major version 1 (e.g. `1.1.0`, `1.2.3`) are forward-compatible and accepted across the boundary.
- **Fail-Closed Version Gate**: Incompatible future major versions (e.g. `2.0.0`) fail closed with `UpgradeRequiredError` (HTTP 426). Outdated, downgraded, or malformed version strings (e.g. `0.9.0`, `"invalid"`) are rejected with `ValidationError` or `UpgradeRequiredError`.

### 2. Explicit Unknown-Field Policy
- **Strict Boundary Envelope Validation (`.strict()`)**: Protocol message envelopes (`ProtocolMessageEnvelopeSchema`) and trace context structures enforce strict schema validation.
- **Additive Cross-Boundary Enforcement**: Strict unknown-field rejection and private-field rejection are enforced at the cross-boundary envelope and parser layer (`validateProtocolEnvelope`, `strictParse`) rather than rewriting domain payload schemas. Pre-existing auth, http, jobs, and stream payload schemas maintain exact backward/forward field compatibility.
- **Rejection of Unknown Envelope Properties**: Any unrecognized top-level property on protocol message envelopes triggers an immediate validation failure. This prevents parameter pollution, shadow fields, and accidental leakage of private cloud fields to public clients.
- **Extensibility Rules**: Open attribute dictionaries are permitted where explicitly modeled as typed records (`z.record(...)`), such as telemetry tags, trace context baggage, and structured error details.

### 3. Prohibition of Raw Private Implementation Objects
- **Wire Filter (`assertNoPrivateImplementationObjects`)**: Public protocol serialization boundaries strictly forbid raw cloud-internal data representations, including:
  - AWS DynamoDB raw typed attribute structures (e.g., `{ S: "...", N: "..." }`).
  - AWS SQS message receipts, envelope handles, and internal transport metadata.
  - Cloud-internal evolution candidate representations (`_cloudInternal`, `_rawEvolutionCandidate`, `_privateKey`).
  - Prototype pollution attempts (`__proto__`, `constructor` overrides).
- **Client Usability**: Public clients validate and consume all protocol contracts using only `@resin/contracts` and `@resin/protocol`, without requiring any private cloud packages or internal source code.

### 4. Canonical Enveloping & Cryptographic Integrity
- **Envelope Format (`ProtocolMessageEnvelope`)**: Wraps all asynchronous and streaming messages with metadata including `version`, `messageId`, `deviceId`, `installationId`, `workspaceId`, `sequence`, `createdAt`, `payloadType`, and `payloadDigest`.
- **Canonical Digest Verification**: Payloads are hashed using canonical JSON serialization (`hashCanonicalContent`) and verified against `payloadDigest` with SHA-256 digest validation.
- **Replay and Expiration Protection**: Clock-skew tolerance (5 minutes default) and expiration timestamps (`expiresAt`) are enforced on every message envelope.
## Architecture References

- [System Overview](overview.md)
- [Canonical Architectural Glossary](glossary.md)
- [Non-Functional Requirements (NFR) Matrix](nfr.md)
- [ADR 0001: V1 Topology](../adr/0001-v1-topology.md)
- [ADR 0002: Daemon Architecture & Sandboxing](../adr/0002-daemon-and-worker-isolation.md)
- [ADR 0005: Privacy & Data Residency](../adr/0005-privacy-data-boundaries.md)
- [ADR 0007: Capability Envelope & Security](../adr/0007-capability-envelope-and-security.md)
