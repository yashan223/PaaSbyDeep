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
import { sanitizeDomain, sanitizeEmail } from '../utils/sanitize.js';

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
    return res.json({ message: 'Dashboard settings updated.', settings: updated });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Failed to update dashboard settings.' });
  }
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

router.post('/docker/prune', requireRole('admin'), async (_req, res) => {
  try {
    const dockerUp = await checkDockerStatus();
    if (!dockerUp) {
      return res.status(400).json({ error: 'Docker engine is not running or unreachable.' });
    }
    const result = await docker.pruneImages({ filters: { dangling: { true: true } } });
    const bytes = Number(result?.SpaceReclaimed || 0);
    const deletedCount = Array.isArray(result?.ImagesDeleted) ? result.ImagesDeleted.length : 0;
    const mb = (bytes / (1024 ** 2)).toFixed(1);
    return res.json({
      message: `Docker image prune complete: ${deletedCount} image(s) removed, ${mb} MB reclaimed.`,
      spaceReclaimedBytes: bytes,
      deletedCount,
    });
  } catch (err) {
    console.error('[Settings] Docker prune error:', err.message);
    return res.status(500).json({ error: `Failed to prune Docker images: ${err.message}` });
  }
});

export default router;
