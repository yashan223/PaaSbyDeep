import { Router } from 'express';
import { getDb } from '../db/database.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { broadcast } from '../services/ws.js';
import { sanitizeDomain, sanitizeEmail } from '../utils/sanitize.js';
import { getPlatformSettings } from '../services/settingsService.js';
import { recordAudit } from '../services/auditService.js';
import {
  checkDomainDns,
  generateNginxConfig,
  getDomainSystemStatus,
  getNginxFileName,
  installCertbotSsl,
  readLocalCertInfo,
  removeDomainNginxConfig,
  renewAllCertbotSsl,
  syncDomainNginxConfig,
} from '../services/domainManager.js';

const router = Router();
router.use(authenticate);

function parseId(raw) {
  const id = Number.parseInt(raw, 10);
  if (!Number.isInteger(id) || id <= 0 || String(id) !== String(raw)) {
    return null;
  }
  return id;
}

router.get('/system', async (_req, res) => {
  try {
    const [status, settings] = await Promise.all([
      getDomainSystemStatus(),
      getPlatformSettings().catch(() => ({})),
    ]);
    return res.json({
      ...status,
      certbotEmailConfigured: Boolean(status.certbotEmailConfigured || sanitizeEmail(settings.certbot_email)),
    });
  } catch (err) {
    console.error('[Domains] System probe error:', err.message);
    return res.status(500).json({ error: 'Failed to inspect server domain/SSL capabilities.' });
  }
});

router.get('/dns-check', async (req, res) => {
  const safeDomain = sanitizeDomain(req.query?.domain);
  if (!safeDomain) {
    return res.status(400).json({ error: 'Valid domain query parameter is required.' });
  }
  try {
    const dnsResult = await checkDomainDns(safeDomain);
    return res.json(dnsResult);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'DNS check failed.' });
  }
});

router.get('/', async (_req, res) => {
  try {
    const sql = getDb();
    const rows = await sql`
      SELECT d.*, a.name AS app_name, a.port AS app_port, a.status AS app_status
      FROM domains d
      JOIN applications a ON a.id = d.app_id
      ORDER BY d.created_at DESC
    `;
    return res.json(rows);
  } catch (err) {
    console.error('[Domains] List error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch domains.' });
  }
});

router.get('/app/:appId', async (req, res) => {
  const appId = parseId(req.params.appId);
  if (!appId) return res.status(400).json({ error: 'Invalid application ID.' });

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT d.*, a.name AS app_name, a.port AS app_port, a.status AS app_status
      FROM domains d
      JOIN applications a ON a.id = d.app_id
      WHERE d.app_id = ${appId}
      ORDER BY d.created_at DESC
    `;
    return res.json(rows);
  } catch (err) {
    console.error('[Domains] List by app error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch application domains.' });
  }
});

router.post('/', requireRole('admin', 'operator'), async (req, res) => {
  const appId = parseId(req.body?.appId ?? req.body?.app_id);
  const safeDomain = sanitizeDomain(req.body?.domain);

  if (!appId) return res.status(400).json({ error: 'Valid application ID is required.' });
  if (!safeDomain) {
    return res.status(400).json({
      error: 'Invalid domain name. Enter a valid domain such as app.example.com (no protocol or port).',
    });
  }

  try {
    const sql = getDb();
    const appRows = await sql`SELECT id, name, port FROM applications WHERE id = ${appId}`;
    if (!appRows[0]) return res.status(404).json({ error: 'Application not found.' });
    const app = appRows[0];

    let nginxConfigured = false;
    let nginxWarning = null;
    try {
      const syncResult = await syncDomainNginxConfig({
        domain: safeDomain,
        port: app.port,
        appName: app.name,
      });
      nginxConfigured = Boolean(syncResult.configured);
      nginxWarning = syncResult.warning || null;
    } catch (syncErr) {
      nginxWarning = syncErr.message;
    }

    const localCert = readLocalCertInfo(safeDomain);
    const sslEnabled = localCert.exists;
    const sslStatus = localCert.exists ? 'active' : 'none';

    const inserted = await sql`
      INSERT INTO domains (app_id, domain, ssl_enabled, ssl_status, cert_expires_at, nginx_configured)
      VALUES (${app.id}, ${safeDomain}, ${sslEnabled}, ${sslStatus}, ${localCert.expiresAt}, ${nginxConfigured})
      RETURNING *
    `;

    const dnsCheck = await checkDomainDns(safeDomain).catch(() => null);

    const record = {
      ...inserted[0],
      app_name: app.name,
      app_port: app.port,
      ...(dnsCheck ? { dns: dnsCheck } : {}),
      ...(nginxWarning ? { nginxWarning } : {}),
    };

    broadcast({ type: 'domains:changed', action: 'created', appId: app.id, domain: safeDomain });
    void recordAudit({
      req,
      action: 'domain.create',
      targetType: 'domain',
      targetId: inserted[0].id,
      targetName: safeDomain,
      details: { appName: app.name },
    });
    return res.status(201).json(record);
  } catch (err) {
    if (err.code === '23505' || err.message?.includes('unique') || err.message?.includes('duplicate')) {
      return res.status(409).json({ error: `Domain '${safeDomain}' is already assigned.` });
    }
    console.error('[Domains] Create error:', err.message);
    return res.status(500).json({ error: 'Failed to add domain.' });
  }
});

router.get('/:id/nginx-config', async (req, res) => {
  const domainId = parseId(req.params.id);
  if (!domainId) return res.status(400).json({ error: 'Invalid domain ID.' });

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT d.*, a.name AS app_name, a.port AS app_port
      FROM domains d
      JOIN applications a ON a.id = d.app_id
      WHERE d.id = ${domainId}
    `;
    if (!rows[0]) return res.status(404).json({ error: 'Domain not found.' });
    const row = rows[0];

    const config = generateNginxConfig({
      domain: row.domain,
      port: row.app_port,
      appName: row.app_name,
      forceHttpsBlock: false,
    });
    const fileName = getNginxFileName(row.domain);

    return res.json({
      domain: row.domain,
      port: row.app_port,
      fileName,
      config,
      certbotCommand: `sudo certbot --nginx -d ${row.domain}`,
    });
  } catch (err) {
    console.error('[Domains] Config preview error:', err.message);
    return res.status(500).json({ error: 'Failed to generate Nginx config.' });
  }
});

