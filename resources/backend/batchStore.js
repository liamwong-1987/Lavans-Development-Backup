const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { OUTPUT_DIR } = require('./fileStore');

const BATCH_PREFIX = 'batch_';
const BATCH_FILE = 'batch.json';
const BATCH_VERSION = 5;

function clampConcurrency(value) {
  const parsed = Number(value);
  return Math.min(8, Math.max(3, Number.isFinite(parsed) ? Math.trunc(parsed) : 8));
}

function queueSequenceFor(task) {
  const value = Number(task?.queueSequence ?? task?.order ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function sortTasksFifo(tasks) {
  return [...(Array.isArray(tasks) ? tasks : [])].sort((a, b) =>
    queueSequenceFor(a) - queueSequenceFor(b)
    || String(a?.queuedAt || a?.createdAt || '').localeCompare(String(b?.queuedAt || b?.createdAt || ''))
    || String(a?.id || '').localeCompare(String(b?.id || ''))
  );
}

function isRemoteUnknownTask(task) {
  if (task?.runtimeStatus === 'remote_unknown') return true;
  const state = String(task?.generationSubmissionState || '').toLowerCase();
  if (['submitting', 'submitted', 'unknown', 'cancelled_after_submit'].includes(state)) return true;
  return task?.executionStatus === 'interrupted'
    && !['not_submitted', 'prepared', 'cancelled_before_submit'].includes(state);
}

function normalizedExecutionStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (['pending', 'queued', 'waiting', 'paused'].includes(status)) return 'pending';
  if (['running', 'generating', 'processing'].includes(status)) return 'running';
  if (['completed', 'done', 'success', 'finished'].includes(status)) return 'completed';
  if (['failed', 'error'].includes(status)) return status;
  if (['cancelled', 'canceled', 'stopped'].includes(status)) return 'cancelled';
  if (status === 'interrupted') return 'interrupted';
  if (status === 'deleted') return 'deleted';
  return 'pending';
}

function mainStatusFor(task) {
  if (task.hiddenInTaskList || task.deletedAt || task.executionStatus === 'deleted') return 'deleted';
  const status = normalizedExecutionStatus(task.executionStatus || task.status || task.mainStatus);
  if (status === 'completed') return task.output ? 'completed' : 'failed';
  if (['failed', 'error', 'cancelled'].includes(status)) return 'failed';
  if (status === 'interrupted') return 'running';
  return status;
}

function normalizeTask(task, batch) {
  // 阶段 A 兼容层：旧执行器继续写 executionStatus，统计只认 mainStatus。
  task.executionStatus = normalizedExecutionStatus(task.executionStatus || task.status || task.mainStatus);
  task.mainStatus = mainStatusFor(task);
  task.runtimeStatus = task.runtimeStatus || (isRemoteUnknownTask(task) ? 'remote_unknown' : null);
  task.queueSequence = queueSequenceFor(task);
  task.queueAttempt = Math.max(0, Number(task.queueAttempt || 0));
  task.queuedAt = task.queuedAt ?? task.createdAt ?? batch.createdAt ?? '';
  task.qualityStatus = task.qualityStatus || 'review_required';
  task.uploadBatchId = task.uploadBatchId ?? task.sessionId ?? batch.uploadBatchId ?? '';
  task.executionBatchId = task.executionBatchId ?? batch.executionBatchId ?? batch.batchId ?? '';
  task.providerIdSnapshot = task.providerIdSnapshot ?? batch.providerIdSnapshot ?? batch.providerId ?? '';
  task.modelSnapshot = task.modelSnapshot ?? batch.modelSnapshot ?? batch.model ?? '';
  task.promptSnapshot = task.promptSnapshot ?? batch.promptSnapshot ?? batch.prompt ?? '';
  task.extraPromptSnapshot = task.extraPromptSnapshot ?? batch.extraPromptSnapshot ?? batch.extraPrompt ?? '';
  task.imageSizeSnapshot = task.imageSizeSnapshot ?? batch.imageSizeSnapshot ?? batch.imageSize ?? '1024x1024';
  task.qualitySnapshot = task.qualitySnapshot ?? batch.qualitySnapshot ?? batch.quality ?? 'low';
  task.costPerCallFenSnapshot = Number(task.costPerCallFenSnapshot ?? batch.costPerCallFenSnapshot ?? batch.costPerCallFen ?? 0);
  task.bindingRevision = Math.max(0, Number(task.bindingRevision || 0));
  task.modelReboundAt = task.modelReboundAt ?? null;
  task.modelRebindRequestId = task.modelRebindRequestId ?? null;
  task.resultVersion = Number.isInteger(task.resultVersion) && task.resultVersion >= 0 ? task.resultVersion : (task.output ? 1 : 0);
  task.exportedAt = task.exportedAt ?? null;
  task.exportedResultVersion = Number.isInteger(task.exportedResultVersion) && task.exportedResultVersion >= 0 ? task.exportedResultVersion : 0;
  task.referenceHex = /^#[0-9a-f]{6}$/i.test(String(task.referenceHex || '')) ? String(task.referenceHex).toUpperCase() : null;
  task.referenceColorLabel = typeof task.referenceColorLabel === 'string' ? task.referenceColorLabel.slice(0, 80) : '';
  task.exportNameStale = Boolean(task.exportNameStale);
  task.deleteRequestedAt = task.deleteRequestedAt ?? null;
  task.deleteUndoUntil = task.deleteUndoUntil ?? null;
  task.deleteToken = task.deleteToken ?? null;
  task.deletedAt = task.deletedAt ?? null;
  task.discardLateResult = Boolean(task.discardLateResult);
  task.redoRequestedAt = task.redoRequestedAt ?? null;
  task.redoBaseResultVersion = Number.isInteger(task.redoBaseResultVersion) && task.redoBaseResultVersion >= 0
    ? task.redoBaseResultVersion
    : null;
  return task;
}

function normalizeBatch(batch) {
  batch.version = Math.max(Number(batch.version) || 0, BATCH_VERSION);
  batch.tasks = Array.isArray(batch.tasks) ? batch.tasks : [];
  batch.uploadBatchId = batch.uploadBatchId ?? batch.tasks.find(task => task?.sessionId)?.sessionId ?? '';
  batch.executionBatchId = batch.executionBatchId ?? batch.batchId ?? '';
  batch.providerIdSnapshot = batch.providerIdSnapshot ?? batch.providerId ?? '';
  batch.modelSnapshot = batch.modelSnapshot ?? batch.model ?? '';
  batch.promptSnapshot = batch.promptSnapshot ?? batch.prompt ?? '';
  batch.extraPromptSnapshot = batch.extraPromptSnapshot ?? batch.extraPrompt ?? '';
  batch.imageSizeSnapshot = batch.imageSizeSnapshot ?? batch.imageSize ?? '1024x1024';
  batch.qualitySnapshot = batch.qualitySnapshot ?? batch.quality ?? 'low';
  batch.costPerCallFenSnapshot = Number(batch.costPerCallFenSnapshot ?? batch.costPerCallFen ?? 0);
  batch.concurrency = clampConcurrency(batch.concurrency);
  batch.userPauseRequested = Boolean(batch.userPauseRequested);
  batch.systemPauseRequested = Boolean(batch.systemPauseRequested);
  batch.pauseReason = batch.pauseReason ?? null;
  batch.unavailableBinding = batch.unavailableBinding && typeof batch.unavailableBinding === 'object'
    ? {
        providerId: String(batch.unavailableBinding.providerId || '').slice(0, 120),
        model: String(batch.unavailableBinding.model || '').slice(0, 200),
        detectedAt: batch.unavailableBinding.detectedAt || null
      }
    : null;
  batch.bindingRevision = Math.max(0, Number(batch.bindingRevision || 0));
  batch.modelRebindReceipts = Array.isArray(batch.modelRebindReceipts) ? batch.modelRebindReceipts.slice(-20) : [];
  batch.lastModelRebind = batch.lastModelRebind && typeof batch.lastModelRebind === 'object' ? batch.lastModelRebind : null;
  batch.healthCheckConsecutive = Math.max(0, Number(batch.healthCheckConsecutive || 0));
  batch.lastHealthCheckAt = batch.lastHealthCheckAt ?? null;
  batch.lastHealthCheckError = batch.lastHealthCheckError ?? null;
  let nextQueueSequence = batch.tasks.reduce((max, task) => Math.max(max, queueSequenceFor(task)), 0);
  batch.tasks.forEach(task => {
    if (!queueSequenceFor(task)) task.queueSequence = ++nextQueueSequence;
  });
  batch.tasks.forEach(task => normalizeTask(task, batch));
  batch.uploadBatchIds = [...new Set(batch.tasks.map(task => task.uploadBatchId).filter(Boolean))];
  return batch;
}

function now() {
  return new Date().toISOString();
}

function safeBatchName(value) {
  return typeof value === 'string' && /^batch_[A-Za-z0-9_-]+$/.test(value);
}

function batchDir(batchId) {
  if (!safeBatchName(batchId)) throw new Error('无效批次ID');
  const resolved = path.resolve(OUTPUT_DIR, batchId);
  const root = path.resolve(OUTPUT_DIR) + path.sep;
  if (!resolved.startsWith(root)) throw new Error('批次路径越界');
  return resolved;
}

function atomicWriteJson(filePath, data) {
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temp, filePath);
}

