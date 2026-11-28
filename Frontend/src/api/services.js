import client from './client';

export const getServiceTemplates = () => client.get('/services/templates').then((r) => r.data);

export const getServices = () => client.get('/services').then((r) => r.data);

export const createService = (data) => client.post('/services', data).then((r) => r.data);

export const controlService = (id, action) =>
  client.post(`/services/${id}/${action}`).then((r) => r.data);

export const getServiceLogs = (id, tail = 200) =>
  client.get(`/services/${id}/logs`, { params: { tail } }).then((r) => r.data);

export const attachServiceToApp = (id, appId, envKey) =>
  client.post(`/services/${id}/attach`, { appId, envKey }).then((r) => r.data);

export const deleteService = (id, removeVolume = false) =>
  client.delete(`/services/${id}`, { params: { removeVolume: String(removeVolume) } }).then((r) => r.data);
