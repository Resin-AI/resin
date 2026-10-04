# Agent instructions

## CI

CI is deliberately small. Don't add CI jobs, required checks or pre-push gates without the owner's approval.

- Pull requests run `.github/workflows/ci.yml` only: Static Checks (`pnpm lint`, `pnpm typecheck`), Repository Gates (`check-boundaries`, `check-secrets`, `verify-adrs`), sharded Unit Tests (`pnpm test`), Sandbox Tests (`pnpm test:sandbox`), and the `CI Gate Rollup` job over all of them, which is the only required check.
- Every test file `pnpm test` excludes must run in CI: derivation sandbox suites in `test:sandbox` (PR CI), release-script and installer suites in the `release-tests` job of `release-candidate.yml` (`release:test:*`, `check:public-artifact`, `test:e2e`; `release:test:packaging` also runs the `check:smoke` binary smoke check). `scripts/public-release-workflows.test.mjs` enforces this. The release candidate also packages and verifies the test-signed release itself (`RESIN_RELEASE_TEST_ONLY=1 pnpm release:package && pnpm release:verify`).
- Everything else runs by hand from `package.json`: `check:all`, `check:privacy-boundary`, `check:hostile-cloud`, `check:runtime-security`.
- Speed targets: PR CI ≤ 4 min; merge to `main` → published release ≤ 15 min (measured 2026-10-03: release candidate 10–13 min, publication 2–4 min). Don't add work to the release path unless it is signing, integrity verification, the packaged vulnerability scan, exact-SHA pinning or channel verification; fold anything else into parallel jobs off the Windows critical path, or drop it.
- `ci.yml` is the only workflow that runs on push to `main`. Platform qualification (7 lanes, including native Windows x64/arm64 on Windows runners), system qualification, the release test suites and the `pnpm audit` vulnerability scan run inside `release-candidate.yml` as parallel jobs on the exact commit, before the signing job. The RC takes the `ci.yml` push run ID for that commit (it may still be running); `release.yml` refuses promotion until the CI run recorded in the candidate evidence completed successfully on the exact SHA.
- Linux jobs pin `ubuntu-24.04`, not `ubuntu-latest`; move to a new image deliberately.
- Release steps: dispatch `release-candidate.yml` (`commit_sha`, `release_tag`, `ci_run_id`) as soon as the commit lands on `main`, then `release.yml` with the RC run ID once the RC and CI have both succeeded. See CONTRIBUTING.md → "Cutting a release".
