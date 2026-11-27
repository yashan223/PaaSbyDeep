import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import {
  Github, Key, Link2, Unlink, RefreshCw, Lock, Globe, Rocket, ExternalLink, Search, X, Play, ArrowUpRight,
} from 'lucide-react';
import {
  getGithubStatus,
  connectGithubPat,
  getGithubOAuthUrl,
  disconnectGithub,
  getGithubRepos,
} from '../api/github';
import { deployApp } from '../api/apps';
import useApps from '../hooks/useApps';
import { useWebSocket } from '../context/WebSocketContext';
import StatusBadge from '../components/StatusBadge';
import RepoVisibilityFilter from '../components/RepoVisibilityFilter';
import { filterRepos, groupAppsByGithubRepo } from '../utils/repoFilter';

function GitHubConnect() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { apps, setApps, fetchApps } = useApps();
  const { subscribe } = useWebSocket();

  const [status, setStatus] = useState(null);
  const [repos, setRepos] = useState([]);
  const [search, setSearch] = useState('');
  const [visibility, setVisibility] = useState('all');
  const [repoScope, setRepoScope] = useState('deployed');
  const [deployingAppId, setDeployingAppId] = useState(null);
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [reposLoading, setReposLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(() => searchParams.get('error') || '');
  const [success, setSuccess] = useState(() =>
    searchParams.get('connected') === '1' ? 'GitHub account connected via OAuth!' : ''
  );

  useEffect(() => {
    void fetchApps();
  }, [fetchApps]);

  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === 'app:status') {
        setApps((prev) =>
          prev.map((a) =>
            Number(a.id) === Number(msg.appId)
              ? { ...a, status: msg.status }
              : a
          )
        );
      } else if (msg.type === 'apps:changed') {
        void fetchApps();
      }
    });
  }, [subscribe, setApps, fetchApps]);

  const loadRepos = useCallback(async () => {
    setReposLoading(true);
    try {
      const list = await getGithubRepos();
      setRepos(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to load repositories from GitHub.');
    } finally {
      setReposLoading(false);
    }
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const data = await getGithubStatus();
      setStatus(data);
      if (data.connected) {
        await loadRepos();
      } else {
        setRepos([]);
      }
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to check GitHub connection.');
    } finally {
      setLoading(false);
    }
  }, [loadRepos]);

  useEffect(() => {
    let active = true;
    if (searchParams.has('connected') || searchParams.has('error')) {
      setSearchParams({}, { replace: true });
    }
    getGithubStatus()
      .then(async (data) => {
        if (!active) return;
        setStatus(data);
        if (data.connected) {
          setReposLoading(true);
          try {
            const list = await getGithubRepos();
            if (active) setRepos(Array.isArray(list) ? list : []);
          } catch (err) {
            if (active) setError(err?.response?.data?.error || 'Failed to load repositories from GitHub.');
          } finally {
            if (active) setReposLoading(false);
          }
        }
      })
      .catch((err) => {
        if (active) setError(err?.response?.data?.error || 'Failed to check GitHub connection.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [searchParams, setSearchParams]);

  const handlePatConnect = async (e) => {
    e.preventDefault();
    if (!token.trim()) {
      setError('Please enter a GitHub Personal Access Token.');
      return;
    }
    setSubmitting(true);
    setError('');
    setSuccess('');
    try {
      const res = await connectGithubPat(token.trim());
      setToken('');
      setSuccess(res.message || 'GitHub account connected!');
      window.dispatchEvent(new Event('github-connection-changed'));
      await loadStatus();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to connect GitHub account.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleOAuthConnect = async () => {
    setError('');
    try {
      const { url } = await getGithubOAuthUrl();
      window.location.href = url;
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to start GitHub OAuth.');
    }
  };

  const handleDisconnect = async () => {
    setSubmitting(true);
    setError('');
    setSuccess('');
    try {
      await disconnectGithub();
      setSuccess('GitHub account disconnected.');
      window.dispatchEvent(new Event('github-connection-changed'));
      await loadStatus();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to disconnect GitHub account.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeployRepo = (repo) => {
    navigate('/apps/new', { state: { repo } });
  };

  const handleRedeployApp = async (appId) => {
    setDeployingAppId(appId);
    setError('');
    try {
      await deployApp(appId);
      setSuccess('Deployment started.');
      await fetchApps();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to start deployment.');
    } finally {
      setDeployingAppId(null);
    }
  };

  const deployedBySlug = useMemo(() => groupAppsByGithubRepo(apps), [apps]);

  const deployedRepos = useMemo(() => {
    const seen = new Set();
    const matched = [];
    for (const r of repos) {
      const slug = r.full_name.toLowerCase();
      if (deployedBySlug.has(slug)) {
        seen.add(slug);
        matched.push(r);
      }
    }
    for (const [slug, linkedApps] of deployedBySlug.entries()) {
      if (seen.has(slug)) continue;
      const first = linkedApps[0];
      matched.push({
        id: `deployed-${first.id}`,
        full_name: slug,
        default_branch: first.branch || 'main',
        private: Boolean(first.has_github_token),
        description: '',
      });
    }
    return matched;
  }, [repos, deployedBySlug]);

  const scopedRepos = repoScope === 'deployed' ? deployedRepos : repos;

  const filteredRepos = useMemo(
    () => filterRepos(scopedRepos, search, visibility),
    [scopedRepos, search, visibility]
  );

  if (loading) {
    return (
      <div className="page">
        <div className="loading-state">Loading GitHub integration…</div>
      </div>
    );
  }

  const conn = status?.connection;

  return (
    <div className="page">
      <div className="page-header">
        <h2 className="page-heading">GitHub Integration</h2>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: '16px' }}>{error}</div>}
      {success && <div className="alert alert-success" style={{ marginBottom: '16px' }}>{success}</div>}

      {status?.connected && conn ? (
        <div className="detail-card" style={{ marginBottom: '24px' }}>
          <div className="github-profile">
            <div className="github-profile-left">
              {conn.avatar_url ? (
                <img src={conn.avatar_url} alt={conn.github_username} className="github-avatar" />
              ) : (
                <div className="github-avatar-fallback"><Github size={24} /></div>
              )}
              <div>
                <div className="github-username-row">
                  <a
                    href={conn.profile_url}
                    target="_blank"
                    rel="noreferrer"
                    className="github-username"
                  >
                    @{conn.github_username} <ExternalLink size={13} />
                  </a>
                  <span className="status-badge status-badge--running">
                    <span className="status-dot" /> Connected
                  </span>
                </div>
                <p className="github-meta">
                  Method: <strong>{conn.auth_type === 'oauth' ? 'GitHub OAuth' : 'Personal Access Token'}</strong>
                  {conn.connected_at && ` • Connected ${new Date(conn.connected_at).toLocaleString()}`}
                </p>
                <p className="detail-hint" style={{ marginTop: '4px' }}>
                  Private repositories and 1-click repository imports automatically use this connection.
                </p>
              </div>
            </div>

            <div className="action-btns">
              <button
                className="btn btn-secondary btn-sm"
                onClick={loadRepos}
                disabled={reposLoading}
              >
                <RefreshCw size={13} /> {reposLoading ? 'Refreshing…' : 'Refresh Repos'}
              </button>
              <button
                className="btn btn-danger btn-sm"
                onClick={handleDisconnect}
                disabled={submitting}
              >
                <Unlink size={13} /> Disconnect
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="github-connect-grid">
          <div className="detail-card">
            <h3 className="detail-card-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Key size={15} /> Connect with Personal Access Token
            </h3>
            <p className="detail-hint" style={{ marginBottom: '14px' }}>
              Works immediately on localhost or any VPS. Create a token with{' '}
              <code>repo</code> (and optional <code>admin:repo_hook</code>) scopes.
            </p>

            <form onSubmit={handlePatConnect}>
              <div className="form-group">
                <label className="form-label" htmlFor="gh-pat">GitHub Personal Access Token</label>
                <input
                  id="gh-pat"
                  type="password"
                  className="form-input"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                  autoComplete="off"
                />
              </div>

              <div className="action-btns">
                <button type="submit" className="btn btn-primary" disabled={submitting}>
                  <Link2 size={14} /> {submitting ? 'Verifying…' : 'Connect GitHub'}
                </button>
                <a
                  href="https://github.com/settings/tokens/new?scopes=repo,admin:repo_hook&description=PaaSbyDeep"
                  target="_blank"
                  rel="noreferrer"
                  className="btn btn-secondary"
                >
                  Generate Token <ExternalLink size={13} />
                </a>
              </div>
            </form>
          </div>

          <div className="detail-card">
            <h3 className="detail-card-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Github size={15} /> Connect with GitHub OAuth
            </h3>
            {status?.oauthConfigured ? (
              <>
                <p className="detail-hint" style={{ marginBottom: '16px' }}>
                  Authorize PaaSbyDeep via your configured GitHub OAuth App to list repositories and deploy private repos.
                </p>
                <button className="btn btn-primary" onClick={handleOAuthConnect}>
                  <Github size={15} /> Authorize with GitHub
                </button>
              </>
            ) : (
              <>
                <p className="detail-hint" style={{ marginBottom: '10px' }}>
                  Optional: to enable 1-click OAuth login, create a GitHub OAuth App and set these variables in{' '}
                  <code>Backend/.env</code>:
                </p>
                <code className="webhook-url" style={{ fontSize: '11px' }}>
                  GITHUB_CLIENT_ID=...{'\n'}
                  GITHUB_CLIENT_SECRET=...{'\n'}
                  Callback URL: {status?.callbackUrl}
                </code>
              </>
            )}
          </div>
        </div>
      )}

      {status?.connected && (
        <div className="section">
          <div className="page-header" style={{ marginBottom: '12px' }}>
            <h3 className="section-title" style={{ marginBottom: 0 }}>
              {repoScope === 'deployed' ? 'Deployed Through PaaSbyDeep' : 'All GitHub Repositories'} ({filteredRepos.length})
            </h3>
            <div className="github-repo-controls">
              <div className="repo-filter-pills" role="group" aria-label="Repository deployment filter">
                <button
                  type="button"
                  className={`repo-filter-pill ${repoScope === 'deployed' ? 'repo-filter-pill--active' : ''}`}
                  onClick={() => setRepoScope('deployed')}
                >
                  Deployed Here ({deployedRepos.length})
                </button>
                <button
                  type="button"
                  className={`repo-filter-pill ${repoScope === 'all' ? 'repo-filter-pill--active' : ''}`}
                  onClick={() => setRepoScope('all')}
                >
                  All GitHub ({repos.length})
                </button>
              </div>
              <RepoVisibilityFilter repos={scopedRepos} value={visibility} onChange={setVisibility} />
              <div className="github-search-wrap">
                <Search size={14} className="github-search-icon" />
                <input
                  type="text"
                  className="form-input github-search-input"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter by name, branch, description…"
                />
                {search && (
                  <button
                    type="button"
                    className="github-search-clear"
                    title="Clear search"
                    onClick={() => setSearch('')}
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            </div>
          </div>

          {reposLoading && repos.length === 0 ? (
            <div className="loading-state">Loading repositories…</div>
          ) : filteredRepos.length === 0 ? (
            <div className="empty-state-sm">
              {repoScope === 'deployed' && deployedRepos.length === 0 ? (
                <div className="github-empty-deployed">
                  <span>No GitHub repositories have been deployed through this platform yet.</span>
                  <div className="action-btns" style={{ justifyContent: 'center', marginTop: '10px' }}>
                    {repos.length > 0 && (
                      <button
                        type="button"
                        className="btn btn-sm btn-secondary"
                        onClick={() => setRepoScope('all')}
                      >
                        Browse All GitHub Repos ({repos.length})
                      </button>
                    )}
                    <Link to="/apps/new" className="btn btn-sm btn-primary">
                      <Rocket size={13} /> Deploy Application
                    </Link>
                  </div>
                </div>
              ) : (
                'No matching repositories found.'
              )}
            </div>
          ) : (
            <div className="github-repo-list">
              {filteredRepos.map((repo) => {
                const linkedApps = deployedBySlug.get(repo.full_name.toLowerCase()) || [];
                const primaryApp = linkedApps[0] || null;
                return (
                  <div key={repo.id} className="github-repo-row">
                    <div className="github-repo-info">
                      <div className="github-repo-title">
                        <span className="github-repo-name">{repo.full_name}</span>
                        <span className={`repo-visibility ${repo.private ? 'repo-visibility--private' : ''}`}>
                          {repo.private ? <><Lock size={11} /> Private</> : <><Globe size={11} /> Public</>}
                        </span>
                        <span className="repo-branch-pill">{repo.default_branch}</span>
                      </div>
                      {repo.description && <p className="github-repo-desc">{repo.description}</p>}
                      {linkedApps.length > 0 && (
                        <div className="github-repo-apps">
                          {linkedApps.map((app) => (
                            <Link key={app.id} to={`/apps/${app.id}`} className="github-repo-app-chip">
                              <span>{app.name}</span>
                              <span className="form-hint">:{app.port}</span>
                              <StatusBadge status={app.status} />
                            </Link>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="action-btns">
                      {primaryApp ? (
                        <>
                          <button
                            className="btn btn-sm btn-primary"
                            onClick={() => handleRedeployApp(primaryApp.id)}
                            disabled={deployingAppId === primaryApp.id}
                          >
                            <Play size={13} /> {deployingAppId === primaryApp.id ? 'Deploying…' : 'Redeploy'}
                          </button>
                          <Link to={`/apps/${primaryApp.id}`} className="btn btn-sm btn-secondary">
                            Open App <ArrowUpRight size={13} />
                          </Link>
                        </>
                      ) : (
                        <button
                          className="btn btn-sm btn-primary"
                          onClick={() => handleDeployRepo(repo)}
                        >
                          <Rocket size={13} /> Deploy
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default GitHubConnect;
