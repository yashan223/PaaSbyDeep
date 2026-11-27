import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';
import os from 'node:os';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync, accessSync, constants } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { sanitizeDomain, sanitizeEmail, sanitizePort } from '../utils/sanitize.js';

const execFileAsync = promisify(execFile);

const NGINX_SITES_AVAILABLE = process.env.NGINX_SITES_AVAILABLE || '/etc/nginx/sites-available';
const NGINX_SITES_ENABLED = process.env.NGINX_SITES_ENABLED || '/etc/nginx/sites-enabled';
const CERTBOT_LE_DIR = process.env.CERTBOT_LE_DIR || '/etc/letsencrypt/live';

function execRaw(command, args, { input = null, timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      { shell: false, timeout, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout = '', stderr = '') => {
        const output = [stdout, stderr].filter(Boolean).join('\n').trim();
        if (err) {
          resolve({
            ok: false,
            code: typeof err.code === 'number' ? err.code : 1,
            errCode: err.code || null,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            output: output || err.message,
          });
        } else {
          resolve({
            ok: true,
            code: 0,
            errCode: null,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            output,
          });
        }
      }
    );

    if (input !== null && child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

async function runPrivileged(command, args, options = {}) {
  if (process.platform === 'win32') {
    return execRaw(command, args, options);
  }
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (isRoot) {
    return execRaw(command, args, options);
  }
  // Prefer non-interactive sudo on Linux VPS when backend runs as non-root user
  const sudoRes = await execRaw('sudo', ['-n', command, ...args], options);
  if (!sudoRes.ok && sudoRes.errCode === 'ENOENT') {
    return execRaw(command, args, options);
  }
  return sudoRes;
}

async function hasBinary(bin) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const res = await execRaw(probe, [bin], { timeout: 5000 });
  return res.ok;
}

function isDirWritable(dirPath) {
  try {
    accessSync(dirPath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function getNginxFileName(domain) {
  const safeDomain = sanitizeDomain(domain);
  if (!safeDomain) throw new Error('Invalid domain name.');
  return `paasbydeeep-${safeDomain}.conf`;
}

export function getCertPaths(domain) {
  const safeDomain = sanitizeDomain(domain);
  if (!safeDomain) return null;
  const certDir = join(CERTBOT_LE_DIR, safeDomain);
  return {
    certDir,
    fullchainPath: join(certDir, 'fullchain.pem'),
    privkeyPath: join(certDir, 'privkey.pem'),
  };
}

/**
 * Inspect on-disk Let's Encrypt certificate expiry for a domain using Node X509Certificate.
 */
export function readLocalCertInfo(domain) {
  const paths = getCertPaths(domain);
  if (!paths) return { exists: false, expiresAt: null };

  try {
    if (!existsSync(paths.fullchainPath) || !existsSync(paths.privkeyPath)) {
      return { exists: false, expiresAt: null };
    }
    const pem = readFileSync(paths.fullchainPath, 'utf8');
    const cert = new X509Certificate(pem);
    const parsedDate = new Date(cert.validTo);
    return {
      exists: true,
      expiresAt: Number.isNaN(parsedDate.getTime()) ? null : parsedDate.toISOString(),
      subject: cert.subject,
    };
  } catch {
    return { exists: false, expiresAt: null };
  }
}

/**
 * Generate an Nginx reverse-proxy configuration for a domain and upstream localhost port.
 * Includes HTTPS server block automatically when local Let's Encrypt cert files exist.
 */
export function generateNginxConfig({ domain, port, appName = 'app', forceHttpsBlock = false }) {
  const safeDomain = sanitizeDomain(domain);
  const safePort = sanitizePort(port);
  if (!safeDomain) throw new Error('Invalid domain name.');
  if (!safePort) throw new Error('Invalid port.');

  const certInfo = readLocalCertInfo(safeDomain);
  const includeHttps = forceHttpsBlock || certInfo.exists;
  const headerComment = `# Managed by PaaSbyDeep for application: ${String(appName).replace(/[\r\n]/g, '')}`;

  const proxyLocation = `    location / {
        proxy_pass http://127.0.0.1:${safePort};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
        proxy_connect_timeout 60s;
    }`;

  if (!includeHttps) {
    return `${headerComment}
server {
    listen 80;
    listen [::]:80;
    server_name ${safeDomain};

    client_max_body_size 50m;

${proxyLocation}
}
`;
  }

  const optionsSslLine = existsSync('/etc/letsencrypt/options-ssl-nginx.conf')
    ? '    include /etc/letsencrypt/options-ssl-nginx.conf;\n'
    : '';
  const dhParamLine = existsSync('/etc/letsencrypt/ssl-dhparams.pem')
    ? '    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;\n'
    : '';

  return `${headerComment}
server {
    listen 80;
    listen [::]:80;
    server_name ${safeDomain};
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name ${safeDomain};

    ssl_certificate /etc/letsencrypt/live/${safeDomain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${safeDomain}/privkey.pem;
${optionsSslLine}${dhParamLine}
    client_max_body_size 50m;

${proxyLocation}
}
`;
}

let cachedIps = null;
let cachedIpsAt = 0;
const IP_CACHE_TTL_MS = 10 * 60 * 1000;

async function fetchTextIp(url, expectedVersion) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    if (net.isIP(text) === expectedVersion) return text;
  } catch {
  }
  return null;
}

function getLocalInterfaceIps() {
  let localIpv4 = null;
  let localIpv6 = null;
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry.internal) continue;
      if (entry.family === 'IPv4' && !localIpv4) localIpv4 = entry.address;
      if (entry.family === 'IPv6' && !entry.address.startsWith('fe80:') && !localIpv6) {
        localIpv6 = entry.address;
      }
    }
  }
  return { localIpv4, localIpv6 };
}

