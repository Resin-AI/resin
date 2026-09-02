-- Resin Local SQLite State Store Schema
-- Migration: 002_add_invocation_records_uploaded_at.sql

ALTER TABLE invocation_records ADD COLUMN uploaded_at TEXT;
CREATE INDEX IF NOT EXISTS idx_invocation_records_uploaded_at ON invocation_records(uploaded_at);
