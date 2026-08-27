'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const backendRoot = path.resolve(__dirname, '..');
const examplePath = path.join(backendRoot, 'canvas-config.example.json');
const modulePath = path.join(backendRoot, 'moduleConfigService.js');

const expectedProviders = [
  ['apimart', 'apimart'],
  ['modelscope', 'modelscope'],
  ['runninghub', 'runninghub'],
  ['volcengine', 'volcengine'],
  ['jimeng', 'jimeng'],
  ['codex', 'codex'],
  ['gemini-cli', 'gemini-cli'],
  ['custom-api', 'openai']
];

const secretFields = [
  'api_key',
  'runninghub_key',
  'runninghub_wallet_key',
  'modelscope_key',
  'volcengine_key',
  'volcengine_access_key',
  'volcengine_secret_key'
];

function withIsolatedConfig(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-canvas-config-'));
  const isolatedModule = path.join(root, 'moduleConfigService.js');
  fs.copyFileSync(modulePath, isolatedModule);
  fs.copyFileSync(examplePath, path.join(root, 'canvas-config.example.json'));
  try {
    return run({ root, service: require(isolatedModule) });
  } finally {
    delete require.cache[require.resolve(isolatedModule)];
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('公开默认配置保留 ChromaOS Provider 与协议并移除全部密钥', () => {
  const config = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
  assert.equal(config.primaryProviderId, 'apimart');
  assert.deepEqual(config.providers.map(provider => [provider.id, provider.protocol]), expectedProviders);
  for (const provider of config.providers) {
    for (const field of secretFields) assert.equal(provider[field], '', `${provider.id}.${field} 必须为空`);
  }
});

test('首次启动从公开默认配置建立完整 Provider 目录', () => {
  withIsolatedConfig(({ root, service }) => {
    const config = service.getModuleConfig('canvas');
    assert.deepEqual(config.providers.map(provider => [provider.id, provider.protocol]), expectedProviders);
    assert.equal(config.primaryProviderId, 'apimart');
    assert(fs.existsSync(path.join(root, 'canvas-config.json')));
  });
});

test('已有本机 API 配置优先，不被公开默认配置覆盖', () => {
  withIsolatedConfig(({ root, service }) => {
    const local = {
      version: 2,
      primaryProviderId: 'local-only',
      providers: [{ id: 'local-only', name: 'Local', protocol: 'custom', enabled: true, primary: true, api_key: 'local-secret' }],
      comfy_instances: []
    };
    fs.writeFileSync(path.join(root, 'canvas-config.json'), JSON.stringify(local, null, 2));
    const config = service.getModuleConfig('canvas');
    assert.deepEqual(config.providers.map(provider => [provider.id, provider.protocol]), [['local-only', 'custom']]);
    assert.equal(config.providers[0].api_key, 'local-secret');
  });
});
