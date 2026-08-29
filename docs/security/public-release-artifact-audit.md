# Public Release Artifact & Boundary Security Audit

**Audit Date**: `2026-08-28`  
**Auditor**: Automated Read-Only Release Channel Scanner (`scripts/audit-public-releases.mjs`)  
**Audit Scope**: Reachable Release Channels (Public CDN, GitHub Releases, Internal Distribution Origin)  
**GitHub Repository**: `Resin-AI/resin`  
**Boundary Specification**: `resin-boundary.json` (Phase 1 Baseline: `b66cd99`)  
**Status**: **HISTORICAL AUDIT COMPLETE — REMEDIATION IN PROGRESS (PHASE 2)**

---

## Executive Summary

As part of GitHub Issue #74 (Splitting Open-Source Local Core from Proprietary Cloud Platform), a comprehensive, read-only security and boundary audit was performed on **every currently reachable Resin release channel and artifact**. 

The audit scanned all historical prepublication release candidates (`v1.0.0` through `v1.0.10`), download archives, release manifests, CycloneDX SBOMs, and channel metadata across the public distribution origin, CloudFront CDN (`dist.resin.sh`), and GitHub Releases.

### Key Audit Findings

1. **Proprietary Cloud Code Disclosed in Standalone Tarballs**:
   - In all historical release versions (`v1.0.0` through `v1.0.10`), release packaging scripts included internal build outputs from `apps/cloud/dist/` (839 files per platform archive).
   - This included proprietary cloud backend modules: cloud orchestrators, prompt synthesis templates, clustering engines, billing/quota controllers, and database repository logic.
   - All disclosed cloud files are cataloged below and must be treated as disclosed.

2. **Source Map Disclosure**:
   - In all historical release versions, TypeScript compilation source maps (`*.js.map` and `*.d.ts.map`, 1,568 files per platform tarball) were bundled into public client archives.

3. **Private Package Leaks in Manifests & SBOMs**:
   - Release manifests (`manifest-1.0.x.json`) declared 15 workspace packages, including private packages `@resin/cloud`, `@resin/e2e`, and `@resin/test-fixtures`.
   - CycloneDX SBOMs (`sbom.json`) included private packages `@resin/cloud`, `@resin/e2e`, `@resin/test-fixtures`, as well as 15+ AWS SDK cloud dependencies (`@aws-sdk/client-s3`, `@aws-sdk/client-sqs`, etc.) that are only used in serverless/cloud backend infrastructure.

4. **Zero Credential Exposure**:
   - Deep text scanning across all 9,643 entries in release tarballs confirmed **zero cleartext AWS credentials, zero private keys, and zero runtime authentication tokens**.
   - Regex matches in `node_modules` were confirmed to be standard library parser definitions (`jose` PEM parser and AWS SDK credential provider regexes).

5. **Channel Routing & Reachability**:
   - **Release Distribution S3 Storage (Internal Origin)**: Contains 137 objects spanning 11 versions (`v1.0.0` through `v1.0.10`), root `channels.json`, 11 manifests, 10 candidate promotion records, 56 evidence files, and 4 pinned Deno runtimes.
   - **CloudFront CDN (`dist.resin.sh`)**: Backed by public distribution `EU92MIHXIEH3G`, serving public requests. Active stable channel points to version `1.0.10`.
   - **GitHub Releases (`Resin-AI/resin`)**: Release tag `v1.0.3` exists; **0 release assets** were attached to GitHub releases (all distribution occurred via CloudFront / release distribution storage).
   - **Staging Distribution Storage (Internal Origin)**: Nonexistent / inactive.
   - **Web Static Storage (Internal Origin)**: Contains installer scripts `_assets/install.sh`, `_assets/install.ps1`, and helper `_assets/install-helper-v1.mjs`.

---

## 1. Reachable Release Channels Inventory

