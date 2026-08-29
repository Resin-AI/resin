import type {
  CanonicalJsonRecord,
  CanonicalJsonValue,
  ToolOutputSchema,
  ToolParameterSchema,
} from "@resin/contracts";

/**
 * Result of JSON Schema validation.
 */
export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates a JavaScript value against a JSON Schema-compatible definition
 * (such as ToolParameterSchema or ToolOutputSchema).
 */
export function validateAgainstSchema(
  schema: ToolParameterSchema | ToolOutputSchema | CanonicalJsonValue | null | undefined,
  value: CanonicalJsonValue,
  path = "",
): SchemaValidationResult {
  if (!schema || !(schema instanceof Object) || Array.isArray(schema)) {
    return { valid: true, errors: [] };
  }

  // SAFETY: Tag check confirms schema is a JSON object record.
  const s = schema as CanonicalJsonRecord;
  const errors: string[] = [];

  // Check if schema has an embedded .schema object (MCP/ToolOutputSchema convention)
  if (s.schema && s.schema instanceof Object && !Array.isArray(s.schema)) {
    // SAFETY: Tag check confirms s.schema is a JSON object record.
    return validateAgainstSchema(s.schema as CanonicalJsonRecord, value, path);
  }

  // SAFETY: String check confirms s.type is a string primitive.
  const expectedType = String(s.type) === s.type ? (s.type as string) : undefined;

  if (expectedType) {
    const isObjectRecord =
      value !== null &&
      !Array.isArray(value) &&
      Object.prototype.toString.call(value) === "[object Object]";

    const valTag = Object.prototype.toString.call(value);
    const valType =
      value === null
        ? "null"
        : value === undefined
          ? "undefined"
          : Array.isArray(value)
            ? "array"
            : Number.isFinite(value)
              ? "number"
              : String(value) === value
                ? "string"
                : value === true || value === false
                  ? "boolean"
                  : isObjectRecord
                    ? "object"
                    : valTag === "[object Function]" || valTag === "[object AsyncFunction]"
                      ? "function"
                      : valTag === "[object BigInt]"
                        ? "bigint"
                        : valTag === "[object Symbol]"
                          ? "symbol"
                          : "unknown";

    // SAFETY: Number.isFinite check confirms value is a finite number for integer test.
    const isInteger = Number.isFinite(value) && Number.isInteger(value as number);

    if (expectedType === "null" && value !== null) {
      errors.push(`${path || "root"}: expected null, got ${valType}`);
    } else if (expectedType === "string" && String(value) !== value) {
      errors.push(`${path || "root"}: expected string, got ${valType}`);
    } else if (expectedType === "number" && !Number.isFinite(value)) {
      errors.push(`${path || "root"}: expected number, got ${valType}`);
    } else if (expectedType === "integer" && !isInteger) {
      errors.push(`${path || "root"}: expected integer, got ${valType}`);
    } else if (expectedType === "boolean" && value !== true && value !== false) {
      errors.push(`${path || "root"}: expected boolean, got ${valType}`);
    } else if (expectedType === "array" && !Array.isArray(value)) {
      errors.push(`${path || "root"}: expected array, got ${valType}`);
    } else if (expectedType === "object" && !isObjectRecord) {
      errors.push(
        `${path || "root"}: expected object, got ${Array.isArray(value) ? "array" : valType}`,
      );
    }
  }

  // If value is an object, validate properties & required fields
  const isValueRecord =
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]";
  if (isValueRecord) {
    // SAFETY: Tag check confirms value is a record.
    const obj = value as CanonicalJsonRecord;
    // SAFETY: s.properties is verified or defaulted to empty record.
    const properties = (
      s.properties && s.properties instanceof Object && !Array.isArray(s.properties)
        ? s.properties
        : {}
    ) as CanonicalJsonRecord;
    // SAFETY: s.required is checked for Array.isArray before cast.
    const required = Array.isArray(s.required) ? (s.required as string[]) : [];
    const additionalProperties = s.additionalProperties !== false;

    // Check required fields
    for (const req of required) {
      if (!(req in obj) || obj[req] === undefined) {
        errors.push(`${path ? `${path}.${req}` : req}: required field is missing`);
      }
    }

    // Validate declared properties
    for (const [propName, propSchema] of Object.entries(properties)) {
      if (propName in obj && obj[propName] !== undefined) {
        const propPath = path ? `${path}.${propName}` : propName;
        // SAFETY: propSchema is passed for validation against property value.
        const res = validateAgainstSchema(
          propSchema as CanonicalJsonRecord,
          obj[propName],
          propPath,
        );
        errors.push(...res.errors);
      }
    }

    // Check additionalProperties if forbidden
    if (!additionalProperties) {
      for (const key of Object.keys(obj)) {
        if (!(key in properties)) {
          errors.push(`${path ? `${path}.${key}` : key}: additional property is not allowed`);
        }
      }
    }
  }

  // If value is an array, validate items if defined
  if (Array.isArray(value) && s.items && s.items instanceof Object && !Array.isArray(s.items)) {
    for (let i = 0; i < value.length; i++) {
      const itemPath = `${path || "root"}[${i}]`;
      // SAFETY: s.items is verified object sub-schema.
      const res = validateAgainstSchema(s.items as CanonicalJsonRecord, value[i], itemPath);
      errors.push(...res.errors);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
export const DENO_WORKER_BOOTSTRAP_SOURCE = `// Resin Deno Worker Bootstrap Script
// Runs inside permissionless Deno sandbox with --no-prompt --deny-all

const pendingBrokerRequests = new Map();
let currentManifest = null;
let currentEntrypoint = null;
let currentAbortController = null;
let textBuffer = "";

function writeMessage(msg) {
  const line = JSON.stringify(msg) + "\\n";
  const encoder = new TextEncoder();
  Deno.stdout.writeSync(encoder.encode(line));
}

function handleBrokerResponse(msg) {
  const { requestId, success, payload, error } = msg;
  const pending = pendingBrokerRequests.get(requestId);
  if (pending) {
    pendingBrokerRequests.delete(requestId);
    if (success) {
      pending.resolve(payload);
    } else {
      pending.reject(new Error(error?.message || "Broker request failed"));
    }
  }
}

function requestBroker(service, action, payload = {}) {
  return new Promise((resolve, reject) => {
    const requestId = "req_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9);
    pendingBrokerRequests.set(requestId, { resolve, reject });
    writeMessage({
      id: "msg_" + Date.now(),
      type: "broker_request",
      timestamp: Date.now(),
      version: "1.0.0",
      requestId,
      service,
      action,
      payload,
    });
  });
}

function createToolContext(invocationId, input, options = {}) {
  const brokerClient = {
    fs: {
      readFile: async (path, encoding = "utf-8") => {
        const res = await requestBroker("fs", "readFile", { path, encoding });
        return res.content;
      },
      writeFile: async (path, content) => {
        const serialized = typeof content === "string" ? content : btoa(String.fromCharCode(...content));
        await requestBroker("fs", "writeFile", { path, content: serialized, encoding: typeof content === "string" ? "utf-8" : "base64" });
      },
      exists: async (path) => {
        const res = await requestBroker("fs", "exists", { path });
        return res.exists;
      },
      listDir: async (path = ".") => {
        const res = await requestBroker("fs", "listDir", { path });
        return res.entries;
      },
      stat: async (path) => {
        return await requestBroker("fs", "stat", { path });
      },
      removeFile: async (path) => {
        await requestBroker("fs", "removeFile", { path });
      },
    },
    net: {
      fetch: async (url, init) => {
        const res = await requestBroker("net", "fetch", { url, ...init });
        return {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
          ok: res.status >= 200 && res.status < 300,
          url: res.finalUrl || url,
          redirected: Boolean(res.redirected),
          text: async () => res.body,
          json: async () => JSON.parse(res.body),
        };
      },
    },
    cmd: {
      exec: async (command, args = [], opts = {}) => {
        return await requestBroker("cmd", "exec", { command, args, ...opts });
      },
    },
    secret: {
      createReference: (name, refOptions = {}) => ({
        kind: "secret_reference",
        name,
        ref: "sec_ref_" + name.toLowerCase().replace(/[^a-z0-9_]/g, "_") + "_" + Math.random().toString(36).slice(2, 10),
        workspaceId: refOptions.workspaceId || options.metadata?.workspaceId || "default",
        toolId: refOptions.toolId,
        permittedModes: refOptions.modes || ["header_template", "bearer_token", "query_template", "command_stdin", "command_env"],
        expiresAt: refOptions.expiresAt,
        metadata: refOptions.metadata || {},
      }),
      bearerToken: (nameOrRef) => typeof nameOrRef === "string"
        ? brokerClient.secret.createReference(nameOrRef, { modes: ["bearer_token", "header_template"] })
        : nameOrRef,
      template: (nameOrRef) => "{{secret:" + (typeof nameOrRef === "string" ? nameOrRef : nameOrRef.name) + "}}",
      envSecret: (nameOrRef) => typeof nameOrRef === "string"
        ? brokerClient.secret.createReference(nameOrRef, { modes: ["command_env"] })
        : nameOrRef,
      stdinSecret: (nameOrRef) => typeof nameOrRef === "string"
        ? brokerClient.secret.createReference(nameOrRef, { modes: ["command_stdin"] })
        : nameOrRef,
    },
  };

  const logFn = async (level, message, data) => {
    writeMessage({
      id: "log_" + Date.now(),
      type: "log",
      timestamp: Date.now(),
      version: "1.0.0",
      invocationId,
      level,
      message,
      data,
    });
  };

  const progressFn = async (percentage, message, stage) => {
    writeMessage({
      id: "prog_" + Date.now(),
      type: "progress",
      timestamp: Date.now(),
      version: "1.0.0",
      invocationId,
      percentage,
      message,
      stage,
    });
  };

  return {
    input,
    invocationId,
    workspaceRoot: options.workspaceRoot || ".",
    scratchDir: options.scratchDir || "",
    metadata: options.metadata || {},
    progress: progressFn,
    log: logFn,
    logger: {
      debug: (msg, data) => logFn("debug", msg, data),
      info: (msg, data) => logFn("info", msg, data),
      warn: (msg, data) => logFn("warn", msg, data),
      error: (msg, data) => logFn("error", msg, data),
    },
    broker: brokerClient,
    fs: brokerClient.fs,
    net: brokerClient.net,
    cmd: brokerClient.cmd,
    secret: brokerClient.secret,
  };
}

function validateSchema(schema, value, path = "") {
  if (!schema || typeof schema !== "object") return { valid: true, errors: [] };
  const s = schema.schema && typeof schema.schema === "object" ? schema.schema : schema;
  const errors = [];
  const expectedType = s.type;

  if (expectedType) {
    if (expectedType === "null" && value !== null) errors.push((path || "root") + ": expected null");
    else if (expectedType === "string" && typeof value !== "string") errors.push((path || "root") + ": expected string");
    else if (expectedType === "number" && typeof value !== "number") errors.push((path || "root") + ": expected number");
    else if (expectedType === "integer" && !Number.isInteger(value)) errors.push((path || "root") + ": expected integer");
    else if (expectedType === "boolean" && typeof value !== "boolean") errors.push((path || "root") + ": expected boolean");
    else if (expectedType === "array" && !Array.isArray(value)) errors.push((path || "root") + ": expected array");
    else if (expectedType === "object" && (typeof value !== "object" || value === null || Array.isArray(value))) errors.push((path || "root") + ": expected object");
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const properties = s.properties || {};
    const required = Array.isArray(s.required) ? s.required : [];
    const additionalProperties = s.additionalProperties !== false;

    for (const req of required) {
      if (!(req in value) || value[req] === undefined) {
        errors.push((path ? path + "." + req : req) + ": required field is missing");
      }
    }

    for (const [propName, propSchema] of Object.entries(properties)) {
      if (propName in value && value[propName] !== undefined) {
        const sub = validateSchema(propSchema, value[propName], path ? path + "." + propName : propName);
        errors.push(...sub.errors);
      }
    }

    if (!additionalProperties) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          errors.push((path ? path + "." + key : key) + ": additional property is not allowed");
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

async function handleMessage(msg) {
  if (msg.type === "initialize") {
    currentManifest = msg.manifest;
    currentEntrypoint = msg.bundleEntrypoint;
    return;
  }

  if (msg.type === "broker_response") {
    handleBrokerResponse(msg);
    return;
  }

  if (msg.type === "heartbeat") {
    writeMessage({
      id: "hb_" + Date.now(),
      type: "heartbeat",
      timestamp: Date.now(),
      version: "1.0.0",
      kind: "pong",
      sequence: msg.sequence,
    });
    return;
  }

  if (msg.type === "shutdown") {
    Deno.exit(0);
    return;
  }

  if (msg.type === "cancel") {
    if (currentAbortController) {
      currentAbortController.abort();
    }
    return;
  }

  if (msg.type === "invoke") {
    const startTime = Date.now();
    const { invocationId, input, context = {} } = msg;

    try {
      // Validate input against parameters schema
      if (currentManifest && currentManifest.parameters) {
        const valRes = validateSchema(currentManifest.parameters, input, "input");
        if (!valRes.valid) {
          writeMessage({
            id: "err_" + Date.now(),
            type: "error",
            timestamp: Date.now(),
            version: "1.0.0",
            invocationId,
            errorType: "validation_error",
            message: "Input validation failed: " + valRes.errors.join("; "),
            details: { errors: valRes.errors },
          });
          return;
        }
      }

      currentAbortController = new AbortController();
      const toolContext = createToolContext(invocationId, input, {
        workspaceRoot: msg.workspaceRoot || ".",
        scratchDir: msg.scratchDir || "",
        metadata: context.metadata || {},
      });

      // Load tool entrypoint
      const entrypointUrl = currentEntrypoint.startsWith("file://")
        ? currentEntrypoint
        : "file://" + (currentEntrypoint.startsWith("/") ? "" : Deno.cwd() + "/") + currentEntrypoint;

      const mod = await import(entrypointUrl);
      const handler = mod.default || mod.execute || mod.run || mod.handler || (typeof mod === "function" ? mod : null);

      if (!handler || typeof handler !== "function") {
        throw new Error("Tool entrypoint does not export a valid function (default, execute, run, or handler)");
      }

      const output = await handler(toolContext);

      // Validate output against outputSchema
      if (currentManifest && currentManifest.outputSchema) {
        const outRes = validateSchema(currentManifest.outputSchema, output, "output");
        if (!outRes.valid) {
          writeMessage({
            id: "err_" + Date.now(),
            type: "error",
            timestamp: Date.now(),
            version: "1.0.0",
            invocationId,
            errorType: "validation_error",
            message: "Output validation failed: " + outRes.errors.join("; "),
            details: { errors: outRes.errors },
          });
          return;
        }
      }

      const durationMs = Date.now() - startTime;
      writeMessage({
        id: "res_" + Date.now(),
        type: "result",
        timestamp: Date.now(),
        version: "1.0.0",
        invocationId,
        status: "success",
        output,
        durationMs,
      });
    } catch (err) {
      writeMessage({
        id: "err_" + Date.now(),
        type: "error",
        timestamp: Date.now(),
        version: "1.0.0",
        invocationId,
        errorType: "execution_error",
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    } finally {
      currentAbortController = null;
    }
  }
}

async function main() {
  const decoder = new TextDecoder();
  const buffer = new Uint8Array(65536);

  while (true) {
    const bytesRead = await Deno.stdin.read(buffer);
    if (bytesRead === null) break;

    textBuffer += decoder.decode(buffer.subarray(0, bytesRead));
    let newlineIndex;
    while ((newlineIndex = textBuffer.indexOf("\\n")) !== -1) {
      const line = textBuffer.slice(0, newlineIndex).trim();
      textBuffer = textBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        try {
          const parsed = JSON.parse(line);
          await handleMessage(parsed);
        } catch (e) {
          // ignore or write malformed frame error
        }
      }
    }
  }
}

main().catch((e) => {
  writeMessage({
    id: "err_fatal_" + Date.now(),
    type: "error",
    timestamp: Date.now(),
    version: "1.0.0",
    errorType: "fatal",
    message: e instanceof Error ? e.message : String(e),
  });
});
`;
