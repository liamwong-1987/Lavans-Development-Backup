const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const createTaskService = require('../services/taskService');
const createTaskRunner = require('../services/taskRunner');
const apiClient = require('../apiClient');

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lanvas-recolor-stage-b-'));
  const dir = path.join(root, 'batch_test');
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'attempts'), { recursive: true });
  return { root, dir };
}

function makeBatch(taskOverrides = {}) {
  const task = {
    id: 'task-1',
    order: 1,
    templatePath: 'template.png',
    colorPath: 'color.png',
    templateNameWithoutExt: '模板',
    colorNameWithoutExt: '森林绿',
    executionStatus: 'pending',
    runtimeStatus: null,
    qualityStatus: 'review_required',
    apiAttempts: 0,
    costFen: 0,
    resultVersion: 0,
    costPerCallFenSnapshot: 8,
    ...taskOverrides
  };
  return {
    batchId: 'batch_test',
    status: 'running',
    active: true,
    cancelRequested: false,
    concurrency: 1,
    promptSnapshot: '只进行颜色替换',
    imageSizeSnapshot: '1024x1024',
    qualitySnapshot: 'low',
    providerIdSnapshot: '',
    modelSnapshot: 'test-image-model',
    costPerCallFenSnapshot: 8,
    tasks: [task]
  };
}

function makeStore(dir) {
  const saves = [];
  return {
    saves,
    batchDir: () => dir,
    saveBatch(batch) {
      saves.push(JSON.parse(JSON.stringify(batch)));
      return batch;
    }
  };
}

function makeService(dir, apiClientOverride, extra = {}) {
  const batchStore = makeStore(dir);
  const service = createTaskService({
    batchStore,
    apiClient: apiClientOverride,
    safeFileStem: value => String(value || 'image').replace(/[^\w\u4e00-\u9fa5-]+/g, '_'),
    now: () => new Date().toISOString(),
    errorMessage: error => error?.message || '未知错误',
    ...extra
  });
  return { service, batchStore };
}

async function onePixelPng() {
  return sharp({ create: { width: 2, height: 2, channels: 3, background: '#566e51' } }).png().toBuffer();
}

test('一次任务只提交一次，成功图片验证后原子成为正式结果', async t => {
  const { root, dir } = makeWorkspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const png = await onePixelPng();
  let submissions = 0;
  const fakeApi = {
    async editImage(options) {
      submissions++;
      await options.onGenerationAttempt({});
      return { success: true, type: 'base64', data: png.toString('base64') };
    },
    async downloadUrl() { throw new Error('不应下载 URL'); }
  };
  const { service } = makeService(dir, fakeApi, {
    qcEngine: { runQC() { throw new Error('不得调用 QC'); } },
    colorEngine: { protectOutsideMask() { throw new Error('不得调用 Mask'); } }
  });
  const batch = makeBatch();

  await service.processTask(batch, batch.tasks[0], new AbortController());

  const task = batch.tasks[0];
  assert.equal(submissions, 1);
  assert.equal(task.apiAttempts, 1);
  assert.equal(task.costFen, 8);
  assert.equal(task.executionStatus, 'completed');
  assert.equal(task.qualityStatus, 'review_required');
  assert.equal(task.correctionRounds, 0);
  assert.equal(task.resultVersion, 1);
  const outputPath = path.join(dir, task.output);
  assert.ok(fs.existsSync(outputPath));
  assert.equal((await sharp(outputPath).metadata()).format, 'jpeg');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'attempts')), []);
});

test('请求发出前的本地失败不计调用和费用', async t => {
  const { root, dir } = makeWorkspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fakeApi = {
    async editImage() { throw new Error('模板图不存在'); },
    async downloadUrl() { throw new Error('不应调用'); }
  };
  const { service } = makeService(dir, fakeApi);
  const batch = makeBatch();

  await service.processTask(batch, batch.tasks[0], new AbortController());

  assert.equal(batch.tasks[0].executionStatus, 'error');
  assert.equal(batch.tasks[0].generationSubmissionState, 'not_submitted');
  assert.equal(batch.tasks[0].apiAttempts, 0);
  assert.equal(batch.tasks[0].costFen, 0);
});

test('远端明确失败只记一次，不自动重发', async t => {
  const { root, dir } = makeWorkspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let submissions = 0;
  const fakeApi = {
    async editImage(options) {
      submissions++;
      await options.onGenerationAttempt({});
      throw new Error('模型明确拒绝了请求');
    },
    async downloadUrl() { throw new Error('不应调用'); }
  };
  const { service } = makeService(dir, fakeApi);
  const batch = makeBatch();

  await service.processTask(batch, batch.tasks[0], new AbortController());

  assert.equal(submissions, 1);
  assert.equal(batch.tasks[0].executionStatus, 'error');
  assert.equal(batch.tasks[0].apiAttempts, 1);
  assert.equal(batch.tasks[0].costFen, 8);
  assert.equal(batch.systemPauseRequested, undefined);
});

