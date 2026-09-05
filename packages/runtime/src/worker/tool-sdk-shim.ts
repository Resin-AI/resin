/**
 * Dependency-free ESM Tool SDK shim for tools executed in isolated worker sandboxes.
 * Runtime imports are deliberately absent; handler types share the public SDK context.
 * The string source (TOOL_SDK_SHIM_SOURCE) is written into worker scratch directories.
 */
import type { ToolContext } from "./sdk.js";

export type { ToolContext } from "./sdk.js";

export interface ToolLoggerShim {
  debug(message: string, context?: Record<string, unknown>): Promise<void>;
  info(message: string, context?: Record<string, unknown>): Promise<void>;
  warn(message: string, context?: Record<string, unknown>): Promise<void>;
  error(message: string, context?: Record<string, unknown>): Promise<void>;
}

export type ToolHandler<TInput = unknown, TOutput = unknown> = (
  context: ToolContext<TInput>,
) => Promise<TOutput> | TOutput;

export interface LegacyToolDefinition<TInput = unknown, TOutput = unknown> {
  handler: (input: TInput, context: ToolContext<TInput>) => Promise<TOutput> | TOutput;
  name?: string;
  description?: string;
  parameters?: unknown;
  outputSchema?: unknown;
}

function isToolHandlerFunction<TInput, TOutput>(
  value: ToolHandler<TInput, TOutput> | LegacyToolDefinition<TInput, TOutput>,
): value is ToolHandler<TInput, TOutput> {
  const tag = Object.prototype.toString.call(value);
  return tag === "[object Function]" || tag === "[object AsyncFunction]";
}

/**
 * Defines the canonical generated-tool ABI.
 * Function passthrough; legacy `{handler}` adapted to `(context) => handler(context.input, context)`.
 */
export function defineTool<TInput = unknown, TOutput = unknown>(
  handlerOrDefinition: ToolHandler<TInput, TOutput> | LegacyToolDefinition<TInput, TOutput>,
): ToolHandler<TInput, TOutput> {
  if (isToolHandlerFunction(handlerOrDefinition)) {
    return handlerOrDefinition;
  }
  if (
    !handlerOrDefinition ||
    Object.prototype.toString.call(handlerOrDefinition.handler) !== "[object Function]"
  ) {
    throw new TypeError("defineTool requires a callable handler");
  }
  return (context: ToolContext<TInput>) => handlerOrDefinition.handler(context.input, context);
}

/**
 * String constant of the dependency-free ESM shim written to <scratch>/resin-runtime.js
 * and mapped as `@resin/runtime` in the Deno worker import map.
 * Must NOT import anything.
 */
export const TOOL_SDK_SHIM_SOURCE = `// Resin Runtime Tool SDK Shim
// Dependency-free ESM exports for tools running in Deno worker sandbox.
// Does NOT import any external modules.

function isToolHandlerFunction(value) {
  const tag = Object.prototype.toString.call(value);
  return tag === "[object Function]" || tag === "[object AsyncFunction]";
}

export function defineTool(handlerOrDefinition) {
  if (isToolHandlerFunction(handlerOrDefinition)) {
    return handlerOrDefinition;
  }
  if (
    !handlerOrDefinition ||
    Object.prototype.toString.call(handlerOrDefinition.handler) !== "[object Function]"
  ) {
    throw new TypeError("defineTool requires a callable handler");
  }
  return (context) => handlerOrDefinition.handler(context.input, context);
}

export function createSecretReference(name, options = {}) {
  return {
    kind: "secret_reference",
    name,
    ref: "sec_ref_" + String(name).toLowerCase().replace(/[^a-z0-9_]/g, "_"),
    scope: options.scope || "workspace",
    mode: options.mode || "disclose",
    target: options.target,
    policy: options.policy,
  };
}

export function createOpaqueSecretRef(name, options = {}) {
  return {
    kind: "secret_reference",
    name,
    ref: "sec_ref_" + String(name).toLowerCase().replace(/[^a-z0-9_]/g, "_"),
    scope: options.scope || "workspace",
    mode: "opaque",
    target: options.target,
    policy: options.policy,
  };
}

export function isSecretReference(val) {
  return (
    val !== null &&
    typeof val === "object" &&
    val.kind === "secret_reference" &&
    typeof val.name === "string" &&
    typeof val.ref === "string"
  );
}

export function formatSecretTemplate(secretNameOrRef) {
  if (typeof secretNameOrRef === "string") {
    return "{{secret:" + secretNameOrRef + "}}";
  }
  return "{{secret:" + (secretNameOrRef?.name || "") + "}}";
}

export function bearerToken(nameOrRef) {
  const name = typeof nameOrRef === "string" ? nameOrRef : nameOrRef.name;
  return createOpaqueSecretRef(name, {
    target: { type: "header", name: "Authorization", template: "Bearer {{secret:" + name + "}}" },
  });
}

export function querySecret(nameOrRef) {
  return formatSecretTemplate(nameOrRef);
}

export function stdinSecret(nameOrRef) {
  const name = typeof nameOrRef === "string" ? nameOrRef : nameOrRef.name;
  return createOpaqueSecretRef(name, {
    target: { type: "stdin" },
  });
}

export function envSecret(nameOrRef) {
  const name = typeof nameOrRef === "string" ? nameOrRef : nameOrRef.name;
  return createOpaqueSecretRef(name, {
    target: { type: "env", name },
  });
}

export default {
  defineTool,
  createSecretReference,
  createOpaqueSecretRef,
  isSecretReference,
  formatSecretTemplate,
  bearerToken,
  querySecret,
  stdinSecret,
  envSecret,
};
`;
