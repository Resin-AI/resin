/**
 * @resin/gateway
 *
 * Local Model Context Protocol (MCP) Gateway and Connection Lifecycle Service.
 */

// Protocol Types, Errors & Framing
export * from "./protocol/index.js";

// Gateway Router
export * from "./router.js";

// Dynamic Tool Registry & Atomic Catalog Snapshots
export * from "./registry/index.js";

// System Meta-Tools & Invariant Tool Discovery / Invocation
export * from "./meta/index.js";

// Project Bootstrap, Metadata Lifecycle & Version-Locked Tools
export * from "./project/types.js";
export * from "./project/project-bootstrap.js";
export * from "./project/project-lock.js";
export * from "./project/lock-manager.js";

// Workspace Context & Symlink-Aware Resolution
export * from "./workspace-resolver.js";

// Connection State, Rate Limiting & Lifecycle
export * from "./connection.js";

// Local MCP Gateway Server
export * from "./gateway.js";

// Stdio Shim & Standalone Process Execution
export * from "./shim/stdio-bridge.js";

// Proxy & Registration
export * from "./proxy/index.js";

// Dynamic Refresh Coordinator & Nudge System
export * from "./refresh/index.js";

export interface GatewayService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createGateway(): GatewayService {
  let isRunning = false;
  return {
    async start() {
      isRunning = true;
    },
    async stop() {
      isRunning = false;
    },
  };
}

export const createGatewayService = createGateway;
