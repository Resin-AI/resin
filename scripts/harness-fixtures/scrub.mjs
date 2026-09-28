#!/usr/bin/env node
/**
 * Scrubs a transcript captured from a real harness install so it can be committed as a
 * decoder fixture.
 *
 * - Machine identity (home directory, user name, host name, Windows domain) and the capture project
 *   directory are rewritten to stable placeholders, longest match first. A Windows path is matched
 *   in every spelling a transcript uses: `\` or `/` separators, JSON-escaped `\\`, any letter
 *   case, a `\\?\` long-path prefix, and the `/c/...` (Git Bash) and `/mnt/c/...` (WSL) mounts.
 * - Any string matching a secret-scanner rule is replaced with "<scrubbed:secret>".
 * - Opaque provider blobs (encrypted reasoning, signatures) are replaced with "<scrubbed:opaque>"
 *   so fixtures stay small and carry no provider state; the field itself is kept.
 *
 * JSON Lines input is walked value by value, so record structure, key order and ids are kept.
 * Lines that are not JSON are scrubbed as text. A scrubbed fixture that still matches a
 * secret rule makes the command fail.
 *
 * Usage:
 *   node scripts/harness-fixtures/scrub.mjs <input> <output> \
 *     --project <capture-cwd> [--replace <from>=<to> ...]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { SECRET_RULES, scanContent } from "../check-secrets.mjs";

export const PLACEHOLDER_HOME = "/home/user";
export const PLACEHOLDER_USER = "user";
export const PLACEHOLDER_HOST = "host";
export const PLACEHOLDER_DOMAIN = "domain";
export const PLACEHOLDER_PROJECT = "/workspace/project";
export const PLACEHOLDER_WINDOWS_HOME = "C:\\Users\\user";
export const PLACEHOLDER_WINDOWS_PROJECT = "C:\\workspace\\project";
export const SCRUBBED_SECRET = "<scrubbed:secret>";
export const SCRUBBED_OPAQUE = "<scrubbed:opaque>";

/** Keys whose values are opaque provider state rather than transcript content. */
const OPAQUE_KEYS = new Set([
  "encrypted_content",
  "encryptedContent",
  "signature",
  "thinkingSignature",
  "thinking_signature",
  "redacted_thinking",
]);

/** One Windows path separator: `\`, a JSON-escaped `\\`, or `/`. */
const SEP = String.raw`(?:\\\\|\\|/)`;
const BACKSLASH = String.raw`(?:\\\\|\\)`;
const DEVICE = `${BACKSLASH}${BACKSLASH}[?.]${BACKSLASH}`;

/**
 * @typedef {[string | RegExp, string | ((match: string) => string)]} Replacement
 */

