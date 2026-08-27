const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const frontendRoot = path.resolve(__dirname, '..', '..', 'frontend');
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

test('真实浏览器中版本入口可见、启动不写入、确认后才更新并请求重启', async t => {
  let applyCalls = 0;
  const app = express();
  app.use(express.json());
  app.get('/api/app-update/status', (_req, res) => res.json({ success: true, currentVersion: '1.0.7' }));
  app.get('/api/app-update/check', (_req, res) => res.json({
    success: true,
    currentVersion: '1.0.7',
    latestVersion: '1.1.0',
    commitSha: 'a'.repeat(40),
    updateAvailable: true,
    title: 'Lavans 1.1.0',
    notes: ['安全更新']
  }));
  app.post('/api/app-update/apply', (_req, res) => {
    applyCalls += 1;
    res.json({ success: true, version: '1.1.0', restartRequired: true });
  });
  app.use(express.static(frontendRoot, { etag: false, lastModified: false }));
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const browser = await chromium.launch({ headless: true, executablePath: edgePath });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
    window.__lavansRestartCalls = 0;
    window.lavansUpdater = { restart: async () => { window.__lavansRestartCalls += 1; return true; } };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('app-update-label')?.textContent === '版本 v1.0.7');
  await page.waitForFunction(() => document.getElementById('app-update-dot')?.hidden === false);
  assert.equal(applyCalls, 0, '启动检查不得写入更新');

  const buttonBox = await page.locator('#app-update-button').boundingBox();
  const sidebarBox = await page.locator('#studioSidebar').boundingBox();
  assert.ok(buttonBox && sidebarBox && buttonBox.x >= sidebarBox.x && buttonBox.x + buttonBox.width <= sidebarBox.x + sidebarBox.width);

  await page.locator('#app-update-button').click();
  await page.locator('#app-update-dialog[open]').waitFor();
  await page.getByRole('button', { name: '安全更新并重启' }).click();
  await page.waitForFunction(() => window.__lavansRestartCalls === 1);
  assert.equal(applyCalls, 1);
  assert.match(await page.locator('#app-update-status').textContent(), /正在重新启动/);
});
