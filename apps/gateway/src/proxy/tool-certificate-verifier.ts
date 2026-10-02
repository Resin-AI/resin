import {
  type V1ToolCertificate,
  normalizeSha256,
  verifyToolCertificateSignature,
} from "@resin/contracts";
import { reportEvent as reportProcessEvent } from "@resin/observer/error-reporting/core";
import type { ToolCertificatesFetchResult } from "./client.js";
import {
  TOOL_CERTIFICATE_FAILURE_OUTCOMES,
  type ToolCertificateCheckRecord,
  type ToolCertificateOutcome,
  type ToolSignatureStateStore,
  toolSignatureScopeKey,
} from "./tool-signature-state.js";
import {
  PINNED_TOOL_SIGNING_TRUST,
  type ToolSigningTrust,
  type TrustedToolSigningKey,
  toolSigningOrigin,
  trustedToolSigningKeysFor,
} from "./tool-signing-trust.js";

/** The device credential a certificate must be bound to, and the cloud that served it. */
export interface ToolCertificateIdentity {
  cloudUrl: string;
  accountId: string;
  workspaceId: string;
}

/** The lock entry being activated: what a certificate must bind. */
export interface ToolCertificateSubject {
  toolId: string;
  name: string;
  version: string;
  manifestDigest: string;
  artifactDigest: string;
}

/** Process-wide notification memory: one stderr warning, one event per failure class. */
export interface ToolCertificateNotificationLatch {
  warned: boolean;
  reported: Set<string>;
}

const PROCESS_LATCH: ToolCertificateNotificationLatch = { warned: false, reported: new Set() };

export const TOOL_CERTIFICATE_EVENT = "tool_certificate_check_failed";

const TOOL_CERTIFICATE_WARNING =
  "resin: a cloud tool's signature certificate did not verify (report-only; the tool still runs). " +
  "See `resin status` for the summary.\n";

export interface ToolCertificateReporterOptions {
  /**
   * The device credential to bind against. `online` is false for passes that must not touch the
   * network (cold-start offline restore). Null skips checking.
   */
  identity: (online: boolean) => Promise<ToolCertificateIdentity | null>;
  fetchCertificates: () => Promise<ToolCertificatesFetchResult>;
  store: ToolSignatureStateStore;
  /** Pinned keys; tests inject generated keys. Defaults to the compiled-in pins. */
  trust?: ToolSigningTrust;
  /**
   * Internal and off by default; never exposed to users. When true, any outcome other than
   * `verified` blocks activation.
   */
  enforce?: boolean;
  warn?: (message: string) => void;
  reportEvent?: (event: string, properties: Record<string, string>) => void;
  latch?: ToolCertificateNotificationLatch;
  now?: () => Date;
}

const OUTCOME_RANK: Record<ToolCertificateOutcome, number> = {
  verified: 0,
  "digest-mismatch": 1,
  "binding-mismatch": 2,
  "invalid-signature": 3,
  "unknown-key": 4,
  "missing-certificate": 5,
  "unpinned-origin": 6,
};

function sameDigest(left: string, right: string): boolean {
  try {
    return normalizeSha256(left, false) === normalizeSha256(right, false);
  } catch {
    return false;
  }
}

function evaluateOne(
  certificate: V1ToolCertificate,
  keys: readonly TrustedToolSigningKey[],
  identity: ToolCertificateIdentity,
  subject: ToolCertificateSubject,
  verifiedArtifactDigest: string,
): ToolCertificateOutcome {
  const key = keys.find(
    (candidate) =>
      candidate.keyId === certificate.signature.keyId &&
      candidate.algorithm === certificate.signature.algorithm,
  );
  if (!key) return "unknown-key";
  if (!verifyToolCertificateSignature(certificate, key.publicKeyPem)) return "invalid-signature";
  if (
    certificate.accountId !== identity.accountId ||
    certificate.workspaceId !== identity.workspaceId ||
    certificate.toolId !== subject.toolId ||
    certificate.toolName !== subject.name ||
    certificate.version !== subject.version
  ) {
    return "binding-mismatch";
  }
  if (
    !sameDigest(certificate.artifactDigest, verifiedArtifactDigest) ||
    !sameDigest(certificate.manifestDigest, subject.manifestDigest)
  ) {
    return "digest-mismatch";
  }
  return "verified";
}

/**
 * Classifies one activated tool version against the certificates available for it. Pure: the
 * trusted keys are the pins for `identity.cloudUrl`'s origin (undefined when unpinned).
 */
export function evaluateToolCertificate(input: {
  certificates: readonly V1ToolCertificate[];
  keys: readonly TrustedToolSigningKey[] | undefined;
  identity: ToolCertificateIdentity;
  subject: ToolCertificateSubject;
  verifiedArtifactDigest: string;
}): ToolCertificateOutcome {
  if (!input.keys) return "unpinned-origin";
  let best: ToolCertificateOutcome = "missing-certificate";
  for (const certificate of input.certificates) {
    if (certificate.toolId !== input.subject.toolId) continue;
    if (certificate.version !== input.subject.version) continue;
    const outcome = evaluateOne(
      certificate,
      input.keys,
      input.identity,
      input.subject,
      input.verifiedArtifactDigest,
    );
    if (OUTCOME_RANK[outcome] < OUTCOME_RANK[best]) best = outcome;
    if (best === "verified") break;
  }
  return best;
}

