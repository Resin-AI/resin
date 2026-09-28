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

- **Secret & Token Redaction**: Scans for JWTs, Bearer tokens, GitHub PATs, AWS access keys, Anthropic/OpenAI API keys, private key headers, credential assignments including secret-named variables (`DB_PASS=V`, `GH_TOKEN=V`), passwords passed as command-line arguments (`--password V`, `--token=V`, `sshpass -p V`, `docker login -p V`, `redis-cli -a V`, `mysql -pV`), URL userinfo passwords (`postgres://u:V@h`, `redis://:V@h`), `Authorization:` credentials (`Basic`, `Bearer`, `token`), secret-named headers (`X-Api-Key: V`, `DD-API-KEY: V`, `X-Auth-Token: V`), HTTP client credentials (`curl -u user:V`, `wget --user user:V`, `http -a user:V`), JSON-quoted credential keys (`{"password": "V"}`), `.netrc` passwords, and `Cookie`/`Set-Cookie` values. The upload validator refuses any payload where one of these slots still holds a literal value.
- **Environment Values**: Values of the default secret variables and of every secret-named variable (`*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_API_KEY`, `DATABASE_URL`, ...) in the redacting environment are replaced by `[REDACTED_ENV:<NAME>:<tag>]`.
- **Path & Username Redaction**: Normalizes local file paths (e.g. `/Users/alice/projects/app` → `~/app`) to prevent username leakage.
- **High-Entropy Filtering**: Filters unstructured high-entropy strings exceeding Shannon entropy thresholds, except path-shaped values (contain `/` and one of `.`, `-`, `_`; none of `@`, `:`, `=`, `+`; every run between `/ . - _` at most 12 characters). Named-secret patterns still scan those. Entropy is also scored against each alphabet's ceiling: 32+ character hex runs are redacted unless they are git object names or content digests in their ordinary setting (a git command, `commit <sha>` output, a checksum tool or `<digest>  <file>` line, a `sha256:`-style label, or a path or file name around it such as `build-<sha>.log`); UUIDs are redacted after a secret label (`token`, `key`, `secret`, ...); 16-64 character base62 runs with all three character classes, near-maximal entropy and frequent class switches are redacted as short keys.
- **Placeholder Tags**: Each placeholder (`[REDACTED_<TYPE>:<tag>]`) carries a 16-hex HMAC-SHA256 tag under a random per-device key (`<data>/private-values/redaction-key`, mode 0600) that never leaves the device (a key file that is not a 0600 regular file owned by the user, or has the wrong size, is replaced with a fresh key after a warning), so an uploaded tag cannot confirm a guessed secret or link one secret across devices. Placeholders written by older versions with unkeyed tags remain in the local private store and still resolve.

### Metadata-only evidence: what the cloud receives per event

The default `metadata-only` redaction strategy is a deterministic projection, not a filter. Every uploaded event is rebuilt from an allowlist of operational fields; nothing else is copied. Most normalized fields use a value-free vocabulary (`apps/observer/src/analytics/evidence-normalization.ts`). Recorded-program source projections and native command lines are explicit exceptions: their engine-redacted views preserve non-secret code and literal values.

