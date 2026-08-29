# Cross-Component Compatibility Matrix (V1.0.0)

This document defines the naming, versioning, and compatibility matrix across all schemas, wire protocols, harness adapters, execution runtimes, and release artifacts for Resin `1.0.0`.

---

## 1. Naming & Version Policy

- **Product Identity**: The official product name is **Resin**.
- **Public CLI**: The CLI binary command is `resin` at `1.0.0`.
- **Internal Implementation Namespaces**: Internal workspace packages use the `@resin/*` naming scope (e.g. `@resin/contracts`, `@resin/protocol`).
- **Release Alignment**: All standalone release artifacts for a given release are produced from the same source commit SHA, share the same `1.0.0` version, and target the supported platform/runtime lanes.

---

## 2. Schema & Contract Versions

| Component / Package   | Package Name               | Version | Schema / Contract Spec     | Backward Compatibility  |
| --------------------- | -------------------------- | ------- | -------------------------- | ----------------------- |
| **Domain Contracts**  | `@resin/contracts`         | `1.0.0` | Domain Schema v1.0         | Compatible with v1.0.0+ |
| **Wire Protocol**     | `@resin/protocol`          | `1.0.0` | Protocol Spec v1.0         | Compatible with v1.0.0+ |
| **Harness Contracts** | `@resin/harness-contracts` | `1.0.0` | Harness SPI v1.0           | Compatible with v1.0.0+ |
| **Crypto & Vault**    | `@resin/crypto`            | `1.0.0` | Crypto Spec v1.0 (Ed25519) | Dual-key verification   |
| **Database Schema**   | `@resin/db`                | `1.0.0` | SQLite Schema v1 / PG 16   | Idempotent migrations   |
| **Runtime Engine**    | `@resin/runtime`           | `1.0.0` | Sandbox Spec v1.0          | Deno 2.x & Node 22+     |

---

## 3. AI Coding Harness Compatibility

| Harness Adapter     | Adapter Package              | Supported Versions | Tested & Qualified Versions | Protocol Bridge        |
| ------------------- | ---------------------------- | ------------------ | --------------------------- | ---------------------- |
| **Claude Code CLI** | `@resin/adapter-claude-code` | `>= 0.1.0`         | `0.2.29`, `1.0.0`           | MCP over SSE / Stdio   |
| **Codex CLI**       | `@resin/adapter-codex`       | `>= 0.1.0`         | `0.1.0`, `0.2.0`            | MCP over SSE           |
| **Oh My Pi (OMP)**  | `@resin/adapter-omp`         | `>= 0.1.0`         | `0.1.0`, `0.2.0`            | MCP over SSE & Hub IPC |

---

## 4. Host Operating Systems & Node.js Matrix

| Platform                        | Node.js 22.x LTS | Node.js 24.x | Deno 2.x (Worker) | Support Level        |
| ------------------------------- | ---------------- | ------------ | ----------------- | -------------------- |
| **Linux x86_64**                | ✅ Supported     | ✅ Supported | ✅ Supported      | Tier 1 (CI Verified) |
| **Linux arm64**                 | ✅ Supported     | ✅ Supported | ✅ Supported      | Tier 1 (CI Verified) |
| **macOS arm64** (Apple Silicon) | ✅ Supported     | ✅ Supported | ✅ Supported      | Tier 1 (CI Verified) |
| **macOS x86_64** (Intel)        | ✅ Supported     | ✅ Supported | ✅ Supported      | Tier 1 (CI Verified) |
| **WSL2** (Ubuntu 22.04+)        | ✅ Supported     | ✅ Supported | ✅ Supported      | Tier 1 (CI Verified) |

---

## 5. MCP Protocol & Feature Compatibility

| MCP Feature                        | Implementation   | Supported in V1? | Notes                                 |
| ---------------------------------- | ---------------- | ---------------- | ------------------------------------- |
| `tools/list`                       | Dynamic Catalog  | ✅ Yes           | Invariant meta-tools + promoted tools |
| `tools/call`                       | Sandboxed Invoke | ✅ Yes           | Enforces capability envelope          |
| `resources/list`                   | Workspace State  | ✅ Yes           | Read-only workspace inspection        |
| `prompts/list`                     | Context Prompts  | ✅ Yes           | Evolution guidance prompts            |
| `notifications/tools/list_changed` | Real-time Push   | ✅ Yes           | Broadcast on tool promotion/rollback  |

---

## Related Documentation

- [Release Notes](v1.0.3-release-notes.md)
- [Release Evidence Trace](release-evidence.md)
- [Rollback Procedures](rollback-procedure.md)
- [Support Policy](../security/support-policy.md)
