/**
 * The derivation sandbox: Python in Pyodide inside Deno sees only its inputs. Allowed modules work; refused imports and host reads fail the step.
 */
import { afterEach, describe, expect, it } from "vitest";
import { HOST, LOOKUP, js, removeDirectories, runDerivation } from "./derivation-fixtures.js";

afterEach(removeDirectories);

describe("the derivation sandbox", { timeout: 60_000 }, () => {
  it("computes the JSON object from the inputs with the allowed modules", async () => {
    const body = [
      "import statistics, datetime, re",
      "from collections import Counter",
      'name = inputs["merchant"]',
      '{"letters": Counter(name.lower())["n"], "mean": statistics.mean([1, 2, 6]), "day": datetime.date(2024, 1, 31).isoformat(), "parts": re.split("_", name)}',
      "",
    ].join("\n");
    const { step } = await runDerivation(body);
    expect(step).toMatchObject({
      status: "completed",
      result: { letters: 2, mean: 3, day: "2024-01-31", parts: ["Crossfit", "Hanna"] },
    });
  });

  const refused: Array<[string, string]> = [
    ["import os", "import os\n"],
    ["import subprocess", "import subprocess\n"],
    ["import socket", "import socket\n"],
    ["import js", "import js\n"],
    ["__import__('os')", "__import__('os')\n"],
    ["reading /proc/self/environ", 'open("/proc/self/environ").read()\n'],
    ["reading env through the host", `${HOST}${js('Deno.env.get("HOME")')}`],
    ["reading a host file through the host", `${HOST}${js('Deno.readTextFileSync("/etc/hosts")')}`],
  ];
  for (const [name, attempt] of refused) {
    it(`fails a derivation that attempts ${name}`, async () => {
      const { step } = await runDerivation(`${attempt}${LOOKUP}`);
      expect(step.status).toBe("failed");
    });
  }

  it("fails a derivation that swallows a refused import", async () => {
    const { step } = await runDerivation(
      `try:\n    import os\nexcept BaseException:\n    pass\n${LOOKUP}`,
    );
    expect(step.status).toBe("failed");
  });
});
