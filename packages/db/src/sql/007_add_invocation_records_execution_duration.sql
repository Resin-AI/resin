-- Resin Local SQLite State Store Schema
-- Migration: 007_add_invocation_records_execution_duration.sql

-- Wall-clock ms the tool's recorded calls spent running; NULL when not measured.
ALTER TABLE invocation_records ADD COLUMN execution_duration_ms INTEGER;
