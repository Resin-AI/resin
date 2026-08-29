# Resin Release Signing Trust & Key Management Runbook

This runbook defines the authoritative operational procedures, cryptographic architectures, trust boundaries, rotation protocols, and emergency revocation workflows for Resin production release signing.

---

## 1. Threat Boundary & Trust Architecture

Resin releases use Ed25519 signatures to verify distributed binaries and release metadata without exposing private signing material.

### 1.1 Architectural Trust Boundaries

- **Build vs. Signing Boundary**: Release artifacts (executables, archives, SBOMs, package tarballs) are compiled in isolated CI runner environments during earlier pipeline steps. Cryptographic signing occurs in a dedicated, gate-controlled environment (`production`) within `.github/workflows/release.yml`.
- **Private Key Step-Scoped Isolation**: Private signing keys (`secrets.RESIN_RELEASE_PRIVATE_KEY_PEM`) are never accessible to compile-time build jobs, matrix builders, PR validation, or unit test runners. Within the `publish-and-smoke` job under the `production` environment, the private key is strictly step-scoped: injected exclusively into the `Package exact production-signed release` step and the failure-handling `Handle post-promotion failure and generate signed freeze plan` step. Pre-qualification gates (`Verify exact main release candidate and signing boundary`), build steps, and smoke tests execute without access to private key material.
- **Public Trust & Bridge Roots Mapping**: Public key identities (`vars.RESIN_RELEASE_KEY_ID`, `vars.RESIN_RELEASE_PUBLIC_KEY_PEM`) and optional bridge roots (`vars.RESIN_RELEASE_ADDITIONAL_TRUSTED_KEYS_JSON`) are mapped from GitHub Environment variables into the job-level environment to enable pre-flight signing validation, evidence qualification, and trust bundle embedding.
- **Client-Side Root Pinning**: CLI clients embed a static trust root bundle (`apps/cli/dist/release-trust.json`, Schema `2.0.0`) containing valid public keys in active-first order. Each bundled Schema 2.0.0 record requires and cross-checks `keyId`, `algorithm` (`Ed25519`), `trustDomain` (`production`), `publicKeyPem` (SPKI PEM), `publicKeyHex` (raw 32-byte Ed25519 root in lowercase hex), and `publicKeyFingerprintSha256` (SHA-256 digest of the SPKI DER public key). The client parses the PEM to confirm it represents an Ed25519 key, verifying that the derived raw root and DER SHA-256 fingerprint strictly match the record metadata. The client preserves full key identities (`TrustedReleaseKey { keyId, publicKeyHex }`) across all verification stages and enforces active-first ordering when matching signatures.
- **Strict Production Trust & Emergency Overrides**: Client production trust accepts semantic non-test and non-revoked IDs only (rejecting digit-only numeric IDs such as `"10"` or `"12345"`, test IDs matching `test-only-*`, and revoked IDs in `REVOKED_RELEASE_KEY_IDS`). Emergency trust override via `RESIN_TRUSTED_RELEASE_PUBLIC_KEYS` requires an explicitly configured, strict non-empty JSON array of exact `{ "keyId": "...", "publicKeyHex": "..." }` objects. Any blank string, extra fields, comma-separated lists, duplicate IDs/keys, or malformed hex fails closed immediately rather than falling back to bundled trust.

### 1.2 GitHub Environment & Admin Bypass Custody Policy

Release signing secrets and configuration are bound exclusively to the `production` GitHub Environment with strict custody rules:

- **Required Reviewers**: Release deployment requires explicit approval from designated Release Stewards / Security Admins.
- **Admin Bypass Decision**: While organization admins possess technical bypass capabilities, release signing policy **prohibits unreviewed admin bypasses** except in declared, documented SEV-1 emergency incidents (see Section 5).
- **Deployment Branch Protection**: Deployments to `production` are restricted to tags matching `v*.*.*` originating from qualified `main` commits.
- **Auditability**:
  - Workflow strictly enforces exact 40-character commit SHA matching against protected release tags.
  - Automated cryptographic qualification gates must pass 100% of checks before signing keys are loaded into runner memory.
  - Immutable GitHub Actions audit logs track the executing operator's identity and timestamp.

---

## 2. Key Inventory, Storage Locations & Configuration

### 2.1 Cryptographic Identity Inventory

