import { randomUUID } from "node:crypto";
import process from "node:process";
import { CloudCredentialStore, type CloudRequestIdentity } from "@resin/observer";
import {
  CONTROL_PLANE_FIELD_INVENTORY,
  type ControlPlaneDesiredState,
  ControlPlaneDesiredStateSchema,
  ControlPlaneEffectiveStateResponseSchema,
  ControlPlaneInventoryResponseSchema,
  type ControlPlaneMutationRequest,
  ControlPlaneMutationResponseSchema,
  ControlPlaneStateResponseSchema,
  type ControlPlaneTarget,
  ControlPlaneTargetSchema,
  PROTOCOL_VERSION,
} from "@resin/protocol";
import { z } from "zod";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return (
    value !== null &&
    value !== undefined &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

const CloudErrorSchema = z.object({
  error: z.string().optional(),
  message: z.string().optional(),
  code: z.string().optional(),
});

export type ControlCommandAction = "get" | "set" | "inventory" | "help";

export interface ControlCommandFlags {
  action: ControlCommandAction;
  scope: "workspace" | "device";
  deviceId?: string;
  effective: boolean;
  field?: string;
  value?: string;
  state?: string;
  expectedRevision?: number;
  idempotencyKey?: string;
  json: boolean;
  help: boolean;
}

export interface ControlCommandOptions {
  home?: string;
  customFetch?: typeof fetch;
  credentialStore?: Pick<CloudCredentialStore, "getRequestIdentity">;
  output?: { write(chunk: string): boolean | undefined };
  errorOutput?: { write(chunk: string): boolean | undefined };
}

export type ControlCommandErrorCode =
  | "INVALID_ARGUMENTS"
  | "AUTHENTICATION_REQUIRED"
  | "CLOUD_UNREACHABLE"
  | "CLOUD_REQUEST_FAILED"
  | "INVALID_CLOUD_RESPONSE"
  | "CONFLICT";
export interface ControlCommandErrorPayload {
  ok: false;
  error: {
    code: ControlCommandErrorCode;
    message: string;
    status?: number;
  };
}

export type ControlCommandJsonPayload =
  | ControlCommandErrorPayload
  | { ok: true; action: "inventory"; data: JsonValue }
  | { ok: true; action: "get"; data: JsonValue }
  | { ok: true; action: "set"; data: JsonValue }
  | JsonValue;

export class ControlCommandError extends Error {
  constructor(
    readonly code: ControlCommandErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ControlCommandError";
  }
}

function requireFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new ControlCommandError("INVALID_ARGUMENTS", `${flag} requires a value`);
  }
  return value;
}

export function parseControlFlags(args: string[]): ControlCommandFlags {
  const actionValue = args[0] ?? "get";
  if (
    actionValue !== "get" &&
    actionValue !== "set" &&
    actionValue !== "inventory" &&
    actionValue !== "help"
  ) {
    throw new ControlCommandError("INVALID_ARGUMENTS", `Unknown control action: ${actionValue}`);
  }
  const flags: ControlCommandFlags = {
    action: actionValue,
    scope: "workspace",
    effective: false,
    json: false,
    help: actionValue === "help",
  };
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--scope": {
        const scope = requireFlagValue(args, index, arg);
        if (scope !== "workspace" && scope !== "device") {
          throw new ControlCommandError("INVALID_ARGUMENTS", "--scope must be workspace or device");
        }
        flags.scope = scope;
        index += 1;
        break;
      }
      case "--device":
        flags.deviceId = requireFlagValue(args, index, arg);
        flags.scope = "device";
        index += 1;
        break;
      case "--effective":
        flags.effective = true;
        break;
      case "--field":
        flags.field = requireFlagValue(args, index, arg);
        index += 1;
        break;
      case "--value":
        flags.value = requireFlagValue(args, index, arg);
        index += 1;
        break;
      case "--state":
        flags.state = requireFlagValue(args, index, arg);
        index += 1;
        break;
      case "--expected-revision": {
        const value = requireFlagValue(args, index, arg);
        const revision = Number(value);
        if (!Number.isSafeInteger(revision) || revision < 0) {
          throw new ControlCommandError(
            "INVALID_ARGUMENTS",
            "--expected-revision must be a nonnegative integer",
          );
        }
        flags.expectedRevision = revision;
        index += 1;
        break;
      }
      case "--idempotency-key":
        flags.idempotencyKey = requireFlagValue(args, index, arg);
        index += 1;
        break;
      case "--json":
        flags.json = true;
        break;
      case "--help":
      case "-h":
        flags.help = true;
        break;
      default:
        throw new ControlCommandError("INVALID_ARGUMENTS", `Unknown option: ${arg}`);
    }
  }
  if (flags.effective && flags.scope !== "device") {
    throw new ControlCommandError("INVALID_ARGUMENTS", "--effective requires --device");
  }
  if (flags.action === "set") {
    if (Boolean(flags.state) === Boolean(flags.field)) {
      throw new ControlCommandError(
        "INVALID_ARGUMENTS",
        "set requires exactly one of --state or --field",
      );
    }
    if (flags.field && flags.value === undefined) {
      throw new ControlCommandError("INVALID_ARGUMENTS", "--field requires --value");
    }
  }
  return flags;
}