/**
 * Detect public and local server IPv4/IPv6 addresses for DNS A/AAAA record setup.
 */
export async function getServerPublicIps() {
  const configured = (process.env.SERVER_PUBLIC_IP || '').trim();
  if (configured && net.isIP(configured)) {
    const { localIpv4, localIpv6 } = getLocalInterfaceIps();
    return {
      publicIpv4: net.isIP(configured) === 4 ? configured : localIpv4,
      publicIpv6: net.isIP(configured) === 6 ? configured : null,
      localIpv4,
      localIpv6,
    };
  }

  if (cachedIps && Date.now() - cachedIpsAt < IP_CACHE_TTL_MS) {
    return cachedIps;
  }

  const { localIpv4, localIpv6 } = getLocalInterfaceIps();
  const [fetchedV4, fetchedV6] = await Promise.all([
    fetchTextIp('https://api.ipify.org', 4),
    fetchTextIp('https://api6.ipify.org', 6),
  ]);

  const publicIpv4 = fetchedV4 || (await fetchTextIp('https://ifconfig.me/ip', 4)) || null;
  const publicIpv6 = fetchedV6 || null;

  cachedIps = { publicIpv4, publicIpv6, localIpv4, localIpv6 };
  cachedIpsAt = Date.now();
  return cachedIps;
}

/**
 * Resolve DNS A/AAAA records for a domain and compare with this server's detected IPs.
 */
