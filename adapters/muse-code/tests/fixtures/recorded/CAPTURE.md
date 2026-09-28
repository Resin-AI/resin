# Muse Code recorded fixtures

Recorded with `muse` 1.4.0 (`Muse Code 1.4.0 (1.4.0-R4302.1)`, linux arm64) on 2026-09-27, against
the real Meta model (`muse-spark-1.3-contributor`, muse's default).

## Capture source: `session.jsonl`

Muse keeps one append-only event log per session at
`${XDG_DATA_HOME:-~/.local/share}/muse/sessions/YYYY/MM/DD/<session-id>/session.jsonl`, with each
spawned subagent and each persisted background observer in
`<session-id>/subagent/<child-id>/session.jsonl`. The adapter tails these logs.

- `muse export` writes a single document after the fact; it cannot follow a running session.
- The session protocol (`muse serve`, schema via `muse schema generate-json-schema`) serves sessions
  the client owns; Resin observes sessions the user starts, so it would have to own the session.
- The logs are durable, written as the run happens, include subagent and observer children, record
  model usage per call, tool calls, effect outcomes, and the reconciliation muse writes on resume.

Each line is a record `{schema_version, id, stream, sequence, recorded_at (µs), record_type,
payload_type, payload}`, or a `retained_frame` whose `children[].record_json` hold records.

## Model provider

Every scenario runs the real `muse` binary against the real Meta model with the user's existing
`muse login`: the capture home gets `.config/muse/auth.json` as a symlink to
`${XDG_CONFIG_HOME:-~/.config}/muse/auth.json` (never copied, so a token refresh updates the one
real store). Model choices, token usage, and the model id in the logs are real. No scenario needs a
scripted model.

Usage lands where each model call ran: the lead log and each subagent and observer log carry a
`model_completed` event with `usage` per call. The lead additionally writes
`subagent.control.runtime_observed` with the subagent's aggregated usage; the decoder ignores it
because the subagent's own log already counts those calls.

## Scenarios

| Directory | What happens |
| --- | --- |
| `1.4.0/full` | `bash` (`ls && git status`), `read_file`, `edit_file`, `write_file`, MCP `mcp__demo__add` on a local stdio server, a failing `bash` (`exit 3`), `subagent_spawn` + `subagent_wait`. Includes the explorer subagent log (2 model calls) and the `verify-reminder` observer log (1 model call). |
| `1.4.0/abort` | A side-effecting `bash` (`echo start > started.txt && sleep 30 …`) sent SIGINT once `started.txt` exists; muse records the call as cancelled. |
| `1.4.0/kill` | The same command with muse killed by SIGKILL once `started.txt` exists (`session.before-resume.jsonl` is the log at that moment: an effect started with no terminal record), then `muse exec --session-id <id>` resumes it (telling the model not to rerun it) and muse records "The outcome is unknown". |
| `1.4.0/normalize` | Recorded 2026-09-28 with `muse exec --approval-mode never` (not by `capture.sh`), scrubbed with `scripts/harness-fixtures/scrub.mjs`: a text-normalization job (`tr` lowercase piped to `sed` whitespace collapse into `out1.txt`). The lead log only; muse linked `skill-reminder` observers before model turns and a `verify-reminder` at the end, none of which is a step the agent took. |

## Regenerate

Requires `muse` on PATH and logged in (`muse login`), `git`, `python3`, and `node`. From this
directory:

```sh
./capture/capture.sh            # writes ./<muse version>/
./capture/capture.sh /tmp/out   # writes elsewhere
```

The script runs every scenario with `XDG_CONFIG_HOME=/tmp/resin-fixture-muse-home/.config`,
`XDG_DATA_HOME=/tmp/resin-fixture-muse-home/.local/share`, `MUSE_NO_AUTO_UPDATE=1`, in a fresh git
project at `/tmp/resin-fixture-muse-cap`, with:

```sh
muse exec --approval-judge off --yolo --json "<prompt>"
```

and scrubs each log with
`node scripts/harness-fixtures/scrub.mjs <raw> <out> --project /tmp/resin-fixture-muse-cap --replace /tmp/resin-fixture-muse-home=/home/user`.
Session ids and the date directory change on every capture; update the ids and date in
`tests/recorded.test.ts` after regenerating. The model's wording varies between captures, but the
prompts name each tool call explicitly.

## Not captured

- `skill-reminder` observer calls: muse 1.4.0 links them from the lead log
  (`memory_reminder_child_session_linked`) but writes no log or usage for them, so their model
  calls cannot be counted.
- Context compaction.
