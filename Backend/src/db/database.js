import dns from 'node:dns';
import { neon, neonConfig } from '@neondatabase/serverless';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;

// Prefer IPv4 DNS results so hosts with broken IPv6 routes don't stall on connect
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

const PRE_CONNECT_ERROR_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const TRANSIENT_STARTUP_CODES = new Set([
  ...PRE_CONNECT_ERROR_CODES,
  'ECONNRESET',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'ABORT_ERR',
  'TimeoutError',
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDeepErrorInfo(err) {
  const details = [];
  const codes = new Set();
  const seen = new Set();
  let current = err;

  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (current.code) codes.add(String(current.code));
    if (current.name && current.name !== 'Error' && current.name !== 'TypeError') {
      codes.add(String(current.name));
    }

    const parts = [];
    if (current.code) parts.push(current.code);
    if (current.hostname) parts.push(current.hostname);
    if (current.message && current.message !== 'fetch failed') {
      parts.push(current.message);
    }
    if (parts.length > 0) {
      details.push(parts.join(': '));
    }

    current = current.cause || current.sourceError || null;
  }

  return { codes, details };
}

function isPreConnectError(err) {
  const { codes } = getDeepErrorInfo(err);
  for (const code of codes) {
    if (PRE_CONNECT_ERROR_CODES.has(code)) return true;
  }
  return false;
}

function isTransientStartupError(err) {
  if (!err) return false;
  const { codes } = getDeepErrorInfo(err);
  for (const code of codes) {
    if (TRANSIENT_STARTUP_CODES.has(code)) return true;
  }
  return /fetch failed|Error connecting to database|timed out|socket|starting up/i.test(err.message || '');
}

/**
 * Unwrap database/network error chains (including sourceError and cause) into an actionable string.
 */
export function formatDbError(err) {
  if (!err) return 'Unknown database error';
  const baseMessage = err.message || String(err);
  const underlying = err.sourceError || err.cause;
  if (!underlying) return baseMessage;

  const { details } = getDeepErrorInfo(underlying);
  const uniqueDetails = [...new Set(details)].filter((d) => d && d !== baseMessage);
  if (uniqueDetails.length === 0) return baseMessage;

  return `${baseMessage} (${uniqueDetails.join(' -> ')})`;
}

// Guard Neon HTTP fetch with an explicit timeout and a single retry for pre-connect DNS/TCP blips
neonConfig.fetchFunction = async (url, init = {}) => {
  const attemptFetch = async () => {
    const signal = init.signal || AbortSignal.timeout(20000);
    return globalThis.fetch(url, { ...init, signal });
  };

  try {
    return await attemptFetch();
  } catch (err) {
    if (isPreConnectError(err)) {
      await sleep(500);
      return attemptFetch();
    }
    throw err;
  }
};

function detectDriver(connectionString) {
  const configured = (process.env.DB_DRIVER || 'auto').trim().toLowerCase();
  if (configured === 'neon' || configured === 'pg') {
    return configured;
  }
  try {
    const parsed = new URL(connectionString);
    if (parsed.hostname.endsWith('.neon.tech')) {
      return 'neon';
    }
  } catch {
  }
  return 'pg';
}

function resolvePgSslOption(connectionString) {
  try {
    const parsed = new URL(connectionString);
    const sslmode = (parsed.searchParams.get('sslmode') || process.env.PGSSLMODE || '').toLowerCase();
    const sslParam = (parsed.searchParams.get('ssl') || '').toLowerCase();

    if (sslmode === 'disable' || sslParam === 'false' || sslParam === '0') {
      return false;
    }
    if (sslmode === 'verify-full' || sslmode === 'verify-ca') {
      return { rejectUnauthorized: true };
    }
    if (sslmode === 'require' || sslmode === 'prefer' || sslmode === 'no-verify' || sslParam === 'true' || sslParam === '1') {
      return { rejectUnauthorized: false };
    }
  } catch {
  }
  return false;
}

function buildParameterizedQuery(strings, values) {
  if (typeof strings === 'string') {
    return {
      text: strings,
      params: Array.isArray(values[0]) ? values[0] : [],
    };
  }
  let text = '';
  for (let i = 0; i < strings.length; i++) {
    text += strings[i];
    if (i < values.length) {
      text += `$${i + 1}`;
    }
  }
  return { text, params: values };
}

function sanitizePgConnectionString(connectionString) {
  try {
    const parsed = new URL(connectionString);
    parsed.searchParams.delete('sslmode');
    parsed.searchParams.delete('ssl');
    parsed.searchParams.delete('channel_binding');
    return parsed.toString();
  } catch {
    return connectionString;
  }
}

function createPgClient(connectionString) {
  const pool = new Pool({
    connectionString: sanitizePgConnectionString(connectionString),
    ssl: resolvePgSslOption(connectionString),
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  pool.on('error', (err) => {
    console.error('[DB] PostgreSQL pool idle client error:', err.message);
  });

  async function sqlTag(strings, ...values) {
    const { text, params } = buildParameterizedQuery(strings, values);
    const result = await pool.query(text, params);
    return result.rows;
  }

  sqlTag.transaction = async (fn) => {
    const conn = await pool.connect();
    try {
      await conn.query('BEGIN');
      const queries = typeof fn === 'function'
        ? fn((strings, ...values) => buildParameterizedQuery(strings, values))
        : fn;

      const results = [];
      for (const q of queries) {
        const res = await conn.query(q.text, q.params);
        results.push(res.rows);
      }
      await conn.query('COMMIT');
      return results;
    } catch (err) {
      await conn.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  };

  sqlTag._pool = pool;
  return sqlTag;
}

let sql;
let activePool = null;

/**
 * Returns the initialized SQL client (Neon serverless or PostgreSQL pg Pool).
 */
export function getDb() {
  if (!sql) throw new Error('Database not initialized. Call initDb() first.');
  return sql;
}

/**
 * Gracefully close any open PostgreSQL pool connections.
 */
export async function closeDb() {
  if (activePool) {
    const pool = activePool;
    activePool = null;
    sql = null;
    await pool.end();
  }
}

function parseSqlStatements(rawSql) {
  return rawSql
    .replace(/--.*$/gm, '')
    .split(';')
    .map((stmt) => stmt.trim())
    .filter(Boolean);
}

/**
 * Initialize PostgreSQL or Neon DB connection, run schema.sql, and seed initial admin user.
 * Retries transient network/cold-start failures during boot.
 */
export async function initDb() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || connectionString.includes('USER:PASSWORD@ep-your-project')) {
    throw new Error(
      'DATABASE_URL is not configured. Please set a valid PostgreSQL or Neon DB connection string in Backend/.env.'
    );
  }

  const driver = detectDriver(connectionString);
  const schemaPath = join(__dirname, 'migrations', 'schema.sql');
  const rawSchema = readFileSync(schemaPath, 'utf8');
  const statements = parseSqlStatements(rawSchema);
  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || 'changeme123';

  const retryDelays = [1500, 3000, 5000];
  let lastError = null;

  for (let attempt = 1; attempt <= retryDelays.length + 1; attempt++) {
    let candidate = null;
    try {
      candidate = driver === 'neon' ? neon(connectionString) : createPgClient(connectionString);

      if (statements.length > 0) {
        await candidate.transaction((txn) => statements.map((stmt) => txn(stmt)));
      }

      const countRows = await candidate`SELECT COUNT(*)::int AS count FROM users`;
      const userCount = Number(countRows[0]?.count || 0);
      if (userCount === 0) {
        const hash = bcrypt.hashSync(adminPassword, 12);
        await candidate`
          INSERT INTO users (username, password_hash, role, is_active, token_version)
          VALUES (${adminUsername}, ${hash}, 'admin', true, 1)
        `;
        console.log(`[DB] Initial admin user '${adminUsername}' created.`);
      }

      sql = candidate;
      activePool = candidate._pool || null;
      break;
    } catch (err) {
      if (candidate?._pool) {
        await candidate._pool.end().catch(() => {});
      }
      lastError = err;
      const delay = retryDelays[attempt - 1];
      if (!delay || !isTransientStartupError(err)) {
        throw new Error(formatDbError(err), { cause: err });
      }
      console.warn(
        `[DB] Connection attempt ${attempt}/${retryDelays.length + 1} failed (${driver}): ${formatDbError(err)}. Retrying in ${delay / 1000}s...`
      );
      await sleep(delay);
    }
  }

  if (!sql && lastError) {
    throw new Error(formatDbError(lastError), { cause: lastError });
  }

  const reposPath = process.env.REPOS_PATH || './data/repos';
  if (!existsSync(reposPath)) {
    mkdirSync(reposPath, { recursive: true });
  }

  console.log(`[DB] ${driver === 'neon' ? 'Neon DB' : 'PostgreSQL'} initialized.`);
  return sql;
}