export async function checkDomainDns(domain) {
  const safeDomain = sanitizeDomain(domain);
  if (!safeDomain) throw new Error('Invalid domain name.');

  const [ips, directV4, directV6] = await Promise.all([
    getServerPublicIps(),
    dns.promises.resolve4(safeDomain).catch(() => []),
    dns.promises.resolve6(safeDomain).catch(() => []),
  ]);

  let resolvedIpv4 = [...directV4];
  let resolvedIpv6 = [...directV6];
  if (resolvedIpv4.length === 0 && resolvedIpv6.length === 0) {
    const sysLookups = await dns.promises.lookup(safeDomain, { all: true }).catch(() => []);
    for (const item of sysLookups) {
      if (item.family === 4 && !resolvedIpv4.includes(item.address)) resolvedIpv4.push(item.address);
      if (item.family === 6 && !resolvedIpv6.includes(item.address)) resolvedIpv6.push(item.address);
    }
  }

  const targetV4 = ips.publicIpv4 || ips.localIpv4;
  const targetV6 = ips.publicIpv6 || ips.localIpv6;
  const matchesServerIpv4 = Boolean(targetV4 && resolvedIpv4.includes(targetV4));
  const matchesServerIpv6 = Boolean(targetV6 && resolvedIpv6.includes(targetV6));

  return {
    domain: safeDomain,
    resolvedIpv4,
    resolvedIpv6,
    expectedIpv4: ips.publicIpv4 || null,
    expectedIpv6: ips.publicIpv6 || null,
    fallbackLocalIpv4: ips.localIpv4 || null,
    matchesServer: matchesServerIpv4 || matchesServerIpv6,
    matchesServerIpv4,
    matchesServerIpv6,
  };
}

/**
 * Probe server capabilities for Nginx, Certbot, and DNS IP targets without mutating system state.
 */
export async function getDomainSystemStatus() {
  const [hasNginx, hasCertbot, ips] = await Promise.all([
    hasBinary('nginx'),
    hasBinary('certbot'),
    getServerPublicIps(),
  ]);
  const sitesAvailableExists = existsSync(NGINX_SITES_AVAILABLE);
  const sitesEnabledExists = existsSync(NGINX_SITES_ENABLED);

  let canManageNginx = false;
  if (hasNginx && process.platform !== 'win32') {
    if (isDirWritable(NGINX_SITES_AVAILABLE)) {
      canManageNginx = true;
    } else {
      const sudoCheck = await execRaw('sudo', ['-n', 'nginx', '-v'], { timeout: 5000 });
      canManageNginx = sudoCheck.ok;
    }
  }

  return {
    platform: process.platform,
    hasNginx,
    hasCertbot,
    canManageNginx,
    sitesAvailableExists,
    sitesEnabledExists,
    nginxSitesAvailable: NGINX_SITES_AVAILABLE,
    nginxSitesEnabled: NGINX_SITES_ENABLED,
    certbotEmailConfigured: Boolean(sanitizeEmail(process.env.CERTBOT_EMAIL)),
    publicIpv4: ips.publicIpv4,
    publicIpv6: ips.publicIpv6,
    localIpv4: ips.localIpv4,
  };
}

/**
 * Write and enable the Nginx site config for a domain, test via `nginx -t`, and reload Nginx.
 */
