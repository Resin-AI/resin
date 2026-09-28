# What Leaves Your Machine

This page explains, in plain terms, what Resin sends off your computer, when it sends it, and what it never sends. The technical, field-by-field list is in the [Privacy Data Inventory](../security/privacy-inventory.md).

## When anything is sent

Resin sends data at three moments. To stop collection, see [Security and Privacy](security-and-privacy.md).

1. **While you work.** As your coding agent runs, Resin records the session on your computer. It then uploads a stripped-down summary of each event (described below) so the cloud can spot work you repeat.
2. **When a tool is being learned.** The cloud asks your computer to check a proposed tool against what you actually did. Your computer answers with a verdict only.
3. **When you use Resin's account features.** Signing in, choosing a workspace and downloading tools exchange the usual account information.

## What is sent

- **Event summaries.** For each thing your agent did: which tool it used (for example `bash`, `read` or `edit`), whether it succeeded, how long it took, how large the output was, and token counts. Text such as your messages, the agent's replies and its reasoning is dropped.
- **Command and file shapes.** A command such as `git commit -m "fix auth bug" && pnpm test src/auth/login.test.ts` is sent as `git commit -m $STR && pnpm test $TEST_FILE`: the program, subcommand and flag names stay, the argument values become placeholders. File paths are shortened to their last few folders, with your home folder removed.
- **Scrubbed command lines.** For commands your agent ran in a shell, Resin also sends the command line itself after removing secrets (passwords, tokens, keys and similar) and replacing your home folder with `~`, capped at 2,000 characters. These lines can name files and folders. The cloud may give this text to a cloud model to name and describe tools learned from it.
- **Scrubbed shell commands as learnable programs.** For Codex shell commands and OMP `bash` commands, Resin also sends the secret-scrubbed command as program text so a repeated job can be learned from it. Only the command itself is sent this way; the working directory, environment variables, timeout and any other option of the call stay on your computer. The original, unscrubbed command stays on your computer and is what runs. Other agents' shell commands, including Claude Code's `Bash`, are not sent this way: Resin cannot yet prove that such a call came from the agent's own shell tool rather than another tool with the same name, so their commands stay private.
- **Scrubbed program text.** When your agent ran a short JavaScript, TypeScript or Python program, Resin sends a secret-scrubbed copy of it so a tool can be learned from it. The original stays on your computer.
- **References and call ids.** Opaque codes that let your computer find its own copy of a value later, and the ids your coding agent gave each tool call. They reveal nothing about the value itself.
- **Counts.** Numbers such as how many times a tool was used, run times and sizes.
- **Validation verdicts.** When the cloud asks your computer to check a proposed tool, the answer contains only step ids, pass/fail verdicts, fixed reason codes and a fingerprint of the plan that was checked. Your computer checks the plan against its own recordings; it does not re-run your commands to do so. A value Resin scrubbed as a secret before upload is only ever compared with a value your computer supplies itself, never with a value the plan supplies or a model-written step computes, and a failed check does not say which such step failed. A plan whose model-written step would read such a value, or the output of a command whose output had a secret scrubbed, is not checked at all. Two comparisons remain possible: a plan may point two positions at two private values your computer already holds and learn whether they are equal, and a plan may state a value that was withheld from upload without being a secret (such as a file name) and learn whether the recording used it. Each recorded call and each private value a plan names (including values withheld from upload without being secrets) is checked at most 12 times a day, and every check is logged in `~/.resin/state/workflow-validation-asks.jsonl`.
- **Account and workspace details.** Your sign-in identity (for example your email address from Google or GitHub), workspace and project identifiers, and which tools are active.

## What is never sent

- **Exact values.** The actual arguments your agent typed into tools, such as search terms, file contents it wrote or messages it passed. Only their shapes and placeholders leave.
- **Outputs.** What commands and tools printed or returned: stdout, stderr, results and error messages.
- **File contents.** Your source code, edits, patches and diffs.
- **Secrets.** Passwords, API keys, tokens, private keys and environment variable values. Resin scrubs them before anything is uploaded, and refuses to send a payload that still looks like it contains one.
- **Your conversation.** Your prompts, the agent's replies and its reasoning.
- **Private originals.** The original, unscrubbed recordings stay in Resin's private store on your computer.

## Where your data stays

Full session recordings, recorded values and outputs live only on your computer, under `~/.resin/`, readable only by your user account. To see or change what Resin collects, see [Security and Privacy](security-and-privacy.md).
