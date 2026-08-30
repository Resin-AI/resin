import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { JsonObject, JsonValue } from "./normalization/redaction.js";

export const DaemonConfigSchema = z.object({
  version: z.string().default("0.1.0"),
  logLevel: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(9400),
  socketPath: z.string().optional(),
  cloudUrl: z.string().url().default("https://api.resin.sh"),
  telemetryEnabled: z.boolean().default(true),
  storageDir: z.string().optional(),
  heartbeatIntervalMs: z.number().int().positive().default(3000),
  lockStaleThresholdMs: z.number().int().positive().default(15000),
  shutdownTimeoutMs: z.number().int().positive().default(10000),
  maxWorkerMemoryMb: z.number().int().positive().default(512),
  workerExecutionTimeoutMs: z.number().int().positive().default(30000),
  moduleConfigs: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  custom: z.record(z.string(), z.unknown()).default({}),
});

export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;
export type RedactedDaemonConfig = JsonObject;

export const IMMUTABLE_CONFIG_FIELDS = ["version", "storageDir", "socketPath"] as const;
export type ImmutableConfigField = (typeof IMMUTABLE_CONFIG_FIELDS)[number];

const SENSITIVE_KEY_PATTERN =
  /token|secret|password|passwd|key|auth|authorization|credential|credentials|assertion|signature|jwt|cookie|private|cert|vault/i;
export const REDACTED_PLACEHOLDER = "[REDACTED]";

/**
 * Deeply redacts sensitive keys from any object/record.
 */
export function redactSensitiveData<T>(data: T, currentKey?: string, parentSensitive = false): T {
  if (data === null || data === undefined) {
    return data;
  }

  const isSensitive = Boolean(
    parentSensitive || (currentKey && SENSITIVE_KEY_PATTERN.test(currentKey)),
  );

  const stringParsed = z.string().safeParse(data);
  if (stringParsed.success) {
    if (isSensitive && stringParsed.data.length > 0) {
      // SAFETY: REDACTED_PLACEHOLDER is string matching input string contract for type T.
      return REDACTED_PLACEHOLDER as T;
    }
    return data;
  }

  if (
    z.number().safeParse(data).success ||
    z.boolean().safeParse(data).success ||
    z.bigint().safeParse(data).success
  ) {
    if (isSensitive) {
      // SAFETY: REDACTED_PLACEHOLDER replaces sensitive primitive value.
      return REDACTED_PLACEHOLDER as T;
    }
    return data;
  }

  if (Array.isArray(data)) {
    // SAFETY: Sanitized array elements maintain array structure for type T.
    return data.map((item) => redactSensitiveData(item, currentKey, isSensitive)) as T;
  }

  const objectParsed = z.record(z.unknown()).safeParse(data);
  if (objectParsed.success) {
    const result: JsonObject = {};
    for (const [key, value] of Object.entries(objectParsed.data)) {
      const keySensitive = isSensitive || SENSITIVE_KEY_PATTERN.test(key);
      if (
        keySensitive &&
        (z.string().safeParse(value).success ||
          z.number().safeParse(value).success ||
          z.boolean().safeParse(value).success ||
          z.bigint().safeParse(value).success)
      ) {
        result[key] = REDACTED_PLACEHOLDER;
      } else {
        // SAFETY: Recursive redaction returns JSON-compatible value.
        result[key] = redactSensitiveData(value, key, keySensitive) as JsonValue;
      }
    }
    // SAFETY: Sanitized output object matches dictionary shape of type T.
    return result as T;
  }

  return data;
}

export function redactConfig(config: DaemonConfig): RedactedDaemonConfig {
  // SAFETY: Serialized config produces JsonObject record.
  const cloned = JSON.parse(JSON.stringify(config)) as JsonObject;
  // SAFETY: redactSensitiveData deep-cleans config object into RedactedDaemonConfig.
  return redactSensitiveData(cloned) as RedactedDaemonConfig;
}

/**
 * Extracts configuration values from environment variables prefixed with `RESIN_`.
 */
