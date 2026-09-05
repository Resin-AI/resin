import { z } from "zod";
import { hashCanonical } from "./canonical.js";
import { CapabilityManifestSchema } from "./capabilities.js";
import { Sha256DigestSchema } from "./common.js";

const NameSchema = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/)
  .refine((name) => !["__proto__", "prototype", "constructor"].includes(name));
const JsonSchema = z.record(z.unknown());

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
    tests: z
      .array(
        z
          .object({
            name: z.string().min(1),
            input: z.record(z.unknown()),
            expectedOutput: z.unknown().optional(),
            expectFailure: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1),
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
