import { getPlatformSettings } from './settingsService.js';

function resolveColorInt(status) {
  if (status === 'success' || status === 'healthy') return 0x2ea043;
  if (status === 'error' || status === 'failed' || status === 'unhealthy') return 0xda3633;
  return 0x1f6feb;
}

function buildWebhookPayload({ platformName, webhookUrl, event, status, title, message, fields }) {
  const safeFields = Array.isArray(fields)
    ? fields.filter((f) => f && f.name && f.value !== undefined).map((f) => ({
        name: String(f.name).slice(0, 80),
        value: String(f.value).slice(0, 500),
        inline: true,
      }))
    : [];

  let host = '';
  try {
    host = new URL(webhookUrl).hostname.toLowerCase();
  } catch {
    host = '';
  }

  // Discord webhook format
  if (host === 'discord.com' || host.endsWith('.discord.com') || host === 'discordapp.com') {
    return {
      username: platformName || 'PaaSbyDeep',
      embeds: [
        {
          title: String(title || event),
          description: String(message || ''),
          color: resolveColorInt(status),
          fields: safeFields,
          timestamp: new Date().toISOString(),
        },
      ],
    };
  }

  // Slack incoming webhook format
  if (host === 'hooks.slack.com') {
    const colorHex = status === 'success' || status === 'healthy'
      ? '#2ea043'
      : status === 'error' || status === 'failed' || status === 'unhealthy'
        ? '#da3633'
        : '#1f6feb';
    return {
      text: `*${title || event}* — ${message || ''}`,
      attachments: [
        {
          color: colorHex,
          fields: safeFields.map((f) => ({ title: f.name, value: f.value, short: true })),
          footer: platformName || 'PaaSbyDeep',
          ts: Math.floor(Date.now() / 1000),
        },
      ],
    };
  }

  // Generic JSON webhook payload
  return {
    event,
    status,
    platform: platformName || 'PaaSbyDeep',
    title,
    message,
    fields: safeFields,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Dispatch an outbound notification webhook if configured and enabled for the event type.
 */
export async function sendNotification({
  event,
  status = 'info',
  title,
  message,
  fields = [],
  force = false,
  overrideWebhookUrl = null,
}) {
  try {
    const settings = await getPlatformSettings().catch(() => ({}));
    const webhookUrl = String(overrideWebhookUrl ?? settings.notification_webhook_url ?? '').trim();
    if (!webhookUrl) {
      return { sent: false, reason: 'No notification webhook URL configured.' };
    }

    const parsed = new URL(webhookUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { sent: false, reason: 'Webhook URL must use http:// or https://.' };
    }

    const events = typeof settings.notification_events === 'object' && settings.notification_events !== null
      ? settings.notification_events
      : {};

    if (!force && event && events[event] === false) {
      return { sent: false, reason: `Event '${event}' is disabled in notification settings.` };
    }

    const payload = buildWebhookPayload({
      platformName: settings.platform_name || 'PaaSbyDeep',
      webhookUrl,
      event,
      status,
      title,
      message,
      fields,
    });

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return {
        sent: false,
        statusCode: response.status,
        reason: `Webhook responded with HTTP ${response.status}${errText ? `: ${errText.slice(0, 120)}` : ''}`,
      };
    }

    return { sent: true, statusCode: response.status };
  } catch (err) {
    console.warn(`[Notify] Failed sending notification (${event}):`, err.message);
    return { sent: false, reason: err.message };
  }
}
