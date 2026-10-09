import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NodeConfigFsBridge } from "@resin/harness-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  claudeCommandSuggestExtension,
  editClaudeSettingsDocument,
  installClaudeCommandSuggest,
  renderClaudeCommandSuggestCommand,
  resolveClaudeSettingsPath,
  uninstallClaudeCommandSuggest,
  verifyClaudeCommandSuggest,
} from "../src/command-suggest.js";
import { claudeCodeInstallHarness } from "../src/install.js";

const fsBridge = new NodeConfigFsBridge();
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function tempHome(): { home: string; env: NodeJS.ProcessEnv; settingsPath: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-claude-suggest-"));
  homes.push(home);
  const env: NodeJS.ProcessEnv = {};
  return { home, env, settingsPath: resolveClaudeSettingsPath(home, env) };
}

function backups(settingsPath: string): string[] {
  return fs
    .readdirSync(path.dirname(settingsPath))
    .filter((name) => name.startsWith("settings.json.resin-backup."));
}

const USER_SETTINGS = {
  model: "example-model",
  permissions: { allow: ["Bash(npm test:*)"] },
  hooks: {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/audit-bash" }] },
    ],
    Stop: [{ hooks: [{ type: "command", command: "notify-done" }] }],
  },
  env: { EXAMPLE: "1" },
};

