# Contributing to Resin

Thank you for contributing to Resin! Please follow the guidelines below to maintain quality, security, and architectural integrity across the repository.

---

## Development Workflow & Local Verification

Before submitting any pull request or pushing changes, ensure your local workspace passes all required checks.

### Complete Local Verification Gate

Run the master verification command that mirrors the complete CI gate set:

```bash
pnpm run check:all
```

`pnpm run check:all` executes the complete sequence in order:
1. `pnpm run check:adrs` — Architecture Decision Record (ADR) format, sequence, and glossary validation
2. `pnpm run check:boundaries` — Monorepo package boundary and architectural import validation
3. `pnpm run check:privacy-boundary` — Fail-closed privacy boundary verification and zero-raw-upload enforcement
4. `pnpm run check:hostile-cloud` — Hostile cloud authority rejection and certificate validation
5. `pnpm run check:runtime-security` — Runtime IPC, process sandbox, and sensitive path security verification
6. `pnpm run check:secrets` — Standalone secret scanner checking for unencrypted private keys, tokens, credentials, and canary leaks
7. `pnpm run lint` — Biome formatting and code style linting
8. `pnpm run typecheck` — TypeScript strict type checking across all packages and apps
9. `pnpm run build` — Topological build of all workspace packages and apps
10. `pnpm run test` — Unit test suite execution via Vitest
11. `pnpm run release:test` — Unit and integrity test suite for release packaging and Ed25519 signing
12. `pnpm run test:e2e` — End-to-end integration test suite
13. `pnpm run check:smoke` (or `pnpm run smoke`) — Binary entry point smoke verification
14. `pnpm run release:verify` — Release artifact, digest, and SBOM verification

### Individual Verification Commands
- **Lint & Format:** `pnpm run lint` / `pnpm run format`
- **Typecheck:** `pnpm run typecheck`
- **Build:** `pnpm run build`
- **Unit Tests:** `pnpm run test`
- **E2E Tests:** `pnpm run test:e2e`
- **Smoke Tests:** `pnpm run check:smoke` (or `pnpm run smoke`)
- **Package Boundaries:** `pnpm run check:boundaries`
- **ADR Check:** `pnpm run check:adrs`
- **Privacy Boundary Check:** `pnpm run check:privacy-boundary`
- **Hostile Cloud Check:** `pnpm run check:hostile-cloud`
- **Runtime Security Check:** `pnpm run check:runtime-security`
- **Release Verification:** `pnpm run release:verify`
- **Release Test Suite:** `pnpm run release:test`

### Running the Locally Built CLI

Run package-manager commands from the repository root so Corepack selects the pinned pnpm version. An invocation from a parent directory such as `pnpm --dir resin build` can select that directory's pnpm version before pnpm processes `--dir`.

```bash
pnpm build
npm exec --yes --ignore-scripts --package ./apps/cli -- resin --version
```

To pair the locally built CLI with a development cloud, pass its printed loopback URL explicitly:

```bash
npm exec --yes --ignore-scripts --package ./apps/cli -- \
  resin init --cloud-url "$RESIN_CLOUD_URL" --workspace "$TARGET_WORKSPACE"
```

Do not use an unqualified `npx resin` command to validate source changes. It resolves the npm registry package rather than the package in this checkout.

---

## Pull Request Lifecycle & Governance Policy

### Branch Protection & PR-Only Gate

