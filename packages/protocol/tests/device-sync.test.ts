import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONTROL_PLANE_QUIET_POLL_INTERVAL_MS,
  DEVICE_SYNC_CAPABILITY,
  DEVICE_SYNC_CAPABILITY_HEADER,
  DEVICE_SYNC_PUBLICATION_MAX_AGE_MS,
  DEVICE_SYNC_ROUTE,
  DeviceSyncResponseSchema,
} from "../src/index.js";

interface FixtureCase {
  name: string;
  response: unknown;
}

/** Servers implementing the route copy this fixture into their own contract tests. */
const fixture: {
  capability: { route: string; header: string; value: string };
  valid: FixtureCase[];
  invalid: FixtureCase[];
} = JSON.parse(fs.readFileSync(new URL("./fixtures/device-sync-v1.json", import.meta.url), "utf8"));

describe("device sync contract", () => {
  it("names the route and capability the fixture records", () => {
    expect(fixture.capability).toEqual({
      route: DEVICE_SYNC_ROUTE,
      header: DEVICE_SYNC_CAPABILITY_HEADER,
      value: DEVICE_SYNC_CAPABILITY,
    });
  });

  it.each(fixture.valid.map((entry) => [entry.name, entry.response] as const))(
    "accepts %s",
    (_name, response) => {
      expect(DeviceSyncResponseSchema.safeParse(response).success).toBe(true);
    },
  );

  it.each(fixture.invalid.map((entry) => [entry.name, entry.response] as const))(
    "rejects %s",
    (_name, response) => {
      expect(DeviceSyncResponseSchema.safeParse(response).success).toBe(false);
    },
  );

  it("lets a published answer outlive one missed quiet sync but not two", () => {
    expect(DEVICE_SYNC_PUBLICATION_MAX_AGE_MS).toBeGreaterThan(
      2 * CONTROL_PLANE_QUIET_POLL_INTERVAL_MS,
    );
    expect(DEVICE_SYNC_PUBLICATION_MAX_AGE_MS).toBeLessThan(
      3 * CONTROL_PLANE_QUIET_POLL_INTERVAL_MS,
    );
  });
});
