import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkOwnerOnly } from "@resin/windows-security";
import { PROBE_ACCESS, probeOpenWithUserSidDisabled } from "@resin/windows-security/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EncryptedVaultSecretStore } from "../src/vault.js";

describe("EncryptedVaultSecretStore", () => {
  let tmpDir: string;
  let vaultPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault_test_"));
    vaultPath = path.join(tmpDir, "test-vault.enc");
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("stores and retrieves secrets in in-memory mode", async () => {
    const store = new EncryptedVaultSecretStore({ vaultPath: ":memory:" });
    const meta = await store.setSecret("API_KEY", "super-secret-12345", {
      alias: "OPENAI_KEY",
      tags: ["ai", "production"],
    });

    expect(meta.name).toBe("API_KEY");
    expect(meta.alias).toBe("OPENAI_KEY");
    expect(meta.version).toBe(1);
    expect(meta.fingerprint).toBeDefined();

    const retrievedByName = await store.getSecret("API_KEY");
    expect(retrievedByName).toBe("super-secret-12345");

    const retrievedByAlias = await store.getSecret("OPENAI_KEY");
    expect(retrievedByAlias).toBe("super-secret-12345");

    const hasSecret = await store.hasSecret("API_KEY");
    expect(hasSecret).toBe(true);

    const hasAlias = await store.hasSecret("OPENAI_KEY");
    expect(hasAlias).toBe(true);
  });

  it("persists encrypted secrets on disk with 0600 permissions", async () => {
    const store1 = new EncryptedVaultSecretStore({
      vaultPath,
      passphrase: "master-passphrase-test",
    });

    await store1.setSecret("DATABASE_URL", "postgres://user:pass@localhost:5432/db", {
      workspaceId: "ws_123",
      allowedMediationModes: ["command_env"],
    });

    expect(fs.existsSync(vaultPath)).toBe(true);
    if (process.platform === "win32") {
      // Windows: an owner-only DACL that every other principal is denied by.
      expect(checkOwnerOnly(vaultPath)).toMatchObject({ ok: true, problems: [] });
      expect(probeOpenWithUserSidDisabled(vaultPath, PROBE_ACCESS.read).win32Error).toBe(5);
    } else {
      const stat = fs.statSync(vaultPath);
      // 0o600 in octal is (stat.mode & 0o777)
      expect(stat.mode & 0o777).toBe(0o600);
    }

    // Verify plaintext is not stored raw in the file
    const rawContent = fs.readFileSync(vaultPath, "utf-8");
    expect(rawContent).not.toContain("postgres://user:pass");
    expect(rawContent).toContain("DATABASE_URL");

    // Load with a new instance using the same passphrase
    const store2 = new EncryptedVaultSecretStore({
      vaultPath,
      passphrase: "master-passphrase-test",
    });

    const retrieved = await store2.getSecret("DATABASE_URL", "ws_123");
    expect(retrieved).toBe("postgres://user:pass@localhost:5432/db");
  });

  it("fails decryption when provided incorrect passphrase or corrupted data", async () => {
    const store1 = new EncryptedVaultSecretStore({
      vaultPath,
      passphrase: "correct-passphrase",
    });

    await store1.setSecret("SECRET_VAL", "my-confidential-token");

    const storeBad = new EncryptedVaultSecretStore({
      vaultPath,
      passphrase: "wrong-passphrase",
    });

    await expect(storeBad.getSecret("SECRET_VAL")).rejects.toThrow();
  });

  it("enforces workspace isolation", async () => {
    const store = new EncryptedVaultSecretStore({ vaultPath: ":memory:" });

    await store.setSecret("SHARED_NAME", "val_ws1", { workspaceId: "ws_alpha" });
    await store.setSecret("SHARED_NAME_2", "val_ws2", { workspaceId: "ws_beta" });

    // Lookup with matching workspace
    expect(await store.getSecret("SHARED_NAME", "ws_alpha")).toBe("val_ws1");
    // Lookup with mismatched workspace
    expect(await store.getSecret("SHARED_NAME", "ws_beta")).toBeNull();

    // Listing by workspace
    const listAlpha = await store.listMetadata("ws_alpha");
    expect(listAlpha).toHaveLength(1);
    expect(listAlpha[0].name).toBe("SHARED_NAME");

    const listBeta = await store.listMetadata("ws_beta");
    expect(listBeta).toHaveLength(1);
    expect(listBeta[0].name).toBe("SHARED_NAME_2");
  });

  it("handles deletion and purging", async () => {
    const store = new EncryptedVaultSecretStore({ vaultPath: ":memory:" });

    await store.setSecret("KEY1", "v1", { workspaceId: "ws_1" });
    await store.setSecret("KEY2", "v2", { workspaceId: "ws_1" });
    await store.setSecret("KEY3", "v3", { workspaceId: "ws_2" });

    expect(await store.deleteSecret("KEY1", "ws_1")).toBe(true);
    expect(await store.getSecret("KEY1", "ws_1")).toBeNull();

    // Purge workspace 1
    const purgedWs1 = await store.purgeSecrets("ws_1");
    expect(purgedWs1).toBe(1);

    expect(await store.hasSecret("KEY2", "ws_1")).toBe(false);
    expect(await store.hasSecret("KEY3", "ws_2")).toBe(true);

    // Global purge
    const purgedAll = await store.purgeSecrets();
    expect(purgedAll).toBe(1);
    expect(await store.listMetadata()).toHaveLength(0);
  });
});

