import { describe, expect, it } from "vitest";
import { DaemonConfigSchema } from "../src/config.js";
import type {
  DaemonModule,
  ModuleContext,
  ModuleHealth,
  ModuleLifecycleState,
} from "../src/lifecycle.js";
import type { JsonObject } from "../src/normalization/redaction.js";
import { DaemonSupervisor, DefaultLogger } from "../src/supervisor.js";

describe("supervisor", () => {
  function createTrackingModule(
    id: string,
    dependencies: string[] = [],
    options: {
      critical?: boolean;
      shouldFailStart?: boolean;
      healthStatus?: "ready" | "degraded" | "failed" | "offline";
      healthDetails?: JsonObject;
      onStart?: () => void;
      onStop?: () => void;
      onReload?: () => void;
    } = {},
  ): DaemonModule & { startCalled: boolean; stopCalled: boolean; reloadCalled: boolean } {
    let state: ModuleLifecycleState = "uninitialized";
    const mod = {
      id,
      name: `Module ${id}`,
      dependencies,
      critical: options.critical ?? false,
      startCalled: false,
      stopCalled: false,
      reloadCalled: false,
      getState: () => state,
      start: async (_ctx: ModuleContext) => {
        mod.startCalled = true;
        options.onStart?.();
        if (options.shouldFailStart) {
          state = "failed";
          throw new Error(`Intentional start failure in ${id}`);
        }
        state = "ready";
      },
      stop: async (_ctx: ModuleContext) => {
        mod.stopCalled = true;
        options.onStop?.();
        state = "stopped";
      },
      healthCheck: async (): Promise<ModuleHealth> => {
        return {
          status: options.healthStatus ?? (state === "ready" ? "ready" : "failed"),
          details: options.healthDetails,
          lastCheckTime: Date.now(),
        };
      },
      reloadConfig: async () => {
        mod.reloadCalled = true;
        options.onReload?.();
      },
      getDiagnostics: async () => {
        return { customInfo: `diagnostics-for-${id}` };
      },
    };
    return mod;
  }

  describe("Startup and Shutdown Ordering", () => {
    it("starts modules in dependency order and stops in reverse order", async () => {
      const orderStarted: string[] = [];
      const orderStopped: string[] = [];

      const modA = createTrackingModule("A", [], {
        onStart: () => orderStarted.push("A"),
        onStop: () => orderStopped.push("A"),
      });
      const modB = createTrackingModule("B", ["A"], {
        onStart: () => orderStarted.push("B"),
        onStop: () => orderStopped.push("B"),
      });
      const modC = createTrackingModule("C", ["B"], {
        onStart: () => orderStarted.push("C"),
        onStop: () => orderStopped.push("C"),
      });

      const config = DaemonConfigSchema.parse({ logLevel: "silent" });
      const supervisor = new DaemonSupervisor({
        config,
        modules: [modC, modA, modB],
      });

      await supervisor.start();
      expect(supervisor.currentState).toBe("ready");
      expect(orderStarted).toEqual(["A", "B", "C"]);

      await supervisor.stop();
      expect(supervisor.currentState).toBe("stopped");
      expect(orderStopped).toEqual(["C", "B", "A"]);
    });
  });

  describe("Failure handling and rollback", () => {
    it("marks supervisor as degraded when non-critical module fails to start", async () => {
      const modA = createTrackingModule("A", []);
      const modB = createTrackingModule("B", ["A"], { shouldFailStart: true, critical: false });
      const modC = createTrackingModule("C", ["A"]);

      const config = DaemonConfigSchema.parse({ logLevel: "silent" });
      const supervisor = new DaemonSupervisor({
        config,
        modules: [modA, modB, modC],
      });

      await supervisor.start();
      expect(supervisor.currentState).toBe("degraded");
      expect(modA.getState()).toBe("ready");
      expect(supervisor.getModuleStatus("B")[0].state).toBe("degraded");
      expect(modC.getState()).toBe("ready");
      await supervisor.stop();
    });

    it("rolls back started modules when critical module fails to start", async () => {
      const orderStopped: string[] = [];
      const modA = createTrackingModule("A", [], {
        onStop: () => orderStopped.push("A"),
      });
      const modB = createTrackingModule("B", ["A"], {
        critical: true,
        shouldFailStart: true,
      });

      const config = DaemonConfigSchema.parse({ logLevel: "silent" });
      const supervisor = new DaemonSupervisor({
        config,
        modules: [modA, modB],
      });

      await expect(supervisor.start()).rejects.toThrow(/Critical module 'B' failed to start/);
      expect(supervisor.currentState).toBe("failed");
      expect(orderStopped).toEqual(["A"]);
    });
  });

  describe("Health aggregation", () => {
    it("reports 'fully-ready' when all modules are ready and healthy", async () => {
      const mod1 = createTrackingModule("mod1");
      const mod2 = createTrackingModule("mod2");

      const config = DaemonConfigSchema.parse({ logLevel: "silent" });
      const supervisor = new DaemonSupervisor({ config, modules: [mod1, mod2] });

      await supervisor.start();
      const health = await supervisor.getHealth();
      expect(health.status).toBe("fully-ready");
      expect(health.modules.mod1.status).toBe("ready");
      expect(health.modules.mod2.status).toBe("ready");
      await supervisor.stop();
    });

    it("returns to ready when modules recover after a degraded startup", async () => {
      const recoveringModule = createTrackingModule("control-plane", [], {
        shouldFailStart: true,
        healthStatus: "ready",
      });
      const config = DaemonConfigSchema.parse({ logLevel: "silent" });
      const supervisor = new DaemonSupervisor({ config, modules: [recoveringModule] });

      await supervisor.start();
      expect(supervisor.currentState).toBe("degraded");

      const health = await supervisor.getHealth();

      expect(health.status).toBe("fully-ready");
      expect(supervisor.currentState).toBe("ready");
      await supervisor.stop();
    });

    it("reports 'cloud-offline' when cloud module is offline", async () => {
      const localMod = createTrackingModule("local-registry");
      const cloudMod = createTrackingModule("cloud-sync", [], { healthStatus: "offline" });

      const config = DaemonConfigSchema.parse({ logLevel: "silent" });
      const supervisor = new DaemonSupervisor({ config, modules: [localMod, cloudMod] });

      await supervisor.start();
      const health = await supervisor.getHealth();
      expect(health.status).toBe("cloud-offline");
      expect(supervisor.currentState).toBe("ready");
      await supervisor.stop();
    });

    it("reports 'adapter-degraded' when adapter module is degraded", async () => {
      const localMod = createTrackingModule("core");
      const adapterMod = createTrackingModule("adapter-claude", [], { healthStatus: "degraded" });

      const config = DaemonConfigSchema.parse({ logLevel: "silent" });
      const supervisor = new DaemonSupervisor({ config, modules: [localMod, adapterMod] });

      await supervisor.start();
      const health = await supervisor.getHealth();
      expect(health.status).toBe("adapter-degraded");
      await supervisor.stop();
    });

    it("reports 'runtime-degraded' when worker runtime module is degraded", async () => {
      const localMod = createTrackingModule("core");
      const runtimeMod = createTrackingModule("runtime-worker", [], { healthStatus: "degraded" });

      const config = DaemonConfigSchema.parse({ logLevel: "silent" });
      const supervisor = new DaemonSupervisor({ config, modules: [localMod, runtimeMod] });

      await supervisor.start();
      const health = await supervisor.getHealth();
      expect(health.status).toBe("runtime-degraded");
      await supervisor.stop();
    });

    it("reports 'upgrade-required' when module signals upgrade is needed", async () => {
      const localMod = createTrackingModule("core", [], {
        healthDetails: { upgradeRequired: true },
      });

      const config = DaemonConfigSchema.parse({ logLevel: "silent" });
      const supervisor = new DaemonSupervisor({ config, modules: [localMod] });

      await supervisor.start();
      const health = await supervisor.getHealth();
      expect(health.status).toBe("upgrade-required");
      await supervisor.stop();
    });
  });

  describe("Module status and diagnostics", () => {
    it("returns module status reports", async () => {
      const modA = createTrackingModule("modA", [], { critical: true });
      const modB = createTrackingModule("modB", ["modA"]);

      const config = DaemonConfigSchema.parse({ logLevel: "silent" });
      const supervisor = new DaemonSupervisor({ config, modules: [modA, modB] });
      await supervisor.start();

      const allStatus = supervisor.getModuleStatus();
      expect(allStatus).toHaveLength(2);
      expect(allStatus[0].id).toBe("modA");
      expect(allStatus[0].critical).toBe(true);
      expect(allStatus[1].id).toBe("modB");
      expect(allStatus[1].dependencies).toEqual(["modA"]);

      const singleStatus = supervisor.getModuleStatus("modA");
      expect(singleStatus).toHaveLength(1);
      expect(singleStatus[0].id).toBe("modA");

      await supervisor.stop();
    });

    it("reloads config and propagates to modules", async () => {
      const mod = createTrackingModule("mod");
      const config = DaemonConfigSchema.parse({ logLevel: "silent", port: 9400 });
      const supervisor = new DaemonSupervisor({ config, modules: [mod] });
      await supervisor.start();

      const reloadRes = await supervisor.reloadConfig({ port: 9500 });
      expect(reloadRes.success).toBe(true);
      expect(reloadRes.reloadedModules).toEqual(["mod"]);
      expect(mod.reloadCalled).toBe(true);
      expect(supervisor.getConfig().port).toBe(9500);

      await supervisor.stop();
    });

    it("generates comprehensive diagnostics report with secret redaction", async () => {
      const mod = createTrackingModule("mod");
      const config = DaemonConfigSchema.parse({
        logLevel: "silent",
        custom: {
          authToken: "secret-token",
        },
      });
      const supervisor = new DaemonSupervisor({ config, modules: [mod] });
      await supervisor.start();

      const diag = await supervisor.getDiagnostics();
      expect(diag.pid).toBe(process.pid);
      expect((diag.config.custom as JsonObject).authToken).toBe("[REDACTED]");
      // SAFETY: Verifies sensitive key is omitted from redacted config.
      expect((diag.config as JsonObject).cloudApiKey).toBeUndefined();
      expect(diag.modules.mod).toEqual({ customInfo: "diagnostics-for-mod" });

      await supervisor.stop();
    });
  });
});
