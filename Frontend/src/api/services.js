import client from './client';

export const getServiceTemplates = () => client.get('/services/templates').then((r) => r.data);

export const getServices = () => client.get('/services').then((r) => r.data);

export const createService = (data) => client.post('/services', data).then((r) => r.data);

export const controlService = (id, action) =>
  client.post(`/services/${id}/${action}`).then((r) => r.data);

export const setServiceAccess = (id, publicAccess) =>
  client.post(`/services/${id}/access`, { publicAccess }).then((r) => r.data);

export const changeServicePassword = (id, payload) =>
  client.post(`/services/${id}/password`, payload).then((r) => r.data);

export const getServiceLogs = (id, tail = 200) =>
  client.get(`/services/${id}/logs`, { params: { tail } }).then((r) => r.data);

export const attachServiceToApp = (id, appId, envKey, bucketName = '') =>
  client.post(`/services/${id}/attach`, {
    appId,
    envKey,
    bucketName: bucketName || undefined,
  }).then((r) => r.data);

export const listServiceBuckets = (id) =>
  client.get(`/services/${id}/buckets`).then((r) => r.data);

export const createServiceBucket = (id, payload) =>
  client.post(`/services/${id}/buckets`, payload).then((r) => r.data);

export const deleteServiceBucket = (id, bucketName) =>
  client.delete(`/services/${id}/buckets/${encodeURIComponent(bucketName)}`).then((r) => r.data);

export const deleteService = (id, removeVolume = false) =>
  client.delete(`/services/${id}`, { params: { removeVolume: String(removeVolume) } }).then((r) => r.data);
