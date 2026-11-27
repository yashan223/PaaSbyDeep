import { useParams, useNavigate, Link } from 'react-router-dom';
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Play, RotateCcw, Square, Pencil, Trash2, ArrowLeft, GitBranch, Globe, Clock, Github,
  ShieldCheck, RefreshCw, FileCode2, Plus, ExternalLink, Terminal, Search, X, Copy, Check,
} from 'lucide-react';
import StatusBadge from '../components/StatusBadge';
import LogViewer from '../components/LogViewer';
import ConfirmModal from '../components/ConfirmModal';
import InstallSslModal from '../components/InstallSslModal';
import NginxConfigModal from '../components/NginxConfigModal';
import SslStatusBadge from '../components/SslStatusBadge';
import DnsRecordHint from '../components/DnsRecordHint';
import { useWebSocket } from '../context/WebSocketContext';
import {
  getApp, deployApp, restartApp, stopApp,
  deleteApp, getAppLogs, getContainerLogs, getDeployments,
} from '../api/apps';
import { getGithubStatus, createGithubWebhook } from '../api/github';
import {
  getAppDomains, getDomainSystemStatus, createDomain, syncNginxConfig, deleteDomain,
} from '../api/domains';

function AppDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [app, setApp] = useState(null);
  const [logs, setLogs] = useState('');
  const [logMode, setLogMode] = useState('build');
  const [selectedDeploymentId, setSelectedDeploymentId] = useState('');
  const [activeBuildDeploymentId, setActiveBuildDeploymentId] = useState(null);
  const [runtimeInfo, setRuntimeInfo] = useState({ available: false, running: false, logs: '', reason: '' });
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [autoRefreshRuntime, setAutoRefreshRuntime] = useState(true);
  const [logSearch, setLogSearch] = useState('');
  const [copiedLogs, setCopiedLogs] = useState(false);
  const logModeInitializedRef = useRef(false);
  const logsSectionRef = useRef(null);
  const [deployments, setDeployments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionLoading, setActionLoading] = useState('');
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [ghConnected, setGhConnected] = useState(false);
  const [webhookMsg, setWebhookMsg] = useState('');
  const [webhookBusy, setWebhookBusy] = useState(false);
  const [domains, setDomains] = useState([]);
  const [domainSysStatus, setDomainSysStatus] = useState(null);
  const [domainInput, setDomainInput] = useState('');
  const [domainBusy, setDomainBusy] = useState(false);
  const [domainNotice, setDomainNotice] = useState('');
  const [sslModalDomain, setSslModalDomain] = useState(null);
  const [configModalDomain, setConfigModalDomain] = useState(null);
  const [domainDeleteTarget, setDomainDeleteTarget] = useState(null);
  const { subscribe } = useWebSocket();

  const fetchRuntimeLogs = useCallback(async () => {
    setRuntimeLoading(true);
    try {
      const res = await getContainerLogs(id, 300);
      setRuntimeInfo(res || { available: false, running: false, logs: '', reason: '' });
    } catch (err) {
      setRuntimeInfo({
        available: false,
        running: false,
        logs: '',
        reason: err?.response?.data?.error || 'Failed to fetch container runtime logs.',
      });
    } finally {
      setRuntimeLoading(false);
    }
  }, [id]);

  const fetchBuildLogs = useCallback(async (deploymentId) => {
    try {
      const l = await getAppLogs(id, deploymentId || undefined);
      setLogs(Array.isArray(l) ? l : l?.logs ?? '');
      if (l?.deployment_id) setActiveBuildDeploymentId(l.deployment_id);
    } catch {
      // keep existing logs on transient failure
    }
  }, [id]);

  useEffect(() => {
    getGithubStatus()
      .then((d) => setGhConnected(Boolean(d.connected)))
      .catch(() => {});
    getDomainSystemStatus()
      .then((d) => setDomainSysStatus(d))
      .catch(() => {});
  }, []);

  const fetchAll = useCallback(async () => {
    try {
      const [appData, logsData, deplData, domData] = await Promise.allSettled([
        getApp(id),
        getAppLogs(id, selectedDeploymentId || undefined),
        getDeployments(id),
        getAppDomains(id),
      ]);
      if (appData.status === 'fulfilled') {
        setApp(appData.value);
        setError('');
      } else {
        setError(appData.reason?.response?.data?.error || appData.reason?.response?.data?.message || 'Failed to load app details.');
      }
      if (logsData.status === 'fulfilled') {
        const l = logsData.value;
        setLogs(Array.isArray(l) ? l : l?.logs ?? '');
        if (l?.deployment_id) setActiveBuildDeploymentId(l.deployment_id);
      }
      if (deplData.status === 'fulfilled') {
        const d = deplData.value;
        setDeployments(Array.isArray(d) ? d.slice(0, 15) : (d?.deployments || []).slice(0, 15));
      }
      if (domData.status === 'fulfilled') {
        setDomains(Array.isArray(domData.value) ? domData.value : []);
      }
    } catch (err) {
      setError(err?.response?.data?.error || err?.response?.data?.message || 'Failed to load app details.');
    } finally {
      setLoading(false);
    }
  }, [id, selectedDeploymentId]);

  useEffect(() => {
    let active = true;
    logModeInitializedRef.current = false;
    Promise.allSettled([
      getApp(id),
      getAppLogs(id),
      getDeployments(id),
      getAppDomains(id),
      getContainerLogs(id, 300),
    ])
      .then(([appData, logsData, deplData, domData, runtimeData]) => {
        if (!active) return;
        if (appData.status === 'fulfilled') {
          const loadedApp = appData.value;
          setApp(loadedApp);
          setError('');
          if (!logModeInitializedRef.current) {
            logModeInitializedRef.current = true;
            if (loadedApp?.status === 'running' && loadedApp?.container_id) {
              setLogMode('runtime');
            }
          }
        } else {
          setError(appData.reason?.response?.data?.error || appData.reason?.response?.data?.message || 'Failed to load app details.');
        }
        if (logsData.status === 'fulfilled') {
          const l = logsData.value;
          setLogs(Array.isArray(l) ? l : l?.logs ?? '');
          if (l?.deployment_id) {
            setActiveBuildDeploymentId(l.deployment_id);
            setSelectedDeploymentId(String(l.deployment_id));
          }
        }
        if (deplData.status === 'fulfilled') {
          const d = deplData.value;
          setDeployments(Array.isArray(d) ? d.slice(0, 15) : (d?.deployments || []).slice(0, 15));
        }
        if (domData.status === 'fulfilled') {
          setDomains(Array.isArray(domData.value) ? domData.value : []);
        }
        if (runtimeData.status === 'fulfilled' && runtimeData.value) {
          setRuntimeInfo(runtimeData.value);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [id]);

  useEffect(() => {
    const numericId = Number(id);
    return subscribe((msg) => {
      if (msg.type === 'domains:changed' && (!msg.appId || Number(msg.appId) === numericId)) {
        getAppDomains(id)
          .then((list) => setDomains(Array.isArray(list) ? list : []))
          .catch(() => {});
        return;
      }

      if (Number(msg.appId) !== numericId) return;

      if (msg.type === 'app:status') {
        setApp((prev) =>
          prev
            ? {
                ...prev,
                status: msg.status,
                ...(msg.lastDeployedAt ? { last_deployed_at: msg.lastDeployedAt } : {}),
              }
            : prev
        );
        if (msg.status === 'running') {
          void fetchRuntimeLogs();
        }
      } else if (msg.type === 'deploy:log' && msg.chunk) {
        if (!selectedDeploymentId || Number(selectedDeploymentId) === Number(msg.deploymentId)) {
          setLogs((prev) => (typeof prev === 'string' ? prev + msg.chunk : msg.chunk));
        }
      } else if (msg.type === 'deploy:status') {
        if (msg.resetLogs) {
          setSelectedDeploymentId(String(msg.deploymentId));
          setActiveBuildDeploymentId(msg.deploymentId);
          setLogs('');
          setLogMode('build');
        }
        getDeployments(id)
          .then((d) => setDeployments(Array.isArray(d) ? d.slice(0, 15) : []))
          .catch(() => {});
      }
    });
  }, [id, subscribe, selectedDeploymentId, fetchRuntimeLogs]);

  useEffect(() => {
    if (logMode !== 'runtime' || !autoRefreshRuntime || app?.status !== 'running') {
      return undefined;
    }
    const timer = setInterval(() => {
      void fetchRuntimeLogs();
    }, 3000);
    return () => clearInterval(timer);
  }, [logMode, autoRefreshRuntime, app?.status, fetchRuntimeLogs]);

  const rawActiveLogText = useMemo(() => {
    if (logMode === 'runtime') {
      return runtimeInfo?.logs || '';
    }
    return Array.isArray(logs) ? logs.join('\n') : String(logs || '');
  }, [logMode, runtimeInfo?.logs, logs]);

  const filteredLogText = useMemo(() => {
    const q = logSearch.trim().toLowerCase();
    if (!q) return rawActiveLogText;
    return rawActiveLogText
      .split(/\r?\n/)
      .filter((line) => line.toLowerCase().includes(q))
      .join('\n');
  }, [rawActiveLogText, logSearch]);

  const handleAction = async (action, label) => {
    setActionError('');
    setActionLoading(label);
    try {
      await action(id);
      await fetchAll();
    } catch (err) {
      setActionError(err?.response?.data?.error || err?.response?.data?.message || `${label} failed.`);
    } finally {
      setActionLoading('');
    }
  };

  const handleDelete = async () => {
    setShowDeleteModal(false);
    try {
      await deleteApp(id);
      navigate('/apps');
    } catch (err) {
      setActionError(err?.response?.data?.error || err?.response?.data?.message || 'Delete failed.');
    }
  };

  if (loading) return <div className="page"><div className="loading-state">Loading…</div></div>;
  if (error && !app) return <div className="page"><div className="alert alert-error">{error}</div></div>;
  if (!app) return <div className="page"><div className="alert alert-error">App not found.</div></div>;

  const rawApiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';
  const apiUrl = rawApiUrl.startsWith('/') ? `${window.location.origin}${rawApiUrl}` : rawApiUrl;

  const handleAutoWebhook = async () => {
    setActionError('');
    setWebhookMsg('');
    setWebhookBusy(true);
    try {
      const publicBase = apiUrl.replace(/\/api\/?$/, '');
      const res = await createGithubWebhook(id, publicBase);
      setWebhookMsg(res.message || 'Webhook added on GitHub!');
    } catch (err) {
      setActionError(err?.response?.data?.error || 'Failed to add GitHub webhook.');
    } finally {
      setWebhookBusy(false);
    }
  };

  const handleAddDomain = async (e) => {
    e.preventDefault();
    if (!domainInput.trim()) return;
    setActionError('');
    setDomainNotice('');
    setDomainBusy(true);
    try {
      const res = await createDomain({ appId: Number(id), domain: domainInput.trim() });
      setDomainInput('');
      const targetIp = res.dns?.expectedIpv4 || res.dns?.fallbackLocalIpv4;
      const dnsSuffix = res.dns
        ? (res.dns.matchesServer
            ? ' DNS resolves to this server.'
            : targetIp
              ? ` Point DNS A record to ${targetIp} before issuing SSL.`
              : '')
        : '';
      setDomainNotice(
        (res.nginxWarning
          ? `Domain '${res.domain}' added. (${res.nginxWarning})`
          : `Domain '${res.domain}' added and Nginx configured.`) + dnsSuffix
      );
      await fetchAll();
    } catch (err) {
      setActionError(err?.response?.data?.error || 'Failed to add domain.');
    } finally {
      setDomainBusy(false);
    }
  };

  const handleSyncDomain = async (dom) => {
    setActionError('');
    setDomainNotice('');
    try {
      const res = await syncNginxConfig(dom.id);
      setDomainNotice(res.message || `Nginx synced for ${dom.domain}.`);
      await fetchAll();
    } catch (err) {
      setActionError(err?.response?.data?.error || 'Failed to sync Nginx config.');
    }
  };

  const handleRemoveDomain = async () => {
    if (!domainDeleteTarget) return;
    const target = domainDeleteTarget;
    setDomainDeleteTarget(null);
    setActionError('');
    setDomainNotice('');
    try {
      await deleteDomain(target.id);
      setDomainNotice(`Removed domain '${target.domain}'.`);
      await fetchAll();
    } catch (err) {
      setActionError(err?.response?.data?.error || 'Failed to remove domain.');
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <Link to="/apps" className="btn btn-secondary btn-sm">
            <ArrowLeft size={14} />
          </Link>
          <div>
            <h2 className="page-heading" style={{ marginBottom: 0 }}>{app.name}</h2>
            <StatusBadge status={app.status} />
          </div>
        </div>
        <div className="action-btns">
          <button
            className="btn btn-primary"
            onClick={() => handleAction(deployApp, 'Deploy')}
            disabled={!!actionLoading}
          >
            <Play size={14} /> {actionLoading === 'Deploy' ? 'Deploying…' : 'Deploy Now'}
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => handleAction(restartApp, 'Restart')}
            disabled={!!actionLoading}
          >
            <RotateCcw size={14} /> {actionLoading === 'Restart' ? 'Restarting…' : 'Restart'}
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => handleAction(stopApp, 'Stop')}
            disabled={!!actionLoading}
          >
            <Square size={14} /> {actionLoading === 'Stop' ? 'Stopping…' : 'Stop'}
          </button>
          <Link to={`/apps/${id}/edit`} className="btn btn-secondary">
            <Pencil size={14} /> Edit
          </Link>
          <button className="btn btn-danger" onClick={() => setShowDeleteModal(true)}>
            <Trash2 size={14} /> Delete
          </button>
        </div>
      </div>

      {actionError && <div className="alert alert-error" style={{ marginBottom: '12px' }}>{actionError}</div>}

      <div className="detail-grid">
        <div className="detail-card">
          <h3 className="detail-card-title">Configuration</h3>
          <div className="detail-rows">
            <div className="detail-row">
              <span className="detail-key"><GitBranch size={13} /> Repository</span>
              <span className="detail-val">{app.repo_url || app.repoUrl || app.repository || '—'}</span>
            </div>
            <div className="detail-row">
              <span className="detail-key"><GitBranch size={13} /> Branch</span>
              <span className="detail-val">{app.branch || 'main'}</span>
            </div>
            <div className="detail-row">
              <span className="detail-key"><Globe size={13} /> Port</span>
              <span className="detail-val">{app.port || '—'}</span>
            </div>
            <div className="detail-row">
              <span className="detail-key">Dockerfile</span>
              <span className="detail-val">{app.dockerfile_path || app.dockerfilePath || 'Dockerfile'}</span>
            </div>
            {app.project_type && app.project_type !== 'auto' && (
              <div className="detail-row">
                <span className="detail-key">Project Type</span>
                <span className="detail-val"><span className="project-type-pill">{app.project_type}</span></span>
              </div>
            )}
            {(app.last_deployed_at || app.lastDeployedAt) && (
              <div className="detail-row">
                <span className="detail-key"><Clock size={13} /> Last Deployed</span>
                <span className="detail-val">{new Date(app.last_deployed_at || app.lastDeployedAt).toLocaleString()}</span>
              </div>
            )}
          </div>
        </div>

        <div className="detail-card">
          <h3 className="detail-card-title">Webhook URL</h3>
          <code className="webhook-url">{apiUrl}/webhook/github/{id}</code>
          <p className="detail-hint">Configure this in your GitHub/GitLab repository webhooks to trigger auto-deploys.</p>
          {ghConnected && (app.repo_url || '').includes('github.com') && (
            <div style={{ marginTop: '12px' }}>
              <button
                className="btn btn-secondary btn-sm"
                onClick={handleAutoWebhook}
                disabled={webhookBusy}
              >
                <Github size={13} /> {webhookBusy ? 'Adding Webhook…' : 'Auto-Add Webhook on GitHub'}
              </button>
              {webhookMsg && <p className="detail-hint" style={{ color: 'var(--success-text)' }}>{webhookMsg}</p>}
            </div>
          )}
        </div>
      </div>

      <div className="section">
        <div className="section-header-row">
          <h3 className="section-title" style={{ marginBottom: 0 }}>
            Domains &amp; SSL ({domains.length})
          </h3>
          <Link to="/domains" className="btn btn-xs btn-secondary">
            Manage All Domains
          </Link>
        </div>

        <div className="detail-card">
          {domainNotice && <div className="alert alert-success" style={{ marginBottom: '12px' }}>{domainNotice}</div>}

          <form className="domain-add-form" onSubmit={handleAddDomain}>
            <div className="domain-add-field domain-add-field--wide">
              <input
                type="text"
                className="form-input"
                value={domainInput}
                onChange={(e) => setDomainInput(e.target.value)}
                aria-label="Custom domain"
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={domainBusy}>
              <Plus size={14} /> {domainBusy ? 'Adding…' : 'Add Domain'}
            </button>
          </form>

          <DnsRecordHint sysStatus={domainSysStatus} domainValue={domainInput} />

          {domains.length > 0 && (
            <div className="table-wrapper" style={{ marginTop: '14px' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Domain</th>
                    <th>Nginx</th>
                    <th>SSL (Certbot)</th>
                    <th>Expires</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {domains.map((d) => {
                    const protocol = d.ssl_enabled ? 'https' : 'http';
                    return (
                      <tr key={d.id}>
                        <td>
                          <a
                            href={`${protocol}://${d.domain}`}
                            target="_blank"
                            rel="noreferrer"
                            className="table-link"
                            style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                          >
                            <Globe size={13} /> {d.domain} <ExternalLink size={11} />
                          </a>
                        </td>
                        <td>
                          <span className={`status-badge ${d.nginx_configured ? 'status-badge--running' : 'status-badge--stopped'}`}>
                            {d.nginx_configured ? 'Configured' : 'Pending'}
                          </span>
                        </td>
                        <td><SslStatusBadge domain={d} /></td>
                        <td>{d.cert_expires_at ? new Date(d.cert_expires_at).toLocaleDateString() : '—'}</td>
                        <td>
                          <div className="action-btns">
                            <button
                              type="button"
                              className="btn btn-xs btn-primary"
                              onClick={() => setSslModalDomain(d)}
                            >
                              <ShieldCheck size={12} /> {d.ssl_enabled ? 'Renew SSL' : 'Install SSL'}
                            </button>
                            <button
                              type="button"
                              className="btn btn-xs btn-secondary"
                              onClick={() => handleSyncDomain(d)}
                            >
                              <RefreshCw size={12} /> Sync Nginx
                            </button>
                            <button
                              type="button"
                              className="btn btn-xs btn-secondary"
                              onClick={() => setConfigModalDomain(d)}
                            >
                              <FileCode2 size={12} /> Config
                            </button>
                            <button
                              type="button"
                              className="btn btn-xs btn-danger"
                              onClick={() => setDomainDeleteTarget(d)}
                              title="Remove domain"
                            >
                              <Trash2 size={12} />
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
      </div>

      <div className="section">
        <h3 className="section-title">Deployment History</h3>
        {deployments.length === 0 ? (
          <div className="empty-state-sm">No deployments yet.</div>
        ) : (
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th>Deploy</th>
                  <th>Commit</th>
                  <th>Triggered By</th>
                  <th>Status</th>
                  <th>Duration</th>
                  <th>Started</th>
                  <th>Logs</th>
                </tr>
              </thead>
              <tbody>
                {deployments.map((d, i) => {
                  const depId = d.id || d._id;
                  const startedAt = d.started_at || d.startedAt;
                  const finishedAt = d.finished_at || d.finishedAt;
                  const durationSec = d.duration ?? (startedAt && finishedAt
                    ? Math.max(0, Math.round((new Date(finishedAt) - new Date(startedAt)) / 1000))
                    : null);
                  const isViewingDep = logMode === 'build' && Number(selectedDeploymentId || activeBuildDeploymentId) === Number(depId);
                  return (
                    <tr key={depId || i}>
                      <td><code style={{ fontSize: '12px' }}>#{depId}</code></td>
                      <td><code style={{ fontSize: '12px' }}>{(d.commit_sha || d.commitSha || d.commit || '—').slice(0, 8)}</code></td>
                      <td>{d.triggered_by || d.triggeredBy || d.trigger || '—'}</td>
                      <td><StatusBadge status={d.status} /></td>
                      <td>{durationSec !== null ? `${durationSec}s` : '—'}</td>
                      <td>{startedAt ? new Date(startedAt).toLocaleString() : '—'}</td>
                      <td>
                        <button
                          type="button"
                          className={`btn btn-xs ${isViewingDep ? 'btn-primary' : 'btn-secondary'}`}
                          onClick={() => {
                            setLogMode('build');
                            setSelectedDeploymentId(String(depId));
                            void fetchBuildLogs(depId);
                            logsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                          }}
                        >
                          <Terminal size={11} /> View Logs
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="section" ref={logsSectionRef}>
        <div className="app-logs-header">
          <div className="live-logs-heading-wrap">
            <h3 className="section-title" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: '7px' }}>
              <Terminal size={15} /> {app.name} Logs
            </h3>
            <div className="repo-filter-pills" role="group" aria-label="Application log source">
              <button
                type="button"
                className={`repo-filter-pill ${logMode === 'runtime' ? 'repo-filter-pill--active' : ''}`}
                onClick={() => {
                  setLogMode('runtime');
                  void fetchRuntimeLogs();
                }}
              >
                Container Runtime
              </button>
              <button
                type="button"
                className={`repo-filter-pill ${logMode === 'build' ? 'repo-filter-pill--active' : ''}`}
                onClick={() => {
                  setLogMode('build');
                  void fetchBuildLogs(selectedDeploymentId);
                }}
              >
                Build &amp; Deploy
              </button>
            </div>
            {logMode === 'runtime' && (
              <span className={`status-badge ${runtimeInfo?.running ? 'status-badge--running' : 'status-badge--stopped'}`}>
                <span className={`status-dot ${runtimeInfo?.running ? 'status-dot--pulse' : ''}`} />
                {runtimeInfo?.running ? 'Container Running' : runtimeInfo?.available ? `Container ${runtimeInfo.status}` : 'No Container'}
              </span>
            )}
          </div>

          <div className="live-logs-controls">
            {logMode === 'build' && deployments.length > 0 && (
              <select
                className="form-input live-logs-select"
                value={selectedDeploymentId || (activeBuildDeploymentId ? String(activeBuildDeploymentId) : '')}
                onChange={(e) => {
                  const nextId = e.target.value;
                  setSelectedDeploymentId(nextId);
                  void fetchBuildLogs(nextId);
                }}
                aria-label="Select deployment logs"
              >
                {deployments.map((d) => {
                  const depId = d.id || d._id;
                  return (
                    <option key={depId} value={String(depId)}>
                      Deploy #{depId} ({d.status})
                    </option>
                  );
                })}
              </select>
            )}

            <div className="live-logs-search-wrap">
              <Search size={13} className="github-search-icon" />
              <input
                type="text"
                className="form-input live-logs-search-input"
                value={logSearch}
                onChange={(e) => setLogSearch(e.target.value)}
                placeholder={`Filter ${app.name} logs…`}
                aria-label={`Filter ${app.name} logs`}
              />
              {logSearch && (
                <button
                  type="button"
                  className="github-search-clear"
                  title="Clear search"
                  onClick={() => setLogSearch('')}
                >
                  <X size={13} />
                </button>
              )}
            </div>

            {logMode === 'runtime' && (
              <label className="app-logs-autorefresh" title="Poll container logs every 3 seconds while running">
                <input
                  type="checkbox"
                  checked={autoRefreshRuntime}
                  onChange={(e) => setAutoRefreshRuntime(e.target.checked)}
                />
                <span>Live</span>
              </label>
            )}

            <button
              type="button"
              className="btn btn-sm btn-secondary"
              disabled={logMode === 'runtime' && runtimeLoading}
              onClick={() => {
                if (logMode === 'runtime') void fetchRuntimeLogs();
                else void fetchBuildLogs(selectedDeploymentId);
              }}
              title="Refresh logs"
            >
              <RefreshCw size={13} /> Refresh
            </button>

            <button
              type="button"
              className="btn btn-sm btn-secondary"
              disabled={!filteredLogText}
              onClick={() => {
                navigator.clipboard?.writeText(filteredLogText).then(() => {
                  setCopiedLogs(true);
                  setTimeout(() => setCopiedLogs(false), 2000);
                }).catch(() => {});
              }}
              title="Copy logs"
            >
              {copiedLogs ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
            </button>
          </div>
        </div>

        <LogViewer
          logs={filteredLogText}
          emptyMessage={
            logMode === 'runtime'
              ? (runtimeInfo?.reason || 'No container stdout/stderr output recorded yet.')
              : 'No build/deployment logs recorded for this deployment yet.'
          }
        />
      </div>

      <ConfirmModal
        isOpen={showDeleteModal}
        title="Delete Application"
        message={`Are you sure you want to delete "${app.name}"? This action cannot be undone.`}
        confirmLabel="Delete"
        danger
        onConfirm={handleDelete}
        onCancel={() => setShowDeleteModal(false)}
      />

      <InstallSslModal
        isOpen={Boolean(sslModalDomain)}
        domainRecord={sslModalDomain}
        certbotEmailConfigured={Boolean(domainSysStatus?.certbotEmailConfigured)}
        onClose={() => setSslModalDomain(null)}
        onSuccess={() => void fetchAll()}
      />

      <NginxConfigModal
        isOpen={Boolean(configModalDomain)}
        domainRecord={configModalDomain}
        onClose={() => setConfigModalDomain(null)}
      />

      <ConfirmModal
        isOpen={Boolean(domainDeleteTarget)}
        title="Remove Domain"
        message={`Remove "${domainDeleteTarget?.domain}" and delete its Nginx configuration?`}
        confirmLabel="Remove"
        danger
        onConfirm={handleRemoveDomain}
        onCancel={() => setDomainDeleteTarget(null)}
      />
    </div>
  );
}

export default AppDetail;
