import { describe, expect, it } from "vitest";
import { AccountProfileResponseSchema } from "../src/index.js";

const profile = {
  schemaVersion: "1.0.0",
  accountId: "account-1",
  userId: "user-1",
  email: "member@example.com",
  membershipType: "pro",
};

describe("account profile response", () => {
  it.each(["free", "pro", "max", "founder"])("accepts the %s membership type", (membershipType) => {
    expect(AccountProfileResponseSchema.parse({ ...profile, membershipType })).toEqual({
      ...profile,
      membershipType,
    });
  });

  it.each([
    { email: "user-1" },
    { email: "member@example.com\nFORGED" },
    { membershipType: "owner" },
    { membershipType: "unknown" },
    { accountId: "" },
    { userId: "" },
    { schemaVersion: "2.0.0" },
  ])("rejects invalid display metadata %j", (overrides) => {
    expect(AccountProfileResponseSchema.safeParse({ ...profile, ...overrides }).success).toBe(
      false,
    );
  });

  it("does not retain unknown response fields", () => {
    expect(AccountProfileResponseSchema.parse({ ...profile, privateData: "omit-me" })).toEqual(
      profile,
    );
  });
});
