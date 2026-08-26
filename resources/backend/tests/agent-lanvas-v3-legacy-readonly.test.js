'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { createAgentRunService, createAgentRunReadOnlyFacade } = require('../services/agentRunService');
const createCanvasRoutes = require('../routes/canvasRoutes');

const READ_ONLY_ERROR = {
  success: false,
  code: 'LEGACY_AGENT_RUN_READ_ONLY',
  error: '旧版 AGENT Run 已转为只读历史；请使用 AgentSession'
};

async function withServer(router, run) {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = await new Promise(resolve => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json();
  return { response, body };
}

function digest(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function treeSnapshot(rootPath) {
  const rows = [];
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) rows.push(`${path.relative(rootPath, absolute).replaceAll('\\', '/')}|${digest(absolute)}`);
    }
  };
  visit(rootPath);
  return rows.sort();
}

function fakeRunService(overrides = {}) {
  return {
    loadRun: () => ({ id: 'legacy-run', canvasId: 'legacy-canvas', status: 'running', stages: [], artifacts: [], scriptReview: { versions: [], attempts: [] } }),
    listRuns: () => [],
    artifactContent: () => ({ run: { id: 'legacy-run' }, artifact: { id: 'artifact' }, content: 'legacy' }),
    scriptVersions: {
      getVersion: () => ({ run: { scriptReview: {} }, version: { id: 'version' }, content: 'legacy' }),
      diffVersions: () => ({ changed: false })
    },
    ...overrides
  };
}

test('M3C：生产只读 facade 只暴露安全读取，并为底层读取固定 recover=false', () => {
  const calls = [];
  const service = fakeRunService({
    loadRun: (...args) => { calls.push(['loadRun', ...args]); return { id: args[0] }; },
    listRuns: (...args) => { calls.push(['listRuns', ...args]); return []; },
    artifactContent: (...args) => { calls.push(['artifactContent', ...args]); return { content: 'legacy' }; },
    createRun: () => { throw new Error('只读 facade 不得暴露此方法'); }
  });
  const facade = createAgentRunReadOnlyFacade(service);
  assert.equal(facade.mode, 'legacy-read-only');
  assert.equal(Object.isFrozen(facade), true);
  assert.equal(Object.isFrozen(facade.scriptVersions), true);
  assert.equal('createRun' in facade, false);
  assert.deepEqual(Object.keys(facade.scriptVersions).sort(), ['diffVersions', 'getVersion']);
  facade.loadRun('run-one');
  facade.listRuns('canvas-one');
  facade.artifactContent('run-one', 'artifact-one');
  assert.deepEqual(calls, [
    ['loadRun', 'run-one', false],
    ['listRuns', 'canvas-one', false],
    ['artifactContent', 'run-one', 'artifact-one', false]
  ]);
});

