## Summary & Motivation

<!-- Provide a concise explanation of the change, background context, and link the related issue. -->
Closes #<!-- Issue Number -->

---

## Acceptance Criteria Evidence

<!-- List every acceptance criterion from the issue or specification and provide verifiable proof/output. -->

- [ ] **Criterion 1:** <!-- Description -->
  - *Evidence:* `<!-- Command output / artifact ref / test report -->`
- [ ] **Criterion 2:** <!-- Description -->
  - *Evidence:* `<!-- Command output / artifact ref / test report -->`
- [ ] **Criterion 3:** <!-- Description -->
  - *Evidence:* `<!-- Command output / artifact ref / test report -->`

---

## Test Commands & Local Verification

<!-- Document the exact local commands executed and confirm that all pass with 0 errors. -->

- [ ] Complete CI verification gate executed locally:
  ```bash
  pnpm run check:all
  ```
- [ ] Verification summary:
  - ADR verification: `pnpm run check:adrs` (PASS)
  - Package boundaries: `pnpm run check:boundaries` (PASS)
  - Privacy boundary check: `pnpm run check:privacy-boundary` (PASS)
  - Hostile cloud authority check: `pnpm run check:hostile-cloud` (PASS)
  - Runtime & IPC security check: `pnpm run check:runtime-security` (PASS)
  - Secret scanning: `pnpm run check:secrets` (PASS)
  - Biome linting: `pnpm run lint` (PASS)
  - TypeScript typecheck: `pnpm run typecheck` (PASS)
  - Monorepo build: `pnpm run build` (PASS)
  - Unit test suite: `pnpm run test` (PASS)
  - E2E integration test suite: `pnpm run test:e2e` (PASS)
  - Binary smoke verification: `pnpm run check:smoke` (PASS)
  - Release artifact & doc verification: `pnpm run release:verify` (PASS)
  - Release test suite: `pnpm run release:test` (PASS)
---

## Security & Privacy Impact

- [ ] **Public / Private Boundary & Cloud Contracts:** Verified against `resin-boundary.json` and `@resin/cloud-contracts`.
  - [ ] Zero raw session data upload: Raw interactive prompts, coding sessions, local source files, and secrets NEVER leave the local developer environment.
  - [ ] Sanitized DTO schema validation: Only allowlisted, sanitized metrics and qualification DTOs are sent to remote services.
  - [ ] Hostile Cloud Authority Rejection: Local engine remains authoritative; invalid/revoked/tampered cloud responses fail closed without execution.
- [ ] **Cryptographic Operations & Signing:** Ed25519 signatures and digests verified; no unauthorized key handling or signature bypasses.
- [ ] **Secret Management:** No credentials, tokens, or private keys committed (verified by standalone secret scanner and gitleaks).
- [ ] **Privacy & Data Residency:** No unconsented telemetry, PII leakage, or violation of ADR 0005.
- [ ] **Capability Envelope & Sandboxing:** Process boundaries and permission constraints strictly enforced for workers (ADR 0002 / ADR 0007).
- [ ] **Network & IPC Boundaries:** Verified against `docs/architecture/boundaries.md`; domain sockets and local named pipes properly restricted.
- [ ] **Untrusted PR Isolation:** Changes tested without exposure to production cloud secrets or private deployment environments.
*Notes / Threat Model Considerations:*
<!-- Any specific notes or risk mitigations -->

---

## Migrations & Breaking Changes

- **Database / Schema Migrations:** <!-- None / details -->
- **Protocol / Wire Contract Changes:** <!-- None / details -->
- **Breaking API Changes:** <!-- None / details -->
- **Rollback Compatibility:** <!-- Verified against docs/release/rollback-procedure.md -->

---

## Generated Artifacts & Build Outputs

- [ ] Workspace binary entry points compile and pass smoke checks (`node scripts/verify-binaries.mjs`).
- [ ] Release manifest, SBOM, and checksums updated if release configuration changed.
- [ ] Documentation cross-links valid (0 broken links across `docs/`).

---

## Review & Governance Verification

- [ ] PR targets `main` and is ready for PR-only release gates.
- [ ] Requires at least one independent code owner approval from designated owners in `.github/CODEOWNERS` (author cannot self-approve).
- [ ] Stale reviews are dismissed upon pushing new commits.
- [ ] Last-push approval is enforced before merging.
- [ ] All required status check jobs in `.github/workflows/ci.yml` and `ci-gate` pass.
