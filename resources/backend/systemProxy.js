'use strict';

const { execFileSync } = require('node:child_process');

const WINDOWS_PROXY_REGISTRY_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
let cachedWindowsSystemProxy;

function parseWindowsProxyServer(value) {
  let proxy = String(value || '').trim();
  if (!proxy) return '';

  if (proxy.includes('=')) {
    const entries = {};
    for (const item of proxy.split(';')) {
      const separator = item.indexOf('=');
      if (separator <= 0) continue;
      const protocol = item.slice(0, separator).trim().toLowerCase();
      const address = item.slice(separator + 1).trim();
      if (protocol && address) entries[protocol] = address;
    }
    proxy = entries.https || entries.http || '';
  }

  if (!proxy) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(proxy)) proxy = `http://${proxy}`;
  try {
    const parsed = new URL(proxy);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) return '';
    return parsed.toString().replace(/\/$/, '');
  } catch (_error) {
    return '';
  }
}

function readWindowsSystemProxy(options = {}) {
  if ((options.platform || process.platform) !== 'win32') return '';
  const query = options.query || (() => execFileSync('reg.exe', ['query', WINDOWS_PROXY_REGISTRY_KEY], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 3000
  }));

  try {
    const output = String(query() || '');
    const enabled = output.match(/^\s*ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/im);
    if (!enabled || Number.parseInt(enabled[1], 16) !== 1) return '';
    const server = output.match(/^\s*ProxyServer\s+REG_\w+\s+(.+)$/im);
    return parseWindowsProxyServer(server?.[1] || '');
  } catch (_error) {
    return '';
  }
}

function resolveProxyUrl(env = process.env, systemProxy = null) {
  const explicit = String(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || '').trim();
  if (explicit) return /^null$/i.test(explicit) ? '' : explicit;
  if (typeof systemProxy === 'function') return String(systemProxy() || '').trim();
  if (cachedWindowsSystemProxy === undefined) cachedWindowsSystemProxy = readWindowsSystemProxy();
  return cachedWindowsSystemProxy;
}

module.exports = { parseWindowsProxyServer, readWindowsSystemProxy, resolveProxyUrl };
