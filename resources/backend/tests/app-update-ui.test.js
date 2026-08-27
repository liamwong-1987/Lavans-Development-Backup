const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..', '..');
const html = fs.readFileSync(path.join(root, 'resources', 'frontend', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'resources', 'frontend', 'lanvas-shell-v3.css'), 'utf8');
const client = fs.readFileSync(path.join(root, 'resources', 'frontend', 'app-update.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8');

test('外壳显示版本入口和明确确认窗口且保留原项目主页与致敬链接', () => {
  assert.match(html, /id="app-update-button"/);
  assert.match(html, /id="app-update-label">版本 --/);
  assert.match(html, /id="app-update-dialog"/);
  assert.match(html, /安全更新并重启/);
  assert.match(html, /\/app-update\.js\?v=1\.1\.1/);
  assert.match(html, /onclick="openProjectPage\(\)"/);
  assert.match(html, /https:\/\/github\.com\/hero8152\/Infinite-Canvas/);
  assert.match(css, /\.app-update-dialog/);
  assert.match(css, /\.app-update-dot\[hidden\]/);
});

test('启动只检查更新，只有确认按钮会调用写入接口', () => {
  assert.match(client, /checkUpdate\(\{ silent: true \}\)/);
  assert.match(client, /addEventListener\('click', applyUpdate\)/);
  assert.equal((client.match(/\/api\/app-update\/apply/g) || []).length, 1);
  assert.match(client, /method: 'POST'/);
  assert.match(client, /window\.lavansUpdater\?\.restart/);
  assert.doesNotMatch(client, /location\.href\s*=|window\.open\(/);
});

test('重启能力只接受 Lavans 主窗口和本机应用来源', () => {
  assert.match(preload, /exposeInMainWorld\('lavansUpdater'/);
  assert.match(main, /event\.sender !== mainWindow\.webContents/);
  assert.match(main, /senderOrigin !== appUrl\(\)/);
  assert.match(main, /app\.relaunch\(\)/);
  assert.match(main, /app\.exit\(0\)/);
});
