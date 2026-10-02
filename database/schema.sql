-- ============================================================
-- Incident Tracker schema
--
-- Written to run unchanged on both PostgreSQL and SQLite:
--   - ids are app-generated UUID strings (TEXT), so there's no
--     dialect-specific SERIAL/AUTOINCREMENT to reconcile
--   - CURRENT_TIMESTAMP and CHECK constraints work the same on both
--
-- Apply with: npm run db:migrate
-- ============================================================

CREATE TABLE IF NOT EXISTS teams (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('requester','agent','manager','admin')),
  team_id       TEXT REFERENCES teams(id),
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS categories (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

-- Priority SLAs: each priority level carries its own response/resolution
-- targets, in minutes, so the app can compute due dates and flag breaches
-- without hardcoding SLA numbers anywhere else.
CREATE TABLE IF NOT EXISTS priorities (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL UNIQUE,
  level               INTEGER NOT NULL,          -- 1 = highest priority
  sla_response_mins   INTEGER NOT NULL,          -- time to first response
  sla_resolution_mins INTEGER NOT NULL           -- time to resolution
);

CREATE TABLE IF NOT EXISTS incidents (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT,
  status       TEXT NOT NULL DEFAULT 'new'
               CHECK (status IN ('new','assigned','in_progress','on_hold','resolved','closed','cancelled')),
  reporter_id  TEXT NOT NULL REFERENCES users(id),
  assignee_id  TEXT REFERENCES users(id),
  team_id      TEXT REFERENCES teams(id),
  category_id  TEXT REFERENCES categories(id),
  priority_id  TEXT NOT NULL REFERENCES priorities(id),
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  assigned_at  TIMESTAMP,
  resolved_at  TIMESTAMP,
  closed_at    TIMESTAMP,
  due_at       TIMESTAMP                         -- created_at + priority's SLA, set by the app
);

CREATE INDEX IF NOT EXISTS idx_incidents_status   ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_incidents_assignee  ON incidents(assignee_id);
CREATE INDEX IF NOT EXISTS idx_incidents_priority  ON incidents(priority_id);
CREATE INDEX IF NOT EXISTS idx_incidents_team      ON incidents(team_id);

-- User assignments: full history of who an incident has been handed to,
-- not just the current holder sitting on incidents.assignee_id. Closing out
-- the previous row (unassigned_at) and inserting a new one on every
-- reassignment gives a complete "who worked this and when" trail.
CREATE TABLE IF NOT EXISTS incident_assignments (
  id            TEXT PRIMARY KEY,
  incident_id   TEXT NOT NULL REFERENCES incidents(id),
  assigned_to   TEXT NOT NULL REFERENCES users(id),
  assigned_by   TEXT REFERENCES users(id),        -- null = system/auto-assignment
  assigned_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  unassigned_at TIMESTAMP,                        -- null while still the current assignee
  reason        TEXT
);

CREATE INDEX IF NOT EXISTS idx_assignments_incident ON incident_assignments(incident_id);
CREATE INDEX IF NOT EXISTS idx_assignments_user     ON incident_assignments(assigned_to);

-- Status change logs: append-only history of every lifecycle transition,
-- separate from incident_assignments so "who's working it" and "what state
-- is it in" can each be queried and audited on their own.
CREATE TABLE IF NOT EXISTS incident_status_history (
  id          TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  from_status TEXT,                               -- null for the initial "new" row
  to_status   TEXT NOT NULL,
  changed_by  TEXT REFERENCES users(id),           -- null = system-triggered
  changed_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  note        TEXT
);

CREATE INDEX IF NOT EXISTS idx_status_history_incident ON incident_status_history(incident_id);