export async function syncDomainNginxConfig({ domain, port, appName }) {
  const safeDomain = sanitizeDomain(domain);
  const safePort = sanitizePort(port);
  if (!safeDomain) throw new Error('Invalid domain name.');
  if (!safePort) throw new Error('Invalid application port.');

  const configContent = generateNginxConfig({ domain: safeDomain, port: safePort, appName });
  const fileName = getNginxFileName(safeDomain);
  const availablePath = join(NGINX_SITES_AVAILABLE, fileName);
  const enabledPath = join(NGINX_SITES_ENABLED, fileName);

  const hasNginx = await hasBinary('nginx');
  if (!hasNginx) {
    return {
      configured: false,
      configContent,
      availablePath,
      warning: 'Nginx is not installed on this host. Saved domain in database; apply the Nginx config manually on your VPS.',
    };
  }

  if (process.platform === 'win32') {
    return {
      configured: false,
      configContent,
      availablePath,
      warning: 'Automatic Nginx site activation runs on Linux VPS hosts. Saved domain in database.',
    };
  }

  if (isDirWritable(NGINX_SITES_AVAILABLE)) {
    mkdirSync(NGINX_SITES_AVAILABLE, { recursive: true });
    writeFileSync(availablePath, configContent, 'utf8');
  } else {
    const writeRes = await runPrivileged('tee', [availablePath], { input: configContent, timeout: 10000 });
    if (!writeRes.ok) {
      throw new Error(
        `Unable to write ${availablePath}. Ensure backend runs as root or grant passwordless sudo for nginx/tee/certbot. (${writeRes.output})`
      );
    }
  }

  if (isDirWritable(NGINX_SITES_ENABLED)) {
    mkdirSync(NGINX_SITES_ENABLED, { recursive: true });
    if (existsSync(enabledPath)) {
      unlinkSync(enabledPath);
    }
    symlinkSync(availablePath, enabledPath);
  } else {
    const linkRes = await runPrivileged('ln', ['-sf', availablePath, enabledPath], { timeout: 10000 });
    if (!linkRes.ok) {
      throw new Error(`Unable to enable Nginx site at ${enabledPath}: ${linkRes.output}`);
    }
  }

  const testRes = await runPrivileged('nginx', ['-t'], { timeout: 15000 });
  if (!testRes.ok) {
    throw new Error(`Nginx configuration test failed: ${testRes.output}`);
  }

  const reloadRes = await runPrivileged('systemctl', ['reload', 'nginx'], { timeout: 15000 });
  if (!reloadRes.ok) {
    const fallbackReload = await runPrivileged('nginx', ['-s', 'reload'], { timeout: 15000 });
    if (!fallbackReload.ok) {
      throw new Error(`Nginx reload failed: ${reloadRes.output || fallbackReload.output}`);
    }
  }

  return {
    configured: true,
    configContent,
    availablePath,
    enabledPath,
    output: [testRes.output, reloadRes.output].filter(Boolean).join('\n'),
  };
}

/**
 * Remove Nginx site config and reload Nginx if configured on Linux host.
 */
export async function removeDomainNginxConfig(domain) {
  const safeDomain = sanitizeDomain(domain);
  if (!safeDomain || process.platform === 'win32') return { removed: false };

  const hasNginx = await hasBinary('nginx');
  if (!hasNginx) return { removed: false };

  const fileName = getNginxFileName(safeDomain);
  const availablePath = join(NGINX_SITES_AVAILABLE, fileName);
  const enabledPath = join(NGINX_SITES_ENABLED, fileName);

  try {
    if (isDirWritable(NGINX_SITES_ENABLED)) {
      rmSync(enabledPath, { force: true });
    } else {
      await runPrivileged('rm', ['-f', enabledPath], { timeout: 10000 });
    }

    if (isDirWritable(NGINX_SITES_AVAILABLE)) {
      rmSync(availablePath, { force: true });
    } else {
      await runPrivileged('rm', ['-f', availablePath], { timeout: 10000 });
    }

    const testRes = await runPrivileged('nginx', ['-t'], { timeout: 15000 });
    if (testRes.ok) {
      const reloadRes = await runPrivileged('systemctl', ['reload', 'nginx'], { timeout: 15000 });
      if (!reloadRes.ok) {
        await runPrivileged('nginx', ['-s', 'reload'], { timeout: 15000 });
      }
    }
    return { removed: true };
  } catch (err) {
    return { removed: false, warning: err.message };
  }
}

/**
 * Install or renew a Let's Encrypt SSL certificate using Certbot's Nginx plugin.
 */
