export function formatHostForUrl(host) {
  if (!host) return '';
  const trimmed = String(host).trim();
  if (trimmed.includes(':') && !trimmed.startsWith('[')) {
    return `[${trimmed}]`;
  }
  return trimmed;
}

export function getServerHostIp(sysStatus) {
  return (
    sysStatus?.publicIpv4 ||
    sysStatus?.localIpv4 ||
    sysStatus?.publicIpv6 ||
    (typeof window !== 'undefined' ? window.location.hostname : '')
  );
}

export function buildIpAccessUrl(port, sysStatus) {
  if (!port) return '';
  const host = formatHostForUrl(getServerHostIp(sysStatus));
  if (!host) return '';
  return `http://${host}:${port}`;
}

export function getPrimaryAppAccess(app, domains, sysStatus) {
  const list = Array.isArray(domains)
    ? domains
    : Array.isArray(app?.domains)
      ? app.domains
      : [];

  if (list.length > 0 && list[0]?.domain) {
    const primary = list[0];
    const protocol = primary.ssl_enabled ? 'https' : 'http';
    return {
      isDomain: true,
      url: `${protocol}://${primary.domain}`,
      label: primary.domain,
    };
  }

  const ipUrl = buildIpAccessUrl(app?.port, sysStatus);
  return ipUrl ? { isDomain: false, url: ipUrl, label: ipUrl } : null;
}