| Channel Name | Location / Identifier | Reachable | Object / Release Count | Findings / Notes |
| :--- | :--- | :---: | :---: | :--- |
| **Release Distribution S3 Origin** | `s3://[REDACTED-DIST-BUCKET]` | ✅ Yes | 137 objects | Primary distribution storage containing versions `v1.0.0`–`v1.0.10`. |
| **CloudFront CDN** | `https://dist.resin.sh` (`EU92MIHXIEH3G`) | ✅ Yes | Active | Public CDN endpoint. `channels.json` active version: `1.0.10`. |
| **GitHub Releases** | `Resin-AI/resin` | ✅ Yes | 1 release (`v1.0.3`) | Release `v1.0.3` published; **0 attached assets** (clean channel). |
| **Web Static S3 Origin** | `s3://[REDACTED-STATIC-BUCKET]` | ✅ Yes | 320 objects | Contains installers (`install.sh`, `install.ps1`, `install-helper-v1.mjs`). |
| **Staging Distribution Origin** | `s3://[REDACTED-STAGING-BUCKET]` | ❌ No | 0 objects | Bucket not created / `NoSuchBucket`. |

---

## 2. Historical Version Inventory Matrix (v1.0.0 through v1.0.10)

All 11 release versions currently stored in the distribution storage origin were audited:

| Version | Total Objects | Platform Tarballs | Manifest SHA-256 | SBOM SHA-256 | Disclosed Cloud Files | Disclosed Source Maps | Disclosed Test Fixtures | Secret Leaks |
| :---: | :---: | :---: | :--- | :--- | :---: | :---: | :---: | :---: |
| **`v1.0.0`** | 6 | 5 | `ee3068c52e3e47b78eb3ca184fc7c78c17772ae5afc03efcb5be147ca856d9b1` | N/A (unbundled) | 839 | 1,568 | 120 | 0 |
| **`v1.0.1`** | 6 | 5 | `4bfef6a8bf8ec968f23fa4613ea2f689eef3bf417bb184e60cf0b39beee1b585` | N/A (unbundled) | 839 | 1,568 | 120 | 0 |
| **`v1.0.2`** | 6 | 5 | `d720cfad15d7e5d848698ee84ee5ea63cfd29cff4e5e40e69dd1367a7604f56f` | N/A (unbundled) | 839 | 1,568 | 120 | 0 |
| **`v1.0.3`** | 12 | 5 | `e600f8e998c64c74405f226b5d75a57904135ecbeaaf07618145a2e2d5b8d5f2` | `cb9b8e8f85f1c93a02798f0607d79b940989f6655c65f979fe7bbf949d01b38f` | 839 | 1,568 | 120 | 0 |
| **`v1.0.4`** | 11 | 5 | `4a34b22c7a972e379b37fb045c7b3ddaa4bc640cb253909772eeffca8a4c1ddf` | `1b853874943fcf5868846c4f74d0db586715f483c38db5d8521bcba1df93c5d6` | 839 | 1,568 | 120 | 0 |
| **`v1.0.5`** | 11 | 5 | `e4d221f7e785c56be42f15ae2d5f5fe678670c108f450a82c3a55bfec2aa59dc` | `0db860aba5f0904a3e7b830395d8e7a9fec54479d4cf348c53eb4ba1248fa2ae` | 839 | 1,568 | 120 | 0 |
| **`v1.0.6`** | 11 | 5 | `270f2095f922766ecad7f5f9f68894df6433e144a2c0c7bc637c3587b1c3eeb8` | `fc2a0c4f8d6722bc13f9c64beab16dc30dffdfd7ea9f96b27e85c2c58e7bbef6` | 839 | 1,568 | 120 | 0 |
| **`v1.0.7`** | 11 | 5 | `5ca6d7bfa5d70f3f2604ee0c656912ea594191c7809623e59998188185c889ce` | `0225d309be0d1f9fb57f9c8f2b84784db3f6b95b8d0034a74fe75ea9c6a0ebc9` | 839 | 1,568 | 120 | 0 |
| **`v1.0.8`** | 11 | 5 | `a8c5fceba0da2c98d6c810f545a95cb88450ca1fe7a17dd10842db13493dbca0` | `8c1ff979f42df28362624bbccfdf96e8557ee61b0c63fa54e58b8f2c3d52670e` | 839 | 1,568 | 120 | 0 |
| **`v1.0.9`** | 11 | 5 | `8aa63fbe59d3e52f53444a1ca9b8feee7d0fc0d86e9fe5bb1562b8c5f0a04918` | `ba34b92b67fef66085a539b56f8f65757fe64fc5f284e3a479ff7376378e9324` | 839 | 1,568 | 120 | 0 |
| **`v1.0.10`** | 11 | 5 | `3db146f8a517f358464fe19ae9873c965c7806f2734cb6ba789bedae9554ef9b` | `ea89417849e782d22a8435d10fe044dcfcbbce4df93b827e8d530fe8318ca471` | 839 | 1,568 | 120 | 0 |

