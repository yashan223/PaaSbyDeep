import client from './client';

export const getSettings = () => client.get('/settings').then((r) => r.data);

export const updateSettings = (data) => client.put('/settings', data).then((r) => r.data);

export const updateAccount = (data) => client.put('/settings/account', data).then((r) => r.data);

export const getDashboardNginxConfig = (domain) =>
  client.get('/settings/dashboard-nginx-config', { params: { domain } }).then((r) => r.data);

export const installDashboardSsl = (data) =>
  client.post('/settings/dashboard-ssl', data).then((r) => r.data);

export const pruneDockerImages = () =>
  client.post('/settings/docker/prune').then((r) => r.data);

export const getDockerDiskUsage = () =>
  client.get('/settings/docker/df').then((r) => r.data);

export const testNotificationWebhook = (webhookUrl) =>
  client.post('/settings/notifications/test', { webhookUrl }).then((r) => r.data);

export const exportPlatformBackup = () =>
  client.get('/settings/backup').then((r) => r.data);

export const restorePlatformBackup = (manifest) =>
  client.post('/settings/backup/restore', manifest).then((r) => r.data);
