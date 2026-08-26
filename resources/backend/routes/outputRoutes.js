// outputRoutes.js — 输出文件、删除、下载路由
const path = require('path');
const fs = require('fs');
const os = require('os');

module.exports = function(deps) {
  const express = require('express');
  const router = express.Router();
  const { batchStore, exporter, resultService, colorEngine } = deps;
  const localColorCache = new Map();

  function isAvailableResultTask(task) {
    return Boolean(task?.output && !task.hiddenInTaskList && !task.deletedAt && task.executionStatus !== 'deleted');
  }

  function listQuery(value) {
    const source = Array.isArray(value) ? value : value == null ? [] : [value];
    return new Set(source.flatMap(item => String(item).split(',')).map(item => item.trim()).filter(Boolean));
  }

  function includesAny(values, candidates) {
    if (!values.size) return true;
    return candidates.some(candidate => values.has(String(candidate || '')));
  }

  function isCompletedResult(task) {
    return ['completed', 'done', 'success'].includes(String(task.executionStatus || '').toLowerCase());
  }

  function resultPath(batchId, output) {
    const root = path.resolve(batchStore.batchDir(batchId)) + path.sep;
    const resolved = path.resolve(batchStore.batchDir(batchId), output || '');
    return resolved.startsWith(root) ? resolved : null;
  }

  function collectExportSnapshot(query = {}) {
    const taskIds = listQuery(query.taskId || query.taskIds);
    const uploadBatchIds = listQuery(query.uploadBatchId || query.uploadBatchIds);
    const colors = listQuery(query.color || query.colors);
    const templates = listQuery(query.template || query.templates);
    const onlyUnexported = String(query.onlyUnexported || '') === '1' || query.onlyUnexported === true;
    const items = [];
    for (const listedBatch of batchStore.listBatches()) {
      const batch = batchStore.loadBatch(listedBatch.batchId);
      if (!batch) continue;
      for (const task of batch.tasks) {
        if (!isAvailableResultTask(task) || !isCompletedResult(task)) continue;
        if (!includesAny(taskIds, [task.id])) continue;
        if (!includesAny(uploadBatchIds, [task.uploadBatchId, task.sessionId])) continue;
        if (!includesAny(colors, [task.colorRef, task.colorNameWithoutExt, task.referenceColorLabel, task.referenceHex])) continue;
        if (!includesAny(templates, [task.template, task.templateNameWithoutExt])) continue;
        if (onlyUnexported
          && task.exportedAt
          && Number(task.exportedResultVersion) === Number(task.resultVersion)
          && !task.exportNameStale) continue;
        const source = resultPath(batch.batchId, task.output);
        if (!source || !fs.existsSync(source)) continue;
        items.push({ batchId: batch.batchId, taskId: task.id, resultVersion: task.resultVersion, source, task: { ...task } });
      }
    }
    return items;
  }

  async function localReferenceHex(task) {
    if (/^#[0-9a-f]{6}$/i.test(String(task?.referenceHex || ''))) {
      return String(task.referenceHex).toUpperCase();
    }
    const source = String(task?.colorPath || '');
    if (!source || !fs.existsSync(source) || !colorEngine?.extractColor) return '';
    const stat = fs.statSync(source);
    const key = `${source}:${stat.size}:${stat.mtimeMs}`;
    if (localColorCache.has(key)) return localColorCache.get(key);
    try {
      const extracted = await colorEngine.extractColor(source);
      const hex = extracted?.success && /^#[0-9a-f]{6}$/i.test(String(extracted.primary?.hex || ''))
        ? String(extracted.primary.hex).toUpperCase()
        : '';
      localColorCache.set(key, hex);
      return hex;
    } catch (_) {
      localColorCache.set(key, '');
      return '';
    }
  }

  async function hydrateSnapshotReferenceColors(snapshot) {
    const resolved = new Map();
    for (const item of snapshot) {
      const task = item.task;
      const colorName = task.colorNameWithoutExt || task.colorRef || '参考色';
      const cacheKey = `${task.colorPath || ''}:${colorName}`;
      let hex = resolved.get(cacheKey);
      if (hex == null) {
        hex = await localReferenceHex(task);
        resolved.set(cacheKey, hex);
      }
      if (hex) task.referenceHex = hex;
    }
    return snapshot;
  }

  function markExported(snapshot, exportedAt) {
    let count = 0;
    const expected = new Map(snapshot.map(item => [`${item.batchId}:${item.taskId}`, item.resultVersion]));
    for (const listedBatch of batchStore.listBatches()) {
      const batch = batchStore.loadBatch(listedBatch.batchId);
      if (!batch) continue;
      let changed = false;
      for (const task of batch.tasks) {
        const version = expected.get(`${batch.batchId}:${task.id}`);
        if (version == null || !isAvailableResultTask(task) || Number(task.resultVersion) !== Number(version)) continue;
        task.exportedAt = exportedAt;
        task.exportedResultVersion = version;
        task.exportNameStale = false;
        changed = true;
        count += 1;
      }
      if (changed) batchStore.saveBatch(batch);
    }
    return count;
  }

  router.get('/api/recolor/export/options', async (req, res) => {
    const snapshot = await hydrateSnapshotReferenceColors(collectExportSnapshot({}));
    const unique = key => [...new Set(snapshot.map(item => item.task[key]).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'zh-CN'));
    const uploads = [...new Set(snapshot.map(item => item.task.uploadBatchId || item.task.sessionId).filter(Boolean))].sort();
    const colorOptions = [];
    const seenColors = new Set();
    for (const item of snapshot) {
      const task = item.task;
      const name = task.colorNameWithoutExt || task.colorRef;
      if (!name || seenColors.has(name)) continue;
      seenColors.add(name);
      colorOptions.push({ name, hex: task.referenceHex || '', label: task.referenceColorLabel || '' });
    }
    colorOptions.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'));
    res.json({ success: true, uploads, colors: colorOptions.map(item => item.name), colorOptions, templates: unique('templateNameWithoutExt'), total: snapshot.length });
  });

  // 新的按需导出：同类条件为 OR，不同类型条件为 AND；创建时冻结当前结果版本。
  router.get('/api/recolor/export', async (req, res) => {
    const snapshot = await hydrateSnapshotReferenceColors(collectExportSnapshot(req.query || {}));
    if (!snapshot.length) return res.status(404).json({ success: false, error: '没有符合条件的已生成结果' });
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lanvas-recolor-export-'));
    try {
      const frozenDir = path.join(tempRoot, 'frozen');
      fs.mkdirSync(frozenDir, { recursive: true });
      const names = new Set();
      const entries = snapshot.map((item, index) => {
        const ext = path.extname(item.source) || '.png';
        const frozen = path.join(frozenDir, `${index}${ext}`);
        fs.copyFileSync(item.source, frozen);
        return { src: frozen, name: exporter.semanticImageName(item.task, names) };
      });
      const exportedAt = new Date().toISOString();
      const archiveName = exporter.semanticArchiveName(snapshot.map(item => item.task), exportedAt);
      const zipPath = await exporter.createNamedZip(tempRoot, entries, archiveName);
      if (!zipPath || !fs.existsSync(zipPath)) throw new Error('打包失败');
      res.setHeader('X-Recolor-Exported-Count', String(snapshot.length));
      res.download(zipPath, archiveName, (downloadError) => {
        if (!downloadError) markExported(snapshot, exportedAt);
        fs.rmSync(tempRoot, { recursive: true, force: true });
      });
    } catch (error) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      res.status(500).json({ success: false, error: '导出失败: ' + error.message });
    }
  });

  // 兼容旧输出页：数据源与复色历史相同，不再枚举已删除任务。
  router.get('/api/outputs', (req, res) => {
    const outputs = batchStore.listBatches().map(batch => ({
      batch: batch.batchId,
      status: batch.status,
      createdAt: batch.createdAt,
      totals: batch.totals,
      files: batch.tasks
        .filter(task => {
          if (!isAvailableResultTask(task)) return false;
          return fs.existsSync(path.join(batchStore.batchDir(batch.batchId), task.output));
        })
        .map(task => ({
          name: path.basename(task.output),
          relativePath: task.output,
          size: fs.statSync(path.join(batchStore.batchDir(batch.batchId), task.output)).size,
          template: task.template,
          colorRef: task.colorRef,
          deltaE: task.deltaE,
          qualityStatus: task.qualityStatus,
          colorStatus: task.colorStatus,
          structureStatus: task.structureStatus,
          outsideMaskStatus: task.outsideMaskStatus,
          outsideChangeRate: task.outsideChangeRate,
          structureScore: task.structureScore,
          costFen: task.costFen,
          executionStatus: task.executionStatus,
          resultVersion: task.resultVersion
        }))
    }));
    res.json({ success: true, outputs });
  });

  router.get('/api/recolor/history', (req, res) => {
    const items = resultService.listHistory({ uploadBatchId: req.query.uploadBatchId || '' });
    res.json({ success: true, total: items.length, items });
  });

  router.post('/api/recolor/history/delete', (req, res) => {
    const result = resultService.requestDelete({
      itemIds: Array.isArray(req.body.itemIds) ? req.body.itemIds : [],
      batchId: req.body.batchId || '',
      taskIds: Array.isArray(req.body.taskIds) ? req.body.taskIds : undefined,
      uploadBatchId: req.body.uploadBatchId || '',
      all: req.body.all === true
    });
    res.json(result);
  });

  router.post('/api/recolor/history/undo', async (req, res) => {
    const result = await resultService.undoDelete(req.body.token);
    res.status(result.success ? 200 : 409).json(result);
  });

  // 删除指定批次：立即隐藏，5 秒后才正式删除。
  router.post('/api/delete-batch', (req, res) => {
    try {
      const bid = req.body.batch;
      if (!bid) return res.status(400).json({ success: false, error: '缺少批次ID' });
      res.json(resultService.requestDelete({ batchId: bid }));
    } catch (e) {
      res.status(500).json({ success: false, error: '删除失败: ' + e.message });
    }
  });

  // 清除所有输出：复用同一可撤销删除状态机。
  router.post('/api/clear-all-outputs', (req, res) => {
    try {
      const result = resultService.requestDelete({ all: true });
      res.json({ ...result, cleared: result.count });
    } catch (e) {
      res.status(500).json({ success: false, error: '清除失败: ' + e.message });
    }
  });

  // ZIP 下载
  router.get('/api/download-zip', async (req, res) => {
    const bid = req.query.batch;
    const color = req.query.color || '';
    if (!bid) return res.status(400).json({ success: false, error: '缺少批次ID' });
    const dir = batchStore.batchDir(bid);
    if (!fs.existsSync(dir)) return res.status(404).json({ success: false, error: '批次不存在' });

    const batch = batchStore.loadBatch(bid);
    const files = [];
    if (batch && color) {
      const decodedColor = decodeURIComponent(color);
      for (const task of batch.tasks) {
        if (task.colorRef === decodedColor && isAvailableResultTask(task)) {
          const fp = path.join(dir, task.output);
          if (fs.existsSync(fp)) files.push(fp);
        }
      }
    } else if (batch) {
      for (const task of batch.tasks) {
        if (!isAvailableResultTask(task)) continue;
        const fp = path.join(dir, task.output);
        if (fs.existsSync(fp)) files.push(fp);
      }
    }

    if (files.length === 0) return res.status(404).json({ success: false, error: '无文件可打包' });

    const suffix = color ? '-' + decodeURIComponent(color).replace(/\.\w+$/, '') : '';
    try {
      const zipPath = await exporter.createZip(dir, files, bid + suffix);
      if (zipPath && fs.existsSync(zipPath)) {
        res.download(zipPath);
      } else {
        res.status(500).json({ success: false, error: '打包失败，请检查 archiver 模块' });
      }
    } catch (e) {
      res.status(500).json({ success: false, error: '打包失败: ' + e.message });
    }
  });

  // ZIP 下载全部已完成结果
  router.get('/api/batches/:batchId/download-results', async (req, res) => {
    const bid = req.params.batchId;
    if (!bid) return res.status(400).json({ success: false, error: '缺少批次ID' });
    const dir = batchStore.batchDir(bid);
    if (!fs.existsSync(dir)) return res.status(404).json({ success: false, error: '批次不存在' });

    const batch = batchStore.loadBatch(bid);
    if (!batch) return res.status(404).json({ success: false, error: '批次数据不存在' });

    const fileGroups = {};
    let seq = 0;
    for (const task of batch.tasks) {
      if (!isAvailableResultTask(task)) continue;
      const es = (task.executionStatus || '').toLowerCase();
      if (!['completed', 'done', 'success'].includes(es)) continue;
      const fp = path.join(dir, task.output);
      if (!fs.existsSync(fp)) continue;

      seq += 1;

      fileGroups['results'] = fileGroups['results'] || [];
      fileGroups['results'].push({ src: fp, seq });
    }

    if (!Object.keys(fileGroups).length)
      return res.status(404).json({ success: false, error: '没有可下载的已完成结果' });

    try {
      const zipPath = await exporter.createStructuredZip(dir, fileGroups, bid + '-all');
      if (zipPath && fs.existsSync(zipPath)) {
        res.download(zipPath);
      } else {
        res.status(500).json({ success: false, error: '打包失败' });
      }
    } catch (e) {
      res.status(500).json({ success: false, error: '打包失败: ' + e.message });
    }
  });

  // ZIP 按颜色分类下载（文件夹内数字编号）
  router.get('/api/batches/:batchId/download-results-by-color', async (req, res) => {
    const bid = req.params.batchId;
    if (!bid) return res.status(400).json({ success: false, error: '缺少批次ID' });
    const dir = batchStore.batchDir(bid);
    if (!fs.existsSync(dir)) return res.status(404).json({ success: false, error: '批次不存在' });

    const batch = batchStore.loadBatch(bid);
    if (!batch) return res.status(404).json({ success: false, error: '批次数据不存在' });

    // 提取颜色名
    function getColorName(task) {
      return (task.colorRef || task.colorNameWithoutExt || '').replace(/\.[^.]+$/, '') || '未分类';
    }

    // 按颜色分组
    const rawGroups = {};
    for (const task of batch.tasks) {
      if (!isAvailableResultTask(task)) continue;
      const es = (task.executionStatus || '').toLowerCase();
      if (!['completed', 'done', 'success'].includes(es)) continue;
      const fp = path.join(dir, task.output);
      if (!fs.existsSync(fp)) continue;
      const clr = getColorName(task);
      rawGroups[clr] = rawGroups[clr] || [];
      rawGroups[clr].push(task);
    }

    if (!Object.keys(rawGroups).length)
      return res.status(404).json({ success: false, error: '没有可下载的已完成结果' });

    // 按模板名自然排序后编号
    function naturalSort(a, b) {
      const na = (a.templateNameWithoutExt || a.template || '').toLowerCase();
      const nb = (b.templateNameWithoutExt || b.template || '').toLowerCase();
      return na.localeCompare(nb, undefined, { numeric: true });
    }

    const fileGroups = {};
    for (const [clr, tasks] of Object.entries(rawGroups)) {
      tasks.sort(naturalSort);
      const entries = tasks.map((t, i) => ({
        src: path.join(dir, t.output),
        seq: i + 1
      }));
      fileGroups[clr] = entries;
    }

    try {
      const zipPath = await exporter.createStructuredZip(dir, fileGroups, bid + '-by-color');
      if (zipPath && fs.existsSync(zipPath)) {
        res.download(zipPath);
      } else {
        res.status(500).json({ success: false, error: '打包失败' });
      }
    } catch (e) {
      res.status(500).json({ success: false, error: '打包失败: ' + e.message });
    }
  });

  // 下载选中任务结果（按颜色分类 + 编号）
  router.get('/api/batches/:batchId/download-selected', async (req, res) => {
    const bid = req.params.batchId;
    const ids = req.query.ids || [];
    const taskIds = Array.isArray(ids) ? ids : [ids];
    if (!bid) return res.status(400).json({ success: false, error: '缺少批次ID' });
    if (!taskIds.length) return res.status(400).json({ success: false, error: '缺少任务ID' });
    const dir = batchStore.batchDir(bid);
    if (!fs.existsSync(dir)) return res.status(404).json({ success: false, error: '批次不存在' });
    const batch = batchStore.loadBatch(bid);
    if (!batch) return res.status(404).json({ success: false, error: '批次数据不存在' });

    const idSet = new Set(taskIds);
    function getColorName(task) { return (task.colorRef || task.colorNameWithoutExt || '').replace(/\.[^.]+$/, '') || '未分类'; }
    const rawGroups = {};
    for (const task of batch.tasks) {
      if (!idSet.has(task.id)) continue;
      if (!isAvailableResultTask(task)) continue;
      const fp = path.join(dir, task.output);
      if (!fs.existsSync(fp)) continue;
      const clr = getColorName(task);
      rawGroups[clr] = rawGroups[clr] || [];
      rawGroups[clr].push(task);
    }
    if (!Object.keys(rawGroups).length) return res.status(404).json({ success: false, error: '没有可下载结果' });

    function naturalSort(a, b) {
      const na = (a.templateNameWithoutExt || '').toLowerCase();
      const nb = (b.templateNameWithoutExt || '').toLowerCase();
      return na.localeCompare(nb, undefined, { numeric: true });
    }
    const fileGroups = {};
    for (const [clr, tasks] of Object.entries(rawGroups)) {
      tasks.sort(naturalSort);
      fileGroups[clr] = tasks.map((t, i) => ({ src: path.join(dir, t.output), seq: i + 1 }));
    }
    try {
      const zipPath = await exporter.createStructuredZip(dir, fileGroups, bid + '-selected');
      if (zipPath && fs.existsSync(zipPath)) res.download(zipPath);
      else res.status(500).json({ success: false, error: '打包失败' });
    } catch (e) { res.status(500).json({ success: false, error: '打包失败: ' + e.message }); }
  });

  return router;
};
