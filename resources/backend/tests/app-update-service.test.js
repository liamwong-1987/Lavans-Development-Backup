const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAppUpdateService, atomicReplaceFromFile } = require('../services/appUpdateService');

const REPOSITORY = 'liamwong-1987/Lavans-Development-Backup';
const COMMIT = 'a'.repeat(40);

function digest(value) {
  return crypto.createHash('sha256').update(Buffer.from(value)).digest('hex');
}

function fakeResponse(value, url, status = 200) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: name => String(name).toLowerCase() === 'content-length' ? String(buffer.length) : null },
    arrayBuffer: async () => buffer
  };
}

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-update-'));
  const stateRoot = path.join(root, 'resources', 'output', '.state', 'app-updates');
  const files = {
    VERSION: '1.1.0\n',
    'resources/backend/server.js': 'module.exports = "new backend";\n',
    'resources/frontend/index.html': '<title>new frontend</title>\n'
  };
  fs.mkdirSync(path.join(root, 'resources', 'backend'), { recursive: true });
  fs.mkdirSync(path.join(root, 'resources', 'frontend'), { recursive: true });
  fs.writeFileSync(path.join(root, 'VERSION'), '1.0.7\n');
  fs.writeFileSync(path.join(root, 'resources', 'backend', 'server.js'), 'module.exports = "old backend";\n');
  fs.writeFileSync(path.join(root, 'resources', 'frontend', 'index.html'), '<title>old frontend</title>\n');
  fs.writeFileSync(path.join(root, 'resources', 'backend', 'config.json'), '{"apiKey":"keep-me"}\n');
  fs.mkdirSync(path.join(root, 'resources', 'backend', 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(root, 'resources', 'backend', 'uploads', 'asset.png'), 'keep-asset');

  const manifest = {
    schemaVersion: 1,
    repository: REPOSITORY,
    branch: 'main',
    version: '1.1.0',
    files: Object.entries(files).map(([filePath, content]) => ({ path: filePath, size: Buffer.byteLength(content), sha256: digest(content) }))
  };
  if (options.corruptHash) manifest.files.find(item => item.path.endsWith('server.js')).sha256 = '0'.repeat(64);
  const notes = { schemaVersion: 1, version: '1.1.0', title: 'Lavans 1.1.0', notes: ['安全更新'] };
  const apiUrl = `https://api.github.com/repos/${REPOSITORY}/commits/main`;
  const rawRoot = `https://raw.githubusercontent.com/${REPOSITORY}/${COMMIT}`;
  const responses = new Map([
    [apiUrl, JSON.stringify({ sha: COMMIT })],
    [`${rawRoot}/update-manifest.json`, JSON.stringify(manifest)],
    [`${rawRoot}/update-notes.json`, JSON.stringify(notes)],
    ...Object.entries(files).map(([filePath, content]) => [`${rawRoot}/${filePath.split('/').map(encodeURIComponent).join('/')}`, content])
  ]);
  const requests = [];
  const fetchImpl = async url => {
    requests.push(url);
    if (!responses.has(url)) return fakeResponse('missing', url, 404);
    return fakeResponse(responses.get(url), url);
  };
  return { root, stateRoot, files, manifest, requests, fetchImpl };
}

test('检查更新只读取固定 Lavans 仓库与 main 分支', async t => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const service = createAppUpdateService({ projectRoot: data.root, stateRoot: data.stateRoot, fetchImpl: data.fetchImpl });
  const result = await service.check();
  assert.equal(result.updateAvailable, true);
  assert.equal(result.currentVersion, '1.0.7');
  assert.equal(result.latestVersion, '1.1.0');
  assert.equal(result.commitSha, COMMIT);
  assert.equal(result.repository, REPOSITORY);
  assert.equal(result.branch, 'main');
  assert.ok(data.requests.every(url => url.startsWith('https://api.github.com/') || url.startsWith('https://raw.githubusercontent.com/')));
});

