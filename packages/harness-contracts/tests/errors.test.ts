import { describe, expect, it } from "vitest";
import {
  AmbiguousActiveSessionError,
  CatalogRefreshError,
  ConcurrentConfigMutationError,
  ConfigPreconditionFailedError,
  HarnessError,
  HarnessErrorCode,
  HarnessPermissionError,
  InaccessibleTranscriptError,
  MalformedRecordError,
  MissingHarnessError,
  TranscriptRotatedError,
  UnsupportedVersionError,
  isHarnessError,
} from "../src/errors.js";

describe("HarnessError Taxonomy", () => {
  it("instantiates MissingHarnessError with code and properties", () => {
    const err = new MissingHarnessError("Binary not found", {
      harnessId: "omp",
      details: { binary: "omp" },
    });

    expect(err.code).toBe(HarnessErrorCode.MISSING_HARNESS);
    expect(err.harnessId).toBe("omp");
    expect(err.details?.binary).toBe("omp");
    expect(err.name).toBe("MissingHarnessError");
    expect(err instanceof HarnessError).toBe(true);
    expect(err instanceof Error).toBe(true);
    expect(isHarnessError(err)).toBe(true);
  });

  it("instantiates UnsupportedVersionError with version info", () => {
    const err = new UnsupportedVersionError("Version 0.5 is not supported", {
      harnessId: "claude-code",
      detectedVersion: "0.5.0",
      supportedVersions: ["1.0.0", ">=1.0.0"],
    });

    expect(err.code).toBe(HarnessErrorCode.UNSUPPORTED_VERSION);
    expect(err.detectedVersion).toBe("0.5.0");
    expect(err.supportedVersions).toEqual(["1.0.0", ">=1.0.0"]);
    expect(isHarnessError(err)).toBe(true);
  });

  it("instantiates InaccessibleTranscriptError with path", () => {
    const err = new InaccessibleTranscriptError("File not found", {
      harnessId: "omp",
      path: "/var/log/session.log",
    });

    expect(err.code).toBe(HarnessErrorCode.INACCESSIBLE_TRANSCRIPT);
    expect(err.path).toBe("/var/log/session.log");
    expect(isHarnessError(err)).toBe(true);
  });

  it("instantiates MalformedRecordError with raw payload", () => {
    const raw = { corrupted: true };
    const err = new MalformedRecordError("Cannot parse JSON line", {
      harnessId: "codex-cli",
      rawRecord: raw,
    });

    expect(err.code).toBe(HarnessErrorCode.MALFORMED_RECORD);
    expect(err.rawRecord).toBe(raw);
    expect(isHarnessError(err)).toBe(true);
  });

  it("instantiates AmbiguousActiveSessionError with candidate IDs", () => {
    const candidates = ["sess-1", "sess-2"];
    const err = new AmbiguousActiveSessionError("Multiple running sessions", {
      harnessId: "omp",
      candidateSessionIds: candidates,
    });

    expect(err.code).toBe(HarnessErrorCode.AMBIGUOUS_ACTIVE_SESSION);
    expect(err.candidateSessionIds).toEqual(candidates);
    expect(isHarnessError(err)).toBe(true);
  });

  it("instantiates HarnessPermissionError with target path", () => {
    const err = new HarnessPermissionError("EACCES on config write", {
      harnessId: "omp",
      targetPath: "/etc/omp/config.json",
    });

    expect(err.code).toBe(HarnessErrorCode.PERMISSION_ERROR);
    expect(err.targetPath).toBe("/etc/omp/config.json");
    expect(isHarnessError(err)).toBe(true);
  });

  it("instantiates ConcurrentConfigMutationError with hash mismatch info", () => {
    const err = new ConcurrentConfigMutationError("File modified concurrently", {
      harnessId: "omp",
      targetPath: "/config.json",
      expectedHash: "aaa",
      actualHash: "bbb",
    });

    expect(err.code).toBe(HarnessErrorCode.CONCURRENT_CONFIG_MUTATION);
    expect(err.expectedHash).toBe("aaa");
    expect(err.actualHash).toBe("bbb");
    expect(isHarnessError(err)).toBe(true);
  });

  it("instantiates ConfigPreconditionFailedError with hash mismatch info", () => {
    const err = new ConfigPreconditionFailedError("Precondition not met", {
      harnessId: "omp",
      targetPath: "/config.json",
      expectedHash: "111",
      actualHash: "222",
    });

    expect(err.code).toBe(HarnessErrorCode.CONFIG_PRECONDITION_FAILED);
    expect(err.expectedHash).toBe("111");
    expect(err.actualHash).toBe("222");
    expect(isHarnessError(err)).toBe(true);
  });

  it("instantiates TranscriptRotatedError with transcript path", () => {
    const err = new TranscriptRotatedError("File truncated during read", {
      harnessId: "omp",
      transcriptPath: "/logs/active.log",
    });

    expect(err.code).toBe(HarnessErrorCode.TRANSCRIPT_ROTATED);
    expect(err.transcriptPath).toBe("/logs/active.log");
    expect(isHarnessError(err)).toBe(true);
  });

  it("instantiates CatalogRefreshError with message", () => {
    const err = new CatalogRefreshError("IPC message timeout", {
      harnessId: "omp",
      details: { timeoutMs: 5000 },
    });

    expect(err.code).toBe(HarnessErrorCode.REFRESH_FAILED);
    expect(isHarnessError(err)).toBe(true);
  });

  it("verifies isHarnessError type guard for non-harness errors", () => {
    expect(isHarnessError(new Error("generic"))).toBe(false);
    expect(isHarnessError("string error")).toBe(false);
    expect(isHarnessError(null)).toBe(false);
    expect(isHarnessError({ code: "MISSING_HARNESS" })).toBe(false);
  });
});