export async function installCertbotSsl({ domain, port, appName, email, redirect = true, forceRenew = false }) {
  const safeDomain = sanitizeDomain(domain);
  const safePort = sanitizePort(port);
  const safeEmail = sanitizeEmail(email || process.env.CERTBOT_EMAIL);

  if (!safeDomain) throw new Error('Invalid domain name.');
  if (!safePort) throw new Error('Invalid application port.');
  if (!safeEmail) {
    throw new Error('A valid email address is required for Let\'s Encrypt SSL registration.');
  }

  const hasCertbot = await hasBinary('certbot');
  if (!hasCertbot) {
    throw new Error(
      `Certbot is not installed on this server. On Ubuntu/Debian VPS, install with: sudo apt install -y certbot python3-certbot-nginx && sudo certbot --nginx -d ${safeDomain}`
    );
  }

  const hasNginx = await hasBinary('nginx');
  if (!hasNginx) {
    throw new Error('Nginx is not installed on this server. Install Nginx before issuing certificates with Certbot.');
  }

  const syncRes = await syncDomainNginxConfig({ domain: safeDomain, port: safePort, appName });
  if (!syncRes.configured) {
    throw new Error(syncRes.warning || 'Nginx configuration could not be activated on this host.');
  }

  let dnsSummary = '';
  try {
    const resolved = await dns.promises.lookup(safeDomain, { all: true });
    dnsSummary = `DNS lookup for ${safeDomain}: ${resolved.map((r) => r.address).join(', ')}`;
  } catch (dnsErr) {
    dnsSummary = `Warning: DNS lookup for ${safeDomain} failed (${dnsErr.code || dnsErr.message}). Certbot HTTP-01 challenge requires DNS pointing to this server.`;
  }

  const args = [
    '--nginx',
    '-d', safeDomain,
    '--non-interactive',
    '--agree-tos',
    '--email', safeEmail,
    redirect ? '--redirect' : '--no-redirect',
    ...(forceRenew ? ['--force-renewal'] : ['--keep-until-expiring']),
  ];

  const certRes = await runPrivileged('certbot', args, { timeout: 120000 });
  const combinedLog = [dnsSummary, certRes.output].filter(Boolean).join('\n');

  if (!certRes.ok) {
    const err = new Error(certRes.stderr || certRes.output || 'Certbot SSL installation failed.');
    err.certLog = combinedLog;
    throw err;
  }

  const reloadRes = await runPrivileged('systemctl', ['reload', 'nginx'], { timeout: 15000 });
  if (!reloadRes.ok) {
    await runPrivileged('nginx', ['-s', 'reload'], { timeout: 15000 });
  }

  const localInfo = readLocalCertInfo(safeDomain);
  const expiresAt = localInfo.expiresAt || new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

  return {
    sslEnabled: true,
    sslStatus: 'active',
    certExpiresAt: expiresAt,
    log: combinedLog,
  };
}

/**
 * Run `certbot renew --nginx --non-interactive` across all installed certificates.
 */
export async function renewAllCertbotSsl() {
  const hasCertbot = await hasBinary('certbot');
  if (!hasCertbot) {
    throw new Error('Certbot is not installed on this server.');
  }

  const res = await runPrivileged('certbot', ['renew', '--nginx', '--non-interactive'], { timeout: 180000 });
  if (!res.ok) {
    const err = new Error(res.stderr || res.output || 'Certbot renewal failed.');
    err.certLog = res.output;
    throw err;
  }

  const reloadRes = await runPrivileged('systemctl', ['reload', 'nginx'], { timeout: 15000 });
  if (!reloadRes.ok) {
    await runPrivileged('nginx', ['-s', 'reload'], { timeout: 15000 });
  }

  return {
    ok: true,
    output: res.output || 'Certificate renewal check completed.',
  };
}

export async function lookupDomainDns(domain) {
  const safeDomain = sanitizeDomain(domain);
  if (!safeDomain) return null;
  try {
    const res = await execFileAsync('getent', ['hosts', safeDomain]).catch(() => null);
    if (res?.stdout) return res.stdout.trim();
  } catch {
  }
  return null;
}

/**
 * Generate the Nginx configuration for the PaaSbyDeep control-plane dashboard itself.
 */
export function generateDashboardNginxConfig({ domain, backendPort = 3001, frontendRoot = '/var/www/paasbydeeep' }) {
  const safeDomain = sanitizeDomain(domain);
  const safePort = Number.parseInt(backendPort, 10) || 3001;
  if (!safeDomain) throw new Error('Invalid dashboard domain name.');
  const safeRoot = /^\/[a-zA-Z0-9._\/-]+$/.test(frontendRoot) && !frontendRoot.includes('..')
    ? frontendRoot
    : '/var/www/paasbydeeep';

  return `# Managed by PaaSbyDeep (Dashboard Control Plane)
server {
    listen 80;
    listen [::]:80;
    server_name ${safeDomain};

    root ${safeRoot};
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:${safePort};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
        proxy_connect_timeout 60s;
        client_max_body_size 1m;
    }
}
`;
}

