import { z } from "zod";

/** Positive account entitlement confirmation, independent of product authorization errors. */
export const AccountToolAccessResponseSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    accountId: z.string().min(1),
    userId: z.string().min(1),
    toolAccess: z.enum(["allowed", "subscription_inactive"]),
  })
  .strict();

export type AccountToolAccessResponse = z.infer<typeof AccountToolAccessResponseSchema>;
