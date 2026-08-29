import { describe, expect, it } from "vitest";
import {
  ArtifactIntegrityError,
  ArtifactSizeExceededError,
  AsyncJobStatusResponseSchema,
  AsyncJobStatusSchema,
  JobAbortedError,
  JobExecutionStatusSchema,
  JobFailedError,
  JobMalformedResponseError,
  JobResultDescriptorSchema,
  JobStatusResponseSchema,
  JobTimeoutError,
  JobToolDescriptorSchema,
  ObservationBatchResponseSchema,
  S3ObjectDescriptorSchema,
} from "../src/index.js";

describe("Async Jobs Protocol Schemas & Errors", () => {
  it("validates JobExecutionStatusSchema for all valid states and rejects invalid states", () => {
    expect(JobExecutionStatusSchema.parse("accepted")).toBe("accepted");
    expect(JobExecutionStatusSchema.parse("queued")).toBe("queued");
    expect(JobExecutionStatusSchema.parse("running")).toBe("running");
    expect(JobExecutionStatusSchema.parse("completed")).toBe("completed");
    expect(JobExecutionStatusSchema.parse("failed")).toBe("failed");
    expect(AsyncJobStatusSchema.parse("completed")).toBe("completed");

    expect(() => JobExecutionStatusSchema.parse("unknown")).toThrow();
    expect(() => JobExecutionStatusSchema.parse("pending")).toThrow();
    expect(() => JobExecutionStatusSchema.parse(123)).toThrow();
  });

  it("validates S3ObjectDescriptorSchema with required and optional fields", () => {
    const validDescriptor = {
      bucket: "test-bucket",
      key: "results/acc-1/ws-1/job-123/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.json",
      contentType: "application/json",
      contentEncoding: "gzip",
      sizeBytes: 1024,
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      etag: '"d41d8cd98f00b204e9800998ecf8427e"',
    };

    const parsed = S3ObjectDescriptorSchema.parse(validDescriptor);
    expect(parsed.bucket).toBe("test-bucket");
    expect(parsed.key).toContain("results/");
    expect(parsed.sizeBytes).toBe(1024);
    expect(parsed.sha256).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

    // Rejects invalid sha256
    expect(() =>
      S3ObjectDescriptorSchema.parse({
        ...validDescriptor,
        sha256: "not-a-valid-sha256",
      }),
    ).toThrow();
  });

  it("validates JobToolDescriptorSchema and JobResultDescriptorSchema", () => {
    const toolDescriptor = {
      toolId: "tool-calc-01",
      version: "1.2.3",
      name: "Calculator Tool",
      description: "Mathematical computation tool",
      downloadUrl: "https://s3.amazonaws.com/test-bucket/tools/calc.tar.gz?sig=abc",
      expiresAt: "2026-08-26T12:00:00.000Z",
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      sizeBytes: 20480,
      contentType: "application/gzip",
      format: "tar.gz",
    };

    const parsedTool = JobToolDescriptorSchema.parse(toolDescriptor);
    expect(parsedTool.toolId).toBe("tool-calc-01");
    expect(parsedTool.version).toBe("1.2.3");
    expect(parsedTool.sizeBytes).toBe(20480);

    const resultDescriptor = {
      downloadUrl: "https://s3.amazonaws.com/test-bucket/results/res.json?sig=xyz",
      expiresAt: "2026-08-26T12:15:00.000Z",
      sha256: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      sizeBytes: 4096,
      tool: toolDescriptor,
      metadata: { itemsEvaluated: 15 },
    };

    const parsedResult = JobResultDescriptorSchema.parse(resultDescriptor);
    expect(parsedResult.downloadUrl).toBeDefined();
    expect(parsedResult.tool?.toolId).toBe("tool-calc-01");
    expect(parsedResult.metadata?.itemsEvaluated).toBe(15);
  });

  it("validates JobStatusResponseSchema across accepted, queued, running, completed, and failed statuses", () => {
    // 1. Accepted status
    const accepted = JobStatusResponseSchema.parse({
      jobId: "job-001",
      status: "accepted",
      createdAt: "2026-08-26T10:00:00.000Z",
    });
    expect(accepted.status).toBe("accepted");
    expect(accepted.jobId).toBe("job-001");

    // 2. Running status with progress
    const running = JobStatusResponseSchema.parse({
      jobId: "job-001",
      status: "running",
      progress: 65,
      createdAt: "2026-08-26T10:00:00.000Z",
      updatedAt: "2026-08-26T10:00:05.000Z",
    });
    expect(running.progress).toBe(65);

    // 3. Completed status with presigned S3 URLs and descriptors
    const completed = AsyncJobStatusResponseSchema.parse({
      jobId: "job-001",
      status: "completed",
      completedAt: "2026-08-26T10:00:10.000Z",
      downloadUrl: "https://s3.amazonaws.com/test-bucket/results/out.json?sig=res123",
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      sizeBytes: 512,
      descriptor: {
        bucket: "test-bucket",
        key: "results/out.json",
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        sizeBytes: 512,
      },
      result: {
        downloadUrl: "https://s3.amazonaws.com/test-bucket/results/out.json?sig=res123",
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        sizeBytes: 512,
      },
    });
    expect(completed.status).toBe("completed");
    expect(completed.downloadUrl).toBeDefined();

    // 4. Failed status with error details
    const failed = JobStatusResponseSchema.parse({
      jobId: "job-001",
      status: "failed",
      error: "LLM synthesis quota exceeded",
      errorCode: "rate_limited",
      details: { quotaLimit: 5000 },
    });
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("LLM synthesis quota exceeded");
    expect(failed.errorCode).toBe("rate_limited");
  });

  it("validates ObservationBatchResponseSchema with optional jobId and statusUrl while preserving backward compatibility", () => {
    // Synchronous standard batch response without async job fields
    const syncResponse = ObservationBatchResponseSchema.parse({
      batchId: "batch-101",
      status: "accepted",
      acceptedCount: 5,
      rejectedCount: 0,
      cursorAck: "cur_001",
    });
    expect(syncResponse.batchId).toBe("batch-101");
    expect(syncResponse.jobId).toBeUndefined();
    expect(syncResponse.statusUrl).toBeUndefined();

    // Async batch response with jobId and statusUrl
    const asyncResponse = ObservationBatchResponseSchema.parse({
      batchId: "batch-102",
      status: "accepted",
      acceptedCount: 10,
      rejectedCount: 0,
      jobId: "job-999",
      statusUrl: "https://api.resin.local/v1/jobs/job-999",
    });
    expect(asyncResponse.jobId).toBe("job-999");
    expect(asyncResponse.statusUrl).toBe("https://api.resin.local/v1/jobs/job-999");
  });

  it("constructs and validates protocol job error classes with expected properties and status codes", () => {
    // 1. JobFailedError
    const failedErr = new JobFailedError("job-123", "Worker crashed", {
      failureReason: "Out of memory",
      details: { memoryUsedMb: 4096 },
    });
    expect(failedErr.name).toBe("JobFailedError");
    expect(failedErr.jobId).toBe("job-123");
    expect(failedErr.failureReason).toBe("Out of memory");
    expect(failedErr.code).toBe("terminal");
    expect(failedErr.status).toBe(500);

    // 2. JobTimeoutError
    const timeoutErr = new JobTimeoutError("job-123", 60000);
    expect(timeoutErr.name).toBe("JobTimeoutError");
    expect(timeoutErr.jobId).toBe("job-123");
    expect(timeoutErr.elapsedMs).toBe(60000);
    expect(timeoutErr.status).toBe(504);

    // 3. JobAbortedError
    const abortedErr = new JobAbortedError("Client aborted polling", "job-123");
    expect(abortedErr.name).toBe("JobAbortedError");
    expect(abortedErr.jobId).toBe("job-123");
    expect(abortedErr.status).toBe(499);

    // 4. ArtifactIntegrityError
    const integrityErr = new ArtifactIntegrityError("expected-sha", "actual-sha");
    expect(integrityErr.name).toBe("ArtifactIntegrityError");
    expect(integrityErr.expectedDigest).toBe("expected-sha");
    expect(integrityErr.actualDigest).toBe("actual-sha");
    expect(integrityErr.status).toBe(422);

    // 5. ArtifactSizeExceededError
    const sizeErr = new ArtifactSizeExceededError(1000, 500);
    expect(sizeErr.name).toBe("ArtifactSizeExceededError");
    expect(sizeErr.actualSizeBytes).toBe(1000);
    expect(sizeErr.maxAllowedSizeBytes).toBe(500);
    expect(sizeErr.status).toBe(413);

    // 6. JobMalformedResponseError
    const malformedErr = new JobMalformedResponseError("Missing jobId");
    expect(malformedErr.name).toBe("JobMalformedResponseError");
    expect(malformedErr.status).toBe(502);
  });
});
