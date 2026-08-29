# ADR 0006: Storage Systems and Runtime Technology Stack

- **Status**: accepted
- **Date**: 2026-08-17
- **Deciders**: Resin Core Architecture Team
- **Consulted**: Database Infrastructure, Backend Platform, Runtime Engineering

## Context and Problem Statement

Resin operates across two distinct environments: the developer's local workstation (which requires instant startup, zero external dependencies, low memory footprint, and bulletproof offline reliability) and the cloud evolution plane (which requires multi-tenant scalability, transactional integrity, blob storage for immutable tool bundles, and asynchronous queue processing).

Selecting the appropriate language runtimes, embedded databases, cloud datastores, and message queuing systems is critical for developer velocity, operational simplicity, and long-term maintainability.

## Decision Drivers

- **Zero Local Setup & Automatic Bootstrap**: Local developer machines must not require installing or managing external database servers. Starting MCP in any project root (Git root if present, otherwise startup directory) synchronously and automatically initializes `.resin/project.json` and `.resin/resin.lock` without prompting.
- **Crash Durability & Partition Isolation**: Local state must survive abrupt power losses, daemon panics, or OS reboots without data corruption. Trust stores and credentials must be isolated under OS-standard data directories partitioned by `<account_id>/<user_id>/<project_id>` with strict POSIX permissions (`0700`/`0600`).
- **Type Safety End-to-End**: A unified language ecosystem (TypeScript) across local daemon, adapters, contracts, and cloud control plane services.
- **Scalable Cloud Storage**: Cloud infrastructure must handle high-throughput telemetry ingestion, multi-tenant relational queries, immutable artifact hosting, and decoupled background worker queues. Cloud never executes tools against developer repositories.

## Considered Options

1. **Option 1: JSON Flat Files Locally + MongoDB in Cloud**
   - *Pros*: Schema flexibility.
   - *Cons*: High risk of file corruption on unexpected power loss locally; lack of ACID transactions; poor query performance on large observation histories.

2. **Option 2: Embedded RocksDB/LevelDB Locally + Cassandra in Cloud**
   - *Pros*: High write throughput.
   - *Cons*: Key-value only, lacks relational querying for complex tool lifecycle queries, complex C++ native bindings prone to build failures.

3. **Option 3: SQLite (WAL mode) Locally + Node.js/TypeScript Control Plane + Postgres/S3/Queue in Cloud + Pinned Deno Sandbox (Selected)**
   - *Pros*: Proven reliability of SQLite; WAL mode provides concurrent read/write performance; pure TypeScript codebase; PostgreSQL provides robust relational guarantees; S3 provides infinite immutable blob storage; Deno provides sandboxed tool execution.
   - *Cons*: Must manage schema migrations across both SQLite and PostgreSQL.

## Decision

We decide on the following storage and runtime technology stack for V1:

### 1. Control Plane & Runtimes

- **Local Daemon & Gateway**: TypeScript on **Node.js (>=22 LTS)**. Node.js provides mature ecosystem support for MCP stdio/HTTP transports, process supervision, and native filesystem operations.
- **Tool Sandbox Execution**: **Pinned Deno runtime** (managed and pinned to a specific version). Used strictly for executing isolated tool bundles with fine-grained sandbox permissions.
- **Cloud Backend Services**: TypeScript on **Node.js (>=22 LTS)** with fastify/express for HTTP/gRPC APIs.

### 2. Local Persistence: Embedded SQLite with WAL and OS-Standard Identity Stores

- **Engine**: SQLite via `@resin/db` (using native `better-sqlite3` or Node 22 built-in `node:sqlite`).
- **Configuration & PRAGMAs**:
  - `journal_mode = WAL` (Write-Ahead Logging for non-blocking concurrent reads during writes).
  - `synchronous = NORMAL` (optimal balance of crash durability and write latency).
  - `foreign_keys = ON` (referential integrity enforcement).
  - `busy_timeout = 5000` (handles transient file locks gracefully).
