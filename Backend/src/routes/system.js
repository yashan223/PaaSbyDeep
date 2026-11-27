import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { getSystemMetrics } from '../services/systemMetrics.js';

const router = Router();
router.use(authenticate);

router.get('/', async (_req, res) => {
  try {
    const metrics = await getSystemMetrics();
    return res.json(metrics);
  } catch (err) {
    console.error('[System] Error fetching system info:', err.message);
    return res.status(500).json({ error: 'Failed to retrieve system information.' });
  }
});

export default router;
