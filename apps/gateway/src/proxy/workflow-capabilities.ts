import { REPOSITORY_LOCATION_CAPABILITY } from "@resin/contracts";

/**
 * What this device's recording check and runtime support, sent on every request that fetches
 * validation asks, the catalog, tool artifacts or an invocation, so the cloud can withhold what an
 * older device would misread:
 *
 * - `workspace-inputs-v1`: replays recorded programs with the recorded workspace-input snapshot;
 * - `unknown-typed-proposals-v1`: input proposals typed `unknown`, answered with `confirmedType`;
 * - `cross-session-held-out-v1`: held-out calls from another session of this workspace;
 * - `and-chain-segments-v1`: plan steps that are segments of a recorded shell `&&` chain
 *   (`WorkflowStep.segment`), checked and run one segment at a time;
 * - `and-chain-segments-v2`: segment addresses of splitter version 2, whose segments may redirect
 *   to plain files, and whose chains may leave a read-only inspection segment (`cat`, `ls`,
 *   `sha256sum`, ... — `isSkippableSegment`) unnamed; version-1 addresses still re-split under the
 *   version-1 grammar and may leave only `mkdir -p` setup unnamed;
 * - `joint-token-spans-v1`: several span proposals or holes inside one program token are decided
 *   jointly against a demonstration that changed all of them (`backups/<dir>/<name>-<date>.tar.gz`);
 * - `cross-harness-shell-heldout-v1`: a held-out recorded by another harness's built-in shell than
 *   the plan's step (Claude `Bash` for Codex `exec_command`) is checked through the program
 *   argument alone; segment steps additionally need the same recorded shell dialect;
 * - `display-filter-v1`: plan steps marked `WorkflowStep.displayFilter` run their recorded program
 *   without its trailing `tail`/`head`/`grep` display filter (`splitDisplayFilter`, version 1),
 *   returning the command's whole output and exit status; replay confirmation pipes that output
 *   through the dropped stages before comparing it with the recording; a step's boolean
 *   `displayFilter.input`, when the caller sets it, pipes the output through them the same way;
 * - `display-filter-v2`: also `displayFilter.version` 2 (`splitDisplayFilters`), which cuts the
 *   trailing display filter of every top-level pipeline of a program the version-2 lexer delimits
 *   (redirections, heredocs, `$NAME`, `$(...)` and double-quoted expansions in the kept text). An
 *   invocation runs the program as recorded, filters inline, and reports each pipeline's status
 *   and the diagnostics its filters hid; replay confirmation replays each cut pipeline's
 *   marker-bracketed output through its own filter.
 * - `repository-location-v1` (`REPOSITORY_LOCATION_CAPABILITY`): a step's
 *   `WorkflowStep.location` runs in the caller's own checkout of the step's repository (with
 *   `leadingCd`, without the program's recorded leading `cd`), and a plan whose location cannot
 *   resolve for the caller is reported unavailable and never run. A device without it ignores the
 *   field and runs the recorded program as recorded.
 */
export const WORKFLOW_CAPABILITIES_HEADER = "x-resin-workflow-validation-capabilities";
export const WORKFLOW_CAPABILITIES = [
  "workspace-inputs-v1",
  "unknown-typed-proposals-v1",
  "cross-session-held-out-v1",
  "and-chain-segments-v1",
  "and-chain-segments-v2",
  "joint-token-spans-v1",
  "cross-harness-shell-heldout-v1",
  "display-filter-v1",
  "display-filter-v2",
  REPOSITORY_LOCATION_CAPABILITY,
].join(",");