function createBatch(pairs, options = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const batchId = `${BATCH_PREFIX}${stamp}_${crypto.randomBytes(2).toString('hex')}`;
  const dir = batchDir(batchId);
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'attempts'), { recursive: true });

  const createdAt = now();
  const tasks = pairs.map((pair, index) => ({
    id: crypto.randomUUID(),
    order: index + 1,
    queueSequence: index + 1,
    queueAttempt: 0,
    queuedAt: createdAt,
    createdAt,
    template: pair.templateName,
    templatePath: pair.templatePath,
    templateNameWithoutExt: pair.templateNameWithoutExt,
    colorRef: pair.colorName,
    colorPath: pair.colorPath,
    colorNameWithoutExt: pair.colorNameWithoutExt,
    referenceHex: /^#[0-9a-f]{6}$/i.test(String(pair.referenceHex || '')) ? String(pair.referenceHex).toUpperCase() : null,
    referenceColorLabel: String(pair.referenceColorLabel || '').slice(0, 80),
    sessionId: pair.sessionId || pair.uploadSessionId || '',
    executionStatus: 'pending',
    qualityStatus: 'review_required',
    apiAttempts: 0,
    correctionRounds: 0,
    costFen: 0,
    elapsedMs: 0,
    deltaE: null,
    targetColor: null,
    colorStatus: null,
    structureStatus: null,
    outsideMaskStatus: null,
    outsideChangeRate: null,
    structureScore: null,
    maskStatus: 'none',
    maskPath: null,
    maskConfirmedAt: null,
    maskHash: null,
    output: null,
    error: null,
    hiddenInTaskList: false,
    startedAt: null,
    finishedAt: null
  }));

  const batch = {
    version: BATCH_VERSION,
    batchId,
    status: 'running',
    active: true,
    cancelRequested: false,
    userPauseRequested: false,
    systemPauseRequested: false,
    pauseReason: null,
    prompt: options.prompt || '',
    imageSize: options.imageSize || '1024x1024',
    providerId: options.providerId || '',
    quality: options.quality || 'low',
    model: options.model || '',
    concurrency: clampConcurrency(options.concurrency),
    costPerCallFen: options.costPerCallFen || 8,
    costCurrency: 'CNY',
    costType: 'estimated',
    createdAt,
    startedAt: options.inheritStartedAt || createdAt,
    updatedAt: createdAt,
    finishedAt: null,
    totals: {
      total: tasks.length,
      pending: tasks.length,
      running: 0,
      completed: 0,
      success: 0,
      failed: 0,
      cancelled: 0,
      interrupted: 0,
      done: 0,
      costFen: 0,
      apiAttempts: 0
    },
    tasks
  };

  saveBatch(batch);
  return batch;
}

