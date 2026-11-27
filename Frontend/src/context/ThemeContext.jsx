import { createContext, useContext, useState, useCallback, useEffect } from 'react';

const THEME_STORAGE_KEY = 'paas_theme';

function readStoredTheme() {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'dark';
  } catch {
    return 'dark';
  }
}

function applyThemeToDocument(theme) {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

// Apply stored theme synchronously at module load so dark/light switches don't flash before first mount.
applyThemeToDocument(readStoredTheme());

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(readStoredTheme);

  const setTheme = useCallback((nextTheme) => {
    const resolved = nextTheme === 'light' ? 'light' : 'dark';
    try {
      localStorage.setItem(THEME_STORAGE_KEY, resolved);
    } catch {
      // Ignore storage failures in restricted browser contexts.
    }
    applyThemeToDocument(resolved);
    setThemeState(resolved);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => {
      const next = prev === 'light' ? 'dark' : 'light';
      try {
        localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // Ignore storage failures in restricted browser contexts.
      }
      applyThemeToDocument(next);
      return next;
    });
  }, []);

  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, isLight: theme === 'light', setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
