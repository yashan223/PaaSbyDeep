import { useState, useEffect, useCallback } from 'react';
import {
  Database, Plus, Play, RotateCcw, Square, Trash2, Terminal, Link2, Copy, Check, Eye, EyeOff, X, RefreshCw,
  HardDrive, ExternalLink, Lock, Globe,
} from 'lucide-react';
import StatusBadge from '../components/StatusBadge';
import LogViewer from '../components/LogViewer';
import CreateDatabaseModal from '../components/CreateDatabaseModal';
import StorageBucketsModal from '../components/StorageBucketsModal';
import useApps from '../hooks/useApps';
import { useAuth } from '../context/AuthContext';
import { useWebSocket } from '../context/WebSocketContext';
import {
  getServiceTemplates, getServices, controlService, setServiceAccess, getServiceLogs,
  attachServiceToApp, deleteService, listServiceBuckets,
} from '../api/services';
import { DEFAULT_SERVICE_TEMPLATES } from '../utils/serviceTemplates';

function Services() {
  const { user } = useAuth();
  const canManage = user?.role === 'admin' || user?.role === 'operator';
  const { subscribe } = useWebSocket();
  const { apps, fetchApps } = useApps();

  const [templates, setTemplates] = useState(DEFAULT_SERVICE_TEMPLATES);
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const [revealedIds, setRevealedIds] = useState({});
  const [copiedKey, setCopiedKey] = useState('');
  const [attachTarget, setAttachTarget] = useState(null);
  const [attachAppId, setAttachAppId] = useState('');
  const [attachEnvKey, setAttachEnvKey] = useState('');
  const [attachBucketName, setAttachBucketName] = useState('');
  const [attachBuckets, setAttachBuckets] = useState([]);
  const [attachBusy, setAttachBusy] = useState(false);

  const [bucketsTarget, setBucketsTarget] = useState(null);

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

  const handleControl = async (id, action) => {
    setError('');
    setNotice('');
    setBusyId(id);
    try {
      const updated = await controlService(id, action);
      setNotice(`Service '${updated.name}' is now ${updated.status}.`);
      await loadAll();
    } catch (err) {
      setError(err?.response?.data?.error || `Failed to ${action} service.`);
      await loadAll();
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleAccess = async (svc) => {
    setError('');
    setNotice('');
    setBusyId(svc.id);
    try {
      const nextPublic = !svc.public_access;
      const updated = await setServiceAccess(svc.id, nextPublic);
      setNotice(
        `Service '${updated.name}' is now ${nextPublic ? 'publicly reachable on VPS IP' : 'restricted to private Docker network & localhost'}.`
      );
      await loadAll();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to update service network access.');
    } finally {
      setBusyId(null);
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
    setAttachBucketName('');
    setAttachBuckets([]);
    if (svc.service_type === 'minio') {
      listServiceBuckets(svc.id)
        .then((res) => {
          const list = Array.isArray(res?.buckets) ? res.buckets : [];
          setAttachBuckets(list);
          if (list[0]?.name) setAttachBucketName(list[0].name);
        })
        .catch(() => {});
    }
  };

  const handleAttachSubmit = async (e) => {
    e.preventDefault();
    if (!attachTarget || !attachAppId) return;
    setAttachBusy(true);
    setError('');
    try {
      const res = await attachServiceToApp(
        attachTarget.id,
        attachAppId,
        attachEnvKey.trim(),
        attachTarget.service_type === 'minio' ? attachBucketName.trim() : ''
      );
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

  return (
    <div className="page">
      <div className="page-header">
        <h2 className="page-heading" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Database size={18} /> Databases &amp; Services
        </h2>
        {canManage && (
          <button type="button" className="btn btn-primary" onClick={() => setShowCreateModal(true)}>
            <Plus size={15} /> Create Database
          </button>
        )}
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: '16px' }}>{error}</div>}
      {notice && <div className="alert alert-success" style={{ marginBottom: '16px' }}>{notice}</div>}

      <div className="section" style={{ marginTop: 0 }}>
        <h3 className="section-title">Provisioned Databases &amp; Services ({services.length})</h3>
        {loading ? (
          <div className="loading-state">Loading databases…</div>
        ) : services.length === 0 ? (
          <div className="empty-state">
            <Database size={38} />
            <p>No managed databases or storage services provisioned yet. Create PostgreSQL, MongoDB, MinIO (S3), Redis, or MySQL.</p>
            {canManage && (
              <button type="button" className="btn btn-primary" onClick={() => setShowCreateModal(true)}>
                <Plus size={14} /> Create Database
              </button>
            )}
          </div>
        ) : (
          <div className="app-grid app-grid--services">
            {services.map((svc) => {
              const revealed = Boolean(revealedIds[svc.id]);
              const isMinio = svc.service_type === 'minio';
              const isBusy = busyId === svc.id;
              return (
                <div key={svc.id} className="app-card">
                  <div className="app-card-header">
                    <div>
                      <span className="app-card-name">{svc.name}</span>
                      <div className="app-card-repo">
                        {(templates[svc.service_type]?.label || svc.service_type)} v{svc.version}
                      </div>
                      <div className="service-host-line">
                        Host: <code>{svc.container_hostname}</code>
                      </div>
                    </div>
                    <StatusBadge status={svc.status} />
                  </div>

                  <div className="app-card-meta">
                    <span>Port: <strong>{svc.port}</strong></span>
                    {svc.console_port && <span>Console: <strong>{svc.console_port}</strong></span>}
                    {svc.database_name && <span>DB: <strong>{svc.database_name}</strong></span>}
                    <span>RAM: <strong>{svc.memory_limit_mb} MB</strong></span>
                    <span className={`service-access-pill ${svc.public_access ? 'service-access-pill--public' : 'service-access-pill--private'}`}>
                      {svc.public_access ? <><Globe size={11} /> Public</> : <><Lock size={11} /> Private</>}
                    </span>
                  </div>

                  {svc.status === 'error' && (
                    <div className="alert alert-error service-inline-error">
                      {svc.last_error || 'Container failed to start. Click Start to retry or Logs to inspect.'}
                    </div>
                  )}

                  <div className="service-conn-box">
                    <div className="code-block-header">
                      <span className="form-hint">
                        Internal Docker URL ({svc.suggested_env_key})
                      </span>
                      <div style={{ display: 'flex', gap: '4px' }}>
                        {!isMinio && canManage && (
                          <button
                            type="button"
                            className="btn btn-xs btn-secondary"
                            onClick={() => setRevealedIds((p) => ({ ...p, [svc.id]: !p[svc.id] }))}
                            title={revealed ? 'Hide credentials' : 'Reveal credentials'}
                          >
                            {revealed ? <EyeOff size={11} /> : <Eye size={11} />}
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-xs btn-secondary"
                          onClick={() => copyValue(`int-${svc.id}`, svc.internal_url)}
                          disabled={!canManage}
                          title="Copy Internal Docker URL"
                        >
                          {copiedKey === `int-${svc.id}` ? <Check size={11} /> : <Copy size={11} />}
                        </button>
                      </div>
                    </div>
                    <code className="webhook-url">
                      {revealed ? svc.internal_url : svc.internal_url.replace(/:([^:@]+)@/, ':••••••••@')}
                    </code>
                    <span className="form-hint" style={{ display: 'block', marginTop: '6px' }}>
                      For backend apps on this VPS only (internal Docker network — not openable in browsers).
                    </span>
                  </div>

                  <div className="service-conn-box">
                    <div className="code-block-header">
                      <span className="form-hint">
                        {svc.public_access
                          ? (isMinio ? 'Public S3 Endpoint (HTTP · Unencrypted)' : 'Public External URL (Raw TCP)')
                          : 'Private Access & SSH Tunnel'}
                      </span>
                      <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                        {canManage && (
                          <button
                            type="button"
                            className="btn btn-xs btn-secondary"
                            disabled={isBusy}
                            onClick={() => handleToggleAccess(svc)}
                            title={svc.public_access ? 'Restrict to private Docker network & 127.0.0.1' : 'Expose port publicly on VPS IP'}
                          >
                            {svc.public_access ? <><Lock size={11} /> Make Private</> : <><Globe size={11} /> Make Public</>}
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-xs btn-secondary"
                          onClick={() => copyValue(`ext-${svc.id}`, svc.public_access ? svc.external_url : (svc.ssh_tunnel_cmd || svc.external_url))}
                          disabled={!canManage}
                          title={svc.public_access ? 'Copy Public URL' : 'Copy SSH Tunnel Command'}
                        >
                          {copiedKey === `ext-${svc.id}` ? <Check size={11} /> : <Copy size={11} />}
                        </button>
                      </div>
                    </div>
                    <code className="webhook-url">
                      {svc.public_access
                        ? (revealed ? svc.external_url : svc.external_url.replace(/:([^:@]+)@/, ':••••••••@'))
                        : (svc.ssh_tunnel_cmd || svc.external_url)}
                    </code>
                    <span className="form-hint" style={{ display: 'block', marginTop: '6px' }}>
                      {svc.public_access
                        ? 'Bound on 0.0.0.0 (unencrypted). Use Make Private to close public port access.'
                        : `Bound to 127.0.0.1:${svc.port}. Run SSH tunnel locally to reach http://localhost:${isMinio ? (svc.console_port || svc.port) : svc.port} securely.`}
                    </span>
                  </div>

                  {isMinio && (
                    <div className="service-conn-box">
                      <div className="code-block-header">
                        <span className="form-hint">S3 Credentials &amp; Web Console</span>
                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                          {svc.public_access && svc.console_url ? (
                            <a
                              href={svc.console_url}
                              target="_blank"
                              rel="noreferrer"
                              className="app-access-link"
                            >
                              Console <ExternalLink size={11} />
                            </a>
                          ) : (
                            <span className="form-hint">Console :{svc.console_port || 9001} (via SSH)</span>
                          )}
                          {canManage && (
                            <button
                              type="button"
                              className="btn btn-xs btn-secondary"
                              onClick={() => setRevealedIds((p) => ({ ...p, [svc.id]: !p[svc.id] }))}
                              title={revealed ? 'Hide secret key' : 'Reveal secret key'}
                            >
                              {revealed ? <EyeOff size={11} /> : <Eye size={11} />}
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="minio-cred-grid">
                        <div className="minio-cred-row">
                          <span className="form-hint">Access Key</span>
                          <div className="minio-cred-val-wrap">
                            <code className="minio-cred-val">{svc.access_key || 'paasadmin'}</code>
                            <button
                              type="button"
                              className="btn btn-xs btn-secondary"
                              onClick={() => copyValue(`ak-${svc.id}`, svc.access_key || 'paasadmin')}
                              disabled={!canManage}
                              title="Copy Access Key"
                            >
                              {copiedKey === `ak-${svc.id}` ? <Check size={10} /> : <Copy size={10} />}
                            </button>
                          </div>
                        </div>
                        <div className="minio-cred-row">
                          <span className="form-hint">Secret Key</span>
                          <div className="minio-cred-val-wrap">
                            <code className="minio-cred-val">
                              {revealed ? (svc.secret_key || '—') : '••••••••'}
                            </code>
                            <button
                              type="button"
                              className="btn btn-xs btn-secondary"
                              onClick={() => copyValue(`sk-${svc.id}`, svc.secret_key)}
                              disabled={!canManage || !svc.secret_key}
                              title="Copy Secret Key"
                            >
                              {copiedKey === `sk-${svc.id}` ? <Check size={10} /> : <Copy size={10} />}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="app-card-actions service-card-actions">
                    {canManage && (
                      <>
                        {svc.status !== 'running' ? (
                          <button
                            className="btn btn-sm btn-primary"
                            disabled={isBusy}
                            onClick={() => handleControl(svc.id, 'start')}
                          >
                            <Play size={13} /> {isBusy ? 'Starting…' : 'Start'}
                          </button>
                        ) : (
                          <button
                            className="btn btn-sm btn-secondary"
                            disabled={isBusy}
                            onClick={() => handleControl(svc.id, 'restart')}
                          >
                            <RotateCcw size={13} /> {isBusy ? 'Restarting…' : 'Restart'}
                          </button>
                        )}
                        {svc.status === 'running' && (
                          <button
                            className="btn btn-sm btn-secondary"
                            disabled={isBusy}
                            onClick={() => handleControl(svc.id, 'stop')}
                          >
                            <Square size={13} /> Stop
                          </button>
                        )}
                        {isMinio && (
                          <button className="btn btn-sm btn-secondary" onClick={() => setBucketsTarget(svc)}>
                            <HardDrive size={13} /> Buckets
                          </button>
                        )}
                        <button className="btn btn-sm btn-secondary" onClick={() => openAttach(svc)} disabled={apps.length === 0}>
                          <Link2 size={13} /> Attach
                        </button>
                      </>
                    )}
                    {!canManage && isMinio && (
                      <button className="btn btn-sm btn-secondary" onClick={() => setBucketsTarget(svc)}>
                        <HardDrive size={13} /> Buckets
                      </button>
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
                  {attachTarget.service_type === 'minio'
                    ? 'Injects S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_REGION, and S3_FORCE_PATH_STYLE directly into the application environment.'
                    : 'Injects the private Docker-network connection URL directly into the selected application\u2019s environment variables.'}
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
                <div className="form-group" style={{ marginBottom: attachTarget.service_type === 'minio' ? '12px' : 0 }}>
                  <label className="form-label" htmlFor="attach-key">Environment Variable Name</label>
                  <input
                    id="attach-key"
                    type="text"
                    className="form-input"
                    value={attachEnvKey}
                    onChange={(e) => setAttachEnvKey(e.target.value)}
                  />
                </div>
                {attachTarget.service_type === 'minio' && (
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label" htmlFor="attach-bucket">
                      Default Bucket <span className="form-optional">(optional, sets S3_BUCKET)</span>
                    </label>
                    {attachBuckets.length > 0 ? (
                      <select
                        id="attach-bucket"
                        className="form-input"
                        value={attachBucketName}
                        onChange={(e) => setAttachBucketName(e.target.value)}
                      >
                        <option value="">Skip S3_BUCKET</option>
                        {attachBuckets.map((b) => (
                          <option key={b.name} value={b.name}>{b.name}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        id="attach-bucket"
                        type="text"
                        className="form-input"
                        value={attachBucketName}
                        onChange={(e) => setAttachBucketName(e.target.value)}
                      />
                    )}
                  </div>
                )}
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
      <CreateDatabaseModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreated={(res) => {
          setError('');
          setNotice('');
          if (res?.startError) {
            setError(`Service '${res.service.name}' was created, but failed to start: ${res.startError}`);
          } else {
            setNotice(`Managed service '${res.service.name}' created and running on port ${res.service.port}.`);
          }
          void loadAll();
        }}
      />
      <StorageBucketsModal
        isOpen={Boolean(bucketsTarget)}
        service={bucketsTarget}
        canManage={canManage}
        onClose={() => setBucketsTarget(null)}
      />
    </div>
  );
}

export default Services;
