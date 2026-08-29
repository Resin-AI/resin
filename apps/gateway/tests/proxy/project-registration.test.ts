import { type V1ProjectMetadata, V1_SCHEMA_KINDS, V1_SCHEMA_VERSION } from "@resin/contracts";
import {
  type ProjectRegistrationRequest,
  type ProjectRegistrationResponse,
  ProtocolError,
} from "@resin/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudCircuitBreaker } from "../../src/proxy/circuit-breaker.js";
import { CloudCatalogClient } from "../../src/proxy/client.js";

describe("CloudCatalogClient Project Registration", () => {
  const sampleProject: V1ProjectMetadata = {
    schemaKind: V1_SCHEMA_KINDS.PROJECT_METADATA,
    schemaVersion: V1_SCHEMA_VERSION,
    projectId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    name: "Gateway Test Project",
    createdAt: "2026-08-24T12:00:00.000Z",
  };

  const validRequest: ProjectRegistrationRequest = {
    project: sampleProject,
    visibility: "workspace",
  };

  it("should successfully register a new project and return strictly parsed response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        outcome: "registered",
        projectId: sampleProject.projectId,
      }),
    });

    const client = new CloudCatalogClient({
      workspaceId: "ws-gateway-1",
      baseUrl: "https://cloud.resin.local",
      authToken: "secret-token-123",
      // SAFETY: Test fixture provides mock fetchFn.
      fetchFn: fetchMock as typeof fetch,
    });

    const response = await client.registerProject(validRequest);
    expect(response).toEqual({
      outcome: "registered",
      projectId: sampleProject.projectId,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // SAFETY: fetchMock was called once with [url, init] arguments.
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://cloud.resin.local/v1/projects");
    expect(init.method).toBe("POST");
    // SAFETY: RequestInit headers passed as record in test fetch.
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token-123");
    // SAFETY: RequestInit headers passed as record in test fetch.
    expect((init.headers as Record<string, string>)["x-workspace-id"]).toBe("ws-gateway-1");
  });

  it("should handle idempotent re-registration returning existing outcome", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        outcome: "existing",
        projectId: sampleProject.projectId,
      }),
    });

    const client = new CloudCatalogClient({
      workspaceId: "ws-gateway-1",
      baseUrl: "https://cloud.resin.local",
      authToken: "secret-token-123",
      // SAFETY: Test fixture provides mock fetchFn.
      fetchFn: fetchMock as typeof fetch,
    });

    const response = await client.registerProject(validRequest);
    expect(response.outcome).toBe("existing");
    expect(response.projectId).toBe(sampleProject.projectId);
  });

  it("should handle fork_required outcome without altering local UUID", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        outcome: "fork_required",
        projectId: sampleProject.projectId,
      }),
    });

    const client = new CloudCatalogClient({
      workspaceId: "ws-clone-1",
      baseUrl: "https://cloud.resin.local",
      authToken: "secret-token-123",
      // SAFETY: Test fixture provides mock fetchFn.
      fetchFn: fetchMock as typeof fetch,
    });

    const response = await client.registerProject(validRequest);
    expect(response.outcome).toBe("fork_required");
    expect(response.projectId).toBe(sampleProject.projectId);
  });

  it("should map network failure / offline state to local_only and preserve UUID", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    const client = new CloudCatalogClient({
      workspaceId: "ws-offline-1",
      baseUrl: "https://cloud.resin.local",
      authToken: "secret-token-123",
      // SAFETY: Test fixture provides mock fetchFn.
      fetchFn: fetchMock as typeof fetch,
    });

    const response = await client.registerProject(validRequest);
    expect(response).toEqual({
      outcome: "local_only",
      projectId: sampleProject.projectId,
    });
  });

  it("should map ECONNREFUSED socket errors to local_only", async () => {
    const networkError = new Error("connect ECONNREFUSED 127.0.0.1:443");
    const fetchMock = vi.fn().mockRejectedValue(networkError);

    const client = new CloudCatalogClient({
      workspaceId: "ws-offline-2",
      baseUrl: "https://cloud.resin.local",
      authToken: "secret-token-123",
      // SAFETY: Test fixture provides mock fetchFn.
      fetchFn: fetchMock as typeof fetch,
    });

    const response = await client.registerProject(validRequest);
    expect(response.outcome).toBe("local_only");
    expect(response.projectId).toBe(sampleProject.projectId);
  });

  it("should immediately return local_only when circuit breaker is open", async () => {
    const circuitBreaker = new CloudCircuitBreaker({
      failureThreshold: 1,
      initialResetTimeoutMs: 60_000,
    });
    // Force circuit breaker into OPEN state
    circuitBreaker.recordFailure(new Error("network failure"));

    const fetchMock = vi.fn();

    const client = new CloudCatalogClient({
      workspaceId: "ws-cb-1",
      baseUrl: "https://cloud.resin.local",
      authToken: "secret-token-123",
      circuitBreaker,
      // SAFETY: Test fixture provides mock fetchFn.
      fetchFn: fetchMock as typeof fetch,
    });

    const response = await client.registerProject(validRequest);
    expect(response.outcome).toBe("local_only");
    expect(response.projectId).toBe(sampleProject.projectId);
    // Ensure no network calls were made
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("should support later registration of offline UUID once online", async () => {
    let isOnline = false;
    const fetchMock = vi.fn().mockImplementation(async () => {
      if (!isOnline) {
        throw new TypeError("fetch failed");
      }
      return {
        ok: true,
        status: 201,
        json: async () => ({
          outcome: "registered",
          projectId: sampleProject.projectId,
        }),
      };
    });

    const client = new CloudCatalogClient({
      workspaceId: "ws-offline-later",
      baseUrl: "https://cloud.resin.local",
      authToken: "secret-token-123",
      // SAFETY: Test fixture provides mock fetchFn.
      fetchFn: fetchMock as typeof fetch,
    });

    // 1. Initial attempt while offline -> local_only
    const offlineResponse = await client.registerProject(validRequest);
    expect(offlineResponse.outcome).toBe("local_only");
    expect(offlineResponse.projectId).toBe(sampleProject.projectId);

    // 2. Connectivity restored -> successful registration
    isOnline = true;
    const onlineResponse = await client.registerProject(validRequest);
    expect(onlineResponse.outcome).toBe("registered");
    expect(onlineResponse.projectId).toBe(sampleProject.projectId);
  });

  it("should reject response projectId mismatch with ProtocolError", async () => {
    const mismatchedUuid = "00000000-0000-4000-8000-000000000000";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        outcome: "registered",
        projectId: mismatchedUuid,
      }),
    });

    const client = new CloudCatalogClient({
      workspaceId: "ws-mismatch",
      baseUrl: "https://cloud.resin.local",
      authToken: "secret-token-123",
      // SAFETY: Test fixture provides mock fetchFn.
      fetchFn: fetchMock as typeof fetch,
    });

    await expect(client.registerProject(validRequest)).rejects.toThrow(ProtocolError);
  });

  it("should reject malformed request schema before network call", async () => {
    const fetchMock = vi.fn();

    const client = new CloudCatalogClient({
      workspaceId: "ws-invalid",
      baseUrl: "https://cloud.resin.local",
      // SAFETY: Test fixture provides mock fetchFn.
      fetchFn: fetchMock as typeof fetch,
    });

    const invalidRequest = {
      projectMetadata: {
        ...sampleProject,
        projectId: "not-a-uuid",
      },
      visibility: "workspace",
    };

    // SAFETY: Intentionally pass invalid request structure to test runtime schema validation.
    await expect(
      client.registerProject(invalidRequest as ProjectRegistrationRequest),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("should reject malformed cloud response schema", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        outcome: "invalid_outcome_type",
        projectId: sampleProject.projectId,
      }),
    });

    const client = new CloudCatalogClient({
      workspaceId: "ws-malformed-res",
      baseUrl: "https://cloud.resin.local",
      authToken: "secret-token-123",
      // SAFETY: Test fixture provides mock fetchFn.
      fetchFn: fetchMock as typeof fetch,
    });

    await expect(client.registerProject(validRequest)).rejects.toThrow();
  });

  it("should support custom projectRegistrar option", async () => {
    const customRegistrar = vi.fn().mockResolvedValue({
      outcome: "registered",
      projectId: sampleProject.projectId,
    });

    const client = new CloudCatalogClient({
      workspaceId: "ws-custom",
      projectRegistrar: customRegistrar,
    });

    const response = await client.registerProject(validRequest);
    expect(response.outcome).toBe("registered");
    expect(customRegistrar).toHaveBeenCalledTimes(1);
  });

  it("should map no transport configured to local_only outcome", async () => {
    const client = new CloudCatalogClient({
      workspaceId: "ws-no-transport",
    });

    const response = await client.registerProject(validRequest);
    expect(response.outcome).toBe("local_only");
    expect(response.projectId).toBe(sampleProject.projectId);
  });
});
