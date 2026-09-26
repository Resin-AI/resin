# ADR 0012: Validate Learned Tools Against Local Recordings

- **Status**: accepted
- **Date**: 2026-09-26
- **Deciders**: Resin Core Architecture Team
- **Consulted**: Application Security, Runtime Engineering

## Context and Problem Statement

Before a learned tool is published, the cloud asks the device to validate its plan: would the tool, given the recorded inputs, do what the user's session did? The gateway answers these asks on its own, without user interaction.

Validation used to answer by re-running the recorded commands against a copy of the project. That had four problems:

- **Side effects.** Recorded commands were run again. A command that deployed, sent a message, wrote outside the project copy or changed remote state did so again during validation.
- **Network and home-folder access.** The replayed processes ran with the user's full network access and could read the home directory, credentials and other projects.
- **Plan-carried program text.** Program steps ran text carried in the plan, so a plan could make the device run code the user never ran.
- **No universal sandbox.** Resin runs on Linux, macOS, WSL, inside Docker and in CI. An operating-system sandbox that works in all of these places, with nothing extra to install, does not exist.

Validation needs a way to establish that a plan reproduces the recording without executing what was recorded.

## Decision Drivers

- Validation must never execute a recorded command, dispatch a tool call, or copy the project.
- The only code validation may run is code no recording produced (derivations), and that code must be contained on every supported platform with nothing extra to install.
- The device, not the plan, decides what was recorded.
- Decisions sent to the cloud carry no recorded values, commands or outputs.

## Considered Options

1. **Keep execution replay inside per-platform OS sandboxes** (bubblewrap/Landlock on Linux, Seatbelt on macOS, AppContainer on Windows).
2. **Keep execution replay inside Anthropic's sandbox-runtime.**
3. **Keep execution replay behind a Resin consent prompt.**
4. **Check plans against the device's own recordings, and run only derivations, inside Pyodide in Deno** (chosen).

## Decision

Resin validates learned tools with a **recording check**.

### 1. The recording check

Validation registers non-executing adapters for every recorded runtime: shell and process commands, recorded programs, tool-protocol calls, harness tools and composed invocations. For each step it resolves the call exactly as an invocation would (templates, holes, inputs, extracts and derivation outputs), then compares the resolved call with the call this device recorded for that step:

- the same callable (name, connection, program kind and argument); and
- every argument equal to the recorded value, with program templates compared after resolving their private original.

A match lets the recorded output answer the step. A mismatch, or a step with no recorded call, means the plan is not verified. Nothing is spawned, dispatched or written, and the project is not copied.

### 2. Local call identity

Every recorded value the check compares against or returns is read from the device's private store under a reference the device computes itself, from a session its own harness adapters discovered and a call id named in the plan (`callId` for the baseline, `heldOut.calls` for held-out repeats). The entry must be owned by this workspace. Literals and references carried in a plan are never trusted as the recording. When a demonstration's calls cannot be identified locally, the result is "unavailable", never verified.

### 3. The hidden-dependency rule

Re-execution used to catch a plan that hard-coded a value an earlier step produced (for example an id printed by one command and pasted into the next): the re-run produced a new value and the stale one failed. A recording check cannot see that. Instead, a step whose resolved call still carries, as literal recorded text, a value the recording shows flowing from an earlier step's output is not verified until the plan binds that position to the earlier step. Incidental matches fail closed.

### 4. Derivations run in Pyodide inside Deno

Derivation steps are short Python programs a cloud model writes to compute a value the recording hard-coded. They are the only plan code no recording produced, and they are never trusted. At validation **and** at tool invocation they run as Python in Pyodide (CPython compiled to WebAssembly) inside a Deno process whose only permission is read access to Resin's pinned, local Pyodide assets. Network, environment, subprocesses, FFI, system information, file writes and remote or npm imports are denied. If Deno or the Pyodide assets are unavailable, the derivation step fails closed. Derivation semantics (the final expression must be a JSON object, a fixed allowlist of importable modules, output and time bounds) are unchanged.

### 5. Proof kind "recording"

A validation decision carries `verification.replay = { kind: "recording", planDigest }`, together with step ids, verdicts and fixed reason strings only. The earlier execution-replay proof kinds are removed; the cloud accepts only "recording" proofs whose digest matches the plan.

## Rejected Alternatives

- **Per-platform OS sandboxes.** Each platform needs a different mechanism with different guarantees, several need extra installs or privileges, and some environments Resin supports (containers, CI runners, WSL) disable or weaken them. Even a perfect sandbox still re-runs side-effecting commands.
- **Anthropic's sandbox-runtime.** It needs extra packages installed and, on Ubuntu 24.04 and later, a sysctl change to allow unprivileged user namespaces; it is weakened inside Docker; and Windows support is alpha. It also still re-runs recorded commands.
- **Resin-specific consent prompts.** Product decision: the harness's own permission policy governs tool calls, as it does for any MCP tool, and Resin adds no approval step of its own. Validation runs in the background without a user present, so a prompt would either block validation or train users to click through it.

## Consequences

### Positive

- Validation has no side effects and no network, home-folder or project access for recorded steps: it reads the local recording and compares.
- Plan-carried program text never runs. The only executed plan code is derivations, contained by the same sandbox on every platform with nothing extra to install.
- Decisions still carry only step ids, verdicts and fixed reason strings.

### Negative / Trade-offs

- **Environment drift is no longer detected.** A plan that matched the recording is verified even if the command would now behave differently on this machine (a changed tool version, a moved file, a changed remote service).
- **One recording cannot tell constants from printed values.** With a single demonstration, a literal that happens to equal an earlier output looks the same as a real constant. The hidden-dependency rule covers the unsafe side: such plans fail closed until the position is bound, at the cost of rejecting some plans whose value really was a constant.
- **Recordings made before this change need re-capture.** They lack the local per-call identity entries the check reads, so their validations are "unavailable" until the work is recorded again.
- **Derivations cost about 1.2 s each**, mostly Pyodide start-up, at validation and at invocation.

## Related Decisions

- [ADR 0002: Daemon and Worker Isolation](0002-daemon-and-worker-isolation.md)
- [ADR 0005: Privacy and Data Boundaries](0005-privacy-data-boundaries.md)
- [ADR 0007: Capability Envelope and Security](0007-capability-envelope-and-security.md)
