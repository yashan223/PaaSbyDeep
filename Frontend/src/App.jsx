import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { WebSocketProvider } from './context/WebSocketContext';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import AppList from './pages/AppList';
import AppDetail from './pages/AppDetail';
import AddApp from './pages/AddApp';
import EditApp from './pages/EditApp';
import GitHubConnect from './pages/GitHubConnect';
import LiveLogs from './pages/LiveLogs';
import Domains from './pages/Domains';
import Users from './pages/Users';
import Settings from './pages/Settings';

function ProtectedRoute({ children }) {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? children : <Navigate to="/login" replace />;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="apps" element={<AppList />} />
        <Route path="apps/new" element={<AddApp />} />
        <Route path="apps/:id" element={<AppDetail />} />
        <Route path="apps/:id/edit" element={<EditApp />} />
        <Route path="domains" element={<Domains />} />
        <Route path="logs" element={<LiveLogs />} />
        <Route path="github" element={<GitHubConnect />} />
        <Route path="users" element={<Users />} />
        <Route path="settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          <WebSocketProvider>
            <AppRoutes />
          </WebSocketProvider>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  );
}

export default App;
