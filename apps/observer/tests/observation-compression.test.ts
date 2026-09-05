import { gunzipSync } from "node:zlib";
import type { NormalizedSessionEvent } from "@resin/contracts";
import { describe, expect, it, vi } from "vitest";
import { CloudObservationClient } from "../src/cloud-runtime.js";

const identity = {
  accountId: "account-test",
  workspaceId: "workspace-test",
  deviceId: "device-test",
  installationId: "installation-test",
  userId: "user-test",
  accessToken: "test-token",
  cloudUrl: "https://api.example.test",
};
describe("observation transport compression", () => {
  it.each([1, 100])(
    "preserves %s metadata-only events byte-for-byte after decoding",
    async (count) => {
      const observations: NormalizedSessionEvent[] = Array.from({ length: count }, (_, index) => ({
        eventId: `event-${index}`,
        schemaVersion: "1.0.0",
        sessionId: "session-test",
        timestamp: "2026-09-05T00:00:00.000Z",
        causalRef: { causalSequence: index },
        redaction: {
          isRedacted: true,
          redactedFields: ["result"],
          redactionStrategy: "drop",
          scrubbedPatterns: [],
        },
        type: "tool_result",
        callId: `call-${index}`,
        toolName: "read",
        isError: false,
        executionDurationMs: 10,
        outputSizeBytes: 10000,
      }));
      const requests: RequestInit[] = [];
      const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        requests.push(init ?? {});
        return new Response(
          JSON.stringify({
            batchId: "batch-test",
            status: "accepted",
            acceptedCount: count,
            rejectedCount: 0,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });
      const client = new CloudObservationClient({
        identityProvider: async () => identity,
        fetchImpl,
      });
      await client.sendObservationBatch({ batchId: "batch-test", observations });
      const request = requests[0];
      const headers = new Headers(request.headers);
      const compressed = headers.get("Content-Encoding") === "gzip";
      expect(compressed).toBe(count === 100);
      const body = request.body;
      const text =
        compressed && body instanceof Uint8Array ? gunzipSync(body).toString("utf8") : String(body);
      expect(JSON.parse(text)).toEqual({
        batchId: "batch-test",
        workspaceId: identity.workspaceId,
        deviceId: identity.deviceId,
        installationId: identity.installationId,
        compressed: false,
        compression: "none",
        observations,
      });
      if (compressed && body instanceof Uint8Array)
        expect(body.byteLength / Buffer.byteLength(text)).toBeLessThan(0.2);
      expect(headers.get("Authorization")).toBe("Bearer test-token");
    },
  );
});
