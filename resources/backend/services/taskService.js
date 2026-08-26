// taskService.js — one recolor task equals one paid generation submission
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');

const REMOTE_UNKNOWN = 'remote_unknown';
const TASK_DISCARDED = 'TASK_DISCARDED';

function uniqueTempToken() {
  return `${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

async function removeIfPresent(filePath) {
  try { await fs.promises.unlink(filePath); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function discardedError() {
  const error = new Error('任务已删除，迟到结果已丢弃');
  error.code = TASK_DISCARDED;
  return error;
}

function isDiscarded(batch, task) {
  return Boolean(batch?.purgeRequested || task?.discardLateResult || task?.deletedAt);
}

function safeResultPath(dir, relativePath) {
  if (!relativePath) return null;
  const root = path.resolve(dir) + path.sep;
  const resolved = path.resolve(dir, relativePath);
  return resolved.startsWith(root) ? resolved : null;
}

async function removeResultFiles(dir, relativePath) {
  const resultPath = safeResultPath(dir, relativePath);
  if (!resultPath) return;
  const previewPath = resultPath.replace(/_final\.jpg$/i, '_preview.jpg');
  await Promise.allSettled([...new Set([resultPath, previewPath])].map(removeIfPresent));
}

async function writeResultAtomic({ buffer, dir, stem, shouldDiscard = () => false }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('API 返回空图片');

  const attemptsDir = path.join(dir, 'attempts');
  const imagesDir = path.join(dir, 'images');
  await fs.promises.mkdir(attemptsDir, { recursive: true });
  await fs.promises.mkdir(imagesDir, { recursive: true });

  const token = uniqueTempToken();
  const sourceTemp = path.join(attemptsDir, `.${stem}.${token}.download.tmp`);
  const finalRel = `images/${stem}_final.jpg`;
  const finalPath = path.join(dir, finalRel);
  const finalTemp = path.join(imagesDir, `.${stem}.${token}.result.tmp.jpg`);
  const backupPath = path.join(imagesDir, `.${stem}.${token}.previous.bak.jpg`);
  let previousMoved = false;
  let finalCommitted = false;

  try {
    await fs.promises.writeFile(sourceTemp, buffer, { flag: 'wx' });
    await sharp(sourceTemp).jpeg({ quality: 95 }).toFile(finalTemp);

    const metadata = await sharp(finalTemp).metadata();
    if (!metadata.width || !metadata.height || metadata.format !== 'jpeg') {
      throw new Error('生成图片无法完整读取');
    }
    // stats() forces a full pixel decode instead of accepting a valid-looking header only.
    await sharp(finalTemp).stats();

    if (shouldDiscard()) throw discardedError();

    if (fs.existsSync(finalPath)) {
      await fs.promises.rename(finalPath, backupPath);
      previousMoved = true;
    }

    if (shouldDiscard()) {
      await removeIfPresent(backupPath);
      previousMoved = false;
      throw discardedError();
    }

    try {
      await fs.promises.rename(finalTemp, finalPath);
      finalCommitted = true;
    } catch (error) {
      if (previousMoved) {
        await fs.promises.rename(backupPath, finalPath);
        previousMoved = false;
      }
      throw error;
    }

    if (shouldDiscard()) {
      await Promise.allSettled([removeIfPresent(finalPath), removeIfPresent(backupPath)]);
      previousMoved = false;
      throw discardedError();
    }

    if (previousMoved) {
      await removeIfPresent(backupPath);
      previousMoved = false;
    }
    return { finalRel, finalPath, width: metadata.width, height: metadata.height };
  } finally {
    if (previousMoved && !finalCommitted && !shouldDiscard()) {
      try { await fs.promises.rename(backupPath, finalPath); } catch (_) {}
    }
    // Cleanup failures must not turn an already-written final image into a false task failure.
    await Promise.allSettled([
      removeIfPresent(sourceTemp),
      removeIfPresent(finalTemp),
      removeIfPresent(backupPath)
    ]);
  }
}

module.exports = function createTaskService(deps) {
  const {
    batchStore,
    apiClient,
    safeFileStem,
    now,
    errorMessage,
    onSystemPause = () => {},
    resultWriter = writeResultAtomic
  } = deps;

  const runnerLog = path.join(__dirname, '..', '..', 'logs', 'task-runner.log');
  const logDir = path.dirname(runnerLog);
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

  function logStage(stage, batch, task, extra) {
    const entry = [
      `[${now()}]`,
      `batch: ${batch.batchId}`,
      `task: ${task.order}.${task.templateNameWithoutExt}/${task.colorNameWithoutExt}`,
      `stage: ${stage}`,
      `mem: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
      extra ? `info: ${extra}` : ''
    ].filter(Boolean).join(' ');
    try { fs.appendFileSync(runnerLog, entry + '\n'); } catch (_) {}
  }

  function lockedCostFen(batch, task) {
    return Math.max(0, Number(
      task.costPerCallFenSnapshot ?? batch.costPerCallFenSnapshot ?? batch.costPerCallFen ?? 0
    ));
  }

  function pauseForRemoteUnknown(batch, task, error) {
    task.executionStatus = 'interrupted';
    task.runtimeStatus = REMOTE_UNKNOWN;
    task.generationSubmissionState = 'unknown';
    task.providerTaskId = error?.providerTaskId || task.providerTaskId || null;
    task.error = '服务商可能已收到请求，正在确认结果；为避免重复扣费，已暂停领取新任务';
    task.finishedAt = now();

    batch.systemPauseRequested = true;
    batch.pauseReason = REMOTE_UNKNOWN;
    batch.status = 'pausing';
  }

  function pauseForGlobalApiError(batch, task, error, attemptRecorded) {
    const modelUnavailable = error?.modelUnavailable === true;
    if (modelUnavailable) {
      // 模型不存在/停用/不支持时，只把尚未提交的任务退回安全等待态。
      // 已产生调用记录的任务保留失败历史，绝不借改绑再次提交。
      task.executionStatus = attemptRecorded ? 'error' : 'pending';
      task.runtimeStatus = null;
      task.generationSubmissionState = attemptRecorded ? 'failed' : 'not_submitted';
      task.error = attemptRecorded ? '原模型不可用；本次调用记录已保留' : null;
      task.finishedAt = attemptRecorded ? now() : null;
    } else {
      task.executionStatus = 'interrupted';
      task.runtimeStatus = 'system_error';
      task.generationSubmissionState = attemptRecorded ? 'failed' : 'not_submitted';
      task.error = `系统 API 配置或账户异常：${errorMessage(error)}`;
      task.finishedAt = now();
    }
    batch.systemPauseRequested = true;
    batch.pauseReason = modelUnavailable ? 'model_unavailable' : 'global_api_error';
    if (modelUnavailable) {
      batch.unavailableBinding = {
        providerId: String(task.providerIdSnapshot || batch.providerIdSnapshot || batch.providerId || ''),
        model: String(task.modelSnapshot || batch.modelSnapshot || batch.model || ''),
        detectedAt: now()
      };
    }
    batch.healthCheckConsecutive = 0;
    batch.status = 'pausing';
  }

  async function commitApiResult(batch, task, apiResult, controller, started) {
    const dir = batchStore.batchDir(batch.batchId);
    const nextResultVersion = Number(task.resultVersion || 0) + 1;
    const stem = `${String(task.order).padStart(3, '0')}_${safeFileStem(task.templateNameWithoutExt)}_${safeFileStem(task.colorNameWithoutExt)}_v${nextResultVersion}`;
    if (apiResult?.providerTaskId) task.providerTaskId = apiResult.providerTaskId;
    const buffer = apiResult.type === 'base64'
      ? Buffer.from(apiResult.data, 'base64')
      : await apiClient.downloadUrl(apiResult.data, controller.signal);

    if (isDiscarded(batch, task)) throw discardedError();
    logStage('output_atomic_write_start', batch, task);
    const previous = {
      output: task.output || null,
      resultVersion: Number(task.resultVersion || 0),
      exportedAt: task.exportedAt ?? null,
      exportedResultVersion: Number(task.exportedResultVersion || 0)
    };
    const written = await resultWriter({
      buffer,
      dir,
      stem,
      task,
      batch,
      shouldDiscard: () => isDiscarded(batch, task)
    });

    if (isDiscarded(batch, task)) {
      await removeResultFiles(dir, written.finalRel);
      throw discardedError();
    }

    try {
      task.output = written.finalRel;
      task.resultVersion = nextResultVersion;
      task.exportedAt = null;
      task.exportedResultVersion = 0;
      task.executionStatus = 'completed';
      task.runtimeStatus = null;
      task.generationSubmissionState = 'resolved';
      task.qualityStatus = 'review_required';
      task.correctionRounds = 0;
      task.redoRequestedAt = null;
      task.finishedAt = now();
      task.elapsedMs = Date.now() - started;
      batchStore.saveBatch(batch);
    } catch (error) {
      task.output = previous.output;
      task.resultVersion = previous.resultVersion;
      task.exportedAt = previous.exportedAt;
      task.exportedResultVersion = previous.exportedResultVersion;
      await removeResultFiles(dir, written.finalRel);
      throw error;
    }

    if (previous.output && previous.output !== written.finalRel) await removeResultFiles(dir, previous.output);
    logStage('task_completed', batch, task, `costFen=${task.costFen}`);
  }

  async function processTask(batch, task, controller) {
    if (isDiscarded(batch, task)) return;
    const unresolvedSubmission = ['submitting', 'submitted', 'unknown'].includes(task.generationSubmissionState);
    if (task.runtimeStatus === REMOTE_UNKNOWN || (task.executionStatus === 'interrupted' && unresolvedSubmission)) {
      pauseForRemoteUnknown(batch, task, { providerTaskId: task.providerTaskId });
      batchStore.saveBatch(batch);
      logStage('task_remote_unknown_guard', batch, task);
      return;
    }

    const nextResultVersion = Number(task.resultVersion || 0) + 1;
    const stem = `${String(task.order).padStart(3, '0')}_${safeFileStem(task.templateNameWithoutExt)}_${safeFileStem(task.colorNameWithoutExt)}_v${nextResultVersion}`;
    const started = Date.now();
    const requestId = unresolvedSubmission && task.generationRequestId
      ? task.generationRequestId
      : `${task.id || stem}-${Date.now()}`;
    let attemptRecorded = false;

    task.executionStatus = 'running';
    task.runtimeStatus = 'preparing';
    task.generationSubmissionState = 'prepared';
    task.generationRequestId = requestId;
    task.startedAt = task.startedAt || now();
    task.error = null;
    batchStore.saveBatch(batch);
    logStage('task_start', batch, task);

    const recordGenerationAttempt = details => {
      if (isDiscarded(batch, task)) return;
      if (attemptRecorded) {
        if (details?.providerTaskId && details.providerTaskId !== task.providerTaskId) {
          task.providerTaskId = details.providerTaskId;
          batchStore.saveBatch(batch);
        }
        return;
      }
      attemptRecorded = true;
      task.apiAttempts = Number(task.apiAttempts || 0) + 1;
      task.costFen = Number(task.costFen || 0) + lockedCostFen(batch, task);
      task.runtimeStatus = 'awaiting_remote';
      task.generationSubmissionState = 'submitted';
      task.generationSubmittedAt = now();
      if (details?.providerTaskId) task.providerTaskId = details.providerTaskId;
      batchStore.saveBatch(batch);
      logStage('generation_submitted', batch, task, `attempt=${task.apiAttempts}`);
    };

    try {
      if (batch.cancelRequested || controller.signal.aborted) throw new Error('任务已取消');

      const apiResult = await apiClient.editImage({
        imagePath: task.templatePath,
        colorImagePath: task.colorPath,
        prompt: task.promptSnapshot || batch.promptSnapshot || batch.prompt || '',
        requestId,
        size: task.imageSizeSnapshot || batch.imageSizeSnapshot || batch.imageSize,
        signal: controller.signal,
        providerId: task.providerIdSnapshot || task.providerId || batch.providerIdSnapshot || batch.providerId || '',
        quality: task.qualitySnapshot || task.quality || batch.qualitySnapshot || batch.quality || '',
        model: task.modelSnapshot || task.model || batch.modelSnapshot || batch.model || '',
        onGenerationAttempt: recordGenerationAttempt
      });

      await commitApiResult(batch, task, apiResult, controller, started);
    } catch (error) {
      if (isDiscarded(batch, task) || error?.code === TASK_DISCARDED) {
        task.executionStatus = 'deleted';
        task.runtimeStatus = null;
        task.hiddenInTaskList = true;
        task.discardLateResult = true;
        return;
      }
      const cancelled = batch.cancelRequested || controller.signal.aborted || errorMessage(error) === '任务已取消';

      if (cancelled) {
        task.executionStatus = 'cancelled';
        task.runtimeStatus = null;
        task.generationSubmissionState = attemptRecorded ? 'cancelled_after_submit' : 'cancelled_before_submit';
        task.qualityStatus = 'cancelled';
        task.error = '用户已停止任务';
        task.finishedAt = now();
      } else if (error?.remoteResultUnknown === true) {
        pauseForRemoteUnknown(batch, task, error);
      } else if (error?.globalApiError === true) {
        pauseForGlobalApiError(batch, task, error, attemptRecorded);
      } else {
        task.executionStatus = 'error';
        task.runtimeStatus = null;
        task.generationSubmissionState = attemptRecorded ? 'failed' : 'not_submitted';
        task.qualityStatus = 'review_required';
        task.error = errorMessage(error);
        task.finishedAt = now();
      }

      task.elapsedMs = Date.now() - started;
      batchStore.saveBatch(batch);
      if (error?.globalApiError === true && error?.modelUnavailable !== true) onSystemPause(batch.batchId);
      logStage(error?.remoteResultUnknown ? 'task_remote_unknown' : 'task_failed', batch, task, `err=${task.error?.slice(0, 120)}`);
    }
  }

  async function resolveRemoteTask(batch, task, apiResult) {
    const controller = new AbortController();
    task.runtimeStatus = 'resolving_remote';
    batchStore.saveBatch(batch);
    await commitApiResult(batch, task, apiResult, controller, Date.now());
    return task;
  }

  return { processTask, resolveRemoteTask };
};

module.exports.__test = { writeResultAtomic };