| Event | Kept verbatim | Normalized on device | Dropped |
|---|---|---|---|
| `message`, `model_reasoning` | role, model, token/usage metrics | — | all text |
| `tool_call` (shell tools such as `bash`) | tool name | `command` → command profile: executable basename, leading subcommand words for a fixed executable allowlist (`git`, `pnpm`, `cargo`, …), flag names, shell operators; every other argument becomes a typed placeholder (`$STR`, `$PATH`, `$SRC_FILE`, `$TEST_FILE`, `$URL`, `$NUM`, `$GLOB`); `cwd` → path pattern | quoted strings, environment values, heredoc bodies, all other parameters |
| `tool_call` (file tools such as `read`, `write`, `edit`, `grep`) | tool name | `path`-like parameters → path pattern: home directory removed, at most the last 4 segments, hash/UUID/timestamp/version segments replaced by `*` | file contents, patches, search patterns, all other parameters |
| `tool_call` (recorded JavaScript, TypeScript, or Python program; a built-in shell tool's command: Codex `exec`/`exec_command`, OMP `bash`, Claude Code `Bash`, OpenCode `bash`, Cursor `Shell`/`run_terminal_cmd`, Copilot CLI `bash`, Pi `bash`) | tool name | program source or command → engine-redacted, canonical-token-aligned view; local original → opaque `sourceReference`; changed token indexes → `protectedTokens` | original private source and store entries; the shell call's cwd, environment, timeout, description and other parameters; source without trusted scanning, complete parsing, or token alignment |
| `tool_call` (everything else) | tool name | parameter *shape* only (key names and primitive types) | all values |
| `tool_result` | tool name, error flag, duration, output size | incomplete or unverified result → value-free suppression flag | result body, raw native outcome metadata |
| `command_exec` | exit code, duration | `command` → command profile (as above); the command line (a `bash -c`/`-lc` launcher's script, unwrapped) → engine-redacted naming text (`resinCommandTextV1`): secrets scrubbed, home directory → `~`, at most 2,000 characters, omitted when the redaction policy keeps `command` local | cwd, stdout, stderr, arguments outside the command line |
| `file_edit` | operation, before/after hashes, diff line counts | `filePath` → path pattern | patch |
| `error` | error type, recoverable flag | — | message, stack, details |

The suppression marker (`__resinLocalWorkflowResultSuppressedV1: true`) survives metadata-only persistence so reloaded events cannot turn an incomplete result into a successful baseline. It carries no output, source, or native error text.

A projected program template carries both `sourceReference` and `protectedTokens` alongside its redacted literal `source`; the callable's source mirrors that view. The reference is declared in `privateReferences` and resolves to the complete original in the local workspace's private store. Runtime binding and program identity resolve and align the original before using canonical token indexes. Missing or non-string originals, changed alignment, or bindings to protected tokens fail closed: the scrubbed view is never an executable fallback. A shell command is projected only for an agent's built-in shell tool, proven by the harness decoder's local-only source-interface marker (stripped before upload); a same-named tool from an MCP server stays opaque.

Examples: `git commit -m "fix auth bug" && pnpm test src/auth/login.test.ts` uploads as `git commit -m $STR && pnpm test $TEST_FILE`; `/home/alice/work/repo/src/auth/login.ts` uploads as `…/repo/src/auth/login.ts`. These command/path profiles disclose tool, flag, file, and directory names without their argument values. Recorded-program projections additionally disclose redacted code and non-secret literal values. A native command such as `bash -lc 'mysql -pS3cret -e "select 1" && python3 check.py'` additionally uploads its engine-redacted line, `mysql -p[REDACTED_CREDENTIAL:…] -e "select 1" && python3 check.py`; the cloud sends that text to the configured model provider to name and describe tools learned from the command. Raw prompts, outputs, original private source, and private store entries remain local. `redaction.redactionStrategy` records whether sensitive fields were `drop`ped or normalized (`mask`).

A learned tool's optional parameters are named from structure only: a long flag's name (`--month` → `month`) or a role inferred from the recorded value's shape (`data_path`, `archive_path`, `file_path`, `date`, `number`, `text`, …). The value is never uploaded; its token position is, and an omitted parameter re-runs the recorded text from the local private store.

Workflow validation compares plans with recordings on the device. At capture the recorder also stores, locally only, a per-call identity entry (callable name, connection, program kind/argument, argument names) under a reference the device computes itself; it is never uploaded. Plans and held-out carriers identify recorded calls only by step ids and harness call ids (`callId`, and `heldOut.calls: [{stepId, callIds}]`, one call id per iteration when the demonstration ran once per item), which cross the boundary as before; recorded values, commands and outputs do not. Validation decisions carry only step ids, verdicts, fixed reason strings and `verification.replay = { kind: "recording", planDigest }`.

---

## 5. Configured Subprocessors & Consent Boundaries

Resin transmits data only to third-party services configured and necessary for hosting, authentication, or user-selected model execution.

| Subprocessor / Service | Purpose | Data Transmitted | Hosting Location / Configuration | Consent Boundary |
|---|---|---|---|---|
| **Google Identity Services** | Single Sign-On / Authentication | OpenID profile, email, authentication tokens | Global / US | Consented at user sign-in |
| **GitHub OAuth** | Code repository identity & auth | GitHub user ID, username, email | Global / US | Consented at account linking |
| **Model Inference Providers** (e.g. OpenRouter, OpenAI, Anthropic) | Model evaluation, tool synthesis, and learned-tool naming | Sanitized prompts, structural capability schemas, engine-redacted recorded-program views and command lines (no raw session files) | Selected per environment configuration | Consented on running evolution/synthesis tasks |
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
