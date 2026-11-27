import client from './client';

export const getApps = () => client.get('/apps').then((r) => r.data);

export const getApp = (id) => client.get(`/apps/${id}`).then((r) => r.data);

export const createApp = (data) => client.post('/apps', data).then((r) => r.data);

export const updateApp = (id, data) => client.put(`/apps/${id}`, data).then((r) => r.data);

export const deleteApp = (id) => client.delete(`/apps/${id}`).then((r) => r.data);

export const deployApp = (id) => client.post(`/deploy/${id}/deploy`).then((r) => r.data);

export const restartApp = (id) => client.post(`/deploy/${id}/restart`).then((r) => r.data);

export const stopApp = (id) => client.post(`/deploy/${id}/stop`).then((r) => r.data);

export const getAppLogs = (id) => client.get(`/deploy/${id}/logs`).then((r) => r.data);

export const getRecentLogs = () => client.get('/deploy/recent-logs').then((r) => r.data);

export const getDeployments = (id) => client.get(`/deploy/${id}/deployments`).then((r) => r.data);
