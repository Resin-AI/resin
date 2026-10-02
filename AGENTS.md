# Agent instructions

## CI

CI is deliberately minimal (static checks + unit tests). Don't add CI jobs, required checks or pre-push gates without the owner's approval.

- Pull requests run `.github/workflows/ci.yml` only: Static Checks (`pnpm lint`, `pnpm typecheck`), sharded Unit Tests (`pnpm test`), and the `CI Gate Rollup` job, which is the only required check.
- When changing derivation/sandbox code, run `pnpm test:sandbox` locally.
- Everything else runs by hand from `package.json`: `check:all`, `test:sandbox`, `test:e2e`, `release:test`, `release:package:test`, `release:verify:test`, `check:smoke`, `check:adrs`, `check:boundaries`, `check:secrets`, `check:privacy-boundary`, `check:hostile-cloud`, `check:runtime-security`.
- Speed targets: PR CI ≤ 90 s; merge to `main` → published release ≤ 5 min. Don't add work to either path unless it is signing, integrity verification, the packaged vulnerability scan, exact-SHA pinning or channel verification; fold anything else into parallel jobs or drop it.
- `ci.yml` is the only workflow that runs on push to `main`. Platform qualification (7 lanes, including native Windows x64/arm64 on Windows runners), system qualification and the `pnpm audit` vulnerability scan run inside `release-candidate.yml` as parallel jobs on the exact commit, before the signing job. The RC takes the `ci.yml` push run ID for that commit (it may still be running); `release.yml` refuses promotion until the CI run recorded in the candidate evidence completed successfully on the exact SHA.
- Release steps: dispatch `release-candidate.yml` (`commit_sha`, `release_tag`, `ci_run_id`) as soon as the commit lands on `main`, then `release.yml` with the RC run ID once the RC and CI have both succeeded. Production stable promotion is weekly: `release.yml` refuses it within 7 days of the newest published GitHub release unless dispatched with `emergency=true` and an `emergency_reason`. See CONTRIBUTING.md → "Cutting a release".
