import { useState, useEffect } from 'react';
import { Database, Plus, X } from 'lucide-react';
import { createService, getServiceTemplates } from '../api/services';
import { DEFAULT_SERVICE_TEMPLATES, sortServiceTemplates } from '../utils/serviceTemplates';

function CreateDatabaseModal({ isOpen, onClose, onCreated }) {
  const [templates, setTemplates] = useState(DEFAULT_SERVICE_TEMPLATES);
  const [form, setForm] = useState({
    serviceType: 'postgres',
    name: '',
    databaseName: 'appdb',
    port: '',
    memoryLimitMb: '512',
  });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    getServiceTemplates()
      .then((res) => setTemplates(res || {}))
      .catch(() => {});
  }, [isOpen]);

  if (!isOpen) return null;

  const orderedTemplates = sortServiceTemplates(templates);

  const handleSelectType = (type) => {
    const tpl = templates[type];
    setForm((f) => ({
      ...f,
      serviceType: type,
      databaseName: tpl?.defaultDatabase || '',
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!form.name.trim()) {
      setError('Database name / identifier is required.');
      return;
    }
    setCreating(true);
    try {
      const res = await createService({
        name: form.name.trim().toLowerCase(),
        serviceType: form.serviceType,
        port: form.port ? Number(form.port) : undefined,
        databaseName: form.databaseName.trim(),
        memoryLimitMb: Number(form.memoryLimitMb) || 512,
      });
      setForm({
        serviceType: 'postgres',
        name: '',
        databaseName: 'appdb',
        port: '',
        memoryLimitMb: '512',
      });
      onCreated?.(res);
      onClose?.();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to create database.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Database size={17} /> Create Database
          </h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {error && <div className="alert alert-error" style={{ marginBottom: '14px' }}>{error}</div>}

            <div className="form-group">
              <span className="form-label">Database Engine</span>
              <div className="service-template-grid">
                {orderedTemplates.map(([key, tpl]) => (
                  <button
                    key={key}
                    type="button"
                    className={`service-template-card${form.serviceType === key ? ' service-template-card--active' : ''}`}
                    onClick={() => handleSelectType(key)}
                  >
                    <span className="service-template-name">{tpl.label}</span>
                    <span className="service-template-meta">
                      v{tpl.version} · :{tpl.defaultPort}{tpl.defaultConsolePort ? ` / :${tpl.defaultConsolePort}` : ''}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label" htmlFor="modal-db-service-name">Service Name *</label>
                <input
                  id="modal-db-service-name"
                  type="text"
                  className="form-input"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  autoFocus
                />
                <span className="form-hint">Lowercase letters, numbers, and dashes</span>
              </div>

              {form.serviceType !== 'redis' && form.serviceType !== 'minio' && (
                <div className="form-group">
                  <label className="form-label" htmlFor="modal-db-name">Database Name</label>
                  <input
                    id="modal-db-name"
                    type="text"
                    className="form-input"
                    value={form.databaseName}
                    onChange={(e) => setForm((f) => ({ ...f, databaseName: e.target.value }))}
                  />
                </div>
              )}
            </div>

            <div className="form-row">
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label" htmlFor="modal-db-port">Port <span className="form-optional">(auto if blank)</span></label>
                <input
                  id="modal-db-port"
                  type="number"
                  className="form-input"
                  value={form.port}
                  onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))}
                  min={1024}
                  max={65535}
                />
              </div>

              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label" htmlFor="modal-db-mem">Memory Limit (MB)</label>
                <input
                  id="modal-db-mem"
                  type="number"
                  className="form-input"
                  value={form.memoryLimitMb}
                  onChange={(e) => setForm((f) => ({ ...f, memoryLimitMb: e.target.value }))}
                  min={128}
                  max={16384}
                />
              </div>
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={creating}>
              <Plus size={14} /> {creating ? 'Creating…' : form.serviceType === 'minio' ? 'Create Storage' : 'Create Database'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default CreateDatabaseModal;
