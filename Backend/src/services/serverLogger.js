const MAX_BUFFER = 150;
const buffer = [];
let initialized = false;
let onEntryCallback = null;

function redactSensitive(text) {
  return String(text)
    .replace(/https:\/\/[^@\s]+@/gi, 'https://[REDACTED]@')
    .replace(/postgresql:\/\/[^@\s]+@/gi, 'postgresql://[REDACTED]@')
    .replace(/postgres:\/\/[^@\s]+@/gi, 'postgres://[REDACTED]@')
    .replace(/\b(ghp_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+)\b/g, '[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/(JWT_SECRET|WEBHOOK_SECRET|DATABASE_URL|GITHUB_TOKEN|ADMIN_PASSWORD)\s*=\s*\S+/gi, '$1=[REDACTED]');
}

function formatArgs(args) {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

function record(level, args) {
  const message = redactSensitive(formatArgs(args));
  if (!message.trim()) return;

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
  };

  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) {
    buffer.shift();
  }

  if (onEntryCallback) {
    try {
      onEntryCallback(entry);
    } catch {
    }
  }
}

/**
 * Intercept console.log/warn/error to keep an in-memory redacted log buffer
 * and stream lines to connected WebSocket clients.
 */
export function initServerLogger(onEntry) {
  if (onEntry) onEntryCallback = onEntry;
  if (initialized) return;
  initialized = true;

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = (...args) => {
    origLog(...args);
    record('info', args);
  };

  console.warn = (...args) => {
    origWarn(...args);
    record('warn', args);
  };

  console.error = (...args) => {
    origError(...args);
    record('error', args);
  };
}

export function setServerLogListener(onEntry) {
  onEntryCallback = onEntry;
}

export function getRecentServerLogs() {
  return [...buffer];
}
