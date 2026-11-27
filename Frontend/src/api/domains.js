import client from './client';

export const getDomainSystemStatus = () => client.get('/domains/system').then((r) => r.data);

export const checkDomainDns = (domain) =>
  client.get('/domains/dns-check', { params: { domain } }).then((r) => r.data);

export const getDomains = () => client.get('/domains').then((r) => r.data);

export const getAppDomains = (appId) => client.get(`/domains/app/${appId}`).then((r) => r.data);

export const createDomain = (data) => client.post('/domains', data).then((r) => r.data);

export const getNginxConfig = (id) => client.get(`/domains/${id}/nginx-config`).then((r) => r.data);

export const syncNginxConfig = (id) => client.post(`/domains/${id}/nginx-sync`).then((r) => r.data);

export const installSsl = (id, data) => client.post(`/domains/${id}/ssl`, data).then((r) => r.data);

export const renewAllSsl = () => client.post('/domains/renew').then((r) => r.data);

export const deleteDomain = (id) => client.delete(`/domains/${id}`).then((r) => r.data);
