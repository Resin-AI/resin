import { createHash } from "node:crypto";
import { tokenizeProgram } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { ContentScanner, RedactionEngine } from "../../src/normalization/index.js";
import { redactProgramSourceInPlace } from "../../src/normalization/program-source-redaction.js";
import { locateReplacements } from "../../src/normalization/redaction-spans.js";

/** Deterministic stand-ins, assembled at runtime so no literal credential shape sits in the source. */
const hex = (seed: string, length = 40) =>
  createHash("sha256").update(seed).digest("hex").slice(0, length);
const base62 = (seed: string, length: number) =>
  createHash("sha512")
    .update(seed)
    .digest("base64")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, length);

const SHA = hex("commit-a");
const OTHER_SHA = hex("commit-b");

function engine() {
  return new RedactionEngine({ homeDir: "/home/developer", environment: {} });
}

function shapes(source: string) {
  return tokenizeProgram("shell", source).map(({ kind, bindable, quote }) => ({
    kind,
    bindable,
    quote,
  }));
}

describe("revision identifiers are not secrets", () => {
  const scanner = new ContentScanner();

  it.each([
    `gh workflow run release.yml --ref main -f commit_sha=${SHA} -f ci_run_id=37248001702`,
    `gh pr merge 302 --squash --match-head-commit ${SHA}`,
    `gh api repos/acme/app/commits/${SHA}/check-runs`,
    `gh run view 37248001702 --log-failed; gh run watch 37248001703`,
    `tool report --run-id 37248001702 --pr 302 --issue 77`,
    `RELEASE_SHA=${SHA} pnpm release:verify`,
    `echo '{"headSha":"${SHA}","number":302}'`,
    `git show ${SHA} && git checkout ${SHA.slice(0, 8)} && git log --oneline -1 ${SHA}`,
    "git show HEAD:studio-plugin/src/modules/handlers/MicroProfilerHandlers.ts",
    `git show ${SHA.slice(0, 8)}:public-core-provenance.json`,
    `git log --oneline ${SHA.slice(0, 8)}..origin/main`,
  ])("keeps %s visible", (command) => {
    expect(scanner.scan(command)).toEqual([]);
  });

  it("still redacts a hex value a secret label or a secret-setting command introduces", () => {
    const value = hex("deploy-key");
    for (const command of [
      `gh secret set DEPLOY_KEY --body ${value}`,
      `export API_KEY_SHA=${value}`,
      `git config core.secret ${value}`,
    ]) {
      expect(scanner.scan(command).map((match) => match.match)).toContain(value);
    }
  });

  it("redacts a hex token in an Authorization header and keeps the commit beside it", () => {
    const token = hex("pat");
    const command = `curl -H "Authorization: token ${token}" https://api.github.com/repos/acme/app/commits/${OTHER_SHA}`;
    const result = engine().redactString(command);
    expect(result.redactedText).not.toContain(token);
    expect(result.redactedText).toContain(OTHER_SHA);
    const bearer = `gh api -H "Authorization: Bearer ${token}" repos/acme/app/commits/${SHA}`;
    const fetched = engine().redactString(bearer).redactedText;
    expect(fetched).not.toContain(token);
    expect(fetched).toContain(SHA);
  });

  it("still redacts known secret formats", () => {
    const secrets = [
      `ghp_${base62("gh", 36)}`,
      `AKIA${base62("aws", 16)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "Q")}`,
      `${["sk", "proj"].join("-")}-${base62("openai", 40)}`,
      `xoxb-1234567890-1234567890-${base62("slack", 24)}`,
    ];
    for (const secret of secrets) {
      const result = engine().redactString(`tool --verbose ${secret} --out data/a.json`);
      expect(result.redactedText).not.toContain(secret);
      expect(result.redactedText).toContain("--out data/a.json");
    }
    const password = base62("db", 14);
    for (const command of [
      `psql postgres://app:${password}@db.internal:5432/main -c "select 1"`,
      `curl -u deploy:${password} https://ci.example.com/api`,
      `DB_PASSWORD=${password} node migrate.mjs`,
      `curl -H "X-Api-Key: ${password}" https://api.example.com/v1/items`,
    ]) {
      expect(engine().redactString(command).redactedText).not.toContain(password);
    }
  });
});

