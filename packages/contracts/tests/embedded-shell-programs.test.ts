import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type EmbeddedProgram,
  applyProgramTokenValues,
  embeddedPrograms,
  programTokenValueAt,
  tokenizeProgram,
} from "../src/program-tokens.js";

/**
 * A POSIX shell program another shell runs from one quoted word: `ssh host '<program>'`,
 * `bash -c '<program>'`, `docker exec <c> sh -c '<program>'`. Its plain tokens are bindable; a
 * bound value is rendered as data for the inner shell, then escaped for the outer quoted word.
 */

function only(source: string): EmbeddedProgram {
  const programs = embeddedPrograms(source);
  expect(programs, source).toHaveLength(1);
  return programs[0]!;
}

function indexOf(program: EmbeddedProgram, raw: string): number {
  const index = program.tokens.findIndex((token) => token.raw === raw);
  if (index < 0) throw new Error(`no embedded token ${raw}`);
  return index;
}

function bind(source: string, raw: string, value: string): string {
  const program = only(source);
  return applyProgramTokenValues(
    source,
    tokenizeProgram("shell", source),
    new Map(),
    "shell",
    new Map([[program.anchor, new Map([[indexOf(program, raw), value]])]]),
  );
}

/** The program text a rendered ssh command hands the remote shell: its one command word, decoded. */
function remoteProgram(rendered: string): string {
  return tokenizeProgram("shell", rendered)[only(rendered).anchor]!.value as string;
}

const HOSTILE = [
  "it's",
  'say "hi"',
  "$(touch PWNED)",
  "`touch PWNED`",
  "a; touch PWNED",
  "a && touch PWNED",
  "a | touch PWNED",
  "two\nlines; touch PWNED",
  "$HOME and ${HOME}",
  "back\\slash",
  "all ' \" $ \\ ` ; & | < > ( ) * ? ! # ~ %",
];

