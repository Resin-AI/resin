# Non-Functional Requirements (NFR) Matrix and Verification Framework

## Overview

This document specifies the complete Non-Functional Requirements (NFR) matrix for the Resin V1 architecture. It defines quantitative service level objectives (SLOs), resource budgets, security baselines, and their corresponding automated verification methodologies.

See [ADR 0009: Non-Functional Requirements and Performance Targets](../adr/0009-nfr-and-performance-targets.md) for architectural decision context.

---

## 1. Performance & Latency Requirements

| ID | Metric Name | Target SLA / Threshold | Conditions / Workload | Verification Method |
| :--- | :--- | :--- | :--- | :--- |
| **NFR-PERF-01** | Gateway Cold Startup | $< 250\text{ ms}$ | Time from daemon process execution to MCP port/socket listening | Cold process spawn benchmark |
| **NFR-PERF-02** | Gateway Warm Restart | $< 50\text{ ms}$ | In-process reload or supervisor hot restart | Warm restart benchmark |
| **NFR-PERF-03** | Gateway Routing Overhead ($p50$) | $< 2\text{ ms}$ | MCP message parsing + routing table lookup (excluding tool execution time) | Micro-benchmark with dummy no-op tool |
| **NFR-PERF-04** | Gateway Routing Overhead ($p95$) | $< 5\text{ ms}$ | 50 concurrent tool invocation requests | Concurrency load test |
| **NFR-PERF-05** | Gateway Routing Overhead ($p99$) | $< 15\text{ ms}$ | 100 concurrent tool invocation requests | Stress load test |
| **NFR-PERF-06** | Deno Worker Cold Start | $< 35\text{ ms}$ | Time to spawn new Deno worker process and complete IPC handshake | Worker initialization benchmark |
| **NFR-PERF-07** | Deno Worker Warm Overhead | $< 5\text{ ms}$ | IPC dispatch to pre-warmed worker | Pre-warmed pool benchmark |
| **NFR-PERF-08** | Canary Rollback Latency | $< 100\text{ ms}$ | Time from anomaly/error detection to in-memory routing pointer swap | Fault injection integration test |

---

## 2. Resource Utilization & Footprint Requirements

| ID | Metric Name | Target SLA / Threshold | Conditions / Workload | Verification Method |
| :--- | :--- | :--- | :--- | :--- |
| **NFR-RES-01** | Daemon Idle Memory (RSS) | $< 65\text{ MB}$ | Measured after 5 minutes of idle state with no active invocations | Process RSS monitor test |
| **NFR-RES-02** | Daemon Peak Memory | $< 150\text{ MB}$ | Continuous 100 req/s tool invocation burst for 60 seconds | Peak memory profiler test |
| **NFR-RES-03** | Worker Heap Ceiling | $< 30\text{ MB}$ per active worker | Hard V8 heap limit configured via `--max-old-space-size=30` | Worker memory constraint test |
| **NFR-RES-04** | Daemon Idle CPU | $< 0.5\%\text{ CPU}$ | Measured across 60 seconds of idle background monitoring | CPU sampler test |
| **NFR-RES-05** | SQLite Disk Baseline | $< 50\text{ MB}$ | Database storing 10,000 recorded observation events | Disk footprint test |
| **NFR-RES-06** | Disk Clean-Up / Pruning | Automatic purge | Retains records exceeding 30-day window or 250MB size cap | Vacuum & pruning test |

---

## 3. Reliability, Durability & Availability Requirements

| ID | Metric Name | Target SLA / Threshold | Conditions / Workload | Verification Method |
| :--- | :--- | :--- | :--- | :--- |
| **NFR-REL-01** | Crash Recovery Time | $< 500\text{ ms}$ | Time from `SIGKILL` injection to healthy supervisor restart | Chaos kill test |
| **NFR-REL-02** | State Durability on Crash | $0\text{ lost committed records}$ | Sudden power loss or process kill during database write | SQLite WAL durability test |
| **NFR-REL-03** | Offline Autonomy | $100\%\text{ local functionality}$ | Network interface disabled; local tools must execute normally | Air-gapped integration suite |
| **NFR-REL-04** | Telemetry Sync Interval | $30\text{ s}$ jittered background | Background synchronization daemon loop | Scheduler timing test |
| **NFR-REL-05** | Sync Payload Budget | $< 50\text{ KB}$ compressed | 100-event observation batch with gzip/brotli compression | Network transfer payload capture |

