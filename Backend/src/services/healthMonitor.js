import { getDb } from '../db/database.js';
import { probeHttpHealth } from './docker.js';
import { broadcast } from './ws.js';
import { sendNotification } from './notificationService.js';

let timer = null;
let ticking = false;

async function checkRunningAppsHealth() {
  if (ticking) return;
  ticking = true;
  try {
    const sql = getDb();
    const apps = await sql`
      SELECT id, name, port, health_check_path, health_status
      FROM applications
      WHERE status = 'running' AND COALESCE(health_check_path, '') <> ''
    `;

    for (const app of apps) {
      const res = await probeHttpHealth(app.port, app.health_check_path, 4500);
      const nextStatus = res.status;
      if (nextStatus !== app.health_status) {
        await sql`
          UPDATE applications
          SET health_status = ${nextStatus}, last_health_check = NOW()
          WHERE id = ${app.id}
        `;
        broadcast({
          type: 'app:health',
          appId: app.id,
          appName: app.name,
          healthStatus: nextStatus,
          checkedAt: new Date().toISOString(),
        });

        if (nextStatus === 'unhealthy') {
          void sendNotification({
            event: 'app_unhealthy',
            status: 'unhealthy',
            title: `Health Check Alert: ${app.name}`,
            message: `Health endpoint ${app.health_check_path} on port ${app.port} is unreachable or failing.`,
            fields: [
              { name: 'Application', value: app.name },
              { name: 'Endpoint', value: app.health_check_path },
              { name: 'Port', value: String(app.port) },
            ],
          });
        }
      } else {
        await sql`UPDATE applications SET last_health_check = NOW() WHERE id = ${app.id}`;
      }
    }
  } catch (err) {
    console.warn('[HealthMonitor] Check warning:', err.message);
  } finally {
    ticking = false;
  }
}

export function startHealthMonitor(intervalMs = 30000) {
  if (timer) return;
  timer = setInterval(checkRunningAppsHealth, intervalMs);
}

export function stopHealthMonitor() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
