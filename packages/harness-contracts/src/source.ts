import type { RawHarnessRecord, SourceCursor } from "./types.js";

/**
 * Callback invoked when new raw records are observed from a harness session.
 */
export type RecordListener = (records: RawHarnessRecord[]) => void | Promise<void>;

/**
 * Event source interface for reading, streaming, and checkpointing raw records
 * from a harness transcript or session stream.
 */
export interface SessionEventSource {
  /**
   * Pulls the next batch of raw harness records from the current cursor position.
   *
   * @param batchSize Optional maximum number of records to return. Defaults to adapter default.
   * @returns Array of newly observed records, or empty array if no new records are available.
   */
  readNext(batchSize?: number): Promise<RawHarnessRecord[]>;

  /**
   * Registers a push callback for real-time streaming of new records.
   *
   * @param callback Function called whenever new records are emitted.
   * @returns Unsubscribe function to detach the listener.
   */
  onRecords(callback: RecordListener): () => void;

  /**
   * Commits a progress checkpoint. The event source will resume from after this cursor
   * on subsequent reads or reconnects.
   *
   * @param cursor The checkpoint cursor to commit.
   */
  checkpoint(cursor: SourceCursor): Promise<void>;

  /**
   * Returns the current cursor position of the event source, if known.
   */
  getCursor(): SourceCursor | null;

  /**
   * Probes whether the underlying transcript or log file has been rotated, truncated,
   * or replaced since the last read / checkpoint.
   *
   * @returns True if file rotation or truncation was detected; false otherwise.
   */
  detectRotation(): Promise<boolean>;

  /**
   * Closes the event source and cleans up any open file handles, watchers, or listeners.
   */
  close(): Promise<void>;
}
