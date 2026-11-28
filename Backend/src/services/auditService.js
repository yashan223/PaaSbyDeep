import { getDb } from '../db/database.js';
import { broadcast } from './ws.js';

const SENSITIVE_KEY_PATTERN = /TOKEN|SECRET|KEY|PASSWORD|PASSWD|PASS|CREDENTIAL|AUTH|WEBHOOK/i;

function sanitizeDetails(raw) {
  if (!raw || typeof raw !== 'object') return {};
  if (Array.isArray(raw)) {
    return raw.slice(0, 50).map((item) => (typeof item === 'object' && item !== null ? sanitizeDetails(item) : item));
  }
  const cleaned = {};
  for (const [k, v] of Object.entries(raw)) {
    if (SENSITIVE_KEY_PATTERN.test(k) && v) {
      cleaned[k] = '[REDACTED]';
    } else if (typeof v === 'object' && v !== null) {
      cleaned[k] = sanitizeDetails(v);
    } else {
      cleaned[k] = v;
    }
  }
  return cleaned;
}

/**
 * Record an operational or security audit entry without throwing to callers.
 */
export async function recordAudit({
  req = null,
  user = null,
  action,
  targetType,
  targetId = null,
  targetName = null,
  details = {},
}) {
  if (!action || !targetType) return null;

  try {
    const sql = getDb();
    const actor = user || req?.user || null;
    const userId = actor?.id ? Number(actor.id) : null;
    const username = actor?.username ? String(actor.username).slice(0, 60) : 'system';
    const ipAddress = req?.ip ? String(req.ip).slice(0, 64) : null;
    const safeDetails = sanitizeDetails(details);

    const rows = await sql`
      INSERT INTO audit_logs (user_id, username, action, target_type, target_id, target_name, details, ip_address)
      VALUES (
        ${userId},
        ${username},
        ${String(action).slice(0, 80)},
        ${String(targetType).slice(0, 40)},
        ${targetId !== null && targetId !== undefined ? String(targetId).slice(0, 40) : null},
        ${targetName ? String(targetName).slice(0, 120) : null},
        ${JSON.stringify(safeDetails)}::jsonb,
        ${ipAddress}
      )
      RETURNING *
    `;

    if (rows[0]) {
      broadcast({ type: 'audit:new', entry: rows[0] });
    }
    return rows[0] || null;
  } catch (err) {
    console.warn('[Audit] Failed to record audit log:', err.message);
    return null;
  }
}
