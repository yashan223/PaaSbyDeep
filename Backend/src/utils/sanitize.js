/**
 * Sanitize an app name: only allow [a-z0-9-], max 50 chars.
 * Returns sanitized string, or null if empty after sanitization.
 */
export function sanitizeName(name) {
  if (!name || typeof name !== 'string') return null;
  const sanitized = name.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 50);
  return sanitized.length > 0 ? sanitized : null;
}

/**
 * Sanitize a port: must be integer 1024-65535.
 * Returns the port as integer, or null if invalid.
 */
export function sanitizePort(port) {
  const p = parseInt(port, 10);
  if (isNaN(p) || p < 1024 || p > 65535) return null;
  return p;
}

/**
 * Sanitize a repository URL: only allow https://github.com/ or https://gitlab.com/ URLs.
 * Returns the URL string, or null if invalid.
 */
export function sanitizeRepoUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    if (parsed.hostname !== 'github.com' && parsed.hostname !== 'gitlab.com') return null;
    const clean = `https://${parsed.hostname}${parsed.pathname}`;
    return clean;
  } catch {
    return null;
  }
}

/**
 * Sanitize a Dockerfile path: strip path traversal, only allow relative paths.
 * Returns the sanitized path, or null if path traversal was detected.
 */
export function sanitizeDockerfilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;

  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.includes('..')) return null;
  if (normalized.startsWith('/')) return null;
  const cleaned = normalized.replace(/^\.\//, '');
  const safe = cleaned.replace(/[^a-zA-Z0-9._\-\/]/g, '');

  return safe.length > 0 ? safe : null;
}

/**
 * Sanitize and validate a domain name (FQDN, no scheme/port/wildcard/shell chars).
 * Returns normalized lowercase domain string, or null if invalid.
 */
export function sanitizeDomain(rawDomain) {
  if (!rawDomain || typeof rawDomain !== 'string') return null;

  let cleaned = rawDomain.trim().toLowerCase();
  cleaned = cleaned.replace(/^https?:\/\//, '').replace(/\/+$/, '');

  if (cleaned.length < 3 || cleaned.length > 253) return null;
  if (!cleaned.includes('.')) return null;

  const domainRegex = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  return domainRegex.test(cleaned) ? cleaned : null;
}

/**
 * Sanitize and validate an email address (used for Certbot Let's Encrypt registration).
 * Rejects leading dashes and shell metacharacters.
 */
export function sanitizeEmail(rawEmail) {
  if (!rawEmail || typeof rawEmail !== 'string') return null;
  const cleaned = rawEmail.trim();
  if (!cleaned || cleaned.length > 254 || cleaned.startsWith('-')) return null;

  const emailRegex = /^[^\s@<>;"'`\\]+@[^\s@<>;"'`\\]+\.[^\s@<>;"'`\\]{2,}$/;
  return emailRegex.test(cleaned) ? cleaned : null;
}
