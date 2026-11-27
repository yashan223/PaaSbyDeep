import { Router } from 'express';
import { join } from 'path';
import { rmSync } from 'fs';
import { getDb } from '../db/database.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { encryptSecret } from '../utils/crypto.js';
import { broadcast } from '../services/ws.js';
import { removeDomainNginxConfig, syncDomainNginxConfig } from '../services/domainManager.js';
import {
  sanitizeName,
  sanitizePort,
  sanitizeRepoUrl,
  sanitizeDockerfilePath,
} from '../utils/sanitize.js';

const router = Router();
router.use(authenticate);

function parseId(raw) {
  const id = Number.parseInt(raw, 10);
  if (!Number.isInteger(id) || id <= 0 || String(id) !== String(raw)) {
    return null;
  }
  return id;
}

const SENSITIVE_ENV_KEY = /TOKEN|SECRET|KEY|PASSWORD|PASSWD|PASS|CREDENTIAL|AUTH|DATABASE_URL/i;

function serializeApp(app, role = 'admin') {
  const { github_token, ...rest } = app;
  const rawEnv = typeof rest.env_vars === 'object' && rest.env_vars !== null ? rest.env_vars : {};
  const envVars = role === 'viewer'
    ? Object.fromEntries(
        Object.entries(rawEnv).map(([k, v]) => [k, SENSITIVE_ENV_KEY.test(k) ? '[REDACTED]' : v])
      )
    : rawEnv;

  return {
    ...rest,
    env_vars: envVars,
    has_github_token: Boolean(github_token),
  };
}

