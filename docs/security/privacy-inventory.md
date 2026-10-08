# Privacy Data Inventory & Data Lifecycle

This document defines the data inventory, classifications, storage boundaries, retention periods, lifecycle state transitions, and configured subprocessor boundaries for Resin.

---

## 1. Data Classification and Storage Boundaries

Resin enforces a strict local-first architecture: raw interactive coding agent sessions remain on the local developer machine, while only sanitized, allowlisted observation and evidence records are synced to the cloud service.

| Data Category | Data Elements | Classification | Storage Location | Retention & Lifecycle | Cloud Transmission |
|---|---|---|---|---|---|
| **Local Raw Sessions** | Raw user prompts, assistant reasoning / thoughts, raw tool calls, local source files | Highly Confidential | Local filesystem (`~/.resin/state/local.db` or configured local path) | Retained per local retention policy (default 30 days, auto-pruned); local purge on workspace deletion or CLI clear | ❌ **Never** (remains local) |
| **Local Private Values** | Exact argument values, results, and per-call details the workflow recorder keeps so learned tools can replay and validation can compare locally; a value index of keyed digests (HMAC under the device redaction key) of recorded argument values, so a value an agent restates in a Resin `invoke_tool` call is uploaded as a private reference, never as its text; a value recorded in its redacted form also keeps the originals of its redaction placeholders in its own entry, so it resolves for as long as the entry is kept, independent of the bounded legacy placeholder cache (`<data>/private-values/private-values.json`, newest 4096 aliases) | Highly Confidential | Local filesystem (`<data>/private-values/entries-v2/<shard>/<sha256>.json` and `<data>/private-values/value-index-v1/<shard>/<hmac>`, owner-only) | The daemon deletes entries that no stored tool, recorded workflow, or daemon state file (validation ask ledger, cached tool catalog) names once they are 14 days old; re-recording a value refreshes its age; named entries are never deleted. Index markers are deleted once 14 days pass without the value being recorded or read back. Stored tools that neither a served catalog nor a known project lock has named for 7 days are deleted, and with them their claim on the values they name | ❌ **Never** (remains local; uploads carry only opaque references) |
| **Sanitized Cloud Evidence** | Allowlisted tool invocation metadata, sanitized execution metrics, structural capability profiles, verification digests | Confidential | Cloud Database / Object Storage | Session event records, finished generation attempt records, and temporary upload copies are deleted 90 days after the cloud stores them, unless protected (see §3 *Cloud Evidence Retention*); records kept longer are deleted upon user/workspace deletion or a deletion request | ✅ Allowlisted and redacted evidence only |
| **Account & Identity** | User identifier, email address, display name, OAuth provider link metadata (Google, GitHub), profile image URL | Confidential | Cloud Auth Database | Active account lifetime; retained during legal hold; hard-deleted upon account deletion | ✅ Authentication & Console management |
| **Workspace & Project Metadata** | Workspace ID, project root hash, repo slug, member role bindings | Internal | Cloud Database | Active workspace lifetime; transferred or purged upon workspace deprovisioning | ✅ Workspace collaboration |
| **Credentials & Auth Tokens** | Device session tokens, OAuth refresh tokens, API keys | Restricted | OS Keyring / Local Vault / Encrypted Auth DB | Active session lifetime; immediate revocation on `logout` / token expiry; separate from durable data deletion | ❌ Provider secret tokens never stored; session tokens encrypted |
| **Diagnostic & Operational Logs** | Redacted error diagnostics, client crash stack traces | Internal / Diagnostics | Cloud Logging (optional opt-in) | 30 days rolling retention | ✅ Redacted diagnostics only |
| **Error Reports & Usage Events** | Sanitized error type/message and stack frames (file:line:column after path rewriting), Resin error code/failure class, handled/fatal flag; usage events (command name path, exit code, duration, install/pairing/daemon lifecycle, update check/deferral/install/failure outcomes with versions and fixed codes, tool id/version/status/duration of failed invocations, daily learned-tool discovery counts (`discovery_funnel_daily`: a UTC date and integer counts only), user-typed `resin feedback` text); Resin version, surface, environment, OS, architecture, Node.js version; anonymous install id or cloud user id, account/workspace ids | Internal / Diagnostics | PostHog (US cloud) via the first-party proxy `https://resin.sh/ingest` | PostHog project retention (see §5); deleted with the person on account deletion requests | ✅ On by default; off with `DO_NOT_TRACK=1`, `RESIN_ERROR_REPORTING=0`, `resin privacy error-reporting disable` or `resin privacy telemetry disable` |

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
- **Cloud Evidence Retention (90 days)**:
  - Deleted 90 days after the cloud stores them: privacy-projected session event records, records of finished tool-generation attempts that a newer generation has replaced, temporary copies of large uploads made while they are processed, and detected workflow opportunities that have not been updated within the window and are not behind an active tool candidate.
  - Kept longer, until you delete the workspace or account or request deletion:
    - Records that an upload batch was received, used to prevent the same batch from being processed twice.
    - The evidence behind tools you have published or that are still in progress, so their provenance stays complete; it returns to the 90-day policy once the tool is retired or deleted.
    - Small index records for an evidence set: which session events it contains (event identifiers, content fingerprints and their order), plus the set's name, description and descriptive metadata. They don't contain the events themselves, which expire as described above unless protected.
    - Archived copies of uploaded batches.
  - A legal hold keeps everything it covers, regardless of age, until it is released.
  - Age-based expiry does not change deletion requests: deleting an account or workspace, or requesting deletion, removes the data on its own schedule regardless of age.
  - Once events have expired, cloud counts and drilldowns cover only retained events, and corrections to expired events are no longer possible.
  - Local retention is unchanged (see *Local Raw Sessions* above).
