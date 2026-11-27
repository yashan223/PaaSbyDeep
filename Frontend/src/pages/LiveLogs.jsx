import { useEffect, useMemo, useState } from 'react';
import { Terminal, Trash2, Search, X } from 'lucide-react';
import LogViewer from '../components/LogViewer';
import useApps from '../hooks/useApps';
import { useWebSocket } from '../context/WebSocketContext';
import { getRecentLogs } from '../api/apps';

function LiveLogs() {
  const { apps, fetchApps } = useApps();
  const { connected, liveLogs, seedLiveLogs, clearLiveLogs } = useWebSocket();
  const [logAppFilter, setLogAppFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    void fetchApps();
  }, [fetchApps]);

  useEffect(() => {
    if (liveLogs.length > 0) return;
    getRecentLogs()
      .then((res) => {
        if (!res?.logs) return;
        const label = res.app_name || (res.app_id ? `app-${res.app_id}` : 'recent');
        const entries = String(res.logs)
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => ({
            appId: res.app_id,
            timestamp: res.started_at || null,
            message: `[${label}] ${line}`,
          }));
        seedLiveLogs(entries);
      })
      .catch(() => {});
  }, [liveLogs.length, seedLiveLogs]);

  const filteredLogs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return liveLogs.filter((entry) => {
      if (logAppFilter !== 'all' && String(entry.appId) !== logAppFilter) {
        return false;
      }
      if (!q) return true;
      const text = typeof entry === 'string'
        ? entry
        : (entry.message || entry.text || '');
      return String(text).toLowerCase().includes(q);
    });
  }, [liveLogs, logAppFilter, searchQuery]);

  return (
    <div className="page">
      <div className="page-header">
        <div className="live-logs-heading-wrap">
          <h2 className="page-heading" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Terminal size={18} /> Live Logs
          </h2>
          <span className={`status-badge ${connected ? 'status-badge--running' : 'status-badge--stopped'}`}>
            <span className={`status-dot ${connected ? 'status-dot--pulse' : ''}`} />
            {connected ? 'Streaming' : 'Reconnecting'}
          </span>
        </div>

        <div className="live-logs-controls">
          <div className="live-logs-search-wrap">
            <Search size={13} className="github-search-icon" />
            <input
              type="text"
              className="form-input live-logs-search-input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter log lines…"
              aria-label="Filter log lines"
            />
            {searchQuery && (
              <button
                type="button"
                className="github-search-clear"
                title="Clear search"
                onClick={() => setSearchQuery('')}
              >
                <X size={13} />
              </button>
            )}
          </div>

          <select
            className="form-input live-logs-select"
            value={logAppFilter}
            onChange={(e) => setLogAppFilter(e.target.value)}
            aria-label="Filter live logs by source"
          >
            <option value="all">All Activity ({liveLogs.length})</option>
            <option value="server">Server Logs</option>
            {apps.map((a) => (
              <option key={a.id} value={String(a.id)}>{a.name}</option>
            ))}
          </select>

          <button
            className="btn btn-sm btn-secondary"
            onClick={clearLiveLogs}
            disabled={liveLogs.length === 0}
            title="Clear logs"
          >
            <Trash2 size={13} /> Clear
          </button>
        </div>
      </div>

      <LogViewer logs={filteredLogs} className="log-viewer--tall" />
    </div>
  );
}

export default LiveLogs;
