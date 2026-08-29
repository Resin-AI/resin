import { describe, expect, it } from "vitest";
import { SecretManager } from "../src/manager.js";
import { EncryptedVaultSecretStore } from "../src/vault.js";

describe("SecretManager", () => {
  it("manages secrets with rotation and metadata listing", async () => {
    const store = new EncryptedVaultSecretStore({ vaultPath: ":memory:" });
    const manager = new SecretManager({ store });

    // Add secret
    const meta1 = await manager.addSecret("NPM_TOKEN", "npm_secret_1111", {
      alias: "NPM_AUTH",
      tags: ["npm", "ci"],
    });

    expect(meta1.name).toBe("NPM_TOKEN");
    expect(meta1.version).toBe(1);
    expect(meta1.fingerprint).toBeDefined();

    // Verify secret was automatically registered in redactor
    expect(manager.redact("Publishing with token npm_secret_1111")).toBe(
      "Publishing with token [REDACTED:NPM_TOKEN]",
    );

    // Rotate secret
    const meta2 = await manager.rotateSecret("NPM_TOKEN", "npm_secret_2222");
    expect(meta2.version).toBe(2);

    // Verify new secret is redacted
    expect(manager.redact("Publishing with token npm_secret_2222")).toBe(
      "Publishing with token [REDACTED:NPM_TOKEN]",
    );

    // List metadata
    const list = await manager.listMetadata();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("NPM_TOKEN");
    // Ensure raw secret is not in metadata
    expect(JSON.stringify(list)).not.toContain("npm_secret");
  });

  it("mediates secret access and restricts disallowed mediation modes", async () => {
    const store = new EncryptedVaultSecretStore({ vaultPath: ":memory:" });
    const manager = new SecretManager({ store });

    await manager.addSecret("HEADER_KEY", "header-secret-val", {
      allowedMediationModes: ["header_template", "bearer_token"],
      workspaceId: "ws_main",
    });

    // Allowed mode in matching workspace
    const resolvedHeader = await manager.getSecretForMediation(
      "HEADER_KEY",
      "header_template",
      "ws_main",
    );
    expect(resolvedHeader).toBe("header-secret-val");

    // Disallowed mode
    await expect(
      manager.getSecretForMediation("HEADER_KEY", "command_env", "ws_main"),
    ).rejects.toThrow(/Mediation mode 'command_env' is not permitted/);

    // Mismatched workspace
    await expect(
      manager.getSecretForMediation("HEADER_KEY", "header_template", "ws_other"),
    ).rejects.toThrow(/belongs to workspace 'ws_main', not 'ws_other'/);

    // Undeclared secret
    await expect(
      manager.getSecretForMediation("UNKNOWN_KEY", "header_template", "ws_main"),
    ).rejects.toThrow(/Secret 'UNKNOWN_KEY' not found/);
  });

  it("deletes and purges secrets cleanly", async () => {
    const store = new EncryptedVaultSecretStore({ vaultPath: ":memory:" });
    const manager = new SecretManager({ store });

    await manager.addSecret("S1", "secret_one_val");
    await manager.addSecret("S2", "secret_two_val");

    expect(await manager.deleteSecret("S1")).toBe(true);
    expect(await manager.hasSecret("S1")).toBe(false);

    expect(await manager.purgeSecrets()).toBe(1);
    expect(await manager.listMetadata()).toHaveLength(0);
  });
});
