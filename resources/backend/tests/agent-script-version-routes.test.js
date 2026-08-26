const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');

const createCanvasRoutes = require('../routes/canvasRoutes');

async function withServer(router, callback) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(router);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(baseUrl + pathname, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.json();
  return { status: response.status, body };
}

function routeFixture() {
  const calls = [];
  const version = {
    id: 'script-v001', number: 1, status: 'awaiting-review', source: 'initial',
    relativePath: 'story/versions/script-v001.md', contentHash: 'abc123'
  };
  const run = {
    id: 'run-1', status: 'paused', currentStageId: 'microstory',
    scriptReview: { activeVersionId: version.id, approvedVersionId: '', lockedVersionId: '', versions: [version], attempts: [] }
  };
  const failFor = runId => {
    if (runId === 'missing') throw new Error('Agent Run 不存在');
  };
  const scriptVersions = {
    initializeReview(runId) { failFor(runId); calls.push(['initialize', runId]); return run; },
    getVersion(runId, versionId) { failFor(runId); calls.push(['get', versionId]); return { run, version, content: '# 完整剧本\n' }; },
    createManualVersion(runId, input) {
      failFor(runId);
      if (!input.content) throw new Error('手动修改后的完整剧本内容不完整');
      calls.push(['manual', input]); return run;
    },
    async startAiRevision(runId, input, runtime) {
      failFor(runId);
      if (runId === 'busy') { const error = new Error('该 Run 已有 AI 修改任务正在运行'); error.code = 'AGENT_REVISION_BUSY'; throw error; }
      calls.push(['revise', input, { providerId: runtime.providerId, model: runtime.model }]); return run;
    },
    approveVersion(runId, versionId) { failFor(runId); calls.push(['approve', versionId]); return run; },
    lockVersion(runId, versionId, options) {
      failFor(runId);
      if (runId === 'confirm') throw new Error('替换已锁定版本需要再次确认');
      calls.push(['lock', versionId, options]); return run;
    },
    submitVersion(runId, versionId) { failFor(runId); calls.push(['submit', versionId]); return run; },
    diffVersions(runId, leftId, rightId) { failFor(runId); calls.push(['diff', leftId, rightId]); return { leftVersionId: leftId, rightVersionId: rightId, addedLines: 1, removedLines: 0, changedSections: 1, rows: [] }; },
    cancelRevisionAttempt(runId, attemptId) { failFor(runId); calls.push(['cancel', attemptId]); return run; }
  };
  return {
    calls,
    run,
    agentRunService: {
      loadRun(runId) { return runId === 'missing' ? null : run; },
      scriptVersions,
      runScriptSimilarityCheck: async () => ({ pass: true })
    },
    selection: {
      provider: { id: 'provider-a', api_key: 'SECRET_KEY_MUST_NOT_LEAK' },
      publicState: {
        providerId: 'provider-a', providerName: 'Provider A', model: 'model-a',
        dataScopes: ['基准剧本', '产品事实锁', '勾选的修改范围'],
        excludedScopes: ['API Key', '故事数据库原文', '一键复色数据']
      }
    }
  };
}

