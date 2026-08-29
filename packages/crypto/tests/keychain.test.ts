import { describe, expect, it } from "vitest";
import {
  LinuxSecretServiceStore,
  MacKeychainSecretStore,
  SystemKeychainStore,
} from "../src/keychain.js";
import { EncryptedVaultSecretStore } from "../src/vault.js";

describe("Keychain & Secret Service Integrations", () => {
  it("MacKeychainSecretStore falls back gracefully to encrypted vault", async () => {
    const fallback = new EncryptedVaultSecretStore({ vaultPath: ":memory:" });
    const store = new MacKeychainSecretStore({ fallbackStore: fallback });

    const meta = await store.setSecret("TEST_SECRET", "mac_secret_val", {
      alias: "MAC_ALIAS",
    });
    expect(meta.name).toBe("TEST_SECRET");

    const retrieved = await store.getSecret("TEST_SECRET");
    expect(retrieved).toBe("mac_secret_val");

    const retrievedByAlias = await store.getSecret("MAC_ALIAS");
    expect(retrievedByAlias).toBe("mac_secret_val");
  });

  it("LinuxSecretServiceStore falls back gracefully to encrypted vault", async () => {
    const fallback = new EncryptedVaultSecretStore({ vaultPath: ":memory:" });
    const store = new LinuxSecretServiceStore({ fallbackStore: fallback });

    const meta = await store.setSecret("LINUX_SECRET", "linux_secret_val");
    expect(meta.name).toBe("LINUX_SECRET");

    const retrieved = await store.getSecret("LINUX_SECRET");
    expect(retrieved).toBe("linux_secret_val");
  });

  it("SystemKeychainStore manages secrets reliably", async () => {
    const fallback = new EncryptedVaultSecretStore({ vaultPath: ":memory:" });
    const store = new SystemKeychainStore({ fallbackStore: fallback });

    await store.setSecret("SYS_SECRET", "system_val_42");
    expect(await store.hasSecret("SYS_SECRET")).toBe(true);
    expect(await store.getSecret("SYS_SECRET")).toBe("system_val_42");

    const list = await store.listMetadata();
    expect(list.some((s) => s.name === "SYS_SECRET")).toBe(true);

    await store.deleteSecret("SYS_SECRET");
    expect(await store.hasSecret("SYS_SECRET")).toBe(false);
  });
});
