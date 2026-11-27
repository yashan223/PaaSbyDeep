import Docker from 'dockerode';
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

const docker = new Docker();

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

async function findAppContainer(app) {
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

function demuxDockerLogBuffer(buffer, isTty = false) {
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
  const containerMemoryBytes = Math.max(128, Number(platformSettings.default_memory_mb) || 512) * 1024 * 1024;
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
  const previousImageName = `paasbydeeep-${safeName}:previous`;
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
      // Strip token from .git/config immediately after clone
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

    // Tag :previous before building so failed builds never clobber the rollback image
    try {
      const existingImage = docker.getImage(imageName);
      await existingImage.inspect();
      await existingImage.tag({ repo: `paasbydeeep-${safeName}`, tag: 'previous' });
      appendLog(logsRef, `Tagged existing ${imageName} as ${previousImageName} for rollback.`, logCtx);
    } catch {
      appendLog(logsRef, 'No existing image found to tag as previous.', logCtx);
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

    appendLog(logsRef, `Building Docker image: ${imageName}...`, logCtx);
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

    appendLog(logsRef, `Stopping old container '${containerName}' (if any)...`, logCtx);
    await cleanupContainer(app);
    appendLog(logsRef, 'Old container cleaned up.', logCtx);

    const containerPort = envVarsObj['PORT'] ? String(envVarsObj['PORT']) : String(app.port);
    if (!envVarsObj['PORT']) {
      envVarsObj['PORT'] = containerPort;
    }
    const envArray = envObjectToArray(envVarsObj);
    appendLog(logsRef, `Environment variables (redacted): ${JSON.stringify(redactEnvVars(envVarsObj))}`, logCtx);

    const containerPortKey = `${containerPort}/tcp`;
    appendLog(logsRef, `Creating container '${containerName}' on port ${app.port}...`, logCtx);
    const container = await docker.createContainer({
      name: containerName,
      Image: imageName,
      Env: envArray,
      ExposedPorts: { [containerPortKey]: {} },
      HostConfig: {
        Privileged: false,
        SecurityOpt: ['no-new-privileges:true'],
        PidsLimit: 256,
        PortBindings: { [containerPortKey]: [{ HostPort: String(app.port) }] },
        RestartPolicy: { Name: 'unless-stopped' },
        Memory: containerMemoryBytes,
      },
    });

    await container.start();
    const containerInfo = await container.inspect();
    const containerId = containerInfo.Id;

    appendLog(logsRef, `Container '${containerName}' started. ID: ${containerId}`, logCtx);
    appendLog(logsRef, `=== Deployment #${deploymentId} completed successfully ===`, logCtx);

    await sql`
      UPDATE applications
      SET status = 'running', container_id = ${containerId}, image_name = ${imageName}, updated_at = NOW()
      WHERE id = ${appId}
    `;
    await sql`
      UPDATE deployments
      SET status = 'success', commit_sha = ${commitSha}, finished_at = NOW(), logs = ${logsRef.value}
      WHERE id = ${deploymentId}
    `;

    broadcast({ type: 'deploy:status', appId, appName: app.name, deploymentId, status: 'success' });
    broadcast({ type: 'app:status', appId, appName: app.name, status: 'running', containerId, lastDeployedAt: new Date().toISOString() });
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

    throw new Error(safeErrorMsg);
  } finally {
    activeDeploymentLogs.delete(Number(deploymentId));
    try {
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
}
