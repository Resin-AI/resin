# Resin

Resin finds recurring patterns in coding-agent sessions and compiles stable work into tools that use less inference, lower inference cost, and complete matching work faster.

## Monorepo Layout

```
resin/
├── apps/                     # Deployable applications & binaries
│   ├── cli/                  # Developer and automated CLI entrypoint (`resin`)
│   ├── cloud/                # Central cloud coordination service
│   ├── gateway/              # Protocol & execution gateway (`resin-mcp`)
│   ├── observer/             # Telemetry, monitoring, and audit daemon (`resin-daemon`)
│   └── web/                  # Public site and authenticated Resin Console
├── packages/                 # Core shared libraries and domain packages
│   ├── contracts/            # Core schema, interfaces, and validation rules
│   ├── crypto/               # Cryptographic primitives, vault, and credential management
│   ├── db/                   # Database client, migrations, and repositories
│   ├── harness-contracts/    # Harness interfaces and adapter specifications
│   ├── protocol/             # Wire protocol schemas and framing
│   └── runtime/              # Sandboxed execution runtime and engine
├── adapters/                 # AI coding harness integration adapters
│   ├── claude-code/          # Claude Code integration adapter
│   ├── codex-cli/            # Codex CLI integration adapter
│   └── omp/                  # OMP (Oh My Pi) harness adapter
├── fixtures/                 # Conformance test suites and mock data
│   ├── e2e/                  # End-to-end integration and smoke tests
│   └── test-fixtures/        # Conformance fixtures and CLI (`resin-conformance`)
├── docs/                     # Canonical documentation and architecture decision records
└── scripts/                  # Packaging, verification, and boundary check tooling
```

## Project Runtime & Metadata Model

Resin operates with automatic, zero-prompt bootstrap and deterministic execution locking:

- **Root Resolution & Automatic Bootstrap**: When starting MCP or resolving tools, Resin automatically identifies the project root (the enclosing Git repository root if present, otherwise the startup working directory). If `.resin/project.json` or `.resin/resin.lock` is missing, Resin automatically initializes them synchronously without interactive prompts or blocking workflows.
- **Committed Portable Files (`.resin/`)**:
  - `.resin/project.json`: Contains portable project metadata (`schemaVersion: 1`, stable project `id` UUID, `name`, and initialization timestamp). It declares project identity, not authorization.
  - `.resin/resin.lock`: Contains the exact locked tool versions, runtime engine requirements, and content digests (`sha256`).
  - *Non-Authorizing Invariant*: Committed metadata files declare dependency requirements and cryptographic identity, but **cannot authorize tool execution**. Authorization is strictly established locally by the user or workspace admin.
- **Lock Semantics**: Resin enforces exact version and digest matching against `.resin/resin.lock`. If a locked tool version or content digest does not match local qualification or offline trust entries, execution fails closed; no fallback, version substitution, or unverified execution is permitted.
- **Move, Rename, Clone, Fork, and Template Outcomes**:
  - *Same-Account Move / Rename*: Moving or renaming a directory retains the project UUID. The local daemon and Cloud resolve the project idempotently by its persistent UUID.
  - *Cross-Account Clone / Public Fork / Template Directory*: When a project is cloned or copied across different accounts or organizations, the project UUID is recognized as owned by another identity. Cloud project registration returns `fork_required` (a non-enumerating response that preserves repository privacy without leaking owner information). This requires an explicit fork/import outcome where a newly initialized project identity and UUID are established under the caller's account, preventing cross-account authorization hijacking.
  - *Offline Bootstrap & Later Registration*: Offline projects initialize locally with `outcome: "local_only"` and operate seamlessly offline within their local trust store. When network connectivity is established and a user session is active, the project registers idempotently with Cloud without mutating locked tool versions.
- **OS-Standard Identity Partitioning**:
  - Local authentication tokens, verified activation certificates, and trust stores are stored under OS-standard data directories (e.g. `XDG_DATA_HOME` / `~/.local/share` on Linux, `~/Library/Application Support` on macOS, `%LOCALAPPDATA%` on Windows) partitioned strictly by `<account_id>/<user_id>/<project_id>` with restricted POSIX permissions (`0700` directories, `0600` files).
  - Storing identity, secrets, and authorization outside the repository tree prevents accidental git commits of sensitive credentials and blocks cross-project hijacking.
