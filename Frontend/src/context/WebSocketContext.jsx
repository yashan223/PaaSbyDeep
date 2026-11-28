import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { useAuth } from './AuthContext';

const WebSocketContext = createContext(null);
const MAX_LIVE_LOGS = 250;

function getWsUrl(token) {
  const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';
  const base = apiUrl.startsWith('/')
    ? `${window.location.origin.replace(/^http/i, 'ws')}${apiUrl}`.replace(/\/+$/, '')
    : apiUrl.replace(/^http/i, 'ws').replace(/\/+$/, '');
  return `${base}/ws?token=${encodeURIComponent(token)}`;
}

function appendLogEntries(prev, newEntries) {
  if (!newEntries.length) return prev;
  const combined = [...prev, ...newEntries];
  return combined.length > MAX_LIVE_LOGS ? combined.slice(-MAX_LIVE_LOGS) : combined;
}

function msgToLogEntries(msg) {
  const ts = new Date().toISOString();
  const label = msg.appName || (msg.appId ? `app-${msg.appId}` : 'system');

  if (msg.type === 'server:log' && msg.entry) {
    return [{
      appId: 'server',
      timestamp: msg.entry.timestamp || ts,
      message: msg.entry.message,
    }];
  }

  if (msg.type === 'deploy:log' && msg.chunk) {
    return String(msg.chunk)
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => ({
        appId: msg.appId,
        timestamp: ts,
        message: `[${label}] ${line}`,
      }));
  }

  if (msg.type === 'deploy:status') {
    const via = msg.triggeredBy ? ` (${msg.triggeredBy})` : '';
    return [{
      appId: msg.appId,
      timestamp: ts,
      message: `[${label}] Deployment #${msg.deploymentId} → ${msg.status}${via}`,
    }];
  }

  if (msg.type === 'app:status') {
    return [{
      appId: msg.appId,
      timestamp: ts,
      message: `[${label}] Container status → ${msg.status}`,
    }];
  }

  if (msg.type === 'apps:changed') {
    return [{
      appId: msg.appId,
      timestamp: ts,
      message: `[${label}] Application ${msg.action}`,
    }];
  }

  return [];
}

export function WebSocketProvider({ children }) {
  const { token, isAuthenticated } = useAuth();
  const [connected, setConnected] = useState(false);
  const [systemStats, setSystemStats] = useState(null);
  const [liveLogs, setLiveLogs] = useState([]);

  const listenersRef = useRef(new Set());
  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);

  const subscribe = useCallback((fn) => {
    listenersRef.current.add(fn);
    return () => {
      listenersRef.current.delete(fn);
    };
  }, []);

  const seedLiveLogs = useCallback((entries) => {
    if (!Array.isArray(entries) || entries.length === 0) return;
    setLiveLogs((prev) => (prev.length === 0 ? entries.slice(-MAX_LIVE_LOGS) : prev));
  }, []);

  const clearLiveLogs = useCallback(() => {
    setLiveLogs([]);
  }, []);

  const send = useCallback((payload) => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }, []);

  useEffect(() => {
    if (!isAuthenticated || !token) {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      return undefined;
    }

    let cancelled = false;
    let attempt = 0;

    function connect() {
      if (cancelled) return;
      const socket = new WebSocket(getWsUrl(token));
      wsRef.current = socket;

      socket.onopen = () => {
        if (cancelled) {
          socket.close();
          return;
        }
        attempt = 0;
        setConnected(true);
      };

      socket.onmessage = (event) => {
        if (cancelled) return;
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }

        if (msg.type === 'system:stats' && msg.data) {
          setSystemStats(msg.data);
        }

        if (msg.type === 'server:logs:history' && Array.isArray(msg.entries)) {
          const histEntries = msg.entries.map((e) => ({
            appId: 'server',
            timestamp: e.timestamp,
            message: e.message,
          }));
          setLiveLogs((prev) => (prev.length === 0 ? histEntries.slice(-MAX_LIVE_LOGS) : prev));
        }

        const logEntries = msgToLogEntries(msg);
        if (logEntries.length > 0) {
          setLiveLogs((prev) => appendLogEntries(prev, logEntries));
        }

        listenersRef.current.forEach((fn) => {
          try {
            fn(msg);
          } catch (err) {
            void err;
          }
        });
      };

      socket.onclose = () => {
        if (cancelled) return;
        setConnected(false);
        wsRef.current = null;
        const delay = Math.min(1000 * 2 ** attempt, 10000);
        attempt += 1;
        reconnectTimerRef.current = setTimeout(connect, delay);
      };

      socket.onerror = () => {
        socket.close();
      };
    }

    connect();

    return () => {
      cancelled = true;
      setConnected(false);
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [isAuthenticated, token]);

  return (
    <WebSocketContext.Provider
      value={{ connected, systemStats, liveLogs, seedLiveLogs, clearLiveLogs, subscribe, send }}
    >
      {children}
    </WebSocketContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useWebSocket() {
  const ctx = useContext(WebSocketContext);
  if (!ctx) throw new Error('useWebSocket must be used within WebSocketProvider');
  return ctx;
}
