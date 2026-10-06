import { z } from "zod";

/**
 * Event metadata key carrying the value-free identity of the directory a recorded call ran in.
 *
 * It rides inside `NormalizedSessionEvent.metadata`, an open record every contracts version
 * accepts, so a cloud that predates the key stores it untouched and ignores it.
 */
export const RESIN_WORKING_DIRECTORY_METADATA_KEY = "__resinWorkingDirectoryV1" as const;

/** Hex characters of a working-directory identity: a 128-bit truncated HMAC-SHA256. */
export const WORKING_DIRECTORY_IDENTITY_HEX_LENGTH = 32;

const IdentityDigestSchema = z
  .string()
  .length(WORKING_DIRECTORY_IDENTITY_HEX_LENGTH)
  .regex(/^[0-9a-f]+$/);

/**
 * Equality-only identities of a recorded call's working directory.
 *
 * Each value is HMAC-SHA256 under a key derived from a random per-installation secret that never
 * leaves the device, over the normalized absolute path, truncated to 128 bits. Within one
 * installation the same directory always yields the same value and different directories differ;
 * nothing else can be learned from it, and values from two installations are unrelated.
 *
 * - `directory`: the call's effective working directory (the harness's per-call working-directory
 *   argument resolved against the session's directory, or the session's directory when the call
 *   names none).
 * - `repository`: the enclosing repository root (nearest ancestor holding `.git`), when the device
 *   could establish one. Computed in the same space as `directory`, so the two are equal exactly when
 *   the call ran at the repository root.
 */
export const WorkingDirectoryIdentitySchema = z
  .object({
    directory: IdentityDigestSchema,
    repository: IdentityDigestSchema.optional(),
  })
  .strict();

export type WorkingDirectoryIdentity = z.infer<typeof WorkingDirectoryIdentitySchema>;

/** Reads the carrier, failing closed on anything that is not exactly its frozen shape. */
export function readWorkingDirectoryIdentity(value: unknown): WorkingDirectoryIdentity | undefined {
  const parsed = WorkingDirectoryIdentitySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
