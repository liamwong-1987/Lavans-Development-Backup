const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const createTaskRunner = require('../services/taskRunner');
const createTaskService = require('../services/taskService');
const apiClient = require('../apiClient');

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function task(id, order, overrides = {}) {
  return {
    id,
    order,
    queueSequence: order,
    queueAttempt: 0,
    queuedAt: `2026-08-23T00:00:0${order}.000Z`,
    executionStatus: 'pending',
    runtimeStatus: null,
    generationSubmissionState: 'not_submitted',
    providerIdSnapshot: 'old-provider',
    modelSnapshot: 'old-model',
    promptSnapshot: '只改变颜色',
    imageSizeSnapshot: '1024x1024',
    qualitySnapshot: 'low',
    costPerCallFenSnapshot: 8,
    apiAttempts: 0,
    costFen: 0,
    hiddenInTaskList: false,
    ...overrides
  };
}

function batch(tasks, overrides = {}) {
  return {
    batchId: 'batch_structural_blockers',
    status: 'paused',
    active: false,
    userPauseRequested: false,
    systemPauseRequested: true,
    pauseReason: 'model_unavailable',
    providerIdSnapshot: 'old-provider',
    modelSnapshot: 'old-model',
    costPerCallFenSnapshot: 8,
    bindingRevision: 0,
    tasks,
    ...overrides
  };
}

function memoryStore(initial) {
  let current = clone(initial);
  let failNextSave = false;
  return {
    loadBatch(id) { return id === current.batchId ? clone(current) : null; },
    saveBatch(value) {
      if (failNextSave) {
        failNextSave = false;
        throw new Error('模拟原子保存失败');
      }
      current = clone(value);
      return value;
    },
    snapshot() { return clone(current); },
    failNextSave() { failNextSave = true; }
  };
}

function rebindCommand(preview, overrides = {}) {
  return {
    requestId: '3d5df88a-4668-4e9d-87b7-5c8c3a14d6ad',
    previewToken: preview.previewToken,
    from: { providerId: 'old-provider', model: 'old-model' },
    to: { providerId: 'new-provider', model: 'new-model' },
    pricing: { mode: 'keep-current-estimate' },
    ...overrides
  };
}

test('暂停批次追加任务不得自动请求恢复', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'app.js'), 'utf8');
  assert.doesNotMatch(source, /resumeAfterAppend\s*:\s*true/);
  assert.doesNotMatch(source, /暂停追加成功[\s\S]{0,500}\/resume/);
});

