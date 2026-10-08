import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDerivationStdlib } from "./build-derivation-stdlib.mjs";

const OUTPUT = "packages/runtime/dist/workflow/python_stdlib.zip";
const temporaryDirectories = [];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A fake pinned pyodide whose module records that it ran and whose stdlib "compiles" to `drifted`. */
function fakePyodideModule(markerPath) {
  return `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(markerPath)}, "executed");
export async function loadPyodide() {
  return {
    runPython() {},
    FS: { readFile: () => new TextEncoder().encode("drifted") },
  };
}
`;
}

function createPinnedRoot() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-derivation-stdlib-"));
  temporaryDirectories.push(rootDir);
  const markerPath = path.join(rootDir, "pyodide-executed");
  const pyodideDir = path.join(rootDir, "packages/runtime/node_modules/pyodide");
  fs.mkdirSync(pyodideDir, { recursive: true });
  fs.mkdirSync(path.join(rootDir, "packages/runtime/src/workflow"), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, "packages/runtime/package.json"),
    JSON.stringify({ name: "runtime", dependencies: { pyodide: "1.2.3" } }),
  );
  const files = {
    "package.json": JSON.stringify({ name: "pyodide", version: "1.2.3" }),
    "pyodide.mjs": fakePyodideModule(markerPath),
    "python_stdlib.zip": "pinned stdlib",
  };
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(pyodideDir, name), content);
  }
  fs.writeFileSync(
    path.join(rootDir, "packages/runtime/src/workflow/derivation-assets.json"),
    JSON.stringify({
      sources: {
        "pyodide.mjs": sha256(files["pyodide.mjs"]),
        "python_stdlib.zip": sha256(files["python_stdlib.zip"]),
      },
      compiledStdlibSha256: sha256("expected compiled stdlib"),
    }),
  );
  return { rootDir, pyodideDir, markerPath };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("buildDerivationStdlib", () => {
  it("refuses an altered pinned source before executing Pyodide", async () => {
    const { rootDir, pyodideDir, markerPath } = createPinnedRoot();
    fs.appendFileSync(path.join(pyodideDir, "pyodide.mjs"), "// altered\n");

    await expect(buildDerivationStdlib({ rootDir })).rejects.toThrow(/pyodide\.mjs/);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(fs.existsSync(path.join(rootDir, OUTPUT))).toBe(false);
  });

  it("refuses a generated stdlib that does not match the expected digest", async () => {
    const { rootDir, markerPath } = createPinnedRoot();

    await expect(buildDerivationStdlib({ rootDir })).rejects.toThrow(/does not match expected/);
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.existsSync(path.join(rootDir, OUTPUT))).toBe(false);
  });
});
