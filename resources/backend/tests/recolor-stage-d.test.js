const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const createTaskService = require('../services/taskService');
const createTaskRunner = require('../services/taskRunner');
const createResultService = require('../services/recolorResultService');

const clone = value => JSON.parse(JSON.stringify(value));

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lanvas-recolor-stage-d-'));
  const dir = path.join(root, 'batch_stage_d');
  for (const relative of ['images', 'attempts', 'inputs/templates', 'inputs/colors']) {
    fs.mkdirSync(path.join(dir, relative), { recursive: true });
  }
  return { root, dir };
}

function task(id, overrides = {}) {
  return {
    id,
    order: 1,
    queueSequence: 1,
    queueAttempt: 0,
    queuedAt: '2026-08-22T00:00:00.000Z',
    template: '模板.png',
    colorRef: '森林绿.png',
    templateNameWithoutExt: '模板',
    colorNameWithoutExt: '森林绿',
    executionStatus: 'completed',
    runtimeStatus: null,
    generationSubmissionState: 'resolved',
    qualityStatus: 'review_required',
    apiAttempts: 0,
    costFen: 0,
    resultVersion: 1,
    exportedAt: null,
    exportedResultVersion: 0,
    hiddenInTaskList: false,
    ...overrides
  };
}

function batch(tasks, overrides = {}) {
  return {
    batchId: 'batch_stage_d',
    status: 'completed',
    active: false,
    cancelRequested: false,
    userPauseRequested: false,
    systemPauseRequested: false,
    concurrency: 1,
    promptSnapshot: '只改变颜色',
    imageSizeSnapshot: '1024x1024',
    qualitySnapshot: 'low',
    providerIdSnapshot: '',
    modelSnapshot: 'test-image-model',
    costPerCallFenSnapshot: 8,
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
    tasks,
    ...overrides
  };
}

function memoryStore(initial, dir, { cloneOnRead = false } = {}) {
  let persisted = clone(initial);
  let saves = 0;
  return {
    batchDir() { return dir; },
    loadBatch() { return cloneOnRead ? clone(persisted) : persisted; },
    listBatches() { return [cloneOnRead ? clone(persisted) : persisted]; },
    saveBatch(value) { persisted = cloneOnRead ? clone(value) : value; saves++; return value; },
    current() { return clone(persisted); },
    saveCount() { return saves; }
  };
}

async function png(color = '#566e51') {
  return sharp({ create: { width: 3, height: 3, channels: 3, background: color } }).png().toBuffer();
}

function taskService(store, apiClient) {
  return createTaskService({
    batchStore: store,
    apiClient,
    safeFileStem: value => String(value || 'image').replace(/[^\w\u4e00-\u9fa5-]+/g, '_'),
    now: () => new Date().toISOString(),
    errorMessage: error => error?.message || '未知错误'
  });
}

function noTimers() {
  return {
    setTimer() { return { unref() {} }; },
    clearTimer() {}
  };
}

test('重做成功后才切换到新结果并删除旧图', async t => {
  const { root, dir } = workspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const oldRel = 'images/old_final.jpg';
  fs.writeFileSync(path.join(dir, oldRel), Buffer.from('old-result'));
  const current = batch([task('redo', {
    output: oldRel,
    resultVersion: 1,
    exportedAt: '2026-08-22T01:00:00.000Z',
    exportedResultVersion: 1
  })], { status: 'running', active: true });
  const store = memoryStore(current, dir);
  const image = await png('#b46b38');
  const service = taskService(store, {
    async editImage(options) {
      await options.onGenerationAttempt({});
      return { type: 'base64', data: image.toString('base64') };
    },
    async downloadUrl() { throw new Error('不应下载 URL'); }
  });

  await service.processTask(current, current.tasks[0], new AbortController());

  assert.notEqual(current.tasks[0].output, oldRel);
  assert.equal(current.tasks[0].resultVersion, 2);
  assert.equal(current.tasks[0].exportedAt, null);
  assert.equal(current.tasks[0].exportedResultVersion, 0);
  assert.equal(fs.existsSync(path.join(dir, oldRel)), false);
  assert.equal(fs.existsSync(path.join(dir, current.tasks[0].output)), true);
});