describe("program source spans", () => {
  it("locates each replacement in the original, through a home alias inside a scanned token", () => {
    const key = base62("key", 24);
    const source = `ls /home/developer/notes; tool --api-key ${key} --out data/a.json`;
    const result = engine().redactProgramSource(source);
    expect(result?.spans).toBeDefined();
    const spans = result!.spans!;
    expect(spans.map((span) => source.slice(span.start, span.end))).toEqual([
      "/home/developer",
      key,
    ]);
    expect(spans[0]?.replacement).toBe("$HOME");
  });

  it("locates nothing when the redacted text is not explained by the replacements", () => {
    const replaced = new Map([["[R]", new Set(["secret"])]]);
    expect(locateReplacements("a secret b", "a [R] c", replaced)).toBeUndefined();
    expect(locateReplacements("a secret b", "a [R] b", replaced)).toEqual([
      { start: 2, end: 8, replacement: "[R]" },
    ]);
  });
});

describe("in-place program redaction", () => {
  const redact = (source: string) => {
    const result = engine().redactProgramSource(source);
    if (result?.spans === undefined) throw new Error("expected located spans");
    return {
      whole: result.redactedText,
      inPlace: redactProgramSourceInPlace("shell", source, result.spans),
    };
  };

  it("keeps a command readable except its API key", () => {
    const key = `${["sk", "proj"].join("-")}-${base62("openai", 40)}`;
    const source = `deploy-tool --api-key ${key} --region eu-west-1 --out data/a.json && jq . data/a.json`;
    const { whole, inPlace } = redact(source);
    // The whole-text placeholder turns the bare word into a glob; in place it stays a plain word.
    expect(shapes(whole)).not.toEqual(shapes(source));
    expect(inPlace).toBeDefined();
    expect(inPlace).not.toContain(key);
    expect(inPlace).toMatch(
      /^deploy-tool --api-key \\\[REDACTED_[A-Z_]+:[0-9a-f]+\\\] --region eu-west-1 --out data\/a\.json && jq \. data\/a\.json$/,
    );
    expect(shapes(inPlace!)).toEqual(shapes(source));
  });

  it("keeps the shell grammar an entropy match ran into", () => {
    const value = base62("state", 30);
    const source = `W=/tmp/${value}; mkdir -p $W && grep -vE "alpha|${value}|\\"channel\\"" log.txt`;
    const { whole, inPlace } = redact(source);
    expect(shapes(whole)).not.toEqual(shapes(source));
    expect(inPlace).toBeDefined();
    expect(inPlace).not.toContain(value);
    expect(inPlace).toContain("; mkdir -p $W && grep -vE");
    expect(inPlace).toContain('channel\\"" log.txt');
    expect(shapes(inPlace!)).toEqual(shapes(source));
  });

  it("projects nothing when an exact secret spans more than one token", () => {
    const source = 'tool "first" "second"';
    const spans = [{ start: 6, end: 20, replacement: "[REDACTED_SECRET:0123456789abcdef]" }];
    expect(redactProgramSourceInPlace("shell", source, spans)).toBeUndefined();
    // Nor when it takes in a quote delimiter of its token.
    const quoted = [{ start: 5, end: 11, replacement: "[REDACTED_SECRET:0123456789abcdef]" }];
    expect(redactProgramSourceInPlace("shell", source, quoted)).toBeUndefined();
  });

  it("keeps the placeholder as written in a word no value is bound to", () => {
    const source = "STATE=/tmp/x; echo $STATE";
    const spans = [
      { start: 0, end: 13, replacement: "[REDACTED_HIGH_ENTROPY_SECRET:0123456789abcdef]" },
    ];
    expect(redactProgramSourceInPlace("shell", source, spans)).toBe(
      "[REDACTED_HIGH_ENTROPY_SECRET:0123456789abcdef]; echo $STATE",
    );
  });
});
