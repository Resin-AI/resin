// Core Types & Schemas
export * from "./types.js";

// Harness Adapter Interface
export * from "./adapter.js";

// Session Event Source Interface
export * from "./source.js";

// Configuration Mutation Planning & Atomic Rollback
export * from "./config.js";

// Catalog Refresh Outcomes & Handlers
export * from "./refresh.js";

// Observation Fidelity Descriptors & Presets
export * from "./fidelity.js";

// Error Taxonomy
export * from "./errors.js";

// Record Decoders & Intermediate Session Events
export * from "./decoder.js";

export const HARNESS_CONTRACTS_VERSION = "0.1.0";

// Harness Definitions (registry entries) & Version Classification
export * from "./definition.js";

// Managed instruction-file blocks
export * from "./managed-block.js";

// Host facts for harness probes: home, PATH/PATHEXT lookup, Windows batch launchers.
export * from "./host.js";
