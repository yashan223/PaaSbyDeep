import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getApp, updateApp } from '../api/apps';

function envObjToText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('\n');
}

function envTextToObj(text) {
  const obj = {};
  text.split('\n').forEach((line) => {
    const eq = line.indexOf('=');
    if (eq > 0) {
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      if (key) obj[key] = val;
    }
  });
  return obj;
}

function EditApp() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    name: '',
    repoUrl: '',
    branch: 'main',
    dockerfilePath: 'Dockerfile',
    port: '',
    envVars: '',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    getApp(id)
      .then((app) => {
        if (!active) return;
        setForm({
          name: app.name || '',
          repoUrl: app.repo_url || app.repoUrl || app.repository || '',
          branch: app.branch || 'main',
          dockerfilePath: app.dockerfile_path || app.dockerfilePath || 'Dockerfile',
          port: app.port ? String(app.port) : '',
          envVars: envObjToText(app.env_vars || app.envVars || app.env),
        });
      })
      .catch((err) => {
        if (active) setError(err?.response?.data?.error || err?.response?.data?.message || 'Failed to load app.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [id]);

  const set = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const validate = () => {
    if (!form.name.trim()) return 'Application name is required.';
    if (!/^[a-z0-9-]+$/.test(form.name.trim().toLowerCase())) return 'Name must be alphanumeric (dashes allowed).';
    if (!form.repoUrl.trim()) return 'Repository URL is required.';
    if (!form.port) return 'Port is required.';
    const port = Number(form.port);
    if (isNaN(port) || !Number.isInteger(port) || port < 1024 || port > 65535) return 'Port must be an integer between 1024 and 65535.';
    return null;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const err = validate();
    if (err) { setError(err); return; }

    setSaving(true);
    setError('');
    try {
      const payload = {
        name: form.name.trim().toLowerCase(),
        repo_url: form.repoUrl.trim(),
        branch: form.branch.trim() || 'main',
        dockerfile_path: form.dockerfilePath.trim() || 'Dockerfile',
        port: Number(form.port),
        env_vars: form.envVars.trim() ? envTextToObj(form.envVars) : {},
      };
      await updateApp(id, payload);
      navigate(`/apps/${id}`);
    } catch (err) {
      setError(err?.response?.data?.error || err?.response?.data?.message || 'Failed to update application.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="page"><div className="loading-state">Loading…</div></div>;

  return (
    <div className="page">
      <div className="page-header">
        <h2 className="page-heading">Edit Application</h2>
      </div>

      <div className="form-card">
        <form onSubmit={handleSubmit}>
          {error && <div className="alert alert-error">{error}</div>}

          <div className="form-row">
            <div className="form-group">
              <label className="form-label" htmlFor="name">Application Name *</label>
              <input
                id="name"
                type="text"
                className="form-input"
                value={form.name}
                onChange={set('name')}
              />
              <span className="form-hint">Alphanumeric and dashes only</span>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="port">Port</label>
              <input
                id="port"
                type="number"
                className="form-input"
                value={form.port}
                onChange={set('port')}
                min="1024"
                max="65535"
              />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="repoUrl">Repository URL *</label>
            <input
              id="repoUrl"
              type="url"
              className="form-input"
              value={form.repoUrl}
              onChange={set('repoUrl')}
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label" htmlFor="branch">Branch</label>
              <input
                id="branch"
                type="text"
                className="form-input"
                value={form.branch}
                onChange={set('branch')}
              />
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="dockerfilePath">Dockerfile Path</label>
              <input
                id="dockerfilePath"
                type="text"
                className="form-input"
                value={form.dockerfilePath}
                onChange={set('dockerfilePath')}
              />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="envVars">Environment Variables</label>
            <textarea
              id="envVars"
              className="form-textarea"
              value={form.envVars}
              onChange={set('envVars')}
              rows={6}
            />
            <span className="form-hint">One KEY=VALUE per line</span>
          </div>

          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => navigate(`/apps/${id}`)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default EditApp;
