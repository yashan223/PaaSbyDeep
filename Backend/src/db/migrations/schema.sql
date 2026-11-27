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

-- Deployments table (deployment history per application)
CREATE TABLE IF NOT EXISTS deployments (
  id           SERIAL PRIMARY KEY,
  app_id       INTEGER     NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  status       TEXT        NOT NULL,          -- pending | running | success | failed
  commit_sha   TEXT,
  triggered_by TEXT        DEFAULT 'manual',  -- manual | webhook
  logs         TEXT        DEFAULT '',
  started_at   TIMESTAMPTZ DEFAULT NOW(),
  finished_at  TIMESTAMPTZ
);

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

-- Custom domains and Certbot SSL certificates per application
CREATE TABLE IF NOT EXISTS domains (
  id               SERIAL PRIMARY KEY,
  app_id           INTEGER     NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
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

-- Dashboard and platform configuration (singleton row id = 1)
CREATE TABLE IF NOT EXISTS platform_settings (
  id                     INTEGER     PRIMARY KEY DEFAULT 1,
  platform_name          TEXT        DEFAULT 'PaaSbyDeep',
  public_url             TEXT        DEFAULT '',
  dashboard_domain       TEXT        DEFAULT '',
  dashboard_ssl_enabled  BOOLEAN     DEFAULT FALSE,
  dashboard_ssl_expires  TIMESTAMPTZ,
  certbot_email          TEXT        DEFAULT '',
  default_memory_mb      INTEGER     DEFAULT 512,
  max_deployments_retain INTEGER     DEFAULT 20,
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);