| Property                     | Active Primary Key                       | Historical Revoked Key                     |
| :--------------------------- | :--------------------------------------- | :----------------------------------------- |
| **Key Identifier (`keyId`)** | `resin-release-2026a`                    | `resin-release-v1`                         |
| **Algorithm**                | Ed25519 (PureEd25519 / RFC 8032)         | Ed25519                                    |
| **Format**                   | SPKI PEM (Public) / PKCS#8 PEM (Private) | PKCS#8                                     |
| **Status**                   | Active Production Signer                 | Revoked (Blacklisted in release verifiers) |
| **Rotation Cadence**         | Annual (or upon incident)                | Permanently deprecated                     |

### 2.2 Storage Locations & Vault Configurations

#### GitHub Actions `production` Environment Configuration

All release variables and secrets must be configured within the **`production`** GitHub Environment (Settings -> Environments -> `production`):

- **Environment Variables** (`vars` in `production` environment):
  - `RESIN_RELEASE_KEY_ID`: Primary active key identifier (e.g., `resin-release-2026a`).
  - `RESIN_RELEASE_PUBLIC_KEY_PEM`: Primary active SPKI PEM public key.
  - `RESIN_RELEASE_ADDITIONAL_TRUSTED_KEYS_JSON`: Optional JSON array string of additional bridge key records (default/initial `[]` during steady-state).
- **Environment Secrets** (`secrets` in `production` environment):
  - `RESIN_RELEASE_PRIVATE_KEY_PEM`: Step-scoped private signing key PEM (write-only, never echoed).

```bash
# Configure production environment variables via GitHub CLI
gh variable set RESIN_RELEASE_KEY_ID -R Resin-AI/resin -e production --body "resin-release-2026a"
gh variable set RESIN_RELEASE_PUBLIC_KEY_PEM -R Resin-AI/resin -e production < resin-release-public.pem
gh variable set RESIN_RELEASE_ADDITIONAL_TRUSTED_KEYS_JSON -R Resin-AI/resin -e production --body "[]"

# Configure step-scoped private signing key secret via GitHub CLI (reads secret via stdin)
gh secret set RESIN_RELEASE_PRIVATE_KEY_PEM -R Resin-AI/resin -e production < resin-release-private.pem
```

#### Infisical Secret Vault

- **Project**: `Resin` (ID: `1f0fb031-a010-42ab-a3e9-58f0befa8ad3`)
- **Environment**: `prod`
- **Path**: `/release-signing`
- **Secrets**:
  - `RESIN_RELEASE_KEY_ID`: `resin-release-2026a`
  - `RESIN_RELEASE_PUBLIC_KEY_PEM`: Public key PEM content.
  - `RESIN_RELEASE_PRIVATE_KEY_PEM`: Private key PEM content (restricted access).
  - `RESIN_RELEASE_PUBLIC_KEY_HEX`: Raw 32-byte public key hex.
  - `RESIN_RELEASE_PUBLIC_KEY_FINGERPRINT_SHA256`: SPKI DER SHA-256 hex.

#### Client Embedded Trust & Override

- **Embedded Trust File**: `apps/cli/dist/release-trust.json`
  - Schema Version: `2.0.0`
  - Bundled Key Records:
    ```json
    [
      {
        "keyId": "resin-release-2026a",
        "algorithm": "Ed25519",
        "trustDomain": "production",
        "publicKeyPem": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA...\n-----END PUBLIC KEY-----",
        "publicKeyHex": "...",
        "publicKeyFingerprintSha256": "..."
      }
    ]
    ```
- **Runtime Override Variable**: `RESIN_TRUSTED_RELEASE_PUBLIC_KEYS`
  - Strict JSON array format: `[{"keyId":"resin-release-2026a","publicKeyHex":"<64-hex-chars>"}]`
  - Validates exact semantic non-test key IDs, valid 64-character lowercase hex roots, and active-first ordering.

---

## 3. Key Generation & Ingestion Ceremony (Production Signers)

Production release signing key creation must follow this formal custody ceremony.

### 3.1 Air-Gapped Key Generation Procedure

Key generation must occur on an isolated workstation or secure HSM:

