import { z } from "zod";
import { hashCanonical } from "./canonical.js";
import { CapabilityManifestSchema } from "./capabilities.js";
import { Sha256DigestSchema } from "./common.js";

const NameSchema = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/)
  .refine((name) => !["__proto__", "prototype", "constructor"].includes(name));
const JsonSchema = z.record(z.unknown());
const MAX_FIXTURE_DEPTH = 16;
const MAX_FIXTURE_NODES = 4096;
const MAX_FIXTURE_BYTES = 512 * 1024; // 512 KiB

function validateFixtureJson(
  root: unknown,
  path: string,
  state: { totalBytes: number; totalNodes: number; seen: Set<object> },
): void {
  const stack: Array<[unknown, number, string]> = [[root, 0, path]];

  while (stack.length > 0) {
    const [val, depth, currentPath] = stack.pop()!;
    state.totalNodes++;
    if (state.totalNodes > MAX_FIXTURE_NODES) {
      throw new Error(
        `Fixture payload exceeds node count limit of ${MAX_FIXTURE_NODES} at ${currentPath}`,
      );
    }
    if (depth > MAX_FIXTURE_DEPTH) {
      throw new Error(
        `Fixture payload exceeds maximum nesting depth of ${MAX_FIXTURE_DEPTH} at ${currentPath}`,
      );
    }

    if (val === null || typeof val === "boolean") {
      state.totalBytes += 4;
    } else if (typeof val === "number") {
      if (!Number.isFinite(val)) {
        throw new Error(`Fixture payload contains non-finite number at ${currentPath}`);
      }
      state.totalBytes += 8;
    } else if (typeof val === "string") {
      if (val.length > 65536) {
        throw new Error(`Fixture string exceeds maximum length of 65536 at ${currentPath}`);
      }
      state.totalBytes += val.length * 2;
    } else if (typeof val === "object") {
      if (state.seen.has(val)) {
        throw new Error(`Fixture payload contains cyclic structure at ${currentPath}`);
      }
      state.seen.add(val);

      if (Array.isArray(val)) {
        if (val.length > 256) {
          throw new Error(`Fixture array exceeds maximum item limit of 256 at ${currentPath}`);
        }
        for (let i = val.length - 1; i >= 0; i--) {
          stack.push([val[i], depth + 1, `${currentPath}[${i}]`]);
        }
      } else {
        const proto = Object.getPrototypeOf(val);
        if (proto !== null && proto !== Object.prototype) {
          throw new Error(`Fixture payload contains non-plain object instance at ${currentPath}`);
        }
        const entries = Object.entries(val);
        if (entries.length > 256) {
          throw new Error(`Fixture object exceeds property count limit of 256 at ${currentPath}`);
        }
        for (const [k, child] of entries) {
          if (["__proto__", "prototype", "constructor"].includes(k)) {
            throw new Error(`Dangerous property identifier '${k}' rejected at ${currentPath}`);
          }
          if (k.length > 256) {
            throw new Error(
              `Fixture object key exceeds length limit of 256 at ${currentPath}.${k}`,
            );
          }
          state.totalBytes += k.length * 2;
          stack.push([child, depth + 1, `${currentPath}.${k}`]);
        }
      }
    } else {
      throw new Error(`Fixture payload contains non-JSON value (${typeof val}) at ${currentPath}`);
    }

    if (state.totalBytes > MAX_FIXTURE_BYTES) {
      throw new Error(`Fixture payload exceeds aggregate size limit of ${MAX_FIXTURE_BYTES} bytes`);
    }
  }
}

const MethodIdentifierSchema = z
  .string()
  .min(1, "Method identifier cannot be empty")
  .max(128, "Method identifier exceeds maximum length of 128 characters")
  .regex(
    /^[A-Za-z][A-Za-z0-9_]*$/,
    "Method identifier must start with a letter and contain only alphanumeric characters and underscores",
  )
  .refine(
    (name) => !["__proto__", "prototype", "constructor"].includes(name),
    "Prototype and constructor identifiers are rejected as method names",
  );

