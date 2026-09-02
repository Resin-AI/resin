import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InMemoryConfigFsBridge } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import {
  type AssetManifest,
  computeSha256,
  discoverAndVerifyAssets,
  findDenoExecutable,
} from "../src/installer/assets.js";

describe("Asset Acquisition & Verification", () => {
  it("calculates deterministic SHA-256 digests", () => {
    const hash = computeSha256("resin-test-payload");
    expect(hash).toBeDefined();
    expect(hash).toHaveLength(64);
    expect(computeSha256("resin-test-payload")).toBe(hash);
  });

  it("verifies assets against expected manifest", async () => {
    const bridge = new InMemoryConfigFsBridge();

    const daemonSource = "console.log('daemon');";
    const runtimeSource = "console.log('runtime');";
    const shimSource = "console.log('shim');";

    await bridge.writeFile("/opt/te/daemon.js", daemonSource);
    await bridge.writeFile("/opt/te/runtime.js", runtimeSource);
    await bridge.writeFile("/opt/te/shim.js", shimSource);

    const manifest: AssetManifest = {
      schemaVersion: "0.1.0",
      assets: {
        daemon: {
          version: "0.1.0",
          sha256: computeSha256(daemonSource),
          required: true,
        },
        runtime: {
          version: "0.1.0",
          sha256: computeSha256(runtimeSource),
          required: true,
        },
        "mcp-shim": {
          version: "0.1.0",
          sha256: computeSha256(shimSource),
          required: true,
        },
        deno: {
          version: "2.0.0",
          required: false,
        },
      },
    };

    const result = await discoverAndVerifyAssets({
      manifest,
      fsBridge: bridge,
      customPaths: {
        daemon: "/opt/te/daemon.js",
        runtime: "/opt/te/runtime.js",
        "mcp-shim": "/opt/te/shim.js",
      },
      allowMissingOptional: true,
    });

    expect(result.allVerified).toBe(true);
    expect(result.missingRequired).toHaveLength(0);
    expect(result.digestMismatches).toHaveLength(0);
    expect(result.assets).toHaveLength(4);
  });

  it("flags digest mismatch when asset content does not match expected hash", async () => {
    const bridge = new InMemoryConfigFsBridge();

    await bridge.writeFile("/opt/te/daemon.js", "corrupted content");

    const manifest: AssetManifest = {
      schemaVersion: "0.1.0",
      assets: {
        daemon: {
          version: "0.1.0",
          sha256: "0000000000000000000000000000000000000000000000000000000000000000",
          required: true,
        },
        runtime: { version: "0.1.0", required: false },
        "mcp-shim": { version: "0.1.0", required: false },
        deno: { version: "2.0.0", required: false },
      },
    };

    const result = await discoverAndVerifyAssets({
      manifest,
      fsBridge: bridge,
      customPaths: { daemon: "/opt/te/daemon.js" },
    });

    expect(result.allVerified).toBe(false);
    expect(result.digestMismatches).toHaveLength(1);
    expect(result.digestMismatches[0].name).toBe("daemon");
  });

  it.skipIf(process.platform === "win32")(
    "discovers Deno from a custom home's active Resin release pointer",
    async () => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), "resin-deno-discovery-"));
      const executablePath = path.join(home, ".resin", "versions", "v2.9.5", "deno", "deno");

      try {
        await fs.mkdir(path.dirname(executablePath), { recursive: true });
        await fs.writeFile(executablePath, '#!/bin/sh\necho "deno 2.9.5"\n', "utf8");
        await fs.chmod(executablePath, 0o755);
        await fs.writeFile(path.join(home, ".resin", "current-version"), "2.9.5\n", "utf8");

        const found = await findDenoExecutable(undefined, {
          HOME: home,
          PATH: "/usr/bin:/bin",
        });

        expect(found).toEqual({ path: executablePath, version: "2.9.5" });
      } finally {
        await fs.rm(home, { recursive: true, force: true });
      }
    },
  );

  it("does not treat a merely existing path as a working Deno executable", async () => {
    const bridge = new InMemoryConfigFsBridge();
    await bridge.writeFile("/home/developer/.deno/bin/deno", "not-an-executable-deno");

    const found = await findDenoExecutable(undefined, { HOME: "/home/developer" }, bridge);

    expect(found).toBeNull();
  });
});
