// Migration 001 — initial schema.
//
// Tables:
//   schema_migrations    — applied migration ledger (owned by the runner)
//   save_checkpoints     — normalized SaveCheckpoint persistence (Phase C)
//   source_health_events — meaningful health transitions only (no per-poll spam)
//   sessions / builds / runs / run_heroes — foundations for future phases
//     (MemorySource, run lifecycle, build fingerprints); intentionally minimal.

import type { Migration } from './index'

const SQL = `
CREATE TABLE IF NOT EXISTS save_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checkpoint_key TEXT NOT NULL UNIQUE,
  observed_at_ms INTEGER NOT NULL,
  observed_time_source TEXT NOT NULL,
  file_mtime_ms INTEGER NOT NULL,
  polled_at_ms INTEGER NOT NULL,
  save_version TEXT,
  play_time_seconds REAL,
  current_stage_key INTEGER,
  current_stage_wave INTEGER,
  max_completed_stage INTEGER,
  wallet_gold REAL,
  combat_gold_earned REAL,
  stage_clears INTEGER,
  stage_fails INTEGER,
  arranged_party_json TEXT,
  hero_checkpoint_json TEXT,
  build_context_json TEXT,
  box_summary_json TEXT,
  persisted_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_save_checkpoints_observed_at
  ON save_checkpoints (observed_at_ms DESC);

CREATE TABLE IF NOT EXISTS source_health_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_kind TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  detail TEXT,
  last_success_at_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_source_health_events_source_time
  ON source_health_events (source_kind, recorded_at_ms DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  start_reason TEXT,
  end_reason TEXT,
  game_version TEXT,
  game_fingerprint TEXT,
  app_version TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_started_at
  ON sessions (started_at_ms DESC);

CREATE TABLE IF NOT EXISTS builds (
  id TEXT PRIMARY KEY,
  fingerprint_version INTEGER NOT NULL,
  canonical_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  friendly_label TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions (id) ON DELETE SET NULL,
  build_id TEXT REFERENCES builds (id) ON DELETE SET NULL,
  stage_key INTEGER NOT NULL,
  difficulty INTEGER,
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER NOT NULL,
  duration_ms REAL NOT NULL,
  official_clear_time_ms REAL,
  outcome TEXT NOT NULL,
  capture_quality TEXT NOT NULL,
  xp_value REAL,
  xp_source TEXT,
  xp_confidence TEXT,
  gold_value REAL,
  gold_source TEXT,
  gold_confidence TEXT,
  damage REAL,
  average_dps REAL,
  mobs_killed INTEGER,
  mobs_total INTEGER,
  game_version TEXT,
  game_fingerprint TEXT,
  source_health_epoch TEXT,
  reconciliation_status TEXT,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_stage_build ON runs (stage_key, build_id);
CREATE INDEX IF NOT EXISTS idx_runs_ended_at ON runs (ended_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs (session_id);
CREATE INDEX IF NOT EXISTS idx_runs_outcome ON runs (outcome);

CREATE TABLE IF NOT EXISTS run_heroes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  hero_key INTEGER NOT NULL,
  level_start INTEGER,
  level_end INTEGER,
  xp_gained REAL,
  slot INTEGER NOT NULL DEFAULT -1,
  UNIQUE (run_id, hero_key, slot)
);

CREATE INDEX IF NOT EXISTS idx_run_heroes_run ON run_heroes (run_id);
`

export const migration001: Migration = {
  version: 1,
  name: 'initial',
  up: (exec: (sql: string) => void) => {
    exec(SQL)
  },
}