/** Whether a path is spelled the Windows way: a drive root or a UNC share. */
export function isWindowsPath(value) {
  return /^(?:[A-Za-z]:[\\/]|\\\\[^\\/])/.test(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A harness's encoding of a directory into a file name (`C:\p\x` → `C--p-x`, `/p/x` → `-p-x`). */
function encodeDirectory(directory) {
  return directory.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Matches a Windows path in every spelling and replaces it with the placeholder in the same style.
 *
 * @param {string} windowsPath
 * @param {string} windowsPlaceholder
 * @param {string} posixPlaceholder
 * @returns {Replacement | undefined}
 */
function windowsPathReplacement(windowsPath, windowsPlaceholder, posixPlaceholder) {
  let normalized = windowsPath.replaceAll("/", "\\").replace(/\\+$/, "");
  if (/^\\\\\?\\UNC\\/i.test(normalized)) normalized = `\\\\${normalized.slice(8)}`;
  else if (/^\\\\[?.]\\/.test(normalized)) normalized = normalized.slice(4);
  const drive = /^([A-Za-z]):\\/.exec(normalized);
  const unc = /^\\\\([^\\]+)\\([^\\]+)/.exec(normalized);
  let root;
  let rest;
  if (drive) {
    root = `(?:${DEVICE})?${drive[1]}:|/(?:mnt/|cygdrive/)?${drive[1]}(?=/)`;
    rest = normalized.slice(2);
  } else if (unc) {
    root = `(?:${DEVICE}UNC${BACKSLASH}|${BACKSLASH}${BACKSLASH})${escapeRegExp(unc[1])}${BACKSLASH}${escapeRegExp(unc[2])}`;
    rest = normalized.slice(unc[0].length);
  } else {
    return undefined;
  }
  const segments = rest.split("\\").filter((segment) => segment.length > 0);
  if (segments.length === 0) return undefined;
  const pattern = new RegExp(
    `(?:${root})${segments.map((segment) => `${SEP}${escapeRegExp(segment)}`).join("")}`,
    "gi",
  );
  const replace = (/** @type {string} */ match) => {
    if (match.startsWith("/")) return posixPlaceholder;
    // The separators after a `\\?\` or UNC `\\` prefix tell a raw path from a JSON-escaped one.
    const body = match.replace(/^(?:\\\\|\\){2}(?:[?.](?:\\\\|\\)(?:UNC(?:\\\\|\\))?)?/i, "");
    if (body.includes("\\\\")) return windowsPlaceholder.replaceAll("\\", "\\\\");
    if (body.includes("/")) return windowsPlaceholder.replaceAll("\\", "/");
    return windowsPlaceholder;
  };
  return [pattern, replace];
}

/**
 * Builds the ordered replacement list for this machine and capture.
 *
 * @param {{ project?: string, home?: string, user?: string, host?: string, domain?: string,
 *   extra?: ReadonlyArray<readonly [string, string]> }} options
 * @returns {Replacement[]}
 */
export function machineReplacements(options = {}) {
  const home = options.home ?? os.homedir();
  const user = options.user ?? os.userInfo().username;
  const host = options.host ?? os.hostname();
  const domain =
    options.domain ?? (process.platform === "win32" ? process.env.USERDOMAIN : undefined);
  /** @type {Array<[string, string]>} */
  const pairs = [...(options.extra ?? [])].map(([from, to]) => [from, to]);
  /** @type {Replacement[]} */
  const windowsPaths = [];
  /** @param {string} directory @param {string} windowsPlaceholder @param {string} posixPlaceholder */
  const addDirectory = (directory, windowsPlaceholder, posixPlaceholder) => {
    if (isWindowsPath(directory)) {
      const replacement = windowsPathReplacement(directory, windowsPlaceholder, posixPlaceholder);
      if (replacement) windowsPaths.push(replacement);
      pairs.push([encodeDirectory(directory), encodeDirectory(windowsPlaceholder)]);
      return;
    }
    pairs.push([directory, posixPlaceholder]);
    // Harnesses that key sessions by an encoded cwd (e.g. "-home-user-proj") need the encoded form too.
    pairs.push([directory.replaceAll("/", "-"), posixPlaceholder.replaceAll("/", "-")]);
    pairs.push([encodeDirectory(directory), encodeDirectory(posixPlaceholder)]);
  };
  if (options.project) {
    // A POSIX absolute path resolves as POSIX: `path.resolve("/tmp/x")` on Windows prepends a drive.
    const project = isWindowsPath(options.project)
      ? options.project
      : path.posix.isAbsolute(options.project)
        ? path.posix.resolve(options.project)
        : path.resolve(options.project);
    addDirectory(project, PLACEHOLDER_WINDOWS_PROJECT, PLACEHOLDER_PROJECT);
    const realProject = safeRealpath(project);
    if (realProject !== project) {
      addDirectory(realProject, PLACEHOLDER_WINDOWS_PROJECT, PLACEHOLDER_PROJECT);
    }
  }
  addDirectory(home, PLACEHOLDER_WINDOWS_HOME, PLACEHOLDER_HOME);
  /** @type {Replacement[]} */
  const identities = [];
  const seenIdentity = new Set();
  for (const [value, placeholder] of [
    [host, PLACEHOLDER_HOST],
    [domain, PLACEHOLDER_DOMAIN],
    [user, PLACEHOLDER_USER],
  ]) {
    if (!value || value.length < 3 || value.toLowerCase() === placeholder) continue;
    if (seenIdentity.has(value.toLowerCase())) continue;
    seenIdentity.add(value.toLowerCase());
    // Windows names are case-insensitive: `ALICE`, `Alice` and `alice` are one account.
    identities.push([new RegExp(escapeRegExp(value), "gi"), placeholder]);
  }
  const seen = new Set();
  const literal = pairs
    .filter(([from]) => from.length > 0 && !seen.has(from) && seen.add(from))
    .sort((a, b) => b[0].length - a[0].length);
  // Whole paths first (longest literal first), then bare identity values left in other text.
  return [...windowsPaths, ...literal, ...identities];
}

function safeRealpath(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

function secretPatterns() {
  return SECRET_RULES.map(
    (rule) => new RegExp(rule.pattern.source, `${rule.pattern.flags.replace("g", "")}g`),
  );
}

/**
 * @param {string} value
 * @param {ReadonlyArray<Replacement>} replacements
 * @param {RegExp[]} patterns
 */
export function scrubString(value, replacements, patterns = secretPatterns()) {
  let out = value;
  for (const pattern of patterns) out = out.replace(pattern, SCRUBBED_SECRET);
  for (const [from, to] of replacements) {
    if (typeof from === "string") {
      out = out.split(from).join(typeof to === "string" ? to : to(from));
    } else {
      // A function replacement keeps `$` in a placeholder literal.
      out = out.replace(new RegExp(from.source, from.flags), (match) =>
        typeof to === "string" ? to : to(match),
      );
    }
  }
  return out;
}

/**
 * Whether scrubbed text still holds a machine-identifying value the replacements target.
 *
 * @param {string} scrubbed
 * @param {ReadonlyArray<Replacement>} replacements
 * @returns {string | undefined} a description of the first leak
 */
export function findMachineLeak(scrubbed, replacements) {
  for (const [from] of replacements) {
    if (typeof from === "string") {
      if (from.length >= 3 && scrubbed.includes(from)) return `${from.length} chars`;
    } else if (new RegExp(from.source, from.flags.replace("g", "")).test(scrubbed)) {
      return "a Windows path or identity value";
    }
  }
  return undefined;
}

function scrubValue(value, replacements, patterns, key) {
  if (typeof value === "string") {
    if (key !== undefined && OPAQUE_KEYS.has(key) && value.length > 0) return SCRUBBED_OPAQUE;
    return scrubString(value, replacements, patterns);
  }
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, replacements, patterns));
  if (value !== null && typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[scrubString(k, replacements, patterns)] = scrubValue(v, replacements, patterns, k);
    }
    return out;
  }
  return value;
}

/**
 * Scrubs transcript text: JSON per line where possible, plain text otherwise.
 *
 * @param {string} text
 * @param {ReadonlyArray<Replacement>} replacements
 */
export function scrubTranscriptText(text, replacements) {
  const patterns = secretPatterns();
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const whole = JSON.parse(text);
      return `${JSON.stringify(scrubValue(whole, replacements, patterns), null, 2)}\n`;
    } catch {
      // Not a single JSON document; fall through to line-by-line handling.
    }
  }
  return text
    .split("\n")
    .map((line) => {
      if (line.trim().length === 0) return line;
      try {
        return JSON.stringify(scrubValue(JSON.parse(line), replacements, patterns));
      } catch {
        return scrubString(line, replacements, patterns);
      }
    })
    .join("\n");
}

