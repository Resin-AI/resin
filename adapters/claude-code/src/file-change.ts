import { z } from "zod";

/** One file a completed Claude Code `Edit` or `Write` changed, as a self-describing unified diff. */
export interface ClaudeFileEdit {
  filePath: string;
  operation: "create" | "update";
  patch: string;
}

const HunkSchema = z
  .object({
    oldStart: z.number().int().nonnegative(),
    oldLines: z.number().int().nonnegative(),
    newStart: z.number().int().nonnegative(),
    newLines: z.number().int().nonnegative(),
    lines: z.array(z.string()),
  })
  .strict();

/**
 * The `toolUseResult` shapes Claude Code 2.1.283 records for a successful edit:
 * `Edit` (`oldString`/`newString` with the hunks it applied) and `Write` (`type` create or update).
 * A `Write` update keeps its hunks but blanks `content`/`originalFile` in storage.
 */
const EditResultSchema = z.object({
  filePath: z.string().min(1),
  oldString: z.string(),
  newString: z.string(),
  structuredPatch: z.array(HunkSchema).min(1),
});
const WriteCreateSchema = z.object({
  type: z.literal("create"),
  filePath: z.string().min(1),
  content: z.string(),
  structuredPatch: z.array(HunkSchema).length(0),
});
const WriteUpdateSchema = z.object({
  type: z.literal("update"),
  filePath: z.string().min(1),
  structuredPatch: z.array(HunkSchema).min(1),
});

function hunksPatch(filePath: string, hunks: z.infer<typeof HunkSchema>[]): string | undefined {
  let body = "";
  for (const hunk of hunks) {
    let before = 0;
    let after = 0;
    for (const line of hunk.lines) {
      // "\ No newline at end of file" and anything unprefixed cannot be restated exactly.
      if (/[\r\n]/u.test(line)) return undefined;
      const prefix = line[0];
      if (prefix === " ") {
        before += 1;
        after += 1;
      } else if (prefix === "-") before += 1;
      else if (prefix === "+") after += 1;
      else return undefined;
    }
    if (before !== hunk.oldLines || after !== hunk.newLines) return undefined;
    body += `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`;
    body += hunk.lines.map((line) => `${line}\n`).join("");
  }
  return `--- ${filePath}\n+++ ${filePath}\n${body}`;
}

/**
 * The edit a Claude `Edit`/`Write` tool result records, or undefined for any shape this decoder has
 * not seen or cannot restate exactly (a failed call, a file without a final newline, CRLF). Nothing
 * is guessed: the patch is built only from what Claude recorded it applied.
 */
export function claudeFileEdit(toolUseResult: unknown): ClaudeFileEdit | undefined {
  const edited = EditResultSchema.safeParse(toolUseResult);
  const updated = edited.success ? edited : WriteUpdateSchema.safeParse(toolUseResult);
  if (updated.success) {
    const { filePath, structuredPatch } = updated.data;
    if (/[\r\n]/u.test(filePath)) return undefined;
    const patch = hunksPatch(filePath, structuredPatch);
    return patch === undefined ? undefined : { filePath, operation: "update", patch };
  }
  const created = WriteCreateSchema.safeParse(toolUseResult);
  if (!created.success) return undefined;
  const { filePath, content } = created.data;
  if (/[\r\n]/u.test(filePath)) return undefined;
  // Whole-file content without a final newline needs a marker this format does not carry.
  if ((content.length > 0 && !content.endsWith("\n")) || content.includes("\r")) return undefined;
  const lines = content.length === 0 ? [] : content.slice(0, -1).split("\n");
  const first = lines.length === 0 ? 0 : 1;
  return {
    filePath,
    operation: "create",
    patch: `--- /dev/null\n+++ ${filePath}\n@@ -0,0 +${first},${lines.length} @@\n${lines
      .map((line) => `+${line}\n`)
      .join("")}`,
  };
}
