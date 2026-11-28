import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Plus, Play, RotateCcw, Square, Activity, Server, AlertTriangle, ExternalLink, Database, Copy, Check,
} from 'lucide-react';
import StatusBadge from '../components/StatusBadge';
import CreateDatabaseModal from '../components/CreateDatabaseModal';
import useApps from '../hooks/useApps';
import { useAuth } from '../context/AuthContext';
import { useWebSocket } from '../context/WebSocketContext';
import { deployApp, restartApp, stopApp } from '../api/apps';
import { getSystemStats } from '../api/system';
import { getDomainSystemStatus } from '../api/domains';
import { getServices, controlService } from '../api/services';
import { getPrimaryAppAccess } from '../utils/appUrl';

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
  const { user } = useAuth();
  const canManage = user?.role === 'admin' || user?.role === 'operator';
  const { apps, setApps, loading, error, fetchApps } = useApps();
  const { connected, systemStats: wsStats, subscribe } = useWebSocket();
  const [polledStats, setPolledStats] = useState(null);
  const [sysStatus, setSysStatus] = useState(null);
  const [services, setServices] = useState([]);
  const [showCreateDbModal, setShowCreateDbModal] = useState(false);
  const [dbNotice, setDbNotice] = useState('');
  const [dbError, setDbError] = useState('');
  const [copiedSvcKey, setCopiedSvcKey] = useState('');
  const [actionError, setActionError] = useState('');
  const stats = wsStats || polledStats;

  useEffect(() => {
    void fetchApps();
    getDomainSystemStatus().then(setSysStatus).catch(() => {});
    getServices().then((list) => setServices(Array.isArray(list) ? list : [])).catch(() => {});
  }, [fetchApps]);

  useEffect(() => {
    if (connected) return undefined;
    let active = true;
    const poll = () => {
      getSystemStats()
        .then((data) => {
          if (active && data) setPolledStats(data);
        })
        .catch(() => {});
    };
    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [connected]);

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
      } else if (msg.type === 'services:changed') {
        getServices().then((list) => setServices(Array.isArray(list) ? list : [])).catch(() => {});
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

  const handleServiceAction = async (id, action) => {
    setDbError('');
    setDbNotice('');
    try {
      const updated = await controlService(id, action);
      setDbNotice(`Database '${updated.name}' is now ${updated.status}.`);
      const list = await getServices();
      setServices(Array.isArray(list) ? list : []);
    } catch (err) {
      setDbError(err?.response?.data?.error || `Failed to ${action} database.`);
      getServices().then((list) => setServices(Array.isArray(list) ? list : [])).catch(() => {});
    }
  };

  const handleCopyDbUrl = (key, value) => {
    if (!value) return;
    navigator.clipboard?.writeText(value).then(() => {
      setCopiedSvcKey(key);
      setTimeout(() => setCopiedSvcKey(''), 2000);
    }).catch(() => {});
  };

  return (
    <div className="page">
      <div className="page-header">
        <h2 className="page-heading">Overview</h2>
        <div className="action-btns">
          {canManage && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setShowCreateDbModal(true)}
            >
              <Database size={15} /> Create Database
            </button>
          )}
          <Link to="/apps/new" className="btn btn-primary">
            <Plus size={15} /> New Application
          </Link>
        </div>
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
          color="var(--success-text)"
        />
        <StatCard
          icon={<AlertTriangle size={22} />}
          label="Failed"
          value={failedApps}
          color="var(--danger)"
        />
        <StatCard
          icon={<Database size={22} />}
          label="Databases"
          value={services.length}
          color="var(--info-text)"
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

        const hasSwap = Boolean(stats.swap && stats.swap.total > 0);
        const swapPercent = stats.swap?.percent ?? 0;
        const swapDetail = hasSwap
          ? `${formatBytes(stats.swap.used)} / ${formatBytes(stats.swap.total)}`
          : null;

        const diskPercent = stats.disk?.percent ?? stats.diskPercent ?? stats.disk ?? 0;
        const diskDetail = stats.disk?.total
          ? `${formatBytes(stats.disk.used)} / ${formatBytes(stats.disk.total)}`
          : null;

        const resources = [
          { key: 'cpu', label: 'CPU', detail: cpuDetail, percent: cpuLoad, fillClass: '' },
          { key: 'ram', label: 'RAM', detail: memDetail, percent: memPercent, fillClass: 'resource-fill--ram' },
          ...(hasSwap
            ? [{ key: 'swap', label: 'Swap', detail: swapDetail, percent: swapPercent, fillClass: 'resource-fill--swap' }]
            : []),
          ...(stats.disk !== undefined
            ? [{ key: 'disk', label: 'Disk', detail: diskDetail, percent: diskPercent, fillClass: 'resource-fill--disk' }]
            : []),
        ];

        return (
          <div className="section">
            <h3 className="section-title">Server Resources</h3>
            <div className="resource-cards">
              {resources.map((res) => (
                <div key={res.key} className="resource-card">
                  <div className="resource-header">
                    <span className="resource-label">{res.label}</span>
                    {res.detail && <span className="resource-detail">{res.detail}</span>}
                    <span className="resource-value">{res.percent}%</span>
                  </div>
                  <div className="resource-bar">
                    <div
                      className={`resource-fill${res.fillClass ? ` ${res.fillClass}` : ''}`}
                      style={{ width: `${Math.min(res.percent, 100)}%` }}
                    />
                  </div>
                </div>
              ))}
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
                  <th>Access URL</th>
                  <th>Last Deployed</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {apps.map((app) => {
                  const access = getPrimaryAppAccess(app, app.domains, sysStatus);
                  return (
                  <tr key={app._id || app.id}>
                    <td>
                      <Link to={`/apps/${app._id || app.id}`} className="table-link">
                        {app.name}
                      </Link>
                    </td>
                    <td><StatusBadge status={app.status} /></td>
                    <td>{app.port || '—'}</td>
                    <td>
                      {access ? (
                        <a
                          href={access.url}
                          target="_blank"
                          rel="noreferrer"
                          className="app-access-link"
                        >
                          {access.label} <ExternalLink size={11} />
                        </a>
                      ) : '—'}
                    </td>
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
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="section">
        <div className="section-header-row">
          <h3 className="section-title" style={{ marginBottom: 0 }}>Databases</h3>
          <div className="action-btns">
            {canManage && (
              <button
                type="button"
                className="btn btn-xs btn-primary"
                onClick={() => setShowCreateDbModal(true)}
              >
                <Plus size={12} /> Create Database
              </button>
            )}
            <Link to="/databases" className="btn btn-xs btn-secondary">
              Manage All
            </Link>
          </div>
        </div>

        {dbError && <div className="alert alert-error" style={{ marginBottom: '12px' }}>{dbError}</div>}
        {dbNotice && <div className="alert alert-success" style={{ marginBottom: '12px' }}>{dbNotice}</div>}

        {services.length === 0 ? (
          <div className="empty-state">
            <Database size={36} />
            <p>No managed databases yet. Spin up PostgreSQL or MongoDB in seconds.</p>
            {canManage && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setShowCreateDbModal(true)}
              >
                <Database size={14} /> Create Database
              </button>
            )}
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Engine</th>
                  <th>Status</th>
                  <th>Host : Port</th>
                  <th>Connection URL</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {services.map((svc) => (
                  <tr key={svc.id}>
                    <td>
                      <Link to="/databases" className="table-link">{svc.name}</Link>
                    </td>
                    <td><span className="project-type-pill">{svc.service_type}</span></td>
                    <td><StatusBadge status={svc.status} /></td>
                    <td>
                      <code>{svc.public_access ? `${svc.public_host}:${svc.port}` : `127.0.0.1:${svc.port}`}</code>
                      <span className="form-hint" style={{ marginLeft: '6px' }}>
                        ({svc.public_access ? 'Public' : 'Private'})
                      </span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-xs btn-secondary"
                        onClick={() => handleCopyDbUrl(`dash-${svc.id}`, svc.public_access ? svc.external_url : svc.internal_url)}
                        disabled={!canManage}
                        title={svc.public_access ? 'Copy public URL' : 'Copy internal Docker URL'}
                      >
                        {copiedSvcKey === `dash-${svc.id}`
                          ? <><Check size={11} /> Copied</>
                          : <><Copy size={11} /> Copy URL</>}
                      </button>
                    </td>
                    <td>
                      {canManage && (
                        <div className="action-btns">
                          {svc.status !== 'running' ? (
                            <button
                              type="button"
                              className="btn btn-xs btn-primary"
                              title="Start"
                              onClick={() => handleServiceAction(svc.id, 'start')}
                            >
                              <Play size={12} />
                            </button>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="btn btn-xs btn-secondary"
                                title="Restart"
                                onClick={() => handleServiceAction(svc.id, 'restart')}
                              >
                                <RotateCcw size={12} />
                              </button>
                              <button
                                type="button"
                                className="btn btn-xs btn-danger"
                                title="Stop"
                                onClick={() => handleServiceAction(svc.id, 'stop')}
                              >
                                <Square size={12} />
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <CreateDatabaseModal
        isOpen={showCreateDbModal}
        onClose={() => setShowCreateDbModal(false)}
        onCreated={(res) => {
          setDbError('');
          setDbNotice('');
          if (res?.startError) {
            setDbError(`Service '${res.service.name}' created, but failed to start: ${res.startError}`);
          } else {
            setDbNotice(`Service '${res?.service?.name}' (${res?.service?.service_type}) created on port ${res?.service?.port}.`);
          }
          getServices().then((list) => setServices(Array.isArray(list) ? list : [])).catch(() => {});
        }}
      />
    </div>
  );
}

export default Dashboard;
