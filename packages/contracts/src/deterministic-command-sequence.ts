import { z } from "zod";
import { descriptorSafeCanonicalJsonStringify, hashCanonicalContent } from "./canonical.js";

/**
 * Metadata key under which deterministic command sequence evidence travels on a session event.
 */
export const RESIN_COMMAND_SEQUENCE_METADATA_KEY = "resinCommandSequence" as const;

/** Version of the deterministic command sequence contract. */
export const DETERMINISTIC_COMMAND_SEQUENCE_SCHEMA_VERSION = 1 as const;

/** Kind discriminator for deterministic command sequences. */
export const DETERMINISTIC_COMMAND_SEQUENCE_KIND = "command-sequence" as const;

/** Control flow model for deterministic command sequences. */
export const DETERMINISTIC_COMMAND_SEQUENCE_CONTROL = "and-then" as const;

/**
 * Hard limits for deterministic command sequences.
 *
 * Limits are size- and resource-based, never a fixed command-count cap: a workflow may be as long
 * as the user's work actually is, as long as the whole sequence fits the resource budget.
 * Evidence growth is bounded by the sequence argument budget, the per-token length limits, the
 * recorder's own command-length bound, and the pinned canonical serializer bounds.
 */
export const DETERMINISTIC_COMMAND_SEQUENCE_LIMITS = {
  /** Maximum number of arguments in a single step. */
  maxArgs: 32,
  /**
   * Maximum number of arguments across every step of one sequence. This is a size limit on the
   * evidence (and therefore on compiled source and invocation cost), not a bound on how many
   * commands a useful workflow may contain.
   */
  maxSequenceArgs: 256,
  /** Maximum length of an executable basename. */
  maxExecutableLength: 128,
  /** Maximum length of a literal token. */
  maxLiteralLength: 128,
  /** Maximum length of a parameter identifier. */
  maxParameterLength: 64,
  /** Maximum length of a step identifier. */
  maxStepIdLength: 32,
  /**
   * Structural bounds for untrusted evidence: maximum node count and nesting depth accepted while
   * walking a payload descriptor-safely, pinned to the same numbers used for canonical
   * serialization so every accepted sequence can always be digested without throwing.
   */
  maxEvidenceNodes: 10_000,
  maxEvidenceDepth: 64,
} as const;
/** Allowed parameter roles for command arguments. */
export const DeterministicCommandParameterRoleSchema = z.enum(["path", "string", "number"]);

export type DeterministicCommandParameterRole = z.infer<
  typeof DeterministicCommandParameterRoleSchema
>;

/**
 * Literal argument in a deterministic command step.
 *
 * Literals are shell-free argv tokens, not shell source. Values requiring
 * whitespace, expansion, chaining, or quoting must be represented as typed
 * parameters instead.
 */