function recalculate(batch, { touchUpdatedAt = true } = {}) {
  normalizeBatch(batch);
  // STEP 2: RESET 操作优先级最高 — 强制清零，不执行任何保护逻辑
  if (batch.resetMode === true || batch.operation === 'RESET') {
    batch.totals = {
      total: 0, pending: 0, running: 0, completed: 0, success: 0,
      failed: 0, cancelled: 0, interrupted: 0, done: 0,
      costFen: 0, apiAttempts: 0
    };
    if (touchUpdatedAt) batch.updatedAt = now();
    return batch;
  }

  const visibleTasks = batch.tasks.filter(task => task.mainStatus !== 'deleted');
  const totals = {
    total: visibleTasks.length,
    pending: 0, running: 0, completed: 0, success: 0,
    failed: 0, cancelled: 0, interrupted: 0, done: 0,
    costFen: 0, apiAttempts: 0
  };
  for (const task of visibleTasks) {
    totals[task.mainStatus]++;
    if (task.executionStatus === 'cancelled') totals.cancelled++;
    if (task.executionStatus === 'interrupted') totals.interrupted++;
    totals.costFen += Number(task.costFen || 0);
    totals.apiAttempts += Number(task.apiAttempts || 0);
  }
  totals.success = totals.completed;
  totals.done = totals.completed + totals.failed;
  batch.totals = totals;
  if (touchUpdatedAt) batch.updatedAt = now();
  return batch;
}

