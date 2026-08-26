// scanRoutes.js — 上传、扫描、校验、颜色提取路由
const path = require('path');
const fs = require('fs');
const createReferenceService = require('../services/recolorReferenceService');

module.exports = function(deps) {
  const express = require('express');
  const router = express.Router();
  const { fileStore, validator, colorEngine, validationCache, colorMapCache, runners, batchStore, resultService } = deps;
  const referenceService = createReferenceService({ fileStore, colorEngine });

  function effectiveLists(sessionId) {
    const lists = fileStore.getFileLists(sessionId);
    return {
      ...lists,
      colors: { ...lists.colors, files: referenceService.effectiveColors(sessionId) }
    };
  }

  function buildPairs(sessionId) {
    const { templates, colors } = effectiveLists(sessionId);
    const pairs = templates.count && colors.count
      ? validator.autoPair(templates.files, colors.files).map(pair => {
          const decorated = referenceService.decoratePair(pair, sessionId);
          return {
            ...decorated,
            sessionId,
            templateUrl: fileStore.getUploadPublicPath(decorated.templatePath, sessionId),
            colorUrl: fileStore.getUploadPublicPath(decorated.colorPath, sessionId),
            originalColorUrl: fileStore.getUploadPublicPath(decorated.originalColorPath, sessionId)
          };
        })
      : [];
    return { templates, colors, pairs };
  }

  function applyMetadataToTasks(sessionId, colorName, metadata) {
    let updatedTasks = 0;
    for (const listedBatch of batchStore.listBatches()) {
      const batch = batchStore.loadBatch(listedBatch.batchId);
      if (!batch) continue;
      let changed = false;
      for (const task of batch.tasks) {
        const taskSessionId = task.uploadBatchId || task.sessionId || '';
        const taskColorName = task.colorRef || task.colorName || task.colorNameWithoutExt || '';
        const sameColor = taskColorName === colorName
          || path.parse(String(taskColorName)).name === path.parse(String(colorName)).name;
        if (taskSessionId !== sessionId || !sameColor) continue;
        const nextHex = metadata.hex || null;
        const nextLabel = metadata.label || '';
        if (task.referenceHex === nextHex && task.referenceColorLabel === nextLabel) continue;
        task.referenceHex = nextHex;
        task.referenceColorLabel = nextLabel;
        // 导出名称依赖 HEX/别名；原图片不变，但旧 ZIP 的名字不能再当作最新版本。
        if (task.output) {
          task.exportedAt = null;
          task.exportedResultVersion = 0;
          task.exportNameStale = true;
        }
        changed = true;
        updatedTasks += 1;
      }
      if (changed) batchStore.saveBatch(batch);
    }
    return updatedTasks;
  }

  // 上传文件
  router.post('/api/upload', (req, res) => {
    const type = req.query.type === 'color' ? 'color' : 'template';
    const appendMode = req.query.append === '1' || req.query.sessionId;
    if (!appendMode) {
      const cleared = fileStore.clearUploads(type);
      if (type === 'color') referenceService.clearColorState(null);
      if (cleared && cleared.success === false) {
        return res.status(500).json({ success: false, error: '清理上传缓存失败', failedFiles: cleared.failed || [] });
      }
    }
    fileStore.upload.array('files', 100)(req, res, error => {
      if (error) return res.status(400).json({ success: false, error: error.message, code: error.code || 'UPLOAD_ERROR' });
      validationCache.data = null;
      res.json({ success: true, count: req.files?.length || 0, type, sessionId: req.uploadSessionId || fileStore.getActiveUploadSessionId() || null });
    });
  });

  // 清空上传
  router.post('/api/upload-clear', (req, res) => {
    const cleared = fileStore.clearUploads(req.body.type, { sessionId: req.body.sessionId || null });
    if (req.body.type === 'color') referenceService.clearColorState(req.body.sessionId || null);
    validationCache.data = null;
    if (cleared && cleared.success === false) {
      return res.status(500).json({ success: false, error: '清空上传缓存失败', failedFiles: cleared.failed || [] });
    }
    res.json({ success: true });
  });

  function safeRemovePath(targetPath, failed) {
    try {
      if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { recursive: true, force: true });
    } catch (error) {
      failed.push({ path: targetPath, reason: error.code || error.message });
    }
  }

  function clearRecolorLogs(failedFiles) {
    const logDir = path.join(__dirname, '..', '..', 'logs');
    for (const name of ['task-runner.log', 'runtime-error.log']) {
      const logPath = path.join(logDir, name);
      try { if (fs.existsSync(logPath)) fs.writeFileSync(logPath, '', 'utf8'); }
      catch (error) { failedFiles.push({ path: logPath, reason: error.code || error.message }); }
    }
  }

  // 唯一的彻底清空：只删除一键复色拥有的数据，保留画布、全局 API 配置和主题。
  function resetAll(req, res) {
    const failedFiles = [];
    try {
      resultService?.dispose?.();
      runners.purgeAll();

      for (const batch of batchStore.listBatches()) {
        safeRemovePath(batchStore.batchDir(batch.batchId), failedFiles);
      }

      const outDir = fileStore.OUTPUT_DIR;
      if (fs.existsSync(outDir)) {
        for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
          if (entry.name.startsWith('batch_')) {
            safeRemovePath(path.join(outDir, entry.name), failedFiles);
          }
        }
      }

      const uploadCleared = fileStore.clearAllUploads();
      if (uploadCleared && uploadCleared.failed) failedFiles.push(...uploadCleared.failed);

      validationCache.data = null;
      colorMapCache.data = {};
      fileStore.clearActiveUploadSession();
      clearRecolorLogs(failedFiles);

      if (failedFiles.length) {
        return res.status(500).json({
          success: false,
          error: '彻底清空缓存未完全成功，部分文件被占用或无权限删除',
          failedFiles
        });
      }

      res.json({ success: true, message: '已彻底清空一键复色的素材、任务、队列、结果、历史、导出标记、缓存、临时文件和日志' });
    } catch (error) {
      res.status(500).json({ success: false, error: '彻底清空缓存失败: ' + error.message, failedFiles });
    }
  }

  router.post('/api/reset-all', resetAll);
  router.post('/api/soft-reset', resetAll);

  // 扫描配对
  router.get('/api/scan', async (req, res) => {
    try {
      const sessionId = req.query.sessionId || fileStore.getActiveUploadSessionId() || null;
      const ensured = await referenceService.ensureExtractedMetadata(sessionId);
      const colorMap = {};
      for (const [name, extracted] of Object.entries(ensured.extractions)) {
        if (extracted?.success) colorMap[name] = extracted;
      }
      colorMapCache.data = colorMap;
      for (const file of ensured.files) {
        if (file.referenceHex) applyMetadataToTasks(sessionId, file.name, { hex: file.referenceHex, label: file.referenceColorLabel });
      }
      const { templates, colors, pairs } = buildPairs(sessionId);
      const maskInfo = {};
      for (const tpl of templates.files) {
        maskInfo[tpl.name] = fs.existsSync(tpl.path.replace(/\.[^.]+$/, '_mask.png'))
          ? 'uploaded' : 'none';
      }
      res.json({ success: true, templates, colors, pairs, totalPairs: pairs.length, maskInfo, colorMap, sessionId });
    } catch (error) {
      res.status(500).json({ success: false, error: '扫描失败: ' + error.message });
    }
  });

  // 校验配对
  router.post('/api/validate', async (req, res) => {
    const sessionId = req.body?.sessionId || fileStore.getActiveUploadSessionId() || null;
    const { templates, colors, pairs } = buildPairs(sessionId);
    if (!templates.count || !colors.count)
      return res.status(400).json({ success: false, error: '请先上传模板和颜色参考图' });
    const validPairs = pairs.filter(p =>
      fs.existsSync(p.templatePath) && fs.existsSync(p.colorPath)
    );
    validationCache.data = {
      passed: validPairs,
      totalPairs: validPairs.length,
      passedCount: validPairs.length,
      warned: pairs.filter(p => !fs.existsSync(p.templatePath) || !fs.existsSync(p.colorPath)),
      warnedCount: pairs.length - validPairs.length,
      avgScore: 100
    };

    const colorMap = {};
    for (const file of colors.files) {
      try {
        const c = await colorEngine.extractColor(file.path);
        if (c?.success) colorMap[file.name] = c;
      } catch (e) {}
    }
    colorMapCache.data = colorMap;
    res.json({ success: true, done: true, totalPairs: validPairs.length, colorMap });
  });

  // 校验状态
  router.get('/api/validate-status', (req, res) => {
    const vc = validationCache.data;
    if (!vc) return res.json({ success: true, done: false });
    res.json({
      success: true,
      done: true,
      passed: vc.passedCount,
      warned: vc.warnedCount || 0,
      avgScore: vc.avgScore,
      pairs: vc.passed.map(p => ({
        id: p.id, templateName: p.templateName, colorName: p.colorName,
        score: 100, warning: null
      })),
      colorMap: colorMapCache.data
    });
  });

  // 单独刷新颜色提取
  router.post('/api/color/re-extract', async (req, res) => {
    const colorName = req.body.colorName;
    if (!colorName)
      return res.status(400).json({ success: false, error: '缺少颜色文件名' });
    const sessionId = req.body.sessionId || fileStore.getActiveUploadSessionId() || null;
    const colorPath = referenceService.getEffectiveColor(sessionId, colorName).path;
    if (!fs.existsSync(colorPath))
      return res.status(404).json({ success: false, error: '颜色图不存在' });
    try {
      const color = await colorEngine.extractColor(colorPath);
      if (color?.success) {
        colorMapCache.data[colorName] = color;
      } else {
        delete colorMapCache.data[colorName];
      }
      res.json({ success: true, colorName, color });
    } catch (e) {
      res.status(500).json({ success: false, error: '提取失败: ' + e.message });
    }
  });

  // 本地取色：仅生成导出/筛选/色块用的元数据，不会写入提示词，也不会发给 API。
  router.get('/api/recolor/reference-colors', async (req, res) => {
    try {
      const sessionId = req.query.sessionId || fileStore.getActiveUploadSessionId() || null;
      const ensured = await referenceService.ensureExtractedMetadata(sessionId);
      for (const file of ensured.files) {
        if (file.referenceHex) applyMetadataToTasks(sessionId, file.name, { hex: file.referenceHex, label: file.referenceColorLabel });
      }
      const refs = [];
      for (const file of ensured.files) {
        const extracted = ensured.extractions[file.name];
        if (extracted?.success) colorMapCache.data[file.name] = extracted;
        refs.push({
          name: file.name,
          originalPath: file.originalPath,
          cropApplied: file.cropApplied,
          crop: file.crop,
          referenceHex: file.referenceHex,
          referenceColorLabel: file.referenceColorLabel,
          primary: extracted?.primary || null,
          candidates: extracted?.candidates || []
        });
      }
      res.json({ success: true, sessionId, references: refs });
    } catch (error) {
      res.status(500).json({ success: false, error: '读取参考色失败: ' + error.message });
    }
  });

  router.post('/api/recolor/reference-colors/metadata', (req, res) => {
    try {
      const sessionId = req.body.sessionId || fileStore.getActiveUploadSessionId() || null;
      const metadata = referenceService.setMetadata(sessionId, req.body.colorName, {
        hex: req.body.hex,
        label: req.body.label
      });
      const updatedTasks = applyMetadataToTasks(sessionId, metadata.name, metadata);
      res.json({ success: true, sessionId, metadata, updatedTasks });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // 参考色同批裁剪：保留原图，只有确认后生成的裁剪副本会进入后续配对和 API 参考图。
  router.post('/api/recolor/reference-crop/preview', async (req, res) => {
    try {
      const sessionId = req.body.sessionId || fileStore.getActiveUploadSessionId() || null;
      const result = await referenceService.previewCrop(sessionId, req.body.colorName, req.body.crop);
      res.json({ success: true, sessionId, ...result });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  router.post('/api/recolor/reference-crop/apply', async (req, res) => {
    try {
      const sessionId = req.body.sessionId || fileStore.getActiveUploadSessionId() || null;
      const result = await referenceService.applyCrop(sessionId, req.body.crop, {
        confirmAspectWarnings: req.body.confirmAspectWarnings === true
      });
      if (!result.success && result.requiresConfirmation) return res.status(409).json(result);
      validationCache.data = null;
      colorMapCache.data = {};
      res.json({ success: true, sessionId, ...result });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  router.post('/api/recolor/reference-crop/clear', (req, res) => {
    try {
      const sessionId = req.body.sessionId || fileStore.getActiveUploadSessionId() || null;
      referenceService.clearCrop(sessionId);
      validationCache.data = null;
      colorMapCache.data = {};
      res.json({ success: true, sessionId });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // Mask 预览
  router.get('/api/mask-preview/:templateName', async (req, res) => {
    const tn = path.basename(req.params.templateName);
    const tplPath = path.join(fileStore.UPLOAD_DIR, 'templates', tn);
    if (!fs.existsSync(tplPath))
      return res.status(404).json({ success: false, error: '模板不存在' });
    const mp = tplPath.replace(/\.[^.]+$/, '_mask.png');
    if (!fs.existsSync(mp))
      return res.status(404).json({ success: false, error: '无Mask' });
    const previewPath = path.join(
      fileStore.UPLOAD_DIR, 'templates',
      path.parse(tn).name + '_mask-preview.png'
    );
    await colorEngine.generateMaskPreview(tplPath, mp, previewPath);
    if (fs.existsSync(previewPath))
      res.sendFile(previewPath);
    else
      res.status(500).json({ success: false, error: '预览失败' });
  });

  return router;
};