export const ComponentBrokerCallSchema = z
  .object({
    service: z.enum(["fs", "cmd", "net", "secrets"]),
    method: MethodIdentifierSchema,
    args: z.array(z.unknown()).max(256),
    result: z.unknown().optional(),
    error: z.string().max(4096).optional(),
  })
  .strict()
  .superRefine((call, ctx) => {
    if (call.result !== undefined && call.error !== undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "result and error are mutually exclusive; a broker call may specify result or error, not both",
        path: ["error"],
      });
    }

    const state = { totalBytes: 0, totalNodes: 0, seen: new Set<object>() };
    try {
      validateFixtureJson(call.args, "args", state);
      if (call.result !== undefined) {
        validateFixtureJson(call.result, "result", state);
      }
    } catch (err) {
      ctx.addIssue({
        code: "custom",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
export type ComponentBrokerCall = z.infer<typeof ComponentBrokerCallSchema>;

export const ComponentTestFixtureSchema = z
  .object({
    brokerCalls: z.array(ComponentBrokerCallSchema).max(64),
  })
  .strict()
  .superRefine((fixture, ctx) => {
    const state = { totalBytes: 0, totalNodes: 0, seen: new Set<object>() };
    try {
      for (const [index, call] of fixture.brokerCalls.entries()) {
        validateFixtureJson(call.args, `brokerCalls[${index}].args`, state);
        if (call.result !== undefined) {
          validateFixtureJson(call.result, `brokerCalls[${index}].result`, state);
        }
        if (call.error !== undefined) {
          state.totalBytes += call.error.length * 2;
        }
        state.totalBytes += call.method.length * 2 + call.service.length * 2;
        if (state.totalBytes > MAX_FIXTURE_BYTES) {
          throw new Error(
            `Fixture payload exceeds aggregate size limit of ${MAX_FIXTURE_BYTES} bytes`,
          );
        }
      }
    } catch (err) {
      ctx.addIssue({
        code: "custom",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
export type ComponentTestFixture = z.infer<typeof ComponentTestFixtureSchema>;

export const ComponentTestCaseSchema = z
  .object({
    name: z.string().min(1),
    input: z.record(z.unknown()),
    expectedOutput: z.unknown().optional(),
    expectFailure: z.boolean().optional(),
    fixture: ComponentTestFixtureSchema.optional(),
  })
  .strict();
export type ComponentTestCase = z.infer<typeof ComponentTestCaseSchema>;

/** Portable behavior identity. Assignment and authorship are deliberately not identity. */
export const ComponentContractSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    name: NameSchema,
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    description: z.string().min(1).max(4096),
    inputSchema: JsonSchema,
    outputSchema: JsonSchema,
    capabilities: CapabilityManifestSchema,
    effects: z.array(z.enum(["read", "write", "network", "command", "secret"])),
    runtime: z.literal("deno"),
    tests: z.array(ComponentTestCaseSchema).min(1),
  })
  .strict();
export type ComponentContract = z.infer<typeof ComponentContractSchema>;

export const ComponentReferenceSchema = z
  .object({
    contractDigest: Sha256DigestSchema,
    sourceDigest: Sha256DigestSchema,
  })
  .strict();
export type ComponentReference = z.infer<typeof ComponentReferenceSchema>;

/** Bindings are data, never expressions. Only previously completed steps may be referenced. */
export const ComponentBindingSchema = z.discriminatedUnion("from", [
  z.object({ from: z.literal("literal"), value: z.unknown() }).strict(),
  z.object({ from: z.literal("input"), path: z.array(NameSchema).max(16) }).strict(),
  z
    .object({ from: z.literal("step"), step: NameSchema, path: z.array(NameSchema).max(16) })
    .strict(),
]);
export type ComponentBinding = z.infer<typeof ComponentBindingSchema>;

export const ComponentCompositionSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    inputSchema: JsonSchema,
    outputSchema: JsonSchema,
    steps: z
      .array(
        z
          .object({
            id: NameSchema,
            component: ComponentReferenceSchema,
            inputs: z.record(NameSchema, ComponentBindingSchema),
          })
          .strict(),
      )
      .min(1)
      .max(64),
    outputs: z.record(NameSchema, ComponentBindingSchema),
  })
  .strict()
  .superRefine((composition, ctx) => {
    const available = new Set<string>();
    for (const [index, step] of composition.steps.entries()) {
      if (available.has(step.id))
        ctx.addIssue({
          code: "custom",
          path: ["steps", index, "id"],
          message: "Duplicate step id",
        });
      for (const binding of Object.values(step.inputs)) {
        if (binding.from === "step" && !available.has(binding.step))
          ctx.addIssue({
            code: "custom",
            path: ["steps", index, "inputs"],
            message: "Binding requires a preceding step",
          });
      }
      available.add(step.id);
    }
    for (const binding of Object.values(composition.outputs)) {
      if (binding.from === "step" && !available.has(binding.step))
        ctx.addIssue({ code: "custom", path: ["outputs"], message: "Unknown output step" });
    }
  });
export type ComponentComposition = z.infer<typeof ComponentCompositionSchema>;

export function componentContractDigest(contract: ComponentContract): string {
  return hashCanonical(ComponentContractSchema.parse(contract));
}
