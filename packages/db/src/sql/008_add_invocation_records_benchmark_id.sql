-- Resin Local SQLite State Store Schema
-- Migration: 008_add_invocation_records_benchmark_id.sql

-- The benchmark run an invocation was recorded for; NULL for ordinary use.
ALTER TABLE invocation_records ADD COLUMN benchmark_id TEXT;
