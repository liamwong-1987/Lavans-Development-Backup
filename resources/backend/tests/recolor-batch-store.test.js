const test = require('node:test');
const assert = require('node:assert/strict');
const batchStore = require('../batchStore');

const { parseBatchJson, recalculate } = batchStore.__test;

test('旧批次读取后补齐状态真相、快照和版本字段', () => {
  const batch = parseBatchJson(JSON.stringify({
    version: 2,
    batchId: 'batch_legacy',
    providerId: 'provider-a',
    model: 'image-model-a',
    prompt: '只改变颜色',
    extraPrompt: '保留纹理',
    imageSize: '1024x1536',
    quality: 'high',
    costPerCallFen: 16,
    tasks: [{
      id: 'legacy-task',
      status: 'success',
      sessionId: 'upload-legacy',
      output: 'images/result.jpg'
    }]
  }));

  const task = batch.tasks[0];
  assert.equal(batch.version, 5);
  assert.equal(batch.concurrency, 8);
  assert.equal(batch.executionBatchId, 'batch_legacy');
  assert.deepEqual(batch.uploadBatchIds, ['upload-legacy']);
  assert.equal(task.executionStatus, 'completed');
  assert.equal(task.mainStatus, 'completed');
  assert.equal(task.runtimeStatus, null);
  assert.equal(task.uploadBatchId, 'upload-legacy');
  assert.equal(task.executionBatchId, 'batch_legacy');
  assert.equal(task.queueSequence, 1);
  assert.equal(task.queueAttempt, 0);
  assert.equal(task.providerIdSnapshot, 'provider-a');
  assert.equal(task.modelSnapshot, 'image-model-a');
  assert.equal(task.promptSnapshot, '只改变颜色');
  assert.equal(task.extraPromptSnapshot, '保留纹理');
  assert.equal(task.imageSizeSnapshot, '1024x1536');
  assert.equal(task.qualitySnapshot, 'high');
  assert.equal(task.costPerCallFenSnapshot, 16);
  assert.equal(task.resultVersion, 1);
  assert.equal(task.exportedAt, null);
  assert.equal(task.exportedResultVersion, 0);
  assert.equal(task.deleteRequestedAt, null);
  assert.equal(task.deleteUndoUntil, null);
  assert.equal(task.deleteToken, null);
  assert.equal(task.deletedAt, null);
  assert.equal(task.discardLateResult, false);
});

test('等待和运行不计完成，只有真实结果或失败进入完成数', () => {
  const batch = recalculate({
    version: 2,
    batchId: 'batch_statuses',
    updatedAt: 'keep-me',
    totals: { total: 99, done: 99 },
    tasks: [
      { id: 'pending', executionStatus: 'pending', costFen: 1, apiAttempts: 0 },
      { id: 'running', executionStatus: 'running', costFen: 2, apiAttempts: 1 },
      { id: 'completed', executionStatus: 'completed', output: 'images/ok.jpg', costFen: 3, apiAttempts: 1 },
      { id: 'empty-completed', executionStatus: 'completed', error: '没有保存图片', costFen: 4, apiAttempts: 1 },
      { id: 'error', executionStatus: 'error', costFen: 5, apiAttempts: 1 },
      { id: 'cancelled', executionStatus: 'cancelled', costFen: 6, apiAttempts: 1 },
      { id: 'interrupted', executionStatus: 'interrupted', costFen: 7, apiAttempts: 1 },
      { id: 'deleted', executionStatus: 'deleted', costFen: 100, apiAttempts: 1 },
      { id: 'hidden', executionStatus: 'completed', output: 'images/hidden.jpg', hiddenInTaskList: true, costFen: 100, apiAttempts: 1 }
    ]
  }, { touchUpdatedAt: false });

  assert.deepEqual(batch.totals, {
    total: 7,
    pending: 1,
    running: 2,
    completed: 1,
    success: 1,
    failed: 3,
    cancelled: 1,
    interrupted: 1,
    done: 4,
    costFen: 28,
    apiAttempts: 6
  });
  assert.equal(batch.tasks.find(task => task.id === 'empty-completed').mainStatus, 'failed');
  assert.equal(batch.tasks.find(task => task.id === 'interrupted').runtimeStatus, 'remote_unknown');
  assert.equal(batch.updatedAt, 'keep-me');
});

test('任务全部删除后统计归零，不恢复旧统计', () => {
  const batch = recalculate({
    batchId: 'batch_deleted',
    totals: { total: 8, completed: 8, success: 8, done: 8, costFen: 64, apiAttempts: 8 },
    tasks: [{ id: 'gone', executionStatus: 'completed', output: 'images/gone.jpg', hiddenInTaskList: true }]
  }, { touchUpdatedAt: false });

  assert.deepEqual(batch.totals, {
    total: 0,
    pending: 0,
    running: 0,
    completed: 0,
    success: 0,
    failed: 0,
    cancelled: 0,
    interrupted: 0,
    done: 0,
    costFen: 0,
    apiAttempts: 0
  });
});
