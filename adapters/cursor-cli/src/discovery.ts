import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type HarnessInstallation,
  type HarnessSession,
  type HarnessWorkspace,
  type SessionStatus,
  UNKNOWN_HARNESS_VERSION,
  classifyHarnessVersion,
} from "@resin/harness-contracts";
import { parseSpoolLine } from "./hook-records.js";
import {
  CURSOR_HARNESS_ID,
  CURSOR_TESTED_VERSIONS,
  normalizeCursorVersion,
  resolveCursorMcpConfigPath,
  resolveCursorProjectsDir,
  resolveCursorSpoolDir,
} from "./paths.js";

/** A spool file untouched this long, without `sessionEnd`, is idle rather than active. */
const ACTIVE_WINDOW_MS = 60_000;

export interface CursorDiscoveryOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export interface CursorProbeOptions extends CursorDiscoveryOptions {
  executablePath?: string;
  configPath?: string;
}

/** How a subagent hook describes one subagent (`subagent_id`, `subagent_type`, `task`). */
interface CursorSubagentDescription {
  readonly agentId?: string;
  readonly agentType?: string;
  readonly task?: string;
}

/** A child conversation named by its parent's hooks. */
export interface CursorSubagentRef extends CursorSubagentDescription {
  readonly childConversationId: string;
}

/** The parent conversation a child's own hooks name. */
export interface CursorParentRef extends CursorSubagentDescription {
  readonly parentConversationId: string;
}

function optionalString<K extends string>(key: K, value: unknown): { [P in K]?: string } {
  return typeof value === "string" && value.length > 0
    ? ({ [key]: value } as { [P in K]?: string })
    : {};
}

/** Summary of one conversation's spool file. */
export interface CursorSpoolSummary {
  readonly conversationId: string;
  readonly spoolPath: string;
  /** First recorded `workspace_roots[0]`: the cwd cursor-agent ran in. */
  readonly workspaceRoot: string | null;
  readonly transcriptPath: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: SessionStatus;
  readonly isBackgroundAgent: boolean;
  /** Subagent conversations this conversation's hooks name as its children. */
  readonly subagents: readonly CursorSubagentRef[];
  /** The parent a subagent hook in this conversation names via `parent_conversation_id`. */
  readonly declaredParent: CursorParentRef | null;
  readonly model: string | null;
}

/** A conversation cursor-agent persisted locally that Resin holds no hook capture for. */
export interface CursorUncapturedSession {
  readonly conversationId: string;
  readonly transcriptPath: string;
  /** Lossy project slug of the directory under `~/.cursor/projects`; never a cwd. */
  readonly projectSlug: string;
  readonly parentConversationId: string | null;
  readonly reason: "no-hook-capture";
}

function resolveHome(options: CursorDiscoveryOptions): string {
  return options.home ?? options.env?.HOME ?? os.homedir();
}

export function cursorWorkspaceId(rootPath: string): string {
  return `${CURSOR_HARNESS_ID}_${createHash("sha256").update(rootPath).digest("hex").slice(0, 16)}`;
}

