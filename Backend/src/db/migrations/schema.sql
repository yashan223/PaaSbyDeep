-- PaaSbyDeep Database Schema (PostgreSQL / Neon DB)

-- Users table (admin accounts)
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT   UNIQUE NOT NULL,
  password_hash TEXT   NOT NULL,
  role          TEXT   DEFAULT 'admin',
  is_active     BOOLEAN DEFAULT TRUE,
  token_version INTEGER DEFAULT 1,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'admin';
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- Applications table (deployed services)
CREATE TABLE IF NOT EXISTS applications (
  id              SERIAL PRIMARY KEY,
  name            TEXT    UNIQUE NOT NULL,
  repo_url        TEXT    NOT NULL,
  branch          TEXT    DEFAULT 'main',
  dockerfile_path TEXT    DEFAULT 'Dockerfile',
  port            INTEGER NOT NULL,
  env_vars        JSONB   DEFAULT '{}',
  github_token    TEXT,
  project_type    TEXT    DEFAULT 'auto',
  status          TEXT    DEFAULT 'stopped', -- stopped | running | deploying | error
  container_id    TEXT,
  image_name      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Ensure optional columns exist on existing deployments of schema
ALTER TABLE applications ADD COLUMN IF NOT EXISTS github_token TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS project_type TEXT DEFAULT 'auto';
ALTER TABLE applications ADD COLUMN IF NOT EXISTS memory_limit_mb INTEGER;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS cpu_limit NUMERIC;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS health_check_path TEXT DEFAULT '';
ALTER TABLE applications ADD COLUMN IF NOT EXISTS volumes JSONB DEFAULT '[]';
ALTER TABLE applications ADD COLUMN IF NOT EXISTS health_status TEXT DEFAULT 'unknown';
ALTER TABLE applications ADD COLUMN IF NOT EXISTS last_health_check TIMESTAMPTZ;

-- Deployments table (deployment history per application)
CREATE TABLE IF NOT EXISTS deployments (
  id               SERIAL PRIMARY KEY,
  app_id           INTEGER     NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  status           TEXT        NOT NULL,          -- pending | running | success | failed
  commit_sha       TEXT,
  triggered_by     TEXT        DEFAULT 'manual',  -- manual | webhook | rollback
  image_tag        TEXT,
  rollback_from_id INTEGER,
  logs             TEXT        DEFAULT '',
  started_at       TIMESTAMPTZ DEFAULT NOW(),
  finished_at      TIMESTAMPTZ
);

ALTER TABLE deployments ADD COLUMN IF NOT EXISTS image_tag TEXT;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS rollback_from_id INTEGER;

-- Connected GitHub accounts (OAuth or Personal Access Token)
CREATE TABLE IF NOT EXISTS github_connections (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER     UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  github_id       BIGINT,
  github_username TEXT        NOT NULL,
  avatar_url      TEXT,
  profile_url     TEXT,
  access_token    TEXT        NOT NULL,
  auth_type       TEXT        DEFAULT 'pat',  -- pat | oauth
  connected_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Custom domains and Certbot SSL certificates per application or MinIO service
CREATE TABLE IF NOT EXISTS domains (
  id               SERIAL PRIMARY KEY,
  app_id           INTEGER     REFERENCES applications(id) ON DELETE CASCADE,
  service_id       INTEGER     REFERENCES managed_services(id) ON DELETE CASCADE,
  service_target   TEXT        DEFAULT 'app', -- app | s3 | console
  domain           TEXT        UNIQUE NOT NULL,
  ssl_enabled      BOOLEAN     DEFAULT FALSE,
  ssl_status       TEXT        DEFAULT 'none', -- none | pending | active | failed
  cert_expires_at  TIMESTAMPTZ,
  last_cert_error  TEXT,
  last_cert_log    TEXT,
  nginx_configured BOOLEAN     DEFAULT FALSE,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE domains ALTER COLUMN app_id DROP NOT NULL;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS service_target TEXT DEFAULT 'app';

-- Dashboard and platform configuration (singleton row id = 1)
CREATE TABLE IF NOT EXISTS platform_settings (
  id                       INTEGER     PRIMARY KEY DEFAULT 1,
  platform_name            TEXT        DEFAULT 'PaaSbyDeep',
  public_url               TEXT        DEFAULT '',
  dashboard_domain         TEXT        DEFAULT '',
  dashboard_ssl_enabled    BOOLEAN     DEFAULT FALSE,
  dashboard_ssl_expires    TIMESTAMPTZ,
  certbot_email            TEXT        DEFAULT '',
  default_memory_mb        INTEGER     DEFAULT 512,
  max_deployments_retain   INTEGER     DEFAULT 20,
  notification_webhook_url TEXT        DEFAULT '',
  notification_events      JSONB       DEFAULT '{"deploy_success":true,"deploy_failed":true,"app_unhealthy":true}',
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS notification_webhook_url TEXT DEFAULT '';
ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS notification_events JSONB DEFAULT '{"deploy_success":true,"deploy_failed":true,"app_unhealthy":true}';

-- One-click managed databases / stateful services
CREATE TABLE IF NOT EXISTS managed_services (
  id              SERIAL PRIMARY KEY,
  name            TEXT UNIQUE NOT NULL,
  service_type    TEXT NOT NULL,
  version         TEXT NOT NULL,
  port            INTEGER NOT NULL,
  console_port    INTEGER,
  username        TEXT DEFAULT '',
  password        TEXT NOT NULL,
  database_name   TEXT DEFAULT '',
  volume_name     TEXT NOT NULL,
  container_id    TEXT,
  status          TEXT DEFAULT 'stopped',
  last_error      TEXT DEFAULT '',
  public_access   BOOLEAN DEFAULT FALSE,
  memory_limit_mb INTEGER DEFAULT 512,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE managed_services ADD COLUMN IF NOT EXISTS console_port INTEGER;
ALTER TABLE managed_services ADD COLUMN IF NOT EXISTS last_error TEXT DEFAULT '';
ALTER TABLE managed_services ADD COLUMN IF NOT EXISTS public_access BOOLEAN DEFAULT FALSE;
ALTER TABLE domains ADD COLUMN IF NOT EXISTS service_id INTEGER REFERENCES managed_services(id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS storage_buckets (
  id          SERIAL PRIMARY KEY,
  service_id  INTEGER NOT NULL REFERENCES managed_services(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  public_read BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (service_id, name)
);

-- Security and operational audit trail
CREATE TABLE IF NOT EXISTS audit_logs (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username    TEXT NOT NULL DEFAULT 'system',
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT,
  target_name TEXT,
  details     JSONB DEFAULT '{}',
  ip_address  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at DESC);
