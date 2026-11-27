import { useState } from 'react';
import { ShieldCheck, X } from 'lucide-react';
import { installSsl } from '../api/domains';

function InstallSslModalBody({ domainRecord, certbotEmailConfigured, onClose, onSuccess }) {
  const [email, setEmail] = useState('');
  const [redirect, setRedirect] = useState(true);
  const [forceRenew, setForceRenew] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(() => domainRecord.last_cert_error || '');
  const [log, setLog] = useState(() => domainRecord.last_cert_log || '');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email.trim() && !certbotEmailConfigured) {
      setError("Please enter an email address for Let's Encrypt SSL notifications.");
      return;
    }

    setSubmitting(true);
    setError('');
    setLog('');
    try {
      const res = await installSsl(domainRecord.id, {
        ...(email.trim() ? { email: email.trim() } : {}),
        redirect,
        forceRenew,
      });
      setLog(res.log || res.message || 'SSL certificate installed.');
      if (onSuccess) onSuccess(res);
    } catch (err) {
      setError(err?.response?.data?.error || 'Certbot SSL installation failed.');
      if (err?.response?.data?.log) {
        setLog(err.response.data.log);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
      <div className="modal-header">
        <h3 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <ShieldCheck size={17} style={{ color: 'var(--success-text)' }} />
          Certbot SSL Installer — {domainRecord.domain}
        </h3>
        <button className="modal-close" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="modal-body">
          <p style={{ marginBottom: '14px', fontSize: '13px' }}>
            Configures Nginx HTTP proxy for <strong>{domainRecord.domain}</strong> (port{' '}
            <code>{domainRecord.app_port || '—'}</code>) and runs{' '}
            <code>certbot --nginx</code> to issue and install a Let&apos;s Encrypt TLS certificate.
          </p>

          {error && <div className="alert alert-error" style={{ marginBottom: '14px' }}>{error}</div>}

          <div className="form-group">
            <label className="form-label" htmlFor="certbot-email">
              Let&apos;s Encrypt Email {certbotEmailConfigured ? '(optional — default set on server)' : '*'}
            </label>
            <input
              id="certbot-email"
              type="email"
              className="form-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <span className="form-hint">Used only by Let&apos;s Encrypt for urgent renewal notices.</span>
          </div>

          <div className="ssl-checkboxes">
            <label className="ssl-checkbox-label">
              <input
                type="checkbox"
                checked={redirect}
                onChange={(e) => setRedirect(e.target.checked)}
              />
              <span>Redirect HTTP to HTTPS (<code>--redirect</code>)</span>
            </label>

            {domainRecord.ssl_enabled && (
              <label className="ssl-checkbox-label">
                <input
                  type="checkbox"
                  checked={forceRenew}
                  onChange={(e) => setForceRenew(e.target.checked)}
                />
                <span>Force renewal even if certificate is still valid</span>
              </label>
            )}
          </div>

          {log && (
            <div style={{ marginTop: '14px' }}>
              <div className="form-label" style={{ marginBottom: '6px' }}>Certbot Output</div>
              <pre className="certbot-log">{log}</pre>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={submitting}>
            Close
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            <ShieldCheck size={14} />
            {submitting
              ? 'Installing Certificate…'
              : domainRecord.ssl_enabled
                ? 'Reinstall / Renew SSL'
                : 'Install SSL Certificate'}
          </button>
        </div>
      </form>
    </div>
  );
}

function InstallSslModal({ isOpen, domainRecord, certbotEmailConfigured = false, onClose, onSuccess }) {
  if (!isOpen || !domainRecord) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <InstallSslModalBody
        key={domainRecord.id}
        domainRecord={domainRecord}
        certbotEmailConfigured={certbotEmailConfigured}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    </div>
  );
}

export default InstallSslModal;