- **Deletion, Recovery, and State Lifecycle**:
  - *Deleting `.resin/project.json`*: Deleting `project.json` resets and breaks the stable project identity and its link to local trust records unless explicitly recovered from Cloud or git history; it is not a routine safe repair operation.
  - *Deleting `.resin/resin.lock`*: Deleting `resin.lock` destroys the exact locked tool selections and cryptographic digests; resolving execution requires explicit lock recovery or re-qualification, never a silent empty lock or automatic version substitution.
  - *Deleting Local Trust State or Cache*: Deleting local trust stores, runtime activation records, or cached packages disables offline execution and invalidates local authorization. Re-establishing execution requires online re-authentication, fresh cryptographic verification, and re-downloading authorized tool packages.
  - *Data Residency & Privacy Invariant*: Raw session transcripts, unredacted prompts, and proprietary source code remain strictly local on the developer workstation. Resin V1 enforces a hard no-raw-upload policy across all sync paths: only validated, branded sanitized observation DTOs cross the network boundary. Cloud never receives raw transcripts or executes tools against developer repositories.

## Quick Start

For the tight `resin.sh` edit/test loop, follow [`WORKFLOW.md`](./WORKFLOW.md). For shared
staging and production operations, follow [`DEPLOY.md`](./DEPLOY.md).

### 1. Install Dependencies

```bash
pnpm install --frozen-lockfile
```

### 2. Build Monorepo

```bash
pnpm build
```

### 3. Run Tests

```bash
# Run all unit tests
pnpm test

# Run end-to-end integration tests
pnpm test:e2e

# Run binary smoke verification across all 4 entry points
pnpm check:smoke
```

### 4. Complete Verification & Quality Gates

Run the comprehensive local verification gate that mirrors all CI checks:

```bash
pnpm run check:all
```

`pnpm run check:all` executes the complete release verification sequence:
1. `pnpm run check:adrs` — ADR structure, sequence, and canonical glossary term validation
2. `pnpm run check:boundaries` — Package boundary and dependency graph validation
3. `pnpm run check:secrets` — Standalone secret scanning for private keys, tokens, credentials, and canary leaks
4. `pnpm run check:privacy-boundary` — Fail-closed local privacy boundary verification and anti-exfiltration enforcement
5. `pnpm run lint` — Biome formatting and linter validation
6. `pnpm run typecheck` — TypeScript strict type validation
7. `pnpm run build` — Topological build across all workspace packages
8. `pnpm run test` — Unit test suite execution
9. `pnpm run release:test` — Unit & integrity tests for release packaging and Ed25519 verification
10. `pnpm run test:e2e` — End-to-end test execution
11. `pnpm run check:smoke` — Binary smoke execution for CLI, Daemon, Gateway MCP, and Conformance Runner
12. `pnpm run release:verify` — Release tarballs, SHA-256 digests, Ed25519 signatures, SBOM, and docs cross-links

### 5. Local Infrastructure

Start local PostgreSQL, MinIO (S3 compatible), and Valkey (Redis compatible) services:

```bash
docker compose -f infra/docker-compose.yml up -d
```

## Binary Entry Points

Resin builds and packages 4 primary binary entry points:
- `@resin/cli` (`apps/cli/dist/bin/cli.js` -> `resin`)
- `@resin/observer` (`apps/observer/dist/bin/daemon.js` -> `resin-daemon`)
- `@resin/gateway` (`apps/gateway/dist/bin/mcp-shim.js` -> `resin-mcp`)
- `@resin/test-fixtures` (`fixtures/test-fixtures/dist/cli.js` -> `resin-conformance`)

Run `pnpm run check:smoke` to verify binary existence, manifest declarations, node shebang headers, and `--help` CLI smoke execution.

## Boundary Rules

1. **No direct source imports across package boundaries**: Always import packages through their declared package exports (e.g. `import { ... } from "@resin/contracts"`). Never use relative paths into another package or reach into internal `src/` directories.
2. **Explicit dependencies**: Any package imported must be declared in the consumer's `package.json`.
3. Run `pnpm check:boundaries` to verify boundary compliance.

## Governance & Release Gates

- **PR-Only Gate**: All modifications must land via pull request targeting `main`. Direct pushes and force-pushes to `main` are blocked.
- **Automated Branch Protection**: Run `./scripts/configure-branch-protection.sh` to configure strict branch protection rules via GitHub API / gh CLI.
- **Review Policy**: Code-owner and peer reviews are encouraged for sensitive changes, but no independent approval is required. Authors may merge once required CI checks pass and all review conversations are resolved.
- **Required CI Status Checks**: All 10 parallel CI jobs (`lint`, `typecheck`, `build`, `test-unit`, `test-e2e`, `check-boundaries`, `check-adrs`, `release-verification`, `binary-smoke`, `secret-scan`) and the rollup `ci-gate` must pass before merge.
