import { describe, expect, it } from "vitest";
import { validToolVersion } from "../fixtures/index.js";
import {
  BundleReferenceSchema,
  ProvenanceMetadataSchema,
  SignatureMetadataSchema,
  ToolArtifactSchema,
  ToolVersionSchema,
  ToolVersionStatusSchema,
} from "../src/versions.js";

describe("versions contracts", () => {
  describe("BundleReferenceSchema & ToolArtifactSchema", () => {
    it("parses valid bundle reference", () => {
      const bundle = BundleReferenceSchema.parse({
        uri: "file:///workspace/bundle.js",
        hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        sizeBytes: 1024,
        format: "js_bundle",
      });
      expect(bundle.format).toBe("js_bundle");
      expect(bundle.sizeBytes).toBe(1024);
    });

    it("rejects unsupported bundle format", () => {
      expect(() =>
        BundleReferenceSchema.parse({
          uri: "file:///workspace/bundle.bin",
          hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          sizeBytes: 1024,
          format: "unsupported_format",
        }),
      ).toThrow();
    });

    it("parses valid tool artifact", () => {
      const artifact = ToolArtifactSchema.parse({
        artifactDigest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        bundleReference: {
          uri: "file:///workspace/bundle.js",
          hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          sizeBytes: 2048,
          format: "js_bundle",
        },
        entrypoint: "run",
      });
      expect(artifact.entrypoint).toBe("run");
    });
  });

  describe("ProvenanceMetadataSchema & SignatureMetadataSchema", () => {
    it("parses provenance metadata", () => {
      const provenance = ProvenanceMetadataSchema.parse({
        synthesizedAt: "2026-08-17T12:00:00.000Z",
        synthesizerModel: "claude-3-7-sonnet",
        deterministicBuildHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      });
      expect(provenance.synthesizerModel).toBe("claude-3-7-sonnet");
    });

    it("parses signature metadata with valid algorithm", () => {
      const sig = SignatureMetadataSchema.parse({
        signature: "sig_bytes_123",
        keyId: "key_01",
        algorithm: "ed25519",
        signedAt: "2026-08-17T12:00:00.000Z",
      });
      expect(sig.algorithm).toBe("ed25519");
    });

    it("rejects invalid signature algorithm", () => {
      expect(() =>
        SignatureMetadataSchema.parse({
          signature: "sig_bytes_123",
          keyId: "key_01",
          algorithm: "md5_rsa",
          signedAt: "2026-08-17T12:00:00.000Z",
        }),
      ).toThrow();
    });
  });

  describe("ToolVersionSchema", () => {
    it("parses valid tool version fixture", () => {
      const parsed = ToolVersionSchema.parse(validToolVersion);
      expect(parsed.toolId).toBe("fast_ast_grep");
      expect(parsed.version).toBe("1.0.0");
      expect(parsed.status).toBe("active");
    });

    it("validates tool version status enum", () => {
      expect(ToolVersionStatusSchema.parse("draft")).toBe("draft");
      expect(ToolVersionStatusSchema.parse("active")).toBe("active");
      expect(ToolVersionStatusSchema.parse("deprecated")).toBe("deprecated");
      expect(ToolVersionStatusSchema.parse("revoked")).toBe("revoked");
      expect(() => ToolVersionStatusSchema.parse("deleted")).toThrow();
    });

    it("accepts valid supersededBy semantic version string or null", () => {
      const withSuperseded = ToolVersionSchema.parse({
        ...validToolVersion,
        supersededBy: "1.1.0",
      });
      expect(withSuperseded.supersededBy).toBe("1.1.0");

      const withNullSuperseded = ToolVersionSchema.parse({
        ...validToolVersion,
        supersededBy: null,
      });
      expect(withNullSuperseded.supersededBy).toBeNull();
    });

    it("rejects invalid supersededBy version strings", () => {
      expect(() =>
        ToolVersionSchema.parse({
          ...validToolVersion,
          supersededBy: "invalid-semver",
        }),
      ).toThrow();
    });
  });
});
