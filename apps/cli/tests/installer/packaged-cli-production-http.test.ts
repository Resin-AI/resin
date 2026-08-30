import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cleanupPaths: string[] = [];

type TestCanonicalJsonValue =
  | string
  | number
  | boolean
  | null
  | TestCanonicalJsonValue[]
  | { [key: string]: TestCanonicalJsonValue };

function canonical(value: TestCanonicalJsonValue | undefined): string {
  if (
    value === null ||
    value === undefined ||
    Array.isArray(value) ||
    Object.prototype.toString.call(value) !== "[object Object]"
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  // SAFETY: value is confirmed to be a record object by type guard and toString tag.
  const record = value as Record<string, TestCanonicalJsonValue>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function sign(payload: TestCanonicalJsonValue | undefined, privateKey: crypto.KeyObject): string {
  return crypto.sign(null, Buffer.from(canonical(payload), "utf8"), privateKey).toString("hex");
}

function sha256(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createTarGz(): Buffer {
  const files = [
    ["resin/bin/resin-daemon", "#!/usr/bin/env node\n"],
    ["resin/bin/resin-mcp", "#!/usr/bin/env node\n"],
    ["resin/bin/resin", "#!/usr/bin/env node\n"],
  ] as const;
  const blocks: Buffer[] = [];
  for (const [name, content] of files) {
    const body = Buffer.from(content, "utf8");
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000755\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header[156] = 48;
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

function createStoredZip(name: string, body: Buffer): Buffer {
  const nameBuffer = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(nameBuffer.length, 26);
  const centralOffset = local.length + nameBuffer.length + body.length;
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(nameBuffer.length, 28);
  central.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBuffer.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, nameBuffer, body, central, nameBuffer, end]);
}

function platformAssetKey(): string {
  if (process.platform === "darwin")
    return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  return process.arch === "arm64" ? "linux-arm64" : "linux-x64";
}

function denoFixtureFilename(): string {
  if (process.platform === "darwin") {
    return process.arch === "arm64"
      ? "deno-aarch64-apple-darwin.zip"
      : "deno-x86_64-apple-darwin.zip";
  }
  return process.arch === "arm64"
    ? "deno-aarch64-unknown-linux-gnu.zip"
    : "deno-x86_64-unknown-linux-gnu.zip";
}

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

describe("packed CLI production bootstrap", () => {
  it("runs the npm-packed CLI entrypoint through a signed channel and HTTP fixture", async () => {
    const rootDir = process.cwd();
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-packed-http-e2e-"));
    cleanupPaths.push(runDir);
    const packDir = path.join(runDir, "pack");
    const installDir = path.join(runDir, "install");
    const home = path.join(runDir, "home");
    const workspace = path.join(runDir, "workspace");
    fs.mkdirSync(packDir, { recursive: true });
    fs.mkdirSync(installDir, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });

    const { stdout: packStdout } = await execFileAsync(
      process.execPath,
      [path.join(rootDir, "scripts", "pack-npm-bootstrap.mjs"), `--output-dir=${packDir}`],
      { cwd: rootDir, maxBuffer: 20 * 1024 * 1024 },
    );
    // SAFETY: Output from npm pack --json contains tarballPath.
    const packed = JSON.parse(packStdout) as { tarballPath: string };
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    await execFileAsync(
      npm,
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
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    const packageRoot = path.join(installDir, "node_modules", "resin");
    const packedBin = path.join(packageRoot, "bin", "resin.mjs");
    expect(fs.existsSync(packedBin)).toBe(true);
    expect(fs.existsSync(path.join(packageRoot, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(packageRoot, "LICENSE"))).toBe(true);
    expect(fs.existsSync(path.join(packageRoot, "NOTICE"))).toBe(true);
    expect(
      fs.existsSync(path.join(packageRoot, "node_modules", "@resin", "runtime", "package.json")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(packageRoot, "node_modules", "@resin", "runtime", "LICENSE")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(packageRoot, "node_modules", "@resin", "runtime", "NOTICE")),
    ).toBe(true);

    const releaseArchive = createTarGz();
    const denoArchive = createStoredZip("deno", Buffer.from("#!/bin/sh\nexit 0\n", "utf8"));
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const der = publicKey.export({ type: "spki", format: "der" });
    const publicKeyHex = der.subarray(-32).toString("hex");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const publicKeyFingerprintSha256 = crypto.createHash("sha256").update(der).digest("hex");
    const keyId = "packaged-http-fixture";
    const packageDistDir = path.join(installDir, "node_modules", "resin", "dist");
    fs.mkdirSync(packageDistDir, { recursive: true });
    const releaseTrustBundle = {
      schemaVersion: "2.0.0",
      trustDomain: "production",
      trustedKeys: [
        {
          keyId,
          algorithm: "Ed25519",
          trustDomain: "production",
          publicKeyPem,
          publicKeyHex,
          publicKeyFingerprintSha256,
        },
      ],
    };
    fs.writeFileSync(
      path.join(packageDistDir, "release-trust.json"),
      JSON.stringify(releaseTrustBundle, null, 2),
      "utf8",
    );
    const releaseIdentity = { commitSha: "a".repeat(40) };
    const assetKey = platformAssetKey();
    const releaseFilename = `resin-v1.0.0-${assetKey}.tar.gz`;
    const denoFilename = denoFixtureFilename();

    let channelBytes = Buffer.alloc(0);
    let manifestBytes = Buffer.alloc(0);
    let baseUrl = "";
    const server = http.createServer((request, response) => {
      if (request.url === "/channels.json") {
        response.setHeader("content-type", "application/json");
        response.end(channelBytes);
        return;
      }
      if (request.url === "/manifest.json") {
        response.setHeader("content-type", "application/json");
        response.end(manifestBytes);
        return;
      }
      if (request.url === `/${releaseFilename}`) {
        response.end(releaseArchive);
        return;
      }
      if (request.url === `/${denoFilename}`) {
        response.end(denoArchive);
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || String(address) === address)
      throw new Error("HTTP fixture did not bind a port");
    baseUrl = `http://127.0.0.1:${address.port}`;

    const manifestPayload = {
      schemaVersion: "2.0.0",
      metadataVersion: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
      version: "1.0.0",
      releaseDate: "2026-08-18T00:00:00.000Z",
      releaseIdentity,
      packages: {},
      assets: {
        [assetKey]: {
          filename: releaseFilename,
          platform: process.platform === "darwin" ? "darwin" : "linux",
          arch: process.arch,
          isWsl: false,
          sizeBytes: releaseArchive.length,
          sha256: sha256(releaseArchive),
          path: releaseFilename,
        },
      },
      runtimes: {
        deno: {
          version: "2.9.5",
          required: true,
          assets: {
            [assetKey]: {
              filename: denoFilename,
              url: `${baseUrl}/${denoFilename}`,
              sha256: sha256(denoArchive),
              archive: "zip",
              executable: "deno",
            },
          },
        },
      },
    };
    const manifest = {
      ...manifestPayload,
      signatures: [
        {
          keyId,
          algorithm: "Ed25519",
          publicKeyHex,
          signatureHex: sign(manifestPayload, privateKey),
        },
      ],
    };
    manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
    const channelPayload = {
      schemaVersion: "2.0.0",
      metadataVersion: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
      minSupportedVersion: "0.1.0",
      currentVersion: "1.0.0",
      updatedAt: "2026-08-18T00:00:00.000Z",
      releaseIdentity,
      channels: {
        stable: {
          version: "1.0.0",
          releaseDate: "2026-08-18T00:00:00.000Z",
          manifestUrl: `${baseUrl}/manifest.json`,
          manifestDigest: sha256(manifestBytes),
          isLatest: true,
        },
      },
      rollbackReferences: {
        targetVersion: "0.1.0",
        minSafeVersion: "0.1.0",
      },
      revokedVersions: [],
    };
    const channel = {
      ...channelPayload,
      signatures: [
        {
          keyId,
          algorithm: "Ed25519",
          publicKeyHex,
          signatureHex: sign(channelPayload, privateKey),
        },
      ],
    };
    channelBytes = Buffer.from(JSON.stringify(channel), "utf8");

    let stdout = "";
    let stderr = "";
    try {
      const result = await execFileAsync(
        process.execPath,
        [
          packedBin,
          "init",
          "--non-interactive",
          "--local-only",
          "--auto-approve",
          `--home=${home}`,
          `--workspace=${workspace}`,
          "--json",
        ],
        {
          cwd: path.dirname(packedBin),
          env: {
            ...process.env,
            NODE_ENV: undefined,
            RESIN_RELEASE_MODE: "production",
            RESIN_RELEASE_CHANNEL_URL: `${baseUrl}/channels.json`,
            RESIN_ALLOW_INSECURE_LOOPBACK_RELEASES: "1",
          },
          maxBuffer: 20 * 1024 * 1024,
        },
      );
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error: unknown) {
      // SAFETY: Error object inspected for stdout/stderr strings.
      const errObj =
        error && error instanceof Object
          ? (error as { stdout?: string; stderr?: string; code?: unknown })
          : null;
      const message = error instanceof Error ? error.message : String(error);
      const out = errObj && String(errObj.stdout) === errObj.stdout ? errObj.stdout : "";
      const err = errObj && String(errObj.stderr) === errObj.stderr ? errObj.stderr : "";
      const code = errObj?.code !== undefined ? String(errObj.code) : "UNKNOWN";
      throw new Error(
        `Packed CLI init failed (code: ${code}): ${message}\n--- stdout ---\n${out}\n--- stderr ---\n${err}`,
      );
    }

    try {
      expect(stderr).toBe("");
      expect(stdout).toContain('"success": true');
      expect(fs.existsSync(path.join(home, ".resin", "versions", "v1.0.0"))).toBe(true);
      expect(fs.existsSync(path.join(home, ".resin", "versions", "v1.0.0", "bin", "resin"))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(home, ".resin", "versions", "v1.0.0", "resin"))).toBe(false);
      const versionMetadata = JSON.parse(
        fs.readFileSync(path.join(home, ".resin", "versions", "v1.0.0", "version.json"), "utf8"),
      );
      expect(versionMetadata.provenance.manifestSha256).toBe(sha256(manifestBytes));
      expect(versionMetadata.denoRuntime.version).toBe("2.9.5");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);
});
