import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, statSync, truncateSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkOwnerOnly } from "@resin/windows-security";
import { PROBE_ACCESS, probeOpenWithUserSidDisabled } from "@resin/windows-security/testing";
import { describe, expect, it } from "vitest";
import {
  FilePrivateValueStore,
  InMemoryPrivateValueStore,
  resolvePrivateReference,
} from "../../src/analytics/private-value-store.js";
import { RedactionEngine } from "../../src/normalization/index.js";
import { RawDataExfiltrationError, assertNoProhibitedRawData } from "../../src/sync/types.js";

/** POSIX: mode 0600. Windows: owner-only DACL that every other principal is denied by. */
function expectOwnerOnlyFile(file: string): void {
  if (process.platform !== "win32") {
    expect(statSync(file).mode & 0o777).toBe(0o600);
    return;
  }
  expect(checkOwnerOnly(file)).toMatchObject({ ok: true, problems: [] });
  expect(probeOpenWithUserSidDisabled(file, PROBE_ACCESS.read)).toEqual({
    ok: false,
    win32Error: 5,
  });
}

/** POSIX: chmod 0644. Windows: grant Everyone read on the file itself. */
function makeReadableByOthers(file: string): void {
  if (process.platform !== "win32") {
    chmodSync(file, 0o644);
    return;
  }
  execFileSync("icacls", [file, "/grant", "*S-1-1-0:(R)"], { stdio: "ignore" });
  expect(probeOpenWithUserSidDisabled(file, PROBE_ACCESS.read).ok).toBe(true);
}

const engine = (config: ConstructorParameters<typeof RedactionEngine>[0] = {}) =>
  new RedactionEngine({ sensitiveEnvVars: [], ...config });

