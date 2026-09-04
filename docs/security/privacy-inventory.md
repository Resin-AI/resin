# Privacy Data Inventory & Data Lifecycle

This document defines the data inventory, classifications, storage boundaries, retention periods, lifecycle state transitions, and configured subprocessor boundaries for Resin.

---

## 1. Data Classification and Storage Boundaries

Resin enforces a strict local-first architecture: raw interactive coding agent sessions remain on the local developer machine, while only sanitized, allowlisted observation and evidence records are synced to the cloud service.

| Data Category | Data Elements | Classification | Storage Location | Retention & Lifecycle | Cloud Transmission |
|---|---|---|---|---|---|
| **Local Raw Sessions** | Raw user prompts, assistant reasoning / thoughts, raw tool calls, local source files | Highly Confidential | Local filesystem (`~/.resin/state/local.db` or configured local path) | Retained per local retention policy (default 30 days, auto-pruned); local purge on workspace deletion or CLI clear | ❌ **Never** (remains local) |
| **Sanitized Cloud Evidence** | Allowlisted tool invocation metadata, sanitized execution metrics, structural capability profiles, verification digests | Confidential | Cloud Database / Object Storage | Retained per workspace policy (default 90 days); deleted upon user/workspace deletion | ✅ Allowlisted and redacted evidence only |
| **Account & Identity** | User identifier, email address, display name, OAuth provider link metadata (Google, GitHub), profile image URL | Confidential | Cloud Auth Database | Active account lifetime; retained during legal hold; hard-deleted upon account deletion | ✅ Authentication & Console management |
| **Workspace & Project Metadata** | Workspace ID, project root hash, repo slug, member role bindings | Internal | Cloud Database | Active workspace lifetime; transferred or purged upon workspace deprovisioning | ✅ Workspace collaboration |
| **Credentials & Auth Tokens** | Device session tokens, OAuth refresh tokens, API keys | Restricted | OS Keyring / Local Vault / Encrypted Auth DB | Active session lifetime; immediate revocation on `logout` / token expiry; separate from durable data deletion | ❌ Provider secret tokens never stored; session tokens encrypted |
| **Diagnostic & Operational Logs** | Redacted error diagnostics, client crash stack traces | Internal / Diagnostics | Cloud Logging (optional opt-in) | 30 days rolling retention | ✅ Redacted diagnostics only |

---

## 2. Personal vs. Workspace Visibility

1. **Personal Account Data**:
   - Identity records, individual device pairings, personal linked accounts, and default workspace assignments are owned by the authenticated user.
   - Credential revocation or personal profile updates do not alter team workspace history.
2. **Workspace & Shared Data**:
   - Sanitized tool candidates, qualified compiled tools, activation history, and shared project metadata belong to the workspace.
   - When a user leaves a workspace or deletes their personal account, shared workspace tools and activation records remain associated with the workspace under the workspace retention policy, unless explicitly requested for team-wide deletion by a workspace owner.

---

## 3. Privacy Lifecycle & State Transitions

Resin manages data through explicit state transitions for revocation, export, retention pruning, legal holds, shared-data transfer, and deletion:

```text
[ Active Data ] ───► [ Export Requested ] ───► [ Export Bundle Generated ] ───► [ Downloaded / Expired ]
       │
       ├──────────────► [ Retention Expiry ] ───► [ Soft-Deleted / Marked ] ───► [ Hard-Purged ]
       │                                                    ▲
       ├──────────────► [ Deletion Requested ] ─────────────┤ (Blocked if Legal Hold Active)
       │                                                    │
       ├──────────────► [ Legal Hold Applied ] ─────────────┴─► [ Retained Until Hold Released ]
       │
       └──────────────► [ Workspace Transfer ] ───► [ Reassigned Ownership / Cleaned from Source ]
```

### State Definitions

- **Credential Revocation vs. Durable Deletion**:
  - `logout` or device disconnect immediately invalidates session tokens and purges local encryption keys from the OS vault.
  - Revoking credentials halts new synchronizations but does not delete previously stored historical evidence or qualified tools until an explicit deletion request is executed.
- **Export (`pending` → `processing` → `ready` | `failed` → `expired`)**:
  - Exports package account metadata, workspace memberships, and sanitized cloud evidence into a downloadable archive.
  - Export packages expire and are automatically purged after 7 days.
- **Durable Deletion (`requested` → `pending_purge` → `purged`)**:
  - Deletes user account records, credentials, and user-scoped cloud evidence across databases and object stores.
  - Triggers local cleanup notifications for CLI daemons to remove local caches and state databases.
- **Legal Hold (`active` → `released`)**:
  - Overrides automated retention pruning and deletion jobs, preserving designated records in immutable storage until the legal hold is formally released.
