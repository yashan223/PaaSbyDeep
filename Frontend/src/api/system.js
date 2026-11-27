import client from './client';

export const getSystemStats = () => client.get('/system').then((r) => r.data);
