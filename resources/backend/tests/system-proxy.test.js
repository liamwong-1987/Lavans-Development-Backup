'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseWindowsProxyServer, readWindowsSystemProxy, resolveProxyUrl } = require('../systemProxy');

test('Windows 系统代理支持统一地址和按协议地址', () => {
  assert.equal(parseWindowsProxyServer('127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(parseWindowsProxyServer('http=127.0.0.1:8080;https=127.0.0.1:7890'), 'http://127.0.0.1:7890');
});

test('只在 Windows 系统代理已启用时读取 ProxyServer', () => {
  const enabled = `\n    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    127.0.0.1:7890\n`;
  const disabled = enabled.replace('0x1', '0x0');
  assert.equal(readWindowsSystemProxy({ platform: 'win32', query: () => enabled }), 'http://127.0.0.1:7890');
  assert.equal(readWindowsSystemProxy({ platform: 'win32', query: () => disabled }), '');
  assert.equal(readWindowsSystemProxy({ platform: 'linux', query: () => enabled }), '');
});

test('显式代理优先且 null 明确禁用系统代理', () => {
  const systemProxy = () => 'http://127.0.0.1:7890';
  assert.equal(resolveProxyUrl({ HTTPS_PROXY: 'http://proxy.example:8080' }, systemProxy), 'http://proxy.example:8080');
  assert.equal(resolveProxyUrl({ HTTPS_PROXY: 'null' }, systemProxy), '');
  assert.equal(resolveProxyUrl({}, systemProxy), 'http://127.0.0.1:7890');
});

test('画布与聊天 Provider 共用系统代理解析', () => {
  const backendRoot = path.resolve(__dirname, '..');
  for (const relative of ['routes/canvasRoutes.js', 'routes/chatRoutes.js']) {
    const source = fs.readFileSync(path.join(backendRoot, relative), 'utf8');
    assert.match(source, /require\('\.\.\/systemProxy'\)/);
    assert.doesNotMatch(source, /function resolveProxyUrl\s*\(/);
  }
});
