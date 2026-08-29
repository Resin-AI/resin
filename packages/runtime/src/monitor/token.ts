import type {
  ObservedEffectProfile,
  QualificationArtifactBundle,
  QualificationRunRecord,
  ToolManifest,
  ToolQualificationApproval,
} from "@resin/contracts";

/**
 * Internal qualification data payload attached to a verified token.
 */
export interface VerifiedQualificationData {
  toolId: string;
  toolVersion: string;
  sourceDigest: string;
  depDigest: string;
  schemaDigest: string;
  intentDigest: string;
  approval: ToolQualificationApproval;
  runs: QualificationRunRecord[];
  effectProfile?: ObservedEffectProfile;
  manifest?: ToolManifest;
  dependencies?: Record<string, string>;
  rawBundle?: QualificationArtifactBundle;
}

/**
 * Internal private branding symbol for verified tokens.
 */
export const TOKEN_BRAND: unique symbol = Symbol("VerifiedQualificationToken");

/**
 * Opaque verified qualification token.
 * Created exclusively by ToolBundleLoader upon successful qualification validation.
 */
export interface VerifiedQualificationToken {
  readonly [TOKEN_BRAND]: true;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly verifiedAt: number;
}

/**
 * Private module WeakMap backing verified qualification tokens.
 * WeakSet/WeakMap-backed guarantee: fabricated objects not in this WeakMap
 * are rejected by EffectMonitor.
 */
const VERIFIED_QUALIFICATION_TOKENS = new WeakMap<object, VerifiedQualificationData>();

/**
 * Internal helper to create and register a VerifiedQualificationToken.
 * Callable exclusively by ToolBundleLoader upon successful bundle validation.
 */
export function createVerifiedQualificationToken(
  data: VerifiedQualificationData,
): VerifiedQualificationToken {
  const token: VerifiedQualificationToken = Object.freeze({
    [TOKEN_BRAND]: true as const,
    toolId: data.toolId,
    toolVersion: data.toolVersion,
    verifiedAt: Date.now(),
  });

  VERIFIED_QUALIFICATION_TOKENS.set(token, data);
  return token;
}

/**
 * Associates a host object (such as LoadedToolBundle) with verified qualification data.
 */
export function registerVerifiedHostObject(host: object, data: VerifiedQualificationData): void {
  if (host && typeof host === "object") {
    VERIFIED_QUALIFICATION_TOKENS.set(host, data);
  }
}

/**
 * Checks whether a candidate object is a verified qualification token or registered host object.
 */
export function isVerifiedQualificationToken(
  candidate: unknown,
): candidate is VerifiedQualificationToken {
  if (!candidate || typeof candidate !== "object") {
    return false;
  }
  if (VERIFIED_QUALIFICATION_TOKENS.has(candidate)) {
    return true;
  }
  const tokenProp = (candidate as Record<string, unknown>).qualificationToken;
  if (tokenProp && typeof tokenProp === "object" && VERIFIED_QUALIFICATION_TOKENS.has(tokenProp)) {
    return true;
  }
  const tokenProp2 = (candidate as Record<string, unknown>).token;
  if (
    tokenProp2 &&
    typeof tokenProp2 === "object" &&
    VERIFIED_QUALIFICATION_TOKENS.has(tokenProp2)
  ) {
    return true;
  }
  return false;
}

/**
 * Extracts the verified qualification data for a token or registered host object.
 * Returns undefined if candidate is unverified or fabricated.
 */
export function getVerifiedQualificationData(
  candidate: unknown,
): VerifiedQualificationData | undefined {
  if (!candidate || typeof candidate !== "object") {
    return undefined;
  }
  if (VERIFIED_QUALIFICATION_TOKENS.has(candidate)) {
    return VERIFIED_QUALIFICATION_TOKENS.get(candidate);
  }
  const tokenProp = (candidate as Record<string, unknown>).qualificationToken;
  if (tokenProp && typeof tokenProp === "object" && VERIFIED_QUALIFICATION_TOKENS.has(tokenProp)) {
    return VERIFIED_QUALIFICATION_TOKENS.get(tokenProp);
  }
  const tokenProp2 = (candidate as Record<string, unknown>).token;
  if (
    tokenProp2 &&
    typeof tokenProp2 === "object" &&
    VERIFIED_QUALIFICATION_TOKENS.has(tokenProp2)
  ) {
    return VERIFIED_QUALIFICATION_TOKENS.get(tokenProp2);
  }
  return undefined;
}