describe("Claude Code command-suggest hook installer", () => {
  it("is registered as a Claude Code install extension", () => {
    expect(claudeCodeInstallHarness.installExtensions).toContain(claudeCommandSuggestExtension);
  });

  it("creates settings with one PreToolUse Bash hook and one UserPromptSubmit hook", async () => {
    const { home, env, settingsPath } = tempHome();
    const [result] = await installClaudeCommandSuggest({ home, env, fsBridge });
    expect(result).toEqual({ path: settingsPath, action: "created" });
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(settings).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: `'${path.join(home, ".resin", "bin", "resin")}' suggest --harness claude-code`,
                timeout: 5,
              },
            ],
          },
        ],
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: `'${path.join(home, ".resin", "bin", "resin")}' suggest --prompt --harness claude-code`,
                timeout: 5,
              },
            ],
          },
        ],
      },
    });
    expect(await verifyClaudeCommandSuggest({ home, env, fsBridge })).toBe(true);
    expect(backups(settingsPath)).toEqual([]);
  });

  it("is idempotent, preserves the user's settings and hooks, and backs up before changing them", async () => {
    const { home, env, settingsPath } = tempHome();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const original = `${JSON.stringify(USER_SETTINGS, null, 2)}\n`;
    fs.writeFileSync(settingsPath, original);

    expect((await installClaudeCommandSuggest({ home, env, fsBridge }))[0]?.action).toBe("updated");
    const installed = fs.readFileSync(settingsPath, "utf8");
    const settings = JSON.parse(installed);
    expect(Object.keys(settings)).toEqual(["model", "permissions", "hooks", "env"]);
    expect(settings.hooks.Stop).toEqual(USER_SETTINGS.hooks.Stop);
    expect(settings.hooks.PreToolUse[0]).toEqual(USER_SETTINGS.hooks.PreToolUse[0]);
    expect(settings.hooks.PreToolUse).toHaveLength(2);
    const [backup] = backups(settingsPath);
    expect(backup).toBeDefined();
    expect(fs.readFileSync(path.join(path.dirname(settingsPath), backup ?? ""), "utf8")).toBe(
      original,
    );

    expect((await installClaudeCommandSuggest({ home, env, fsBridge }))[0]?.action).toBe(
      "unchanged",
    );
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(installed);
    expect(backups(settingsPath)).toHaveLength(1);
  });

  it("dry run reports the change without writing", async () => {
    const { home, env, settingsPath } = tempHome();
    const [result] = await installClaudeCommandSuggest({ home, env, fsBridge, dryRun: true });
    expect(result?.action).toBe("created");
    expect(fs.existsSync(settingsPath)).toBe(false);
  });

  it("uninstall removes only Resin's hook and restores the user's document", async () => {
    const { home, env, settingsPath } = tempHome();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, `${JSON.stringify(USER_SETTINGS, null, 2)}\n`);
    await installClaudeCommandSuggest({ home, env, fsBridge });

    expect((await uninstallClaudeCommandSuggest({ home, env, fsBridge }))[0]?.action).toBe(
      "removed",
    );
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toEqual(USER_SETTINGS);
    expect(await verifyClaudeCommandSuggest({ home, env, fsBridge })).toBe(false);
    expect((await uninstallClaudeCommandSuggest({ home, env, fsBridge }))[0]?.action).toBe(
      "unchanged",
    );
  });

  it("uninstall removes settings that held only Resin's hook, and keeps the user's other keys", async () => {
    const { home, env, settingsPath } = tempHome();
    await installClaudeCommandSuggest({ home, env, fsBridge });
    await uninstallClaudeCommandSuggest({ home, env, fsBridge });
    expect(fs.existsSync(settingsPath)).toBe(false);
    expect(backups(settingsPath)).toEqual([]);

    fs.writeFileSync(settingsPath, JSON.stringify({ model: "example-model" }));
    await installClaudeCommandSuggest({ home, env, fsBridge });
    await uninstallClaudeCommandSuggest({ home, env, fsBridge });
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toEqual({ model: "example-model" });
    const missing = tempHome();
    expect((await uninstallClaudeCommandSuggest({ ...missing, fsBridge }))[0]?.action).toBe(
      "unchanged",
    );
    expect(fs.existsSync(missing.settingsPath)).toBe(false);
  });

  it("replaces a hook from a moved Resin home instead of adding a second one", () => {
    const stale = "'/old/home/.resin/bin/resin' suggest --harness claude-code";
    const current = "'/new/home/.resin/bin/resin' suggest --harness claude-code";
    const doc = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "keep-me" },
              { type: "command", command: stale },
            ],
          },
        ],
      },
    };
    const next = editClaudeSettingsDocument(
      doc,
      { command: current, prompt: current.replace("suggest", "suggest --prompt") },
      true,
    );
    expect(next.hooks?.PreToolUse).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: "keep-me" }] },
      { matcher: "Bash", hooks: [{ type: "command", command: current, timeout: 5 }] },
    ]);
  });

  it("adds the prompt hook to an install that predates it, keeping the user's prompt hooks", async () => {
    const { home, env, settingsPath } = tempHome();
    const resin = `'${path.join(home, ".resin", "bin", "resin")}'`;
    const older = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: `${resin} suggest --harness claude-code`, timeout: 5 },
            ],
          },
        ],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "/usr/local/bin/log-prompt" }] }],
      },
    };
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(older));
    // Harness health repairs what verify reports as stale.
    expect(await verifyClaudeCommandSuggest({ home, env, fsBridge })).toBe(false);
    expect((await installClaudeCommandSuggest({ home, env, fsBridge }))[0]?.action).toBe("updated");
    expect(backups(settingsPath)).toHaveLength(1);
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    expect(settings.hooks.PreToolUse).toEqual(older.hooks.PreToolUse);
    expect(settings.hooks.UserPromptSubmit).toEqual([
      { hooks: [{ type: "command", command: "/usr/local/bin/log-prompt" }] },
      {
        hooks: [
          {
            type: "command",
            command: `${resin} suggest --prompt --harness claude-code`,
            timeout: 5,
          },
        ],
      },
    ]);
    expect(await verifyClaudeCommandSuggest({ home, env, fsBridge })).toBe(true);
    expect((await installClaudeCommandSuggest({ home, env, fsBridge }))[0]?.action).toBe(
      "unchanged",
    );

    // A duplicated prompt hook is not verified, and reinstalling leaves one.
    settings.hooks.UserPromptSubmit.push(settings.hooks.UserPromptSubmit[1]);
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    expect(await verifyClaudeCommandSuggest({ home, env, fsBridge })).toBe(false);
    await installClaudeCommandSuggest({ home, env, fsBridge });
    expect(await verifyClaudeCommandSuggest({ home, env, fsBridge })).toBe(true);

    await uninstallClaudeCommandSuggest({ home, env, fsBridge });
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toEqual({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "/usr/local/bin/log-prompt" }] }],
      },
    });
  });

  it("refuses to rewrite settings it cannot parse", async () => {
    const { home, env, settingsPath } = tempHome();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, "{ not json");
    await expect(installClaudeCommandSuggest({ home, env, fsBridge })).rejects.toThrow(
      /not valid JSON/,
    );
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: "x" } }));
    await expect(installClaudeCommandSuggest({ home, env, fsBridge })).rejects.toThrow(
      /not a list/,
    );
    expect(fs.readFileSync(settingsPath, "utf8")).toBe(
      JSON.stringify({ hooks: { PreToolUse: "x" } }),
    );
  });

  it("honours CLAUDE_CONFIG_DIR and RESIN_HOME", async () => {
    const { home } = tempHome();
    const env = {
      CLAUDE_CONFIG_DIR: path.join(home, "claude-config"),
      RESIN_HOME: path.join(home, "resin-home"),
    };
    await installClaudeCommandSuggest({ home, env, fsBridge });
    const settings = JSON.parse(
      fs.readFileSync(path.join(home, "claude-config", "settings.json"), "utf8"),
    );
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(
      `'${path.join(home, "resin-home", "bin", "resin")}' suggest --harness claude-code`,
    );
  });

  it("quotes the launcher for the shell Claude Code runs hooks with", () => {
    expect(
      renderClaudeCommandSuggestCommand(
        {
          command: "/home/o'brien/.resin/bin/resin",
          args: ["suggest", "--harness", "claude-code"],
        },
        "linux",
      ),
    ).toBe(`'/home/o'\\''brien/.resin/bin/resin' suggest --harness claude-code`);
    expect(
      renderClaudeCommandSuggestCommand(
        {
          command: "C:\\Program Files\\nodejs\\node.exe",
          args: [
            "C:\\Users\\example\\.resin\\bin\\resin.mjs",
            "suggest",
            "--harness",
            "claude-code",
          ],
        },
        "win32",
      ),
    ).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\example\\.resin\\bin\\resin.mjs" suggest --harness claude-code',
    );
  });
});
