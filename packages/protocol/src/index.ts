/**
 * @resin/protocol
 *
 * Wire protocol, device authentication envelopes, OpenAPI schemas,
 * control streams, and mock fixtures for Resin.
 */

// Error Taxonomy & Error Classes
export * from "./errors.js";

// Protocol Message Envelope & Helpers
export * from "./envelope.js";

// Device Authentication & Token Lifecycle
export * from "./auth.js";
export * from "./tool-access.js";

// HTTP Endpoints, Data Models & OpenAPI 3.1 Specification
export * from "./http.js";

// Bidirectional Control Stream, Sequencing, Replay Buffer & Backoff
export * from "./stream.js";

// Deterministic Mock Protocol Server & Fixtures
export * from "./mock.js";

// Local-to-Cloud Protocol Client
export * from "./client.js";

// Project Registration & Wire Contracts
export * from "./projects.js";

// Console Wire Schemas, Activation History, Controls & Resolution
export * from "./console.js";

// Asynchronous Job Polling, Descriptors, Results & Tools
export * from "./jobs.js";

// Actionable Intervention Notifications & Cooldown State
export * from "./notifications.js";

// Revisioned Cloud Desired State & Device Reconciliation Reports
export * from "./control-plane.js";

// Backward Compatibility Helpers
export interface ProtocolMessage<T = unknown> {
  id: string;
  type: string;
  payload: T;
  timestamp: number;
}

export function createMessage<T>(type: string, payload: T): ProtocolMessage<T> {
  return {
    id: crypto.randomUUID(),
    type,
    payload,
    timestamp: Date.now(),
  };
}
