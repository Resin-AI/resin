import { z } from "zod";

/**
 * Normalization-scrubbed text of a recorded command. It lets naming describe what a learned tool
 * runs; the exact command stays local and is the only form that executes.
 */
export const RESIN_COMMAND_TEXT_METADATA_KEY = "resinCommandTextV1" as const;
export const RESIN_COMMAND_TEXT_MAX_CHARS = 2000;

const CommandTextMetadataSchema = z
  .object({
    version: z.literal(1),
    text: z.string().min(1).max(RESIN_COMMAND_TEXT_MAX_CHARS),
    truncated: z.boolean(),
  })
  .strict();
export type CommandTextMetadata = z.infer<typeof CommandTextMetadataSchema>;

const SHELL_LAUNCHERS: Readonly<Record<string, true>> = {
  bash: true,
  sh: true,
  zsh: true,
  dash: true,
};

/** The script a `bash -c`/`bash -lc` style launcher ran, or undefined for other commands. */
export function shellScriptOf(command: string, args: readonly string[]): string | undefined {
  const launcher = command.slice(command.lastIndexOf("/") + 1);
  return SHELL_LAUNCHERS[launcher] === true &&
    args.length === 2 &&
    (args[0] === "-c" || args[0] === "-lc")
    ? args[1]
    : undefined;
}

/** The command line a command event ran, unwrapping a shell launcher. */
export function commandLineOf(command: string, args: readonly string[]): string {
  return (
    shellScriptOf(command, args) ?? (args.length === 0 ? command : `${command} ${args.join(" ")}`)
  );
}
/** Bounded command text for metadata, or undefined when there is nothing to describe. */
export function commandTextMetadata(text: string): CommandTextMetadata | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  return {
    version: 1,
    text: trimmed.slice(0, RESIN_COMMAND_TEXT_MAX_CHARS),
    truncated: trimmed.length > RESIN_COMMAND_TEXT_MAX_CHARS,
  };
}

/** Reject malformed or oversized text rather than trusting an unvalidated metadata field. */
export function readCommandTextMetadata(value: unknown): CommandTextMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const parsed = CommandTextMetadataSchema.safeParse(
    (value as Record<string, unknown>)[RESIN_COMMAND_TEXT_METADATA_KEY],
  );
  return parsed.success ? parsed.data : undefined;
}