export function printControlHelp(
  output: { write(chunk: string): boolean | undefined } = process.stdout,
): void {
  output.write(`Resin Cloud control plane\n\n`);
  output.write(`Usage:\n`);
  output.write(
    `  resin control get [--scope workspace|device] [--device ID] [--effective] [--json]\n`,
  );
  output.write(`  resin control set [--device ID] (--state JSON | --field PATH --value JSON)\n`);
  output.write(`                    [--expected-revision N] [--idempotency-key KEY] [--json]\n`);
  output.write(`  resin control inventory [--json]\n\n`);
  output.write(`All mutations are noninteractive, authenticated, revisioned, and idempotent.\n`);
  output.write(`Destructive privacy operations remain under resin privacy delete with step-up.\n`);
}

function parseJsonArgument(value: string, flag: string): JsonValue {
  try {
    return JSON.parse(value);
  } catch {
    throw new ControlCommandError("INVALID_ARGUMENTS", `${flag} must contain valid JSON`);
  }
}

function targetFor(flags: ControlCommandFlags, identity: CloudRequestIdentity): ControlPlaneTarget {
  const target =
    flags.scope === "workspace"
      ? { scope: "workspace" as const }
      : { scope: "device" as const, deviceId: flags.deviceId ?? identity.deviceId };
  const parsed = ControlPlaneTargetSchema.safeParse(target);
  if (!parsed.success) {
    throw new ControlCommandError(
      "INVALID_ARGUMENTS",
      parsed.error.issues[0]?.message ?? "Invalid control target",
    );
  }
  return parsed.data;
}

function setDesiredField(
  current: ControlPlaneDesiredState,
  fieldPath: string,
  value: JsonValue,
): ControlPlaneDesiredState {
  const parts = fieldPath.split(".");
  const knownRoot = CONTROL_PLANE_FIELD_INVENTORY.some((entry) => {
    return entry.path === fieldPath || entry.path.startsWith(`${fieldPath}.`);
  });
  if (
    !knownRoot &&
    !CONTROL_PLANE_FIELD_INVENTORY.some((entry) => fieldPath.startsWith(`${entry.path}.`))
  ) {
    throw new ControlCommandError("INVALID_ARGUMENTS", `Unsupported control field: ${fieldPath}`);
  }
  // SAFETY: Cloning JSON-compatible desired state structure for field mutation.
  const next = structuredClone(current) as JsonObject;
  let cursor: JsonObject = next;
  for (const part of parts.slice(0, -1)) {
    const existing = cursor[part];
    if (!isJsonObject(existing)) {
      cursor[part] = {};
      // SAFETY: Navigating internal mutable object hierarchy after initialization.
      cursor = cursor[part] as JsonObject;
    } else {
      cursor = existing;
    }
  }
  cursor[parts[parts.length - 1]!] = value;
  const parsed = ControlPlaneDesiredStateSchema.safeParse(next);
  if (!parsed.success) {
    throw new ControlCommandError(
      "INVALID_ARGUMENTS",
      parsed.error.issues[0]?.message ?? "Invalid control field value",
    );
  }
  return parsed.data;
}

