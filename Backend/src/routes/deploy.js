import { Router } from 'express';
import Docker from 'dockerode';
import { getDb } from '../db/database.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { enqueue } from '../services/deploymentQueue.js';
import { broadcast } from '../services/ws.js';

const router = Router();
router.use(authenticate);

const docker = new Docker();

function parseId(raw) {
  const id = Number.parseInt(raw, 10);
  if (!Number.isInteger(id) || id <= 0 || String(id) !== String(raw)) {
    return null;
  }
  return id;
}

router.get('/recent-logs', async (_req, res) => {
  try {
    const sql = getDb();
    const rows = await sql`
      SELECT d.id AS deployment_id, d.app_id, a.name AS app_name, d.status, d.started_at, d.logs
      FROM deployments d
      JOIN applications a ON a.id = d.app_id
      ORDER BY d.id DESC
      LIMIT 1
    `;
    if (!rows[0]) {
      return res.json({ logs: '', app_name: null });
    }
    const row = rows[0];
    const lines = String(row.logs || '').split(/\r?\n/);
    const tail = lines.slice(-100).join('\n');
    return res.json({
      deployment_id: row.deployment_id,
      app_id: row.app_id,
      app_name: row.app_name,
      status: row.status,
      started_at: row.started_at,
      logs: tail,
    });
  } catch (err) {
    console.error('[Deploy] Recent logs error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch recent logs.' });
  }
});

router.post('/:id/deploy', requireRole('admin', 'operator'), async (req, res) => {
  const appId = parseId(req.params.id);
  if (!appId) return res.status(400).json({ error: 'Invalid application ID.' });

  try {
    const sql = getDb();
    const rows = await sql`SELECT * FROM applications WHERE id = ${appId}`;
    if (!rows[0]) return res.status(404).json({ error: 'Application not found.' });

    const deploymentId = await enqueue(rows[0].id, 'manual', null, rows[0].name);
    return res.json({ message: `Deployment enqueued for '${rows[0].name}'.`, deploymentId });
  } catch (err) {
    console.error('[Deploy] Enqueue error:', err.message);
    return res.status(500).json({ error: 'Failed to enqueue deployment.' });
  }
});

router.post('/:id/restart', requireRole('admin', 'operator'), async (req, res) => {
  const appId = parseId(req.params.id);
  if (!appId) return res.status(400).json({ error: 'Invalid application ID.' });

  try {
    const sql = getDb();
    const rows = await sql`SELECT * FROM applications WHERE id = ${appId}`;
    if (!rows[0]) return res.status(404).json({ error: 'Application not found.' });
    const app = rows[0];

    if (!app.container_id) {
      return res.status(400).json({ error: 'No container associated with this application. Deploy it first.' });
    }

    const container = docker.getContainer(app.container_id);
    await container.restart();
    await sql`UPDATE applications SET status = 'running', updated_at = NOW() WHERE id = ${app.id}`;
    broadcast({ type: 'app:status', appId: app.id, appName: app.name, status: 'running' });
    return res.json({ message: `Container for '${app.name}' restarted.` });
  } catch (err) {
    if (err.statusCode === 404) {
      const sql = getDb();
      await sql`UPDATE applications SET status = 'stopped', container_id = NULL, updated_at = NOW() WHERE id = ${appId}`;
      broadcast({ type: 'app:status', appId, status: 'stopped' });
      return res.status(404).json({ error: 'Container no longer exists. Please redeploy.' });
    }
    console.error('[Deploy] Restart error:', err.message);
    return res.status(500).json({ error: `Failed to restart container: ${err.message}` });
  }
});

router.post('/:id/stop', requireRole('admin', 'operator'), async (req, res) => {
  const appId = parseId(req.params.id);
  if (!appId) return res.status(400).json({ error: 'Invalid application ID.' });

  try {
    const sql = getDb();
    const rows = await sql`SELECT * FROM applications WHERE id = ${appId}`;
    if (!rows[0]) return res.status(404).json({ error: 'Application not found.' });
    const app = rows[0];

    if (!app.container_id) {
      return res.status(400).json({ error: 'No container associated with this application.' });
    }

    try {
      const container = docker.getContainer(app.container_id);
      await container.stop({ t: 10 });
    } catch (err) {
      if (err.statusCode === 304) {
      } else if (err.statusCode === 404) {
        await sql`UPDATE applications SET status = 'stopped', container_id = NULL, updated_at = NOW() WHERE id = ${app.id}`;
        broadcast({ type: 'app:status', appId: app.id, appName: app.name, status: 'stopped' });
        return res.json({ message: `Container for '${app.name}' was already removed.` });
      } else {
        throw err;
      }
    }

    await sql`UPDATE applications SET status = 'stopped', updated_at = NOW() WHERE id = ${app.id}`;
    broadcast({ type: 'app:status', appId: app.id, appName: app.name, status: 'stopped' });
    return res.json({ message: `Container for '${app.name}' stopped.` });
  } catch (err) {
    console.error('[Deploy] Stop error:', err.message);
    return res.status(500).json({ error: `Failed to stop container: ${err.message}` });
  }
});

router.get('/:id/logs', async (req, res) => {
  const appId = parseId(req.params.id);
  if (!appId) return res.status(400).json({ error: 'Invalid application ID.' });

  try {
    const sql = getDb();
    const rows = await sql`SELECT id FROM applications WHERE id = ${appId}`;
    if (!rows[0]) return res.status(404).json({ error: 'Application not found.' });

    const deployments = await sql`
      SELECT id, status, logs FROM deployments WHERE app_id = ${appId} ORDER BY id DESC LIMIT 1
    `;
    if (!deployments[0]) {
      return res.json({ logs: '', message: 'No deployments found for this application.' });
    }
    const d = deployments[0];
    return res.json({ deployment_id: d.id, status: d.status, logs: d.logs || '' });
  } catch (err) {
    console.error('[Deploy] Logs error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch logs.' });
  }
});

router.get('/:id/deployments', async (req, res) => {
  const appId = parseId(req.params.id);
  if (!appId) return res.status(400).json({ error: 'Invalid application ID.' });

  try {
    const sql = getDb();
    const rows = await sql`SELECT id FROM applications WHERE id = ${appId}`;
    if (!rows[0]) return res.status(404).json({ error: 'Application not found.' });

    const deployments = await sql`
      SELECT id, app_id, status, commit_sha, triggered_by, started_at, finished_at
      FROM deployments
      WHERE app_id = ${appId}
      ORDER BY id DESC
      LIMIT 20
    `;
    return res.json(deployments);
  } catch (err) {
    console.error('[Deploy] Deployments error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch deployments.' });
  }
});

export default router;
