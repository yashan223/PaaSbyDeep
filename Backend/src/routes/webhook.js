import { Router } from 'express';
import crypto from 'crypto';
import { getDb } from '../db/database.js';
import { enqueue } from '../services/deploymentQueue.js';

const router = Router();

router.post('/github/:appId', async (req, res) => {
  const appId = Number.parseInt(req.params.appId, 10);
  if (!Number.isInteger(appId) || appId <= 0 || String(appId) !== String(req.params.appId)) {
    return res.status(400).json({ error: 'Invalid application ID.' });
  }

  try {
    const sql = getDb();
    const rows = await sql`SELECT * FROM applications WHERE id = ${appId}`;
    if (!rows[0]) return res.status(404).json({ error: 'Application not found.' });
    const app = rows[0];

    const signature = req.headers['x-hub-signature-256'];
    if (!signature || typeof signature !== 'string') {
      return res.status(401).json({ error: 'Missing X-Hub-Signature-256 header.' });
    }

    const webhookSecret = process.env.WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error('[Webhook] WEBHOOK_SECRET is not configured.');
      return res.status(500).json({ error: 'Webhook secret not configured.' });
    }

    // Use rawBody captured in index.js middleware for exact GitHub HMAC match
    const rawPayload = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    const expectedSig = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(rawPayload).digest('hex');

    let sigValid = false;
    try {
      const sigBuf = Buffer.from(signature);
      const expBuf = Buffer.from(expectedSig);
      sigValid = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
    } catch {
      sigValid = false;
    }

    if (!sigValid) {
      return res.status(401).json({ error: 'Invalid webhook signature.' });
    }

    const event = req.headers['x-github-event'];
    if (event === 'ping') {
      return res.status(200).json({ message: 'Webhook ping verified.' });
    }

    const ref = req.body?.ref;
    const expectedRef = `refs/heads/${app.branch}`;
    if (ref !== expectedRef) {
      return res.status(200).json({ message: `Ignoring push to ${ref || 'unknown'}, watching ${expectedRef}.` });
    }

    const commitSha = req.body?.after || null;
    const deploymentId = await enqueue(app.id, 'webhook', commitSha, app.name);
    return res.status(200).json({ message: 'Deployment enqueued.', deploymentId, commitSha });
  } catch (err) {
    console.error('[Webhook] Error:', err.message);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

export default router;
