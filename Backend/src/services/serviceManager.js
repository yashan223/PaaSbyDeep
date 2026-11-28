import crypto from 'node:crypto';
import net from 'node:net';
import { getDb } from '../db/database.js';
import { encryptSecret, decryptSecret } from '../utils/crypto.js';
import { sanitizeName, sanitizePort } from '../utils/sanitize.js';
import { broadcast } from './ws.js';
import {
  docker,
  demuxDockerLogBuffer,
  ensureDockerNetwork,
  ensureContainerOnSharedNetwork,
  SHARED_DOCKER_NETWORK,
} from './docker.js';
import { getServerPublicIps, removeDomainNginxConfig } from './domainManager.js';
import {
  isValidBucketName,
  listMinioBuckets,
  createMinioBucket,
  deleteMinioBucket,
} from './minioS3.js';

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
  // Official minio/minio images were removed from Docker Hub; pgsty/silo is a drop-in S3 & Console compatible fork
  minio: {
    label: 'MinIO (S3 Storage)',
    image: 'pgsty/silo:latest',
    version: 'latest',
    defaultPort: 9000,
    containerPort: 9000,
    defaultConsolePort: 9001,
    dataPath: '/data',
    defaultUsername: 'paasadmin',
    defaultDatabase: '',
    envKey: 'S3_ENDPOINT',
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
};

function generatePassword(length = 24) {
  return crypto.randomBytes(Math.ceil((length * 3) / 4)).toString('base64url').slice(0, length);
}

function validateServicePassword(rawPassword) {
  const pass = String(rawPassword ?? '');
  if (!pass || pass.length < 8 || pass.length > 128) {
    throw new Error('Password must be between 8 and 128 characters.');
  }
  if (/[\r\n\0]/.test(pass)) {
    throw new Error('Password cannot contain newline or null characters.');
  }
  return pass;
}

