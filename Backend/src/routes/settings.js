import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Docker from 'dockerode';
import { getDb } from '../db/database.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { getQueueStatus } from '../services/deploymentQueue.js';
import { getPlatformSettings, updatePlatformSettings } from '../services/settingsService.js';
import {
  generateDashboardNginxConfig,
  getDomainSystemStatus,
  installDashboardCertbotSsl,
} from '../services/domainManager.js';
import { broadcast } from '../services/ws.js';
import { sanitizeDomain, sanitizeEmail, sanitizeName, sanitizePort, sanitizeRepoUrl, sanitizeDockerfilePath } from '../utils/sanitize.js';
import { sendNotification } from '../services/notificationService.js';
import { recordAudit } from '../services/auditService.js';

const router = Router();
router.use(authenticate);

const docker = new Docker();

async function checkDockerStatus() {
  try {
    await Promise.race([
      docker.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
    ]);
    return true;
  } catch {
    return false;
  }
}

router.get('/', async (_req, res) => {
  try {
    const [settings, dockerConnected, domainSystem] = await Promise.all([
      getPlatformSettings(),
      checkDockerStatus(),
      getDomainSystemStatus(),
    ]);

    return res.json({
      settings,
      runtime: {
        nodeVersion: process.version,
        platform: process.platform,
        uptimeSeconds: Math.round(process.uptime()),
        port: Number(process.env.PORT || 3001),
        frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
        dockerConnected,
        queue: getQueueStatus(),
        domainSystem,
      },
    });
  } catch (err) {
    console.error('[Settings] Load error:', err.message);
    return res.status(500).json({ error: 'Failed to load dashboard settings.' });
  }
});

router.put('/', requireRole('admin'), async (req, res) => {
  try {
    const updated = await updatePlatformSettings(req.body || {});
    broadcast({ type: 'settings:changed', settings: updated });
    void recordAudit({
      req,
      action: 'settings.update',
      targetType: 'settings',
      targetName: updated.platform_name,
    });
    return res.json({ message: 'Dashboard settings updated.', settings: updated });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Failed to update dashboard settings.' });
  }
});

router.post('/notifications/test', requireRole('admin'), async (req, res) => {
  const result = await sendNotification({
    force: true,
    overrideWebhookUrl: req.body?.webhookUrl,
    event: 'test',
    status: 'info',
    title: 'PaaSbyDeep Test Notification',
    message: 'Webhook notifications are configured and active.',
    fields: [{ name: 'Triggered By', value: req.user?.username || 'admin' }],
  });

  if (!result.sent) {
    return res.status(400).json({ error: result.reason || 'Failed to deliver test notification.' });
  }

  void recordAudit({
    req,
    action: 'settings.notification_test',
    targetType: 'settings',
    targetName: 'Notification Webhook',
  });
  return res.json({ message: 'Test notification sent successfully.' });
});

router.put('/account', async (req, res) => {
  const { currentPassword, newUsername, newPassword } = req.body || {};

  if (!currentPassword || typeof currentPassword !== 'string') {
    return res.status(400).json({ error: 'Current password is required to update account credentials.' });
  }

  try {
    const sql = getDb();
    const rows = await sql`SELECT * FROM users WHERE id = ${req.user.id}`;
    if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
    const user = rows[0];

    if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    let nextUsername = user.username;
    if (typeof newUsername === 'string' && newUsername.trim()) {
      const cleanName = newUsername.trim();
      if (!/^[a-zA-Z0-9._-]{3,40}$/.test(cleanName)) {
        return res.status(400).json({
          error: 'Username must be 3-40 characters (letters, numbers, dot, underscore, hyphen).',
        });
      }
      nextUsername = cleanName;
    }

    let nextHash = user.password_hash;
    if (typeof newPassword === 'string' && newPassword.length > 0) {
      if (newPassword.length < 8 || newPassword.length > 128) {
        return res.status(400).json({ error: 'New password must be between 8 and 128 characters.' });
      }
      nextHash = bcrypt.hashSync(newPassword, 12);
    }

    const nextTokenVersion = Number(user.token_version || 1) + 1;
    await sql`
      UPDATE users
      SET username = ${nextUsername}, password_hash = ${nextHash}, token_version = ${nextTokenVersion}
      WHERE id = ${user.id}
    `;

    const role = user.role || 'admin';
    const token = jwt.sign(
      { id: user.id, username: nextUsername, role, tv: nextTokenVersion },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1d' }
    );

    return res.json({
      message: 'Account credentials updated.',
      token,
      id: user.id,
      username: nextUsername,
      role,
    });
  } catch (err) {
    if (err.code === '23505' || err.message?.includes('unique')) {
      return res.status(409).json({ error: 'That username is already taken.' });
    }
    console.error('[Settings] Account update error:', err.message);
    return res.status(500).json({ error: 'Failed to update account credentials.' });
  }
});

