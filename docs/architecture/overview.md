# Resin Architecture Overview

## Executive Summary

**Resin** is an autonomous, privacy-preserving infrastructure system that observes AI coding agent workflows, detects performance bottlenecks and repetitive tool patterns, and autonomously synthesizes, verifies, sandboxes, and deploys optimized Model Context Protocol (MCP) tools directly to developer workstations.

The architecture is divided into two primary tiers:
1. **Local Workstation Tier**: A lightweight, user-level background daemon providing a unified Local MCP Gateway, real-time Observer, sandboxed Deno execution workers, embedded SQLite storage, and a pre-authorized Capability Envelope.
2. **Cloud Evolution Tier**: A scalable backend providing multi-tenant tool registry cataloging, asynchronous synthesis pipelines, test generation, and anonymized collective telemetry aggregation. Cloud never executes tools against developer repositories.

## System Topology & Architecture Diagram

```mermaid
flowchart TB
    subgraph LocalStation["Developer Workstation (Local Host)"]
        subgraph Harnesses["AI Coding Harnesses"]
            ClaudeCode["Claude Code"]
            CodexCLI["Codex CLI"]
            OMP["Oh My Pi (OMP)"]
        end

        subgraph LocalDaemon["Supervised Local Daemon (Node.js LTS)"]
            LocalGateway["Local MCP Gateway\n(@resin/gateway)"]
            Observer["Observer & Sanitizer\n(@resin/observer)"]
            CapBroker["Capability Broker\n(FS / Net / Cmd)"]
            SyncMgr["Cloud Sync Manager\n(@resin/crypto)"]
            LocalDB[("Local SQLite DB\nWAL Mode")]
            TrustStore[("OS Identity Data Store\n0700/0600 Perms")]
        end

        subgraph ProjectDir["Project Directory (Repository Root)"]
            ProjectMeta[".resin/project.json\n(Portable Project UUID)"]
            ProjectLock[".resin/resin.lock\n(Exact Tool Digests)"]
        end

        subgraph Sandbox["Execution Plane"]
            DenoWorker1["Deno Sandbox Worker 1\n(Active Tool Execution)"]
            DenoWorker2["Deno Sandbox Worker 2\n(Warm Worker Pool)"]
        end
    end

    subgraph CloudPlane["Cloud Evolution Plane"]
        CloudAPI["Cloud API Gateway\n(mTLS / Auth)"]
        TelemetryIngest["Telemetry & Analytics\nPipeline"]
        EvolEngine["Evolution Engine\n(Synthesis & Optimization)"]
        CloudDB[("PostgreSQL\nRelational Metadata")]
        BlobStore[("S3 Object Store\nTool Bundles & Fixtures")]
        TaskQueue["Task Bus / Queue\n(BullMQ / Redis)"]
    end

    %% Local Connections
    ClaudeCode -->|Local MCP stdio/socket| LocalGateway
    CodexCLI -->|Local MCP stdio/socket| LocalGateway
    OMP -->|Local MCP stdio/socket| LocalGateway

    LocalGateway --> Observer
    LocalGateway --> CapBroker
    LocalGateway <--> LocalDB
    LocalGateway <--> TrustStore
    LocalGateway <--> ProjectMeta
    LocalGateway <--> ProjectLock
    Observer --> LocalDB
    SyncMgr <--> LocalDB
    SyncMgr <--> TrustStore

    CapBroker -->|Sandboxed IPC| DenoWorker1
    CapBroker -->|Pre-warmed| DenoWorker2

    %% Local to Cloud Connections (Sanitized Only)
    SyncMgr -->|Encrypted HTTPS / Sanitized Data| CloudAPI
    LocalGateway -.->|Proxy Remote Tools| CloudAPI

    %% Cloud Internal Connections
    CloudAPI --> TelemetryIngest
    CloudAPI --> EvolEngine
    TelemetryIngest --> TaskQueue
    TaskQueue --> EvolEngine
    EvolEngine <--> CloudDB
    EvolEngine <--> BlobStore
    TelemetryIngest <--> CloudDB
```