function saveBatch(batch) {
  const dir = batchDir(batch.batchId);
  fs.mkdirSync(dir, { recursive: true });
  recalculate(batch);
  atomicWriteJson(path.join(dir, BATCH_FILE), batch);
  return batch;
}

function appendTasks(batch, tasks) {
  const persisted = batch?.batchId ? loadBatch(batch.batchId) : null;
  if (persisted) Object.assign(batch, persisted);
  normalizeBatch(batch);
  const existingIds = new Set(batch.tasks.map(task => task.id));
  let nextSequence = batch.tasks.reduce((max, task) => Math.max(max, queueSequenceFor(task)), 0);
  const appended = [];
  for (const task of tasks || []) {
    if (!task?.id || existingIds.has(task.id)) continue;
    nextSequence++;
    task.queueSequence = nextSequence;
    task.order = nextSequence;
    task.queuedAt = task.queuedAt || task.createdAt || now();
    task.createdAt = task.createdAt || task.queuedAt;
    batch.tasks.push(task);
    existingIds.add(task.id);
    appended.push(task);
  }
  if (appended.length) {
    batch.finishedAt = null;
    saveBatch(batch);
  }
  return appended;
}

function parseBatchJson(json) {
  return recalculate(JSON.parse(json), { touchUpdatedAt: false });
}

