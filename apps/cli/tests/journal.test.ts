import { InMemoryConfigFsBridge } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { InstallationJournal, type InstallationStepName } from "../src/installer/journal.js";

describe("InstallationJournal & Atomic Rollback", () => {
  it("initializes with 11 standard predefined steps in pending state", () => {
    const journal = new InstallationJournal();

    expect(journal.status).toBe("in_progress");
    expect(journal.steps).toHaveLength(11);
    expect(journal.steps.map((s) => s.name)).toEqual([
      "preflight",
      "platform",
      "assets",
      "directories",
      "authorization",
      "pairing",
      "harness_discovery",
      "config_planning",
      "apply",
      "verify",
      "complete",
    ]);
    expect(journal.steps.every((s) => s.status === "pending")).toBe(true);
  });

  it("transitions steps across running, completed, skipped, and failed", () => {
    const journal = new InstallationJournal();

    journal.startStep("preflight", { check: "node" });
    const preflight = journal.getStep("preflight");
    expect(preflight.status).toBe("running");
    expect(preflight.startedAt).toBeDefined();
    expect(preflight.details?.check).toBe("node");

    journal.completeStep("preflight", { result: "ok" });
    expect(preflight.status).toBe("completed");
    expect(preflight.completedAt).toBeDefined();
    expect(preflight.details?.result).toBe("ok");

    journal.skipStep("assets", { reason: "cached" });
    expect(journal.getStep("assets").status).toBe("skipped");

    journal.failStep("authorization", new Error("Declined by user"));
    expect(journal.getStep("authorization").status).toBe("failed");
    expect(journal.getStep("authorization").error).toBe("Declined by user");
    expect(journal.status).toBe("failed");
  });

  it("executes registered rollback actions in reverse order (LIFO)", async () => {
    const journal = new InstallationJournal();
    const bridge = new InMemoryConfigFsBridge();
    const executionOrder: string[] = [];

    journal.startStep("apply");
    journal.addRollbackAction("apply", "Action 1", async () => {
      executionOrder.push("action1");
    });
    journal.addRollbackAction("apply", "Action 2", async () => {
      executionOrder.push("action2");
    });
    journal.addRollbackAction("apply", "Action 3", async () => {
      executionOrder.push("action3");
    });

    const rollbackResult = await journal.rollback(bridge);

    expect(rollbackResult.success).toBe(true);
    expect(rollbackResult.executedActionsCount).toBe(3);
    expect(executionOrder).toEqual(["action3", "action2", "action1"]);
    expect(journal.status).toBe("rolled_back");
    expect(journal.getStep("apply").status).toBe("rolled_back");
  });

  it("handles rollback errors gracefully without stopping remaining actions", async () => {
    const journal = new InstallationJournal();
    const bridge = new InMemoryConfigFsBridge();
    const executionOrder: string[] = [];

    journal.addRollbackAction("apply", "Good Action 1", async () => {
      executionOrder.push("good1");
    });
    journal.addRollbackAction("apply", "Failing Action", async () => {
      executionOrder.push("failing");
      throw new Error("Disk error during rollback");
    });
    journal.addRollbackAction("apply", "Good Action 2", async () => {
      executionOrder.push("good2");
    });

    const result = await journal.rollback(bridge);

    expect(result.success).toBe(false);
    expect(result.executedActionsCount).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].description).toBe("Failing Action");
    expect(result.errors[0].error).toContain("Disk error during rollback");
    expect(executionOrder).toEqual(["good2", "failing", "good1"]);
  });

  it("saves and loads journal state to/from disk bridge", async () => {
    const journal = new InstallationJournal();
    const bridge = new InMemoryConfigFsBridge();

    journal.startStep("platform");
    journal.completeStep("platform", { os: "linux" });
    journal.finalize("completed");

    const journalPath = "/home/user/.resin/state/install-journal.json";
    await journal.save(journalPath, bridge);

    const loaded = await InstallationJournal.load(journalPath, bridge);
    expect(loaded.journalId).toBe(journal.journalId);
    expect(loaded.status).toBe("completed");
    expect(loaded.getStep("platform").status).toBe("completed");
    expect(loaded.getStep("platform").details?.os).toBe("linux");
  });
});
