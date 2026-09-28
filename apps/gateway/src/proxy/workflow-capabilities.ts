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
 *   version-1 grammar and may leave only `mkdir -p` setup unnamed.
 */
export const WORKFLOW_CAPABILITIES_HEADER = "x-resin-workflow-validation-capabilities";
export const WORKFLOW_CAPABILITIES = [
  "workspace-inputs-v1",
  "unknown-typed-proposals-v1",
  "cross-session-held-out-v1",
  "and-chain-segments-v1",
  "and-chain-segments-v2",
].join(",");
