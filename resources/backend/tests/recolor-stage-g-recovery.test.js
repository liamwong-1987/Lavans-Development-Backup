const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const createTaskService = require('../services/taskService');
const createRecolorHealthService = require('../services/recolorHealthService');
const apiClient = require('../apiClient');

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function baseTask(overrides = {}) {
  return {
    id: 'task-1', order: 1, templatePath: 'template.png', colorPath: 'color.png',
    templateNameWithoutExt: '模板', colorNameWithoutExt: '森林绿',
    executionStatus: 'pending', runtimeStatus: null, generationSubmissionState: 'not_submitted',
    qualityStatus: 'review_required', apiAttempts: 0, costFen: 0, resultVersion: 0,
    costPerCallFenSnapshot: 8, ...overrides
  };
}

function baseBatch(task, overrides = {}) {
  return {
    batchId: 'batch-stage-g-recovery', status: 'running', active: true,
    cancelRequested: false, userPauseRequested: false, systemPauseRequested: false,
    promptSnapshot: '只进行颜色替换', imageSizeSnapshot: '1024x1024',
    qualitySnapshot: 'low', providerIdSnapshot: '', modelSnapshot: 'test-model',
    costPerCallFenSnapshot: 8, tasks: [task], ...overrides
  };
}

function memoryStore(initial) {
  let current = clone(initial);
  return {
    loadBatch(id) { return id === current.batchId ? clone(current) : null; },
    saveBatch(batch) { current = clone(batch); return batch; },
    snapshot() { return clone(current); }
  };
}

test('全局 API 配置异常立即暂停整批，不再继续领取新任务', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lanvas-stage-g-global-error-'));
  fs.mkdirSync(path.join(root, 'images'), { recursive: true });
  fs.mkdirSync(path.join(root, 'attempts'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const batch = baseBatch(baseTask());
  let pauses = 0;
  const service = createTaskService({
    batchStore: { batchDir: () => root, saveBatch(value) { return value; } },
    apiClient: {
      async editImage(options) {
        await options.onGenerationAttempt({});
        const error = new Error('密钥无效');
        error.globalApiError = true;
        throw error;
      },
      async downloadUrl() { throw new Error('不应下载'); }
    },
    safeFileStem: value => String(value),
    now: () => new Date().toISOString(),
    errorMessage: error => error.message,
    onSystemPause() { pauses++; }
  });

  await service.processTask(batch, batch.tasks[0], new AbortController());

  assert.equal(pauses, 1);
  assert.equal(batch.systemPauseRequested, true);
  assert.equal(batch.pauseReason, 'global_api_error');
  assert.equal(batch.tasks[0].executionStatus, 'interrupted');
  assert.equal(batch.tasks[0].runtimeStatus, 'system_error');
  assert.equal(batch.tasks[0].apiAttempts, 1);
  assert.equal(batch.tasks[0].costFen, 8);
});

test('免费健康检查必须连续成功两次才自动续跑', async () => {
  const store = memoryStore(baseBatch(baseTask({
    executionStatus: 'interrupted', runtimeStatus: 'system_error', generationSubmissionState: 'failed', error: '密钥异常'
  }), {
    status: 'pausing', active: false, systemPauseRequested: true, pauseReason: 'global_api_error', healthCheckConsecutive: 0
  }));
  const healthResults = [
    { success: false, error: '仍未恢复' },
    { success: true },
    { success: true }
  ];
  let resumes = 0;
  const service = createRecolorHealthService({
    batchStore: store,
    apiClient: { async checkHealth() { return healthResults.shift(); } },
    taskRunner: { async resume() { resumes++; } },
    requiredSuccesses: 2
  });

  assert.equal((await service.checkNow('batch-stage-g-recovery')).consecutive, 0);
  const firstSuccess = await service.checkNow('batch-stage-g-recovery');
  assert.equal(firstSuccess.ready, false);
  assert.equal(firstSuccess.consecutive, 1);
  assert.equal(resumes, 0);
  const recovered = await service.checkNow('batch-stage-g-recovery');
  assert.equal(recovered.ready, true);
  assert.equal(recovered.resumed, 1);
  assert.equal(resumes, 1);
  const batch = store.snapshot();
  assert.equal(batch.systemPauseRequested, false);
  assert.equal(batch.tasks[0].executionStatus, 'pending');
  assert.equal(batch.tasks[0].runtimeStatus, null);
});

test('远端结果不明时只查询不重复生成，明确失败后才解除未知状态', async () => {
  const store = memoryStore(baseBatch(baseTask({
    executionStatus: 'interrupted', runtimeStatus: 'remote_unknown', generationSubmissionState: 'submitted', providerTaskId: 'remote-1'
  }), { status: 'pausing', active: false, systemPauseRequested: true, pauseReason: 'remote_unknown' }));
  let queryCount = 0;
  let generationCount = 0;
  const client = {
    async checkHealth() { return { success: true }; },
    async editImage() { generationCount++; throw new Error('绝不应重复生成'); },
    async queryGenerationResult() {
      queryCount++;
      return queryCount === 1
        ? { status: 'unknown', error: '仍在确认' }
        : { status: 'failed', error: '服务商已确认失败' };
    }
  };
  const service = createRecolorHealthService({
    batchStore: store, apiClient: client, taskRunner: { async resume() {} }
  });

  const unresolved = await service.resolveRemoteUnknown('batch-stage-g-recovery');
  assert.equal(unresolved.remaining, 1);
  assert.equal(store.snapshot().tasks[0].runtimeStatus, 'remote_unknown');
  const resolved = await service.resolveRemoteUnknown('batch-stage-g-recovery');
  assert.equal(resolved.remaining, 0);
  assert.equal(store.snapshot().tasks[0].executionStatus, 'error');
  assert.equal(generationCount, 0);
});

test('全局异常识别覆盖密钥、余额、模型和接口地址', () => {
  for (const message of [
    'API key invalid', '余额不足', '模型不存在', '生成接口地址无效，请检查全局 API 设置'
  ]) assert.equal(apiClient.__test.isGlobalGenerationError(new Error(message)), true);
});
