import { Sun, Moon } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';

function ThemeToggle({ className = '' }) {
  const { isLight, toggleTheme } = useTheme();
  const label = isLight ? 'Switch to dark mode' : 'Switch to light mode';

  return (
    <button
      type="button"
      className={`theme-toggle-btn ${className}`.trim()}
      onClick={toggleTheme}
      title={label}
      aria-label={label}
      aria-pressed={isLight}
    >
      {isLight ? <Moon size={18} /> : <Sun size={18} />}
    </button>
  );
}

export default ThemeToggle;
