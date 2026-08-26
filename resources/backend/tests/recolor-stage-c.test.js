const test = require('node:test');
const assert = require('node:assert/strict');

const createTaskRunner = require('../services/taskRunner');
const createBatchService = require('../services/batchService');

const clone = value => JSON.parse(JSON.stringify(value));

function task(id, queueSequence, executionStatus = 'pending', extra = {}) {
  return {
    id,
    order: queueSequence,
    queueSequence,
    queuedAt: `2026-08-22T00:00:0${queueSequence}.000Z`,
    templateNameWithoutExt: `模板${id}`,
    colorNameWithoutExt: `颜色${id}`,
    executionStatus,
    runtimeStatus: null,
    ...extra
  };
}

function batch(tasks, extra = {}) {
  return {
    batchId: 'batch_stage_c',
    status: 'running',
    active: true,
    cancelRequested: false,
    userPauseRequested: false,
    systemPauseRequested: false,
    concurrency: 3,
    tasks,
    ...extra
  };
}

function memoryStore(initial) {
  let persisted = clone(initial);
  return {
    loadBatch() { return clone(persisted); },
    saveBatch(value) { persisted = clone(value); return value; },
    current() { return clone(persisted); }
  };
}

async function waitUntil(predicate, message, timeoutMs = 1500) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('运行中追加进入同一 FIFO，旧任务完成保存不会覆盖新增任务', async () => {
  const store = memoryStore(batch([task('a', 1)], { concurrency: 1 }));
  const claimed = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const runner = createTaskRunner({
    batchStore: store,
    now: () => new Date().toISOString(),
    minConcurrency: 1,
    sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 5)))
  });
  runner.injectTaskService({
    async processTask(currentBatch, currentTask) {
      claimed.push(currentTask.id);
      if (currentTask.id === 'a') await firstGate;
      currentTask.executionStatus = 'completed';
      currentTask.output = `images/${currentTask.id}.jpg`;
      store.saveBatch(currentBatch);
    }
  });

  const running = runner.start('batch_stage_c');
  await waitUntil(() => claimed.length === 1, '首个任务未被领取');

  const fresh = store.loadBatch('batch_stage_c');
  fresh.tasks.push(task('c', 3), task('b', 2));
  store.saveBatch(fresh);
  runner.start('batch_stage_c');
  releaseFirst();
  await running;

  assert.deepEqual(claimed, ['a', 'b', 'c']);
  assert.deepEqual(store.current().tasks.map(item => item.id), ['a', 'b', 'c']);
  assert.ok(store.current().tasks.every(item => item.executionStatus === 'completed'));
});

test('用户暂停只停止领取，已领取任务收尾；暂停追加只入队，恢复后继续', async () => {
  const store = memoryStore(batch([task('a', 1), task('b', 2)], { concurrency: 1 }));
  const claimed = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const runner = createTaskRunner({
    batchStore: store,
    now: () => new Date().toISOString(),
    minConcurrency: 1,
    sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 5)))
  });
  runner.injectTaskService({
    async processTask(currentBatch, currentTask, controller) {
      claimed.push(currentTask.id);
      if (currentTask.id === 'a') {
        await firstGate;
        assert.equal(controller.signal.aborted, false);
      }
      currentTask.executionStatus = 'completed';
      currentTask.output = `images/${currentTask.id}.jpg`;
      store.saveBatch(currentBatch);
    }
  });

  const firstRun = runner.start('batch_stage_c');
  await waitUntil(() => claimed.length === 1, '首个任务未被领取');
  assert.equal(runner.pause('batch_stage_c'), true);

  const pausedAppend = store.loadBatch('batch_stage_c');
  pausedAppend.tasks.push(task('c', 3));
  store.saveBatch(pausedAppend);
  runner.start('batch_stage_c');
  releaseFirst();
  await firstRun;

  assert.deepEqual(claimed, ['a']);
  assert.equal(store.current().status, 'paused');
  assert.deepEqual(store.current().tasks.filter(item => item.executionStatus === 'pending').map(item => item.id), ['b', 'c']);

  const service = createBatchService({ batchStore: store, runners: runner });
  const resumeResult = service.resumeBatchTasks(store.loadBatch('batch_stage_c'));
  assert.equal(resumeResult.blocked, false);
  await runner.start('batch_stage_c');

  assert.deepEqual(claimed, ['a', 'b', 'c']);
  assert.equal(store.current().status, 'completed');
});

test('重复启动同一任务编号不会造成二次领取', async () => {
  const store = memoryStore(batch([task('same-id', 1)], { concurrency: 3 }));
  let submissions = 0;
  const runner = createTaskRunner({
    batchStore: store,
    now: () => new Date().toISOString(),
    sleep: () => Promise.resolve()
  });
  runner.injectTaskService({
    async processTask(currentBatch, currentTask) {
      submissions++;
      currentTask.executionStatus = 'completed';
      currentTask.output = 'images/result.jpg';
      store.saveBatch(currentBatch);
    }
  });

  const first = runner.start('batch_stage_c');
  const second = runner.start('batch_stage_c');
  await Promise.all([first, second]);

  assert.equal(submissions, 1);
});

