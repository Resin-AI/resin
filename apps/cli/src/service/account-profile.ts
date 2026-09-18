import type { StoredCloudCredentials } from "@resin/observer";
import { AccountProfileResponseSchema } from "@resin/protocol";
import type { AccountProfileResponse } from "@resin/protocol";
import { validateCloudUrl } from "./auth-bootstrap.js";

const MAX_PROFILE_BYTES = 4_096;

/** Display-only metadata: never refresh, revoke, or rewrite credentials on lookup failure. */
export async function fetchAccountProfile(
  credentials: StoredCloudCredentials,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<AccountProfileResponse | null> {
  const userId = credentials.claims.userId?.trim() || credentials.claims.subject?.trim();
  if (!userId) return null;

  try {
    const cloudUrl = validateCloudUrl(credentials.cloudUrl);
    const response = await fetchImpl(`${cloudUrl}/v1/account/profile`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${credentials.accessToken}`,
        "Cache-Control": "no-store",
      },
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
    });
    if (response.status !== 200 || response.redirected || !response.body) {
      await response.body?.cancel();
      return null;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_PROFILE_BYTES) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const parsed = AccountProfileResponseSchema.safeParse(payload);
    if (
      !parsed.success ||
      parsed.data.accountId !== credentials.claims.accountId ||
      parsed.data.userId !== userId
    ) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}
