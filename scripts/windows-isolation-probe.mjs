#!/usr/bin/env node

/**
 * Cross-user isolation probe for native Windows release lanes.
 *
 * Standalone on purpose (Node built-ins only): the release candidate copies this file next to
 * a node.exe and runs it as a second, unprivileged local user, which cannot read the checkout.
 *
 *   node windows-isolation-probe.mjs --endpoint \\.\pipe\resin-daemon-<hash> \
 *     --file C:\Users\me\.resin\config\config.json --dir C:\Users\me\.resin\state \
 *     --expect denied|allowed [--out result.json]
 *
 * `denied` passes only when every access fails with an access-denied code (EACCES/EPERM); a
 * missing pipe or file (ENOENT) proves nothing and fails the probe. `allowed` is the
 * positive control run as the owner: the pipe connects and every path is readable.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const ACCESS_DENIED_CODES = Object.freeze(["EACCES", "EPERM"]);

function errorCode(error) {
  return error && typeof error === "object" && "code" in error && error.code
    ? String(error.code)
    : "UNKNOWN";
}

/** Try to open the daemon endpoint; resolves "connected" or the error code. */
export function probeEndpoint(endpoint, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const socket = net.connect(endpoint);
    const finish = (outcome) => {
      socket.destroy();
      resolve(outcome);
    };
    socket.setTimeout(timeoutMs, () => finish("ETIMEDOUT"));
    socket.once("connect", () => finish("connected"));
    socket.once("error", (error) => finish(errorCode(error)));
  });
}

export function probeFile(filePath) {
  try {
    fs.readFileSync(filePath);
    return "read";
  } catch (error) {
    return errorCode(error);
  }
}

export function probeDirectory(dirPath) {
  try {
    fs.readdirSync(dirPath);
    return "listed";
  } catch (error) {
    return errorCode(error);
  }
}

/** Judge probe outcomes against the expectation; returns the failures, empty when it holds. */
export function evaluateProbe(result, expect) {
  const failures = [];
  const accesses = [
    ...(result.endpoint ? [{ kind: "endpoint", ...result.endpoint }] : []),
    ...result.files.map((entry) => ({ kind: "file", ...entry })),
    ...result.dirs.map((entry) => ({ kind: "dir", ...entry })),
  ];
  if (accesses.length === 0) failures.push("nothing was probed");
  for (const access of accesses) {
    if (expect === "denied") {
      if (!ACCESS_DENIED_CODES.includes(access.outcome)) {
        failures.push(
          `${access.kind} ${access.target} was ${access.outcome}, expected access denied`,
        );
      }
    } else if (!["connected", "read", "listed"].includes(access.outcome)) {
      failures.push(`${access.kind} ${access.target} was ${access.outcome}, expected access`);
    }
  }
  return failures;
}

/**
 * Who this process runs as, read from the process token rather than the environment:
 * `Start-Process -Credential` hands the child the launching user's environment, so USERNAME
 * names the wrong account. `sid` and `account` (DOMAIN\\user) come from `whoami` on Windows.
 */
export function processIdentity() {
  const identity = { user: os.userInfo().username, account: null, sid: null };
  if (process.platform !== "win32") return identity;
  const whoami = spawnSync(
    path.join(process.env.SystemRoot || "C:\\Windows", "System32", "whoami.exe"),
    ["/user", "/fo", "csv", "/nh"],
    { encoding: "utf8", timeout: 10_000, windowsHide: true },
  );
  const match = /^"([^"]+)","(S-[0-9-]+)"/.exec((whoami.stdout ?? "").trim());
  if (match) {
    identity.account = match[1];
    identity.sid = match[2];
  }
  return identity;
}

/** Same account? Case-insensitive, and `DOMAIN\\user` matches a bare `user`. */
export function sameAccount(actual, expected) {
  const bare = (name) =>
    String(name ?? "")
      .split("\\")
      .pop()
      .toLowerCase();
  return Boolean(actual) && Boolean(expected) && bare(actual) === bare(expected);
}

export async function runProbe({ endpoint, files = [], dirs = [], expect }) {
  if (expect !== "denied" && expect !== "allowed") {
    throw new Error(`--expect must be 'denied' or 'allowed', got '${expect}'`);
  }
  const result = {
    expect,
    ...processIdentity(),
    endpoint: endpoint ? { target: endpoint, outcome: await probeEndpoint(endpoint) } : null,
    files: files.map((target) => ({ target, outcome: probeFile(target) })),
    dirs: dirs.map((target) => ({ target, outcome: probeDirectory(target) })),
  };
  const failures = evaluateProbe(result, expect);
  return { ...result, ok: failures.length === 0, failures };
}

export function parseProbeArgs(argv) {
  const options = { files: [], dirs: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`Missing value for ${arg}`);
      return next;
    };
    if (arg === "--endpoint") options.endpoint = value();
    else if (arg === "--file") options.files.push(value());
    else if (arg === "--dir") options.dirs.push(value());
    else if (arg === "--expect") options.expect = value();
    else if (arg === "--out") options.out = value();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseProbeArgs(process.argv.slice(2));
  const result = await runProbe(options);
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (options.out) fs.writeFileSync(options.out, text, "utf8");
  process.stdout.write(text);
  process.exitCode = result.ok ? 0 : 1;
}
