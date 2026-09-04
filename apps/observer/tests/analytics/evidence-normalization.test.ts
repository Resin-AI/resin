import { describe, expect, it } from "vitest";
import {
  MAX_PROFILE_LENGTH,
  MAX_PROFILE_TOKENS,
  classifyPathAlias,
  extractAnchoredEditPath,
  normalizeCommandProfile,
  normalizePathPattern,
  projectEnrichedToolParameters,
  tokenizeShellLine,
} from "../../src/analytics/evidence-normalization.js";

const SECRETS = [
  "sk-live-ABCDEF1234567890abcdef",
  "ghp_9fK2mQxT8vLpR4sW7yZ1bN3cH6jD0aE5",
  "hunter2",
  "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc",
  "postgres://admin:s3cr3t@db.internal:5432/prod",
  "fix the auth bug in login flow",
  "AKIAIOSFODNN7EXAMPLE",
  "/home/alice/projects/secret-client/notes.md",
  "alice",
];

const PLACEHOLDER =
  /^\$(STR|URL|NUM|GLOB|PATH|SRC_FILE|TEST_FILE|CONFIG_FILE|DOC_FILE|BUILD_DIR|TMP_DIR)$/;
const FLAG = /^-{1,2}[A-Za-z][\w-]*(=\$[A-Z_]+)?$/;
const OPERATOR = /^(&&|\|\||\||;|>|>>|<|2>|2>>|2>&1|&>|1>)$/;
const EXE = /^[a-z0-9_.+-]{1,32}$/;
const ENV_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=\$STR$/;

function assertVocabulary(profile: string): void {
  for (const token of profile.split(" ")) {
    const ok =
      PLACEHOLDER.test(token) ||
      FLAG.test(token) ||
      OPERATOR.test(token) ||
      EXE.test(token) ||
      ENV_PREFIX.test(token);
    expect(ok, `token '${token}' escaped the vocabulary in '${profile}'`).toBe(true);
  }
}

