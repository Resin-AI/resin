import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrokerSecurityError } from "./base.js";

/** Additional confinement, never a substitute for the invocation's command grant. */
export function prepareReadOnlyGit(
  executable: string,
  args: string[],
  cwd: string,
): Record<string, string> {
  const fail = (): never => {
    throw new BrokerSecurityError(
      "OPERATION_NOT_PERMITTED",
      "Repository is not compatible with confined read-only Git execution",
    );
  };
  if (!/^git(?:\.exe)?$/i.test(path.basename(executable))) fail();
  const fixed = [
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"],
    ["ls-files", "-z", "--cached", "--"],
    ["rev-parse", "--verify", "--quiet", "HEAD"],
    ["symbolic-ref", "--quiet", "HEAD"],
    [
      "diff",
      "--name-status",
      "-z",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=all",
      "--find-renames=50%",
      "--",
    ],
    [
      "diff",
      "--cached",
      "--name-status",
      "-z",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=all",
      "--find-renames=50%",
      "--",
    ],
  ];
  const log =
    args.length === 7 &&
    args[0] === "log" &&
    args[1] === "--first-parent" &&
    args[2] === "--format=%H%x00%s" &&
    args[3] === "-z" &&
    /^--max-count=(?:[1-9][0-9]{0,2}|100[01])$/.test(args[4]) &&
    args[5] === "HEAD" &&
    args[6] === "--";
  if (!log && !fixed.some((candidate) => JSON.stringify(candidate) === JSON.stringify(args)))
    fail();
  const gitDir = path.join(cwd, ".git");
  if (
    !fs.existsSync(gitDir) ||
    !fs.lstatSync(gitDir).isDirectory() ||
    fs.lstatSync(gitDir).isSymbolicLink()
  )
    fail();
  // Linked worktrees, alternates, and symbolic metadata can point outside the authorized root.
  // Bound inspection rather than trusting a mutable repository cache.
  let entries = 0;
  const inspect = (directory: string): void => {
    const handle = fs.opendirSync(directory);
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        if (++entries > 20000) fail();
        const target = path.join(directory, entry.name);
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) fail();
        const relative = path.relative(gitDir, target).split(path.sep).join("/");
        if (
          ["commondir", "objects/info/alternates", "objects/info/http-alternates"].includes(
            relative,
          )
        )
          fail();
        if (stat.isDirectory()) inspect(target);
      }
    } finally {
      handle.closeSync();
    }
  };
  inspect(gitDir);
  const configPath = path.join(gitDir, "config");
  if (fs.statSync(configPath).size > 65536) fail();
  const config = fs.readFileSync(configPath, "utf8");
  // Reject features whose configuration can read external files, execute conversion programs,
  // or fetch missing objects. Ordinary core/user/remote/branch settings remain supported.
  if (
    /\\\r?\n/.test(config) ||
    /^\s*\[\s*(?:include|includeif|filter|diff|merge|submodule)(?:\s|\])/im.test(config) ||
    /partialclone|promisor/i.test(config)
  )
    fail();
  const overrides: Record<string, string> = {
    "core.fsmonitor": "false",
    "core.hooksPath": os.devNull,
    "core.attributesFile": os.devNull,
    "core.untrackedCache": "false",
    "core.pager": "",
    "core.bare": "false",
    "submodule.recurse": "false",
    "protocol.allow": "never",
    "color.ui": "false",
    "core.quotePath": "false",
  };
  const env: Record<string, string> = {
    GIT_DIR: gitDir,
    GIT_COMMON_DIR: gitDir,
    GIT_WORK_TREE: cwd,
    GIT_OBJECT_DIRECTORY: path.join(gitDir, "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_PAGER: "",
    GIT_CONFIG_COUNT: String(Object.keys(overrides).length),
  };
  Object.entries(overrides).forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}
