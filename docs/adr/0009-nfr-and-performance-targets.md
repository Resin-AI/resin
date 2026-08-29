# ADR 0009: Non-Functional Requirements and Performance Targets

- **Status**: accepted
- **Date**: 2026-08-17
- **Deciders**: Resin Core Architecture Team
- **Consulted**: Performance Engineering, SRE, QA

## Context and Problem Statement

For AI coding agents to maintain fluid, interactive multi-turn conversations, tool invocations must be nearly instantaneous. If the local MCP gateway or tool execution sandbox adds noticeable latency, developer productivity drops and agent execution times balloon. Furthermore, a background daemon must be an unobtrusive neighbor on the developer's machine, consuming minimal memory and CPU cycles while remaining resilient to unexpected crashes.

We must define explicit, measurable, non-negotiable numeric performance and operational targets for V1.

## Decision Drivers

- **Real-Time Responsiveness**: Prevent tool execution overhead from degrading agent token generation flow.
- **Resource Modesty**: Keep developer machine footprint negligible to run comfortably alongside heavy IDEs and builds.
- **High Availability & Durability**: Fast crash recovery with zero data loss.
- **Measurable Accountability**: Establish concrete benchmark budgets verified in CI.

## Considered Options

1. **Option 1: Qualitative Performance Guidelines (e.g., "fast", "lightweight")**
   - *Pros*: Easy to agree upon initially.
   - *Cons*: Unenforceable in CI; performance degrades silently over time.

2. **Option 2: Explicit Numeric SLO Targets with Automated Benchmark Enforcement (Selected)**
   - *Pros*: Clear engineering contracts; regression tests in CI; unambiguous acceptance criteria.
   - *Cons*: Requires building and maintaining micro-benchmarks and load test suites.

## Decision

We decide on the following explicit numeric targets for the Resin V1 system:

### 1. Performance & Latency Matrix

| Metric Category | Target Value | Verification Method |
| :--- | :--- | :--- |
| **Local Gateway Cold Startup** | $< 250\text{ ms}$ | Benchmark test measuring time from process spawn to MCP listening state |
| **Local Gateway Warm Restart** | $< 50\text{ ms}$ | Benchmark measuring supervisor reload time |
| **Gateway Routing Overhead ($p50$)** | $< 2\text{ ms}$ | Micro-benchmark measuring gateway proxy overhead excluding tool logic |
| **Gateway Routing Overhead ($p95$)** | $< 5\text{ ms}$ | High-concurrency load benchmark (50 concurrent invocations) |
| **Gateway Routing Overhead ($p99$)** | $< 15\text{ ms}$ | High-concurrency load benchmark |
| **Deno Worker Cold Start** | $< 35\text{ ms}$ | Benchmark measuring worker spawn and capability handshake |
| **Deno Worker Warm Overhead** | $< 5\text{ ms}$ | Benchmark measuring IPC round-trip to pre-warmed worker |
| **Canary Rollback Latency** | $< 100\text{ ms}$ | End-to-end integration test from failure trigger to fallback routing |

### 2. Resource Utilization Matrix

| Metric Category | Target Value | Verification Method |
| :--- | :--- | :--- |
| **Daemon Idle Memory (RSS)** | $< 65\text{ MB}$ | Measured after 5 minutes of idle state in clean environment |
| **Daemon Peak Memory Under Load** | $< 150\text{ MB}$ | Measured during continuous 100 req/s tool invocation burst |
| **Deno Worker Sandbox Memory** | $< 30\text{ MB}$ per active worker | Hard heap limit enforced via `--max-old-space-size=30` |
| **Daemon Idle CPU Usage** | $< 0.5\%$ CPU | Monitored across 60s idle window |
| **Local SQLite Disk Footprint** | $< 50\text{ MB}$ baseline | Database sizing test with 10,000 recorded observations |

### 3. Reliability & Recovery Matrix

| Metric Category | Target Value | Verification Method |
| :--- | :--- | :--- |
| **Process Crash Recovery Time** | $< 500\text{ ms}$ | `SIGKILL` injected into daemon; measured until MCP reconnect |
| **State Loss on Abrupt Termination** | $0\text{ records}$ | SQLite WAL durability test with sudden process termination |
| **Offline Resilience** | $100\%$ local operations | Test suite run with network interface disabled |
| **Telemetry Sync Batch Interval** | $30\text{ s}$ jittered background | Measured background sync scheduler behavior |
| **Telemetry Compressed Batch Size** | $< 50\text{ KB}$ per sync | Network payload capture of 100-event observation batch |

```
+---------------------------------------------------------------+
| Performance Target Summary (V1 Architecture)                  |
|                                                               |
|   Gateway Latency Overhead:                                   |
|   [========== p50: <2ms ==========]                           |
|   [================= p95: <5ms =================]             |
|   [======================= p99: <15ms =======================] |
|                                                               |
|   Memory Footprint:                                           |
|   [Daemon Idle: <65MB] [Peak: <150MB] [Worker: <30MB]         |
|                                                               |
|   Reliability:                                                |
|   [Recovery: <500ms] [Rollback: <100ms] [State Loss: 0%]      |
+---------------------------------------------------------------+
```

## Consequences

### Positive
- Strict, enforceable performance baselines prevent regressions from entering the codebase.
- The developer experience remains lightning-fast with zero noticeable latency penalty for using evolved tools.
- Minimal resource consumption ensures Resin runs seamlessly on developer laptops.

### Negative / Trade-offs
- Requires ongoing maintenance of automated benchmark suites and performance regression tracking in CI.

### Mitigations
- Integrate performance regression checks into nightly CI jobs, alerting on >10% statistical regressions.

## Compliance and Verification

- The Vitest performance test suite executes micro-benchmarks against `@resin/gateway` and `@resin/runtime` to enforce these thresholds.