test('删除立即隐藏，5 秒内撤销会同时恢复任务和同一份历史结果', async t => {
  const { root, dir } = workspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const templatePath = path.join(dir, 'inputs', 'templates', 'template.png');
  const colorPath = path.join(dir, 'inputs', 'colors', 'color.png');
  const output = 'images/result_final.jpg';
  fs.writeFileSync(templatePath, await png());
  fs.writeFileSync(colorPath, await png('#b46b38'));
  fs.writeFileSync(path.join(dir, output), await png('#2c2926'));
  let time = Date.parse('2026-08-22T02:00:00.000Z');
  const current = batch([task('one', { templatePath, colorPath, output, referenceHex: '#B46B38', referenceColorLabel: '陶土橙' })]);
  const store = memoryStore(current, dir);
  const runners = { getRunner() { return null; }, start() { return Promise.resolve(); } };
  const service = createResultService({
    batchStore: store,
    runners,
    now: () => new Date(time).toISOString(),
    clock: () => time,
    ...noTimers()
  });

  assert.equal(service.listHistory().length, 1);
  assert.equal(service.listHistory()[0].referenceHex, '#B46B38');
  assert.equal(service.listHistory()[0].referenceColorLabel, '陶土橙');
  const deletion = service.requestDelete({ batchId: current.batchId, taskIds: ['one'] });
  assert.equal(deletion.count, 1);
  assert.equal(store.current().tasks[0].hiddenInTaskList, true);
  assert.equal(service.listHistory().length, 0);
  assert.equal(fs.existsSync(path.join(dir, output)), true);

  time += 4000;
  const restored = await service.undoDelete(deletion.token);
  assert.equal(restored.success, true);
  assert.equal(store.current().tasks[0].hiddenInTaskList, false);
  assert.equal(store.current().tasks[0].deleteToken, null);
  assert.equal(service.listHistory().length, 1);
  assert.equal(fs.existsSync(path.join(dir, output)), true);
});

test('正式删除只清当前结果，共享输入在最后一个引用删除后才清理', async t => {
  const { root, dir } = workspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const templatePath = path.join(dir, 'inputs', 'templates', 'shared.png');
  const colorPath = path.join(dir, 'inputs', 'colors', 'shared-color.png');
  fs.writeFileSync(templatePath, await png());
  fs.writeFileSync(colorPath, await png('#b46b38'));
  const firstOutput = 'images/first_final.jpg';
  const secondOutput = 'images/second_final.jpg';
  fs.writeFileSync(path.join(dir, firstOutput), await png('#333333'));
  fs.writeFileSync(path.join(dir, secondOutput), await png('#444444'));
  const current = batch([
    task('first', { order: 1, templatePath, colorPath, output: firstOutput }),
    task('second', { order: 2, queueSequence: 2, templatePath, colorPath, output: secondOutput })
  ]);
  const store = memoryStore(current, dir);
  const service = createResultService({ batchStore: store, runners: { getRunner() { return null; } }, ...noTimers() });

  const firstDelete = service.requestDelete({ batchId: current.batchId, taskIds: ['first'] });
  await service.finalizeDelete(firstDelete.token);
  assert.equal(fs.existsSync(path.join(dir, firstOutput)), false);
  assert.equal(fs.existsSync(templatePath), true);
  assert.equal(fs.existsSync(colorPath), true);
  assert.deepEqual(service.listHistory().map(item => item.taskId), ['second']);

  const secondDelete = service.requestDelete({ batchId: current.batchId, taskIds: ['second'] });
  await service.finalizeDelete(secondDelete.token);
  assert.equal(fs.existsSync(path.join(dir, secondOutput)), false);
  assert.equal(fs.existsSync(templatePath), false);
  assert.equal(fs.existsSync(colorPath), false);
  assert.equal(service.listHistory().length, 0);
});