---

## 4. Security, Isolation & Privacy Requirements

| ID | Metric Name | Target SLA / Threshold | Conditions / Workload | Verification Method |
| :--- | :--- | :--- | :--- | :--- |
| **NFR-SEC-01** | Sandbox Hermeticity | $100\%\text{ unbrokered syscall rejection}$ | Direct `Deno.readTextFile`, `Deno.connect`, `Deno.Command` without broker | Security penetration test suite |
| **NFR-SEC-02** | Path Traversal Protection | $100\%\text{ path escape rejection}$ | Symlinks, `../` escapes targeting outside workspace root | Path resolution test |
| **NFR-SEC-03** | Sensitive Path Deny | $100\%\text{ denial}$ | Attempts to read `.git`, `.env`, `~/.ssh`, `~/.aws` | Deny-list compliance test |
| **NFR-SEC-04** | Secret Redaction Rate | $100\%\text{ secret scrubbing}$ | Synthetic test data containing API keys, private tokens, passwords | Redaction regex & entropy test |
| **NFR-SEC-05** | Raw Code Upload Default | $0\text{ bytes uploaded}$ | Default configuration must never transmit raw source files | Network capture boundary test |
| **NFR-SEC-06** | Audit Ledger Tamper Proof | Cryptographic verification | Merkle chain and HMAC-SHA256 validation | Audit ledger verification test |

---

## 5. Portability & Compatibility Requirements

| ID | Dimension | Requirement | Verification Method |
| :--- | :--- | :--- | :--- |
| **NFR-PORT-01** | Operating Systems | Linux (`x86_64`, `arm64`), macOS (`arm64`, `x86_64`), Windows WSL2 | Multi-OS CI matrix runners |
| **NFR-PORT-02** | AI Harnesses | Claude Code, Codex CLI, OMP | Harness adapter contract test suite |
| **NFR-PORT-03** | Runtime Compatibility | Node.js (>=22 LTS), Pinned Deno (2.x) | Environment runtime check |
| **NFR-PORT-04** | Dependency Boundary | Strict monorepo package isolation | `pnpm check:boundaries` in CI |

---

## 6. Verification Methodologies

To guarantee that every requirement in this matrix is defended continuously, the Resin repository implements six automated verification tiers:

```
+---------------------------------------------------------------+
| Automated Verification Pipeline                               |
|                                                               |
|  [Tier 1: Static Architecture & Boundary Verification]        |
|  - scripts/verify-adrs.mjs (ADR governance, links, glossary)  |
|  - scripts/check-boundaries.mjs (Monorepo imports & exports)  |
|                                                               |
|  [Tier 2: Unit & Contract Tests]                              |
|  - Vitest test suites in each package and app                 |
|                                                               |
|  [Tier 3: Micro-Benchmarks]                                   |
|  - Latency benchmarks (Gateway routing, worker dispatch)      |
|                                                               |
|  [Tier 4: Resource & Memory Profiling]                        |
|  - RSS monitoring, leak detection, heap bounds                |
|                                                               |
|  [Tier 5: Security & Sandbox Penetration Tests]               |
|  - Fuzzing, path escape, SSRF, secret scrubber verification   |
|                                                               |
|  [Tier 6: Chaos & Recovery Integration Tests]                 |
|  - Process kill injection, crash durability, offline mode     |
+---------------------------------------------------------------+
```

## References

- [ADR 0009: Non-Functional Requirements & Performance Targets](../adr/0009-nfr-and-performance-targets.md)
- [Architecture Overview](overview.md)
- [Trust Boundaries & Process Model](boundaries.md)
- [Canonical Architectural Glossary](glossary.md)
