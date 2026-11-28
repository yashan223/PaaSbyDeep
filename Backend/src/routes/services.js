import { Router } from 'express';
import { getDb } from '../db/database.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { broadcast } from '../services/ws.js';
import { recordAudit } from '../services/auditService.js';
import {
  SERVICE_TEMPLATES,
  listManagedServices,
  createManagedService,
  controlManagedService,
  getManagedServiceLogs,
  deleteManagedService,
  serializeService,
} from '../services/serviceManager.js';
import { getServerPublicIps } from '../services/domainManager.js';

const router = Router();
router.use(authenticate);

function parseId(raw) {
  const id = Number.parseInt(raw, 10);
  if (!Number.isInteger(id) || id <= 0 || String(id) !== String(raw)) {
    return null;
  }
  return id;
}

router.get('/templates', (_req, res) => {
  return res.json(SERVICE_TEMPLATES);
});

router.get('/', async (req, res) => {
  try {
    const services = await listManagedServices(req.user?.role);
    return res.json(services);
  } catch (err) {
    console.error('[Services] List error:', err.message);
    return res.status(500).json({ error: 'Failed to load managed services.' });
  }
});

router.post('/', requireRole('admin', 'operator'), async (req, res) => {
  const { name, serviceType, service_type, port, databaseName, database_name, memoryLimitMb, memory_limit_mb, autoStart } = req.body || {};
  try {
    const result = await createManagedService(
      {
        name,
        serviceType: serviceType ?? service_type,
        port,
        databaseName: databaseName ?? database_name,
        memoryLimitMb: memoryLimitMb ?? memory_limit_mb ?? 512,
        autoStart: autoStart !== false,
      },
      req.user?.role
    );

    void recordAudit({
      req,
      action: 'service.create',
      targetType: 'service',
      targetId: result.service.id,
      targetName: result.service.name,
      details: { type: result.service.service_type, port: result.service.port },
    });

    return res.status(201).json(result);
  } catch (err) {
    if (err.code === '23505' || err.message?.includes('unique')) {
      return res.status(409).json({ error: `A service named '${name}' already exists.` });
    }
    return res.status(400).json({ error: err.message || 'Failed to create managed service.' });
  }
});

router.get('/:id/logs', async (req, res) => {
  const serviceId = parseId(req.params.id);
  if (!serviceId) return res.status(400).json({ error: 'Invalid service ID.' });

  try {
    const tail = Number.parseInt(req.query.tail ?? '200', 10);
    const result = await getManagedServiceLogs(serviceId, tail);
    return res.json(result);
  } catch (err) {
    return res.status(404).json({ error: err.message || 'Failed to read service logs.' });
  }
});

router.post('/:id/attach', requireRole('admin', 'operator'), async (req, res) => {
  const serviceId = parseId(req.params.id);
  if (!serviceId) return res.status(400).json({ error: 'Invalid service ID.' });

  const appId = parseId(req.body?.appId ?? req.body?.app_id);
  if (!appId) return res.status(400).json({ error: 'Valid application ID is required.' });

  const rawEnvKey = String(req.body?.envKey || '').trim();
  if (rawEnvKey && !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(rawEnvKey)) {
    return res.status(400).json({ error: 'Invalid environment variable key name.' });
  }

  try {
    const sql = getDb();
    const [svcRows, appRows, ips] = await Promise.all([
      sql`SELECT * FROM managed_services WHERE id = ${serviceId}`,
      sql`SELECT id, name, env_vars FROM applications WHERE id = ${appId}`,
      getServerPublicIps().catch(() => ({ publicIpv4: null, localIpv4: 'localhost' })),
    ]);

    if (!svcRows[0]) return res.status(404).json({ error: 'Managed service not found.' });
    if (!appRows[0]) return res.status(404).json({ error: 'Target application not found.' });

    const publicHost = ips.publicIpv4 || ips.localIpv4 || 'localhost';
    const serialized = serializeService(svcRows[0], publicHost, 'admin');
    const envKey = rawEnvKey || serialized.suggested_env_key || 'DATABASE_URL';
    const currentEnv = typeof appRows[0].env_vars === 'object' && appRows[0].env_vars !== null
      ? { ...appRows[0].env_vars }
      : {};
    currentEnv[envKey] = serialized.internal_url;

    await sql`
      UPDATE applications SET env_vars = ${JSON.stringify(currentEnv)}::jsonb, updated_at = NOW()
      WHERE id = ${appId}
    `;
    broadcast({ type: 'apps:changed', action: 'updated', appId, appName: appRows[0].name });

    void recordAudit({
      req,
      action: 'service.attach',
      targetType: 'application',
      targetId: appId,
      targetName: appRows[0].name,
      details: { serviceName: svcRows[0].name, envKey },
    });

    return res.json({
      message: `Added ${envKey} from '${svcRows[0].name}' into '${appRows[0].name}'. Redeploy the app to apply changes.`,
      envKey,
    });
  } catch (err) {
    console.error('[Services] Attach error:', err.message);
    return res.status(500).json({ error: 'Failed to attach service to application.' });
  }
});

router.post('/:id/:action', requireRole('admin', 'operator'), async (req, res) => {
  const serviceId = parseId(req.params.id);
  if (!serviceId) return res.status(400).json({ error: 'Invalid service ID.' });

  const action = String(req.params.action || '').toLowerCase();
  if (!['start', 'stop', 'restart'].includes(action)) {
    return res.status(400).json({ error: 'Unsupported action.' });
  }

  try {
    const updated = await controlManagedService(serviceId, action, req.user?.role);
    void recordAudit({
      req,
      action: `service.${action}`,
      targetType: 'service',
      targetId: updated.id,
      targetName: updated.name,
    });
    return res.json(updated);
  } catch (err) {
    return res.status(400).json({ error: err.message || `Failed to ${action} service.` });
  }
});

router.delete('/:id', requireRole('admin', 'operator'), async (req, res) => {
  const serviceId = parseId(req.params.id);
  if (!serviceId) return res.status(400).json({ error: 'Invalid service ID.' });

  try {
    const removeVolume = req.query.removeVolume === 'true' || req.body?.removeVolume === true;
    const deleted = await deleteManagedService(serviceId, removeVolume);
    void recordAudit({
      req,
      action: 'service.delete',
      targetType: 'service',
      targetId: deleted.id,
      targetName: deleted.name,
      details: { removeVolume },
    });
    return res.json({ message: `Service '${deleted.name}' deleted.` });
  } catch (err) {
    return res.status(404).json({ error: err.message || 'Failed to delete service.' });
  }
});

export default router;
