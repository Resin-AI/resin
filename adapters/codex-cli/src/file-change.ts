import { z } from "zod";

/** One file a completed Codex `FileChange` item edited, as a self-describing unified diff. */
export interface CodexFileEdit {
  filePath: string;
  operation: "create" | "update" | "delete";
  patch: string;
}

/** The only change shapes observed in Codex 0.156 rollouts; a rename (`move_path`) is refused. */
const ChangeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("update"), unified_diff: z.string(), move_path: z.null() }).strict(),
  z.object({ type: z.literal("add"), content: z.string() }).strict(),
  z.object({ type: z.literal("delete"), content: z.string() }).strict(),
]);
const FileChangeItemSchema = z.object({
  type: z.literal("FileChange"),
  status: z.literal("completed"),
  changes: z.record(z.string(), ChangeSchema),
});

/**
 * The edits a completed native `FileChange` item made, one per changed path, or undefined for any
 * shape this decoder has not seen: a rename, extra fields, an unfinished item, or content that a
 * unified diff cannot restate exactly. Nothing is guessed.
 */
export function codexFileEdits(item: unknown): CodexFileEdit[] | undefined {
  const parsed = FileChangeItemSchema.safeParse(item);
  if (!parsed.success) return undefined;
  const entries = Object.entries(parsed.data.changes);
  if (entries.length === 0) return undefined;
  const edits: CodexFileEdit[] = [];
  for (const [filePath, change] of entries) {
    if (filePath.length === 0 || /[\r\n]/u.test(filePath)) return undefined;
    if (change.type === "update") {
      const diff = change.unified_diff;
      if (!diff.startsWith("@@") || !diff.endsWith("\n")) return undefined;
      edits.push({
        filePath,
        operation: "update",
        patch: `--- ${filePath}\n+++ ${filePath}\n${diff}`,
      });
      continue;
    }
    // Whole-file content without a final newline needs a marker this format does not carry.
    const content = change.content;
    if ((content.length > 0 && !content.endsWith("\n")) || content.includes("\r")) {
      return undefined;
    }
    const add = change.type === "add";
    const lines = content.length === 0 ? [] : content.slice(0, -1).split("\n");
    const count = lines.length;
    const first = count === 0 ? 0 : 1;
    const header = add
      ? `--- /dev/null\n+++ ${filePath}\n@@ -0,0 +${first},${count} @@\n`
      : `--- ${filePath}\n+++ /dev/null\n@@ -${first},${count} +0,0 @@\n`;
    const prefix = add ? "+" : "-";
    edits.push({
      filePath,
      operation: add ? "create" : "delete",
      patch: header + lines.map((line) => `${prefix}${line}\n`).join(""),
    });
  }
  return edits;
}