function requestHeaders(identity: CloudRequestIdentity) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${identity.accessToken}`,
    "x-account-id": identity.accountId,
    "x-workspace-id": identity.workspaceId,
    "x-device-id": identity.deviceId,
    "x-installation-id": identity.installationId,
    "x-protocol-version": PROTOCOL_VERSION,
  } satisfies Record<string, string>;
}

async function readResponseBody(response: Response): Promise<JsonValue | null> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ControlCommandError("INVALID_CLOUD_RESPONSE", "Cloud returned invalid JSON");
  }
}

function cloudFailure(response: Response, body: JsonValue | null): ControlCommandError {
  const parsed = CloudErrorSchema.safeParse(body);
  const record = parsed.success ? parsed.data : null;
  const serverCode = record?.error ?? null;
  const message =
    record?.message !== undefined
      ? record.message.slice(0, 256)
      : `Cloud request failed with HTTP ${response.status}`;
  if (response.status === 409) return new ControlCommandError("CONFLICT", message, 409);
  if (response.status === 401 || response.status === 403) {
    return new ControlCommandError("AUTHENTICATION_REQUIRED", message, response.status);
  }
  return new ControlCommandError(
    "CLOUD_REQUEST_FAILED",
    serverCode ? `${serverCode}: ${message}` : message,
    response.status,
  );
}

async function cloudRequest(
  identityProvider: (forceRefresh?: boolean) => Promise<CloudRequestIdentity | null>,
  fetchImpl: typeof fetch,
  route: string,
  init: RequestInit,
  forceRefresh = false,
): Promise<JsonValue | null> {
  const identity = await identityProvider(forceRefresh);
  if (!identity) {
    throw new ControlCommandError(
      "AUTHENTICATION_REQUIRED",
      "Cloud authentication is required; run resin login",
    );
  }
  let response: Response;
  try {
    const headers = {
      ...requestHeaders(identity),
    };
    if (init.headers) {
      // SAFETY: Forwarding headers provided via RequestInit as header key-value map.
      Object.assign(headers, init.headers as Record<string, string>);
    }
    response = await fetchImpl(`${identity.cloudUrl.replace(/\/$/, "")}${route}`, {
      ...init,
      headers,
    });
  } catch {
    throw new ControlCommandError("CLOUD_UNREACHABLE", "Cloud control plane is unreachable");
  }
  if (!forceRefresh && (response.status === 401 || response.status === 403)) {
    await response.body?.cancel().catch(() => undefined);
    return cloudRequest(identityProvider, fetchImpl, route, init, true);
  }
  const body = await readResponseBody(response);
  if (!response.ok) throw cloudFailure(response, body);
  return body;
}

function safeError(cause: unknown): ControlCommandError {
  if (cause instanceof ControlCommandError) return cause;
  return new ControlCommandError("CLOUD_REQUEST_FAILED", "Control-plane operation failed");
}

function writeJson(
  output: { write(chunk: string): boolean | undefined },
  value: ControlCommandJsonPayload,
): void {
  output.write(`${JSON.stringify(value)}\n`);
}

export async function controlCommand(
  args: string[],
  options: ControlCommandOptions = {},
): Promise<number> {
  const output = options.output ?? process.stdout;
  const errorOutput = options.errorOutput ?? process.stderr;
  let flags: ControlCommandFlags;
  try {
    flags = parseControlFlags(args);
  } catch (error) {
    const safe = safeError(error);
    writeJson(errorOutput, { ok: false, error: { code: safe.code, message: safe.message } });
    return 2;
  }
  if (flags.help) {
    printControlHelp(output);
    return 0;
  }

  const credentialStore =
    options.credentialStore ??
    new CloudCredentialStore({ home: options.home, fetchImpl: options.customFetch });
  const identityProvider = async (forceRefresh = false): Promise<CloudRequestIdentity | null> =>
    credentialStore.getRequestIdentity(forceRefresh ? { forceRefresh: true } : undefined);
  const fetchImpl = options.customFetch ?? fetch;

  try {
    const identity = await identityProvider();
    if (!identity) {
      throw new ControlCommandError(
        "AUTHENTICATION_REQUIRED",
        "Cloud authentication is required; run resin login",
      );
    }
    const target = targetFor(flags, identity);
    if (flags.action === "inventory") {
      const body = await cloudRequest(identityProvider, fetchImpl, "/v1/control-plane/inventory", {
        method: "GET",
      });
      const inventory = ControlPlaneInventoryResponseSchema.safeParse(body);
      if (!inventory.success) {
        throw new ControlCommandError("INVALID_CLOUD_RESPONSE", "Cloud inventory was malformed");
      }
      writeJson(output, { ok: true, action: "inventory", data: inventory.data });
      return 0;
    }
    if (flags.action === "get") {
      const route = flags.effective
        ? `/v1/control-plane/effective?deviceId=${encodeURIComponent(target.scope === "device" ? target.deviceId : identity.deviceId)}`
        : `/v1/control-plane/state?scope=${target.scope}${target.scope === "device" ? `&deviceId=${encodeURIComponent(target.deviceId)}` : ""}`;
      const body = await cloudRequest(identityProvider, fetchImpl, route, { method: "GET" });
      const parsed = flags.effective
        ? ControlPlaneEffectiveStateResponseSchema.safeParse(body)
        : ControlPlaneStateResponseSchema.safeParse(body);
      if (!parsed.success) {
        throw new ControlCommandError("INVALID_CLOUD_RESPONSE", "Cloud state was malformed");
      }
      writeJson(output, { ok: true, action: "get", data: parsed.data });
      return 0;
    }

    let desiredState: ControlPlaneDesiredState;
    let expectedRevision = flags.expectedRevision;
    if (flags.state) {
      const parsed = ControlPlaneDesiredStateSchema.safeParse(
        parseJsonArgument(flags.state, "--state"),
      );
      if (!parsed.success) {
        throw new ControlCommandError(
          "INVALID_ARGUMENTS",
          parsed.error.issues[0]?.message ?? "Invalid desired state",
        );
      }
      desiredState = parsed.data;
    } else {
      const route = `/v1/control-plane/state?scope=${target.scope}${target.scope === "device" ? `&deviceId=${encodeURIComponent(target.deviceId)}` : ""}`;
      const body = await cloudRequest(identityProvider, fetchImpl, route, { method: "GET" });
      const current = ControlPlaneStateResponseSchema.safeParse(body);
      if (!current.success) {
        throw new ControlCommandError("INVALID_CLOUD_RESPONSE", "Cloud state was malformed");
      }
      expectedRevision ??= current.data.desired?.revision ?? 0;
      desiredState = setDesiredField(
        current.data.desired?.desiredState ?? {},
        flags.field!,
        parseJsonArgument(flags.value!, "--value"),
      );
    }
    const mutation: ControlPlaneMutationRequest = {
      target,
      desiredState,
      idempotencyKey: flags.idempotencyKey ?? randomUUID(),
      source: "cli",
    };
    if (expectedRevision !== undefined) {
      mutation.expectedRevision = expectedRevision;
    }
    const body = await cloudRequest(identityProvider, fetchImpl, "/v1/control-plane/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mutation),
    });
    const result = ControlPlaneMutationResponseSchema.safeParse(body);
    if (!result.success) {
      throw new ControlCommandError(
        "INVALID_CLOUD_RESPONSE",
        "Cloud mutation response was malformed",
      );
    }
    writeJson(output, { ok: true, action: "set", data: result.data });
    return 0;
  } catch (error) {
    const safe = safeError(error);
    const payload: ControlCommandErrorPayload = {
      ok: false,
      error: { code: safe.code, message: safe.message, status: safe.status },
    };
    if (flags.json) writeJson(output, payload);
    else writeJson(errorOutput, payload);
    return safe.code === "INVALID_ARGUMENTS" ? 2 : 1;
  }
}