test('并发可在 3 到 8 之间实时提高，不中断已领取任务', async () => {
  const store = memoryStore(batch([
    task('a', 1), task('b', 2), task('c', 3), task('d', 4), task('e', 5)
  ], { concurrency: 3 }));
  const claimed = [];
  const releases = [];
  const runner = createTaskRunner({
    batchStore: store,
    now: () => new Date().toISOString(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 5)))
  });
  runner.injectTaskService({
    async processTask(currentBatch, currentTask, controller) {
      claimed.push(currentTask.id);
      await new Promise(resolve => releases.push(resolve));
      assert.equal(controller.signal.aborted, false);
      currentTask.executionStatus = 'completed';
      currentTask.output = `images/${currentTask.id}.jpg`;
      store.saveBatch(currentBatch);
    }
  });

  const running = runner.start('batch_stage_c');
  await waitUntil(() => claimed.length === 3, '默认三个并发位未被填满');
  assert.equal(runner.setConcurrency('batch_stage_c', 8), 8);
  await waitUntil(() => claimed.length === 5, '提高并发后没有立即补足空闲位');
  releases.splice(0).forEach(resolve => resolve());
  await running;

  assert.equal(store.current().concurrency, 8);
  assert.equal(store.current().status, 'completed');
});

test('未提供并发设置时默认领取 8 项，第 9 项保持等待', async () => {
  const tasks = Array.from({ length: 9 }, (_, index) => task(String(index + 1), index + 1));
  const store = memoryStore(batch(tasks, { concurrency: undefined }));
  const claimed = [];
  const releases = [];
  const runner = createTaskRunner({
    batchStore: store,
    now: () => new Date().toISOString(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 5)))
  });
  runner.injectTaskService({
    async processTask(currentBatch, currentTask) {
      claimed.push(currentTask.id);
      await new Promise(resolve => releases.push(resolve));
      currentTask.executionStatus = 'completed';
      currentTask.output = `images/${currentTask.id}.jpg`;
      store.saveBatch(currentBatch);
    }
  });

  const running = runner.start('batch_stage_c');
  await waitUntil(() => claimed.length === 8, '默认 8 个并发位未被填满');
  assert.equal(claimed.includes('9'), false);
  releases.splice(0).forEach(resolve => resolve());
  await waitUntil(() => claimed.length === 9, '空闲并发位没有领取第 9 项');
  releases.splice(0).forEach(resolve => resolve());
  await running;
});

test('执行器关闭边界发生追加时会自动接续，不遗留等待任务', async () => {
  let persisted = clone(batch([task('a', 1)], { concurrency: 1 }));
  let injected = false;
  let runner;
  const claimed = [];
  const store = {
    loadBatch() { return clone(persisted); },
    saveBatch(value) {
      persisted = clone(value);
      if (!injected && value.status === 'completed') {
        injected = true;
        persisted.tasks.push(task('b', 2));
        runner.start('batch_stage_c');
      }
      return value;
    },
    current() { return clone(persisted); }
  };
  runner = createTaskRunner({
    batchStore: store,
    now: () => new Date().toISOString(),
    minConcurrency: 1,
    sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 5)))
  });
  runner.injectTaskService({
    async processTask(currentBatch, currentTask) {
      claimed.push(currentTask.id);
      currentTask.executionStatus = 'completed';
      currentTask.output = `images/${currentTask.id}.jpg`;
      store.saveBatch(currentBatch);
    }
  });

  await runner.start('batch_stage_c');
  await waitUntil(() => claimed.length === 2, '关闭边界追加的任务没有被接续');
  await waitUntil(() => store.current().status === 'completed', '接续任务完成后批次未关闭');
  assert.deepEqual(claimed, ['a', 'b']);
});

test('手动继续只恢复安全中断和等待任务，不重跑失败、完成或远端未知任务', () => {
  const current = batch([
    task('pending', 1),
    task('safe', 2, 'interrupted', { generationSubmissionState: 'prepared' }),
    task('failed', 3, 'error'),
    task('done', 4, 'completed', { output: 'images/done.jpg' }),
    task('unknown', 5, 'interrupted', { runtimeStatus: 'remote_unknown', generationSubmissionState: 'submitted' })
  ], { status: 'paused', active: false, userPauseRequested: true });
  const store = memoryStore(current);
  const service = createBatchService({ batchStore: store, runners: { getRunner() { return null; } } });

  const result = service.resumeBatchTasks(current);

  assert.equal(result.blocked, true);
  assert.equal(store.current().status, 'paused');
  assert.equal(store.current().tasks.find(item => item.id === 'failed').executionStatus, 'error');
  assert.equal(store.current().tasks.find(item => item.id === 'done').executionStatus, 'completed');
  assert.equal(store.current().tasks.find(item => item.id === 'unknown').executionStatus, 'interrupted');
});
