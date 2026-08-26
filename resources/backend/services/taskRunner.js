// taskRunner.js — 一键复色唯一 FIFO 队列与并发执行器
const crypto = require('crypto');

module.exports = function createTaskRunner(deps) {
  const { batchStore, now } = deps;
  const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const minConcurrency = Number(deps.minConcurrency ?? 3);
  const maxConcurrency = Number(deps.maxConcurrency ?? 8);

  let _taskService = deps.taskService || null;
  const runners = new Map();

  function injectTaskService(service) { _taskService = service; }

  function clampConcurrency(value) {
    const parsed = Number(value);
    return Math.min(maxConcurrency, Math.max(minConcurrency, Number.isFinite(parsed) ? Math.trunc(parsed) : maxConcurrency));
  }

  function queueSequence(task) {
    const value = Number(task?.queueSequence ?? task?.order ?? Number.MAX_SAFE_INTEGER);
    return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
  }

  function queueKey(task) {
    return `${task?.id || ''}:${Number(task?.queueAttempt || 0)}`;
  }

  function fifoTasks(tasks) {
    const seen = new Set();
    return [...(tasks || [])]
      .sort((a, b) => queueSequence(a) - queueSequence(b)
        || String(a?.queuedAt || '').localeCompare(String(b?.queuedAt || ''))
        || String(a?.id || '').localeCompare(String(b?.id || '')))
      .filter(task => {
        const key = queueKey(task);
        if (!task?.id || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function codedError(code, message, statusCode = 409) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
  }

  function binding(value = {}) {
    return {
      providerId: String(value.providerId || '').trim().slice(0, 120),
      model: String(value.model || '').trim().slice(0, 200)
    };
  }

  function digest(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  function protectedReason(task, runner, from) {
    if (task?.hiddenInTaskList || task?.deletedAt || task?.deleteRequestedAt || task?.discardLateResult) return 'deleted';
    if (String(task?.providerIdSnapshot || '') !== from.providerId || String(task?.modelSnapshot || '') !== from.model) return 'binding_mismatch';
    const key = queueKey(task);
    if (runner?.active?.has(key) || runner?.claimed?.has(key)) return 'claimed';
    if (Number(task?.apiAttempts || 0) > 0 || Number(task?.costFen || 0) > 0) return 'already_charged';
    const submissionState = String(task?.generationSubmissionState || '').toLowerCase();
    if (!['', 'not_submitted', 'prepared', 'cancelled_before_submit'].includes(submissionState)) return 'already_submitted';
    if (task?.runtimeStatus) return 'runtime_active';
    if (String(task?.executionStatus || '').toLowerCase() !== 'pending') return 'not_pending';
    return null;
  }

  function buildRebindPreview(batch, runner, command = {}) {
    if (!batch) throw codedError('BATCH_NOT_FOUND', '批次不存在', 404);
    if (batch.purgeRequested || batch.resetMode || batch.cancelRequested || ['cancelled', 'deleted'].includes(String(batch.status || '').toLowerCase())) {
      throw codedError('REBIND_BATCH_BLOCKED', '当前批次正在取消或清理，不能改绑模型');
    }
    const from = binding(command.from);
    const to = binding(command.to);
    if (!from.providerId || !from.model || !to.providerId || !to.model) {
      throw codedError('REBIND_BINDING_REQUIRED', '必须提供完整的原模型和目标模型', 400);
    }
    if (from.providerId === to.providerId && from.model === to.model) {
      throw codedError('REBIND_TARGET_UNCHANGED', '目标模型必须与原模型不同', 400);
    }

    const protectedCounts = {};
    const eligibleTaskIds = [];
    const fingerprints = [];
    const oldCostsFen = new Set();
    for (const task of fifoTasks(batch.tasks)) {
      const reason = protectedReason(task, runner, from);
      if (reason) protectedCounts[reason] = Number(protectedCounts[reason] || 0) + 1;
      else {
        eligibleTaskIds.push(task.id);
        oldCostsFen.add(Math.max(0, Number(task.costPerCallFenSnapshot || 0)));
      }
      fingerprints.push({
        id: task.id,
        queueAttempt: Number(task.queueAttempt || 0),
        executionStatus: task.executionStatus || '',
        runtimeStatus: task.runtimeStatus || '',
        generationSubmissionState: task.generationSubmissionState || '',
        apiAttempts: Number(task.apiAttempts || 0),
        costFen: Number(task.costFen || 0),
        providerIdSnapshot: task.providerIdSnapshot || '',
        modelSnapshot: task.modelSnapshot || '',
        hiddenInTaskList: Boolean(task.hiddenInTaskList),
        deletedAt: task.deletedAt || '',
        active: Boolean(runner?.active?.has(queueKey(task))),
        claimed: Boolean(runner?.claimed?.has(queueKey(task)))
      });
    }
    const previewToken = digest({
      batchId: batch.batchId,
      bindingRevision: Number(batch.bindingRevision || 0),
      from,
      to,
      fingerprints
    });
    return {
      batchId: batch.batchId,
      from,
      to,
      eligibleTaskIds,
      eligibleCount: eligibleTaskIds.length,
      protectedCount: fingerprints.length - eligibleTaskIds.length,
      protectedCounts,
      oldCostsFen: [...oldCostsFen].sort((a, b) => a - b),
      previewToken,
      bindingRevision: Number(batch.bindingRevision || 0),
      canResume: false
    };
  }

  function batchForRebind(batchId) {
    const runner = runners.get(batchId);
    const fresh = batchStore.loadBatch(batchId);
    if (runner && fresh) mergeFresh(runner, fresh);
    return { runner, batch: runner ? runner.batch : fresh };
  }

  function previewPendingModelRebind(batchId, command) {
    const current = batchForRebind(batchId);
    return buildRebindPreview(current.batch, current.runner, command);
  }

  function rebindPendingTasks(batchId, command = {}) {
    const current = batchForRebind(batchId);
    const batch = current.batch;
    if (!batch) throw codedError('BATCH_NOT_FOUND', '批次不存在', 404);
    const requestId = String(command.requestId || '').trim().slice(0, 120);
    if (!requestId) throw codedError('REBIND_REQUEST_ID_REQUIRED', '缺少改绑请求编号', 400);
    const requestHash = digest({
      previewToken: String(command.previewToken || ''),
      from: binding(command.from),
      to: binding(command.to),
      pricing: command.pricing || null
    });
    const previousReceipt = (batch.modelRebindReceipts || []).find(item => item.requestId === requestId);
    if (previousReceipt) {
      if (previousReceipt.requestHash !== requestHash) {
        throw codedError('REBIND_REQUEST_CONFLICT', '相同请求编号不能用于不同的改绑内容');
      }
      return { ...previousReceipt.response, replayed: true };
    }

    const preview = buildRebindPreview(batch, current.runner, command);
    if (!command.previewToken || command.previewToken !== preview.previewToken) {
      throw codedError('REBIND_PREVIEW_STALE', '任务状态已变化，请重新确认改绑范围');
    }
    if (!preview.eligibleTaskIds.length) throw codedError('REBIND_NO_ELIGIBLE_TASKS', '没有可安全改绑的未提交任务');

    const pricing = command.pricing || {};
    const pricingMode = String(pricing.mode || '');
    if (!['keep-current-estimate', 'replace-estimate'].includes(pricingMode)) {
      throw codedError('REBIND_PRICING_REQUIRED', '请选择沿用原估算或输入新估算', 400);
    }
    const targetCostPerCallFen = pricingMode === 'replace-estimate'
      ? Number(pricing.targetCostPerCallFen)
      : null;
    if (pricingMode === 'replace-estimate' && (!Number.isInteger(targetCostPerCallFen) || targetCostPerCallFen < 0 || targetCostPerCallFen > 100000000)) {
      throw codedError('REBIND_PRICING_INVALID', '新的估算单价必须是有效的非负整数分', 400);
    }

    const eligible = new Set(preview.eligibleTaskIds);
    const changedTasks = batch.tasks.filter(task => eligible.has(task.id));
    const taskBackup = changedTasks.map(task => ({
      task,
      providerIdSnapshot: task.providerIdSnapshot,
      modelSnapshot: task.modelSnapshot,
      costPerCallFenSnapshot: task.costPerCallFenSnapshot,
      bindingRevision: task.bindingRevision,
      modelReboundAt: task.modelReboundAt,
      modelRebindRequestId: task.modelRebindRequestId
    }));
    const batchBackup = {
      bindingRevision: batch.bindingRevision,
      modelRebindReceipts: batch.modelRebindReceipts,
      lastModelRebind: batch.lastModelRebind
    };
    const reboundAt = now();
    const nextRevision = Number(batch.bindingRevision || 0) + 1;
    for (const task of changedTasks) {
      task.providerIdSnapshot = preview.to.providerId;
      task.modelSnapshot = preview.to.model;
      if (pricingMode === 'replace-estimate') task.costPerCallFenSnapshot = targetCostPerCallFen;
      task.bindingRevision = nextRevision;
      task.modelReboundAt = reboundAt;
      task.modelRebindRequestId = requestId;
    }
    batch.bindingRevision = nextRevision;
    const response = {
      requestId,
      replayed: false,
      updatedCount: changedTasks.length,
      protectedCount: preview.protectedCount,
      protectedCounts: preview.protectedCounts,
      from: preview.from,
      to: preview.to,
      pricing: pricingMode === 'replace-estimate'
        ? { mode: pricingMode, targetCostPerCallFen }
        : { mode: pricingMode },
      bindingRevision: nextRevision,
      remainsPaused: true,
      reboundAt
    };
    const receipt = { requestId, requestHash, response };
    batch.modelRebindReceipts = [...(batch.modelRebindReceipts || []).filter(item => item.requestId !== requestId), receipt].slice(-20);
    batch.lastModelRebind = response;
    try {
      batchStore.saveBatch(batch);
    } catch (error) {
      for (const old of taskBackup) {
        old.task.providerIdSnapshot = old.providerIdSnapshot;
        old.task.modelSnapshot = old.modelSnapshot;
        old.task.costPerCallFenSnapshot = old.costPerCallFenSnapshot;
        old.task.bindingRevision = old.bindingRevision;
        old.task.modelReboundAt = old.modelReboundAt;
        old.task.modelRebindRequestId = old.modelRebindRequestId;
      }
      batch.bindingRevision = batchBackup.bindingRevision;
      batch.modelRebindReceipts = batchBackup.modelRebindReceipts;
      batch.lastModelRebind = batchBackup.lastModelRebind;
      throw error;
    }
    return response;
  }

  function mergeFresh(runner, fresh, { allowResume = false } = {}) {
    if (!fresh || !Array.isArray(fresh.tasks)) return runner.batch;
    const currentById = new Map(runner.batch.tasks.map(task => [task.id, task]));
    const merged = [];

    for (const freshTask of fresh.tasks) {
      const current = currentById.get(freshTask.id);
      if (!current) {
        merged.push(freshTask);
        continue;
      }
      if (!runner.active.has(queueKey(current))) Object.assign(current, freshTask);
      merged.push(current);
      currentById.delete(freshTask.id);
    }
    for (const current of currentById.values()) {
      if (runner.active.has(queueKey(current))) merged.push(current);
    }

    const activeTasks = runner.active;
    const oldUserPause = runner.batch.userPauseRequested;
    const oldSystemPause = runner.batch.systemPauseRequested;
    const oldCancel = runner.batch.cancelRequested;
    Object.assign(runner.batch, fresh);
    runner.batch.tasks = fifoTasks(merged);
    runner.batch.concurrency = clampConcurrency(fresh.concurrency);
    runner.batch.userPauseRequested = allowResume ? Boolean(fresh.userPauseRequested) : Boolean(oldUserPause || fresh.userPauseRequested);
    runner.batch.systemPauseRequested = allowResume ? Boolean(fresh.systemPauseRequested) : Boolean(oldSystemPause || fresh.systemPauseRequested);
    runner.batch.cancelRequested = Boolean(oldCancel || fresh.cancelRequested);
    runner.active = activeTasks;
    return runner.batch;
  }

  function hasUnfinished(batch) {
    return batch.tasks.some(task => ['pending', 'running', 'interrupted'].includes(task.executionStatus));
  }

  function runBatch(batchId) {
    const batch = batchStore.loadBatch(batchId);
    if (!batch) return Promise.resolve(null);
    if (runners.has(batchId)) return runners.get(batchId).promise;
    if (batch.userPauseRequested || batch.systemPauseRequested) return Promise.resolve(batch);
    if (!_taskService) return Promise.reject(new Error('任务执行服务尚未初始化'));

    const runner = {
      batch,
      controller: new AbortController(),
      active: new Set(),
      claimed: new Set(),
      purgeRequested: false,
      promise: null
    };
    runners.set(batchId, runner);

    runner.promise = (async () => {
      try {
        batch.status = 'running';
        batch.active = true;
        batch.cancelRequested = false;
        batch.concurrency = clampConcurrency(batch.concurrency);
        batchStore.saveBatch(batch);

        while (true) {
          const fresh = batchStore.loadBatch(batchId);
          if (fresh) mergeFresh(runner, fresh);

          if (runner.purgeRequested || batch.purgeRequested || batch.cancelRequested || runner.controller.signal.aborted) break;

          if (batch.userPauseRequested || batch.systemPauseRequested) {
            if (runner.active.size === 0) break;
            await sleep(20);
            continue;
          }

          const limit = clampConcurrency(batch.concurrency);
          const pending = fifoTasks(batch.tasks).filter(task =>
            !task.hiddenInTaskList
            && task.executionStatus === 'pending'
            && !runner.active.has(queueKey(task))
            && !runner.claimed.has(queueKey(task))
          );

          for (const task of pending) {
            if (batch.cancelRequested || runner.controller.signal.aborted || batch.userPauseRequested || batch.systemPauseRequested) break;
            if (runner.active.size >= limit) break;

            const claimKey = queueKey(task);
            if (runner.active.has(claimKey) || runner.claimed.has(claimKey)) continue;
            runner.active.add(claimKey);
            runner.claimed.add(claimKey);
            task.executionStatus = 'running';
            task.runtimeStatus = 'claimed';
            task.startedAt = task.startedAt || now();
            batchStore.saveBatch(batch);

            Promise.resolve(_taskService.processTask(batch, task, runner.controller))
              .catch(error => {
                if (runner.purgeRequested || batch.purgeRequested || task.discardLateResult || task.deletedAt) return;
                task.executionStatus = 'error';
                task.runtimeStatus = null;
                task.error = error?.message || '任务执行失败';
                task.finishedAt = now();
                batchStore.saveBatch(batch);
              })
              .finally(() => runner.active.delete(claimKey));
          }

          const hasPending = batch.tasks.some(task =>
            task.executionStatus === 'pending' && !runner.claimed.has(queueKey(task))
          );
          if (!hasPending && runner.active.size === 0) break;
          await sleep(20);
        }

        if (runner.purgeRequested || batch.purgeRequested) return null;
        const finalFresh = batchStore.loadBatch(batchId);
        if (finalFresh) mergeFresh(runner, finalFresh);
        const allDone = !hasUnfinished(batch);
        batch.active = false;
        batch.status = batch.cancelRequested ? 'cancelled' : allDone ? 'completed' : 'paused';
        if (allDone) {
          batch.finishedAt = now();
          batch.userPauseRequested = false;
        }
        batchStore.saveBatch(batch);
        return batch;
      } catch (error) {
        if (runner.purgeRequested || batch.purgeRequested) return null;
        batch.active = false;
        batch.status = 'error';
        batchStore.saveBatch(batch);
        throw error;
      } finally {
        runners.delete(batchId);
        if (runner.purgeRequested || batch.purgeRequested) return;
        const latest = batchStore.loadBatch(batchId);
        const shouldRestart = latest
          && !latest.cancelRequested
          && !latest.userPauseRequested
          && !latest.systemPauseRequested
          && latest.tasks.some(task => !task.hiddenInTaskList && task.executionStatus === 'pending');
        if (shouldRestart) {
          queueMicrotask(() => {
            start(batchId).catch(error => console.error('[TASK-RUNNER] restart:', error.message));
          });
        }
      }
    })();

    return runner.promise;
  }

  function start(batchId) {
    const existing = runners.get(batchId);
    if (existing) {
      const fresh = batchStore.loadBatch(batchId);
      if (fresh) mergeFresh(existing, fresh);
      return existing.promise;
    }
    return runBatch(batchId);
  }

  function pause(batchId) {
    const existing = runners.get(batchId);
    const fresh = batchStore.loadBatch(batchId);
    if (!fresh && !existing) return false;
    if (existing && fresh) mergeFresh(existing, fresh);
    const batch = existing ? existing.batch : fresh;
    batch.userPauseRequested = true;
    batch.status = existing?.active?.size ? 'pausing' : 'paused';
    batch.active = Boolean(existing?.active?.size);
    batchStore.saveBatch(batch);
    return true;
  }

  function resume(batchId) {
    const existing = runners.get(batchId);
    const fresh = batchStore.loadBatch(batchId);
    if (!fresh && !existing) return Promise.resolve(null);
    if (existing && fresh) mergeFresh(existing, fresh, { allowResume: true });
    const batch = existing ? existing.batch : fresh;
    batch.userPauseRequested = false;
    batch.status = 'running';
    batch.active = true;
    batch.finishedAt = null;
    batchStore.saveBatch(batch);
    if (existing) return existing.promise;
    return runBatch(batchId);
  }

  function setConcurrency(batchId, value) {
    const concurrency = clampConcurrency(value);
    const existing = runners.get(batchId);
    const fresh = batchStore.loadBatch(batchId);
    if (!fresh && !existing) return null;
    if (existing && fresh) mergeFresh(existing, fresh);
    const batch = existing ? existing.batch : fresh;
    batch.concurrency = concurrency;
    batchStore.saveBatch(batch);
    return concurrency;
  }

  return {
    injectTaskService,
    start,
    pause,
    resume,
    setConcurrency,
    previewPendingModelRebind,
    rebindPendingTasks,
    isRunning: batchId => runners.has(batchId),
    getRunner: batchId => runners.get(batchId),
    forceDeleteRunner: batchId => runners.delete(batchId),

    async cancel(batchId) {
      const runner = runners.get(batchId);
      if (!runner) return false;
      runner.batch.cancelRequested = true;
      runner.controller.abort();
      batchStore.saveBatch(runner.batch);
      try { await runner.promise; } catch (_) {}
      return true;
    },

    stopAllActive() {
      for (const [batchId, runner] of runners) {
        runner.batch.cancelRequested = true;
        runner.controller.abort();
        batchStore.saveBatch(runner.batch);
        runners.delete(batchId);
      }
    },

    stopAll() {
      for (const [batchId, runner] of runners) {
        runner.controller.abort();
        runners.delete(batchId);
      }
    },

    purgeAll() {
      const purged = [];
      for (const [batchId, runner] of runners) {
        runner.purgeRequested = true;
        runner.batch.purgeRequested = true;
        runner.batch.cancelRequested = true;
        for (const task of runner.batch.tasks || []) {
          task.hiddenInTaskList = true;
          task.discardLateResult = true;
          task.deletedAt = task.deletedAt || now();
        }
        runner.controller.abort();
        purged.push(batchId);
      }
      return purged;
    },

    __test: { clampConcurrency, fifoTasks, mergeFresh, queueKey, protectedReason, buildRebindPreview }
  };
};
