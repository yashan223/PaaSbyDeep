import { useState, useMemo } from 'react';
import { Plus, Trash2, Eye, EyeOff, FileText, List, Download, Database } from 'lucide-react';

const SENSITIVE_KEY_RE = /TOKEN|SECRET|KEY|PASSWORD|PASSWD|PASS|CREDENTIAL|AUTH|DATABASE_URL|REDIS_URL|MONGODB_URI/i;

function objToRows(obj) {
  if (!obj || typeof obj !== 'object') return [];
  return Object.entries(obj).map(([key, value], idx) => ({
    id: `${idx}-${key}`,
    key,
    value: value === undefined || value === null ? '' : String(value),
  }));
}

function rowsToObj(rows) {
  const out = {};
  for (const row of rows) {
    const k = String(row.key || '').trim();
    if (k) out[k] = String(row.value ?? '');
  }
  return out;
}

function objToText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  return Object.entries(obj)
    .map(([k, v]) => `${k}=${v ?? ''}`)
    .join('\n');
}

function textToObj(text) {
  const obj = {};
  String(text || '')
    .split(/\r?\n/)
    .forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const clean = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
      const eq = clean.indexOf('=');
      if (eq > 0) {
        const key = clean.slice(0, eq).trim();
        let val = clean.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (key) obj[key] = val;
      }
    });
  return obj;
}

function EnvVarsEditor({ value = {}, onChange, services = [], readOnly = false }) {
  const [mode, setMode] = useState('rows'); // rows | raw
  const [revealedKeys, setRevealedKeys] = useState({});
  const [selectedServiceId, setSelectedServiceId] = useState('');

  const rows = useMemo(() => objToRows(value), [value]);
  const rawText = useMemo(() => objToText(value), [value]);

  const emitRows = (nextRows) => {
    onChange?.(rowsToObj(nextRows));
  };

  const handleRowChange = (index, field, val) => {
    const next = rows.map((r, i) => (i === index ? { ...r, [field]: val } : r));
    emitRows(next);
  };

  const handleAddRow = () => {
    emitRows([...rows, { id: `new-${Date.now()}`, key: '', value: '' }]);
  };

  const handleRemoveRow = (index) => {
    emitRows(rows.filter((_, i) => i !== index));
  };

  const toggleReveal = (rowKey) => {
    setRevealedKeys((prev) => ({ ...prev, [rowKey]: !prev[rowKey] }));
  };

  const handleDownloadEnv = () => {
    const content = objToText(value);
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '.env';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleInjectService = () => {
    const svc = services.find((s) => String(s.id) === String(selectedServiceId));
    if (!svc || !svc.internal_url) return;
    const key = svc.suggested_env_key || 'DATABASE_URL';
    onChange?.({ ...(value || {}), [key]: svc.internal_url });
    setSelectedServiceId('');
  };

  return (
    <div className="env-editor">
      <div className="env-editor-toolbar">
        <div className="repo-filter-pills" role="group" aria-label="Environment editor mode">
          <button
            type="button"
            className={`repo-filter-pill ${mode === 'rows' ? 'repo-filter-pill--active' : ''}`}
            onClick={() => setMode('rows')}
          >
            <List size={11} style={{ verticalAlign: '-1px', marginRight: '4px' }} />
            Key / Value ({rows.length})
          </button>
          <button
            type="button"
            className={`repo-filter-pill ${mode === 'raw' ? 'repo-filter-pill--active' : ''}`}
            onClick={() => setMode('raw')}
          >
            <FileText size={11} style={{ verticalAlign: '-1px', marginRight: '4px' }} />
            Raw .env
          </button>
        </div>

        <div className="env-editor-actions">
          {services.length > 0 && !readOnly && (
            <div className="env-service-inject">
              <select
                className="form-input env-service-select"
                value={selectedServiceId}
                onChange={(e) => setSelectedServiceId(e.target.value)}
                aria-label="Select managed service to inject connection URL"
              >
                <option value="">Insert Managed DB URL…</option>
                {services.map((s) => (
                  <option key={s.id} value={String(s.id)}>
                    {s.name} ({s.service_type}) → {s.suggested_env_key}
                  </option>
                ))}
              </select>
              {selectedServiceId && (
                <button type="button" className="btn btn-xs btn-secondary" onClick={handleInjectService}>
                  <Database size={11} /> Insert
                </button>
              )}
            </div>
          )}

          {rows.length > 0 && (
            <button type="button" className="btn btn-xs btn-secondary" onClick={handleDownloadEnv} title="Export .env">
              <Download size={11} /> Export .env
            </button>
          )}
        </div>
      </div>

      {mode === 'raw' ? (
        <textarea
          id="envVars"
          className="form-textarea"
          value={rawText}
          onChange={(e) => onChange?.(textToObj(e.target.value))}
          readOnly={readOnly}
          rows={6}
          placeholder="KEY=VALUE (one per line, # comments supported)"
        />
      ) : (
        <div className="env-rows">
          {rows.length === 0 ? (
            <div className="empty-state-sm" style={{ padding: '14px' }}>
              No environment variables configured yet.
            </div>
          ) : (
            rows.map((row, idx) => {
              const isSensitive = SENSITIVE_KEY_RE.test(row.key) || row.value === '[REDACTED]';
              const revealed = Boolean(revealedKeys[row.id]);
              return (
                <div key={row.id} className="env-row">
                  <input
                    type="text"
                    className="form-input env-key-input"
                    value={row.key}
                    onChange={(e) => handleRowChange(idx, 'key', e.target.value)}
                    placeholder="Key"
                    readOnly={readOnly}
                    aria-label={`Environment key ${idx + 1}`}
                  />
                  <div className="input-with-icon env-val-wrap">
                    <input
                      type={isSensitive && !revealed ? 'password' : 'text'}
                      className="form-input"
                      value={row.value}
                      onChange={(e) => handleRowChange(idx, 'value', e.target.value)}
                      placeholder="Value"
                      readOnly={readOnly}
                      aria-label={`Environment value ${idx + 1}`}
                    />
                    {isSensitive && (
                      <button
                        type="button"
                        className="input-icon-btn"
                        onClick={() => toggleReveal(row.id)}
                        aria-label={revealed ? 'Hide value' : 'Reveal value'}
                      >
                        {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    )}
                  </div>
                  {!readOnly && (
                    <button
                      type="button"
                      className="btn btn-xs btn-danger env-remove-btn"
                      onClick={() => handleRemoveRow(idx)}
                      title="Remove variable"
                      aria-label={`Remove variable ${row.key || idx + 1}`}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              );
            })
          )}

          {!readOnly && (
            <button type="button" className="btn btn-xs btn-secondary" onClick={handleAddRow}>
              <Plus size={12} /> Add Variable
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default EnvVarsEditor;
