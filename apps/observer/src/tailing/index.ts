// Transcript Tailing, Checkpointing, and Source Recovery Module

// Deduplication
export * from "./deduplicator.js";

// Atomic SQLite Checkpoint Management
export * from "./cursor-manager.js";

// Per-Source Bounded Queue & Dead-Letter Classification
export * from "./queue.js";

// Source Recovery Engine & Inode / Rotation / Truncation Tracking
export * from "./recovery.js";

// Transcript Watcher & Partial Line Buffering
export * from "./watcher.js";

// Transcript Tailer & Active Event Source Coordination
export * from "./tailer.js";

// Observer Coordinator & Workspace / Session Supervision
export * from "./coordinator.js";