The `main` branch is strictly protected and enforces PR-only release gates:
- **Direct Pushes Blocked:** Direct commits and pushes to `main` are disabled. All changes must arrive via pull request.
- **Force Pushes Disabled:** Force-pushing to `main` is strictly forbidden.
- **Review Policy:** All pull requests touching protected paths (observer, gateway, runtime, crypto, protocol, contracts, release/install scripts, workflows, lockfile, root package, and boundary manifest/checker) strictly require at least one independent code-owner approval from designated owners in `.github/CODEOWNERS`. Self-approvals are prohibited. Stale reviews are automatically dismissed upon pushing new commits, and last-push approval is enforced before merging.
- **Branch Protection Automation:** Run `./scripts/configure-branch-protection.sh` (or `pnpm exec ./scripts/configure-branch-protection.sh`) to automatically configure strict branch protection rules via GitHub API / gh CLI.
- **Required Status Checks:** All 13 parallel CI jobs and the rollup `ci-gate` must pass before merging:
  1. `lint` (Biome Lint & Format Check)
  2. `typecheck` (TypeScript Typecheck)
  3. `build` (Monorepo Build)
  4. `test-unit` (Unit Tests)
  5. `test-e2e` (E2E Tests with PostgreSQL)
  6. `check-boundaries` (Package Import Boundaries)
  7. `check-adrs` (ADR Integrity & Glossary Validation)
  8. `check-privacy-boundary` (Privacy Data Boundary Check)
  9. `check-hostile-cloud` (Hostile Cloud Quarantine & Preactivation Check)
  10. `check-runtime-security` (Runtime IPC & Broker Security Check)
  11. `release-verification` (Release Packaging, Digest, SBOM, and Docs Cross-Links)
  12. `binary-smoke` (Binary Entry Point Smoke Tests)
  13. `secret-scan` (Gitleaks and Standalone Secret Scanner)
  14. `ci-gate` (Rollup Status Gate)

### PR Template & Checklist
All pull requests must use `.github/pull_request_template.md` and provide:
- Detailed acceptance criteria evidence with verifiable command outputs or test artifacts.
- Security and privacy impact assessment (cryptography, secrets, capability envelopes, data residency).
- Public / private boundary impact verification (`resin-boundary.json` and `@resin/cloud-contracts`).
- Migration and backward compatibility impact.
- Confirmation that workspace binary entry points build and pass smoke checks.

---

## Public / Private Boundary & Cloud Contracts Governance

Resin enforces a strict architectural boundary separating the open-source local core from cloud services:

1. **Open-Source Local Core vs. Cloud Services:**
   - Local core components (`apps/observer`, `apps/gateway`, `packages/runtime`, `packages/protocol`, `packages/contracts`, `packages/crypto`) operate entirely on the developer's local machine.
   - Remote cloud services and external integrations must strictly communicate through schemas defined in `@resin/cloud-contracts` and obey the boundary manifest (`resin-boundary.json`).
2. **Zero Raw Data Upload in V1:**
   - Raw interactive agent prompts, session conversations, model completions, local source code, repository file contents, file paths, directory structures, and environment secrets **NEVER** leave the local machine and are **NEVER** transmitted to Resin Cloud or any remote server.
   - Local state (SQLite databases, session state, secure key vaults) is strictly on-device.
3. **Sanitized DTO Schema Validation:**
   - All data transmitted across the network boundary is restricted to allowlisted, sanitized DTO schemas defined in `@resin/cloud-contracts` (e.g. aggregate performance metrics, tool qualification evidence, signed activation certificates).
   - DTO payloads are validated locally before dispatch; arbitrary or unstructured payloads are rejected.
4. **Hostile Cloud Authority Rejection & Fail-Closed Local Control:**
   - The local Resin runtime is authoritative. It never executes remote commands or modifies local capability envelopes based on unverified cloud responses.
   - Invalid, expired, revoked, signature-mismatched, or unverified certificates from cloud endpoints immediately fail closed.
5. **Untrusted PR Isolation:**
   - CI workflows execute untrusted pull requests exclusively on unprivileged GitHub-hosted runners without access to production cloud credentials, internal networks, or release signing keys.

---

## Code Style & Architectural Boundaries

1. **Package Boundaries:**
   - Packages must strictly communicate through declared exports (e.g. `@resin/contracts`).
   - Deep imports into internal files (`src/`) of sibling packages are prohibited.
   - All cross-package dependencies must be explicitly declared in `package.json`.
2. **Deterministic Release Packaging & Supply Chain Trust:**
   - Release assets, tarballs, and SBOMs must be generated deterministically through `scripts/package-release.mjs`.
   - Signatures are verified cryptographically via Ed25519 in `scripts/verify-release.mjs`.
   - Verification is purely offline and self-contained without exposing private cloud topology or internal endpoints.
