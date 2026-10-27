-- VibeForge production schema (Postgres). Embedded mode uses data/db.json;
-- set DATABASE_URL to run against this schema (see docker-compose.yml).
CREATE EXTENSION IF NOT EXISTS citext;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email CITEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL, is_platform_admin BOOLEAN NOT NULL DEFAULT FALSE,
  mfa_secret TEXT, mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE, oidc_subject TEXT,
  is_blocked BOOLEAN NOT NULL DEFAULT FALSE, blocked_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS group_members (group_id TEXT REFERENCES groups(id), user_id TEXT REFERENCES users(id), PRIMARY KEY (group_id, user_id));
CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, created_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS space_members (
  space_id TEXT REFERENCES spaces(id), principal_kind TEXT NOT NULL, principal_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','coder','reader')), PRIMARY KEY (space_id, principal_kind, principal_id));
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, space_id TEXT REFERENCES spaces(id), slug TEXT NOT NULL, name TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'space', UNIQUE (space_id, slug));
CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), seq_no INT NOT NULL,
  label TEXT NOT NULL, parent_milestone_id TEXT, blob_key TEXT NOT NULL,
  manifest JSONB NOT NULL, scan_status TEXT NOT NULL, languages TEXT[] NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (project_id, seq_no));
CREATE TABLE IF NOT EXISTS files (milestone_id TEXT REFERENCES milestones(id), path TEXT NOT NULL, blob_key TEXT NOT NULL, size_bytes BIGINT NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY (milestone_id, path));
CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY, milestone_id TEXT REFERENCES milestones(id), kind TEXT NOT NULL, severity TEXT NOT NULL,
  plain_title TEXT NOT NULL, plain_explain TEXT NOT NULL, fix_text TEXT NOT NULL,
  file_path TEXT, line_no INT, cve_id TEXT, package TEXT, current_version TEXT, fixed_version TEXT,
  cvss_score DOUBLE PRECISION, cvss_vector TEXT, status TEXT NOT NULL DEFAULT 'open');
CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY, milestone_id TEXT REFERENCES milestones(id), body TEXT NOT NULL, done BOOLEAN NOT NULL DEFAULT FALSE, source TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), name TEXT NOT NULL, prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL, scopes TEXT[] NOT NULL, last_used_at TIMESTAMPTZ, expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS refresh_tokens (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), token_hash TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS password_resets (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), token_hash TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, outcome TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_findings_open ON findings (status, severity);
CREATE INDEX IF NOT EXISTS idx_milestones_project ON milestones (project_id, seq_no);
