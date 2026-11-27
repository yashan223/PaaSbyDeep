import client from './client';

export const getGithubStatus = () =>
  client.get('/github/status').then((r) => r.data);

export const connectGithubPat = (token) =>
  client.post('/github/connect', { token }).then((r) => r.data);

export const getGithubOAuthUrl = () =>
  client.get('/github/oauth/url').then((r) => r.data);

export const disconnectGithub = () =>
  client.delete('/github/connection').then((r) => r.data);

export const getGithubRepos = () =>
  client.get('/github/repos').then((r) => r.data);

export const getRepoBranches = (owner, repo) =>
  client.get(`/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`).then((r) => r.data);

export const createGithubWebhook = (appId, publicUrl) =>
  client.post(`/github/apps/${appId}/webhook`, { publicUrl }).then((r) => r.data);

export const detectGithubProject = (repoUrl, branch = 'main', dockerfilePath = 'Dockerfile') =>
  client
    .get('/github/detect', {
      params: { repo_url: repoUrl, branch, dockerfile_path: dockerfilePath },
    })
    .then((r) => r.data);