test('远端结果未知时暂停且再次调用服务也不会重新提交', async t => {
  const { root, dir } = makeWorkspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let submissions = 0;
  const fakeApi = {
    async editImage(options) {
      submissions++;
      await options.onGenerationAttempt({ providerTaskId: 'remote-123' });
      const error = new Error('连接在提交后断开');
      error.remoteResultUnknown = true;
      error.providerTaskId = 'remote-123';
      throw error;
    },
    async downloadUrl() { throw new Error('不应调用'); }
  };
  const { service } = makeService(dir, fakeApi);
  const batch = makeBatch();
  const controller = new AbortController();

  await service.processTask(batch, batch.tasks[0], controller);
  await service.processTask(batch, batch.tasks[0], controller);

  const task = batch.tasks[0];
  assert.equal(submissions, 1);
  assert.equal(task.executionStatus, 'interrupted');
  assert.equal(task.runtimeStatus, 'remote_unknown');
  assert.equal(task.providerTaskId, 'remote-123');
  assert.equal(task.apiAttempts, 1);
  assert.equal(task.costFen, 8);
  assert.equal(batch.systemPauseRequested, true);
  assert.equal(batch.pauseReason, 'remote_unknown');
});

test('图片落盘失败保留旧结果，同时保留真实调用和费用', async t => {
  const { root, dir } = makeWorkspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const png = await onePixelPng();
  const oldRel = 'images/old-result.jpg';
  fs.writeFileSync(path.join(dir, oldRel), Buffer.from('old-result'));
  let submissions = 0;
  const fakeApi = {
    async editImage(options) {
      submissions++;
      await options.onGenerationAttempt({});
      return { success: true, type: 'base64', data: png.toString('base64') };
    },
    async downloadUrl() { throw new Error('不应调用'); }
  };
  const { service } = makeService(dir, fakeApi, {
    async resultWriter() { throw new Error('模拟磁盘写入失败'); }
  });
  const batch = makeBatch({ output: oldRel, resultVersion: 1 });

  await service.processTask(batch, batch.tasks[0], new AbortController());

  assert.equal(submissions, 1);
  assert.equal(batch.tasks[0].apiAttempts, 1);
  assert.equal(batch.tasks[0].costFen, 8);
  assert.equal(batch.tasks[0].executionStatus, 'error');
  assert.equal(batch.tasks[0].output, oldRel);
  assert.equal(fs.readFileSync(path.join(dir, oldRel), 'utf8'), 'old-result');
});

test('生成客户端不自动重试，并区分明确拒绝与远端未知', async t => {
  const { root } = makeWorkspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const png = await onePixelPng();
  const templatePath = path.join(root, 'template.png');
  const colorPath = path.join(root, 'color.png');
  fs.writeFileSync(templatePath, png);
  fs.writeFileSync(colorPath, png);
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  const scenarios = [
    { status: 400, unknown: false },
    { status: 500, unknown: true },
    { transport: true, unknown: true }
  ];

  for (const scenario of scenarios) {
    let posts = 0;
    let recorded = 0;
    global.fetch = async () => {
      posts++;
      if (scenario.transport) throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
      return {
        ok: false,
        status: scenario.status,
        async json() { return { error: { message: `HTTP ${scenario.status}` } }; }
      };
    };

    await assert.rejects(
      apiClient.editImage({
        imagePath: templatePath,
        colorImagePath: colorPath,
        prompt: '只复色',
        size: '1024x1024',
        model: 'test-image-model',
        onGenerationAttempt() { recorded++; }
      }),
      error => error.remoteResultUnknown === scenario.unknown
    );
    assert.equal(posts, 1);
    assert.equal(recorded, 1);
  }
});

test('Runner 收到远端未知暂停信号后不再领取后续任务', async () => {
  const batch = makeBatch();
  batch.tasks.push({ ...batch.tasks[0], id: 'task-2', order: 2, executionStatus: 'pending' });
  const batchStore = {
    loadBatch: () => batch,
    saveBatch: value => value
  };
  const runner = createTaskRunner({ batchStore, now: () => new Date().toISOString() });
  const claimed = [];
  runner.injectTaskService({
    async processTask(currentBatch, task) {
      claimed.push(task.id);
      task.executionStatus = 'interrupted';
      task.runtimeStatus = 'remote_unknown';
      currentBatch.systemPauseRequested = true;
      currentBatch.pauseReason = 'remote_unknown';
    }
  });

  await runner.start(batch.batchId);

  assert.deepEqual(claimed, ['task-1']);
  assert.equal(batch.tasks[1].executionStatus, 'pending');
  assert.equal(batch.status, 'paused');
  assert.equal(batch.active, false);
});
