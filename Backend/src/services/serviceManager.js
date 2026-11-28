import crypto from 'node:crypto';
import { getDb } from '../db/database.js';
import { encryptSecret, decryptSecret } from '../utils/crypto.js';
import { sanitizeName, sanitizePort } from '../utils/sanitize.js';
import { broadcast } from './ws.js';
import {
  docker,
  demuxDockerLogBuffer,
  ensureDockerNetwork,
  SHARED_DOCKER_NETWORK,
} from './docker.js';
import { getServerPublicIps } from './domainManager.js';

export const SERVICE_TEMPLATES = {
  postgres: {
    label: 'PostgreSQL',
    image: 'postgres:16-alpine',
    version: '16-alpine',
    defaultPort: 5432,
    containerPort: 5432,
    dataPath: '/var/lib/postgresql/data',
    defaultUsername: 'paas',
    defaultDatabase: 'appdb',
    envKey: 'DATABASE_URL',
  },
  redis: {
    label: 'Redis',
    image: 'redis:7-alpine',
    version: '7-alpine',
    defaultPort: 6379,
    containerPort: 6379,
    dataPath: '/data',
    defaultUsername: '',
    defaultDatabase: '',
    envKey: 'REDIS_URL',
  },
  mysql: {
    label: 'MySQL',
    image: 'mysql:8.4',
    version: '8.4',
    defaultPort: 3306,
    containerPort: 3306,
    dataPath: '/var/lib/mysql',
    defaultUsername: 'paas',
    defaultDatabase: 'appdb',
    envKey: 'DATABASE_URL',
  },
  mongodb: {
    label: 'MongoDB',
    image: 'mongo:7',
    version: '7',
    defaultPort: 27017,
    containerPort: 27017,
    dataPath: '/data/db',
    defaultUsername: 'paas',
    defaultDatabase: 'appdb',
    envKey: 'MONGODB_URI',
  },
};

function generatePassword(length = 24) {
  return crypto.randomBytes(Math.ceil((length * 3) / 4)).toString('base64url').slice(0, length);
}

function pullImage(imageName) {
  return new Promise((resolve, reject) => {
    docker.pull(imageName, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (progressErr) => {
        if (progressErr) return reject(progressErr);
        resolve();
      });
    });
  });
}

async function ensureImagePresent(imageName) {
  try {
    await docker.getImage(imageName).inspect();
  } catch {
    await pullImage(imageName);
  }
}

function getContainerName(service) {
  return `paasbydeeep-svc-${sanitizeName(service.name)}`;
}

