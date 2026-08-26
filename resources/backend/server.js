require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const RUNNER_LOG = path.join(__dirname, '..', 'logs', 'task-runner.log');
function retryLog(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [RETRY] ${msg}\n`;
  try { fs.appendFileSync(RUNNER_LOG, line, 'utf8'); } catch (e) {}
  console.log('[RETRY]', msg);
}

// ===== 加载持久化配置（config.json） =====
(function loadPersistedConfig() {
  const configPath = require('path').join(__dirname, 'config.json');
  try {
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (cfg.apiKey) process.env.API_KEY = cfg.apiKey;
      if (cfg.baseUrl) process.env.BASE_URL = cfg.baseUrl;
      if (cfg.imageModel) process.env.IMAGE_MODEL = cfg.imageModel;
      console.log('[CONFIG] Loaded persisted config (baseUrl=' + (cfg.baseUrl || 'default') + ', imageModel=' + (cfg.imageModel || 'default') + ', key=' + (cfg.apiKey ? '***' : 'N/A') + ')');
    }
  } catch (e) { console.warn('[CONFIG] Failed to load config.json:', e.message); }
})();

const crypto = require('crypto');
const sharp = require('sharp');

const validator = require('./validator');
const fileStore = require('./fileStore');
const colorEngine = require('./colorEngine');
const promptComposer = require('./promptComposer');
const qcEngine = require('./qcEngine');
const apiClient = require('./apiClient');
const exporter = require('./exporter');
const batchStore = require('./batchStore');
const { getModuleConfig } = require('./moduleConfigService');

// 拆分的路由模块
const configRoutes = require('./routes/configRoutes');
const scanRoutes = require('./routes/scanRoutes');
const outputRoutes = require('./routes/outputRoutes');
const logRoutes = require('./routes/logRoutes');
const creativeRoutes = require('./routes/creativeRoutes');
const canvasRoutes = require('./routes/canvasRoutes');
const chatRoutes = require('./routes/chatRoutes');
const assetManagerRoutes = require('./routes/assetManagerRoutes');
const BRAND = require('../frontend/brand-config.js');
const app = express();
const PORT = Number(process.env.PORT || 3001);
const MAX_CONCURRENCY = 8;
const MAX_CORRECTIONS = Math.min(Math.max(0, Number(process.env.MAX_CORRECTIONS || 1)), 1);
const API_COST_FEN = Math.max(0, Number(process.env.API_COST_FEN || 8));
const VISION_COST_FEN = Math.max(0, Number(process.env.VISION_COST_FEN || 2));

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.use('/output', express.static(fileStore.OUTPUT_DIR));
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// 共享状态缓存（包装为对象以便 routes 跨文件修改）
let validationCache = { data: null };
let colorMapCache = { data: {} };

// Service 层
const taskRunner = require('./services/taskRunner')({ batchStore, now });
const batchService = require('./services/batchService')({ batchStore, runners: taskRunner });
const recolorHealthService = require('./services/recolorHealthService')({ batchStore, apiClient, taskRunner });
const taskService = require('./services/taskService')({
  batchStore, apiClient, promptComposer, qcEngine, colorEngine,
  MAX_CORRECTIONS, VISION_COST_FEN,
  safeFileStem, now, errorMessage,
  onSystemPause: batchId => recolorHealthService.watch(batchId)
});
// 回注 taskService（避免循环依赖）
taskRunner.injectTaskService(taskService);
recolorHealthService.injectTaskService(taskService);

const recolorResultService = require('./services/recolorResultService')({ batchStore, runners: taskRunner, now });
recolorResultService.recoverPendingDeletes().catch(error => console.error('[RECOLOR-DELETE] recover:', error.message));

function now() { return new Date().toISOString(); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function errorMessage(error) { return error.response?.data?.error?.message || error.message || '未知错误'; }
function safeFileStem(value) {
  return String(value || 'image').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\.+$/g, '').slice(0, 80) || 'image';
}
function publicBatch(batch) { return batchService.publicBatch(batch); }

function getBatchOr404(req, res) {
  const batch = batchService.loadBatch(req.params.batchId);
  if (batch === null) {
    if (!batchStore.safeBatchName(req.params.batchId)) return res.status(400).json({ success: false, error: '无效批次ID' }), null;
    if (!batch) return res.status(404).json({ success: false, error: '批次不存在' }), null;
  }
  return batch;
}

function configuredRebindTarget(providerId, model) {
  const canvas = getModuleConfig('canvas');
  const provider = (canvas.providers || []).find(item => item.id === providerId);
  if (!provider) throw Object.assign(new Error('目标 Provider 不存在'), { code: 'REBIND_PROVIDER_NOT_FOUND', statusCode: 400 });
  if (provider.enabled === false) throw Object.assign(new Error('目标 Provider 已停用'), { code: 'REBIND_PROVIDER_DISABLED', statusCode: 409 });
  if (!(provider.image_models || []).includes(model)) throw Object.assign(new Error('目标模型不在该 Provider 的生图模型列表中'), { code: 'REBIND_MODEL_NOT_CONFIGURED', statusCode: 400 });
  const protocol = String(provider.protocol || '').toLowerCase();
  const configured = Boolean(
    provider.api_key
    || (protocol === 'comfyui' && provider.comfy_url)
    || (protocol === 'runninghub' && provider.runninghub_key)
    || (protocol === 'modelscope' && provider.modelscope_key)
    || (protocol === 'volcengine' && (provider.volcengine_key || (provider.volcengine_access_key && provider.volcengine_secret_key)))
  );
  if (!configured) throw Object.assign(new Error('目标 Provider 尚未配置可用凭据'), { code: 'REBIND_PROVIDER_UNCONFIGURED', statusCode: 409 });
  return { providerId: provider.id, providerName: provider.name || provider.id, model };
}

function modelUnavailableBatch(req, res) {
  const batch = getBatchOr404(req, res);
  if (!batch) return null;
  if (!batch.systemPauseRequested || batch.pauseReason !== 'model_unavailable' || !batch.unavailableBinding) {
    res.status(409).json({ success: false, code: 'REBIND_NOT_AVAILABLE', error: '当前批次不是原模型不可用暂停状态' });
    return null;
  }
  return batch;
}

function sendRebindError(res, error) {
  const status = Number(error?.statusCode || 0) || (error?.code === 'BATCH_NOT_FOUND' ? 404 : 409);
  return res.status(status).json({ success: false, code: error?.code || 'REBIND_FAILED', error: error?.message || '模型改绑失败' });
}

// ==================== 批次输入快照 ====================

function snapshotInputs(pairs, batchDir) {
  const inputsDir = path.join(batchDir, 'inputs');
  const tplDir = path.join(inputsDir, 'templates');
  const clrDir = path.join(inputsDir, 'colors');
  const mskDir = path.join(inputsDir, 'masks');
  [tplDir, clrDir, mskDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

  function uniqueDest(dir, sourcePath, sessionId) {
    const parsed = path.parse(path.basename(sourcePath));
    let dest = path.join(dir, parsed.base);
    if (!fs.existsSync(dest)) return dest;
    try {
      if (sha256(fs.readFileSync(dest)) === sha256(fs.readFileSync(sourcePath))) return dest;
    } catch (e) {}
    const safeSession = String(sessionId || 'dup').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'dup';
    let index = 1;
    do {
      const suffix = `__${safeSession}_${index}`;
      dest = path.join(dir, `${parsed.name}${suffix}${parsed.ext}`);
      index++;
    } while (fs.existsSync(dest));
    return dest;
  }

  const hashes = {};
  for (const pair of pairs) {
    const sessionId = pair.sessionId || pair.uploadSessionId || '';
    if (!hashes[pair.templatePath]) {
      const dest = uniqueDest(tplDir, pair.templatePath, sessionId);
      fs.copyFileSync(pair.templatePath, dest);
      hashes[pair.templatePath] = { dest, sha256: sha256(fs.readFileSync(dest)) };
    }
    if (!hashes[pair.colorPath]) {
      const dest = uniqueDest(clrDir, pair.colorPath, sessionId);
      fs.copyFileSync(pair.colorPath, dest);
      hashes[pair.colorPath] = { dest, sha256: sha256(fs.readFileSync(dest)) };
    }
    const userMaskPath = pair.templatePath.replace(/\.[^.]+$/, '_mask.png');
    if (fs.existsSync(userMaskPath) && !hashes[userMaskPath]) {
      const dest = uniqueDest(mskDir, userMaskPath, sessionId);
      fs.copyFileSync(userMaskPath, dest);
      hashes[userMaskPath] = { dest, sha256: sha256(fs.readFileSync(dest)) };
    }
  }
  return hashes;
}

// 创建单个任务对象（用于追加到现有批次）
function createTaskObject(batch, pair, order, costPerCallFen) {
  const id = crypto.randomUUID();
  const createdAt = now();
  return {
    id, order,
    queueSequence: order,
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
    colorCandidates: [],
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
  };
}

function requeueTaskAtTail(batch, task) {
  const nextSequence = (batch.tasks || []).reduce((max, item) => {
    const value = Number(item.queueSequence ?? item.order ?? 0);
    return Number.isFinite(value) ? Math.max(max, value) : max;
  }, 0) + 1;
  task.queueSequence = nextSequence;
  task.order = nextSequence;
  task.queueAttempt = Number(task.queueAttempt || 0) + 1;
  task.queuedAt = now();
  task.runtimeStatus = null;
  task.generationSubmissionState = 'not_submitted';
}

function prepareTaskRedo(batch, task) {
  task.executionStatus = 'pending';
  task.error = null;
  task.deltaE = null;
  task.correctionRounds = 0;
  task.colorStatus = null;
  task.structureStatus = null;
  task.outsideMaskStatus = null;
  task.startedAt = null;
  task.finishedAt = null;
  task.redoRequestedAt = now();
  task.redoBaseResultVersion = Number(task.resultVersion || 0);
  requeueTaskAtTail(batch, task);
}

async function prepareBatch(pairs, userPrompt, size, extraPrompt = '', costPerCallFen = API_COST_FEN, providerId = '', quality = 'low', model = '', concurrency = MAX_CONCURRENCY) {
  const finalPrompt = extraPrompt ? `${userPrompt}\n\nAdditional user instructions:\n${extraPrompt}` : userPrompt;
  const batch = batchStore.createBatch(pairs, { prompt: finalPrompt, imageSize: size, concurrency, costPerCallFen, providerId, quality, model });
  const dir = batchStore.batchDir(batch.batchId);
  const hashes = snapshotInputs(pairs, dir);
  batch.inputHashes = {};

  for (const task of batch.tasks) {
    const tplDest = hashes[task.templatePath]?.dest || task.templatePath;
    const clrDest = hashes[task.colorPath]?.dest || task.colorPath;
    const userMaskPath = task.templatePath.replace(/\.[^.]+$/, '_mask.png');
    const maskDest = hashes[userMaskPath]?.dest || null;

    task.templatePath = tplDest;
    task.colorPath = clrDest;
    batch.inputHashes[task.template] = hashes[task.templatePath]?.sha256 || '';
    batch.inputHashes[task.colorRef] = hashes[task.colorPath]?.sha256 || '';

    // 本地 HEX 只用于展示与导出命名，不进入生成或 QC。
    task.targetColor = null;
    task.colorCandidates = [];

    // Mask 状态
    task.maskStatus = 'none';
    task.maskPath = null;
    task.maskConfirmedAt = null;
    task.maskHash = null;

    if (maskDest && fs.existsSync(maskDest)) {
      const maskCopy = path.join(dir, 'inputs', 'masks', path.basename(maskDest));
      task.maskPath = maskCopy;
      task.maskStatus = 'uploaded';
      task.maskHash = sha256(fs.readFileSync(maskCopy));
    }

    // 执行/质量状态
    task.executionStatus = task.executionStatus || 'pending';
    task.qualityStatus = 'review_required';
  }

  batchStore.saveBatch(batch);
  return batch;
}

// ==================== API 路由 ====================

// 路由挂载
app.use(configRoutes({ MAX_CONCURRENCY, API_COST_FEN, VISION_COST_FEN }));
app.use(scanRoutes({ fileStore, validator, colorEngine, validationCache, colorMapCache, runners: taskRunner, batchStore, resultService: recolorResultService }));
app.use(outputRoutes({ batchStore, exporter, resultService: recolorResultService, colorEngine }));
app.use(logRoutes());
app.use(creativeRoutes({ apiClient }));
// 素材库管理（asset-manager）非 canvas 命名空间别名：把源端 /api/local-assets、/api/asset-library、
// /api/prompt-libraries、/api/providers 映射到 Lavans 的 canvas 命名空间，前端 asset-manager.js 原样调用。
app.use((req, res, next) => {
  const raw = req.originalUrl || req.url || '';
  const qIndex = raw.indexOf('?');
  const pathOnly = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
  const query = qIndex >= 0 ? raw.slice(qIndex) : '';
  const aliases = [
    ['/api/local-assets', '/api/canvas/local-assets'],
    ['/api/asset-library', '/api/canvas/assets-library'],
    ['/api/prompt-libraries', '/api/canvas/prompt-libraries'],
    ['/api/providers', '/api/canvas/providers']
  ];
  for (const [from, to] of aliases) {
    if (pathOnly === from || pathOnly.startsWith(from + '/')) {
      req.url = to + pathOnly.slice(from.length) + query;
      break;
    }
  }
  next();
});
app.use(canvasRoutes());
app.use(chatRoutes());
app.use(assetManagerRoutes());
// --- 以下为核心生成/批次路由，待后续拆分 ---

app.post(['/api/generate', '/api/generate-v2'], async (req, res) => {
  try {
    const counts = getRunningTaskCount();
    const targetBatchId = String(req.body.batchId || '').trim();
    let pairs = Array.isArray(req.body.pairs) && req.body.pairs.length > 0 ? req.body.pairs : (validationCache.data?.passed || []);
    if (!pairs.length) return res.status(400).json({ success: false, error: '请先完成文件检查' });

    // STEP 15: 修复 continueGen 时 pair 路径丢失/过期 → 从 batch inputs 快照恢复
    const resolveBatchId = targetBatchId;
    if (resolveBatchId) {
      const resolveDir = batchStore.batchDir(resolveBatchId);
      pairs = pairs.map(p => {
        var tplResolved = null, clrResolved = null;
        // 模板图：优先 batch inputs，再回退 uploads
        if (!p.templatePath || !fs.existsSync(p.templatePath)) {
          var tplName = p.templateName || p.template || '';
          if (tplName) {
            var tplBatchInput = path.join(resolveDir, 'inputs', 'templates', tplName);
            if (fs.existsSync(tplBatchInput)) tplResolved = tplBatchInput;
          }
        }
        // 参考图：优先 batch inputs，再回退 uploads
        if (!p.colorPath || !fs.existsSync(p.colorPath)) {
          var clrName = p.colorName || p.colorRef || '';
          if (clrName) {
            var clrBatchInput = path.join(resolveDir, 'inputs', 'colors', clrName);
            if (fs.existsSync(clrBatchInput)) clrResolved = clrBatchInput;
          }
        }
        if (!tplResolved && !clrResolved) return p;
        return Object.assign({}, p, {
          templatePath: tplResolved || p.templatePath,
          colorPath: clrResolved || p.colorPath
        });
      });
    }

    // STEP 15: 过滤仍缺失的任务，不阻断整批
    const { validPairs, missingPairs } = (() => {
      const valid = [], missing = [];
      pairs.forEach(p => {
        const tplOk = p.templatePath && fs.existsSync(p.templatePath);
        const clrOk = p.colorPath && fs.existsSync(p.colorPath);
        if (tplOk && clrOk) { valid.push(p); }
        else { missing.push({ template: p.templateName || p.template || '?', colorRef: p.colorName || p.colorRef || '?' }); }
      });
      return { validPairs: valid, missingPairs: missing };
    })();
    if (!validPairs.length) {
      const sample = missingPairs.slice(0, 3).map(m => `${m.template}→${m.colorRef}`).join('、');
      return res.status(400).json({ success: false, error: `所有任务文件均缺失，请重新上传。示例: ${sample}${missingPairs.length > 3 ? ' 等' : ''}` });
    }
    if (missingPairs.length > 0) {
      console.log(`[SKIP_MISSING] 跳过 ${missingPairs.length} 个文件缺失任务，剩余 ${validPairs.length} 个`);
    }
    pairs = validPairs;
    const prompt = String(req.body.prompt || '').trim();
    const extraPrompt = String(req.body.extraPrompt || '').trim().slice(0, 2000);
    const costOverride = parseInt(req.body.costPerCallFen, 10) || 0;
    const effectiveCost = costOverride > 0 ? costOverride : API_COST_FEN;
    // === 打通画布 Provider:前端选 Provider/Model/Quality/Size/Quantity，存到 batch 上 ===
    const providerId = String(req.body.providerId || '').trim();
    const model = String(req.body.model || '').trim();
    const quality = String(req.body.quality || '').trim().toLowerCase() || 'low';
    const size = String(req.body.size || '').trim() || '1024x1024';
    const quantity = parseInt(req.body.quantity, 10) || 0;
    const concurrencyValue = Number(req.body.concurrency);
    const requestedConcurrency = Number.isFinite(concurrencyValue)
      ? Math.min(8, Math.max(3, Math.trunc(concurrencyValue)))
      : 8;

    if (quantity > 0 && quantity < pairs.length) pairs = pairs.slice(0, quantity);
    if (counts.total + pairs.length > MAX_QUEUE_SIZE) {
      return res.status(503).json({
        success: false,
        code: 'QUEUE_FULL',
        error: `加入这 ${pairs.length} 项后队列将达到 ${counts.total + pairs.length}/${MAX_QUEUE_SIZE}，请等待当前任务完成后再试`
      });
    }

    const targetBatch = targetBatchId ? batchStore.loadBatch(targetBatchId) : null;
    if (targetBatchId && !targetBatch) {
      return res.status(404).json({ success: false, error: '目标执行批次不存在' });
    }
    const unresolvedBatch = targetBatch && targetBatch.tasks.some(t =>
      t.runtimeStatus === 'remote_unknown' || t.generationSubmissionState === 'unknown'
    ) ? targetBatch : batchStore.listBatches().find(batch => batch.tasks.some(t =>
      t.runtimeStatus === 'remote_unknown' || t.generationSubmissionState === 'unknown'
    ));
    const unresolvedRemoteTask = unresolvedBatch?.tasks?.find(t =>
      t.runtimeStatus === 'remote_unknown' || t.generationSubmissionState === 'unknown'
    );
    if (unresolvedRemoteTask) {
      return res.status(409).json({
        success: false,
        code: 'REMOTE_RESULT_UNKNOWN',
        error: '有任务仍在确认远端结果。为避免重复扣费，当前批次已暂停，暂不提交新任务。'
      });
    }
    const executionStillOpen = targetBatch
      && !['completed', 'cancelled', 'error'].includes(String(targetBatch.status || '').toLowerCase())
      && targetBatch.tasks.some(task => !task.hiddenInTaskList);

    if (executionStillOpen) {
        console.log(`[APPEND] 追加 ${pairs.length} 个任务到执行批次 ${targetBatch.batchId} 的 FIFO 队尾`);
        const dir = batchStore.batchDir(targetBatch.batchId);
        const hashes = snapshotInputs(pairs, dir);
        const newTasks = pairs.map((pair, index) => createTaskObject(targetBatch, pair, targetBatch.tasks.length + index + 1, targetBatch.costPerCallFenSnapshot));

        newTasks.forEach(task => {
          task.providerIdSnapshot = targetBatch.providerIdSnapshot || targetBatch.providerId || '';
          task.modelSnapshot = targetBatch.modelSnapshot || targetBatch.model || '';
          task.promptSnapshot = targetBatch.promptSnapshot || targetBatch.prompt || '';
          task.extraPromptSnapshot = targetBatch.extraPromptSnapshot || targetBatch.extraPrompt || '';
          task.imageSizeSnapshot = targetBatch.imageSizeSnapshot || targetBatch.imageSize || '1024x1024';
          task.qualitySnapshot = targetBatch.qualitySnapshot || targetBatch.quality || 'low';
          task.costPerCallFenSnapshot = Number(targetBatch.costPerCallFenSnapshot ?? targetBatch.costPerCallFen ?? effectiveCost);
          if (hashes[task.templatePath]) {
            task.templatePath = hashes[task.templatePath].dest;
          }
          if (hashes[task.colorPath]) {
            task.colorPath = hashes[task.colorPath].dest;
          }
          task.targetColor = null;
        });

        const appended = batchStore.appendTasks(targetBatch, newTasks);
        res.json({ success: true, batchId: targetBatch.batchId, totalJobs: targetBatch.tasks.length, appended: appended.length });
        if (!targetBatch.userPauseRequested && !targetBatch.systemPauseRequested) {
          taskRunner.start(targetBatch.batchId).catch(e => console.error('[BATCH] append restart:', e.message));
        }
        return;
    }

    if (counts.total > 0) {
      return res.status(409).json({
        success: false,
        code: 'ACTIVE_EXECUTION_EXISTS',
        error: '当前仍有等待或生成中的任务，请把新任务加入当前执行批次，或等待它结束后再开始下一批。'
      });
    }

    const batch = await prepareBatch(pairs, prompt, size, extraPrompt, effectiveCost, providerId, quality, model, requestedConcurrency);
    const hasErrors = batch.tasks.some(t => t.executionStatus === 'error');
    if (hasErrors) {
      const errTask = batch.tasks.find(t => t.executionStatus === 'error');
      return res.status(400).json({ success: false, error: errTask?.error || '颜色提取失败，请确认颜色后重试' });
    }
    res.json({ success: true, batchId: batch.batchId, totalJobs: batch.tasks.length });
    taskRunner.start(batch.batchId).catch(e => console.error('[BATCH]', e.message));
  } catch (error) { res.status(500).json({ success: false, error: errorMessage(error) }); }
});

app.get('/api/batches/latest', (req, res) => { res.json({ success: true, batch: publicBatch(batchStore.latestBatch()) }); });
app.get('/api/batches/:batchId', (req, res) => { const b = getBatchOr404(req, res); if (b) res.json({ success: true, batch: publicBatch(b) }); });

app.post('/api/batches/:batchId/retry-task', async (req, res) => {
  const batch = getBatchOr404(req, res);
  if (!batch) return;
  const taskId = req.body.taskId;
  const skipStart = Boolean(req.body.skipStart);
  retryLog(`retry-task 收到: batchId=${req.params.batchId} taskId=${taskId} skipStart=${skipStart} batch.status=${batch.status} batch.active=${batch.active}`);
  const task = batch.tasks.find(t => t.id === taskId);
  if (!task) { retryLog(`retry-task 失败: 任务不存在 taskId=${taskId}`); return res.status(404).json({ success: false, error: '任务不存在' }); }
  if (batch.tasks.some(item => item.runtimeStatus === 'remote_unknown' || item.generationSubmissionState === 'unknown')) {
    return res.status(409).json({ success: false, code: 'REMOTE_RESULT_UNKNOWN', error: '当前批次仍有远端结果未确认，不能再次提交，以免重复扣费。' });
  }
  const es = task.executionStatus || task.status;
  retryLog(`retry-task 找到任务: status=${es} order=${task.order}`);
  if (!['failed', 'error', 'cancelled', 'completed', 'done', 'success'].includes(es)) { retryLog(`retry-task 拒绝: 状态不匹配 es=${es}`); return res.status(400).json({ success: false, error: '只能重试失败、已完成或取消的任务' }); }

  // 旧结果保留到新结果完整写入并保存成功后，才由 taskService 替换。
  prepareTaskRedo(batch, task);

  // 恢复批次为运行状态，否则 runner 不会重新处理这个 pending 任务
  const canRunNow = !batch.userPauseRequested && !batch.systemPauseRequested;
  batch.status = canRunNow ? 'running' : 'paused';
  batch.active = canRunNow;
  batch.cancelRequested = false;

  batchStore.saveBatch(batch);
  retryLog(`retry-task 已保存: batch.status=${batch.status} batch.active=${batch.active} pending=${batch.tasks.filter(t=>t.executionStatus==='pending').length}`);
  res.json({ success: true, taskId });

  // 立即启动 runner（start 内部会判断：runner 在跑就复用，陈旧才清理重启）
  if (!skipStart && canRunNow) {
    retryLog(`retry-task 调用taskRunner.start(${batch.batchId}) isRunning=${taskRunner.isRunning(batch.batchId)}`);
    taskRunner.start(batch.batchId).catch(e => { retryLog(`retry-task runner启动失败: ${e.message}`); console.error('[RETRY]', e.message); });
  }
});

// 批量重试：一次请求重置多个任务 + 统一启动 runner
app.post('/api/batches/:batchId/retry-batch', async (req, res) => {
  const batch = getBatchOr404(req, res);
  if (!batch) return;
  const taskIds = Array.isArray(req.body.taskIds) ? req.body.taskIds : [];
  if (!taskIds.length) return res.status(400).json({ success: false, error: '未提供任务ID' });
  let count = 0;
  if (batch.tasks.some(task => task.runtimeStatus === 'remote_unknown' || task.generationSubmissionState === 'unknown')) {
    return res.status(409).json({ success: false, code: 'REMOTE_RESULT_UNKNOWN', error: '仍有任务在确认远端结果，当前批次不能提交重做。' });
  }
  for (const taskId of taskIds) {
    const task = batch.tasks.find(t => t.id === taskId);
    if (!task) continue;
    const es = task.executionStatus || task.status;
    if (!['failed','error','cancelled','completed','done','success'].includes(es)) continue;
    prepareTaskRedo(batch, task);
    count++;
  }
  if (!count) return res.json({ success: false, error: '没有可重试的任务' });
  const canRunNow = !batch.userPauseRequested && !batch.systemPauseRequested;
  batch.status = canRunNow ? 'running' : 'paused';
  batch.active = canRunNow;
  batch.cancelRequested = false;
  batchStore.saveBatch(batch);
  res.json({ success: true, count });
  // start 内部会判断：runner 在跑就复用（靠磁盘同步拾取新 pending），陈旧才清理重启
  if (canRunNow) taskRunner.start(batch.batchId).catch(e => console.error('[RETRY-BATCH]', e.message));
});

app.post('/api/batches/:batchId/clear-task', (req, res) => {
  const result = recolorResultService.requestDelete({ batchId: req.params.batchId, taskIds: [req.body.taskId] });
  if (!result.count) return res.status(404).json({ success: false, error: '任务不存在或已删除' });
  res.json(result);
});

app.post('/api/batches/:batchId/clear-all-success', (req, res) => {
  const result = recolorResultService.requestDelete({ batchId: req.params.batchId, statuses: ['completed'] });
  res.json({ ...result, cleared: result.count });
});

app.post('/api/batches/:batchId/clear-all-non-running', (req, res) => {
  const result = recolorResultService.requestDelete({
    batchId: req.params.batchId,
    statuses: ['pending', 'completed', 'failed', 'error', 'cancelled', 'interrupted']
  });
  res.json({ ...result, cleared: result.count });
});

app.post('/api/batches/:batchId/clear-all-cancelled', (req, res) => {
  const result = recolorResultService.requestDelete({ batchId: req.params.batchId, statuses: ['cancelled'] });
  res.json({ ...result, cleared: result.count });
});

app.post('/api/batches/:batchId/clear-all-failed', (req, res) => {
  const result = recolorResultService.requestDelete({ batchId: req.params.batchId, statuses: ['failed', 'error'] });
  res.json({ ...result, cleared: result.count });
});

app.post('/api/batches/:batchId/clear-all', (req, res) => {
  const result = recolorResultService.requestDelete({ batchId: req.params.batchId });
  res.json({ ...result, cleared: result.count });
});

app.post('/api/batches/:batchId/concurrency', (req, res) => {
  const requested = Number(req.body.concurrency);
  if (!Number.isInteger(requested) || requested < 3 || requested > 8) {
    return res.status(400).json({ success: false, error: '并发数只能设置为 3 到 8 的整数' });
  }
  const concurrency = taskRunner.setConcurrency(req.params.batchId, requested);
  if (concurrency === null) return res.status(404).json({ success: false, error: '批次不存在' });
  res.json({ success: true, concurrency });
});

app.get('/api/batches/:batchId/pending-model-rebind/preview', (req, res) => {
  const batch = modelUnavailableBatch(req, res);
  if (!batch) return;
  try {
    const from = {
      providerId: String(req.query.fromProviderId || batch.unavailableBinding.providerId || ''),
      model: String(req.query.fromModel || batch.unavailableBinding.model || '')
    };
    if (from.providerId !== batch.unavailableBinding.providerId || from.model !== batch.unavailableBinding.model) {
      throw Object.assign(new Error('原模型绑定与当前暂停记录不一致'), { code: 'REBIND_SOURCE_MISMATCH', statusCode: 409 });
    }
    const target = configuredRebindTarget(String(req.query.toProviderId || ''), String(req.query.toModel || ''));
    const preview = taskRunner.previewPendingModelRebind(batch.batchId, { from, to: target });
    return res.json({
      success: true,
      preview: {
        ...preview,
        to: target,
        pricing: {
          selectionRequired: true,
          currentEstimatesFen: preview.oldCostsFen,
          targetEstimateFen: null
        }
      }
    });
  } catch (error) {
    return sendRebindError(res, error);
  }
});

app.post('/api/batches/:batchId/pending-model-rebind', (req, res) => {
  const batch = modelUnavailableBatch(req, res);
  if (!batch) return;
  try {
    const from = {
      providerId: String(req.body?.from?.providerId || batch.unavailableBinding.providerId || ''),
      model: String(req.body?.from?.model || batch.unavailableBinding.model || '')
    };
    if (from.providerId !== batch.unavailableBinding.providerId || from.model !== batch.unavailableBinding.model) {
      throw Object.assign(new Error('原模型绑定与当前暂停记录不一致'), { code: 'REBIND_SOURCE_MISMATCH', statusCode: 409 });
    }
    const requestedTarget = req.body?.to || {};
    const target = configuredRebindTarget(String(requestedTarget.providerId || ''), String(requestedTarget.model || ''));
    const result = taskRunner.rebindPendingTasks(batch.batchId, {
      requestId: req.body?.requestId,
      previewToken: req.body?.previewToken,
      from,
      to: target,
      pricing: req.body?.pricing
    });
    return res.json({
      success: true,
      ...result,
      batch: publicBatch(batchStore.loadBatch(batch.batchId))
    });
  } catch (error) {
    return sendRebindError(res, error);
  }
});

app.post('/api/batches/:batchId/resume', async (req, res) => {
  let batch = getBatchOr404(req, res);
  if (!batch) return;
  if (batch.tasks.some(task => task.runtimeStatus === 'remote_unknown' || ['submitting','submitted','unknown','cancelled_after_submit'].includes(task.generationSubmissionState))) {
    const remote = await recolorHealthService.resolveRemoteUnknown(batch.batchId);
    if (remote.remaining) {
      return res.status(409).json({ success: false, code: 'REMOTE_RESULT_UNKNOWN', remaining: remote.remaining, error: '仍有任务在确认远端结果。系统已先查询服务商，不会重复提交。' });
    }
    batch = batchService.loadBatch(batch.batchId);
  }
  if (batch.systemPauseRequested && batch.pauseReason === 'global_api_error') {
    const health = await recolorHealthService.checkNow(batch.batchId);
    if (!health.ready) {
      const detail = health.success
        ? `系统恢复检查已通过 ${health.consecutive}/2 次，再确认一次后自动继续。`
        : `系统仍未恢复：${health.error || '健康检查失败'}。`;
      return res.status(409).json({ success: false, code: 'SYSTEM_HEALTH_PENDING', consecutive: health.consecutive || 0, error: detail });
    }
    return res.json({ success: true, resumed: health.resumed || 0, healthRecovered: true });
  }
  if (batch.systemPauseRequested && batch.pauseReason === 'model_unavailable') {
    if (!batch.unavailableBinding || !batch.lastModelRebind?.to) {
      return res.status(409).json({ success: false, code: 'REBIND_REQUIRED', error: '请先确认待生成任务使用的新模型。' });
    }
    try {
      const remaining = taskRunner.previewPendingModelRebind(batch.batchId, {
        from: batch.unavailableBinding,
        to: batch.lastModelRebind.to
      });
      if (remaining.eligibleCount > 0) {
        return res.status(409).json({
          success: false,
          code: 'REBIND_REQUIRED',
          remaining: remaining.eligibleCount,
          error: `仍有 ${remaining.eligibleCount} 项未提交任务使用原模型，请重新确认改绑范围。`
        });
      }
      batch.systemPauseRequested = false;
      batch.pauseReason = null;
      batch.unavailableBinding = null;
      batchStore.saveBatch(batch);
      batch = batchService.loadBatch(batch.batchId);
    } catch (error) {
      if (error?.code) return sendRebindError(res, error);
      return res.status(500).json({ success: false, code: 'REBIND_RESUME_SAVE_FAILED', error: '恢复队列失败，批次仍保持暂停。' });
    }
  }
  const result = batchService.resumeBatchTasks(batch);
  if (result.blocked) {
    const error = result.code === 'REMOTE_RESULT_UNKNOWN'
      ? '仍有任务在确认远端结果。为避免重复扣费，暂不能继续生成。'
      : '当前批次因系统错误暂停，请先恢复系统状态。';
    return res.status(409).json({ success: false, code: result.code, error });
  }
  res.json({ success: true, resumed: result.resumed });
  taskRunner.resume(batch.batchId).catch(e => console.error('[RESUME]', e.message));
});

app.get(['/api/generate-status', '/api/generate-v2-status'], (req, res) => { const b = batchStore.latestBatch(); if (!b) return res.json({ success: true, active: false, total: 0, done: 0, results: [] }); const d = publicBatch(b); res.json({ success: true, active: d.active, batchId: d.batchId, total: d.totals.total, done: d.totals.done, costFen: d.totals.costFen, status: d.status, results: d.tasks }); });

function pauseBatchRequest(batchId, res) {
  if (!batchId) return res.status(404).json({ success: false, error: '没有可暂停的任务' });
  const batch = batchStore.loadBatch(batchId);
  if (!batch) return res.status(404).json({ success: false, error: '批次不存在' });
  if (['completed', 'cancelled'].includes(String(batch.status || '').toLowerCase())) {
    return res.json({ success: true, status: batch.status, active: false });
  }
  taskRunner.pause(batchId);
  const paused = batchStore.loadBatch(batchId);
  return res.json({ success: true, status: paused?.status || 'paused', active: Boolean(paused?.active) });
}

app.post('/api/batches/:batchId/pause', (req, res) => pauseBatchRequest(req.params.batchId, res));
app.post('/api/cancel', (req, res) => {
  const batchId = req.body.batchId || batchStore.latestBatch()?.batchId;
  return pauseBatchRequest(batchId, res);
});


// ==================== 全局异常捕获 ====================
const LOG_DIR = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// 防止 stdout/stderr 管道断开（EPIPE）在异常处理器内再次抛错，
// 否则 uncaughtException 里的 console.error 会 EPIPE → 又触发 uncaughtException → 死循环刷屏
try { process.stdout.on('error', () => {}); } catch (e) {}
try { process.stderr.on('error', () => {}); } catch (e) {}

// crashLog 节流：同一错误签名短时间只记一条，防止异常死循环把日志撑爆磁盘
const crashLogThrottle = new Map();
const CRASH_LOG_THROTTLE_MS = 30000; // 30 秒内相同错误只记一条
const CRASH_LOG_MAX_BYTES = 50 * 1024 * 1024; // 日志超过 50MB 自动轮转，物理上限兜底

function crashLog(label, error, code) {
  const fp = path.join(LOG_DIR, 'runtime-error.log');
  const errMsg = error instanceof Error ? error.message : String(error);
  const sig = label + '|' + String(errMsg).slice(0, 200);
  const t = Date.now();
  const last = crashLogThrottle.get(sig) || 0;
  if (t - last < CRASH_LOG_THROTTLE_MS) return; // 相同错误短时间重复 → 丢弃
  crashLogThrottle.set(sig, t);
  if (crashLogThrottle.size > 500) { // 清理过期节流记录，防止 Map 无限增长
    for (const [k, v] of crashLogThrottle) if (t - v > 60000) crashLogThrottle.delete(k);
  }
  // 物理上限兜底：超过 50MB 轮转为 .old（只保留最近一份），
  // 即使将来有未知 bug 导致异常刷屏，日志也不可能再膨胀到几百 GB
  try {
    const st = fs.statSync(fp);
    if (st.size > CRASH_LOG_MAX_BYTES) {
      const old = fp + '.old';
      try { fs.rmSync(old, { force: true }); } catch (e) {}
      try { fs.renameSync(fp, old); } catch (e) {}
    }
  } catch (e) {}
  const lines = [
    `[${now()}] ${label}`,
    `exitCode: ${code ?? 'N/A'}`,
    error instanceof Error ? `error: ${error.message}` : `error: ${String(error)}`,
    error instanceof Error && error.stack ? `stack:\n${error.stack}` : '',
    `memory: ${JSON.stringify(process.memoryUsage())}`,
    `---`
  ].join('\n');
  try { fs.appendFileSync(fp, lines + '\n'); } catch(e) {}
}

process.on('uncaughtException', (err) => {
  crashLog('UNCAUGHT_EXCEPTION', err);
  try { console.error('[FATAL] uncaughtException:', err.message); } catch (e) {}
  // 不退出进程，保持服务器运行
  try { crashLog('RECOVERY', 'Pid ' + process.pid + ' survived uncaught exception, staying alive.'); } catch(e) {}
});

process.on('unhandledRejection', (reason) => {
  crashLog('UNHANDLED_REJECTION', reason?.stack || reason);
  try { console.error('[WARN] unhandledRejection:', reason?.message || reason); } catch (e) {}
  // 不退出进程
});

process.on('exit', (code) => {
  crashLog('EXIT', 'Process exiting', code);
});

// 优雅关闭 — 用户点击关闭按钮时保存状态
function persistRecolorShutdownState(signal) {
  console.log(`[SHUTDOWN] ${signal} received, saving state...`);
  try {
    const b = batchStore.latestBatch();
    if (b && b.active) {
      b.active = false;
      b.status = 'paused';
      for (const task of b.tasks) {
        if (task.executionStatus === 'running') {
          task.executionStatus = 'interrupted';
          if (['submitting','submitted'].includes(task.generationSubmissionState)) {
            task.runtimeStatus = 'remote_unknown';
            task.generationSubmissionState = 'unknown';
            b.systemPauseRequested = true;
            b.pauseReason = 'remote_unknown';
          }
        }
      }
      batchStore.saveBatch(b);
    }
  } catch(e) { console.error('[SHUTDOWN] Save error:', e.message); }
}

process.on('SIGINT', () => {
  persistRecolorShutdownState('SIGINT');
  process.exit(0);
});

process.on('SIGTERM', () => {
  persistRecolorShutdownState('SIGTERM');
  process.exit(0);
});

// Express 全局错误中间件 — 防止路由异常导致进程崩溃
app.use((err, req, res, next) => {
  crashLog('EXPRESS_ERROR', err);
  try { console.error('[API_ERROR]', err.message); } catch (e) {}
  if (!res.headersSent) {
    res.status(500).json({ success: false, error: err.message || '服务器内部错误' });
  }
});

// ==================== 启动 ====================

batchStore.recoverInterruptedBatches();
for (const batch of batchStore.listBatches()) {
  if (batch.systemPauseRequested && batch.pauseReason === 'global_api_error') recolorHealthService.watch(batch.batchId);
}

app.listen(PORT, () => {
  console.log(''); console.log('========================================'); console.log(`  ${BRAND.title}`); console.log(`  http://localhost:${PORT}`); console.log(`  并发: ${MAX_CONCURRENCY}`); console.log(`  PID: ${process.pid}`); console.log('========================================');
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[FATAL] 端口 ${PORT} 已被占用，请在任务管理器终止占用进程后重试`);
  } else {
    console.error('[FATAL] Server error:', err.message);
  }
  process.exit(1);
});

// 定时输出心跳，证明进程未挂
setInterval(() => {
  console.log(`[HEARTBEAT ${new Date().toISOString()}] PID ${process.pid} alive`);
}, 60000); // 每1分钟

// 孤儿进程自检：父进程（启动本进程的 shell/Electron 主进程）退出后自动退出，
// 防止测试遗留的后端进程变成孤儿继续跑，进而 EPIPE 死循环刷爆日志。
// 发信号 0 只检测父进程是否存活、不杀进程；正常运行时父进程存活，不受影响。
const ORPHAN_CHECK_INTERVAL_MS = 20000; // 每 20 秒检查一次
setInterval(() => {
  try {
    process.kill(process.ppid, 0); // 探测父进程是否存在
  } catch (e) {
    if (e && e.code === 'ESRCH') {
      // 父进程已退出，本进程已成孤儿 → 自动退出
      try { console.log('[ORPHAN] parent process exited, shutting down to avoid orphan leak'); } catch (e2) {}
      process.exit(0);
    }
    // EPERM 等其它错误：父进程仍在（只是无权限探测），忽略
  }
}, ORPHAN_CHECK_INTERVAL_MS);

// 系统保护配置
const MAX_QUEUE_SIZE = 100; // 最大队列任务数
const MEMORY_THRESHOLD_MB = 800; // 内存阈值（MB）
const TASK_TIMEOUT_MS = 300000; // 单任务超时（5分钟）

// 系统模式（NORMAL / SAFE / FAILSAFE）
let SYSTEM_MODE = 'NORMAL';
let SYSTEM_MODE_REASON = '';

// 队列保护：检查当前运行中的任务数
function getRunningTaskCount() {
  try {
    const batches = batchStore.listBatches();
    let running = 0;
    let pending = 0;
    batches.forEach(b => {
      if (['completed', 'cancelled', 'error'].includes(String(b.status || '').toLowerCase())) return;
      if (b.tasks) {
        b.tasks.forEach(t => {
          if (t.hiddenInTaskList) return;
          const status = String(t.executionStatus || '').toLowerCase();
          if (['running', 'processing', 'generating'].includes(status)) running++;
          if (['pending', 'queued', 'waiting'].includes(status)) pending++;
        });
      }
    });
    return { running, pending, total: running + pending };
  } catch (e) {
    return { running: 0, pending: 0, total: 0 };
  }
}

// 内存泄漏监控 + SAFE-FAILSAFE 模式
setInterval(() => {
  const mem = process.memoryUsage();
  const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
  const rssMB = Math.round(mem.rss / 1024 / 1024);
  const heapUsed = mem.heapUsed;

  console.log(`[MEMORY] heap=${heapMB}MB rss=${rssMB}MB mode=${SYSTEM_MODE}`);

  // SAFE 模式：内存超过阈值
  if (heapUsed > MEMORY_THRESHOLD_MB * 1024 * 1024) {
    if (SYSTEM_MODE === 'NORMAL') {
      SYSTEM_MODE = 'SAFE';
      SYSTEM_MODE_REASON = `Memory ${heapMB}MB exceeds threshold ${MEMORY_THRESHOLD_MB}MB`;
      console.warn(`[SYSTEM MODE] Entering SAFE mode: ${SYSTEM_MODE_REASON}`);
    }
  } else {
    if (SYSTEM_MODE === 'SAFE') {
      SYSTEM_MODE = 'NORMAL';
      SYSTEM_MODE_REASON = '';
      console.log(`[SYSTEM MODE] Returning to NORMAL mode`);
    }
  }

  // FAILSAFE 模式：内存超过临界值
  if (heapUsed > 1500 * 1024 * 1024) {
    SYSTEM_MODE = 'FAILSAFE';
    SYSTEM_MODE_REASON = `Memory ${heapMB}MB exceeds critical threshold 1500MB`;
    console.error(`[SYSTEM MODE] Entering FAILSAFE mode: ${SYSTEM_MODE_REASON}`);
  }
}, 30000); // 每30秒

// 队列健康检查
setInterval(() => {
  const counts = getRunningTaskCount();
  console.log(`[QUEUE HEALTH] running=${counts.running} pending=${counts.pending} total=${counts.total} mode=${SYSTEM_MODE}`);

  // 队列溢出保护
  if (counts.total > MAX_QUEUE_SIZE) {
    if (SYSTEM_MODE === 'NORMAL') {
      SYSTEM_MODE = 'SAFE';
      SYSTEM_MODE_REASON = `Queue size ${counts.total} exceeds limit ${MAX_QUEUE_SIZE}`;
      console.warn(`[SYSTEM MODE] Entering SAFE mode: ${SYSTEM_MODE_REASON}`);
    }
  }
}, 60000); // 每1分钟

// 导出给 routes 使用
app.locals.SYSTEM_MODE = SYSTEM_MODE;
app.locals.getSystemMode = () => SYSTEM_MODE;
app.locals.getSystemModeReason = () => SYSTEM_MODE_REASON;
app.locals.MAX_QUEUE_SIZE = MAX_QUEUE_SIZE;
app.locals.getRunningTaskCount = getRunningTaskCount;