export function parseEnvConfig(
  env: Record<string, string | undefined> = process.env,
): Partial<DaemonConfig> {
  const result: Partial<DaemonConfig> = {};

  if (env.RESIN_LOG_LEVEL) {
    const parsed = z
      .enum(["debug", "info", "warn", "error", "silent"])
      .safeParse(env.RESIN_LOG_LEVEL);
    if (parsed.success) result.logLevel = parsed.data;
  }

  if (env.RESIN_HOST) {
    result.host = env.RESIN_HOST;
  }

  if (env.RESIN_PORT) {
    const port = Number.parseInt(env.RESIN_PORT, 10);
    if (!Number.isNaN(port)) result.port = port;
  }

  if (env.RESIN_SOCKET_PATH) {
    result.socketPath = env.RESIN_SOCKET_PATH;
  }

  if (env.RESIN_CLOUD_URL) {
    result.cloudUrl = env.RESIN_CLOUD_URL;
  }

  if (env.RESIN_TELEMETRY_ENABLED !== undefined) {
    result.telemetryEnabled =
      env.RESIN_TELEMETRY_ENABLED === "1" || env.RESIN_TELEMETRY_ENABLED === "true";
  }

  if (env.RESIN_STORAGE_DIR) {
    result.storageDir = env.RESIN_STORAGE_DIR;
  }

  if (env.RESIN_SHUTDOWN_TIMEOUT_MS) {
    const timeout = Number.parseInt(env.RESIN_SHUTDOWN_TIMEOUT_MS, 10);
    if (!Number.isNaN(timeout)) result.shutdownTimeoutMs = timeout;
  }

  if (env.RESIN_MAX_WORKER_MEMORY_MB) {
    const mem = Number.parseInt(env.RESIN_MAX_WORKER_MEMORY_MB, 10);
    if (!Number.isNaN(mem)) result.maxWorkerMemoryMb = mem;
  }

  if (env.RESIN_WORKER_EXECUTION_TIMEOUT_MS) {
    const workerTimeout = Number.parseInt(env.RESIN_WORKER_EXECUTION_TIMEOUT_MS, 10);
    if (!Number.isNaN(workerTimeout)) result.workerExecutionTimeoutMs = workerTimeout;
  }

  return result;
}

export const ConfigRecoveryWarningSchema = z
  .object({
    category: z.literal("MALFORMED_CONFIG"),
    detectedAt: z.number().int().nonnegative(),
    configPath: z.string().min(1).max(8_192),
    backupPath: z.string().min(1).max(8_192),
    remediation: z.string().min(1).max(4_096),
    message: z.string().min(1).max(16_384),
  })
  .strict();

export type ConfigRecoveryWarning = z.infer<typeof ConfigRecoveryWarningSchema>;

export const CONFIG_RECOVERY_WARNING_STATE_FILE_NAME = "config-recovery-warning.json";

const PersistedConfigRecoveryWarningSchema = z
  .object({
    version: z.literal(1),
    warning: ConfigRecoveryWarningSchema.nullable(),
  })
  .strict();
const MAX_CONFIG_RECOVERY_WARNING_BYTES = 64 * 1024;

interface PersistedConfigRecoveryWarningInspection {
  exists: boolean;
  valid: boolean;
  device?: number;
  inode?: number;
  state?: z.infer<typeof PersistedConfigRecoveryWarningSchema>;
}

export interface LoadConfigOptions {
  configPath?: string;
  env?: Record<string, string | undefined>;
  overrides?: Partial<DaemonConfig>;
  onWarning?: (warning: ConfigRecoveryWarning) => void;
}

let lastCorruptBackupTimestamp = 0;

function nextCorruptBackupPath(configPath: string): string {
  const timestamp = Math.max(Date.now(), lastCorruptBackupTimestamp + 1);
  lastCorruptBackupTimestamp = timestamp;
  return `${configPath}.corrupt.${timestamp}`;
}

function backUpMalformedConfig(configPath: string, rawContent: string): string {
  let lastCollision: NodeJS.ErrnoException | undefined;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const backupPath = nextCorruptBackupPath(configPath);
    try {
      fs.writeFileSync(backupPath, rawContent, {
        encoding: "utf-8",
        flag: "wx",
        mode: 0o600,
      });
      return backupPath;
    } catch (err) {
      // SAFETY: Node.js filesystem error carries standard ErrnoException code.
      const error = err as NodeJS.ErrnoException;
      if (error.code === "EEXIST") {
        lastCollision = error;
        continue;
      }
      throw new Error(
        `Malformed configuration at ${configPath} could not be backed up safely: ${error.message}`,
      );
    }
  }

  throw new Error(
    `Malformed configuration at ${configPath} could not be backed up safely: ${lastCollision?.message ?? "backup path collision"}`,
  );
}

