import { useState, useEffect, useCallback } from 'react';
import {
  Database, Plus, Play, RotateCcw, Square, Trash2, Terminal, Link2, Copy, Check, Eye, EyeOff, X, RefreshCw,
} from 'lucide-react';
import StatusBadge from '../components/StatusBadge';
import LogViewer from '../components/LogViewer';
import useApps from '../hooks/useApps';
import { useAuth } from '../context/AuthContext';
import { useWebSocket } from '../context/WebSocketContext';
import {
  getServiceTemplates, getServices, createService, controlService, getServiceLogs, attachServiceToApp, deleteService,
} from '../api/services';

function Services() {
  const { user } = useAuth();
  const canManage = user?.role === 'admin' || user?.role === 'operator';
  const { subscribe } = useWebSocket();
  const { apps, fetchApps } = useApps();

  const [templates, setTemplates] = useState({});
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [creating, setCreating] = useState(false);

  const [form, setForm] = useState({
    serviceType: 'postgres',
    name: '',
    databaseName: 'appdb',
    port: '',
    memoryLimitMb: '512',
  });

  const [revealedIds, setRevealedIds] = useState({});
  const [copiedKey, setCopiedKey] = useState('');
  const [attachTarget, setAttachTarget] = useState(null);
  const [attachAppId, setAttachAppId] = useState('');
  const [attachEnvKey, setAttachEnvKey] = useState('');
  const [attachBusy, setAttachBusy] = useState(false);

  const [logsTarget, setLogsTarget] = useState(null);
  const [serviceLogs, setServiceLogs] = useState('');
  const [logsLoading, setLogsLoading] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [removeVolume, setRemoveVolume] = useState(false);

  const loadAll = useCallback(async () => {
    try {
      const [tpls, list] = await Promise.all([getServiceTemplates(), getServices()]);
      setTemplates(tpls || {});
      setServices(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to load managed services.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([getServiceTemplates(), getServices()])
      .then(([tpls, list]) => {
        if (!active) return;
        setTemplates(tpls || {});
        setServices(Array.isArray(list) ? list : []);
      })
      .catch((err) => {
        if (active) setError(err?.response?.data?.error || 'Failed to load managed services.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    void fetchApps();
    return () => { active = false; };
  }, [fetchApps]);

  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === 'services:changed') {
        void loadAll();
      }
    });
  }, [subscribe, loadAll]);

  const handleSelectTemplate = (type) => {
    const tpl = templates[type];
    setForm((f) => ({
      ...f,
      serviceType: type,
      databaseName: tpl?.defaultDatabase || '',
    }));
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    setError('');
    setNotice('');
    if (!form.name.trim()) {
      setError('Service name is required.');
      return;
    }
    setCreating(true);
    try {
      const res = await createService({
        name: form.name.trim().toLowerCase(),
        serviceType: form.serviceType,
        port: form.port ? Number(form.port) : undefined,
        databaseName: form.databaseName.trim(),
        memoryLimitMb: Number(form.memoryLimitMb) || 512,
      });
      setForm((f) => ({ ...f, name: '', port: '' }));
      setNotice(
        res.startError
          ? `Service '${res.service.name}' created, but container failed to start: ${res.startError}`
          : `Managed service '${res.service.name}' created and running on port ${res.service.port}.`
      );
      await loadAll();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to create managed service.');
    } finally {
      setCreating(false);
    }
  };

  const handleControl = async (id, action) => {
    setError('');
    setNotice('');
    try {
      const updated = await controlService(id, action);
      setNotice(`Service '${updated.name}' is now ${updated.status}.`);
      await loadAll();
    } catch (err) {
      setError(err?.response?.data?.error || `Failed to ${action} service.`);
    }
  };

  const openLogs = async (svc) => {
    setLogsTarget(svc);
    setServiceLogs('');
    setLogsLoading(true);
    try {
      const res = await getServiceLogs(svc.id);
      setServiceLogs(res.logs || res.reason || 'No logs recorded yet.');
    } catch (err) {
      setServiceLogs(err?.response?.data?.error || 'Failed to fetch logs.');
    } finally {
      setLogsLoading(false);
    }
  };

  const openAttach = (svc) => {
    setAttachTarget(svc);
    setAttachAppId(apps[0]?.id ? String(apps[0].id) : '');
    setAttachEnvKey(svc.suggested_env_key || 'DATABASE_URL');
  };

  const handleAttachSubmit = async (e) => {
    e.preventDefault();
    if (!attachTarget || !attachAppId) return;
    setAttachBusy(true);
    setError('');
    try {
      const res = await attachServiceToApp(attachTarget.id, attachAppId, attachEnvKey.trim());
      setNotice(res.message);
      setAttachTarget(null);
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to attach service.');
    } finally {
      setAttachBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    setError('');
    try {
      const res = await deleteService(target.id, removeVolume);
      setRemoveVolume(false);
      setNotice(res.message);
      await loadAll();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to delete service.');
    }
  };

  const copyValue = (key, text) => {
    if (!text) return;
    navigator.clipboard?.writeText(text).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(''), 2000);
    }).catch(() => {});
  };

  const templateEntries = Object.entries(templates);

  return (
    <div className="page">
      <div className="page-header">
        <h2 className="page-heading" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Database size={18} /> Managed Databases &amp; Services
        </h2>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: '16px' }}>{error}</div>}
      {notice && <div className="alert alert-success" style={{ marginBottom: '16px' }}>{notice}</div>}

      {canManage && (
        <div className="detail-card" style={{ marginBottom: '24px' }}>
          <h3 className="detail-card-title">Provision Managed Service</h3>

          <div className="service-template-grid">
            {templateEntries.map(([key, tpl]) => (
              <button
                key={key}
                type="button"
                className={`service-template-card${form.serviceType === key ? ' service-template-card--active' : ''}`}
                onClick={() => handleSelectTemplate(key)}
              >
                <span className="service-template-name">{tpl.label}</span>
                <span className="service-template-meta">v{tpl.version} · :{tpl.defaultPort}</span>
              </button>
            ))}
          </div>

          <form className="domain-add-form" onSubmit={handleCreate} style={{ marginTop: '14px' }}>
            <div className="domain-add-field">
              <label className="form-label" htmlFor="svc-name">Service Name *</label>
              <input
                id="svc-name"
                type="text"
                className="form-input"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>

            {form.serviceType !== 'redis' && (
              <div className="domain-add-field">
                <label className="form-label" htmlFor="svc-db">Database Name</label>
                <input
                  id="svc-db"
                  type="text"
                  className="form-input"
                  value={form.databaseName}
                  onChange={(e) => setForm((f) => ({ ...f, databaseName: e.target.value }))}
                />
              </div>
            )}

            <div className="domain-add-field">
              <label className="form-label" htmlFor="svc-port">Port (auto if blank)</label>
              <input
                id="svc-port"
                type="number"
                className="form-input"
                value={form.port}
                onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))}
                min={1024}
                max={65535}
              />
            </div>

            <div className="domain-add-field">
              <label className="form-label" htmlFor="svc-mem">Memory (MB)</label>
              <input
                id="svc-mem"
                type="number"
                className="form-input"
                value={form.memoryLimitMb}
                onChange={(e) => setForm((f) => ({ ...f, memoryLimitMb: e.target.value }))}
                min={128}
                max={16384}
              />
            </div>

            <div className="domain-add-submit">
              <button type="submit" className="btn btn-primary" disabled={creating}>
                <Plus size={14} /> {creating ? 'Provisioning…' : 'Create Service'}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="section" style={{ marginTop: 0 }}>
        <h3 className="section-title">Provisioned Services ({services.length})</h3>
        {loading ? (
          <div className="loading-state">Loading services…</div>
        ) : services.length === 0 ? (
          <div className="empty-state">
            <Database size={38} />
            <p>No managed databases provisioned yet. Create PostgreSQL, Redis, MySQL, or MongoDB above.</p>
          </div>
        ) : (
          <div className="app-grid">
            {services.map((svc) => {
              const revealed = Boolean(revealedIds[svc.id]);
              return (
                <div key={svc.id} className="app-card">
                  <div className="app-card-header">
                    <div>
                      <span className="app-card-name">{svc.name}</span>
                      <div className="app-card-repo">
                        {(templates[svc.service_type]?.label || svc.service_type)} v{svc.version} · Host: <code>{svc.container_hostname}</code>
                      </div>
                    </div>
                    <StatusBadge status={svc.status} />
                  </div>

                  <div className="app-card-meta">
                    <span>Port: <strong>{svc.port}</strong></span>
                    {svc.database_name && <span>DB: <strong>{svc.database_name}</strong></span>}
                    <span>RAM: <strong>{svc.memory_limit_mb} MB</strong></span>
                  </div>

                  <div className="service-conn-box">
                    <div className="code-block-header">
                      <span className="form-hint">Internal Connection URL ({svc.suggested_env_key})</span>
                      <div style={{ display: 'flex', gap: '4px' }}>
                        {canManage && (
                          <button
                            type="button"
                            className="btn btn-xs btn-secondary"
                            onClick={() => setRevealedIds((p) => ({ ...p, [svc.id]: !p[svc.id] }))}
                          >
                            {revealed ? <EyeOff size={11} /> : <Eye size={11} />}
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-xs btn-secondary"
                          onClick={() => copyValue(`int-${svc.id}`, svc.internal_url)}
                          disabled={!canManage}
                        >
                          {copiedKey === `int-${svc.id}` ? <Check size={11} /> : <Copy size={11} />}
                        </button>
                      </div>
                    </div>
                    <code className="webhook-url">
                      {revealed ? svc.internal_url : svc.internal_url.replace(/:([^:@]+)@/, ':••••••••@')}
                    </code>
                  </div>

                  <div className="app-card-actions">
                    {canManage && (
                      <>
                        {svc.status !== 'running' ? (
                          <button className="btn btn-sm btn-primary" onClick={() => handleControl(svc.id, 'start')}>
                            <Play size={13} /> Start
                          </button>
                        ) : (
                          <button className="btn btn-sm btn-secondary" onClick={() => handleControl(svc.id, 'restart')}>
                            <RotateCcw size={13} /> Restart
                          </button>
                        )}
                        {svc.status === 'running' && (
                          <button className="btn btn-sm btn-secondary" onClick={() => handleControl(svc.id, 'stop')}>
                            <Square size={13} /> Stop
                          </button>
                        )}
                        <button className="btn btn-sm btn-secondary" onClick={() => openAttach(svc)} disabled={apps.length === 0}>
                          <Link2 size={13} /> Attach
                        </button>
                      </>
                    )}
                    <button className="btn btn-sm btn-secondary" onClick={() => openLogs(svc)}>
                      <Terminal size={13} /> Logs
                    </button>
                    {canManage && (
                      <button
                        className="btn btn-sm btn-danger app-card-edit-btn"
                        onClick={() => setDeleteTarget(svc)}
                        title="Delete service"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {attachTarget && (
        <div className="modal-overlay" onClick={() => setAttachTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Attach &ldquo;{attachTarget.name}&rdquo; to App</h3>
              <button className="modal-close" onClick={() => setAttachTarget(null)}><X size={16} /></button>
            </div>
            <form onSubmit={handleAttachSubmit}>
              <div className="modal-body">
                <p style={{ marginBottom: '12px' }}>
                  Injects the private Docker-network connection URL directly into the selected application&apos;s environment variables.
                </p>
                <div className="form-group">
                  <label className="form-label" htmlFor="attach-app">Target Application</label>
                  <select
                    id="attach-app"
                    className="form-input"
                    value={attachAppId}
                    onChange={(e) => setAttachAppId(e.target.value)}
                  >
                    {apps.map((a) => (
                      <option key={a.id} value={String(a.id)}>{a.name} (:{a.port})</option>
                    ))}
                  </select>
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label" htmlFor="attach-key">Environment Variable Name</label>
                  <input
                    id="attach-key"
                    type="text"
                    className="form-input"
                    value={attachEnvKey}
                    onChange={(e) => setAttachEnvKey(e.target.value)}
                  />
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setAttachTarget(null)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={attachBusy}>
                  {attachBusy ? 'Attaching…' : 'Attach to Application'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {logsTarget && (
        <div className="modal-overlay" onClick={() => setLogsTarget(null)}>
          <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Service Logs — {logsTarget.name}</h3>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                <button className="btn btn-xs btn-secondary" onClick={() => openLogs(logsTarget)} disabled={logsLoading}>
                  <RefreshCw size={12} /> Refresh
                </button>
                <button className="modal-close" onClick={() => setLogsTarget(null)}><X size={16} /></button>
              </div>
            </div>
            <div className="modal-body">
              <LogViewer logs={logsLoading ? 'Loading logs…' : serviceLogs} />
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="modal-overlay" onClick={() => setDeleteTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Delete Service</h3>
              <button className="modal-close" onClick={() => setDeleteTarget(null)}><X size={16} /></button>
            </div>
            <div className="modal-body">
              <p style={{ marginBottom: '12px' }}>
                Delete managed service <strong>{deleteTarget.name}</strong> and stop its Docker container?
              </p>
              <label className="ssl-checkbox-label">
                <input
                  type="checkbox"
                  checked={removeVolume}
                  onChange={(e) => setRemoveVolume(e.target.checked)}
                />
                <span>Also delete persistent data volume ({deleteTarget.volume_name})</span>
              </label>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button className="btn btn-danger" onClick={confirmDelete}>Delete Service</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Services;
