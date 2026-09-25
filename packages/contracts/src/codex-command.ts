import { z } from "zod";

/** Operational identifiers only: no command, source, path, arguments or value digests. */
export const RESIN_CODEX_COMMAND_METADATA_KEY = "resinCodexCommandV1" as const;

const Id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);
const Time = z.number().int().nonnegative().finite();
const AssociationFields = {
  callId: Id,
  nativeCommandId: Id,
  startedAtMs: Time,
  callStartedAtMs: Time,
  callCompletedAtMs: Time,
};
export const CodexCommandAssociationSchema = z
  .object({
    kind: z.literal("derived"),
    rule: z.literal("codex-single-command-start-window-v1"),
    ...AssociationFields,
  })
  .strict();
export type CodexCommandAssociation = z.infer<typeof CodexCommandAssociationSchema>;

export const CodexCommandMetadataSchema = z.discriminatedUnion("kind", [
  z
    .object({
      version: z.literal(1),
      kind: z.literal("call"),
      form: z.literal("single-command-output"),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      kind: z.literal("command"),
      nativeId: Id,
      startedAtMs: Time.optional(),
      association: CodexCommandAssociationSchema.optional(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      kind: z.literal("result"),
      form: z.literal("single-command-output"),
      status: z.enum(["completed", "failed", "yielded"]),
      association: CodexCommandAssociationSchema.optional(),
    })
    .strict(),
]);
export type CodexCommandMetadata = z.infer<typeof CodexCommandMetadataSchema>;

/** Reject malformed or extended carriers rather than trusting an unvalidated metadata hint. */
export function readCodexCommandMetadata(value: unknown): CodexCommandMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const carrier = (value as Record<string, unknown>)[RESIN_CODEX_COMMAND_METADATA_KEY];
  if (carrier === undefined) return undefined;
  const parsed = CodexCommandMetadataSchema.safeParse(carrier);
  return parsed.success ? parsed.data : undefined;
}
