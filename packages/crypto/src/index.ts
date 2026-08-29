import { createHash } from "node:crypto";

export function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

export const CRYPTO_VERSION = "0.1.0";

// Types & Interfaces
export * from "./types.js";

// Secret Redaction & Fingerprinting
export * from "./redaction.js";

// Encrypted Vault Secret Store
export * from "./vault.js";

// Keychain & Secret Service Integrations
export * from "./keychain.js";

// Secret Manager
export * from "./manager.js";