---

## 3. Comprehensive Deep-Dive: Release `v1.0.3`

Release `v1.0.3` is the baseline release candidate cited in Epic #22 and Roadmap Issue #74.

### 3.1 Itemized Artifact Inventory for `v1.0.3`

| Artifact Key | File Type | Size (Bytes) | SHA-256 Digest | Status / Findings |
| :--- | :---: | :---: | :--- | :--- |
| `releases/v1/artifacts/v1.0.3/resin-v1.0.3-darwin-arm64.tar.gz` | Tarball | 13,775,374 | `99d183d3c86e9718790559d8a5503a57037eae0de6fff11e8639b11db8df494f` | ⚠️ 839 cloud files, 1,568 maps |
| `releases/v1/artifacts/v1.0.3/resin-v1.0.3-darwin-x64.tar.gz` | Tarball | 13,775,373 | `b073bbc81a52a32df0c270f8618adb393102e1ee5348bf3e2ce4db5283a45cb4` | ⚠️ 839 cloud files, 1,568 maps |
| `releases/v1/artifacts/v1.0.3/resin-v1.0.3-linux-arm64.tar.gz` | Tarball | 13,775,374 | `9a5830b35753e254d30b992680ea8b04ab344cd156377b3ce7b25c58746e9053` | ⚠️ 839 cloud files, 1,568 maps |
| `releases/v1/artifacts/v1.0.3/resin-v1.0.3-linux-x64.tar.gz` | Tarball | 13,775,372 | `00c7324ee76fcfc27301c238b72f2324e9ecba9a22e86d9a9cb84e7a2b9ee37b` | ⚠️ 839 cloud files, 1,568 maps |
| `releases/v1/artifacts/v1.0.3/resin-v1.0.3-wsl.tar.gz` | Tarball | 13,775,370 | `a999fa43ba7fc7aa8e83bebb6e3260840ff68541e204c38234395bc58e1d2c6c` | ⚠️ 839 cloud files, 1,568 maps |
| `releases/v1/manifests/manifest-1.0.3.json` | Manifest | 10,755 | `e600f8e998c64c74405f226b5d75a57904135ecbeaaf07618145a2e2d5b8d5f2` | ⚠️ `@resin/cloud` declared |
| `releases/v1/evidence/v1.0.3/sbom.json` | SBOM | 27,249 | `cb9b8e8f85f1c93a02798f0607d79b940989f6655c65f979fe7bbf949d01b38f` | ⚠️ `@resin/cloud` + AWS SDK components |
| `releases/v1/evidence/v1.0.3/release-evidence.json` | JSON | 7,162 | `95e0c52bb7a829ba88d227f2c695dbbf793c12feaa1ca7eb68b31a89c933a085` | Qualification evidence receipt |
| `releases/v1/evidence/v1.0.3/release-trust.json` | JSON | 3,454 | `8cefc8cf36e29da4fc15db47306263df6f5984620f4c9c1aa2c3f851eb336585` | Key metadata & trust chain |
| `releases/v1/evidence/v1.0.3/RELEASE-EVIDENCE.md` | Markdown | 22,057 | `c6e4fc734e2cedaed964bf1fd36f8f9ba3af3f07769cdae1cc50c192663529bf` | Human-readable REM-001–REM-020 |
| `releases/v1/evidence/v1.0.3/public-release-smoke-8a3560295843460269f8c648dc8b3b4f65d6c81fae62740bcde7ff7cfa5eb093.json` | JSON | 3,745 | `8b7245b73f848972df7859b85c13f63ea47c6a9a3b98c3933c0618063a8a3a0e` | Automated smoke run verification |
| `releases/v1/evidence/v1.0.3/public-release-smoke-ec471e4cb8fa7c3c86720f180746b1eb96db6235b2e04f98df3ee3be3568c07e.json` | JSON | 3,745 | `b6770f1a4eecf1cb5b89a059b0f443859670d9ae487422f2f73752e259b13926` | Second smoke verification receipt |

