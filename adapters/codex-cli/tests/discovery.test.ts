import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CODEX_DISPLAY_NAME,
  CODEX_HARNESS_ID,
  CODEX_MIN_SUPPORTED_VERSION,
  compareSemver,
  extractSemver,
  findCodexExecutable,
  getCandidateBinaryNames,
  probeCodexInstallation,
  probeCodexVersion,
  resolveCodexPaths,
} from "../src/discovery.js";

describe("Codex CLI Discovery & Version Probing", () => {
  describe("SemVer extraction and comparison", () => {
    it("extracts semver from various output strings", () => {
      expect(extractSemver("codex 0.45.1")).toBe("0.45.1");
      expect(extractSemver("codex-cli v1.2.3")).toBe("1.2.3");
      expect(extractSemver("codex version 2.0.0-alpha.1")).toBe("2.0.0-alpha.1");
      expect(extractSemver("v0.1.0")).toBe("0.1.0");
      expect(extractSemver("OpenAI Codex CLI (version 1.0.4)")).toBe("1.0.4");
      expect(extractSemver("No version found here")).toBeNull();
    });

    it("compares semver strings correctly", () => {
      expect(compareSemver("1.0.0", "0.9.0")).toBe(1);
      expect(compareSemver("0.1.0", "0.1.0")).toBe(0);
      expect(compareSemver("0.0.9", "0.1.0")).toBe(-1);
      expect(compareSemver("1.2.3", "1.2.4")).toBe(-1);
      expect(compareSemver("2.0.0", "1.99.99")).toBe(1);
    });
  });

  describe("Candidate binary discovery", () => {
    it("returns platform-specific binary names", () => {
      const posix = getCandidateBinaryNames("linux");
      expect(posix).toContain("codex");
      expect(posix).toContain("codex-cli");

      const win = getCandidateBinaryNames("win32");
      expect(win).toContain("codex.exe");
      expect(win).toContain("codex.cmd");
      expect(win).toContain("codex-cli.exe");
    });

    it("finds executable via custom path", async () => {
      // Test when custom executable exists
      const thisFile = path.resolve("package.json");
      const found = await findCodexExecutable({
        customExecutablePath: thisFile,
      });
      expect(found).toBe(thisFile);

      // Non-existent custom path
      const missing = await findCodexExecutable({
        customExecutablePath: "/non/existent/codex-bin",
      });
      expect(missing).toBeNull();
    });

    it("finds executable via mock path lookup", async () => {
      const mockLookup = async (bin: string) => {
        if (bin === "codex") return "/usr/local/bin/codex";
        return null;
      };

      const found = await findCodexExecutable({
        pathLookup: mockLookup,
      });
      expect(found).toBe(path.resolve("/usr/local/bin/codex"));
    });
  });

  describe("Version probing", () => {
    it("probes version successfully with mock executor", async () => {
      const mockExecutor = async (file: string, args: string[]) => {
        if (args.includes("--version")) {
          return { stdout: "codex-cli 0.45.0\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "unknown flag", exitCode: 1 };
      };

      const { version } = await probeCodexVersion("/bin/codex", mockExecutor);
      expect(version).toBe("0.45.0");
    });

    it("falls back to -V or version command", async () => {
      const mockExecutor = async (file: string, args: string[]) => {
        if (args.includes("-V")) {
          return { stdout: "codex 1.0.0\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 1 };
      };

      const { version } = await probeCodexVersion("/bin/codex", mockExecutor);
      expect(version).toBe("1.0.0");
    });

    it("returns null version when command fails completely", async () => {
      const mockExecutor = async () => ({
        stdout: "",
        stderr: "Command failed",
        exitCode: 127,
      });

      const { version } = await probeCodexVersion("/bin/codex", mockExecutor);
      expect(version).toBeNull();
    });
  });

  describe("Path resolution", () => {
    it("resolves default paths based on home directory", async () => {
      const paths = await resolveCodexPaths({
        homeDir: "/home/testuser/.codex",
        env: {},
      });

      expect(paths.homeDir).toBe("/home/testuser/.codex");
      expect(paths.configPath).toBe(path.resolve("/home/testuser/.codex/config.toml"));
      expect(paths.sessionRoot).toBe(path.resolve("/home/testuser/.codex/sessions"));
      expect(paths.configFormat).toBe("toml");
    });

    it("respects custom environment variables", async () => {
      const paths = await resolveCodexPaths({
        env: {
          CODEX_HOME: "/custom/codex",
          CODEX_CONFIG_PATH: "/custom/codex/my-config.json",
          CODEX_SESSIONS_DIR: "/custom/codex/my-sessions",
        },
      });

      expect(paths.homeDir).toBe("/custom/codex");
      expect(paths.configPath).toBe(path.resolve("/custom/codex/my-config.json"));
      expect(paths.sessionRoot).toBe(path.resolve("/custom/codex/my-sessions"));
      expect(paths.configFormat).toBe("json");
    });
  });

  describe("Installation probing statuses", () => {
    it("returns missing_executable when binary is not found", async () => {
      const result = await probeCodexInstallation({
        pathLookup: async () => null,
      });

      expect(result.harnessId).toBe(CODEX_HARNESS_ID);
      expect(result.displayName).toBe(CODEX_DISPLAY_NAME);
      expect(result.status).toBe("missing_executable");
      expect(result.isInstalled).toBe(false);
      // SAFETY: HarnessInstallation metadata.diagnostics contains AdapterDiagnostic items.
      const diagnostics = result.metadata.diagnostics as Array<{ code: string }>;
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.code).toBe("MISSING_EXECUTABLE");
    });

    it("returns corrupt when binary output has no valid version", async () => {
      const result = await probeCodexInstallation({
        pathLookup: async () => "/usr/bin/codex",
        executor: async () => ({ stdout: "Unexpected binary output", stderr: "", exitCode: 0 }),
      });

      expect(result.status).toBe("corrupt");
      expect(result.isInstalled).toBe(true);
      // SAFETY: HarnessInstallation metadata.diagnostics contains AdapterDiagnostic items.
      const diagnostics = result.metadata.diagnostics as Array<{ code: string }>;
      expect(diagnostics[0]?.code).toBe("VERSION_PROBE_FAILED");
    });

    it("returns unsupported_version when version is below minimum", async () => {
      const result = await probeCodexInstallation({
        pathLookup: async () => "/usr/bin/codex",
        executor: async () => ({ stdout: "codex 0.0.5", stderr: "", exitCode: 0 }),
        minSupportedVersion: CODEX_MIN_SUPPORTED_VERSION,
      });

      expect(result.status).toBe("unsupported_version");
      expect(result.version).toBe("0.0.5");
      // SAFETY: HarnessInstallation metadata.diagnostics contains AdapterDiagnostic items.
      const diagnostics = result.metadata.diagnostics as Array<{ code: string }>;
      expect(diagnostics[0]?.code).toBe("UNSUPPORTED_VERSION");
    });

    it("returns ready when binary is found and version is supported", async () => {
      const result = await probeCodexInstallation({
        pathLookup: async () => "/usr/bin/codex",
        executor: async () => ({ stdout: "codex 0.50.0", stderr: "", exitCode: 0 }),
      });

      expect(result.status).toBe("ready");
      expect(result.version).toBe("0.50.0");
      expect(result.executablePath).toBe(path.resolve("/usr/bin/codex"));
      // SAFETY: HarnessInstallation metadata.diagnostics contains AdapterDiagnostic items.
      const diagnostics = result.metadata.diagnostics as Array<{ code: string }>;
      expect(diagnostics).toHaveLength(0);
    });
  });
});