let configRecoveryWarningWriteSequence = 0;

async function inspectPersistedConfigRecoveryWarning(
  warningStatePath: string,
): Promise<PersistedConfigRecoveryWarningInspection> {
  let entryStat: fs.Stats;
  try {
    entryStat = await fs.promises.lstat(warningStatePath);
  } catch (err) {
    // SAFETY: Node.js filesystem error carries standard ErrnoException code.
    const error = err as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      return { exists: false, valid: false };
    }
    throw err;
  }

  if (!entryStat.isFile() || entryStat.size > MAX_CONFIG_RECOVERY_WARNING_BYTES) {
    return {
      exists: true,
      valid: false,
      device: entryStat.dev,
      inode: entryStat.ino,
    };
  }

  const handle = await fs.promises.open(warningStatePath, "r");
  try {
    const openedStat = await handle.stat();
    if (
      !openedStat.isFile() ||
      openedStat.dev !== entryStat.dev ||
      openedStat.ino !== entryStat.ino ||
      openedStat.size > MAX_CONFIG_RECOVERY_WARNING_BYTES
    ) {
      return {
        exists: true,
        valid: false,
        device: entryStat.dev,
        inode: entryStat.ino,
      };
    }

    const content = Buffer.alloc(openedStat.size);
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== content.length) {
      return {
        exists: true,
        valid: false,
        device: entryStat.dev,
        inode: entryStat.ino,
      };
    }

    try {
      const parsed = PersistedConfigRecoveryWarningSchema.safeParse(
        JSON.parse(content.toString("utf-8")),
      );
      return {
        exists: true,
        valid: parsed.success,
        device: entryStat.dev,
        inode: entryStat.ino,
        state: parsed.success ? parsed.data : undefined,
      };
    } catch {
      return {
        exists: true,
        valid: false,
        device: entryStat.dev,
        inode: entryStat.ino,
      };
    }
  } finally {
    await handle.close();
  }
}

