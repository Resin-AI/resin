import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDirectorySync, writeNewPrivateFileSync } from "../private-fs.js";

export const ANALYTICS_ID_FILE_NAME = "analytics-id";
const ANONYMOUS_ID_PATTERN = /^anon_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Opaque cloud identifiers only: an e-mail address or free text is never used as an identity. */
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value) && !value.includes("@");
}

export function isAnonymousId(value: string): boolean {
  return ANONYMOUS_ID_PATTERN.test(value);
}

function readAnonymousId(filePath: string): string | undefined {
  try {
    const value = fs.readFileSync(filePath, "utf8").trim();
    return ANONYMOUS_ID_PATTERN.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Reads the install's anonymous analytics id without creating one. */
export function peekAnonymousId(stateDir: string): string | undefined {
  return readAnonymousId(path.join(stateDir, ANALYTICS_ID_FILE_NAME));
}

/**
 * The install's random `anon_<uuid>`, persisted owner-only at `<stateDir>/analytics-id`. It is not
 * derived from the host, user or device id. When the file cannot be written the id lives for this
 * process only. Never throws.
 */
export function readOrCreateAnonymousId(stateDir: string, preferredId?: string): string {
  const filePath = path.join(stateDir, ANALYTICS_ID_FILE_NAME);
  const existing = readAnonymousId(filePath);
  if (existing) return existing;
  // The shell installer mints an id before this process runs; adopt it so installs join the CLI.
  const created = preferredId && isAnonymousId(preferredId) ? preferredId : `anon_${randomUUID()}`;
  try {
    ensurePrivateDirectorySync(stateDir);
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
    writeNewPrivateFileSync(filePath, `${created}\n`);
    return created;
  } catch {
    // A concurrent process may have won the race; prefer its id so both agree.
    return readAnonymousId(filePath) ?? created;
  }
}

export interface CloudIdentity {
  /** The Resin cloud tenant user id (`claims.userId`, falling back to `claims.subject`). */
  readonly userId: string;
  readonly accountId?: string;
  readonly workspaceId?: string;
}

/**
 * The paired cloud identity from `<stateDir>/device-token.json` claims. Only opaque ids are read;
 * tokens in the file are never touched beyond parsing. Missing or malformed files yield undefined.
 */
export function readCloudIdentity(stateDir: string): CloudIdentity | undefined {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(stateDir, "device-token.json"), "utf8"),
    );
    if (parsed === null || typeof parsed !== "object") return undefined;
    const claims: unknown = Reflect.get(parsed, "claims");
    if (claims === null || typeof claims !== "object") return undefined;
    const userId: unknown = Reflect.get(claims, "userId");
    const subject: unknown = Reflect.get(claims, "subject");
    const accountId: unknown = Reflect.get(claims, "accountId");
    const workspaceId: unknown = Reflect.get(claims, "workspaceId");
    const trimmedUserId = typeof userId === "string" ? userId.trim() : undefined;
    const trimmedSubject = typeof subject === "string" ? subject.trim() : undefined;
    const resolved = trimmedUserId || trimmedSubject;
    if (!isOpaqueId(resolved)) return undefined;
    return {
      userId: resolved,
      accountId: isOpaqueId(accountId) ? accountId : undefined,
      workspaceId: isOpaqueId(workspaceId) ? workspaceId : undefined,
    };
  } catch {
    return undefined;
  }
}
