import { Lock, ShieldAlert } from 'lucide-react';

function SslStatusBadge({ domain }) {
  if (domain?.ssl_status === 'active' || domain?.ssl_enabled) {
    return (
      <span className="status-badge status-badge--running">
        <Lock size={11} /> Active
      </span>
    );
  }
  if (domain?.ssl_status === 'pending') {
    return (
      <span className="status-badge status-badge--deploying">
        <span className="status-dot status-dot--pulse" /> Installing…
      </span>
    );
  }
  if (domain?.ssl_status === 'failed') {
    return (
      <span className="status-badge status-badge--failed" title={domain.last_cert_error || ''}>
        <ShieldAlert size={11} /> Failed
      </span>
    );
  }
  return (
    <span className="status-badge status-badge--stopped">
      HTTP Only
    </span>
  );
}

export default SslStatusBadge;
