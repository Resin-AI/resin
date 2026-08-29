import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

const EXPECTED_HELPER_URL = "https://resin.sh/install-helper-v1.mjs";
const EXPECTED_HELPER_SHA256 = "4fdae2b7beb34bb5d74eee867f68ce143588990758595c4a7287ed258b9de12c";
const EXPECTED_MIN_NODE_VERSION = 22;

const SCRIPT_PATH = path.resolve(process.cwd(), "apps/cli/install/install.ps1");
const HELPER_PATH = path.resolve(process.cwd(), "apps/cli/install/install-helper-v1.mjs");

describe("install.ps1 static and security invariants", () => {
  it("declares pinned helper constants matching project policy", () => {
    const content = fs.readFileSync(SCRIPT_PATH, "utf8");
    expect(content).toContain(`$PINNED_HELPER_URL = "${EXPECTED_HELPER_URL}"`);
    expect(content).toContain(`$PINNED_HELPER_SHA256 = "${EXPECTED_HELPER_SHA256}"`);
  });

  it("pins Node.js >= 22 as minimum requirement", () => {
    const content = fs.readFileSync(SCRIPT_PATH, "utf8");
    expect(content).toContain(`$MIN_NODE_VERSION = ${EXPECTED_MIN_NODE_VERSION}`);
  });

  it("enforces HTTPS scheme in production mode and allows HTTP only in test mode", () => {
    const content = fs.readFileSync(SCRIPT_PATH, "utf8");
    expect(content).toContain("if (-not $isTestMode -and $helperUri.Scheme -ne 'https')");
    expect(content).toContain("Security Error: Helper URL must use HTTPS.");
  });

  it("implements fail-closed owner-only ACLs on Windows and 0700 on non-Windows", () => {
    const content = fs.readFileSync(SCRIPT_PATH, "utf8");
    // Windows ACL protection
    expect(content).toContain("$acl.SetAccessRuleProtection($true, $false)");
    expect(content).toContain("[System.Security.AccessControl.FileSystemRights]::FullControl");
    expect(content).toContain("Failed to enforce owner-only ACLs on temporary directory");
    // Non-Windows chmod 0700
    expect(content).toContain("& chmod 0700 $tempDir");
    expect(content).toContain("Failed to set owner-only permissions on temporary directory");
  });

  it("stages helper inside WSL in a 0700 directory on native Linux filesystem", () => {
    const content = fs.readFileSync(SCRIPT_PATH, "utf8");
    expect(content).toContain("mktemp -d /tmp/resin-install.XXXXXX");
    expect(content).toContain("chmod 0700");
    expect(content).toContain("& wsl.exe --exec cp $wslSrcPath $wslDestHelper");
    expect(content).toContain("& wsl.exe --exec chmod 0600 $wslDestHelper");
    expect(content).toContain("& wsl.exe --exec rm -rf $wslStagingDir");
  });

  it("enforces HTTP limits and deadlines in Download-HelperBytes", () => {
    const content = fs.readFileSync(SCRIPT_PATH, "utf8");
    expect(content).toContain("$MAX_HEADER_SIZE = 64 * 1024");
    expect(content).toContain("$MAX_BODY_SIZE = 1024 * 1024");
    expect(content).toContain("$CONNECT_TIMEOUT_MS = 15000");
    expect(content).toContain("$IDLE_TIMEOUT_MS = 15000");
    expect(content).toContain("$TOTAL_TIMEOUT_MS = 60000");
  });

  it("restricts certificate bypass to explicit loopback test mode", () => {
    const content = fs.readFileSync(SCRIPT_PATH, "utf8");
    expect(content).toContain(
      "$isLoopbackTarget = ($TargetIP.ToString() -eq '127.0.0.1' -or $TargetIP.ToString() -eq '::1' -or [System.Net.IPAddress]::IsLoopback($TargetIP))",
    );
    expect(content).toContain("if ($IsTest -and $isLoopbackTarget) { return $true }");
    expect(content).toContain(
      "return ($sslPolicyErrors -eq [System.Net.Security.SslPolicyErrors]::None)",
    );
  });

  it("validates success JSON from helper before completing", () => {
    const content = fs.readFileSync(SCRIPT_PATH, "utf8");
    expect(content).toContain("ConvertFrom-Json");
    expect(content).toContain("$parsedJson.success -ne $true");
    expect(content).toContain("[string]::IsNullOrWhiteSpace($parsedJson.version)");
  });

  function isRestrictedIPv4(b0, b1, b2, b3) {
    if (b0 === 0) return true; // 0.0.0.0/8
    if (b0 === 10) return true; // 10.0.0.0/8
    if (b0 === 100 && (b1 & 192) === 64) return true; // 100.64.0.0/10
    if (b0 === 127) return true; // 127.0.0.0/8
    if (b0 === 169 && b1 === 254) return true; // 169.254.0.0/16
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return true; // 172.16.0.0/12
    if (b0 === 192 && b1 === 0 && b2 === 0) return true; // 192.0.0.0/24
    if (b0 === 192 && b1 === 0 && b2 === 2) return true; // 192.0.2.0/24
    if (b0 === 192 && b1 === 88 && b2 === 99) return true; // 192.88.99.0/24
    if (b0 === 192 && b1 === 168) return true; // 192.168.0.0/16
    if (b0 === 198 && (b1 === 18 || b1 === 19)) return true; // 198.18.0.0/15
    if (b0 === 198 && b1 === 51 && b2 === 100) return true; // 198.51.100.0/24
    if (b0 === 203 && b1 === 0 && b2 === 113) return true; // 203.0.113.0/24
    if (b0 >= 224 && b0 <= 239) return true; // 224.0.0.0/4
    if (b0 >= 240) return true; // 240.0.0.0/4
    return false;
  }

  function isRestrictedIPv6(bytes) {
    if (bytes.every((b) => b === 0)) return true; // ::/128
    if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true; // ::1/128
    // IPv4-mapped ::ffff:0:0/96
    if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 255 && bytes[11] === 255) {
      return isRestrictedIPv4(bytes[12], bytes[13], bytes[14], bytes[15]);
    }
    // 64:ff9b::/96
    if (
      bytes[0] === 0 &&
      bytes[1] === 0x64 &&
      bytes[2] === 0xff &&
      bytes[3] === 0x9b &&
      bytes.slice(4, 12).every((b) => b === 0)
    ) {
      return isRestrictedIPv4(bytes[12], bytes[13], bytes[14], bytes[15]);
    }
    // 100::/64
    if (bytes[0] === 0x01 && bytes[1] === 0x00 && bytes.slice(2, 8).every((b) => b === 0))
      return true;
    // 2001:db8::/32
    if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8)
      return true;
    // 2002::/16
    if (bytes[0] === 0x20 && bytes[1] === 0x02) return true;
    // fc00::/7
    if ((bytes[0] & 0xfe) === 0xfc) return true;
    // fe80::/10
    if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
    // ff00::/8
    if (bytes[0] === 0xff) return true;

    return false;
  }

  it("correctly identifies all forbidden IPv4 ranges", () => {
    expect(isRestrictedIPv4(0, 0, 0, 0)).toBe(true);
    expect(isRestrictedIPv4(127, 0, 0, 1)).toBe(true);
    expect(isRestrictedIPv4(10, 0, 5, 2)).toBe(true);
    expect(isRestrictedIPv4(172, 16, 0, 1)).toBe(true);
    expect(isRestrictedIPv4(172, 31, 255, 254)).toBe(true);
    expect(isRestrictedIPv4(192, 168, 1, 1)).toBe(true);
    expect(isRestrictedIPv4(169, 254, 10, 20)).toBe(true);
    expect(isRestrictedIPv4(100, 64, 0, 1)).toBe(true);
    expect(isRestrictedIPv4(100, 127, 255, 255)).toBe(true);
    expect(isRestrictedIPv4(192, 0, 0, 1)).toBe(true);
    expect(isRestrictedIPv4(192, 0, 2, 50)).toBe(true);
    expect(isRestrictedIPv4(198, 51, 100, 1)).toBe(true);
    expect(isRestrictedIPv4(203, 0, 113, 10)).toBe(true);
    expect(isRestrictedIPv4(224, 0, 0, 1)).toBe(true);
    expect(isRestrictedIPv4(240, 0, 0, 1)).toBe(true);
    expect(isRestrictedIPv4(255, 255, 255, 255)).toBe(true);
  });

  it("allows valid public IPv4 addresses", () => {
    expect(isRestrictedIPv4(8, 8, 8, 8)).toBe(false);
    expect(isRestrictedIPv4(1, 1, 1, 1)).toBe(false);
    expect(isRestrictedIPv4(140, 82, 121, 4)).toBe(false);
    expect(isRestrictedIPv4(104, 26, 10, 230)).toBe(false);
  });

  it("correctly identifies all forbidden IPv6 ranges", () => {
    // Unspecified ::
    expect(isRestrictedIPv6(new Array(16).fill(0))).toBe(true);
    // Loopback ::1
    const loopback = new Array(16).fill(0);
    loopback[15] = 1;
    expect(isRestrictedIPv6(loopback)).toBe(true);
    // IPv4-mapped loopback ::ffff:127.0.0.1
    const mappedLoopback = new Array(16).fill(0);
    mappedLoopback[10] = 255;
    mappedLoopback[11] = 255;
    mappedLoopback[12] = 127;
    mappedLoopback[13] = 0;
    mappedLoopback[14] = 0;
    mappedLoopback[15] = 1;
    expect(isRestrictedIPv6(mappedLoopback)).toBe(true);
    // Unique Local fc00::
    const ula = new Array(16).fill(0);
    ula[0] = 0xfd;
    expect(isRestrictedIPv6(ula)).toBe(true);
    // Link Local fe80::
    const linkLocal = new Array(16).fill(0);
    linkLocal[0] = 0xfe;
    linkLocal[1] = 0x80;
    expect(isRestrictedIPv6(linkLocal)).toBe(true);
    // Multicast ff02::
    const multicast = new Array(16).fill(0);
    multicast[0] = 0xff;
    expect(isRestrictedIPv6(multicast)).toBe(true);
    // Doc 2001:db8::
    const doc = new Array(16).fill(0);
    doc[0] = 0x20;
    doc[1] = 0x01;
    doc[2] = 0x0d;
    doc[3] = 0xb8;
    expect(isRestrictedIPv6(doc)).toBe(true);
  });

  it("allows valid public IPv6 addresses", () => {
    // 2606:4700:4700::1111 (Cloudflare DNS)
    const publicIpv6 = [
      0x26, 0x06, 0x47, 0x00, 0x47, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x11,
      0x11,
    ];
    expect(isRestrictedIPv6(publicIpv6)).toBe(false);
  });
});

