import type { CloudRequestIdentity } from "@resin/observer";
import { describe, expect, it } from "vitest";
import { controlCommand, parseControlFlags } from "../src/commands/control.js";

const identity: CloudRequestIdentity = {
  cloudUrl: "https://cloud.resin.test",
  accessToken: "secret-access-token",
  accountId: "account-1",
  workspaceId: "workspace-1",
  deviceId: "device-1",
  installationId: "installation-1",
  userId: "user-1",
};

function outputBuffer() {
  let value = "";
  return {
    stream: {
      write(chunk: string) {
        value += chunk;
      },
    },
    read() {
      return value;
    },
  };
}

describe("resin control", () => {
  it("parses noninteractive device targeting and compare-and-set flags", () => {
    expect(
      parseControlFlags([
        "set",
        "--device",
        "device-2",
        "--state",
        '{"configuration":{"logLevel":"warn"}}',
        "--expected-revision",
        "7",
        "--idempotency-key",
        "mutation-key-0001",
        "--json",
      ]),
    ).toMatchObject({
      action: "set",
      scope: "device",
      deviceId: "device-2",
      expectedRevision: 7,
      json: true,
    });
  });

  it("reads, changes one field, and emits stable JSON without credentials", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (init?.method === "GET") {
        return new Response(
          JSON.stringify({ desired: null, report: null, connectivity: "never_reported" }),
          { status: 200 },
        );
      }
      const mutation = JSON.parse(String(init?.body)) as {
        target: { scope: "device"; deviceId: string };
        desiredState: { configuration: { logLevel: string } };
        idempotencyKey: string;
      };
      return new Response(
        JSON.stringify({
          desired: {
            target: mutation.target,
            revision: 1,
            desiredState: mutation.desiredState,
            updatedAt: "2026-08-28T12:00:00.000Z",
            updatedBy: "user-1",
            source: "cli",
          },
          idempotentReplay: false,
        }),
        { status: 200 },
      );
    };
    const stdout = outputBuffer();
    const stderr = outputBuffer();
    const exitCode = await controlCommand(
      [
        "set",
        "--device",
        "device-1",
        "--field",
        "configuration.logLevel",
        "--value",
        '"warn"',
        "--idempotency-key",
        "mutation-key-0001",
        "--json",
      ],
      {
        customFetch: fetchImpl,
        credentialStore: { getRequestIdentity: async () => identity },
        output: stdout.stream,
        errorOutput: stderr.stream,
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.read())).toMatchObject({
      ok: true,
      action: "set",
      data: { desired: { revision: 1, desiredState: { configuration: { logLevel: "warn" } } } },
    });
    expect(stdout.read()).not.toContain(identity.accessToken);
    expect(stderr.read()).toBe("");
    expect(requests.map((request) => request.url)).toEqual([
      "https://cloud.resin.test/v1/control-plane/state?scope=device&deviceId=device-1",
      "https://cloud.resin.test/v1/control-plane/state",
    ]);
    expect(requests[1]?.init?.headers).toMatchObject({
      Authorization: `Bearer ${identity.accessToken}`,
    });
  });

  it("rejects destructive desired-state fields before contacting Cloud", async () => {
    let calls = 0;
    const stdout = outputBuffer();
    const exitCode = await controlCommand(
      [
        "set",
        "--state",
        '{"privacy":{"delete":true}}',
        "--idempotency-key",
        "destructive-key-0001",
        "--json",
      ],
      {
        customFetch: async () => {
          calls += 1;
          return new Response(null, { status: 500 });
        },
        credentialStore: { getRequestIdentity: async () => identity },
        output: stdout.stream,
      },
    );

    expect(exitCode).toBe(2);
    expect(calls).toBe(0);
    expect(JSON.parse(stdout.read())).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENTS" },
    });
  });
});
