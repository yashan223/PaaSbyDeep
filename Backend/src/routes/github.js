import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { getDb } from '../db/database.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { encryptSecret, decryptSecret } from '../utils/crypto.js';
import { classifyProject } from '../services/projectDetector.js';
import { getPlatformSettings } from '../services/settingsService.js';

const router = Router();

const GITHUB_API = 'https://api.github.com';

async function githubFetch(path, token, options = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'PaaSbyDeep',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(options.headers || {}),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `GitHub API error (${res.status})`);
    err.statusCode = res.status;
    throw err;
  }
  return data;
}

function getOAuthConfig(req) {
  const clientId = process.env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim();
  const publicBackendUrl = process.env.BACKEND_PUBLIC_URL?.trim() || `${req.protocol}://${req.get('host')}`;
  const frontendUrl = process.env.FRONTEND_URL?.trim() || 'http://localhost:5173';
  return {
    configured: Boolean(clientId && clientSecret),
    clientId,
    clientSecret,
    callbackUrl: `${publicBackendUrl.replace(/\/+$/, '')}/api/github/oauth/callback`,
    frontendUrl: frontendUrl.replace(/\/+$/, ''),
  };
}

function serializeConnection(row) {
  if (!row) return null;
  return {
    github_id: row.github_id,
    github_username: row.github_username,
    avatar_url: row.avatar_url,
    profile_url: row.profile_url,
    auth_type: row.auth_type,
    connected_at: row.connected_at,
    updated_at: row.updated_at,
  };
}

async function saveGithubConnection(userId, token, authType) {
  const ghUser = await githubFetch('/user', token);
  const encrypted = encryptSecret(token);
  const sql = getDb();

  const rows = await sql`
    INSERT INTO github_connections (user_id, github_id, github_username, avatar_url, profile_url, access_token, auth_type, updated_at)
    VALUES (${userId}, ${ghUser.id}, ${ghUser.login}, ${ghUser.avatar_url}, ${ghUser.html_url}, ${encrypted}, ${authType}, NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      github_id       = EXCLUDED.github_id,
      github_username = EXCLUDED.github_username,
      avatar_url      = EXCLUDED.avatar_url,
      profile_url     = EXCLUDED.profile_url,
      access_token    = EXCLUDED.access_token,
      auth_type       = EXCLUDED.auth_type,
      updated_at      = NOW()
    RETURNING github_id, github_username, avatar_url, profile_url, auth_type, connected_at, updated_at
  `;
  return serializeConnection(rows[0]);
}

async function getUserGithubToken(userId) {
  const sql = getDb();
  const rows = await sql`SELECT access_token FROM github_connections WHERE user_id = ${userId}`;
  if (!rows[0]?.access_token) return null;
  return decryptSecret(rows[0].access_token);
}

router.get('/oauth/callback', async (req, res) => {
  const { frontendUrl, clientId, clientSecret, callbackUrl, configured } = getOAuthConfig(req);
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    return res.redirect(`${frontendUrl}/github?error=${encodeURIComponent(String(oauthError))}`);
  }

  if (!configured) {
    return res.redirect(`${frontendUrl}/github?error=${encodeURIComponent('GitHub OAuth is not configured on the server.')}`);
  }

  if (!code || !state) {
    return res.redirect(`${frontendUrl}/github?error=${encodeURIComponent('Missing OAuth code or state.')}`);
  }

  try {
    const decoded = jwt.verify(String(state), process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (decoded?.purpose !== 'github_oauth' || !decoded?.userId) {
      throw new Error('Invalid OAuth state.');
    }

    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code: String(code),
        redirect_uri: callbackUrl,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      throw new Error(tokenData.error_description || tokenData.error || 'Failed to obtain GitHub access token.');
    }

    await saveGithubConnection(decoded.userId, tokenData.access_token, 'oauth');
    return res.redirect(`${frontendUrl}/github?connected=1`);
  } catch (err) {
    console.error('[GitHub OAuth] Callback error:', err.message);
    return res.redirect(`${frontendUrl}/github?error=${encodeURIComponent(err.message || 'OAuth failed.')}`);
  }
});

router.use(authenticate);

router.get('/status', async (req, res) => {
  try {
    const sql = getDb();
    const rows = await sql`
      SELECT github_id, github_username, avatar_url, profile_url, auth_type, connected_at, updated_at
      FROM github_connections
      WHERE user_id = ${req.user.id}
    `;
    const oauth = getOAuthConfig(req);
    return res.json({
      connected: Boolean(rows[0]),
      oauthConfigured: oauth.configured,
      callbackUrl: oauth.callbackUrl,
      connection: serializeConnection(rows[0]),
    });
  } catch (err) {
    console.error('[GitHub] Status error:', err.message);
    return res.status(500).json({ error: 'Failed to check GitHub connection status.' });
  }
});

