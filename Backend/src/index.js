import './config/env.js';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

import { initServerLogger } from './services/serverLogger.js';
import { initDb, closeDb, formatDbError } from './db/database.js';
import { initWebSocket, closeWebSocket } from './services/ws.js';
import { startHealthMonitor, stopHealthMonitor } from './services/healthMonitor.js';

initServerLogger();
import authRoutes from './routes/auth.js';
import appsRoutes from './routes/apps.js';
import deployRoutes from './routes/deploy.js';
import webhookRoutes from './routes/webhook.js';
import systemRoutes from './routes/system.js';
import githubRoutes from './routes/github.js';
import domainsRoutes from './routes/domains.js';
import settingsRoutes from './routes/settings.js';
import usersRoutes from './routes/users.js';
import servicesRoutes from './routes/services.js';
import auditRoutes from './routes/audit.js';

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const ALLOWED_ORIGINS = FRONTEND_URL.split(',').map((o) => o.trim()).filter(Boolean);

app.use(helmet());

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use((req, res, next) => {
  if (req.path.startsWith('/api/webhook')) {
    express.json({
      limit: '512kb',
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    })(req, res, next);
  } else {
    express.json({ limit: '512kb' })(req, res, next);
  }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many failed login attempts. Please try again in 15 minutes.' },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many API requests. Please slow down.' },
});

app.use('/api/auth/login', loginLimiter);
app.use('/api', apiLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/apps', appsRoutes);
app.use('/api/deploy', deployRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api/system', systemRoutes);
app.use('/api/github', githubRoutes);
app.use('/api/domains', domainsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/services', servicesRoutes);
app.use('/api/audit', auditRoutes);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found.' });
});

app.use((err, _req, res, _next) => {
  console.error('[Server] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

async function bootstrap() {
  const jwtSecret = process.env.JWT_SECRET || '';
  if (!jwtSecret) {
    throw new Error('JWT_SECRET must be set in Backend/.env before starting the server.');
  }
  if (jwtSecret.length < 32 || jwtSecret.includes('change_this')) {
    console.warn('[Security] WARNING: JWT_SECRET is weak or uses default placeholder. Set a 32+ character random secret.');
  }

  await initDb();

  const server = app.listen(PORT, () => {
    console.log(`[Server] PaaSbyDeeP backend running on port ${PORT}`);
    console.log(`[Server] Frontend allowed from: ${FRONTEND_URL}`);
  });

  initWebSocket(server);
  startHealthMonitor();

  function shutdown(signal) {
    console.log(`[Server] Received ${signal}. Shutting down gracefully...`);
    stopHealthMonitor();
    closeWebSocket();
    server.close(async () => {
      await closeDb().catch(() => {});
      console.log('[Server] HTTP server closed.');
      process.exit(0);
    });
    setTimeout(() => {
      console.error('[Server] Forced shutdown after timeout.');
      process.exit(1);
    }, 10000);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  console.error('[Server] Failed to start:', formatDbError(err));
  process.exit(1);
});
