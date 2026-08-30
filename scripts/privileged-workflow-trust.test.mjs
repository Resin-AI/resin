import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const ROOT_DIR = process.cwd();

const PRIVILEGED_RELEASE_WORKFLOWS = [
  ".github/workflows/release.yml",
  ".github/workflows/release-candidate.yml",
  ".github/workflows/production-operational-evidence.yml",
  ".github/workflows/security-scan.yml",
];

const ALL_PRIVILEGED_WORKFLOWS = [
  ...PRIVILEGED_RELEASE_WORKFLOWS,
  ".github/workflows/cloud-deploy.yml",
  ".github/workflows/web-deploy.yml",
];

function loadWorkflows(fileList) {
  const workflows = {};
  for (const relPath of fileList) {
    const fullPath = path.join(ROOT_DIR, relPath);
    if (fs.existsSync(fullPath)) {
      const raw = fs.readFileSync(fullPath, "utf8");
      workflows[relPath] = {
        raw,
        doc: YAML.parse(raw),
      };
    }
  }
  return workflows;
}

describe("Privileged Workflow Trust & Security Boundaries", () => {
  const allWorkflows = loadWorkflows(ALL_PRIVILEGED_WORKFLOWS);
  const releaseWorkflows = loadWorkflows(PRIVILEGED_RELEASE_WORKFLOWS);
  const isCombinedMonorepo = fs.existsSync(
    path.join(ROOT_DIR, ".github/workflows/cloud-deploy.yml"),
  );

  describe("Trigger Isolation: Protected Refs & Manual Trusted Dispatch Only", () => {
    it("ensures all privileged workflows are loaded and parse as valid YAML documents", () => {
      const expectedList = isCombinedMonorepo
        ? ALL_PRIVILEGED_WORKFLOWS
        : ALL_PRIVILEGED_WORKFLOWS.filter((relPath) => fs.existsSync(path.join(ROOT_DIR, relPath)));
      expect(Object.keys(allWorkflows).length).toBe(expectedList.length);
      for (const [filePath, { doc }] of Object.entries(allWorkflows)) {
        expect(doc, `${filePath} must be valid YAML`).toBeDefined();
        expect(doc.name, `${filePath} must have a name`).toBeDefined();
        expect(doc.jobs, `${filePath} must define jobs`).toBeDefined();
      }
    });

    it("strictly prohibits pull_request and pull_request_target triggers in privileged workflows", () => {
      for (const [filePath, { doc }] of Object.entries(allWorkflows)) {
        const triggers = Object.keys(doc.on || {});
        expect(
          triggers,
          `${filePath} must not trigger on pull_request (untrusted fork execution risk)`,
        ).not.toContain("pull_request");
        expect(
          triggers,
          `${filePath} must not trigger on pull_request_target (untrusted PR privileged execution risk)`,
        ).not.toContain("pull_request_target");
        expect(triggers, `${filePath} must not trigger on issues`).not.toContain("issues");
        expect(triggers, `${filePath} must not trigger on issue_comment`).not.toContain(
          "issue_comment",
        );
      }
    });

    it("restricts push triggers exclusively to protected main branch", () => {
      for (const [filePath, { doc }] of Object.entries(allWorkflows)) {
        if (doc.on?.push) {
          const branches = doc.on.push.branches || [];
          expect(
            branches,
            `${filePath} push trigger must only target protected 'main' branch`,
          ).toEqual(["main"]);
        }
      }
    });

    it("verifies release, candidate, operational evidence, and security scan are strictly manual trusted dispatch", () => {
      const release = releaseWorkflows[".github/workflows/release.yml"];
      const candidate = releaseWorkflows[".github/workflows/release-candidate.yml"];
      const operational = releaseWorkflows[".github/workflows/production-operational-evidence.yml"];
      const securityScan = releaseWorkflows[".github/workflows/security-scan.yml"];

      expect(Object.keys(release.doc.on)).toEqual(["workflow_dispatch"]);
      expect(Object.keys(candidate.doc.on)).toEqual(["workflow_dispatch"]);
      if (operational) {
        expect(Object.keys(operational.doc.on)).toEqual(["workflow_dispatch"]);
      }
      expect(Object.keys(securityScan.doc.on)).toEqual(["workflow_dispatch"]);
    });

    it("keeps the public security scan independent of the private cloud container", () => {
      const securityScan = releaseWorkflows[".github/workflows/security-scan.yml"];

      expect(securityScan.raw).not.toContain("apps/cloud");
      expect(securityScan.raw).not.toContain("trivy");
      expect(securityScan.raw).toContain('source: "pnpm-audit"');
      expect(securityScan.raw).toContain('status: "NOT_APPLICABLE"');
    });

    it("validates workflow_dispatch inputs enforce required fields and descriptive parameters", () => {
      for (const [filePath, { doc }] of Object.entries(releaseWorkflows)) {
        const inputs = doc.on.workflow_dispatch?.inputs || {};
        expect(
          Object.keys(inputs).length,
          `${filePath} must define typed workflow_dispatch inputs`,
        ).toBeGreaterThan(0);

        for (const [inputName, inputSpec] of Object.entries(inputs)) {
          expect(
            inputSpec.description,
            `Input '${inputName}' in ${filePath} must have a description`,
          ).toBeDefined();
          expect(
            inputSpec.type,
            `Input '${inputName}' in ${filePath} must define a type`,
          ).toBeDefined();
        }
      }
    });
  });

  describe("Immutable Action Pins: 40-Character Hex SHAs with Version Comments", () => {
    const shaPattern = /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+@[0-9a-f]{40}$/;

    it("pins all third-party Action references across all privileged workflows to exact 40-hex commit SHAs", () => {
      for (const [filePath, { doc }] of Object.entries(allWorkflows)) {
        const steps = Object.values(doc.jobs || {}).flatMap((job) => job.steps || []);
        const actionRefs = steps.map((s) => s.uses).filter(Boolean);

        expect(actionRefs.length, `${filePath} should use at least one action`).toBeGreaterThan(0);
        for (const actionRef of actionRefs) {
          expect(
            actionRef,
            `Action '${actionRef}' in ${filePath} must be pinned to exact 40-character SHA`,
          ).toMatch(shaPattern);
          expect(
            actionRef,
            `Action '${actionRef}' in ${filePath} must not use mutable tag or branch`,
          ).not.toMatch(/@(v\d+|main|master|latest)$/);
        }
      }
    });

    it("verifies every action reference in raw YAML has a trailing human-readable version comment", () => {
      for (const [filePath, { raw }] of Object.entries(allWorkflows)) {
        const lines = raw.split("\n");
        for (const line of lines) {
          const match = line.match(/^\s*uses:\s*([^\s#]+)(.*)$/);
          if (match) {
            const actionRef = match[1];
            const trailing = match[2];
            expect(
              actionRef,
              `Action '${actionRef}' in ${filePath} must be pinned to 40-hex SHA`,
            ).toMatch(shaPattern);
            expect(
              trailing,
              `Action '${actionRef}' in ${filePath} must include a version comment (e.g. # v4)`,
            ).toMatch(/#\s+v[0-9.]+/);
          }
        }
      }
    });

    it("verifies canonical action SHAs are pinned across release family workflows", () => {
      const canonicalPins = {
        "actions/checkout": "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
        "actions/setup-node": "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
        "pnpm/action-setup": "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1",
        "actions/upload-artifact":
          "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
        "actions/download-artifact":
          "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
        "aws-actions/configure-aws-credentials":
          "aws-actions/configure-aws-credentials@7474bc4690e29a8392af63c5b98e7449536d5c3a",
        "aquasecurity/trivy-action":
          "aquasecurity/trivy-action@a9c7b0f06e461e9d4b4d1711f154ee024b8d7ab8",
      };

      for (const [filePath, { doc }] of Object.entries(releaseWorkflows)) {
        const steps = Object.values(doc.jobs || {}).flatMap((job) => job.steps || []);
        for (const step of steps) {
          if (!step.uses) continue;
          for (const [actionName, expectedFullRef] of Object.entries(canonicalPins)) {
            if (step.uses.startsWith(`${actionName}@`)) {
              expect(
                step.uses,
                `Action '${actionName}' in ${filePath} must match canonical SHA pin`,
              ).toBe(expectedFullRef);
            }
          }
        }
      }
    });
    it("publishes the web image on the private runner's native ARM64 architecture", () => {
      const workflowEntry = allWorkflows[".github/workflows/web-deploy.yml"];
      if (!workflowEntry) {
        expect(fs.existsSync(path.join(ROOT_DIR, "apps/web"))).toBe(false);
        return;
      }
      const workflow = workflowEntry.doc;
      const publishJob = workflow.jobs.publish;
      const imageStep = publishJob.steps.find((step) =>
        step.uses?.startsWith("docker/build-push-action@"),
      );

      expect(workflow.env.IMAGE_NAME).toBe("ghcr.io/resin-ai/resin-cloud-web");
      expect(publishJob["runs-on"]).toBe("resin-vm-linux-arm64");
      expect(imageStep.with.platforms).toBe("linux/arm64");
      expect(
        publishJob.steps.some((step) => step.uses?.startsWith("docker/setup-qemu-action@")),
      ).toBe(false);
      const dockerfile = fs.readFileSync(path.join(ROOT_DIR, "apps/web/Dockerfile"), "utf8");
      for (const requiredInput of [
        "COPY apps/cloud/package.json ./apps/cloud/package.json",
        "COPY packages/cloud-contracts/package.json ./packages/cloud-contracts/package.json",
        "COPY apps/cloud ./apps/cloud",
        "COPY packages/cloud-contracts ./packages/cloud-contracts",
      ]) {
        expect(dockerfile).toContain(requiredInput);
      }
      expect(dockerfile.indexOf("pnpm --filter @resin/cloud build")).toBeLessThan(
        dockerfile.indexOf("pnpm --filter @resin/web build"),
      );
    });
  });

  describe("Least Privilege Permissions", () => {
    it("prohibits blanket write-all permissions in any privileged workflow", () => {
      for (const [filePath, { doc }] of Object.entries(allWorkflows)) {
        expect(doc.permissions, `${filePath} top-level permissions cannot be 'write-all'`).not.toBe(
          "write-all",
        );
        for (const [jobId, job] of Object.entries(doc.jobs || {})) {
          expect(
            job.permissions,
            `${filePath} job '${jobId}' permissions cannot be 'write-all'`,
          ).not.toBe("write-all");
        }
      }
    });

    it("verifies contents permission is strictly read-only across all privileged workflows", () => {
      for (const [filePath, { doc }] of Object.entries(allWorkflows)) {
        if (
          doc.permissions &&
          Object.prototype.toString.call(doc.permissions) === "[object Object]"
        ) {
          if (doc.permissions.contents) {
            expect(
              doc.permissions.contents,
              `${filePath} top-level contents permission must be read`,
            ).toBe("read");
          }
        }
        for (const [jobId, job] of Object.entries(doc.jobs || {})) {
          if (
            job.permissions &&
            Object.prototype.toString.call(job.permissions) === "[object Object]"
          ) {
            if (job.permissions.contents) {
              expect(
                job.permissions.contents,
                `${filePath} job '${jobId}' contents permission must be read`,
              ).toBe("read");
            }
          }
        }
      }
    });

    it("restricts write permissions strictly to approved least privilege scopes", () => {
      const allowedWriteScopes = new Set(["id-token", "actions", "packages"]);

      for (const [filePath, { doc }] of Object.entries(allWorkflows)) {
        const checkPerms = (perms, context) => {
          if (!perms || Object.prototype.toString.call(perms) !== "[object Object]") return;
          for (const [scope, level] of Object.entries(perms)) {
            if (level === "write") {
              expect(
                allowedWriteScopes.has(scope),
                `Write permission for '${scope}' in ${context} (${filePath}) must be an approved least-privilege scope`,
              ).toBe(true);
            }
          }
        };

        checkPerms(doc.permissions, "top-level");
        for (const [jobId, job] of Object.entries(doc.jobs || {})) {
          checkPerms(job.permissions, `job '${jobId}'`);
        }
      }
    });

    it("isolates build-and-sign job with id-token: none to prevent ambient OIDC exchange during signing", () => {
      const candidate = releaseWorkflows[".github/workflows/release-candidate.yml"];
      const buildJob = candidate.doc.jobs["build-and-sign"];
      expect(buildJob).toBeDefined();
      expect(buildJob.permissions?.["id-token"]).toBe("none");
    });
  });

  describe("Credential Confinement: Protected Environments for Signing & Deployment", () => {
    it("confines release candidate signing secrets to production protected environment", () => {
      const candidate = releaseWorkflows[".github/workflows/release-candidate.yml"];
      const buildAndSignJob = candidate.doc.jobs["build-and-sign"];
      expect(buildAndSignJob).toBeDefined();
      expect(buildAndSignJob.environment).toBe("production");

      const verifyJob = candidate.doc.jobs["attest-and-publish-candidate"];
      expect(verifyJob).toBeDefined();
      expect(verifyJob.environment).toBeUndefined();
      expect(JSON.stringify(verifyJob)).not.toMatch(/RESIN_RELEASE_PRIVATE_KEY/);
    });

    it("confines production operational evidence rehearsal secrets to production environment", () => {
      const operational = releaseWorkflows[".github/workflows/production-operational-evidence.yml"];
      if (operational) {
        const rehearseJob = operational.doc.jobs.rehearse;
        expect(rehearseJob).toBeDefined();
        expect(rehearseJob.environment).toBe("production");
      }
    });

    it("confines publication credentials in release.yml to parameterized environment", () => {
      const release = releaseWorkflows[".github/workflows/release.yml"];
      const releaseJob = release.doc.jobs.release;
      expect(releaseJob).toBeDefined();
      expect(releaseJob.environment).toEqual({
        name: "${{ inputs.environment || 'production' }}",
      });
    });

    it("ensures signing private keys are never exposed in unverified jobs", () => {
      for (const [filePath, { doc }] of Object.entries(releaseWorkflows)) {
        for (const [jobId, job] of Object.entries(doc.jobs || {})) {
          const jobStr = JSON.stringify(job);
          if (jobStr.includes("RESIN_RELEASE_PRIVATE_KEY")) {
            expect(
              job.environment,
              `Job '${jobId}' in ${filePath} using signing keys must declare an explicit environment`,
            ).toBeDefined();
          }
        }
      }
    });
    it("confines cloud deployment jobs to staging and production environments", () => {
      const cloudDeploy = allWorkflows[".github/workflows/cloud-deploy.yml"];
      if (isCombinedMonorepo) {
        expect(cloudDeploy).toBeDefined();
      }
      if (cloudDeploy) {
        expect(cloudDeploy.doc.jobs["deploy-staging"]?.environment?.name).toBe("staging");
        expect(cloudDeploy.doc.jobs["deploy-production"]?.environment?.name).toBe("production");
      }
    });
  });

  describe("Checkout Hygiene: Persist-Credentials False", () => {
    it("enforces persist-credentials: false on all actions/checkout steps in release workflows", () => {
      for (const [filePath, { doc }] of Object.entries(releaseWorkflows)) {
        const steps = Object.values(doc.jobs || {}).flatMap((job) => job.steps || []);
        for (const step of steps) {
          if (step.uses && step.uses.startsWith("actions/checkout@")) {
            expect(
              step.with?.["persist-credentials"],
              `Checkout step '${step.name || "unnamed"}' in ${filePath} must have persist-credentials: false`,
            ).toBe(false);
          }
        }
      }
    });
  });

  describe("Script Injection Resistance & Input Hardening", () => {
    it("verifies commit_sha inputs are validated against exact 40-hex pattern in verification steps", () => {
      const candidate = releaseWorkflows[".github/workflows/release-candidate.yml"];
      const operational = releaseWorkflows[".github/workflows/production-operational-evidence.yml"];
      const securityScan = releaseWorkflows[".github/workflows/security-scan.yml"];

      expect(candidate.raw).toMatch(
        /\[\[\s*!\s*"\$RELEASE_SHA"\s*=~\s*\^\[0-9a-f\]\{40\}\$\s*\]\]/,
      );
      if (operational) {
        expect(operational.raw).toMatch(/\[\[\s*"\$TARGET_SHA"\s*=~\s*\^\[0-9a-f\]\{40\}\$\s*\]\]/);
      }
      expect(securityScan.raw).toMatch(/\[\[\s*"\$TARGET_SHA"\s*=~\s*\^\[0-9a-f\]\{40\}\$\s*\]\]/);
    });

    it("prohibits raw inputs interpolation inside multiline shell scripts in release workflows", () => {
      for (const [filePath, { doc }] of Object.entries(releaseWorkflows)) {
        const steps = Object.values(doc.jobs || {}).flatMap((job) => job.steps || []);
        for (const step of steps) {
          if (step.run && step.run.includes("\n")) {
            const matches = step.run.match(/\$\{\{\s*inputs\.[a-zA-Z0-9_]+\s*\}\}/g);
            expect(
              matches,
              `Multiline run script in step '${step.name}' (${filePath}) should pass inputs via env instead of inline interpolation: ${matches?.join(", ")}`,
            ).toBeNull();
          }
        }
      }
    });
  });

  describe("Negative Regression Checks: Security Rules Catch Vulnerabilities", () => {
    it("rejects mutable action tags or branch names when evaluated against the sha pattern", () => {
      const shaPattern = /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+@[0-9a-f]{40}$/;
      const badActions = [
        "actions/checkout@v4",
        "actions/setup-node@main",
        "pnpm/action-setup@v3",
        "aws-actions/configure-aws-credentials@master",
        "actions/upload-artifact@latest",
      ];
      for (const badAction of badActions) {
        expect(badAction).not.toMatch(shaPattern);
      }
    });

    it("detects and flags untrusted triggers if introduced into workflow documents", () => {
      const isTriggerSafe = (onConfig) => {
        const triggers = Object.keys(onConfig || {});
        const forbidden = ["pull_request", "pull_request_target", "issues", "issue_comment"];
        return !triggers.some((t) => forbidden.includes(t));
      };

      expect(isTriggerSafe({ pull_request: {} })).toBe(false);
      expect(isTriggerSafe({ pull_request_target: {} })).toBe(false);
      expect(isTriggerSafe({ issue_comment: {} })).toBe(false);
      expect(isTriggerSafe({ workflow_dispatch: {} })).toBe(true);
      expect(isTriggerSafe({ push: { branches: ["main"] } })).toBe(true);
    });

    it("detects missing persist-credentials: false on checkout steps", () => {
      const isCheckoutSafe = (step) => {
        if (!step.uses?.startsWith("actions/checkout@")) return true;
        return step.with?.["persist-credentials"] === false;
      };

      expect(
        isCheckoutSafe({ uses: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262" }),
      ).toBe(false);
      expect(
        isCheckoutSafe({
          uses: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
          with: { "persist-credentials": true },
        }),
      ).toBe(false);
      expect(
        isCheckoutSafe({
          uses: "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
          with: { "persist-credentials": false },
        }),
      ).toBe(true);
    });

    it("detects signing or deployment secrets referenced without an environment boundary", () => {
      const isJobCredentialSafe = (job) => {
        const jobStr = JSON.stringify(job);
        const hasSensitiveSecret =
          jobStr.includes("RESIN_RELEASE_PRIVATE_KEY") || jobStr.includes("AWS_DEPLOY_ROLE_ARN");
        if (hasSensitiveSecret) {
          return job.environment !== undefined;
        }
        return true;
      };

      const unsafeJob = {
        steps: [
          {
            run: "echo $RESIN_RELEASE_PRIVATE_KEY_PEM",
            env: { RESIN_RELEASE_PRIVATE_KEY_PEM: "${{ secrets.RESIN_RELEASE_PRIVATE_KEY_PEM }}" },
          },
        ],
      };
      const safeJob = {
        environment: "production",
        steps: [
          {
            run: "echo $RESIN_RELEASE_PRIVATE_KEY_PEM",
            env: { RESIN_RELEASE_PRIVATE_KEY_PEM: "${{ secrets.RESIN_RELEASE_PRIVATE_KEY_PEM }}" },
          },
        ],
      };

      expect(isJobCredentialSafe(unsafeJob)).toBe(false);
      expect(isJobCredentialSafe(safeJob)).toBe(true);
    });
  });
});
