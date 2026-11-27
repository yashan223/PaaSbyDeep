import { useEffect, useState, useCallback } from 'react';
import { Users as UsersIcon, UserPlus, KeyRound, Trash2, Shield, Ban, CheckCircle, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import ConfirmModal from '../components/ConfirmModal';
import { getUsers, createUser, updateUser, deleteUser } from '../api/users';

function ResetPasswordModal({ targetUser, onClose, onSaved }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  if (!targetUser) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    setSaving(true);
    setError('');
    try {
      await updateUser(targetUser.id, { password });
      onSaved(`Password updated and active sessions revoked for '${targetUser.username}'.`);
      onClose();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to reset password.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <KeyRound size={16} /> Reset Password — {targetUser.username}
          </h3>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {error && <div className="alert alert-error" style={{ marginBottom: '12px' }}>{error}</div>}
            <div className="form-group">
              <label className="form-label" htmlFor="reset-pass">New Password</label>
              <input
                id="reset-pass"
                type="password"
                className="form-input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Min 8 characters"
                autoFocus
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label" htmlFor="reset-confirm">Confirm Password</label>
              <input
                id="reset-confirm"
                type="password"
                className="form-input"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Repeat new password"
              />
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Updating…' : 'Update Password'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Users() {
  const { user: currentUser } = useAuth();
  const isAdmin = (currentUser?.role || 'admin') === 'admin';
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(isAdmin);
  const [form, setForm] = useState({ username: '', password: '', role: 'operator' });
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [resetTarget, setResetTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const loadUsers = useCallback(async () => {
    try {
      const list = await getUsers();
      setUsers(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to load users.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return undefined;
    let active = true;
    getUsers()
      .then((list) => {
        if (active) setUsers(Array.isArray(list) ? list : []);
      })
      .catch((err) => {
        if (active) setError(err?.response?.data?.error || 'Failed to load users.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [isAdmin]);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!form.username.trim() || form.password.length < 8) {
      setError('Enter a valid username (3-40 chars) and password (min 8 characters).');
      return;
    }

    setCreating(true);
    setError('');
    setNotice('');
    try {
      const created = await createUser({
        username: form.username.trim(),
        password: form.password,
        role: form.role,
      });
      setForm({ username: '', password: '', role: 'operator' });
      setNotice(`User '${created.username}' (${created.role}) created.`);
      await loadUsers();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to create user.');
    } finally {
      setCreating(false);
    }
  };

  const handleRoleChange = async (u, nextRole) => {
    setBusyId(u.id);
    setError('');
    setNotice('');
    try {
      await updateUser(u.id, { role: nextRole });
      setNotice(`Updated '${u.username}' role to ${nextRole}.`);
      await loadUsers();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to update role.');
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleActive = async (u) => {
    setBusyId(u.id);
    setError('');
    setNotice('');
    try {
      const nextActive = !(u.is_active !== false);
      await updateUser(u.id, { is_active: nextActive });
      setNotice(`User '${u.username}' ${nextActive ? 'enabled' : 'disabled'}.`);
      await loadUsers();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to update user status.');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    setError('');
    setNotice('');
    try {
      await deleteUser(target.id);
      setNotice(`Deleted user '${target.username}'.`);
      await loadUsers();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to delete user.');
    }
  };

  if (!isAdmin) {
    return (
      <div className="page">
        <div className="alert alert-error">
          Administrator privileges are required to manage users.
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <h2 className="page-heading" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <UsersIcon size={18} /> User Management
        </h2>
      </div>

      <div className="domain-env-bar">
        <div className="domain-env-item">
          <Shield size={13} style={{ color: '#58a6ff' }} />
          <span className="domain-env-note">
            <strong>Admin:</strong> Full platform &amp; user control · <strong>Operator:</strong> Deploy apps, domains &amp; SSL · <strong>Viewer:</strong> Read-only access (secrets masked)
          </span>
        </div>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: '16px' }}>{error}</div>}
      {notice && <div className="alert alert-success" style={{ marginBottom: '16px' }}>{notice}</div>}

      <div className="detail-card" style={{ marginBottom: '24px' }}>
        <h3 className="detail-card-title">Add User Account</h3>
        <form className="domain-add-form" onSubmit={handleCreate}>
          <div className="domain-add-field">
            <label className="form-label" htmlFor="new-username">Username</label>
            <input
              id="new-username"
              type="text"
              className="form-input"
              value={form.username}
              onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
              autoComplete="off"
            />
          </div>
          <div className="domain-add-field domain-add-field--wide">
            <label className="form-label" htmlFor="new-password">Password</label>
            <input
              id="new-password"
              type="password"
              className="form-input"
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              placeholder="Min 8 characters"
              autoComplete="new-password"
            />
          </div>
          <div className="domain-add-field">
            <label className="form-label" htmlFor="new-role">Role</label>
            <select
              id="new-role"
              className="form-input"
              value={form.role}
              onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
            >
              <option value="operator">Operator</option>
              <option value="admin">Admin</option>
              <option value="viewer">Viewer</option>
            </select>
          </div>
          <div className="domain-add-submit">
            <button type="submit" className="btn btn-primary" disabled={creating}>
              <UserPlus size={14} /> {creating ? 'Creating…' : 'Create User'}
            </button>
          </div>
        </form>
      </div>

      <div className="section" style={{ marginTop: 0 }}>
        <h3 className="section-title">Accounts ({users.length})</h3>
        {loading ? (
          <div className="loading-state">Loading users…</div>
        ) : (
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Last Login</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const isSelf = Number(u.id) === Number(currentUser?.id) || u.username === currentUser?.username;
                  const active = u.is_active !== false;
                  return (
                    <tr key={u.id}>
                      <td>
                        <strong>{u.username}</strong>
                        {isSelf && <span className="project-type-pill" style={{ marginLeft: '8px' }}>you</span>}
                      </td>
                      <td>
                        {isSelf ? (
                          <span className="project-type-pill">{u.role || 'admin'}</span>
                        ) : (
                          <select
                            className="form-input user-role-select"
                            value={u.role || 'admin'}
                            disabled={busyId === u.id}
                            onChange={(e) => handleRoleChange(u, e.target.value)}
                            aria-label={`Role for ${u.username}`}
                          >
                            <option value="admin">admin</option>
                            <option value="operator">operator</option>
                            <option value="viewer">viewer</option>
                          </select>
                        )}
                      </td>
                      <td>
                        <span className={`status-badge ${active ? 'status-badge--running' : 'status-badge--failed'}`}>
                          {active ? 'Active' : 'Disabled'}
                        </span>
                      </td>
                      <td>{u.last_login_at ? new Date(u.last_login_at).toLocaleString() : 'Never'}</td>
                      <td>
                        <div className="action-btns">
                          <button
                            type="button"
                            className="btn btn-xs btn-secondary"
                            onClick={() => setResetTarget(u)}
                            disabled={busyId === u.id}
                          >
                            <KeyRound size={12} /> Password
                          </button>
                          {!isSelf && (
                            <>
                              <button
                                type="button"
                                className="btn btn-xs btn-secondary"
                                onClick={() => handleToggleActive(u)}
                                disabled={busyId === u.id}
                              >
                                {active ? <><Ban size={12} /> Disable</> : <><CheckCircle size={12} /> Enable</>}
                              </button>
                              <button
                                type="button"
                                className="btn btn-xs btn-danger"
                                onClick={() => setDeleteTarget(u)}
                                disabled={busyId === u.id}
                                title="Delete user"
                              >
                                <Trash2 size={12} />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ResetPasswordModal
        key={resetTarget?.id || 'none'}
        targetUser={resetTarget}
        onClose={() => setResetTarget(null)}
        onSaved={(msg) => {
          setNotice(msg);
          void loadUsers();
        }}
      />

      <ConfirmModal
        isOpen={Boolean(deleteTarget)}
        title="Delete User"
        message={`Delete user "${deleteTarget?.username}"? All active sessions for this user will stop working immediately.`}
        confirmLabel="Delete"
        danger
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

export default Users;
