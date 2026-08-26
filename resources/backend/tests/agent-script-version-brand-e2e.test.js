// Stage 2 end-to-end regression with the user-authorized Derenburg brand fixture.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const createCanvasRoutes = require('../routes/canvasRoutes');
const {
  createAgentScriptVersionService,
  normalizeScriptReview,
  hasLockedScript
} = require('../services/agentScriptVersionService');

const BRAND_ROOT = 'E:\\素材\\【SKILL】\\【】AGENT开发\\agent测试品牌';
const BRAND_IMAGE = path.join(BRAND_ROOT, '德伦堡.png');
const BRAND_REPORT = path.join(BRAND_ROOT, '德伦堡28天德式小麦鲜啤-卖点发掘报告.md');

const clone = value => JSON.parse(JSON.stringify(value));

async function withServer(router, callback) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(router);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(baseUrl + pathname, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  return { status: response.status, body: await response.json() };
}

function createBrandFixture() {
  assert.equal(fs.existsSync(BRAND_IMAGE), true, 'authorized brand product image must exist');
  assert.equal(fs.existsSync(BRAND_REPORT), true, 'authorized brand report must exist');
  const report = fs.readFileSync(BRAND_REPORT, 'utf8');
  assert.match(report, /德伦堡/);
  assert.match(report, /28天/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-stage2-brand-'));
  const projectRoot = path.join(root, 'agent-projects');
  const projectSlug = 'derenburg-stage2-e2e';
  const projectDir = path.join(projectRoot, projectSlug);
  fs.mkdirSync(path.join(projectDir, 'story'), { recursive: true });
  const initialScript = [
    '# 德伦堡28天德式小麦鲜啤｜30秒竖屏剧本',
    '',
    '## 产品事实锁',
    '- 品牌：德伦堡（Derenburg）',
    '- 产品：德伦堡28天德式小麦鲜啤',
    '- 规格：500ml；原麦汁浓度9°P；酒精度≥3.3%vol；保质期28天',
    '- 原料：水、大麦芽、小麦芽、啤酒花、酵母',
    '',
    '## 剧情',
    '0—3秒：冰箱门打开，人物看到只剩最后一罐，动作停住。',
    '4—20秒：朋友同时伸手，二人用猜拳决定归属；镜头自然带到罐身。',
    '21—30秒：胜者把酒放回桌中央与朋友分享，字幕回扣“留住新鲜，也留住这一刻”。',
    '',
    '全片不出现价格、销量、奖项或未经包装确认的功效数据。'
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(projectDir, 'story', 'final-script.md'), initialScript, 'utf8');

  let storedRun = {
    id: 'agent-run-derenburg-stage2',
    canvasId: 'canvas-derenburg-stage2-test',
    status: 'paused',
    currentStageId: 'microstory',
    project: { slug: projectSlug, name: '德伦堡28天德式小麦鲜啤' },
    questionnaireAnswers: {
      productName: '德伦堡28天德式小麦鲜啤',
      facts: '500ml；原麦汁浓度9°P；酒精度≥3.3%vol；保质期28天；原料为水、大麦芽、小麦芽、啤酒花、酵母',
      prohibitedClaims: '不得增加价格、销量、奖项、功效或其他未经包装图确认的数据',
      durationSeconds: '30秒',
      aspectRatio: '9:16（竖屏）'
    },
    materials: [
      { id: 'brand-image', name: path.basename(BRAND_IMAGE), kind: 'image', size: fs.statSync(BRAND_IMAGE).size },
      { id: 'brand-report', name: path.basename(BRAND_REPORT), kind: 'text', size: fs.statSync(BRAND_REPORT).size }
    ],
    scriptReview: {},
    events: [],
    laterAddedCanvasFeature: { preserved: true }
  };
  const saveRun = run => {
    storedRun = clone(run);
    storedRun.scriptReview = normalizeScriptReview(storedRun.scriptReview);
    return clone(storedRun);
  };
  const loadRun = runId => runId === storedRun.id ? clone(storedRun) : null;
  const scriptVersions = createAgentScriptVersionService({ projectRoot, loadRun, saveRun });
  return {
    root,
    projectDir,
    runId: storedRun.id,
    loadRun,
    saveRun,
    scriptVersions,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

test('authorized brand completes the real Stage 2 API lifecycle without paid model calls', async () => {
  const fixture = createBrandFixture();
  let generationMode = 'success';
  let generatedPrompt = '';
  let generationStarted = null;
  let signalGenerationStarted;
  const generationStartedPromise = () => {
    if (!generationStarted) generationStarted = new Promise(resolve => { signalGenerationStarted = resolve; });
    return generationStarted;
  };
  const selection = {
    provider: { id: 'controlled-test-provider', api_key: 'TEST_SECRET_MUST_NOT_LEAK' },
    publicState: {
      providerId: 'controlled-test-provider',
      providerName: '受控测试 Provider（不联网）',
      model: 'controlled-stage2-model',
      dataScopes: ['基准剧本', '产品事实锁', '勾选的修改范围'],
      excludedScopes: ['API Key', '故事数据库原文', '一键复色数据', '未核验网络卖点']
    }
  };
  const generateApprovedAgentStoryText = async (_selection, input) => {
    generatedPrompt = String(input.userPrompt || '');
    if (generationMode === 'cancel') {
      signalGenerationStarted?.();
      return new Promise((_resolve, reject) => {
        const abort = () => { const error = new Error('controlled cancellation'); error.name = 'AbortError'; reject(error); };
        if (input.signal?.aborted) abort();
        else input.signal?.addEventListener('abort', abort, { once: true });
      });
    }
    if (generationMode === 'fail') return { text: '# 不完整结果\n\n受控失败结果故意缺少已确认产品名称。' };
    return {
      text: [
        '# 德伦堡28天德式小麦鲜啤｜AI修订完整剧本',
        '',
        '0—3秒：冰箱灯亮起，两只手同时停在最后一罐前。',
        '4—18秒：两位朋友先对视再猜拳，镜头只呈现已确认的罐身与规格。',
        '19—27秒：胜者没有独享，而是拿出两个杯子一起分享。',
        '28—30秒：字幕“把新鲜留在相聚这一刻”，产品自然留在画面中心。',
        '',
        '事实锁：500ml，9°P，酒精度≥3.3%vol，保质期28天。'
      ].join('\n')
    };
  };
  const agentRunService = {
    loadRun: fixture.loadRun,
    scriptVersions: fixture.scriptVersions,
    runScriptSimilarityCheck: async () => ({ pass: true, maxSimilarity: 0.06 })
  };
  const router = createCanvasRoutes({
    legacyAgentRunMaintenance: 'test-only',
    agentRunService,
    agentStoryTextSelection: () => selection,
    generateApprovedAgentStoryText
  });

  try {
    await withServer(router, async baseUrl => {
      const runId = fixture.runId;
      const initialize = await request(baseUrl, `/api/canvas/agent-runs/${runId}/stages/microstory/review/initialize`, { method: 'POST', body: '{}' });
      assert.equal(initialize.status, 200);
      assert.equal(initialize.body.run.scriptReview.versions.length, 1);
      assert.equal(initialize.body.run.scriptReview.versions[0].id, 'script-v001');

      const v1 = await request(baseUrl, `/api/canvas/agent-runs/${runId}/stages/microstory/versions/script-v001`);
      assert.equal(v1.status, 200);
      assert.match(v1.body.content, /德伦堡28天德式小麦鲜啤/);
      const v1Path = path.join(fixture.projectDir, 'story', 'versions', 'script-v001.md');
      const v1Bytes = fs.readFileSync(v1Path);

      const manualText = v1.body.content.replace('动作停住', '镜头定格半秒').replace('猜拳决定归属', '用杯子数量制造误会后再一起分享');
      const manual = await request(baseUrl, `/api/canvas/agent-runs/${runId}/stages/microstory/versions/manual`, {
        method: 'POST',
        body: JSON.stringify({ baseVersionId: 'script-v001', content: manualText, operationId: 'derenburg-manual-v2' })
      });
      assert.equal(manual.status, 200);
      assert.equal(manual.body.run.scriptReview.versions.at(-1).id, 'script-v002');
      assert.deepEqual(fs.readFileSync(v1Path), v1Bytes, 'manual revision must not mutate V1');

      const diff = await request(baseUrl, `/api/canvas/agent-runs/${runId}/stages/microstory/versions/script-v001/diff/script-v002`);
      assert.equal(diff.status, 200);
      assert(diff.body.diff.addedLines > 0);
      assert(diff.body.diff.removedLines > 0);

      const preflight = await request(baseUrl, `/api/canvas/agent-runs/${runId}/stages/microstory/versions/script-v002/revise/preflight?changeScopes=hook,product-placement,ending`);
      assert.equal(preflight.status, 200);
      assert.deepEqual(preflight.body.selection.changeScopes, ['hook', 'product-placement', 'ending']);
      assert.equal(JSON.stringify(preflight.body).includes('TEST_SECRET_MUST_NOT_LEAK'), false);

      generationMode = 'cancel';
      const cancelReady = generationStartedPromise();
      const revisePromise = request(baseUrl, `/api/canvas/agent-runs/${runId}/stages/microstory/versions/script-v002/revise`, {
        method: 'POST',
        body: JSON.stringify({
          changeScopes: ['hook'], operationId: 'derenburg-cancelled-revision',
          approval: { approved: true, providerId: selection.publicState.providerId, model: selection.publicState.model, changeScopes: ['hook'], excludedScopes: selection.publicState.excludedScopes }
        })
      });
      await cancelReady;
      const running = await request(baseUrl, `/api/canvas/agent-runs/${runId}/stages/microstory/versions`);
      const runningAttempt = running.body.attempts.find(item => item.operationId === 'derenburg-cancelled-revision');
      assert.equal(runningAttempt.status, 'running');
      const cancelled = await request(baseUrl, `/api/canvas/agent-runs/${runId}/stages/microstory/revision-attempts/${runningAttempt.id}/cancel`, { method: 'POST', body: '{}' });
      assert.equal(cancelled.status, 200);
      await revisePromise;
      assert.equal(fixture.loadRun(runId).scriptReview.attempts.find(item => item.id === runningAttempt.id).status, 'cancelled');
      assert.equal(fixture.loadRun(runId).scriptReview.versions.length, 2, 'cancelled AI work must not create a version');

      generationMode = 'fail';
      const failed = await request(baseUrl, `/api/canvas/agent-runs/${runId}/stages/microstory/versions/script-v002/revise`, {
        method: 'POST',
        body: JSON.stringify({
          changeScopes: ['dialogue'], operationId: 'derenburg-failed-revision',
          approval: { approved: true, providerId: selection.publicState.providerId, model: selection.publicState.model, changeScopes: ['dialogue'], excludedScopes: selection.publicState.excludedScopes }
        })
      });
      assert.equal(failed.status, 200);
      assert.equal(failed.body.run.scriptReview.attempts.at(-1).status, 'failed');
      assert.equal(failed.body.run.scriptReview.versions.length, 2, 'failed AI work must not create a version');

      generationMode = 'success';
      const revised = await request(baseUrl, `/api/canvas/agent-runs/${runId}/stages/microstory/versions/script-v002/revise`, {
        method: 'POST',
        body: JSON.stringify({
          changeScopes: ['hook', 'product-placement', 'ending'], operationId: 'derenburg-ai-v3',
          approval: { approved: true, providerId: selection.publicState.providerId, model: selection.publicState.model, changeScopes: ['hook', 'product-placement', 'ending'], excludedScopes: selection.publicState.excludedScopes }
        })
      });
      assert.equal(revised.status, 200);
      assert.equal(revised.body.run.scriptReview.versions.at(-1).id, 'script-v003');
      assert.equal(revised.body.run.scriptReview.versions.at(-1).source, 'ai-revision');
      assert.match(generatedPrompt, /500ml/);
      assert.match(generatedPrompt, /不得增加价格、销量、奖项/);
      assert.equal(generatedPrompt.includes('TEST_SECRET_MUST_NOT_LEAK'), false);
      assert.equal(generatedPrompt.includes('一键复色'), false);

      const v3 = await request(baseUrl, `/api/canvas/agent-runs/${runId}/stages/microstory/versions/script-v003`);
      assert.equal(v3.status, 200);
      assert.match(v3.body.content, /德伦堡28天德式小麦鲜啤/);
      assert.doesNotMatch(v3.body.content, /价格|销量|奖项|治疗|冠军/);

      const approved = await request(baseUrl, `/api/canvas/agent-runs/${runId}/stages/microstory/versions/script-v003/approve`, { method: 'POST', body: '{}' });
      assert.equal(approved.status, 200);
      assert.equal(approved.body.run.scriptReview.approvedVersionId, 'script-v003');
      const locked = await request(baseUrl, `/api/canvas/agent-runs/${runId}/stages/microstory/versions/script-v003/lock`, { method: 'POST', body: '{}' });
      assert.equal(locked.status, 200);
      assert.equal(locked.body.run.scriptReview.lockedVersionId, 'script-v003');
      assert.equal(hasLockedScript(locked.body.run), true);
      assert.deepEqual(locked.body.run.laterAddedCanvasFeature, { preserved: true });

      const lockPointer = JSON.parse(fs.readFileSync(path.join(fixture.projectDir, 'story', 'locked-script.json'), 'utf8'));
      assert.equal(lockPointer.versionId, 'script-v003');
      assert.equal(lockPointer.contentHash, locked.body.run.scriptReview.versions.find(item => item.id === 'script-v003').contentHash);

      const refreshed = await request(baseUrl, `/api/canvas/agent-runs/${runId}/stages/microstory/versions`);
      assert.equal(refreshed.status, 200);
      assert.equal(refreshed.body.versions.length, 3);
      assert.deepEqual(refreshed.body.attempts.map(item => item.status), ['cancelled', 'failed', 'completed']);
      assert.equal(refreshed.body.lockedVersionId, 'script-v003');
    });

    const restartingService = createAgentScriptVersionService({
      projectRoot: path.dirname(fixture.projectDir),
      loadRun: fixture.loadRun,
      saveRun: fixture.saveRun
    });
    const restarted = restartingService.reconcileVersionFiles(fixture.loadRun(fixture.runId));
    fixture.saveRun(restarted);
    const afterRestart = fixture.loadRun(fixture.runId);
    assert.equal(afterRestart.scriptReview.versions.length, 3);
    assert.equal(afterRestart.scriptReview.lockedVersionId, 'script-v003');
    assert.equal(hasLockedScript(afterRestart), true);
    assert.equal(fs.existsSync(BRAND_IMAGE), true, 'source brand image must remain untouched');
    assert.equal(fs.existsSync(BRAND_REPORT), true, 'source brand report must remain untouched');
  } finally {
    fixture.cleanup();
  }
});