router.get('/oauth/url', requireRole('admin', 'operator'), (req, res) => {
  const oauth = getOAuthConfig(req);
  if (!oauth.configured) {
    return res.status(400).json({
      error: 'GitHub OAuth is not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in Backend/.env, or connect using a Personal Access Token.',
    });
  }

  const state = jwt.sign(
    { userId: req.user.id, purpose: 'github_oauth' },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '10m' }
  );

  const params = new URLSearchParams({
    client_id: oauth.clientId,
    redirect_uri: oauth.callbackUrl,
    scope: 'repo admin:repo_hook read:user',
    state,
  });

  return res.json({ url: `https://github.com/login/oauth/authorize?${params.toString()}` });
});

router.post('/connect', requireRole('admin', 'operator'), async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string' || !token.trim()) {
    return res.status(400).json({ error: 'GitHub Personal Access Token is required.' });
  }

  try {
    const connection = await saveGithubConnection(req.user.id, token.trim(), 'pat');
    return res.json({ message: `Connected GitHub account @${connection.github_username}.`, connection });
  } catch (err) {
    console.error('[GitHub] PAT connect error:', err.message);
    const status = err.statusCode === 401 ? 401 : 400;
    return res.status(status).json({ error: `GitHub token verification failed: ${err.message}` });
  }
});

router.delete('/connection', requireRole('admin', 'operator'), async (req, res) => {
  try {
    const sql = getDb();
    await sql`DELETE FROM github_connections WHERE user_id = ${req.user.id}`;
    return res.json({ message: 'GitHub account disconnected.' });
  } catch (err) {
    console.error('[GitHub] Disconnect error:', err.message);
    return res.status(500).json({ error: 'Failed to disconnect GitHub account.' });
  }
});

router.get('/repos', async (req, res) => {
  try {
    const token = await getUserGithubToken(req.user.id);
    if (!token) {
      return res.status(400).json({ error: 'No GitHub account connected.' });
    }

    const repos = await githubFetch(
      '/user/repos?sort=updated&per_page=100&affiliation=owner,collaborator,organization_member',
      token
    );

    const formatted = repos.map((r) => ({
      id: r.id,
      name: r.name,
      full_name: r.full_name,
      owner: r.owner?.login,
      clone_url: r.clone_url,
      html_url: r.html_url,
      default_branch: r.default_branch || 'main',
      private: Boolean(r.private),
      description: r.description || '',
      updated_at: r.updated_at,
    }));

    return res.json(formatted);
  } catch (err) {
    console.error('[GitHub] Repos fetch error:', err.message);
    const status = err.statusCode === 401 ? 401 : 500;
    return res.status(status).json({ error: `Failed to fetch repositories: ${err.message}` });
  }
});

router.get('/repos/:owner/:repo/branches', async (req, res) => {
  const { owner, repo } = req.params;
  if (!/^[a-zA-Z0-9._-]+$/.test(owner) || !/^[a-zA-Z0-9._-]+$/.test(repo)) {
    return res.status(400).json({ error: 'Invalid repository owner or name.' });
  }

  try {
    const token = await getUserGithubToken(req.user.id);
    if (!token) {
      return res.status(400).json({ error: 'No GitHub account connected.' });
    }

    const branches = await githubFetch(`/repos/${owner}/${repo}/branches?per_page=50`, token);
    return res.json(branches.map((b) => b.name));
  } catch (err) {
    console.error('[GitHub] Branches fetch error:', err.message);
    return res.status(500).json({ error: `Failed to fetch branches: ${err.message}` });
  }
});

