# ADR 0005: Privacy and Data Residency Boundaries

- **Status**: accepted
- **Date**: 2026-08-17
- **Deciders**: Resin Core Architecture Team
- **Consulted**: Privacy Officer, Information Security, Platform Architecture

## Context and Problem Statement

AI coding agents handle highly confidential data: proprietary source code, internal API endpoints, secret credentials, proprietary business logic, and private developer conversational context.

A major barrier to enterprise and developer adoption of continuous tool evolution is the risk of data leakage. If raw agent transcripts or full source code files are transmitted to cloud infrastructure for tool synthesis without strict boundaries, organizations cannot adopt the tool.

We must define strict privacy invariants, data residency boundaries, redaction guarantees, and synchronization rules for V1.

## Decision Drivers

- **Zero Unintended Data Exfiltration**: Keep original private source, secrets, and raw conversation transcripts local; only allowlisted, locally sanitized evidence may cross the cloud boundary.
- **Local Source of Truth**: All operational state, full transcripts, and debug traces remain resident on the developer's local machine.
- **Synthesis Utility**: Provide enough structural, semantic, and telemetry context to cloud or local evolution engines to enable high-quality tool synthesis.
- **Cryptographic Auditability**: Provide verifiable cryptographic proofs of what data was captured, redacted, and synced.

## Considered Options

1. **Option 1: Full Cloud Streaming (All transcripts & code synced to cloud)**
   - *Pros*: Cloud LLM synthesis has maximum context for tool generation.
   - *Cons*: Violates enterprise privacy policies; unacceptable data exfiltration risk; rejected outright.

2. **Option 2: Zero Cloud Sync (Pure Local Execution & Synthesis)**
   - *Pros*: Complete data isolation.
   - *Cons*: Requires heavy local LLMs capable of code synthesis running on every developer machine; prevents team-wide tool sharing and collective optimization.

3. **Option 3: Local Source of Truth with Sanitized Observation Sync and Strict No-Raw-Upload Boundary (Selected)**
   - *Pros*: Raw transcripts and original private source remain local; deterministic local redaction strips secrets and PII. Sanitized observations include execution structure, metrics, and explicitly allowed redacted recorded-program views without exposing local private store entries.
   - *Cons*: Requires maintaining a robust local redaction and anonymization pipeline.

## Decision

We decide on the following privacy and data residency architecture for V1:

### 1. Local Residency as Single Source of Truth

- **Local SQLite Store**: All raw conversation transcripts, full tool input arguments, raw tool outputs, system prompts, and workspace file diffs reside exclusively in the local developer SQLite database (`~/.resin/state.db` or workspace `.resin/`).
- **Local Data Retention**: Raw local data is subject to user-configurable retention policies (default: 30 days) and can be cleared instantly via `resin purge`.

### 2. Local Redaction and Sanitization Pipeline

Before any observation is queued for cloud synchronization, it passes through a multi-stage local sanitizer:
1. **Secret & Credential Scrubbing**: High-entropy token detection, regex filters for API keys (AWS, OpenAI, GitHub, SSH private keys, JWTs).
2. **Path & Identifier Anonymization**: Absolute file paths are normalized to relative workspace root tokens (`<WORKSPACE_ROOT>/src/...`); user home directories (`/home/username/`) are scrubbed.
3. **Payload Abstraction**: Tool input and output values are replaced with structural schema descriptors, byte counts, and execution metrics unless explicitly whitelisted as structural metadata.
   Recorded JavaScript, TypeScript, and Python source views are an explicit exception to value-free abstraction: they retain non-secret code and literals after the configured engine's scanning and canonical token alignment. Paired `sourceReference` and `protectedTokens` retain local original authority and prohibit binding redaction-sensitive tokens. Shell, truncated, unparseable, or unalignable source is not projected.
4. **Error Signature Extraction**: Stack traces are stripped of local user names and private string literals, preserving only canonical error codes, exception types, and public module frames.

### 3. Strict Invariant: Zero Raw Data Upload (No-Raw-Upload V1 Policy)

- **Hard Boundary**: Raw prompts, raw conversation turns, original private program source, and private store entries are not uploaded. Engine-redacted recorded-program views may be transmitted as sanitized evidence, including their non-secret code and literal values.
- **No Raw Upload Path**: There is no configuration flag, opt-in toggle (`sync.upload_raw_traces`), remote directive, or alternative upload mode that permits raw transcript or source file exfiltration. All cloud sync is strictly limited to validated, branded, sanitized observation DTOs.

### 4. Cryptographic Audit Trail

- Every sanitized observation batch and tool activation is recorded with an HMAC-SHA256 signature and Merkle log in the local audit database (`@resin/crypto`).
- Developers can audit exactly what data has been transmitted upstream via `resin audit export`.

```
+---------------------------------------------------------------+
| Local Developer Machine (Private Boundary)                   |
|                                                               |
|  +----------------------------------------------------------+ |
|  | Raw Transcripts & Workspace Files (STAYS LOCAL ONLY)     | |
|  +---------------------------+------------------------------+ |
|                              |                                |
|                              v                                |
|  +----------------------------------------------------------+ |
|  | Multi-Stage Local Redaction Pipeline                     | |
|  | - Secret & Credential Scrubber                           | |
|  | - Path Anonymizer & PII Redactor                         | |
|  | - Structural Schema Abstractor                           | |
|  +---------------------------+------------------------------+ |
|                              |                                |
|                              v                                |
|  +----------------------------------------------------------+ |
|  | Sanitized Observations (Metrics, Tool DAGs, Error Codes) | |
|  +---------------------------+------------------------------+ |
|                              | (Encrypted HTTPS / mTLS)       |
+------------------------------+--------------------------------+
                               |
                               | (Boundary Cross: Sanitized Only)
                               v
+---------------------------------------------------------------+
| Cloud Evolution Plane (Shared Intelligence)                   |
|                                                               |
|  +----------------------------------------------------------+ |
|  | Telemetry & Pattern Analysis Engine                      | |
|  +----------------------------------------------------------+ |
+---------------------------------------------------------------+
```

## Consequences

### Positive
- Enterprise compliance: SOC2, GDPR, and corporate IP protection requirements are met out of the box.
- Developers retain total control and visibility over their data.
- Cloud synthesis still receives rich telemetry (latency profiles, repetitive tool chains, abstract AST patterns) to drive autonomous tool evolution.

### Negative / Trade-offs
- Cloud synthesis receives sanitized observations and redacted recorded-program views, not raw transcripts or original private store values. The source view intentionally discloses non-secret program logic and literals; local replay still requires the original and rejects unavailable or invalid projections.

### Mitigations
- Use local synthetic mock generators to reproduce execution patterns without needing raw proprietary inputs.
- Allow optional local LLM synthesis for fully air-gapped environments.

## Compliance and Verification

- Unit tests in `@resin/crypto` and `@resin/observer` verify that synthetic test datasets with mock API keys and private user paths are 100% scrubbed before serialization.
- Automated boundary tests ensure network sync modules never read from raw transcript tables.
