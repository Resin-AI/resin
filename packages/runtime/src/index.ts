import type { ToolSpec } from "@resin/contracts";
import { type ProtocolMessage, createMessage } from "@resin/protocol";

// Bundle Specification, Schemas & Types
export * from "./bundle/spec.js";

// Bundle Construction & Encoding
export * from "./bundle/builder.js";

// Bundle Cryptographic Signatures & Key Store
export * from "./bundle/signature.js";

// Production Readiness Safety Gate & Attestation Verification
export * from "./safety-gate/index.js";

// Candidate Verification, Type Checking, Probes & Evidence Records
export * from "./verifier/index.js";

// Bundle & Artifact Construction
export * from "./builder/index.js";

// Loader Security & Path Traversal Checks
export * from "./loader/security-checks.js";

// Content-Addressed Cache & Reference Tracking
export * from "./loader/cache.js";

// Quarantine Manager
export * from "./loader/quarantine.js";
export type { QuarantineRecord } from "./loader/quarantine.js";

// Cache Reconciliation
export * from "./loader/reconciliation.js";

// Retention & Garbage Collection
export * from "./loader/retention.js";

// Static Inspection API & CLI
export * from "./loader/inspector.js";

// Workflow Execution Engine, Compensation & Binding Resolution
export * from "./workflow/index.js";
// Tool Bundle Loader
export * from "./loader/loader.js";

// Worker Protocol, SDK, Process & Runner
export * from "./worker/index.js";

// Capability Policy Engine, Grants, Command Templates, Canonicalizers & Inspection
export * from "./policy/index.js";

// Capability Brokers (FS, Net, Command, Audit & SDK Clients)
export * from "./brokers/index.js";

// Effect Monitoring, Boundary Enforcement & Quarantining
export * from "./monitor/index.js";

// Runtime Trust Store, Offline Leases & High-Water Mark Anti-Rollback
export * from "./trust/index.js";

// Backward-compatible Runtime Engine Interface
export interface RuntimeEngine {
  isReady(): boolean;
  run(tool: ToolSpec): Promise<ProtocolMessage<{ toolId: string; status: string }>>;
}

export class DefaultRuntimeEngine implements RuntimeEngine {
  isReady(): boolean {
    return true;
  }

  async run(tool: ToolSpec): Promise<ProtocolMessage<{ toolId: string; status: string }>> {
    return createMessage("runtime:executed", { toolId: tool.id, status: "completed" });
  }
}