describe.runIf(process.platform === "win32")("EncryptedVaultSecretStore on Windows", () => {
  const EVERYONE = "S-1-1-0";
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault_win_"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function exposeToEveryone(target: string, directory: boolean): void {
    const grant = directory ? `*${EVERYONE}:(OI)(CI)(F)` : `*${EVERYONE}:(R)`;
    execFileSync("icacls", [target, "/grant", grant], { stdio: "ignore" });
  }

  it("hardens an existing exposed vault directory before storing anything in it", async () => {
    const vaultDir = path.join(tmpDir, "exposed");
    fs.mkdirSync(vaultDir);
    exposeToEveryone(vaultDir, true);
    expect(checkOwnerOnly(vaultDir).ok).toBe(false);

    const vaultPath = path.join(vaultDir, "vault.enc");
    const store = new EncryptedVaultSecretStore({ vaultPath, passphrase: "p" });
    await store.setSecret("TOKEN", "secret-value");

    expect(checkOwnerOnly(vaultDir, { requireProtected: true })).toMatchObject({ ok: true });
    // The vault file carries its own protected owner-only DACL from its creation.
    expect(checkOwnerOnly(vaultPath, { requireProtected: true })).toMatchObject({ ok: true });
    expect(probeOpenWithUserSidDisabled(vaultPath, PROBE_ACCESS.read).win32Error).toBe(5);
    expect(fs.readdirSync(vaultDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(await store.getSecret("TOKEN")).toBe("secret-value");
  });

  it("repairs an exposed vault file this user owns before reading secrets from it", async () => {
    const vaultPath = path.join(tmpDir, "vault.enc");
    const writer = new EncryptedVaultSecretStore({ vaultPath, passphrase: "p" });
    await writer.setSecret("TOKEN", "secret-value");
    exposeToEveryone(vaultPath, false);
    expect(probeOpenWithUserSidDisabled(vaultPath, PROBE_ACCESS.read).ok).toBe(true);

    const reader = new EncryptedVaultSecretStore({ vaultPath, passphrase: "p" });
    expect(await reader.getSecret("TOKEN")).toBe("secret-value");
    expect(checkOwnerOnly(vaultPath)).toMatchObject({ ok: true });
    expect(probeOpenWithUserSidDisabled(vaultPath, PROBE_ACCESS.read).win32Error).toBe(5);
  });

  it("refuses a vault path that is not a regular file", async () => {
    const vaultPath = path.join(tmpDir, "vault.enc");
    fs.mkdirSync(vaultPath);
    const store = new EncryptedVaultSecretStore({ vaultPath, passphrase: "p" });
    await expect(store.getSecret("TOKEN")).rejects.toThrow(/not a regular file/);
  });
});
