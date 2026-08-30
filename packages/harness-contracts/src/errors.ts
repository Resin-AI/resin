/**
 * Standard error codes for the HarnessError taxonomy.
 */
export const HarnessErrorCode = {
  MISSING_HARNESS: "MISSING_HARNESS",
  UNSUPPORTED_VERSION: "UNSUPPORTED_VERSION",
  INACCESSIBLE_TRANSCRIPT: "INACCESSIBLE_TRANSCRIPT",
  MALFORMED_RECORD: "MALFORMED_RECORD",
  AMBIGUOUS_ACTIVE_SESSION: "AMBIGUOUS_ACTIVE_SESSION",
  PERMISSION_ERROR: "PERMISSION_ERROR",
  CONCURRENT_CONFIG_MUTATION: "CONCURRENT_CONFIG_MUTATION",
  CONFIG_PRECONDITION_FAILED: "CONFIG_PRECONDITION_FAILED",
  TRANSCRIPT_ROTATED: "TRANSCRIPT_ROTATED",
  REFRESH_FAILED: "REFRESH_FAILED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type HarnessErrorDetailValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | HarnessErrorDetailRecord
  | HarnessErrorDetailValue[];

export interface HarnessErrorDetailRecord {
  [key: string]: HarnessErrorDetailValue;
}

/**
 * Normalizes an arbitrary value into the HarnessErrorDetailValue contract.
 */
export function toHarnessErrorDetailValue(cause: unknown): HarnessErrorDetailValue {
  if (cause === null || cause === undefined) {
    return cause;
  }
  const tag = Object.prototype.toString.call(cause);
  if (tag === "[object String]" || tag === "[object Number]" || tag === "[object Boolean]") {
    // SAFETY: Tag verification confirms cause is a primitive string, number, or boolean.
    return cause as string | number | boolean;
  }
  if (Array.isArray(cause)) {
    return cause.map((item) => toHarnessErrorDetailValue(item));
  }
  if (cause instanceof Error) {
    const errorRecord: HarnessErrorDetailRecord = {
      name: cause.name,
      message: cause.message,
    };
    if (cause.stack) {
      errorRecord.stack = cause.stack;
    }
    return errorRecord;
  }
  if (tag === "[object Object]") {
    const record: HarnessErrorDetailRecord = {};
    for (const [k, v] of Object.entries(cause)) {
      record[k] = toHarnessErrorDetailValue(v);
    }
    return record;
  }
  return String(cause);
}

export type HarnessErrorCode = (typeof HarnessErrorCode)[keyof typeof HarnessErrorCode];

/**
 * Base class for all harness-related errors.
 */
export class HarnessError extends Error {
  readonly code: HarnessErrorCode;
  readonly harnessId?: string;
  readonly details?: HarnessErrorDetailRecord;
  readonly isHarnessError = true;
  constructor(
    code: HarnessErrorCode,
    message: string,
    options?: {
      harnessId?: string;
      details?: HarnessErrorDetailRecord;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = this.constructor.name;
    this.code = code;
    this.harnessId = options?.harnessId;
    this.details = options?.details;

    // Ensure proper prototype chain inheritance in transpiled environments
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Error thrown when an AI harness executable, CLI, or required environment is missing.
 */
export class MissingHarnessError extends HarnessError {
  constructor(
    message: string,
    options?: {
      harnessId?: string;
      details?: HarnessErrorDetailRecord;
      cause?: unknown;
    },
  ) {
    super(HarnessErrorCode.MISSING_HARNESS, message, options);
  }
}

/**
 * Error thrown when a detected harness version does not satisfy the supported version constraints.
 */
export class UnsupportedVersionError extends HarnessError {
  readonly detectedVersion?: string;
  readonly supportedVersions?: readonly string[];

  constructor(
    message: string,
    options?: {
      harnessId?: string;
      detectedVersion?: string;
      supportedVersions?: readonly string[];
      details?: HarnessErrorDetailRecord;
      cause?: unknown;
    },
  ) {
    super(HarnessErrorCode.UNSUPPORTED_VERSION, message, {
      ...options,
      details: {
        ...options?.details,
        detectedVersion: options?.detectedVersion,
        supportedVersions: options?.supportedVersions ? [...options.supportedVersions] : undefined,
      },
    });
    this.detectedVersion = options?.detectedVersion;
    this.supportedVersions = options?.supportedVersions;
  }
}

/**
 * Error thrown when a session transcript or log file cannot be read, opened, or located.
 */
export class InaccessibleTranscriptError extends HarnessError {
  readonly path?: string;

  constructor(
    message: string,
    options?: {
      harnessId?: string;
      path?: string;
      details?: HarnessErrorDetailRecord;
      cause?: unknown;
    },
  ) {
    super(HarnessErrorCode.INACCESSIBLE_TRANSCRIPT, message, {
      ...options,
      details: { ...options?.details, path: options?.path },
    });
    this.path = options?.path;
  }
}

/**
 * Error thrown when an entry or line in a transcript cannot be parsed or is corrupted.
 */
export class MalformedRecordError extends HarnessError {
  readonly rawRecord?: unknown;

  constructor(
    message: string,
    options?: {
      harnessId?: string;
      rawRecord?: unknown;
      details?: HarnessErrorDetailRecord;
      cause?: unknown;
    },
  ) {
    super(HarnessErrorCode.MALFORMED_RECORD, message, {
      ...options,
      details: {
        ...options?.details,
        rawRecord:
          options?.rawRecord !== undefined
            ? toHarnessErrorDetailValue(options.rawRecord)
            : undefined,
      },
    });
    this.rawRecord = options?.rawRecord;
  }
}

/**
 * Error thrown when resolveActiveSession finds multiple conflicting or ambiguous active sessions.
 */
export class AmbiguousActiveSessionError extends HarnessError {
  readonly candidateSessionIds?: readonly string[];

  constructor(
    message: string,
    options?: {
      harnessId?: string;
      candidateSessionIds?: readonly string[];
      details?: HarnessErrorDetailRecord;
      cause?: unknown;
    },
  ) {
    super(HarnessErrorCode.AMBIGUOUS_ACTIVE_SESSION, message, {
      ...options,
      details: {
        ...options?.details,
        candidateSessionIds: options?.candidateSessionIds
          ? [...options.candidateSessionIds]
          : undefined,
      },
    });
    this.candidateSessionIds = options?.candidateSessionIds;
  }
}

/**
 * Error thrown when filesystem, process, or IPC operations fail due to permissions.
 */
export class HarnessPermissionError extends HarnessError {
  readonly targetPath?: string;

  constructor(
    message: string,
    options?: {
      harnessId?: string;
      targetPath?: string;
      details?: HarnessErrorDetailRecord;
      cause?: unknown;
    },
  ) {
    super(HarnessErrorCode.PERMISSION_ERROR, message, {
      ...options,
      details: { ...options?.details, targetPath: options?.targetPath },
    });
    this.targetPath = options?.targetPath;
  }
}

/**
 * Error thrown when a configuration file is mutated concurrently or modified externally.
 */
export class ConcurrentConfigMutationError extends HarnessError {
  readonly targetPath?: string;
  readonly expectedHash?: string;
  readonly actualHash?: string;

  constructor(
    message: string,
    options?: {
      harnessId?: string;
      targetPath?: string;
      expectedHash?: string;
      actualHash?: string;
      details?: HarnessErrorDetailRecord;
      cause?: unknown;
    },
  ) {
    super(HarnessErrorCode.CONCURRENT_CONFIG_MUTATION, message, {
      ...options,
      details: {
        ...options?.details,
        targetPath: options?.targetPath,
        expectedHash: options?.expectedHash,
        actualHash: options?.actualHash,
      },
    });
    this.targetPath = options?.targetPath;
    this.expectedHash = options?.expectedHash;
    this.actualHash = options?.actualHash;
  }
}

/**
 * Error thrown when a configuration mutation plan fails precondition hash validation.
 */
export class ConfigPreconditionFailedError extends HarnessError {
  readonly targetPath?: string;
  readonly expectedHash?: string;
  readonly actualHash?: string;

  constructor(
    message: string,
    options?: {
      harnessId?: string;
      targetPath?: string;
      expectedHash?: string;
      actualHash?: string;
      details?: HarnessErrorDetailRecord;
      cause?: unknown;
    },
  ) {
    super(HarnessErrorCode.CONFIG_PRECONDITION_FAILED, message, {
      ...options,
      details: {
        ...options?.details,
        targetPath: options?.targetPath,
        expectedHash: options?.expectedHash,
        actualHash: options?.actualHash,
      },
    });
    this.targetPath = options?.targetPath;
    this.expectedHash = options?.expectedHash;
    this.actualHash = options?.actualHash;
  }
}

/**
 * Error thrown when a session transcript is rotated, truncated, or replaced unexpectedly.
 */
export class TranscriptRotatedError extends HarnessError {
  readonly transcriptPath?: string;

  constructor(
    message: string,
    options?: {
      harnessId?: string;
      transcriptPath?: string;
      details?: HarnessErrorDetailRecord;
      cause?: unknown;
    },
  ) {
    super(HarnessErrorCode.TRANSCRIPT_ROTATED, message, {
      ...options,
      details: { ...options?.details, transcriptPath: options?.transcriptPath },
    });
    this.transcriptPath = options?.transcriptPath;
  }
}

/**
 * Error thrown when tool catalog refresh notification to the harness fails.
 */
export class CatalogRefreshError extends HarnessError {
  constructor(
    message: string,
    options?: {
      harnessId?: string;
      details?: HarnessErrorDetailRecord;
      cause?: unknown;
    },
  ) {
    super(HarnessErrorCode.REFRESH_FAILED, message, options);
  }
}

/**
 * Type guard to check if an unknown error is a HarnessError.
 */
export function isHarnessError(error: Error | null | undefined): error is HarnessError {
  return error instanceof Error && "isHarnessError" in error && Boolean(error.isHarnessError);
}
