# Contributing to Resin

Thank you for contributing to Resin! Please follow the guidelines below to maintain quality, security, and architectural integrity across the repository.

---

## Development Workflow & Local Verification

### What CI runs

CI is deliberately small. Don't add CI jobs, required checks or pre-push gates without the owner's approval.

Pull-request CI (`.github/workflows/ci.yml`) runs only:
- **Static Checks:** repository boundary, secret and ADR checks, then `pnpm lint` and `pnpm typecheck`
- **Unit Tests:** `pnpm test`, sharded across parallel jobs
- **Sandbox Tests:** `pnpm test:sandbox`, the derivation sandbox suites `pnpm test` excludes
- **CI Gate Rollup:** the single required check; it fails unless every job above passes

`ci.yml` is the only workflow that runs on pushes to `main`. Release-only checks run inside `release-candidate.yml`: verifier and packaging tests in `release-tests`, installer tests in system qualification, and `check:public-artifact` against the candidate already built by the linux-x64 lane. Darwin and WSL artifact checks reuse that candidate too. All seven platform evidence files remain required before signing.

Speed targets: PR CI ≤ 4 min, merge to `main` → published release ≤ 15 min (release candidate 10–13 min, publication 2–4 min). Keep signing, integrity verification, the packaged vulnerability scan, exact-SHA pinning and channel verification; anything that only repeats a test run must not be added to the release critical path.

### Cutting a release

1. Merge to `main`. The `ci.yml` push run for the merge commit starts immediately.
2. Right away, dispatch `release-candidate.yml` with `commit_sha` (the merge commit), `release_tag` and `ci_run_id` (the ID of that `ci.yml` push run; it may still be running). Its first job fails within seconds if `release_tag` is already a published GitHub release (a draft with that tag is allowed), so a second operator racing the same release gets a clear error instead of a duplicate candidate. The RC then runs platform qualification (linux-x64 and linux-arm64 natively, darwin-x64/darwin-arm64/wsl artifact validation, windows-x64 and windows-arm64 natively in PowerShell including install, service, second-user isolation and uninstall), system qualification and the release test suites in parallel on GitHub-hosted runners, then the signing job audits production dependencies, generates the qualification evidence, and builds, signs and verifies the candidate.
3. When the RC and the CI run have both succeeded, dispatch `release.yml` with `commit_sha`, `release_tag`, `candidate_run_id`, `confirm_promotion=PROMOTE_PRODUCTION` and `environment=production`. A production run fails before downloading the candidate if `release_tag` is already published (a draft from an earlier failed attempt is reused). It fails before publishing anything unless the CI run recorded in the candidate evidence completed successfully on the exact SHA, then publishes and verifies the channel.

### Everyday checks

Run `pnpm check` for the same checks as PR CI. It builds the workspace and runs static, unit and sandbox checks, but does not package release archives. Use `pnpm check:all` for the additional release and installer checks.

`pnpm build` and `pnpm typecheck` share one fully checked TypeScript solution build and its Turbo cache. One compiler process builds the workspace in dependency order. Running both commands does not compile it twice.

When adding a TypeScript workspace, add its project to the root `tsconfig.json` references and declare its dependency references in its own config. The existing boundary check rejects workspace projects missing from the root solution. Keep the root config as plain JSON.

### Complete Local Verification Gate

Run the full verification sequence by hand when a change touches release, security or packaging paths:

```bash
pnpm run check:all
```

`pnpm run check:all` executes the complete sequence in order:
1. `pnpm run check:adrs` — Architecture Decision Record (ADR) format, sequence, and glossary validation
2. `pnpm run check:boundaries` — Monorepo package boundary and architectural import validation
3. `pnpm run check:secrets` — Standalone secret scanner checking for unencrypted private keys, tokens, credentials, and canary leaks
4. `pnpm run lint` — Biome formatting and code style linting
5. `pnpm run typecheck` — TypeScript strict type checking across all packages and apps
6. `pnpm run build` — Topological build of all workspace packages and apps
7. `pnpm run test` — Unit test suite execution via Vitest, including the privacy boundary, hostile cloud and runtime security suites
8. `pnpm run test:sandbox` — Derivation tests against the real Deno + Pyodide sandbox
9. `node scripts/build-install-helper.mjs --check` — Committed install-helper freshness, also checked by PR CI
10. `pnpm run release:test` — Release packaging, signer/verifier, standalone artifact and binary smoke checks
11. `pnpm run test:e2e` — End-to-end installer tests

`check:all` runs the security suites once, through `pnpm run test`. The focused scripts below still run each group on its own.

Turbo includes the root `tsconfig.base.json` in every task hash, so changing it invalidates cached builds and typechecks. The release candidate caches the pnpm content store and Turbo outputs per OS and CPU architecture; it never caches `node_modules`, and installs still run `pnpm install --frozen-lockfile`. In both CI and the release candidate, the pnpm store cache is keyed by OS, CPU architecture and the exact lockfile hash with no prefix fallback, so a lockfile change starts a fresh store instead of carrying obsolete packages forward.

### Individual Verification Commands
- **Lint & Format:** `pnpm run lint` / `pnpm run format`
- **Typecheck:** `pnpm run typecheck`
- **Build:** `pnpm run build`
- **Unit Tests:** `pnpm run test`
- **Sandbox Tests (real Deno + Pyodide; run when changing derivation/sandbox code):** `pnpm run test:sandbox`
- **E2E Tests:** `pnpm run test:e2e`
- **Smoke Tests:** `pnpm run check:smoke`
- **Package Boundaries:** `pnpm run check:boundaries`
- **ADR Check:** `pnpm run check:adrs`
- **Privacy Boundary Check (also in `pnpm run test`):** `pnpm run check:privacy-boundary`
- **Hostile Cloud Check (also in `pnpm run test`):** `pnpm run check:hostile-cloud`
- **Runtime Security Check (also in `pnpm run test`):** `pnpm run check:runtime-security`
- **Release Verification:** `pnpm run release:verify`
- **Release Test Suite:** `pnpm run release:test`

`pnpm run test:e2e` runs through `vitest.packaged.config.ts`. Its global setup packs the npm bootstrap tarball once per run into a fresh temporary directory and deletes it when the run ends; nothing is cached between runs. Each suite installs into its own temporary directory.

To run one packaged suite on its own, pass the same config:

```bash
pnpm exec vitest run --config vitest.packaged.config.ts apps/cli/tests/installer/packaged-cli-production-http.test.ts
```

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
- **Review Policy:** Pull requests enforce PR-only integration with zero required approving reviews. Human reviews are optional and are not automatically requested through code ownership rules. Automated gating relies entirely on required machine verification.
- **Branch Protection Automation:** Run `./scripts/configure-branch-protection.sh` (or `pnpm exec ./scripts/configure-branch-protection.sh`) to automatically configure strict branch protection rules via GitHub API / gh CLI.
- **Required Status Check:** `CI Gate Rollup` is the only required check; it passes only when Static Checks, every Unit Tests shard and Sandbox Tests passed on the exact commit.

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
