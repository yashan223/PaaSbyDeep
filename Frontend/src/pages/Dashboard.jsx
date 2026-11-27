import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Plus, Play, RotateCcw, Square, Activity, Server, AlertTriangle,
} from 'lucide-react';
import StatusBadge from '../components/StatusBadge';
import useApps from '../hooks/useApps';
import { useWebSocket } from '../context/WebSocketContext';
import { deployApp, restartApp, stopApp } from '../api/apps';

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '--';
  const gb = bytes / (1024 ** 3);
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 ** 2);
  return `${Math.round(mb)} MB`;
}

function StatCard({ icon, label, value, color }) {
  return (
    <div className="stat-card">
      <div className="stat-card-icon" style={{ color }}>{icon}</div>
      <div className="stat-card-info">
        <span className="stat-card-value">{value}</span>
        <span className="stat-card-label">{label}</span>
      </div>
    </div>
  );
}

function Dashboard() {
  const { apps, setApps, loading, error, fetchApps } = useApps();
  const { systemStats: stats, subscribe } = useWebSocket();
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    void fetchApps();
  }, [fetchApps]);

  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === 'app:status') {
        setApps((prev) =>
          prev.map((a) =>
            Number(a.id) === Number(msg.appId)
              ? {
                  ...a,
                  status: msg.status,
                  ...(msg.lastDeployedAt ? { last_deployed_at: msg.lastDeployedAt } : {}),
                }
              : a
          )
        );
      } else if (msg.type === 'apps:changed') {
        void fetchApps();
      }
    });
  }, [subscribe, setApps, fetchApps]);

  const totalApps = apps.length;
  const runningApps = apps.filter((a) => a.status === 'running').length;
  const failedApps = apps.filter((a) => a.status === 'error' || a.status === 'failed').length;

  const handleAction = async (action, id) => {
    setActionError('');
    try {
      await action(id);
      await fetchApps();
    } catch (err) {
      setActionError(err?.response?.data?.error || err?.response?.data?.message || 'Action failed.');
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h2 className="page-heading">Overview</h2>
        <Link to="/apps/new" className="btn btn-primary">
          <Plus size={15} /> New Application
        </Link>
      </div>

      <div className="stat-cards">
        <StatCard
          icon={<Server size={22} />}
          label="Total Apps"
          value={totalApps}
          color="var(--info)"
        />
        <StatCard
          icon={<Activity size={22} />}
          label="Running"
          value={runningApps}
          color="#3fb950"
        />
        <StatCard
          icon={<AlertTriangle size={22} />}
          label="Failed"
          value={failedApps}
          color="var(--danger)"
        />
      </div>

      {stats && (() => {
        const cpuLoad = stats.cpu?.load ?? stats.cpu ?? 0;
        const cpuCores = stats.cpu?.cores;
        const cpuDetail = cpuCores
          ? `${((cpuLoad / 100) * cpuCores).toFixed(2)} / ${cpuCores} cores`
          : `${cpuLoad}% / 100%`;

        const memPercent = stats.memory?.percent ?? stats.memPercent ?? stats.ram ?? 0;
        const memDetail = stats.memory?.total
          ? `${formatBytes(stats.memory.used)} / ${formatBytes(stats.memory.total)}`
          : null;

        const diskPercent = stats.disk?.percent ?? stats.diskPercent ?? stats.disk ?? 0;
        const diskDetail = stats.disk?.total
          ? `${formatBytes(stats.disk.used)} / ${formatBytes(stats.disk.total)}`
          : null;

        return (
          <div className="section">
            <h3 className="section-title">Server Resources</h3>
            <div className="resource-cards">
              <div className="resource-card">
                <div className="resource-header">
                  <span className="resource-label">CPU</span>
                  <span className="resource-detail">{cpuDetail}</span>
                  <span className="resource-value">{cpuLoad}%</span>
                </div>
                <div className="resource-bar">
                  <div className="resource-fill" style={{ width: `${Math.min(cpuLoad, 100)}%` }} />
                </div>
              </div>

              <div className="resource-card">
                <div className="resource-header">
                  <span className="resource-label">RAM</span>
                  {memDetail && <span className="resource-detail">{memDetail}</span>}
                  <span className="resource-value">{memPercent}%</span>
                </div>
                <div className="resource-bar">
                  <div className="resource-fill resource-fill--ram" style={{ width: `${Math.min(memPercent, 100)}%` }} />
                </div>
              </div>

              {stats.disk !== undefined && (
                <div className="resource-card">
                  <div className="resource-header">
                    <span className="resource-label">Disk</span>
                    {diskDetail && <span className="resource-detail">{diskDetail}</span>}
                    <span className="resource-value">{diskPercent}%</span>
                  </div>
                  <div className="resource-bar">
                    <div className="resource-fill resource-fill--disk" style={{ width: `${Math.min(diskPercent, 100)}%` }} />
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      <div className="section">
        <h3 className="section-title">Applications</h3>

        {actionError && <div className="alert alert-error" style={{ marginBottom: '12px' }}>{actionError}</div>}

        {loading && apps.length === 0 ? (
          <div className="loading-state">Loading applications…</div>
        ) : error ? (
          <div className="alert alert-error">{error}</div>
        ) : apps.length === 0 ? (
          <div className="empty-state">
            <Server size={40} />
            <p>No applications yet.</p>
            <Link to="/apps/new" className="btn btn-primary">Deploy your first app</Link>
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Port</th>
                  <th>Last Deployed</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {apps.map((app) => (
                  <tr key={app._id || app.id}>
                    <td>
                      <Link to={`/apps/${app._id || app.id}`} className="table-link">
                        {app.name}
                      </Link>
                    </td>
                    <td><StatusBadge status={app.status} /></td>
                    <td>{app.port || '—'}</td>
                    <td>
                      {(app.last_deployed_at || app.lastDeployedAt)
                        ? new Date(app.last_deployed_at || app.lastDeployedAt).toLocaleString()
                        : '—'}
                    </td>
                    <td>
                      <div className="action-btns">
                        <button
                          className="btn btn-xs btn-primary"
                          title="Deploy"
                          onClick={() => handleAction(deployApp, app._id || app.id)}
                        >
                          <Play size={12} />
                        </button>
                        <button
                          className="btn btn-xs btn-secondary"
                          title="Restart"
                          onClick={() => handleAction(restartApp, app._id || app.id)}
                        >
                          <RotateCcw size={12} />
                        </button>
                        <button
                          className="btn btn-xs btn-danger"
                          title="Stop"
                          onClick={() => handleAction(stopApp, app._id || app.id)}
                        >
                          <Square size={12} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default Dashboard;