async function writeConfigRecoveryWarningState(
  warningStatePath: string,
  warning: ConfigRecoveryWarning | null,
): Promise<void> {
  const resolvedStatePath = path.resolve(warningStatePath);
  await fs.promises.mkdir(path.dirname(resolvedStatePath), {
    recursive: true,
    mode: 0o700,
  });

  const existing = await inspectPersistedConfigRecoveryWarning(resolvedStatePath);
  if (existing.exists && !existing.valid) {
    throw new Error(
      `Refusing to replace unexpected config recovery warning path at ${resolvedStatePath}`,
    );
  }

  const payload = JSON.stringify(
    {
      version: 1,
      warning,
    },
    null,
    2,
  );
  if (Buffer.byteLength(payload, "utf-8") > MAX_CONFIG_RECOVERY_WARNING_BYTES) {
    throw new Error("Config recovery warning exceeds the safe persistence limit");
  }

  configRecoveryWarningWriteSequence += 1;
  const temporaryPath = `${resolvedStatePath}.${process.pid}.${configRecoveryWarningWriteSequence}.tmp`;
  let temporaryFileCreated = false;
  try {
    await fs.promises.writeFile(temporaryPath, payload, {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    temporaryFileCreated = true;

    try {
      const currentStat = await fs.promises.lstat(resolvedStatePath);
      if (
        !existing.exists ||
        !currentStat.isFile() ||
        currentStat.dev !== existing.device ||
        currentStat.ino !== existing.inode
      ) {
        throw new Error(
          `Refusing to replace changed config recovery warning path at ${resolvedStatePath}`,
        );
      }
    } catch (err) {
      // SAFETY: Node.js filesystem error carries standard ErrnoException code.
      const error = err as NodeJS.ErrnoException;
      if (error.code !== "ENOENT" || existing.exists) {
        throw err;
      }
    }

    await fs.promises.rename(temporaryPath, resolvedStatePath);
  } catch (err) {
    if (temporaryFileCreated) {
      try {
        await fs.promises.unlink(temporaryPath);
      } catch {
        // Only the private temporary file created above is eligible for cleanup.
      }
    }
    throw err;
  }
}

export async function persistConfigRecoveryWarning(
  warningStatePath: string,
  warning: ConfigRecoveryWarning,
): Promise<void> {
  await writeConfigRecoveryWarningState(
    warningStatePath,
    ConfigRecoveryWarningSchema.parse(warning),
  );
}

export async function readPersistedConfigRecoveryWarning(
  warningStatePath: string,
): Promise<ConfigRecoveryWarning | undefined> {
  const inspected = await inspectPersistedConfigRecoveryWarning(path.resolve(warningStatePath));
  return inspected.valid ? (inspected.state?.warning ?? undefined) : undefined;
}

export async function clearPersistedConfigRecoveryWarning(
  warningStatePath: string,
): Promise<boolean> {
  const inspected = await inspectPersistedConfigRecoveryWarning(path.resolve(warningStatePath));
  if (!inspected.exists || !inspected.valid || inspected.state?.warning === null) {
    return false;
  }
  await writeConfigRecoveryWarningState(warningStatePath, null);
  return true;
}

/**
 * Loads configuration by merging defaults < file config < environment variables < explicit overrides.
 * Missing schema fields are backfilled in memory; the source file is never rewritten.
 */
export function loadDaemonConfig(options: LoadConfigOptions = {}): DaemonConfig {
  const env = options.env ?? process.env;
  let fileConfig: Partial<DaemonConfig> = {};

  if (options.configPath) {
    const resolvedPath = path.resolve(options.configPath);
    if (fs.existsSync(resolvedPath)) {
      let rawContent: string;
      try {
        rawContent = fs.readFileSync(resolvedPath, "utf-8");
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to read configuration file at ${resolvedPath}: ${errorMsg}`);
      }

      try {
        const parsedFile = JSON.parse(rawContent);
        const parsedObj = z.record(z.unknown()).safeParse(parsedFile);
        if (!parsedObj.success || Array.isArray(parsedFile)) {
          throw new Error("Configuration file content must be a JSON object");
        }
        // SAFETY: Parsed JSON object matches partial DaemonConfig dictionary.
        fileConfig = parsedObj.data as Partial<DaemonConfig>;
      } catch (err) {
        const backupPath = backUpMalformedConfig(resolvedPath, rawContent);
        const remediation = `Inspect ${backupPath}, repair ${resolvedPath}, then restart Resin.`;
        const warning: ConfigRecoveryWarning = {
          category: "MALFORMED_CONFIG",
          detectedAt: Date.now(),
          configPath: resolvedPath,
          backupPath,
          remediation,
          message:
            `WARNING: Resin found malformed JSON at ${resolvedPath}. ` +
            `The original was left unchanged and a permission-safe backup was created at ${backupPath}. ` +
            `Resin is continuing with safe defaults. ${remediation}`,
        };

        if (options.onWarning) {
          options.onWarning(warning);
        } else {
          console.warn(warning.message);
        }
      }
    }
  }

  const envConfig = parseEnvConfig(env);
  // SAFETY: Filtered key-value entries represent partial DaemonConfig overrides.
  const explicitOverrides = Object.fromEntries(
    Object.entries(options.overrides ?? {}).filter(([, value]) => value !== undefined),
  ) as Partial<DaemonConfig>;

  const merged = {
    ...fileConfig,
    ...envConfig,
    ...explicitOverrides,
  };

  const parsed = DaemonConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const errorIssues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join(", ");
    throw new Error(`Invalid daemon configuration: ${errorIssues}`);
  }

  return parsed.data;
}

export interface ConfigUpdateValidationResult {
  valid: boolean;
  errors: string[];
  updatedConfig?: DaemonConfig;
}

/**
 * Validates a configuration update against immutable fields and schema constraints.
 */
export function validateConfigUpdate(
  currentConfig: DaemonConfig,
  update: Partial<DaemonConfig>,
): ConfigUpdateValidationResult {
  const errors: string[] = [];

  // Check immutable fields
  for (const field of IMMUTABLE_CONFIG_FIELDS) {
    if (field in update && update[field] !== undefined && update[field] !== currentConfig[field]) {
      errors.push(`Field '${field}' is immutable and cannot be updated at runtime.`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const candidate = {
    ...currentConfig,
    ...update,
  };

  const parsed = DaemonConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    const schemaErrors = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    return {
      valid: false,
      errors: schemaErrors,
    };
  }

  return {
    valid: true,
    errors: [],
    updatedConfig: parsed.data,
  };
}
