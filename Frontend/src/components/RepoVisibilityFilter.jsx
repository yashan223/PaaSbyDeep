import { countRepoVisibility } from '../utils/repoFilter';

/**
 * Segmented filter pills for All / Public / Private GitHub repositories.
 */
function RepoVisibilityFilter({ repos, value, onChange }) {
  const { totalCount, publicCount, privateCount } = countRepoVisibility(repos);
  const options = [
    { key: 'all', label: `All (${totalCount})` },
    { key: 'public', label: `Public (${publicCount})` },
    { key: 'private', label: `Private (${privateCount})` },
  ];

  return (
    <div className="repo-filter-pills" role="group" aria-label="Repository visibility filter">
      {options.map((opt) => (
        <button
          key={opt.key}
          type="button"
          className={`repo-filter-pill ${value === opt.key ? 'repo-filter-pill--active' : ''}`}
          onClick={() => onChange(opt.key)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export default RepoVisibilityFilter;