async function runContainerExec(container, cmd, env = []) {
  const exec = await container.exec({
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    Env: env,
    Cmd: cmd,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  const chunks = [];
  await new Promise((resolve, reject) => {
    stream.on('data', (d) => chunks.push(d));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  const inspect = await exec.inspect();
  const output = demuxDockerLogBuffer(Buffer.concat(chunks), false).trim();
  if (inspect.ExitCode !== 0) {
    throw new Error(output || `Container command exited with code ${inspect.ExitCode}.`);
  }
  return output;
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
  if (type === 'minio') {
    return [
      `MINIO_ROOT_USER=${username || 'paasadmin'}`,
      `MINIO_ROOT_PASSWORD=${password}`,
    ];
  }
  return [];
}

function buildContainerCmd(type, password) {
  if (type === 'redis' && password) {
    return ['redis-server', '--appendonly', 'yes', '--requirepass', password];
  }
  if (type === 'minio') {
    return ['server', '/data', '--console-address', ':9001'];
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
  if (service.service_type === 'minio') {
    return `http://${host}:${port}`;
  }
  return '';
}

export function serializeService(service, publicHost = 'localhost', role = 'admin') {
  const tpl = SERVICE_TEMPLATES[service.service_type] || {};
  const isViewer = role === 'viewer';
  const publicAccess = Boolean(service.public_access);
  const containerHost = getContainerName(service);
  const externalHost = publicAccess ? publicHost : '127.0.0.1';
  const rawPass = decryptSecret(service.password) || '';
  const { password, ...rest } = service;
  void password;

  const consoleUrl = service.service_type === 'minio' && service.console_port
    ? `http://${externalHost}:${service.console_port}`
    : null;
  const tunnelPort = service.service_type === 'minio' && service.console_port
    ? service.console_port
    : service.port;

  return {
    ...rest,
    domains: Array.isArray(service.domains) ? service.domains : [],
    public_access: publicAccess,
    public_host: publicHost,
    console_url: consoleUrl,
    ssh_tunnel_cmd: !publicAccess && !isViewer
      ? `ssh -N -L ${tunnelPort}:127.0.0.1:${tunnelPort} root@${publicHost}`
      : '',
    access_key: service.service_type === 'minio' ? (isViewer ? '••••••••' : (service.username || 'paasadmin')) : undefined,
    secret_key: service.service_type === 'minio' ? (isViewer ? '••••••••' : rawPass) : undefined,
    suggested_env_key: tpl.envKey || 'SERVICE_URL',
    container_hostname: containerHost,
    internal_url: buildConnectionString(service, containerHost, tpl.containerPort || service.port, {
      maskSecret: isViewer,
    }),
    external_url: buildConnectionString(service, externalHost, service.port, {
      maskSecret: isViewer,
    }),
  };
}

function isHostPortAvailable(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host: '0.0.0.0', exclusive: true }, () => {
      srv.close(() => resolve(true));
    });
  });
}

async function allocateServicePort(sql, requestedPort, defaultPort, extraUsedPorts = []) {
  const extraSet = new Set(extraUsedPorts.map(Number));
  if (requestedPort !== undefined && requestedPort !== null && requestedPort !== '') {
    const safe = sanitizePort(requestedPort);
    if (!safe) throw new Error('Port must be between 1024 and 65535.');
    if (extraSet.has(safe)) throw new Error(`Port ${safe} conflicts with another assigned port.`);
    const svcClash = await sql`SELECT id FROM managed_services WHERE port = ${safe} OR console_port = ${safe}`;
    const appClash = await sql`SELECT id FROM applications WHERE port = ${safe}`;
    if (svcClash.length > 0 || appClash.length > 0) {
      throw new Error(`Port ${safe} is already assigned to another service or application.`);
    }
    if (!(await isHostPortAvailable(safe))) {
      throw new Error(`Host port ${safe} is already in use on this server.`);
    }
    return safe;
  }

  const usedRows = await sql`
    SELECT port FROM managed_services
    UNION
    SELECT console_port AS port FROM managed_services WHERE console_port IS NOT NULL
    UNION
    SELECT port FROM applications
  `;
  const used = new Set([...usedRows.map((r) => Number(r.port)), ...extraSet]);
  let candidate = defaultPort;
  while (candidate < 65000 && (used.has(candidate) || !(await isHostPortAvailable(candidate)))) {
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

  const hostIp = service.public_access ? '0.0.0.0' : '127.0.0.1';
  const portBindings = { [portKey]: [{ HostIp: hostIp, HostPort: String(service.port) }] };
  const exposedPorts = { [portKey]: {} };
  if (service.service_type === 'minio' && service.console_port) {
    const consoleKey = '9001/tcp';
    exposedPorts[consoleKey] = {};
    portBindings[consoleKey] = [{ HostIp: hostIp, HostPort: String(service.console_port) }];
  }

  const createOptions = {
    name: cname,
    Image: tpl.image,
    Env: env,
    ExposedPorts: exposedPorts,
    HostConfig: {
      PortBindings: portBindings,
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
  await new Promise((resolve) => setTimeout(resolve, 700));
  const info = await container.inspect();
  if (!info.State?.Running) {
    let tail = '';
    try {
      const buf = await container.logs({ stdout: true, stderr: true, tail: 25, follow: false });
      tail = demuxDockerLogBuffer(buf, Boolean(info.Config?.Tty)).trim();
    } catch {
    }
    throw new Error(
      tail
        ? `Container exited right after start (code ${info.State?.ExitCode}): ${tail.slice(0, 240)}`
        : `Container exited right after start with code ${info.State?.ExitCode ?? 'unknown'}.`
    );
  }
  return info.Id;
}

export async function listManagedServices(role = 'admin') {
  const sql = getDb();
  const [rows, domainRows, ips] = await Promise.all([
    sql`SELECT * FROM managed_services ORDER BY created_at DESC`,
    sql`SELECT id, service_id, domain, ssl_enabled, service_target FROM domains WHERE service_id IS NOT NULL ORDER BY created_at ASC`.catch(() => []),
    getServerPublicIps().catch(() => ({ publicIpv4: null, localIpv4: 'localhost' })),
  ]);
  const publicHost = ips.publicIpv4 || ips.localIpv4 || 'localhost';
  const domainsByService = new Map();
  for (const d of domainRows) {
    const arr = domainsByService.get(d.service_id) || [];
    arr.push(d);
    domainsByService.set(d.service_id, arr);
  }

  // Refresh live container status safely in parallel
  const hydrated = await Promise.all(rows.map(async (row) => {
    let status = row.status;
    let lastError = row.last_error || '';
    try {
      const found = await findServiceContainer(row);
      if (found) {
        const isRunning = Boolean(found.info.State?.Running);
        if (isRunning) {
          status = 'running';
          lastError = '';
        } else {
          const failedExit = row.status === 'error' && Number(found.info.State?.ExitCode || 0) !== 0;
          status = failedExit ? 'error' : 'stopped';
        }
        if (status !== row.status || lastError !== (row.last_error || '')) {
          await sql`
            UPDATE managed_services SET status = ${status}, last_error = ${lastError}, updated_at = NOW()
            WHERE id = ${row.id}
          `;
        }
      }
    } catch {
    }
    return serializeService(
      { ...row, status, last_error: lastError, domains: domainsByService.get(row.id) || [] },
      publicHost,
      role
    );
  }));
  return hydrated;
}

export async function createManagedService({
  name,
  serviceType,
  port,
  databaseName,
  password,
  memoryLimitMb = 512,
  publicAccess = false,
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

  const isPublic = Boolean(publicAccess);
  const plainPassword = password !== undefined && password !== null && String(password) !== ''
    ? validateServicePassword(password)
    : generatePassword(24);
  const sql = getDb();
  const assignedPort = await allocateServicePort(sql, port, tpl.defaultPort);
  const consolePort = tpl.defaultConsolePort
    ? await allocateServicePort(sql, null, tpl.defaultConsolePort, [assignedPort])
    : null;
  const encryptedPassword = encryptSecret(plainPassword);
  const volumeName = `paasbydeeep-svc-vol-${safeName}`;
  const cleanDbName = safeType === 'redis' || safeType === 'minio'
    ? ''
    : String(databaseName || tpl.defaultDatabase).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 40) || tpl.defaultDatabase;

  const rows = await sql`
    INSERT INTO managed_services (
      name, service_type, version, port, console_port, username, password, database_name, volume_name, status, public_access, memory_limit_mb
    )
    VALUES (
      ${safeName}, ${safeType}, ${tpl.version}, ${assignedPort}, ${consolePort},
      ${tpl.defaultUsername}, ${encryptedPassword}, ${cleanDbName},
      ${volumeName}, ${autoStart ? 'starting' : 'stopped'}, ${isPublic}, ${memMb}
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
        SET container_id = ${containerId}, status = 'running', last_error = '', updated_at = NOW()
        WHERE id = ${record.id}
        RETURNING *
      `;
      record = updated[0];
    } catch (err) {
      startError = err.message;
      const errMsg = String(err.message || 'Container failed to start').slice(0, 600);
      const errRows = await sql`
        UPDATE managed_services SET status = 'error', last_error = ${errMsg}, updated_at = NOW()
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
  const tpl = SERVICE_TEMPLATES[service.service_type];
  const plainPassword = decryptSecret(service.password) || '';

  try {
    const portKey = `${tpl?.containerPort || service.port}/tcp`;
    const expectedHostIp = service.public_access ? '0.0.0.0' : '127.0.0.1';
    const hasBindingMismatch = (found) => {
      const boundIp = found?.info?.HostConfig?.PortBindings?.[portKey]?.[0]?.HostIp || '0.0.0.0';
      return boundIp !== expectedHostIp;
    };

    if (action === 'start') {
      const found = await findServiceContainer(service);
      let containerId = service.container_id;
      const needsRecreate = !found
        || hasBindingMismatch(found)
        || (!found.info.State?.Running && (service.status === 'error' || (tpl?.image && found.info.Config?.Image !== tpl.image)));
      if (needsRecreate) {
        containerId = await createAndStartServiceContainer(service, plainPassword);
      } else if (!found.info.State?.Running) {
        await found.container.start();
        containerId = found.info.Id;
        await ensureContainerOnSharedNetwork(containerId);
      } else {
        containerId = found.info.Id;
        await ensureContainerOnSharedNetwork(containerId);
      }
      const nextVer = tpl?.version || service.version;
      const upd = await sql`
        UPDATE managed_services
        SET status = 'running', version = ${nextVer}, container_id = ${containerId}, last_error = '', updated_at = NOW()
        WHERE id = ${id} RETURNING *
      `;
      service = upd[0];
    } else if (action === 'stop') {
      const found = await findServiceContainer(service);
      if (found && found.info.State?.Running) {
        await found.container.stop({ t: 10 });
      }
      const upd = await sql`
        UPDATE managed_services SET status = 'stopped', last_error = '', updated_at = NOW()
        WHERE id = ${id} RETURNING *
      `;
      service = upd[0];
    } else if (action === 'restart') {
      const found = await findServiceContainer(service);
      const needsRecreate = !found
        || hasBindingMismatch(found)
        || (tpl?.image && found.info.Config?.Image !== tpl.image);
      if (needsRecreate) {
        const containerId = await createAndStartServiceContainer(service, plainPassword);
        service = (await sql`
          UPDATE managed_services SET container_id = ${containerId}, version = ${tpl?.version || service.version}, updated_at = NOW()
          WHERE id = ${id} RETURNING *
        `)[0];
      } else {
        await found.container.restart();
        await ensureContainerOnSharedNetwork(found.info.Id);
      }
      const upd = await sql`
        UPDATE managed_services SET status = 'running', last_error = '', updated_at = NOW()
        WHERE id = ${id} RETURNING *
      `;
      service = upd[0];
    } else {
      throw new Error('Invalid service action.');
    }
  } catch (err) {
    const errMsg = String(err.message || `Failed to ${action} service.`).slice(0, 600);
    await sql`
      UPDATE managed_services SET status = 'error', last_error = ${errMsg}, updated_at = NOW()
      WHERE id = ${id}
    `.catch(() => {});
    broadcast({ type: 'services:changed', action, serviceId: id });
    throw err;
  }

  const ips = await getServerPublicIps().catch(() => ({ publicIpv4: null, localIpv4: 'localhost' }));
  const publicHost = ips.publicIpv4 || ips.localIpv4 || 'localhost';
  broadcast({ type: 'services:changed', action, serviceId: service.id });
  return serializeService(service, publicHost, role);
}

/**
 * Toggle whether a managed service binds publicly (0.0.0.0) or stays private to Docker & 127.0.0.1.
 */
export async function setManagedServiceAccess(id, publicAccess, role = 'admin') {
  const sql = getDb();
  const isPublic = Boolean(publicAccess);
  const rows = await sql`
    UPDATE managed_services SET public_access = ${isPublic}, updated_at = NOW()
    WHERE id = ${id} RETURNING *
  `;
  if (!rows[0]) throw new Error('Managed service not found.');
  let service = rows[0];

  const found = await findServiceContainer(service).catch(() => null);
  if (found?.info?.State?.Running) {
    const plainPassword = decryptSecret(service.password) || '';
    const containerId = await createAndStartServiceContainer(service, plainPassword);
    const upd = await sql`
      UPDATE managed_services SET container_id = ${containerId}, status = 'running', last_error = '', updated_at = NOW()
      WHERE id = ${id} RETURNING *
    `;
    service = upd[0];
  } else if (found) {
    try {
      await found.container.remove({ force: true });
      await sql`UPDATE managed_services SET container_id = NULL WHERE id = ${id}`;
    } catch {
    }
  }

  const ips = await getServerPublicIps().catch(() => ({ publicIpv4: null, localIpv4: 'localhost' }));
  const publicHost = ips.publicIpv4 || ips.localIpv4 || 'localhost';
  broadcast({ type: 'services:changed', action: 'access', serviceId: service.id });
  return serializeService(service, publicHost, role);
}

async function applyEnginePasswordChange(service, found, oldPass, nextPass, encryptedNext) {
  const type = service.service_type;
  const isRunning = Boolean(found?.info?.State?.Running);

  if (type === 'redis' || type === 'minio') {
    if (isRunning) {
      return createAndStartServiceContainer({ ...service, password: encryptedNext }, nextPass);
    }
    if (found) {
      try {
        await found.container.remove({ force: true });
      } catch {
      }
      return null;
    }
    return service.container_id;
  }

  if (!found && !service.container_id) {
    return null;
  }
  if (!isRunning) {
    throw new Error(`Start '${service.name}' first so the new password can be updated inside its running database.`);
  }

  const user = service.username || 'paas';
  if (type === 'postgres') {
    const safeIdent = user.replace(/"/g, '');
    const escapedPass = nextPass.replace(/'/g, "''");
    await runContainerExec(
      found.container,
      ['psql', '-U', user, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', `ALTER USER "${safeIdent}" WITH PASSWORD '${escapedPass}';`],
      [`PGPASSWORD=${oldPass}`]
    );
  } else if (type === 'mysql') {
    const safeUser = user.replace(/'/g, '');
    const escapedPass = nextPass.replace(/\\/g, '\\\\').replace(/'/g, "''");
    const sqlStmt = `ALTER USER IF EXISTS 'root'@'localhost' IDENTIFIED BY '${escapedPass}'; ALTER USER IF EXISTS 'root'@'%' IDENTIFIED BY '${escapedPass}'; ALTER USER IF EXISTS '${safeUser}'@'%' IDENTIFIED BY '${escapedPass}'; FLUSH PRIVILEGES;`;
    await runContainerExec(found.container, ['mysql', '-u', 'root', '-e', sqlStmt], [`MYSQL_PWD=${oldPass}`]);
  } else if (type === 'mongodb') {
    await runContainerExec(
      found.container,
      [
        'mongosh', '--quiet', '--username', user, '--password', oldPass, '--authenticationDatabase', 'admin',
        '--eval', 'db.getSiblingDB("admin").changeUserPassword(process.env.MONGO_TARGET_USER, process.env.MONGO_NEW_PASS)',
      ],
      [`MONGO_TARGET_USER=${user}`, `MONGO_NEW_PASS=${nextPass}`]
    );
  }
  return found.info.Id;
}

/**
 * Rotate a managed service's password both in the engine/container and in encrypted storage,
 * and optionally refresh env vars on attached applications referencing this service.
 */
export async function changeManagedServicePassword(id, { password, generateRandom = false, syncApps = true }, role = 'admin') {
  const nextPass = generateRandom ? generatePassword(24) : validateServicePassword(password);
  const encryptedNext = encryptSecret(nextPass);

  const sql = getDb();
  const rows = await sql`SELECT * FROM managed_services WHERE id = ${id}`;
  if (!rows[0]) throw new Error('Managed service not found.');
  const service = rows[0];
  const oldPass = decryptSecret(service.password) || '';

  const found = await findServiceContainer(service).catch(() => null);
  const nextContainerId = await applyEnginePasswordChange(service, found, oldPass, nextPass, encryptedNext);

  const updatedRows = await sql`
    UPDATE managed_services
    SET password = ${encryptedNext}, container_id = ${nextContainerId}, last_error = '', updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `;
  const updated = updatedRows[0];

  const tpl = SERVICE_TEMPLATES[updated.service_type] || {};
  const containerHost = getContainerName(updated);
  const newInternalUrl = buildConnectionString(updated, containerHost, tpl.containerPort || updated.port, { maskSecret: false });

  const syncedApps = [];
  if (syncApps) {
    const appRows = await sql`SELECT id, name, env_vars FROM applications`;
    for (const app of appRows) {
      const envObj = typeof app.env_vars === 'object' && app.env_vars !== null ? { ...app.env_vars } : {};
      let changed = false;

      if (updated.service_type === 'minio') {
        const matchesEndpoint = Object.values(envObj).some((v) => String(v || '').includes(containerHost));
        if (matchesEndpoint && envObj.S3_SECRET_KEY !== nextPass) {
          envObj.S3_SECRET_KEY = nextPass;
          changed = true;
        }
      } else {
        for (const [k, v] of Object.entries(envObj)) {
          if (typeof v === 'string' && v.includes(containerHost) && v !== newInternalUrl) {
            envObj[k] = newInternalUrl;
            changed = true;
          }
        }
      }

      if (changed) {
        await sql`UPDATE applications SET env_vars = ${JSON.stringify(envObj)}::jsonb, updated_at = NOW() WHERE id = ${app.id}`;
        syncedApps.push(app.name);
        broadcast({ type: 'apps:changed', action: 'updated', appId: app.id, appName: app.name });
      }
    }
  }

  const ips = await getServerPublicIps().catch(() => ({ publicIpv4: null, localIpv4: 'localhost' }));
  const publicHost = ips.publicIpv4 || ips.localIpv4 || 'localhost';
  broadcast({ type: 'services:changed', action: 'password', serviceId: updated.id });
  return {
    service: serializeService(updated, publicHost, role),
    syncedApps,
  };
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

  try {
    const found = await findServiceContainer(service);
    if (found) {
      if (found.info.State?.Running) await found.container.stop({ t: 10 });
      await found.container.remove({ force: true });
    }
  } catch {
  }

  if (removeVolume && service.volume_name) {
    try {
      await docker.getVolume(service.volume_name).remove();
    } catch {
    }
  }

  const serviceDomains = await sql`SELECT domain FROM domains WHERE service_id = ${id}`.catch(() => []);
  for (const dom of serviceDomains) {
    await removeDomainNginxConfig(dom.domain).catch(() => {});
  }

  await sql`DELETE FROM managed_services WHERE id = ${id}`;
  if (serviceDomains.length > 0) {
    broadcast({ type: 'domains:changed', action: 'deleted', serviceId: service.id });
  }
  broadcast({ type: 'services:changed', action: 'deleted', serviceId: service.id });
  return service;
}

export async function listServiceBuckets(serviceId) {
  const sql = getDb();
  const rows = await sql`SELECT * FROM managed_services WHERE id = ${serviceId}`;
  if (!rows[0]) throw new Error('Managed service not found.');
  const service = rows[0];
  if (service.service_type !== 'minio') {
    throw new Error('Bucket management is only available for MinIO object storage services.');
  }

  const dbBuckets = await sql`
    SELECT id, name, public_read, created_at FROM storage_buckets WHERE service_id = ${serviceId} ORDER BY name ASC
  `;
  const byName = new Map(dbBuckets.map((b) => [b.name, b]));

  const accessKey = service.username || 'paasadmin';
  const secretKey = decryptSecret(service.password) || '';
  let liveSync = false;
  let syncWarning = null;

  try {
    const found = await findServiceContainer(service);
    if (found?.info?.State?.Running) {
      const liveBuckets = await listMinioBuckets({
        endpoint: `http://127.0.0.1:${service.port}`,
        accessKey,
        secretKey,
      });
      liveSync = true;
      for (const lb of liveBuckets) {
        if (!byName.has(lb.name)) {
          const ins = await sql`
            INSERT INTO storage_buckets (service_id, name, public_read)
            VALUES (${serviceId}, ${lb.name}, false)
            ON CONFLICT (service_id, name) DO NOTHING
            RETURNING id, name, public_read, created_at
          `;
          if (ins[0]) byName.set(lb.name, ins[0]);
        }
      }
    } else {
      syncWarning = 'MinIO container is stopped; showing stored bucket metadata.';
    }
  } catch (err) {
    syncWarning = err.message;
  }

  return {
    buckets: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    liveSync,
    syncWarning,
  };
}