router.post('/:id/nginx-sync', requireRole('admin', 'operator'), async (req, res) => {
  const domainId = parseId(req.params.id);
  if (!domainId) return res.status(400).json({ error: 'Invalid domain ID.' });

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT d.*, a.name AS app_name, a.port AS app_port
      FROM domains d
      JOIN applications a ON a.id = d.app_id
      WHERE d.id = ${domainId}
    `;
    if (!rows[0]) return res.status(404).json({ error: 'Domain not found.' });
    const row = rows[0];

    const syncRes = await syncDomainNginxConfig({
      domain: row.domain,
      port: row.app_port,
      appName: row.app_name,
    });

    const updated = await sql`
      UPDATE domains
      SET nginx_configured = ${Boolean(syncRes.configured)}, updated_at = NOW()
      WHERE id = ${domainId}
      RETURNING *
    `;

    broadcast({ type: 'domains:changed', action: 'synced', appId: row.app_id, domain: row.domain });

    if (!syncRes.configured) {
      return res.status(400).json({
        error: syncRes.warning || 'Nginx is not available on this host.',
        domain: { ...updated[0], app_name: row.app_name, app_port: row.app_port },
        config: syncRes.configContent,
      });
    }

    return res.json({
      message: `Nginx configured and reloaded for ${row.domain}.`,
      domain: { ...updated[0], app_name: row.app_name, app_port: row.app_port },
    });
  } catch (err) {
    console.error('[Domains] Nginx sync error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to configure Nginx.' });
  }
});

router.post('/:id/ssl', requireRole('admin', 'operator'), async (req, res) => {
  const domainId = parseId(req.params.id);
  if (!domainId) return res.status(400).json({ error: 'Invalid domain ID.' });

  const settings = await getPlatformSettings().catch(() => ({}));
  const emailInput = req.body?.email || settings.certbot_email || process.env.CERTBOT_EMAIL;
  const safeEmail = sanitizeEmail(emailInput);
  if (!safeEmail) {
    return res.status(400).json({
      error: "Please provide a valid email address for Let's Encrypt SSL certificate notifications.",
    });
  }

  const redirect = req.body?.redirect !== false;
  const forceRenew = Boolean(req.body?.forceRenew);

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT d.*, a.name AS app_name, a.port AS app_port
      FROM domains d
      JOIN applications a ON a.id = d.app_id
      WHERE d.id = ${domainId}
    `;
    if (!rows[0]) return res.status(404).json({ error: 'Domain not found.' });
    const row = rows[0];

    await sql`
      UPDATE domains SET ssl_status = 'pending', last_cert_error = NULL, updated_at = NOW()
      WHERE id = ${domainId}
    `;
    broadcast({ type: 'domains:changed', action: 'ssl-pending', appId: row.app_id, domain: row.domain });

    try {
      const result = await installCertbotSsl({
        domain: row.domain,
        port: row.app_port,
        appName: row.app_name,
        email: safeEmail,
        redirect,
        forceRenew,
      });

      const updated = await sql`
        UPDATE domains
        SET ssl_enabled = true,
            ssl_status = 'active',
            nginx_configured = true,
            cert_expires_at = ${result.certExpiresAt},
            last_cert_error = NULL,
            last_cert_log = ${result.log},
            updated_at = NOW()
        WHERE id = ${domainId}
        RETURNING *
      `;

      broadcast({ type: 'domains:changed', action: 'ssl-active', appId: row.app_id, domain: row.domain });
      console.log(`[SSL] Certbot installed certificate for ${row.domain}`);
      void recordAudit({
        req,
        action: 'domain.ssl_install',
        targetType: 'domain',
        targetId: domainId,
        targetName: row.domain,
      });

      return res.json({
        message: `SSL certificate installed for ${row.domain}.`,
        domain: { ...updated[0], app_name: row.app_name, app_port: row.app_port },
        log: result.log,
      });
    } catch (certErr) {
      const certLog = certErr.certLog || certErr.message;
      await sql`
        UPDATE domains
        SET ssl_status = CASE WHEN ssl_enabled THEN 'active' ELSE 'failed' END,
            last_cert_error = ${certErr.message},
            last_cert_log = ${certLog},
            updated_at = NOW()
        WHERE id = ${domainId}
      `;
      broadcast({ type: 'domains:changed', action: 'ssl-failed', appId: row.app_id, domain: row.domain });
      console.error(`[SSL] Certbot failed for ${row.domain}:`, certErr.message);

      return res.status(400).json({
        error: certErr.message,
        log: certLog,
      });
    }
  } catch (err) {
    console.error('[Domains] SSL install error:', err.message);
    return res.status(500).json({ error: 'Failed to install SSL certificate.' });
  }
});