function loadBatch(batchId) {
  const file = path.join(batchDir(batchId), BATCH_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    return parseBatchJson(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error('[BATCH] 读取失败:', batchId, error.message);
    return null;
  }
}

function listBatches() {
  if (!fs.existsSync(OUTPUT_DIR)) return [];
  return fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && safeBatchName(entry.name))
    .map(entry => loadBatch(entry.name))
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function latestBatch() {
  return listBatches()[0] || null;
}

function recoverInterruptedBatches() {
  for (const batch of listBatches()) {
    if (!batch.active && batch.status !== 'running') continue;
    let changed = false;
    for (const task of batch.tasks) {
      if (task.executionStatus === 'running' || task.status === 'running') {
        const submissionState = String(task.generationSubmissionState || '').toLowerCase();
        const safelyNotSubmitted = ['not_submitted', 'prepared', 'cancelled_before_submit'].includes(submissionState);
        task.executionStatus = safelyNotSubmitted ? 'pending' : 'interrupted';
        task.runtimeStatus = safelyNotSubmitted ? null : 'remote_unknown';
        task.error = safelyNotSubmitted
          ? null
          : '服务关闭时任务可能已提交，正在确认远端结果';
        task.interruptCount = (task.interruptCount || 0) + 1;
        if (!safelyNotSubmitted) {
          batch.systemPauseRequested = true;
          batch.pauseReason = 'remote_unknown';
        }
        changed = true;
      }
    }
    if (changed || batch.active) {
      batch.active = false;
      batch.status = 'paused';
      batch.cancelRequested = false;
      saveBatch(batch);
    }
  }
}

function publicBatch(batch) {
  if (!batch) return null;
  recalculate(batch, { touchUpdatedAt: false });
  return {
    batchId: batch.batchId,
    status: batch.status,
    active: batch.active,
    cancelRequested: batch.cancelRequested,
    userPauseRequested: batch.userPauseRequested,
    systemPauseRequested: batch.systemPauseRequested,
    pauseReason: batch.pauseReason,
    unavailableBinding: batch.unavailableBinding,
    bindingRevision: batch.bindingRevision,
    lastModelRebind: batch.lastModelRebind,
    healthCheckConsecutive: batch.healthCheckConsecutive,
    lastHealthCheckAt: batch.lastHealthCheckAt,
    lastHealthCheckError: batch.lastHealthCheckError,
    concurrency: batch.concurrency,
    createdAt: batch.createdAt,
    startedAt: batch.startedAt,
    updatedAt: batch.updatedAt,
    finishedAt: batch.finishedAt,
    costCurrency: batch.costCurrency,
    costType: batch.costType,
    costPerCallFen: batch.costPerCallFen,
    uploadBatchId: batch.uploadBatchId,
    uploadBatchIds: batch.uploadBatchIds,
    executionBatchId: batch.executionBatchId,
    providerIdSnapshot: batch.providerIdSnapshot,
    modelSnapshot: batch.modelSnapshot,
    promptSnapshot: batch.promptSnapshot,
    extraPromptSnapshot: batch.extraPromptSnapshot,
    imageSizeSnapshot: batch.imageSizeSnapshot,
    qualitySnapshot: batch.qualitySnapshot,
    costPerCallFenSnapshot: batch.costPerCallFenSnapshot,
    prompt: batch.prompt || '',
    extraPrompt: batch.extraPrompt || '',
    totals: batch.totals,
    tasks: batch.tasks.map(task => ({
      id: task.id || '',
      order: task.order,
      queueSequence: task.queueSequence,
      queueAttempt: task.queueAttempt,
      queuedAt: task.queuedAt,
      template: task.template,
      colorRef: task.colorRef,
      templateNameWithoutExt: task.templateNameWithoutExt,
      colorNameWithoutExt: task.colorNameWithoutExt,
      executionStatus: task.executionStatus,
      mainStatus: task.mainStatus,
      runtimeStatus: task.runtimeStatus,
      qualityStatus: task.qualityStatus,
      uploadBatchId: task.uploadBatchId,
      executionBatchId: task.executionBatchId,
      providerIdSnapshot: task.providerIdSnapshot,
      modelSnapshot: task.modelSnapshot,
      bindingRevision: task.bindingRevision,
      modelReboundAt: task.modelReboundAt,
      promptSnapshot: task.promptSnapshot,
      extraPromptSnapshot: task.extraPromptSnapshot,
      imageSizeSnapshot: task.imageSizeSnapshot,
      qualitySnapshot: task.qualitySnapshot,
      costPerCallFenSnapshot: task.costPerCallFenSnapshot,
      resultVersion: task.resultVersion,
      exportedAt: task.exportedAt,
      exportedResultVersion: task.exportedResultVersion,
      referenceHex: task.referenceHex,
      referenceColorLabel: task.referenceColorLabel,
      exportNameStale: task.exportNameStale,
      deleteRequestedAt: task.deleteRequestedAt,
      deleteUndoUntil: task.deleteUndoUntil,
      deleteToken: task.deleteToken,
      deletedAt: task.deletedAt,
      discardLateResult: task.discardLateResult,
      redoRequestedAt: task.redoRequestedAt,
      redoBaseResultVersion: task.redoBaseResultVersion,
      colorStatus: task.colorStatus,
      structureStatus: task.structureStatus,
      outsideMaskStatus: task.outsideMaskStatus,
      apiAttempts: task.apiAttempts,
      correctionRounds: task.correctionRounds,
      costFen: task.costFen,
      elapsedMs: task.elapsedMs,
      deltaE: task.deltaE,
      outsideChangeRate: task.outsideChangeRate,
      structureScore: task.structureScore,
      targetColor: task.targetColor,
      output: task.output,
      error: task.error,
      hiddenInTaskList: task.hiddenInTaskList,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt
    })).filter(task => !task.hiddenInTaskList && task.mainStatus !== 'deleted')
  };
}

module.exports = {
  batchDir,
  createBatch,
  appendTasks,
  saveBatch,
  loadBatch,
  listBatches,
  latestBatch,
  recoverInterruptedBatches,
  publicBatch,
  safeBatchName,
  __test: {
    normalizeBatch,
    normalizeTask,
    recalculate,
    parseBatchJson,
    clampConcurrency,
    sortTasksFifo,
    isRemoteUnknownTask
  }
};
