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

/** Hard limits for deterministic command sequences. */
export const DETERMINISTIC_COMMAND_SEQUENCE_LIMITS = {
  /** Maximum number of command steps in a single sequence. */
  maxSteps: 8,
  /** Maximum number of arguments in a single step. */
  maxArgs: 32,
  /** Maximum length of a literal token. */
  maxLiteralLength: 128,
  /** Maximum length of a parameter identifier. */
  maxParameterLength: 64,
  /** Maximum length of a step identifier. */
  maxStepIdLength: 32,
} as const;

/** Allowed parameter roles for command arguments. */
export const DeterministicCommandParameterRoleSchema = z.enum(["path", "string", "number"]);

export type DeterministicCommandParameterRole = z.infer<
  typeof DeterministicCommandParameterRoleSchema
>;

/**
 * Literal argument in a deterministic command step.
 * Only allowlisted CLI syntax literals (subcommands, flags) can appear.
 */
export const DeterministicCommandArgLiteralSchema = z
  .object({
    literal: z.string().min(1).max(DETERMINISTIC_COMMAND_SEQUENCE_LIMITS.maxLiteralLength),
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

/** Single argument in a deterministic command step. */
export const DeterministicCommandArgSchema = z.union([
  DeterministicCommandArgLiteralSchema,
  DeterministicCommandArgParameterSchema,
]);

export type DeterministicCommandArg = z.infer<typeof DeterministicCommandArgSchema>;

/** Allowlisted executables for deterministic command execution. */
export const DeterministicCommandExecutableSchema = z.enum(["git", "lune", "stylua", "selene"]);

export type DeterministicCommandExecutable = z.infer<typeof DeterministicCommandExecutableSchema>;

/** Single step in a deterministic command sequence. */
export const DeterministicCommandStepSchema = z
  .object({
    id: z
      .string()
      .regex(/^step[0-9]+$/)
      .max(DETERMINISTIC_COMMAND_SEQUENCE_LIMITS.maxStepIdLength),
    executable: DeterministicCommandExecutableSchema,
    argv: z
      .array(DeterministicCommandArgSchema)
      .min(1)
      .max(DETERMINISTIC_COMMAND_SEQUENCE_LIMITS.maxArgs),
  })
  .strict();

export type DeterministicCommandStep = z.infer<typeof DeterministicCommandStepSchema>;

function isForbiddenKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

/**
 * Validates that a value tree consists exclusively of descriptor-safe plain objects,
 * arrays, and primitives. Rejects accessors (getters/setters), forbidden prototype keys,
 * custom prototypes, and circular structures without invoking any getters.
 */
export function isDescriptorSafePlainTree(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== "object") {
    return true;
  }

  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  const proto = Object.getPrototypeOf(value);

  if (Array.isArray(value)) {
    if (proto !== Array.prototype) {
      return false;
    }
    const propNames = Object.getOwnPropertyNames(value);
    for (let i = 0; i < propNames.length; i++) {
      const key = propNames[i] as string;
      if (key === "length") continue;
      if (isForbiddenKey(key)) return false;

      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (!desc) return false;
      if (!("value" in desc) || desc.get !== undefined || desc.set !== undefined) {
        return false;
      }
      if (!isDescriptorSafePlainTree(desc.value, seen)) {
        return false;
      }
    }
    return true;
  }

  if (proto !== null && proto !== Object.prototype) {
    return false;
  }

  const propNames = Object.getOwnPropertyNames(value);
  for (let i = 0; i < propNames.length; i++) {
    const key = propNames[i] as string;
    if (isForbiddenKey(key)) {
      return false;
    }

    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc) return false;
    if (!("value" in desc) || desc.get !== undefined || desc.set !== undefined) {
      return false;
    }
    if (!isDescriptorSafePlainTree(desc.value, seen)) {
      return false;
    }
  }

  return true;
}

/**
 * Validates the exact supported grammar for an individual command step.
 */
