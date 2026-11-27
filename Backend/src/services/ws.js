import { WebSocketServer, WebSocket } from 'ws';
import { verifyUserToken } from '../middleware/auth.js';
import { getSystemMetrics } from './systemMetrics.js';
import { getRecentServerLogs, setServerLogListener } from './serverLogger.js';

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

  wss.on('connection', async (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));

    const recentLogs = getRecentServerLogs();
    if (recentLogs.length > 0 && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'server:logs:history', entries: recentLogs }));
    }

    try {
      const metrics = await getSystemMetrics();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'system:stats', data: metrics }));
      }
    } catch {
    }

    startMetricsStream();

    ws.on('close', () => {
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
