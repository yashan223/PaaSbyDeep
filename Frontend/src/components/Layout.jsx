import { useState, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Menu } from 'lucide-react';
import Sidebar from './Sidebar';
import ThemeToggle from './ThemeToggle';

const pageTitles = {
  '/': 'Dashboard',
  '/apps': 'Applications',
  '/apps/new': 'Add Application',
  '/domains': 'Domains & SSL',
  '/services': 'Managed Services',
  '/logs': 'Live Logs',
  '/github': 'GitHub Integration',
  '/users': 'User Management',
  '/audit': 'Audit Trail',
  '/settings': 'Management Settings',
};

function getTitle(pathname) {
  if (pageTitles[pathname]) return pageTitles[pathname];
  if (pathname.endsWith('/edit')) return 'Edit Application';
  if (/^\/apps\/[^/]+$/.test(pathname)) return 'Application Detail';
  return 'PaaSbyDeep';
}

function Layout() {
  const location = useLocation();
  const title = getTitle(location.pathname);
  const [openMenuPath, setOpenMenuPath] = useState(null);
  const mobileNavOpen = openMenuPath === location.pathname;

  useEffect(() => {
    if (!mobileNavOpen) return undefined;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setOpenMenuPath(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileNavOpen]);

  return (
    <div className="layout">
      <Sidebar isOpen={mobileNavOpen} onClose={() => setOpenMenuPath(null)} />
      <div className="layout-main">
        <header className="layout-header">
          <div className="layout-header-left">
            <button
              type="button"
              className="mobile-menu-btn"
              onClick={() => setOpenMenuPath((p) => (p === location.pathname ? null : location.pathname))}
              aria-label="Open navigation menu"
              aria-expanded={mobileNavOpen}
            >
              <Menu size={19} />
            </button>
            <h1 className="layout-title">{title}</h1>
          </div>
          <div className="layout-header-actions">
            <ThemeToggle />
          </div>
        </header>
        <main className="layout-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export default Layout;