```bash
# Generate new Ed25519 keypair and output PKCS#8 private PEM and SPKI public PEM
node -e '
  const crypto = require("node:crypto");
  const fs = require("node:fs");

  const keypair = crypto.generateKeyPairSync("ed25519");
  const privPem = keypair.privateKey.export({ type: "pkcs8", format: "pem" });
  const pubPem = keypair.publicKey.export({ type: "spki", format: "pem" });
  const spkiDer = keypair.publicKey.export({ type: "spki", format: "der" });
  const hex = spkiDer.subarray(-32).toString("hex");
  const fp = crypto.createHash("sha256").update(spkiDer).digest("hex");

  fs.writeFileSync("resin-release-private.pem", privPem, { mode: 0o600 });
  fs.writeFileSync("resin-release-public.pem", pubPem, { mode: 0o644 });

  console.log("Raw Public Key Hex:", hex);
  console.log("SPKI SHA-256 Fingerprint:", fp);
'
```

### 3.2 Custody Transfer & Vault Ingestion

1. **Infisical Ingestion**:
   - Open Infisical -> Project `Resin` (`1f0fb031-a010-42ab-a3e9-58f0befa8ad3`) -> Environment `prod` -> Path `/release-signing`.
   - Set `RESIN_RELEASE_KEY_ID` to the new key identifier (e.g., `resin-release-2026b`).
   - Store `RESIN_RELEASE_PUBLIC_KEY_PEM`, `RESIN_RELEASE_PRIVATE_KEY_PEM`, `RESIN_RELEASE_PUBLIC_KEY_HEX`, and `RESIN_RELEASE_PUBLIC_KEY_FINGERPRINT_SHA256`.
2. **GitHub Actions Ingestion (`production` Environment)**:
   - Ingest environment variables and secrets scoped strictly to `-R Resin-AI/resin -e production`:
     ```bash
     gh variable set RESIN_RELEASE_KEY_ID -R Resin-AI/resin -e production --body "resin-release-2026b"
     gh variable set RESIN_RELEASE_PUBLIC_KEY_PEM -R Resin-AI/resin -e production < resin-release-2026b-public.pem
     gh variable set RESIN_RELEASE_ADDITIONAL_TRUSTED_KEYS_JSON -R Resin-AI/resin -e production --body "[]"
     gh secret set RESIN_RELEASE_PRIVATE_KEY_PEM -R Resin-AI/resin -e production < resin-release-2026b-private.pem
     ```
3. **Encrypted Cold Backup**:
   - Encrypt the private key using an offline, multi-recipient age/GPG key for disaster recovery and store in secure cold storage.

### 3.3 Plaintext Key Cleanup & Sanitization

Immediately following vault ingestion:

```bash
shred -u resin-release-private.pem
rm -f resin-release-public.pem
```

---

## 4. Safe Bridge Rotation Procedure (Zero-Downtime Rotation)

To rotate release signing keys without breaking existing CLI installations or client auto-updates, execute a **three-phase bridge rotation protocol**.

```
Phase 1: Key A Signs [A, B]  -->  Phase 2: Key B Signs [B, A]  -->  Phase 3: Key B Signs [B]
(Clients learn Key B)              (Clients transition to B)          (Key A retired)
```

### Phase 1: Provision Key B & Expand Trust Bundle (Key A Signs `[A, B]`)

1. Generate new Ed25519 keypair for `Key B` (e.g. `keyId: "resin-release-2026b"`).
2. Retain `Key A` (`resin-release-2026a`) as the active signing key:
   - `RESIN_RELEASE_KEY_ID=resin-release-2026a`
   - `RESIN_RELEASE_PUBLIC_KEY_PEM=<Key A Public PEM>`
   - `RESIN_RELEASE_PRIVATE_KEY_PEM=<Key A Private PEM>`
3. Set `RESIN_RELEASE_ADDITIONAL_TRUSTED_KEYS_JSON` in the GitHub `production` environment and Infisical:
   ```bash
   gh variable set RESIN_RELEASE_ADDITIONAL_TRUSTED_KEYS_JSON -R Resin-AI/resin -e production --body '[{"keyId":"resin-release-2026b","publicKeyPem":"-----BEGIN PUBLIC KEY-----\n<Key B SPKI PEM Base64>\n-----END PUBLIC KEY-----"}]'
   ```
4. Build and publish release `vX.Y.Z`.
   - The release manifest is signed by **Key A**.
   - The CLI binary embeds trust bundle schema `2.0.0` with `[Key A, Key B]`.
   - Existing installed CLIs (which trust Key A) successfully download and verify this update.
   - Newly installed or updated CLIs now trust **both** Key A and Key B.

