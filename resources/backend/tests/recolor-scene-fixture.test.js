const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const {
  SCENES,
  THEMES,
  createRecolorSceneServer
} = require('./helpers/recolor-scene-ui-server');

async function withServer(run) {
  const server = createRecolorSceneServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function fixtureCookie(response) {
  return response.headers.getSetCookie
    ? response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    : String(response.headers.get('set-cookie') || '').split(/,(?=\s*recolor_fixture_)/).map(value => value.split(';')[0]).join('; ');
}

test('验收夹具固定提供 14 个正式场景与浅深两种主题', async () => {
  assert.deepEqual(SCENES, [
    'running', 'paused', 'prompt', 'history', 'billing', 'compare', 'export',
    'crop', 'palette', 'start', 'redo', 'clear', 'rebind', 'empty'
  ]);
  assert.deepEqual(THEMES, ['light', 'dark']);
  await withServer(async base => {
    for (const scene of SCENES) {
      for (const theme of THEMES) {
        const response = await fetch(`${base}/recolor.html?scene=${scene}&theme=${theme}`);
        assert.equal(response.status, 200, `${scene}/${theme}`);
        const html = await response.text();
        assert.match(html, new RegExp(`const scene=${JSON.stringify(scene)}`));
        assert.match(html, new RegExp(`const theme=${JSON.stringify(theme)}`));
      }
    }
  });
});

test('未知场景和主题被拒绝，不会退回到近似页面', async () => {
  await withServer(async base => {
    assert.equal((await fetch(`${base}/recolor.html?scene=components`)).status, 400);
    assert.equal((await fetch(`${base}/recolor.html?theme=purple`)).status, 400);
  });
});

test('运行、暂停、空状态互相隔离，开始场景没有伪造批次', async () => {
  await withServer(async base => {
    for (const expected of [
      ['running', 'running', true, 24],
      ['paused', 'paused', false, 24],
      ['empty', 'empty', false, 0],
      ['start', null, null, null]
    ]) {
      const page = await fetch(`${base}/index.html?scene=${expected[0]}&theme=light`);
      const response = await fetch(`${base}/api/batches/latest`, { headers: { cookie: fixtureCookie(page) } });
      const payload = await response.json();
      if (expected[1] === null) {
        assert.equal(payload.batch, null);
      } else {
        assert.equal(payload.batch.status, expected[1]);
        assert.equal(payload.batch.active, expected[2]);
        assert.equal(payload.batch.tasks.length, expected[3]);
        if (expected[0] === 'running') {
          assert.equal(payload.batch.totals.apiAttempts, 29);
          assert.equal(payload.batch.totals.costFen, 232);
        }
      }
    }
  });
});

test('历史、参考色和开始生成扫描数据完整且只来自内存', async () => {
  await withServer(async base => {
    const page = await fetch(`${base}/index.html?scene=history&theme=light`);
    const headers = { cookie: fixtureCookie(page) };
    const history = await (await fetch(`${base}/api/recolor/history`, { headers })).json();
    const references = await (await fetch(`${base}/api/recolor/reference-colors`, { headers })).json();
    const scan = await (await fetch(`${base}/api/scan`, { headers })).json();
    assert.equal(history.items.length, 18);
    assert.ok(history.items.every(item => item.referenceHex && item.templateUrl && item.resultUrl && item.colorUrl));
    assert.equal(references.references.length, 4);
    assert.ok(references.references.every(item => item.referenceHex && item.candidates.length === 6));
    assert.equal(scan.totalPairs, 24);
    assert.ok(scan.pairs.every(pair => pair.referenceHex && pair.templateName && pair.colorName));
  });
});

test('任务行手动 HEX 修改只更新夹具内存元数据与同批任务，零生成调用零新增费用', async () => {
  await withServer(async base => {
    const page = await fetch(`${base}/index.html?scene=running&theme=dark`);
    const headers = { cookie: fixtureCookie(page), 'content-type': 'application/json' };
    const response = await fetch(`${base}/api/recolor/reference-colors/metadata`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sessionId: 'upload-fixture-A', name: '森林绿.png', referenceHex: '#123456', referenceColorLabel: '森林绿' })
    });
    assert.equal(response.status, 200);
    const saved = await response.json();
    assert.equal(saved.reference.referenceHex, '#123456');
    const references = await (await fetch(`${base}/api/recolor/reference-colors?sessionId=upload-fixture-A`, { headers })).json();
    assert.equal(references.references.find(item => item.name === '森林绿.png').referenceHex, '#123456');
    const batch = await (await fetch(`${base}/api/batches/latest`, { headers })).json();
    assert.ok(batch.batch.tasks.filter(task => task.uploadBatchId === 'upload-fixture-A' && task.colorRef === '森林绿.png').every(task => task.referenceHex === '#123456'));
    const state = await (await fetch(`${base}/__fixture/state`, { headers })).json();
    assert.equal(state.metadataWrites, 1);
    assert.equal(state.providerGenerationCalls, 0);
    assert.equal(state.addedCostFen, 0);
    assert.equal(state.requests.filter(item => item.path === '/api/generate-v2').length, 0);
  });
});