test('M3C：默认 GET 读取 running 旧 Run 不执行恢复写回，源文件哈希保持不变', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-legacy-read-'));
  const service = createAgentRunService({
    outputRoot,
    findAgentSkillRuntime: () => null,
    findAgentDependencyRuntime: () => null,
    foundation: {}
  });
  const runId = 'legacy-run-running';
  const projectSlug = 'legacy-project';
  const versionsDir = path.join(outputRoot, 'agent-projects', projectSlug, 'story', 'versions');
  fs.mkdirSync(versionsDir, { recursive: true });
  const tempName = 'orphan.tmp-10-12345678-1234-4123-8123-123456789abc';
  fs.writeFileSync(path.join(versionsDir, tempName), 'recover=true 会删除这个文件', 'utf8');
  const orphanContent = '# 未登记但完整的旧剧本版本\n';
  fs.writeFileSync(path.join(versionsDir, 'script-v002.md'), orphanContent, 'utf8');
  fs.writeFileSync(path.join(versionsDir, 'script-v002.json'), `${JSON.stringify({
    schemaVersion: '1.0',
    id: 'script-v002',
    number: 2,
    parentVersionId: '',
    operationId: 'legacy-orphan-version',
    source: 'manual',
    status: 'awaiting-review',
    relativePath: 'story/versions/script-v002.md',
    metadataPath: 'story/versions/script-v002.json',
    contentHash: crypto.createHash('sha256').update(orphanContent).digest('hex'),
    changeScopes: [],
    providerId: '',
    model: '',
    createdAt: 10,
    approvedAt: null,
    lockedAt: null
  }, null, 2)}\n`);
  const runPath = path.join(outputRoot, '.state', 'agent-runs', `${runId}.json`);
  fs.writeFileSync(runPath, `${JSON.stringify({
    id: runId,
    canvasId: 'legacy-canvas',
    skillId: 'legacy-skill',
    skillTitle: '旧版 AGENT',
    questionnaireVersion: '1',
    brief: '',
    questionnaireAnswers: {},
    materials: [],
    status: 'running',
    currentStageId: 'microstory',
    stages: [{ id: 'microstory', order: 1, title: '旧阶段', status: 'running', message: '运行中', artifactIds: [], updatedAt: 10 }],
    artifacts: [],
    project: { name: '旧项目', slug: projectSlug, url: '' },
    scriptReview: {
      versions: [],
      attempts: [
        {
          id: 'revision-attempt-running',
          baseVersionId: '',
          operationId: 'legacy-running-revision',
          status: 'running',
          changeScopes: ['tone'],
          providerId: 'legacy-provider',
          model: 'legacy-model',
          createdAt: 10,
          updatedAt: 10,
          completedAt: null
        },
        {
          id: 'revision-attempt-queued',
          baseVersionId: '',
          operationId: 'legacy-queued-revision',
          status: 'queued',
          changeScopes: ['structure'],
          providerId: 'legacy-provider',
          model: 'legacy-model',
          createdAt: 11,
          updatedAt: 11,
          completedAt: null
        }
      ]
    },
    events: [],
    createdAt: 10,
    updatedAt: 10
  }, null, 2)}\n`);
  const before = digest(runPath);
  const projectBefore = treeSnapshot(path.join(outputRoot, 'agent-projects', projectSlug));
  const router = createCanvasRoutes({ outputRoot, agentRunService: service });

  await withServer(router, async baseUrl => {
    const list = await requestJson(`${baseUrl}/api/canvas/agent-runs?canvasId=legacy-canvas`);
    assert.equal(list.response.status, 200);
    assert.equal(list.body.runs[0].status, 'running');
    const single = await requestJson(`${baseUrl}/api/canvas/agent-runs/${runId}`);
    assert.equal(single.response.status, 200);
    assert.equal(single.body.run.status, 'running');
    const artifacts = await requestJson(`${baseUrl}/api/canvas/agent-runs/${runId}/artifacts`);
    assert.equal(artifacts.response.status, 200);
    assert.deepEqual(artifacts.body.artifacts, []);

    const source = fs.readFileSync(path.join(__dirname, '../routes/canvasRoutes.js'), 'utf8');
    const safeGets = [...source.matchAll(/router\.get\('([^']*\/agent-runs[^']*)'/g)]
      .map(match => match[1].replace(':runId', runId).replace(/:[A-Za-z0-9_]+/g, 'missing'));
    const uniqueSafeGets = [...new Set(safeGets)];
    assert.equal(uniqueSafeGets.length, 12, 'Legacy GET 清单发生变化时必须同步审计');
    for (const routePath of uniqueSafeGets) {
      const result = await requestJson(`${baseUrl}${routePath}`);
      assert.ok(result.response.status < 500, `GET ${routePath} 不应触发服务错误`);
      assert.notEqual(result.body.code, 'LEGACY_AGENT_RUN_READ_ONLY', `GET ${routePath} 必须保持只读可访问`);
    }

    const blocked = await requestJson(`${baseUrl}/api/canvas/agent-runs/${runId}/resume`, { method: 'POST' });
    assert.equal(blocked.response.status, 409);
    assert.deepEqual(blocked.body, READ_ONLY_ERROR);
  });

  assert.equal(digest(runPath), before);
  const persisted = JSON.parse(fs.readFileSync(runPath, 'utf8'));
  assert.equal(persisted.status, 'running');
  assert.deepEqual(persisted.scriptReview.attempts.map(attempt => attempt.status), ['running', 'queued']);
  assert.equal(fs.existsSync(path.join(versionsDir, tempName)), true, 'GET 不得清理旧原子临时文件');
  assert.equal(persisted.scriptReview.versions.length, 0, 'GET 不得把孤立版本补登记回旧 Run');
  assert.equal(fs.existsSync(path.join(versionsDir, 'script-v002.json')), true);
  assert.equal(fs.existsSync(path.join(versionsDir, 'script-v002.md')), true);
  assert.deepEqual(treeSnapshot(path.join(outputRoot, 'agent-projects', projectSlug)), projectBefore);
});