- **Shared Data Transfer (`transfer_pending` → `transferred` | `orphaned_cleanup`)**:
  - On workspace member removal, team-owned tool qualifications and historical metrics are either transferred to an active workspace admin or transitioned to organization-owned records.

---

## 4. Real-Time Redaction & Local Sanitization

Before any event or diagnostic metadata is written to cloud storage or diagnostic bundles:

- **Secret & Token Redaction**: Scans for JWTs, Bearer tokens, GitHub PATs, AWS access keys, Anthropic/OpenAI API keys, private key headers, credential assignments including secret-named variables (`DB_PASS=V`, `GH_TOKEN=V`), passwords passed as command-line arguments (`--password V`, `--token=V`, `sshpass -p V`, `docker login -p V`, `redis-cli -a V`, `mysql -pV`), URL userinfo passwords (`postgres://u:V@h`, `redis://:V@h`), `Authorization:` credentials (`Basic`, `Bearer`, `token`), secret-named headers (`X-Api-Key: V`, `DD-API-KEY: V`, `X-Auth-Token: V`), HTTP client credentials (`curl -u user:V`, `wget --user user:V`, `http -a user:V`), JSON-quoted credential keys (`{"password": "V"}`), `.netrc` passwords, and `Cookie`/`Set-Cookie` values. Windows PowerShell and cmd.exe forms redact the whole value, quoted spaces and here-string lines included: `$env:GH_TOKEN = 'V'`, `${env:DB_PASSWORD}="V"`, `$apiKey = @'<lines>'@` (any secret-named variable, with an optional `env:`/`global:`/`script:` scope), `Set-Item Env:GH_TOKEN V`, `Set-Item -Path Env:\GH_TOKEN -Value V`, `New-Item Env: -Name GH_TOKEN -Value V`, `[Environment]::SetEnvironmentVariable('GH_TOKEN', 'V')`, `set GH_TOKEN=V` (to the end of the command), `set "GH_TOKEN=V"`, `setx [/M] GH_TOKEN V`, the `/p` and `/rp` switches of `setx` and `schtasks`, `ConvertTo-SecureString V -AsPlainText` (with or without `-String`), a quoted string or here-string piped to `ConvertTo-SecureString -AsPlainText` or `--password-stdin`, and single-dash secret parameters (`-Password V`, `-Token:V`, `-ApiKey`, `-NuGetApiKey`, `-AccessToken`, `-ClientSecret`, ...). Overlapping matches merge into one placeholder, so no tail of a longer value survives. The upload validator refuses any payload where one of these slots still holds a literal value.
- **Environment Values**: Values of the default secret variables and of every secret-named variable (`*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_API_KEY`, `DATABASE_URL`, ...) in the redacting environment are replaced by `[REDACTED_ENV:<NAME>:<tag>]`. For a Windows session, variable names are looked up case-insensitively, as Windows resolves them; the value is replaced wherever it appears, while a reference to it (`%GH_TOKEN%`, `$env:GH_TOKEN`) is left as written.
- **Path & Username Redaction**: Normalizes local file paths (e.g. `/Users/alice/projects/app` → `~/app`) to prevent username leakage.
- **Windows Identity Redaction** (`apps/observer/src/normalization/windows-identity.ts`): runs after the environment and custom secret values, which may contain these names.
  - The current user's home (`os.homedir()`, `USERPROFILE`, `HOMEDRIVE`+`HOMEPATH`, `HOMESHARE`+`HOMEPATH`) becomes `$HOME` in every spelling: `\` or `/` separators, JSON-escaped `\\`, any drive-letter or name case, a `\\?\` or `\\?\UNC\` prefix, UNC shares, the Git Bash `/c/…` and WSL `/mnt/c/…` mounts, and the drive-less `\Users\<name>` that `%HOMEPATH%` expands to. A sibling whose name merely starts with the home's name is not matched.
  - Any other profile under `Users` or `Documents and Settings`, on any drive or share and in the same spellings, becomes `[REDACTED_USER_HOME:<tag>]` (profile root and name together, so a share's host goes too). `Public`, `Default`, `Default User`, `All Users` and `defaultuser0` and variable spellings (`C:\Users\%USERNAME%`) are kept. This applies to every session's content, not only Windows sessions.
  - The organization in a OneDrive for Business folder (`OneDrive - <organization>`) becomes `[REDACTED_ORGANIZATION:<tag>]`.
  - For a Windows session, the `USERNAME` (or the home's profile name), `USERDOMAIN`, `USERDNSDOMAIN` and `COMPUTERNAME` values become `[REDACTED_USERNAME:<tag>]`, `[REDACTED_DOMAIN:<tag>]` and `[REDACTED_HOSTNAME:<tag>]` wherever they stand as a whole word, case-insensitively. Values shorter than three characters and generic names (`admin`, `user`, `runner`, `WORKGROUP`, ...) are left alone.
  - Variable spellings of the home (`%USERPROFILE%`, `%HOMEDRIVE%%HOMEPATH%`, `$env:USERPROFILE`, `${env:USERPROFILE}`, `$HOME`, `~`) carry no identity and stay as written; the harness-introspection check (`packages/contracts/src/harness-introspection.ts`) treats all of them, and `[REDACTED_USER_HOME:<tag>]`, as a home when it looks for reads of `.resin`, `.codex`, `.omp` or `.claude`.
  - Nothing new leaves the machine on Windows: the same allowlisted projections apply, and these steps only remove text from them.
- **High-Entropy Filtering**: Filters unstructured high-entropy strings exceeding Shannon entropy thresholds, except path-shaped values (contain `/` or `\` and one of `.`, `-`, `_`; none of `@`, `:`, `=`, `+` once a leading drive (`C:`), `\\?\` prefix or variable (`$env:X`, `${env:X}`, `%X%`) is set aside; every run between `/ \ . - _` at most 12 characters). Named-secret patterns still scan those. Entropy is also scored against each alphabet's ceiling: 32+ character hex runs are redacted unless they are git object names or content digests in their ordinary setting (a git command, `commit <sha>` output, a checksum tool or `<digest>  <file>` line, a `sha256:`-style label, or a path or file name around it such as `build-<sha>.log` or `C:\cache\<md5>\x`); UUIDs are redacted after a secret label (`token`, `key`, `secret`, ...); 16-64 character base62 runs with all three character classes, near-maximal entropy and frequent class switches are redacted as short keys. Revision identifiers are not secrets: a hex value after a revision label that ends a name (`commit_sha=`, `HEAD_SHA=`, `--match-head-commit`, JSON `headSha`), a hex run that is one segment of a path (`repos/o/r/commits/<sha>/check-runs`), and a git revision argument on a git command line (`<rev>:<path>` such as `HEAD:src/a.ts`, `<rev>..<rev>`) stay, unless a secret label (`token`, `key`, `secret`, ...) precedes them. CI run IDs and pull-request or issue numbers are plain numbers and were never redacted. Credentials stay redacted in every setting: a hex token in an `Authorization` header, a `--token` flag, a secret-named variable or URL userinfo is still replaced.
- **Placeholder Tags**: Each placeholder (`[REDACTED_<TYPE>:<tag>]`) carries a 16-hex HMAC-SHA256 tag under a random per-device key (`<data>/private-values/redaction-key`, mode 0600) that never leaves the device (a key file that is not a 0600 regular file owned by the user, or has the wrong size, is replaced with a fresh key after a warning), so an uploaded tag cannot confirm a guessed secret or link one secret across devices. Placeholders written by older versions with unkeyed tags remain in the local private store and still resolve.

### Metadata-only evidence: what the cloud receives per event

The default `metadata-only` redaction strategy is a deterministic projection, not a filter. Every uploaded event is rebuilt from an allowlist of operational fields; nothing else is copied. Most normalized fields use a value-free vocabulary (`apps/observer/src/analytics/evidence-normalization.ts`). Recorded-program source projections and native command lines are explicit exceptions: their engine-redacted views preserve non-secret code and literal values.

| Event | Kept verbatim | Normalized on device | Dropped |
|---|---|---|---|
| `message`, `model_reasoning` | role, model, token/usage metrics | — | all text |
| `tool_call` (shell tools such as `bash`) | tool name | `command` → command profile: executable basename, leading subcommand words for a fixed executable allowlist (`git`, `pnpm`, `cargo`, …), flag names, shell operators; every other argument becomes a typed placeholder (`$STR`, `$PATH`, `$SRC_FILE`, `$TEST_FILE`, `$URL`, `$NUM`, `$GLOB`); a `$STR`/`$URL`/`$GLOB` argument's value is committed to only as an HMAC-SHA256 under the device redaction key (`parameterValueHmacSha256`), which the cloud never holds, so a guessed value cannot be confirmed; `cwd` → path pattern | quoted strings, environment values, heredoc bodies, all other parameters |
| `tool_call` (file tools such as `read`, `write`, `edit`, `grep`) | tool name | `path`-like parameters → path pattern: home directory removed, at most the last 4 segments, hash/UUID/timestamp/version segments replaced by `*` | file contents, patches, search patterns, all other parameters |
| `tool_call` (recorded JavaScript, TypeScript, or Python program; a built-in shell tool's command: Codex `exec`/`exec_command`, OMP `bash`, Claude Code `Bash`, OpenCode `bash`, Cursor `Shell`/`run_terminal_cmd`, Copilot CLI `bash`, Pi `bash`, Grok Build `run_terminal_command`) | tool name | program source or command → engine-redacted, canonical-token-aligned view; local original → opaque `sourceReference`; changed token indexes → `protectedTokens` | original private source and store entries; the shell call's cwd, environment, timeout, description and other parameters; source without trusted scanning, complete parsing, or token alignment |
| `tool_call` (everything else) | tool name | parameter *shape* only (key names and primitive types) | all values |
| `tool_result` | tool name, error flag, duration, output size | incomplete or unverified result → value-free suppression flag | result body, raw native outcome metadata |
| `command_exec` | exit code, duration | `command` → command profile (as above); the command line (a `bash -c`/`-lc` launcher's script, unwrapped) → engine-redacted naming text (`resinCommandTextV1`): secrets scrubbed, home directory → `~`, at most 2,000 characters, omitted when the redaction policy keeps `command` local | cwd, stdout, stderr, arguments outside the command line |
| `file_edit` | operation, before/after hashes, diff line counts | `filePath` → path pattern | patch |
| `error` | error type, recoverable flag | — | message, stack, details |

The suppression marker (`__resinLocalWorkflowResultSuppressedV1: true`) survives metadata-only persistence so reloaded events cannot turn an incomplete result into a successful baseline. It carries no output, source, or native error text.

**Working-directory identity** (`apps/observer/src/analytics/working-directory-identity.ts`). A call's working directory is never uploaded as text; `tool_call` and `command_exec` events instead carry `metadata.__resinWorkingDirectoryV1 = { directory, repository? }`, two 32-hex values the cloud can compare for equality and nothing else:

- `directory` identifies the call's effective working directory: its own working-directory argument (`cwd`, `workdir` or `workingDirectory`, read from the unredacted local original) resolved against its session's directory (the root of the workspace the harness recorded the session in), or the session's directory when the call names none. The path is normalized by path arithmetic only (`.`/`..`, trailing separators, `~`, `file:` URLs; Windows paths case-folded); nothing is read from disk for it.
- `repository` identifies the nearest enclosing directory holding a `.git` entry, found by checking this device's own filesystem for a path in its native form. No git command runs and nothing is fetched. It is computed in the same space as `directory`, so the two are equal exactly when the call ran at the repository root. It is absent when no repository is found.
- Each value is HMAC-SHA256 of the normalized absolute path, truncated to 128 bits, under a key derived (HMAC-SHA256 with the fixed label `resin:working-directory-identity:v1`) from the random per-device redaction key at `<data>/private-values/redaction-key` (mode 0600, owner-only). Neither the device key nor the derived key leaves the device, so the cloud cannot recover a path or confirm a guessed one, and the same directory on two installations yields unrelated values. Replacing the redaction key (see Placeholder Tags) changes every identity afterwards.
- A call whose directory cannot be established (a relative or absent directory with no known session directory, or an event without its local original) carries no identity. A value a transcript supplies under the key is discarded, and the metadata-only projection copies only the exact two-field hex shape.

A projected program template carries both `sourceReference` and `protectedTokens` alongside its redacted literal `source`; the callable's source mirrors that view. The reference is declared in `privateReferences` and resolves to the complete original in the local workspace's private store. Runtime binding and program identity resolve and align the original before using canonical token indexes. Missing or non-string originals, changed alignment, or bindings to protected tokens fail closed: the scrubbed view is never an executable fallback. Each redacted value is replaced in place, inside the token holding it (`deploy-tool --api-key \[REDACTED_OPENAI_API_KEY:<tag>\] --region eu-west-1`), so the rest of the program stays readable: a bare word's placeholder is backslash-escaped so it stays a plain word, an entropy match that ran into a `;`, `|` or the backslash of a `\"` is cut to the tokens it covers (operators and whitespace are grammar, not values; every covered character of a value is replaced), and a token that cannot be redacted partly has its whole value replaced. An exact value (named credential, environment or custom secret, home path) that spans tokens or a quote delimiter, a view that would change any token's kind, quoting or bindability, and a view in which the engine still finds something to redact keep the whole program private. A shell command is projected only for an agent's built-in shell tool, proven by the harness decoder's local-only source-interface marker (stripped before upload); a same-named tool from an MCP server stays opaque.

Examples: `git commit -m "fix auth bug" && pnpm test src/auth/login.test.ts` uploads as `git commit -m $STR && pnpm test $TEST_FILE`; `/home/alice/work/repo/src/auth/login.ts` uploads as `…/repo/src/auth/login.ts`. These command/path profiles disclose tool, flag, file, and directory names without their argument values. Recorded-program projections additionally disclose redacted code and non-secret literal values. A native command such as `bash -lc 'mysql -pS3cret -e "select 1" && python3 check.py'` additionally uploads its engine-redacted line, `mysql -p[REDACTED_CREDENTIAL:…] -e "select 1" && python3 check.py`; the cloud sends that text to the configured model provider to name and describe tools learned from the command. Raw prompts, outputs, original private source, and private store entries remain local. `redaction.redactionStrategy` records whether sensitive fields were `drop`ped or normalized (`mask`).

A learned tool's optional parameters are named from structure only: a long flag's name (`--month` → `month`) or a role inferred from the recorded value's shape (`data_path`, `archive_path`, `file_path`, `date`, `number`, `text`, …). The value is never uploaded; its token position is, and an omitted parameter re-runs the recorded text from the local private store.

Learned-tool descriptions are built on the device for the recording workspace (`search_tools`, `get_tool_schema`, the native tool list and `manage_tools` listings). They are never uploaded, but they reach the model provider and the harness transcript, so they show no resolved private value. A projected program is shown as its redacted `source`; each other private value appears as a stable `<private:N>` placeholder, including a program kept wholly private and a harness tool's laundered arguments; caller values appear as `{name}`. Recorded parameter and dated-input values come from that same view, as does the refusal a call missing a dated input gets. As a second safeguard, the gateway replaces with `<private>` every private value of the tool's plan (4+ characters, plus each original token that a projection's redaction changed) wherever it appears in that text. Invocation is unchanged: it resolves the originals locally.

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
| **PostHog** (PostHog Inc., US cloud) | Error tracking and product usage analytics for the CLI, daemon, MCP gateway, installers and Resin Cloud | Error reports and usage events listed in §1 and §5.1. Never prompts, transcripts, tool inputs/outputs, source contents, command arguments, request/response bodies, headers, environment values, e-mail addresses or tokens | US; reached through `https://resin.sh/ingest` (override with `RESIN_POSTHOG_HOST`) | On by default with an easy opt-out (§5.1) |

*Note: Enterprise or self-hosted deployments may substitute or disable external cloud subprocessors entirely.*

### 5.1 Error Reports and Usage Events (PostHog)

The public client (`resin` CLI, `resin-daemon`, `resin-gateway` MCP shim, the automatic updater, `install.sh`, `install.ps1` and the install helper) sends error reports and a small set of usage events to PostHog so failures can be found and fixed.

- **What is sent**: for errors, the error type, a sanitized message (capped at ~1,000 characters) and up to 50 stack frames with file, line and column; a Resin error code or failure class when one exists; and whether the error was handled or crashed the process. Usage events are `cli_command_completed` (command and sub-command names only, exit code, duration), `daemon_started`/`daemon_stopped`, `install_started`/`install_completed`/`install_failed` (step, OS, architecture, exit code, a short sanitized reason), `init_completed`/`init_failed`, `pairing_completed`/`pairing_failed`, `tool_invocation_failed` (tool id, version, status, duration), the update events below, `credential_refresh_failed` (reason and HTTP status), `runtime_crash_recorded`, `discovery_funnel_daily` (below), and `feedback_submitted` (the text the user typed in `resin feedback`, sanitized and capped at 5,000 characters). Every event carries the Resin version, surface, environment, OS, architecture and Node.js version.
- **Update events** (the automatic updater reports as surface `updater`: the service's update timer and the out-of-service update worker; `resin upgrade` reports as `cli` with `trigger: manual`). Properties are versions, fixed codes, durations, counts and booleans only; never paths, URLs, host names or error text:
  - `update_check_completed`: `trigger` (`startup`, `scheduled`, `offline_retry`, `manual`), `outcome` (`up_to_date`, `update_available`, `offline`, `failed`, `skipped_disabled`, `skipped_window`, `blocked_quarantine`, `blocked_downgrade`), `current_version`, `available_version`, `channel`, `duration_ms`, and `suppressed_count` on rate-limited outcomes. Offline and skipped outcomes, and every offline-backoff retry, are sent at most once per outcome per six hours.
  - `update_deferred`: `trigger` (`auto`, `manual`), `reason` (`active_sessions`, `active_tool_executions`, `active_executions`, `in_flight_requests`, `activity_unknown`, `service_unavailable`, `maintenance_window`, `locked`), `current_version`, `target_version`, `deferral_count` (consecutive), `deferred_for_ms`. The first deferral of a target is sent, then at most one per hour.
  - `update_installed`: `trigger`, `from_version`, `to_version`, `channel`, `duration_ms` (worker or command start to healthy), `publish_to_install_ms` (from the signed release date), `deferral_count`.
  - `update_failed`: `trigger`, `stage` (`preflight`, `lock`, `launch`, `download`, `verify`, `stage`, `activate`, `restart`, `health_check`, `rollback`), `error_code` (an error code or class name), `from_version`, `target_version`, `channel`, `rolled_back`, `rollback_outcome` (`not_attempted`, `succeeded`, `failed`), `quarantined`, and `suppressed_count` for rate-limited worker-launch failures. Each is paired with a handled error report (failure class `update_failed`) whose message is the fixed text `Update failed during <stage> (<code>)` and whose stack frames come from the original error.
  - Rate-limit bookkeeping is kept locally in `<RESIN_HOME>/updates/update-telemetry.json` (last send time and suppressed count per outcome, and the current deferral run); nothing is recorded while reporting is off.
- **Learned-tool discovery event**: `discovery_funnel_daily` reports, once per finished UTC day, how agents found and used learned tools on this device. Properties are `day` (`YYYY-MM-DD`, UTC) and integer counts only: `searches` (`search_tools` calls, and `manage_tools` listings with a query), `searches_with_results`, `tools_listed` (tools shown when a small repository catalog is listed directly), `schema_reads` (`get_tool_schema` of a learned tool), `suggestions_shown` (a learned tool suggested for a command an agent was about to run), `invocations_succeeded`, `invocations_failed` (learned-tool calls through `invoke_tool` or by name), and `unavailable_here` (calls to a learned tool not offered in the caller's repository). Never queries, commands, tool names or ids, arguments, results, paths or repository identities.
  - Counting is local and independent of consent: each process that serves discovery (the MCP gateway, the `resin suggest` hook) writes its own per-day count file under `<RESIN_HOME>/state/discovery-funnel/` (`<day>.<pid>.<random>.json`, counts only); `resin status --verbose` shows the last seven days from them. Files are deleted 30 days after their day.
  - One hour after a day ends, the first process with a configured reporter claims it with a `<day>.sent` marker and sends its totals. A day that ends while reporting is off is marked `skipped` and is never sent later, even if reporting is turned back on; days more than seven days old are never sent.
- **Sanitization before sending**: the home directory becomes `~`, the current project root `<project>`, and other user-profile path segments `<user>`; bearer tokens, JWTs, `key=`/`token=`/`secret=`/`password=` values, known API key formats (`phc_`, `phx_`, `sk-`, `ghp_`, AWS keys and others), long opaque secrets, URL credentials and query strings, e-mail addresses and private keys are replaced with markers. Stack frames never include source lines (context lines are not collected).
- **Never sent**: prompts, transcripts, tool inputs or outputs, source contents, command-line argument values, request or response bodies, headers or environment values.
- **Identity**: the paired Resin cloud user id (`userId` claim of the device credential, falling back to `subject`) when the device is paired, otherwise a random `anon_<uuid>` stored owner-only at `<RESIN_HOME>/state/analytics-id`. It is not derived from the host name, user name or device id. Opaque account and workspace ids are attached as PostHog groups. Pairing links the anonymous id to the cloud user id. GeoIP enrichment is disabled for client events.
- **Opt-out** (any one turns everything off): `DO_NOT_TRACK=1`; `RESIN_ERROR_REPORTING=0` (or `false`/`off`); `resin privacy error-reporting disable` (stored as `errorReportingEnabled: false` in the device configuration); or disabling metadata telemetry (`resin privacy telemetry disable` / `RESIN_TELEMETRY_ENABLED=0`). Reporting is also off under test runners, and in builds without a PostHog project key nothing is sent at all. Running processes pick up a changed setting within a minute.
- **Reliability**: reporting never changes program behaviour or exit codes, never writes to standard output, waits at most about two seconds at exit, and silently drops events when offline.
- **Retention**: PostHog keeps events and error reports for the retention period configured on the Resin PostHog project; person data is deleted on request through `hello@resin.sh` or account deletion.

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