export async function createServiceBucket(serviceId, { name, publicRead = false }) {
  const safeName = String(name || '').trim().toLowerCase();
  if (!isValidBucketName(safeName)) {
    throw new Error('Bucket name must be 3-63 characters using lowercase letters, numbers, and hyphens.');
  }

  const sql = getDb();
  const rows = await sql`SELECT * FROM managed_services WHERE id = ${serviceId}`;
  if (!rows[0]) throw new Error('Managed service not found.');
  const service = rows[0];
  if (service.service_type !== 'minio') {
    throw new Error('Bucket creation is only available for MinIO services.');
  }

  const found = await findServiceContainer(service);
  if (!found?.info?.State?.Running) {
    throw new Error('Start the MinIO container first before creating storage buckets.');
  }

  const accessKey = service.username || 'paasadmin';
  const secretKey = decryptSecret(service.password) || '';
  await createMinioBucket({
    endpoint: `http://127.0.0.1:${service.port}`,
    accessKey,
    secretKey,
    bucketName: safeName,
    publicRead: Boolean(publicRead),
  });

  const inserted = await sql`
    INSERT INTO storage_buckets (service_id, name, public_read)
    VALUES (${serviceId}, ${safeName}, ${Boolean(publicRead)})
    ON CONFLICT (service_id, name)
    DO UPDATE SET public_read = ${Boolean(publicRead)}
    RETURNING id, name, public_read, created_at
  `;
  return { bucket: inserted[0], service };
}

export async function deleteServiceBucket(serviceId, bucketName) {
  const safeName = String(bucketName || '').trim().toLowerCase();
  const sql = getDb();
  const rows = await sql`SELECT * FROM managed_services WHERE id = ${serviceId}`;
  if (!rows[0]) throw new Error('Managed service not found.');
  const service = rows[0];

  const found = await findServiceContainer(service);
  if (found?.info?.State?.Running) {
    const accessKey = service.username || 'paasadmin';
    const secretKey = decryptSecret(service.password) || '';
    await deleteMinioBucket({
      endpoint: `http://127.0.0.1:${service.port}`,
      accessKey,
      secretKey,
      bucketName: safeName,
    });
  }

  await sql`DELETE FROM storage_buckets WHERE service_id = ${serviceId} AND name = ${safeName}`;
  return { bucketName: safeName, service };
}