describe("normalizeCommandProfile", () => {
  it("keeps executable, subcommands and flags; collapses values", () => {
    expect(normalizeCommandProfile('git commit -m "fix auth bug"')).toBe("git commit -m $STR");
    expect(normalizeCommandProfile("pnpm test src/auth/login.test.ts")).toBe(
      "pnpm test $TEST_FILE",
    );
    expect(normalizeCommandProfile("git status --porcelain")).toBe("git status --porcelain");
    expect(normalizeCommandProfile("npm run build")).toBe("npm run build");
    expect(normalizeCommandProfile("node scripts/migrate.js --dry-run")).toBe(
      "node $SRC_FILE --dry-run",
    );
  });

  it("splits composite commands and keeps operators", () => {
    expect(
      normalizeCommandProfile("git add -A && git commit -m 'x' || echo failed | tee out.log"),
    ).toBe("git add -A && git commit -m $STR || echo $STR | tee $PATH");
    expect(normalizeCommandProfile("cd /tmp/x; ls -la")).toBe("cd $TMP_DIR ; ls -la");
  });

  it("handles redirections, env prefixes, urls, numbers and globs", () => {
    expect(normalizeCommandProfile("pytest -x 2>&1 > /tmp/log.txt")).toBe(
      "pytest -x 2>&1 > $TMP_DIR",
    );
    expect(normalizeCommandProfile("NODE_ENV=production node server.js")).toBe(
      "NODE_ENV=$STR node $SRC_FILE",
    );
    expect(normalizeCommandProfile("curl -sS https://api.example.com/v1?x=1")).toBe(
      "curl -sS $URL",
    );
    expect(normalizeCommandProfile("sleep 30")).toBe("sleep $NUM");
    expect(normalizeCommandProfile("rm -rf dist/*.js")).toBe("rm -rf $GLOB");
    expect(normalizeCommandProfile("grep -n TODO --include=*.ts -r src")).toBe(
      "grep -n $STR --include=$GLOB -r $STR",
    );
  });

  it("does not treat positional words after a flag as subcommands", () => {
    expect(normalizeCommandProfile("git commit -m hunter2")).toBe("git commit -m $STR");
    expect(normalizeCommandProfile("echo -n secretword")).toBe("echo -n $STR");
  });

  it("caps subcommand slots at two", () => {
    expect(normalizeCommandProfile("aws s3 cp bucket target")).toBe("aws s3 cp $STR $STR");
  });

  it("unwraps sudo/env style wrappers", () => {
    expect(normalizeCommandProfile("sudo apt-get install -y jq")).toBe(
      "sudo apt-get install -y $STR",
    );
  });

  it("drops heredoc bodies and comment lines", () => {
    const script = "cat > notes.md <<'EOF'\nthis is private text\nEOF\n# comment\nls";
    expect(normalizeCommandProfile(script)).toBe("cat > $DOC_FILE");
  });

  it("treats multi-line scripts as sequenced commands", () => {
    expect(normalizeCommandProfile("git fetch\ngit rebase origin/main")).toBe(
      "git fetch ; git rebase $PATH",
    );
  });

  it("is bounded", () => {
    const long = `echo ${"word ".repeat(200)}`;
    const profile = normalizeCommandProfile(long);
    expect(profile.split(" ").length).toBeLessThanOrEqual(MAX_PROFILE_TOKENS);
    expect(profile.length).toBeLessThanOrEqual(MAX_PROFILE_LENGTH);
    expect(normalizeCommandProfile("")).toBe("");
    expect(normalizeCommandProfile(undefined)).toBe("");
    expect(normalizeCommandProfile("   \n  ")).toBe("");
  });

  it("is deterministic", () => {
    const input = "pnpm exec vitest run tests/a.test.ts --reporter=json > /tmp/out.json";
    expect(normalizeCommandProfile(input)).toBe(normalizeCommandProfile(input));
  });

  it("never leaks secrets or free text in any argument position", () => {
    // The executable basename itself is intentionally retained (it is the
    // primary signal); every argument position is covered below.
    const templates = [
      (s: string) => `echo ${s}`,
      (s: string) => `git commit -m "${s}"`,
      (s: string) => `git commit -m ${s}`,
      (s: string) => `curl -H "Authorization: ${s}" ${s}`,
      (s: string) => `export TOKEN=${s}`,
      (s: string) => `node -e '${s}'`,
      (s: string) => `cat ${s} | grep ${s} > ${s}`,
      (s: string) => `git push origin ${s}`,
      (s: string) => `psql ${s} -c "${s}"`,
      (s: string) => `x=${s} y=${s} cmd ${s}`,
    ];
    for (const secret of SECRETS) {
      for (const make of templates) {
        const profile = normalizeCommandProfile(make(secret));
        assertVocabulary(profile);
        for (const fragment of secret.split(/[\s/@:.-]+/).filter((f) => f.length >= 5)) {
          expect(
            profile,
            `leaked '${fragment}' from '${make(secret)}' -> '${profile}'`,
          ).not.toContain(fragment);
        }
      }
    }
  });
});

describe("tokenizeShellLine", () => {
  it("keeps quoted regions as single flagged tokens", () => {
    expect(tokenizeShellLine(`a "b c" 'd e' f`)).toEqual([
      { text: "a", quoted: false },
      { text: "b c", quoted: true },
      { text: "d e", quoted: true },
      { text: "f", quoted: false },
    ]);
  });

  it("does not split operators inside quotes", () => {
    expect(tokenizeShellLine(`grep "a|b" x && y`).map((t) => t.text)).toEqual([
      "grep",
      "a|b",
      "x",
      "&&",
      "y",
    ]);
  });
});

