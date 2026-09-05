import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type CommandCapability,
  type SecretReference,
  SecretReferenceSchema,
  isSecretReference,
} from "@resin/contracts";
import {
  type CommandIdentity,
  containsForbiddenArgMetacharacters,
  containsShellMetacharacters,
  isDangerousEnvVar,
  isDangerousOption,
  isInterpreterEscapeArg,
  isPathInsideRoot,
  isResponseFileEscape,
  isShellExecutable,
  matchesArgPattern,
  normalizeSlashes,
  resolveCanonicalBinary,
  verifyExecutableIdentity,
} from "../policy/canonicalizers.js";
import {
  COMMAND_PLACEHOLDER_CLASSES,
  matchCommandProfileArgs,
} from "../policy/command-template.js";
import { withResolvers } from "../worker/protocol.js";
import {
  BaseCapabilityBroker,
  type BaseCapabilityBrokerOptions,
  type BrokerContext,
  BrokerSecurityError,
} from "./base.js";
import { prepareReadOnlyGit } from "./read-only-git.js";
import type { SecretBroker } from "./secret-broker.js";

const PYTHON_TEST_MODULES: Record<string, true> = { unittest: true, pytest: true };

/**
 * Standard parameters for brokered command execution.
 */
export interface CommandExecuteParams {
  command?: string;
  executable?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | SecretReference>;
  stdin?: string | SecretReference;
  timeoutMs?: number;
  maxOutputSizeBytes?: number;
  readOnlyGit?: boolean;
  truncateOutput?: boolean;
  secretEnv?: Record<string, SecretReference | string>;
}

/**
 * Result of brokered command execution.
 */
export interface CommandExecuteResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated?: boolean;
}

export interface SanitizedChildEnvironment {
  [key: string]: string;
}

export interface AuthorizedCommandExecution {
  identity: CommandIdentity;
  executable: string;
  args: string[];
  cwd: string;
  childEnv: SanitizedChildEnvironment;
}

/**
 * Options for configuring CommandBroker.
 */
export interface CommandBrokerOptions extends BaseCapabilityBrokerOptions {
  secretBroker?: SecretBroker;
}

/**
 * Deterministic argv lexer that securely parses command lines into exact argument vectors.
 * Supports POSIX single/double quotes, backslash escapes, empty quoted arguments, and Unicode text.
 * Rejects unterminated quotes/escapes, shell operators, and expansions.
 */
export function parseCommandLine(commandLine: string): string[] {
  if (String(commandLine) !== commandLine) {
    throw new BrokerSecurityError("INVALID_PATH", "Command line must be a string");
  }

  const tokens: string[] = [];
  let currentToken = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let hasToken = false;

  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i];

    if (inSingleQuote) {
      if (ch === "'") {
        inSingleQuote = false;
      } else if (ch === "\0") {
        throw new BrokerSecurityError("SHELL_EXECUTION_DENIED", "Null bytes are prohibited");
      } else {
        currentToken += ch;
        hasToken = true;
      }
    } else if (inDoubleQuote) {
      if (ch === '"') {
        inDoubleQuote = false;
      } else if (ch === "\\") {
        if (i + 1 >= commandLine.length) {
          throw new BrokerSecurityError(
            "SHELL_EXECUTION_DENIED",
            "Unterminated backslash escape sequence",
          );
        }
        i++;
        const nextCh = commandLine[i];
        if (nextCh === "\0") {
          throw new BrokerSecurityError("SHELL_EXECUTION_DENIED", "Null bytes are prohibited");
        }
        currentToken += nextCh;
        hasToken = true;
      } else if (ch === "\0") {
        throw new BrokerSecurityError("SHELL_EXECUTION_DENIED", "Null bytes are prohibited");
      } else if (ch === "$" || ch === "`") {
        throw new BrokerSecurityError(
          "SHELL_EXECUTION_DENIED",
          "Shell variable or command expansions are prohibited",
        );
      } else if (ch === "\r" || ch === "\n") {
        throw new BrokerSecurityError(
          "SHELL_EXECUTION_DENIED",
          "Control characters or newlines are prohibited",
        );
      } else {
        currentToken += ch;
        hasToken = true;
      }
    } else {
      // Outside quotes
      if (ch === "'") {
        inSingleQuote = true;
        hasToken = true;
      } else if (ch === '"') {
        inDoubleQuote = true;
        hasToken = true;
      } else if (ch === "\\") {
        if (i + 1 >= commandLine.length) {
          throw new BrokerSecurityError(
            "SHELL_EXECUTION_DENIED",
            "Unterminated backslash escape sequence",
          );
        }
        i++;
        const nextCh = commandLine[i];
        if (nextCh === "\0") {
          throw new BrokerSecurityError("SHELL_EXECUTION_DENIED", "Null bytes are prohibited");
        }
        currentToken += nextCh;
        hasToken = true;
      } else if (/\s/.test(ch)) {
        if (hasToken) {
          tokens.push(currentToken);
          currentToken = "";
          hasToken = false;
        }
      } else if (ch === "\0") {
        throw new BrokerSecurityError("SHELL_EXECUTION_DENIED", "Null bytes are prohibited");
      } else if (
        ch === ";" ||
        ch === "&" ||
        ch === "|" ||
        ch === ">" ||
        ch === "<" ||
        ch === "$" ||
        ch === "`" ||
        ch === "(" ||
        ch === ")" ||
        ch === "{" ||
        ch === "}" ||
        ch === "!"
      ) {
        throw new BrokerSecurityError(
          "SHELL_EXECUTION_DENIED",
          `Shell operator or expansion '${ch}' is prohibited`,
          { command: commandLine },
        );
      } else {
        currentToken += ch;
        hasToken = true;
      }
    }
  }

  if (inSingleQuote) {
    throw new BrokerSecurityError(
      "SHELL_EXECUTION_DENIED",
      "Unterminated single quote in command line",
    );
  }
  if (inDoubleQuote) {
    throw new BrokerSecurityError(
      "SHELL_EXECUTION_DENIED",
      "Unterminated double quote in command line",
    );
  }

  if (hasToken) {
    tokens.push(currentToken);
  }

  return tokens;
}

