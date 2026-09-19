import path from "node:path";
import process from "node:process";
import type { CapabilityEnvelope } from "@resin/contracts";
import { createLocalStateStore } from "@resin/db";
import { CloudCredentialStore, type CloudRequestIdentity } from "@resin/observer";
import { PROTOCOL_VERSION } from "@resin/protocol";
import { z } from "zod";
import { resolvePlatformPaths } from "../platform/paths.js";
import { createAuthorizationPlan } from "../installer/auth-plan.js";

/**
 * Owner-facing authorization for Resin's generated tools.
 *
 * A recording becomes a published tool only under an explicit capability envelope the workspace
 * owner grants: without one, every compiled candidate parks at `authorization_pending` and is never
 * qualified or published. This command is that grant. It builds the workspace's authorization plan
 * with the same builder the installer uses, binds it to the workspace this installation is paired
 * with, records it in the local capability store, and hands it to the cloud's candidate-generation
 * route — which re-validates the recording's existing candidate under the grant instead of
 * recompiling it, leaving the envelope, not this command, as the authority.
 */

const GENERATE_ROUTE = "/v1/evolution/candidates/generate";
const REQUIRED_SCOPE = "deployments:write";

const CloudErrorSchema = z.object({
  error: z.string().optional(),
  message: z.string().optional(),
});

export type AuthorizeCommandErrorCode =
  | "INVALID_ARGUMENTS"
  | "AUTHENTICATION_REQUIRED"
  | "MISSING_SCOPE"
  | "CLOUD_UNREACHABLE"
  | "CLOUD_REJECTED"
  | "AUTHORIZATION_PLAN_FAILED";

export interface AuthorizeCommandErrorPayload {
  ok: false;
  error: { code: AuthorizeCommandErrorCode; message: string };
}

export class AuthorizeCommandError extends Error {
  constructor(
    readonly code: AuthorizeCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AuthorizeCommandError";
  }
}

export interface AuthorizeCommandFlags {
  opportunityId?: string;
  workspacePath?: string;
  capabilitiesFile?: string;
  json: boolean;
  help: boolean;
}

export interface AuthorizeCommandOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  customFetch?: typeof fetch;
  output?: { write(chunk: string): unknown };
  errorOutput?: { write(chunk: string): unknown };
}

const AUTHORIZE_HELP = `
Resin authorize — grant this workspace's capability envelope to a recorded workflow.

Usage:
  resin authorize --opportunity <id> [--workspace <path>] [--capabilities <file>] [--json]

Options:
  --opportunity <id>     Recorded-workflow opportunity to authorize (required).
  --workspace <path>     Workspace the envelope is built for (default: current directory).
  --capabilities <file>  Use this capability envelope file instead of the default plan.
  --json                 Emit a machine-readable result.
  -h, --help             Display this help message.

The grant is recorded locally (capability_envelopes) and delivered to Resin Cloud with the
installation's own authenticated device credentials. Requires the "${REQUIRED_SCOPE}" scope.
`;

export function parseAuthorizeFlags(args: string[]): AuthorizeCommandFlags {
  const flags: AuthorizeCommandFlags = { json: false, help: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index] ?? "";
    if (argument === "--help" || argument === "-h") {
      flags.help = true;
      continue;
    }
    if (argument === "--json") {
      flags.json = true;
      continue;
    }
    const readValue = (name: string): string => {
      const inline = `${name}=`;
      if (argument.startsWith(inline)) return argument.slice(inline.length);
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new AuthorizeCommandError("INVALID_ARGUMENTS", `${name} requires a value`);
      }
      index++;
      return next;
    };
    if (argument === "--opportunity" || argument.startsWith("--opportunity=")) {
      flags.opportunityId = readValue("--opportunity");
      continue;
    }
    if (argument === "--workspace" || argument.startsWith("--workspace=")) {
      flags.workspacePath = readValue("--workspace");
      continue;
    }
    if (argument === "--capabilities" || argument.startsWith("--capabilities=")) {
      flags.capabilitiesFile = readValue("--capabilities");
      continue;
    }
    throw new AuthorizeCommandError("INVALID_ARGUMENTS", `Unknown option: ${argument}`);
  }
  return flags;
}

