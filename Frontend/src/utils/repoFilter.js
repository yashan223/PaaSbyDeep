/**
 * Extract normalized "owner/repo" slug from a github.com repository URL.
 */
export function extractGithubSlug(url) {
  if (!url || typeof url !== 'string') return null;
  const match = url.trim().match(/^https?:\/\/github\.com\/([^/\s]+\/[^/\s#?]+?)(?:\.git)?(?:\/.*)?$/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Group deployed applications by their lowercase GitHub "owner/repo" slug.
 */
export function groupAppsByGithubRepo(apps = []) {
  const map = new Map();
  for (const app of apps) {
    const slug = extractGithubSlug(app.repo_url || app.repoUrl || app.repository);
    if (!slug) continue;
    if (!map.has(slug)) map.set(slug, []);
    map.get(slug).push(app);
  }
  return map;
}

/**
 * Count public and private repositories in a list.
 */
export function countRepoVisibility(repos) {
  let publicCount = 0;
  let privateCount = 0;
  for (const repo of repos) {
    if (repo.private) privateCount += 1;
    else publicCount += 1;
  }
  return { totalCount: repos.length, publicCount, privateCount };
}

/**
 * Filter repositories by text query (name, description, default branch) and visibility.
 */
export function filterRepos(repos, query, visibility = 'all') {
  const q = String(query || '').trim().toLowerCase();
  return repos.filter((repo) => {
    if (visibility === 'public' && repo.private) return false;
    if (visibility === 'private' && !repo.private) return false;
    if (!q) return true;
    return (
      repo.full_name.toLowerCase().includes(q) ||
      (repo.description && repo.description.toLowerCase().includes(q)) ||
      (repo.default_branch && repo.default_branch.toLowerCase().includes(q))
    );
  });
}
