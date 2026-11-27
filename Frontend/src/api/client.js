import axios from 'axios';

const client = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:3001/api',
  headers: {
    'Content-Type': 'application/json',
  },
});

client.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('paas_token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

client.interceptors.response.use(
  (response) => response,
  (error) => {
    const reqUrl = error.config?.url || '';
    const isCredentialCheck = reqUrl.includes('/auth/login') || reqUrl.includes('/settings/account');
    if (error.response && error.response.status === 401 && !isCredentialCheck) {
      localStorage.removeItem('paas_token');
      localStorage.removeItem('paas_user');
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export default client;
