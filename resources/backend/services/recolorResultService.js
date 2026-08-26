// recolorResultService.js — 复色结果历史与可撤销删除；历史直接引用任务结果，不复制图片
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

module.exports = function createRecolorResultService(deps) {
  const {
    batchStore,
    runners,
    now = () => new Date().toISOString(),
    clock = () => Date.now(),
    undoMs = 5000,
    setTimer = setTimeout,
    clearTimer = clearTimeout
  } = deps;
  const timers = new Map();

  function currentBatch(batchId) {
    return runners?.getRunner?.(batchId)?.batch || batchStore.loadBatch(batchId);
  }

  function safeInside(root, target) {
    const resolvedRoot = path.resolve(root) + path.sep;
    const resolvedTarget = path.resolve(target);
    return resolvedTarget.startsWith(resolvedRoot) ? resolvedTarget : null;
  }

  async function removeIfPresent(target) {
    try { await fs.promises.unlink(target); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  async function removeResult(batchId, relativePath) {
    if (!relativePath) return;
    const dir = batchStore.batchDir(batchId);
    const resultPath = safeInside(dir, path.resolve(dir, relativePath));
    if (!resultPath) return;
    const previewPath = resultPath.replace(/_final\.jpg$/i, '_preview.jpg');
    await Promise.allSettled([...new Set([resultPath, previewPath])].map(removeIfPresent));
  }

  function publicFileUrl(batch, filePath) {
    if (!filePath) return null;
    const dir = batchStore.batchDir(batch.batchId);
    const resolved = safeInside(dir, filePath);
    if (!resolved) return null;
    const relative = path.relative(dir, resolved).split(path.sep).map(encodeURIComponent).join('/');
    return `/output/${encodeURIComponent(batch.batchId)}/${relative}`;
  }

  function historyItems({ uploadBatchId = '' } = {}) {
    const items = [];
    for (const batch of batchStore.listBatches()) {
      const dir = batchStore.batchDir(batch.batchId);
      for (const task of batch.tasks || []) {
        if (task.hiddenInTaskList || task.deletedAt || task.executionStatus === 'deleted' || !task.output) continue;
        const resultPath = safeInside(dir, path.resolve(dir, task.output));
        if (!resultPath || !fs.existsSync(resultPath)) continue;
        if (uploadBatchId && task.uploadBatchId !== uploadBatchId) continue;
        items.push({
          id: `${batch.batchId}:${task.id}`,
          batchId: batch.batchId,
          taskId: task.id,
          uploadBatchId: task.uploadBatchId || batch.uploadBatchId || '',
          templateName: task.templateNameWithoutExt || task.template || '',
          colorName: task.colorNameWithoutExt || task.colorRef || '',
          referenceHex: task.referenceHex || '',
          referenceColorLabel: task.referenceColorLabel || '',
          templateUrl: publicFileUrl(batch, task.templatePath),
          colorUrl: publicFileUrl(batch, task.colorPath),
          resultUrl: publicFileUrl(batch, resultPath),
          resultVersion: Number(task.resultVersion || 0),
          executionStatus: task.executionStatus,
          generatedAt: task.finishedAt || batch.updatedAt || batch.createdAt,
          exportedAt: task.exportedAt || null,
          size: fs.statSync(resultPath).size
        });
      }
    }
    return items.sort((a, b) => String(b.generatedAt || '').localeCompare(String(a.generatedAt || '')));
  }

  function parseItemId(value) {
    const text = String(value || '');
    const separator = text.lastIndexOf(':');
    if (separator <= 0 || separator === text.length - 1) return null;
    return { batchId: text.slice(0, separator), taskId: text.slice(separator + 1) };
  }

  function scheduleFinalize(token, delayMs) {
    if (timers.has(token)) clearTimer(timers.get(token));
    const timer = setTimer(() => {
      timers.delete(token);
      finalizeDelete(token).catch(error => console.error('[RECOLOR-DELETE] finalize:', error.message));
    }, Math.max(0, delayMs));
    timer?.unref?.();
    timers.set(token, timer);
  }

  function selectTasks(options) {
    const selected = new Map();
    const explicitItems = (options.itemIds || []).map(parseItemId).filter(Boolean);
    const explicitByBatch = new Map();
    for (const item of explicitItems) {
      if (!explicitByBatch.has(item.batchId)) explicitByBatch.set(item.batchId, new Set());
      explicitByBatch.get(item.batchId).add(item.taskId);
    }

    const batches = batchStore.listBatches();
    for (const listed of batches) {
      const batchId = listed.batchId;
      const relevant = options.all
        || options.uploadBatchId
        || batchId === options.batchId
        || explicitByBatch.has(batchId);
      if (!relevant) continue;
      const batch = currentBatch(batchId) || listed;
      const explicitIds = explicitByBatch.get(batchId);
      const requestedIds = batchId === options.batchId && Array.isArray(options.taskIds)
        ? new Set(options.taskIds.map(String))
        : null;
      const statuses = Array.isArray(options.statuses) ? new Set(options.statuses) : null;

      for (const task of batch.tasks || []) {
        if (task.deletedAt || task.executionStatus === 'deleted') continue;
        if (explicitIds && !explicitIds.has(String(task.id))) continue;
        if (!explicitIds && requestedIds && !requestedIds.has(String(task.id))) continue;
        if (!explicitIds && !requestedIds && options.uploadBatchId && task.uploadBatchId !== options.uploadBatchId) continue;
        if (statuses && !statuses.has(task.executionStatus || task.status)) continue;
        if (!options.all && !explicitIds && !requestedIds && !options.uploadBatchId && batchId !== options.batchId) continue;
        selected.set(`${batchId}:${task.id}`, { batch, task });
      }
    }
    return [...selected.values()];
  }

  function requestDelete(options = {}) {
    const selected = selectTasks(options);
    if (!selected.length) return { success: true, count: 0, token: null, undoUntil: null, remoteCancelSupported: false };

    const token = `delete_${clock()}_${crypto.randomBytes(4).toString('hex')}`;
    const requestedAt = now();
    const undoUntilMs = clock() + undoMs;
    const undoUntil = new Date(undoUntilMs).toISOString();
    const touched = new Map();
    let remoteMayContinue = false;

    for (const { batch, task } of selected) {
      if (task.executionStatus === 'running' || ['submitting', 'submitted'].includes(task.generationSubmissionState)) {
        remoteMayContinue = true;
      }
      task.hiddenInTaskList = true;
      task.deleteRequestedAt = requestedAt;
      task.deleteUndoUntil = undoUntil;
      task.deleteToken = token;
      task.discardLateResult = false;
      touched.set(batch.batchId, batch);
    }
    for (const batch of touched.values()) batchStore.saveBatch(batch);
    scheduleFinalize(token, undoMs);

    return {
      success: true,
      count: selected.length,
      token,
      undoUntil,
      batchIds: [...touched.keys()],
      remoteCancelSupported: false,
      remoteMayContinue
    };
  }

  async function cleanupUnreferencedInputs(batch, candidates) {
    const dir = batchStore.batchDir(batch.batchId);
    const inputsRoot = path.join(dir, 'inputs');
    for (const candidate of new Set(candidates.filter(Boolean))) {
      const target = safeInside(inputsRoot, candidate);
      if (!target) continue;
      const stillReferenced = batch.tasks.some(task =>
        !task.deletedAt
        && task.executionStatus !== 'deleted'
        && [task.templatePath, task.colorPath, task.maskPath].includes(candidate)
      );
      if (!stillReferenced) await removeIfPresent(target);
    }
  }

  async function finalizeDelete(token) {
    if (!token) return { success: false, error: '缺少删除凭证' };
    if (timers.has(token)) {
      clearTimer(timers.get(token));
      timers.delete(token);
    }

    const deletedAt = now();
    const affected = [];
    const failedFiles = [];
    for (const listed of batchStore.listBatches()) {
      const batch = currentBatch(listed.batchId) || listed;
      const deletedTasks = (batch.tasks || []).filter(task => task.deleteToken === token && !task.deletedAt);
      if (!deletedTasks.length) continue;

      const inputCandidates = [];
      const outputs = [];
      for (const task of deletedTasks) {
        outputs.push(task.output);
        inputCandidates.push(task.templatePath, task.colorPath, task.maskPath);
        task.hiddenInTaskList = true;
        task.deleteUndoUntil = null;
        task.deleteToken = null;
        task.deletedAt = deletedAt;
        task.discardLateResult = true;
        task.executionStatus = 'deleted';
        task.runtimeStatus = null;
        task.generationSubmissionState = ['submitting', 'submitted'].includes(task.generationSubmissionState)
          ? 'discarded_after_submit'
          : 'deleted';
        task.output = null;
        task.error = null;
      }
      batchStore.saveBatch(batch);

      for (const output of outputs) {
        try { await removeResult(batch.batchId, output); } catch (error) {
          failedFiles.push({ path: output, reason: error.code || error.message });
        }
      }
      try { await cleanupUnreferencedInputs(batch, inputCandidates); } catch (error) {
        failedFiles.push({ path: path.join(batchStore.batchDir(batch.batchId), 'inputs'), reason: error.code || error.message });
      }
      affected.push(...deletedTasks.map(task => ({ batchId: batch.batchId, taskId: task.id })));
    }
    return { success: failedFiles.length === 0, count: affected.length, affected, failedFiles };
  }

  async function undoDelete(token) {
    if (!token) return { success: false, error: '缺少撤销凭证' };
    const matches = [];
    for (const listed of batchStore.listBatches()) {
      const batch = currentBatch(listed.batchId) || listed;
      const tasks = (batch.tasks || []).filter(task => task.deleteToken === token && !task.deletedAt);
      if (tasks.length) matches.push({ batch, tasks });
    }
    if (!matches.length) return { success: false, expired: true, error: '撤销时间已结束' };

    const deadline = Math.min(...matches.flatMap(({ tasks }) => tasks.map(task => Date.parse(task.deleteUndoUntil || 0))));
    if (!Number.isFinite(deadline) || clock() > deadline) {
      await finalizeDelete(token);
      return { success: false, expired: true, error: '撤销时间已结束' };
    }

    if (timers.has(token)) {
      clearTimer(timers.get(token));
      timers.delete(token);
    }
    for (const { batch, tasks } of matches) {
      for (const task of tasks) {
        task.hiddenInTaskList = false;
        task.deleteRequestedAt = null;
        task.deleteUndoUntil = null;
        task.deleteToken = null;
        task.discardLateResult = false;
      }
      batchStore.saveBatch(batch);
      if (!batch.userPauseRequested && !batch.systemPauseRequested
          && batch.tasks.some(task => !task.hiddenInTaskList && task.executionStatus === 'pending')) {
        runners?.start?.(batch.batchId)?.catch?.(() => {});
      }
    }
    return { success: true, count: matches.reduce((sum, item) => sum + item.tasks.length, 0), batchIds: matches.map(item => item.batch.batchId) };
  }

  async function recoverPendingDeletes() {
    const pending = new Map();
    for (const batch of batchStore.listBatches()) {
      for (const task of batch.tasks || []) {
        if (!task.deleteToken || task.deletedAt) continue;
        const deadline = Date.parse(task.deleteUndoUntil || 0);
        if (!pending.has(task.deleteToken)) pending.set(task.deleteToken, deadline);
        else pending.set(task.deleteToken, Math.min(pending.get(task.deleteToken), deadline));
      }
    }
    for (const [token, deadline] of pending) {
      if (!Number.isFinite(deadline) || deadline <= clock()) await finalizeDelete(token);
      else scheduleFinalize(token, deadline - clock());
    }
    return pending.size;
  }

  function dispose() {
    for (const timer of timers.values()) clearTimer(timer);
    timers.clear();
  }

  return {
    listHistory: historyItems,
    requestDelete,
    finalizeDelete,
    undoDelete,
    recoverPendingDeletes,
    dispose,
    __test: { parseItemId, safeInside, currentBatch }
  };
};
