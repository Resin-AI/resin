import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  CommandCapability,
  FsCapability,
  NetCapability,
  SecretCapability,
} from "@resin/contracts";

/**
 * Standard Error code types for canonicalization rejections.
 */
export type CanonicalizationErrorCode =
  | "PATH_TRAVERSAL"
  | "PARENT_WIDENING"
  | "INVALID_PATH_CHARACTERS"
  | "EMPTY_PATH"
  | "INVALID_HOST"
  | "INVALID_SCHEME"
  | "INVALID_PORT"
  | "PRIVATE_IP_BLOCKED"
  | "SHELL_EXECUTION_DENIED"
  | "SHELL_METACHARACTERS_DETECTED"
  | "DANGEROUS_ENV_VAR"
  | "UNAUTHORIZED_ENV_VAR"
  | "INVALID_SECRET_NAME"
  | "INVALID_SECRET_PREFIX"
  | "WORKING_DIR_OUTSIDE_ROOT"
  | "COMMAND_NOT_FOUND"
  | "COMMAND_IDENTITY_VIOLATION"
  | "UNAUTHORIZED_BINARY"
  | "FORBIDDEN_ARGUMENT_PATTERN"
  | "INTERPRETER_ESCAPE_DENIED"
  | "RESPONSE_FILE_DENIED";

export type PolicyCanonicalizationValue =
  | string
  | number
  | boolean
  | null
  | readonly PolicyCanonicalizationValue[]
  | PolicyCanonicalizationValue[]
  | { [key: string]: PolicyCanonicalizationValue | undefined };

export interface PolicyCanonicalizationDetails {
  [key: string]: PolicyCanonicalizationValue | undefined;
}

export class PolicyCanonicalizationError extends Error {
  readonly code: CanonicalizationErrorCode;
  readonly details?: PolicyCanonicalizationDetails;

