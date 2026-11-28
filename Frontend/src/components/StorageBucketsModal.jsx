import { useState, useEffect, useCallback } from 'react';
import {
  HardDrive, Plus, Trash2, RefreshCw, ExternalLink, Lock, Globe, X,
} from 'lucide-react';
import {
  listServiceBuckets, createServiceBucket, deleteServiceBucket,
} from '../api/services';

const BUCKET_NAME_REGEX = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/**
 * Modal for listing, creating, and deleting S3 buckets inside a MinIO managed service.
 */
function StorageBucketsModal({ isOpen, service, canManage, onClose }) {
  const [buckets, setBuckets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [syncWarning, setSyncWarning] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [bucketName, setBucketName] = useState('');
  const [publicRead, setPublicRead] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busyBucket, setBusyBucket] = useState('');

  const loadBuckets = useCallback(async (serviceId) => {
    setLoading(true);
    setError('');
    try {
      const res = await listServiceBuckets(serviceId);
      setBuckets(Array.isArray(res?.buckets) ? res.buckets : []);
      setSyncWarning(res?.syncWarning || '');
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to load storage buckets.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen || !service?.id) return;
    let active = true;
    listServiceBuckets(service.id)
      .then((res) => {
        if (!active) return;
        setBuckets(Array.isArray(res?.buckets) ? res.buckets : []);
        setSyncWarning(res?.syncWarning || '');
        setError('');
        setNotice('');
      })
      .catch((err) => {
        if (active) setError(err?.response?.data?.error || 'Failed to load storage buckets.');
      });
    return () => { active = false; };
  }, [isOpen, service?.id]);

  if (!isOpen || !service) return null;

  const handleCreateBucket = async (e) => {
    e.preventDefault();
    const cleaned = bucketName.trim().toLowerCase();
    setError('');
    setNotice('');
    if (!BUCKET_NAME_REGEX.test(cleaned)) {
      setError('Bucket name must be 3-63 characters using lowercase letters, numbers, or hyphens.');
      return;
    }
    setCreating(true);
    try {
      await createServiceBucket(service.id, { name: cleaned, publicRead });
      setBucketName('');
      setPublicRead(false);
      setNotice(`Bucket '${cleaned}' created.`);
      await loadBuckets(service.id);
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to create bucket.');
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteBucket = async (name) => {
    setBusyBucket(name);
    setError('');
    setNotice('');
    try {
      const res = await deleteServiceBucket(service.id, name);
      setNotice(res.message || `Bucket '${name}' deleted.`);
      await loadBuckets(service.id);
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to delete bucket.');
    } finally {
      setBusyBucket('');
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <HardDrive size={17} /> Storage Buckets — {service.name}
          </h3>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <button
              type="button"
              className="btn btn-xs btn-secondary"
              onClick={() => loadBuckets(service.id)}
              disabled={loading}
              title="Refresh buckets"
            >
              <RefreshCw size={12} /> Refresh
            </button>
            <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="modal-body">
          <div className="bucket-endpoint-bar">
            <span className="form-hint">
              S3 API: <code>{service.external_url}</code>
            </span>
            {service.console_url && (
              <a
                href={service.console_url}
                target="_blank"
                rel="noreferrer"
                className="app-access-link"
              >
                MinIO Console <ExternalLink size={11} />
              </a>
            )}
          </div>

          {syncWarning && (
            <div className="alert alert-warning" style={{ marginBottom: '12px' }}>
              {syncWarning}
            </div>
          )}
          {error && <div className="alert alert-error" style={{ marginBottom: '12px' }}>{error}</div>}
          {notice && <div className="alert alert-success" style={{ marginBottom: '12px' }}>{notice}</div>}

          {canManage && (
            <form className="bucket-create-form" onSubmit={handleCreateBucket}>
              <div className="bucket-create-row">
                <div className="bucket-create-input-wrap">
                  <label className="form-label" htmlFor="new-bucket-name">Bucket Name *</label>
                  <input
                    id="new-bucket-name"
                    type="text"
                    className="form-input"
                    value={bucketName}
                    onChange={(e) => setBucketName(e.target.value)}
                  />
                </div>
                <button type="submit" className="btn btn-primary" disabled={creating}>
                  <Plus size={14} /> {creating ? 'Creating…' : 'Create Bucket'}
                </button>
              </div>
              <span className="form-hint" style={{ display: 'block', marginTop: '6px' }}>
                3–63 lowercase letters, numbers, or hyphens
              </span>
              <label className="ssl-checkbox-label" style={{ marginTop: '8px' }}>
                <input
                  type="checkbox"
                  checked={publicRead}
                  onChange={(e) => setPublicRead(e.target.checked)}
                />
                <span>Public read access (allow anonymous GET object URLs)</span>
              </label>
            </form>
          )}

          <div className="bucket-list-wrap">
            {loading && buckets.length === 0 ? (
              <div className="loading-state">Loading buckets…</div>
            ) : buckets.length === 0 ? (
              <div className="empty-state-sm">No storage buckets created yet.</div>
            ) : (
              <div className="bucket-list">
                {buckets.map((b) => (
                  <div key={b.name} className="bucket-row">
                    <div className="bucket-row-main">
                      <code className="bucket-row-name">{b.name}</code>
                      <span className={`bucket-access-pill ${b.public_read ? 'bucket-access-pill--public' : ''}`}>
                        {b.public_read ? <><Globe size={11} /> Public Read</> : <><Lock size={11} /> Private</>}
                      </span>
                    </div>
                    <div className="bucket-row-actions">
                      {b.created_at && (
                        <span className="form-hint">
                          {new Date(b.created_at).toLocaleDateString()}
                        </span>
                      )}
                      {canManage && (
                        <button
                          type="button"
                          className="btn btn-xs btn-danger"
                          disabled={busyBucket === b.name}
                          onClick={() => handleDeleteBucket(b.name)}
                          title={`Delete bucket ${b.name}`}
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default StorageBucketsModal;
