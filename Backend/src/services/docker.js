import Docker from 'dockerode';
import { randomUUID } from 'node:crypto';
import { simpleGit } from 'simple-git';
import tar from 'tar-fs';
import { existsSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { getDb } from '../db/database.js';
import { sanitizeName } from '../utils/sanitize.js';
import { decryptSecret } from '../utils/crypto.js';
import { broadcast } from './ws.js';
import { detectProjectFromDir } from './projectDetector.js';
import { getPlatformSettings } from './settingsService.js';
import { sendNotification } from './notificationService.js';
import { recordAudit } from './auditService.js';

export const docker = new Docker();
export const SHARED_DOCKER_NETWORK = 'paasbydeeep-net';

const SENSITIVE_PATTERNS = /TOKEN|SECRET|KEY|PASSWORD|PASSWD|PASS|CREDENTIAL|AUTH/i;
const MAX_LOG_CHARS = 50000;
const MAX_DEPLOYMENTS_PER_APP = 20;
const activeDeploymentLogs = new Map();

export function getActiveDeploymentLogs(deploymentId) {
  return activeDeploymentLogs.get(Number(deploymentId)) || '';
}

export function redactSecrets(text) {
  if (!text) return '';
  return String(text)
    .replace(/https:\/\/[^@\s]+@/gi, 'https://[REDACTED]@')
    .replace(/\b(ghp_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+)\b/g, '[REDACTED]')
    .replace(/(x-access-token|oauth2):[^\s@]+/gi, '$1:[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED]');
}

function redactEnvVars(envVarsObj) {
  const redacted = {};
  for (const [k, v] of Object.entries(envVarsObj)) {
    redacted[k] = SENSITIVE_PATTERNS.test(k) ? '[REDACTED]' : v;
  }
  return redacted;
}

function envObjectToArray(envVarsObj) {
  return Object.entries(envVarsObj).map(([k, v]) => `${k}=${v}`);
}

function appendLog(logsRef, line, ctx) {
  const cleanLine = redactSecrets(line);
  const chunk = cleanLine + '\n';
  logsRef.value += chunk;
  if (logsRef.value.length > MAX_LOG_CHARS) {
    logsRef.value = '... [older logs truncated] ...\n' + logsRef.value.slice(-MAX_LOG_CHARS);
  }
  process.stdout.write(`[Deploy] ${cleanLine}\n`);
  if (ctx) {
    activeDeploymentLogs.set(Number(ctx.deploymentId), logsRef.value);
    broadcast({
      type: 'deploy:log',
      appId: ctx.appId,
      appName: ctx.appName,
      deploymentId: ctx.deploymentId,
      chunk,
    });
  }
}

function appendRawLog(logsRef, text, ctx) {
  const cleanText = redactSecrets(text);
  if (!cleanText) return;
  logsRef.value += cleanText;
  if (logsRef.value.length > MAX_LOG_CHARS) {
    logsRef.value = '... [older logs truncated] ...\n' + logsRef.value.slice(-MAX_LOG_CHARS);
  }
  if (ctx) {
    activeDeploymentLogs.set(Number(ctx.deploymentId), logsRef.value);
    broadcast({
      type: 'deploy:log',
      appId: ctx.appId,
      appName: ctx.appName,
      deploymentId: ctx.deploymentId,
      chunk: cleanText,
    });
  }
}

function streamToString(stream, onChunk) {
  return new Promise((resolve, reject) => {
    let output = '';
    docker.modem.followProgress(
      stream,
      (err) => {
        if (err) return reject(err);
        resolve(output);
      },
      (event) => {
        let piece = '';
        if (event.stream) piece += event.stream;
        if (event.error) piece += `ERROR: ${event.error}\n`;
        if (event.status) piece += `${event.status}${event.progress ? ' ' + event.progress : ''}\n`;
        if (piece) {
          output += piece;
          if (onChunk) onChunk(piece);
        }
      }
    );
  });
}

/**
 * Ensure shared bridge network exists so apps can reach managed databases by container name.
 */
export async function ensureDockerNetwork() {
  try {
    await docker.getNetwork(SHARED_DOCKER_NETWORK).inspect();
    return true;
  } catch (err) {
    if (err.statusCode === 404) {
      try {
        await docker.createNetwork({ Name: SHARED_DOCKER_NETWORK, Driver: 'bridge', CheckDuplicate: true });
        return true;
      } catch (createErr) {
        if (createErr.statusCode === 409) return true;
        console.warn('[Docker] Network creation warning:', createErr.message);
        return false;
      }
    }
    return false;
  }
}

export async function findAppContainer(app) {
  const safeName = sanitizeName(app.name);
  const containerName = safeName ? `paasbydeeep-${safeName}` : null;

  if (app.container_id) {
    try {
      const c = docker.getContainer(app.container_id);
      const info = await c.inspect();
      return { container: c, info, containerName: info.Name?.replace(/^\//, '') || containerName };
    } catch (err) {
      if (err.statusCode !== 404) {
        throw err;
      }
    }
  }

  if (containerName) {
    try {
      const c = docker.getContainer(containerName);
      const info = await c.inspect();
      return { container: c, info, containerName };
    } catch (err) {
      if (err.statusCode !== 404) {
        throw err;
      }
    }
  }

  return null;
}

export function demuxDockerLogBuffer(buffer, isTty = false) {
  if (!buffer || buffer.length === 0) return '';
  if (isTty || typeof buffer === 'string') {
    return buffer.toString('utf8');
  }

  const chunks = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset];
    const zero1 = buffer[offset + 1];
    const zero2 = buffer[offset + 2];
    const zero3 = buffer[offset + 3];
    const payloadSize = buffer.readUInt32BE(offset + 4);

    const validHeader = (streamType === 0 || streamType === 1 || streamType === 2)
      && zero1 === 0 && zero2 === 0 && zero3 === 0
      && offset + 8 + payloadSize <= buffer.length;

    if (!validHeader) {
      return buffer.toString('utf8');
    }

    chunks.push(buffer.subarray(offset + 8, offset + 8 + payloadSize).toString('utf8'));
    offset += 8 + payloadSize;
  }

  return chunks.join('');
}

/**
 * Fetch recent stdout/stderr runtime logs from an application's Docker container.
 */
export async function getContainerLogs(app, { tail = 300 } = {}) {
  try {
    const found = await findAppContainer(app);
    if (!found) {
      return {
        available: false,
        running: false,
        status: 'not_found',
        containerName: null,
        logs: '',
        reason: 'No Docker container found for this application yet.',
      };
    }

    const { container, info, containerName } = found;
    const rawBuffer = await container.logs({
      stdout: true,
      stderr: true,
      tail,
      timestamps: true,
      follow: false,
    });
    const decoded = demuxDockerLogBuffer(rawBuffer, Boolean(info.Config?.Tty));
    return {
      available: true,
      running: Boolean(info.State?.Running),
      status: info.State?.Status || 'unknown',
      containerName,
      logs: redactSecrets(decoded),
    };
  } catch (err) {
    return {
      available: false,
      running: false,
      status: 'unavailable',
      containerName: null,
      logs: '',
      reason: err.message || 'Unable to read container logs from Docker.',
    };
  }
}

/**
 * Fetch live container telemetry (CPU %, memory, network I/O, PIDs, uptime, restarts).
 */
export async function getContainerStats(app) {
  try {
    const found = await findAppContainer(app);
    if (!found) {
      return { available: false, running: false, status: 'not_found' };
    }

    const { container, info, containerName } = found;
    const running = Boolean(info.State?.Running);
    const base = {
      available: true,
      running,
      containerName,
      status: info.State?.Status || 'unknown',
      startedAt: info.State?.StartedAt || null,
      restartCount: Number(info.RestartCount || 0),
      cpuPercent: 0,
      memoryUsedBytes: 0,
      memoryLimitBytes: 0,
      memoryPercent: 0,
      netRxBytes: 0,
      netTxBytes: 0,
      pids: 0,
    };

    if (!running) return base;

    const stats = await container.stats({ stream: false });
    const cpuDelta = Number(stats.cpu_stats?.cpu_usage?.total_usage || 0)
      - Number(stats.precpu_stats?.cpu_usage?.total_usage || 0);
    const systemDelta = Number(stats.cpu_stats?.system_cpu_usage || 0)
      - Number(stats.precpu_stats?.system_cpu_usage || 0);
    const onlineCpus = Number(
      stats.cpu_stats?.online_cpus
      || stats.cpu_stats?.cpu_usage?.percpu_usage?.length
      || 1
    );
    const cpuPercent = systemDelta > 0 && cpuDelta > 0
      ? Number(((cpuDelta / systemDelta) * onlineCpus * 100).toFixed(2))
      : 0;

    const memStats = stats.memory_stats || {};
    const cacheBytes = Number(memStats.stats?.inactive_file ?? memStats.stats?.cache ?? 0);
    const memoryUsedBytes = Math.max(0, Number(memStats.usage || 0) - cacheBytes);
    const memoryLimitBytes = Number(memStats.limit || 0);
    const memoryPercent = memoryLimitBytes > 0
      ? Number(((memoryUsedBytes / memoryLimitBytes) * 100).toFixed(1))
      : 0;

    let netRxBytes = 0;
    let netTxBytes = 0;
    if (stats.networks && typeof stats.networks === 'object') {
      for (const iface of Object.values(stats.networks)) {
        netRxBytes += Number(iface?.rx_bytes || 0);
        netTxBytes += Number(iface?.tx_bytes || 0);
      }
    }

    return {
      ...base,
      cpuPercent,
      memoryUsedBytes,
      memoryLimitBytes,
      memoryPercent,
      netRxBytes,
      netTxBytes,
      pids: Number(stats.pids_stats?.current || 0),
    };
  } catch (err) {
    return {
      available: false,
      running: false,
      status: 'unavailable',
      reason: err.message || 'Unable to inspect container stats.',
    };
  }
}

/**
 * Start an interactive TTY shell inside a running application container.
 */
export async function startContainerExecSession(app, { cols = 100, rows = 24, onData, onClose }) {
  const found = await findAppContainer(app);
  if (!found || !found.info.State?.Running) {
    throw new Error('Application container must be running to open a terminal.');
  }

  const exec = await found.container.exec({
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    Env: ['TERM=xterm-256color', `COLUMNS=${cols}`, `LINES=${rows}`],
    Cmd: ['/bin/sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'],
  });

  const stream = await exec.start({ hijack: true, stdin: true, Tty: true });
  const sessionId = randomUUID();

  try {
    await exec.resize({ h: rows, w: cols });
  } catch {
  }

  stream.on('data', (chunk) => {
    if (onData) onData(chunk.toString('utf8'));
  });
  stream.on('end', () => {
    if (onClose) onClose('closed');
  });
  stream.on('close', () => {
    if (onClose) onClose('closed');
  });
  stream.on('error', (err) => {
    if (onClose) onClose(err.message);
  });

  return {
    sessionId,
    write(data) {
      if (stream.writable) {
        stream.write(String(data));
      }
    },
    async resize(nextCols, nextRows) {
      try {
        await exec.resize({
          w: Math.min(Math.max(Number(nextCols) || 80, 20), 400),
          h: Math.min(Math.max(Number(nextRows) || 24, 5), 200),
        });
      } catch {
      }
    },
    close() {
      try {
        stream.end();
        stream.destroy();
      } catch {
      }
    },
  };
}

export async function cleanupContainer(app) {
  const safeName = sanitizeName(app.name);
  const containerName = safeName ? `paasbydeeep-${safeName}` : app.container_id;

  try {
    const found = await findAppContainer(app);
    if (!found) return;
    if (found.info.State?.Running) await found.container.stop({ t: 10 });
    await found.container.remove({ force: true });
    console.log(`[Docker] Removed container ${found.containerName || containerName}`);
  } catch (err) {
    if (err.statusCode !== 404) {
      console.warn(`[Docker] Warning removing container ${containerName}: ${err.message}`);
    }
  }
}

function buildAppVolumeBinds(safeName, rawVolumes) {
  if (!Array.isArray(rawVolumes)) return [];
  const binds = [];
  for (const vol of rawVolumes) {
    if (!vol || !vol.name || !vol.containerPath) continue;
    const safeVol = String(vol.name).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40);
    const mountPath = String(vol.containerPath).trim();
    if (!safeVol || !mountPath.startsWith('/')) continue;
    binds.push(`paasbydeeep-vol-${safeName}-${safeVol}:${mountPath}`);
  }
  return binds;
}

