# Muse Code recorded fixtures

Recorded with `muse` 1.4.0 (`Muse Code 1.4.0 (1.4.0-R4161.1)`, linux arm64) on 2026-09-26.

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

Muse was not authenticated (`muse login` is an interactive browser device-code login). The real
binary was run with `--base-url http://127.0.0.1:18777`, pointed at `capture/fake-meta.py`, a
scripted stand-in for the Meta Responses endpoint (`GET /muse-code/models`, streaming
`POST /responses`). Everything in the logs is written by muse 1.4.0 itself: tool execution, MCP
server calls, subagent spawning, observers, cancellation, and resume. Only the model's choices and
its token counts come from the script. `META_API_KEY=dummy` satisfies the client and is never sent
anywhere but the local stand-in.

## Scenarios

| Directory | What happens |
| --- | --- |
| `1.4.0/full` | `bash` (`ls && git status`), `read_file`, `edit_file`, `write_file`, MCP `mcp__demo__add` on a local stdio server, a failing `bash` (`exit 3`), `subagent_spawn` + `subagent_wait`. Includes the explorer subagent log and the `verify-reminder` observer log. |
| `1.4.0/abort` | A side-effecting `bash` (`echo start > started.txt && sleep 30 …`) interrupted with SIGINT; muse records the call as cancelled. |
| `1.4.0/kill` | The same command with muse killed by SIGKILL (`session.before-resume.jsonl` is the log at that moment: an effect started with no terminal record), then `muse exec --session-id <id>` resumes it and muse records "The outcome is unknown". |

## Regenerate

Requires `muse` on PATH, `python3`, `git`, and `node`. From this directory:

```sh
./capture/capture.sh            # writes ./<muse version>/
./capture/capture.sh /tmp/out   # writes elsewhere
```

The script runs every scenario with `HOME=/tmp/resin-fixture-muse-home`,
`MUSE_NO_AUTO_UPDATE=1`, in `/tmp/resin-fixture-muse-cap`, with:

```sh
META_API_KEY=dummy muse exec --base-url http://127.0.0.1:18777 --model fake-model \
  --approval-judge off --yolo --json "<prompt>"
```

and scrubs each log with
`node scripts/harness-fixtures/scrub.mjs <raw> <out> --project /tmp/resin-fixture-muse-cap --replace /tmp/resin-fixture-muse-home=/home/user`.
Session ids change on every capture; update the ids in `tests/recorded.test.ts` after regenerating.

## Not captured

- Real Meta model output and pricing (no provider login).
- `skill-reminder` observer calls: muse 1.4.0 links them from the lead log
  (`memory_reminder_child_session_linked`) but writes no log or usage for them; the stand-in saw
  their requests.
- Context compaction.