function parseEnvVarsInput(rawEnv) {
  if (rawEnv === undefined || rawEnv === null || rawEnv === '') return {};
  const parsed = typeof rawEnv === 'string' ? JSON.parse(rawEnv) : rawEnv;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('env_vars must be a valid JSON object.');
  }

  const sanitized = {};
  for (const [key, val] of Object.entries(parsed)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment variable key '${key}'. Use letters, numbers, and underscores only.`);
    }
    const strVal = String(val ?? '');
    if (/[\r\n\0]/.test(strVal)) {
      throw new Error(`Environment variable '${key}' contains invalid newline or null characters.`);
    }
    sanitized[key] = strVal;
  }
  return sanitized;
}

router.get('/', async (req, res) => {
  try {
    const sql = getDb();
    const apps = await sql`
      SELECT a.*,
        (SELECT status     FROM deployments WHERE app_id = a.id ORDER BY id DESC LIMIT 1) AS last_deployment_status,
        (SELECT started_at FROM deployments WHERE app_id = a.id ORDER BY id DESC LIMIT 1) AS last_deployed_at
      FROM applications a
      ORDER BY a.created_at DESC
    `;
    return res.json(apps.map((a) => serializeApp(a, req.user?.role)));
  } catch (err) {
    console.error('[Apps] List error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch applications.' });
  }
});

router.post('/', requireRole('admin', 'operator'), async (req, res) => {
  const name = req.body.name;
  const repoUrlInput = req.body.repo_url ?? req.body.repoUrl;
  const branchInput = req.body.branch;
  const dockerfileInput = req.body.dockerfile_path ?? req.body.dockerfilePath;
  const portInput = req.body.port;
  const envVarsInput = req.body.env_vars ?? req.body.envVars;
  const githubTokenInput = req.body.github_token ?? req.body.githubToken;
  const projectTypeInput = req.body.project_type ?? req.body.projectType;

  if (!name || !repoUrlInput || !portInput) {
    return res.status(400).json({ error: 'name, repo_url, and port are required.' });
  }

  const safeName = sanitizeName(String(name));
  if (!safeName) {
    return res.status(400).json({
      error: 'Invalid app name. Use only lowercase letters, numbers, and hyphens (max 50 chars).',
    });
  }

  const safeRepoUrl = sanitizeRepoUrl(String(repoUrlInput));
  if (!safeRepoUrl) {
    return res.status(400).json({
      error: 'Invalid repo URL. Only https://github.com/ and https://gitlab.com/ URLs are allowed.',
    });
  }

  const safePort = sanitizePort(portInput);
  if (!safePort) {
    return res.status(400).json({ error: 'Invalid port. Must be an integer between 1024 and 65535.' });
  }

  const safeBranch = branchInput
    ? String(branchInput).replace(/[^a-zA-Z0-9._\-\/]/g, '').slice(0, 100) || 'main'
    : 'main';

  const safeDockerfilePath = dockerfileInput
    ? sanitizeDockerfilePath(String(dockerfileInput))
    : 'Dockerfile';
  if (!safeDockerfilePath) {
    return res.status(400).json({ error: 'Invalid dockerfile_path. Path traversal is not allowed.' });
  }

  let envVarsObj = {};
  try {
    envVarsObj = parseEnvVarsInput(envVarsInput);
  } catch (envErr) {
    return res.status(400).json({ error: envErr.message || 'env_vars must be a valid JSON object.' });
  }

  const encryptedToken = githubTokenInput && typeof githubTokenInput === 'string' && githubTokenInput.trim()
    ? encryptSecret(githubTokenInput.trim())
    : null;

  const safeProjectType = projectTypeInput && typeof projectTypeInput === 'string'
    ? projectTypeInput.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30) || 'auto'
    : 'auto';

  try {
    const sql = getDb();
    const rows = await sql`
      INSERT INTO applications (name, repo_url, branch, dockerfile_path, port, env_vars, github_token, project_type)
      VALUES (${safeName}, ${safeRepoUrl}, ${safeBranch}, ${safeDockerfilePath}, ${safePort}, ${JSON.stringify(envVarsObj)}::jsonb, ${encryptedToken}, ${safeProjectType})
      RETURNING *
    `;
    const created = serializeApp(rows[0]);
    broadcast({ type: 'apps:changed', action: 'created', appId: created.id, appName: created.name });
    return res.status(201).json(created);
  } catch (err) {
    if (err.code === '23505' || err.message?.includes('unique') || err.message?.includes('duplicate')) {
      return res.status(409).json({ error: `An application named '${safeName}' already exists.` });
    }
    console.error('[Apps] Create error:', err.message);
    return res.status(500).json({ error: 'Failed to create application.' });
  }
});

router.get('/:id', async (req, res) => {
  const appId = parseId(req.params.id);
  if (!appId) return res.status(400).json({ error: 'Invalid application ID.' });

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT a.*,
        (SELECT status     FROM deployments WHERE app_id = a.id ORDER BY id DESC LIMIT 1) AS last_deployment_status,
        (SELECT started_at FROM deployments WHERE app_id = a.id ORDER BY id DESC LIMIT 1) AS last_deployed_at
      FROM applications a
      WHERE a.id = ${appId}
    `;
    if (!rows[0]) return res.status(404).json({ error: 'Application not found.' });

    const deployments = await sql`
      SELECT * FROM deployments WHERE app_id = ${appId} ORDER BY id DESC LIMIT 10
    `;
    return res.json({ ...serializeApp(rows[0], req.user?.role), deployments });
  } catch (err) {
    console.error('[Apps] Get error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch application.' });
  }
});