function parseArgs(argv) {
  const positional = [];
  /** @type {Array<[string, string]>} */
  const extra = [];
  let project;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project") project = argv[++i];
    else if (arg === "--replace") {
      const spec = argv[++i] ?? "";
      const at = spec.indexOf("=");
      if (at <= 0) throw new Error(`--replace expects <from>=<to>, got ${JSON.stringify(spec)}`);
      extra.push([spec.slice(0, at), spec.slice(at + 1)]);
    } else positional.push(arg);
  }
  if (positional.length !== 2) {
    throw new Error(
      "usage: scrub.mjs <input> <output> --project <capture-cwd> [--replace from=to ...]",
    );
  }
  return { input: positional[0], output: positional[1], project, extra };
}

function main() {
  const { input, output, project, extra } = parseArgs(process.argv.slice(2));
  const replacements = machineReplacements({ project, extra });
  const scrubbed = scrubTranscriptText(fs.readFileSync(input, "utf8"), replacements);
  const leaks = scanContent(output, scrubbed);
  if (leaks.length > 0) {
    throw new Error(
      `scrubbed output still matches secret rules: ${leaks.map((leak) => `${leak.rule}@${leak.line}`).join(", ")}`,
    );
  }
  const leak = findMachineLeak(scrubbed, replacements);
  if (leak !== undefined) {
    throw new Error(`scrubbed output still contains a machine-identifying value (${leak})`);
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, scrubbed);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
