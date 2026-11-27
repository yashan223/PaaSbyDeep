import os from 'os';
import si from 'systeminformation';

/**
 * Collect lightweight CPU, memory, disk, and uptime metrics.
 */
export async function getSystemMetrics() {
  const [load, mem, fsSizes] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.fsSize(),
  ]);

  const disk = fsSizes.reduce(
    (acc, fs) => ({
      total: acc.total + (fs.size || 0),
      used: acc.used + (fs.used || 0),
    }),
    { total: 0, used: 0 }
  );

  const diskPercent = disk.total > 0 ? Math.round((disk.used / disk.total) * 100) : 0;
  const cores = load.cpus?.length || os.cpus().length || 1;

  return {
    cpu: {
      load: Math.round(load.currentLoad * 10) / 10,
      cores,
    },
    memory: {
      total: mem.total,
      used: mem.used,
      percent: mem.total > 0 ? Math.round((mem.used / mem.total) * 100) : 0,
    },
    disk: {
      total: disk.total,
      used: disk.used,
      percent: diskPercent,
    },
    uptime: Math.floor(process.uptime()),
  };
}