  constructor(
    code: CanonicalizationErrorCode,
    message: string,
    details?: PolicyCanonicalizationDetails,
  ) {
    super(`[${code}] ${message}`);
    this.name = "PolicyCanonicalizationError";
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// =============================================================================
// Filesystem Canonicalizer
// =============================================================================

export interface FsCanonicalizeOptions {
  allowTemp?: boolean;
  tempDir?: string;
  allowGlob?: boolean;
}

/**
 * Standard sensitive or hidden path patterns that require explicit non-wildcard inclusion.
 */
export const SENSITIVE_PATH_PATTERNS = [
  "**/.git/**",
  "**/.git",
  "**/.ssh/**",
  "**/.ssh",
  "**/.aws/**",
  "**/.aws",
  "**/.env*",
  "**/id_rsa*",
  "**/id_ed25519*",
  "/etc/shadow",
  "/etc/passwd",
  "/etc/sudoers",
  "/private/etc/shadow",
  "/private/etc/passwd",
  "/private/etc/sudoers",
] as const;

/**
 * Resolves platform-specific path aliases (macOS /private/var <-> /var, WSL /mnt/c <-> c:).
 */
export function resolvePlatformAliases(p: string): string {
  let normalized = p.replace(/\\+/g, "/");

  // macOS /private aliases
  if (normalized.startsWith("/private/var/") || normalized === "/private/var") {
    normalized = normalized.replace(/^\/private\/var/, "/var");
  } else if (normalized.startsWith("/private/tmp/") || normalized === "/private/tmp") {
    normalized = normalized.replace(/^\/private\/tmp/, "/tmp");
  } else if (normalized.startsWith("/private/etc/") || normalized === "/private/etc") {
    normalized = normalized.replace(/^\/private\/etc/, "/etc");
  }

  // WSL mount aliases: /mnt/c/... -> c:/...
  const wslMatch = normalized.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
  if (wslMatch) {
    const drive = wslMatch[1].toLowerCase();
    const rest = wslMatch[2] ? `/${wslMatch[2]}` : "";
    normalized = `${drive}:${rest}`;
  }

  // Normalize uppercase Windows drive letter: C:/... -> c:/...
  const winMatch = normalized.match(/^([a-zA-Z]):(?:\/(.*))?$/);
  if (winMatch) {
    const drive = winMatch[1].toLowerCase();
    const rest = winMatch[2] ? `/${winMatch[2]}` : "";
    normalized = `${drive}:${rest}`;
  }

  return normalized;
}

/**
 * Checks whether a path matches any standard sensitive or hidden path patterns.
 */
export function isSensitivePath(targetPath: string, workspaceRoot?: string): boolean {
  const normTarget = normalizeSlashes(targetPath);
  const aliasTarget = resolvePlatformAliases(normTarget);
  const normRoot = workspaceRoot ? normalizeSlashes(workspaceRoot) : undefined;

  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    if (
      matchesPathPattern(normTarget, pattern, normRoot ?? process.cwd()) ||
      matchesPathPattern(aliasTarget, pattern, normRoot ?? process.cwd())
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Checks whether a pattern is an explicit literal non-wildcard match for a target path.
 */
export function isExplicitNonWildcardMatch(
  pattern: string,
  targetPath: string,
  workspaceRoot?: string,
): boolean {
  if (/[*?]/.test(pattern)) {
    return false;
  }
  const normRoot = workspaceRoot ? normalizeSlashes(workspaceRoot) : "";
  const normPattern = normalizeSlashes(pattern);
  const normTarget = normalizeSlashes(targetPath);

  const resolvedPattern = path.isAbsolute(normPattern)
    ? normPattern
    : normalizeSlashes(path.resolve(normRoot, normPattern));
  const resolvedTarget = path.isAbsolute(normTarget)
    ? normTarget
    : normalizeSlashes(path.resolve(normRoot, normTarget));

  if (resolvedTarget === resolvedPattern) return true;
  return resolvePlatformAliases(resolvedTarget) === resolvePlatformAliases(resolvedPattern);
}

/**
 * Normalizes all path separators to POSIX standard forward-slashes.
 */
export function normalizeSlashes(p: string): string {
  return p.replace(/\\+/g, "/");
}

/**
 * Expands placeholders like {{workspace}} or ${workspace} in a path string.
 */
export function expandWorkspacePlaceholder(p: string, workspaceRoot: string): string {
  const normRoot = normalizeSlashes(workspaceRoot);
  return p
    .replace(/<WORKSPACE_ROOT>/gi, normRoot)
    .replace(/\{\{workspace\}\}/gi, normRoot)
    .replace(/\$\{workspace\}/gi, normRoot)
    .replace(/^~(?=$|\/|\\)/, os.homedir());
}

/**
 * Checks whether a target path is strictly contained within a given root directory.
 */
export function isPathInsideRoot(targetPath: string, rootDir: string): boolean {
  const normTarget = normalizeSlashes(targetPath);
  const normRoot = normalizeSlashes(rootDir);

  const aliasTarget = resolvePlatformAliases(normTarget);
  const aliasRoot = resolvePlatformAliases(normRoot);

  if (aliasTarget === aliasRoot) {
    return true;
  }

  const aliasRootPrefix = aliasRoot.endsWith("/") ? aliasRoot : `${aliasRoot}/`;
  if (aliasTarget.startsWith(aliasRootPrefix)) {
    return true;
  }

  const resolvedTarget = normalizeSlashes(path.resolve(rootDir, targetPath));
  const resolvedRoot = normalizeSlashes(path.resolve(rootDir));

  if (resolvedTarget === resolvedRoot) {
    return true;
  }

  const resolvedRootPrefix = resolvedRoot.endsWith("/") ? resolvedRoot : `${resolvedRoot}/`;
  if (resolvedTarget.startsWith(resolvedRootPrefix)) {
    return true;
  }

  const resolvedAliasTarget = resolvePlatformAliases(resolvedTarget);
  const resolvedAliasRoot = resolvePlatformAliases(resolvedRoot);
  if (resolvedAliasTarget === resolvedAliasRoot) {
    return true;
  }
  const resolvedAliasPrefix = resolvedAliasRoot.endsWith("/")
    ? resolvedAliasRoot
    : `${resolvedAliasRoot}/`;
  return resolvedAliasTarget.startsWith(resolvedAliasPrefix);
}

/**
 * Checks for invalid characters (null bytes, control characters, unprintable chars, reserved DOS names).
 */
export function validatePathCharacters(rawPath: string): void {
  if (String(rawPath) !== rawPath || rawPath.length === 0) {
    throw new PolicyCanonicalizationError("EMPTY_PATH", "Path must be a non-empty string");
  }

  // Null bytes or control characters
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(rawPath)) {
    throw new PolicyCanonicalizationError(
      "INVALID_PATH_CHARACTERS",
      `Path contains null or control characters: ${JSON.stringify(rawPath)}`,
      { rawPath },
    );
  }

  // Encoded null bytes or traversal tricks
  if (/%00|%2e%2e|\.\.%2f|\.\.%5c|%2e%2e%2f|%2e%2e%5c|%252e%252e/i.test(rawPath)) {
    throw new PolicyCanonicalizationError(
      "PATH_TRAVERSAL",
      `Path contains encoded traversal sequences: ${rawPath}`,
      { rawPath },
    );
  }

  // Windows / DOS reserved device names
  const segments = normalizeSlashes(rawPath).split("/");
  for (const seg of segments) {
    const baseSeg = seg.split(".")[0]?.toUpperCase();
    if (baseSeg && /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(baseSeg)) {
      throw new PolicyCanonicalizationError(
        "INVALID_PATH_CHARACTERS",
        `Path contains reserved Windows device name: ${seg}`,
        { rawPath, segment: seg },
      );
    }
  }

  // Alternative Data Streams (e.g. file.txt:stream or :$DATA)
  const withoutDrive = rawPath.replace(/^[a-zA-Z]:[/\\]/, "");
  if (withoutDrive.includes(":")) {
    throw new PolicyCanonicalizationError(
      "INVALID_PATH_CHARACTERS",
      `Path contains NTFS alternative data stream colon: ${rawPath}`,
      { rawPath },
    );
  }
}

/**
 * Canonicalizes a filesystem path against the workspace root.
 * Enforces:
 * 1. Unicode NFC normalization.
 * 2. Path traversal rejection (`..` climbing above root).
 * 3. Prevention of parent widening.
 * 4. Resolving relative paths against workspaceRoot.
 * 5. Allowing temp directory only if explicit allowTemp is enabled.
 */
export function canonicalizePath(
  rawPath: string,
  workspaceRoot: string,
  options: FsCanonicalizeOptions = {},
): string {
  validatePathCharacters(rawPath);

  const normalizedUnicode = rawPath.normalize("NFC");
  const expanded = expandWorkspacePlaceholder(normalizedUnicode, workspaceRoot);
  const normalizedSlashes = normalizeSlashes(expanded);

  const normWorkspaceRoot = normalizeSlashes(path.resolve(workspaceRoot));
  const effectiveTempDir = normalizeSlashes(path.resolve(options.tempDir ?? os.tmpdir()));

  // If the path is a glob pattern containing wildcards (* or ?)
  const isGlob = options.allowGlob && /[*?]/.test(normalizedSlashes);

  if (isGlob) {
    // For glob patterns, check the non-glob prefix directory
    const parts = normalizedSlashes.split("/");
    const nonGlobParts: string[] = [];
    for (const part of parts) {
      if (/[*?]/.test(part)) break;
      nonGlobParts.push(part);
    }
    const baseDir = nonGlobParts.join("/") || "/";
    const resolvedBase = path.isAbsolute(baseDir)
      ? path.resolve(baseDir)
      : path.resolve(normWorkspaceRoot, baseDir);
    const normResolvedBase = normalizeSlashes(resolvedBase);

    const insideWorkspace =
      normResolvedBase === normWorkspaceRoot ||
      normResolvedBase.startsWith(
        normWorkspaceRoot.endsWith("/") ? normWorkspaceRoot : `${normWorkspaceRoot}/`,
      );

    const insideTemp =
      options.allowTemp &&
      (normResolvedBase === effectiveTempDir ||
        normResolvedBase.startsWith(
          effectiveTempDir.endsWith("/") ? effectiveTempDir : `${effectiveTempDir}/`,
        ));

    if (!insideWorkspace && !insideTemp) {
      throw new PolicyCanonicalizationError(
        "PARENT_WIDENING",
        `Glob base path escapes allowed workspace/temp root: ${rawPath}`,
        { rawPath, baseDir: normResolvedBase, workspaceRoot: normWorkspaceRoot },
      );
    }

    return normalizedSlashes;
  }

  // Exact path resolution
  const resolved = path.isAbsolute(normalizedSlashes)
    ? path.resolve(normalizedSlashes)
    : path.resolve(normWorkspaceRoot, normalizedSlashes);

  const canonical = normalizeSlashes(resolved);

  const insideWorkspace =
    canonical === normWorkspaceRoot ||
    canonical.startsWith(
      normWorkspaceRoot.endsWith("/") ? normWorkspaceRoot : `${normWorkspaceRoot}/`,
    );

  const insideTemp =
    options.allowTemp &&
    (canonical === effectiveTempDir ||
      canonical.startsWith(
        effectiveTempDir.endsWith("/") ? effectiveTempDir : `${effectiveTempDir}/`,
      ));

  if (!insideWorkspace && !insideTemp) {
    throw new PolicyCanonicalizationError(
      "PARENT_WIDENING",
      `Path escapes workspace root (${normWorkspaceRoot}): ${rawPath} -> ${canonical}`,
      { rawPath, canonical, workspaceRoot: normWorkspaceRoot },
    );
  }

  return canonical;
}

/**
 * Converts a glob pattern into a regular expression.
 */
export function globToRegExp(globPattern: string): RegExp {
  const normPattern = normalizeSlashes(globPattern);
  let regexStr = "^";
  let i = 0;
  while (i < normPattern.length) {
    const char = normPattern[i];
    if (char === "*") {
      if (normPattern[i + 1] === "*") {
        // Recursive wildcard **
        if (normPattern[i + 2] === "/") {
          regexStr += "(?:.*/)?";
          i += 3;
        } else {
          regexStr += ".*";
          i += 2;
        }
      } else {
        // Single wildcard *
        regexStr += "[^/]*";
        i++;
      }
    } else if (char === "?") {
      regexStr += "[^/]";
      i++;
    } else if (/[.\\+^$[\](){}|]/.test(char)) {
      regexStr += `\\${char}`;
      i++;
    } else {
      regexStr += char;
      i++;
    }
  }
  regexStr += "$";
  return new RegExp(regexStr);
}

/**
 * Checks whether a given canonical path matches an allowed or denied path pattern.
 */
export function matchesPathPattern(
  targetPath: string,
  pattern: string,
  workspaceRoot: string,
): boolean {
  const normTarget = normalizeSlashes(path.resolve(workspaceRoot, targetPath));
  const expandedPattern = expandWorkspacePlaceholder(pattern, workspaceRoot);
  const normPattern = normalizeSlashes(expandedPattern);

  const isPatternAbsolute = path.isAbsolute(normPattern) || /^[a-zA-Z]:/.test(normPattern);
  if (!isPatternAbsolute) {
    if (!isPathInsideRoot(normTarget, workspaceRoot)) {
      return false;
    }
  }

  // If pattern is a glob
  if (/[*?]/.test(normPattern)) {
    const resolvedPattern = isPatternAbsolute
      ? normPattern
      : `${normalizeSlashes(path.resolve(workspaceRoot))}/${normPattern.replace(/^\.\//, "")}`;
    const re = globToRegExp(resolvedPattern);
    if (re.test(normTarget)) {
      return true;
    }
    // Also test relative pattern only if inside workspace
    if (isPathInsideRoot(normTarget, workspaceRoot)) {
      const relTarget = path.relative(workspaceRoot, normTarget).replace(/\\/g, "/");
      if (!relTarget.startsWith("..")) {
        const relRe = globToRegExp(normPattern.replace(/^\.\//, ""));
        if (relRe.test(relTarget)) {
          return true;
        }
      }
    }
    // Also test platform alias
    const aliasTarget = resolvePlatformAliases(normTarget);
    const aliasPattern = resolvePlatformAliases(resolvedPattern);
    const aliasRe = globToRegExp(aliasPattern);
    if (aliasRe.test(aliasTarget)) {
      return true;
    }
    return false;
  }

  // Exact literal path match
  const resolvedLiteral = isPatternAbsolute
    ? normPattern
    : normalizeSlashes(path.resolve(workspaceRoot, normPattern));

  if (normTarget === resolvedLiteral) {
    return true;
  }

  return resolvePlatformAliases(normTarget) === resolvePlatformAliases(resolvedLiteral);
}

/**
 * Determines whether a target path is allowed given allowedPatterns and denyPatterns.
 */
export function isPathPermitted(
  targetPath: string,
  allowedPatterns: string[],
  denyPatterns: string[],
  workspaceRoot: string,
): boolean {
  const normTarget = normalizeSlashes(path.resolve(workspaceRoot, targetPath));

  // Sensitive paths remain denied unless explicitly allowed via non-wildcard match
  if (isSensitivePath(normTarget, workspaceRoot)) {
    const hasExplicit = allowedPatterns.some((pattern) =>
      isExplicitNonWildcardMatch(pattern, normTarget, workspaceRoot),
    );
    if (!hasExplicit) {
      return false;
    }
  }

  for (const denyPattern of denyPatterns) {
    if (matchesPathPattern(normTarget, denyPattern, workspaceRoot)) {
      return false;
    }
  }

  // If allowedPatterns is empty, check if target is inside workspace root
  if (allowedPatterns.length === 0) {
    return isPathInsideRoot(normTarget, workspaceRoot);
  }

  for (const allowedPattern of allowedPatterns) {
    if (matchesPathPattern(normTarget, allowedPattern, workspaceRoot)) {
      return true;
    }
  }

  return false;
}

export interface CanonicalFsCapability {
  readPaths: string[];
  writePaths: string[];
  allowWorkspaceRoot: boolean;
  allowTemp: boolean;
  denyPaths: string[];
  maxFileSizeBytes: number;
}

/**
 * Canonicalizes a FsCapability object deterministically.
 */
export function canonicalizeFsCapability(
  fsCap: FsCapability,
  workspaceRoot: string,
): CanonicalFsCapability {
  const normRead = (fsCap.readPaths ?? []).map((p) =>
    canonicalizePath(p, workspaceRoot, {
      allowTemp: fsCap.allowTemp,
      allowGlob: true,
    }),
  );
  const normWrite = (fsCap.writePaths ?? []).map((p) =>
    canonicalizePath(p, workspaceRoot, {
      allowTemp: fsCap.allowTemp,
      allowGlob: true,
    }),
  );
  const normDeny = (fsCap.denyPaths ?? []).map((p) =>
    canonicalizePath(p, workspaceRoot, {
      allowTemp: true,
      allowGlob: true,
    }),
  );

  return {
    readPaths: Array.from(new Set(normRead)).sort(),
    writePaths: Array.from(new Set(normWrite)).sort(),
    allowWorkspaceRoot: Boolean(fsCap.allowWorkspaceRoot),
    allowTemp: Boolean(fsCap.allowTemp),
    denyPaths: Array.from(new Set(normDeny)).sort(),
    maxFileSizeBytes: Math.max(1, Math.floor(fsCap.maxFileSizeBytes ?? 10485760)),
  };
}

// =============================================================================
// Network Canonicalizer
// =============================================================================

export interface CanonicalNetCapability {
  allowOutbound: boolean;
  allowedDomains: string[];
  allowedHosts: string[];
  allowedPorts: number[];
  allowedProtocols: ("http" | "https" | "ws" | "wss")[];
  allowLocalhost: boolean;
  denyPrivateRanges: boolean;
}

/**
 * Standard protocol schemes supported by the network broker.
 */
export const ALLOWED_PROTOCOLS = ["http", "https", "ws", "wss"] as const;
export type AllowedProtocol = (typeof ALLOWED_PROTOCOLS)[number];

/**
 * Canonicalizes and validates a network scheme / protocol.
 */
export function canonicalizeScheme(rawScheme: string): AllowedProtocol {
  if (String(rawScheme) !== rawScheme) {
    throw new PolicyCanonicalizationError("INVALID_SCHEME", "Scheme must be a string");
  }
  const clean = rawScheme
    .toLowerCase()
    .replace(/[:/]+$/, "")
    .trim();
  if (clean === "http" || clean === "https" || clean === "ws" || clean === "wss") {
    return clean;
  }
  throw new PolicyCanonicalizationError(
    "INVALID_SCHEME",
    `Unsupported network protocol scheme: ${rawScheme}`,
    { rawScheme },
  );
}

/**
 * Canonicalizes a port number.
 */
export function canonicalizePort(
  port: number | string | undefined,
  defaultScheme?: string,
): number {
  if (port === undefined || port === null || port === "") {
    if (defaultScheme === "https" || defaultScheme === "wss") return 443;
    return 80;
  }

  const num = Number(port);
  if (!Number.isInteger(num) || num < 1 || num > 65535) {
    throw new PolicyCanonicalizationError(
      "INVALID_PORT",
      `Port must be an integer between 1 and 65535: ${port}`,
      { port },
    );
  }
  return num;
}

/**
 * Canonicalizes a hostname or domain pattern.
 * Trims trailing dots, normalizes to lowercase, rejects invalid chars.
 */
export function canonicalizeHost(rawHost: string): string {
  if (String(rawHost) !== rawHost || rawHost.trim().length === 0) {
    throw new PolicyCanonicalizationError("INVALID_HOST", "Host must be a non-empty string");
  }

  let host = rawHost.trim().toLowerCase().normalize("NFC");

  // Strip protocol prefix if present
  if (host.includes("://")) {
    try {
      const url = new URL(host);
      host = url.hostname;
    } catch {
      host = host.replace(/^[a-z]+:\/\//, "");
    }
  }

  // Strip trailing slash or port if provided as host:port
  if (host.includes("/")) {
    host = host.split("/")[0];
  }
  if (host.includes(":") && !host.startsWith("[")) {
    // IPv4 or hostname with port
    host = host.split(":")[0];
  }

  // Trim trailing dot (e.g. example.com.)
  host = host.replace(/\.+$/, "");

  if (host.length === 0) {
    throw new PolicyCanonicalizationError("INVALID_HOST", `Invalid empty host from: ${rawHost}`);
  }

  // Allow wildcard prefix *.
  const isWildcard = host.startsWith("*.");
  const checkHost = isWildcard ? host.slice(2) : host;

  if (checkHost.length === 0) {
    throw new PolicyCanonicalizationError("INVALID_HOST", `Invalid wildcard host: ${rawHost}`);
  }

  // Validate characters: only alphanumeric, hyphen, dot, and IPv6 brackets/colons
  if (!/^[a-z0-9_.-]+$/.test(checkHost) && !/^\[[a-f0-9:]+\]$/.test(checkHost)) {
    throw new PolicyCanonicalizationError(
      "INVALID_HOST",
      `Host contains invalid characters: ${rawHost}`,
      { rawHost, host },
    );
  }

  return host;
}

/**
 * Parses numeric IPv4 representation (e.g. hex 0x7f000001, octal 0177.0.0.1, integer 2130706433).
 */
function parseIpv4ToNumber(ipStr: string): number | null {
  const parts = ipStr.trim().split(".");
  if (parts.length === 1) {
    // Single integer / hex representation e.g. 2130706433 or 0x7f000001
    const raw = parts[0];
    const num =
      raw.startsWith("0x") || raw.startsWith("0X")
        ? Number.parseInt(raw, 16)
        : raw.startsWith("0") && raw.length > 1
          ? Number.parseInt(raw, 8)
          : Number.parseInt(raw, 10);
    if (!Number.isNaN(num) && num >= 0 && num <= 0xffffffff) {
      return num;
    }
    return null;
  }

  if (parts.length !== 4) {
    return null;
  }

  let fullNum = 0;
  for (let i = 0; i < 4; i++) {
    const p = parts[i];
    let byteVal: number;
    if (p.startsWith("0x") || p.startsWith("0X")) {
      byteVal = Number.parseInt(p, 16);
    } else if (p.startsWith("0") && p.length > 1 && /^[0-7]+$/.test(p)) {
      byteVal = Number.parseInt(p, 8);
    } else {
      byteVal = Number.parseInt(p, 10);
    }

    if (Number.isNaN(byteVal) || byteVal < 0 || byteVal > 255) {
      return null;
    }
    fullNum = (fullNum << 8) | byteVal;
  }

  return fullNum >>> 0; // Unsigned 32-bit int
}

/**
 * Checks whether an IPv4 numeric address falls into private, loopback, or reserved ranges.
 */
function isPrivateIpv4Number(ipNum: number): boolean {
  const b0 = (ipNum >>> 24) & 0xff;
  const b1 = (ipNum >>> 16) & 0xff;
  const b2 = (ipNum >>> 8) & 0xff;
  const b3 = ipNum & 0xff;

  // 0.0.0.0/8 (Current network / default route)
  if (b0 === 0) return true;

  // 127.0.0.0/8 (Loopback)
  if (b0 === 127) return true;

  // 10.0.0.0/8 (Private-Use RFC 1918)
  if (b0 === 10) return true;

  // 172.16.0.0/12 (Private-Use RFC 1918: 172.16.0.0 - 172.31.255.255)
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;

  // 192.168.0.0/16 (Private-Use RFC 1918)
  if (b0 === 192 && b1 === 168) return true;

  // 169.254.0.0/16 (Link-Local RFC 3927)
  if (b0 === 169 && b1 === 254) return true;

  // 100.64.0.0/10 (Carrier-Grade NAT RFC 6598: 100.64.0.0 - 100.127.255.255)
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;

  // 192.0.2.0/24 (TEST-NET-1 RFC 5737)
  if (b0 === 192 && b1 === 0 && b2 === 2) return true;

  // 198.51.100.0/24 (TEST-NET-2 RFC 5737)
  if (b0 === 198 && b1 === 51 && b2 === 100) return true;

  // 203.0.113.0/24 (TEST-NET-3 RFC 5737)
  if (b0 === 203 && b1 === 0 && b2 === 113) return true;

  // 224.0.0.0/4 (Multicast RFC 5771: 224.0.0.0 - 239.255.255.255)
  if (b0 >= 224 && b0 <= 239) return true;

  // 240.0.0.0/4 (Reserved RFC 1112: 240.0.0.0 - 255.255.255.255)
  if (b0 >= 240) return true;

  return false;
}

/**
 * Checks whether a given host or IP is private, reserved, loopback, or local.
 */
export function isPrivateOrReservedIp(ipOrHost: string): boolean {
  const host = ipOrHost
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");

  // Localhost names
  if (
    host === "localhost" ||
    host === "localhost.localdomain" ||
    host.endsWith(".localhost") ||
    host === "local" ||
    host.endsWith(".local")
  ) {
    return true;
  }

  // Check IPv4 parsing
  const ipv4Num = parseIpv4ToNumber(host);
  if (ipv4Num !== null) {
    return isPrivateIpv4Number(ipv4Num);
  }

  // Check IPv6 addresses
  if (host.includes(":")) {
    // Loopback
    if (host === "::1" || host === "0:0:0:0:0:0:0:1" || host === "::") {
      return true;
    }

    // IPv4-mapped IPv6 ::ffff:127.0.0.1 or ::ffff:7f00:1
    if (host.startsWith("::ffff:") || host.startsWith("0:0:0:0:0:ffff:")) {
      const remainder = host.split("ffff:")[1];
      if (remainder) {
        if (remainder.includes(".")) {
          const mappedIpv4 = parseIpv4ToNumber(remainder);
          if (mappedIpv4 !== null) return isPrivateIpv4Number(mappedIpv4);
        } else {
          // Hex format e.g. 7f00:1
          const hexParts = remainder.split(":");
          if (hexParts.length === 2) {
            const high = Number.parseInt(hexParts[0], 16);
            const low = Number.parseInt(hexParts[1], 16);
            if (!Number.isNaN(high) && !Number.isNaN(low)) {
              const num = ((high << 16) | low) >>> 0;
              return isPrivateIpv4Number(num);
            }
          }
        }
      }
      return true;
    }

    // Unique Local Addresses (fc00::/7 -> fc00:: through fdff::)
    if (/^f[cd][0-9a-f]{2}:/i.test(host)) {
      return true;
    }

    // Link-Local (fe80::/10 -> fe80:: through febf::)
    if (/^fe[89ab][0-9a-f]:/i.test(host)) {
      return true;
    }

    // Documentation (2001:db8::/32)
    if (host.startsWith("2001:db8:") || host.startsWith("2001:0db8:")) {
      return true;
    }

    // Multicast (ff00::/8)
    if (host.startsWith("ff")) {
      return true;
    }
  }

  return false;
}

/**
 * Checks whether a hostname matches an allowed domain or host pattern (including wildcards).
 */
export function matchesHostPattern(targetHost: string, allowedPattern: string): boolean {
  const normTarget = canonicalizeHost(targetHost);
  const normPattern = canonicalizeHost(allowedPattern);

  if (normTarget === normPattern) {
    return true;
  }

  if (normPattern.startsWith("*.")) {
    const rootDomain = normPattern.slice(2);
    // Matches sub.domain.com and domain.com itself
    if (normTarget === rootDomain || normTarget.endsWith(`.${rootDomain}`)) {
      return true;
    }
  }

  return false;
}

/**
 * Canonicalizes a NetCapability object deterministically.
 */
export function canonicalizeNetCapability(netCap: NetCapability): CanonicalNetCapability {
  const normDomains = (netCap.allowedDomains ?? []).map(canonicalizeHost);
  const normHosts = (netCap.allowedHosts ?? []).map(canonicalizeHost);
  const normPorts = (netCap.allowedPorts ?? []).map((p) => canonicalizePort(p));
  const normProtocols = (netCap.allowedProtocols ?? ["https"]).map(canonicalizeScheme);

  return {
    allowOutbound: Boolean(netCap.allowOutbound),
    allowedDomains: Array.from(new Set(normDomains)).sort(),
    allowedHosts: Array.from(new Set(normHosts)).sort(),
    allowedPorts: Array.from(new Set(normPorts)).sort((a, b) => a - b),
    allowedProtocols: Array.from(new Set(normProtocols)).sort(),
    allowLocalhost: Boolean(netCap.allowLocalhost),
    denyPrivateRanges: netCap.denyPrivateRanges !== false, // default true
  };
}

// =============================================================================
// Command Canonicalizer
// =============================================================================

export interface CanonicalCommandCapability {
  allowShellExecution: boolean;
  allowedCommands: string[];
  allowedBinaries: string[];
  forbiddenPatterns: string[];
  allowEnvPassthrough: string[];
}

/**
 * Known shell binaries that execute shell scripts and arbitrary commands.
 */
export const SHELL_EXECUTABLES = {
  sh: true,
  bash: true,
  zsh: true,
  csh: true,
  tcsh: true,
  ksh: true,
  fish: true,
  dash: true,
  ash: true,
  cmd: true,
  "cmd.exe": true,
  powershell: true,
  "powershell.exe": true,
  pwsh: true,
  "pwsh.exe": true,
  wscript: true,
  "wscript.exe": true,
  cscript: true,
  "cscript.exe": true,
} as const satisfies Record<string, true>;

/**
 * Checks whether an executable name or path refers to a shell executable.
 */
export function isShellExecutable(cmd: string): boolean {
  const baseName = path.basename(cmd).toLowerCase();
  return Object.hasOwn(SHELL_EXECUTABLES, baseName);
}

/**
 * Detects shell metacharacters that enable command chaining, redirection, or injection.
 */
export function containsShellMetacharacters(commandStr: string): boolean {
  // eslint-disable-next-line no-control-regex
  const shellMetaPattern = /[;&|`$><\\!~*?[\]{}()'\"]|[\x00-\x1f\x7f]/;
  return shellMetaPattern.test(commandStr);
}

/**
 * Detects forbidden characters or control characters in argument strings.
 */
export function containsForbiddenArgMetacharacters(arg: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (/[\x00\r\n`$|;&<>]/.test(arg)) {
    return true;
  }
  return false;
}

export interface InterpreterEscapeFlags {
  [binary: string]: readonly string[];
}

/**
 * Known interpreter escape flags that allow inline execution, code evaluation, or unapproved script loading.
 */
export const INTERPRETER_ESCAPE_FLAGS: InterpreterEscapeFlags = {
  node: [
    "-e",
    "--eval",
    "-p",
    "--print",
    "--input-type",
    "--inspect",
    "--inspect-brk",
    "--inspect-port",
    "--experimental-loader",
    "--import",
    "--require",
    "-r",
  ],
  nodejs: [
    "-e",
    "--eval",
    "-p",
    "--print",
    "--input-type",
    "--inspect",
    "--inspect-brk",
    "--inspect-port",
    "--experimental-loader",
    "--import",
    "--require",
    "-r",
  ],
  python: ["-c", "-m", "--command"],
  python3: ["-c", "-m", "--command"],
  python2: ["-c", "-m", "--command"],
  ruby: ["-e", "-r", "--eval"],
  perl: ["-e", "-E"],
  php: ["-r", "-B", "-R", "-F"],
  sh: ["-c", "-s"],
  bash: ["-c", "-s"],
  zsh: ["-c", "-s"],
  dash: ["-c", "-s"],
  ksh: ["-c", "-s"],
  pwsh: ["-c", "-Command", "-EncodedCommand", "-e", "-ec", "-File"],
  powershell: ["-c", "-Command", "-EncodedCommand", "-e", "-ec", "-File"],
  cmd: ["/c", "/k"],
  "cmd.exe": ["/c", "/k"],
};

/**
 * Checks whether an argument represents an interpreter escape vector for the given executable.
 */
export function isInterpreterEscapeArg(
  binaryNameOrPath: string,
  arg: string,
  _nextArg?: string,
): boolean {
  const baseName = path
    .basename(binaryNameOrPath)
    .toLowerCase()
    .replace(/\.exe$/i, "");
  const flags = INTERPRETER_ESCAPE_FLAGS[baseName] ?? [];
  const cleanArg = arg.trim();

  for (const flag of flags) {
    if (cleanArg === flag || cleanArg.startsWith(`${flag}=`)) {
      return true;
    }
  }

  // Generic interpreter evaluation flags check
  if (
    cleanArg === "-e" ||
    cleanArg === "-c" ||
    cleanArg === "--eval" ||
    cleanArg.startsWith("-e=") ||
    cleanArg.startsWith("-c=") ||
    cleanArg.startsWith("--eval=")
  ) {
    const isInterpreter =
      baseName.includes("node") ||
      baseName.includes("python") ||
      baseName.includes("ruby") ||
      baseName.includes("perl") ||
      baseName.includes("php") ||
      baseName.includes("deno") ||
      baseName.includes("bun");
    if (isInterpreter) {
      return true;
    }
  }

  return false;
}

/**
 * Checks for dangerous command-specific options (e.g. git command injection options).
 */
export function isDangerousOption(binaryNameOrPath: string, arg: string): boolean {
  const baseName = path
    .basename(binaryNameOrPath)
    .toLowerCase()
    .replace(/\.exe$/i, "");
  const cleanArg = arg.trim();

  if (baseName === "git") {
    if (
      cleanArg.startsWith("--upload-pack") ||
      cleanArg.startsWith("--receive-pack") ||
      cleanArg.startsWith("--exec=") ||
      cleanArg === "--exec" ||
      cleanArg.includes("core.fsmonitor") ||
      cleanArg.includes("core.sshCommand") ||
      cleanArg.includes("protocol.ext.allow") ||
      cleanArg.includes("diff.external") ||
      cleanArg.includes("sequence.editor")
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if an argument is a dangerous response file reference escaping workspace boundaries.
 */
export function isResponseFileEscape(
  arg: string,
  workspaceRoot: string,
  allowTemp = true,
): boolean {
  if (!arg.startsWith("@")) return false;
  const filePath = arg.slice(1).trim();
  if (filePath.length === 0) return false;

  if (filePath.includes("..")) return true;

  const targetPath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(workspaceRoot, filePath);

  const inWorkspace = isPathInsideRoot(targetPath, workspaceRoot);
  const inTemp = allowTemp && isPathInsideRoot(targetPath, os.tmpdir());

  return !inWorkspace && !inTemp;
}
/**
 * Dangerous environment variables known to facilitate dynamic library injection,
 * interpreter code hijacking, or unsafe process environment overrides.
 */
export const DANGEROUS_ENV_VARS = {
  LD_PRELOAD: true,
  LD_LIBRARY_PATH: true,
  LD_AUDIT: true,
  LD_ORIGIN_PATH: true,
  LD_DEBUG: true,
  LD_PROFILE: true,
  LD_SHOW_AUXV: true,
  LD_USE_LOAD_BIAS: true,
  DYLD_INSERT_LIBRARIES: true,
  DYLD_LIBRARY_PATH: true,
  DYLD_FRAMEWORK_PATH: true,
  DYLD_FALLBACK_LIBRARY_PATH: true,
  DYLD_IMAGE_SUFFIX: true,
  DYLD_PRINT_LIBRARIES: true,
  NODE_OPTIONS: true,
  NODE_PATH: true,
  PYTHONPATH: true,
  PYTHONHOME: true,
  PYTHONSTARTUP: true,
  PYTHONOPTIMIZE: true,
  PYTHONDEBUG: true,
  PYTHONINSPECT: true,
  PYTHONUNBUFFERED: true,
  PYTHONDONTWRITEBYTECODE: true,
  PYTHONHASHSEED: true,
  PYTHONNOUSERSITE: true,
  PYTHONUSERBASE: true,
  RUBYOPT: true,
  RUBYLIB: true,
  PERL5OPT: true,
  PERL5LIB: true,
  PERLLIB: true,
  PHP_INI_SCAN_DIR: true,
  JAVA_TOOL_OPTIONS: true,
  _JAVA_OPTIONS: true,
  JDK_JAVA_OPTIONS: true,
  BASH_ENV: true,
  ENV: true,
  PROMPT_COMMAND: true,
  SHELLOPTS: true,
  BASHOPTS: true,
  GLIBC_TUNABLES: true,
  IFS: true,
  PS4: true,
  GLOBIGNORE: true,
} as const satisfies Record<string, true>;

export const DANGEROUS_ENV_PREFIXES: string[] = [
  "LD_",
  "DYLD_",
  "PYTHON",
  "NODE_OPTIONS",
  "RUBY",
  "PERL5",
  "PERL_",
  "JAVA_",
  "_JAVA_",
  "JDK_",
  "BASH_",
  "SHELLOPTS",
  "BASHOPTS",
];

/**
 * Checks whether an environment variable name is dangerous.
 */
export function isDangerousEnvVar(envName: string): boolean {
  if (!envName || String(envName) !== envName) return true;
  const upper = envName.toUpperCase().trim();
  if (Object.hasOwn(DANGEROUS_ENV_VARS, upper)) {
    return true;
  }
  for (const prefix of DANGEROUS_ENV_PREFIXES) {
    if (upper.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

/**
 * Validates whether an environment variable name is safe and valid.
 */
export function canonicalizeEnvName(rawName: string): string {
  if (String(rawName) !== rawName || rawName.trim().length === 0) {
    throw new PolicyCanonicalizationError("DANGEROUS_ENV_VAR", "Env var name must be non-empty");
  }

  const name = rawName.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new PolicyCanonicalizationError(
      "DANGEROUS_ENV_VAR",
      `Invalid environment variable identifier: ${name}`,
      { name },
    );
  }

  return name;
}

/**
 * Immutable command identity evidence captured at resolution time.
 */
export interface CommandIdentity {
  canonicalPath: string;
  realPath: string;
  inode?: number;
  device?: number;
  size?: number;
  mtimeMs?: number;
  uid?: number;
  gid?: number;
  sha256?: string;
}

export interface ResolveBinaryOptions {
  searchPaths?: string[];
  allowNonExistent?: boolean;
  computeDigest?: boolean;
  workspaceRoot?: string;
}

/**
 * Resolves an executable binary to its canonical absolute path and captures identity metadata.
 */
export function resolveCanonicalBinary(
  binary: string,
  options: ResolveBinaryOptions = {},
): CommandIdentity {
  if (String(binary) !== binary || binary.trim().length === 0) {
    throw new PolicyCanonicalizationError("EMPTY_PATH", "Binary path must be a non-empty string");
  }

  const clean = binary.trim();

  if (clean.includes("..")) {
    throw new PolicyCanonicalizationError(
      "PATH_TRAVERSAL",
      `Binary path cannot contain path traversal: ${clean}`,
      { binary },
    );
  }

  if (containsShellMetacharacters(clean)) {
    throw new PolicyCanonicalizationError(
      "SHELL_METACHARACTERS_DETECTED",
      `Binary path contains forbidden shell metacharacters: ${clean}`,
      { binary },
    );
  }

  let candidatePath: string | null = null;
  if (path.isAbsolute(clean)) {
    candidatePath = path.resolve(clean);
  } else if (clean.includes("/") || clean.includes("\\")) {
    candidatePath = options.workspaceRoot
      ? path.resolve(options.workspaceRoot, clean)
      : path.resolve(clean);
  } else {
    // Bare binary name like "git", "node"
    if (clean === "node") {
      candidatePath = process.execPath;
    } else {
      const safePaths = options.searchPaths ?? [
        "/usr/bin",
        "/bin",
        "/usr/local/bin",
        "/opt/homebrew/bin",
        "/usr/sbin",
        "/sbin",
      ];
      if (process.env.PATH) {
        const pathDirs = process.env.PATH.split(path.delimiter);
        for (const dir of pathDirs) {
          if (!dir || dir === "." || dir.startsWith("./") || dir.startsWith("../")) continue;
          if (dir === "/tmp" || dir.startsWith("/tmp/") || dir.startsWith("/var/tmp/")) continue;
          if (!safePaths.includes(dir)) {
            safePaths.push(dir);
          }
        }
      }

      for (const dir of safePaths) {
        const full = path.join(dir, clean);
        if (fs.existsSync(full)) {
          candidatePath = full;
          break;
        }
        if (process.platform === "win32") {
          for (const ext of [".exe", ".cmd", ".bat"]) {
            const fullWithExt = path.join(dir, `${clean}${ext}`);
            if (fs.existsSync(fullWithExt)) {
              candidatePath = fullWithExt;
              break;
            }
          }
          if (candidatePath) break;
        }
      }
    }
  }

  if (!candidatePath || !fs.existsSync(candidatePath)) {
    if (options.allowNonExistent) {
      const fallback = candidatePath ? path.resolve(candidatePath) : `/usr/bin/${clean}`;
      return {
        canonicalPath: fallback,
        realPath: fallback,
      };
    }
    throw new PolicyCanonicalizationError(
      "PATH_TRAVERSAL",
      `Executable binary not found on host: ${clean}`,
      { binary: clean },
    );
  }

  let realPath: string;
  try {
    realPath = fs.realpathSync.native
      ? fs.realpathSync.native(candidatePath)
      : fs.realpathSync(candidatePath);
  } catch {
    realPath = fs.realpathSync(candidatePath);
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(realPath);
  } catch (err) {
    throw new PolicyCanonicalizationError(
      "PATH_TRAVERSAL",
      `Unable to stat executable binary '${realPath}': ${err instanceof Error ? err.message : String(err)}`,
      { binary: clean, realPath },
    );
  }

  if (!stat.isFile()) {
    throw new PolicyCanonicalizationError(
      "PATH_TRAVERSAL",
      `Executable path is not a regular file: ${realPath}`,
      { binary: clean, realPath },
    );
  }

  let sha256Hash: string | undefined;
  if (options.computeDigest) {
    try {
      const content = fs.readFileSync(realPath);
      sha256Hash = crypto.createHash("sha256").update(content).digest("hex");
    } catch {
      // ignore
    }
  }

  return {
    canonicalPath: path.resolve(candidatePath),
    realPath,
    inode: stat.ino,
    device: stat.dev,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    uid: stat.uid,
    gid: stat.gid,
    sha256: sha256Hash,
  };
}

/**
 * Re-verifies executable identity against previously recorded identity evidence.
 * Detects symlink swaps, binary replacements, inode modifications, and hash changes.
 */
export interface ExecutableIdentityVerificationResult {
  valid: boolean;
  reason?: string;
}

export function verifyExecutableIdentity(
  expected: CommandIdentity,
  currentPath?: string,
): ExecutableIdentityVerificationResult {
  const target = currentPath ?? expected.canonicalPath;
  if (!fs.existsSync(target)) {
    return { valid: false, reason: `Executable file does not exist: ${target}` };
  }

  let currentRealPath: string;
  try {
    currentRealPath = fs.realpathSync.native
      ? fs.realpathSync.native(target)
      : fs.realpathSync(target);
  } catch (err) {
    return {
      valid: false,
      reason: `Failed to resolve realpath for '${target}': ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (currentRealPath !== expected.realPath) {
    return {
      valid: false,
      reason: `Executable realpath mismatch (possible symlink swap): expected ${expected.realPath}, got ${currentRealPath}`,
    };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(currentRealPath);
  } catch (err) {
    return {
      valid: false,
      reason: `Failed to stat executable '${currentRealPath}': ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!stat.isFile()) {
    return { valid: false, reason: `Target executable is not a regular file: ${currentRealPath}` };
  }

  if (expected.inode !== undefined && expected.device !== undefined) {
    if (stat.ino !== expected.inode || stat.dev !== expected.device) {
      return {
        valid: false,
        reason: `Executable inode/device mismatch: expected inode ${expected.inode} on dev ${expected.device}, got inode ${stat.ino} on dev ${stat.dev}`,
      };
    }
  }

  if (expected.sha256) {
    try {
      const content = fs.readFileSync(currentRealPath);
      const hash = crypto.createHash("sha256").update(content).digest("hex");
      if (hash !== expected.sha256) {
        return {
          valid: false,
          reason: `Executable SHA256 digest mismatch: expected ${expected.sha256}, got ${hash}`,
        };
      }
    } catch (err) {
      return {
        valid: false,
        reason: `Failed to compute executable digest: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return { valid: true };
}

/**
 * Canonicalizes a command / executable name.
 */
export function canonicalizeCommand(cmd: string): string {
  if (String(cmd) !== cmd || cmd.trim().length === 0) {
    throw new PolicyCanonicalizationError("EMPTY_PATH", "Command must be a non-empty string");
  }

  const clean = cmd.trim();

  // Traversal check
  if (clean.includes("..")) {
    throw new PolicyCanonicalizationError(
      "PATH_TRAVERSAL",
      `Command executable path cannot contain path traversal: ${clean}`,
      { cmd },
    );
  }

  // Metacharacters check
  if (containsShellMetacharacters(clean)) {
    throw new PolicyCanonicalizationError(
      "SHELL_METACHARACTERS_DETECTED",
      `Command contains forbidden shell metacharacters: ${clean}`,
      { cmd },
    );
  }

  return normalizeSlashes(clean);
}

/**
 * Matches an argument against an argument pattern (exact, prefix, or regex).
 */
export function matchesArgPattern(arg: string, pattern: string): boolean {
  if (arg === pattern) return true;

  if (pattern.startsWith("^") || pattern.endsWith("$")) {
    try {
      const re = new RegExp(pattern);
      return re.test(arg);
    } catch {
      return false;
    }
  }

  if (pattern.includes("*")) {
    const re = globToRegExp(pattern);
    return re.test(arg);
  }

  return false;
}

/**
 * Validates a working directory against workspace root and temp directory.
 */
export function validateWorkingDir(
  workingDir: string,
  workspaceRoot: string,
  allowTemp = false,
  tempDir?: string,
): void {
  const normTarget = normalizeSlashes(path.resolve(workspaceRoot, workingDir));
  const normRoot = normalizeSlashes(path.resolve(workspaceRoot));
  const effectiveTemp = normalizeSlashes(path.resolve(tempDir ?? os.tmpdir()));

  const inWorkspace =
    normTarget === normRoot ||
    normTarget.startsWith(normRoot.endsWith("/") ? normRoot : `${normRoot}/`);
  const inTemp =
    allowTemp &&
    (normTarget === effectiveTemp ||
      normTarget.startsWith(effectiveTemp.endsWith("/") ? effectiveTemp : `${effectiveTemp}/`));

  if (!inWorkspace && !inTemp) {
    throw new PolicyCanonicalizationError(
      "WORKING_DIR_OUTSIDE_ROOT",
      `Working directory escapes workspace root: ${workingDir}`,
      { workingDir, normTarget, workspaceRoot: normRoot },
    );
  }
}

/**
 * Canonicalizes a CommandCapability object deterministically.
 */
export function canonicalizeCommandCapability(
  cmdCap: CommandCapability,
): CanonicalCommandCapability {
  const normCommands = (cmdCap.allowedCommands ?? []).map(canonicalizeCommand);
  const normBinaries = (cmdCap.allowedBinaries ?? []).map(canonicalizeCommand);
  const normEnv = (cmdCap.allowEnvPassthrough ?? [])
    .map(canonicalizeEnvName)
    .filter((name) => !isDangerousEnvVar(name));

  return {
    allowShellExecution: Boolean(cmdCap.allowShellExecution),
    allowedCommands: Array.from(new Set(normCommands)).sort(),
    allowedBinaries: Array.from(new Set(normBinaries)).sort(),
    forbiddenPatterns: Array.from(new Set(cmdCap.forbiddenPatterns ?? [])).sort(),
    allowEnvPassthrough: Array.from(new Set(normEnv)).sort(),
  };
}

// =============================================================================
// Secret Canonicalizer
// =============================================================================

export interface CanonicalSecretCapability {
  allowedSecretNames: string[];
  allowedPrefixes: string[];
  denyDirectRead: boolean;
  injectAsEnv: boolean;
}

/**
 * Canonicalizes and validates a secret alias / name.
 */
export function canonicalizeSecretName(secretName: string): string {
  if (String(secretName) !== secretName || secretName.trim().length === 0) {
    throw new PolicyCanonicalizationError("INVALID_SECRET_NAME", "Secret name must be non-empty");
  }

  const name = secretName.trim();
  // Standard secret naming: uppercase alphanumeric with underscores or dots/hyphens
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new PolicyCanonicalizationError(
      "INVALID_SECRET_NAME",
      `Secret name contains invalid characters: ${name}`,
      { name },
    );
  }

  return name;
}

/**
 * Canonicalizes and validates a secret prefix.
 */
export function canonicalizeSecretPrefix(prefix: string): string {
  if (String(prefix) !== prefix || prefix.trim().length === 0) {
    throw new PolicyCanonicalizationError(
      "INVALID_SECRET_PREFIX",
      "Secret prefix must be non-empty",
    );
  }

  const clean = prefix.trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(clean)) {
    throw new PolicyCanonicalizationError(
      "INVALID_SECRET_PREFIX",
      `Secret prefix contains invalid characters: ${clean}`,
      { prefix },
    );
  }

  return clean;
}

/**
 * Checks whether a named secret alias is permitted by allowed secret names or allowed prefixes.
 */
export function isSecretAllowed(
  secretName: string,
  allowedNames: string[],
  allowedPrefixes: string[],
): boolean {
  const normName = canonicalizeSecretName(secretName);

  for (const allowed of allowedNames) {
    if (normName === allowed) {
      return true;
    }
  }

  for (const prefix of allowedPrefixes) {
    if (normName.startsWith(prefix)) {
      return true;
    }
  }

  return false;
}

/**
 * Canonicalizes a SecretCapability object deterministically.
 */
export function canonicalizeSecretCapability(
  secretCap: SecretCapability,
): CanonicalSecretCapability {
  const normNames = (secretCap.allowedSecretNames ?? []).map(canonicalizeSecretName);
  const normPrefixes = (secretCap.allowedPrefixes ?? []).map(canonicalizeSecretPrefix);

  return {
    allowedSecretNames: Array.from(new Set(normNames)).sort(),
    allowedPrefixes: Array.from(new Set(normPrefixes)).sort(),
    denyDirectRead: secretCap.denyDirectRead !== false, // default true
    injectAsEnv: secretCap.injectAsEnv !== false, // default true
  };
}
