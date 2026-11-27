import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { Github, Sparkles, Search, Lock, Globe, ChevronDown, X, Check } from 'lucide-react';
import { createApp } from '../api/apps';
import { getGithubStatus, getGithubRepos, getRepoBranches, detectGithubProject } from '../api/github';
import RepoVisibilityFilter from '../components/RepoVisibilityFilter';
import { filterRepos } from '../utils/repoFilter';

const DEFAULT_FORM = {
  name: '',
  repoUrl: '',
  branch: 'main',
  dockerfilePath: 'Dockerfile',
  port: '',
  envVars: '',
  githubToken: '',
};

function sanitizeAppName(raw) {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
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

function AddApp() {
  const location = useLocation();
  const initialRepo = location.state?.repo;

  const [form, setForm] = useState(() => ({
    ...DEFAULT_FORM,
    ...(initialRepo
      ? {
          name: sanitizeAppName(initialRepo.name || ''),
          repoUrl: initialRepo.html_url || initialRepo.clone_url || '',
          branch: initialRepo.default_branch || 'main',
        }
      : {}),
  }));
  const [ghConnected, setGhConnected] = useState(false);
  const [ghUsername, setGhUsername] = useState('');
  const [repos, setRepos] = useState([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [branches, setBranches] = useState([]);
  const [selectedRepo, setSelectedRepo] = useState(initialRepo?.full_name || '');
  const [repoSearch, setRepoSearch] = useState('');
  const [repoVisibility, setRepoVisibility] = useState('all');
  const [repoDropdownOpen, setRepoDropdownOpen] = useState(false);
  const [highlightedIdx, setHighlightedIdx] = useState(0);
  const [detected, setDetected] = useState(null);
  const [detecting, setDetecting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [createdApp, setCreatedApp] = useState(null);
  const repoPickerRef = useRef(null);
  const navigate = useNavigate();

  const runDetection = useCallback(async (repoUrl, branch, dockerfilePath) => {
    if (!repoUrl || !repoUrl.includes('github.com/')) {
      setDetected(null);
      return;
    }
    setDetecting(true);
    try {
      const res = await detectGithubProject(repoUrl, branch || 'main', dockerfilePath || 'Dockerfile');
      setDetected(res);
      if (res?.suggestedPort) {
        setForm((f) => (f.port ? f : { ...f, port: String(res.suggestedPort) }));
      }
    } catch {
      setDetected(null);
    } finally {
      setDetecting(false);
    }
  }, []);

  useEffect(() => {
    getGithubStatus()
      .then((status) => {
        if (status.connected) {
          setGhConnected(true);
          setGhUsername(status.connection?.github_username || '');
          setReposLoading(true);
          return getGithubRepos()
            .then((list) => setRepos(Array.isArray(list) ? list : []))
            .finally(() => setReposLoading(false));
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (repoPickerRef.current && !repoPickerRef.current.contains(event.target)) {
        setRepoDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (initialRepo?.owner && initialRepo?.name) {
      getRepoBranches(initialRepo.owner, initialRepo.name)
        .then((b) => setBranches(Array.isArray(b) ? b : []))
        .catch(() => {});
      const url = initialRepo.html_url || initialRepo.clone_url;
      if (url) {
        detectGithubProject(url, initialRepo.default_branch || 'main', 'Dockerfile')
          .then((res) => {
            setDetected(res);
            if (res?.suggestedPort) {
              setForm((f) => (f.port ? f : { ...f, port: String(res.suggestedPort) }));
            }
          })
          .catch(() => {});
      }
    }
  }, [initialRepo]);

  const filteredRepos = useMemo(
    () => filterRepos(repos, repoSearch, repoVisibility),
    [repos, repoSearch, repoVisibility]
  );

  const activeHighlightedIdx = Math.min(highlightedIdx, Math.max(filteredRepos.length - 1, 0));

  const handleSelectRepo = (repo) => {
    if (!repo) return;
    setSelectedRepo(repo.full_name);
    setRepoSearch('');
    setRepoDropdownOpen(false);
    setHighlightedIdx(0);

    const repoUrl = repo.html_url || repo.clone_url;
    const branch = repo.default_branch || 'main';
    setForm((f) => ({
      ...f,
      name: sanitizeAppName(repo.name),
      repoUrl,
      branch,
    }));

    if (repo.owner && repo.name) {
      getRepoBranches(repo.owner, repo.name)
        .then((b) => setBranches(Array.isArray(b) ? b : []))
        .catch(() => setBranches([]));
    }
    void runDetection(repoUrl, branch, form.dockerfilePath);
  };

  const handleRepoSearchKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!repoDropdownOpen) {
        setRepoDropdownOpen(true);
        return;
      }
      setHighlightedIdx((idx) => Math.min(idx + 1, Math.max(filteredRepos.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIdx((idx) => Math.max(idx - 1, 0));
    } else if (e.key === 'Enter' && repoDropdownOpen && filteredRepos[activeHighlightedIdx]) {
      e.preventDefault();
      handleSelectRepo(filteredRepos[activeHighlightedIdx]);
    } else if (e.key === 'Escape') {
      setRepoDropdownOpen(false);
    }
  };

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

    setLoading(true);
    setError('');
    try {
      const payload = {
        name: form.name.trim().toLowerCase(),
        repo_url: form.repoUrl.trim(),
        branch: form.branch.trim() || 'main',
        dockerfile_path: form.dockerfilePath.trim() || 'Dockerfile',
        port: Number(form.port),
        env_vars: form.envVars.trim() ? envTextToObj(form.envVars) : {},
        project_type: detected?.projectType || 'auto',
        ...(form.githubToken.trim() && { github_token: form.githubToken.trim() }),
      };
      const result = await createApp(payload);
      setCreatedApp(result.app || result);
    } catch (err) {
      setError(err?.response?.data?.error || err?.response?.data?.message || 'Failed to create application.');
    } finally {
      setLoading(false);
    }
  };

  const rawApiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';
  const apiUrl = rawApiUrl.startsWith('/') ? `${window.location.origin}${rawApiUrl}` : rawApiUrl;
  const appId = createdApp?._id || createdApp?.id;

  if (createdApp) {
    return (
      <div className="page">
        <div className="success-card">
          <h2>🎉 Application Created!</h2>
          <p><strong>{createdApp.name}</strong> was created successfully.</p>

          <div className="form-group" style={{ marginTop: '20px' }}>
            <label className="form-label">Webhook URL (for auto-deploy)</label>
            <code className="webhook-url">{apiUrl}/webhook/github/{appId}</code>
            <p className="detail-hint">Add this to your GitHub/GitLab repository's webhook settings.</p>
          </div>

          <div className="action-btns" style={{ marginTop: '20px' }}>
            <button className="btn btn-primary" onClick={() => navigate(`/apps/${appId}`)}>
              View Application
            </button>
            <button className="btn btn-secondary" onClick={() => navigate('/apps')}>
              All Applications
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <h2 className="page-heading">New Application</h2>
      </div>

      <div className="form-card">
        <form onSubmit={handleSubmit}>
          {error && <div className="alert alert-error">{error}</div>}

          {ghConnected ? (
            <div className="github-import-box" ref={repoPickerRef}>
              <div className="github-import-header">
                <label className="form-label" htmlFor="ghRepoSearch" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Github size={14} /> Import from connected GitHub (@{ghUsername})
                </label>

                <RepoVisibilityFilter
                  repos={repos}
                  value={repoVisibility}
                  onChange={(nextVisibility) => {
                    setRepoVisibility(nextVisibility);
                    setHighlightedIdx(0);
                    setRepoDropdownOpen(true);
                  }}
                />
              </div>

              <div className="repo-picker">
                <div className="repo-picker-input-wrap">
                  <Search size={14} className="github-search-icon" />
                  <input
                    id="ghRepoSearch"
                    type="text"
                    className="form-input repo-picker-input"
                    value={repoSearch}
                    onChange={(e) => {
                      setRepoSearch(e.target.value);
                      setHighlightedIdx(0);
                      setRepoDropdownOpen(true);
                    }}
                    onFocus={() => setRepoDropdownOpen(true)}
                    onKeyDown={handleRepoSearchKeyDown}
                    placeholder={
                      selectedRepo
                        ? `Selected: ${selectedRepo} — type to search another repo…`
                        : reposLoading
                          ? 'Loading repositories…'
                          : 'Search repositories by name, branch, or description…'
                    }
                    role="combobox"
                    aria-expanded={repoDropdownOpen}
                    aria-controls="gh-repo-listbox"
                    aria-autocomplete="list"
                    autoComplete="off"
                  />
                  <div className="repo-picker-actions">
                    {(repoSearch || selectedRepo) && (
                      <button
                        type="button"
                        className="repo-picker-icon-btn"
                        title={repoSearch ? 'Clear search' : 'Clear selected repository'}
                        onClick={() => {
                          if (repoSearch) {
                            setRepoSearch('');
                          } else {
                            setSelectedRepo('');
                          }
                          setHighlightedIdx(0);
                          setRepoDropdownOpen(true);
                        }}
                      >
                        <X size={14} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="repo-picker-icon-btn"
                      title={repoDropdownOpen ? 'Hide repositories' : 'Show repositories'}
                      onClick={() => setRepoDropdownOpen((open) => !open)}
                    >
                      <ChevronDown
                        size={15}
                        style={{
                          transform: repoDropdownOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                          transition: 'transform 0.15s ease',
                        }}
                      />
                    </button>
                  </div>
                </div>

                {repoDropdownOpen && (
                  <div id="gh-repo-listbox" className="repo-picker-dropdown" role="listbox">
                    {reposLoading && repos.length === 0 ? (
                      <div className="repo-picker-empty">Loading repositories…</div>
                    ) : filteredRepos.length === 0 ? (
                      <div className="repo-picker-empty">
                        <span>No matching repositories found.</span>
                        {(repoSearch || repoVisibility !== 'all') && (
                          <button
                            type="button"
                            className="repo-picker-reset"
                            onClick={() => {
                              setRepoSearch('');
                              setRepoVisibility('all');
                              setHighlightedIdx(0);
                            }}
                          >
                            Reset filters
                          </button>
                        )}
                      </div>
                    ) : (
                      filteredRepos.map((repo, idx) => {
                        const isSelected = selectedRepo === repo.full_name;
                        const isActive = idx === activeHighlightedIdx;
                        return (
                          <button
                            key={repo.id}
                            type="button"
                            role="option"
                            aria-selected={isSelected}
                            className={`repo-picker-option ${isActive ? 'repo-picker-option--active' : ''} ${isSelected ? 'repo-picker-option--selected' : ''}`}
                            onMouseEnter={() => setHighlightedIdx(idx)}
                            onClick={() => handleSelectRepo(repo)}
                          >
                            <div className="repo-picker-option-main">
                              <span className="repo-picker-option-name">{repo.full_name}</span>
                              <span className={`repo-visibility ${repo.private ? 'repo-visibility--private' : ''}`}>
                                {repo.private ? <><Lock size={10} /> Private</> : <><Globe size={10} /> Public</>}
                              </span>
                              <span className="repo-branch-pill">{repo.default_branch}</span>
                              {isSelected && <Check size={14} className="repo-picker-check" />}
                            </div>
                            {repo.description && (
                              <span className="repo-picker-option-desc">{repo.description}</span>
                            )}
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="github-import-hint">
              <Github size={14} />
              <span>
                Want to pick repos directly or deploy private repos without pasting tokens?{' '}
                <Link to="/github">Connect your GitHub account</Link>.
              </span>
            </div>
          )}

          <div className="form-row">
            <div className="form-group">
              <label className="form-label" htmlFor="name">Application Name *</label>
              <input
                id="name"
                type="text"
                className="form-input"
                value={form.name}
                onChange={set('name')}
                placeholder="my-app"
                pattern="[a-zA-Z0-9-]+"
                autoFocus
              />
              <span className="form-hint">Alphanumeric and dashes only</span>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="port">Port *</label>
              <input
                id="port"
                type="number"
                className="form-input"
                value={form.port}
                onChange={set('port')}
                placeholder="3000"
                min="1024"
                max="65535"
              />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="repoUrl">Repository URL *</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                id="repoUrl"
                type="url"
                className="form-input"
                value={form.repoUrl}
                onChange={set('repoUrl')}
                onBlur={() => runDetection(form.repoUrl.trim(), form.branch.trim(), form.dockerfilePath.trim())}
                placeholder="https://github.com/user/repo"
              />
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => runDetection(form.repoUrl.trim(), form.branch.trim(), form.dockerfilePath.trim())}
                disabled={detecting || !form.repoUrl.trim()}
              >
                <Sparkles size={14} /> {detecting ? 'Detecting…' : 'Detect'}
              </button>
            </div>
            {detected && (
              <div className="detect-banner">
                <Sparkles size={13} />
                <span>
                  Detected: <strong>{detected.label}</strong>
                  {detected.hasDockerfile
                    ? ' — using repository Dockerfile'
                    : detected.projectType !== 'unknown'
                      ? ' — no Dockerfile found, auto-Dockerfile will be generated on deploy'
                      : ' — add a Dockerfile to deploy'}
                </span>
              </div>
            )}
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label" htmlFor="branch">Branch</label>
              <input
                id="branch"
                type="text"
                list="branch-suggestions"
                className="form-input"
                value={form.branch}
                onChange={set('branch')}
                placeholder="main"
              />
              {branches.length > 0 && (
                <datalist id="branch-suggestions">
                  {branches.map((b) => (
                    <option key={b} value={b} />
                  ))}
                </datalist>
              )}
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="dockerfilePath">Dockerfile Path</label>
              <input
                id="dockerfilePath"
                type="text"
                className="form-input"
                value={form.dockerfilePath}
                onChange={set('dockerfilePath')}
                placeholder="Dockerfile"
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
              placeholder={"NODE_ENV=production\nPORT=3000\nDATABASE_URL=..."}
              rows={6}
            />
            <span className="form-hint">One KEY=VALUE per line</span>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="githubToken">
              GitHub Token <span className="form-optional">(optional override)</span>
            </label>
            <input
              id="githubToken"
              type="password"
              className="form-input"
              value={form.githubToken}
              onChange={set('githubToken')}
              placeholder="ghp_••••••••"
              autoComplete="off"
            />
            <span className="form-hint">
              {ghConnected
                ? 'Private repos will automatically use your connected GitHub account if left blank.'
                : 'Required for private repos unless you connect your GitHub account.'}
            </span>
          </div>

          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => navigate('/apps')}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Creating…' : 'Create Application'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default AddApp;
