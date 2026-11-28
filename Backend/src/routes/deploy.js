import { Router } from 'express';
import Docker from 'dockerode';
import { getDb } from '../db/database.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { enqueue } from '../services/deploymentQueue.js';
import { broadcast } from '../services/ws.js';
import {
  ensureContainerOnSharedNetwork,
  getActiveDeploymentLogs,
  getContainerLogs,
  getContainerStats,
  rollbackAppToDeployment,
} from '../services/docker.js';
import { recordAudit } from '../services/auditService.js';

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
    void recordAudit({
      req,
      action: 'app.deploy',
      targetType: 'application',
      targetId: rows[0].id,
      targetName: rows[0].name,
      details: { deploymentId },
    });
    return res.json({ message: `Deployment enqueued for '${rows[0].name}'.`, deploymentId });
  } catch (err) {
    console.error('[Deploy] Enqueue error:', err.message);
    return res.status(500).json({ error: 'Failed to enqueue deployment.' });
  }
});

router.post('/:id/rollback', requireRole('admin', 'operator'), async (req, res) => {
  const appId = parseId(req.params.id);
  const deploymentId = parseId(req.body?.deploymentId ?? req.body?.deployment_id);
  if (!appId) return res.status(400).json({ error: 'Invalid application ID.' });
  if (!deploymentId) return res.status(400).json({ error: 'Valid target deploymentId is required.' });

  try {
    const sql = getDb();
    const [appRows, depRows] = await Promise.all([
      sql`SELECT * FROM applications WHERE id = ${appId}`,
      sql`SELECT * FROM deployments WHERE id = ${deploymentId} AND app_id = ${appId}`,
    ]);
    if (!appRows[0]) return res.status(404).json({ error: 'Application not found.' });
    if (!depRows[0]) return res.status(404).json({ error: 'Target deployment not found for this application.' });
    if (depRows[0].status !== 'success') {
      return res.status(400).json({ error: 'Only succeeded deployments can be rolled back to.' });
    }

    const rollbackDeploymentId = await rollbackAppToDeployment(appRows[0], depRows[0], req.user);
    return res.json({
      message: `Rolled back '${appRows[0].name}' to deployment #${deploymentId}.`,
      deploymentId: rollbackDeploymentId,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Failed to roll back deployment.' });
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
    await ensureContainerOnSharedNetwork(app.container_id);
    await sql`UPDATE applications SET status = 'running', updated_at = NOW() WHERE id = ${app.id}`;
    broadcast({ type: 'app:status', appId: app.id, appName: app.name, status: 'running' });
    void recordAudit({ req, action: 'app.restart', targetType: 'application', targetId: app.id, targetName: app.name });
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
    void recordAudit({ req, action: 'app.stop', targetType: 'application', targetId: app.id, targetName: app.name });
    return res.json({ message: `Container for '${app.name}' stopped.` });
  } catch (err) {
    console.error('[Deploy] Stop error:', err.message);
    return res.status(500).json({ error: `Failed to stop container: ${err.message}` });
  }
});

router.get('/:id/logs', async (req, res) => {
  const appId = parseId(req.params.id);
  if (!appId) return res.status(400).json({ error: 'Invalid application ID.' });

  const requestedDeploymentId = req.query.deploymentId ? parseId(req.query.deploymentId) : null;
  if (req.query.deploymentId && !requestedDeploymentId) {
    return res.status(400).json({ error: 'Invalid deploymentId.' });
  }

  try {
    const sql = getDb();
    const rows = await sql`SELECT id FROM applications WHERE id = ${appId}`;
    if (!rows[0]) return res.status(404).json({ error: 'Application not found.' });

    const deployments = requestedDeploymentId
      ? await sql`
          SELECT id, status, triggered_by, started_at, finished_at, logs
          FROM deployments
          WHERE app_id = ${appId} AND id = ${requestedDeploymentId}
          LIMIT 1
        `
      : await sql`
          SELECT id, status, triggered_by, started_at, finished_at, logs
          FROM deployments
          WHERE app_id = ${appId}
          ORDER BY id DESC
          LIMIT 1
        `;

    if (!deployments[0]) {
      return res.json({ logs: '', message: 'No deployments found for this application.' });
    }
    const d = deployments[0];
    const logs = d.logs || (d.status === 'running' ? getActiveDeploymentLogs(d.id) : '') || '';
    return res.json({
      deployment_id: d.id,
      status: d.status,
      triggered_by: d.triggered_by,
      started_at: d.started_at,
      finished_at: d.finished_at,
      logs,
    });
  } catch (err) {
    console.error('[Deploy] Logs error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch logs.' });
  }
});

router.get('/:id/container-logs', async (req, res) => {
  const appId = parseId(req.params.id);
  if (!appId) return res.status(400).json({ error: 'Invalid application ID.' });

  const parsedTail = Number.parseInt(req.query.tail ?? '300', 10);
  const tail = Number.isInteger(parsedTail) ? Math.min(Math.max(parsedTail, 10), 2000) : 300;

  try {
    const sql = getDb();
    const rows = await sql`SELECT id, name, container_id, status FROM applications WHERE id = ${appId}`;
    if (!rows[0]) return res.status(404).json({ error: 'Application not found.' });

    const result = await getContainerLogs(rows[0], { tail });
    return res.json(result);
  } catch (err) {
    console.error('[Deploy] Container logs error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch container logs.' });
  }
});

router.get('/:id/container-stats', async (req, res) => {
  const appId = parseId(req.params.id);
  if (!appId) return res.status(400).json({ error: 'Invalid application ID.' });

  try {
    const sql = getDb();
    const rows = await sql`SELECT id, name, container_id, status FROM applications WHERE id = ${appId}`;
    if (!rows[0]) return res.status(404).json({ error: 'Application not found.' });

    const stats = await getContainerStats(rows[0]);
    return res.json(stats);
  } catch (err) {
    console.error('[Deploy] Container stats error:', err.message);
    return res.status(500).json({ error: 'Failed to read container stats.' });
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
      SELECT id, app_id, status, commit_sha, triggered_by, image_tag, rollback_from_id, started_at, finished_at
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