---

### 3.2 Breakdown of Disclosed Files in `v1.0.3` Client Tarballs

Each `resin-v1.0.3-*.tar.gz` tarball contains **9,643 entries**. The breakdown across packages is as follows:

```
resin/
├── adapters/
│   ├── claude-code/dist/    (30 files)
│   ├── codex-cli/dist/      (30 files)
│   └── omp/dist/            (34 files)
├── apps/
│   ├── cli/dist/            (110 files)
│   ├── cloud/dist/          (839 files)  <-- ⚠️ PROPRIETARY CLOUD BACKEND (DISCLOSED)
│   ├── gateway/dist/        (202 files)
│   └── observer/dist/       (202 files)
├── bin/                     (3 launcher binaries)
├── fixtures/
│   ├── e2e/dist/            (66 files)   <-- ⚠️ TEST DOUBLE FIXTURES
│   └── test-fixtures/dist/  (54 files)   <-- ⚠️ TEST DOUBLE FIXTURES
├── packages/
│   ├── contracts/dist/      (70 files)
│   ├── crypto/dist/         (56 files)
│   ├── db/dist/             (68 files)
│   ├── harness-contracts/   (60 files)
│   ├── protocol/dist/       (78 files)
│   └── runtime/dist/        (120 files)
├── node_modules/
│   ├── @aws-sdk/            (3,347 files)<-- ⚠️ CLOUD DEPENDENCY BUNDLED
│   ├── @smithy/             (1,548 files)<-- ⚠️ CLOUD DEPENDENCY BUNDLED
│   └── (other deps)         (2,668 files)
└── LICENSE                  (1 file)
```

#### Disclosed `apps/cloud/dist/` Subsystem Inventory

The 839 disclosed cloud files inside `resin/apps/cloud/dist/` include:

1. **Analytics Engine (`resin/apps/cloud/dist/analytics/`, 36 files)**:
   - `anomaly.js`, `calibration.js`, `cost-attribution.js`, `drift.js`, `latency.js`, `metrics.js`, `profiling.js`, `roi.js`, `savings.js`, `telemetry.js`, `token-accounting.js` (with `.d.ts` and `.js.map`).
2. **API & Routing Subsystem (`resin/apps/cloud/dist/api/`, 108 files)**:
   - REST controllers, GraphQL resolvers, request validation schemas, rate-limiting interceptors.
3. **Authentication & Multi-Tenancy (`resin/apps/cloud/dist/auth/`, 42 files)**:
   - Tenant isolation guards, session token verification, IAM role mapping.
4. **Billing & Usage Metering (`resin/apps/cloud/dist/billing/`, 30 files)**:
   - Stripe integration handlers, credit balance calculations, tier quota enforcement.
5. **Clustering & Embeddings (`resin/apps/cloud/dist/clustering/`, 66 files)**:
   - Session DBSCAN clustering, embedding vector indexing, opportunity detection logic.
6. **Database & Repository Layer (`resin/apps/cloud/dist/db/`, 84 files)**:
   - PostgreSQL schema models, Prisma/Drizzle query repositories, migration runners.
7. **Serverless Dispatcher (`resin/apps/cloud/dist/deploy/`, 48 files)**:
   - Lambda trigger handlers, SQS queue consumers, EventBridge event routing.
8. **Cloud Orchestrator (`resin/apps/cloud/dist/orchestrator/`, 192 files)**:
   - Multi-tenant tool synthesis scheduler, sandbox runner management, canary rollout pipelines.
9. **Code Synthesizer (`resin/apps/cloud/dist/synthesizer/`, 233 files)**:
   - LLM prompt generation templates, AST AST-grep code generator, tool test synthesizers.

---

### 3.3 Manifest & SBOM Boundary Disclosures in `v1.0.3`

