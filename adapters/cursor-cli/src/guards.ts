/** Canonical object guard for this package's untrusted JSON (hook payloads, Cursor configs). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