test('带任务深色夹具只在浏览器内补齐 6 张模板和 4 张参考色，不触发上传或生成', async () => {
  await withServer(async base => {
    const page = await fetch(`${base}/index.html?scene=running&theme=dark`);
    const headers = { cookie: fixtureCookie(page) };
    const html = await (await fetch(`${base}/recolor.html`, { headers })).text();
    assert.match(html, /Array\.from\(\{length:6\}/);
    assert.match(html, /\['森林绿\.png','陶土橙\.png','暮光紫\.png','曜石黑\.png'\]/);
    assert.match(html, /addFiles\('template',templates,\{silent:true,deferScan:true\}\)/);
    assert.match(html, /addFiles\('color',references,\{silent:true,deferScan:true\}\)/);
    const state = await (await fetch(`${base}/__fixture/state`, { headers })).json();
    assert.equal(state.providerGenerationCalls, 0);
    assert.equal(state.addedCostFen, 0);
    assert.equal(state.requests.filter(item => item.method !== 'GET' && item.method !== 'HEAD').length, 0);
  });
});

test('危险写请求全部拦截并记账，普通写请求也不能落盘', async () => {
  await withServer(async base => {
    const page = await fetch(`${base}/index.html?scene=running&theme=light`);
    const headers = { cookie: fixtureCookie(page), 'content-type': 'application/json' };
    const dangerous = [
      '/api/generate-v2',
      '/api/reset-all',
      '/api/cancel',
      '/api/batches/fixture-running/retry-task',
      '/api/batches/fixture-running/resume'
    ];
    for (const endpoint of dangerous) {
      const response = await fetch(base + endpoint, { method: 'POST', headers, body: '{}' });
      assert.equal(response.status, 409, endpoint);
    }
    assert.equal((await fetch(`${base}/api/config`, { method: 'POST', headers, body: '{}' })).status, 405);
    const state = await (await fetch(`${base}/__fixture/state`, { headers })).json();
    assert.equal(state.requests.filter(item => item.method === 'POST').length, 6);
  });
});

test('改绑场景只走正式入口与内存安全接口，零生成调用零新增费用', async () => {
  await withServer(async base => {
    const page = await fetch(`${base}/index.html?scene=rebind&theme=dark`);
    const headers = { cookie: fixtureCookie(page), 'content-type': 'application/json' };
    const query = new URLSearchParams({ fromProviderId: 'local-scene-fixture', fromModel: '已停用模型', toProviderId: 'local-scene-fixture', toModel: 'GPT Image' });
    const preview = await (await fetch(`${base}/api/batches/fixture-rebind/pending-model-rebind/preview?${query}`, { headers })).json();
    assert.equal(preview.preview.eligibleCount, 12);
    assert.equal(preview.preview.protectedCount, 12);
    assert.equal(preview.preview.canResume, false);
    const confirmation = await (await fetch(`${base}/api/batches/fixture-rebind/pending-model-rebind`, {
      method: 'POST', headers, body: JSON.stringify({
        requestId: 'fixture-request-1', previewToken: preview.preview.previewToken,
        from: preview.preview.from, to: preview.preview.to, pricing: { mode: 'keep-current-estimate' }
      })
    })).json();
    assert.equal(confirmation.updatedCount, 12);
    assert.equal(confirmation.remainsPaused, true);
    assert.equal(confirmation.batch.systemPauseRequested, true);
    const state = await (await fetch(`${base}/__fixture/state`, { headers })).json();
    assert.equal(state.blocked, false);
    assert.equal(state.providerGenerationCalls, 0);
    assert.equal(state.addedCostFen, 0);
    assert.equal(state.requests.filter(item => item.path === '/api/generate-v2').length, 0);
    const html = await (await fetch(`${base}/recolor.html`, { headers })).text();
    assert.match(html, /fixtureSceneStatus=modal&&preview\?'opened':'preview-missing'/);
    assert.doesNotMatch(html, /fixture-rebind-modal/);
  });
});