export const lexCommandLine = parseCommandLine;

const COMMAND_PLACEHOLDER_PATTERN = new RegExp(
  Object.keys(COMMAND_PLACEHOLDER_CLASSES)
    .sort((left, right) => right.length - left.length)
    .map((placeholder) => placeholder.replace("$", "\\$"))
    .join("|"),
  "g",
);

/**
 * Helper to detect sensitive or credential paths for response file validation.
 */
function isCredentialOrSensitivePath(targetPath: string, workspaceRoot?: string): boolean {
  if (!targetPath || String(targetPath) !== targetPath) {
    return false;
  }
  const clean = targetPath.replace(/\\+/g, "/").replace(/^\.\//, "");
  const parts = clean.split("/").filter(Boolean);
  const base = path.posix.basename(clean);

  if (parts.some((part) => part === ".git" || part === ".ssh" || part === ".aws")) {
    return true;
  }
  if (
    clean === ".docker" ||
    clean === ".docker/config.json" ||
    clean.endsWith("/.docker") ||
    clean.endsWith("/.docker/config.json") ||
    clean.includes("/.docker/") ||
    parts.includes(".docker")
  ) {
    return true;
  }
  if (base === ".env" || base.startsWith(".env.") || base.startsWith(".env")) {
    return true;
  }
  if (base === ".npmrc" || base === ".netrc") {
    return true;
  }
  if (
    base.startsWith("id_rsa") ||
    base.startsWith("id_ed25519") ||
    base.startsWith("id_ecdsa") ||
    base.startsWith("id_dsa")
  ) {
    return true;
  }
  if (
    clean === "/etc/shadow" ||
    clean === "/etc/passwd" ||
    clean === "/etc/sudoers" ||
    clean === "/private/etc/shadow" ||
    clean === "/private/etc/passwd" ||
    clean === "/private/etc/sudoers" ||
    clean.endsWith("/etc/shadow") ||
    clean.endsWith("/etc/passwd") ||
    clean.endsWith("/etc/sudoers")
  ) {
    return true;
  }
  return false;
}

/**
 * Comprehensive check for Node/Python/shell/PowerShell interpreter escape arguments.
 */
function isInterpreterEscape(binaryNameOrPath: string, arg: string, nextArg?: string): boolean {
  if (isInterpreterEscapeArg(binaryNameOrPath, arg, nextArg)) {
    return true;
  }

  const baseName = path
    .basename(binaryNameOrPath)
    .toLowerCase()
    .replace(/\.exe$/i, "");
  const cleanArg = arg.trim();

  // 1. Node / JS runtimes
  if (
    baseName === "node" ||
    baseName === "nodejs" ||
    baseName === "bun" ||
    baseName === "deno" ||
    baseName === "ts-node"
  ) {
    const nodeFlags = [
      "-e",
      "--eval",
      "-p",
      "--print",
      "-i",
      "--interactive",
      "-r",
      "--require",
      "--import",
      "--loader",
      "--experimental-loader",
      "--input-type",
      "--inspect",
      "--inspect-brk",
      "--inspect-port",
      "--inspect-publish-uid",
      "--env-file",
      "--openssl-config",
      "--tls-cipher-list",
      "--conditions",
      "--experimental-specifier-resolution",
      "--policy-integrity",
      "--diagnostic-dir",
      "--secure-heap",
      "--trace-sigint",
      "--unhandled-rejections",
    ];
    for (const flag of nodeFlags) {
      if (cleanArg === flag || cleanArg.startsWith(`${flag}=`)) {
        return true;
      }
    }
  }

  // 2. Python runtimes
  if (
    baseName === "python" ||
    baseName === "python3" ||
    baseName === "python2" ||
    baseName.startsWith("python3.") ||
    baseName.startsWith("python2.") ||
    baseName === "py" ||
    baseName === "pypy" ||
    baseName === "pypy3"
  ) {
    const pyFlags = ["-c", "--command", "-m", "--module", "-i", "--interactive", "-W", "-X"];
    for (const flag of pyFlags) {
      if (cleanArg === flag || cleanArg.startsWith(`${flag}=`)) {
        return true;
      }
    }
    if (/^-[a-zA-Z0-9]*[cmi][a-zA-Z0-9]*/.test(cleanArg)) {
      return true;
    }
  }

  // 3. Shells
  if (["sh", "bash", "zsh", "dash", "ksh", "ash", "tcsh", "csh"].includes(baseName)) {
    const shellFlags = [
      "-c",
      "-s",
      "-i",
      "--rcfile",
      "--init-file",
      "--noprofile",
      "--norc",
      "--command",
    ];
    for (const flag of shellFlags) {
      if (cleanArg === flag || cleanArg.startsWith(`${flag}=`)) {
        return true;
      }
    }
    if (/^-[a-zA-Z0-9]*[csi][a-zA-Z0-9]*/.test(cleanArg)) {
      return true;
    }
  }

  // 4. PowerShell
  if (baseName === "pwsh" || baseName === "powershell") {
    const pwshFlags = [
      "-c",
      "-command",
      "-encodedcommand",
      "-e",
      "-ec",
      "-file",
      "-f",
      "-i",
      "-interactive",
    ];
    const lowerArg = cleanArg.toLowerCase();
    for (const flag of pwshFlags) {
      if (lowerArg === flag || lowerArg.startsWith(`${flag}=`) || lowerArg.startsWith(`${flag}:`)) {
        return true;
      }
    }
  }

  // 5. CMD
  if (baseName === "cmd") {
    const cmdFlags = ["/c", "/k", "/r"];
    const lowerArg = cleanArg.toLowerCase();
    for (const flag of cmdFlags) {
      if (lowerArg === flag || lowerArg.startsWith(`${flag}:`)) {
        return true;
      }
    }
  }

  // 6. Generic interpreter evaluation
  if (
    cleanArg === "-e" ||
    cleanArg === "-c" ||
    cleanArg === "-i" ||
    cleanArg === "-p" ||
    cleanArg === "--eval" ||
    cleanArg === "--print" ||
    cleanArg.startsWith("-e=") ||
    cleanArg.startsWith("-c=") ||
    cleanArg.startsWith("-i=") ||
    cleanArg.startsWith("-p=") ||
    cleanArg.startsWith("--eval=") ||
    cleanArg.startsWith("--print=")
  ) {
    return true;
  }

  return false;
}

/**
 * Comprehensive check for response file escapes (boundary escape or credential targeting).
 */
function isResponseFileEscapeArg(arg: string, workspaceRoot: string, scratchDir?: string): boolean {
  if (isResponseFileEscape(arg, workspaceRoot)) {
    return true;
  }

  const cleanArg = arg.trim();
  let filePath: string | null = null;

  if (cleanArg.startsWith("@")) {
    filePath = cleanArg.slice(1).trim();
  } else if (cleanArg.includes("=@")) {
    const atIndex = cleanArg.indexOf("=@");
    filePath = cleanArg.slice(atIndex + 2).trim();
  } else if (cleanArg.includes(":@")) {
    const atIndex = cleanArg.indexOf(":@");
    filePath = cleanArg.slice(atIndex + 2).trim();
  }

  if (!filePath) {
    return false;
  }

  const resolvedTarget = path.isAbsolute(filePath)
    ? normalizeSlashes(path.resolve(filePath))
    : normalizeSlashes(path.resolve(workspaceRoot, filePath));

  const inWorkspace = isPathInsideRoot(resolvedTarget, workspaceRoot);
  const inScratch = scratchDir ? isPathInsideRoot(resolvedTarget, scratchDir) : false;
  const inTmp = isPathInsideRoot(resolvedTarget, os.tmpdir());

  if (!inWorkspace && !inScratch && !inTmp) {
    return true;
  }

  if (
    isCredentialOrSensitivePath(resolvedTarget, workspaceRoot) ||
    isCredentialOrSensitivePath(filePath, workspaceRoot)
  ) {
    return true;
  }

  return false;
}

/**
 * Broker that securely handles subprocess execution and command delegation.
 * Enforces canonical binary path resolution, immutable executable identity verification,
 * shell restriction, argument vector validation, and strict child environment sanitization.
 */
export class CommandBroker extends BaseCapabilityBroker {
  readonly serviceName = "cmd" as const;
  private secretBroker?: SecretBroker;

  constructor(options: CommandBrokerOptions = {}) {
    super(options);
    this.secretBroker = options.secretBroker;
  }

  /**
   * Sets or updates the secret broker for credential mediation.
   */
  setSecretBroker(broker: SecretBroker): void {
    this.secretBroker = broker;
  }

  /**
   * Validates that all path components along a resolved path contain no symlinks
   * between the canonical root and the target directory.
   */
  private assertNoSymlinksInPath(targetPath: string, rootDir: string): void {
    const normTarget = path.normalize(targetPath);
    const normRoot = path.normalize(rootDir);

    let current = normTarget;
    while (current !== normRoot && current !== path.dirname(current)) {
      try {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) {
          throw new BrokerSecurityError(
            "WORKING_DIRECTORY_DENIED",
            `Working directory component contains symbolic link: ${current}`,
            { path: current, targetPath },
          );
        }
      } catch (err) {
        if (err instanceof BrokerSecurityError) throw err;
        throw new BrokerSecurityError(
          "FILE_NOT_FOUND",
          `Failed to inspect working directory component: ${current} (${err instanceof Error ? err.message : String(err)})`,
          { path: current, targetPath },
        );
      }
      current = path.dirname(current);
    }
  }

  /**
   * Safely resolves and validates containment of the working directory against approved roots.
   * Enforces realpath resolution, rejects symlinks and escapes, and verifies directory existence.
   */
  private validateAndResolveCwd(
    requestedCwd: string | undefined,
    workspaceRoot: string,
    scratchDir?: string,
  ): string {
    // 1. Resolve canonical workspace and scratch roots
    let realWorkspaceRoot: string;
    try {
      if (!fs.existsSync(workspaceRoot)) {
        throw new BrokerSecurityError(
          "FILE_NOT_FOUND",
          `Workspace root does not exist: ${workspaceRoot}`,
          { workspaceRoot },
        );
      }
      realWorkspaceRoot = normalizeSlashes(
        fs.realpathSync.native
          ? fs.realpathSync.native(workspaceRoot)
          : fs.realpathSync(workspaceRoot),
      );
    } catch (err) {
      if (err instanceof BrokerSecurityError) throw err;
      throw new BrokerSecurityError(
        "WORKING_DIRECTORY_DENIED",
        `Failed to resolve realpath for workspace root '${workspaceRoot}': ${err instanceof Error ? err.message : String(err)}`,
        { workspaceRoot },
      );
    }

    let realScratchDir: string | undefined;
    if (scratchDir) {
      try {
        if (fs.existsSync(scratchDir)) {
          realScratchDir = normalizeSlashes(
            fs.realpathSync.native
              ? fs.realpathSync.native(scratchDir)
              : fs.realpathSync(scratchDir),
          );
        }
      } catch {
        // If scratchDir cannot be realpathed, keep undefined
      }
    }

    // 2. Resolve nominal target cwd
    const nominalTargetCwd = requestedCwd
      ? path.resolve(realWorkspaceRoot, requestedCwd)
      : realWorkspaceRoot;

    // 3. Reject non-existent cwd or non-directory
    let lstat: fs.Stats;
    try {
      lstat = fs.lstatSync(nominalTargetCwd);
    } catch {
      throw new BrokerSecurityError(
        "FILE_NOT_FOUND",
        `Working directory does not exist or is not a directory: ${nominalTargetCwd}`,
        { cwd: nominalTargetCwd },
      );
    }

    if (lstat.isSymbolicLink()) {
      throw new BrokerSecurityError(
        "WORKING_DIRECTORY_DENIED",
        `Working directory cannot be a symbolic link: ${nominalTargetCwd}`,
        { cwd: requestedCwd, resolvedCwd: nominalTargetCwd },
      );
    }

    if (!lstat.isDirectory()) {
      throw new BrokerSecurityError(
        "FILE_NOT_FOUND",
        `Working directory is not a directory: ${nominalTargetCwd}`,
        { cwd: nominalTargetCwd },
      );
    }

    // 4. Resolve realpath of target cwd
    let realTargetCwd: string;
    try {
      realTargetCwd = normalizeSlashes(
        fs.realpathSync.native
          ? fs.realpathSync.native(nominalTargetCwd)
          : fs.realpathSync(nominalTargetCwd),
      );
    } catch (err) {
      throw new BrokerSecurityError(
        "WORKING_DIRECTORY_DENIED",
        `Failed to resolve realpath for working directory '${nominalTargetCwd}': ${err instanceof Error ? err.message : String(err)}`,
        { cwd: requestedCwd, resolvedCwd: nominalTargetCwd },
      );
    }

    // Verify realTarget is a directory
    try {
      const realStat = fs.statSync(realTargetCwd);
      if (!realStat.isDirectory()) {
        throw new BrokerSecurityError(
          "FILE_NOT_FOUND",
          `Working directory realpath is not a directory: ${realTargetCwd}`,
          { cwd: realTargetCwd },
        );
      }
    } catch (err) {
      if (err instanceof BrokerSecurityError) throw err;
      throw new BrokerSecurityError(
        "FILE_NOT_FOUND",
        `Working directory realpath does not exist: ${realTargetCwd}`,
        { cwd: realTargetCwd },
      );
    }

    // 5. Verify containment in realWorkspaceRoot or realScratchDir
    const inWorkspace = isPathInsideRoot(realTargetCwd, realWorkspaceRoot);
    const inScratch = realScratchDir ? isPathInsideRoot(realTargetCwd, realScratchDir) : false;

    if (!inWorkspace && !inScratch) {
      throw new BrokerSecurityError(
        "WORKING_DIRECTORY_DENIED",
        `Working directory '${requestedCwd ?? ""}' resolves outside allowed roots (${realWorkspaceRoot}): ${realTargetCwd}`,
        { cwd: requestedCwd, resolvedCwd: realTargetCwd, workspaceRoot: realWorkspaceRoot },
      );
    }

    // Also assert no intermediate symlink components along the path from matching root
    const matchingRoot = inWorkspace ? realWorkspaceRoot : (realScratchDir ?? realWorkspaceRoot);
    this.assertNoSymlinksInPath(nominalTargetCwd, matchingRoot);

    return realTargetCwd;
  }

  /**
   * Validates and resolves an authorized command executable, working directory, and environment.
   */
  private authorizeExecution(
    params: CommandExecuteParams,
    context: BrokerContext,
    cmdCap: CommandCapability,
  ): AuthorizedCommandExecution {
    // 1. Extract raw binary and validate string via deterministic non-shell argv lexer
    let commandTokens: string[] = [];
    if (params.command) {
      commandTokens = parseCommandLine(params.command);
    }

    const rawBinary =
      params.executable ?? (commandTokens.length > 0 ? commandTokens[0] : undefined);
    if (!rawBinary || String(rawBinary) !== rawBinary || rawBinary.trim().length === 0) {
      throw new BrokerSecurityError("INVALID_PATH", "Executable binary name must be specified");
    }
    const binary = rawBinary.trim();

    // 2. Shell execution restriction
    if (cmdCap.allowShellExecution === false) {
      if (isShellExecutable(binary)) {
        throw new BrokerSecurityError(
          "SHELL_EXECUTION_DENIED",
          `Shell execution is prohibited by capability grant: ${path.basename(binary)}`,
          { binary },
        );
      }
    }

    // 3. Binary resolution to canonical absolute path and identity
    const workspaceRoot = path.resolve(context.workspaceRoot ?? process.cwd());
    const scratchDir = path.resolve(context.scratchDir ?? path.join(os.tmpdir(), "resin_scratch"));

    let identity: CommandIdentity;
    try {
      identity = resolveCanonicalBinary(binary, {
        workspaceRoot,
        allowNonExistent: false,
        computeDigest: true,
      });
    } catch (err) {
      throw new BrokerSecurityError(
        "UNAUTHORIZED_BINARY",
        `Binary '${binary}' could not be resolved or is invalid: ${err instanceof Error ? err.message : String(err)}`,
        { binary },
      );
    }

    if (cmdCap.allowShellExecution === false) {
      if (isShellExecutable(identity.realPath) || isShellExecutable(identity.canonicalPath)) {
        throw new BrokerSecurityError(
          "SHELL_EXECUTION_DENIED",
          `Resolved executable '${identity.realPath}' is a shell executable and shell execution is disabled`,
          { binary, realPath: identity.realPath },
        );
      }
    }

    // 4. Extract raw arguments
    const rawArgs: string[] = params.args
      ? [...params.args]
      : commandTokens.length > 1
        ? commandTokens.slice(1)
        : [];

    // 5. Validate against canonical approved command tuples or explicit broad binaries
    const allowedCommands = cmdCap.allowedCommands ?? [];
    const allowedBinaries = cmdCap.allowedBinaries ?? [];
    let authorizedPythonTestModule = false;

    if (allowedCommands.length > 0) {
      let matched = false;
      for (const commandProfile of allowedCommands) {
        if (String(commandProfile) !== commandProfile || commandProfile.trim().length === 0) {
          continue;
        }
        // Vocabulary placeholders are policy syntax, not shell expansion: mask them so
        // the quote-aware parser accepts the profile, then restore them per token.
        const placeholders: string[] = [];
        const maskedProfile = commandProfile.replace(COMMAND_PLACEHOLDER_PATTERN, (placeholder) => {
          placeholders.push(placeholder);
          return `__RESIN_PLACEHOLDER_${placeholders.length - 1}__`;
        });
        const profileTokens = parseCommandLine(maskedProfile).map((token) =>
          token.replace(/__RESIN_PLACEHOLDER_(\d+)__/g, (_, index) => placeholders[Number(index)]),
        );
        if (profileTokens.length === 0) {
          continue;
        }
        const profileBinary = profileTokens[0];
        const profileArgs = profileTokens.slice(1);

        let profileIdentity: CommandIdentity | null = null;
        try {
          profileIdentity = resolveCanonicalBinary(profileBinary, {
            workspaceRoot,
            allowNonExistent: false,
            computeDigest: true,
          });
        } catch {
          try {
            profileIdentity = resolveCanonicalBinary(profileBinary, {
              workspaceRoot,
              allowNonExistent: true,
              computeDigest: false,
            });
          } catch {
            profileIdentity = null;
          }
        }

        const executableMatches =
          (profileIdentity !== null &&
            (profileIdentity.realPath === identity.realPath ||
              profileIdentity.canonicalPath === identity.canonicalPath)) ||
          profileBinary === binary ||
          profileBinary === identity.canonicalPath ||
          profileBinary === identity.realPath;

        if (!executableMatches) {
          continue;
        }

        const argsMatch = matchCommandProfileArgs(profileArgs, rawArgs);
        if (argsMatch) {
          matched = true;
          // A fixed, explicitly granted test runner is not an arbitrary module
          // escape. Broad binary grants and placeholder module names still deny -m.
          authorizedPythonTestModule =
            /^python(?:[23](?:\.\d+)*)?(?:\.exe)?$/i.test(path.basename(identity.realPath)) &&
            profileArgs[0] === "-m" &&
            Object.hasOwn(PYTHON_TEST_MODULES, profileArgs[1] ?? "");
          break;
        }
      }

      if (!matched) {
        throw new BrokerSecurityError(
          "UNAUTHORIZED_BINARY",
          `Command '${[binary, ...rawArgs].join(" ")}' (${identity.realPath}) is not permitted by capability grant allowedCommands: [${allowedCommands.join(", ")}]`,
          { binary, realPath: identity.realPath, args: rawArgs, allowedCommands },
        );
      }
    } else if (allowedBinaries.length > 0) {
      const allowedCommandIdentities = allowedBinaries.map((allowed) => {
        try {
          return resolveCanonicalBinary(allowed, { workspaceRoot, allowNonExistent: true });
        } catch {
          return {
            canonicalPath: path.resolve(allowed),
            realPath: path.resolve(allowed),
          };
        }
      });

      const isAllowed = allowedCommandIdentities.some((allowedId) => {
        if (allowedId.realPath === identity.realPath) return true;
        if (allowedId.canonicalPath === identity.canonicalPath) return true;
        return false;
      });

      if (!isAllowed) {
        throw new BrokerSecurityError(
          "UNAUTHORIZED_BINARY",
          `Binary '${binary}' (${identity.realPath}) is not permitted by capability grant (allowed: ${allowedBinaries.join(", ")})`,
          { binary, realPath: identity.realPath, allowedBinaries },
        );
      }
    } else {
      throw new BrokerSecurityError(
        "UNAUTHORIZED_BINARY",
        `Binary '${binary}' is not permitted (no canonical command identity configured)`,
        { binary },
      );
    }
    // 6. Validate argument syntax guards
    for (let i = 0; i < rawArgs.length; i++) {
      const arg = rawArgs[i];
      if (String(arg) !== arg) {
        throw new BrokerSecurityError(
          "FORBIDDEN_ARGUMENT_PATTERN",
          "All command arguments must be strings",
        );
      }
      if (containsForbiddenArgMetacharacters(arg)) {
        throw new BrokerSecurityError(
          "FORBIDDEN_ARGUMENT_PATTERN",
          `Argument contains forbidden shell metacharacters or control bytes: '${arg}'`,
          { arg },
        );
      }

      if (
        (isInterpreterEscape(identity.realPath, arg, rawArgs[i + 1]) ||
          isInterpreterEscape(binary, arg, rawArgs[i + 1])) &&
        !(i === 0 && arg === "-m" && authorizedPythonTestModule)
      ) {
        throw new BrokerSecurityError(
          "FORBIDDEN_ARGUMENT_PATTERN",
          `Interpreter escape flag '${arg}' is prohibited for binary '${path.basename(identity.realPath)}'`,
          { binary: identity.realPath, arg },
        );
      }

      if (isDangerousOption(identity.realPath, arg) || isDangerousOption(binary, arg)) {
        throw new BrokerSecurityError(
          "FORBIDDEN_ARGUMENT_PATTERN",
          `Dangerous option '${arg}' is prohibited for binary '${path.basename(identity.realPath)}'`,
          { binary: identity.realPath, arg },
        );
      }

      if (isResponseFileEscapeArg(arg, workspaceRoot, scratchDir)) {
        throw new BrokerSecurityError(
          "FORBIDDEN_ARGUMENT_PATTERN",
          `Response file argument '${arg}' escapes authorized workspace boundaries or targets sensitive credentials`,
          { arg },
        );
      }

      for (const pattern of cmdCap.forbiddenPatterns ?? []) {
        if (matchesArgPattern(arg, pattern) || arg.includes(pattern)) {
          throw new BrokerSecurityError(
            "FORBIDDEN_PATTERN",
            `Command argument '${arg}' matches forbidden pattern '${pattern}'`,
            { arg, pattern },
          );
        }
      }
    }

    // 6. Validate working directory boundaries
    // 6. Validate working directory boundaries and symlink containment
    const targetCwd = this.validateAndResolveCwd(params.cwd, workspaceRoot, scratchDir);

    // 7. Construct minimal sanitized child environment
    const childEnv: SanitizedChildEnvironment = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: process.env.LANG ?? "C.UTF-8",
      LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
      TMPDIR: scratchDir,
      HOME: workspaceRoot,
    };

    if (process.platform === "win32") {
      if (process.env.SYSTEMROOT) childEnv.SYSTEMROOT = process.env.SYSTEMROOT;
      if (process.env.WINDIR) childEnv.WINDIR = process.env.WINDIR;
      if (process.env.COMSPEC) childEnv.COMSPEC = process.env.COMSPEC;
      if (process.env.PATHEXT) childEnv.PATHEXT = process.env.PATHEXT;
    }

    const passthroughKeys = cmdCap.allowEnvPassthrough ?? [];
    for (const key of passthroughKeys) {
      if (!isDangerousEnvVar(key) && process.env[key] !== undefined) {
        childEnv[key] = process.env[key];
      }
    }

    if (params.env) {
      const grant = this.validateGrant(context);
      const secretsCap = grant.capabilities.secrets;
      const allowedSecretNames = secretsCap?.allowedSecretNames ?? [];
      const allowedPrefixes: readonly string[] = secretsCap?.allowedPrefixes ?? [];
      const hasSecretsCapability = allowedSecretNames.length > 0 || allowedPrefixes.length > 0;

      for (const [key, val] of Object.entries(params.env)) {
        if (isDangerousEnvVar(key)) {
          throw new BrokerSecurityError(
            "DANGEROUS_ENV_VAR",
            `Dangerous environment variable '${key}' cannot be provided by caller`,
            { envVar: key },
          );
        }

        if (SecretReferenceSchema.safeParse(val).success) {
          continue;
        }

        const isAllowedPassthrough = passthroughKeys.includes(key);
        const isAllowedSecret =
          allowedSecretNames.includes(key) || allowedPrefixes.some((p) => key.startsWith(p));
        if (!isAllowedPassthrough && !isAllowedSecret) {
          throw new BrokerSecurityError(
            "UNAUTHORIZED_ENV_VAR",
            `Environment variable '${key}' is not authorized in capability grant (allowed: ${passthroughKeys.join(", ")})`,
            { envVar: key, allowEnvPassthrough: passthroughKeys },
          );
        }

        if (String(val) === val) {
          childEnv[key] = val;
        }
      }
    }
    return {
      identity,
      executable: identity.realPath,
      args: rawArgs,
      cwd: targetCwd,
      childEnv,
    };
  }

  /**
   * Executes an authorized subprocess with output limits, timeout bounds, and mediated credentials.
   */
  async execute(
    params: CommandExecuteParams,
    context: BrokerContext,
  ): Promise<CommandExecuteResult> {
    const startTime = Date.now();
    const grant = this.validateGrant(context);
    const cmdCap = grant.capabilities.command ?? {};
    const limits = grant.capabilities.limits;

    const timeoutMs = Math.min(
      params.timeoutMs ?? limits?.maxExecutionTimeMs ?? 30000,
      limits?.maxExecutionTimeMs ?? 30000,
    );
    const maxOutputBytes = Math.min(
      params.maxOutputSizeBytes ?? limits?.maxOutputSizeBytes ?? 10485760,
      limits?.maxOutputSizeBytes ?? 10485760,
    );
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1)
      throw new BrokerSecurityError("OPERATION_NOT_PERMITTED", "Invalid command output bound");

    const secretBroker = this.secretBroker ?? context.secretBroker;
    const redactor = secretBroker?.getRedactor();

    try {
      const { identity, executable, args, cwd, childEnv } = this.authorizeExecution(
        params,
        context,
        cmdCap,
      );

      // Pre-spawn executable identity re-verification (detects symlink swaps / replacements)
      const verifyResult = verifyExecutableIdentity(identity);
      if (!verifyResult.valid) {
        throw new BrokerSecurityError(
          "COMMAND_IDENTITY_VIOLATION",
          `Executable identity verification failed before spawn: ${verifyResult.reason}`,
          { executable: identity.realPath, reason: verifyResult.reason },
        );
      }
      // Pre-spawn working directory re-verification (detects symlink swaps / race conditions)
      const workspaceRoot = normalizeSlashes(path.resolve(context.workspaceRoot ?? process.cwd()));
      const scratchDir = context.scratchDir
        ? normalizeSlashes(path.resolve(context.scratchDir))
        : undefined;
      const verifiedCwd = this.validateAndResolveCwd(params.cwd, workspaceRoot, scratchDir);
      if (verifiedCwd !== cwd) {
        throw new BrokerSecurityError(
          "WORKING_DIRECTORY_DENIED",
          `Working directory path changed between authorization and spawn: expected ${cwd}, got ${verifiedCwd}`,
          { expectedCwd: cwd, verifiedCwd },
        );
      }

      // 1. Host-side stdin secret mediation
      let resolvedStdin: string | undefined = undefined;
      if (params.stdin !== undefined) {
        if (secretBroker) {
          resolvedStdin = await secretBroker.mediateCommandStdin(params.stdin, context);
        } else if (String(params.stdin) === params.stdin) {
          resolvedStdin = params.stdin;
        }
      }

      // 2. Host-side environment secret mediation
      const rawEnv = {
        ...(params.env ?? {}),
        ...(params.secretEnv ?? {}),
      } satisfies Record<string, string | SecretReference>;

      if (Object.keys(rawEnv).length > 0 && secretBroker) {
        const mediatedEnv = await secretBroker.mediateCommandEnv(rawEnv, context);
        for (const [key, val] of Object.entries(mediatedEnv)) {
          if (!isDangerousEnvVar(key)) {
            childEnv[key] = val;
          }
        }
      }
      if (params.readOnlyGit) Object.assign(childEnv, prepareReadOnlyGit(executable, args, cwd));

      // 3. Subprocess execution with process group termination and timeout protection
      const rawResult = await this.spawnSubprocess({
        executable,
        args,
        cwd,
        env: childEnv,
        stdin: resolvedStdin,
        timeoutMs,
        maxOutputBytes,
        truncateOutput: params.truncateOutput === true,
      });

      // 4. Output Redaction
      const sanitizedStdout = redactor ? redactor.redact(rawResult.stdout) : rawResult.stdout;
      const sanitizedStderr = redactor ? redactor.redact(rawResult.stderr) : rawResult.stderr;

      // 5. Emit Audit Event
      this.recordAudit(
        "execute",
        context,
        rawResult.exitCode === 0 ? "allowed" : "denied",
        {
          command: executable,
          args: redactor ? args.map((a) => redactor.redact(a)) : args,
          cwd,
          exitCode: rawResult.exitCode,
        },
        { durationMs: rawResult.durationMs },
      );

      return {
        exitCode: rawResult.exitCode,
        stdout: sanitizedStdout,
        stderr: sanitizedStderr,
        durationMs: Date.now() - startTime,
        ...(rawResult.truncated ? { truncated: true } : {}),
      };
    } catch (error) {
      const isSecErr = error instanceof BrokerSecurityError;
      const errCode = isSecErr ? error.code : "PROCESS_SPAWN_FAILED";
      const rawMsg = error instanceof Error ? error.message : String(error);
      const errMsg = redactor ? redactor.redact(rawMsg) : rawMsg;

      this.recordAudit(
        "execute",
        context,
        "denied",
        {
          command: params.executable ?? params.command ?? "unknown",
          args: redactor && params.args ? params.args.map((a) => redactor.redact(a)) : params.args,
          cwd: params.cwd,
        },
        {
          error: {
            code: errCode,
            message: errMsg,
            details:
              redactor && isSecErr && error.details
                ? redactor.redactObject(error.details)
                : undefined,
          },
        },
      );

      if (isSecErr) {
        throw new BrokerSecurityError(
          error.code,
          errMsg,
          redactor && error.details ? redactor.redactObject(error.details) : error.details,
        );
      }
      throw new BrokerSecurityError("PROCESS_SPAWN_FAILED", errMsg);
    }
  }

  /**
   * Spawns a child process and collects standard output and error streams with timeout protection.
   */
  private spawnSubprocess(options: {
    executable: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdin?: string;
    timeoutMs: number;
    maxOutputBytes: number;
    truncateOutput?: boolean;
  }): Promise<CommandExecuteResult> {
    const { promise, resolve, reject } = withResolvers<CommandExecuteResult>();
    const startTime = Date.now();

    const isPosix = process.platform !== "win32";
    let child: ChildProcess;
    try {
      child = spawn(options.executable, options.args, {
        cwd: options.cwd,
        env: options.env,
        shell: false, // Strict: never invoke through shell
        stdio: ["pipe", "pipe", "pipe"],
        detached: isPosix, // Enable process group killing on POSIX
      });
    } catch (err) {
      reject(
        new BrokerSecurityError(
          "PROCESS_SPAWN_FAILED",
          `Failed to spawn binary '${options.executable}': ${err instanceof Error ? err.message : String(err)}`,
          {
            executable: options.executable,
            error: err instanceof Error ? err.message : String(err),
          },
        ),
      );
      return promise;
    }

    const killProcessGroup = (signal: NodeJS.Signals = "SIGKILL") => {
      if (child.killed) return;
      if (isPosix && child.pid) {
        try {
          process.kill(-child.pid, signal);
        } catch {
          try {
            child.kill(signal);
          } catch {
            // already exited
          }
        }
      } else {
        try {
          child.kill(signal);
        } catch {
          // already exited
        }
      }
    };

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let totalBytes = 0;
    let timedOut = false;
    let killedForSize = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup("SIGTERM");
      setTimeout(() => {
        killProcessGroup("SIGKILL");
      }, 50);
    }, options.timeoutMs);

    if (child.stdin) child.stdin.end(options.stdin);

    const collect = (target: Buffer[], chunk: Buffer | string) => {
      if (killedForSize) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const available = options.maxOutputBytes - totalBytes;
      if (bytes.length > available) {
        if (options.truncateOutput && available > 0) target.push(bytes.subarray(0, available));
        killedForSize = true;
        killProcessGroup("SIGKILL");
        return;
      }
      totalBytes += bytes.length;
      target.push(bytes);
    };
    child.stdout?.on("data", (chunk: Buffer | string) => collect(stdoutChunks, chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => collect(stderrChunks, chunk));

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new BrokerSecurityError(
          "PROCESS_SPAWN_FAILED",
          `Child process emitted error: ${err.message}`,
          { error: err.message },
        ),
      );
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);

      if (timedOut) {
        reject(
          new BrokerSecurityError(
            "COMMAND_TIMEOUT",
            `Command execution timed out after ${options.timeoutMs}ms`,
            { timeoutMs: options.timeoutMs, signal },
          ),
        );
        return;
      }

      if (killedForSize && !options.truncateOutput) {
        reject(
          new BrokerSecurityError(
            "MAX_OUTPUT_EXCEEDED",
            `Subprocess output exceeded quota limit of ${options.maxOutputBytes} bytes`,
            { maxOutputBytes: options.maxOutputBytes },
          ),
        );
        return;
      }

      resolve({
        exitCode: code ?? (signal ? 1 : 0),
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        ...(killedForSize ? { truncated: true } : {}),
        durationMs: Date.now() - startTime,
      });
    });

    return promise;
  }

  /**
   * Convenience alias for executing commands.
   */
  async exec(
    command: string,
    args: string[],
    options: Omit<CommandExecuteParams, "command" | "args">,
    context: BrokerContext,
  ): Promise<CommandExecuteResult> {
    return this.execute({ ...options, command, args }, context);
  }
}
