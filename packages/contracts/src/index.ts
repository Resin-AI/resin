// Core Schema & Type Exports

// Common Primitives
export * from "./common.js";

// Canonical Serialization & Hashing
export * from "./canonical.js";

// Session Events
export * from "./events.js";

// Tools & Manifests
export * from "./tools.js";

// Capabilities & Envelopes
export * from "./capabilities.js";
// Secret References & Mediation
export * from "./secrets.js";

// Tool Versions & Artifacts
export * from "./versions.js";

// Deployments & State Machine
export * from "./deployments.js";

// Workspace, Device, Invocation & Telemetry Records
export * from "./records.js";

// Production Safety Gate & Attestations
export * from "./safety-gate.js";

// Creation-Time Qualification Contracts & Artifact Bundles
export * from "./qualification.js";

// V1 Canonical Contracts & Schemas
export * from "./v1.js";

// Legacy compatibility types and constants
export interface ToolSpec {
  id: string;
  name: string;
  version: string;
  description: string;
}

export const CONTRACTS_VERSION = "1.0.0";
