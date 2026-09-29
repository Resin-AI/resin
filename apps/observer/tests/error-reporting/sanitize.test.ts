import { describe, expect, it } from "vitest";
import {
  MAX_STACK_FRAMES,
  parseStackFrames,
  redactText,
  sanitizeError,
  sanitizePaths,
  sanitizeStack,
  sanitizeText,
} from "../../src/error-reporting/sanitize.js";

const context = {
  homeDir: "/home/alice",
  projectRoot: "/home/alice/src/acme",
  username: "alice",
};

describe("sanitizePaths", () => {
  it("replaces the project root before the home directory", () => {
    expect(sanitizePaths("open /home/alice/src/acme/lib/a.ts failed", context)).toBe(
      "open <project>/lib/a.ts failed",
    );
    expect(sanitizePaths("read /home/alice/.resin/state/x.json", context)).toBe(
      "read ~/.resin/state/x.json",
    );
  });

  it("does not treat a longer sibling name as the home directory", () => {
    expect(sanitizePaths("/home/alicex/file", context)).toBe("/home/<user>/file");
  });

  it("replaces other users and the OS user name in paths", () => {
    expect(sanitizePaths("at /Users/bob/work/x.js:1:2", {})).toBe("at /Users/<user>/work/x.js:1:2");
    expect(sanitizePaths("at /home/carol/x.js", {})).toBe("at /home/<user>/x.js");
    expect(sanitizePaths("C:\\Users\\Dave\\proj\\a.ts", {})).toBe("C:\\Users\\<user>\\proj\\a.ts");
    expect(sanitizePaths("/mnt/data/alice/cache/x", { username: "alice" })).toBe(
      "/mnt/data/<user>/cache/x",
    );
  });

  it("handles Windows home directories case-insensitively in both separators", () => {
    const windows = { homeDir: "C:\\Users\\Erin", projectRoot: "C:\\Users\\Erin\\repo" };
    expect(sanitizePaths("c:\\users\\erin\\repo\\a.ts and C:/Users/Erin/x", windows)).toBe(
      "<project>\\a.ts and ~/x",
    );
  });
});

describe("redactText", () => {
  it("redacts bearer tokens, JWTs and known key prefixes", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const out = redactText(
      `Authorization: Bearer abc.def.ghi123 token ${jwt} phc_abcdefghijklmnop sk-proj-1234567890abcdef ghp_abcdefghijklmnopqrstu AKIAIOSFODNN7EXAMPLE`,
    );
    expect(out).not.toContain("abc.def.ghi123");
    expect(out).not.toContain(jwt);
    expect(out).not.toContain("phc_abcdefghijklmnop");
    expect(out).not.toContain("sk-proj-1234567890abcdef");
    expect(out).not.toContain("ghp_abcdefghijklmnopqrstu");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("redacts key=, token=, secret= and password= values", () => {
    const out = redactText("key=abc token=t0k secret='s3' password=\"p w\" api_key: zzzz1234yyyy");
    expect(out).toBe(
      "key=[REDACTED] token=[REDACTED] secret=[REDACTED] password=[REDACTED] api_key: [REDACTED]",
    );
  });

  it("keeps ordinary prose after a colon", () => {
    expect(redactText("auth: failed")).toBe("auth: failed");
  });

  it("strips URL credentials and query strings", () => {
    expect(redactText("GET https://user:pw@api.example.com/v1/x?code=123#frag failed.")).toBe(
      "GET https://[REDACTED]@api.example.com/v1/x?[REDACTED] failed.",
    );
  });

  it("redacts e-mail addresses and long opaque secrets", () => {
    expect(redactText("user jane.doe+x@example.co.uk")).toBe("user <email>");
    expect(
      redactText(
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY value 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      ),
    ).not.toContain("9f86d081884c7d659a2feaa0c55ad015");
  });

  it("redacts private key blocks", () => {
    expect(redactText("-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY----- tail")).toBe(
      "[REDACTED_PRIVATE_KEY] tail",
    );
  });
});

describe("sanitizeText", () => {
  it("caps messages", () => {
    const out = sanitizeText("x".repeat(5_000), {}, 1_000);
    expect(out.length).toBeLessThanOrEqual(1_000);
    expect(out.endsWith("…[truncated]")).toBe(true);
  });
});

describe("stack sanitization", () => {
  const stack = [
    "Error: failed for jane@example.com at /home/alice/src/acme/a.ts",
    "    at doThing (/home/alice/src/acme/src/a.ts:10:5)",
    "    at async run (file:///home/alice/.resin/app/dist/b.js:20:7)",
    "    at node:internal/process/task_queues:95:5",
    "    at /Users/bob/x.js:1:1",
  ].join("\n");

  it("parses frames outermost first with sanitized file:line:col", () => {
    const frames = parseStackFrames(stack, context);
    expect(frames).toEqual([
      {
        platform: "node:javascript",
        function: undefined,
        filename: "/Users/<user>/x.js",
        lineno: 1,
        colno: 1,
        in_app: true,
      },
      {
        platform: "node:javascript",
        function: undefined,
        filename: "node:internal/process/task_queues",
        lineno: 95,
        colno: 5,
        in_app: false,
      },
      {
        platform: "node:javascript",
        function: "run",
        filename: "file://~/.resin/app/dist/b.js",
        lineno: 20,
        colno: 7,
        in_app: true,
      },
      {
        platform: "node:javascript",
        function: "doThing",
        filename: "<project>/src/a.ts",
        lineno: 10,
        colno: 5,
        in_app: true,
      },
    ]);
  });

  it("caps frames", () => {
    const long = [
      "Error: x",
      ...Array.from({ length: 80 }, (_, i) => `    at f${i} (/tmp/a.js:${i + 1}:1)`),
    ].join("\n");
    expect(parseStackFrames(long)).toHaveLength(MAX_STACK_FRAMES);
    expect(sanitizeStack(long).split("\n")).toHaveLength(MAX_STACK_FRAMES + 1);
  });

  it("sanitizes the message lines of a raw stack", () => {
    const out = sanitizeStack(stack, context);
    expect(out).not.toContain("jane@example.com");
    expect(out).not.toContain("alice");
  });
});

describe("sanitizeError", () => {
  it("extracts type, sanitized message, code and frames", () => {
    const error = Object.assign(new TypeError("bad token=abc in /home/alice/x"), { code: "E_BAD" });
    const out = sanitizeError(error, context);
    expect(out.type).toBe("TypeError");
    expect(out.message).toBe("bad token=[REDACTED] in ~/x");
    expect(out.code).toBe("E_BAD");
    expect(out.frames.length).toBeGreaterThan(0);
  });

  it("handles non-Error throwables", () => {
    expect(sanitizeError("boom me@x.io").message).toBe("boom <email>");
    expect(sanitizeError({ message: "obj" }).message).toBe("obj");
    expect(sanitizeError(42).message).toBe("Thrown number");
  });
});
