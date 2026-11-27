function StatusBadge({ status }) {
  const normalized = (status || 'unknown').toLowerCase();

  const labels = {
    running: 'Running',
    stopped: 'Stopped',
    deploying: 'Deploying',
    error: 'Error',
    failed: 'Error',
    unknown: 'Unknown',
    building: 'Building',
    pending: 'Pending',
  };

  const label = labels[normalized] || status;

  return (
    <span className={`status-badge status-badge--${normalized}`}>
      <span className={`status-dot${normalized === 'deploying' || normalized === 'building' ? ' status-dot--pulse' : ''}`} />
      {label}
    </span>
  );
}

export default StatusBadge;
