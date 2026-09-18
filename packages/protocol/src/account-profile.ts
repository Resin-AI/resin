import { z } from "zod";

export const MembershipTypeSchema = z.enum(["free", "pro", "max", "founder"]);
export type MembershipType = z.infer<typeof MembershipTypeSchema>;

/** Read-only GET /v1/account/profile, bound to the authenticated device's account and user. */
export const AccountProfileResponseSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  accountId: z.string().min(1),
  userId: z.string().min(1),
  email: z.string().email().max(254),
  membershipType: MembershipTypeSchema,
});

export type AccountProfileResponse = z.infer<typeof AccountProfileResponseSchema>;