## Project Runtime & Metadata Model

Resin implements a deterministic, zero-prompt bootstrap and exact tool-sync contract across projects:

### 1. Root Resolution and Automatic Bootstrap
When starting MCP or resolving tools, Resin automatically identifies the project root:
- **Git Root Resolution**: If running within a Git repository, the root is the top-level Git working tree.
- **Non-Git Fallback**: If not within a Git repository, the root is the MCP startup directory.
- **Synchronous Zero-Prompt Bootstrap**: If `.resin/project.json` or `.resin/resin.lock` is missing, Resin automatically creates them synchronously during resolver initialization. No user prompts, confirmations, or interactive setup are required.

### 2. Committed Portable Files vs. Local Trust
- **`.resin/project.json`**: Contains portable project metadata (`schemaVersion: 1`, project UUID `id`, `name`, and timestamp). It declares identity, not execution authority.
- **`.resin/resin.lock`**: Contains locked tool versions and SHA-256 content digests. It ensures exact byte-for-byte reproducibility across checkouts.
- **Non-Authorizing Invariant**: Committed files in `.resin/` **cannot authorize execution**. Local execution is authorized solely by the user's local trust store.
- **OS-Standard Identity Partitioning**: Authorization certificates, tokens, and trust stores reside outside the project tree in OS-standard data directories (e.g. `XDG_DATA_HOME` / `~/.local/share` on Linux, `~/Library/Application Support` on macOS, `%LOCALAPPDATA%` on Windows) partitioned strictly by `<account_id>/<user_id>/<project_id>` with POSIX `0700`/`0600` permissions.

### 3. Move, Rename, Fork, and Template Lifecycles
- **Same-Account Move / Rename**: Moving or renaming a directory retains the project UUID in `.resin/project.json`. Local daemon and Cloud recognize the UUID idempotently.
- **Cross-Account Clones / Public Forks / Template Repositories**: When a project is cloned by a different user/organization, the project UUID is recognized as owned by another identity. Cloud returns a non-enumerating `fork_required` response (preserving project privacy without leaking owner details). This triggers an explicit fork/import outcome where a newly initialized project identity and UUID are established under the caller's account, preventing cross-account authorization hijacking.
- **Offline Bootstrap & Later Registration**: An offline project operates immediately with `outcome: "local_only"`. When online connectivity and an authenticated session are established, the project registers idempotently with Cloud without modifying locked tool definitions.

### 4. Deletion, Invalidation, and Recovery
- **Deleting `.resin/project.json`**: Resets and breaks the stable project identity and its link to local trust records unless explicitly recovered from Cloud or git history; it is not a routine safe repair operation.
- **Deleting `.resin/resin.lock`**: Destroys the exact locked tool selections and cryptographic digests; execution cannot proceed with silent empty locks or substituted versions and requires explicit lock recovery or re-qualification.
- **Deleting Local Trust State or Cache**: Disables offline execution and invalidates local authorization, requiring online re-authentication, fresh signature verification, and re-downloading authorized tool packages.
- **Data Residency & Execution Invariant**: Raw session transcripts and source code remain strictly local. Cloud never executes tools against developer repositories.

## Core Local Components

### 1. Local MCP Gateway (`@resin/gateway`)
The Local MCP Gateway is the single point of contact for all AI coding harnesses on the developer's machine ([ADR 0001](../adr/0001-v1-topology.md)). It:
- Exposes standard Model Context Protocol (MCP) endpoints via stdio, Unix domain sockets, and localhost HTTP/SSE.
- Dynamically routes tool invocations to local sandboxed workers or proxies to cloud-hosted tools.
- Maintains in-memory routing tables for instant, sub-100ms canaries and rollbacks.
- Adds less than 2ms ($p50$) routing latency overhead ([ADR 0009](../adr/0009-nfr-and-performance-targets.md)).

### 2. Observer & Sanitizer (`@resin/observer`)
The Observer passively monitors tool executions, transcript interactions, and performance metrics:
- Records raw execution traces into local SQLite ([ADR 0005](../adr/0005-privacy-data-boundaries.md)). Raw session transcripts remain strictly local.
- Runs a multi-stage local redaction pipeline to scrub credentials, private paths, and PII.
- Generates sanitized observation summaries for the evolution engine.

