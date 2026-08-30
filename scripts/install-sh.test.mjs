import child_process from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const INSTALL_SH_PATH = path.resolve(process.cwd(), "apps/cli/install/install.sh");
const HELPER_MJS_PATH = path.resolve(process.cwd(), "apps/cli/install/install-helper-v1.mjs");

/**
 * Execute install.sh asynchronously in a controlled environment.
 */
function runInstallSh(args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const proc = child_process.spawn("sh", [INSTALL_SH_PATH, ...args], {
      cwd: options.cwd || process.cwd(),
      env: {
        PATH: process.env.PATH,
        TMPDIR: options.tmpDir || process.env.TMPDIR,
        ...options.env,
      },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    proc.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Execute install.sh via stdin pipe (simulating curl | sh).
 */
function runInstallShViaStdin(args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const scriptContent = fs.readFileSync(INSTALL_SH_PATH);
    const proc = child_process.spawn("sh", ["-s", "--", ...args], {
      cwd: options.cwd || process.cwd(),
      env: {
        PATH: process.env.PATH,
        TMPDIR: options.tmpDir || process.env.TMPDIR,
        ...options.env,
      },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    proc.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });

    proc.on("error", (err) => {
      reject(err);
    });

    proc.stdin.write(scriptContent);
    proc.stdin.end();
  });
}

describe("install.sh bootstrap script", () => {
  let tempDir;
  let mockServer;
  let serverPort;
  let helperContent;
  let helperSha256;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-sh-test-"));
    helperContent = fs.readFileSync(HELPER_MJS_PATH);
    helperSha256 = crypto.createHash("sha256").update(helperContent).digest("hex");
  });

  afterEach(async () => {
    if (mockServer) {
      await new Promise((resolve) => mockServer.close(resolve));
      mockServer = null;
    }
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("prints help documentation with inspect-first flow on --help and -h", async () => {
    for (const flag of ["--help", "-h"]) {
      const res = await runInstallSh([flag]);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("Resin Standalone Installer for POSIX");
      expect(res.stdout).toContain("Inspect-First Workflow");
      expect(res.stdout).toContain("--download-only <path>");
      expect(res.stdout).toContain("node ./install-helper.mjs");
      expect(res.stdout).toContain("Node.js >= 22.0.0");
      expect(res.stderr).toBe("");
    }
  });

  it("functions properly when piped via stdin (curl -fsSL https://resin.sh/install.sh | sh)", async () => {
    const res = await runInstallShViaStdin(["--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Resin Standalone Installer for POSIX");
    expect(res.stdout).toContain("Inspect-First Workflow");
  });

  it("validates CLI arguments and rejects unknown or malformed options", async () => {
    const invalidInvocations = [
      { args: ["--unknown-flag"], error: "Unknown option: --unknown-flag" },
      { args: ["--download-only"], error: "Missing value for argument: --download-only" },
      { args: ["--download-only="], error: "Missing value for argument: --download-only" },
      {
        args: ["--download-only", "--channel"],
        error: "Missing value for argument: --download-only",
      },
      { args: ["--channel"], error: "Missing value for argument: --channel" },
      { args: ["--channel="], error: "Missing value for argument: --channel" },
      { args: ["--channel-url"], error: "Missing value for argument: --channel-url" },
      { args: ["--channel-url="], error: "Missing value for argument: --channel-url" },
      { args: ["--resin-home"], error: "Missing value for argument: --resin-home" },
      { args: ["--resin-home="], error: "Missing value for argument: --resin-home" },
      { args: ["unexpected_bare_arg"], error: "Unexpected argument: unexpected_bare_arg" },
      {
        args: ["--channel", "stable", "trailing_bare_arg"],
        error: "Unexpected argument: trailing_bare_arg",
      },
    ];

    for (const { args, error } of invalidInvocations) {
      const res = await runInstallSh(args);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(error);
    }
  });

  it("downloads and verifies exact bytes atomically with --download-only and --download-only=path without executing", async () => {
    mockServer = http.createServer((req, res) => {
      if (req.url === "/install-helper-v1.mjs") {
        res.writeHead(200, { "Content-Type": "application/javascript" });
        res.end(helperContent);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    serverPort = mockServer.address().port;

    // Test 1: Space-separated flag syntax
    const downloadTarget1 = path.join(tempDir, "verified-helper-1.mjs");
    const resinHome1 = path.join(tempDir, "resin-home-1");

    const res1 = await runInstallSh(["--download-only", downloadTarget1], {
      env: {
        RESIN_INSTALL_TEST_ONLY: "1",
        RESIN_HELPER_URL: `http://127.0.0.1:${serverPort}/install-helper-v1.mjs`,
        RESIN_HOME: resinHome1,
      },
    });

    expect(res1.status).toBe(0);
    expect(res1.stdout).toContain("Successfully downloaded and verified Resin install helper.");
    expect(res1.stdout).toContain(`Location: ${path.resolve(downloadTarget1)}`);
    expect(res1.stdout).toContain(`SHA-256:  ${helperSha256}`);
    expect(res1.stdout).toContain(`cat "${path.resolve(downloadTarget1)}"`);
    expect(res1.stdout).toContain(`node "${path.resolve(downloadTarget1)}"`);

    expect(fs.existsSync(downloadTarget1)).toBe(true);
    const writtenBytes1 = fs.readFileSync(downloadTarget1);
    expect(writtenBytes1.equals(helperContent)).toBe(true);
    const writtenSha1 = crypto.createHash("sha256").update(writtenBytes1).digest("hex");
    expect(writtenSha1).toBe(helperSha256);
    expect(fs.existsSync(resinHome1)).toBe(false);

    // Test 2: Equals-separated flag syntax
    const downloadTarget2 = path.join(tempDir, "verified-helper-2.mjs");
    const resinHome2 = path.join(tempDir, "resin-home-2");

    const res2 = await runInstallSh([`--download-only=${downloadTarget2}`], {
      env: {
        RESIN_INSTALL_TEST_ONLY: "1",
        RESIN_HELPER_URL: `http://127.0.0.1:${serverPort}/install-helper-v1.mjs`,
        RESIN_HOME: resinHome2,
      },
    });

    expect(res2.status).toBe(0);
    expect(fs.existsSync(downloadTarget2)).toBe(true);
    const writtenBytes2 = fs.readFileSync(downloadTarget2);
    expect(writtenBytes2.equals(helperContent)).toBe(true);
    expect(fs.existsSync(resinHome2)).toBe(false);
  });

  it("rejects helper with SHA-256 hash mismatch and avoids mutation", async () => {
    const tamperedContent = Buffer.from(
      "// Tampered helper script content\nconsole.log('pwned');\n",
    );
    mockServer = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end(tamperedContent);
    });

    await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    serverPort = mockServer.address().port;

    const downloadTarget = path.join(tempDir, "tampered-helper.mjs");
    const resinHome = path.join(tempDir, "resin-home");

    const res = await runInstallSh(["--download-only", downloadTarget], {
      env: {
        RESIN_INSTALL_TEST_ONLY: "1",
        RESIN_HELPER_URL: `http://127.0.0.1:${serverPort}/install-helper-v1.mjs`,
        RESIN_HOME: resinHome,
      },
    });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("SHA-256 checksum mismatch!");
    expect(res.stderr).toContain("Helper script may have been tampered with or corrupted.");

    // File must not exist at download target
    expect(fs.existsSync(downloadTarget)).toBe(false);
    expect(fs.existsSync(resinHome)).toBe(false);
  });

  it("rejects HTTP redirects in helper download and fails safely", async () => {
    mockServer = http.createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "/install-helper-v1.mjs" });
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "application/javascript" });
        res.end(helperContent);
      }
    });

    await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    serverPort = mockServer.address().port;

    const downloadTarget = path.join(tempDir, "redirect-helper.mjs");
    const resinHome = path.join(tempDir, "resin-home");

    const res = await runInstallSh(["--download-only", downloadTarget], {
      env: {
        RESIN_INSTALL_TEST_ONLY: "1",
        RESIN_HELPER_URL: `http://127.0.0.1:${serverPort}/redirect`,
        RESIN_HOME: resinHome,
      },
    });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("HTTP redirect (status 302) rejected");
    expect(fs.existsSync(downloadTarget)).toBe(false);
    expect(fs.existsSync(resinHome)).toBe(false);
  });

  it("rejects private and loopback address resolution in production mode", async () => {
    const fakeBinDir = path.join(tempDir, "fake-bin-dns");
    const dnsFixturePath = path.join(tempDir, "dns-fixture.cjs");
    const fakeNodePath = path.join(fakeBinDir, "node");
    fs.mkdirSync(fakeBinDir, { recursive: true });

    fs.writeFileSync(
      dnsFixturePath,
      `const dns = require("node:dns").promises;
const net = require("node:net");
const address = process.env.RESIN_TEST_DNS_ADDRESS;

dns.resolve4 = async () => net.isIPv4(address) ? [address] : [];
dns.resolve6 = async () => net.isIPv6(address) ? [address] : [];
dns.lookup = async (_hostname, options) => {
  const result = { address, family: net.isIPv4(address) ? 4 : 6 };
  return options?.all ? [result] : result;
};
`,
    );
    fs.writeFileSync(
      fakeNodePath,
      `#!/bin/sh
exec "$RESIN_TEST_REAL_NODE" --require "$RESIN_TEST_DNS_FIXTURE" "$@"
`,
      { mode: 0o755 },
    );

    const restrictedAddresses = [
      "127.0.0.1",
      "10.0.0.1",
      "::1",
      "fd00::1",
      "::ffff:7f00:1",
      "::ffff:a00:1",
    ];
    for (const address of restrictedAddresses) {
      const downloadTarget = path.join(
        tempDir,
        `private-helper-${address.replaceAll(":", "-")}.mjs`,
      );
      const res = await runInstallSh(["--download-only", downloadTarget], {
        env: {
          PATH: `${fakeBinDir}:${process.env.PATH}`,
          RESIN_INSTALL_TEST_ONLY: "0",
          RESIN_TEST_DNS_ADDRESS: address,
          RESIN_TEST_DNS_FIXTURE: dnsFixturePath,
          RESIN_TEST_REAL_NODE: process.execPath,
        },
      });

      expect(res.status).toBe(1);
      expect(res.stderr).toContain(
        `Host "dist.resin.sh" resolved to prohibited address "${address}". Helper acquisition rejected.`,
      );
      expect(fs.existsSync(downloadTarget)).toBe(false);
    }
  });

  it("fails preflight check before downloading when Node.js is missing or < 22", async () => {
    const fakeBinDir = path.join(tempDir, "fake-bin");
    fs.mkdirSync(fakeBinDir, { recursive: true });

    // Link required shell utilities
    for (const util of ["sh", "uname", "mktemp", "mkdir", "chmod", "rm", "cat", "echo"]) {
      try {
        const fullPath = child_process.execSync(`which ${util}`, { encoding: "utf8" }).trim();
        fs.symlinkSync(fullPath, path.join(fakeBinDir, util));
      } catch {}
    }

    // 1. Missing node binary
    const resNoNode = await runInstallSh([], {
      env: {
        PATH: fakeBinDir,
      },
    });
    expect(resNoNode.status).toBe(1);
    expect(resNoNode.stderr).toContain(
      "Node.js is required to install Resin, but 'node' was not found in PATH.",
    );
    expect(resNoNode.stderr).toContain("Node.js >= 22.0.0");

    // 2. Outdated Node version (e.g. Node 18)
    const fakeNodePath = path.join(fakeBinDir, "node");
    fs.writeFileSync(
      fakeNodePath,
      `#!/bin/sh
if [ "$1" = "--no-warnings" ]; then shift; fi
if [ "$1" = "-v" ]; then echo "v18.20.0"; exit 0; fi
if [ "$1" = "-e" ]; then echo "FAIL:18.20.0"; exit 0; fi
exit 0
`,
      { mode: 0o755 },
    );

    const resOldNode = await runInstallSh([], {
      env: {
        PATH: `${fakeBinDir}:${process.env.PATH}`,
      },
    });
    expect(resOldNode.status).toBe(1);
    expect(resOldNode.stderr).toContain("Node.js >= 22.0.0 is required, but found 18.20.0");
  });

  it("fails preflight check before mutation when native Windows environment is detected", async () => {
    const fakeBinDir = path.join(tempDir, "fake-bin-win");
    fs.mkdirSync(fakeBinDir, { recursive: true });

    for (const util of ["sh", "mktemp", "mkdir", "chmod", "rm", "cat", "echo", "node"]) {
      try {
        const fullPath = child_process.execSync(`which ${util}`, { encoding: "utf8" }).trim();
        fs.symlinkSync(fullPath, path.join(fakeBinDir, util));
      } catch {}
    }

    const fakeUname = path.join(fakeBinDir, "uname");
    fs.writeFileSync(
      fakeUname,
      `#!/bin/sh
if [ "$1" = "-s" ]; then echo "MINGW64_NT-10.0-22631"; exit 0; fi
if [ "$1" = "-m" ]; then echo "x86_64"; exit 0; fi
echo "MINGW64"
`,
      { mode: 0o755 },
    );

    const resWin = await runInstallSh([], {
      env: {
        PATH: `${fakeBinDir}:/bin:/usr/bin`,
      },
    });

    expect(resWin.status).toBe(1);
    expect(resWin.stderr).toContain(
      "Native Windows shell environments (cmd.exe, PowerShell, Git Bash) are not supported directly.",
    );
    expect(resWin.stderr).toContain(
      "Resin requires WSL2 (Windows Subsystem for Linux 2) on Windows.",
    );
    expect(resWin.stderr).toContain("wsl --install");
  });

  it("fails preflight check before mutation when CPU architecture is unsupported 32-bit", async () => {
    const fakeBinDir = path.join(tempDir, "fake-bin-32");
    fs.mkdirSync(fakeBinDir, { recursive: true });

    for (const util of ["sh", "mktemp", "mkdir", "chmod", "rm", "cat", "echo", "node"]) {
      try {
        const fullPath = child_process.execSync(`which ${util}`, { encoding: "utf8" }).trim();
        fs.symlinkSync(fullPath, path.join(fakeBinDir, util));
      } catch {}
    }

    const fakeUname = path.join(fakeBinDir, "uname");
    fs.writeFileSync(
      fakeUname,
      `#!/bin/sh
if [ "$1" = "-s" ]; then echo "Linux"; exit 0; fi
if [ "$1" = "-m" ]; then echo "i686"; exit 0; fi
echo "Linux"
`,
      { mode: 0o755 },
    );

    const res32 = await runInstallSh([], {
      env: {
        PATH: `${fakeBinDir}:/bin:/usr/bin`,
      },
    });

    expect(res32.status).toBe(1);
    expect(res32.stderr).toContain("CPU architecture 'i686' is not supported by Resin.");
    expect(res32.stderr).toContain("Resin requires 64-bit x86_64 or arm64/aarch64.");
  });

  it("rejects helper download when Content-Length exceeds 1 MiB cap or is invalid", async () => {
    // 1. Content-Length exceeding 1 MiB
    mockServer = http.createServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/javascript",
        "Content-Length": "1048577",
      });
      res.end(Buffer.alloc(100));
    });
    await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    serverPort = mockServer.address().port;

    const downloadTarget1 = path.join(tempDir, "oversized-cl.mjs");
    const res1 = await runInstallSh(["--download-only", downloadTarget1], {
      env: {
        RESIN_INSTALL_TEST_ONLY: "1",
        RESIN_HELPER_URL: `http://127.0.0.1:${serverPort}/install-helper-v1.mjs`,
      },
    });

    expect(res1.status).toBe(1);
    expect(res1.stderr).toContain("exceeds maximum allowed size of 1 MiB");
    expect(fs.existsSync(downloadTarget1)).toBe(false);

    await new Promise((resolve) => mockServer.close(resolve));

    // 2. Malformed Content-Length
    mockServer = http.createServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/javascript",
        "Content-Length": "invalid-size",
      });
      res.end(Buffer.alloc(100));
    });
    await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    serverPort = mockServer.address().port;

    const downloadTarget2 = path.join(tempDir, "invalid-cl.mjs");
    const res2 = await runInstallSh(["--download-only", downloadTarget2], {
      env: {
        RESIN_INSTALL_TEST_ONLY: "1",
        RESIN_HELPER_URL: `http://127.0.0.1:${serverPort}/install-helper-v1.mjs`,
      },
    });

    expect(res2.status).toBe(1);
    expect(res2.stderr).toMatch(
      /Error: (Parse Error: Invalid character in content-length|Invalid Content-Length header value)/i,
    );
    expect(fs.existsSync(downloadTarget2)).toBe(false);
  });

  it("rejects helper download when streaming body chunks exceed 1 MiB cap", async () => {
    mockServer = http.createServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/javascript",
        "Transfer-Encoding": "chunked",
      });
      res.write(Buffer.alloc(512 * 1024));
      setTimeout(() => {
        try {
          res.write(Buffer.alloc(600 * 1024));
          res.end();
        } catch {}
      }, 10);
    });

    await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    serverPort = mockServer.address().port;

    const downloadTarget = path.join(tempDir, "oversized-body.mjs");
    const res = await runInstallSh(["--download-only", downloadTarget], {
      env: {
        RESIN_INSTALL_TEST_ONLY: "1",
        RESIN_HELPER_URL: `http://127.0.0.1:${serverPort}/install-helper-v1.mjs`,
      },
    });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Response body exceeded maximum allowed size of 1 MiB");
    expect(fs.existsSync(downloadTarget)).toBe(false);
  });

  it("aborts and cleans up when response body is prematurely closed or aborted by server", async () => {
    mockServer = http.createServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/javascript",
        "Content-Length": "50000",
      });
      res.write(Buffer.alloc(500));
      setTimeout(() => {
        req.socket.destroy();
      }, 20);
    });

    await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    serverPort = mockServer.address().port;

    const downloadTarget = path.join(tempDir, "aborted.mjs");
    const res = await runInstallSh(["--download-only", downloadTarget], {
      env: {
        RESIN_INSTALL_TEST_ONLY: "1",
        RESIN_HELPER_URL: `http://127.0.0.1:${serverPort}/install-helper-v1.mjs`,
      },
    });

    expect(res.status).toBe(1);
    expect(fs.existsSync(downloadTarget)).toBe(false);
  });

  it("enforces transport limits and timeout constants statically", () => {
    const scriptContent = fs.readFileSync(INSTALL_SH_PATH, "utf8");
    expect(scriptContent).toContain("MAX_HELPER_BYTES = 1024 * 1024");
    expect(scriptContent).toContain("MAX_HEADER_BYTES = 64 * 1024");
    expect(scriptContent).toContain("SOCKET_TIMEOUT_MS = 15000");
    expect(scriptContent).toContain("ABSOLUTE_TIMEOUT_MS = 60000");
  });

  it("ensures no helper execution occurs before cryptographic digest verification", async () => {
    const canaryFile = path.join(tempDir, "canary-executed.txt");
    const maliciousScript = `
import fs from "node:fs";
import process from "node:process";
fs.writeFileSync(${JSON.stringify(canaryFile)}, "EXECUTED");
process.stdout.write(JSON.stringify({ success: true }));
process.exit(0);
`;
    const maliciousBuffer = Buffer.from(maliciousScript, "utf8");

    mockServer = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end(maliciousBuffer);
    });

    await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    serverPort = mockServer.address().port;

    // Use a different expected hash so digest check fails
    const res = await runInstallSh([], {
      env: {
        RESIN_INSTALL_TEST_ONLY: "1",
        RESIN_HELPER_URL: `http://127.0.0.1:${serverPort}/install-helper-v1.mjs`,
        RESIN_TEST_HELPER_SHA256:
          "0000000000000000000000000000000000000000000000000000000000000000",
      },
    });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("SHA-256 checksum mismatch");
    expect(fs.existsSync(canaryFile)).toBe(false);
  });

  it("rejects execution when helper exits 0 with empty stdout", async () => {
    const emptyScript = `
import process from "node:process";
process.stderr.write("Diagnostic info logged to stderr\\n");
process.exit(0);
`;
    const emptyBuffer = Buffer.from(emptyScript, "utf8");
    const emptySha = crypto.createHash("sha256").update(emptyBuffer).digest("hex");

    mockServer = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end(emptyBuffer);
    });

    await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    serverPort = mockServer.address().port;

    const res = await runInstallSh([], {
      env: {
        RESIN_INSTALL_TEST_ONLY: "1",
        RESIN_HELPER_URL: `http://127.0.0.1:${serverPort}/install-helper-v1.mjs`,
        RESIN_TEST_HELPER_SHA256: emptySha,
      },
    });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Diagnostic info logged to stderr");
    expect(res.stderr).toContain(
      "completed with exit code 0 but did not emit a valid JSON success result",
    );
  });

  it("rejects execution when helper exits 0 but outputs invalid JSON or non-success payload", async () => {
    // 1. Plain text output
    const textScript = `
import process from "node:process";
process.stderr.write("Starting...\\n");
process.stdout.write("Not JSON output\\n");
process.exit(0);
`;
    const textBuffer = Buffer.from(textScript, "utf8");
    const textSha = crypto.createHash("sha256").update(textBuffer).digest("hex");

    mockServer = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end(textBuffer);
    });

    await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    serverPort = mockServer.address().port;

    const res1 = await runInstallSh([], {
      env: {
        RESIN_INSTALL_TEST_ONLY: "1",
        RESIN_HELPER_URL: `http://127.0.0.1:${serverPort}/install-helper-v1.mjs`,
        RESIN_TEST_HELPER_SHA256: textSha,
      },
    });

    expect(res1.status).toBe(1);
    expect(res1.stderr).toContain("Starting...");
    expect(res1.stderr).toContain(
      "completed with exit code 0 but did not emit a valid JSON success result",
    );

    await new Promise((resolve) => mockServer.close(resolve));

    // 2. JSON with success: false
    const failJsonScript = `
import process from "node:process";
process.stdout.write(JSON.stringify({ success: false, error: "Something went wrong" }) + "\\n");
process.exit(0);
`;
    const failJsonBuffer = Buffer.from(failJsonScript, "utf8");
    const failJsonSha = crypto.createHash("sha256").update(failJsonBuffer).digest("hex");

    mockServer = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end(failJsonBuffer);
    });

    await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    serverPort = mockServer.address().port;

    const res2 = await runInstallSh([], {
      env: {
        RESIN_INSTALL_TEST_ONLY: "1",
        RESIN_HELPER_URL: `http://127.0.0.1:${serverPort}/install-helper-v1.mjs`,
        RESIN_TEST_HELPER_SHA256: failJsonSha,
      },
    });

    expect(res2.status).toBe(1);
    expect(res2.stderr).toContain(
      "completed with exit code 0 but did not emit a valid JSON success result",
    );
  });

  it("accepts execution when helper exits 0 and outputs valid JSON success result", async () => {
    const successResult = {
      success: true,
      version: "1.0.0",
      resinHome: "/tmp/resin-test",
    };
    const successScript = `
import process from "node:process";
process.stderr.write("Platform qualified: linux-arm64\\n");
process.stdout.write(${JSON.stringify(JSON.stringify(successResult, null, 2))} + "\\n");
process.exit(0);
`;
    const successBuffer = Buffer.from(successScript, "utf8");
    const successSha = crypto.createHash("sha256").update(successBuffer).digest("hex");

    mockServer = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end(successBuffer);
    });

    await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    serverPort = mockServer.address().port;

    const res = await runInstallSh([], {
      env: {
        RESIN_INSTALL_TEST_ONLY: "1",
        RESIN_HELPER_URL: `http://127.0.0.1:${serverPort}/install-helper-v1.mjs`,
        RESIN_TEST_HELPER_SHA256: successSha,
      },
    });

    expect(res.status).toBe(0);
    expect(res.stderr).toContain("Platform qualified: linux-arm64");
    const parsed = JSON.parse(res.stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.version).toBe("1.0.0");
  });

  it("cleans up temporary directories on exit, failure, and termination", async () => {
    const customTmp = path.join(tempDir, "custom-tmp");
    fs.mkdirSync(customTmp, { recursive: true });

    // 1. Run a failing command (CLI argument validation failure)
    await runInstallSh(["--channel"], {
      tmpDir: customTmp,
    });
    expect(fs.readdirSync(customTmp).filter((e) => e.startsWith("resin-install")).length).toBe(0);

    // 2. Successful execution cleanup
    const successScript = `
import process from "node:process";
process.stdout.write(JSON.stringify({ success: true, version: "1.0.0" }) + "\\n");
process.exit(0);
`;
    const successBuffer = Buffer.from(successScript, "utf8");
    const successSha = crypto.createHash("sha256").update(successBuffer).digest("hex");

    mockServer = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end(successBuffer);
    });
    await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    serverPort = mockServer.address().port;

    await runInstallSh([], {
      tmpDir: customTmp,
      env: {
        RESIN_INSTALL_TEST_ONLY: "1",
        RESIN_HELPER_URL: `http://127.0.0.1:${serverPort}/install-helper-v1.mjs`,
        RESIN_TEST_HELPER_SHA256: successSha,
      },
    });

    expect(fs.readdirSync(customTmp).filter((e) => e.startsWith("resin-install")).length).toBe(0);
  });
  it("forwards -v, --verbose, --json, and --no-path-update flags to install helper cleanly", async () => {
    const successResult = {
      success: true,
      version: "1.0.0",
    };
    const forwardCheckScript = `
import process from "node:process";
const args = process.argv.slice(2);
process.stderr.write("Received args: " + args.join(" ") + "\\n");
process.stdout.write(${JSON.stringify(JSON.stringify(successResult, null, 2))} + "\\n");
process.exit(0);
`;
    const forwardBuffer = Buffer.from(forwardCheckScript, "utf8");
    const forwardSha = crypto.createHash("sha256").update(forwardBuffer).digest("hex");

    mockServer = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end(forwardBuffer);
    });

    await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    serverPort = mockServer.address().port;

    const res = await runInstallSh(["--verbose", "--no-path-update"], {
      env: {
        RESIN_INSTALL_TEST_ONLY: "1",
        RESIN_HELPER_URL: `http://127.0.0.1:${serverPort}/install-helper-v1.mjs`,
        RESIN_TEST_HELPER_SHA256: forwardSha,
      },
    });

    expect(res.status).toBe(0);
    expect(res.stderr).toContain("Received args: --verbose --no-path-update");
    const parsed = JSON.parse(res.stdout);
    expect(parsed.success).toBe(true);
  });
});
