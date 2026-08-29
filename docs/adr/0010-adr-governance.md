# ADR 0010: Architecture Decision Record (ADR) Governance and Lifecycle

- **Status**: accepted
- **Date**: 2026-08-17
- **Deciders**: Resin Core Architecture Team
- **Consulted**: Engineering Leadership, Core Contributors

## Context and Problem Statement

As the Resin codebase and team expand, architectural decisions must be documented unambiguously, maintained with rigorous version control, and protected against undocumented drift. Without a formal governance process and automated verification tooling, architecture records become stale, out-of-sequence, poorly formatted, or broken over time.

We must define the formal lifecycle, format, numbering, superseding process, migration requirements, and automated enforcement mechanisms for Architecture Decision Records (ADRs).

## Decision Drivers

- **Clarity & Traceability**: Every architectural decision must have a clear history, rationale, and owner.
- **Immutability of Accepted Records**: Historical context of why a decision was made must be preserved; past decisions are superseded, not rewritten in place.
- **Automated Continuous Enforcement**: CI must fail if ADR formatting, sequential numbering, cross-references, or terminology rules are violated.
- **Seamless Migrations**: Any decision that alters a prior decision must explicitly document a backward-compatible migration strategy.

## Considered Options

1. **Option 1: Informal Wiki / Notion Pages**
   - *Pros*: Easy rich-text editing.
   - *Cons*: Disconnected from code commits; impossible to enforce in CI; drifts rapidly from implementation.

2. **Option 2: Unchecked Markdown Files in Repo**
   - *Pros*: Stored alongside code in Git.
   - *Cons*: Numbering collisions; broken cross-links; inconsistent status definitions.

3. **Option 3: Formally Governed Repository ADRs with Automated CI Verification (Selected)**
   - *Pros*: Git-backed; strict lifecycle state machine; automated verification via `scripts/verify-adrs.mjs`; enforced in CI; strict superseding rules.
   - *Cons*: Requires disciplined authoring and maintaining the verification script.

## Decision

We decide on the following ADR governance and lifecycle rules:

### 1. ADR Lifecycle State Machine

Every ADR must declare exactly one status from the canonical lifecycle state set:

- **`proposed`**: Under active discussion and review. Not yet authoritative.
- **`accepted`**: Approved by the architecture team and binding on implementation.
- **`superseded`**: Replaced by a newer ADR. Must reference the superseding ADR.
- **`deprecated`**: No longer applicable or active, but not directly replaced.
- **`rejected`**: Evaluated and explicitly not adopted, recorded for historical context.

```
                  +------------+
                  |  proposed  |
                  +-----+------+
                        |
            +-----------+-----------+
            |                       |
            v                       v
      +----------+            +----------+
      | accepted |            | rejected |
      +----+-----+            +----------+
           |
     +-----+-----+
     |           |
     v           v
+------------+ +------------+
| superseded | | deprecated |
+------------+ +------------+
```

### 2. Numbering and File Naming Rules

- All ADR files reside in `docs/adr/`.
- File naming format is strictly `NNNN-kebab-case-title.md` (e.g., `0001-v1-topology.md`).
- Numbers must be strictly sequential 4-digit zero-padded integers starting from `0001` with **zero gaps and zero duplicates**.

### 3. Immutability and Superseding Process

- Once an ADR is marked `accepted`, its core decision and rationale are **immutable**.
- When an architectural change is required:
  1. Author a new ADR with the next sequential number.
  2. The new ADR must declare `- **Supersedes**: [ADR NNNN](0001-v1-topology.md)` (referencing the prior ADR) in its header.
  3. The new ADR must include a **Migration Plan** section detailing backward compatibility, deprecation windows, and migration steps.
  4. The old ADR is updated only to change its status to `superseded` and add `- **Superseded by**: [ADR MMMM](0010-adr-governance.md)`.

### 4. Required ADR Structure

Every ADR must include the following standard sections:
1. Title: `# ADR NNNN: Title`
2. Metadata header: Status, Date, Deciders, Consulted (plus optional Supersedes/Superseded by).
3. `## Context and Problem Statement`
4. `## Decision Drivers`
5. `## Considered Options`
6. `## Decision`
7. `## Consequences` (with Positive, Negative/Trade-offs, Mitigations subsections)
8. `## Compliance and Verification`

### 5. Automated CI Verification

- The verification script `scripts/verify-adrs.mjs` is executed on every commit and PR via `pnpm check:adrs` and `pnpm check`.
- Verification checks:
  1. File sequence and naming (`NNNN-slug.md`).
  2. Valid status values.
  3. Presence of all mandatory sections.
  4. Cross-link integrity (all markdown links between ADRs and `docs/architecture/` must resolve).
  5. Supersedes / Superseded-by bidirectional link consistency.
  6. Canonical glossary terminology consistency.

## Consequences

### Positive
- A single, unambiguous, authoritative source of truth for all architectural decisions.
- Automated tooling prevents broken links, duplicate numbers, or forgotten migrations.
- Easy onboarding for new engineers who can read the chronological evolution of the system.

### Negative / Trade-offs
- Slight overhead in authoring formal records for major technical changes.

### Mitigations
- Provide an ADR template and fast CLI validation (`pnpm check:adrs`) to give instant feedback during development.

## Compliance and Verification

- The automated verification script `scripts/verify-adrs.mjs` and test suite `scripts/verify-adrs.test.mjs` enforce all governance rules in CI.
