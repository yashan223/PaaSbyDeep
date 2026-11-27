import { Link } from 'react-router-dom';
import { Plus, Play, RotateCcw, Square, Pencil, Server, Globe, ExternalLink } from 'lucide-react';
import StatusBadge from '../components/StatusBadge';
import useApps from '../hooks/useApps';
import { useWebSocket } from '../context/WebSocketContext';
import { deployApp, restartApp, stopApp } from '../api/apps';
import { getDomainSystemStatus } from '../api/domains';
import { getPrimaryAppAccess } from '../utils/appUrl';
import { useState, useEffect } from 'react';

function AppList() {
  const { apps, setApps, loading, error, fetchApps } = useApps();
  const { subscribe } = useWebSocket();
  const [sysStatus, setSysStatus] = useState(null);
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    void fetchApps();
    getDomainSystemStatus().then(setSysStatus).catch(() => {});
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
      } else if (msg.type === 'apps:changed' || msg.type === 'domains:changed') {
        void fetchApps();
      }
    });
  }, [subscribe, setApps, fetchApps]);

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
        <h2 className="page-heading">Applications</h2>
        <Link to="/apps/new" className="btn btn-primary">
          <Plus size={15} /> New Application
        </Link>
      </div>

      {actionError && <div className="alert alert-error" style={{ marginBottom: '12px' }}>{actionError}</div>}

      {loading && apps.length === 0 ? (
        <div className="loading-state">Loading applications…</div>
      ) : error ? (
        <div className="alert alert-error">{error}</div>
      ) : apps.length === 0 ? (
        <div className="empty-state">
          <Server size={40} />
          <p>No applications yet. Deploy your first app to get started.</p>
          <Link to="/apps/new" className="btn btn-primary">Deploy first app</Link>
        </div>
      ) : (
        <div className="app-grid">
          {apps.map((app) => {
            const id = app._id || app.id;
            return (
              <div key={id} className="app-card">
                <div className="app-card-header">
                  <div>
                    <Link to={`/apps/${id}`} className="app-card-name">{app.name}</Link>
                    <div className="app-card-repo">{app.repo_url || app.repoUrl || app.repository || '—'}</div>
                  </div>
                  <StatusBadge status={app.status} />
                </div>

                <div className="app-card-meta">
                  <span>Branch: <strong>{app.branch || 'main'}</strong></span>
                  <span>Port: <strong>{app.port || '—'}</strong></span>
                  {app.project_type && app.project_type !== 'auto' && (
                    <span className="project-type-pill">{app.project_type}</span>
                  )}
                </div>

                {(() => {
                  const access = getPrimaryAppAccess(app, app.domains, sysStatus);
                  return access ? (
                    <div className="app-card-access">
                      <a
                        href={access.url}
                        target="_blank"
                        rel="noreferrer"
                        className="app-access-link"
                        title={access.isDomain ? 'Open configured domain' : 'No domain added — open via IP & port'}
                      >
                        <Globe size={12} />
                        <span>{access.label}</span>
                        <ExternalLink size={11} />
                      </a>
                    </div>
                  ) : null;
                })()}

                {(app.last_deployed_at || app.lastDeployedAt) && (
                  <div className="app-card-date">
                    Last deployed: {new Date(app.last_deployed_at || app.lastDeployedAt).toLocaleString()}
                  </div>
                )}

                <div className="app-card-actions">
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => handleAction(deployApp, id)}
                  >
                    <Play size={13} /> Deploy
                  </button>
                  <button
                    className="btn btn-sm btn-secondary"
                    onClick={() => handleAction(restartApp, id)}
                  >
                    <RotateCcw size={13} /> Restart
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => handleAction(stopApp, id)}
                  >
                    <Square size={13} /> Stop
                  </button>
                  <Link to={`/apps/${id}/edit`} className="btn btn-sm btn-secondary app-card-edit-btn">
                    <Pencil size={13} /> Edit
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default AppList;
