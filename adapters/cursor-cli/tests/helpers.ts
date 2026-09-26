import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NodeConfigFsBridge } from "@resin/harness-contracts";
import { installCursorCaptureHooks } from "../src/hooks.js";
import { resolveCursorHookScriptPath } from "../src/paths.js";

export const fsBridge = new NodeConfigFsBridge();

export function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "resin-cursor-home-"));
}

/** Installs the real capture hook into `home` and returns a function that feeds it one payload. */
export async function installedHook(home: string): Promise<(payload: unknown) => string> {
  await installCursorCaptureHooks({ home, env: {}, fsBridge });
  const script = resolveCursorHookScriptPath(home);
  return (payload) =>
    execFileSync(process.execPath, [script], {
      input: typeof payload === "string" ? payload : JSON.stringify(payload),
      encoding: "utf8",
    });
}

/**
 * Hook payloads shaped exactly like cursor-agent 2026.09.26-dd393fe builds them (executor base
 * fields plus each `executeHookForStep` call site's fields). Not recorded from a live session:
 * cursor-agent needs `cursor-agent login` before any hook fires.
 */
export function conversationPayloads(options: {
  conversationId: string;
  workspace: string;
  subagentId?: string;
}): Record<string, unknown>[] {
  const common = {
    conversation_id: options.conversationId,
    generation_id: "gen-1",
    model: "composer-1",
    cursor_version: "2026.09.26-dd393fe",
    workspace_roots: [options.workspace],
    user_email: "someone@example.com",
    transcript_path: `/home/u/.cursor/projects/x/agent-transcripts/${options.conversationId}/${options.conversationId}.jsonl`,
  };
  const payloads: Record<string, unknown>[] = [
    {
      ...common,
      session_id: options.conversationId,
      hook_event_name: "sessionStart",
      composer_mode: "agent",
    },
    {
      ...common,
      hook_event_name: "beforeSubmitPrompt",
      prompt: "count the lines in README.md",
      attachments: [],
    },
    { ...common, hook_event_name: "afterAgentThought", text: "I will run wc.", duration_ms: 120 },
    {
      ...common,
      hook_event_name: "postToolUse",
      tool_name: "Shell",
      tool_input: JSON.stringify({
        command: "wc -l README.md",
        working_directory: options.workspace,
      }),
      tool_output: JSON.stringify({ exitCode: 0, stdout: "3 README.md\n", stderr: "" }),
      duration: 42,
      tool_use_id: "call-shell-1",
    },
    {
      ...common,
      hook_event_name: "postToolUseFailure",
      tool_name: "Read",
      tool_input: { path: "missing.txt" },
      error_message: "File not found",
      failure_type: "error",
      duration: 3,
      tool_use_id: "call-read-2",
      is_interrupt: false,
    },
    {
      ...common,
      hook_event_name: "afterFileEdit",
      file_path: `${options.workspace}/notes.txt`,
      edits: [{ old_string: "", new_string: "hello\n" }],
    },
    {
      ...common,
      hook_event_name: "postToolUse",
      tool_name: "mcp_demo_echo",
      tool_input: JSON.stringify({ text: "ping" }),
      tool_output: JSON.stringify({ content: [{ type: "text", text: "ping" }], isError: false }),
      duration: 7,
      tool_use_id: "call-mcp-3",
    },
    {
      ...common,
      hook_event_name: "afterAgentResponse",
      text: "README.md has 3 lines.",
      input_tokens: 1200,
      output_tokens: 80,
      cache_read_tokens: 900,
      cache_write_tokens: 0,
    },
    {
      ...common,
      hook_event_name: "preCompact",
      trigger: "auto",
      context_usage_percent: 91,
      context_tokens: 180000,
      context_window_size: 200000,
      message_count: 40,
      messages_to_compact: 30,
      is_first_compaction: true,
    },
  ];
  if (options.subagentId) {
    payloads.push({
      ...common,
      hook_event_name: "subagentStart",
      subagent_id: options.subagentId,
      subagent_type: "explore",
      task: "find tests",
      parent_conversation_id: options.conversationId,
      tool_call_id: "call-task-4",
      is_parallel_worker: false,
    });
  }
  payloads.push(
    {
      ...common,
      hook_event_name: "stop",
      status: "aborted",
      loop_count: 0,
      input_tokens: 1200,
      output_tokens: 80,
    },
    {
      ...common,
      session_id: options.conversationId,
      hook_event_name: "sessionEnd",
      reason: "user_exit",
    },
  );
  return payloads;
}
