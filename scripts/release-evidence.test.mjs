import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PARENT_EPIC_ID,
  RELEASE_VERSION,
  V1_MILESTONES_SPEC,
  fileSha256,
  formatReleaseEvidenceMarkdown,
  generateReleaseEvidence,
  resolveReleaseMilestones,
  writeReleaseEvidence,
} from "./generate-release-evidence.mjs";
import { verifyReleaseEvidence } from "./verify-release.mjs";

describe("Release Evidence & Publication Suite (REM-020)", () => {
  const rootDir = process.cwd();
  const releaseMilestones = resolveReleaseMilestones(rootDir);
  let tempReleaseDir;

  beforeAll(() => {
    tempReleaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-release-evidence-"));
  });

  afterAll(async () => {
    try {
      await fs.promises.rm(tempReleaseDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it.each([
    ["", "1.0.3"],
    ["v1.0.49", "1.0.49"],
    ["v1.2.0-rc.1", "1.2.0-rc.1"],
    ["1.0.49", "1.0.49"],
  ])("uses selected release tag %j consistently with packaging", (releaseTag, version) => {
    // A fresh process exercises import-time environment selection, not cached test modules.
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
          import { generateReleaseEvidence, formatReleaseEvidenceMarkdown } from "./scripts/generate-release-evidence.mjs";
          import { RELEASE_VERSION } from "./scripts/package-release.mjs";
          const evidence = generateReleaseEvidence({ testOnly: true });
          console.log(JSON.stringify({
            release: evidence.release,
            packageVersion: RELEASE_VERSION,
            markdown: formatReleaseEvidenceMarkdown(evidence),
          }));
        `,
      ],
      { cwd: rootDir, env: { ...process.env, RELEASE_TAG: releaseTag }, encoding: "utf8" },
    );
    const result = JSON.parse(output);
    expect(result.release).toBe(version);
    expect(result.packageVersion).toBe(version);
    expect(result.markdown).toContain(`**Release Version**: \`v${version}\``);
  });

  describe("1. Authoritative Milestones Traceability Matrix (Parent #22 & REM-001 to REM-020)", () => {
    it("defines exactly 21 milestone entries (Parent Epic #22 and REM-001 through REM-020)", () => {
      expect(V1_MILESTONES_SPEC).toHaveLength(21);
      expect(PARENT_EPIC_ID).toBe("#22");

      const epic = V1_MILESTONES_SPEC.find((m) => m.id === "#22");
      expect(epic).toBeDefined();
      expect(epic?.issue).toBe("#22");
      expect(epic?.category).toBe("epic");

      for (let i = 1; i <= 20; i++) {
        const remId = `REM-${String(i).padStart(3, "0")}`;
        const found = V1_MILESTONES_SPEC.find((m) => m.id === remId);
        expect(found).toBeDefined();
        expect(found?.remId).toBe(remId);
        expect(found?.issue).toBe("#22");
      }
    });

    it("verifies all repository-scoped artifact and suite paths exist on disk", () => {
      for (const milestone of releaseMilestones) {
        expect(milestone.artifacts.length).toBeGreaterThan(0);
        expect(milestone.suites.length).toBeGreaterThan(0);

        for (const artifact of milestone.artifacts) {
          expect(fs.existsSync(path.resolve(rootDir, artifact))).toBe(true);
        }

        for (const suite of milestone.suites) {
          expect(fs.existsSync(path.resolve(rootDir, suite))).toBe(true);
        }
      }
    });
    it("generates evidence where all repository-scoped milestones are verified", () => {
      const evidence = generateReleaseEvidence({ rootDir, testOnly: true });

      expect(evidence.schemaVersion).toBe("2.0.0");
      expect(evidence.release).toBe(RELEASE_VERSION);
      expect(evidence.status).toBe("TEST_ONLY");
      expect(evidence.summary.totalMilestones).toBe(releaseMilestones.length);
      expect(evidence.summary.verifiedMilestones).toBe(releaseMilestones.length);
      expect(evidence.milestones).toHaveLength(releaseMilestones.length);

      for (const m of evidence.milestones) {
        expect(m.status).toBe("TEST_ONLY");
        expect(m.artifacts.length).toBeGreaterThan(0);
        expect(m.verificationSuites.length).toBeGreaterThan(0);

        for (const artifact of m.artifacts) {
          expect(artifact.exists).toBe(true);
          expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);

          const fullPath = path.resolve(rootDir, artifact.path);
          expect(fs.existsSync(fullPath)).toBe(true);
          expect(fileSha256(fullPath)).toBe(artifact.sha256);
        }

        for (const suite of m.verificationSuites) {
          expect(suite.exists).toBe(true);
          expect(suite.sha256).toMatch(/^[0-9a-f]{64}$/);
          expect(suite.status).toBe("TEST_ONLY");

          const fullPath = path.resolve(rootDir, suite.path);
          expect(fs.existsSync(fullPath)).toBe(true);
          expect(fileSha256(fullPath)).toBe(suite.sha256);
        }
      }
    });
  });

  describe("2. Qualification Coverage (Platforms, Harnesses, Cloud Staging & Security)", () => {
    it("includes all 7 required platform qualification lanes", () => {
      const evidence = generateReleaseEvidence({ rootDir, testOnly: true });
      const platforms = evidence.qualification.platforms;

      expect(platforms.totalLanes).toBe(7);
      expect(platforms.passedLanes).toBe(0);

      const laneIds = platforms.lanes.map((l) => l.id);
      expect(laneIds).toEqual([]);

      for (const lane of platforms.lanes) {
        expect(lane.status).toBe("QUALIFIED");
        expect(lane.evidence).toBe("scripts/platform-qualification.test.mjs");
      }
    });

    it("includes all 3 supported AI harnesses (Claude Code, Codex CLI, OMP)", () => {
      const evidence = generateReleaseEvidence({ rootDir, testOnly: true });
      const harnesses = evidence.qualification.harnesses;

      expect(harnesses.totalHarnesses).toBe(3);
      expect(harnesses.qualifiedHarnesses).toBe(0);

      const harnessNames = harnesses.harnesses.map((h) => h.name);
      expect(harnessNames).toEqual([]);

      for (const h of harnesses.harnesses) {
        expect(h.status).toBe("QUALIFIED");
        expect(h.evidence).toMatch(/^adapters\/.*\/tests\/qualification\.test\.ts$/);
      }
    });

    it("includes clean-checkout full-system qualification evidence", () => {
      const evidence = generateReleaseEvidence({ rootDir, testOnly: true });
      const system = evidence.qualification.system;

      expect(system.status).toBe("TEST_ONLY");
      expect(system.suites).toEqual([]);
    });

    it("records security and boundary audit status with zero violations", () => {
      const evidence = generateReleaseEvidence({ rootDir, testOnly: true });
      const sec = evidence.qualification.securityAudit;

      expect(sec.status).toBe("TEST_ONLY");
    });
  });

  describe("3. Evidence File Writing and Formatting", () => {
    it("formats markdown document with complete traceability table", () => {
      const evidence = generateReleaseEvidence({ rootDir, testOnly: true });
      const md = formatReleaseEvidenceMarkdown(evidence);

      expect(md).toContain("# Comprehensive Release Evidence Trace (REM-001 through REM-020)");
      expect(md).toContain(`v${RELEASE_VERSION}`);
      expect(md).toContain("REM-001");
      expect(md).toContain("REM-020");
      expect(md).toContain("#22");
    });

    it("writes release-evidence.json and RELEASE-EVIDENCE.md to dist directory", () => {
      const out = writeReleaseEvidence({
        rootDir,
        distDir: tempReleaseDir,
        testOnly: true,
      });

      expect(fs.existsSync(out.jsonPath)).toBe(true);
      expect(fs.existsSync(out.markdownPath)).toBe(true);

      const parsed = JSON.parse(fs.readFileSync(out.jsonPath, "utf8"));
      expect(parsed.schemaVersion).toBe("2.0.0");
      expect(parsed.release).toBe(RELEASE_VERSION);
      expect(parsed.parentEpic).toBe("#22");
      expect(parsed.summary.totalMilestones).toBe(releaseMilestones.length);
      expect(parsed.summary.verifiedMilestones).toBe(releaseMilestones.length);

      const mdContent = fs.readFileSync(out.markdownPath, "utf8");
      expect(mdContent).toContain("# Comprehensive Release Evidence Trace");
      expect(mdContent).toContain("#22");
    });
  });

  describe("4. Runtime Input Validation & Provenance Integrity", () => {
    it("rejects invalid, all-zero, or placeholder commit SHAs", () => {
      expect(() => {
        generateReleaseEvidence({
          rootDir,
          testOnly: true,
          commitSha: "0000000000000000000000000000000000000000",
        });
      }).toThrow(/full 40-character non-zero/);

      expect(() => {
        generateReleaseEvidence({
          rootDir,
          testOnly: true,
          commitSha: "not-a-valid-sha",
        });
      }).toThrow(/full 40-character non-zero/);

      expect(() => {
        generateReleaseEvidence({
          rootDir,
          testOnly: true,
          commitSha: "1234567890abcdef1234567890abcdef12345678",
          releaseIdentity: {
            commitSha: "abcdef1234567890abcdef1234567890abcdef12",
          },
        });
      }).toThrow(/does not match/);
    });

    it("validates release date and accepts dynamic ISO timestamps", () => {
      expect(() => {
        generateReleaseEvidence({
          rootDir,
          testOnly: true,
          releaseDate: "invalid-date-string",
        });
      }).toThrow(/valid ISO-8601 string/);

      const customDate = "2026-08-25T12:34:56.789Z";
      const evidence = generateReleaseEvidence({
        rootDir,
        testOnly: true,
        releaseDate: customDate,
      });
      expect(evidence.releaseDate).toBe(customDate);
    });

    it("requires CI qualification evidence in production mode", () => {
      expect(() => {
        generateReleaseEvidence({
          rootDir,
          testOnly: false,
        });
      }).toThrow(/Production release evidence requires machine-readable CI qualification evidence/);
    });

    it("links the generated evidence to docs that exist at the released commit", () => {
      const evidence = generateReleaseEvidence({ rootDir, testOnly: true });
      const markdown = formatReleaseEvidenceMarkdown(evidence);
      const prefix = `https://github.com/Resin-AI/resin/blob/${evidence.commitSha}/`;
      const related = markdown.slice(markdown.indexOf("## Related Documentation"));
      const targets = [...related.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);

      expect(targets.length).toBeGreaterThan(0);
      for (const target of targets) {
        expect(target.startsWith(prefix)).toBe(true);
        expect(fs.existsSync(path.resolve(rootDir, target.slice(prefix.length)))).toBe(true);
      }
    });
  });

  describe("5. End-to-End Publication & Verification Pipeline", () => {
    it("detects missing evidence files and incomplete milestones", () => {
      const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "broken-release-evidence-"));

      try {
        const missingRes = verifyReleaseEvidence(brokenDir);
        expect(missingRes.some((v) => v.rule === "MISSING_EVIDENCE_JSON")).toBe(true);

        const badEvidence = {
          release: "0.9.0",
          status: "INCOMPLETE",
          milestones: [
            {
              id: "REM-001",
              status: "FAILED",
              artifacts: [],
              verificationSuites: [],
            },
          ],
        };
        fs.writeFileSync(
          path.join(brokenDir, "release-evidence.json"),
          JSON.stringify(badEvidence),
        );
        fs.writeFileSync(path.join(brokenDir, "RELEASE-EVIDENCE.md"), "# Incomplete");

        const violations = verifyReleaseEvidence(brokenDir);
        expect(violations.some((v) => v.rule === "INVALID_EVIDENCE_VERSION")).toBe(true);
        expect(violations.some((v) => v.rule === "EVIDENCE_NOT_VERIFIED")).toBe(true);
        expect(violations.some((v) => v.rule === "INCOMPLETE_EVIDENCE_MD")).toBe(true);
      } finally {
        fs.rmSync(brokenDir, { recursive: true, force: true });
      }
    });
  });
});
