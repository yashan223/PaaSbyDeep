import { getDb } from '../db/database.js';
import { deployApp } from './docker.js';
import { broadcast } from './ws.js';

const queue = [];
let isProcessing = false;

/**
 * Add a deployment job to the queue.
 * @param {number} appId
 * @param {string} triggeredBy - 'manual' | 'webhook'
 * @param {string|null} commitSha
 * @returns {Promise<number>} deploymentId
 */
export async function enqueue(appId, triggeredBy = 'manual', commitSha = null, appName = null) {
  const sql = getDb();

  const rows = await sql`
    INSERT INTO deployments (app_id, status, triggered_by, commit_sha)
    VALUES (${appId}, 'pending', ${triggeredBy}, ${commitSha})
    RETURNING id, started_at
  `;
  const deploymentId = rows[0].id;

  queue.push({ appId, appName, deploymentId, triggeredBy, commitSha });
  console.log(`[Queue] Enqueued deployment ${deploymentId} for app ${appId} (${triggeredBy}). Queue length: ${queue.length}`);

  broadcast({
    type: 'deploy:status',
    appId,
    appName,
    deploymentId,
    status: 'pending',
    triggeredBy,
    commitSha,
    startedAt: rows[0].started_at,
  });

  processNext();
  return deploymentId;
}

/**
 * Process the next item in the queue.
 */
async function processNext() {
  if (isProcessing || queue.length === 0) return;

  isProcessing = true;
  const job = queue.shift();
  console.log(`[Queue] Processing deployment ${job.deploymentId} for app ${job.appId}...`);

  try {
    await deployApp(job.appId, job.deploymentId, job.triggeredBy, job.commitSha);
  } catch (err) {
    console.error(`[Queue] Unhandled error in deployment ${job.deploymentId}:`, err.message);
    try {
      const sql = getDb();
      await sql`
        UPDATE deployments SET status = 'failed', finished_at = NOW(), logs = COALESCE(NULLIF(logs, ''), ${`Unhandled error: ${err.message}`})
        WHERE id = ${job.deploymentId}
      `;
      await sql`UPDATE applications SET status = 'error', updated_at = NOW() WHERE id = ${job.appId}`;
      broadcast({ type: 'deploy:status', appId: job.appId, appName: job.appName, deploymentId: job.deploymentId, status: 'failed' });
      broadcast({ type: 'app:status', appId: job.appId, appName: job.appName, status: 'error' });
    } catch (dbErr) {
      console.error('[Queue] Failed to update DB after error:', dbErr.message);
    }
  } finally {
    isProcessing = false;
    processNext();
  }
}

/**
 * Get current queue status.
 */
export function getQueueStatus() {
  return {
    isProcessing,
    queueLength: queue.length,
    pending: queue.map(j => ({ appId: j.appId, deploymentId: j.deploymentId, triggeredBy: j.triggeredBy })),
  };
}