function validateStepGrammar(
  step: DeterministicCommandStep,
  stepIndex: number,
  ctx: z.RefinementCtx,
): void {
  if (step.executable === "git") {
    const firstArg = step.argv[0];
    if (!("literal" in firstArg)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Step ${stepIndex} (git) first argument must be a literal subcommand`,
        path: ["steps", stepIndex, "argv", 0],
      });
      return;
    }

    const sub = firstArg.literal;
    if (sub === "status") {
      // git status (--short, --porcelain)
      if (step.argv.length > 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `git status accepts at most one optional flag (--short or --porcelain)`,
          path: ["steps", stepIndex, "argv"],
        });
        return;
      }
      if (step.argv.length === 2) {
        const flagArg = step.argv[1];
        if (
          !("literal" in flagArg) ||
          (flagArg.literal !== "--short" && flagArg.literal !== "--porcelain")
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `git status flag must be literal --short or --porcelain`,
            path: ["steps", stepIndex, "argv", 1],
          });
        }
      }
    } else if (sub === "diff") {
      // git diff (--stat, --name-only, --name-status)
      if (step.argv.length > 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `git diff accepts at most one optional flag (--stat, --name-only, or --name-status)`,
          path: ["steps", stepIndex, "argv"],
        });
        return;
      }
      if (step.argv.length === 2) {
        const flagArg = step.argv[1];
        if (
          !("literal" in flagArg) ||
          (flagArg.literal !== "--stat" &&
            flagArg.literal !== "--name-only" &&
            flagArg.literal !== "--name-status")
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `git diff flag must be literal --stat, --name-only, or --name-status`,
            path: ["steps", stepIndex, "argv", 1],
          });
        }
      }
    } else if (sub === "log") {
      // git log (--oneline, optional -n NUMBER)
      // Allowed flags: literal "--oneline", and optional pair literal "-n" + parameter(number)
      let hasOneline = false;
      let hasLimit = false;

      let idx = 1;
      while (idx < step.argv.length) {
        const arg = step.argv[idx];
        if ("literal" in arg && arg.literal === "--oneline") {
          if (hasOneline) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Duplicate --oneline flag in git log`,
              path: ["steps", stepIndex, "argv", idx],
            });
            return;
          }
          hasOneline = true;
          idx++;
        } else if ("literal" in arg && arg.literal === "-n") {
          if (hasLimit) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Duplicate -n limit in git log`,
              path: ["steps", stepIndex, "argv", idx],
            });
            return;
          }
          if (idx + 1 >= step.argv.length) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `-n requires a numeric parameter argument`,
              path: ["steps", stepIndex, "argv", idx],
            });
            return;
          }
          const nextArg = step.argv[idx + 1];
          if (!("parameter" in nextArg) || nextArg.role !== "number") {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `-n argument must be a parameter with role 'number'`,
              path: ["steps", stepIndex, "argv", idx + 1],
            });
            return;
          }
          hasLimit = true;
          idx += 2;
        } else {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Unsupported argument for git log: only --oneline and -n NUMBER are permitted`,
            path: ["steps", stepIndex, "argv", idx],
          });
          return;
        }
      }

      if (!hasOneline) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `git log requires --oneline flag`,
          path: ["steps", stepIndex, "argv"],
        });
      }
    } else {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unsupported git subcommand '${sub}': only status, diff, log are permitted`,
        path: ["steps", stepIndex, "argv", 0],
      });
    }
  } else if (step.executable === "lune") {
    // lune run PATH (optional --suite STRING)
    const firstArg = step.argv[0];
    if (!("literal" in firstArg) || firstArg.literal !== "run") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Step ${stepIndex} (lune) first argument must be literal 'run'`,
        path: ["steps", stepIndex, "argv", 0],
      });
      return;
    }

    if (step.argv.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `lune run requires a path parameter argument`,
        path: ["steps", stepIndex, "argv"],
      });
      return;
    }

    const pathArg = step.argv[1];
    if (!("parameter" in pathArg) || pathArg.role !== "path") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `lune run second argument must be a parameter with role 'path'`,
        path: ["steps", stepIndex, "argv", 1],
      });
      return;
    }

    if (step.argv.length === 2) {
      return;
    }

    if (step.argv.length === 4) {
      const suiteFlag = step.argv[2];
      const suiteVal = step.argv[3];
      if (!("literal" in suiteFlag) || suiteFlag.literal !== "--suite") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `lune run third argument must be literal '--suite'`,
          path: ["steps", stepIndex, "argv", 2],
        });
        return;
      }
      if (!("parameter" in suiteVal) || suiteVal.role !== "string") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `lune run --suite value must be a parameter with role 'string'`,
          path: ["steps", stepIndex, "argv", 3],
        });
        return;
      }
      return;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Unsupported arguments for lune run: must be 'run PATH' or 'run PATH --suite STRING'`,
      path: ["steps", stepIndex, "argv"],
    });
  } else if (step.executable === "stylua") {
    // stylua --check PATH... (one or more path parameters)
    const firstArg = step.argv[0];
    if (!("literal" in firstArg) || firstArg.literal !== "--check") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Step ${stepIndex} (stylua) first argument must be literal '--check'`,
        path: ["steps", stepIndex, "argv", 0],
      });
      return;
    }

    if (step.argv.length < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `stylua --check requires at least one path parameter argument`,
        path: ["steps", stepIndex, "argv"],
      });
      return;
    }

    for (let i = 1; i < step.argv.length; i++) {
      const arg = step.argv[i];
      if (!("parameter" in arg) || arg.role !== "path") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `stylua argument at index ${i} must be a parameter with role 'path'`,
          path: ["steps", stepIndex, "argv", i],
        });
      }
    }
  } else if (step.executable === "selene") {
    // selene [--allow-warnings] PATH... (one or more path parameters)
    let pathStartIndex = 0;
    const firstArg = step.argv[0];

    if ("literal" in firstArg) {
      if (firstArg.literal !== "--allow-warnings") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unsupported flag '${firstArg.literal}' for selene: only optional '--allow-warnings' is permitted`,
          path: ["steps", stepIndex, "argv", 0],
        });
        return;
      }
      pathStartIndex = 1;
    }

    if (step.argv.length <= pathStartIndex) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `selene requires at least one path parameter argument`,
        path: ["steps", stepIndex, "argv"],
      });
      return;
    }

    for (let i = pathStartIndex; i < step.argv.length; i++) {
      const arg = step.argv[i];
      if (!("parameter" in arg) || arg.role !== "path") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `selene argument at index ${i} must be a parameter with role 'path'`,
          path: ["steps", stepIndex, "argv", i],
        });
      }
    }
  }
}

/**
 * Strict schema and validator for deterministic command sequences.
 *
 * Enforces:
 * - schemaVersion: 1
 * - kind: 'command-sequence'
 * - control: 'and-then'
 * - 1 to 8 steps
 * - strictly sequential step IDs (step0, step1, ...)
 * - strictly sequential, unique parameter identifiers (arg0, arg1, ...)
 * - exact CLI grammar per step (git status, git diff, git log, lune run, stylua --check, selene)
 * - strict plain objects with no extra keys, prototype pollution, or hostiles
 */
const RawDeterministicCommandSequenceSchema = z
  .object({
    schemaVersion: z.literal(DETERMINISTIC_COMMAND_SEQUENCE_SCHEMA_VERSION),
    kind: z.literal(DETERMINISTIC_COMMAND_SEQUENCE_KIND),
    control: z.literal(DETERMINISTIC_COMMAND_SEQUENCE_CONTROL),
    steps: z
      .array(DeterministicCommandStepSchema)
      .min(1)
      .max(DETERMINISTIC_COMMAND_SEQUENCE_LIMITS.maxSteps),
  })
  .strict()
  .superRefine((seq, ctx) => {
    let expectedParamIndex = 0;
    const seenParamNames = new Set<string>();

    for (let i = 0; i < seq.steps.length; i++) {
      const step = seq.steps[i];

      // Validate step id ordering
      const expectedStepId = `step${i}`;
      if (step.id !== expectedStepId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Step at index ${i} must have id '${expectedStepId}', got '${step.id}'`,
          path: ["steps", i, "id"],
        });
      }

      // Check step grammar
      validateStepGrammar(step, i, ctx);

      // Validate parameter ordering and uniqueness across all steps
      for (let j = 0; j < step.argv.length; j++) {
        const arg = step.argv[j];
        if ("parameter" in arg) {
          const expectedParamName = `arg${expectedParamIndex}`;
          if (seenParamNames.has(arg.parameter)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Duplicate parameter identifier '${arg.parameter}' in sequence. Each input identifier must be positional and unique.`,
              path: ["steps", i, "argv", j, "parameter"],
            });
          } else {
            seenParamNames.add(arg.parameter);
          }

          if (arg.parameter !== expectedParamName) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Positional parameter identifier mismatch at position ${expectedParamIndex}: expected '${expectedParamName}', got '${arg.parameter}'`,
              path: ["steps", i, "argv", j, "parameter"],
            });
          }
          expectedParamIndex++;
        }
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
 */
export function canonicalDeterministicCommandSequenceDigest(
  sequence: DeterministicCommandSequence,
  options?: { prefix?: boolean },
): string {
  const serialized = descriptorSafeCanonicalJsonStringify(sequence);
  if (!serialized) {
    throw new Error("Failed to canonically serialize DeterministicCommandSequence");
  }
  return hashCanonicalContent(JSON.parse(serialized), options);
}
