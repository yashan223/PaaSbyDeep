import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getDb } from '../db/database.js';
import { authenticate } from '../middleware/auth.js';
import { recordAudit } from '../services/auditService.js';

const router = Router();

router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Invalid input.' });
  }

  try {
    const sql = getDb();
    const rows = await sql`SELECT * FROM users WHERE username = ${username.trim()}`;
    const user = rows[0];

    if (!user) return res.status(401).json({ error: 'Invalid credentials.' });

    const valid = bcrypt.compareSync(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials.' });

    if (user.is_active === false) {
      return res.status(403).json({ error: 'Account is disabled. Contact an administrator.' });
    }

    await sql`UPDATE users SET last_login_at = NOW() WHERE id = ${user.id}`;

    const role = user.role || 'admin';
    const tokenVersion = Number(user.token_version || 1);
    const token = jwt.sign(
      { id: user.id, username: user.username, role, tv: tokenVersion },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1d' }
    );

    void recordAudit({
      req,
      user: { id: user.id, username: user.username, role },
      action: 'auth.login',
      targetType: 'user',
      targetId: user.id,
      targetName: user.username,
    });

    return res.json({
      token,
      id: user.id,
      username: user.username,
      role,
    });
  } catch (err) {
    console.error('[Auth] Login error:', err.message);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

router.get('/me', authenticate, async (req, res) => {
  try {
    const sql = getDb();
    const rows = await sql`
      SELECT id, username, role, is_active, last_login_at, created_at
      FROM users
      WHERE id = ${req.user.id}
    `;
    if (!rows[0]) return res.status(404).json({ error: 'User not found.' });
    return res.json(rows[0]);
  } catch (err) {
    console.error('[Auth] Me error:', err.message);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

export default router;
