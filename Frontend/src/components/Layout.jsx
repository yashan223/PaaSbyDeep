import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import ThemeToggle from './ThemeToggle';

const pageTitles = {
  '/': 'Dashboard',
  '/apps': 'Applications',
  '/apps/new': 'Add Application',
  '/domains': 'Domains & SSL',
  '/logs': 'Live Logs',
  '/github': 'GitHub Integration',
  '/users': 'User Management',
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

  return (
    <div className="layout">
      <Sidebar />
      <div className="layout-main">
        <header className="layout-header">
          <h1 className="layout-title">{title}</h1>
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