describe("upload redaction of credentials without a named vendor prefix", () => {
  it.each([
    [
      "hex API key",
      "dd-agent status --api-key-file x; DD_SITE=us5 ddsend 3f9a1c07b2e84d65a0f1c2d3e4b5a697",
      "3f9a1c07b2e84d65a0f1c2d3e4b5a697",
    ],
    ["short base62 key", "deploy --api 7Kq2mZ9xW4pL8vRt3N --region eu", "7Kq2mZ9xW4pL8vRt3N"],
    [
      "postgres URL",
      "psql postgres://app:hunter22@db.internal:5432/prod -c 'select 1'",
      "hunter22",
    ],
    ["redis URL", "redis-cli -u redis://:s3cr@cache.internal:6379 ping", "s3cr"],
    [
      "Basic auth header",
      'curl -H "Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l" https://api.example.com',
      "YWxhZGRpbjpvcGVuc2VzYW1l",
    ],
    ["curl -u", "curl -sS -u deploy:Tr0ub4 https://ci.example.com/job", "Tr0ub4"],
    [
      "X-Api-Key header",
      "curl -H 'X-Api-Key: pk_live_2b7e' https://api.example.com/v1",
      "pk_live_2b7e",
    ],
    [
      "token Authorization header",
      'curl -H "Authorization: token gho9f8e7" https://api.github.com',
      "gho9f8e7",
    ],
    [
      "UUID labelled as a key",
      "ddsend --app web api token 5f0c8d2e-3b4a-4c1d-9e8f-7a6b5c4d3e2f",
      "5f0c8d2e-3b4a-4c1d-9e8f-7a6b5c4d3e2f",
    ],
    [
      "hex key before a path",
      "fetch key=3f9a1c07b2e84d65a0f1c2d3e4b5a697/x",
      "3f9a1c07b2e84d65a0f1c2d3e4b5a697",
    ],
    [
      "hex token query before a path",
      "curl https://api.example.com/v1?token=3f9a1c07b2e84d65a0f1c2d3e4b5a697/",
      "3f9a1c07b2e84d65a0f1c2d3e4b5a697",
    ],
    [
      "webhook secret path segment",
      "curl -X POST https://ci.example.com/hooks/3f9a1c07b2e84d65a0f1c2d3e4b5a697/",
      "3f9a1c07b2e84d65a0f1c2d3e4b5a697",
    ],
    ["JSON api_key", '{"api_key":"q8Zr2Lk9Wm4x"}', "q8Zr2Lk9Wm4x"],
    ["JSON password", '{"user": "ops", "password": "Hunter2Hunter2"}', "Hunter2Hunter2"],
    [
      "single-line .netrc entry",
      "machine api.example.com login ops password n3tRcS3cret",
      "n3tRcS3cret",
    ],
    [
      "multi-line .netrc entry",
      "machine api.example.com\n  login ops\n  password n3tRcS3cret\n",
      "n3tRcS3cret",
    ],
    ["Cookie header", "curl -H 'Cookie: session=s3ss10nV4lue' https://x", "session=s3ss10nV4lue"],
    ["Set-Cookie header", "Set-Cookie: sid=AbC9dEf8; Path=/; HttpOnly", "sid=AbC9dEf8"],
  ])("redacts a %s before upload", (_label, command, secret) => {
    const store = new InMemoryPrivateValueStore();
    const { data } = engine({
      onRedact: (placeholder, original) => store.set(placeholder, original),
    }).redact({
      command,
    });
    expect(data.command).not.toContain(secret);
    expect(data.command).toMatch(/\[REDACTED_[A-Z_]+:[0-9a-f]{16}\]/);
    expect(() => assertNoProhibitedRawData(data)).not.toThrow();
    // The local private store still recovers the exact command for replay on this device.
    store.set("private:cmd", data.command);
    expect(resolvePrivateReference(store, "private:cmd")).toBe(command);
  });

  it.each([
    "psql postgres://app:hunter22@db.internal/prod",
    'curl -H "Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l" https://x',
    "curl -u deploy:Tr0ub4 https://x",
    "http -a bob:pw1 example.org",
    'curl -H "X-Api-Key: abc123" https://x',
    '{"api_key":"q8Zr2Lk9Wm4x"}',
    '{\\"password\\": \\"Hunter2Hunter2\\"}',
    "machine h login u password n3tRc",
    "Cookie: session=s3ss10n",
  ])("fails closed if %s ever reaches the upload validator unredacted", (command) => {
    expect(() => assertNoProhibitedRawData({ command })).toThrow(RawDataExfiltrationError);
  });

  it.each([
    "git checkout 3f9a1c07b2e84d65a0f1c2d3e4b5a6979c2f4e1a",
    "git log -1\ncommit 3f9a1c07b2e84d65a0f1c2d3e4b5a6979c2f4e1a\nAuthor: Jane Doe <jane@example.com>\nDate:   Mon Jun 2 10:00:00 2025",
    "git show --stat 3f9a1c07b2e84d65a0f1c2d3e4b5a6979c2f4e1a",
    "commit 3f9a1c07b2e84d65a0f1c2d3e4b5a6979c2f4e1a\nMerge: 1a2b3c4 5d6e7f8",
    "sha256sum -c SHA256SUMS\nbackup.tar.gz: OK",
    "cat SHA256SUMS\n3f9a1c07b2e84d65a0f1c2d3e4b5a6979c2f4e1a3f9a1c07b2e84d65a0f1c2d3  backup.tar.gz",
    'echo "3f9a1c07b2e84d65a0f1c2d3e4b5a6979c2f4e1a3f9a1c07b2e84d65a0f1c2d3  backup.tar.gz" | sha256sum -c',
    "docker pull alpine@sha256:3f9a1c07b2e84d65a0f1c2d3e4b5a6979c2f4e1a3f9a1c07b2e84d65a0f1c2d3",
    "const bytes = base64ToUint8Array(input) as HTMLInputElement2; Author: Jane",
    "request 123e4567-e89b-12d3-a456-426614174000 finished",
    "ls build-3f9a1c07b2e84d65a0f1c2d3e4b5a6979c2f4e1a.log",
    "du -sh /tmp/cache/3f9a1c07b2e84d65a0f1c2d3e4b5a697/x",
    "by default the password is rotated monthly",
  ])("keeps ordinary digests and identifiers intact: %s", (text) => {
    expect(engine().redactString(text).redactedText).toBe(text);
  });
});

