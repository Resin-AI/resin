import { describe, expect, it } from "vitest";
import { inputRoleName, tokenizeProgram, valueFlag } from "../src/index.js";

/** The role name of the word at `index` of a recorded shell command, as the device names it. */
function roleAt(source: string, index: number): string {
  const tokens = tokenizeProgram("shell", source);
  const flag = valueFlag(tokens, index);
  return inputRoleName([
    { value: tokens[index]!.value as string, ...(flag === undefined ? {} : { flag }) },
  ]);
}

describe("input role names", () => {
  it("names a value after a boolean switch by its own role, never the switch", () => {
    // Copilot's recorded changelog job: `--oneline` takes no value.
    expect(roleAt("git log --oneline v0.1..HEAD", 3)).toBe("revision_range");
    expect(roleAt("git log --oneline HEAD~2..HEAD", 3)).toBe("revision_range");
    expect(roleAt("git diff --no-color main...topic", 3)).toBe("revision_range");
  });

  it("treats a flag the same command follows with another flag as a switch", () => {
    expect(roleAt("tool --fast --fast out/a.json", 3)).toBe("config_path");
    expect(roleAt("tool --fast --verbose out/a.txt", 3)).toBe("document_path");
  });

  it("keeps a value flag's name and names a -n value a count", () => {
    expect(roleAt("aws s3 ls --region eu-west-1", 4)).toBe("region");
    expect(roleAt("head -n 5 notes.md", 2)).toBe("count");
  });
});
