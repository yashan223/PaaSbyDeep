import { useState } from 'react';
import { Copy, Check, Globe } from 'lucide-react';

function getDnsHostLabel(domainInput) {
  const cleaned = String(domainInput || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  if (!cleaned) return '@ or subdomain';
  const parts = cleaned.split('.').filter(Boolean);
  if (parts.length <= 2) return '@';
  return parts.slice(0, -2).join('.');
}

function DnsRecordHint({ sysStatus, domainValue }) {
  const [copiedKey, setCopiedKey] = useState('');

  if (!sysStatus) return null;

  const targetIp = sysStatus.publicIpv4 || sysStatus.localIpv4 || '';
  const isLocalFallback = !sysStatus.publicIpv4 && Boolean(sysStatus.localIpv4);
  const hostLabel = getDnsHostLabel(domainValue);

  const copyValue = (key, value) => {
    if (!value) return;
    navigator.clipboard?.writeText(value).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(''), 2000);
    }).catch(() => {});
  };

  return (
    <div className="dns-hint-box">
      <div className="dns-hint-title">
        <Globe size={13} />
        <span>DNS Record Setup (Point your domain before installing SSL)</span>
      </div>

      {targetIp ? (
        <div className="dns-record-grid">
          <div className="dns-record-row">
            <span className="dns-record-type">A</span>
            <span className="dns-record-label">Name / Host: <code>{hostLabel}</code></span>
            <span className="dns-record-label">
              IPv4 Address: <code className="dns-ip-code">{targetIp}</code>
              {isLocalFallback && <span className="form-hint" style={{ marginLeft: '6px' }}>(Local IP — use your VPS Public IP in production)</span>}
            </span>
            <button
              type="button"
              className="btn btn-xs btn-secondary"
              onClick={() => copyValue('v4', targetIp)}
            >
              {copiedKey === 'v4' ? <><Check size={11} /> Copied</> : <><Copy size={11} /> Copy IP</>}
            </button>
          </div>

          {sysStatus.publicIpv6 && (
            <div className="dns-record-row">
              <span className="dns-record-type">AAAA</span>
              <span className="dns-record-label">Name / Host: <code>{hostLabel}</code></span>
              <span className="dns-record-label">
                IPv6 Address: <code className="dns-ip-code">{sysStatus.publicIpv6}</code>
              </span>
              <button
                type="button"
                className="btn btn-xs btn-secondary"
                onClick={() => copyValue('v6', sysStatus.publicIpv6)}
              >
                {copiedKey === 'v6' ? <><Check size={11} /> Copied</> : <><Copy size={11} /> Copy IPv6</>}
              </button>
            </div>
          )}
        </div>
      ) : (
        <p className="detail-hint" style={{ marginTop: 0 }}>
          Add an <strong>A record</strong> for <code>{hostLabel}</code> pointing to your VPS public IPv4 address (or set <code>SERVER_PUBLIC_IP</code> in <code>Backend/.env</code>).
        </p>
      )}
    </div>
  );
}

export default DnsRecordHint;
