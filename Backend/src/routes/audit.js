import { Router } from 'express';
import { getDb } from '../db/database.js';
import { authenticate, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(authenticate);
router.use(requireRole('admin'));

router.get('/', async (req, res) => {
  const limitRaw = Number.parseInt(req.query.limit ?? '50', 10);
  const offsetRaw = Number.parseInt(req.query.offset ?? '0', 10);
  const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
  const offset = Number.isInteger(offsetRaw) ? Math.max(offsetRaw, 0) : 0;

  const targetType = String(req.query.targetType || '').trim();
  const q = String(req.query.q || '').trim().toLowerCase();
  const qPattern = `%${q}%`;

  try {
    const sql = getDb();
    const [entries, countRows] = await Promise.all([
      sql`
        SELECT id, user_id, username, action, target_type, target_id, target_name, details, ip_address, created_at
        FROM audit_logs
        WHERE (${targetType} = '' OR target_type = ${targetType})
          AND (${q} = '' OR LOWER(username) LIKE ${qPattern} OR LOWER(action) LIKE ${qPattern} OR LOWER(COALESCE(target_name, '')) LIKE ${qPattern})
        ORDER BY id DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
      sql`
        SELECT COUNT(*)::int AS total
        FROM audit_logs
        WHERE (${targetType} = '' OR target_type = ${targetType})
          AND (${q} = '' OR LOWER(username) LIKE ${qPattern} OR LOWER(action) LIKE ${qPattern} OR LOWER(COALESCE(target_name, '')) LIKE ${qPattern})
      `,
    ]);

    const total = Number(countRows[0]?.total || 0);
    return res.json({
      entries,
      total,
      limit,
      offset,
      hasMore: offset + entries.length < total,
    });
  } catch (err) {
    console.error('[Audit] List error:', err.message);
    return res.status(500).json({ error: 'Failed to load audit logs.' });
  }
});

export default router;
