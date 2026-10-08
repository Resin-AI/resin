import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { TestProject } from "vitest/node";
import type { PackedNpmBootstrap } from "./packed-npm-bootstrap.js";

const execFileAsync = promisify(execFile);
const ROOT_DIR = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * Packs the npm bootstrap once per Vitest run into a fresh temporary directory, provides its
 * location to the suites, and removes it when the run ends. Nothing is cached across runs.
 */
export async function setup(project: TestProject): Promise<() => Promise<void>> {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-npm-bootstrap-pack-"));
  const removeRunDir = () => fs.promises.rm(runDir, { recursive: true, force: true });
  try {
    const home = path.join(runDir, "home");
    const packDir = path.join(runDir, "pack");
    fs.mkdirSync(home);
    fs.mkdirSync(packDir);
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(ROOT_DIR, "scripts", "pack-npm-bootstrap.mjs"), `--output-dir=${packDir}`],
      {
        cwd: ROOT_DIR,
        // Global setup runs in the main Vitest process, outside the per-worker HOME override and
        // real-home guard, so the packer gets its own throwaway home instead of the real one.
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          DO_NOT_TRACK: "1",
          npm_config_update_notifier: "false",
        },
        maxBuffer: 20 * 1024 * 1024,
        timeout: 600_000,
      },
    );
    // SAFETY: JSON output of pack-npm-bootstrap.mjs contains tarballPath and filename.
    const packed = JSON.parse(stdout) as PackedNpmBootstrap;
    project.provide("packedNpmBootstrap", {
      tarballPath: packed.tarballPath,
      filename: packed.filename,
    });
    return removeRunDir;
  } catch (error) {
    await removeRunDir();
    throw error;
  }
}
