# Security Policy & Trust Model

Resin compiles recurring coding-agent work into qualified tools that use less inference, lower inference cost, and complete matching work faster.

Security and privacy are fundamental load-bearing architectural constraints for Resin. This document outlines our vulnerability disclosure process, supported versions, local threat model, privacy data boundaries, supply chain integrity, and verification guarantees.

---

## Supported Versions & Security Gates

Only the latest active minor release line receives security updates and vulnerability patches.

| Version | Status | Security gate & Release Invariants |
| ------- | ------ | ---------------------------------- |
| `1.0.x` | Supported after public publication | CycloneDX 1.5 SBOM; Ed25519 signature verification; zero unapproved critical/high vulnerabilities; license policy compliance |
| Pre-1.0 | Unsupported | None |

Every published release artifact undergoes automated cryptographic signing and supply chain verification before distribution.

---

## Reporting a Vulnerability

If you discover a security vulnerability in Resin (daemon, observer, gateway, worker runtimes, CLI, or cloud contracts), please report it privately to our security team. **Do not create public GitHub issues for security vulnerabilities.**

### Private Reporting Channels

- **Email**: `security@resin.sh`
- **PGP Key Fingerprint**: `4A82 9D1E C5B7 2209 8E3F 9912 A3BC D4E5 F607 1829`
- **GitHub Private Vulnerability Reporting**: Submit via [GitHub Security Advisories](https://github.com/Resin-AI/resin/security/advisories/new)

### Report Contents

Please include as much detail as possible to enable rapid triage and remediation:
1. Detailed description of the vulnerability and potential security impact.
2. Affected components, packages, or version tags.
3. Step-by-step reproduction instructions or a minimal proof-of-concept (PoC).
4. Any proposed mitigations, patches, or workarounds.
5. Your contact information for coordination, validation, and attribution.

### Vulnerability Handling SLA & Response Timeline

1. **Initial Acknowledgment**: Within **48 hours** of report receipt.
2. **Triage & Assessment**: Within **5 business days**, the security team will reproduce the issue and determine CVSS v3.1 / v4.0 severity.
3. **Patch Development & Release Targets**:
   - **Critical (CVSS 9.0 – 10.0)**: Remediated within **14 calendar days**.
   - **High (CVSS 7.0 – 8.9)**: Remediated within **30 calendar days**.
   - **Medium (CVSS 4.0 – 6.9)**: Remediated within **60 calendar days**.
   - **Low (CVSS 0.1 – 3.9)**: Addressed in next scheduled minor/patch release.
4. **Coordinated Disclosure**: We adhere to coordinated vulnerability disclosure. We request a standard **90-day embargo period** from initial receipt to develop, test, and distribute fixes before public disclosure.

---

## Local Threat Model & Trust Boundaries

Resin is designed with a strict local-first architecture where the local developer machine remains the authoritative boundary of execution and data ownership.

### Architectural Trust Boundaries

```text
┌───────────────────────────────────────────────────────────────────────────┐
│                              HOST MACHINE                                 │
│                                                                           │
│  ┌─────────────────────────┐        Localhost IPC / Domain Sockets        │
│  │    AI Coding Harness    │ ───────────────────────────────────────────┐ │
│  │ (Claude / Codex / OMP)  │                                            │ │
│  └─────────────────────────┘                                            │ │
│               │ (tool calls)                                            ▼ │
│               ▼                                               ┌─────────┐ │
│  ┌─────────────────────────┐        Authenticated IPC         │ Observer│ │
│  │      Gateway Process    │ ───────────────────────────────► │ Process │ │
│  └─────────────────────────┘                                  └─────────┘ │
│               │                                                           │
│               ▼ (unprivileged fork)                                       │
│  ┌─────────────────────────┐        Strict Sandbox Envelope               │
│  │ Isolated Worker Runtime │ ◄──────────────────────────────────────────  │
│  └─────────────────────────┘                                              │
│               │                                                           │
│               ▼ (local storage only)                                      │
│  ┌─────────────────────────┐                                              │
│  │ Local SQLite / Vault DB │                                              │
│  └─────────────────────────┘                                              │
└───────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Network Boundary (HTTPS / TLS 1.3)
                                    │ Strictly Sanitized DTOs Only
                                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                           REMOTE CLOUD SERVICES                           │
│                                                                           │
│  - Tool Qualification Sync (@resin/contracts schemas only)                │
│  - Anonymous Aggregated Metric Signals                                    │
│  - Signed Activation Certificates & Entitlements                          │
└───────────────────────────────────────────────────────────────────────────┘
```

### Key Trust & Isolation Guarantees

1. **Daemon & Worker Isolation (ADR 0002):**
   - Worker runtimes execute inside unprivileged child processes with restricted capabilities.
   - Capability envelopes (ADR 0007) are a manifest policy check: a tool's declared capabilities are checked against workspace policy before activation and dispatch. The envelope does not isolate processes. Invoking a published tool runs its recorded commands directly, by design; the calling harness's own permission policy governs that tool call, as for any MCP tool, and Resin adds no approval or consent step of its own.
2. **Local Authority & Fail-Closed Enforcement:**
   - The local Gateway and Runtime are authoritative. Cloud-sent workflow validation executes nothing recorded (see [Workflow Validation](#workflow-validation)); the only cloud-authored code it runs is sandboxed derivation steps.
   - All external inputs, activation certificates, and cloud sync responses are validated against strict schemas; unverified or signature-mismatched data is immediately rejected and fails closed.
3. **Localhost IPC Security:**
   - Inter-process communication between Gateway, Observer, and Worker runtimes uses local domain sockets or named pipes with OS-level file permissions.
   - All IPC messages are strictly serialized via typed contracts (`@resin/protocol`) and validated against schema invariants.

---

## Privacy Boundary: Zero Raw Data Upload Policy

Resin enforces an absolute, fail-closed privacy boundary. The core local engine compiles and executes tools on-device.

### Explicit V1 Data Privacy Guarantee

**In Resin V1, raw interactive coding-agent session data NEVER leaves the local developer machine and is NEVER transmitted to Resin Cloud or any remote server.**

Specifically, the following data types are strictly prohibited from cloud egress and remain strictly on the local host:
- **Raw Conversation Transcripts & Prompts**: Full agent-user interaction history, interactive prompt text, thought traces, and model inputs.
- **Raw Model Outputs**: Direct completions, raw generation tokens, and untruncated model responses.
- **Local Source Code & File Contents**: Project repository files, edited buffers, local patches, diffs, and source text.
- **Abstract Syntax Trees & Symbols**: Private codebase AST representations, symbol tables, and semantic index structures.
- **File Paths & Directory Hierarchies**: Local filesystem paths, workspace layouts, directory trees, and environment path names.
- **Secrets & Credentials**: Environment variables, private keys, authentication tokens, API credentials, and connection strings.

Engine-redacted evidence is not raw session data: secret-scrubbed recorded-program views and native command lines, which can name files and directories, are uploaded as learned-tool evidence. The per-event allowlist is in [`docs/security/privacy-inventory.md`](docs/security/privacy-inventory.md).

All local session logs, trajectory databases, and cached tool artifacts reside solely on the local filesystem (`~/.resin/` or workspace-local storage) under local user permissions.

---

## Sanitized Cloud Sync Data Inventory

When cloud connectivity is configured, data transmitted across the network boundary is strictly constrained to sanitized, allowlisted Data Transfer Objects (DTOs) defined in `@resin/contracts`:

| Data Category | Data Elements | Classification | Transport Boundary | Schema / Contract |
| ------------- | ------------- | -------------- | ------------------ | ----------------- |
| **Tool Qualification Evidence** | Aggregated latency savings, token reduction percentages, execution counts, qualification status, tool signature hash | Sanitized / Non-sensitive | Outbound HTTPS (TLS 1.3) | `@resin/contracts` (Analytics & Qualification DTOs) |
| **Anonymous Usage Signals** | Tool invocation frequency, session completion counters, aggregate error category codes (no error strings containing paths or code) | Anonymous / Non-sensitive | Outbound HTTPS (TLS 1.3) | `@resin/contracts` (Telemetry DTOs) |
| **Activation & Entitlements** | Cryptographically signed public key IDs, workspace identifier, plan entitlement flags | Identity / Non-sensitive | Bidirectional HTTPS (TLS 1.3) | `@resin/contracts` (Activation Certificate DTOs) |

### Pre-Dispatch Local Validation

Every payload destined for cloud synchronization is validated against its corresponding schema in `@resin/contracts` before network dispatch. Any payload containing unrecognized fields, raw source fragments, or unallowlisted properties is rejected and logged locally with a privacy violation fault.

---

## Hostile Cloud Authority Rejection

The local Resin installation does not trust remote cloud endpoints as an execution authority:
- **No Remote Code Execution**: Cloud services cannot instruct the local runtime to execute arbitrary scripts, alter capability envelopes, or disable security gates. Validation asks are answered from local recordings without running recorded programs or dispatching tool calls; derivation steps run only in a sandbox. Invoking a published tool runs its recorded commands directly, by design; the calling harness's own permission policy governs that tool call, as for any MCP tool, and Resin adds no approval or consent step of its own.
- **Certificate Verification**: All activation certificates and plan updates from cloud endpoints must carry valid Ed25519 cryptographic signatures from recognized root keys.
- **Fail-Closed on Tampering**: Expired, revoked, signature-mismatched, or unrecognized certificates immediately drop to local unentitled/safe mode without interruption of local tool compilation and execution.

---

## Workflow Validation

The cloud sends validation asks; the gateway polls, decides and submits without user interaction. Validation executes nothing recorded. For every recorded step (shell/process, program, tool-protocol, harness tool, composed invoke) it resolves the step's call exactly as an invocation would and compares it with the call this device recorded for that step: same callable (name, connection, program kind/argument) and every argument equal to the recorded value, with program templates compared after resolving the private original. A match lets the recorded output answer the step; a mismatch or missing recorded call means the plan is not verified. No recorded program is spawned, no tool call is dispatched, and no project is copied.

- **Local call identity**: Every recorded value compared or returned is read from the local private store under a reference the device recomputes from a session its own harness adapters discovered and a call id from the plan (`callId`, or `heldOut.calls` for held-out repeats); the entry must be owned by this workspace. References and literals carried in a plan are never trusted as the recording. Calls that cannot be identified locally yield "unavailable", never verified.
- **Hidden dependencies**: A step that still carries, as literal recorded text, a value the recording shows flowing from an earlier step's output is not verified until the plan binds that position. Incidental matches fail closed.
- **Decisions**: `verification.replay = { kind: "recording", planDigest }`, with only step ids, verdicts and fixed reason strings — never recorded values, commands or outputs.
- **Invocation**: Invoking a published tool runs its recorded commands directly, by design; the calling harness's own permission policy governs that tool call, as for any MCP tool, and Resin adds no approval or consent step of its own.

### Derivation steps

Derivation steps — short Python a cloud model writes to compute a value a recording hard-coded — are the only plan code no local recording produced, and are never trusted. At validation and at tool invocation alike they run as Python in Pyodide (CPython compiled to WebAssembly) inside a Deno process whose only permission is read access to Resin's pinned local Pyodide assets; network, environment, subprocesses, FFI, system information, file writes, and remote or npm imports are denied, and no other file can be read. A derivation therefore sees only its inputs, written into its source: it cannot read the project, the home directory, or any secret on the device, even through Pyodide's JavaScript bridge. It may import only a fixed allowlist of pure standard-library modules, its result is the JSON object of its final expression, and it is bounded in output size, wall-clock time (the process is killed) and memory (V8 heap and 2 GiB WebAssembly limits). The Pyodide release (314.0.7) is pinned by version, lockfile integrity and per-asset SHA-256, ships inside the Resin package, and is never downloaded at run time. If Deno (the installer's ~/.resin/current/deno, RESIN_DENO_EXECUTABLE, or PATH) or the pinned assets are missing or altered, the derivation step fails closed.

---

## Public Artifact Signing & Offline Supply Chain Verification

Public release artifacts are distributed with cryptographic integrity proofs that require zero access to private cloud infrastructure:

1. **Cryptographic Ed25519 Signing:**
   - Public distribution packages (binaries, npm bootstrap packages, release tarballs, installation helper scripts) are deterministically packaged and signed via Ed25519 private keys in protected CI release workflows (`scripts/package-release.mjs`).
2. **Offline & Self-Contained Verification:**
   - Verification is entirely offline. The verifier (`scripts/verify-release.mjs` or `resin verify`) computes SHA-256 digests and verifies Ed25519 signatures against embedded trusted public keys.
   - **Zero Cloud Topology Exposure**: Verification operates purely on static public assets and embeds no private cloud endpoints, internal VPC references, API gateways, or proprietary serverless cloud topology.
3. **Software Bill of Materials (SBOM):**
   - Every release ships with a CycloneDX 1.5 SBOM (`sbom.json`) documenting full dependency provenance and license metadata.
4. **Zero Unapproved Critical/High Findings:**
   - Automated release gates block publication if unapproved critical or high vulnerabilities exist in the dependency tree.

---

## CI/CD Security & Untrusted PR Isolation

The Resin repository implements defense-in-depth for all continuous integration workflows:
- **Untrusted PR Isolation**: Pull request workflows triggered from external forks execute exclusively in unprivileged GitHub-hosted runner environments with zero access to internal secrets, production cloud credentials, or release signing keys.
- **Protected Workflow Separation**: Release and deployment workflows execute exclusively on protected `main` or tag refs with explicit promotion confirmations, auditable workflow dispatch, and offline verification receipts.
- **Optional Human Review**: Human reviews are optional and are not automatically requested through code ownership rules; pull requests enforce PR-only release gates with zero required approving reviews while requiring 100% automated machine qualification.
- **Branch Protection & Automated Gating**: Direct pushes and force pushes are blocked on `main`. Merging requires all 13 CI status checks, package and privacy boundary checks, security scans, and the `ci-gate` rollup to pass.

---

## Safe Harbor

We consider good-faith security research conducted in accordance with this policy to be authorized. We will not pursue legal action against researchers who:
- Make a good-faith effort to avoid privacy violations, data destruction, and service interruption.
- Report vulnerabilities through authorized private channels without public disclosure prior to mutual agreement.
- Do not exploit identified vulnerabilities beyond what is strictly necessary to demonstrate proof-of-concept.
