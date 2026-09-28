import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const filterUrl = new URL("../dist/node-warning-filter.js", import.meta.url).href;

function runWithFilter(): string {
  const script = [
    `await import(${JSON.stringify(filterUrl)});`,
    `await import("node:sqlite");`,
    `process.emitWarning("unrelated deprecation", "DeprecationWarning");`,
    `process.emitWarning("unrelated experimental", "ExperimentalWarning");`,
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  return result.stderr;
}

describe("node-warning-filter", () => {
  it("hides only the node:sqlite ExperimentalWarning and still prints other warnings", () => {
    const stderr = runWithFilter();
    expect(stderr).not.toMatch(/SQLite is an experimental feature/);
    expect(stderr).toMatch(/\(node:\d+\) DeprecationWarning: unrelated deprecation/);
    expect(stderr).toMatch(/\(node:\d+\) ExperimentalWarning: unrelated experimental/);
  });
});
