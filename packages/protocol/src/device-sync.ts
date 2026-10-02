import { ISOTimestampSchema, IdentifierSchema } from "@resin/contracts/common";
import { z } from "zod";
import {
  CONTROL_PLANE_CADENCE_JITTER_RATIO,
  CONTROL_PLANE_QUIET_POLL_INTERVAL_MS,
  ControlPlaneRevisionVectorSchema,
} from "./control-plane.js";

/**
 * Consolidated device sync.
 *
 * A device that keeps several things current (desired state, the tool catalog, account tool
 * access and pending validation asks) can learn whether any of them changed from one small,
 * authenticated read instead of polling each of them. The answer carries change tokens, never the
 * bodies: a device fetches a body from its existing endpoint only when that token changes, after it
 * lost its local copy or its identity changed, or on a bounded safety refresh.
 *
 * Negotiation is header-only so no existing strict response gains a field. A server that serves
 * this route sends {@link DEVICE_SYNC_CAPABILITY_HEADER}: {@link DEVICE_SYNC_CAPABILITY} on its
 * effective-state responses, 200 and 304 alike. A device without that advertisement, or whose sync
 * read answers 404/405/501, keeps polling every endpoint exactly as before. Under device sync the
 * device keeps the adaptive control-plane cadence (fast, then quiet after three unchanged reads,
 * positive-only jitter) and its separate heartbeat report.
 *
 * Tool access is authoritative: the server reads the account's current plan for every answer and
 * the route does not require an active plan, so a downgraded account still learns that it lost
 * access. An account without tool access receives no catalog, validation or desired-state token.
 */
export const DEVICE_SYNC_ROUTE = "/v1/device/sync";
export const DEVICE_SYNC_CAPABILITY_HEADER = "Resin-Device-Sync";
export const DEVICE_SYNC_CAPABILITY = "sync-v1";
export const DEVICE_SYNC_SCHEMA_VERSION = "1.0.0";

/**
 * Longest a device goes without refetching a body whose token has not changed. It bounds how long
 * a missed server-side invalidation could hide a change; it is not a polling interval.
 */
export const DEVICE_SYNC_SAFETY_REFRESH_MS = 60 * 60 * 1000;

/**
 * How old a sync answer one local process published may be and still stand in for another local
 * process's own polling: two quiet intervals at their longest jitter. Past it the consumer polls for
 * itself again, so a stopped or offline publisher never freezes what the consumer believes.
 */
export const DEVICE_SYNC_PUBLICATION_MAX_AGE_MS = Math.ceil(
  2 * CONTROL_PLANE_QUIET_POLL_INTERVAL_MS * (1 + CONTROL_PLANE_CADENCE_JITTER_RATIO),
);

/** Opaque change token: equal tokens mean the body behind them is unchanged. */
export const DeviceSyncTokenSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\x21-\x7e]+$/);

export const DeviceSyncDesiredSchema = z
  .object({
    revisions: ControlPlaneRevisionVectorSchema,
    revisionToken: z.string().regex(/^w:\d+:d:\d+$/),
  })
  .strict();
export type DeviceSyncDesired = z.infer<typeof DeviceSyncDesiredSchema>;

export const DeviceSyncResponseSchema = z
  .object({
    schemaVersion: z.literal(DEVICE_SYNC_SCHEMA_VERSION),
    deviceId: IdentifierSchema,
    accountId: z.string().min(1),
    userId: z.string().min(1),
    /** Same values as the account tool-access read. */
    toolAccess: z.enum(["allowed", "subscription_inactive"]),
    /** When the server read the plan behind `toolAccess`. */
    checkedAt: ISOTimestampSchema,
    /** Revision vector of the effective desired state, in its acknowledgement format. */
    desired: DeviceSyncDesiredSchema.nullable(),
    /** Changes whenever the catalog snapshot this identity is served may have changed. */
    catalogToken: DeviceSyncTokenSchema.nullable(),
    /** Changes whenever the pending validation asks listed for this device may have changed. */
    validationToken: DeviceSyncTokenSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.toolAccess === "allowed") return;
    for (const key of ["desired", "catalogToken", "validationToken"] as const) {
      if (value[key] !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: "An account without tool access receives no paid-data tokens",
        });
      }
    }
  });
export type DeviceSyncResponse = z.infer<typeof DeviceSyncResponseSchema>;