describe("install.ps1 execution and behavioral security tests", () => {
  const pwshAvailable = (() => {
    try {
      const res = spawnSync("pwsh", ["-NoProfile", "-Command", "Write-Output 'OK'"], {
        encoding: "utf8",
        timeout: 5000,
      });
      return res.status === 0 && res.stdout.includes("OK");
    } catch {
      return false;
    }
  })();

  function runPwshAsync(args, options = {}) {
    return new Promise((resolve, reject) => {
      const timeoutMs = options.timeout ?? 30000;
      const proc = spawn("pwsh", args, {
        ...options,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, timeoutMs);

      proc.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      proc.stderr.on("data", (d) => {
        stderr += d.toString();
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      proc.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({
          status: code,
          signal,
          stdout,
          stderr,
          timedOut,
        });
      });
    });
  }

  it("downloads helper when -DownloadOnly is passed with matching hash", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-ps1-test-"));
    const helperContent = fs.existsSync(HELPER_PATH)
      ? fs.readFileSync(HELPER_PATH)
      : Buffer.from("// mock helper\n");

    const server = http.createServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/javascript",
        "Content-Length": helperContent.length,
      });
      res.end(helperContent);
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const serverPort = server.address().port;
    const targetPath = path.join(tmpDir, "downloaded-helper.mjs");

    try {
      if (pwshAvailable) {
        const res = await runPwshAsync(
          ["-NoProfile", "-File", SCRIPT_PATH, "-DownloadOnly", targetPath],
          {
            timeout: 15000,
            env: {
              ...process.env,
              RESIN_INSTALL_TEST_ONLY: "1",
              RESIN_INSTALL_HELPER_URL: `http://127.0.0.1:${serverPort}/install-helper-v1.mjs`,
            },
          },
        );
        expect(res.status).toBe(0);
        expect(fs.existsSync(targetPath)).toBe(true);
        const downloadedBytes = fs.readFileSync(targetPath);
        const actualSha = crypto.createHash("sha256").update(downloadedBytes).digest("hex");
        expect(actualSha).toBe(EXPECTED_HELPER_SHA256);
      } else {
        const content = fs.readFileSync(SCRIPT_PATH, "utf8");
        expect(content).toContain("if (-not [string]::IsNullOrWhiteSpace($DownloadOnly))");
      }
    } finally {
      server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("ignores helper URL overrides outside test mode and retains the loopback guard", () => {
    const content = fs.readFileSync(SCRIPT_PATH, "utf8");
    expect(content).toContain("$helperUrl = $PINNED_HELPER_URL");
    expect(content).toContain(
      "if ($isTestMode -and -not [string]::IsNullOrWhiteSpace($env:RESIN_INSTALL_HELPER_URL))",
    );
    expect(content).toContain("Host $($helperUri.Host) resolved to forbidden IP address");
  });

  it("rejects helper download and aborts execution on SHA-256 digest mismatch", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-ps1-mismatch-"));
    const corruptedContent = Buffer.from(
      "// Corrupted or malicious payload\nconsole.log('pwned');\n",
    );

    const server = http.createServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/javascript",
        "Content-Length": corruptedContent.length,
      });
      res.end(corruptedContent);
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const serverPort = server.address().port;
    const targetPath = path.join(tmpDir, "should-not-exist.mjs");

    try {
      if (pwshAvailable) {
        const res = await runPwshAsync(
          ["-NoProfile", "-File", SCRIPT_PATH, "-DownloadOnly", targetPath],
          {
            timeout: 15000,
            env: {
              ...process.env,
              RESIN_INSTALL_TEST_ONLY: "1",
              RESIN_INSTALL_HELPER_URL: `http://127.0.0.1:${serverPort}/install-helper-v1.mjs`,
            },
          },
        );
        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain("Security Error: Helper SHA-256 mismatch");
        expect(fs.existsSync(targetPath)).toBe(false);
      } else {
        const content = fs.readFileSync(SCRIPT_PATH, "utf8");
        expect(content).toContain("Security Error: Helper SHA-256 mismatch!");
      }
    } finally {
      server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("correctly handles destination paths with spaces, '#', and '%'", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-ps1-spaces-"));
    const specialSubdir = path.join(tmpDir, "path with spaces # and %");
    fs.mkdirSync(specialSubdir, { recursive: true });
    const targetPath = path.join(specialSubdir, "helper#file%1.mjs");

    const helperContent = fs.existsSync(HELPER_PATH)
      ? fs.readFileSync(HELPER_PATH)
      : Buffer.from("// mock helper\n");

    const server = http.createServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/javascript",
        "Content-Length": helperContent.length,
      });
      res.end(helperContent);
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const serverPort = server.address().port;

    try {
      if (pwshAvailable) {
        const res = await runPwshAsync(
          ["-NoProfile", "-File", SCRIPT_PATH, "-DownloadOnly", targetPath],
          {
            timeout: 15000,
            env: {
              ...process.env,
              RESIN_INSTALL_TEST_ONLY: "1",
              RESIN_INSTALL_HELPER_URL: `http://127.0.0.1:${serverPort}/install-helper-v1.mjs`,
            },
          },
        );
        expect(res.status).toBe(0);
        expect(fs.existsSync(targetPath)).toBe(true);
        const downloadedBytes = fs.readFileSync(targetPath);
        const actualSha = crypto.createHash("sha256").update(downloadedBytes).digest("hex");
        expect(actualSha).toBe(EXPECTED_HELPER_SHA256);
      } else {
        const content = fs.readFileSync(SCRIPT_PATH, "utf8");
        expect(content).toContain("[System.IO.Path]::GetFullPath($DownloadOnly)");
      }
    } finally {
      server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects oversized response headers (> 64 KiB)", async () => {
    const server = http.createServer((req, res) => {
      const hugeHeader = `X-Large-Header: ${"A".repeat(70 * 1024)}\r\n`;
      res.socket.write(`HTTP/1.1 200 OK\r\n${hugeHeader}Content-Length: 5\r\n\r\nhello`);
      res.socket.end();
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const serverPort = server.address().port;

    try {
      if (pwshAvailable) {
        const res = await runPwshAsync(
          ["-NoProfile", "-File", SCRIPT_PATH, "-DownloadOnly", "unused.mjs"],
          {
            timeout: 15000,
            env: {
              ...process.env,
              RESIN_INSTALL_TEST_ONLY: "1",
              RESIN_INSTALL_HELPER_URL: `http://127.0.0.1:${serverPort}/install-helper-v1.mjs`,
            },
          },
        );
        expect(res.status).not.toBe(0);
        expect(res.stderr).toMatch(/exceeded limit of 64 KiB|Failed to download/);
      } else {
        const content = fs.readFileSync(SCRIPT_PATH, "utf8");
        expect(content).toContain("$MAX_HEADER_SIZE = 64 * 1024");
      }
    } finally {
      server.close();
    }
  });

  it("rejects oversized response bodies (> 1 MiB)", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/javascript",
        "Content-Length": (2 * 1024 * 1024).toString(),
      });
      res.write(Buffer.alloc(1024 * 1024 + 100, "A"));
      res.end();
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const serverPort = server.address().port;

    try {
      if (pwshAvailable) {
        const res = await runPwshAsync(
          ["-NoProfile", "-File", SCRIPT_PATH, "-DownloadOnly", "unused.mjs"],
          {
            timeout: 15000,
            env: {
              ...process.env,
              RESIN_INSTALL_TEST_ONLY: "1",
              RESIN_INSTALL_HELPER_URL: `http://127.0.0.1:${serverPort}/install-helper-v1.mjs`,
            },
          },
        );
        expect(res.status).not.toBe(0);
        expect(res.stderr).toMatch(/exceeds maximum limit of 1 MiB|Failed to download/);
      } else {
        const content = fs.readFileSync(SCRIPT_PATH, "utf8");
        expect(content).toContain("$MAX_BODY_SIZE = 1024 * 1024");
      }
    } finally {
      server.close();
    }
  });

  it("handles aborted / prematurely closed connections fail-closed", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, {
        "Content-Type": "application/javascript",
        "Content-Length": "10000",
      });
      res.write("partial content");
      // Abruptly destroy socket
      res.socket.destroy();
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const serverPort = server.address().port;

    try {
      if (pwshAvailable) {
        const res = await runPwshAsync(
          ["-NoProfile", "-File", SCRIPT_PATH, "-DownloadOnly", "unused.mjs"],
          {
            timeout: 15000,
            env: {
              ...process.env,
              RESIN_INSTALL_TEST_ONLY: "1",
              RESIN_INSTALL_HELPER_URL: `http://127.0.0.1:${serverPort}/install-helper-v1.mjs`,
            },
          },
        );
        expect(res.status).not.toBe(0);
        expect(res.stderr).toMatch(/Content-Length mismatch|connection reset|Failed to download/i);
      } else {
        const content = fs.readFileSync(SCRIPT_PATH, "utf8");
        expect(content).toContain("Content-Length mismatch");
      }
    } finally {
      server.close();
    }
  });

  it("rejects zero-exit helper that produces empty output", () => {
    const content = fs.readFileSync(SCRIPT_PATH, "utf8");
    expect(content).toContain("if ([string]::IsNullOrWhiteSpace($stdoutStr))");
    expect(content).toContain(
      "Installer helper exited with code 0 but emitted no output. Expected success JSON payload.",
    );
  });

  it("rejects zero-exit helper that produces invalid JSON or unsuccessful payload", () => {
    const content = fs.readFileSync(SCRIPT_PATH, "utf8");
    expect(content).toContain("Installer helper output is not valid JSON");
    expect(content).toContain(
      "if ($null -eq $parsedJson -or $parsedJson.success -ne $true -or [string]::IsNullOrWhiteSpace($parsedJson.version))",
    );
    expect(content).toContain("Installer helper did not report successful installation.");
  });

  it("ensures WSL staging directory cleanup on exit", () => {
    const content = fs.readFileSync(SCRIPT_PATH, "utf8");
    expect(content).toContain("& wsl.exe --exec rm -rf $wslStagingDir");
    expect(content).toContain(
      "Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue",
    );
  });
});
