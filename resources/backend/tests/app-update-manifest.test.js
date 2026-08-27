const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isAllowedUpdatePath } = require('../services/appUpdatePolicy');

const root = path.resolve(__dirname, '..', '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'update-manifest.json'), 'utf8'));
const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const electronPkg = JSON.parse(fs.readFileSync(path.join(root, 'electron', 'package.json'), 'utf8'));
const notes = JSON.parse(fs.readFileSync(path.join(root, 'update-notes.json'), 'utf8'));

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

test('版本来源、包版本与更新说明保持一致', () => {
  assert.equal(version, '1.1.0');
  assert.equal(pkg.version, version);
  assert.equal(electronPkg.version, version);
  assert.equal(manifest.version, version);
  assert.equal(notes.version, version);
  assert.equal(manifest.repository, 'liamwong-1987/Lavans-Development-Backup');
  assert.equal(manifest.branch, 'main');
});

test('更新清单只包含允许的第一方普通文件且哈希完整', () => {
  assert.ok(manifest.files.length > 100);
  const paths = new Set();
  for (const entry of manifest.files) {
    assert.equal(isAllowedUpdatePath(entry.path), true, `路径不在白名单: ${entry.path}`);
    assert.equal(paths.has(entry.path), false, `路径重复: ${entry.path}`);
    paths.add(entry.path);
    const absolutePath = path.join(root, ...entry.path.split('/'));
    const stat = fs.lstatSync(absolutePath);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
    const content = fs.readFileSync(absolutePath);
    assert.equal(entry.size, content.length, entry.path);
    assert.equal(entry.sha256, sha256(content), entry.path);
  }
});

test('更新白名单拒绝用户数据、密钥、依赖、Electron 核心与测试', () => {
  const blocked = [
    'resources/backend/config.json',
    'resources/backend/canvas-config.json',
    'resources/backend/output/canvases.json',
    'resources/backend/uploads/private.png',
    'resources/backend/agent-skills/imported/private/SKILL.md',
    'resources/backend/tests/example.test.js',
    'resources/.env',
    'node_modules/express/index.js',
    'electron/main.js',
    'package.json'
  ];
  for (const relativePath of blocked) assert.equal(isAllowedUpdatePath(relativePath), false, relativePath);
});
