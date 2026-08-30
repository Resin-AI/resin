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

export interface QualificationHostTarget {
  readonly toolId?: string;
  readonly toolVersion?: string;
  readonly manifest?: ToolManifest;
  readonly digest?: string;
  readonly entrypointPath?: string;
}

export type TokenVerificationCandidate =
  | VerifiedQualificationToken
  | TokenCarrier
  | QualificationHostTarget
  | QualificationArtifactBundle
  | ObservedEffectProfile
  | null
  | undefined;

export interface TokenCarrier {
  readonly qualificationToken?: VerifiedQualificationToken | object | null;
  readonly token?: VerifiedQualificationToken | object | null;
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
export function registerVerifiedHostObject(
  host: QualificationHostTarget,
  data: VerifiedQualificationData,
): void {
  if (host !== null && host !== undefined) {
    VERIFIED_QUALIFICATION_TOKENS.set(host, data);
  }
}

/**
 * Checks whether a candidate object is a verified qualification token or registered host object.
 */
export function isVerifiedQualificationToken(
  candidate: TokenVerificationCandidate,
): candidate is VerifiedQualificationToken {
  if (candidate === null || candidate === undefined || Array.isArray(candidate)) {
    return false;
  }
  if (VERIFIED_QUALIFICATION_TOKENS.has(candidate)) {
    return true;
  }
  if (
    "qualificationToken" in candidate &&
    candidate.qualificationToken !== null &&
    candidate.qualificationToken !== undefined &&
    !Array.isArray(candidate.qualificationToken) &&
    VERIFIED_QUALIFICATION_TOKENS.has(candidate.qualificationToken)
  ) {
    return true;
  }
  if (
    "token" in candidate &&
    candidate.token !== null &&
    candidate.token !== undefined &&
    !Array.isArray(candidate.token) &&
    VERIFIED_QUALIFICATION_TOKENS.has(candidate.token)
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
  candidate: TokenVerificationCandidate,
): VerifiedQualificationData | undefined {
  if (candidate === null || candidate === undefined || Array.isArray(candidate)) {
    return undefined;
  }
  if (VERIFIED_QUALIFICATION_TOKENS.has(candidate)) {
    return VERIFIED_QUALIFICATION_TOKENS.get(candidate);
  }
  if (
    "qualificationToken" in candidate &&
    candidate.qualificationToken !== null &&
    candidate.qualificationToken !== undefined &&
    !Array.isArray(candidate.qualificationToken) &&
    VERIFIED_QUALIFICATION_TOKENS.has(candidate.qualificationToken)
  ) {
    return VERIFIED_QUALIFICATION_TOKENS.get(candidate.qualificationToken);
  }
  if (
    "token" in candidate &&
    candidate.token !== null &&
    candidate.token !== undefined &&
    !Array.isArray(candidate.token) &&
    VERIFIED_QUALIFICATION_TOKENS.has(candidate.token)
  ) {
    return VERIFIED_QUALIFICATION_TOKENS.get(candidate.token);
  }
  return undefined;
}
