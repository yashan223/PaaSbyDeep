import { useEffect, useRef } from 'react';

function formatTimestamp(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

function LogViewer({ logs, className = '', emptyMessage = 'No logs available.', autoScroll = true }) {
  const viewerRef = useRef(null);
  const viewerClass = `log-viewer${className ? ` ${className}` : ''}`;

  useEffect(() => {
    if (autoScroll && viewerRef.current) {
      viewerRef.current.scrollTop = viewerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  if (!logs || logs.length === 0) {
    return (
      <div className={`${viewerClass} log-viewer--empty`}>
        <span>{emptyMessage}</span>
      </div>
    );
  }

  const lines = Array.isArray(logs)
    ? logs
    : typeof logs === 'string'
      ? logs.split(/\r?\n/).filter((line, idx, arr) => !(idx === arr.length - 1 && line === ''))
      : [logs];

  if (lines.length === 0) {
    return (
      <div className={`${viewerClass} log-viewer--empty`}>
        <span>{emptyMessage}</span>
      </div>
    );
  }

  return (
    <div ref={viewerRef} className={viewerClass}>
      {lines.map((line, i) => {
        if (typeof line === 'string') {
          return (
            <div key={i} className="log-line">
              <span className="log-text">{line}</span>
            </div>
          );
        }
        return (
          <div key={i} className="log-line">
            {line.timestamp && (
              <span className="log-timestamp">{formatTimestamp(line.timestamp)}</span>
            )}
            <span className="log-text">{line.message || line.text || JSON.stringify(line)}</span>
          </div>
        );
      })}
    </div>
  );
}

export default LogViewer;