export const DeterministicCommandArgLiteralSchema = z
  .object({
    literal: z
      .string()
      .min(1)
      .max(DETERMINISTIC_COMMAND_SEQUENCE_LIMITS.maxLiteralLength)
      .regex(
        /^[^\s\x00\r\n`$|;&<>(){}!'"\\]+$/,
        "Literal argument must be a shell-free argv token",
      ),
  })
  .strict();

export type DeterministicCommandArgLiteral = z.infer<typeof DeterministicCommandArgLiteralSchema>;

/**
 * Parameter argument in a deterministic command step.
 * Actual parameter values (paths, strings, numbers) are strictly excluded from evidence.
 */
export const DeterministicCommandArgParameterSchema = z
  .object({
    parameter: z
      .string()
      .regex(/^arg[0-9]+$/)
      .max(DETERMINISTIC_COMMAND_SEQUENCE_LIMITS.maxParameterLength),
    role: DeterministicCommandParameterRoleSchema,
  })
  .strict();

export type DeterministicCommandArgParameter = z.infer<
  typeof DeterministicCommandArgParameterSchema
>;

/**
 * Parameter embedded after a fixed flag prefix in one argv token.
 *
 * Example: `{ prefix: "--output=", parameter: "arg0", role: "path" }`
 * replays as the single argument `--output=<value>`.
 */
export const DeterministicCommandArgPrefixedParameterSchema = z
  .object({
    prefix: z
      .string()
      .min(3)
      .max(DETERMINISTIC_COMMAND_SEQUENCE_LIMITS.maxLiteralLength)
      .regex(
        /^-{1,2}[A-Za-z][A-Za-z0-9_.-]*=$/,
        "Parameter prefix must be a shell-free --flag= token prefix",
      ),
    parameter: z
      .string()
      .regex(/^arg[0-9]+$/)
      .max(DETERMINISTIC_COMMAND_SEQUENCE_LIMITS.maxParameterLength),
    role: DeterministicCommandParameterRoleSchema,
  })
  .strict();

export type DeterministicCommandArgPrefixedParameter = z.infer<
  typeof DeterministicCommandArgPrefixedParameterSchema
>;

/** Single argument in a deterministic command step. */
export const DeterministicCommandArgSchema = z.union([
  DeterministicCommandArgLiteralSchema,
  DeterministicCommandArgParameterSchema,
  DeterministicCommandArgPrefixedParameterSchema,
]);

export type DeterministicCommandArg = z.infer<typeof DeterministicCommandArgSchema>;

const UNSAFE_DETERMINISTIC_COMMAND_EXECUTABLES: Record<string, true> = {
  // Shells and command interpreters.
  sh: true,
  bash: true,
  zsh: true,
  csh: true,
  tcsh: true,
  ksh: true,
  dash: true,
  fish: true,
  cmd: true,
  "cmd.exe": true,
  powershell: true,
  "powershell.exe": true,
  pwsh: true,
  "pwsh.exe": true,
  wscript: true,
  cscript: true,
  // Positional-program tools can execute caller-controlled code without a flag.
  awk: true,
  gawk: true,
  mawk: true,
  nawk: true,
  sed: true,
  gsed: true,
  // Wrappers whose outer binary hides the executable identity checked by the broker.
  sudo: true,
  env: true,
  time: true,
  nohup: true,
  exec: true,
  nice: true,
  ionice: true,
  timeout: true,
  setsid: true,
  stdbuf: true,
  busybox: true,
  xargs: true,
  chroot: true,
  watch: true,
  strace: true,
  ltrace: true,
  taskset: true,
  numactl: true,
  unshare: true,
  nsenter: true,
  // Stateful or shell-only builtins cannot preserve sequential subprocess semantics.
  cd: true,
  pushd: true,
  popd: true,
  export: true,
  unset: true,
  alias: true,
  unalias: true,
  set: true,
  shift: true,
  trap: true,
  wait: true,
  jobs: true,
  fg: true,
  bg: true,
  disown: true,
  hash: true,
  type: true,
  source: true,
  builtin: true,
  command: true,
  eval: true,
  umask: true,
  ulimit: true,
  readonly: true,
  local: true,
  declare: true,
  typeset: true,
  read: true,
  exit: true,
  return: true,
  break: true,
  continue: true,
};

/**
 * Returns whether an executable directly interprets commands or hides a
 * nested executable identity from the command broker.
 */
export function isUnsafeDeterministicCommandExecutable(executable: string): boolean {
  const normalized = executable.toLowerCase().replace(/\.exe$/i, "");
  return UNSAFE_DETERMINISTIC_COMMAND_EXECUTABLES[normalized] === true;
}

/**
 * Executable basename for deterministic command execution.
 *
 * This is intentionally an open lexical schema rather than a command
 * allowlist. Runtime authorization remains bound to the exact executable and
 * argv profile recorded in each compiled tool's capability manifest. Shell
 * interpreters and identity-hiding process wrappers remain denied.
 */
export const DeterministicCommandExecutableSchema = z
  .string()
  .min(1)
  .max(DETERMINISTIC_COMMAND_SEQUENCE_LIMITS.maxExecutableLength)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/, "Executable must be a portable bare command name")
  .refine(
    (executable) => !isUnsafeDeterministicCommandExecutable(executable),
    "Shell interpreters, process-launching wrappers, and stateful builtins are not deterministic command executables",
  );

export type DeterministicCommandExecutable = z.infer<typeof DeterministicCommandExecutableSchema>;

/** Single step in a deterministic command sequence. */
export const DeterministicCommandStepSchema = z
  .object({
    id: z
      .string()
      .regex(/^step[0-9]+$/)
      .max(DETERMINISTIC_COMMAND_SEQUENCE_LIMITS.maxStepIdLength),
    executable: DeterministicCommandExecutableSchema,
    argv: z.array(DeterministicCommandArgSchema).max(DETERMINISTIC_COMMAND_SEQUENCE_LIMITS.maxArgs),
  })
  .strict();

export type DeterministicCommandStep = z.infer<typeof DeterministicCommandStepSchema>;

function isForbiddenKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

/** Options for {@link isDescriptorSafePlainTree}; defaults match the pinned evidence limits. */
export interface DescriptorSafeTreeOptions {
  maxDepth?: number;
  maxNodes?: number;
}

/**
 * Validates that a value tree consists exclusively of descriptor-safe plain objects,
 * arrays, and primitives within pinned depth and node bounds. Rejects accessors (getters/setters),
 * forbidden prototype keys, custom prototypes, and circular structures without invoking any
 * getters.
 */
export function isDescriptorSafePlainTree(
  value: unknown,
  options: DescriptorSafeTreeOptions = {},
): boolean {
  const maxDepth = options.maxDepth ?? DETERMINISTIC_COMMAND_SEQUENCE_LIMITS.maxEvidenceDepth;
  const maxNodes = options.maxNodes ?? DETERMINISTIC_COMMAND_SEQUENCE_LIMITS.maxEvidenceNodes;
  let nodes = 0;
  const seen = new Set<object>();

  const walk = (current: unknown, depth: number): boolean => {
    // Count every value, primitives included, exactly as canonical serialization does.
    nodes++;
    if (nodes > maxNodes || depth > maxDepth) {
      return false;
    }
    if (current === null || typeof current !== "object") {
      return true;
    }
    if (seen.has(current)) {
      return false;
    }
    seen.add(current);

    const proto = Object.getPrototypeOf(current);
    if (Array.isArray(current)) {
      if (proto !== Array.prototype) {
        return false;
      }
      const propNames = Object.getOwnPropertyNames(current);
      for (let i = 0; i < propNames.length; i++) {
        const key = propNames[i] as string;
        if (key === "length") continue;
        if (isForbiddenKey(key)) return false;

        const desc = Object.getOwnPropertyDescriptor(current, key);
        if (!desc || !("value" in desc) || desc.get !== undefined || desc.set !== undefined) {
          return false;
        }
        if (!walk(desc.value, depth + 1)) {
          return false;
        }
      }
      return true;
    }

    if (proto !== null && proto !== Object.prototype) {
      return false;
    }

    const propNames = Object.getOwnPropertyNames(current);
    for (let i = 0; i < propNames.length; i++) {
      const key = propNames[i] as string;
      if (isForbiddenKey(key)) {
        return false;
      }

      const desc = Object.getOwnPropertyDescriptor(current, key);
      if (!desc || !("value" in desc) || desc.get !== undefined || desc.set !== undefined) {
        return false;
      }
      if (!walk(desc.value, depth + 1)) {
        return false;
      }
    }

    return true;
  };

  try {
    return walk(value, 0);
  } catch {
    return false;
  }
}

/**
 * Strict schema and validator for deterministic command sequences.
 *
 * Enforces:
 * - schemaVersion: 1
 * - kind: 'command-sequence'
 * - control: 'and-then'
 * - 1 or more shell-free command steps, bounded by the sequence budget rather than a fixed command count
 * - portable executable names without a command allowlist
 * - strictly sequential step IDs (step0, step1, ...)
 * - strictly sequential parameter identifiers (arg0, arg1, ...) where a repeated identifier names one
 *   input value shared by several steps and therefore keeps one role; the argv prefix carrying each
 *   occurrence is positional and may differ
 * - strict plain objects with no extra keys, prototype pollution, or hostiles
 * - evidence-derived SHA-256 commitments for private string parameters: a string parameter without a
 *   commitment is a caller-supplied input, while a committed one is pinned to the private value the
 *   evidence recorded, so the compiled tool can only ever replay that value
 */
const RawDeterministicCommandSequenceSchema = z
  .object({
    schemaVersion: z.literal(DETERMINISTIC_COMMAND_SEQUENCE_SCHEMA_VERSION),
    kind: z.literal(DETERMINISTIC_COMMAND_SEQUENCE_KIND),
    control: z.literal(DETERMINISTIC_COMMAND_SEQUENCE_CONTROL),
    steps: z.array(DeterministicCommandStepSchema).min(1),
    parameterValueSha256: z
      .record(z.string().regex(/^arg[0-9]+$/), z.string().regex(/^[0-9a-f]{64}$/))
      .optional(),
  })
  .strict()
  .superRefine((seq, ctx) => {
    const seenParamNames = new Map<string, DeterministicCommandParameterRole>();
    let totalArgs = 0;

    for (let i = 0; i < seq.steps.length; i++) {
      const step = seq.steps[i];
      totalArgs += step.argv.length;

      // Validate step id ordering
      const expectedStepId = `step${i}`;
      if (step.id !== expectedStepId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Step at index ${i} must have id '${expectedStepId}', got '${step.id}'`,
          path: ["steps", i, "id"],
        });
      }

      // Validate parameter ordering and consistent role reuse across all steps. A shared identifier
      // names one input value; the argv prefix that carries it belongs to its position and may
      // differ per occurrence.
      for (let j = 0; j < step.argv.length; j++) {
        const arg = step.argv[j];
        if ("parameter" in arg) {
          const existingRole = seenParamNames.get(arg.parameter);
          if (existingRole === undefined) {
            const expectedParamName = `arg${seenParamNames.size}`;
            if (arg.parameter !== expectedParamName) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Parameter identifier '${arg.parameter}' first appears at position ${seenParamNames.size}: expected '${expectedParamName}'`,
                path: ["steps", i, "argv", j, "parameter"],
              });
            }
            seenParamNames.set(arg.parameter, arg.role);
          } else if (existingRole !== arg.role) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Parameter '${arg.parameter}' is reused with conflicting role: expected '${existingRole}', got '${arg.role}'`,
              path: ["steps", i, "argv", j],
            });
          }
        }
      }
    }

    if (totalArgs > DETERMINISTIC_COMMAND_SEQUENCE_LIMITS.maxSequenceArgs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Command sequence carries ${totalArgs} arguments; the evidence budget allows at most ${DETERMINISTIC_COMMAND_SEQUENCE_LIMITS.maxSequenceArgs} across all steps`,
        path: ["steps"],
      });
    }

    // Structural work is bounded by matching the canonical serializer's node budget
    let totalNodes =
      5 + (seq.parameterValueSha256 ? 1 + Object.keys(seq.parameterValueSha256).length : 0);
    for (let i = 0; i < seq.steps.length; i++) {
      const step = seq.steps[i];
      totalNodes += 4; // step object + id + executable + argv array
      for (let j = 0; j < step.argv.length; j++) {
        const arg = step.argv[j];
        if ("prefix" in arg) {
          totalNodes += 4; // arg object + prefix + parameter + role
        } else if ("parameter" in arg) {
          totalNodes += 3; // arg object + parameter + role
        } else {
          totalNodes += 2; // arg object + literal
        }
      }
    }

    if (totalNodes > DETERMINISTIC_COMMAND_SEQUENCE_LIMITS.maxEvidenceNodes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Command sequence carries ${totalNodes} structural nodes; the evidence budget allows at most ${DETERMINISTIC_COMMAND_SEQUENCE_LIMITS.maxEvidenceNodes}`,
        path: ["steps"],
      });
    }

    // A string parameter may be free: the compiled tool then requires the caller to supply the value.
    // Only a parameter whose recorded value is private carries a commitment, and admission refuses
    // sequences that pin such values because they can never be reused for other inputs.

    for (const parameter of Object.keys(seq.parameterValueSha256 ?? {})) {
      if (seenParamNames.get(parameter) !== "string") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Value commitment '${parameter}' must reference a string parameter`,
          path: ["parameterValueSha256", parameter],
        });
      }
    }
  });

export const DeterministicCommandSequenceSchema = z.preprocess((val) => {
  if (!isDescriptorSafePlainTree(val)) {
    return null;
  }
  return val;
}, RawDeterministicCommandSequenceSchema);

export type DeterministicCommandSequence = z.infer<typeof DeterministicCommandSequenceSchema>;

/**
 * Type guard verifying if an unknown value is a valid DeterministicCommandSequence.
 */
export function isDeterministicCommandSequence(
  value: unknown,
): value is DeterministicCommandSequence {
  if (!isDescriptorSafePlainTree(value)) {
    return false;
  }
  return DeterministicCommandSequenceSchema.safeParse(value).success;
}

/**
 * Parses and validates an unknown value as a DeterministicCommandSequence.
 * Throws ZodError on validation failure.
 */
export function parseDeterministicCommandSequence(value: unknown): DeterministicCommandSequence {
  if (!isDescriptorSafePlainTree(value)) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        message:
          "Input must be a descriptor-safe plain object tree without accessors, prototype pollution, or forbidden keys",
        path: [],
      },
    ]);
  }
  return DeterministicCommandSequenceSchema.parse(value);
}

/**
 * Safely parses an unknown value as a DeterministicCommandSequence.
 */
export function safeParseDeterministicCommandSequence(
  value: unknown,
): z.SafeParseReturnType<unknown, DeterministicCommandSequence> {
  if (!isDescriptorSafePlainTree(value)) {
    return {
      success: false,
      error: new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          message:
            "Input must be a descriptor-safe plain object tree without accessors, prototype pollution, or forbidden keys",
          path: [],
        },
      ]),
    };
  }
  return DeterministicCommandSequenceSchema.safeParse(value);
}

/**
 * Computes a deterministic SHA-256 digest of a canonical command sequence.
 *
 * Pinned to the same structural bounds the validator enforces, so an accepted sequence always
 * serializes.
 */
export function canonicalDeterministicCommandSequenceDigest(
  sequence: DeterministicCommandSequence,
  options?: { prefix?: boolean },
): string {
  const serialized = descriptorSafeCanonicalJsonStringify(sequence, {
    maxDepth: DETERMINISTIC_COMMAND_SEQUENCE_LIMITS.maxEvidenceDepth,
    maxNodes: DETERMINISTIC_COMMAND_SEQUENCE_LIMITS.maxEvidenceNodes,
  });
  if (!serialized) {
    throw new Error("Failed to canonically serialize DeterministicCommandSequence");
  }
  return hashCanonicalContent(JSON.parse(serialized), options);
}

/**
 * Fail-closed digest for untrusted command-sequence evidence.
 *
 * Validates the payload under the same descriptor-safe bounds and strict schema as
 * {@link safeParseDeterministicCommandSequence} and returns `undefined` instead of throwing, so
 * evidence ingestion can never be interrupted by a hostile, oversized, or malformed payload.
 */
export function tryCanonicalDeterministicCommandSequenceDigest(
  value: unknown,
  options?: { prefix?: boolean },
): string | undefined {
  const parsed = safeParseDeterministicCommandSequence(value);
  if (!parsed.success) {
    return undefined;
  }
  try {
    return canonicalDeterministicCommandSequenceDigest(parsed.data, options);
  } catch {
    return undefined;
  }
}
