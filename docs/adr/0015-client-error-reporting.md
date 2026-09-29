# ADR 0015: Client Error Reporting and Usage Events

- **Status**: accepted
- **Date**: 2026-09-29
- **Deciders**: Resin Core Architecture Team
- **Consulted**: Privacy, Developer Tooling, Platform Engineering

## Context and Problem Statement

Resin runs on developer machines as a CLI, a background daemon, an MCP stdio gateway and a set of installers. When one of them fails, the failure usually stays on that machine: in a local log, a crash-recovery record, or a terminal the user closed. Maintainers learn about it only if the user files a report, so install failures, daemon crashes, pairing problems and failing tool invocations go unseen and unfixed.

We need visibility into every error and failure in the public client, without weakening the privacy boundaries of [ADR 0005](0005-privacy-data-boundaries.md): raw prompts, transcripts, source, tool inputs and outputs never leave the device.

## Decision Drivers

- **See every failure**: uncaught crashes, terminal command errors, recovered errors and failed lifecycle steps, with stack traces precise enough to fix them.
- **Privacy first**: sanitize on the device before anything is sent; never send free-form user or project data except text the user explicitly writes as feedback.
- **Easy opt-out**: honour `DO_NOT_TRACK`, and let one familiar switch turn everything off.
- **Zero behaviour change**: reporting must never alter output, exit codes or protocol traffic (the MCP shim's stdout is protocol), must work offline, and must never hold a process open for long.
- **One source of truth** for the ingest key and endpoint across TypeScript, POSIX shell and PowerShell.

## Considered Options

1. **Option 1: Local logs only (status quo)**
   - *Pros*: Nothing leaves the device.
   - *Cons*: Failures are invisible unless users report them.

2. **Option 2: Opt-in error reporting**
   - *Pros*: Strongest consent posture.
   - *Cons*: Very few users opt in, so most failures (especially install failures, before any prompt could be shown) stay invisible.

3. **Option 3: Default-on, sanitized error reporting and usage events through a first-party proxy, with an easy opt-out (Selected)**
   - *Pros*: Broad visibility; data minimized and sanitized locally; standard `DO_NOT_TRACK` and a `resin privacy` switch; the proxy keeps a Resin-owned endpoint.
   - *Cons*: A new subprocessor (PostHog); default-on requires clear documentation.

## Decision

1. **Transport**: the public client sends PostHog `$exception` events and a fixed set of usage events to PostHog US cloud through the first-party proxy `https://resin.sh/ingest` (overridable with `RESIN_POSTHOG_HOST`). The public, write-only project key lives in one constant, `RESIN_POSTHOG_PROJECT_API_KEY` in `apps/observer/src/error-reporting/facade.ts`; `install.sh` and `install.ps1` carry the same literal and a unit test keeps them equal. While the key is the placeholder, every integration is a silent no-op.
2. **Module**: `@resin/observer/error-reporting` wraps `posthog-node` for the CLI, daemon and MCP shim. `@resin/observer/error-reporting/core` holds consent, identity, sanitization and the process-wide reporter registry without loading `posthog-node`, so deep call sites and the standalone install helper stay small. The install helper posts the capture endpoint directly.
3. **Exceptions are built by Resin, not the SDK**: the SDK's Node error tracking attaches source-code context lines, which ADR 0005 forbids. Resin builds `$exception_list` itself from sanitized messages and at most 50 stack frames (file, line, column), and sets `$exception_handled`, `$exception_level`, `resin_error_code` and `resin_failure_class`.
4. **Sanitization on the device**: home directory → `~`, project root → `<project>`, other user-profile segments → `<user>`; tokens, keys, secret assignments, URL credentials and queries, e-mail addresses and private keys are redacted; messages are capped at about 1,000 characters. Command arguments, prompts, transcripts, tool inputs/outputs, source contents, bodies, headers and environment values are never sent.
5. **Consent**: on by default. Off when any of `DO_NOT_TRACK`, `RESIN_ERROR_REPORTING=0`, `errorReportingEnabled: false` (`resin privacy error-reporting disable`) or disabled metadata telemetry applies, and under test runners unless forced. Unreadable device configuration fails closed.
6. **Identity**: the paired cloud user id (`claims.userId`, falling back to `claims.subject`), which equals the Resin Cloud tenant user id used by the web and API; otherwise a random `anon_<uuid>` at `<RESIN_HOME>/state/analytics-id`, aliased to the user id at pairing. Account and workspace ids are sent as PostHog groups.
7. **Hooks**: process-level crash handlers (installed only when reporting is enabled; they reproduce Node's default stderr output and exit code 1), terminal catches of the CLI, daemon and MCP shim, supervisor module start/stop/rollback/reload failures, daemon `error` logs (rate-limited), crash-recovery records, pairing, install/init, upgrade, credential-refresh and tool-invocation failures.
8. **Bounded shutdown**: sends use unref'd sockets with a 3 s request timeout, flushes wait at most 2 s and then drop in-flight requests, and send failures are silently discarded.

## Consequences

### Positive
- Crashes and recovered failures on user machines become visible with actionable stack traces.
- Install funnels and command failure rates can be measured.
- The same user id joins CLI, web and API events.

### Negative
- PostHog becomes a subprocessor for diagnostic data (documented in the privacy inventory).
- Default-on reporting requires clear user-facing documentation and a visible opt-out.
- Short-lived commands may wait up to about 2 s at exit when the ingest host is slow or unreachable.

## Compliance and Verification

- Unit tests cover the sanitizer (paths, tokens, e-mail addresses, URLs), the consent matrix, anonymous id persistence, capture-and-rethrow wrappers, crash handlers, the no-op placeholder key, the absence of stdout writes, and a bounded exit against a host that never answers.
- A unit test keeps the installer key literals equal to the TypeScript constant; `pnpm check:secrets` allows only a bare assignment of that public constant.
- [Privacy Inventory](../security/privacy-inventory.md) and [Security & Privacy](../user/security-and-privacy.md) list the fields, retention and opt-outs.