- **Local Data Model & Persistence Layout**:
  - `workspaces`: Registered workspace paths, configurations, and capability envelopes.
  - `tool_registry`: Local active tool specs, version tags, and activation statuses.
  - `tool_candidates`: Candidate versions under synthesis or canary evaluation.
  - `observations`: Local conversation traces and sanitized telemetry records. Raw session transcripts remain strictly local.
  - `audit_events`: Tamper-evident cryptographic audit logs.
  - **OS-Standard Identity Storage**: Trust stores, verified activation tokens, and cached credentials reside in OS-standard application data paths (e.g. `XDG_DATA_HOME` / `~/.local/share` on Linux, `~/Library/Application Support` on macOS, `%LOCALAPPDATA%` on Windows) under identity-partitioned subdirectories (`<account>/<user>/<project>`) with `0700` directory and `0600` file permissions.
  - **Project Directory Metadata (`.resin/`)**: `.resin/project.json` and `.resin/resin.lock` are committed, portable declarative files. They define project identity and exact tool version/digest requirements. They **cannot authorize tool execution**—authorization is resolved locally through the user's OS trust store.
  - **Deletion, Invalidation, and Recovery**:
    - Deleting `.resin/project.json` breaks stable project identity and severs the link to existing local trust records; restoring project continuity requires explicit recovery from Cloud or source control.
    - Deleting `.resin/resin.lock` loses exact locked tool selections and cryptographic digests; execution cannot proceed with silent empty locks or substituted versions and requires explicit lock recovery or re-qualification.
    - Deleting local trust stores or cached bundles disables offline execution and revokes local authorization, requiring online re-authentication, fresh signature verification, and redownload.

### 3. Cloud Persistence & Infrastructure

- **Relational Store (PostgreSQL >= 16)**: Multi-tenant metadata, user/team accounts, global tool catalogs, authorization policies, and aggregation metrics.
- **Object / Blob Storage (S3-Compatible)**: Immutable storage for tool bundle tarballs, compiled AST snapshots, candidate test fixtures, and benchmark datasets.
- **Asynchronous Task Queue (Redis / BullMQ / SQS)**: Decoupled background processing for tool synthesis jobs, LLM inference pipelines, multi-version benchmark matrices, and telemetry aggregation.
- **Execution Boundary**: Cloud hosts tool packages, catalogs, and synthesis pipelines, but **never executes tools against developer repositories or customer code**.

```
+---------------------------------------------------------------+
| Local Workstation Storage Architecture                        |
|                                                               |
|  +----------------------------------------------------------+ |
|  | Local Node.js Control Plane (@resin/db)           | |
|  +---------------------------+------------------------------+ |
|                              |                                |
|                              v (WAL Mode, synchronous=NORMAL) |
|  +----------------------------------------------------------+ |
|  | Embedded SQLite Database (State & Observation Traces)    | |
|  | - tool_registry       - observations (Local Only)        | |
|  | - tool_candidates     - audit_events                     | |
|  +----------------------------------------------------------+ |
|                              |                                |
|                              v (0700 / 0600 POSIX Perms)      |
|  +----------------------------------------------------------+ |
|  | OS Data Directory (<account_id>/<user_id>/<project_id>)  | |
|  | - RuntimeTrustStore   - Verified Activation Credentials  | |
|  +----------------------------------------------------------+ |
|                              |                                |
|                              v (Committed, Non-Authorizing)   |
|  +----------------------------------------------------------+ |
|  | Repository Directory (.resin/)                            | |
|  | - project.json (UUID) - resin.lock (Exact Digests)       | |
|  +----------------------------------------------------------+ |
+---------------------------------------------------------------+

+---------------------------------------------------------------+
| Cloud Infrastructure Storage Architecture                     |
|                                                               |
|  +---------------------+  +-----------------+  +------------+ |
|  | PostgreSQL (>=16)   |  | S3-Compatible   |  | Queue /    | |
|  | Relational Metadata |  | Immutable Tools |  | Task Bus   | |
|  | Multi-Tenant Tables |  | Tarball Bundles |  | BullMQ/SQS | |
|  +---------------------+  +-----------------+  +------------+ |
+---------------------------------------------------------------+
```

## Consequences

### Positive
- Zero external daemon dependencies on the developer's local machine; installation is self-contained.
- Embedded SQLite with WAL mode delivers microsecond query latencies for local tool resolution.
- Standardized TypeScript across the entire monorepo maximizes code reuse between `@resin/contracts`, `@resin/protocol`, local daemon, and cloud services.
- S3 + PostgreSQL in the cloud provides industry-standard scalability, backup, and disaster recovery.
- Strict separation between committed project metadata (`.resin/`), OS-standard identity storage, and cloud catalogs ensures zero credential leakage and prevents cross-account repository hijacking.

### Negative / Trade-offs
- Maintaining two database dialects (SQLite locally and PostgreSQL in cloud) requires careful ORM/migration abstraction.

### Mitigations
- Use shared schema definition patterns and strict contract validation packages (`@resin/contracts`) to prevent schema divergence.
- Automated CI integration tests run against both in-memory SQLite and PostgreSQL test instances.

## Compliance and Verification

- Monorepo package checks ensure `@resin/db` is the sole provider of local database access.
- SQLite migration tests verify schema upgrades and downgrades execute with zero data loss.
