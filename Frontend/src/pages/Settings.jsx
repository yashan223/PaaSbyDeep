import { useEffect, useState } from 'react';
import {
  Settings as SettingsIcon, KeyRound, ShieldCheck, HardDrive, FileCode2, Check, Copy, Trash2,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import {
  getSettings,
  updateSettings,
  updateAccount,
  getDashboardNginxConfig,
  installDashboardSsl,
  pruneDockerImages,
} from '../api/settings';

function formatUptime(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${seconds % 60}s`;
}

function Settings() {
  const { user, login } = useAuth();
  const isAdmin = (user?.role || 'admin') === 'admin';

  const [loading, setLoading] = useState(true);
  const [runtime, setRuntime] = useState(null);
  const [generalForm, setGeneralForm] = useState({
    platformName: 'PaaSbyDeep',
    publicUrl: '',
    certbotEmail: '',
    defaultMemoryMb: '512',
    maxDeploymentsRetain: '20',
  });
  const [dashboardDomain, setDashboardDomain] = useState('');
  const [dashboardSslEnabled, setDashboardSslEnabled] = useState(false);
  const [dashboardSslExpires, setDashboardSslExpires] = useState(null);
  const [dashboardSslEmail, setDashboardSslEmail] = useState('');
  const [dashboardRedirect, setDashboardRedirect] = useState(true);
  const [dashboardNginxPreview, setDashboardNginxPreview] = useState(null);
  const [dashboardCertLog, setDashboardCertLog] = useState('');
  const [copiedKey, setCopiedKey] = useState('');

  const [accountForm, setAccountForm] = useState({
    currentPassword: '',
    newUsername: user?.username || 'admin',
    newPassword: '',
    confirmPassword: '',
  });

  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    getSettings()
      .then((res) => {
        if (!active) return;
        const s = res.settings || {};
        setRuntime(res.runtime || null);
        setGeneralForm({
          platformName: s.platform_name || 'PaaSbyDeep',
          publicUrl: s.public_url || '',
          certbotEmail: s.certbot_email || '',
          defaultMemoryMb: String(s.default_memory_mb || 512),
          maxDeploymentsRetain: String(s.max_deployments_retain || 20),
        });
        setDashboardDomain(s.dashboard_domain || '');
        setDashboardSslEnabled(Boolean(s.dashboard_ssl_enabled));
        setDashboardSslExpires(s.dashboard_ssl_expires || null);
        setDashboardSslEmail(s.certbot_email || '');
      })
      .catch((err) => {
        if (active) setError(err?.response?.data?.error || 'Failed to load dashboard settings.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  const handleSaveGeneral = async (e) => {
    e.preventDefault();
    setBusy('general');
    setError('');
    setNotice('');
    try {
      const res = await updateSettings({
        platform_name: generalForm.platformName.trim(),
        public_url: generalForm.publicUrl.trim(),
        certbot_email: generalForm.certbotEmail.trim(),
        default_memory_mb: Number(generalForm.defaultMemoryMb),
        max_deployments_retain: Number(generalForm.maxDeploymentsRetain),
      });
      setNotice(res.message || 'Dashboard settings saved.');
      window.dispatchEvent(new CustomEvent('platform-settings-changed', { detail: res.settings }));
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to update settings.');
    } finally {
      setBusy('');
    }
  };

  const handleUpdateAccount = async (e) => {
    e.preventDefault();
    if (!accountForm.currentPassword) {
      setError('Enter your current password.');
      return;
    }
    if (accountForm.newPassword && accountForm.newPassword !== accountForm.confirmPassword) {
      setError('New password and confirmation do not match.');
      return;
    }

    setBusy('account');
    setError('');
    setNotice('');
    try {
      const res = await updateAccount({
        currentPassword: accountForm.currentPassword,
        newUsername: accountForm.newUsername.trim(),
        ...(accountForm.newPassword ? { newPassword: accountForm.newPassword } : {}),
      });
      login(res.token, {
        id: res.id || user?.id,
        username: res.username,
        role: res.role || user?.role || 'admin',
      });
      setAccountForm((prev) => ({
        ...prev,
        currentPassword: '',
        newUsername: res.username,
        newPassword: '',
        confirmPassword: '',
      }));
      setNotice(res.message || 'Account credentials updated.');
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to update account credentials.');
    } finally {
      setBusy('');
    }
  };

  const handlePreviewDashboardNginx = async () => {
    setBusy('preview');
    setError('');
    try {
      const res = await getDashboardNginxConfig(dashboardDomain.trim());
      setDashboardNginxPreview(res);
    } catch (err) {
      setError(err?.response?.data?.error || 'Enter a valid domain to preview Nginx config.');
    } finally {
      setBusy('');
    }
  };

  const handleInstallDashboardSsl = async (e) => {
    e.preventDefault();
    setBusy('ssl');
    setError('');
    setNotice('');
    setDashboardCertLog('');
    try {
      const res = await installDashboardSsl({
        domain: dashboardDomain.trim(),
        email: (dashboardSslEmail || generalForm.certbotEmail).trim(),
        redirect: dashboardRedirect,
      });
      setDashboardSslEnabled(true);
      setDashboardSslExpires(res.settings?.dashboard_ssl_expires || null);
      setDashboardCertLog(res.log || '');
      setNotice(res.message || 'Dashboard SSL certificate installed.');
      window.dispatchEvent(new CustomEvent('platform-settings-changed', { detail: res.settings }));
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to install dashboard SSL certificate.');
      if (err?.response?.data?.log) setDashboardCertLog(err.response.data.log);
    } finally {
      setBusy('');
    }
  };

  const handlePruneDocker = async () => {
    setBusy('prune');
    setError('');
    setNotice('');
    try {
      const res = await pruneDockerImages();
      setNotice(res.message || 'Unused Docker images pruned.');
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to prune Docker images.');
    } finally {
      setBusy('');
    }
  };

  const copyText = (key, text) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(''), 2000);
    }).catch(() => {});
  };

  if (loading) {
    return (
      <div className="page">
        <div className="loading-state">Loading management settings…</div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <h2 className="page-heading">Dashboard Management Settings</h2>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: '16px' }}>{error}</div>}
      {notice && <div className="alert alert-success" style={{ marginBottom: '16px' }}>{notice}</div>}

      <div className="settings-grid">
        <div className="detail-card">
          <h3 className="detail-card-title" style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
            <SettingsIcon size={14} /> General &amp; Runtime Defaults
          </h3>
          <form onSubmit={handleSaveGeneral}>
            <div className="form-group">
              <label className="form-label" htmlFor="platformName">Platform Name</label>
              <input
                id="platformName"
                type="text"
                className="form-input"
                value={generalForm.platformName}
                onChange={(e) => setGeneralForm((f) => ({ ...f, platformName: e.target.value }))}
                maxLength={40}
              />
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="publicUrl">Public Dashboard URL</label>
              <input
                id="publicUrl"
                type="url"
                className="form-input"
                value={generalForm.publicUrl}
                onChange={(e) => setGeneralForm((f) => ({ ...f, publicUrl: e.target.value }))}
              />
              <span className="form-hint">Used automatically when auto-creating GitHub webhooks.</span>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="certbotEmail">Default Certbot Email</label>
              <input
                id="certbotEmail"
                type="email"
                className="form-input"
                value={generalForm.certbotEmail}
                onChange={(e) => setGeneralForm((f) => ({ ...f, certbotEmail: e.target.value }))}
              />
              <span className="form-hint">Pre-fills Let&apos;s Encrypt email for SSL installations.</span>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label" htmlFor="defaultMemoryMb">Container RAM Limit (MB)</label>
                <input
                  id="defaultMemoryMb"
                  type="number"
                  className="form-input"
                  min={128}
                  max={8192}
                  value={generalForm.defaultMemoryMb}
                  onChange={(e) => setGeneralForm((f) => ({ ...f, defaultMemoryMb: e.target.value }))}
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="maxRetain">Deployments Retained / App</label>
                <input
                  id="maxRetain"
                  type="number"
                  className="form-input"
                  min={5}
                  max={100}
                  value={generalForm.maxDeploymentsRetain}
                  onChange={(e) => setGeneralForm((f) => ({ ...f, maxDeploymentsRetain: e.target.value }))}
                />
              </div>
            </div>

            <button type="submit" className="btn btn-primary" disabled={!isAdmin || busy === 'general'}>
              {busy === 'general' ? 'Saving…' : 'Save Runtime Settings'}
            </button>
          </form>
        </div>

        <div className="detail-card">
          <h3 className="detail-card-title" style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
            <KeyRound size={14} /> Admin Account Security
          </h3>
          <form onSubmit={handleUpdateAccount}>
            <div className="form-group">
              <label className="form-label" htmlFor="accUsername">Admin Username</label>
              <input
                id="accUsername"
                type="text"
                className="form-input"
                value={accountForm.newUsername}
                onChange={(e) => setAccountForm((f) => ({ ...f, newUsername: e.target.value }))}
              />
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="accCurrentPass">Current Password *</label>
              <input
                id="accCurrentPass"
                type="password"
                className="form-input"
                value={accountForm.currentPassword}
                onChange={(e) => setAccountForm((f) => ({ ...f, currentPassword: e.target.value }))}
                placeholder="Required to confirm changes"
              />
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label" htmlFor="accNewPass">New Password</label>
                <input
                  id="accNewPass"
                  type="password"
                  className="form-input"
                  value={accountForm.newPassword}
                  onChange={(e) => setAccountForm((f) => ({ ...f, newPassword: e.target.value }))}
                  placeholder="Min 8 characters"
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="accConfirmPass">Confirm New Password</label>
                <input
                  id="accConfirmPass"
                  type="password"
                  className="form-input"
                  value={accountForm.confirmPassword}
                  onChange={(e) => setAccountForm((f) => ({ ...f, confirmPassword: e.target.value }))}
                  placeholder="Repeat new password"
                />
              </div>
            </div>

            <button type="submit" className="btn btn-primary" disabled={busy === 'account'}>
              {busy === 'account' ? 'Updating…' : 'Update Credentials'}
            </button>
          </form>
        </div>

        <div className="detail-card">
          <div className="settings-card-header">
            <h3 className="detail-card-title" style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: 0 }}>
              <ShieldCheck size={14} /> Dashboard Domain &amp; SSL (Certbot)
            </h3>
            <span className={`status-badge ${dashboardSslEnabled ? 'status-badge--running' : 'status-badge--stopped'}`}>
              {dashboardSslEnabled ? 'HTTPS Active' : 'HTTP Only'}
            </span>
          </div>

          <form onSubmit={handleInstallDashboardSsl}>
            <div className="form-group">
              <label className="form-label" htmlFor="dashDomain">Control Panel Domain</label>
              <input
                id="dashDomain"
                type="text"
                className="form-input"
                value={dashboardDomain}
                onChange={(e) => setDashboardDomain(e.target.value)}
              />
              {dashboardSslExpires && (
                <span className="form-hint">
                  Certificate expires {new Date(dashboardSslExpires).toLocaleDateString()}
                </span>
              )}
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="dashSslEmail">Certbot Email</label>
              <input
                id="dashSslEmail"
                type="email"
                className="form-input"
                value={dashboardSslEmail}
                onChange={(e) => setDashboardSslEmail(e.target.value)}
                placeholder={generalForm.certbotEmail || ''}
              />
            </div>

            <label className="ssl-checkbox-label" style={{ marginBottom: '14px' }}>
              <input
                type="checkbox"
                checked={dashboardRedirect}
                onChange={(e) => setDashboardRedirect(e.target.checked)}
              />
              <span>Redirect HTTP to HTTPS</span>
            </label>

            <div className="action-btns">
              <button type="submit" className="btn btn-primary" disabled={!isAdmin || busy === 'ssl' || !dashboardDomain.trim()}>
                <ShieldCheck size={14} />
                {busy === 'ssl' ? 'Installing SSL…' : 'Install Dashboard SSL'}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handlePreviewDashboardNginx}
                disabled={busy === 'preview' || !dashboardDomain.trim()}
              >
                <FileCode2 size={14} /> Preview Nginx Config
              </button>
            </div>
          </form>

          {dashboardNginxPreview && (
            <div style={{ marginTop: '14px' }}>
              <div className="code-block-header">
                <span className="form-label">/etc/nginx/sites-available/paasbydeeep</span>
                <button
                  type="button"
                  className="btn btn-xs btn-secondary"
                  onClick={() => copyText('dash-cfg', dashboardNginxPreview.config)}
                >
                  {copiedKey === 'dash-cfg' ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
                </button>
              </div>
              <pre className="certbot-log">{dashboardNginxPreview.config}</pre>
            </div>
          )}

          {dashboardCertLog && (
            <div style={{ marginTop: '14px' }}>
              <div className="form-label" style={{ marginBottom: '6px' }}>Certbot Output</div>
              <pre className="certbot-log">{dashboardCertLog}</pre>
            </div>
          )}
        </div>

        <div className="detail-card">
          <h3 className="detail-card-title" style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
            <HardDrive size={14} /> System &amp; Maintenance
          </h3>

          {runtime && (
            <div className="detail-rows" style={{ marginBottom: '16px' }}>
              <div className="detail-row">
                <span className="detail-key">Docker Engine</span>
                <span className="detail-val">
                  <span className={`status-badge ${runtime.dockerConnected ? 'status-badge--running' : 'status-badge--failed'}`}>
                    {runtime.dockerConnected ? 'Connected' : 'Unreachable'}
                  </span>
                </span>
              </div>
              <div className="detail-row">
                <span className="detail-key">Nginx / Certbot</span>
                <span className="detail-val">
                  {runtime.domainSystem?.hasNginx ? 'Nginx Ready' : 'No Nginx'} · {runtime.domainSystem?.hasCertbot ? 'Certbot Ready' : 'No Certbot'}
                </span>
              </div>
              <div className="detail-row">
                <span className="detail-key">Deploy Queue</span>
                <span className="detail-val">
                  {runtime.queue?.isProcessing ? 'Processing' : 'Idle'} ({runtime.queue?.queueLength || 0} pending)
                </span>
              </div>
              <div className="detail-row">
                <span className="detail-key">Backend Uptime</span>
                <span className="detail-val">{formatUptime(runtime.uptimeSeconds)}</span>
              </div>
              <div className="detail-row">
                <span className="detail-key">Runtime</span>
                <span className="detail-val">{runtime.nodeVersion} ({runtime.platform}) · Port {runtime.port}</span>
              </div>
              <div className="detail-row">
                <span className="detail-key">CORS Origin</span>
                <span className="detail-val">{runtime.frontendUrl}</span>
              </div>
            </div>
          )}

          <button
            type="button"
            className="btn btn-secondary"
            onClick={handlePruneDocker}
            disabled={!isAdmin || busy === 'prune' || !runtime?.dockerConnected}
          >
            <Trash2 size={14} /> {busy === 'prune' ? 'Pruning…' : 'Prune Unused Docker Images'}
          </button>
          <p className="detail-hint">
            Removes dangling Docker image layers left over from previous builds to free VPS disk space.
          </p>
        </div>
      </div>
    </div>
  );
}

export default Settings;
