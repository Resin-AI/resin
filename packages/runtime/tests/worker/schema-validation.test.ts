import { describe, expect, it } from "vitest";
import { validateAgainstSchema } from "../../src/worker/bootstrap.js";

describe("validateAgainstSchema", () => {
  it("validates primitive types correctly", () => {
    expect(validateAgainstSchema({ type: "string" }, "hello").valid).toBe(true);
    expect(validateAgainstSchema({ type: "string" }, 123).valid).toBe(false);

    expect(validateAgainstSchema({ type: "number" }, 42.5).valid).toBe(true);
    expect(validateAgainstSchema({ type: "number" }, "42").valid).toBe(false);

    expect(validateAgainstSchema({ type: "integer" }, 10).valid).toBe(true);
    expect(validateAgainstSchema({ type: "integer" }, 10.5).valid).toBe(false);

    expect(validateAgainstSchema({ type: "boolean" }, true).valid).toBe(true);
    expect(validateAgainstSchema({ type: "boolean" }, "true").valid).toBe(false);

    expect(validateAgainstSchema({ type: "null" }, null).valid).toBe(true);
    expect(validateAgainstSchema({ type: "null" }, "null").valid).toBe(false);
  });

  it("validates object properties and required fields", () => {
    const schema = {
      type: "object",
      properties: {
        id: { type: "string" },
        count: { type: "integer" },
        active: { type: "boolean" },
      },
      required: ["id", "count"],
      additionalProperties: false,
    };

    const validObj = { id: "item-1", count: 5, active: true };
    expect(validateAgainstSchema(schema, validObj).valid).toBe(true);

    const missingReq = { id: "item-1" };
    const missingRes = validateAgainstSchema(schema, missingReq);
    expect(missingRes.valid).toBe(false);
    expect(missingRes.errors.some((e) => e.includes("required field is missing"))).toBe(true);

    const extraProp = { id: "item-1", count: 5, extra: "unauthorized" };
    const extraRes = validateAgainstSchema(schema, extraProp);
    expect(extraRes.valid).toBe(false);
    expect(extraRes.errors.some((e) => e.includes("additional property is not allowed"))).toBe(
      true,
    );
  });

  it("validates embedded .schema objects (MCP output schema)", () => {
    const mcpSchema = {
      type: "object",
      schema: {
        type: "object",
        properties: {
          result: { type: "number" },
          status: { type: "string" },
        },
        required: ["result"],
      },
    };

    expect(validateAgainstSchema(mcpSchema, { result: 100, status: "ok" }).valid).toBe(true);
    expect(validateAgainstSchema(mcpSchema, { status: "ok" }).valid).toBe(false);
  });

  it("validates nested objects and arrays", () => {
    const schema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              score: { type: "number" },
            },
            required: ["name"],
          },
        },
      },
      required: ["items"],
    };

    const valid = {
      items: [
        { name: "alpha", score: 95 },
        { name: "beta", score: 88 },
      ],
    };
    expect(validateAgainstSchema(schema, valid).valid).toBe(true);

    const invalid = {
      items: [{ name: "alpha", score: "not-a-number" }],
    };
    expect(validateAgainstSchema(schema, invalid).valid).toBe(false);
  });
});
