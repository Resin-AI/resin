-- Resin Local SQLite State Store Schema
-- Migration: 003_add_invocation_records_usage_estimate.sql

ALTER TABLE invocation_records ADD COLUMN usage_estimate_json TEXT;
