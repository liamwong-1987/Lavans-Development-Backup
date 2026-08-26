'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const routesPath = path.resolve(__dirname, '../routes/canvasRoutes.js');

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

test('素材中心 GET 只读补齐画布素材，显式修改时才持久化', async t => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lanvas-asset-center-readonly-'));
  const canvasesRoot = path.join(outputRoot, 'canvases');
  const libraryPath = path.join(outputRoot, 'library', 'asset-library.json');
  fs.mkdirSync(canvasesRoot, { recursive: true });
  fs.writeFileSync(path.join(canvasesRoot, 'canvas-readonly.json'), JSON.stringify({
    id: 'canvas-readonly',
    title: 'Read-only fixture',
    kind: 'smart',
    project: 'default',
    created_at: 1,
    updated_at: 2,
    nodes: [{
      id: 'source-image',
      type: 'smart-image',
      x: 0,
      y: 0,
      images: [{ url: '/canvas-assets/unindexed.png', name: 'unindexed.png', mime: 'image/png', createdAt: 2 }]
    }],
    connections: []
  }, null, 2));

  delete require.cache[require.resolve(routesPath)];
  const app = express();
  app.use(express.json());
  app.use(require(routesPath)({ outputRoot }));
  const listener = await listen(app);
  t.after(async () => {
    await new Promise(resolve => listener.server.close(resolve));
    const safePrefix = `${path.resolve(os.tmpdir())}${path.sep}lanvas-asset-center-readonly-`;
    if (path.resolve(outputRoot).startsWith(safePrefix)) fs.rmSync(outputRoot, { recursive: true, force: true });
  });

  assert.equal(fs.existsSync(libraryPath), false);
  const firstResponse = await fetch(`${listener.baseUrl}/api/canvas/asset-center?includeDeleted=true`);
  const first = await firstResponse.json();
  assert.equal(firstResponse.status, 200);
  const firstItem = first.items.find(item => item.url === '/canvas-assets/unindexed.png');
  assert.ok(firstItem, '只读响应仍须包含尚未持久化的画布素材');
  assert.equal(fs.existsSync(libraryPath), false, 'GET 不得创建或改写素材索引');

  const secondResponse = await fetch(`${listener.baseUrl}/api/canvas/asset-center?includeDeleted=true`);
  const second = await secondResponse.json();
  assert.equal(second.items.find(item => item.url === firstItem.url)?.id, firstItem.id, '只读补齐的素材 ID 必须稳定');
  assert.equal(fs.existsSync(libraryPath), false, '重复 GET 仍不得写入');

  const patchResponse = await fetch(`${listener.baseUrl}/api/canvas/asset-center/${encodeURIComponent(firstItem.id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ favorite: true })
  });
  const patched = await patchResponse.json();
  assert.equal(patchResponse.status, 200);
  assert.equal(patched.item.favorite, true);
  assert.equal(fs.existsSync(libraryPath), true, '用户显式修改后才允许保存索引');
});
