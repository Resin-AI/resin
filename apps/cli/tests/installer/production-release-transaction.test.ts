import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { ChannelMetadata, SignedManifest } from "../../src/installer/channel-verifier.js";
import { ResinInstaller } from "../../src/installer/installer.js";

type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

function canonical(value: CanonicalValue | undefined): string {
  if (
    value === null ||
    value === undefined ||
    Array.isArray(value) ||
    Object.prototype.toString.call(value) !== "[object Object]"
  ) {
    if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
    return JSON.stringify(value);
  }
  // SAFETY: Value narrowed to record object.
  const obj = value as Record<string, CanonicalValue>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(obj[key])}`)
    .join(",")}}`;
}

function sign(payload: CanonicalValue | undefined, privateKey: crypto.KeyObject): string {
  return crypto.sign(null, Buffer.from(canonical(payload)), privateKey).toString("hex");
}

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function tarGz(): Buffer {
  const files = [
    ["bin/resin-daemon", "#!/usr/bin/env node\n"],
    ["bin/resin-mcp", "#!/usr/bin/env node\n"],
    ["bin/resin", "#!/usr/bin/env node\n"],
  ] as const;
  const blocks: Buffer[] = [];
  for (const [name, content] of files) {
    const body = Buffer.from(content);
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
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

function zipStored(name: string, body: Buffer): Buffer {
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  const centralOffset = local.length + nameBuf.length + body.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBuf.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, nameBuf, body, central, nameBuf, end]);
}

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("production signed release transaction", () => {
  it("installs only after channel, manifest, release and runtime verification and rolls back a downstream authorization failure", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-prod-install-"));
    homes.push(home);
    const release = tarGz();
    const denoZip = zipStored("deno", Buffer.from("#!/bin/sh\nexit 0\n"));
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const publicKeyHex = publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("hex");
    const keyId = "test-production-key";
    const assetKey = `${process.platform}-${process.arch}`;
    const releaseFilename = `resin-v1.0.0-${assetKey}.tar.gz`;
    const denoFilename = `deno-${assetKey}.zip`;

    let base = "";
    const releaseIdentity = { commitSha: "a".repeat(40) };
    const manifestPayload = {
      schemaVersion: "2.0.0",
      metadataVersion: 1,
      expiresAt: "2029-01-01T00:00:00.000Z",
      version: "1.0.0",
      releaseDate: "2026-08-18T00:00:00.000Z",
      releaseIdentity,
      packages: {},
      assets: {
        [assetKey]: {
          filename: releaseFilename,
          platform: process.platform,
          arch: process.arch,
          isWsl: false,
          sizeBytes: release.length,
          sha256: sha256(release),
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
              url: "__DENO__",
              sha256: sha256(denoZip),
              archive: "zip",
              executable: "deno",
            },
          },
        },
      },
    };
    let manifest: SignedManifest | null = null;
    let channel: ChannelMetadata | null = null;

    const server = http.createServer((req, res) => {
      if (req.url === "/channels.json") return void res.end(JSON.stringify(channel));
      if (req.url === "/manifest.json") return void res.end(JSON.stringify(manifest));
      if (req.url === `/${releaseFilename}`) return void res.end(release);
      if (req.url === "/deno.zip") return void res.end(denoZip);
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || String(address) === address) throw new Error("missing fixture address");
    base = `http://127.0.0.1:${address.port}`;
    const fixedManifestPayload = JSON.parse(
      JSON.stringify(manifestPayload).replace("__DENO__", `${base}/deno.zip`),
    );
    const manifestSignature = sign(fixedManifestPayload, privateKey);
    manifest = {
      ...fixedManifestPayload,
      signatures: [{ keyId, algorithm: "Ed25519", publicKeyHex, signatureHex: manifestSignature }],
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const channelPayload = {
      schemaVersion: "2.0.0",
      metadataVersion: 1,
      expiresAt: "2029-01-01T00:00:00.000Z",
      minSupportedVersion: "0.1.0",
      currentVersion: "1.0.0",
      updatedAt: "2026-08-18T00:00:00.000Z",
      releaseIdentity,
      channels: {
        stable: {
          version: "1.0.0",
          releaseDate: "2026-08-18T00:00:00.000Z",
          manifestUrl: `${base}/manifest.json`,
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
    channel = {
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

    try {
      const installer = new ResinInstaller({ logger: () => {} });
      await expect(
        installer.run({
          customHome: home,
          workspace: home,
          releaseMode: "production",
          releaseChannelUrl: `${base}/channels.json`,
          trustedReleaseKeys: [{ keyId, publicKeyHex }],
          allowInsecureReleaseTransportForTests: true,
          nonInteractive: true,
          autoApprove: false,
        }),
      ).rejects.toThrow(/authorization/i);
      expect(fs.existsSync(path.join(home, ".resin", "current"))).toBe(false);
      expect(fs.existsSync(path.join(home, ".resin", "versions", "v1.0.0"))).toBe(false);
      const journal = JSON.parse(
        fs.readFileSync(path.join(home, ".resin", "state", "install-journal.json"), "utf8"),
      );
      expect(journal.status).toBe("rolled_back");
      expect(journal.metadata.releaseProvenance.manifestSha256).toBe(sha256(manifestBytes));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);
});
