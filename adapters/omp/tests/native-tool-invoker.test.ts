import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { invokeOmpNativeTool } from "../src/native-tool-invoker.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("OMP native tool invocation", () => {
  it("uses the harness write and read implementations with exact text", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "resin-omp-native-"));
    roots.push(cwd);

    await invokeOmpNativeTool({
      name: "write",
      cwd,
      parameters: { path: "out/release-note.txt", content: "  exact output\n" },
    });
    const read = await invokeOmpNativeTool({
      name: "read",
      cwd,
      parameters: { path: "out/release-note.txt:raw" },
    });

    expect(await readFile(join(cwd, "out/release-note.txt"), "utf8")).toBe("  exact output\n");
    expect(read.content).toEqual([{ type: "text", text: "  exact output\n" }]);
  });

  it("refuses unknown names instead of routing them elsewhere", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "resin-omp-native-"));
    roots.push(cwd);
    await expect(
      invokeOmpNativeTool({ name: "not_a_builtin", cwd, parameters: {} }),
    ).rejects.toThrow(/not available in the installed harness SDK/);
  });
});
