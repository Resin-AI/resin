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
  /** Subagent conversation ids started by this conversation (`subagentStart.subagent_id`). */
  readonly subagentIds: readonly string[];
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
  const subagentIds: string[] = [];
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
        if (typeof payload.subagent_id === "string" && !subagentIds.includes(payload.subagent_id)) {
          subagentIds.push(payload.subagent_id);
        }
        break;
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
    subagentIds,
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
 * hooks recorded. Subagent conversations link to their parent via `subagentStart`. Conversations
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

  const parentOf = new Map<string, string>();
  for (const summary of summaries) {
    for (const child of summary.subagentIds) parentOf.set(child, summary.conversationId);
  }
  const byId = new Map(summaries.map((summary) => [summary.conversationId, summary]));

  const workspaces = new Map<string, HarnessWorkspace>();
  const sessionsByWorkspace = new Map<string, HarnessSession[]>();
  for (const summary of summaries) {
    // Subagents inherit the parent's recorded root when their own payloads lack one.
    let root = summary.workspaceRoot;
    for (let parent = parentOf.get(summary.conversationId); root === null && parent; ) {
      root = byId.get(parent)?.workspaceRoot ?? null;
      parent = parentOf.get(parent);
    }
    if (root === null) continue;
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
        parentSessionId: parentOf.get(summary.conversationId) ?? null,
        isSubagent: parentOf.has(summary.conversationId),
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
