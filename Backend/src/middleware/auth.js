import jwt from 'jsonwebtoken';
import { getDb } from '../db/database.js';

/**
 * Verify JWT bearer token and validate live user status/token_version in database.
 */
export async function verifyUserToken(token) {
  const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  const userId = Number(decoded?.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    const err = new Error('Invalid token payload.');
    err.statusCode = 401;
    throw err;
  }

  const sql = getDb();
  const rows = await sql`
    SELECT id, username, role, is_active, token_version
    FROM users
    WHERE id = ${userId}
  `;
  const user = rows[0];
  if (!user) {
    const err = new Error('User account no longer exists.');
    err.statusCode = 401;
    throw err;
  }
  if (user.is_active === false) {
    const err = new Error('User account is disabled.');
    err.statusCode = 403;
    throw err;
  }

  const tokenVersion = decoded.tv ?? 1;
  if (Number(user.token_version || 1) !== Number(tokenVersion)) {
    const err = new Error('Session expired. Please sign in again.');
    err.statusCode = 401;
    throw err;
  }

  return {
    id: user.id,
    username: user.username,
    role: user.role || 'admin',
    token_version: Number(user.token_version || 1),
  };
}

export async function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header.' });
  }

  const token = authHeader.slice(7);
  try {
    req.user = await verifyUserToken(token);
    next();
  } catch (err) {
    const status = err.statusCode || 401;
    return res.status(status).json({ error: err.statusCode ? err.message : 'Invalid or expired token.' });
  }
}

/**
 * Restrict route access to specific user roles (e.g. 'admin', 'operator').
 */
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    const role = req.user?.role || 'viewer';
    if (!allowedRoles.includes(role)) {
      return res.status(403).json({
        error: `Access denied. Requires ${allowedRoles.join(' or ')} role.`,
      });
    }
    next();
  };
}