router.get('/dashboard-nginx-config', async (req, res) => {
  try {
    const settings = await getPlatformSettings();
    const domain = sanitizeDomain(req.query.domain || settings.dashboard_domain);
    if (!domain) {
      return res.status(400).json({ error: 'Enter a valid dashboard domain first.' });
    }
    const config = generateDashboardNginxConfig({
      domain,
      backendPort: Number(process.env.PORT || 3001),
    });
    return res.json({
      domain,
      config,
      certbotCommand: `sudo certbot --nginx -d ${domain}`,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Failed to generate config.' });
  }
});

router.post('/dashboard-ssl', requireRole('admin'), async (req, res) => {
  try {
    const settings = await getPlatformSettings();
    const domain = sanitizeDomain(req.body?.domain || settings.dashboard_domain);
    const email = sanitizeEmail(req.body?.email || settings.certbot_email || process.env.CERTBOT_EMAIL);

    if (!domain) {
      return res.status(400).json({ error: 'Please provide a valid dashboard domain name.' });
    }
    if (!email) {
      return res.status(400).json({ error: "Please provide a valid Certbot email address." });
    }

    const result = await installDashboardCertbotSsl({
      domain,
      email,
      backendPort: Number(process.env.PORT || 3001),
      redirect: req.body?.redirect !== false,
    });

    const sql = getDb();
    const rows = await sql`
      UPDATE platform_settings
      SET dashboard_domain = ${domain},
          dashboard_ssl_enabled = true,
          dashboard_ssl_expires = ${result.expiresAt},
          certbot_email = ${email},
          public_url = CASE WHEN COALESCE(public_url, '') = '' THEN ${`https://${domain}`} ELSE public_url END,
          updated_at = NOW()
      WHERE id = 1
      RETURNING *
    `;

    broadcast({ type: 'settings:changed', settings: rows[0] });
    return res.json({
      message: `SSL certificate installed for dashboard domain ${domain}.`,
      settings: rows[0],
      log: result.log,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message, log: err.certLog || '' });
  }
});

router.get('/docker/df', requireRole('admin'), async (_req, res) => {
  try {
    const dockerUp = await checkDockerStatus();
    if (!dockerUp) {
      return res.json({ available: false });
    }
    const df = await docker.df();
    const sumSizes = (arr, key = 'Size') => (Array.isArray(arr) ? arr.reduce((acc, x) => acc + Math.max(0, Number(x?.[key] || 0)), 0) : 0);
    const imagesBytes = sumSizes(df.Images, 'Size');
    const containersBytes = sumSizes(df.Containers, 'SizeRw');
    const volumesBytes = Array.isArray(df.Volumes)
      ? df.Volumes.reduce((acc, v) => acc + Math.max(0, Number(v?.UsageData?.Size || 0)), 0)
      : 0;
    const buildCacheBytes = sumSizes(df.BuildCache, 'Size');

    return res.json({
      available: true,
      imagesCount: Array.isArray(df.Images) ? df.Images.length : 0,
      containersCount: Array.isArray(df.Containers) ? df.Containers.length : 0,
      volumesCount: Array.isArray(df.Volumes) ? df.Volumes.length : 0,
      imagesBytes,
      containersBytes,
      volumesBytes,
      buildCacheBytes,
    });
  } catch (err) {
    return res.json({ available: false, reason: err.message });
  }
});

router.post('/docker/prune', requireRole('admin'), async (req, res) => {
  try {
    const dockerUp = await checkDockerStatus();
    if (!dockerUp) {
      return res.status(400).json({ error: 'Docker engine is not running or unreachable.' });
    }
    const imgResult = await docker.pruneImages({ filters: { dangling: { true: true } } });
    let buildCacheBytes = 0;
    try {
      if (typeof docker.pruneBuilder === 'function') {
        const buildResult = await docker.pruneBuilder();
        buildCacheBytes = Number(buildResult?.SpaceReclaimed || 0);
      }
    } catch {
    }

    const bytes = Number(imgResult?.SpaceReclaimed || 0) + buildCacheBytes;
    const deletedCount = Array.isArray(imgResult?.ImagesDeleted) ? imgResult.ImagesDeleted.length : 0;
    const mb = (bytes / (1024 ** 2)).toFixed(1);

    void recordAudit({
      req,
      action: 'system.docker_prune',
      targetType: 'system',
      targetName: 'Docker Engine',
      details: { deletedCount, reclaimedBytes: bytes },
    });

    return res.json({
      message: `Docker cleanup complete: ${deletedCount} dangling image(s) removed, ${mb} MB reclaimed.`,
      spaceReclaimedBytes: bytes,
      deletedCount,
    });
  } catch (err) {
    console.error('[Settings] Docker prune error:', err.message);
    return res.status(500).json({ error: `Failed to prune Docker images: ${err.message}` });
  }
});

router.get('/backup', requireRole('admin'), async (req, res) => {
  try {
    const sql = getDb();
    const [settings, apps, domains] = await Promise.all([
      getPlatformSettings(),
      sql`
        SELECT name, repo_url, branch, dockerfile_path, port, env_vars, project_type,
               memory_limit_mb, cpu_limit, health_check_path, volumes
        FROM applications ORDER BY id ASC
      `,
      sql`
        SELECT d.domain, a.name AS app_name, d.ssl_enabled
        FROM domains d JOIN applications a ON a.id = d.app_id ORDER BY d.id ASC
      `,
    ]);

    void recordAudit({
      req,
      action: 'system.backup_export',
      targetType: 'system',
      targetName: 'Platform Backup',
      details: { appCount: apps.length, domainCount: domains.length },
    });

    return res.json({
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: {
        platform_name: settings.platform_name,
        public_url: settings.public_url,
        dashboard_domain: settings.dashboard_domain,
        certbot_email: settings.certbot_email,
        default_memory_mb: settings.default_memory_mb,
        max_deployments_retain: settings.max_deployments_retain,
        notification_events: settings.notification_events,
      },
      applications: apps,
      domains,
    });
  } catch (err) {
    console.error('[Settings] Backup export error:', err.message);
    return res.status(500).json({ error: 'Failed to export backup manifest.' });
  }
});

router.post('/backup/restore', requireRole('admin'), async (req, res) => {
  const manifest = req.body;
  if (!manifest || typeof manifest !== 'object' || Number(manifest.version) !== 1) {
    return res.status(400).json({ error: 'Invalid backup manifest format (expected version: 1).' });
  }

  try {
    if (manifest.settings && typeof manifest.settings === 'object') {
      await updatePlatformSettings(manifest.settings);
    }

    const sql = getDb();
    let importedApps = 0;
    let skippedApps = 0;

    if (Array.isArray(manifest.applications)) {
      for (const appItem of manifest.applications.slice(0, 100)) {
        const safeName = sanitizeName(String(appItem?.name || ''));
        const safeRepo = sanitizeRepoUrl(String(appItem?.repo_url || ''));
        const safePort = sanitizePort(appItem?.port);
        const safeDf = sanitizeDockerfilePath(String(appItem?.dockerfile_path || 'Dockerfile')) || 'Dockerfile';
        if (!safeName || !safeRepo || !safePort) {
          skippedApps += 1;
          continue;
        }
        const existing = await sql`SELECT id FROM applications WHERE name = ${safeName}`;
        if (existing.length > 0) {
          skippedApps += 1;
          continue;
        }
        const envObj = typeof appItem.env_vars === 'object' && appItem.env_vars !== null ? appItem.env_vars : {};
        const volsArr = Array.isArray(appItem.volumes) ? appItem.volumes : [];
        await sql`
          INSERT INTO applications (
            name, repo_url, branch, dockerfile_path, port, env_vars, project_type,
            memory_limit_mb, cpu_limit, health_check_path, volumes, status
          )
          VALUES (
            ${safeName}, ${safeRepo},
            ${String(appItem.branch || 'main').slice(0, 100)},
            ${safeDf}, ${safePort},
            ${JSON.stringify(envObj)}::jsonb,
            ${String(appItem.project_type || 'auto').slice(0, 30)},
            ${appItem.memory_limit_mb ?? null},
            ${appItem.cpu_limit ?? null},
            ${String(appItem.health_check_path || '').slice(0, 120)},
            ${JSON.stringify(volsArr)}::jsonb,
            'stopped'
          )
        `;
        importedApps += 1;
      }
    }

    broadcast({ type: 'apps:changed', action: 'imported' });
    broadcast({ type: 'settings:changed' });
    void recordAudit({
      req,
      action: 'system.backup_restore',
      targetType: 'system',
      targetName: 'Platform Backup',
      details: { importedApps, skippedApps },
    });

    return res.json({
      message: `Backup restored: ${importedApps} app(s) imported, ${skippedApps} skipped.`,
      importedApps,
      skippedApps,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Failed to restore backup manifest.' });
  }
});

export default router;