test('正式暂停、空态和改绑入口只在主界面原位呈现', () => {
  const frontend = path.join(__dirname, '..', '..', 'frontend');
  const source = fs.readFileSync(path.join(frontend, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(frontend, 'recolor.html'), 'utf8');
  const css = fs.readFileSync(path.join(frontend, 'lanvas-recolor-v3.css'), 'utf8');
  const empty = html.match(/<div class="task-table-empty"[\s\S]*?<\/div>\s*<\/div>/)?.[0] || '';
  assert.match(html, /id="recolor-pause-banner"/);
  assert.match(html, /id="recolor-pause-rebind"[^>]+openPendingModelRebind/);
  assert.match(empty, /两类素材齐备后自动建立任务/);
  assert.doesNotMatch(empty, /扫描配对/);
  assert.match(source, /function openPendingModelRebind\(\)/);
  assert.match(source, /selectionRequired|rebind-pricing-mode/);
  assert.doesNotMatch(source, /value="(?:keep-current-estimate|replace-estimate)"\s+checked/);
  assert.match(source, /data-safe-focus[^>]*>继续保持暂停/);
  assert.match(css, /\.recolor-pause-banner/);
  assert.match(css, /\.task-table-empty\s*\{[\s\S]*?border:\s*1px dashed[\s\S]*?border-radius:\s*18px/);
  assert.match(css, /\.recolor-workbench-modal\.scene-rebind/);
});

test('改绑预览只选中零调用零费用且未领取未提交的等待任务', () => {
  const store = memoryStore(batch([
    task('eligible', 1),
    task('paid', 2, { apiAttempts: 1, costFen: 8 }),
    task('running', 3, { executionStatus: 'running', runtimeStatus: 'claimed' }),
    task('submitted', 4, { executionStatus: 'interrupted', runtimeStatus: 'remote_unknown', generationSubmissionState: 'submitted' }),
    task('completed', 5, { executionStatus: 'completed', output: 'images/done.png' }),
    task('deleted', 6, { hiddenInTaskList: true, deletedAt: '2026-08-23T00:01:00.000Z' }),
    task('other-model', 7, { modelSnapshot: 'another-model' })
  ]));
  const runner = createTaskRunner({ batchStore: store, now: () => '2026-08-23T00:02:00.000Z' });

  const preview = runner.previewPendingModelRebind('batch_structural_blockers', {
    from: { providerId: 'old-provider', model: 'old-model' },
    to: { providerId: 'new-provider', model: 'new-model' }
  });

  assert.deepEqual(preview.eligibleTaskIds, ['eligible']);
  assert.equal(preview.eligibleCount, 1);
  assert.equal(preview.protectedCount, 6);
  assert.equal(preview.canResume, false);
  assert.match(preview.previewToken, /^[a-f0-9]{64}$/);
});

test('预览后任务被 Runner 领取时整批改绑返回过期且零修改', async () => {
  const store = memoryStore(batch([task('a', 1), task('b', 2)], {
    status: 'paused', systemPauseRequested: false, userPauseRequested: true
  }));
  const runner = createTaskRunner({
    batchStore: store,
    now: () => '2026-08-23T00:02:00.000Z',
    minConcurrency: 1,
    sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 5)))
  });
  const preview = runner.previewPendingModelRebind('batch_structural_blockers', {
    from: { providerId: 'old-provider', model: 'old-model' },
    to: { providerId: 'new-provider', model: 'new-model' }
  });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  runner.injectTaskService({
    async processTask(currentBatch, currentTask) {
      await gate;
      currentTask.executionStatus = 'completed';
      currentTask.runtimeStatus = null;
      currentTask.output = `images/${currentTask.id}.png`;
      store.saveBatch(currentBatch);
    }
  });
  const resumed = store.loadBatch('batch_structural_blockers');
  resumed.userPauseRequested = false;
  resumed.status = 'running';
  resumed.active = true;
  store.saveBatch(resumed);
  const running = runner.start('batch_structural_blockers');
  for (let index = 0; index < 50 && !runner.getRunner('batch_structural_blockers')?.active.size; index++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }

  assert.throws(
    () => runner.rebindPendingTasks('batch_structural_blockers', rebindCommand(preview)),
    error => error && error.code === 'REBIND_PREVIEW_STALE'
  );
  assert.equal(runner.getRunner('batch_structural_blockers').batch.tasks.find(item => item.id === 'b').modelSnapshot, 'old-model');
  release();
  await running;
});

test('原子改绑保持 FIFO 和业务快照，重复 requestId 只回放一次', () => {
  const initial = batch([task('a', 1), task('b', 2)]);
  const store = memoryStore(initial);
  const runner = createTaskRunner({ batchStore: store, now: () => '2026-08-23T00:02:00.000Z' });
  const preview = runner.previewPendingModelRebind('batch_structural_blockers', {
    from: { providerId: 'old-provider', model: 'old-model' },
    to: { providerId: 'new-provider', model: 'new-model' }
  });
  const before = store.snapshot();

  const first = runner.rebindPendingTasks('batch_structural_blockers', rebindCommand(preview));
  const replay = runner.rebindPendingTasks('batch_structural_blockers', rebindCommand(preview));
  const after = store.snapshot();

  assert.equal(first.updatedCount, 2);
  assert.equal(first.remainsPaused, true);
  assert.equal(replay.replayed, true);
  assert.equal(after.bindingRevision, 1);
  assert.deepEqual(after.tasks.map(item => item.modelSnapshot), ['new-model', 'new-model']);
  for (const field of ['order', 'queueSequence', 'queueAttempt', 'queuedAt', 'promptSnapshot', 'imageSizeSnapshot', 'qualitySnapshot', 'apiAttempts', 'costFen']) {
    assert.deepEqual(after.tasks.map(item => item[field]), before.tasks.map(item => item[field]), field);
  }
  assert.equal(after.status, 'paused');
  assert.equal(after.active, false);
});

