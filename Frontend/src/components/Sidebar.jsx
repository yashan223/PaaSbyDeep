import { NavLink, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Box, Globe, Terminal, Github, Users, Settings, LogOut } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useState, useEffect } from 'react';
import { getGithubStatus } from '../api/github';
import { getSettings } from '../api/settings';

function Sidebar() {
  const { logout, user } = useAuth();
  const navigate = useNavigate();
  const [ghConnected, setGhConnected] = useState(false);
  const [platformName, setPlatformName] = useState('PaaSbyDeep');

  useEffect(() => {
    const refresh = () => {
      getGithubStatus()
        .then((d) => setGhConnected(Boolean(d.connected)))
        .catch(() => {});
    };
    refresh();
    getSettings()
      .then((res) => {
        if (res?.settings?.platform_name) setPlatformName(res.settings.platform_name);
      })
      .catch(() => {});

    const onSettingsChanged = (e) => {
      if (e.detail?.platform_name) setPlatformName(e.detail.platform_name);
    };

    window.addEventListener('github-connection-changed', refresh);
    window.addEventListener('platform-settings-changed', onSettingsChanged);
    return () => {
      window.removeEventListener('github-connection-changed', refresh);
      window.removeEventListener('platform-settings-changed', onSettingsChanged);
    };
  }, []);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <img src="/logo.png" alt={platformName} className="sidebar-logo-img" />
        <span className="sidebar-logo-text">{platformName}</span>
      </div>

      <nav className="sidebar-nav">
        <NavLink
          to="/"
          end
          className={({ isActive }) => `sidebar-link${isActive ? ' sidebar-link--active' : ''}`}
        >
          <LayoutDashboard size={16} />
          <span>Dashboard</span>
        </NavLink>
        <NavLink
          to="/apps"
          className={({ isActive }) => `sidebar-link${isActive ? ' sidebar-link--active' : ''}`}
        >
          <Box size={16} />
          <span>Applications</span>
        </NavLink>
        <NavLink
          to="/domains"
          className={({ isActive }) => `sidebar-link${isActive ? ' sidebar-link--active' : ''}`}
        >
          <Globe size={16} />
          <span>Domains &amp; SSL</span>
        </NavLink>
        <NavLink
          to="/logs"
          className={({ isActive }) => `sidebar-link${isActive ? ' sidebar-link--active' : ''}`}
        >
          <Terminal size={16} />
          <span>Live Logs</span>
        </NavLink>
        <NavLink
          to="/github"
          className={({ isActive }) => `sidebar-link${isActive ? ' sidebar-link--active' : ''}`}
        >
          <Github size={16} />
          <span>GitHub</span>
          {ghConnected && <span className="sidebar-dot-connected" title="Connected" />}
        </NavLink>
        {(user?.role || 'admin') === 'admin' && (
          <NavLink
            to="/users"
            className={({ isActive }) => `sidebar-link${isActive ? ' sidebar-link--active' : ''}`}
          >
            <Users size={16} />
            <span>Users</span>
          </NavLink>
        )}
        <NavLink
          to="/settings"
          className={({ isActive }) => `sidebar-link${isActive ? ' sidebar-link--active' : ''}`}
        >
          <Settings size={16} />
          <span>Settings</span>
        </NavLink>
      </nav>

      <div className="sidebar-bottom">
        <div className="sidebar-user">
          <span className="sidebar-user-name">
            {user?.username || user?.name || 'Admin'}
            {user?.role && <span className="sidebar-user-role">{user.role}</span>}
          </span>
          <button className="sidebar-logout" onClick={handleLogout} title="Logout">
            <LogOut size={15} />
          </button>
        </div>
      </div>
    </aside>
  );
}

export default Sidebar;
