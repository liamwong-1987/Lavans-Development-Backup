module.exports = function createRecolorHealthService(deps) {
  const {
    batchStore,
    apiClient,
    taskRunner,
    intervalMs = 5000,
    requiredSuccesses = 2,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval
  } = deps;
  const timers = new Map();
  let taskService = deps.taskService || null;

  function injectTaskService(service) { taskService = service; }

  function hasRemoteUnknown(batch) {
    return (batch?.tasks || []).some(task => task.runtimeStatus === 'remote_unknown'
      || ['submitting','submitted','unknown','cancelled_after_submit'].includes(task.generationSubmissionState));
  }

  function stop(batchId) {
    const timer = timers.get(batchId);
    if (timer) clearIntervalFn(timer);
    timers.delete(batchId);
  }

  function recoverBatch(batch) {
    let resumed = 0;
    for (const task of batch.tasks || []) {
      if (task.executionStatus !== 'interrupted' || task.runtimeStatus !== 'system_error') continue;
      task.executionStatus = 'pending';
      task.runtimeStatus = null;
      task.generationSubmissionState = 'not_submitted';
      task.error = null;
      resumed++;
    }
    batch.systemPauseRequested = false;
    batch.pauseReason = null;
    batch.healthCheckConsecutive = requiredSuccesses;
    batch.status = batch.userPauseRequested ? 'paused' : 'running';
    batch.active = !batch.userPauseRequested;
    batchStore.saveBatch(batch);
    stop(batch.batchId);
    if (!batch.userPauseRequested) taskRunner.resume(batch.batchId).catch(error => console.error('[RECOLOR-HEALTH-RESUME]', error.message));
    return resumed;
  }

  async function checkNow(batchId) {
    const batch = batchStore.loadBatch(batchId);
    if (!batch) return { success: false, code: 'BATCH_NOT_FOUND', ready: false, consecutive: 0 };
    if (hasRemoteUnknown(batch)) return { success: false, code: 'REMOTE_RESULT_UNKNOWN', ready: false, consecutive: Number(batch.healthCheckConsecutive || 0) };
    if (!batch.systemPauseRequested || batch.pauseReason !== 'global_api_error') {
      return { success: true, ready: true, consecutive: requiredSuccesses, resumed: 0 };
    }
    const health = await apiClient.checkHealth({ providerId: batch.providerIdSnapshot || batch.providerId || '' });
    if (!health.success) {
      batch.healthCheckConsecutive = 0;
      batch.lastHealthCheckAt = new Date().toISOString();
      batch.lastHealthCheckError = health.error || '健康检查失败';
      batchStore.saveBatch(batch);
      return { success: false, code: health.code || 'HEALTH_CHECK_FAILED', ready: false, consecutive: 0, error: batch.lastHealthCheckError };
    }
    batch.healthCheckConsecutive = Number(batch.healthCheckConsecutive || 0) + 1;
    batch.lastHealthCheckAt = new Date().toISOString();
    batch.lastHealthCheckError = null;
    if (batch.healthCheckConsecutive < requiredSuccesses) {
      batchStore.saveBatch(batch);
      return { success: true, ready: false, consecutive: batch.healthCheckConsecutive };
    }
    const resumed = recoverBatch(batch);
    return { success: true, ready: true, consecutive: requiredSuccesses, resumed };
  }

  async function resolveRemoteUnknown(batchId) {
    const batch = batchStore.loadBatch(batchId);
    if (!batch) return { success: false, code: 'BATCH_NOT_FOUND', resolved: 0, remaining: 0 };
    let resolved = 0;
    for (const task of batch.tasks || []) {
      const unknown = task.runtimeStatus === 'remote_unknown'
        || ['submitting','submitted','unknown','cancelled_after_submit'].includes(task.generationSubmissionState);
      if (!unknown) continue;
      const result = await apiClient.queryGenerationResult({
        providerId: task.providerIdSnapshot || batch.providerIdSnapshot || batch.providerId || '',
        providerTaskId: task.providerTaskId
      });
      if (result.status === 'completed' && taskService?.resolveRemoteTask) {
        await taskService.resolveRemoteTask(batch, task, result);
        resolved++;
      } else if (result.status === 'failed') {
        task.executionStatus = 'error';
        task.runtimeStatus = null;
        task.generationSubmissionState = 'resolved_failed';
        task.error = result.error || '远端任务失败';
        task.finishedAt = new Date().toISOString();
        resolved++;
      } else {
        task.executionStatus = 'interrupted';
        task.runtimeStatus = 'remote_unknown';
        task.generationSubmissionState = 'unknown';
        task.error = result.error || '远端结果仍在确认中';
      }
    }
    const remaining = (batch.tasks || []).filter(task => task.runtimeStatus === 'remote_unknown'
      || ['submitting','submitted','unknown','cancelled_after_submit'].includes(task.generationSubmissionState)).length;
    if (!remaining) {
      batch.systemPauseRequested = false;
      batch.pauseReason = null;
    }
    batchStore.saveBatch(batch);
    return { success: remaining === 0, code: remaining ? 'REMOTE_RESULT_UNKNOWN' : null, resolved, remaining };
  }

  function watch(batchId) {
    if (!batchId || timers.has(batchId)) return;
    const tick = () => checkNow(batchId).catch(error => console.error('[RECOLOR-HEALTH]', error.message));
    const timer = setIntervalFn(tick, intervalMs);
    timer?.unref?.();
    timers.set(batchId, timer);
  }

  return { checkNow, resolveRemoteUnknown, watch, stop, injectTaskService, __test: { hasRemoteUnknown, recoverBatch } };
};
