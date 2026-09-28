import { describe, expect, it } from "vitest";
import { inputRoleName, shellCommandSite, tokenizeProgram, valueFlag } from "../src/index.js";

/** The role name of the word at `index` of a recorded shell command, as the device names it. */
function roleAt(source: string, index: number): string {
  const tokens = tokenizeProgram("shell", source);
  const flag = valueFlag(tokens, index);
  const command = shellCommandSite(tokens, index);
  return inputRoleName([
    {
      value: tokens[index]!.value as string,
      ...(flag === undefined ? {} : { flag }),
      ...(command === undefined ? {} : { command }),
    },
  ]);
}

/** Every non-option word's role in a recorded shell command, keyed by the recorded word. */
function rolesOf(source: string): Record<string, string> {
  const tokens = tokenizeProgram("shell", source);
  const roles: Record<string, string> = {};
  for (const [index, token] of tokens.entries()) {
    if (
      token.kind !== "operator" &&
      index > 0 &&
      !token.raw.startsWith("-") &&
      typeof token.value === "string"
    ) {
      roles[token.value] = roleAt(source, index);
    }
  }
  return roles;
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

  it("names the production backup pair's values by what each command does with them", () => {
    // The two recordings ReportPairing paired on production, as their commands ran.
    expect(rolesOf("mkdir -p backups")).toMatchObject({ backups: "directory" });
    expect(rolesOf("tar -czf backups/zeta-2025-11-19.tar.gz -C data zeta")).toMatchObject({
      "backups/zeta-2025-11-19.tar.gz": "archive_path",
      data: "directory",
      zeta: "folder",
    });
    expect(
      rolesOf("sha256sum backups/zeta-2025-11-19.tar.gz > backups/zeta-2025-11-19.sha256"),
    ).toMatchObject({
      "backups/zeta-2025-11-19.tar.gz": "archive_path",
      "backups/zeta-2025-11-19.sha256": "checksum_path",
    });
    expect(rolesOf("sha256sum -c sums")).toMatchObject({ sums: "checksum_path" });
    expect(rolesOf("cd /w && sha256sum --check SUMS && ls")).toMatchObject({
      SUMS: "checksum_path",
    });
    expect(rolesOf("sha256sum -c sums > report")).toMatchObject({ report: "text" });
    expect(roleAt("mkdir -p backups/2025-11-19", 2)).toBe("directory");
    for (const [source, roles] of Object.entries(
      Object.fromEntries(
        [
          "mkdir -p backups",
          "tar -czf backups/zeta-2025-11-19.tar.gz -C data zeta",
          "sha256sum -c backups/zeta-2025-11-19.sha256",
        ].map((source) => [source, rolesOf(source)]),
      ),
    )) {
      for (const role of Object.values(roles)) expect(role, source).not.toMatch(/^text(_\d+)?$/u);
    }
  });

  it("names a copy's source and destination, and a mkdir operand a directory", () => {
    expect(rolesOf("cp -r reports out")).toMatchObject({
      reports: "source_path",
      out: "destination_path",
    });
    expect(rolesOf("mv a b c")).toMatchObject({
      a: "source_path",
      b: "source_path",
      c: "destination_path",
    });
    expect(rolesOf("cp -t dest one two")).toMatchObject({
      dest: "destination_path",
      one: "source_path",
      two: "source_path",
    });
    expect(rolesOf("mkdir -m 755 build")).toMatchObject({ build: "directory", "755": "number" });
  });

  it("gives command context no say over a span or a command it does not know", () => {
    // Only a whole word has a command role; unknown commands keep the value's own role.
    const tokens = tokenizeProgram("shell", "tar -C data zeta");
    const command = shellCommandSite(tokens, 3)!;
    expect(
      inputRoleName([{ value: "et", token: "zeta", span: { start: 2, end: 4 }, command }]),
    ).toBe("text");
    expect(rolesOf("tar -tzf backups/a.tar.gz")).toMatchObject({
      "backups/a.tar.gz": "archive_path",
    });
    expect(rolesOf("tar -czf out.tgz data")).toMatchObject({ data: "text" });
    expect(rolesOf("./release build alpha")).toMatchObject({ alpha: "text" });
    expect(rolesOf("DEBUG=1 mkdir x")).toMatchObject({ x: "directory" });
  });
});
