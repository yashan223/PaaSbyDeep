import { useState, useEffect, useCallback } from 'react';
import { ClipboardList, Search, RefreshCw, Shield, X } from 'lucide-react';
import { getAuditLogs } from '../api/audit';
import { useAuth } from '../context/AuthContext';
import { useWebSocket } from '../context/WebSocketContext';

function AuditLogs() {
  const { user } = useAuth();
  const isAdmin = (user?.role || 'admin') === 'admin';
  const { subscribe } = useWebSocket();

  const [entries, setEntries] = useState([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [targetType, setTargetType] = useState('');

  const fetchLogs = useCallback(async ({ offset = 0, append = false, nextTargetType = targetType, nextSearch = search } = {}) => {
    try {
      const res = await getAuditLogs({
        limit: 50,
        offset,
        targetType: nextTargetType,
        q: nextSearch.trim(),
      });
      const list = Array.isArray(res?.entries) ? res.entries : [];
      setEntries((prev) => (append ? [...prev, ...list] : list));
      setTotal(Number(res?.total || 0));
      setHasMore(Boolean(res?.hasMore));
      setError('');
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to fetch audit logs.');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [targetType, search]);

  useEffect(() => {
    if (!isAdmin) return undefined;
    let active = true;
    getAuditLogs({ limit: 50, offset: 0, targetType, q: search.trim() })
      .then((res) => {
        if (!active) return;
        const list = Array.isArray(res?.entries) ? res.entries : [];
        setEntries(list);
        setTotal(Number(res?.total || 0));
        setHasMore(Boolean(res?.hasMore));
        setError('');
      })
      .catch((err) => {
        if (active) setError(err?.response?.data?.error || 'Failed to fetch audit logs.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [isAdmin, targetType, search]);

  useEffect(() => {
    if (!isAdmin) return undefined;
    return subscribe((msg) => {
      if (msg.type === 'audit:new' && msg.entry) {
        if (targetType && msg.entry.target_type !== targetType) return;
        const q = search.trim().toLowerCase();
        if (q) {
          const hay = `${msg.entry.username} ${msg.entry.action} ${msg.entry.target_name || ''}`.toLowerCase();
          if (!hay.includes(q)) return;
        }
        setEntries((prev) => [msg.entry, ...prev.slice(0, 199)]);
        setTotal((t) => t + 1);
      }
    });
  }, [isAdmin, subscribe, targetType, search]);

  if (!isAdmin) {
    return (
      <div className="page">
        <div className="alert alert-error" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Shield size={16} /> Administrator privileges are required to view audit logs.
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div className="live-logs-heading-wrap">
          <h2 className="page-heading" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <ClipboardList size={18} /> Audit Trail
          </h2>
          <span className="project-type-pill">{total} events</span>
        </div>

        <div className="live-logs-controls">
          <div className="live-logs-search-wrap">
            <Search size={13} className="github-search-icon" />
            <input
              type="text"
              className="form-input live-logs-search-input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search user, action, target…"
              aria-label="Search audit events"
            />
            {search && (
              <button
                type="button"
                className="github-search-clear"
                onClick={() => setSearch('')}
                title="Clear search"
              >
                <X size={13} />
              </button>
            )}
          </div>

          <select
            className="form-input live-logs-select"
            value={targetType}
            onChange={(e) => setTargetType(e.target.value)}
            aria-label="Filter by resource type"
          >
            <option value="">All Resources</option>
            <option value="application">Applications</option>
            <option value="service">Services</option>
            <option value="domain">Domains</option>
            <option value="user">Users</option>
            <option value="settings">Settings</option>
            <option value="system">System</option>
          </select>

          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() => {
              setLoading(true);
              void fetchLogs({ offset: 0, append: false });
            }}
            disabled={loading}
          >
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: '16px' }}>{error}</div>}

      {loading ? (
        <div className="loading-state">Loading audit events…</div>
      ) : entries.length === 0 ? (
        <div className="empty-state">
          <ClipboardList size={38} />
          <p>No audit log entries match the current filter.</p>
        </div>
      ) : (
        <>
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Resource</th>
                  <th>Details</th>
                  <th>IP</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((ev) => {
                  const detailsObj = ev.details && typeof ev.details === 'object' ? ev.details : {};
                  const detailKeys = Object.entries(detailsObj);
                  return (
                    <tr key={ev.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{new Date(ev.created_at).toLocaleString()}</td>
                      <td><strong>{ev.username}</strong></td>
                      <td><code className="project-type-pill">{ev.action}</code></td>
                      <td>
                        <span className="form-hint" style={{ marginRight: '6px' }}>{ev.target_type}</span>
                        <span>{ev.target_name || ev.target_id || '—'}</span>
                      </td>
                      <td>
                        {detailKeys.length > 0 ? (
                          <span className="form-hint">
                            {detailKeys.map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}
                          </span>
                        ) : '—'}
                      </td>
                      <td><code>{ev.ip_address || '—'}</code></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {hasMore && (
            <div style={{ marginTop: '14px', textAlign: 'center' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setLoadingMore(true);
                  void fetchLogs({ offset: entries.length, append: true });
                }}
                disabled={loadingMore}
              >
                {loadingMore ? 'Loading…' : 'Load Older Events'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default AuditLogs;
