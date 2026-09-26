#!/usr/bin/env node
/**
 * Scrubs a transcript captured from a real harness install so it can be committed as a
 * decoder fixture.
 *
 * - Machine identity (home directory, user name, host name) and the capture project directory
 *   are rewritten to stable placeholders, longest match first.
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
export const PLACEHOLDER_PROJECT = "/workspace/project";
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

/**
 * Builds the ordered replacement list for this machine and capture.
 *
 * @param {{ project?: string, home?: string, user?: string, host?: string,
 *   extra?: ReadonlyArray<readonly [string, string]> }} options
 * @returns {Array<[string, string]>}
 */
export function machineReplacements(options = {}) {
  const home = options.home ?? os.homedir();
  const user = options.user ?? os.userInfo().username;
  const host = options.host ?? os.hostname();
  /** @type {Array<[string, string]>} */
  const pairs = [...(options.extra ?? [])].map(([from, to]) => [from, to]);
  if (options.project) {
    const project = path.resolve(options.project);
    pairs.push([project, PLACEHOLDER_PROJECT]);
    // Harnesses that key sessions by an encoded cwd (e.g. "-home-user-proj") need the encoded form too.
    pairs.push([project.replaceAll("/", "-"), PLACEHOLDER_PROJECT.replaceAll("/", "-")]);
    const realProject = safeRealpath(project);
    if (realProject !== project) {
      pairs.push([realProject, PLACEHOLDER_PROJECT]);
      pairs.push([realProject.replaceAll("/", "-"), PLACEHOLDER_PROJECT.replaceAll("/", "-")]);
    }
  }
  pairs.push([home, PLACEHOLDER_HOME]);
  pairs.push([home.replaceAll("/", "-"), PLACEHOLDER_HOME.replaceAll("/", "-")]);
  if (host.length >= 3) pairs.push([host, PLACEHOLDER_HOST]);
  if (user.length >= 3) pairs.push([user, PLACEHOLDER_USER]);
  const seen = new Set();
  return pairs
    .filter(([from]) => from.length > 0 && !seen.has(from) && seen.add(from))
    .sort((a, b) => b[0].length - a[0].length);
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
 * @param {ReadonlyArray<readonly [string, string]>} replacements
 * @param {RegExp[]} patterns
 */
export function scrubString(value, replacements, patterns = secretPatterns()) {
  let out = value;
  for (const pattern of patterns) out = out.replace(pattern, SCRUBBED_SECRET);
  for (const [from, to] of replacements) out = out.split(from).join(to);
  return out;
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
 * @param {ReadonlyArray<readonly [string, string]>} replacements
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
  for (const [from] of replacements) {
    if (from.length >= 3 && scrubbed.includes(from)) {
      throw new Error(
        `scrubbed output still contains a machine-identifying value (${from.length} chars)`,
      );
    }
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
