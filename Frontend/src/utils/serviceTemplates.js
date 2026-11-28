export const PREFERRED_SERVICE_ORDER = ['postgres', 'mongodb', 'minio', 'redis', 'mysql'];

export const DEFAULT_SERVICE_TEMPLATES = {
  postgres: { label: 'PostgreSQL', version: '16-alpine', defaultPort: 5432, defaultDatabase: 'appdb' },
  mongodb: { label: 'MongoDB', version: '7', defaultPort: 27017, defaultDatabase: 'appdb' },
  minio: {
    label: 'MinIO (S3 Storage)',
    version: 'latest',
    defaultPort: 9000,
    defaultConsolePort: 9001,
    defaultDatabase: '',
  },
  redis: { label: 'Redis', version: '7-alpine', defaultPort: 6379, defaultDatabase: '' },
  mysql: { label: 'MySQL', version: '8.4', defaultPort: 3306, defaultDatabase: 'appdb' },
};

export function sortServiceTemplates(tpls) {
  return Object.entries(tpls || {}).sort(([a], [b]) => {
    const ia = PREFERRED_SERVICE_ORDER.indexOf(a);
    const ib = PREFERRED_SERVICE_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}