export async function probeHttpHealth(port, healthPath, timeoutMs = 15000) {
  if (!port || !healthPath || !String(healthPath).startsWith('/')) {
    return { checked: false, status: 'unknown' };
  }
  const url = `http://127.0.0.1:${port}${healthPath}`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (res.status < 400) {
        return { checked: true, status: 'healthy', httpStatus: res.status };
      }
    } catch {
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { checked: true, status: 'unhealthy' };
}

async function createAndStartAppContainer({
  app,
  safeName,
  imageName,
  containerName,
  envVarsObj,
  platformSettings,
  logsRef,
  logCtx,
}) {
  const defaultMemoryMb = Math.max(128, Number(platformSettings.default_memory_mb) || 512);
  const effectiveMemoryMb = app.memory_limit_mb && Number(app.memory_limit_mb) >= 128
    ? Number(app.memory_limit_mb)
    : defaultMemoryMb;
  const containerMemoryBytes = effectiveMemoryMb * 1024 * 1024;
  const cpuLimit = Number(app.cpu_limit);
  const nanoCpus = Number.isFinite(cpuLimit) && cpuLimit >= 0.1 ? Math.round(cpuLimit * 1e9) : 0;
  const binds = buildAppVolumeBinds(safeName, app.volumes);
  const networkReady = await ensureDockerNetwork();

  const containerPort = envVarsObj['PORT'] ? String(envVarsObj['PORT']) : String(app.port);
  if (!envVarsObj['PORT']) {
    envVarsObj['PORT'] = containerPort;
  }
  const envArray = envObjectToArray(envVarsObj);
  appendLog(logsRef, `Environment variables (redacted): ${JSON.stringify(redactEnvVars(envVarsObj))}`, logCtx);
  if (binds.length > 0) {
    appendLog(logsRef, `Persistent volumes: ${binds.join(', ')}`, logCtx);
  }
  appendLog(
    logsRef,
    `Container limits: ${effectiveMemoryMb} MB RAM${nanoCpus ? `, ${cpuLimit} CPU` : ''}`,
    logCtx
  );

  const containerPortKey = `${containerPort}/tcp`;
  appendLog(logsRef, `Creating container '${containerName}' on port ${app.port} from ${imageName}...`, logCtx);

  const hostConfig = {
    Privileged: false,
    SecurityOpt: ['no-new-privileges:true'],
    PidsLimit: 256,
    PortBindings: { [containerPortKey]: [{ HostPort: String(app.port) }] },
    RestartPolicy: { Name: 'unless-stopped' },
    Memory: containerMemoryBytes,
  };
  if (nanoCpus > 0) hostConfig.NanoCpus = nanoCpus;
  if (binds.length > 0) hostConfig.Binds = binds;

  const createConfig = {
    name: containerName,
    Image: imageName,
    Env: envArray,
    ExposedPorts: { [containerPortKey]: {} },
    HostConfig: hostConfig,
  };
  if (networkReady) {
    createConfig.NetworkingConfig = { EndpointsConfig: { [SHARED_DOCKER_NETWORK]: {} } };
  }

  const container = await docker.createContainer(createConfig);
  await container.start();
  const containerInfo = await container.inspect();
  const containerId = containerInfo.Id;
  appendLog(logsRef, `Container '${containerName}' started. ID: ${containerId}`, logCtx);

  let healthStatus = 'unknown';
  if (app.health_check_path && String(app.health_check_path).startsWith('/')) {
    appendLog(logsRef, `Checking HTTP health on http://127.0.0.1:${app.port}${app.health_check_path}...`, logCtx);
    const health = await probeHttpHealth(app.port, app.health_check_path, 15000);
    healthStatus = health.status;
    appendLog(
      logsRef,
      healthStatus === 'healthy'
        ? `Health check passed (HTTP ${health.httpStatus}).`
        : 'Health check did not respond healthy within 15s (continuing monitoring).',
      logCtx
    );
  }

  return { containerId, healthStatus };
}