test('M3C：全部已登记 Legacy 写路由及方法变体固定 409，且不会进入旧服务', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-legacy-firewall-'));
  const calls = [];
  const service = fakeRunService(new Proxy({}, {
    get(_target, property) {
      if (['loadRun', 'listRuns', 'artifactContent', 'scriptVersions'].includes(property)) return undefined;
      return (...args) => { calls.push([property, ...args]); throw new Error('写服务不应被调用'); };
    }
  }));
  const router = createCanvasRoutes({ outputRoot, agentRunService: service });
  const source = fs.readFileSync(path.join(__dirname, '../routes/canvasRoutes.js'), 'utf8');
  const registeredWrites = [...source.matchAll(/router\.(post|put|patch|delete)\('([^']*\/agent-runs[^']*)'/g)]
    .map(match => ({ method: match[1].toUpperCase(), path: match[2].replace(/:[A-Za-z0-9_]+/g, 'fixture') }));
  assert.equal(registeredWrites.length, 59, 'Legacy 写路由清单发生变化时必须同步审计');
  registeredWrites.push(
    { method: 'PUT', path: '/api/canvas/agent-runs/fixture' },
    { method: 'PATCH', path: '/api/canvas/agent-runs/fixture' },
    { method: 'DELETE', path: '/api/canvas/agent-runs/fixture' }
  );

  await withServer(router, async baseUrl => {
    for (const entry of registeredWrites) {
      const result = await requestJson(`${baseUrl}${entry.path}`, {
        method: entry.method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed: true })
      });
      assert.equal(result.response.status, 409, `${entry.method} ${entry.path}`);
      assert.deepEqual(result.body, READ_ONLY_ERROR, `${entry.method} ${entry.path}`);
    }
  });
  assert.deepEqual(calls, []);
});

test('M3C：维护旁路只有进程内精确 test-only 开关可用，布尔值不能误开启', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-legacy-maintenance-'));
  let pauses = 0;
  const service = fakeRunService({ pauseRun: runId => { pauses += 1; return { id: runId, status: 'paused' }; } });
  const blockedRouter = createCanvasRoutes({ outputRoot, agentRunService: service, legacyAgentRunMaintenance: true });
  await withServer(blockedRouter, async baseUrl => {
    const blocked = await requestJson(`${baseUrl}/api/canvas/agent-runs/legacy-run/pause`, { method: 'POST' });
    assert.equal(blocked.response.status, 409);
    assert.deepEqual(blocked.body, READ_ONLY_ERROR);
  });
  assert.equal(pauses, 0);

  const maintenanceRouter = createCanvasRoutes({ outputRoot, agentRunService: service, legacyAgentRunMaintenance: 'test-only' });
  await withServer(maintenanceRouter, async baseUrl => {
    const allowed = await requestJson(`${baseUrl}/api/canvas/agent-runs/legacy-run/pause`, { method: 'POST' });
    assert.equal(allowed.response.status, 200);
    assert.equal(allowed.body.run.status, 'paused');
  });
  assert.equal(pauses, 1);
});
