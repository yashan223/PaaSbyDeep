import { WebSocketServer, WebSocket } from 'ws';
import { verifyUserToken } from '../middleware/auth.js';
import { getDb } from '../db/database.js';
import { getSystemMetrics } from './systemMetrics.js';
import { getRecentServerLogs, setServerLogListener } from './serverLogger.js';
import { startContainerExecSession } from './docker.js';
import { recordAudit } from './auditService.js';

let wss = null;
let statsInterval = null;
let heartbeatInterval = null;
let collectingStats = false;

function startMetricsStream() {
  if (statsInterval) return;

  statsInterval = setInterval(async () => {
    if (!wss || wss.clients.size === 0) {
      stopMetricsStream();
      return;
    }
    if (collectingStats) return;
    collectingStats = true;
    try {
      const metrics = await getSystemMetrics();
      broadcast({ type: 'system:stats', data: metrics });
    } catch (err) {
      console.warn('[WS] Failed to collect system metrics:', err.message);
    } finally {
      collectingStats = false;
    }
  }, 1000);
}

function stopMetricsStream() {
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }
}

function sendJson(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

async function handleExecMessage(ws, execSessions, msg) {
  const role = ws.user?.role || 'viewer';
  if (role !== 'admin' && role !== 'operator') {
    sendJson(ws, { type: 'exec:error', error: 'Viewer accounts cannot open container shell sessions.' });
    return;
  }

  if (msg.type === 'exec:start') {
    const appId = Number.parseInt(msg.appId, 10);
    if (!Number.isInteger(appId) || appId <= 0) {
      sendJson(ws, { type: 'exec:error', error: 'Invalid application ID.' });
      return;
    }

    // Limit concurrent exec shells per WebSocket connection
    if (execSessions.size >= 3) {
      sendJson(ws, { type: 'exec:error', error: 'Maximum 3 concurrent terminal sessions reached.' });
      return;
    }

    try {
      const sql = getDb();
      const rows = await sql`SELECT * FROM applications WHERE id = ${appId}`;
      if (!rows[0]) {
        sendJson(ws, { type: 'exec:error', error: 'Application not found.' });
        return;
      }

      const app = rows[0];
      const session = await startContainerExecSession(app, {
        cols: msg.cols,
        rows: msg.rows,
        onData: (data) => {
          sendJson(ws, { type: 'exec:data', appId, sessionId: session.sessionId, data });
        },
        onClose: (reason) => {
          execSessions.delete(session.sessionId);
          sendJson(ws, { type: 'exec:closed', appId, sessionId: session.sessionId, reason });
        },
      });

      execSessions.set(session.sessionId, session);
      sendJson(ws, { type: 'exec:started', appId, sessionId: session.sessionId });
      void recordAudit({
        user: ws.user,
        action: 'app.exec_open',
        targetType: 'application',
        targetId: app.id,
        targetName: app.name,
      });
    } catch (err) {
      sendJson(ws, { type: 'exec:error', appId, error: err.message });
    }
    return;
  }

  if (msg.type === 'exec:input') {
    const session = execSessions.get(msg.sessionId);
    if (session && typeof msg.data === 'string') {
      session.write(msg.data);
    }
    return;
  }

  if (msg.type === 'exec:resize') {
    const session = execSessions.get(msg.sessionId);
    if (session) {
      await session.resize(msg.cols, msg.rows);
    }
    return;
  }

  if (msg.type === 'exec:close') {
    const session = execSessions.get(msg.sessionId);
    if (session) {
      execSessions.delete(msg.sessionId);
      session.close();
    }
  }
}

/**
 * Attach authenticated WebSocket server to an existing HTTP server.
 * Accepts upgrades on /api/ws (and /ws) with ?token=<JWT>.
 */
export function initWebSocket(server) {
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    if (url.pathname !== '/api/ws' && url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const token = url.searchParams.get('token');
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    try {
      req.user = await verifyUserToken(token);
    } catch (err) {
      const codeLine = err?.statusCode === 403 ? '403 Forbidden' : '401 Unauthorized';
      socket.write(`HTTP/1.1 ${codeLine}\r\n\r\n`);
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', async (ws, req) => {
    ws.user = req.user;
    ws.isAlive = true;
    const execSessions = new Map();

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg && typeof msg.type === 'string' && msg.type.startsWith('exec:')) {
        void handleExecMessage(ws, execSessions, msg);
      }
    });

    sendJson(ws, { type: 'connected', timestamp: new Date().toISOString() });

    const recentLogs = getRecentServerLogs();
    if (recentLogs.length > 0) {
      sendJson(ws, { type: 'server:logs:history', entries: recentLogs });
    }

    try {
      const metrics = await getSystemMetrics();
      sendJson(ws, { type: 'system:stats', data: metrics });
    } catch {
    }

    startMetricsStream();

    ws.on('close', () => {
      for (const session of execSessions.values()) {
        session.close();
      }
      execSessions.clear();

      if (wss && wss.clients.size === 0) {
        stopMetricsStream();
      }
    });
  });

  heartbeatInterval = setInterval(() => {
    if (!wss) return;
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);

  setServerLogListener((entry) => {
    broadcast({ type: 'server:log', entry });
  });

  console.log('[WS] WebSocket server ready on /api/ws');
  return wss;
}

/**
 * Broadcast an event JSON payload to all connected authenticated clients.
 */
export function broadcast(payload) {
  if (!wss || wss.clients.size === 0) return;
  const message = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

/**
 * Cleanly stop intervals and close all WebSocket clients.
 */
export function closeWebSocket() {
  stopMetricsStream();
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  if (wss) {
    for (const client of wss.clients) {
      client.close(1001, 'Server shutting down');
    }
    wss.close();
    wss = null;
  }
}