### Phase 2: Active Signer Switchover (Key B Signs `[B, A]`)

1. Promote `Key B` to the active primary signer in GitHub `production` environment and Infisical:
   ```bash
   gh variable set RESIN_RELEASE_KEY_ID -R Resin-AI/resin -e production --body "resin-release-2026b"
   gh variable set RESIN_RELEASE_PUBLIC_KEY_PEM -R Resin-AI/resin -e production < resin-release-2026b-public.pem
   gh secret set RESIN_RELEASE_PRIVATE_KEY_PEM -R Resin-AI/resin -e production < resin-release-2026b-private.pem
   ```
2. Configure `Key A` as the additional trusted root:
   ```bash
   gh variable set RESIN_RELEASE_ADDITIONAL_TRUSTED_KEYS_JSON -R Resin-AI/resin -e production --body '[{"keyId":"resin-release-2026a","publicKeyPem":"-----BEGIN PUBLIC KEY-----\n<Key A SPKI PEM Base64>\n-----END PUBLIC KEY-----"}]'
   ```
3. Build and publish release `vX.Y.(Z+1)`.
   - The release manifest is signed by **Key B**.
   - The CLI binary embeds trust bundle schema `2.0.0` with `[Key B, Key A]`.
   - Phase 1 clients (which trust [A, B]) verify Key B's signature and successfully update.
   - Any remaining Phase 0 clients that missed Phase 1 update to Phase 2 via installer bootstrap.

### Phase 3: Retirement of Key A (Key B Signs `[B]`)

1. Once client adoption of Phase 1 / Phase 2 binaries exceeds deprecation thresholds (typically 90 days):
2. Clear additional trusted keys in GitHub `production` environment and Infisical:
   ```bash
   gh variable set RESIN_RELEASE_ADDITIONAL_TRUSTED_KEYS_JSON -R Resin-AI/resin -e production --body "[]"
   ```
3. Build and publish release `vX.Y.(Z+2)`.
   - The release manifest is signed by **Key B**.
   - The CLI binary embeds trust bundle schema `2.0.0` with `[Key B]`.
4. Archive `Key A` private key in offline cold storage and delete from active vault paths.

---

## 5. Emergency Key Compromise & Revocation Runbook

If a private signing key is compromised or suspected of exposure, execute this procedure immediately.

### 5.1 Step 1: Immediate Containment (T0 - T+10m)

1. **Revoke GitHub Actions Secret**:
   ```bash
   # Immediately delete the compromised private signing key secret from production environment
   gh secret delete RESIN_RELEASE_PRIVATE_KEY_PEM -R Resin-AI/resin -e production
   ```
2. **Disable Release Workflow**:
   ```bash
   gh workflow disable release.yml -R Resin-AI/resin
   ```

### 5.2 Step 2: Distribution Channel Freeze & Revocation Notice (T+10m - T+30m)