async function pruneUnusedDeploymentTags(sql, appId, maxDeploymentsRetain) {
  try {
    const expired = await sql`
      SELECT id, image_tag FROM deployments
      WHERE app_id = ${appId}
        AND id NOT IN (
          SELECT id FROM deployments WHERE app_id = ${appId} ORDER BY id DESC LIMIT ${maxDeploymentsRetain}
        )
    `;
    for (const row of expired) {
      if (row.image_tag) {
        try {
          await docker.getImage(row.image_tag).remove({ noprune: true });
        } catch {
        }
      }
    }
    await sql`
      DELETE FROM deployments
      WHERE app_id = ${appId}
        AND id NOT IN (
          SELECT id FROM deployments WHERE app_id = ${appId} ORDER BY id DESC LIMIT ${maxDeploymentsRetain}
        )
    `;
  } catch (pruneErr) {
    console.warn('[Deploy] Log pruning warning:', pruneErr.message);
  }
}

export async function deployApp(appId, deploymentId, triggeredBy, commitSha) {
  const logsRef = { value: '' };
  const sql = getDb();

  const appRows = await sql`SELECT * FROM applications WHERE id = ${appId}`;
  if (!appRows[0]) throw new Error(`App ${appId} not found in database.`);
  const app = appRows[0];
  const logCtx = { appId, appName: app.name, deploymentId };

  const safeName = sanitizeName(app.name);
  if (!safeName) throw new Error(`Invalid app name: ${app.name}`);

  const platformSettings = await getPlatformSettings().catch(() => ({}));
  const maxDeploymentsRetain = Math.max(5, Number(platformSettings.max_deployments_retain) || MAX_DEPLOYMENTS_PER_APP);

  await sql`UPDATE deployments SET status = 'running' WHERE id = ${deploymentId}`;
  await sql`UPDATE applications SET status = 'deploying', updated_at = NOW() WHERE id = ${appId}`;

  broadcast({ type: 'deploy:status', appId, appName: app.name, deploymentId, status: 'running', resetLogs: true });
  broadcast({ type: 'app:status', appId, appName: app.name, status: 'deploying' });

  appendLog(logsRef, `=== Deployment #${deploymentId} started (triggered by: ${triggeredBy}) ===`, logCtx);
  if (commitSha) appendLog(logsRef, `Commit: ${commitSha}`, logCtx);

  const reposPath = process.env.REPOS_PATH || './data/repos';
  const repoPath = join(reposPath, safeName);
  const imageName = `paasbydeeep-${safeName}:latest`;
  const versionedTag = `paasbydeeep-${safeName}:dep-${deploymentId}`;
  const containerName = `paasbydeeep-${safeName}`;

  try {
    const envVarsObj =
      typeof app.env_vars === 'object' && app.env_vars !== null ? { ...app.env_vars } : {};

    const storedToken = decryptSecret(app.github_token);
    let githubToken = storedToken || envVarsObj['GITHUB_TOKEN'] || envVarsObj['GH_TOKEN'] || null;

    if (!githubToken && app.repo_url.startsWith('https://github.com/')) {
      const connRows = await sql`
        SELECT access_token FROM github_connections ORDER BY updated_at DESC LIMIT 1
      `;
      if (connRows[0]?.access_token) {
        githubToken = decryptSecret(connRows[0].access_token);
      }
    }

    let authRepoUrl = app.repo_url;
    if (githubToken) {
      if (authRepoUrl.startsWith('https://github.com/')) {
        authRepoUrl = authRepoUrl.replace('https://github.com/', `https://x-access-token:${githubToken}@github.com/`);
      } else if (authRepoUrl.startsWith('https://gitlab.com/')) {
        authRepoUrl = authRepoUrl.replace('https://gitlab.com/', `https://oauth2:${githubToken}@gitlab.com/`);
      }
    }

    if (!existsSync(repoPath)) {
      appendLog(logsRef, `Cloning repository from ${app.repo_url} (branch: ${app.branch})...`, logCtx);
      await simpleGit().clone(authRepoUrl, repoPath, ['--branch', app.branch, '--depth', '1']);
      await simpleGit(repoPath).remote(['set-url', 'origin', app.repo_url]);
      appendLog(logsRef, 'Repository cloned successfully.', logCtx);
    } else {
      appendLog(logsRef, `Pulling latest changes from ${app.repo_url} (branch: ${app.branch})...`, logCtx);
      const git = simpleGit(repoPath);
      await git.remote(['set-url', 'origin', authRepoUrl]);
      try {
        await git.pull('origin', app.branch);
      } finally {
        await git.remote(['set-url', 'origin', app.repo_url]).catch(() => {});
      }
      appendLog(logsRef, 'Repository updated successfully.', logCtx);
    }

    const detected = detectProjectFromDir(repoPath, app.dockerfile_path);
    let buildDockerfile = app.dockerfile_path;
    let tempDockerfilePath = null;

    if (detected.hasDockerfile) {
      appendLog(logsRef, `Using repository Dockerfile: ${app.dockerfile_path}`, logCtx);
    } else if (detected.dockerfileContent) {
      appendLog(
        logsRef,
        `No '${app.dockerfile_path}' found — detected ${detected.label} (${detected.projectType}). Generating temporary Dockerfile...`,
        logCtx
      );
      buildDockerfile = '.paasbydeeep.Dockerfile';
      tempDockerfilePath = join(repoPath, buildDockerfile);
      writeFileSync(tempDockerfilePath, detected.dockerfileContent, 'utf8');
    } else {
      throw new Error(
        `No Dockerfile found at '${app.dockerfile_path}' and could not auto-detect project type.`
      );
    }

    if (detected.projectType && detected.projectType !== 'unknown') {
      await sql`UPDATE applications SET project_type = ${detected.projectType} WHERE id = ${appId}`;
      broadcast({ type: 'apps:changed', action: 'updated', appId, appName: app.name });
    }

    appendLog(logsRef, `Building Docker image: ${versionedTag}...`, logCtx);
    const tarStream = tar.pack(repoPath);
    try {
      const buildStream = await docker.buildImage(tarStream, {
        t: imageName,
        dockerfile: buildDockerfile,
      });
      appendLog(logsRef, '--- Build Output ---', logCtx);
      await streamToString(buildStream, (chunk) => appendRawLog(logsRef, chunk, logCtx));
      appendLog(logsRef, '--- End Build Output ---', logCtx);
    } finally {
      if (tempDockerfilePath) {
        rmSync(tempDockerfilePath, { force: true });
      }
    }

    // Tag immutable deployment image for one-click rollback
    try {
      await docker.getImage(imageName).tag({ repo: `paasbydeeep-${safeName}`, tag: `dep-${deploymentId}` });
      appendLog(logsRef, `Tagged rollback image: ${versionedTag}`, logCtx);
    } catch (tagErr) {
      appendLog(logsRef, `Warning tagging rollback image: ${tagErr.message}`, logCtx);
    }

    appendLog(logsRef, `Stopping old container '${containerName}' (if any)...`, logCtx);
    await cleanupContainer(app);
    appendLog(logsRef, 'Old container cleaned up.', logCtx);

    const { containerId, healthStatus } = await createAndStartAppContainer({
      app,
      safeName,
      imageName,
      containerName,
      envVarsObj,
      platformSettings,
      logsRef,
      logCtx,
    });

    appendLog(logsRef, `=== Deployment #${deploymentId} completed successfully ===`, logCtx);

    await sql`
      UPDATE applications
      SET status = 'running',
          container_id = ${containerId},
          image_name = ${imageName},
          health_status = ${healthStatus},
          last_health_check = NOW(),
          updated_at = NOW()
      WHERE id = ${appId}
    `;
    await sql`
      UPDATE deployments
      SET status = 'success',
          commit_sha = ${commitSha},
          image_tag = ${versionedTag},
          finished_at = NOW(),
          logs = ${logsRef.value}
      WHERE id = ${deploymentId}
    `;

    broadcast({ type: 'deploy:status', appId, appName: app.name, deploymentId, status: 'success' });
    broadcast({
      type: 'app:status',
      appId,
      appName: app.name,
      status: 'running',
      containerId,
      healthStatus,
      lastDeployedAt: new Date().toISOString(),
    });

    void sendNotification({
      event: 'deploy_success',
      status: 'success',
      title: `Deployment Succeeded: ${app.name}`,
      message: `Deployment #${deploymentId} is live on port ${app.port}.`,
      fields: [
        { name: 'Application', value: app.name },
        { name: 'Trigger', value: triggeredBy || 'manual' },
        { name: 'Branch', value: app.branch || 'main' },
        ...(commitSha ? [{ name: 'Commit', value: commitSha.slice(0, 8) }] : []),
      ],
    });
  } catch (err) {
    const safeErrorMsg = redactSecrets(err.message);
    appendLog(logsRef, `=== Deployment #${deploymentId} FAILED ===`, logCtx);
    appendLog(logsRef, `Error: ${safeErrorMsg}`, logCtx);

    await sql`UPDATE applications SET status = 'error', updated_at = NOW() WHERE id = ${appId}`;
    await sql`
      UPDATE deployments
      SET status = 'failed', finished_at = NOW(), logs = ${logsRef.value}
      WHERE id = ${deploymentId}
    `;

    broadcast({ type: 'deploy:status', appId, appName: app.name, deploymentId, status: 'failed' });
    broadcast({ type: 'app:status', appId, appName: app.name, status: 'error' });

    void sendNotification({
      event: 'deploy_failed',
      status: 'failed',
      title: `Deployment Failed: ${app.name}`,
      message: safeErrorMsg,
      fields: [
        { name: 'Application', value: app.name },
        { name: 'Deployment', value: `#${deploymentId}` },
        { name: 'Trigger', value: triggeredBy || 'manual' },
      ],
    });

    throw new Error(safeErrorMsg);
  } finally {
    activeDeploymentLogs.delete(Number(deploymentId));
    await pruneUnusedDeploymentTags(sql, appId, maxDeploymentsRetain);
  }
}

