import type { ProtocolMessage } from "@resin/protocol";

// Paths & Environment Resolution
export * from "./paths.js";
// Actionable Notification State & Observer Projection
export * from "./notifications.js";

// Lockfile & Single-Instance Mechanics
export * from "./lock.js";

// Validated Configuration & Redaction
export * from "./config.js";

// Module Lifecycle, DAG Dependency Ordering & Timeouts
export * from "./lifecycle.js";

// Supervisor & Signal Handling
export * from "./supervisor.js";

// Internal IPC Protocol, Framing, Transports, Server & Client
export * from "./ipc/protocol.js";
export * from "./ipc/framing.js";
export * from "./ipc/transport.js";
export * from "./ipc/server.js";
export * from "./ipc/client.js";

// Worker Process Supervision & Isolation
export * from "./worker-supervisor.js";

// Transcript Tailing, Checkpointing, and Source Recovery
export * from "./tailing/index.js";

// Transcript Normalization, Deduplication, Privacy Redaction & Re-normalization
export * from "./normalization/index.js";

// Local Observability, Audit Trail, Kill Switches, Health & Recovery
export * from "./observability/index.js";

// Deployment Synchronization & Transactional Local Activation
export * from "./sync/index.js";

// Canonical Cloud Credentials & Storage Boundary
export * from "./cloud-credentials.js";

// Production Cloud Runtime & Observation Client
export * from "./cloud-runtime.js";

// Cloud Desired-State Reconciliation & Applied-State Reporting
export * from "./control-plane.js";

// Asynchronous Cloud Job Client & Artifact Download
export * from "./cloud-job-client.js";

// Outer Trajectory Observation & Attribution Analytics
export * from "./analytics/index.js";

// Trajectory Capture Daemon Module & Attribution
export * from "./trajectory-capture-module.js";
// Backward Compatibility Observer Service
export interface ObserverService {
  recordEvent(message: ProtocolMessage): void;
  getEventCount(): number;
}

export function createObserver(): ObserverService {
  const events: ProtocolMessage[] = [];
  return {
    recordEvent(msg) {
      events.push(msg);
    },
    getEventCount() {
      return events.length;
    },
  };
}