1. Generate an emergency signed freeze notice and signed key revocation notice using an uncompromised key (e.g., from an emergency offline root or newly provisioned Key C injected via Infisical):
   ```bash
   # Securely load credentials from local environment file without logging secrets
   set -a; source .env; set +a

   # Authenticate with Infisical Universal Auth into a restricted temporary token file
   INFISICAL_TOKEN_FILE="$(mktemp)"
   chmod 0600 "$INFISICAL_TOKEN_FILE"
   trap 'rm -f "$INFISICAL_TOKEN_FILE"' EXIT INT TERM

   infisical login --method=universal-auth --client-id="$INFISICAL_CLIENT_ID" --client-secret="$INFISICAL_CLIENT_SECRET" --plain > "$INFISICAL_TOKEN_FILE"

   # Execute emergency signed notice generation using Infisical-injected uncompromised key
   infisical run --token="$(cat "$INFISICAL_TOKEN_FILE")" --env=prod --path=/release-signing --projectId=1f0fb031-a010-42ab-a3e9-58f0befa8ad3 -- node --input-type=module -e '
     import fs from "node:fs";
     import path from "node:path";
     import {
       loadReleaseSigningKeyFromEnv,
       trustedKeysFromSigningKey,
       createSignedFreezeNotice,
       verifySignedFreezeNotice,
       createSignedRevocationNotice,
       verifySignedRevocationNotice,
     } from "./scripts/release-trust.mjs";

     const uncompromisedKey = loadReleaseSigningKeyFromEnv();
     const revokedKeyId = "resin-release-2026a";
     if (uncompromisedKey.keyId === revokedKeyId) {
       throw new Error("Refusing to sign revocation with the compromised key.");
     }
     const trustedKeys = trustedKeysFromSigningKey(uncompromisedKey);

     const distDir = path.resolve("dist");
     fs.mkdirSync(distDir, { recursive: true });

     // 1. Create and verify signed freeze notice
     const freezeNotice = createSignedFreezeNotice(
       {
         targetVersion: "1.0.0",
         reason: "Emergency incident response: signing key compromise.",
         rollbackTargetVersion: "0.1.0",
         deprecationNotice: "Release v1.0.0 is frozen and deprecated due to key revocation. Do not install.",
       },
       uncompromisedKey,
     );

     const freezeCheck = verifySignedFreezeNotice(freezeNotice, trustedKeys);
     if (!freezeCheck.valid) {
       throw new Error(`Signed freeze notice validation failed: ${freezeCheck.reason}`);
     }

     const freezePath = path.join(distDir, "incident-freeze-plan.json");
     fs.writeFileSync(freezePath, JSON.stringify(freezeNotice, null, 2) + "\n");
     console.log(`✅ Verified and wrote signed freeze notice to ${freezePath}`);

     // 2. Create and verify signed key revocation notice
     const revocationNotice = createSignedRevocationNotice(
       {
         keyId: revokedKeyId,
         reason: "Private signing key compromise incident.",
         supersededByKeyId: uncompromisedKey.keyId,
       },
       uncompromisedKey,
     );

     const revocationCheck = verifySignedRevocationNotice(revocationNotice, trustedKeys);
     if (!revocationCheck.valid) {
       throw new Error(`Signed revocation notice validation failed: ${revocationCheck.reason}`);
     }

     const revocationPath = path.join(distDir, "key-revocation-notice.json");
     fs.writeFileSync(revocationPath, JSON.stringify(revocationNotice, null, 2) + "\n");
     console.log(`✅ Verified and wrote signed revocation notice to ${revocationPath}`);
   '
   ```
2. Publish emergency signed notices and freeze metadata to distribution channels:
   ```bash
   # Upload signed freeze and revocation notices to distribution CDN / S3 bucket
   aws s3 cp dist/incident-freeze-plan.json s3://dist.resin.sh/releases/v1/incident-freeze-plan.json --cache-control "no-cache, no-store, must-revalidate"
   aws s3 cp dist/key-revocation-notice.json s3://dist.resin.sh/releases/v1/key-revocation-notice.json --cache-control "no-cache, no-store, must-revalidate"

   # Update channels.json on distribution CDN to freeze stable channel
   aws s3 cp dist/channels-frozen.json s3://dist.resin.sh/releases/v1/channels.json --cache-control "no-cache, no-store, must-revalidate"

   # Attach signed incident freeze plan and key revocation notice to GitHub Release
   gh release upload v1.0.0 dist/incident-freeze-plan.json dist/key-revocation-notice.json -R Resin-AI/resin --clobber
   ```

### 5.3 Step 3: Release Deprecation (T+30m - T+1h)
1. **GitHub Releases**:
   - Update release notes and tag advisory:
     ```bash
     gh release edit v1.0.0 -R Resin-AI/resin --title "[REVOKED - DO NOT USE] Release v1.0.0" --notes "CRITICAL SECURITY ADVISORY: The release signing key for this version has been revoked. Do not download or execute these artifacts."
     ```

### 5.4 Step 4: Codebase Revocation & Emergency Key Ingestion (T+1h - T+2h)

1. Add the compromised `keyId` to `REVOKED_RELEASE_KEY_IDS` in:
   - `scripts/release-trust.mjs`
   - `apps/cli/src/installer/channel-verifier.ts`