/**
 * Write Nginx vhost and run Certbot SSL installation for the PaaSbyDeep dashboard domain.
 */
export async function installDashboardCertbotSsl({ domain, email, backendPort = 3001, redirect = true }) {
  const safeDomain = sanitizeDomain(domain);
  const safeEmail = sanitizeEmail(email || process.env.CERTBOT_EMAIL);
  if (!safeDomain) throw new Error('Invalid dashboard domain name.');
  if (!safeEmail) throw new Error("A valid email address is required for Let's Encrypt registration.");

  const hasCertbot = await hasBinary('certbot');
  const hasNginx = await hasBinary('nginx');
  if (!hasNginx || !hasCertbot) {
    throw new Error(
      `Nginx and Certbot must both be installed on this server to issue SSL for ${safeDomain}. Manual command: sudo certbot --nginx -d ${safeDomain}`
    );
  }
  if (process.platform === 'win32') {
    throw new Error('Certbot dashboard SSL installation runs on Linux VPS hosts.');
  }

  const configContent = generateDashboardNginxConfig({ domain: safeDomain, backendPort });
  const availablePath = join(NGINX_SITES_AVAILABLE, 'paasbydeeep');
  const enabledPath = join(NGINX_SITES_ENABLED, 'paasbydeeep');

  if (isDirWritable(NGINX_SITES_AVAILABLE)) {
    mkdirSync(NGINX_SITES_AVAILABLE, { recursive: true });
    writeFileSync(availablePath, configContent, 'utf8');
  } else {
    const writeRes = await runPrivileged('tee', [availablePath], { input: configContent, timeout: 10000 });
    if (!writeRes.ok) throw new Error(`Unable to write ${availablePath}: ${writeRes.output}`);
  }

  if (isDirWritable(NGINX_SITES_ENABLED)) {
    mkdirSync(NGINX_SITES_ENABLED, { recursive: true });
    if (existsSync(enabledPath)) unlinkSync(enabledPath);
    symlinkSync(availablePath, enabledPath);
  } else {
    const linkRes = await runPrivileged('ln', ['-sf', availablePath, enabledPath], { timeout: 10000 });
    if (!linkRes.ok) throw new Error(`Unable to enable ${enabledPath}: ${linkRes.output}`);
  }

  const testRes = await runPrivileged('nginx', ['-t'], { timeout: 15000 });
  if (!testRes.ok) throw new Error(`Nginx configuration test failed: ${testRes.output}`);

  const reloadRes = await runPrivileged('systemctl', ['reload', 'nginx'], { timeout: 15000 });
  if (!reloadRes.ok) {
    await runPrivileged('nginx', ['-s', 'reload'], { timeout: 15000 });
  }

  const args = [
    '--nginx',
    '-d', safeDomain,
    '--non-interactive',
    '--agree-tos',
    '--email', safeEmail,
    redirect ? '--redirect' : '--no-redirect',
    '--keep-until-expiring',
  ];
  const certRes = await runPrivileged('certbot', args, { timeout: 120000 });
  if (!certRes.ok) {
    const err = new Error(certRes.stderr || certRes.output || 'Certbot SSL installation failed.');
    err.certLog = certRes.output;
    throw err;
  }

  const finalReload = await runPrivileged('systemctl', ['reload', 'nginx'], { timeout: 15000 });
  if (!finalReload.ok) {
    await runPrivileged('nginx', ['-s', 'reload'], { timeout: 15000 });
  }

  const info = readLocalCertInfo(safeDomain);
  return {
    sslEnabled: true,
    expiresAt: info.expiresAt || new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
    log: certRes.output || 'Dashboard SSL certificate installed.',
  };
}
