import { useState, useEffect } from 'react';
import { Copy, Check, FileCode2, X } from 'lucide-react';
import { getNginxConfig } from '../api/domains';

function NginxConfigModalBody({ domainRecord, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  useEffect(() => {
    let active = true;
    getNginxConfig(domainRecord.id)
      .then((res) => {
        if (active) setData(res);
      })
      .catch((err) => {
        if (active) setError(err?.response?.data?.error || 'Failed to load Nginx configuration.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [domainRecord.id]);

  const copyText = (key, text) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(''), 2000);
    }).catch(() => {});
  };

  return (
    <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
      <div className="modal-header">
        <h3 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <FileCode2 size={17} /> Nginx &amp; Certbot Config — {domainRecord.domain}
        </h3>
        <button className="modal-close" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </div>

      <div className="modal-body">
        {loading ? (
          <div className="loading-state">Loading configuration…</div>
        ) : error ? (
          <div className="alert alert-error">{error}</div>
        ) : data && (
          <>
            <div className="code-block-header">
              <span className="form-label">/etc/nginx/sites-available/{data.fileName}</span>
              <button
                type="button"
                className="btn btn-xs btn-secondary"
                onClick={() => copyText('config', data.config)}
              >
                {copied === 'config' ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy Config</>}
              </button>
            </div>
            <pre className="certbot-log">{data.config}</pre>

            <div className="code-block-header" style={{ marginTop: '14px' }}>
              <span className="form-label">Manual Certbot Command (VPS)</span>
              <button
                type="button"
                className="btn btn-xs btn-secondary"
                onClick={() => copyText('cmd', data.certbotCommand)}
              >
                {copied === 'cmd' ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy Command</>}
              </button>
            </div>
            <code className="webhook-url">{data.certbotCommand}</code>

            {domainRecord.last_cert_log && (
              <div style={{ marginTop: '14px' }}>
                <div className="form-label" style={{ marginBottom: '6px' }}>Last Certbot Log</div>
                <pre className="certbot-log">{domainRecord.last_cert_log}</pre>
              </div>
            )}
          </>
        )}
      </div>

      <div className="modal-footer">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

function NginxConfigModal({ isOpen, domainRecord, onClose }) {
  if (!isOpen || !domainRecord) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <NginxConfigModalBody
        key={domainRecord.id}
        domainRecord={domainRecord}
        onClose={onClose}
      />
    </div>
  );
}

export default NginxConfigModal;
