import { describe, expect, it } from "vitest";
import {
  ComponentBrokerCallSchema,
  type ComponentContract,
  ComponentContractSchema,
  ComponentTestCaseSchema,
  ComponentTestFixtureSchema,
  componentContractDigest,
} from "../src/components.js";

const baseContract: ComponentContract = {
  schemaVersion: "1.0.0",
  name: "test.fixture.component",
  version: "1.0.0",
  description: "Test component for portable fixtures",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  outputSchema: {
    type: "object",
    properties: { content: { type: "string" } },
    required: ["content"],
  },
  capabilities: {},
  effects: ["read"],
  runtime: "deno",
  tests: [
    {
      name: "pure test case without fixture",
      input: { path: "hello.txt" },
      expectedOutput: { content: "hello world" },
    },
  ],
};

describe("ComponentContract test fixtures", () => {
  describe("fixture roundtrip", () => {
    it("parses and preserves complete test fixture with multiple broker calls", () => {
      const contractWithFixture = {
        ...baseContract,
        tests: [
          {
            name: "effectful read and transform",
            input: { path: "/workspace/data.json" },
            expectedOutput: { content: "transformed" },
            fixture: {
              brokerCalls: [
                {
                  service: "fs" as const,
                  method: "readFile",
                  args: ["/workspace/data.json", { encoding: "utf-8" }],
                  result: '{"raw":"data"}',
                },
                {
                  service: "secrets" as const,
                  method: "getSecret",
                  args: ["API_KEY"],
                  result: "secret_value_123",
                },
                {
                  service: "cmd" as const,
                  method: "exec",
                  args: ["echo", "test"],
                  result: { stdout: "test\n", exitCode: 0 },
                },
                {
                  service: "net" as const,
                  method: "fetch",
                  args: ["https://api.example.com/check"],
                  error: "Network connection refused",
                },
                {
                  service: "fs" as const,
                  method: "writeFile",
                  args: ["/workspace/out.json", "done"],
                },
              ],
            },
          },
        ],
      };

      const parsed = ComponentContractSchema.parse(contractWithFixture);
      expect(parsed.tests[0]?.fixture).toBeDefined();
      expect(parsed.tests[0]?.fixture?.brokerCalls).toHaveLength(5);

      const calls = parsed.tests[0]!.fixture!.brokerCalls;
      expect(calls[0]).toEqual({
        service: "fs",
        method: "readFile",
        args: ["/workspace/data.json", { encoding: "utf-8" }],
        result: '{"raw":"data"}',
      });
      expect(calls[3]).toEqual({
        service: "net",
        method: "fetch",
        args: ["https://api.example.com/check"],
        error: "Network connection refused",
      });
      expect(calls[4]).toEqual({
        service: "fs",
        method: "writeFile",
        args: ["/workspace/out.json", "done"],
      });
    });

    it("roundtrips through ComponentTestCaseSchema and ComponentTestFixtureSchema", () => {
      const fixtureData = {
        brokerCalls: [
          {
            service: "fs" as const,
            method: "stat",
            args: ["file.txt"],
            result: { size: 1024, isFile: true },
          },
        ],
      };

      const parsedFixture = ComponentTestFixtureSchema.parse(fixtureData);
      expect(parsedFixture).toEqual(fixtureData);

      const testCaseData = {
        name: "stat file",
        input: { path: "file.txt" },
        expectedOutput: { size: 1024 },
        fixture: parsedFixture,
      };

      const parsedTestCase = ComponentTestCaseSchema.parse(testCaseData);
      expect(parsedTestCase).toEqual(testCaseData);
    });
  });

  describe("identity changes when explicit fixture differs", () => {
    it("produces different contract digests between fixture-bearing and fixture-absent contracts", () => {
      const withoutFixture = ComponentContractSchema.parse(baseContract);

      const withFixture = ComponentContractSchema.parse({
        ...baseContract,
        tests: [
          {
            ...baseContract.tests[0],
            fixture: {
              brokerCalls: [
                {
                  service: "fs",
                  method: "readFile",
                  args: ["hello.txt"],
                  result: "hello world",
                },
              ],
            },
          },
        ],
      });

      const digestWithout = componentContractDigest(withoutFixture);
      const digestWith = componentContractDigest(withFixture);

      expect(digestWithout).not.toBe(digestWith);
      expect(digestWithout).toMatch(/^[a-f0-9]{64}$/);
      expect(digestWith).toMatch(/^[a-f0-9]{64}$/);
    });

    it("produces different contract digests when fixture arguments, results, or methods differ", () => {
      const contractA = ComponentContractSchema.parse({
        ...baseContract,
        tests: [
          {
            ...baseContract.tests[0],
            fixture: {
              brokerCalls: [
                {
                  service: "fs",
                  method: "readFile",
                  args: ["file_a.txt"],
                  result: "data a",
                },
              ],
            },
          },
        ],
      });

      const contractB = ComponentContractSchema.parse({
        ...baseContract,
        tests: [
          {
            ...baseContract.tests[0],
            fixture: {
              brokerCalls: [
                {
                  service: "fs",
                  method: "readFile",
                  args: ["file_b.txt"],
                  result: "data a",
                },
              ],
            },
          },
        ],
      });

      const contractC = ComponentContractSchema.parse({
        ...baseContract,
        tests: [
          {
            ...baseContract.tests[0],
            fixture: {
              brokerCalls: [
                {
                  service: "fs",
                  method: "readFile",
                  args: ["file_a.txt"],
                  result: "data b",
                },
              ],
            },
          },
        ],
      });

      const contractD = ComponentContractSchema.parse({
        ...baseContract,
        tests: [
          {
            ...baseContract.tests[0],
            fixture: {
              brokerCalls: [
                {
                  service: "fs",
                  method: "readFile",
                  args: ["file_a.txt"],
                  error: "Permission denied",
                },
              ],
            },
          },
        ],
      });

      const digestA = componentContractDigest(contractA);
      const digestB = componentContractDigest(contractB);
      const digestC = componentContractDigest(contractC);
      const digestD = componentContractDigest(contractD);

      expect(digestA).not.toBe(digestB);
      expect(digestA).not.toBe(digestC);
      expect(digestA).not.toBe(digestD);
      expect(digestB).not.toBe(digestC);
    });
  });

  describe("unchanged absent-field digest", () => {
    it("produces identical digests when fixture field is absent vs explicitly undefined", () => {
      const contractOmitted = ComponentContractSchema.parse(baseContract);
      const contractExplicitUndefined = ComponentContractSchema.parse({
        ...baseContract,
        tests: [
          {
            name: baseContract.tests[0]!.name,
            input: baseContract.tests[0]!.input,
            expectedOutput: baseContract.tests[0]!.expectedOutput,
            fixture: undefined,
          },
        ],
      });

      const digestOmitted = componentContractDigest(contractOmitted);
      const digestExplicitUndefined = componentContractDigest(contractExplicitUndefined);

      expect(digestOmitted).toBe(digestExplicitUndefined);
    });

    it("parses existing pure component contracts without modifying their digest", () => {
      const parsed = ComponentContractSchema.parse(baseContract);
      expect(parsed.tests[0]?.fixture).toBeUndefined();

      const digest = componentContractDigest(parsed);
      expect(digest).toHaveLength(64);
    });
  });

  describe("mutually exclusive failure/result", () => {
    it("rejects broker calls defining both result and error", () => {
      expect(() =>
        ComponentBrokerCallSchema.parse({
          service: "fs",
          method: "readFile",
          args: ["test.txt"],
          result: "contents",
          error: "Failed to read",
        }),
      ).toThrow(/mutually exclusive/);
    });

    it("rejects broker calls defining both result as null and error", () => {
      expect(() =>
        ComponentBrokerCallSchema.parse({
          service: "fs",
          method: "readFile",
          args: ["test.txt"],
          result: null,
          error: "Failed to read",
        }),
      ).toThrow(/mutually exclusive/);
    });

    it("accepts broker call with only result", () => {
      const parsed = ComponentBrokerCallSchema.parse({
        service: "fs",
        method: "readFile",
        args: ["test.txt"],
        result: "contents",
      });
      expect(parsed.result).toBe("contents");
      expect(parsed.error).toBeUndefined();
    });

    it("accepts broker call with only error", () => {
      const parsed = ComponentBrokerCallSchema.parse({
        service: "fs",
        method: "readFile",
        args: ["test.txt"],
        error: "ENOENT",
      });
      expect(parsed.error).toBe("ENOENT");
      expect(parsed.result).toBeUndefined();
    });

    it("accepts broker call with neither result nor error (void/undefined result)", () => {
      const parsed = ComponentBrokerCallSchema.parse({
        service: "fs",
        method: "writeFile",
        args: ["test.txt", "data"],
      });
      expect(parsed.result).toBeUndefined();
      expect(parsed.error).toBeUndefined();
    });

    it("accepts broker call with result: undefined and explicit error", () => {
      const parsed = ComponentBrokerCallSchema.parse({
        service: "cmd",
        method: "exec",
        args: ["failing_binary"],
        result: undefined,
        error: "Exit code 1",
      });
      expect(parsed.error).toBe("Exit code 1");
      expect(parsed.result).toBeUndefined();
    });
  });

  describe("bounds", () => {
    it("accepts at most 64 broker interactions in a fixture", () => {
      const exactly64 = {
        brokerCalls: Array.from({ length: 64 }, (_, i) => ({
          service: "fs" as const,
          method: `step_${i}`,
          args: [i],
        })),
      };
      expect(() => ComponentTestFixtureSchema.parse(exactly64)).not.toThrow();

      const tooMany65 = {
        brokerCalls: Array.from({ length: 65 }, (_, i) => ({
          service: "fs" as const,
          method: `step_${i}`,
          args: [i],
        })),
      };
      expect(() => ComponentTestFixtureSchema.parse(tooMany65)).toThrow();
    });

    it("accepts empty brokerCalls array (0 interactions)", () => {
      const empty = { brokerCalls: [] };
      const parsed = ComponentTestFixtureSchema.parse(empty);
      expect(parsed.brokerCalls).toEqual([]);
    });

    it("enforces method identifier length bounds (1 to 128 chars)", () => {
      expect(() =>
        ComponentBrokerCallSchema.parse({
          service: "fs",
          method: "",
          args: [],
        }),
      ).toThrow();

      const maxLen128 = `a${"b".repeat(127)}`;
      expect(() =>
        ComponentBrokerCallSchema.parse({
          service: "fs",
          method: maxLen128,
          args: [],
        }),
      ).not.toThrow();

      const tooLong129 = `a${"b".repeat(128)}`;
      expect(() =>
        ComponentBrokerCallSchema.parse({
          service: "fs",
          method: tooLong129,
          args: [],
        }),
      ).toThrow();
    });

    it("enforces error string length bound (max 4096 chars)", () => {
      const maxError = "e".repeat(4096);
      expect(() =>
        ComponentBrokerCallSchema.parse({
          service: "cmd",
          method: "exec",
          args: [],
          error: maxError,
        }),
      ).not.toThrow();

      const tooLongError = "e".repeat(4097);
      expect(() =>
        ComponentBrokerCallSchema.parse({
          service: "cmd",
          method: "exec",
          args: [],
          error: tooLongError,
        }),
      ).toThrow();
    });

    it("enforces args array bounds (max 256 args)", () => {
      const maxArgs = Array.from({ length: 256 }, (_, i) => i);
      expect(() =>
        ComponentBrokerCallSchema.parse({
          service: "cmd",
          method: "exec",
          args: maxArgs,
        }),
      ).not.toThrow();

      const tooManyArgs = Array.from({ length: 257 }, (_, i) => i);
      expect(() =>
        ComponentBrokerCallSchema.parse({
          service: "cmd",
          method: "exec",
          args: tooManyArgs,
        }),
      ).toThrow();
    });
  });

  describe("dangerous method identifiers", () => {
    it("rejects prototype pollution identifiers as method names", () => {
      for (const dangerous of ["__proto__", "prototype", "constructor"]) {
        expect(() =>
          ComponentBrokerCallSchema.parse({
            service: "fs",
            method: dangerous,
            args: [],
          }),
        ).toThrow();
      }
    });

    it("rejects method identifiers with invalid characters or format", () => {
      const invalidMethods = [
        "123startsWithNumber",
        "method with spaces",
        "method;injection",
        "../pathTraversal",
        "<script>alert(1)</script>",
        "method$special",
        "foo/bar",
        "fs.readFile",
        "read-file",
        "cmd.exec",
      ];

      for (const method of invalidMethods) {
        expect(() =>
          ComponentBrokerCallSchema.parse({
            service: "fs",
            method,
            args: [],
          }),
        ).toThrow();
      }
    });

    it("accepts legitimate method identifiers (^[A-Za-z][A-Za-z0-9_]*$)", () => {
      const validMethods = ["readFile", "read_file", "get", "resolveSecret", "exec_cmd_1"];

      for (const method of validMethods) {
        expect(() =>
          ComponentBrokerCallSchema.parse({
            service: "fs",
            method,
            args: [],
          }),
        ).not.toThrow();
      }
    });
  });

  describe("non-JSON values and bounds", () => {
    it("rejects functions in args and result", () => {
      expect(() =>
        ComponentBrokerCallSchema.parse({
          service: "fs",
          method: "read",
          args: [() => "malicious"],
        }),
      ).toThrow();

      expect(() =>
        ComponentBrokerCallSchema.parse({
          service: "fs",
          method: "read",
          args: [],
          result: () => "malicious",
        }),
      ).toThrow();
    });

    it("rejects symbols in args and result", () => {
      expect(() =>
        ComponentBrokerCallSchema.parse({
          service: "fs",
          method: "read",
          args: [Symbol("dangerous")],
        }),
      ).toThrow();

      expect(() =>
        ComponentBrokerCallSchema.parse({
          service: "fs",
          method: "read",
          args: [],
          result: Symbol("dangerous"),
        }),
      ).toThrow();
    });

    it("rejects BigInt in args and result", () => {
      expect(() =>
        ComponentBrokerCallSchema.parse({
          service: "fs",
          method: "read",
          args: [12345678901234567890n],
        }),
      ).toThrow();

      expect(() =>
        ComponentBrokerCallSchema.parse({
          service: "fs",
          method: "read",
          args: [],
          result: 12345678901234567890n,
        }),
      ).toThrow();
    });

    it("rejects non-finite numbers (NaN, Infinity, -Infinity)", () => {
      for (const nonFinite of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        expect(() =>
          ComponentBrokerCallSchema.parse({
            service: "fs",
            method: "read",
            args: [nonFinite],
          }),
        ).toThrow();

        expect(() =>
          ComponentBrokerCallSchema.parse({
            service: "fs",
            method: "read",
            args: [],
            result: nonFinite,
          }),
        ).toThrow();
      }
    });

    it("rejects undefined within args array", () => {
      expect(() =>
        ComponentBrokerCallSchema.parse({
          service: "fs",
          method: "read",
          args: [undefined],
        }),
      ).toThrow();
    });

    it("rejects non-plain objects (Date, RegExp, Map, Set)", () => {
      const nonPlainObjects = [new Date(), /regex/, new Map(), new Set()];

      for (const obj of nonPlainObjects) {
        expect(() =>
          ComponentBrokerCallSchema.parse({
            service: "fs",
            method: "read",
            args: [obj],
          }),
        ).toThrow();

        expect(() =>
          ComponentBrokerCallSchema.parse({
            service: "fs",
            method: "read",
            args: [],
            result: obj,
          }),
        ).toThrow();
      }
    });

    it("rejects dangerous object keys (__proto__, prototype, constructor) in JSON values", () => {
      const dangerousPayload = JSON.parse('{"__proto__": "polluted", "safe": 123}');
      expect(() =>
        ComponentBrokerCallSchema.parse({
          service: "fs",
          method: "read",
          args: [dangerousPayload],
        }),
      ).toThrow();
    });
    it("rejects cyclic structures in args and result", () => {
      const cyclicArray: unknown[] = [];
      cyclicArray.push(cyclicArray);

      expect(() =>
        ComponentBrokerCallSchema.parse({
          service: "fs",
          method: "read",
          args: [cyclicArray],
        }),
      ).toThrow(/cyclic/i);

      const cyclicObject: Record<string, unknown> = {};
      cyclicObject.self = cyclicObject;

      expect(() =>
        ComponentBrokerCallSchema.parse({
          service: "fs",
          method: "read",
          args: [],
          result: cyclicObject,
        }),
      ).toThrow(/cyclic/i);
    });

    it("rejects custom class instances as non-plain objects", () => {
      class NonPlainPayload {
        value = 42;
      }

      expect(() =>
        ComponentBrokerCallSchema.parse({
          service: "fs",
          method: "read",
          args: [new NonPlainPayload()],
        }),
      ).toThrow(/non-plain/i);
    });

    it("enforces maximum nesting depth of 16", () => {
      let deep: unknown = "leaf";
      for (let i = 0; i < 20; i++) {
        deep = [deep];
      }

      expect(() =>
        ComponentBrokerCallSchema.parse({
          service: "fs",
          method: "read",
          args: [deep],
        }),
      ).toThrow(/nesting depth/i);

      let shallow: unknown = "leaf";
      for (let i = 0; i < 8; i++) {
        shallow = [shallow];
      }

      expect(() =>
        ComponentBrokerCallSchema.parse({
          service: "fs",
          method: "read",
          args: [shallow],
        }),
      ).not.toThrow();
    });

    it("enforces aggregate fixture size limit", () => {
      const largeString = "x".repeat(60000);
      const largeCalls = Array.from({ length: 10 }, (_, i) => ({
        service: "fs" as const,
        method: `write_${i}`,
        args: [largeString],
      }));

      expect(() =>
        ComponentTestFixtureSchema.parse({
          brokerCalls: largeCalls,
        }),
      ).toThrow(/aggregate size limit/i);
    });
  });

  describe("strict parsing", () => {
    it("rejects unknown properties on ComponentTestFixtureSchema", () => {
      expect(() =>
        ComponentTestFixtureSchema.parse({
          brokerCalls: [],
          extraField: "disallowed",
        }),
      ).toThrow();
    });

    it("rejects unknown properties on ComponentBrokerCallSchema", () => {
      expect(() =>
        ComponentBrokerCallSchema.parse({
          service: "fs",
          method: "read",
          args: [],
          unexpected: true,
        }),
      ).toThrow();
    });

    it("rejects unknown properties on ComponentTestCaseSchema", () => {
      expect(() =>
        ComponentTestCaseSchema.parse({
          name: "test",
          input: {},
          extraProperty: 123,
        }),
      ).toThrow();
    });
  });
});
