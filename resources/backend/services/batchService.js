// batchService.js — 批次数据读取、状态统计、清理操作（不负责执行任务）

module.exports = function(deps) {
  const { batchStore } = deps;

  return {
    // 加载批次（含校验）
    loadBatch(batchId) {
      if (!batchStore.safeBatchName(batchId)) return null;
      return batchStore.loadBatch(batchId);
    },

    // 获取最新批次
    latestBatch() {
      return batchStore.latestBatch();
    },

    // 脱敏输出
    publicBatch(batch) {
      return batchStore.publicBatch(batch);
    },

    // 重算统计并保存
    saveBatch(batch) {
      return batchStore.saveBatch(batch);
    },

    // 恢复批次任务状态
    resumeBatchTasks(batch) {
      const remoteUnknown = batch.tasks.some(task =>
        task.runtimeStatus === 'remote_unknown'
        || ['submitting', 'submitted', 'unknown', 'cancelled_after_submit'].includes(task.generationSubmissionState)
      );
      if (remoteUnknown) return { blocked: true, code: 'REMOTE_RESULT_UNKNOWN', resumed: 0 };
      if (batch.systemPauseRequested) return { blocked: true, code: 'SYSTEM_PAUSED', resumed: 0 };

      let resetCount = 0;
      for (const task of batch.tasks) {
        const safeInterrupted = task.executionStatus === 'interrupted'
          && ['not_submitted', 'prepared', 'cancelled_before_submit'].includes(task.generationSubmissionState);
        if (safeInterrupted) {
          task.executionStatus = 'pending';
          task.runtimeStatus = null;
          task.error = null;
          resetCount++;
        }
      }
      batch.userPauseRequested = false;
      batch.status = 'running';
      batch.active = true;
      batch.cancelRequested = false;
      batchStore.saveBatch(batch);
      return { blocked: false, resumed: resetCount };
    },

    // 判断批次是否全部完成
    isAllDone(batch) {
      return !batch.tasks.some(t =>
        ['pending', 'running', 'interrupted'].includes(t.executionStatus)
      );
    }
  };
};