test('script review routes expose immutable version operations and exact AI approval', async () => {
  const fixture = routeFixture();
  const router = createCanvasRoutes({
    legacyAgentRunMaintenance: 'test-only',
    agentRunService: fixture.agentRunService,
    agentStoryTextSelection: () => fixture.selection,
    generateApprovedAgentStoryText: async () => ({ text: '# 完整剧本\n' })
  });
  await withServer(router, async baseUrl => {
    assert.equal((await request(baseUrl, '/api/canvas/agent-runs/run-1/stages/microstory/review/initialize', { method: 'POST', body: '{}' })).status, 200);
    const versions = await request(baseUrl, '/api/canvas/agent-runs/run-1/stages/microstory/versions');
    assert.equal(versions.status, 200);
    assert.equal(versions.body.versions[0].id, 'script-v001');
    assert.equal((await request(baseUrl, '/api/canvas/agent-runs/run-1/stages/microstory/versions/script-v001')).status, 200);
    assert.equal((await request(baseUrl, '/api/canvas/agent-runs/run-1/stages/microstory/versions/manual', {
      method: 'POST', body: JSON.stringify({ baseVersionId: 'script-v001', content: '# 完整修改剧本\n\n内容长度足够并保持完整。', operationId: 'manual-1' })
    })).status, 200);

    const preflight = await request(baseUrl, '/api/canvas/agent-runs/run-1/stages/microstory/versions/script-v001/revise/preflight?changeScopes=hook,ending');
    assert.equal(preflight.status, 200);
    assert.deepEqual(preflight.body.selection.changeScopes, ['hook', 'ending']);
    assert.equal(JSON.stringify(preflight.body).includes('SECRET_KEY_MUST_NOT_LEAK'), false);

    const rejected = await request(baseUrl, '/api/canvas/agent-runs/run-1/stages/microstory/versions/script-v001/revise', {
      method: 'POST', body: JSON.stringify({
        changeScopes: ['hook', 'ending'], operationId: 'ai-1',
        approval: { approved: true, providerId: 'wrong-provider', model: 'model-a', changeScopes: ['hook', 'ending'], excludedScopes: fixture.selection.publicState.excludedScopes }
      })
    });
    assert.equal(rejected.status, 409);
    assert.equal(fixture.calls.some(call => call[0] === 'revise'), false);

    const revised = await request(baseUrl, '/api/canvas/agent-runs/run-1/stages/microstory/versions/script-v001/revise', {
      method: 'POST', body: JSON.stringify({
        changeScopes: ['hook', 'ending'], operationId: 'ai-1',
        approval: { approved: true, providerId: 'provider-a', model: 'model-a', changeScopes: ['hook', 'ending'], excludedScopes: fixture.selection.publicState.excludedScopes }
      })
    });
    assert.equal(revised.status, 200);
    assert.deepEqual(fixture.calls.find(call => call[0] === 'revise')[2], { providerId: 'provider-a', model: 'model-a' });

    assert.equal((await request(baseUrl, '/api/canvas/agent-runs/run-1/stages/microstory/versions/script-v001/approve', { method: 'POST', body: '{}' })).status, 200);
    assert.equal((await request(baseUrl, '/api/canvas/agent-runs/run-1/stages/microstory/versions/script-v001/lock', { method: 'POST', body: '{}' })).status, 200);
    assert.equal((await request(baseUrl, '/api/canvas/agent-runs/run-1/stages/microstory/versions/script-v001/submit', { method: 'POST', body: JSON.stringify({ checks: [true, true, true] }) })).status, 200);
    assert.equal(fixture.calls.some(call => call[0] === 'submit'), true);
    assert.equal((await request(baseUrl, '/api/canvas/agent-runs/run-1/stages/microstory/versions/script-v001/diff/script-v002')).status, 200);
    assert.equal((await request(baseUrl, '/api/canvas/agent-runs/run-1/stages/microstory/revision-attempts/attempt-1/cancel', { method: 'POST', body: '{}' })).status, 200);
  });
});

test('script review routes map missing, invalid, conflict and busy states', async () => {
  const fixture = routeFixture();
  const router = createCanvasRoutes({
    legacyAgentRunMaintenance: 'test-only',
    agentRunService: fixture.agentRunService,
    agentStoryTextSelection: () => fixture.selection,
    generateApprovedAgentStoryText: async () => ({ text: '# 完整剧本\n' })
  });
  await withServer(router, async baseUrl => {
    assert.equal((await request(baseUrl, '/api/canvas/agent-runs/missing/stages/microstory/review/initialize', { method: 'POST', body: '{}' })).status, 404);
    assert.equal((await request(baseUrl, '/api/canvas/agent-runs/run-1/stages/microstory/versions/manual', { method: 'POST', body: '{}' })).status, 400);
    assert.equal((await request(baseUrl, '/api/canvas/agent-runs/run-1/stages/microstory/versions/script-v001/submit', { method: 'POST', body: JSON.stringify({ checks: [true, false, true] }) })).status, 400);
    assert.equal((await request(baseUrl, '/api/canvas/agent-runs/confirm/stages/microstory/versions/script-v002/lock', { method: 'POST', body: '{}' })).status, 409);
    const busy = await request(baseUrl, '/api/canvas/agent-runs/busy/stages/microstory/versions/script-v001/revise', {
      method: 'POST', body: JSON.stringify({
        changeScopes: ['hook'], operationId: 'busy-ai',
        approval: { approved: true, providerId: 'provider-a', model: 'model-a', changeScopes: ['hook'], excludedScopes: fixture.selection.publicState.excludedScopes }
      })
    });
    assert.equal(busy.status, 423);
  });
});