async function fetchRepoFileText(owner, repo, filePath, branch, token) {
  try {
    const data = await githubFetch(
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(branch)}`,
      token
    );
    if (data?.content && data.encoding === 'base64') {
      return Buffer.from(data.content, 'base64').toString('utf8');
    }
  } catch {
  }
  return '';
}

router.get('/detect', async (req, res) => {
  const { repo_url: repoUrl, branch = 'main', dockerfile_path: dockerfilePath = 'Dockerfile' } = req.query;
  if (!repoUrl || typeof repoUrl !== 'string') {
    return res.status(400).json({ error: 'repo_url query parameter is required.' });
  }

  let parsed;
  try {
    parsed = new URL(repoUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid repository URL.' });
  }

  if (parsed.hostname !== 'github.com') {
    return res.status(400).json({ error: 'Auto-detection currently supports github.com repositories.' });
  }

  const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '').split('/');
  if (parts.length < 2) {
    return res.status(400).json({ error: 'Could not extract owner/repo from URL.' });
  }
  const [owner, repo] = parts;

  try {
    const token = await getUserGithubToken(req.user.id);
    const refQuery = branch ? `?ref=${encodeURIComponent(String(branch))}` : '';
    const contents = await githubFetch(`/repos/${owner}/${repo}/contents${refQuery}`, token);
    const files = Array.isArray(contents) ? contents.map((item) => item.name) : [];
    const lowerSet = new Set(files.map((f) => f.toLowerCase()));

    const [packageJson, requirementsTxt, pyprojectToml] = await Promise.all([
      lowerSet.has('package.json') ? fetchRepoFileText(owner, repo, 'package.json', String(branch), token) : '',
      lowerSet.has('requirements.txt') ? fetchRepoFileText(owner, repo, 'requirements.txt', String(branch), token) : '',
      lowerSet.has('pyproject.toml') ? fetchRepoFileText(owner, repo, 'pyproject.toml', String(branch), token) : '',
    ]);

    const result = classifyProject({
      files,
      packageJson: packageJson || null,
      requirementsTxt,
      pyprojectToml,
      dockerfilePath: String(dockerfilePath || 'Dockerfile'),
    });

    return res.json({
      projectType: result.projectType,
      label: result.label,
      hasDockerfile: result.hasDockerfile,
      suggestedPort: result.suggestedPort,
    });
  } catch (err) {
    const status = err.statusCode === 404 ? 404 : err.statusCode === 401 ? 401 : 500;
    return res.status(status).json({ error: `Could not detect project type: ${err.message}` });
  }
});

router.post('/apps/:appId/webhook', requireRole('admin', 'operator'), async (req, res) => {
  const appId = Number.parseInt(req.params.appId, 10);
  if (!Number.isInteger(appId) || appId <= 0) {
    return res.status(400).json({ error: 'Invalid application ID.' });
  }

  try {
    const token = await getUserGithubToken(req.user.id);
    if (!token) {
      return res.status(400).json({ error: 'Connect your GitHub account first to auto-create webhooks.' });
    }

    const sql = getDb();
    const rows = await sql`SELECT * FROM applications WHERE id = ${appId}`;
    if (!rows[0]) return res.status(404).json({ error: 'Application not found.' });
    const app = rows[0];

    const parsed = new URL(app.repo_url);
    if (parsed.hostname !== 'github.com') {
      return res.status(400).json({ error: 'Automatic webhook creation only supports GitHub repositories.' });
    }

    const parts = parsed.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '').split('/');
    if (parts.length < 2) {
      return res.status(400).json({ error: 'Could not parse owner/repo from repository URL.' });
    }
    const [owner, repo] = parts;

    const platformSettings = await getPlatformSettings().catch(() => ({}));
    const reqPublicUrl = req.body?.publicUrl && !String(req.body.publicUrl).includes('localhost')
      ? req.body.publicUrl
      : '';
    const baseUrl = (
      platformSettings.public_url ||
      reqPublicUrl ||
      process.env.BACKEND_PUBLIC_URL ||
      `${req.protocol}://${req.get('host')}`
    ).replace(/\/+$/, '');
    if (baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1')) {
      return res.status(400).json({
        error: 'GitHub cannot send webhooks to localhost. Provide your public HTTPS domain URL (e.g. https://paas.yourdomain.com).',
      });
    }

    const webhookUrl = `${baseUrl}/api/webhook/github/${app.id}`;
    const webhookSecret = process.env.WEBHOOK_SECRET;
    if (!webhookSecret) {
      return res.status(500).json({ error: 'WEBHOOK_SECRET is not configured on the server.' });
    }

    const hook = await githubFetch(`/repos/${owner}/${repo}/hooks`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'web',
        active: true,
        events: ['push'],
        config: {
          url: webhookUrl,
          content_type: 'json',
          secret: webhookSecret,
          insecure_ssl: '0',
        },
      }),
    });

    return res.status(201).json({
      message: `Webhook created on ${owner}/${repo}.`,
      webhookUrl,
      hookId: hook.id,
    });
  } catch (err) {
    console.error('[GitHub] Webhook creation error:', err.message);
    return res.status(err.statusCode || 500).json({
      error: `Failed to create webhook on GitHub: ${err.message}`,
    });
  }
});

export default router;