2. Generate emergency `Key C` (`resin-release-2026c`) following Section 3.
3. Configure `Key C` in GitHub `production` environment and Infisical:
   ```bash
   gh variable set RESIN_RELEASE_KEY_ID -R Resin-AI/resin -e production --body "resin-release-2026c"
   gh variable set RESIN_RELEASE_PUBLIC_KEY_PEM -R Resin-AI/resin -e production < resin-release-2026c-public.pem
   gh variable set RESIN_RELEASE_ADDITIONAL_TRUSTED_KEYS_JSON -R Resin-AI/resin -e production --body "[]"
   gh secret set RESIN_RELEASE_PRIVATE_KEY_PEM -R Resin-AI/resin -e production < resin-release-2026c-private.pem
   ```
4. Re-enable release workflow and publish emergency patch release (e.g. `v1.0.3`):
   ```bash
   gh workflow enable release.yml -R Resin-AI/resin
   ```

### 5.5 Step 5: User & Client Recovery Guidance

Users on compromised versions who encounter signature validation failures can bootstrap using the emergency root public key identity record:

```bash
export RESIN_TRUSTED_RELEASE_PUBLIC_KEYS='[{"keyId":"resin-release-2026c","publicKeyHex":"<64-hex-public-key-of-Key-C>"}]'
curl -fsSL https://get.resin.sh | bash
```

Emergency overrides require explicit key identity records (`keyId` and `publicKeyHex`) formatted as a strict JSON array; raw string keys, blank strings, and comma lists fail closed to guarantee that channel and manifest verifiers preserve verified key identities.

---

## 6. Rehearsal & Verification Drill (Non-Production Qualification)

To validate key rotation, revocation, and cryptographic verification without modifying production secrets or deploying live artifacts, execute this non-production drill.

### 6.1 Key Rotation & Trust Verification Test Suite (Vitest)

Run the automated Vitest test selections covering release trust, key separation, active-first rotation, revocation notices, and channel verifier rules:

```bash
# Execute full release trust, key separation, rotation, and revocation test suite
pnpm exec vitest run scripts/verify-release.test.mjs -t "Release Trust, Key Separation, Expiry & Signed Freeze/Rollback Plans"

# Execute dual-root bridge rotation verification test
pnpm exec vitest run scripts/verify-release.test.mjs -t "loads active-first bridge roots from additional trusted keys JSON and supports dual-root rotation verification"

# Execute signed revocation notice and tampering verification test
pnpm exec vitest run scripts/verify-release.test.mjs -t "creates, cryptographically signs, and verifies key revocation notices with tamper rejection"

# Execute client channel verifier key rotation & active-first ordering tests
pnpm exec vitest run apps/cli/tests/installer/signed-channel-verifier.test.ts -t "Channel metadata verification"
```

### 6.2 Packaging & Verification Drill (`pnpm release:package:test` & `pnpm release:verify:test`)

Execute local test-mode packaging and verification using the workspace npm scripts:

```bash
# Step 1: Clean build environment and ensure clean working tree
git status
rm -rf dist/

# Step 2: Build project artifacts
pnpm build

# Step 3: Package release in test-only mode (uses ephemeral test signing key)
pnpm release:package:test

# Step 4: Run full cryptographic verification against the packaged test release
pnpm release:verify:test
```

### 6.3 Expected Drill Outputs & Real Failure Rule Names

- **Evidence Path**: `dist/release/v1.0.0/release-evidence.json` generated and populated with SHA-256 digests.
- **Expected Success Verification Output (`pnpm release:verify:test`)**:
  Verification must complete with exit code 0, displaying the success banner and reported counts for all verified artifacts and documentation files:
  ```text
  🔍 Verifying Resin V1.0.0 Release Artifacts & Documentation...
  📂 Release Directory: /.../dist/release/v1.0.0

  ✅ Release verification PASSED! All <platform-count> platform tarballs, signed manifest, SBOM, channel metadata, and <doc-count> documentation files verified.
  ```
