import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getDb } from '../db/database.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { recordAudit } from '../services/auditService.js';

const router = Router();
router.use(authenticate);
router.use(requireRole('admin'));

const VALID_ROLES = new Set(['admin', 'operator', 'viewer']);

function parseId(raw) {
  const id = Number.parseInt(raw, 10);
  if (!Number.isInteger(id) || id <= 0 || String(id) !== String(raw)) {
    return null;
  }
  return id;
}

function validateUsername(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return /^[a-zA-Z0-9._-]{3,40}$/.test(trimmed) ? trimmed : null;
}

async function countOtherActiveAdmins(sql, excludeUserId) {
  const rows = await sql`
    SELECT COUNT(*)::int AS count
    FROM users
    WHERE role = 'admin' AND is_active = true AND id <> ${excludeUserId}
  `;
  return Number(rows[0]?.count || 0);
}

router.get('/', async (_req, res) => {
  try {
    const sql = getDb();
    const users = await sql`
      SELECT id, username, role, is_active, last_login_at, created_at
      FROM users
      ORDER BY id ASC
    `;
    return res.json(users);
  } catch (err) {
    console.error('[Users] List error:', err.message);
    return res.status(500).json({ error: 'Failed to load users.' });
  }
});

router.post('/', async (req, res) => {
  const username = validateUsername(req.body?.username);
  const password = req.body?.password;
  const role = String(req.body?.role || 'operator').trim().toLowerCase();
  const isActive = req.body?.is_active !== false;

  if (!username) {
    return res.status(400).json({
      error: 'Username must be 3-40 characters (letters, numbers, dot, underscore, hyphen).',
    });
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    return res.status(400).json({ error: 'Password must be between 8 and 128 characters.' });
  }
  if (!VALID_ROLES.has(role)) {
    return res.status(400).json({ error: 'Role must be admin, operator, or viewer.' });
  }

  try {
    const sql = getDb();
    const hash = bcrypt.hashSync(password, 12);
    const rows = await sql`
      INSERT INTO users (username, password_hash, role, is_active, token_version)
      VALUES (${username}, ${hash}, ${role}, ${Boolean(isActive)}, 1)
      RETURNING id, username, role, is_active, last_login_at, created_at
    `;
    void recordAudit({
      req,
      action: 'user.create',
      targetType: 'user',
      targetId: rows[0].id,
      targetName: rows[0].username,
      details: { role: rows[0].role },
    });
    return res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505' || err.message?.includes('unique') || err.message?.includes('duplicate')) {
      return res.status(409).json({ error: `Username '${username}' already exists.` });
    }
    console.error('[Users] Create error:', err.message);
    return res.status(500).json({ error: 'Failed to create user.' });
  }
});

router.put('/:id', async (req, res) => {
  const userId = parseId(req.params.id);
  if (!userId) return res.status(400).json({ error: 'Invalid user ID.' });

  try {
    const sql = getDb();
    const rows = await sql`SELECT * FROM users WHERE id = ${userId}`;
    if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
    const existing = rows[0];

    const nextRole = req.body?.role !== undefined
      ? String(req.body.role).trim().toLowerCase()
      : (existing.role || 'admin');
    if (!VALID_ROLES.has(nextRole)) {
      return res.status(400).json({ error: 'Role must be admin, operator, or viewer.' });
    }

    const nextActive = req.body?.is_active !== undefined
      ? Boolean(req.body.is_active)
      : (existing.is_active !== false);

    if (userId === req.user.id && (!nextActive || nextRole !== 'admin')) {
      return res.status(400).json({ error: 'You cannot disable or demote your own active admin account.' });
    }

    if ((existing.role === 'admin' && existing.is_active !== false) && (nextRole !== 'admin' || !nextActive)) {
      const remainingAdmins = await countOtherActiveAdmins(sql, userId);
      if (remainingAdmins === 0) {
        return res.status(400).json({ error: 'At least one active admin account is required.' });
      }
    }

    let nextUsername = existing.username;
    if (req.body?.username !== undefined) {
      const cleanName = validateUsername(req.body.username);
      if (!cleanName) {
        return res.status(400).json({ error: 'Invalid username format.' });
      }
      nextUsername = cleanName;
    }

    let nextHash = existing.password_hash;
    let revokeTokens = nextRole !== existing.role || !nextActive;
    if (typeof req.body?.password === 'string' && req.body.password.length > 0) {
      if (req.body.password.length < 8 || req.body.password.length > 128) {
        return res.status(400).json({ error: 'Password must be between 8 and 128 characters.' });
      }
      nextHash = bcrypt.hashSync(req.body.password, 12);
      revokeTokens = true;
    }

    const nextTokenVersion = revokeTokens
      ? Number(existing.token_version || 1) + 1
      : Number(existing.token_version || 1);

    const updated = await sql`
      UPDATE users
      SET username = ${nextUsername},
          password_hash = ${nextHash},
          role = ${nextRole},
          is_active = ${nextActive},
          token_version = ${nextTokenVersion}
      WHERE id = ${userId}
      RETURNING id, username, role, is_active, last_login_at, created_at
    `;
    void recordAudit({
      req,
      action: 'user.update',
      targetType: 'user',
      targetId: updated[0].id,
      targetName: updated[0].username,
      details: { role: updated[0].role, is_active: updated[0].is_active },
    });
    return res.json(updated[0]);
  } catch (err) {
    if (err.code === '23505' || err.message?.includes('unique') || err.message?.includes('duplicate')) {
      return res.status(409).json({ error: 'That username is already taken.' });
    }
    console.error('[Users] Update error:', err.message);
    return res.status(500).json({ error: 'Failed to update user.' });
  }
});

router.delete('/:id', async (req, res) => {
  const userId = parseId(req.params.id);
  if (!userId) return res.status(400).json({ error: 'Invalid user ID.' });

  if (userId === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your currently logged-in account.' });
  }

  try {
    const sql = getDb();
    const rows = await sql`SELECT id, username, role, is_active FROM users WHERE id = ${userId}`;
    if (!rows[0]) return res.status(404).json({ error: 'User not found.' });

    if (rows[0].role === 'admin' && rows[0].is_active !== false) {
      const remainingAdmins = await countOtherActiveAdmins(sql, userId);
      if (remainingAdmins === 0) {
        return res.status(400).json({ error: 'Cannot delete the last active admin account.' });
      }
    }

    await sql`DELETE FROM users WHERE id = ${userId}`;
    void recordAudit({
      req,
      action: 'user.delete',
      targetType: 'user',
      targetId: rows[0].id,
      targetName: rows[0].username,
    });
    return res.json({ message: `User '${rows[0].username}' deleted.` });
  } catch (err) {
    console.error('[Users] Delete error:', err.message);
    return res.status(500).json({ error: 'Failed to delete user.' });
  }
});

export default router;
