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
  setManagedServiceAccess,
  changeManagedServicePassword,
  getManagedServiceLogs,
  deleteManagedService,
  serializeService,
  listServiceBuckets,
  createServiceBucket,
  deleteServiceBucket,
} from '../services/serviceManager.js';
import { ensureContainerOnSharedNetwork } from '../services/docker.js';
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
  const { name, serviceType, service_type, port, databaseName, database_name, password, memoryLimitMb, memory_limit_mb, publicAccess, public_access, autoStart } = req.body || {};
  try {
    const result = await createManagedService(
      {
        name,
        serviceType: serviceType ?? service_type,
        port,
        databaseName: databaseName ?? database_name,
        password,
        memoryLimitMb: memoryLimitMb ?? memory_limit_mb ?? 512,
        publicAccess: Boolean(publicAccess ?? public_access),
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
      sql`SELECT id, name, container_id, env_vars FROM applications WHERE id = ${appId}`,
      getServerPublicIps().catch(() => ({ publicIpv4: null, localIpv4: 'localhost' })),
    ]);

    if (!svcRows[0]) return res.status(404).json({ error: 'Managed service not found.' });
    if (!appRows[0]) return res.status(404).json({ error: 'Target application not found.' });

    if (appRows[0].container_id) {
      await ensureContainerOnSharedNetwork(appRows[0].container_id);
    }

    const publicHost = ips.publicIpv4 || ips.localIpv4 || 'localhost';
    const serialized = serializeService(svcRows[0], publicHost, 'admin');
    const envKey = rawEnvKey || serialized.suggested_env_key || 'DATABASE_URL';
    const currentEnv = typeof appRows[0].env_vars === 'object' && appRows[0].env_vars !== null
      ? { ...appRows[0].env_vars }
      : {};

    const addedKeys = [];
    if (svcRows[0].service_type === 'minio') {
      currentEnv[envKey] = serialized.internal_url;
      currentEnv.S3_ACCESS_KEY = serialized.access_key || 'paasadmin';
      currentEnv.S3_SECRET_KEY = serialized.secret_key || '';
      currentEnv.S3_REGION = 'us-east-1';
      currentEnv.S3_FORCE_PATH_STYLE = 'true';
      addedKeys.push(envKey, 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_REGION', 'S3_FORCE_PATH_STYLE');
      const bucketName = String(req.body?.bucketName || '').trim().toLowerCase();
      if (bucketName) {
        currentEnv.S3_BUCKET = bucketName;
        addedKeys.push('S3_BUCKET');
      }
    } else {
      currentEnv[envKey] = serialized.internal_url;
      addedKeys.push(envKey);
    }

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
      details: { serviceName: svcRows[0].name, keys: addedKeys },
    });

    return res.json({
      message: `Injected ${addedKeys.join(', ')} from '${svcRows[0].name}' into '${appRows[0].name}'. Redeploy the app to apply changes.`,
      envKey,
      addedKeys,
    });
  } catch (err) {
    console.error('[Services] Attach error:', err.message);
    return res.status(500).json({ error: 'Failed to attach service to application.' });
  }
});

router.get('/:id/buckets', async (req, res) => {
  const serviceId = parseId(req.params.id);
  if (!serviceId) return res.status(400).json({ error: 'Invalid service ID.' });

  try {
    const result = await listServiceBuckets(serviceId);
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Failed to load storage buckets.' });
  }
});

router.post('/:id/buckets', requireRole('admin', 'operator'), async (req, res) => {
  const serviceId = parseId(req.params.id);
  if (!serviceId) return res.status(400).json({ error: 'Invalid service ID.' });

  try {
    const { bucket, service } = await createServiceBucket(serviceId, {
      name: req.body?.name,
      publicRead: Boolean(req.body?.publicRead),
    });
    void recordAudit({
      req,
      action: 'storage.bucket_create',
      targetType: 'service',
      targetId: service.id,
      targetName: `${service.name}/${bucket.name}`,
      details: { publicRead: bucket.public_read },
    });
    return res.status(201).json(bucket);
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Failed to create storage bucket.' });
  }
});

router.delete('/:id/buckets/:bucketName', requireRole('admin', 'operator'), async (req, res) => {
  const serviceId = parseId(req.params.id);
  if (!serviceId) return res.status(400).json({ error: 'Invalid service ID.' });

  try {
    const { bucketName, service } = await deleteServiceBucket(serviceId, req.params.bucketName);
    void recordAudit({
      req,
      action: 'storage.bucket_delete',
      targetType: 'service',
      targetId: service.id,
      targetName: `${service.name}/${bucketName}`,
    });
    return res.json({ message: `Bucket '${bucketName}' deleted.` });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Failed to delete storage bucket.' });
  }
});

router.post('/:id/access', requireRole('admin', 'operator'), async (req, res) => {
  const serviceId = parseId(req.params.id);
  if (!serviceId) return res.status(400).json({ error: 'Invalid service ID.' });

  const publicAccess = Boolean(req.body?.publicAccess ?? req.body?.public_access);
  try {
    const updated = await setManagedServiceAccess(serviceId, publicAccess, req.user?.role);
    void recordAudit({
      req,
      action: publicAccess ? 'service.expose_public' : 'service.restrict_private',
      targetType: 'service',
      targetId: updated.id,
      targetName: updated.name,
      details: { publicAccess },
    });
    return res.json(updated);
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Failed to update service network access.' });
  }
});

router.post('/:id/password', requireRole('admin', 'operator'), async (req, res) => {
  const serviceId = parseId(req.params.id);
  if (!serviceId) return res.status(400).json({ error: 'Invalid service ID.' });

  try {
    const result = await changeManagedServicePassword(
      serviceId,
      {
        password: req.body?.password,
        generateRandom: Boolean(req.body?.generateRandom),
        syncApps: req.body?.syncApps !== false,
      },
      req.user?.role
    );
    void recordAudit({
      req,
      action: 'service.password_change',
      targetType: 'service',
      targetId: result.service.id,
      targetName: result.service.name,
      details: { syncedApps: result.syncedApps },
    });
    const appMsg = result.syncedApps.length > 0
      ? ` Updated env vars in: ${result.syncedApps.join(', ')} (redeploy apps to apply).`
      : '';
    return res.json({
      ...result,
      message: `Password updated for '${result.service.name}'.${appMsg}`,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Failed to change service password.' });
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