async function findExecutable(options: CursorProbeOptions, home: string): Promise<string | null> {
  const env = options.env ?? process.env;
  const candidates = [
    options.executablePath,
    ...(env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, "cursor-agent")),
    path.join(home, ".local", "bin", "cursor-agent"),
  ].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );
  for (const candidate of candidates) {
    try {
      await fsp.access(candidate, 1);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

/**
 * Reads the raw version from the install layout: the installer unpacks each release into
 * `.../cursor-agent/versions/<version>/` and symlinks `cursor-agent` to the binary inside it.
 * The binary is never run, so probing stays cheap and side-effect free.
 */
export async function readCursorRawVersion(executablePath: string): Promise<string | null> {
  const target = await fsp.realpath(executablePath).catch(() => executablePath);
  const versionDir = path.dirname(target);
  if (path.basename(path.dirname(versionDir)) !== "versions") return null;
  const raw = path.basename(versionDir);
  return normalizeCursorVersion(raw) ? raw : null;
}

/**
 * Probes for cursor-agent. The version comes from the versioned install directory and is
 * normalized to semver; an unreadable version reports {@link UNKNOWN_HARNESS_VERSION}.
 */
export async function probeCursorInstallation(
  options: CursorProbeOptions = {},
): Promise<HarnessInstallation | null> {
  const home = resolveHome(options);
  const executablePath = await findExecutable(options, home);
  const configPath = options.configPath ?? resolveCursorMcpConfigPath(home);
  if (executablePath === null) return null;
  const rawVersion = await readCursorRawVersion(executablePath);
  const version = (rawVersion && normalizeCursorVersion(rawVersion)) || UNKNOWN_HARNESS_VERSION;
  return {
    harnessId: CURSOR_HARNESS_ID,
    displayName: "Cursor CLI",
    version,
    executablePath,
    configPath,
    homePath: path.join(home, ".cursor"),
    isInstalled: true,
    status: "ready",
    detectedAt: new Date().toISOString(),
    metadata: {
      rawVersion,
      versionClassification: classifyHarnessVersion(version, CURSOR_TESTED_VERSIONS),
    },
  };
}

/** Reads one spool file into a summary; null when it holds no parseable payload. */
export async function summarizeCursorSpool(
  spoolPath: string,
  now: number = Date.now(),
): Promise<CursorSpoolSummary | null> {
  let content: string;
  let mtimeMs: number;
  try {
    [content, mtimeMs] = await Promise.all([
      fsp.readFile(spoolPath, "utf8"),
      fsp.stat(spoolPath).then((stat) => stat.mtimeMs),
    ]);
  } catch {
    return null;
  }
  let conversationId: string | null = null;
  let workspaceRoot: string | null = null;
  let transcriptPath: string | null = null;
  let createdAt: string | null = null;
  let updatedAt: string | null = null;
  let ended = false;
  let lastStop: string | null = null;
  let isBackgroundAgent = false;
  let model: string | null = null;
  const subagents: CursorSubagentRef[] = [];
  let declaredParent: CursorParentRef | null = null;
  for (const line of content.split("\n")) {
    const payload = parseSpoolLine(line);
    if (payload === null) continue;
    const at = typeof payload.resin_received_at === "string" ? payload.resin_received_at : null;
    if (at !== null) {
      createdAt ??= at;
      updatedAt = at;
    }
    conversationId ??=
      [payload.conversation_id, payload.session_id].find(
        (value): value is string => typeof value === "string" && value.length > 0,
      ) ?? null;
    if (workspaceRoot === null && Array.isArray(payload.workspace_roots)) {
      const root = payload.workspace_roots.find(
        (value) => typeof value === "string" && value.length > 0,
      );
      if (typeof root === "string") workspaceRoot = root;
    }
    if (transcriptPath === null && typeof payload.transcript_path === "string") {
      transcriptPath = payload.transcript_path;
    }
    if (typeof payload.model === "string" && payload.model.length > 0) model = payload.model;
    if (payload.is_background_agent === true) isBackgroundAgent = true;
    switch (payload.hook_event_name) {
      case "sessionEnd":
        ended = true;
        break;
      case "stop":
        lastStop = typeof payload.status === "string" ? payload.status : null;
        break;
      case "subagentStart":
      case "subagentStop": {
        // cursor-agent builds both payloads with `subagent_id`, `subagent_type` and
        // `parent_conversation_id`; subagentStop adds `child_conversation_id` when it knows the
        // child's conversation. A hook whose `parent_conversation_id` is another conversation ran
        // in the child; otherwise it ran in the parent and names its child.
        const own = conversationId ?? "";
        const description: CursorSubagentDescription = {
          ...optionalString("agentId", payload.subagent_id),
          ...optionalString("agentType", payload.subagent_type),
          ...optionalString("task", payload.task),
        };
        const declared = payload.parent_conversation_id;
        if (typeof declared === "string" && declared.length > 0 && declared !== own) {
          declaredParent ??= { parentConversationId: declared, ...description };
          break;
        }
        const childId =
          typeof payload.child_conversation_id === "string" && payload.child_conversation_id
            ? payload.child_conversation_id
            : payload.hook_event_name === "subagentStart"
              ? payload.subagent_id
              : undefined;
        if (typeof childId === "string" && childId.length > 0 && childId !== own) {
          const index = subagents.findIndex((ref) => ref.childConversationId === childId);
          const previous = index >= 0 ? subagents[index] : undefined;
          const merged = { ...description, ...previous, childConversationId: childId };
          if (index >= 0) subagents[index] = merged;
          else subagents.push(merged);
        }
        break;
      }
    }
  }
  if (conversationId === null) return null;
  const fallback = new Date(mtimeMs).toISOString();
  let status: SessionStatus;
  if (ended) status = "completed";
  else if (now - mtimeMs <= ACTIVE_WINDOW_MS) status = "active";
  else if (lastStop === "aborted") status = "interrupted";
  else if (lastStop === "error") status = "failed";
  else status = "idle";
  return {
    conversationId,
    spoolPath,
    workspaceRoot,
    transcriptPath,
    createdAt: createdAt ?? fallback,
    updatedAt: updatedAt ?? fallback,
    status,
    isBackgroundAgent,
    subagents,
    declaredParent,
    model,
  };
}

async function listFiles(dir: string, suffix: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

export interface CursorDiscoveryCatalog {
  readonly workspaces: HarnessWorkspace[];
  readonly sessionsByWorkspace: ReadonlyMap<string, HarnessSession[]>;
  readonly uncaptured: CursorUncapturedSession[];
}

/**
 * Builds the catalog from Resin's hook spool: one session per conversation, bound to the cwd the
 * hooks recorded. Subagent conversations link to their parent through `subagentStart` /
 * `subagentStop` (`parent_conversation_id`, `child_conversation_id`, `subagent_id`); a subagent
 * whose parent no hook names is a plain session. Conversations
 * cursor-agent persisted under `~/.cursor/projects/<slug>/agent-transcripts/` without a spool
 * file are returned as {@link CursorUncapturedSession}s so callers can report them.
 */
export async function buildCursorDiscoveryCatalog(
  options: CursorDiscoveryOptions = {},
): Promise<CursorDiscoveryCatalog> {
  const home = resolveHome(options);
  const now = options.now?.() ?? Date.now();
  const spoolDir = resolveCursorSpoolDir(home, options.env);
  const summaries = (
    await Promise.all(
      (await listFiles(spoolDir, ".jsonl")).map((file) => summarizeCursorSpool(file, now)),
    )
  ).filter((summary): summary is CursorSpoolSummary => summary !== null);

  // Each child conversation's link to its immediate parent. A parent's hooks naming the child win
  // over the child's own `parent_conversation_id`; both name the same conversation.
  const links = new Map<string, CursorParentRef>();
  for (const summary of summaries) {
    for (const { childConversationId, ...description } of summary.subagents) {
      if (childConversationId === summary.conversationId) continue;
      links.set(childConversationId, {
        parentConversationId: summary.conversationId,
        ...description,
      });
    }
  }
  for (const summary of summaries) {
    const declared = summary.declaredParent;
    if (declared && !links.has(summary.conversationId)) links.set(summary.conversationId, declared);
  }
  const byId = new Map(summaries.map((summary) => [summary.conversationId, summary]));

  const workspaces = new Map<string, HarnessWorkspace>();
  const sessionsByWorkspace = new Map<string, HarnessSession[]>();
  for (const summary of summaries) {
    // Subagents inherit the parent's recorded root when their own payloads lack one.
    let root = summary.workspaceRoot;
    const seen = new Set([summary.conversationId]);
    for (
      let parent = links.get(summary.conversationId)?.parentConversationId;
      root === null && parent && !seen.has(parent);
      parent = links.get(parent)?.parentConversationId
    ) {
      seen.add(parent);
      root = byId.get(parent)?.workspaceRoot ?? null;
    }
    if (root === null) continue;
    const link = links.get(summary.conversationId);
    const workspaceId = cursorWorkspaceId(root);
    if (!workspaces.has(workspaceId)) {
      workspaces.set(workspaceId, {
        workspaceId,
        rootPath: root,
        name: path.basename(root) || root,
        harnessId: CURSOR_HARNESS_ID,
        configPath: resolveCursorMcpConfigPath(home),
        mcpConfigPath: resolveCursorMcpConfigPath(home),
        metadata: { spoolDir },
      });
      sessionsByWorkspace.set(workspaceId, []);
    }
    sessionsByWorkspace.get(workspaceId)?.push({
      sessionId: summary.conversationId,
      workspaceId,
      harnessId: CURSOR_HARNESS_ID,
      transcriptPath: summary.spoolPath,
      status: summary.status,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      metadata: {
        cwd: root,
        // A linked subagent is its own agent session under the parent that started it.
        ...(link
          ? {
              sessionKind: "agent",
              parentSessionId: link.parentConversationId,
              ...(link.agentId ? { agentId: link.agentId } : {}),
              ...(link.agentType ? { agentName: link.agentType, agentKind: link.agentType } : {}),
              ...(link.task ? { agentTask: link.task } : {}),
            }
          : { parentSessionId: null }),
        isSubagent: link !== undefined,
        isBackgroundAgent: summary.isBackgroundAgent,
        cursorTranscriptPath: summary.transcriptPath,
        model: summary.model,
      },
    });
  }
  for (const sessions of sessionsByWorkspace.values()) {
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  const uncaptured: CursorUncapturedSession[] = [];
  const projectsDir = resolveCursorProjectsDir(home);
  let projects: string[] = [];
  try {
    projects = (await fsp.readdir(projectsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    projects = [];
  }
  for (const slug of projects) {
    const transcriptsDir = path.join(projectsDir, slug, "agent-transcripts");
    let conversations: string[];
    try {
      conversations = (await fsp.readdir(transcriptsDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      continue;
    }
    for (const conversationId of conversations) {
      const primary = path.join(transcriptsDir, conversationId, `${conversationId}.jsonl`);
      const candidates: Array<{ id: string; file: string; parent: string | null }> = [
        { id: conversationId, file: primary, parent: null },
        ...(await listFiles(path.join(transcriptsDir, conversationId, "subagents"), ".jsonl")).map(
          (file) => ({ id: path.basename(file, ".jsonl"), file, parent: conversationId }),
        ),
      ];
      for (const candidate of candidates) {
        if (byId.has(candidate.id)) continue;
        try {
          await fsp.access(candidate.file);
        } catch {
          continue;
        }
        uncaptured.push({
          conversationId: candidate.id,
          transcriptPath: candidate.file,
          projectSlug: slug,
          parentConversationId: candidate.parent,
          reason: "no-hook-capture",
        });
      }
    }
  }

  return { workspaces: [...workspaces.values()], sessionsByWorkspace, uncaptured };
}
