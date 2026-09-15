import { createPublicKey } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { InMemoryKeyStore, type KeyStore } from "@resin/runtime";
import { z } from "zod";

const localArtifactTrustSchema = z
  .object({
    version: z.literal(1),
    cloudOrigin: z.string().min(1),
    keyId: z.string().min(1).max(256).regex(/^\S+$/),
    algorithm: z.literal("ed25519"),
    publicKeyPem: z.string().max(4096),
  })
  .strict();

export class LocalArtifactTrustConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Invalid local artifact trust configuration: ${message}`, options);
    this.name = "LocalArtifactTrustConfigurationError";
  }
}

/** Explicit local-only pin. Never reads keys from cloud responses or the workspace. */
export function loadLocalArtifactTrust(
  resinHome: string,
  cloudUrl: string | undefined,
): KeyStore | undefined {
  const filePath = process.env.RESIN_LOCAL_ARTIFACT_TRUST_FILE;
  if (filePath === undefined) return undefined;

  try {
    const root = path.resolve(resinHome);
    if (!path.isAbsolute(filePath) || filePath !== path.resolve(filePath)) {
      throw new Error("trust file path must be absolute and normalized");
    }
    const relative = path.relative(root, filePath);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error("trust file must be inside the Resin profile");
    }
    const uid = process.getuid?.();
    if (uid === undefined)
      throw new Error("owner-only local trust requires POSIX ownership checks");
    let directory = path.dirname(filePath);
    for (;;) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
        throw new Error("trust profile directories must be owner-only and not symlinks");
      }
      if (directory === root) break;
      directory = path.dirname(directory);
    }

    const fd = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    let raw: string;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o077) !== 0 || stat.nlink !== 1) {
        throw new Error("trust file must be an owner-only regular file without links");
      }
      if (stat.size > 8192) throw new Error("trust file is too large");
      raw = fs.readFileSync(fd, "utf8");
    } finally {
      fs.closeSync(fd);
    }
    const config = localArtifactTrustSchema.parse(JSON.parse(raw));
    const origin = new URL(config.cloudOrigin);
    const loopback =
      origin.hostname === "localhost" ||
      origin.hostname === "[::1]" ||
      /^127\.\d+\.\d+\.\d+$/.test(origin.hostname);
    if (
      !loopback ||
      !["http:", "https:"].includes(origin.protocol) ||
      config.cloudOrigin !== origin.origin
    ) {
      throw new Error("cloudOrigin must be a canonical loopback HTTP(S) origin");
    }
    if (!cloudUrl) throw new Error("valid cloud credentials are required for local trust");
    const configured = new URL(cloudUrl);
    if (
      configured.origin !== config.cloudOrigin ||
      configured.username ||
      configured.password ||
      configured.pathname !== "/" ||
      configured.search ||
      configured.hash
    ) {
      throw new Error("cloudOrigin must exactly match the credential cloud origin");
    }
    if (
      !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PUBLIC KEY-----\r?\n?$/.test(
        config.publicKeyPem,
      )
    ) {
      throw new Error("publicKeyPem must contain only one SPKI public key");
    }
    const key = createPublicKey(config.publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("public key must be Ed25519");
    return new InMemoryKeyStore([
      {
        keyId: config.keyId,
        algorithm: config.algorithm,
        publicKeyPem: key.export({ type: "spki", format: "pem" }).toString(),
        trustLevel: "development",
        createdAt: new Date().toISOString(),
      },
    ]);
  } catch (cause) {
    throw new LocalArtifactTrustConfigurationError(
      cause instanceof Error ? cause.message : "could not load trust file",
      { cause },
    );
  }
}