async function findServiceContainer(service) {
  const cname = getContainerName(service);
  if (service.container_id) {
    try {
      const c = docker.getContainer(service.container_id);
      const info = await c.inspect();
      return { container: c, info, containerName: cname };
    } catch (err) {
      if (err.statusCode !== 404) throw err;
    }
  }
  try {
    const c = docker.getContainer(cname);
    const info = await c.inspect();
    return { container: c, info, containerName: cname };
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

function buildContainerEnv(type, username, password, databaseName) {
  if (type === 'postgres') {
    return [
      `POSTGRES_USER=${username || 'paas'}`,
      `POSTGRES_PASSWORD=${password}`,
      `POSTGRES_DB=${databaseName || 'appdb'}`,
    ];
  }
  if (type === 'mysql') {
    return [
      `MYSQL_ROOT_PASSWORD=${password}`,
      `MYSQL_USER=${username || 'paas'}`,
      `MYSQL_PASSWORD=${password}`,
      `MYSQL_DATABASE=${databaseName || 'appdb'}`,
    ];
  }
  if (type === 'mongodb') {
    return [
      `MONGO_INITDB_ROOT_USERNAME=${username || 'paas'}`,
      `MONGO_INITDB_ROOT_PASSWORD=${password}`,
      `MONGO_INITDB_DATABASE=${databaseName || 'appdb'}`,
    ];
  }
  return [];
}

function buildContainerCmd(type, password) {
  if (type === 'redis' && password) {
    return ['redis-server', '--appendonly', 'yes', '--requirepass', password];
  }
  return undefined;
}

export function buildConnectionString(service, host, port, { maskSecret = false } = {}) {
  const tpl = SERVICE_TEMPLATES[service.service_type];
  if (!tpl) return '';
  const rawPass = decryptSecret(service.password) || '';
  const encPass = maskSecret ? '••••••••' : encodeURIComponent(rawPass);
  const encUser = encodeURIComponent(service.username || tpl.defaultUsername || '');
  const db = encodeURIComponent(service.database_name || tpl.defaultDatabase || '');

  if (service.service_type === 'postgres') {
    return `postgresql://${encUser}:${encPass}@${host}:${port}/${db}`;
  }
  if (service.service_type === 'mysql') {
    return `mysql://${encUser}:${encPass}@${host}:${port}/${db}`;
  }
  if (service.service_type === 'redis') {
    return `redis://:${encPass}@${host}:${port}`;
  }
  if (service.service_type === 'mongodb') {
    return `mongodb://${encUser}:${encPass}@${host}:${port}/${db}?authSource=admin`;
  }
  return '';
}

export function serializeService(service, publicHost = 'localhost', role = 'admin') {
  const tpl = SERVICE_TEMPLATES[service.service_type] || {};
  const isViewer = role === 'viewer';
  const containerHost = getContainerName(service);
  const { password, ...rest } = service;
  void password;

  return {
    ...rest,
    suggested_env_key: tpl.envKey || 'SERVICE_URL',
    container_hostname: containerHost,
    internal_url: buildConnectionString(service, containerHost, tpl.containerPort || service.port, {
      maskSecret: isViewer,
    }),
    external_url: buildConnectionString(service, publicHost, service.port, {
      maskSecret: isViewer,
    }),
  };
}

async function allocateServicePort(sql, requestedPort, defaultPort) {
  if (requestedPort !== undefined && requestedPort !== null && requestedPort !== '') {
    const safe = sanitizePort(requestedPort);
    if (!safe) throw new Error('Port must be between 1024 and 65535.');
    const svcClash = await sql`SELECT id FROM managed_services WHERE port = ${safe}`;
    const appClash = await sql`SELECT id FROM applications WHERE port = ${safe}`;
    if (svcClash.length > 0 || appClash.length > 0) {
      throw new Error(`Port ${safe} is already assigned to another service or application.`);
    }
    return safe;
  }

  const usedRows = await sql`
    SELECT port FROM managed_services
    UNION
    SELECT port FROM applications
  `;
  const used = new Set(usedRows.map((r) => Number(r.port)));
  let candidate = defaultPort;
  while (used.has(candidate) && candidate < 65000) {
    candidate += 1;
  }
  return candidate;
}

async function createAndStartServiceContainer(service, plainPassword) {
  const tpl = SERVICE_TEMPLATES[service.service_type];
  if (!tpl) throw new Error(`Unsupported service type '${service.service_type}'.`);

  await ensureImagePresent(tpl.image);
  const networkReady = await ensureDockerNetwork();
  const cname = getContainerName(service);

  const existing = await findServiceContainer(service);
  if (existing) {
    try {
      if (existing.info.State?.Running) await existing.container.stop({ t: 10 });
      await existing.container.remove({ force: true });
    } catch {
    }
  }

  const portKey = `${tpl.containerPort}/tcp`;
  const env = buildContainerEnv(
    service.service_type,
    service.username,
    plainPassword,
    service.database_name
  );
  const cmd = buildContainerCmd(service.service_type, plainPassword);
  const memBytes = Math.max(128, Number(service.memory_limit_mb) || 512) * 1024 * 1024;

  const createOptions = {
    name: cname,
    Image: tpl.image,
    Env: env,
    ExposedPorts: { [portKey]: {} },
    HostConfig: {
      PortBindings: { [portKey]: [{ HostPort: String(service.port) }] },
      Binds: [`${service.volume_name}:${tpl.dataPath}`],
      RestartPolicy: { Name: 'unless-stopped' },
      Memory: memBytes,
      SecurityOpt: ['no-new-privileges:true'],
    },
  };
  if (cmd) createOptions.Cmd = cmd;
  if (networkReady) {
    createOptions.NetworkingConfig = { EndpointsConfig: { [SHARED_DOCKER_NETWORK]: {} } };
  }

  const container = await docker.createContainer(createOptions);
  await container.start();
  const info = await container.inspect();
  return info.Id;
}

export async function listManagedServices(role = 'admin') {
  const sql = getDb();
  const [rows, ips] = await Promise.all([
    sql`SELECT * FROM managed_services ORDER BY created_at DESC`,
    getServerPublicIps().catch(() => ({ publicIpv4: null, localIpv4: 'localhost' })),
  ]);
  const publicHost = ips.publicIpv4 || ips.localIpv4 || 'localhost';

  // Refresh live container status safely in parallel
  const hydrated = await Promise.all(rows.map(async (row) => {
    let status = row.status;
    try {
      const found = await findServiceContainer(row);
      if (found) {
        status = found.info.State?.Running ? 'running' : 'stopped';
        if (status !== row.status) {
          await sql`UPDATE managed_services SET status = ${status}, updated_at = NOW() WHERE id = ${row.id}`;
        }
      }
    } catch {
    }
    return serializeService({ ...row, status }, publicHost, role);
  }));
  return hydrated;
}

export async function createManagedService({
  name,
  serviceType,
  port,
  databaseName,
  memoryLimitMb = 512,
  autoStart = true,
}, role = 'admin') {
  const safeType = String(serviceType || '').trim().toLowerCase();
  const tpl = SERVICE_TEMPLATES[safeType];
  if (!tpl) {
    throw new Error(`Unsupported service type. Allowed: ${Object.keys(SERVICE_TEMPLATES).join(', ')}`);
  }

  const safeName = sanitizeName(String(name || ''));
  if (!safeName) {
    throw new Error('Service name must contain lowercase letters, numbers, and dashes only.');
  }

  const memMb = Number.parseInt(memoryLimitMb ?? 512, 10);
  if (!Number.isInteger(memMb) || memMb < 128 || memMb > 16384) {
    throw new Error('Memory limit must be between 128 and 16384 MB.');
  }

  const sql = getDb();
  const assignedPort = await allocateServicePort(sql, port, tpl.defaultPort);
  const plainPassword = generatePassword(24);
  const encryptedPassword = encryptSecret(plainPassword);
  const volumeName = `paasbydeeep-svc-vol-${safeName}`;
  const cleanDbName = safeType === 'redis'
    ? ''
    : String(databaseName || tpl.defaultDatabase).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 40) || tpl.defaultDatabase;

  const rows = await sql`
    INSERT INTO managed_services (
      name, service_type, version, port, username, password, database_name, volume_name, status, memory_limit_mb
    )
    VALUES (
      ${safeName}, ${safeType}, ${tpl.version}, ${assignedPort},
      ${tpl.defaultUsername}, ${encryptedPassword}, ${cleanDbName},
      ${volumeName}, ${autoStart ? 'starting' : 'stopped'}, ${memMb}
    )
    RETURNING *
  `;
  let record = rows[0];
  let startError = null;

  if (autoStart) {
    try {
      const containerId = await createAndStartServiceContainer(record, plainPassword);
      const updated = await sql`
        UPDATE managed_services
        SET container_id = ${containerId}, status = 'running', updated_at = NOW()
        WHERE id = ${record.id}
        RETURNING *
      `;
      record = updated[0];
    } catch (err) {
      startError = err.message;
      const errRows = await sql`
        UPDATE managed_services SET status = 'error', updated_at = NOW()
        WHERE id = ${record.id}
        RETURNING *
      `;
      record = errRows[0];
    }
  }

  const ips = await getServerPublicIps().catch(() => ({ publicIpv4: null, localIpv4: 'localhost' }));
  const publicHost = ips.publicIpv4 || ips.localIpv4 || 'localhost';
  broadcast({ type: 'services:changed', action: 'created', serviceId: record.id });
  return {
    service: serializeService(record, publicHost, role),
    startError,
  };
}

export async function controlManagedService(id, action, role = 'admin') {
  const sql = getDb();
  const rows = await sql`SELECT * FROM managed_services WHERE id = ${id}`;
  if (!rows[0]) throw new Error('Managed service not found.');
  let service = rows[0];
  const plainPassword = decryptSecret(service.password) || '';

  if (action === 'start') {
    const found = await findServiceContainer(service);
    let containerId = service.container_id;
    if (found) {
      if (!found.info.State?.Running) await found.container.start();
      containerId = found.info.Id;
    } else {
      containerId = await createAndStartServiceContainer(service, plainPassword);
    }
    const upd = await sql`
      UPDATE managed_services SET status = 'running', container_id = ${containerId}, updated_at = NOW()
      WHERE id = ${id} RETURNING *
    `;
    service = upd[0];
  } else if (action === 'stop') {
    const found = await findServiceContainer(service);
    if (found && found.info.State?.Running) {
      await found.container.stop({ t: 10 });
    }
    const upd = await sql`
      UPDATE managed_services SET status = 'stopped', updated_at = NOW()
      WHERE id = ${id} RETURNING *
    `;
    service = upd[0];
  } else if (action === 'restart') {
    const found = await findServiceContainer(service);
    if (found) {
      await found.container.restart();
    } else {
      const containerId = await createAndStartServiceContainer(service, plainPassword);
      service = (await sql`
        UPDATE managed_services SET container_id = ${containerId}, updated_at = NOW()
        WHERE id = ${id} RETURNING *
      `)[0];
    }
    const upd = await sql`
      UPDATE managed_services SET status = 'running', updated_at = NOW()
      WHERE id = ${id} RETURNING *
    `;
    service = upd[0];
  } else {
    throw new Error('Invalid service action.');
  }

  const ips = await getServerPublicIps().catch(() => ({ publicIpv4: null, localIpv4: 'localhost' }));
  const publicHost = ips.publicIpv4 || ips.localIpv4 || 'localhost';
  broadcast({ type: 'services:changed', action, serviceId: service.id });
  return serializeService(service, publicHost, role);
}

export async function getManagedServiceLogs(id, tail = 200) {
  const sql = getDb();
  const rows = await sql`SELECT * FROM managed_services WHERE id = ${id}`;
  if (!rows[0]) throw new Error('Managed service not found.');

  const found = await findServiceContainer(rows[0]);
  if (!found) {
    return { available: false, running: false, logs: '', reason: 'Container has not been created yet.' };
  }
  const buf = await found.container.logs({
    stdout: true,
    stderr: true,
    tail: Math.min(Math.max(Number(tail) || 200, 10), 1000),
    timestamps: true,
    follow: false,
  });
  return {
    available: true,
    running: Boolean(found.info.State?.Running),
    containerName: found.containerName,
    logs: demuxDockerLogBuffer(buf, Boolean(found.info.Config?.Tty)),
  };
}

export async function deleteManagedService(id, removeVolume = false) {
  const sql = getDb();
  const rows = await sql`SELECT * FROM managed_services WHERE id = ${id}`;
  if (!rows[0]) throw new Error('Managed service not found.');
  const service = rows[0];

  const found = await findServiceContainer(service);
  if (found) {
    try {
      if (found.info.State?.Running) await found.container.stop({ t: 10 });
      await found.container.remove({ force: true });
    } catch {
    }
  }

  if (removeVolume && service.volume_name) {
    try {
      await docker.getVolume(service.volume_name).remove();
    } catch {
    }
  }

  await sql`DELETE FROM managed_services WHERE id = ${id}`;
  broadcast({ type: 'services:changed', action: 'deleted', serviceId: service.id });
  return service;
}