describe("embedded shell programs", () => {
  it("reads the program of ssh, sh -c, bash -lc and docker exec sh -c", () => {
    const describe = (source: string) => {
      const program = only(source);
      return {
        anchor: tokenizeProgram("shell", source)[program.anchor]!.raw,
        text: source.slice(program.start, program.end),
        context: program.context,
        remote: program.remote ?? false,
      };
    };
    expect(
      describe(
        "ssh -o BatchMode=yes -o ConnectTimeout=10 -p22 host-a 'docker logs --since 2026-01-01T07:30:00Z web-1 2>&1' | cut -c1-400",
      ),
    ).toEqual({
      anchor: "'docker logs --since 2026-01-01T07:30:00Z web-1 2>&1'",
      text: "docker logs --since 2026-01-01T07:30:00Z web-1 2>&1",
      context: "single-quoted",
      remote: true,
    });
    expect(describe(`ssh host-a "journalctl --since '2026-01-01 03:30:00'" 2>&1`)).toEqual({
      anchor: `"journalctl --since '2026-01-01 03:30:00'"`,
      text: "journalctl --since '2026-01-01 03:30:00'",
      context: "double-quoted",
      remote: true,
    });
    expect(describe("bash -lc 'ls -la /data'")).toMatchObject({
      text: "ls -la /data",
      remote: false,
    });
    expect(describe("X=1 sh -c 'ls /data'")).toMatchObject({ text: "ls /data", remote: false });
    expect(
      describe(
        "docker exec -it -e PGOPTIONS=x -u postgres --workdir=/srv db-1 sh -c 'psql -U postgres'",
      ),
    ).toMatchObject({ text: "psql -U postgres", remote: false });
    expect(describe("podman exec db-1 /bin/bash -c 'ls'")).toMatchObject({ text: "ls" });
  });

  it("reads nothing it cannot delimit or whose shell it does not know", () => {
    for (const source of [
      // ssh modes that run no shell command, more than one command word, or an expansion.
      "ssh -N host-a 'ls'",
      "ssh -s host-a sftp",
      "ssh -O exit host-a",
      "ssh host-a ls -la",
      "ssh host-a 'ls' extra",
      `ssh host-a "ls $HOME"`,
      "ssh $HOST 'ls'",
      "ssh host-a '-t ls'",
      "ssh host-a",
      // A quoted word whose content is not its value, or is not one quoted word.
      `bash -c "printf \\"%s\\" x"`,
      "bash -c 'a'\\''b'",
      "bash -c ls",
      // Not a shell's code string, or an option that takes a value before it.
      "echo sh -c 'ls'",
      "bash script.sh 'ls'",
      "bash -o pipefail -c 'ls'",
      "fish -c 'ls'",
      "timeout 5 sh -c 'ls'",
      "docker run img sh -c 'ls'",
      "docker exec --unknown db-1 sh -c 'ls'",
    ]) {
      expect(embeddedPrograms(source), source).toEqual([]);
    }
  });

  it("keeps every top-level token where it was and the code string itself unbindable", () => {
    for (const source of [
      "ssh -o BatchMode=yes host-a 'docker logs web-1'",
      "bash -c 'docker logs web-1'",
      "docker exec db-1 sh -c 'docker logs web-1'",
    ]) {
      const tokens = tokenizeProgram("shell", source);
      expect(tokens.at(-1)!.raw).toBe("'docker logs web-1'");
      expect(tokens.at(-1)!.bindable).toBe(false);
      expect(only(source).anchor).toBe(tokens.length - 1);
    }
    // An ssh command binds no top-level word: ssh joins its words into one remote command line.
    expect(tokenizeProgram("shell", "ssh host-a 'ls'").some((token) => token.bindable)).toBe(false);
  });

  it("binds the inner program's data words and nothing the inner shell would run as code", () => {
    const bindable = (source: string) =>
      only(source)
        .tokens.filter((token) => token.bindable)
        .map((token) => token.raw);
    expect(
      bindable(`ssh host-a 'docker logs --since 2026-01-01T07:30:00Z web-1 2>&1 | cut -c1-400'`),
    ).toEqual(["logs", "--since", "2026-01-01T07:30:00Z", "web-1", "-c1-400"]);
    // The inner program's own evaluators and code strings are refused as they are at top level.
    expect(bindable("ssh host-a 'eval docker logs web-1'")).toEqual([]);
    expect(bindable("ssh host-a 'ssh host-b ls'")).toEqual([]);
    expect(bindable(`bash -c 'python3 -c "print(1)" out.txt'`)).toEqual(["-c", "out.txt"]);
    expect(bindable(`bash -c 'sh -c "ls" x'`)).toEqual(["-c", "x"]);
    expect(programTokenValueAt("shell", "bash -c 'ls /data'", { token: 2, embedded: 1 })).toBe(
      "/data",
    );
  });

  it.each([
    ["bash -c 'printf %s alpha'", "alpha"],
    ['bash -c \'printf "%s" "alpha"\'', '"alpha"'],
    [`sh -c "printf %s 'alpha'"`, "'alpha'"],
    [`sh -c "printf %s alpha"`, "alpha"],
  ])(
    "renders quotes, substitutions, separators and newlines as data both shells pass on: %s",
    (source, raw) => {
      const directory = mkdtempSync(join(tmpdir(), "resin-embedded-shell-"));
      try {
        for (const value of HOSTILE) {
          const rendered = bind(source, raw, value);
          const run = spawnSync("sh", ["-c", rendered], { cwd: directory, encoding: "utf8" });
          expect({ value, stdout: run.stdout, status: run.status }).toEqual({
            value,
            stdout: value,
            status: 0,
          });
        }
        expect(existsSync(join(directory, "PWNED"))).toBe(false);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("passes a docker exec program to the container's shell as recorded, with the value as data", () => {
    const source = "docker exec db-1 sh -c 'printf %s alpha'";
    for (const value of HOSTILE) {
      const rendered = bind(source, "alpha", value);
      // The words docker hands `sh -c`: the decoded code string, run here by sh.
      const code = tokenizeProgram("shell", rendered).at(-1)!.value as string;
      expect(spawnSync("sh", ["-c", code], { encoding: "utf8" }).stdout).toBe(value);
    }
  });

  it("refuses a value that would read as an option the recording never passed", () => {
    const source = "bash -c 'docker logs web-1'";
    expect(() => bind(source, "web-1", "--help")).toThrow(/looks like an option/);
    expect(() => bind(source, "web-1", "-rf")).toThrow(/looks like an option/);
    expect(bind(source, "web-1", "web-2")).toBe("bash -c 'docker logs web-2'");
    // Where the recording passed an option, another option may take its place.
    expect(bind("bash -c 'ls -la /data'", "-la", "-l")).toBe("bash -c 'ls -l /data'");
    expect(() => bind(source, "web-1", "a\0b")).toThrow(/NUL/);
  });

  it("hands a remote shell only values every common shell reads as data", () => {
    const source =
      "ssh -o BatchMode=yes host-a 'journalctl --since \"2026-01-01 03:30:00\" -u web-1'";
    for (const value of [...HOSTILE, "-u", "--help", "50%", "a*", "x@y"]) {
      expect(() => bind(source, '"2026-01-01 03:30:00"', value), value).toThrow();
    }
    for (const value of ["2026-01-02 08:00:00", "web-2", "a,b=c+d/e:f~g_h.i", ""]) {
      const program = remoteProgram(bind(source, '"2026-01-01 03:30:00"', value));
      expect(program).toBe(`journalctl --since "${value}" -u web-1`);
      // Run by the shell at the other end, the value is one word of data.
      const run = spawnSync("sh", ["-c", program.replace("journalctl", "printf %s")], {
        encoding: "utf8",
      });
      expect(run.stdout).toBe(`--since${value}-uweb-1`);
    }
  });

  it("binds a span of an inner token, and the remote limits apply to the composed value", () => {
    const source = `ssh host-a 'journalctl --since "2026-01-01 03:30:00"'`;
    const program = only(source);
    const token = indexOf(program, '"2026-01-01 03:30:00"');
    const apply = (value: string) =>
      applyProgramTokenValues(
        source,
        tokenizeProgram("shell", source),
        new Map(),
        "shell",
        undefined,
        [{ token: program.anchor, embedded: token, span: { start: 0, end: 10 }, value }],
      );
    expect(apply("2026-02-03")).toBe(`ssh host-a 'journalctl --since "2026-02-03 03:30:00"'`);
    expect(() => apply("x'; touch PWNED; '")).toThrow(/remote shell program/);
  });
});