describe("normalizePathPattern", () => {
  it("strips the home directory and keeps only trailing segments", () => {
    expect(normalizePathPattern("/home/alice/work/repo/src/auth/login.ts", "/home/alice")).toBe(
      "…/repo/src/auth/login.ts",
    );
    expect(normalizePathPattern("src/auth/login.ts")).toBe("src/auth/login.ts");
    expect(normalizePathPattern("a/b/c/d/e/f.ts")).toBe("…/c/d/e/f.ts");
  });

  it("replaces identifier-like segments", () => {
    expect(normalizePathPattern("runs/20260903T051407Z/out/report.json")).toBe(
      "runs/*/out/report.json",
    );
    expect(normalizePathPattern("cache/3fa85f64-5717-4562-b3fc-2c963f66afa6/x.json")).toBe(
      "cache/*/x.json",
    );
    expect(normalizePathPattern("build/deadbeefcafe1234/a.js")).toBe("build/*/a.js");
    expect(normalizePathPattern("releases/v1.2.3/notes.md")).toBe("releases/*/notes.md");
  });

  it("never emits the user name from an absolute home path", () => {
    const pattern = normalizePathPattern("/home/alice/x.ts", "/home/alice");
    expect(pattern).not.toContain("alice");
    expect(normalizePathPattern("/Users/alice/x.ts", "/Users/alice")).not.toContain("alice");
  });

  it("handles urls, blanks and non-strings", () => {
    expect(normalizePathPattern("https://example.com/a")).toBe("$URL");
    expect(normalizePathPattern("")).toBe("$PATH");
    expect(normalizePathPattern(42)).toBe("$PATH");
  });
});

describe("classifyPathAlias", () => {
  it("matches the cloud vocabulary", () => {
    expect(classifyPathAlias("src/a.test.ts")).toBe("$TEST_FILE");
    expect(classifyPathAlias("package.json")).toBe("$CONFIG_FILE");
    expect(classifyPathAlias("/tmp/x")).toBe("$TMP_DIR");
    expect(classifyPathAlias("dist/index.js")).toBe("$BUILD_DIR");
    expect(classifyPathAlias("README.md")).toBe("$DOC_FILE");
    expect(classifyPathAlias("src/index.ts")).toBe("$SRC_FILE");
    expect(classifyPathAlias("data/records.csv")).toBe("$PATH");
  });
});

describe("extractAnchoredEditPath", () => {
  it("extracts the path from a hashline header", () => {
    expect(extractAnchoredEditPath("[src/foo.ts#A1B2]\nPUT 1.=1:\n+x")).toBe("src/foo.ts");
    expect(extractAnchoredEditPath("no header")).toBeUndefined();
    expect(extractAnchoredEditPath(3)).toBeUndefined();
  });
});

describe("projectEnrichedToolParameters", () => {
  it("projects shell tools to a command profile and cwd pattern", () => {
    const res = projectEnrichedToolParameters(
      "bash",
      {
        command: 'pnpm test src/a.test.ts && git commit -m "done"',
        cwd: "/home/alice/repo",
        i: "run tests",
        timeout: 30,
      },
      { homeDir: "/home/alice" },
    );
    expect(res).toEqual({
      parameters: { command: "pnpm test $TEST_FILE && git commit -m $STR", cwd: "…/repo" },
      maskedFields: ["command", "cwd"],
    });
  });

  it("projects path parameters for file tools and ignores content", () => {
    const res = projectEnrichedToolParameters("write", {
      path: "src/utils/format.ts",
      content: "export const secret = 'abc';",
      i: "write",
    });
    expect(res).toEqual({
      parameters: { path: "src/utils/format.ts" },
      maskedFields: ["path"],
    });
    expect(JSON.stringify(res)).not.toContain("secret");
  });

  it("recovers the path from anchored edit payloads", () => {
    const res = projectEnrichedToolParameters("edit", {
      input: "[apps/x/src/a.ts#1A2B]\nPUT 3.=3:\n+const token = 'sk-live';",
    });
    expect(res).toEqual({ parameters: { path: "apps/x/src/a.ts" }, maskedFields: ["input"] });
    expect(JSON.stringify(res)).not.toContain("sk-live");
  });

  it("returns null when nothing enrichable is present", () => {
    expect(projectEnrichedToolParameters("hub", { op: "list" })).toBeNull();
    expect(projectEnrichedToolParameters("bash", { command: "" })).toBeNull();
    expect(projectEnrichedToolParameters("bash", null)).toBeNull();
    expect(projectEnrichedToolParameters("bash", "command")).toBeNull();
  });

  it("does not treat non-shell tools' command keys as shell commands", () => {
    expect(projectEnrichedToolParameters("hub", { command: "rm -rf /" })).toBeNull();
  });
});