test('保存失败必须恢复 Runner 内存中的旧绑定', async () => {
  const store = memoryStore(batch([task('active', 1), task('waiting', 2)], {
    status: 'running', active: true, systemPauseRequested: false, concurrency: 1
  }));
  const runner = createTaskRunner({
    batchStore: store,
    now: () => '2026-08-23T00:02:00.000Z',
    minConcurrency: 1,
    sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 5)))
  });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  runner.injectTaskService({
    async processTask(currentBatch, currentTask) {
      await gate;
      currentTask.executionStatus = 'completed';
      currentTask.runtimeStatus = null;
      currentTask.output = `images/${currentTask.id}.png`;
      store.saveBatch(currentBatch);
    }
  });
  const running = runner.start('batch_structural_blockers');
  for (let index = 0; index < 50 && !runner.getRunner('batch_structural_blockers')?.active.size; index++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const preview = runner.previewPendingModelRebind('batch_structural_blockers', {
    from: { providerId: 'old-provider', model: 'old-model' },
    to: { providerId: 'new-provider', model: 'new-model' }
  });
  store.failNextSave();

  assert.throws(() => runner.rebindPendingTasks('batch_structural_blockers', rebindCommand(preview)), /模拟原子保存失败/);
  assert.equal(runner.getRunner('batch_structural_blockers').batch.tasks.find(item => item.id === 'waiting').modelSnapshot, 'old-model');
  release();
  await running;
});

test('明确模型不可用错误与其他全局 API 错误分型', async t => {
  assert.equal(apiClient.__test.isModelUnavailableError(new Error('模型不存在')), true);
  assert.equal(apiClient.__test.isModelUnavailableError(new Error('API key invalid')), false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lanvas-rebind-model-unavailable-'));
  fs.mkdirSync(path.join(root, 'images'), { recursive: true });
  fs.mkdirSync(path.join(root, 'attempts'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const current = batch([task('model-error', 1)], { status: 'running', active: true, systemPauseRequested: false, pauseReason: null });
  let healthWatches = 0;
  const service = createTaskService({
    batchStore: { batchDir: () => root, saveBatch(value) { return value; } },
    apiClient: {
      async editImage(options) {
        await options.onGenerationAttempt({});
        const error = new Error('模型不存在');
        error.globalApiError = true;
        error.modelUnavailable = true;
        throw error;
      },
      async downloadUrl() { throw new Error('不应下载'); }
    },
    safeFileStem: value => String(value),
    now: () => '2026-08-23T00:02:00.000Z',
    errorMessage: error => error.message,
    onSystemPause() { healthWatches++; }
  });

  await service.processTask(current, current.tasks[0], new AbortController());

  assert.equal(current.pauseReason, 'model_unavailable');
  assert.equal(current.tasks[0].executionStatus, 'error');
  assert.equal(current.tasks[0].runtimeStatus, null);
  assert.equal(current.tasks[0].generationSubmissionState, 'failed');
  assert.equal(current.tasks[0].apiAttempts, 1);
  assert.equal(current.tasks[0].costFen, 8);
  assert.doesNotMatch(current.tasks[0].error, /模型不存在/);
  assert.deepEqual(current.unavailableBinding, {
    providerId: 'old-provider',
    model: 'old-model',
    detectedAt: '2026-08-23T00:02:00.000Z'
  });
  assert.equal(healthWatches, 0);

  const unsubmitted = batch([task('model-error-before-submit', 1)], { status: 'running', active: true, systemPauseRequested: false, pauseReason: null });
  const safeService = createTaskService({
    batchStore: { batchDir: () => root, saveBatch(value) { return value; } },
    apiClient: {
      async editImage() {
        const error = new Error('模型已停用');
        error.globalApiError = true;
        error.modelUnavailable = true;
        throw error;
      },
      async downloadUrl() { throw new Error('不应下载'); }
    },
    safeFileStem: value => String(value),
    now: () => '2026-08-23T00:03:00.000Z',
    errorMessage: error => error.message,
    onSystemPause() { healthWatches++; }
  });
  await safeService.processTask(unsubmitted, unsubmitted.tasks[0], new AbortController());
  assert.equal(unsubmitted.tasks[0].executionStatus, 'pending');
  assert.equal(unsubmitted.tasks[0].runtimeStatus, null);
  assert.equal(unsubmitted.tasks[0].generationSubmissionState, 'not_submitted');
  assert.equal(unsubmitted.tasks[0].apiAttempts, 0);
  assert.equal(unsubmitted.tasks[0].costFen, 0);
  assert.equal(unsubmitted.tasks[0].error, null);
});
