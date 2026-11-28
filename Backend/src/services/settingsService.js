import { getDb } from '../db/database.js';
import { sanitizeDomain, sanitizeEmail } from '../utils/sanitize.js';

const DEFAULT_NOTIFICATION_EVENTS = {
  deploy_success: true,
  deploy_failed: true,
  app_unhealthy: true,
};

const DEFAULT_SETTINGS = {
  id: 1,
  platform_name: 'PaaSbyDeep',
  public_url: '',
  dashboard_domain: '',
  dashboard_ssl_enabled: false,
  dashboard_ssl_expires: null,
  certbot_email: '',
  default_memory_mb: 512,
  max_deployments_retain: 20,
  notification_webhook_url: '',
  notification_events: DEFAULT_NOTIFICATION_EVENTS,
};

function sanitizeNotificationWebhookUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Notification webhook URL must use http:// or https://.');
    }
    return parsed.toString();
  } catch {
    throw new Error('Invalid notification webhook URL.');
  }
}

function normalizeNotificationEvents(raw, fallback = DEFAULT_NOTIFICATION_EVENTS) {
  const base = { ...DEFAULT_NOTIFICATION_EVENTS, ...(fallback || {}) };
  if (!raw || typeof raw !== 'object') return base;
  return {
    deploy_success: raw.deploy_success !== undefined ? Boolean(raw.deploy_success) : base.deploy_success,
    deploy_failed: raw.deploy_failed !== undefined ? Boolean(raw.deploy_failed) : base.deploy_failed,
    app_unhealthy: raw.app_unhealthy !== undefined ? Boolean(raw.app_unhealthy) : base.app_unhealthy,
  };
}

function sanitizePublicUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Public URL must use http:// or https://.');
    }
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/+$/, '');
  } catch {
    throw new Error('Invalid Public URL. Example: https://paas.yourdomain.com');
  }
}

/**
 * Fetch the singleton platform settings row, seeding defaults if missing.
 */
export async function getPlatformSettings() {
  const sql = getDb();
  await sql`INSERT INTO platform_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
  const rows = await sql`SELECT * FROM platform_settings WHERE id = 1`;
  const row = rows[0] || {};
  return {
    ...DEFAULT_SETTINGS,
    ...row,
    notification_events: normalizeNotificationEvents(row.notification_events, DEFAULT_NOTIFICATION_EVENTS),
  };
}

/**
 * Validate and update general/runtime platform settings.
 */
export async function updatePlatformSettings(input = {}) {
  const current = await getPlatformSettings();

  let platformName = current.platform_name;
  if (input.platform_name !== undefined || input.platformName !== undefined) {
    const rawName = String(input.platform_name ?? input.platformName ?? '').trim().slice(0, 40);
    if (!rawName) throw new Error('Platform name cannot be empty.');
    platformName = rawName;
  }

  let publicUrl = current.public_url;
  if (input.public_url !== undefined || input.publicUrl !== undefined) {
    publicUrl = sanitizePublicUrl(input.public_url ?? input.publicUrl);
  }

  let certbotEmail = current.certbot_email;
  if (input.certbot_email !== undefined || input.certbotEmail !== undefined) {
    const rawEmail = String(input.certbot_email ?? input.certbotEmail ?? '').trim();
    if (rawEmail) {
      const validEmail = sanitizeEmail(rawEmail);
      if (!validEmail) throw new Error('Invalid Certbot email address.');
      certbotEmail = validEmail;
    } else {
      certbotEmail = '';
    }
  }

  let dashboardDomain = current.dashboard_domain;
  if (input.dashboard_domain !== undefined || input.dashboardDomain !== undefined) {
    const rawDomain = String(input.dashboard_domain ?? input.dashboardDomain ?? '').trim();
    if (rawDomain) {
      const validDomain = sanitizeDomain(rawDomain);
      if (!validDomain) throw new Error('Invalid dashboard domain name.');
      dashboardDomain = validDomain;
    } else {
      dashboardDomain = '';
    }
  }

  let defaultMemoryMb = current.default_memory_mb;
  if (input.default_memory_mb !== undefined || input.defaultMemoryMb !== undefined) {
    const mem = Number.parseInt(input.default_memory_mb ?? input.defaultMemoryMb, 10);
    if (!Number.isInteger(mem) || mem < 128 || mem > 8192) {
      throw new Error('Default container memory must be between 128 and 8192 MB.');
    }
    defaultMemoryMb = mem;
  }

  let maxDeploymentsRetain = current.max_deployments_retain;
  if (input.max_deployments_retain !== undefined || input.maxDeploymentsRetain !== undefined) {
    const retain = Number.parseInt(input.max_deployments_retain ?? input.maxDeploymentsRetain, 10);
    if (!Number.isInteger(retain) || retain < 5 || retain > 100) {
      throw new Error('Deployment history retention must be between 5 and 100.');
    }
    maxDeploymentsRetain = retain;
  }

  let notificationWebhookUrl = current.notification_webhook_url || '';
  if (input.notification_webhook_url !== undefined || input.notificationWebhookUrl !== undefined) {
    notificationWebhookUrl = sanitizeNotificationWebhookUrl(
      input.notification_webhook_url ?? input.notificationWebhookUrl
    );
  }

  const notificationEvents = normalizeNotificationEvents(
    input.notification_events ?? input.notificationEvents,
    current.notification_events
  );

  const sql = getDb();
  await sql`INSERT INTO platform_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
  const rows = await sql`
    UPDATE platform_settings
    SET platform_name = ${platformName},
        public_url = ${publicUrl},
        dashboard_domain = ${dashboardDomain},
        certbot_email = ${certbotEmail},
        default_memory_mb = ${defaultMemoryMb},
        max_deployments_retain = ${maxDeploymentsRetain},
        notification_webhook_url = ${notificationWebhookUrl},
        notification_events = ${JSON.stringify(notificationEvents)}::jsonb,
        updated_at = NOW()
    WHERE id = 1
    RETURNING *
  `;
  return rows[0];
}