test('运行中删除保留真实调用费用，并丢弃无法取消的迟到结果', async t => {
  const { root, dir } = workspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const image = await png('#777777');
  let release;
  let submitted;
  const submittedPromise = new Promise(resolve => { submitted = resolve; });
  const remoteGate = new Promise(resolve => { release = resolve; });
  const current = batch([task('running', {
    executionStatus: 'pending',
    generationSubmissionState: 'not_submitted',
    resultVersion: 0,
    output: null
  })], { status: 'running', active: true });
  const store = memoryStore(current, dir);
  const runners = { getRunner() { return { batch: current }; } };
  const worker = taskService(store, {
    async editImage(options) {
      await options.onGenerationAttempt({ providerTaskId: 'remote-1' });
      submitted();
      await remoteGate;
      return { type: 'base64', data: image.toString('base64') };
    },
    async downloadUrl() { throw new Error('不应下载 URL'); }
  });
  const deletionService = createResultService({ batchStore: store, runners, ...noTimers() });

  const processing = worker.processTask(current, current.tasks[0], new AbortController());
  await submittedPromise;
  const deletion = deletionService.requestDelete({ batchId: current.batchId, taskIds: ['running'] });
  assert.equal(deletion.remoteMayContinue, true);
  await deletionService.finalizeDelete(deletion.token);
  release();
  await processing;

  assert.equal(current.tasks[0].apiAttempts, 1);
  assert.equal(current.tasks[0].costFen, 8);
  assert.equal(current.tasks[0].executionStatus, 'deleted');
  assert.equal(current.tasks[0].output, null);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'images')), []);
});

test('彻底清空世代阻止活跃执行器在删除后重新保存批次', async t => {
  const { root, dir } = workspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const image = await png('#999999');
  let release;
  let submitted;
  const submittedPromise = new Promise(resolve => { submitted = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const initial = batch([task('active', {
    executionStatus: 'pending',
    generationSubmissionState: 'not_submitted',
    resultVersion: 0,
    output: null
  })], { status: 'running', active: true, concurrency: 1 });
  const store = memoryStore(initial, dir, { cloneOnRead: true });
  const worker = taskService(store, {
    async editImage(options) {
      await options.onGenerationAttempt({});
      submitted();
      await gate;
      return { type: 'base64', data: image.toString('base64') };
    },
    async downloadUrl() { throw new Error('不应下载 URL'); }
  });
  const runner = createTaskRunner({
    batchStore: store,
    taskService: worker,
    now: () => new Date().toISOString(),
    minConcurrency: 1,
    sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 5)))
  });

  const running = runner.start(initial.batchId);
  await submittedPromise;
  const savesAtPurge = store.saveCount();
  assert.deepEqual(runner.purgeAll(), [initial.batchId]);
  release();
  await running;

  assert.equal(store.saveCount(), savesAtPurge);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'images')), []);
});

test('复色页面不再接入画布历史删除器，清空只删除复色浏览器键', () => {
  const frontendRoot = path.join(__dirname, '..', '..', 'frontend');
  const appSource = fs.readFileSync(path.join(frontendRoot, 'app.js'), 'utf8');
  const htmlSource = fs.readFileSync(path.join(frontendRoot, 'recolor.html'), 'utf8');
  const fileStoreSource = fs.readFileSync(path.join(__dirname, '..', 'fileStore.js'), 'utf8');

  assert.equal(/localStorage\.clear\s*\(/.test(appSource), false);
  assert.equal(/sessionStorage\.clear\s*\(/.test(appSource), false);
  assert.equal(htmlSource.includes('history-bulk-manager.js'), false);
  assert.equal(fileStoreSource.includes("clearDirectoryContents(UPLOAD_DIR"), false);
});