#### Release Manifest (`manifest-1.0.3.json`)
The manifest declared the following **15 packages**:
- Allowlisted Public Packages: `@resin/contracts`, `@resin/crypto`, `@resin/db`, `@resin/harness-contracts`, `@resin/protocol`, `@resin/runtime`, `resin`, `@resin/gateway`, `@resin/observer`, `@resin/adapter-claude-code`, `@resin/adapter-codex`, `@resin/adapter-omp` (12 packages).
- **Disclosed Private Packages (3 packages)**:
  - ⚠️ `@resin/cloud` (Path: `apps/cloud`, Type: `app`)
  - ⚠️ `@resin/test-fixtures` (Path: `fixtures/test-fixtures`, Type: `package`)
  - ⚠️ `@resin/e2e` (Path: `packages/e2e`, Type: `package`)

#### CycloneDX SBOM (`sbom.json`)
The SBOM contained **38 total components**, including:
- **Disclosed Private Components**:
  - `pkg:npm/%40resin/cloud@1.0.3`
  - `pkg:npm/%40resin/test-fixtures@1.0.3`
  - `pkg:npm/%40resin/e2e@1.0.3`
- **Disclosed Cloud-Only Third-Party Dependencies**:
  - `@aws-sdk/client-s3`, `@aws-sdk/client-sqs`, `@aws-sdk/client-dynamodb`, `@aws-sdk/client-eventbridge`, `@aws-sdk/client-lambda`
  - `@smithy/node-http-handler`, `@smithy/protocol-http`, `@smithy/signature-v4`

---

## 4. Root Cause Analysis

The inclusion of proprietary cloud code in public workstation release artifacts was caused by the following mechanism in `scripts/package-release.mjs`:

1. **Shared Workspace Definition (`WORKSPACE_PACKAGES`)**:
   `scripts/package-release.mjs` used a single `WORKSPACE_PACKAGES` constant for both monorepo build orchestration (`turbo run build`) and release payload packaging (`createPlatformReleaseTarballs`).
2. **Inclusive Packaging Loop**:
   The release generator iterated over every item in `WORKSPACE_PACKAGES` (which included `@resin/cloud`, `apps/cloud`, `@resin/test-fixtures`, and `@resin/e2e`) and copied `dist/` files directly into the platform tarball payload.
3. **Absence of Negative Release Gate**:
   There was no automated pre-upload assertion verifying that public tarballs contain *only* packages listed in `resin-boundary.json.publicReleasePackages`, nor any check forbidding `.map` files or `apps/cloud/` paths.

---

## 5. Remediation Plan & Phase 2 Action Items

1. **Separation of Concerns in `package-release.mjs`**:
   - Monorepo build tooling may build internal packages, but workstation release packaging must strictly derive its package list from `resin-boundary.json.publicReleasePackages` (`PUBLIC_RELEASE_PACKAGES`).
   - Private packages (`@resin/cloud`, `@resin/web`, `@resin/cloud-contracts`, `@resin/e2e`) must never be iterated or packaged into client tarballs, manifests, or SBOMs.

2. **Negative Boundary Assertions**:
   - `package-release.mjs` must assert that 0 forbidden paths (`apps/cloud`, `apps/web`, `packages/cloud-contracts`, `infra/serverless`, `fixtures/test-fixtures`) exist in the generated tarball.
   - Source maps (`*.map`) must be excluded from public workstation release tarballs.

3. **CI / Pre-Release Gate Wiring (`check:public-artifact`)**:
   - An explicit validation step must run against generated release artifacts prior to S3/CloudFront publication or candidate promotion.

4. **Repeatable Auditor Tooling**:
   - `scripts/audit-public-releases.mjs` is committed to the repository with automated unit tests in `scripts/audit-public-releases.test.mjs` to enable automated, repeatable regression auditing of all release channels.

---

## 6. Verification and Attestation

- **Audit Execution Reproduction**:
  ```bash
  # Run against distribution storage origin (requires authorized bucket parameter)
  node scripts/audit-public-releases.mjs --bucket <release-distribution-bucket> [--profile <aws-profile>] --json

  # Run against local directory or synthetic offline artifacts
  node scripts/audit-public-releases.mjs --dir dist/release/v1.0.3/ --json
  node scripts/audit-public-releases.mjs --offline
  ```
- **Tooling Test Suite**: `pnpm vitest run scripts/audit-public-releases.test.mjs` (22 unit tests passing)
- **Immutable Policy**: In accordance with the audit directive, no historical releases, S3 objects, or cryptographic keys were modified, deleted, or rewritten during this audit.
