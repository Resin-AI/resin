import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACCESS_DENIED_CODES,
  evaluateProbe,
  parseProbeArgs,
  processIdentity,
  runProbe,
  sameAccount,
} from "./windows-isolation-probe.mjs";
import {
  createReleaseServer,
  fetchPinnedRuntime,
  resolveReleaseRequest,
  verifyPrebuildsAgainstEvidence,
} from "./windows-lane.mjs";

const tempDirs = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

describe("windows-lane release server", () => {
  const options = { releaseDir: "/rel", runtimeDir: "/rt", version: "1.0.3" };

  it("maps the CDN layout the installer resolves onto the packaged release directory", () => {
    expect(resolveReleaseRequest("/releases/v1/channels.json", options)).toBe(
      path.join("/rel", "channels.json"),
    );
    expect(resolveReleaseRequest("/releases/v1/manifests/manifest-1.0.3.json", options)).toBe(
      path.join("/rel", "manifest.json"),
    );
    expect(
      resolveReleaseRequest(
        "/releases/v1/artifacts/v1.0.3/resin-v1.0.3-windows-x64.tar.gz",
        options,
      ),
    ).toBe(path.join("/rel", "resin-v1.0.3-windows-x64.tar.gz"));
    expect(
      resolveReleaseRequest(
        "/releases/v1/runtimes/deno/v2.9.5/deno-x86_64-pc-windows-msvc.zip",
        options,
      ),
    ).toBe(path.join("/rt", "deno-x86_64-pc-windows-msvc.zip"));
  });

  it("serves nothing outside the release: other versions, traversal and unknown paths", () => {
    for (const request of [
      "/releases/v1/manifests/manifest-9.9.9.json",
      "/releases/v1/artifacts/v9.9.9/resin.tar.gz",
      "/releases/v1/artifacts/v1.0.3/..%2Fsecret",
      "/releases/v1/artifacts/v1.0.3/%2e%2e",
      "/releases/v1/runtimes/deno/v1.0.0/deno.zip",
      "/release-trust.json",
      "/",
    ]) {
      expect(resolveReleaseRequest(request, options), request).toBeNull();
    }
    expect(
      resolveReleaseRequest("/releases/v1/runtimes/deno/v2.9.5/deno.zip", {
        ...options,
        runtimeDir: undefined,
      }),
    ).toBeNull();
  });

  it("streams release files over loopback and 404s everything else", async () => {
    const releaseDir = tempDir("resin-win-lane-release-");
    fs.writeFileSync(path.join(releaseDir, "manifest.json"), JSON.stringify({ version: "1.0.3" }));
    fs.writeFileSync(path.join(releaseDir, "channels.json"), '{"channels":{}}');
    const server = createReleaseServer({ releaseDir });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const channels = await fetch(`${base}/releases/v1/channels.json`);
      expect(channels.status).toBe(200);
      expect(await channels.text()).toBe('{"channels":{}}');
      const missing = await fetch(`${base}/releases/v1/artifacts/v1.0.3/absent.tar.gz`);
      expect(missing.status).toBe(404);
      const post = await fetch(`${base}/releases/v1/channels.json`, { method: "POST" });
      expect(post.status).toBe(404);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("rejects a Deno runtime whose bytes do not match the pin", async () => {
    const outDir = tempDir("resin-win-lane-runtime-");
    const fakeFetch = async () => new Response(Buffer.from("not deno"));
    await expect(fetchPinnedRuntime("windows-x64", outDir, fakeFetch)).rejects.toThrow(
      /Pinned Deno runtime deno-x86_64-pc-windows-msvc\.zip mismatch/,
    );
    expect(fs.existsSync(path.join(outDir, "deno-x86_64-pc-windows-msvc.zip"))).toBe(false);
    await expect(fetchPinnedRuntime("windows-mips", outDir, fakeFetch)).rejects.toThrow(
      /No pinned Deno runtime/,
    );
  });
});

describe("windows-lane prebuild verification for signing", () => {
  function stage({ tamper = null, omitLane = null } = {}) {
    const evidenceDir = tempDir("resin-win-lane-evidence-");
    const prebuildsDir = tempDir("resin-win-lane-prebuilds-");
    for (const [lane, arch] of [
      ["windows-x64", "x64"],
      ["windows-arm64", "arm64"],
    ]) {
      const nativePrebuilds = {};
      fs.mkdirSync(path.join(prebuildsDir, `win32-${arch}`), { recursive: true });
      for (const file of ["resin_windows_security.node", "resin-service-host.exe"]) {
        const bytes = Buffer.from(`${arch}:${file}`);
        nativePrebuilds[file] = { sha256: sha256(bytes) };
        const staged = tamper === `${arch}/${file}` ? Buffer.from("tampered") : bytes;
        fs.writeFileSync(path.join(prebuildsDir, `win32-${arch}`, file), staged);
      }
      if (lane === omitLane) continue;
      fs.writeFileSync(
        path.join(evidenceDir, `${lane}.json`),
        JSON.stringify({
          lane,
          passed: true,
          status: "QUALIFIED",
          checks: { artifactLayout: { nativePrebuilds } },
        }),
      );
    }
    fs.writeFileSync(
      path.join(evidenceDir, "linux-x64.json"),
      JSON.stringify({ lane: "linux-x64", passed: true, status: "QUALIFIED" }),
    );
    return { evidenceDir, prebuildsDir };
  }

  it("accepts prebuilds byte-identical to the ones both Windows lanes qualified", () => {
    const result = verifyPrebuildsAgainstEvidence(stage());
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.verified).toHaveLength(4);
  });

  it("rejects a staged prebuild that differs from the qualified bytes", () => {
    const result = verifyPrebuildsAgainstEvidence(
      stage({ tamper: "arm64/resin-service-host.exe" }),
    );
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(
      /resin-service-host\.exe is [0-9a-f]{64}, but windows-arm64 qualified/,
    );
  });

  it("rejects signing when a Windows lane has no qualification evidence", () => {
    const result = verifyPrebuildsAgainstEvidence(stage({ omitLane: "windows-x64" }));
    expect(result.ok).toBe(false);
    expect(result.problems).toContain("no qualification evidence for windows-x64");
  });
});

describe("windows isolation probe", () => {
  it("parses repeatable targets and the expectation", () => {
    expect(
      parseProbeArgs([
        "--endpoint",
        "\\\\.\\pipe\\resin-daemon-0123456789abcdef",
        "--file",
        "a",
        "--file",
        "b",
        "--dir",
        "c",
        "--expect",
        "denied",
      ]),
    ).toEqual({
      endpoint: "\\\\.\\pipe\\resin-daemon-0123456789abcdef",
      files: ["a", "b"],
      dirs: ["c"],
      expect: "denied",
    });
    expect(() => parseProbeArgs(["--bogus"])).toThrow(/Unknown argument/);
  });

  it("only counts access-denied as a denial; a missing target proves nothing", () => {
    const result = (outcome) => ({
      endpoint: { target: "pipe", outcome },
      files: [{ target: "f", outcome }],
      dirs: [],
    });
    for (const code of ACCESS_DENIED_CODES) {
      expect(evaluateProbe(result(code), "denied")).toEqual([]);
    }
    expect(evaluateProbe(result("ENOENT"), "denied")).toHaveLength(2);
    expect(evaluateProbe(result("connected"), "denied")[0]).toMatch(/expected access denied/);
    expect(evaluateProbe({ endpoint: null, files: [], dirs: [] }, "denied")).toEqual([
      "nothing was probed",
    ]);
  });

  it("reports the process-token identity, not USERNAME, and compares accounts domain-aware", () => {
    const saved = process.env.USERNAME;
    process.env.USERNAME = "someone-else";
    try {
      const identity = processIdentity();
      expect(identity.user).toBe(os.userInfo().username);
      expect(identity.user).not.toBe("someone-else");
      if (process.platform === "win32") {
        expect(identity.sid).toMatch(/^S-1-5-/);
        expect(sameAccount(identity.account, os.userInfo().username)).toBe(true);
      }
    } finally {
      if (saved === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = saved;
    }
    expect(sameAccount("RUNNER-VM\\ResinProbe", "resinprobe")).toBe(true);
    expect(sameAccount("resinprobe", "RESINPROBE")).toBe(true);
    expect(sameAccount("RUNNER-VM\\runneradmin", "resinprobe")).toBe(false);
    expect(sameAccount(null, "resinprobe")).toBe(false);
  });

  it("connects and reads as the owner (positive control)", async () => {
    const dir = tempDir("resin-win-probe-");
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, "{}");
    const endpoint =
      process.platform === "win32"
        ? `\\\\.\\pipe\\resin-probe-test-${process.pid}`
        : path.join(dir, "probe.sock");
    const server = net.createServer((socket) => socket.end());
    await new Promise((resolve) => server.listen(endpoint, resolve));
    try {
      const allowed = await runProbe({ endpoint, files: [file], dirs: [dir], expect: "allowed" });
      expect(allowed.failures).toEqual([]);
      expect(allowed.ok).toBe(true);
      const denied = await runProbe({ endpoint, files: [file], dirs: [dir], expect: "denied" });
      expect(denied.ok).toBe(false);
      expect(denied.failures).toHaveLength(3);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    await expect(runProbe({ endpoint, expect: "maybe" })).rejects.toThrow(/--expect/);
  });
});
