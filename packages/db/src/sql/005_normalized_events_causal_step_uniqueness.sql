-- Resin Local SQLite State Store Schema
-- Migration: 005_normalized_events_causal_step_uniqueness.sql

-- Decoder fan-out emits siblings that share one source sequence but differ in
-- causalRef.stepIndex. The uniqueness key therefore gains the causal step;
-- rows without a step coalesce to 0 and keep their original guarantee.
-- json_valid guards rows with malformed payload_json so a corrupted state file
-- cannot abort the migration; those rows fail closed to step 0.
DROP INDEX IF EXISTS idx_normalized_events_session_sequence;
CREATE UNIQUE INDEX IF NOT EXISTS idx_normalized_events_session_sequence
  ON normalized_events(
    session_id,
    sequence,
    CASE
      WHEN json_valid(payload_json)
        THEN COALESCE(json_extract(payload_json, '$.causalRef.stepIndex'), 0)
      ELSE 0
    END
  );