interface PassContext {
  identity: ToolCertificateIdentity;
  keys: readonly TrustedToolSigningKey[] | undefined;
  certificates: readonly V1ToolCertificate[];
  certificateScopeKey: string;
  fetched?: readonly V1ToolCertificate[];
}

/**
 * Report-only verification of cloud tool certificates. Checks never throw and, unless the
 * internal `enforce` option is set, never change whether a tool activates or runs.
 */
export class ToolCertificateReporter {
  readonly enforce: boolean;
  private readonly options: ToolCertificateReporterOptions;

  constructor(options: ToolCertificateReporterOptions) {
    this.options = options;
    this.enforce = options.enforce ?? false;
  }

  /** Starts one activation pass over a project lock. Certificates are fetched at most once. */
  beginPass(options: { online: boolean; projectId: string }): ToolCertificatePass {
    return new ToolCertificatePass(this, this.options, options);
  }
}

export class ToolCertificatePass {
  private context?: Promise<PassContext | null>;
  /** Latest outcome per (toolId, version, artifactDigest) checked in this pass. */
  private readonly records = new Map<string, ToolCertificateCheckRecord>();
  private scopeKey?: string;

  constructor(
    private readonly reporter: ToolCertificateReporter,
    private readonly options: ToolCertificateReporterOptions,
    private readonly pass: { online: boolean; projectId: string },
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async loadContext(): Promise<PassContext | null> {
    const identity = await this.options.identity(this.pass.online);
    if (!identity) return null;
    const origin = toolSigningOrigin(identity.cloudUrl) ?? identity.cloudUrl;
    this.scopeKey = toolSignatureScopeKey([
      origin,
      identity.accountId,
      identity.workspaceId,
      this.pass.projectId,
    ]);
    const certificateScopeKey = toolSignatureScopeKey([
      origin,
      identity.accountId,
      identity.workspaceId,
    ]);
    const keys = trustedToolSigningKeysFor(
      identity.cloudUrl,
      this.options.trust ?? PINNED_TOOL_SIGNING_TRUST,
    );
    // An unpinned cloud cannot be verified: do not spend a request on it.
    if (!keys) return { identity, keys, certificates: [], certificateScopeKey };

    let fetched: readonly V1ToolCertificate[] | undefined;
    if (this.pass.online) {
      try {
        const result = await this.options.fetchCertificates();
        if (result.kind === "certificates") fetched = result.certificates;
      } catch {
        // Unreachable or failing endpoint: fall back to the certificates stored last time.
      }
    }
    const certificates = fetched ?? this.options.store.readCertificates(certificateScopeKey);
    return { identity, keys, certificates, certificateScopeKey, fetched };
  }

  /** Whether `outcome` stops activation. Always false unless the internal enforce mode is on. */
  blocks(outcome: ToolCertificateOutcome | undefined): boolean {
    return this.reporter.enforce && outcome !== "verified";
  }

  /**
   * Checks one tool version whose artifact bytes already hash to `verifiedArtifactDigest`.
   * Returns undefined when no check could run (no credential, or an internal error). Never throws.
   */
  async check(
    subject: ToolCertificateSubject,
    verifiedArtifactDigest: string,
  ): Promise<ToolCertificateOutcome | undefined> {
    try {
      this.context ??= this.loadContext();
      const context = await this.context;
      if (!context) return undefined;
      const outcome = evaluateToolCertificate({
        certificates: context.certificates,
        keys: context.keys,
        identity: context.identity,
        subject,
        verifiedArtifactDigest,
      });
      const artifactDigest = normalizeSha256(verifiedArtifactDigest, false);
      this.records.set(JSON.stringify([subject.toolId, subject.version, artifactDigest]), {
        toolId: subject.toolId,
        version: subject.version,
        artifactDigest,
        outcome,
        checkedAt: this.now().toISOString(),
      });
      if (TOOL_CERTIFICATE_FAILURE_OUTCOMES.has(outcome)) this.notify(outcome);
      return outcome;
    } catch {
      this.notify("verifier-error");
      return undefined;
    }
  }

  /** Persists this pass's outcomes and any freshly fetched certificates. Never throws. */
  async finish(): Promise<void> {
    try {
      if (!this.context) return;
      const context = await this.context;
      if (!context || !this.scopeKey) return;
      this.options.store.write({
        scopeKey: this.scopeKey,
        records: [...this.records.values()],
        mode: this.reporter.enforce ? "enforce" : "report-only",
        ...(context.fetched
          ? {
              certificates: {
                scopeKey: context.certificateScopeKey,
                certificates: context.fetched,
              },
            }
          : {}),
        now: this.now(),
      });
    } catch {
      // Report-only state; a failed write is retried by the next pass.
    }
  }

  /** One stderr line per process; one event per failure class. Only fixed category strings. */
  private notify(failureClass: ToolCertificateOutcome | "verifier-error"): void {
    const latch = this.options.latch ?? PROCESS_LATCH;
    try {
      if (failureClass !== "verifier-error" && !latch.warned) {
        latch.warned = true;
        (this.options.warn ?? ((message) => process.stderr.write(message)))(
          TOOL_CERTIFICATE_WARNING,
        );
      }
    } catch {
      // A closed stderr must not affect the sync.
    }
    try {
      if (!latch.reported.has(failureClass)) {
        latch.reported.add(failureClass);
        (this.options.reportEvent ?? reportProcessEvent)(TOOL_CERTIFICATE_EVENT, {
          outcome: failureClass,
          mode: this.reporter.enforce ? "enforce" : "report-only",
        });
      }
    } catch {
      // Reporting never affects the program.
    }
  }
}
