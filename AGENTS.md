# Agent instructions

## CI

CI is deliberately small. Don't add CI jobs, required checks or pre-push gates without the owner's approval.

- Pull requests run `.github/workflows/ci.yml` only: Static Checks (`check-boundaries`, `check-secrets`, `verify-adrs`, `pnpm lint`, `pnpm typecheck`), sharded Unit Tests (`pnpm test`), Sandbox Tests (`pnpm test:sandbox`), and the `CI Gate Rollup` over all of them, which is the only required check. The rollup checks job results and commit SHAs without checking out the repository.
- Every test file `pnpm test` excludes must run in CI: derivation sandbox suites in `test:sandbox` (PR CI), verifier and packaging suites in the RC's `release-tests`, installer suites in system qualification, and `check:public-artifact` against the linux-x64 lane's existing candidate. `release:test:packaging` also runs `check:smoke`. The excluded-suite coverage test enforces this. System qualification still packages and verifies the test-signed release before binding its evidence.
- `pnpm check` runs the PR-equivalent local checks without release packaging. `pnpm check:all` adds release and installer checks. Focused privacy, hostile-cloud and runtime-security commands remain available by hand.
- Speed targets: PR CI ≤ 4 min; merge to `main` → published release ≤ 15 min (measured 2026-10-03: release candidate 10–13 min, publication 2–4 min). Don't add work to the release path unless it is signing, integrity verification, the packaged vulnerability scan, exact-SHA pinning or channel verification; fold anything else into parallel jobs off the Windows critical path, or drop it.
- `ci.yml` is the only workflow that runs on push to `main`. Platform qualification (7 lanes, including native Windows x64/arm64 on Windows runners), system qualification, the release test suites and the `pnpm audit` vulnerability scan run inside `release-candidate.yml` as parallel jobs on the exact commit, before the signing job. The RC takes the `ci.yml` push run ID for that commit (it may still be running); `release.yml` refuses promotion until the CI run recorded in the candidate evidence completed successfully on the exact SHA.
- Linux jobs pin `ubuntu-24.04`, not `ubuntu-latest`; move to a new image deliberately.
- Release steps: dispatch `release-candidate.yml` (`commit_sha`, `release_tag`, `ci_run_id`) as soon as the commit lands on `main`, then `release.yml` with the RC run ID once the RC and CI have both succeeded. See CONTRIBUTING.md → "Cutting a release".
