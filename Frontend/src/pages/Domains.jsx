import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  Globe, ShieldCheck, Plus, RefreshCw, Trash2, FileCode2, ExternalLink, Search,
} from 'lucide-react';
import useApps from '../hooks/useApps';
import { useWebSocket } from '../context/WebSocketContext';
import ConfirmModal from '../components/ConfirmModal';
import InstallSslModal from '../components/InstallSslModal';
import NginxConfigModal from '../components/NginxConfigModal';
import SslStatusBadge from '../components/SslStatusBadge';
import DnsRecordHint from '../components/DnsRecordHint';
import {
  getDomainSystemStatus,
  getDomains,
  createDomain,
  checkDomainDns,
  syncNginxConfig,
  renewAllSsl,
  deleteDomain,
} from '../api/domains';

function Domains() {
  const { apps, fetchApps } = useApps();
  const { subscribe } = useWebSocket();

  const [domains, setDomains] = useState([]);
  const [sysStatus, setSysStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [appId, setAppId] = useState('');
  const [domainInput, setDomainInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [renewingAll, setRenewingAll] = useState(false);
  const [syncingId, setSyncingId] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [sslModalDomain, setSslModalDomain] = useState(null);
  const [configModalDomain, setConfigModalDomain] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const effectiveAppId = appId || (apps[0] ? String(apps[0].id) : '');

  const loadAll = useCallback(async () => {
    try {
      const [domList, sys] = await Promise.all([getDomains(), getDomainSystemStatus()]);
      setDomains(Array.isArray(domList) ? domList : []);
      setSysStatus(sys);
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to load domains.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchApps();
    let active = true;
    Promise.all([getDomains(), getDomainSystemStatus()])
      .then(([domList, sys]) => {
        if (!active) return;
        setDomains(Array.isArray(domList) ? domList : []);
        setSysStatus(sys);
      })
      .catch((err) => {
        if (active) setError(err?.response?.data?.error || 'Failed to load domains.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [fetchApps]);

  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === 'domains:changed' || msg.type === 'apps:changed') {
        void loadAll();
      }
    });
  }, [subscribe, loadAll]);

  const handleAddDomain = async (e) => {
    e.preventDefault();
    if (!effectiveAppId) {
      setError('Select an application first.');
      return;
    }
    if (!domainInput.trim()) {
      setError('Enter a domain name.');
      return;
    }

    setAdding(true);
    setError('');
    setNotice('');
    try {
      const res = await createDomain({ appId: Number(effectiveAppId), domain: domainInput.trim() });
      setDomainInput('');
      const targetIp = res.dns?.expectedIpv4 || res.dns?.fallbackLocalIpv4;
      const dnsSuffix = res.dns
        ? (res.dns.matchesServer
            ? ' DNS resolves to this server.'
            : targetIp
              ? ` Point DNS A record to ${targetIp} before issuing SSL.`
              : '')
        : '';
      setNotice(
        (res.nginxWarning
          ? `Domain '${res.domain}' added. (${res.nginxWarning})`
          : `Domain '${res.domain}' added and Nginx configured.`) + dnsSuffix
      );
      await loadAll();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to add domain.');
    } finally {
      setAdding(false);
    }
  };

  const handleCheckDns = async (dom) => {
    setError('');
    setNotice('');
    try {
      const dns = await checkDomainDns(dom.domain);
      const found = [...(dns.resolvedIpv4 || []), ...(dns.resolvedIpv6 || [])];
      if (dns.matchesServer) {
        setNotice(`DNS verified for ${dom.domain}: resolves to this server (${found.join(', ')}).`);
      } else {
        const expected = dns.expectedIpv4 || dns.fallbackLocalIpv4 || 'your VPS IP';
        setError(
          found.length > 0
            ? `DNS for ${dom.domain} resolves to ${found.join(', ')} instead of ${expected}.`
            : `No DNS A/AAAA record found for ${dom.domain}. Add an A record pointing to ${expected}.`
        );
      }
    } catch (err) {
      setError(err?.response?.data?.error || 'DNS check failed.');
    }
  };

  const handleSyncNginx = async (dom) => {
    setSyncingId(dom.id);
    setError('');
    setNotice('');
    try {
      const res = await syncNginxConfig(dom.id);
      setNotice(res.message || `Nginx synced for ${dom.domain}.`);
      await loadAll();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to sync Nginx config.');
    } finally {
      setSyncingId(null);
    }
  };

  const handleRenewAll = async () => {
    setRenewingAll(true);
    setError('');
    setNotice('');
    try {
      const res = await renewAllSsl();
      setNotice(res.message || 'Certificate renewal completed.');
      await loadAll();
    } catch (err) {
      setError(err?.response?.data?.error || 'Certbot renewal failed.');
    } finally {
      setRenewingAll(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    setError('');
    setNotice('');
    try {
      await deleteDomain(target.id);
      setNotice(`Removed domain '${target.domain}'.`);
      await loadAll();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to delete domain.');
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h2 className="page-heading">Domains &amp; SSL Certificates</h2>
        <button
          className="btn btn-secondary"
          onClick={handleRenewAll}
          disabled={renewingAll || !sysStatus?.hasCertbot}
          title={sysStatus?.hasCertbot ? 'Run certbot renew --nginx' : 'Certbot is not installed on this host'}
        >
          <RefreshCw size={14} /> {renewingAll ? 'Renewing…' : 'Renew All Certs'}
        </button>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: '16px' }}>{error}</div>}
      {notice && <div className="alert alert-success" style={{ marginBottom: '16px' }}>{notice}</div>}

      <div className="detail-card" style={{ marginBottom: '24px' }}>
        <h3 className="detail-card-title">Assign Custom Domain</h3>
        {apps.length === 0 ? (
          <p className="detail-hint">
            Create an application first before attaching a domain.{' '}
            <Link to="/apps/new">Create application</Link>.
          </p>
        ) : (
          <form className="domain-add-form" onSubmit={handleAddDomain}>
            <div className="domain-add-field">
              <label className="form-label" htmlFor="domain-app">Application</label>
              <select
                id="domain-app"
                className="form-input"
                value={effectiveAppId}
                onChange={(e) => setAppId(e.target.value)}
              >
                {apps.map((a) => (
                  <option key={a.id} value={String(a.id)}>
                    {a.name} (:{a.port})
                  </option>
                ))}
              </select>
            </div>
            <div className="domain-add-field domain-add-field--wide">
              <label className="form-label" htmlFor="domain-hostname">Domain Name</label>
              <input
                id="domain-hostname"
                type="text"
                className="form-input"
                value={domainInput}
                onChange={(e) => setDomainInput(e.target.value)}
                placeholder="app.yourdomain.com"
              />
            </div>
            <div className="domain-add-submit">
              <button type="submit" className="btn btn-primary" disabled={adding}>
                <Plus size={14} /> {adding ? 'Adding…' : 'Add Domain'}
              </button>
            </div>
          </form>
        )}
        <DnsRecordHint sysStatus={sysStatus} domainValue={domainInput} />
      </div>

      <div className="section" style={{ marginTop: 0 }}>
        <h3 className="section-title">Configured Domains ({domains.length})</h3>
        {loading ? (
          <div className="loading-state">Loading domains…</div>
        ) : domains.length === 0 ? (
          <div className="empty-state-sm">No custom domains configured yet.</div>
        ) : (
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th>Domain</th>
                  <th>Application</th>
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
                        <Link to={`/apps/${d.app_id}`} className="table-link">
                          {d.app_name}
                        </Link>
                        <span className="form-hint" style={{ marginLeft: '6px' }}>:{d.app_port}</span>
                      </td>
                      <td>
                        <span className={`status-badge ${d.nginx_configured ? 'status-badge--running' : 'status-badge--stopped'}`}>
                          {d.nginx_configured ? 'Configured' : 'Pending'}
                        </span>
                      </td>
                      <td><SslStatusBadge domain={d} /></td>
                      <td>
                        {d.cert_expires_at
                          ? new Date(d.cert_expires_at).toLocaleDateString()
                          : '—'}
                      </td>
                      <td>
                        <div className="action-btns">
                          <button
                            className="btn btn-xs btn-primary"
                            onClick={() => setSslModalDomain(d)}
                            title="Install or renew SSL certificate via Certbot"
                          >
                            <ShieldCheck size={12} /> {d.ssl_enabled ? 'Renew SSL' : 'Install SSL'}
                          </button>
                          <button
                            className="btn btn-xs btn-secondary"
                            onClick={() => handleCheckDns(d)}
                            title="Verify DNS A/AAAA record"
                          >
                            <Search size={12} /> Check DNS
                          </button>
                          <button
                            className="btn btn-xs btn-secondary"
                            onClick={() => handleSyncNginx(d)}
                            disabled={syncingId === d.id}
                            title="Write Nginx server block & reload"
                          >
                            <RefreshCw size={12} /> {syncingId === d.id ? 'Syncing…' : 'Sync Nginx'}
                          </button>
                          <button
                            className="btn btn-xs btn-secondary"
                            onClick={() => setConfigModalDomain(d)}
                            title="View Nginx config & Certbot logs"
                          >
                            <FileCode2 size={12} /> Config
                          </button>
                          <button
                            className="btn btn-xs btn-danger"
                            onClick={() => setDeleteTarget(d)}
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

      <InstallSslModal
        isOpen={Boolean(sslModalDomain)}
        domainRecord={sslModalDomain}
        certbotEmailConfigured={Boolean(sysStatus?.certbotEmailConfigured)}
        onClose={() => setSslModalDomain(null)}
        onSuccess={() => void loadAll()}
      />

      <NginxConfigModal
        isOpen={Boolean(configModalDomain)}
        domainRecord={configModalDomain}
        onClose={() => setConfigModalDomain(null)}
      />

      <ConfirmModal
        isOpen={Boolean(deleteTarget)}
        title="Remove Domain"
        message={`Remove "${deleteTarget?.domain}" and delete its Nginx configuration?`}
        confirmLabel="Remove"
        danger
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

export default Domains;