router.put('/:id', requireRole('admin', 'operator'), async (req, res) => {
  const appId = parseId(req.params.id);
  if (!appId) return res.status(400).json({ error: 'Invalid application ID.' });

  try {
    const sql = getDb();
    const rows = await sql`SELECT * FROM applications WHERE id = ${appId}`;
    if (!rows[0]) return res.status(404).json({ error: 'Application not found.' });
    const app = rows[0];

    const name = req.body.name;
    const repoUrlInput = req.body.repo_url ?? req.body.repoUrl;
    const branchInput = req.body.branch;
    const dockerfileInput = req.body.dockerfile_path ?? req.body.dockerfilePath;
    const portInput = req.body.port;
    const envVarsInput = req.body.env_vars ?? req.body.envVars;
    const githubTokenInput = req.body.github_token ?? req.body.githubToken;
    const projectTypeInput = req.body.project_type ?? req.body.projectType;

    const safeName = name ? sanitizeName(String(name)) : app.name;
    if (!safeName) return res.status(400).json({ error: 'Invalid app name.' });

    const safePort = portInput !== undefined ? sanitizePort(portInput) : app.port;
    if (!safePort) return res.status(400).json({ error: 'Invalid port. Must be 1024-65535.' });

    const safeDockerfilePath = dockerfileInput
      ? sanitizeDockerfilePath(String(dockerfileInput))
      : app.dockerfile_path;
    if (!safeDockerfilePath) return res.status(400).json({ error: 'Invalid dockerfile_path.' });

    const safeBranch = branchInput
      ? String(branchInput).replace(/[^a-zA-Z0-9._\-\/]/g, '').slice(0, 100) || app.branch
      : app.branch;

    let safeRepoUrl = app.repo_url;
    if (repoUrlInput) {
      safeRepoUrl = sanitizeRepoUrl(String(repoUrlInput));
      if (!safeRepoUrl) return res.status(400).json({ error: 'Invalid repo URL.' });
    }

    let envVarsObj = typeof app.env_vars === 'object' && app.env_vars !== null ? app.env_vars : {};
    if (envVarsInput !== undefined) {
      try {
        envVarsObj = parseEnvVarsInput(envVarsInput);
      } catch (envErr) {
        return res.status(400).json({ error: envErr.message || 'env_vars must be a valid JSON object.' });
      }
    }

    let encryptedToken = app.github_token;
    if (typeof githubTokenInput === 'string' && githubTokenInput.trim()) {
      encryptedToken = encryptSecret(githubTokenInput.trim());
    }

    const safeProjectType = projectTypeInput && typeof projectTypeInput === 'string'
      ? projectTypeInput.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30) || app.project_type || 'auto'
      : app.project_type || 'auto';

    const updated = await sql`
      UPDATE applications
      SET name = ${safeName}, repo_url = ${safeRepoUrl}, branch = ${safeBranch},
          dockerfile_path = ${safeDockerfilePath}, port = ${safePort},
          env_vars = ${JSON.stringify(envVarsObj)}::jsonb,
          github_token = ${encryptedToken},
          project_type = ${safeProjectType},
          updated_at = NOW()
      WHERE id = ${app.id}
      RETURNING *
    `;
    const result = serializeApp(updated[0]);
    if (safePort !== app.port) {
      const appDomains = await sql`SELECT id, domain FROM domains WHERE app_id = ${app.id}`;
      for (const d of appDomains) {
        syncDomainNginxConfig({ domain: d.domain, port: safePort, appName: result.name }).catch(() => {});
      }
    }
    broadcast({ type: 'apps:changed', action: 'updated', appId: result.id, appName: result.name });
    return res.json(result);
  } catch (err) {
    if (err.code === '23505' || err.message?.includes('unique') || err.message?.includes('duplicate')) {
      return res.status(409).json({ error: 'An application with that name already exists.' });
    }
    console.error('[Apps] Update error:', err.message);
    return res.status(500).json({ error: 'Failed to update application.' });
  }
});

router.delete('/:id', requireRole('admin', 'operator'), async (req, res) => {
  const appId = parseId(req.params.id);
  if (!appId) return res.status(400).json({ error: 'Invalid application ID.' });

  try {
    const sql = getDb();
    const rows = await sql`SELECT * FROM applications WHERE id = ${appId}`;
    if (!rows[0]) return res.status(404).json({ error: 'Application not found.' });
    const app = rows[0];

    if (app.container_id || (app.status && app.status !== 'stopped')) {
      try {
        const { cleanupContainer } = await import('../services/docker.js');
        await cleanupContainer(app);
      } catch (err) {
        console.warn('[Apps] Container cleanup warning:', err.message);
      }
    }

    try {
      const reposPath = process.env.REPOS_PATH || './data/repos';
      const safeName = sanitizeName(app.name);
      if (safeName) {
        rmSync(join(reposPath, safeName), { recursive: true, force: true });
      }
    } catch (err) {
      console.warn('[Apps] Repo dir cleanup warning:', err.message);
    }

    const appDomains = await sql`SELECT domain FROM domains WHERE app_id = ${app.id}`;
    for (const d of appDomains) {
      await removeDomainNginxConfig(d.domain).catch(() => {});
    }

    await sql`DELETE FROM applications WHERE id = ${app.id}`;
    broadcast({ type: 'apps:changed', action: 'deleted', appId: app.id, appName: app.name });
    return res.json({ message: `Application '${app.name}' deleted.` });
  } catch (err) {
    console.error('[Apps] Delete error:', err.message);
    return res.status(500).json({ error: 'Failed to delete application.' });
  }
});

export default router;