/**
 * Roll back an application immediately to a previously succeeded deployment image tag.
 */
export async function rollbackAppToDeployment(app, targetDeployment, user = null) {
  const sql = getDb();
  const safeName = sanitizeName(app.name);
  if (!safeName) throw new Error('Invalid application name.');

  const targetTag = targetDeployment.image_tag;
  if (!targetTag) {
    throw new Error(`Deployment #${targetDeployment.id} does not have a tagged rollback image.`);
  }

  try {
    await docker.getImage(targetTag).inspect();
  } catch {
    throw new Error(`Rollback image '${targetTag}' was pruned or no longer exists on this host.`);
  }

  const insRows = await sql`
    INSERT INTO deployments (app_id, status, triggered_by, commit_sha, rollback_from_id)
    VALUES (${app.id}, 'running', 'rollback', ${targetDeployment.commit_sha || null}, ${targetDeployment.id})
    RETURNING id
  `;
  const rollbackDepId = insRows[0].id;
  const logsRef = { value: '' };
  const logCtx = { appId: app.id, appName: app.name, deploymentId: rollbackDepId };
  const latestImage = `paasbydeeep-${safeName}:latest`;
  const containerName = `paasbydeeep-${safeName}`;

  await sql`UPDATE applications SET status = 'deploying', updated_at = NOW() WHERE id = ${app.id}`;
  broadcast({ type: 'deploy:status', appId: app.id, appName: app.name, deploymentId: rollbackDepId, status: 'running', resetLogs: true });
  broadcast({ type: 'app:status', appId: app.id, appName: app.name, status: 'deploying' });

  try {
    appendLog(logsRef, `=== Rollback #${rollbackDepId} to Deployment #${targetDeployment.id} (${targetTag}) ===`, logCtx);
    await docker.getImage(targetTag).tag({ repo: `paasbydeeep-${safeName}`, tag: 'latest' });

    appendLog(logsRef, `Stopping current container '${containerName}'...`, logCtx);
    await cleanupContainer(app);

    const platformSettings = await getPlatformSettings().catch(() => ({}));
    const envVarsObj =
      typeof app.env_vars === 'object' && app.env_vars !== null ? { ...app.env_vars } : {};

    const { containerId, healthStatus } = await createAndStartAppContainer({
      app,
      safeName,
      imageName: targetTag,
      containerName,
      envVarsObj,
      platformSettings,
      logsRef,
      logCtx,
    });

    appendLog(logsRef, `=== Rollback #${rollbackDepId} completed successfully ===`, logCtx);

    await sql`
      UPDATE applications
      SET status = 'running',
          container_id = ${containerId},
          image_name = ${latestImage},
          health_status = ${healthStatus},
          last_health_check = NOW(),
          updated_at = NOW()
      WHERE id = ${app.id}
    `;
    await sql`
      UPDATE deployments
      SET status = 'success',
          image_tag = ${targetTag},
          finished_at = NOW(),
          logs = ${logsRef.value}
      WHERE id = ${rollbackDepId}
    `;

    broadcast({ type: 'deploy:status', appId: app.id, appName: app.name, deploymentId: rollbackDepId, status: 'success' });
    broadcast({
      type: 'app:status',
      appId: app.id,
      appName: app.name,
      status: 'running',
      containerId,
      healthStatus,
      lastDeployedAt: new Date().toISOString(),
    });

    void sendNotification({
      event: 'deploy_success',
      status: 'success',
      title: `Rollback Succeeded: ${app.name}`,
      message: `Rolled back to Deployment #${targetDeployment.id} (${rollbackDepId}).`,
      fields: [
        { name: 'Application', value: app.name },
        { name: 'Target Deployment', value: `#${targetDeployment.id}` },
      ],
    });
    void recordAudit({
      user,
      action: 'app.rollback',
      targetType: 'application',
      targetId: app.id,
      targetName: app.name,
      details: { rollbackDeploymentId: rollbackDepId, fromDeploymentId: targetDeployment.id, imageTag: targetTag },
    });

    return rollbackDepId;
  } catch (err) {
    const safeErrorMsg = redactSecrets(err.message);
    appendLog(logsRef, `=== Rollback #${rollbackDepId} FAILED: ${safeErrorMsg} ===`, logCtx);
    await sql`UPDATE applications SET status = 'error', updated_at = NOW() WHERE id = ${app.id}`;
    await sql`
      UPDATE deployments SET status = 'failed', finished_at = NOW(), logs = ${logsRef.value}
      WHERE id = ${rollbackDepId}
    `;
    broadcast({ type: 'deploy:status', appId: app.id, appName: app.name, deploymentId: rollbackDepId, status: 'failed' });
    broadcast({ type: 'app:status', appId: app.id, appName: app.name, status: 'error' });
    throw new Error(safeErrorMsg);
  } finally {
    activeDeploymentLogs.delete(Number(rollbackDepId));
  }
}
