import os from 'os';
import si from 'systeminformation';

/**
 * Resolve actual used RAM bytes excluding reclaimable Linux buffers/cache.
 */
export function resolveUsedMemoryBytes(mem) {
  const total = Number(mem?.total) || 0;
  if (Number.isFinite(mem?.available) && mem.available >= 0 && total >= mem.available) {
    return total - mem.available;
  }
  if (Number.isFinite(mem?.active) && mem.active >= 0) {
    return Math.min(mem.active, total || mem.active);
  }
  return Number(mem?.used) || 0;
}

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
  const memUsed = resolveUsedMemoryBytes(mem);
  const memPercent = mem.total > 0 ? Math.round((memUsed / mem.total) * 100) : 0;

  return {
    cpu: {
      load: Math.round(load.currentLoad * 10) / 10,
      cores,
    },
    memory: {
      total: mem.total,
      used: memUsed,
      available: mem.available,
      buffcache: mem.buffcache || 0,
      percent: memPercent,
    },
    disk: {
      total: disk.total,
      used: disk.used,
      percent: diskPercent,
    },
    uptime: Math.floor(process.uptime()),
  };
}
