import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  Database, Plus, Play, RotateCcw, Square, Trash2, Terminal, Link2, Copy, Check, Eye, EyeOff, X, RefreshCw,
  HardDrive, ExternalLink, Lock, Globe, KeyRound,
} from 'lucide-react';
import StatusBadge from '../components/StatusBadge';
import LogViewer from '../components/LogViewer';
import CreateDatabaseModal from '../components/CreateDatabaseModal';
import StorageBucketsModal from '../components/StorageBucketsModal';
import useApps from '../hooks/useApps';
import { useAuth } from '../context/AuthContext';
import { useWebSocket } from '../context/WebSocketContext';
import {
  getServiceTemplates, getServices, controlService, setServiceAccess, changeServicePassword, getServiceLogs,
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

  const [passwordTarget, setPasswordTarget] = useState(null);
  const [nextPassword, setNextPassword] = useState('');
  const [showNextPassword, setShowNextPassword] = useState(false);
  const [syncAppsOnPass, setSyncAppsOnPass] = useState(true);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState('');

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

  const openPasswordModal = (svc) => {
    setPasswordTarget(svc);
    setNextPassword('');
    setShowNextPassword(false);
    setSyncAppsOnPass(true);
    setPasswordError('');
  };

  const fillGeneratedPassword = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*_-';
    const bytes = new Uint8Array(24);
    window.crypto.getRandomValues(bytes);
    setNextPassword(Array.from(bytes, (b) => chars[b % chars.length]).join(''));
    setShowNextPassword(true);
  };

  const handlePasswordSubmit = async (e) => {
    e.preventDefault();
    if (!passwordTarget) return;
    if (!nextPassword || nextPassword.length < 8 || nextPassword.length > 128) {
      setPasswordError('New password must be between 8 and 128 characters.');
      return;
    }
    setPasswordBusy(true);
    setPasswordError('');
    setError('');
    setNotice('');
    try {
      const res = await changeServicePassword(passwordTarget.id, {
        password: nextPassword,
        syncApps: syncAppsOnPass,
      });
      setNotice(res.message || `Password updated for '${passwordTarget.name}'.`);
      setPasswordTarget(null);
      await loadAll();
    } catch (err) {
      setPasswordError(err?.response?.data?.error || 'Failed to change password.');
    } finally {
      setPasswordBusy(false);
    }
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
                        Backend App Connection (Container-Only · {svc.suggested_env_key})
                      </span>
                      <div style={{ display: 'flex', gap: '4px' }}>
                        {canManage && (
                          <button
                            type="button"
                            className="btn btn-xs btn-secondary"
                            onClick={() => openPasswordModal(svc)}
                            title="Change password"
                          >
                            <KeyRound size={11} /> Password
                          </button>
                        )}
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
                          title={`Copy ${svc.suggested_env_key}`}
                        >
                          {copiedKey === `int-${svc.id}` ? <Check size={11} /> : <Copy size={11} />}
                        </button>
                      </div>
                    </div>
                    <code className="webhook-url service-internal-code">
                      {revealed ? svc.internal_url : svc.internal_url.replace(/:([^:@]+)@/, ':••••••••@')}
                    </code>
                    <span className="form-hint" style={{ display: 'block', marginTop: '6px' }}>
                      Internal Docker network address for backend apps on this VPS — cannot be opened in a browser.
                    </span>
                  </div>

                  <div className="service-conn-box">
                    <div className="code-block-header">
                      <span className="form-hint">
                        {svc.public_access
                          ? (isMinio ? 'Public IP Access (HTTP)' : 'Public External URL (Raw TCP)')
                          : (isMinio ? 'Browser / SSH Access' : 'Private Access & SSH Tunnel')}
                      </span>
                      <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                        {isMinio && canManage && (
                          <Link
                            to="/domains"
                            className="btn btn-xs btn-secondary"
                            title="Attach a custom domain with SSL for browser & HTTPS S3 access"
                          >
                            + Domain
                          </Link>
                        )}
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
                    {isMinio && Array.isArray(svc.domains) && svc.domains.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '8px' }}>
                        {svc.domains.map((dom) => {
                          const proto = dom.ssl_enabled ? 'https' : 'http';
                          return (
                            <div key={dom.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                              <a
                                href={`${proto}://${dom.domain}`}
                                target="_blank"
                                rel="noreferrer"
                                className="app-access-link"
                              >
                                <Globe size={11} /> {proto}://{dom.domain} <ExternalLink size={10} />
                              </a>
                              <span className="project-type-pill">
                                {dom.service_target === 'console' ? 'Console' : 'S3 API'}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <code className={svc.public_access ? 'webhook-url' : 'webhook-url service-internal-code'}>
                      {svc.public_access
                        ? (revealed ? svc.external_url : svc.external_url.replace(/:([^:@]+)@/, ':••••••••@'))
                        : (svc.ssh_tunnel_cmd || svc.external_url)}
                    </code>
                    <span className="form-hint" style={{ display: 'block', marginTop: '6px' }}>
                      {svc.public_access
                        ? (isMinio
                            ? `Console UI opens at http://${svc.public_host}:${svc.console_port || 9001} (unencrypted IP). For HTTPS, add a + Domain.`
                            : 'Bound on 0.0.0.0 (unencrypted). Use Make Private to close public port access.')
                        : (isMinio
                            ? `Open Console in browser: add + Domain for HTTPS, click Make Public for IP, or run SSH tunnel above for http://localhost:${svc.console_port || 9001}.`
                            : `Bound to 127.0.0.1:${svc.port}. Run SSH tunnel locally to reach 127.0.0.1:${svc.port} securely.`)}
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

      {passwordTarget && (
        <div className="modal-overlay" onClick={() => setPasswordTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <KeyRound size={16} /> Change Password — {passwordTarget.name}
              </h3>
              <button className="modal-close" onClick={() => setPasswordTarget(null)} aria-label="Close">
                <X size={16} />
              </button>
            </div>
            <form onSubmit={handlePasswordSubmit}>
              <div className="modal-body">
                {passwordError && (
                  <div className="alert alert-error" style={{ marginBottom: '12px' }}>{passwordError}</div>
                )}
                <p style={{ marginBottom: '12px' }}>
                  {passwordTarget.service_type === 'redis' || passwordTarget.service_type === 'minio'
                    ? 'Updates the secret and recreates running containers while preserving all persistent data.'
                    : 'Applies the new password inside the running database engine and updates encrypted credentials.'}
                </p>

                <div className="form-group">
                  <div className="code-block-header">
                    <label className="form-label" htmlFor="svc-new-password" style={{ marginBottom: 0 }}>
                      New Password *
                    </label>
                    <button
                      type="button"
                      className="btn btn-xs btn-secondary"
                      onClick={fillGeneratedPassword}
                    >
                      <RefreshCw size={11} /> Generate
                    </button>
                  </div>
                  <div className="input-with-icon">
                    <input
                      id="svc-new-password"
                      type={showNextPassword ? 'text' : 'password'}
                      className="form-input"
                      value={nextPassword}
                      onChange={(e) => setNextPassword(e.target.value)}
                      autoComplete="new-password"
                      autoFocus
                    />
                    <button
                      type="button"
                      className="input-icon-btn"
                      onClick={() => setShowNextPassword((s) => !s)}
                      aria-label={showNextPassword ? 'Hide password' : 'Show password'}
                    >
                      {showNextPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                  <span className="form-hint">8–128 characters.</span>
                </div>

                <label className="ssl-checkbox-label">
                  <input
                    type="checkbox"
                    checked={syncAppsOnPass}
                    onChange={(e) => setSyncAppsOnPass(e.target.checked)}
                  />
                  <span>Auto-update connection URL / S3_SECRET_KEY on attached apps</span>
                </label>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setPasswordTarget(null)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={passwordBusy}>
                  <KeyRound size={14} /> {passwordBusy ? 'Updating…' : 'Update Password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default Services;
