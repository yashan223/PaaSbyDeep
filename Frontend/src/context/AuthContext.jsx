import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { getMe } from '../api/auth';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem('paas_token'));
  const [user, setUser] = useState(() => {
    try {
      const stored = localStorage.getItem('paas_user');
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });

  const isAuthenticated = Boolean(token);

  const login = useCallback((newToken, newUser) => {
    localStorage.setItem('paas_token', newToken);
    localStorage.setItem('paas_user', JSON.stringify(newUser));
    setToken(newToken);
    setUser(newUser);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('paas_token');
    localStorage.removeItem('paas_user');
    setToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    if (!token) return undefined;
    let active = true;
    getMe()
      .then((me) => {
        if (!active || !me) return;
        const synced = { id: me.id, username: me.username, role: me.role || 'admin' };
        localStorage.setItem('paas_user', JSON.stringify(synced));
        setUser(synced);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [token]);

  return (
    <AuthContext.Provider value={{ token, user, isAuthenticated, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
