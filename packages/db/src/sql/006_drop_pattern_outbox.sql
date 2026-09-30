-- Resin Local SQLite State Store Schema
-- Migration: 006_drop_pattern_outbox.sql

-- Migration 004 created pattern_outbox as a local queue for proven patterns awaiting
-- upload, but nothing ever read it: the opportunity tracker wrote one row per dispatch and
-- no uploader consumed them. Dropping the table also drops its three indexes.
DROP TABLE IF EXISTS pattern_outbox;
