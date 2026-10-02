/**
 * The only keys this client trusts to sign tool certificates, pinned per cloud origin.
 *
 * Keys are compiled in: never read from cloud responses, the workspace, or environment variables.
 * A cloud origin not listed here has no trusted key, so its certificates are reported as
 * `unpinned-origin` and never verified. Rotating a key is a client release: add the new key beside
 * the old one, ship, and only then let the cloud sign with it.
 */

export type ToolSigningEnvironment = "production" | "staging";

export interface TrustedToolSigningKey {
  readonly keyId: string;
  readonly algorithm: "ed25519";
  /** SPKI PEM of the Ed25519 public key (the KMS key's public half). */
  readonly publicKeyPem: string;
  readonly environment: ToolSigningEnvironment;
}

/** Cloud origin (`URL.origin`) to the keys trusted for certificates that cloud serves. */
export type ToolSigningTrust = Readonly<Record<string, readonly TrustedToolSigningKey[]>>;

export const PRODUCTION_CLOUD_ORIGIN = "https://api.resin.sh";
export const STAGING_CLOUD_ORIGIN = "https://67sho46k61.execute-api.us-east-1.amazonaws.com";

// KMS key resin-production-tool-signing (ECC_NIST_EDWARDS25519), account 104818751793.
const PRODUCTION_TOOL_SIGNING_KEYS: readonly TrustedToolSigningKey[] = [
  {
    keyId: "production-tool-signing-2026-10",
    algorithm: "ed25519",
    publicKeyPem: [
      "-----BEGIN PUBLIC KEY-----",
      "MCowBQYDK2VwAyEAxTE6rEotF1EOYFTnJ/tjEabIjLrWdqW4eqT+wl+D6dI=",
      "-----END PUBLIC KEY-----",
      "",
    ].join("\n"),
    environment: "production",
  },
];

// KMS key resin-staging-tool-signing (ECC_NIST_EDWARDS25519), account 631718647304.
const STAGING_TOOL_SIGNING_KEYS: readonly TrustedToolSigningKey[] = [
  {
    keyId: "staging-tool-signing-2026-10",
    algorithm: "ed25519",
    publicKeyPem: [
      "-----BEGIN PUBLIC KEY-----",
      "MCowBQYDK2VwAyEAQv/B+ov06orWjCN9NP0YLjis3nCwYE6+kdW7qdQTdbM=",
      "-----END PUBLIC KEY-----",
      "",
    ].join("\n"),
    environment: "staging",
  },
];

/** Deep-freezes a trust table so no code path can add or swap a key at runtime. */
export function freezeToolSigningTrust(
  table: Record<string, readonly TrustedToolSigningKey[]>,
): ToolSigningTrust {
  const frozen: Record<string, readonly TrustedToolSigningKey[]> = Object.create(null);
  for (const [origin, keys] of Object.entries(table)) {
    frozen[origin] = Object.freeze(keys.map((key) => Object.freeze({ ...key })));
  }
  return Object.freeze(frozen);
}

export const PINNED_TOOL_SIGNING_TRUST: ToolSigningTrust = freezeToolSigningTrust({
  [PRODUCTION_CLOUD_ORIGIN]: PRODUCTION_TOOL_SIGNING_KEYS,
  [STAGING_CLOUD_ORIGIN]: STAGING_TOOL_SIGNING_KEYS,
});

/** The origin a cloud URL is pinned under, or undefined for an unparseable URL. */
export function toolSigningOrigin(cloudUrl: string): string | undefined {
  try {
    return new URL(cloudUrl).origin;
  } catch {
    return undefined;
  }
}

/**
 * The keys trusted to sign certificates served by `cloudUrl`'s origin, or undefined when that
 * origin is not pinned. Matching is on the exact origin (scheme, host and port).
 */
export function trustedToolSigningKeysFor(
  cloudUrl: string,
  trust: ToolSigningTrust = PINNED_TOOL_SIGNING_TRUST,
): readonly TrustedToolSigningKey[] | undefined {
  const origin = toolSigningOrigin(cloudUrl);
  if (origin === undefined || !Object.hasOwn(trust, origin)) return undefined;
  const keys = trust[origin];
  return keys !== undefined && keys.length > 0 ? keys : undefined;
}