- **Real Failure Rule Names & Remediation Reference**:
  When verification fails, `verifyRelease` emits structured violations (`[RULE_NAME] file: message`). The real failure rule names defined in `scripts/verify-release.mjs` include:

  | Violation Rule Name                           | Cause / Trigger Condition                                                                        | Remediation Action                                                                |
  | :-------------------------------------------- | :----------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------- |
  | `UNKNOWN_SIGNING_KEY`                         | Manifest signature `keyId` does not match any configured trusted release key                     | Verify `RESIN_RELEASE_KEY_ID` / `RESIN_RELEASE_PUBLIC_KEY_PEM` matches signer     |
  | `REVOKED_SIGNING_KEY`                         | Manifest signature `keyId` is present in `REVOKED_RELEASE_KEY_IDS`                               | Rotate to an active, uncompromised release signing key                            |
  | `SIGNATURE_VERIFICATION_FAILED`               | Ed25519 signature payload mismatch or cryptographic verification failed                          | Verify artifact integrity and confirm private/public keypair match                |
  | `TEST_EVIDENCE_NOT_ALLOWED`                   | Test-only evidence or test signing keys detected during production verification (`--production`) | Re-run evidence qualification and packaging in full production mode               |
  | `MANIFEST_EXPIRED`                            | Manifest `expiresAt` timestamp is in the past                                                    | Re-package and re-sign release with fresh timestamp                               |
  | `MANIFEST_COMMIT_MISMATCH`                    | Manifest `releaseIdentity.commitSha` does not match expected commit SHA                          | Build and sign release from exact commit SHA                                      |
  | `MISSING_ARTIFACT`                            | Expected platform tarball or metadata file is absent from `dist/release/v1.0.0/`                 | Ensure build and packaging steps completed without error                          |
  | `DIGEST_MISMATCH`                             | Calculated SHA-256 digest of artifact does not match manifest                                    | Verify build reproducibility and artifact integrity                               |
  | `MISSING_EVIDENCE_JSON`                       | `release-evidence.json` missing from `dist/release/v1.0.0/`                                      | Execute release packaging (`pnpm release:package:test` or `pnpm release:package`) |
  | `EVIDENCE_DIGEST_MISMATCH`                    | `release-evidence.json` digest does not match manifest evidence binding                          | Re-run release packaging before verification                                      |
  | `BROKEN_DOC_LINK` / `MISSING_DOC_LINK_TARGET` | Relative Markdown documentation links contain broken anchors or missing targets                  | Fix broken Markdown links before release verification                             |

- **Cleanup**:
  ```bash
  rm -rf dist/
  ```

---

## 7. Production Manifest Verification Commands & Pass/Fail Criteria

Before promoting any release, the verification suite must be executed in `--production` mode.

### 7.1 Operator Verification Commands

```bash
# Standard interactive production verification
pnpm release:verify --production

# Machine-readable JSON output for automated audit recording
pnpm release:verify --production --json

# Standalone qualification unit & integration suite
pnpm release:test
```

### 7.2 Pass / Fail Gate Criteria

| Verification Check                   | Tool / Function                              | Acceptance Gate                                                          |
| :----------------------------------- | :------------------------------------------- | :----------------------------------------------------------------------- |
| **Release Directory Existence**      | `verifyReleaseFiles`                         | Must exist at `dist/release/v1.0.0`                                      |
| **Root Legal Files**                 | `verifyReleaseFiles`                         | `LICENSE`, `SECURITY.md`, `README.md` must be present and non-empty      |
| **Platform Artifacts**               | `verifyReleaseFiles`                         | All 5 platform `.tar.gz` and `.zip` files present and non-empty          |
| **Manifest Schema & Signatures**     | `verifyManifestSignatures`                   | Valid Ed25519 signature matching active production trusted keys          |
| **Manifest Commit Binding**          | `verifyManifestCommit`                       | Bound commit SHA matches qualified `main` commit SHA                     |
| **Asset & Package Digest Integrity** | `verifyAssetDigests`, `verifyPackageDigests` | 100% SHA-256 match between disk files and signed manifest digests        |
| **CycloneDX 1.5 SBOM**               | `verifySbom`                                 | Valid CycloneDX JSON schema, correct metadata, all 15 components present |
| **License Compliance**               | `verifySbom`                                 | 100% approved licenses (`MIT`, `Apache-2.0`, `BSD-3-Clause`, `ISC`)      |
| **Release Channels**                 | `verifyChannels`                             | Valid schema, `minSupportedVersion: "0.1.0"`, valid rollback pointer     |
| **Markdown Links**                   | `verifyDocLinks`                             | 0 broken relative cross-document links                                   |

---

## Related Documentation

- [Release Evidence Trace](release-evidence.md)
- [Client & Cloud Rollback Procedures](rollback-procedure.md)
- [Release Notes](v1.0.3-release-notes.md)
- [Cross-Component Compatibility Matrix](compatibility-matrix.md)
- [Security & Privacy Guide](../user/security-and-privacy.md)
