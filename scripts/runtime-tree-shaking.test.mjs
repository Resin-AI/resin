import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import * as esbuild from "esbuild";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const runtimeDirectory = path.join(root, "packages/runtime");

describe("runtime artifact-helper tree shaking", () => {
  it("retains bundle validation and archive helpers without compiler or sandbox startup", async () => {
    if (!fs.existsSync(path.join(runtimeDirectory, "dist/index.js"))) {
      throw new Error("Build first: pnpm --filter @resin/runtime... build");
    }
    const result = await esbuild.build({
      stdin: {
        contents: `
          import {
            buildToolBundle, computeSha256, BundleSignatureDataSchema,
            encodeDeterministicTar, parseTarArchive,
          } from '@resin/runtime';
          export { buildToolBundle, computeSha256, BundleSignatureDataSchema,
            encodeDeterministicTar, parseTarArchive };
          const tar = encodeDeterministicTar([{path: 'entry.ts', content: 'hello'}]);
          export const evidence = {
            hash: computeSha256(Buffer.from('hello')),
            content: parseTarArchive(tar.archive)[0].content.toString('utf8'),
            invalidSignatureAccepted: BundleSignatureDataSchema.safeParse({}).success,
          };
        `,
        resolveDir: runtimeDirectory,
        sourcefile: "artifact-consumer.js",
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      write: false,
      metafile: true,
    });
    const inputs = Object.values(result.metafile.outputs)
      .flatMap((output) => Object.entries(output.inputs))
      .filter(([, input]) => input.bytesInOutput > 0)
      .map(([name]) => name);
    expect(inputs.filter((name) => /typescript\/lib\/typescript\.js$/.test(name))).toEqual([]);
    expect(inputs.filter((name) => /runtime\/dist\/worker\/runner\.js$/.test(name))).toEqual([]);

    const loaded = { exports: {} };
    vm.runInNewContext(result.outputFiles[0].text, {
      module: loaded,
      exports: loaded.exports,
      require: createRequire(import.meta.url),
      Buffer,
    });
    expect(loaded.exports.evidence).toEqual({
      hash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      content: "hello",
      invalidSignatureAccepted: false,
    });
    expect(typeof loaded.exports.buildToolBundle).toBe("function");
  });
});