- **Shared Data Transfer (`transfer_pending` → `transferred` | `orphaned_cleanup`)**:
  - On workspace member removal, team-owned tool qualifications and historical metrics are either transferred to an active workspace admin or transitioned to organization-owned records.

---

## 4. Real-Time Redaction & Local Sanitization

Before any event or diagnostic metadata is written to cloud storage or diagnostic bundles:

- **Secret & Token Redaction**: Scans for JWTs, Bearer tokens, GitHub PATs, AWS access keys, Anthropic/OpenAI API keys, and private key headers.
- **Path & Username Redaction**: Normalizes local file paths (e.g. `/Users/alice/projects/app` → `~/app`) to prevent username leakage.
- **High-Entropy Filtering**: Filters unstructured high-entropy strings exceeding Shannon entropy thresholds.

### Metadata-only evidence: what the cloud receives per event

The default `metadata-only` redaction strategy is a deterministic projection, not a filter. Every uploaded event is rebuilt from an allowlist of operational fields; nothing else is copied. Fields marked *normalized* are replaced on-device by a value-free form drawn from a finite vocabulary before upload (`apps/observer/src/analytics/evidence-normalization.ts`).

| Event | Kept verbatim | Normalized on device | Dropped |
|---|---|---|---|
| `message`, `model_reasoning` | role, model, token/usage metrics | — | all text |
| `tool_call` (shell tools such as `bash`) | tool name | `command` → command profile: executable basename, leading subcommand words for a fixed executable allowlist (`git`, `pnpm`, `cargo`, …), flag names, shell operators; every other argument becomes a typed placeholder (`$STR`, `$PATH`, `$SRC_FILE`, `$TEST_FILE`, `$URL`, `$NUM`, `$GLOB`); `cwd` → path pattern | quoted strings, environment values, heredoc bodies, all other parameters |
| `tool_call` (file tools such as `read`, `write`, `edit`, `grep`) | tool name | `path`-like parameters → path pattern: home directory removed, at most the last 4 segments, hash/UUID/timestamp/version segments replaced by `*` | file contents, patches, search patterns, all other parameters |
| `tool_call` (everything else) | tool name | parameter *shape* only (key names and primitive types) | all values |
| `tool_result` | tool name, error flag, duration, output size | — | result body |
| `command_exec` | exit code, duration | `command` → command profile (as above) | args, cwd, stdout, stderr |
| `file_edit` | operation, before/after hashes, diff line counts | `filePath` → path pattern | patch |
| `error` | error type, recoverable flag | — | message, stack, details |

Examples: `git commit -m "fix auth bug" && pnpm test src/auth/login.test.ts` uploads as `git commit -m $STR && pnpm test $TEST_FILE`; `/home/alice/work/repo/src/auth/login.ts` uploads as `…/repo/src/auth/login.ts`. The residual disclosure is which command-line tools, flags, file names and directory names a workspace uses—comparable to a dependency manifest—and never prompt text, code, output, or argument values. `redaction.redactionStrategy` on each uploaded event records whether its sensitive fields were `drop`ped or normalized (`mask`).

---

## 5. Configured Subprocessors & Consent Boundaries

Resin transmits data only to third-party services configured and necessary for hosting, authentication, or user-selected model execution.

| Subprocessor / Service | Purpose | Data Transmitted | Hosting Location / Configuration | Consent Boundary |
|---|---|---|---|---|
| **Google Identity Services** | Single Sign-On / Authentication | OpenID profile, email, authentication tokens | Global / US | Consented at user sign-in |
| **GitHub OAuth** | Code repository identity & auth | GitHub user ID, username, email | Global / US | Consented at account linking |
| **Model Inference Providers** (e.g. OpenRouter, OpenAI, Anthropic) | Model evaluation & tool synthesis | Sanitized prompts, structural capability schemas (no raw session files) | Selected per environment configuration | Consented on running evolution/synthesis tasks |
| **Cloud Storage Provider** (Configured S3-compatible / MinIO) | Cloud evidence & artifact store | Encrypted sanitized evidence bundles, qualified tool binaries | Configured deployment region | Required for cloud workspace synchronization |

*Note: Enterprise or self-hosted deployments may substitute or disable external cloud subprocessors entirely.*

---

## 6. Support & Security Ownership

- **General Support & Privacy Requests**: `hello@resin.sh`
- **Security & Vulnerability Disclosures**: `hello@resin.sh`
- **Operational Status**: Operational procedures, subprocessor controls, and disaster recovery processes are maintained per documented engineering runbooks.

---

## Related Documentation

- [Support Policy](support-policy.md)
- [Security Threat Model](threat-model.md)
- [Vulnerability Reporting](vulnerability-reporting.md)
- [User Security & Privacy Model](../user/security-and-privacy.md)
