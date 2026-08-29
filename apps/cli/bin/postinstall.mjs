#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

function isEnabled(value) {
  return value === "1" || value === "true";
}

export function isGlobalLifecycleInstall(env = process.env) {
  return (
    isEnabled(env.npm_config_global) ||
    env.npm_config_location === "global" ||
    env.RESIN_FORCE_POSTINSTALL === "1"
  );
}

export function postinstallSuppressionReason(
  env = process.env,
  getuid = typeof process.getuid === "function" ? () => process.getuid() : () => undefined,
) {
  if (
    isEnabled(env.RESIN_NO_ONBOARD) ||
    isEnabled(env.RESIN_SKIP_ONBOARDING) ||
    isEnabled(env.RESIN_SKIP_POSTINSTALL)
  ) {
    return "automatic onboarding was explicitly disabled";
  }

  const ciVariables = [
    env.CI,
    env.CONTINUOUS_INTEGRATION,
    env.GITHUB_ACTIONS,
    env.GITLAB_CI,
    env.TRAVIS,
    env.CIRCLECI,
    env.JENKINS_URL,
  ];
  if (
    ciVariables.some(
      (value) =>
        typeof value === "string" &&
        value.length > 0 &&
        value !== "0" &&
        value.toLowerCase() !== "false",
    )
  ) {
    return "CI environment detected";
  }
  if (env.DEBIAN_FRONTEND === "noninteractive" || isEnabled(env.RESIN_NON_INTERACTIVE)) {
    return "non-interactive dependency environment detected";
  }
  if (getuid() === 0 && !isEnabled(env.RESIN_ALLOW_ROOT)) {
    return "root/sudo lifecycle context is not a supported user onboarding target";
  }
  return null;
}

export async function runPostinstall(options = {}) {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  if (!isGlobalLifecycleInstall(env)) {
    return { attempted: false, skipped: true, reason: "dependency install" };
  }

  const suppressionReason = postinstallSuppressionReason(env, options.getuid);
  if (suppressionReason) {
    return { attempted: false, skipped: true, reason: suppressionReason };
  }

  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const target = options.target ?? path.resolve(currentDir, "../dist/bin/cli.js");
  if (!fs.existsSync(target) && !options.loadCli) {
    return { attempted: false, skipped: true, reason: "compiled CLI is unavailable" };
  }

  const cli = options.loadCli ? await options.loadCli() : await import(pathToFileURL(target).href);
  if (typeof cli.initCommand !== "function") {
    throw new Error("Installed Resin CLI does not expose the onboarding transaction");
  }

  stdout.write(
    "\n[resin] Completing browser authorization, editor configuration, and daemon setup...\n" +
      "[resin] Keep this install open. If no browser opens, use the URL and code shown below.\n\n",
  );
  const exitCode = await cli.initCommand(["--auto-approve"]);
  if (exitCode !== 0) {
    throw new Error(`onboarding transaction exited with code ${exitCode}`);
  }

  stdout.write(
    "\n[resin] Setup complete. Detected editors are configured and the daemon is ready.\n\n",
  );
  return { attempted: true, skipped: false, success: true };
}

if (
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
) {
  try {
    await runPostinstall();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `\n[resin] Automatic setup did not complete: ${message}\n[resin] Any partial local changes were rolled back and the install journal was preserved.\n[resin] Rerun the same global npm or pnpm install command to resume; no separate Resin command is required.\n\n`,
    );
    process.exitCode = 1;
  }
}
