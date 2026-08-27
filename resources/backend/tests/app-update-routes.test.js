const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const appUpdateRoutes = require('../routes/appUpdateRoutes');

async function startFixture() {
  let applyCalls = 0;
  const service = {
    status: () => ({ currentVersion: '1.0.7' }),
    check: async () => ({ updateAvailable: true, latestVersion: '1.1.0' }),
    apply: async () => { applyCalls += 1; return { success: true, restartRequired: true }; }
  };
  const app = express();
  app.use(express.json());
  app.use(appUpdateRoutes({ service }));
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return { server, port, applyCalls: () => applyCalls };
}

function request(port, method, route, origin, referer = '') {
  return new Promise((resolve, reject) => {
    const body = method === 'POST' ? JSON.stringify({ commitSha: 'a'.repeat(40), version: '1.1.0' }) : '';
    const req = http.request({
      hostname: '127.0.0.1', port, path: route, method,
      headers: {
        Host: `127.0.0.1:${port}`,
        ...(origin ? { Origin: origin } : {}),
        ...(referer ? { Referer: referer } : {}),
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.once('error', reject);
    req.end(body);
  });
}

test('更新接口拒绝非同源网页且不会开始替换', async t => {
  const fixture = await startFixture();
  t.after(() => new Promise(resolve => fixture.server.close(resolve)));
  const result = await request(fixture.port, 'POST', '/api/app-update/apply', 'https://evil.example');
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'UPDATE_LOCAL_ORIGIN_REQUIRED');
  assert.equal(fixture.applyCalls(), 0);
});

test('Lavans 本机同源页面可检查并确认应用更新', async t => {
  const fixture = await startFixture();
  t.after(() => new Promise(resolve => fixture.server.close(resolve)));
  const origin = `http://127.0.0.1:${fixture.port}`;
  const check = await request(fixture.port, 'GET', '/api/app-update/check', '', `${origin}/`);
  const apply = await request(fixture.port, 'POST', '/api/app-update/apply', origin);
  assert.equal(check.status, 200);
  assert.equal(check.body.latestVersion, '1.1.0');
  assert.equal(apply.status, 200);
  assert.equal(apply.body.restartRequired, true);
  assert.equal(fixture.applyCalls(), 1);
});
