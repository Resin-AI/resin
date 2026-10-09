import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/bin/cli.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-cli-suggest-"));
  dirs.push(dir);
  return dir;
}

function capture() {
  let text = "";
  return {
    stream: {
      write: (chunk: string) => {
        text += chunk;
        return true;
      },
    },
    text: () => text,
  };
}

describe("resin suggest", () => {
  it("switches suggestions off and on through the CLI", async () => {
    const env = { RESIN_STATE_DIR: tempStateDir(), DO_NOT_TRACK: "1" };
    const off = capture();
    expect(await main(["suggest", "--disable"], { env, stdout: off.stream })).toBe(0);
    expect(off.text()).toContain("off");
    expect(fs.existsSync(path.join(env.RESIN_STATE_DIR, "command-suggest", "disabled"))).toBe(true);
    const status = capture();
    expect(await main(["suggest", "--status"], { env, stdout: status.stream })).toBe(0);
    expect(status.text()).toBe("Resin command suggestions are off.\n");
    expect(await main(["suggest", "--enable"], { env, stdout: capture().stream })).toBe(0);
    expect(fs.existsSync(path.join(env.RESIN_STATE_DIR, "command-suggest", "disabled"))).toBe(
      false,
    );
  });

  it("is listed in the global help", async () => {
    const out = capture();
    await main(["--help"], { stdout: out.stream });
    expect(out.text()).toMatch(/\n {2}suggest {6}/u);
  });

  const launcher = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/resin.mjs");
  const built = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../gateway/dist/suggest/index.js",
  );
  it.skipIf(!fs.existsSync(built))(
    "the launcher answers a hook payload without loading the CLI, exiting 0 with no output",
    () => {
      const env = { ...process.env, RESIN_STATE_DIR: tempStateDir(), DO_NOT_TRACK: "1" };
      const payload = JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "npx vitest run" },
        cwd: os.tmpdir(),
      });
      const result = spawnSync(
        process.execPath,
        [launcher, "suggest", "--harness", "claude-code"],
        {
          input: payload,
          env,
          encoding: "utf8",
        },
      );
      expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
        status: 0,
        stdout: "",
        stderr: "",
      });
      const prompt = spawnSync(
        process.execPath,
        [launcher, "suggest", "--prompt", "--harness", "claude-code"],
        {
          input: JSON.stringify({
            hook_event_name: "UserPromptSubmit",
            prompt: "run the tests",
            cwd: os.tmpdir(),
          }),
          env,
          encoding: "utf8",
        },
      );
      expect({ status: prompt.status, stdout: prompt.stdout, stderr: prompt.stderr }).toEqual({
        status: 0,
        stdout: "",
        stderr: "",
      });
    },
  );
});
