import { describe, expect, it } from "vitest";
import {
  PLACEHOLDER_HOME,
  PLACEHOLDER_PROJECT,
  findMachineLeak,
  machineReplacements,
  scrubString,
  scrubTranscriptText,
} from "./scrub.mjs";

const windows = () =>
  machineReplacements({
    home: "C:\\Users\\alice",
    user: "alice",
    host: "DESKTOP-7Q2M9ZK",
    domain: "CONTOSO",
    project: "C:\\Users\\alice\\src\\proj",
  });

describe("fixture scrubbing of Windows captures", () => {
  it.each([
    ["the project", "cd C:\\Users\\alice\\src\\proj\\lib", "cd C:\\workspace\\project\\lib"],
    ["the home", "type C:\\Users\\alice\\.gitconfig", "type C:\\Users\\user\\.gitconfig"],
    ["another letter case", "dir c:\\USERS\\Alice\\x", "dir C:\\Users\\user\\x"],
    ["forward slashes", "code c:/users/alice/a.ts", "code C:/Users/user/a.ts"],
    ["JSON escaping", '"C:\\\\Users\\\\alice\\\\x"', '"C:\\\\Users\\\\user\\\\x"'],
    ["a long path", "\\\\?\\C:\\Users\\alice\\y", "C:\\Users\\user\\y"],
    ["a WSL mount", "ls /mnt/c/Users/alice/src/proj/a", "ls /workspace/project/a"],
    ["a Git Bash mount", "ls /c/Users/alice/notes", "ls /home/user/notes"],
    [
      "an encoded project directory",
      "C--Users-alice-src-proj/1.jsonl",
      "C--workspace-project/1.jsonl",
    ],
    ["domain, user and host", "CONTOSO\\ALICE on desktop-7q2m9zk", "domain\\user on host"],
  ])("rewrites %s", (_label, text, expected) => {
    const replacements = windows();
    const scrubbed = scrubString(text, replacements, []);
    expect(scrubbed).toBe(expected);
    expect(findMachineLeak(scrubbed, replacements)).toBeUndefined();
  });

  it("scrubs a JSON Lines capture whose values hold nested, escaped Windows paths", () => {
    const record = {
      cwd: "C:\\Users\\alice\\src\\proj",
      input: JSON.stringify({ command: "type C:\\Users\\alice\\src\\proj\\a.txt" }),
    };
    const replacements = windows();
    const scrubbed = scrubTranscriptText(`${JSON.stringify(record)}\n`, replacements);
    expect(scrubbed).not.toMatch(/alice/i);
    expect(JSON.parse(scrubbed.trim())).toEqual({
      cwd: "C:\\workspace\\project",
      input: JSON.stringify({ command: "type C:\\workspace\\project\\a.txt" }),
    });
    expect(findMachineLeak(scrubbed, replacements)).toBeUndefined();
  });

  it("reports a Windows spelling that survived", () => {
    expect(findMachineLeak("C:/USERS/ALICE", windows())).toBeDefined();
  });

  it("keeps POSIX captures scrubbed as before", () => {
    const replacements = machineReplacements({
      home: "/home/chris",
      user: "chris",
      host: "devbox",
      project: "/tmp/cap-proj",
    });
    expect(
      scrubString(
        "cd /tmp/cap-proj && cat /home/chris/.x -tmp-cap-proj chris@devbox",
        replacements,
        [],
      ),
    ).toBe(`cd ${PLACEHOLDER_PROJECT} && cat ${PLACEHOLDER_HOME}/.x -workspace-project user@host`);
  });
});
