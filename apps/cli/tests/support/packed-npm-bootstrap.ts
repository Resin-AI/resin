import { inject } from "vitest";

/** The npm bootstrap tarball packed once per run by packed-npm-bootstrap.global-setup.ts. */
export interface PackedNpmBootstrap {
  tarballPath: string;
  filename: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    packedNpmBootstrap: PackedNpmBootstrap;
  }
}

export function injectPackedNpmBootstrap(): PackedNpmBootstrap {
  const packed = inject("packedNpmBootstrap");
  if (!packed) {
    throw new Error(
      "The packed npm bootstrap was not provided; run this suite with --config vitest.packaged.config.ts",
    );
  }
  return packed;
}