describe("placeholder tags", () => {
  const secret = "hunter22";
  const legacyTag = createHash("sha256").update(secret).digest("hex").slice(0, 8);
  const tagOf = (key?: Uint8Array) =>
    engine({ fingerprintKey: key })
      .redactString(`psql postgres://app:${secret}@db/prod`)
      .redactedText.match(/\[REDACTED_URL_CREDENTIAL:([0-9a-f]+)\]/)?.[1];

  it("are keyed per device instead of an unsalted digest of the secret", () => {
    const deviceA = new Uint8Array(32).fill(1);
    const deviceB = new Uint8Array(32).fill(2);
    expect(tagOf(deviceA)).toBe(tagOf(deviceA));
    expect(tagOf(deviceA)).not.toBe(tagOf(deviceB));
    expect(tagOf(deviceA)?.startsWith(legacyTag)).toBe(false);
    expect(tagOf()).not.toBe(tagOf());
  });

  it("use an owner-only device key that persists and keeps legacy placeholders resolvable", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "resin-redaction-key-"));
    const legacy = new FilePrivateValueStore(root);
    const legacyPlaceholder = `[REDACTED_CREDENTIAL:${legacyTag}]`;
    legacy.set(legacyPlaceholder, secret, { workspaceId: "ws" });
    legacy.set("private:legacy", `psql -p ${legacyPlaceholder}`);

    const store = new FilePrivateValueStore(root);
    const key = store.redactionKey();
    const keyFile = path.join(root, "private-values", "redaction-key");
    expectOwnerOnlyFile(keyFile);
    expect(Buffer.from(new FilePrivateValueStore(root).redactionKey())).toEqual(Buffer.from(key));

    const pipelineEngine = engine({ fingerprintKey: key });
    const redacted = pipelineEngine.redactString(
      `psql postgres://app:${secret}@db/prod`,
    ).redactedText;
    expect(redacted).not.toContain(legacyTag);
    expect(resolvePrivateReference(store, "private:legacy")).toBe(`psql -p ${secret}`);
  });

  it.each([
    ["readable by others", makeReadableByOthers],
    ["truncated", (file: string) => truncateSync(file, 7)],
  ])("replace a key file that is %s and keep earlier placeholders resolvable", (_label, damage) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "resin-redaction-key-"));
    const first = new FilePrivateValueStore(root);
    const oldKey = Buffer.from(first.redactionKey());
    const oldPlaceholder = engine({ fingerprintKey: oldKey })
      .redactString(`psql postgres://app:${secret}@db/prod`)
      .redactedText.match(/\[REDACTED_URL_CREDENTIAL:[0-9a-f]+\]/)?.[0];
    expect(oldPlaceholder).toBeDefined();
    first.set(oldPlaceholder!, secret, { workspaceId: "ws" });
    first.set("private:old", `psql postgres://app:${oldPlaceholder}@db/prod`);
    const keyFile = path.join(root, "private-values", "redaction-key");
    damage(keyFile);

    const reopened = new FilePrivateValueStore(root);
    const newKey = Buffer.from(reopened.redactionKey());
    expectOwnerOnlyFile(keyFile);
    expect(newKey).toHaveLength(32);
    expect(newKey).not.toEqual(oldKey);
    expect(resolvePrivateReference(reopened, "private:old")).toBe(
      `psql postgres://app:${secret}@db/prod`,
    );
  });
});

describe("session environment", () => {
  it("scrubs secret-named variables from the supplied session environment, not the daemon's", () => {
    const text = "export STRIPE_SECRET=abcdef123456 && ./deploy";
    // An empty session environment scrubs nothing, whatever this process's environment holds.
    const unrelated = new RedactionEngine({ environment: {}, scanContent: false });
    expect(unrelated.redactString(text).redactedText).toBe(text);
    const session = new RedactionEngine({
      environment: { STRIPE_SECRET: "abcdef123456", HOME: "/home/dev" },
      scanContent: false,
    });
    expect(session.redactString(text).redactedText).toMatch(
      /^export STRIPE_SECRET=\[REDACTED_ENV:STRIPE_SECRET:[0-9a-f]{16}\] && \.\/deploy$/,
    );
  });
});
