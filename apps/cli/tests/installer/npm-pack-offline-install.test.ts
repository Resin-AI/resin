import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("public npm bootstrap offline installation", () => {
  it("packs all runtime dependencies and executes from a clean npm install with network disabled", () => {
    const rootDir = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-npm-offline-"));
    tempDirs.push(tempDir);
    const packDir = path.join(tempDir, "pack");
    const installDir = path.join(tempDir, "install");
    fs.mkdirSync(packDir, { recursive: true });
    fs.mkdirSync(installDir, { recursive: true });

    // SAFETY: JSON output of pack-npm-bootstrap.mjs contains tarballPath and filename.
    const packed = JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(rootDir, "scripts", "pack-npm-bootstrap.mjs"), `--output-dir=${packDir}`],
        { cwd: rootDir, encoding: "utf8" },
      ),
    ) as { tarballPath: string; filename: string };

    expect(packed.filename).toBe("resin-1.0.0.tgz");
    expect(fs.existsSync(packed.tarballPath)).toBe(true);

    execFileSync(
      "npm",
      [
        "install",
        "--prefix",
        installDir,
        "--ignore-scripts",
        "--offline",
        "--no-audit",
        "--no-fund",
        packed.tarballPath,
      ],
      {
        cwd: installDir,
        env: { ...process.env, npm_config_update_notifier: "false" },
        stdio: "pipe",
      },
    );

    const packageRoot = path.join(installDir, "node_modules", "resin");
    expect(fs.existsSync(path.join(packageRoot, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(packageRoot, "LICENSE"))).toBe(true);
    expect(fs.existsSync(path.join(packageRoot, "NOTICE"))).toBe(true);
    expect(fs.existsSync(path.join(packageRoot, "README.md"))).toBe(true);

    const contractsDir = path.join(packageRoot, "node_modules", "@resin", "contracts");
    expect(fs.existsSync(contractsDir)).toBe(true);
    expect(fs.existsSync(path.join(contractsDir, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(contractsDir, "LICENSE"))).toBe(true);
    expect(fs.existsSync(path.join(contractsDir, "NOTICE"))).toBe(true);
    expect(fs.existsSync(path.join(contractsDir, "dist", "index.js"))).toBe(true);
    expect(fs.existsSync(path.join(contractsDir, "src"))).toBe(false);
    expect(fs.existsSync(path.join(contractsDir, "tests"))).toBe(false);

    expect(fs.existsSync(path.join(packageRoot, "node_modules", "zod"))).toBe(true);
    expect(
      fs.existsSync(path.join(packageRoot, "node_modules", "typescript", "package.json")),
    ).toBe(true);
    const cli = path.join(packageRoot, "bin", "resin.mjs");
    const env = { ...process.env, NODE_ENV: "production" };
    delete env.NODE_PATH;

    const help = execFileSync(process.execPath, [cli, "help"], {
      cwd: installDir,
      env,
      encoding: "utf8",
    });
    expect(help).toContain("Resin CLI");

    const version = execFileSync(process.execPath, [cli, "version"], {
      cwd: installDir,
      env,
      encoding: "utf8",
    });
    expect(version.trim()).toBe("resin v1.0.0");
  }, 60_000);
});