test('完整校验后更新程序文件并保留 API 设置、素材和可回滚备份', async t => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const service = createAppUpdateService({ projectRoot: data.root, stateRoot: data.stateRoot, fetchImpl: data.fetchImpl });
  const result = await service.apply({ commitSha: COMMIT, version: '1.1.0' });
  assert.equal(result.success, true);
  assert.equal(result.restartRequired, true);
  for (const [filePath, content] of Object.entries(data.files)) {
    assert.equal(fs.readFileSync(path.join(data.root, ...filePath.split('/')), 'utf8'), content);
  }
  assert.equal(fs.readFileSync(path.join(data.root, 'resources', 'backend', 'config.json'), 'utf8'), '{"apiKey":"keep-me"}\n');
  assert.equal(fs.readFileSync(path.join(data.root, 'resources', 'backend', 'uploads', 'asset.png'), 'utf8'), 'keep-asset');
  const backupRoot = path.join(data.stateRoot, 'backups', result.updateId);
  assert.equal(fs.readFileSync(path.join(backupRoot, 'VERSION'), 'utf8'), '1.0.7\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(backupRoot, 'update-receipt.json'), 'utf8')).status, 'completed');
});

test('下载哈希不符时不触碰任何本机程序或用户数据', async t => {
  const data = fixture({ corruptHash: true });
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const service = createAppUpdateService({ projectRoot: data.root, stateRoot: data.stateRoot, fetchImpl: data.fetchImpl });
  await assert.rejects(service.apply({ commitSha: COMMIT, version: '1.1.0' }), error => error.code === 'UPDATE_FILE_HASH_MISMATCH');
  assert.equal(fs.readFileSync(path.join(data.root, 'VERSION'), 'utf8'), '1.0.7\n');
  assert.equal(fs.readFileSync(path.join(data.root, 'resources', 'backend', 'server.js'), 'utf8'), 'module.exports = "old backend";\n');
  assert.equal(fs.readFileSync(path.join(data.root, 'resources', 'backend', 'config.json'), 'utf8'), '{"apiKey":"keep-me"}\n');
});

test('替换中途失败会恢复已经变更的全部文件', async t => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  let replacements = 0;
  const service = createAppUpdateService({
    projectRoot: data.root,
    stateRoot: data.stateRoot,
    fetchImpl: data.fetchImpl,
    replaceFile(sourcePath, targetPath) {
      replacements += 1;
      if (replacements === 2) throw new Error('fixture replacement failure');
      atomicReplaceFromFile(sourcePath, targetPath);
    }
  });
  await assert.rejects(service.apply({ commitSha: COMMIT, version: '1.1.0' }), /fixture replacement failure/);
  assert.equal(fs.readFileSync(path.join(data.root, 'VERSION'), 'utf8'), '1.0.7\n');
  assert.equal(fs.readFileSync(path.join(data.root, 'resources', 'backend', 'server.js'), 'utf8'), 'module.exports = "old backend";\n');
  assert.equal(fs.readFileSync(path.join(data.root, 'resources', 'frontend', 'index.html'), 'utf8'), '<title>old frontend</title>\n');
  const backupIds = fs.readdirSync(path.join(data.stateRoot, 'backups'));
  const receipt = JSON.parse(fs.readFileSync(path.join(data.stateRoot, 'backups', backupIds[0], 'update-receipt.json'), 'utf8'));
  assert.equal(receipt.status, 'rolled_back');
});

test('Windows 大小写等价的重复路径会在下载前被拒绝', async t => {
  const data = fixture();
  t.after(() => fs.rmSync(data.root, { recursive: true, force: true }));
  const duplicate = { ...data.manifest.files[1], path: 'resources/backend/SERVER.js' };
  data.manifest.files.push(duplicate);
  const rawRoot = `https://raw.githubusercontent.com/${REPOSITORY}/${COMMIT}`;
  const manifestUrl = `${rawRoot}/update-manifest.json`;
  const originalFetch = data.fetchImpl;
  const fetchImpl = async url => url === manifestUrl
    ? fakeResponse(JSON.stringify(data.manifest), url)
    : originalFetch(url);
  const service = createAppUpdateService({ projectRoot: data.root, stateRoot: data.stateRoot, fetchImpl });
  await assert.rejects(service.apply({ commitSha: COMMIT, version: '1.1.0' }), error => error.code === 'UPDATE_PATH_DUPLICATE');
  assert.equal(fs.readFileSync(path.join(data.root, 'resources', 'backend', 'server.js'), 'utf8'), 'module.exports = "old backend";\n');
});