router.post('/renew', requireRole('admin', 'operator'), async (_req, res) => {
  try {
    const result = await renewAllCertbotSsl();
    const sql = getDb();
    const allDomains = await sql`SELECT id, domain FROM domains WHERE ssl_enabled = true`;

    for (const row of allDomains) {
      const info = readLocalCertInfo(row.domain);
      if (info.exists && info.expiresAt) {
        await sql`
          UPDATE domains
          SET cert_expires_at = ${info.expiresAt}, ssl_status = 'active', updated_at = NOW()
          WHERE id = ${row.id}
        `;
      }
    }

    broadcast({ type: 'domains:changed', action: 'renewed' });
    return res.json({ message: 'Certbot renewal completed.', output: result.output });
  } catch (err) {
    console.error('[SSL] Renew all error:', err.message);
    return res.status(400).json({ error: err.message, output: err.certLog || '' });
  }
});

router.delete('/:id', requireRole('admin', 'operator'), async (req, res) => {
  const domainId = parseId(req.params.id);
  if (!domainId) return res.status(400).json({ error: 'Invalid domain ID.' });

  try {
    const sql = getDb();
    const rows = await sql`SELECT * FROM domains WHERE id = ${domainId}`;
    if (!rows[0]) return res.status(404).json({ error: 'Domain not found.' });
    const row = rows[0];

    await removeDomainNginxConfig(row.domain);
    await sql`DELETE FROM domains WHERE id = ${domainId}`;

    broadcast({ type: 'domains:changed', action: 'deleted', appId: row.app_id, domain: row.domain });
    void recordAudit({
      req,
      action: 'domain.delete',
      targetType: 'domain',
      targetId: row.id,
      targetName: row.domain,
    });
    return res.json({ message: `Domain '${row.domain}' removed.` });
  } catch (err) {
    console.error('[Domains] Delete error:', err.message);
    return res.status(500).json({ error: 'Failed to remove domain.' });
  }
});

export default router;
