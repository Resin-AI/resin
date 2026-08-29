import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const ROOT_DIR = process.cwd();
const CANDIDATE_WORKFLOW_PATH = path.join(
  ROOT_DIR,
  ".github",
  "workflows",
  "release-candidate.yml",
);
const PRODUCTION_WORKFLOW_PATH = path.join(ROOT_DIR, ".github", "workflows", "release.yml");
const CI_WORKFLOW_PATH = path.join(ROOT_DIR, ".github", "workflows", "ci.yml");
const PLATFORM_QUALIFICATION_WORKFLOW_PATH = path.join(
  ROOT_DIR,
  ".github",
  "workflows",
  "platform-qualification.yml",
);
const SYSTEM_QUALIFICATION_WORKFLOW_PATH = path.join(
  ROOT_DIR,
  ".github",
  "workflows",
  "system-qualification.yml",
);
const PACKAGE_JSON_PATH = path.join(ROOT_DIR, "package.json");

function loadWorkflow(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const content = fs.readFileSync(filePath, "utf8");
  return {
    raw: content,
    doc: YAML.parse(content),
  };
}

describe("Public Release Workflows Contract", () => {
  const candidate = loadWorkflow(CANDIDATE_WORKFLOW_PATH);
  const production = loadWorkflow(PRODUCTION_WORKFLOW_PATH);
  const ci = loadWorkflow(CI_WORKFLOW_PATH);
  const platformQualification = loadWorkflow(PLATFORM_QUALIFICATION_WORKFLOW_PATH);
  const systemQualification = loadWorkflow(SYSTEM_QUALIFICATION_WORKFLOW_PATH);
  describe("YAML Structure & Runner Compliance", () => {
    it("parses release-candidate.yml as valid YAML document", () => {
      expect(candidate.doc).toBeDefined();
      expect(candidate.doc.name).toBe("Release Candidate");
      expect(candidate.doc.jobs).toBeDefined();
    });

    it("parses release.yml as valid YAML document", () => {
      expect(production.doc).toBeDefined();
      expect(production.doc.name).toBe("Production Release");
      expect(production.doc.jobs).toBeDefined();
    });

    it("requires the ARM64 self-hosted runner for every candidate job", () => {
      for (const [jobId, job] of Object.entries(candidate.doc.jobs)) {
        expect(job["runs-on"], `Job ${jobId} must run on resin-vm-linux-arm64`).toBe(
          "resin-vm-linux-arm64",
        );
      }
    });

    it("requires the ARM64 self-hosted runner for every production job", () => {
      for (const [jobId, job] of Object.entries(production.doc.jobs)) {
        expect(job["runs-on"], `Job ${jobId} must run on resin-vm-linux-arm64`).toBe(
          "resin-vm-linux-arm64",
        );
      }
    });

    it("pins all workflow actions to exact 40-hex commit SHAs with major-version comments", () => {
      const shaPattern = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+@[0-9a-f]{40}$/;
      const candidateSteps = Object.values(candidate.doc.jobs).flatMap((j) => j.steps ?? []);
      const productionSteps = Object.values(production.doc.jobs).flatMap((j) => j.steps ?? []);
      const allUses = [...candidateSteps, ...productionSteps].map((s) => s.uses).filter(Boolean);

      expect(allUses.length).toBeGreaterThan(0);
      for (const actionRef of allUses) {
        expect(actionRef, `Action reference '${actionRef}' must be pinned to a 40-hex SHA`).toMatch(
          shaPattern,
        );
        expect(actionRef).not.toMatch(/@(v\d+|main|master|latest)$/);
      }
    });

    it("pins exact resolved official action commits", () => {
      const candidateSteps = Object.values(candidate.doc.jobs).flatMap((j) => j.steps ?? []);
      const productionSteps = Object.values(production.doc.jobs).flatMap((j) => j.steps ?? []);

      const getUse = (steps, prefix) => steps.find((s) => s.uses?.startsWith(prefix))?.uses;

      expect(getUse(productionSteps, "aws-actions/configure-aws-credentials")).toBe(
        "aws-actions/configure-aws-credentials@7474bc4690e29a8392af63c5b98e7449536d5c3a",
      );
      expect(getUse(candidateSteps, "actions/checkout")).toBe(
        "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
      );
      expect(getUse(candidateSteps, "actions/setup-node")).toBe(
        "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
      );
      expect(getUse(candidateSteps, "pnpm/action-setup")).toBe(
        "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1",
      );
      expect(getUse(candidateSteps, "actions/upload-artifact")).toBe(
        "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
      );
      expect(getUse(candidateSteps, "actions/download-artifact")).toBe(
        "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
      );
    });

    it("verifies human-readable version comments accompany pinned actions in workflow YAML", () => {
      expect(production.raw).toMatch(
        /uses:\s+aws-actions\/configure-aws-credentials@7474bc4690e29a8392af63c5b98e7449536d5c3a\s+#\s+v4/,
      );
      expect(candidate.raw).toMatch(
        /uses:\s+actions\/checkout@11d5960a326750d5838078e36cf38b85af677262\s+#\s+v4/,
      );
      expect(candidate.raw).toMatch(
        /uses:\s+actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020\s+#\s+v4/,
      );
      expect(candidate.raw).toMatch(
        /uses:\s+pnpm\/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1\s+#\s+v4/,
      );
      expect(candidate.raw).toMatch(
        /uses:\s+actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\s+#\s+v4/,
      );
      expect(candidate.raw).toMatch(
        /uses:\s+actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093\s+#\s+v4/,
      );
    });
  });

  describe("Release Candidate Workflow: Security Boundaries & Upstream Qualification", () => {
    const jobs = candidate.doc.jobs;
    const inputs = candidate.doc.on?.workflow_dispatch?.inputs;

    it("defines workflow_dispatch trigger with required commit_sha and all five upstream run IDs", () => {
      expect(inputs).toBeDefined();
      expect(inputs.commit_sha?.required).toBe(true);
      expect(inputs.release_tag?.default).toBe("v1.0.3");
      expect(inputs.ci_run_id?.required).toBe(true);
      expect(inputs.platform_qualification_run_id?.required).toBe(true);
      expect(inputs.system_qualification_run_id?.required).toBe(true);
      expect(inputs.security_scan_run_id?.required).toBe(true);
      expect(inputs.operational_evidence_run_id?.required).toBe(true);
      expect(
        inputs.allow_uncommitted_worktree,
        "allow_uncommitted_worktree must be removed",
      ).toBeUndefined();
    });

    it("enforces per-commit concurrency group with cancel-in-progress false", () => {
      expect(candidate.doc.concurrency?.group).toContain("${{ inputs.commit_sha }}");
      expect(candidate.doc.concurrency?.["cancel-in-progress"]).toBe(false);
    });

    it("exports public release key vars at job level and keeps private key step-scoped", () => {
      const buildJob = jobs["build-and-sign"];
      expect(buildJob.env?.RESIN_RELEASE_KEY_ID).toContain("vars.RESIN_RELEASE_KEY_ID");
      expect(buildJob.env?.RESIN_RELEASE_PUBLIC_KEY_PEM).toContain(
        "vars.RESIN_RELEASE_PUBLIC_KEY_PEM",
      );
      expect(
        buildJob.env?.RESIN_RELEASE_PRIVATE_KEY_PEM,
        "Private key must not be exposed in job-level env",
      ).toBeUndefined();

      const packageStep = buildJob.steps.find((s) =>
        s.name?.includes("Package exact production-signed release"),
      );
      expect(packageStep).toBeDefined();
      expect(packageStep.env?.RESIN_RELEASE_PRIVATE_KEY_PEM).toContain(
        "secrets.RESIN_RELEASE_PRIVATE_KEY_PEM",
      );
    });

    it("isolates build/sign job in production environment with explicit id-token: none", () => {
      const buildJob = jobs["build-and-sign"];
      expect(buildJob, "build-and-sign job must exist").toBeDefined();
      expect(buildJob.environment).toBe("production");
      expect(
        buildJob.permissions?.["id-token"],
        "build-and-sign must have id-token: none to prevent AWS OIDC",
      ).toBe("none");
      expect(buildJob.permissions?.contents).toBe("read");
      expect(buildJob.permissions?.actions).toBe("read");
    });

    it("retains verified candidates and deletes temporary unsigned candidates", () => {
      const verifyJob = jobs["attest-and-publish-candidate"];
      expect(verifyJob, "candidate verification job must exist").toBeDefined();
      expect(verifyJob.needs).toContain("build-and-sign");
      expect(
        verifyJob.environment,
        "candidate verification job must NOT have production environment",
      ).toBeUndefined();
      expect(verifyJob.permissions?.contents).toBe("read");
      expect(verifyJob.permissions?.["id-token"]).toBeUndefined();
      expect(verifyJob.permissions?.attestations).toBeUndefined();

      const uploadStep = verifyJob.steps.find((s) => s.uses?.startsWith("actions/upload-artifact"));
      expect(uploadStep).toBeDefined();
      expect(uploadStep.with?.["retention-days"]).toBe(30);

      const intermediateUpload = jobs["build-and-sign"].steps.find((s) =>
        s.uses?.startsWith("actions/upload-artifact"),
      );
      expect(intermediateUpload?.id).toBe("upload-unsigned");
      expect(intermediateUpload?.with?.["retention-days"]).toBe(1);
      expect(jobs["build-and-sign"].outputs.unsigned_artifact_id).toBe(
        "${{ steps.upload-unsigned.outputs.artifact-id }}",
      );

      const cleanupJob = jobs["delete-unsigned-candidate"];
      expect(cleanupJob.needs).toEqual(["build-and-sign", "attest-and-publish-candidate"]);
      expect(cleanupJob.permissions).toEqual({ actions: "write", contents: "read" });
      expect(cleanupJob.env.ARTIFACT_ID).toBe(
        "${{ needs.build-and-sign.outputs.unsigned_artifact_id }}",
      );
      expect(cleanupJob.steps[0].run).toContain(
        'gh api --method DELETE "repos/$GITHUB_REPOSITORY/actions/artifacts/$ARTIFACT_ID"',
      );
    });

    it("checks out exact SHA with fetch-depth 0", () => {
      const steps = jobs["build-and-sign"].steps;
      const checkoutStep = steps.find((s) => s.uses?.startsWith("actions/checkout"));
      expect(checkoutStep).toBeDefined();
      expect(checkoutStep.with?.ref).toContain("RELEASE_SHA");
      expect(checkoutStep.with?.["fetch-depth"]).toBe(0);
    });

    it("validates every supplied upstream run via actions/runs/<id> without polling fallbacks", () => {
      const steps = jobs["build-and-sign"].steps;
      const gateStep = steps.find(
        (s) => s.id === "gates" || s.name?.includes("qualification identities"),
      );
      expect(gateStep).toBeDefined();
      const script = gateStep.run;

      expect(script).toContain("actions/runs/");
      expect(script).toContain(".github/workflows/ci.yml");
      expect(script).toContain(".github/workflows/platform-qualification.yml");
      expect(script).toContain(".github/workflows/system-qualification.yml");
      expect(script).toContain(".github/workflows/security-scan.yml");
      expect(script).toContain(".github/workflows/production-operational-evidence.yml");
      expect(script).toContain("vulnerability-scan-evidence.json");
      expect(script).toContain("REVOKED_RELEASE_KEY_IDS");
      expect(script, "Must not contain sleep polling loops").not.toMatch(/sleep\s+\d+/);
    });

    it("requires qualification for all four production platforms", () => {
      const steps = jobs["build-and-sign"].steps;
      const platStep = steps.find(
        (s) => s.name === "Require qualification for every production platform",
      );
      expect(platStep).toBeDefined();
      const script = platStep.run;
      expect(script).toContain("darwin-arm64");
      expect(script).toContain("darwin-x64");
      expect(script).toContain("linux-arm64");
      expect(script).toContain("linux-x64");
    });

    it("executes single upstream package call", () => {
      const steps = jobs["build-and-sign"].steps;
      const packageSteps = steps.filter(
        (s) => s.run && s.run.includes("node scripts/package-release.mjs"),
      );
      expect(packageSteps.length, "package-release.mjs must be called exactly once").toBe(1);
    });

    it("mirrors runtime sources and verifies candidate before tar assembly", () => {
      const steps = jobs["build-and-sign"].steps;
      const mirrorStepIndex = steps.findIndex((s) => s.run?.includes("mirror-runtimes"));
      const verifyStepIndex = steps.findIndex((s) => s.run?.includes("verify-candidate"));
      const assembleStepIndex = steps.findIndex((s) => s.name?.includes("Assemble deterministic"));

      expect(mirrorStepIndex, "mirror-runtimes step must exist").toBeGreaterThanOrEqual(0);
      expect(verifyStepIndex, "verify-candidate step must exist").toBeGreaterThanOrEqual(0);
      expect(assembleStepIndex, "Assemble step must exist").toBeGreaterThanOrEqual(0);

      expect(mirrorStepIndex).toBeLessThan(verifyStepIndex);
      expect(verifyStepIndex).toBeLessThan(assembleStepIndex);
    });
    it("stages exactly four pinned runtime archives before candidate verification", () => {
      const steps = jobs["build-and-sign"].steps;
      const stageIndex = steps.findIndex(
        (s) => s.name === "Stage and verify all pinned runtime archives",
      );
      const verifyIndex = steps.findIndex((s) => s.run?.includes("verify-candidate"));
      expect(stageIndex).toBeGreaterThan(-1);
      expect(stageIndex).toBeLessThan(verifyIndex);
      expect(steps[stageIndex].run).toContain('"${#runtimes[@]}" -ne 4');
      expect(steps[stageIndex].run).toContain('cp "${runtimes[@]}" "$release_dir/"');
    });

    it("assembles deterministic candidate archive containing release, qualification, tools, and verified installers", () => {
      const steps = jobs["build-and-sign"].steps;
      const assembleStep = steps.find((s) => s.name?.includes("Assemble deterministic"));
      expect(assembleStep).toBeDefined();
      const script = assembleStep.run;
      expect(script).toContain("scripts/build-install-helper.mjs --check");
      expect(script).toContain("PINNED_HELPER_SHA256");
      expect(script).toContain("apps/cli/install/install.sh");
      expect(script).toContain("apps/cli/install/install.ps1");
      expect(script).toContain("apps/cli/install/install-helper-v1.mjs");
      expect(script).toContain("$candidate_stage/installers");
      expect(script).toContain("--sort=name");
      expect(script).toContain("--mtime=");
      expect(script).toContain("--owner=0");
      expect(script).toContain("--group=0");
      expect(script).toContain("installers");
      expect(script).toContain("resin-release-candidate.tar.gz");
      expect(script).toContain("sha256sum");
      expect(script).toContain("scripts/publish-public-release.mjs");
      expect(script).toContain("scripts/release-trust.mjs");
    });

    it("verifies and uploads exact named candidate artifact", () => {
      const verifySteps = jobs["attest-and-publish-candidate"].steps;
      const digestStep = verifySteps.find((s) => s.name === "Verify candidate archive digest");
      expect(digestStep).toBeDefined();
      expect(digestStep.run).toContain("sha256sum -c");

      const uploadStep = verifySteps.find((s) => s.uses?.startsWith("actions/upload-artifact"));
      expect(uploadStep).toBeDefined();
      expect(uploadStep.with?.name).toBe("resin-release-candidate-${{ inputs.commit_sha }}");
      expect(uploadStep.with?.path).toContain("resin-release-candidate.tar.gz");
    });

    it("configures setup-node without registry URL or authentication tokens", () => {
      const steps = jobs["build-and-sign"].steps;
      const setupNodeStep = steps.find((s) => s.uses?.includes("actions/setup-node"));
      expect(setupNodeStep).toBeDefined();
      expect(
        setupNodeStep.with?.["registry-url"],
        "setup-node must NOT specify registry-url",
      ).toBeUndefined();
      expect(setupNodeStep.with?.scope, "setup-node must NOT specify scope").toBeUndefined();
      expect(
        setupNodeStep.with?.["always-auth"],
        "setup-node must NOT specify always-auth",
      ).toBeUndefined();

      // Assert neither release workflow configures registry URL or NODE_AUTH_TOKEN
      expect(candidate.raw, "Candidate workflow must not reference registry-url").not.toContain(
        "registry-url",
      );
      expect(candidate.raw, "Candidate workflow must not reference NODE_AUTH_TOKEN").not.toContain(
        "NODE_AUTH_TOKEN",
      );
      expect(production.raw, "Production workflow must not reference registry-url").not.toContain(
        "registry-url",
      );
      expect(
        production.raw,
        "Production workflow must not reference NODE_AUTH_TOKEN",
      ).not.toContain("NODE_AUTH_TOKEN");
    });
  });

  describe("Production Release Workflow: Controls, Verification & Immutable Transaction", () => {
    const job = production.doc.jobs.release;
    const inputs = production.doc.on?.workflow_dispatch?.inputs;

    it("defines workflow_dispatch with required environment choice and candidate_run_id", () => {
      expect(inputs).toBeDefined();
      expect(inputs.commit_sha?.required).toBe(true);
      expect(inputs.confirm_promotion?.required).toBe(true);
      expect(inputs.candidate_run_id?.required).toBe(true);
      expect(inputs.environment?.type).toBe("choice");
      expect(inputs.environment?.options).toEqual(["staging", "production"]);
    });

    it("enforces release concurrency and environment protection", () => {
      expect(production.doc.concurrency?.group).toBe(
        "release-${{ inputs.environment || 'production' }}",
      );
      expect(production.doc.concurrency?.["cancel-in-progress"]).toBe(false);
      expect(job.environment?.name).toBe("${{ inputs.environment || 'production' }}");
      expect(job.permissions?.["id-token"]).toBe("write");
      expect(job.permissions?.contents).toBe("read");
      expect(job.permissions?.actions).toBe("read");
      expect(job.permissions?.attestations).toBe("read");
    });

    it("validates environment contract and distinguishes staging vs production promotion strings", () => {
      const firstStep = job.steps[0];
      expect(firstStep.name).toContain("Validate manual promotion confirmation");
      const script = firstStep.run;
      expect(script).toContain("PROMOTE_PRODUCTION");
      expect(script).toContain("PROMOTE_STAGING");
      expect(script).toContain("https://dist.resin.sh");
      expect(script).toContain("RESIN_RELEASE_ROLE_ARN");
      expect(script).toContain("RESIN_DISTRIBUTION_BUCKET");
      expect(script).toContain("RESIN_DISTRIBUTION_ID");
    });

    it("contains ZERO source checkout, dependency installation, or packaging steps in production", () => {
      const steps = job.steps;
      for (const step of steps) {
        if (step.uses) {
          expect(step.uses, "Production workflow must NOT check out repository source").not.toMatch(
            /^actions\/checkout/,
          );
        }
        if (step.run) {
          expect(step.run, "Production workflow must NOT install dependencies").not.toMatch(
            /pnpm install|npm install|yarn install/,
          );
          expect(step.run, "Production workflow must NOT build or compile code").not.toMatch(
            /pnpm build|turbo run build|npm run build/,
          );
          expect(step.run, "Production workflow must NOT package release from source").not.toMatch(
            /package-release\.mjs/,
          );

          expect(step.run, "Production workflow must NOT publish to npm registry").not.toMatch(
            /npm publish/,
          );
          expect(step.run, "Production workflow must NOT create GitHub releases").not.toMatch(
            /gh release create/,
          );
        }
      }
    });
    it("gates partial immutable cleanup behind an explicit production-only input", () => {
      expect(inputs.reset_partial_release.type).toBe("boolean");
      expect(inputs.reset_partial_release.default).toBe(false);
      const cleanup = job.steps.find(
        (s) => s.name === "Delete confirmed partial immutable release prefix",
      );
      expect(cleanup).toBeDefined();
      expect(cleanup.if).toContain("inputs.reset_partial_release");
      expect(cleanup.if).toContain("inputs.environment == 'production'");
      expect(cleanup.run).toContain('prefix="releases/v1/artifacts/${RELEASE_TAG}/"');
    });

    it("validates candidate run via actions/runs/<id>, downloads exact artifact, and verifies its digest", () => {
      const steps = job.steps;
      const candidateValStep = steps.find(
        (s) => s.id === "candidate_gate" || s.name?.includes("candidate run identity"),
      );
      expect(candidateValStep).toBeDefined();
      expect(candidateValStep.run).toContain("actions/runs/");
      expect(candidateValStep.run).toContain(".github/workflows/release-candidate.yml");
      const downloadStep = steps.find((s) =>
        s.name?.includes("Download candidate release artifact"),
      );
      expect(downloadStep).toBeDefined();
      expect(downloadStep.run).toContain("resin-release-candidate-${RELEASE_SHA}");
      expect(downloadStep.run).toContain("actions/runs/$candidate_run_id/artifacts");
      expect(downloadStep.run).toContain(".expired == false");
      expect(downloadStep.run).toContain("actions/artifacts/$artifact_id/zip");
      expect(downloadStep.run).toContain("^sha256:[0-9a-f]{64}$");
      expect(downloadStep.run).toContain("unzip -q -o");
      expect(downloadStep.run).toContain("Downloaded artifact ZIP digest mismatch");
      expect(downloadStep.run).not.toContain("gh run download");

      const verifyStep = steps.find((s) => s.name?.includes("Verify candidate checksum"));
      expect(verifyStep).toBeDefined();
      expect(verifyStep.run).toContain("sha256sum -c");

      const extractStep = steps.find((s) => s.name?.includes("Extract candidate tools"));
      expect(extractStep).toBeDefined();
      expect(extractStep.run).toContain("execFileSync");
      expect(extractStep.run).toContain("-tzvf");
      expect(extractStep.run).toContain("tar -xzf");
      expect(extractStep.run).toContain("tools/publish-public-release.mjs");
      expect(extractStep.run).toContain("tools/release-trust.mjs");
    });
    it("assumes AWS release role via OIDC before publishing", () => {
      const steps = job.steps;
      const awsStep = steps.find((s) =>
        s.uses?.startsWith("aws-actions/configure-aws-credentials"),
      );
      expect(awsStep).toBeDefined();
      expect(awsStep.with?.["role-to-assume"]).toContain("RESIN_RELEASE_ROLE_ARN");
      expect(awsStep.with?.["aws-region"]).toBe("us-east-1");
    });

    it("executes publisher phases in strict immutable -> verify -> pre-smoke -> promote -> post-smoke order with stable receipt-dir", () => {
      const steps = job.steps;
      const publishStep = steps.find(
        (s) => s.id === "publish_immutable" || s.run?.includes("publish-immutable"),
      );
      const verifyStep = steps.find(
        (s) => s.id === "verify_public" || s.run?.includes("verify-public"),
      );
      const preSmokeStep = steps.find(
        (s) => s.id === "prepromotion_smoke" || s.name?.includes("pre-promotion"),
      );
      const promoteStep = steps.find((s) => s.id === "promote" || s.run?.includes("promote"));
      const smokeStep = steps.find(
        (s) => s.id === "public_smoke" || s.run?.includes("record-smoke"),
      );

      expect(publishStep, "publish-immutable must exist").toBeDefined();
      expect(verifyStep, "verify-public must exist").toBeDefined();
      expect(preSmokeStep, "prepromotion_smoke must exist").toBeDefined();
      expect(promoteStep, "promote must exist").toBeDefined();
      expect(smokeStep, "record-smoke must exist").toBeDefined();

      const publishIndex = steps.indexOf(publishStep);
      const verifyIndex = steps.indexOf(verifyStep);
      const preSmokeIndex = steps.indexOf(preSmokeStep);
      const promoteIndex = steps.indexOf(promoteStep);
      const smokeIndex = steps.indexOf(smokeStep);

      expect(publishIndex).toBeLessThan(verifyIndex);
      expect(verifyIndex).toBeLessThan(preSmokeIndex);
      expect(preSmokeIndex).toBeLessThan(promoteIndex);
      expect(promoteIndex).toBeLessThan(smokeIndex);

      expect(publishStep.run).toContain("--receipt-dir");
      expect(verifyStep.run).toContain("--receipt-dir");
      expect(promoteStep.run).toContain("--receipt-dir");

      // Verify that every step after promote either performs smoke testing or is a conditional freeze handler
      const postPromoteSteps = steps.slice(promoteIndex + 1);

      for (const step of postPromoteSteps) {
        if (
          step.id === "public_smoke" ||
          (step.name?.includes("smoke") &&
            !step.name?.includes("Freeze") &&
            !step.name?.includes("freeze"))
        ) {
          expect(step.run).toContain("record-smoke");
        } else if (step.name?.includes("Freeze") || step.run?.includes("freeze")) {
          expect(step.if).toContain("failure()");
          expect(step.if).toContain("steps.promote.outcome == 'success'");
        }
      }
    });

    it("validates candidate archive extraction safely and requires installer assets", () => {
      const extractStep = job.steps.find((s) => s.name?.includes("Extract candidate tools"));
      expect(extractStep).toBeDefined();
      expect(extractStep.run).toContain("installers");
      expect(extractStep.run).toContain("installers/install.sh");
      expect(extractStep.run).toContain("installers/install.ps1");
      expect(extractStep.run).toContain("installers/install-helper-v1.mjs");
    });

    it("runs pre-promotion smoke testing with immutable candidate channel URL and clean homes before promotion", () => {
      const preSmokeStep = job.steps.find(
        (s) =>
          s.id === "prepromotion_smoke" ||
          s.name === "Run pre-promotion installer smoke verification",
      );
      expect(preSmokeStep).toBeDefined();
      const script = preSmokeStep.run;
      expect(script).toContain("verify-public-receipt.json");
      expect(script).toContain("candidate_channel_url");
      expect(script).toContain("installers/install.sh");
      expect(script).toContain("installers/install.ps1");
      expect(script).toContain("--channel-url");
      expect(script).toContain("-ChannelUrl");
      expect(script).toContain('bin/resin" version');
      expect(script).toContain("expected_version");
    });

    it("runs post-promotion smoke downloading canonical resin.sh assets anonymously and checking byte parity", () => {
      const smokeStep = job.steps.find(
        (s) =>
          s.id === "public_smoke" ||
          s.name === "Run post-promotion public artifact smoke verification",
      );
      expect(smokeStep).toBeDefined();
      const script = smokeStep.run;
      expect(script).toContain("https://resin.sh/install.sh");
      expect(script).toContain("https://resin.sh/install.ps1");
      expect(script).toContain("https://resin.sh/install-helper-v1.mjs");
      expect(script).toContain('redirect: "manual"');
      expect(script).toContain("installers/install.sh");
      expect(script).toContain("installers/install.ps1");
      expect(script).toContain("installers/install-helper-v1.mjs");
      expect(script).toContain("Byte parity mismatch");
    });

    it("executes post-promotion clean installs against stable with no overrides and records two-item results JSON", () => {
      const smokeStep = job.steps.find(
        (s) =>
          s.id === "public_smoke" ||
          s.name === "Run post-promotion public artifact smoke verification",
      );
      expect(smokeStep).toBeDefined();
      const script = smokeStep.run;
      expect(script).toContain("installer-results.json");
      expect(script).toContain('installer = "posix"');
      expect(script).toContain('installer = "powershell"');
      expect(script).toContain("entrypointUrl");
      expect(script).toContain("durationMs");
      expect(script).toContain("installedVersion");
      expect(script).toContain("status");
      expect(script).toContain("--installer-results");
    });

    it("records complete post-promotion smoke evidence with bucket, distribution, key-prefix, environment, and receipt-dir arguments", () => {
      const steps = job.steps;
      const smokeStep = steps.find(
        (s) =>
          s.id === "public_smoke" ||
          s.name === "Run post-promotion public artifact smoke verification",
      );
      expect(smokeStep).toBeDefined();
      const script = smokeStep.run;
      expect(script).toContain("tools/publish-public-release.mjs record-smoke");
      expect(script).toContain("--dist-dir");
      expect(script).toContain("--bucket");
      expect(script).toContain("--distribution-id");
      expect(script).toContain("--base-url");
      expect(script).toContain("--key-prefix");
      expect(script).toContain("--environment");
      expect(script).toContain("--receipt-dir");
      expect(script).toContain("--output-dir");
      expect(script).toContain("--installer-results");
    });

    it("implements emergency signed freeze rollback if post-promotion smoke fails with scoped signing key and receipt-dir", () => {
      const steps = job.steps;
      const freezeStep = steps.find((s) => s.name?.includes("Freeze") || s.run?.includes("freeze"));
      expect(freezeStep).toBeDefined();
      expect(freezeStep.if).toBe("failure() && steps.promote.outcome == 'success'");
      expect(freezeStep.env?.RESIN_RELEASE_PRIVATE_KEY_PEM).toBe(
        "${{ secrets.RESIN_RELEASE_PRIVATE_KEY_PEM }}",
      );
      expect(freezeStep.env?.RESIN_RELEASE_KEY_ID).toBe("${{ vars.RESIN_RELEASE_KEY_ID }}");
      expect(freezeStep.env?.RESIN_RELEASE_PUBLIC_KEY_PEM).toBe(
        "${{ vars.RESIN_RELEASE_PUBLIC_KEY_PEM }}",
      );
      const script = freezeStep.run;
      expect(script).toContain("tools/publish-public-release.mjs freeze");
      expect(script).toContain("--dist-dir");
      expect(script).toContain("--bucket");
      expect(script).toContain("--distribution-id");
      expect(script).toContain("--base-url");
      expect(script).toContain("--reason");
      expect(script).toContain("--receipt-dir");
      expect(script).toContain("RESIN_RELEASE_PRIVATE_KEY_PEM");
    });

    it("derives staging dry-run key prefix from github.run_id and sets empty prefix for production", () => {
      expect(job.env?.KEY_PREFIX).toBe(
        "${{ (inputs.environment || 'production') == 'staging' && format('dry-runs/{0}', github.run_id) || '' }}",
      );

      const firstStep = job.steps[0];
      expect(firstStep.run).toContain('key_prefix=""');
      expect(firstStep.run).toContain('key_prefix="dry-runs/${GITHUB_RUN_ID}"');
      expect(firstStep.run).toContain('echo "KEY_PREFIX=$key_prefix" >> "$GITHUB_ENV"');
    });

    it("propagates --key-prefix to all publisher modes in release workflow", () => {
      const publishStep = job.steps.find((s) => s.id === "publish_immutable");
      expect(publishStep.run).toContain('--key-prefix "$KEY_PREFIX"');

      const verifyStep = job.steps.find((s) => s.id === "verify_public");
      expect(verifyStep.run).toContain('--key-prefix "$KEY_PREFIX"');

      const promoteStep = job.steps.find((s) => s.id === "promote");
      expect(promoteStep.run).toContain('--key-prefix "$KEY_PREFIX"');

      const smokeStep = job.steps.find((s) => s.id === "public_smoke");
      expect(smokeStep.run).toContain('--key-prefix "$KEY_PREFIX"');

      const freezeStep = job.steps.find(
        (s) => s.id === "freeze_release" || s.name?.includes("Freeze release"),
      );
      expect(freezeStep.run).toContain('--key-prefix "$KEY_PREFIX"');
    });

    it("packages all 13 public fallback tarballs with contracted release:packages command, base URL, and staging output directory", () => {
      const packageStep = job.steps.find(
        (s) => s.id === "package_fallback" || s.name?.includes("fallback package"),
      );
      expect(packageStep, "Must have package_fallback step").toBeDefined();
      expect(packageStep.shell).toBe("bash");

      const script = packageStep.run;
      expect(script).toContain("pnpm run release:packages");
      expect(script).toContain(
        '--artifact-base-url "https://github.com/${GITHUB_REPOSITORY}/releases/download/${TAG}"',
      );
      expect(script).toContain('--output-dir "$staging_dir"');
      expect(script).toContain('TAG="$RELEASE_TAG"');
      expect(script).not.toMatch(/\$\{\{\s*inputs\./);
    });

    it("uploads all 13 package fallback tarballs and machine-readable manifest to GitHub release alongside public artifacts", () => {
      const uploadStep = job.steps.find(
        (s) => s.id === "upload_github_release" || s.name?.includes("Upload fallback package"),
      );
      expect(uploadStep, "Must have upload_github_release step").toBeDefined();
      expect(uploadStep.shell).toBe("bash");

      const script = uploadStep.run;
      expect(script).toContain('gh release upload "$RELEASE_TAG"');
      expect(script).toContain('"$staging_dir"/*.tgz');
      expect(script).toContain('"$staging_dir/packages-manifest.json"');
      expect(script).toContain("--clobber");
    });

    it("verifies package fallback covers exactly the 13 public packages without private/cloud artifacts", () => {
      const splitConfigPath = path.join(ROOT_DIR, "repository-split.json");
      const splitConfig = JSON.parse(fs.readFileSync(splitConfigPath, "utf-8"));
      expect(splitConfig.publicPackageManifests).toHaveLength(13);
      expect(splitConfig.publicPackages).toHaveLength(13);

      const EXPECTED_PUBLIC_TARBALLS = [
        "resin-1.0.0.tgz",
        "resin-gateway-0.1.0.tgz",
        "resin-observer-0.1.0.tgz",
        "resin-runtime-0.1.0.tgz",
        "resin-crypto-0.1.0.tgz",
        "resin-protocol-0.1.0.tgz",
        "resin-contracts-0.1.0.tgz",
        "resin-harness-contracts-0.1.0.tgz",
        "resin-db-0.1.0.tgz",
        "resin-adapter-claude-code-0.1.0.tgz",
        "resin-adapter-codex-0.1.0.tgz",
        "resin-adapter-omp-0.1.0.tgz",
        "resin-test-fixtures-0.1.0.tgz",
      ];

      for (const manifestRelPath of splitConfig.publicPackageManifests) {
        const manifest = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, manifestRelPath), "utf-8"));
        const sanitized = manifest.name.startsWith("@")
          ? manifest.name.slice(1).replace("/", "-")
          : manifest.name;
        const expectedTarball = `${sanitized}-${manifest.version}.tgz`;
        expect(EXPECTED_PUBLIC_TARBALLS).toContain(expectedTarball);
      }

      const PRIVATE_NAMES = ["@resin/cloud", "@resin/web", "@resin/cloud-contracts", "@resin/e2e"];
      for (const priv of PRIVATE_NAMES) {
        expect(splitConfig.publicPackages).not.toContain(priv);
      }
    });
  });

  describe("Static Security Regression: No Run-Script ${{ inputs.* }} Interpolation & Strict Shell Validation", () => {
    function assertNoInputsInRun(workflowDoc, workflowName) {
      const jobs = workflowDoc.jobs || {};
      for (const [jobName, job] of Object.entries(jobs)) {
        const steps = job.steps || [];
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          if (typeof step.run === "string") {
            expect(
              step.run,
              `Workflow '${workflowName}', job '${jobName}', step #${i} ('${step.name || step.id || "unnamed"}') must NOT interpolate \${{ inputs.* }} in run script`,
            ).not.toMatch(/\$\{\{\s*inputs\./);
          }
        }
      }
    }

    it("ensures release-candidate.yml contains NO ${{ inputs.* }} inside run scripts", () => {
      assertNoInputsInRun(candidate.doc, "release-candidate.yml");
    });

    it("ensures release.yml contains NO ${{ inputs.* }} inside run scripts", () => {
      assertNoInputsInRun(production.doc, "release.yml");
    });

    it("validates run IDs as digits, commit SHA as 40 hex, and release tag as strict semver before use", () => {
      const candidateGates = candidate.doc.jobs["build-and-sign"].steps.find(
        (s) => s.id === "gates",
      );
      expect(candidateGates).toBeDefined();
      expect(candidateGates.run).toContain("^[0-9a-f]{40}$");
      expect(candidateGates.run).toContain("^[0-9]+$");
      expect(candidateGates.run).toContain("v[0-9]+\\.[0-9]+\\.[0-9]+");

      const prodValidate = production.doc.jobs.release.steps.find((s) =>
        s.name?.includes("Validate manual promotion"),
      );
      expect(prodValidate).toBeDefined();
      expect(prodValidate.run).toContain("^[0-9a-f]{40}$");
      expect(prodValidate.run).toContain("^[0-9]+$");
      expect(prodValidate.run).toContain("v[0-9]+\\.[0-9]+\\.[0-9]+");
    });

    it("validates candidate archive safely before extraction in production workflow", () => {
      const extractStep = production.doc.jobs.release.steps.find((s) =>
        s.name?.includes("Extract candidate tools"),
      );
      expect(extractStep).toBeDefined();
      expect(extractStep.run).toContain("execFileSync");
      expect(extractStep.run).toContain("-tzvf");
      expect(extractStep.run).toContain("Illegal archive entry type");
      expect(extractStep.run).toContain("Illegal entry path");
      expect(extractStep.run).toContain("Duplicate entry path");
    });
  });

  describe("Public PR Workflow Trust, Runner Isolation & Gate Enforcement", () => {
    const prWorkflows = [
      { name: "ci.yml", data: ci },
      { name: "platform-qualification.yml", data: platformQualification },
      ...(systemQualification
        ? [{ name: "system-qualification.yml", data: systemQualification }]
        : []),
    ];

    const GITHUB_HOSTED_RUNNER_PATTERNS = [
      /^ubuntu-(?:latest|\d{2}\.\d{2}(?:-arm)?)$/,
      /^macos-(?:latest|\d{2}(?:-arm64)?)$/,
      /^windows-(?:latest|\d{4})$/,
    ];

    function isGitHubHostedRunner(runner) {
      if (typeof runner !== "string") return false;
      return GITHUB_HOSTED_RUNNER_PATTERNS.some((pattern) => pattern.test(runner));
    }

    it("parses ci.yml, platform-qualification.yml, and system-qualification.yml as valid YAML documents", () => {
      expect(ci.doc).toBeDefined();
      expect(ci.doc.name).toBe("CI");
      expect(ci.doc.jobs).toBeDefined();

      expect(platformQualification.doc).toBeDefined();
      expect(platformQualification.doc.name).toBe("Platform Qualification");
      expect(platformQualification.doc.jobs).toBeDefined();

      if (systemQualification) {
        expect(systemQualification.doc).toBeDefined();
        expect(systemQualification.doc.name).toBe("System Qualification");
        expect(systemQualification.doc.jobs).toBeDefined();
      }
    });

    it("strictly prohibits pull_request_target on all public PR workflows", () => {
      for (const { name, data } of prWorkflows) {
        const triggers = data.doc.on;
        if (typeof triggers === "object" && triggers !== null) {
          expect(triggers, `${name} must not use pull_request_target trigger`).not.toHaveProperty(
            "pull_request_target",
          );
        }
        expect(data.raw, `${name} must not contain pull_request_target`).not.toContain(
          "pull_request_target",
        );
      }
    });

    it("strictly prohibits self-hosted runners and resin-vm infrastructure on all PR workflows", () => {
      for (const { name, data } of prWorkflows) {
        expect(
          data.raw,
          `${name} must not mention resin-vm-linux-arm64 or self-hosted runners`,
        ).not.toContain("resin-vm");
        expect(data.raw, `${name} must not reference self-hosted label`).not.toMatch(
          /runs-on:\s*.*self-hosted/,
        );

        for (const [jobId, job] of Object.entries(data.doc.jobs || {})) {
          const runsOn = job["runs-on"];
          if (typeof runsOn === "string" && !runsOn.startsWith("${{")) {
            expect(
              isGitHubHostedRunner(runsOn),
              `Job ${jobId} in ${name} must run on a GitHub-hosted runner, got: ${runsOn}`,
            ).toBe(true);
          } else if (Array.isArray(runsOn)) {
            for (const r of runsOn) {
              expect(
                isGitHubHostedRunner(r),
                `Job ${jobId} in ${name} has non-GitHub-hosted runner: ${r}`,
              ).toBe(true);
            }
          }
        }
      }
    });

    it("ensures no runner in PR workflows is selected by fork-controlled input or expressions", () => {
      for (const { name, data } of prWorkflows) {
        for (const [jobId, job] of Object.entries(data.doc.jobs || {})) {
          const runsOnStr = String(job["runs-on"] || "");
          expect(
            runsOnStr,
            `Job ${jobId} in ${name} must not select runner using github.event or inputs`,
          ).not.toMatch(/\$\{\{\s*(?:github\.event|inputs)\./);

          if (job.strategy?.matrix?.include) {
            for (const entry of job.strategy.matrix.include) {
              if (entry.runner) {
                expect(
                  isGitHubHostedRunner(entry.runner),
                  `Matrix runner in ${jobId} (${name}) must be GitHub-hosted, got: ${entry.runner}`,
                ).toBe(true);
              }
            }
          }
        }
      }
    });

    it("enforces minimal read-only permissions and rejects write permissions on all PR workflows", () => {
      const FORBIDDEN_WRITE_PERMISSIONS = [
        "contents: write",
        "actions: write",
        "id-token: write",
        "packages: write",
        "deployments: write",
        "security-events: write",
        "statuses: write",
        "pull-requests: write",
      ];

      for (const { name, data } of prWorkflows) {
        for (const forbidden of FORBIDDEN_WRITE_PERMISSIONS) {
          expect(data.raw, `${name} must not request '${forbidden}'`).not.toContain(forbidden);
        }

        const topPermissions = data.doc.permissions;
        if (typeof topPermissions === "object" && topPermissions !== null) {
          for (const [scope, level] of Object.entries(topPermissions)) {
            expect(level, `Top-level permission '${scope}' in ${name} must be 'read'`).toBe("read");
          }
        }

        for (const [jobId, job] of Object.entries(data.doc.jobs || {})) {
          if (job.permissions && typeof job.permissions === "object") {
            for (const [scope, level] of Object.entries(job.permissions)) {
              expect(level, `Job permission '${scope}' in ${jobId} (${name}) must be 'read'`).toBe(
                "read",
              );
            }
          }
        }
      }
    });

    it("enforces persist-credentials: false on all actions/checkout steps in PR workflows", () => {
      for (const { name, data } of prWorkflows) {
        for (const [jobId, job] of Object.entries(data.doc.jobs || {})) {
          const steps = job.steps || [];
          const checkoutSteps = steps.filter(
            (s) =>
              s.uses?.startsWith("actions/checkout") || s.name?.toLowerCase().includes("checkout"),
          );
          expect(
            checkoutSteps.length,
            `Job ${jobId} in ${name} must have at least one checkout step`,
          ).toBeGreaterThanOrEqual(1);

          for (const step of checkoutSteps) {
            expect(
              step.with?.["persist-credentials"],
              `Checkout step in job ${jobId} (${name}) must set persist-credentials: false`,
            ).toBe(false);
          }
        }
      }
    });

    it("strictly prohibits release and deployment environments in PR workflows", () => {
      for (const { name, data } of prWorkflows) {
        for (const [jobId, job] of Object.entries(data.doc.jobs || {})) {
          expect(
            job.environment,
            `Job ${jobId} in ${name} must not configure a deployment environment`,
          ).toBeUndefined();
        }
        expect(data.raw, `${name} must not declare environment:`).not.toMatch(/^\s*environment:/m);
      }
    });

    it("prohibits privileged production, deployment, and signing secrets in PR workflows", () => {
      const FORBIDDEN_SECRET_PATTERNS = [
        /\$\{\{\s*secrets\.AWS_/i,
        /\$\{\{\s*secrets\.DEPLOY_/i,
        /\$\{\{\s*secrets\.SIGNING_/i,
        /\$\{\{\s*secrets\.NPM_/i,
        /\$\{\{\s*secrets\.PROD_/i,
        /\$\{\{\s*secrets\.RESIN_RELEASE_PRIVATE_KEY/i,
      ];

      for (const { name, data } of prWorkflows) {
        for (const pattern of FORBIDDEN_SECRET_PATTERNS) {
          expect(
            data.raw,
            `${name} must not reference privileged secrets matching ${pattern}`,
          ).not.toMatch(pattern);
        }
      }
    });

    it("requires explicit root gate commands in package.json and wire them into check:all", () => {
      const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8"));
      const scripts = packageJson.scripts || {};

      expect(scripts["check:privacy-boundary"]).toBeDefined();
      expect(scripts["check:privacy-boundary"]).toContain(
        "apps/observer/tests/sync/privacy-boundary.test.ts",
      );

      expect(scripts["check:hostile-cloud"]).toBeDefined();
      expect(scripts["check:hostile-cloud"]).toContain("packages/runtime/tests/security.test.ts");
      expect(scripts["check:hostile-cloud"]).toContain(
        "apps/observer/tests/sync/preactivation.test.ts",
      );
      expect(scripts["check:hostile-cloud"]).toContain(
        "apps/observer/tests/sync/signed-activation-and-quarantine.test.ts",
      );

      expect(scripts["check:runtime-security"]).toBeDefined();
      expect(scripts["check:runtime-security"]).toContain(
        "packages/runtime/tests/brokers/fs-security.test.ts",
      );
      expect(scripts["check:runtime-security"]).toContain(
        "packages/runtime/tests/brokers/net-security.test.ts",
      );
      expect(scripts["check:runtime-security"]).toContain(
        "packages/runtime/tests/brokers/cmd-security.test.ts",
      );
      expect(scripts["check:runtime-security"]).toContain("apps/observer/tests/ipc.test.ts");
      expect(scripts["check:runtime-security"]).toContain(
        "apps/cli/tests/installer/asset-downloader-security.test.ts",
      );

      const checkAll = scripts["check:all"];
      expect(checkAll).toBeDefined();
      expect(checkAll).toContain("pnpm run check:privacy-boundary");
      expect(checkAll).toContain("pnpm run check:hostile-cloud");
      expect(checkAll).toContain("pnpm run check:runtime-security");
      expect(checkAll).toContain("pnpm run check:adrs");
      expect(checkAll).toContain("pnpm run check:boundaries");
      expect(checkAll).toContain("pnpm run check:secrets");
      expect(checkAll).toContain("pnpm run lint");
      expect(checkAll).toContain("pnpm run typecheck");
      expect(checkAll).toContain("pnpm run test");
      expect(checkAll).toContain("pnpm run release:test");
      expect(checkAll).toContain("pnpm run test:e2e");
      expect(checkAll).toContain("pnpm run check:smoke");
      expect(checkAll).toContain("pnpm run release:package:test");
      expect(checkAll).toContain("pnpm run release:verify:test");
    });

    it("exposes named CI jobs for privacy boundary, hostile cloud, and runtime security in ci.yml", () => {
      const jobs = ci.doc.jobs;
      expect(jobs["check-privacy-boundary"]).toBeDefined();
      expect(jobs["check-privacy-boundary"]["runs-on"]).toBe("ubuntu-latest");
      const privacyRun = jobs["check-privacy-boundary"].steps.find((s) =>
        s.run?.includes("check:privacy-boundary"),
      );
      expect(privacyRun).toBeDefined();

      expect(jobs["check-hostile-cloud"]).toBeDefined();
      expect(jobs["check-hostile-cloud"]["runs-on"]).toBe("ubuntu-latest");
      const hostileRun = jobs["check-hostile-cloud"].steps.find((s) =>
        s.run?.includes("check:hostile-cloud"),
      );
      expect(hostileRun).toBeDefined();

      expect(jobs["check-runtime-security"]).toBeDefined();
      expect(jobs["check-runtime-security"]["runs-on"]).toBe("ubuntu-latest");
      const runtimeRun = jobs["check-runtime-security"].steps.find((s) =>
        s.run?.includes("check:runtime-security"),
      );
      expect(runtimeRun).toBeDefined();
    });

    it("requires ci-gate in ci.yml to enforce all 13 checks including privacy, hostile cloud, and runtime security gates", () => {
      const gateJob = ci.doc.jobs["ci-gate"];
      expect(gateJob).toBeDefined();
      expect(gateJob["runs-on"]).toBe("ubuntu-latest");
      expect(gateJob.if).toBe("always()");

      const expectedRequiredJobs = [
        "lint",
        "typecheck",
        "build",
        "test-unit",
        "test-e2e",
        "check-boundaries",
        "check-adrs",
        "check-privacy-boundary",
        "check-hostile-cloud",
        "check-runtime-security",
        "release-verification",
        "binary-smoke",
        "secret-scan",
      ];

      expect(gateJob.needs).toEqual(expect.arrayContaining(expectedRequiredJobs));
      expect(gateJob.needs).toHaveLength(expectedRequiredJobs.length);

      const verifyStep = gateJob.steps.find((s) => s.id === "gate");
      expect(verifyStep).toBeDefined();
      for (const requiredJob of expectedRequiredJobs) {
        expect(verifyStep.run).toContain(requiredJob);
      }
    });

    it("verifies configure-branch-protection.sh enforces all 13 CI status check contexts plus rollup", () => {
      const scriptPath = path.join(ROOT_DIR, "scripts", "configure-branch-protection.sh");
      const scriptContent = fs.readFileSync(scriptPath, "utf8");

      const expectedContexts = [
        "Lint & Format Check",
        "TypeScript Typecheck",
        "Monorepo Build",
        "Unit Tests",
        "E2E Tests (with PostgreSQL)",
        "Package Boundaries Check",
        "ADR Verification",
        "Privacy Data Boundary Check",
        "Hostile Cloud Quarantine & Preactivation Check",
        "Runtime IPC & Broker Security Check",
        "Release Verification",
        "Binary Smoke Test",
        "Secret Scanning",
        "CI Gate Rollup",
      ];

      for (const context of expectedContexts) {
        expect(scriptContent).toContain(`"${context}"`);
      }
    });

    it("retains 5-lane platform qualification coverage in platform-qualification.yml on GitHub-hosted runners", () => {
      const platformJob = platformQualification.doc.jobs["platform-artifacts"];
      expect(platformJob).toBeDefined();
      expect(platformJob["runs-on"]).toBe("${{ matrix.runner }}");

      const matrix = platformJob.strategy?.matrix?.include;
      expect(matrix).toHaveLength(5);

      const lanes = matrix.map((m) => m.lane);
      expect(lanes).toEqual(
        expect.arrayContaining(["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "wsl"]),
      );

      for (const entry of matrix) {
        expect(isGitHubHostedRunner(entry.runner)).toBe(true);
        if (entry.lane.startsWith("darwin") || entry.lane === "wsl") {
          expect(entry.mode).toBe("artifact");
        }
      }
    });

    it("validates system-qualification.yml clean checkout gate and artifact upload on GitHub-hosted runner", () => {
      if (!systemQualification) {
        return;
      }
      const job = systemQualification.doc.jobs["full-system"];
      expect(job).toBeDefined();
      expect(job["runs-on"]).toBe("ubuntu-latest");

      const steps = job.steps;
      const checkoutStep = steps.find((s) => s.uses?.startsWith("actions/checkout"));
      expect(checkoutStep).toBeDefined();
      expect(checkoutStep.with?.["persist-credentials"]).toBe(false);

      const uploadStep = steps.find((s) => s.uses?.startsWith("actions/upload-artifact"));
      expect(uploadStep).toBeDefined();
      expect(uploadStep.with?.path).toBe("dist/qualification/system-e2e.json");
    });
  });
});