### 3. Capability Broker (`@resin/runtime`)
The Capability Broker enforces the pre-authorized **Capability Envelope** ([ADR 0007](../adr/0007-capability-envelope-and-security.md)):
- Mediates all filesystem, network, and subprocess access from tool workers.
- Restricts filesystem access to authorized workspace roots and prevents access to sensitive files (`.git`, `.env`).
- Restricts network calls to whitelisted domains and blocks unauthorized shell spawns.

### 4. Deno Execution Sandbox (`@resin/runtime`)
Executes tool code in hermetically isolated, pinned Deno worker subprocesses ([ADR 0002](../adr/0002-daemon-and-worker-isolation.md)):
- Enforces hard memory limits (30MB per worker) and execution timeouts (30s).
- Isolates faults so a crashing or hung tool never terminates the gateway.
- Leverages a pre-warmed worker pool for sub-5ms warm invocation execution.

### 5. Local Storage & Trust (`@resin/db` & `@resin/crypto`)
Embedded SQLite with Write-Ahead Logging (WAL mode) and OS-standard identity-partitioned trust stores ([ADR 0006](../adr/0006-storage-and-runtimes.md)):
- Manages workspace scopes, tool registry metadata, candidate lifecycle states, cryptographic audit logs, and runtime activation certificates.

## Core Cloud Components

### 1. Cloud API Gateway & Ingestion
- Authenticates local daemon sync sessions via mTLS or bearer tokens.
- Ingests sanitized observation batches and enqueues them for pattern analysis.

### 2. Evolution Engine & Task Queue
- Asynchronously processes aggregated telemetry to detect optimization opportunities (e.g., repetitive tool chains, slow query patterns).
- Synthesizes candidate MCP tools and workflows using specialized code models.
- Generates property-based contract test suites and publishes immutable tool bundles to S3.

### 3. Cloud Storage & Catalog
- **Amazon DynamoDB**: Single-table datastore with continuous PITR for relational metadata, multi-tenant accounts, global catalogs, and outbox streams.
- **Amazon S3**: Immutable, versioned object storage for cryptographically signed tool bundles and verification fixtures.

## Key Architectural Principles

1. **Local-First & Offline-Capable**: All local tools execute and function with 100% reliability even when completely disconnected from the internet.
2. **Zero-Prompt Autonomy within Envelope**: Tools bootstrap, lock, qualify, and execute autonomously without prompting the developer, provided they stay within the pre-authorized security envelope.
3. **Strict Data Residency**: Proprietary source code, raw session transcripts, and unredacted conversation turns never leave the local machine. Cloud never executes tools against developer repositories.
4. **Hermetic & Deterministic**: Pinned runtime binaries, exact version/digest locks, and comprehensive contract tests ensure identical behavior across Linux, macOS, and WSL2 ([ADR 0003](../adr/0003-supported-harnesses-and-platforms.md)).

## Architecture References
- [System Boundaries and Process Model](boundaries.md)
- [Canonical Architectural Glossary](glossary.md)
- [Non-Functional Requirements (NFR) Matrix](nfr.md)
- [ADR 0001: V1 Topology](../adr/0001-v1-topology.md)
- [ADR 0002: Daemon Architecture & Sandboxing](../adr/0002-daemon-and-worker-isolation.md)
- [ADR 0003: Supported Harnesses & Platforms](../adr/0003-supported-harnesses-and-platforms.md)
- [ADR 0005: Privacy & Data Residency](../adr/0005-privacy-data-boundaries.md)
- [ADR 0006: Storage Systems and Runtime Technology Stack](../adr/0006-storage-and-runtimes.md)
- [ADR 0007: Capability Envelope & Security](../adr/0007-capability-envelope-and-security.md)
- [ADR 0009: Non-Functional Requirements](../adr/0009-nfr-and-performance-targets.md)
- [ADR 0010: ADR Governance](../adr/0010-adr-governance.md)