function requestHeaders(identity: CloudRequestIdentity): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${identity.accessToken}`,
    "x-account-id": identity.accountId,
    "x-workspace-id": identity.workspaceId,
    "x-device-id": identity.deviceId,
    "x-installation-id": identity.installationId,
    "x-protocol-version": PROTOCOL_VERSION,
  };
}

function writeJson(sink: { write(chunk: string): unknown }, payload: unknown): void {
  sink.write(`${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * Records the granted envelope where the daemon keeps its own capability envelopes, so the owner's
 * authorization survives a restart and is inspectable without the cloud.
 */
async function recordGrantLocally(dataDir: string, envelope: CapabilityEnvelope): Promise<void> {
  const store = createLocalStateStore({ path: path.join(dataDir, "state.db") });
  try {
    await store.initialize();
    await store.capabilities.saveEnvelope(envelope);
  } finally {
    store.close();
  }
}

export async function authorizeCommand(
  args: string[],
  options: AuthorizeCommandOptions = {},
): Promise<number> {
  const output = options.output ?? process.stdout;
  const errorOutput = options.errorOutput ?? process.stderr;
  let flags: AuthorizeCommandFlags;
  try {
    flags = parseAuthorizeFlags(args);
  } catch (error) {
    const safe = error instanceof Error ? error.message : String(error);
    writeJson(errorOutput, {
      ok: false,
      error: { code: "INVALID_ARGUMENTS", message: safe },
    } satisfies AuthorizeCommandErrorPayload);
    return 2;
  }
  if (flags.help) {
    output.write(AUTHORIZE_HELP);
    return 0;
  }
  if (!flags.opportunityId) {
    writeJson(errorOutput, {
      ok: false,
      error: { code: "INVALID_ARGUMENTS", message: "--opportunity <id> is required" },
    } satisfies AuthorizeCommandErrorPayload);
    return 2;
  }

  const env = options.env ?? process.env;
  const store = new CloudCredentialStore({ home: options.home, fetchImpl: options.customFetch });
  const fetchImpl = options.customFetch ?? fetch;

  try {
    const loaded = await store.load();
    if (!loaded.credentials) {
      throw new AuthorizeCommandError(
        "AUTHENTICATION_REQUIRED",
        "This installation is not paired with Resin Cloud; run resin login",
      );
    }
    const scopes = loaded.credentials.claims.scopes ?? [];
    if (!scopes.includes(REQUIRED_SCOPE)) {
      throw new AuthorizeCommandError(
        "MISSING_SCOPE",
        `Authorizing a generated tool requires the "${REQUIRED_SCOPE}" scope; this installation was paired without it`,
      );
    }
    const identity = await store.getRequestIdentity();
    if (!identity) {
      throw new AuthorizeCommandError(
        "AUTHENTICATION_REQUIRED",
        "This installation's stored credentials are no longer valid; run resin login",
      );
    }

    const workspacePath = path.resolve(flags.workspacePath ?? process.cwd());
    const plan = await createAuthorizationPlan({
      workspacePath,
      ...(flags.capabilitiesFile ? { capabilitiesFile: path.resolve(flags.capabilitiesFile) } : {}),
    });
    // The cloud binds an envelope to the workspace that is asking, so the plan's capabilities are
    // granted to the paired workspace. Every capability stays exactly as the plan produced it.
    const envelope = { ...plan.capabilities, workspaceId: identity.workspaceId };

    const paths = resolvePlatformPaths({ home: options.home, env });
    await recordGrantLocally(paths.dataDir, envelope);

    let response: Response;
    try {
      response = await fetchImpl(
        `${identity.cloudUrl.replace(/\/$/, "")}${GENERATE_ROUTE}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...requestHeaders(identity) },
          body: JSON.stringify({
            opportunityId: flags.opportunityId,
            options: { envelope },
          }),
        },
      );
    } catch {
      throw new AuthorizeCommandError("CLOUD_UNREACHABLE", "Resin Cloud is unreachable");
    }

    const text = await response.text();
    let body: unknown = null;
    try {
      body = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok) {
      const parsed = CloudErrorSchema.safeParse(body);
      const detail = parsed.success
        ? (parsed.data.message ?? parsed.data.error ?? `HTTP ${response.status}`)
        : `HTTP ${response.status}`;
      throw new AuthorizeCommandError("CLOUD_REJECTED", detail);
    }

    if (flags.json) {
      writeJson(output, {
        ok: true,
        opportunityId: flags.opportunityId,
        workspacePath,
        workspaceId: identity.workspaceId,
        envelopeId: envelope.envelopeId,
        cloud: body,
      });
    } else {
      output.write(
        `Authorized ${flags.opportunityId} for ${workspacePath}\n` +
          `  envelope: ${envelope.envelopeId} (workspace ${identity.workspaceId}, ${REQUIRED_SCOPE})\n` +
          `  cloud:    ${JSON.stringify(body)}\n`,
      );
    }
    return 0;
  } catch (error) {
    const payload: AuthorizeCommandErrorPayload =
      error instanceof AuthorizeCommandError
        ? { ok: false, error: { code: error.code, message: error.message } }
        : { ok: false, error: { code: "AUTHORIZATION_PLAN_FAILED", message: String(error) } };
    writeJson(errorOutput, payload);
    return 1;
  }
}
