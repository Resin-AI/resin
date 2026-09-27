# Agent instructions

## CI

CI is deliberately minimal (static checks + unit tests). Don't add CI jobs, required checks or pre-push gates without the owner's approval.

- Pull requests run `.github/workflows/ci.yml` only: Static Checks (`pnpm lint`, `pnpm typecheck`), sharded Unit Tests (`pnpm test`), and the `CI Gate Rollup` job, which is the only required check.
- When changing derivation/sandbox code, run `pnpm test:sandbox` locally.
- Everything else runs by hand from `package.json`: `check:all`, `test:sandbox`, `test:e2e`, `release:test`, `release:package:test`, `release:verify:test`, `check:smoke`, `check:adrs`, `check:boundaries`, `check:secrets`, `check:privacy-boundary`, `check:hostile-cloud`, `check:runtime-security`.
- `platform-qualification.yml`, `system-qualification.yml` and `security-scan.yml` run on push to `main` and `workflow_dispatch`; `release-candidate.yml` validates their runs (and the `ci.yml` run) on the exact release SHA.
