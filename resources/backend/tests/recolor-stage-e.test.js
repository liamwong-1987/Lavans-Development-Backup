const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const sharp = require('sharp');

const createReferenceService = require('../services/recolorReferenceService');
const createScanRoutes = require('../routes/scanRoutes');
const batchStore = require('../batchStore');
const exporter = require('../exporter');

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lanvas-recolor-stage-e-'));
  for (const relative of ['templates', 'colors']) fs.mkdirSync(path.join(root, relative), { recursive: true });
  const fileStore = {
    getActiveUploadSessionId() { return null; },
    getUploadRoot() { return root; },
    getFileLists() {
      const files = fs.readdirSync(path.join(root, 'colors')).map(name => ({
        name,
        nameWithoutExt: path.parse(name).name,
        path: path.join(root, 'colors', name),
        ext: path.extname(name)
      }));
      return { templates: { files: [], count: 0 }, colors: { files, count: files.length } };
    }
  };
  return { root, fileStore };
}

async function image(filePath, width, height, color) {
  await sharp({ create: { width, height, channels: 3, background: color } }).png().toFile(filePath);
}

test('同批参考色裁剪保留原图，比例异常必须先确认', async t => {
  const { root, fileStore } = workspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await image(path.join(root, 'colors', '正方形.png'), 100, 100, '#566e51');
  await image(path.join(root, 'colors', '长图.png'), 200, 100, '#b46b38');
  const service = createReferenceService({ fileStore, colorEngine: {} });

  const pending = await service.applyCrop(null, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
  assert.equal(pending.requiresConfirmation, true);
  assert.equal(fs.existsSync(path.join(root, '.recolor-color-crops', '正方形.png')), false);

  const applied = await service.applyCrop(null, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, { confirmAspectWarnings: true });
  assert.equal(applied.success, true);
  assert.equal(applied.count, 2);
  assert.deepEqual(await sharp(path.join(root, 'colors', '正方形.png')).metadata().then(meta => [meta.width, meta.height]), [100, 100]);
  assert.deepEqual(await sharp(path.join(root, '.recolor-color-crops', '正方形.png')).metadata().then(meta => [meta.width, meta.height]), [50, 50]);
  assert.equal(service.getEffectiveColor(null, '正方形.png').cropApplied, true);
});

test('HEX 元数据只服务本地管理，并能随配对带入导出字段', async t => {
  const { root, fileStore } = workspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await image(path.join(root, 'colors', '客户给色.png'), 30, 30, '#566e51');
  const service = createReferenceService({ fileStore, colorEngine: {} });

  const metadata = service.setMetadata(null, '客户给色.png', { hex: '#566e51', label: '森林绿' });
  assert.equal(metadata.hex, '#566E51');
  const pair = service.decoratePair({ colorName: '客户给色.png', colorPath: path.join(root, 'colors', '客户给色.png') }, null);
  assert.equal(pair.referenceHex, '#566E51');
  assert.equal(pair.referenceColorLabel, '森林绿');
  assert.equal(pair.colorPath, path.join(root, 'colors', '客户给色.png'));
});

test('缺失 HEX 时自动本地吸色，人工保存值始终优先', async t => {
  const { root, fileStore } = workspace();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await image(path.join(root, 'colors', '自动取色.png'), 30, 30, '#b46b38');
  let extractedHex = '#B46B38';
  const service = createReferenceService({
    fileStore,
    colorEngine: { async extractColor() { return { success: true, primary: { hex: extractedHex }, candidates: [{ hex: extractedHex }] }; } }
  });

  const automatic = await service.ensureExtractedMetadata(null);
  assert.equal(automatic.updated.length, 1);
  assert.equal(service.getEffectiveColor(null, '自动取色.png').referenceHex, '#B46B38');
  assert.equal(service.getEffectiveColor(null, '自动取色.png').referenceHexSource, 'auto');

  extractedHex = '#4EA29B';
  const refreshedAutomatic = await service.ensureExtractedMetadata(null);
  assert.equal(refreshedAutomatic.updated.length, 1);
  assert.equal(service.getEffectiveColor(null, '自动取色.png').referenceHex, '#4EA29B');

  service.setMetadata(null, '自动取色.png', { hex: '#123456', label: '人工确认色' });
  extractedHex = '#FFFFFF';
  const preserved = await service.ensureExtractedMetadata(null);
  assert.equal(preserved.updated.length, 0);
  assert.equal(service.getEffectiveColor(null, '自动取色.png').referenceHex, '#123456');
  assert.equal(service.getEffectiveColor(null, '自动取色.png').referenceColorLabel, '人工确认色');
  assert.equal(service.getEffectiveColor(null, '自动取色.png').referenceHexSource, 'manual');
});

test('扫描自动吸色并回填同批已有任务 referenceHex', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lanvas-recolor-scan-hex-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'templates'), { recursive: true });
  fs.mkdirSync(path.join(root, 'colors'), { recursive: true });
  await image(path.join(root, 'templates', '床品.png'), 20, 20, '#eeeeee');
  await image(path.join(root, 'colors', '湖绿.png'), 20, 20, '#0a8f80');
  const sessionId = 'session-existing';
  const list = type => fs.readdirSync(path.join(root, type)).map(name => ({
    name, nameWithoutExt: path.parse(name).name, path: path.join(root, type, name), ext: path.extname(name)
  }));
  const fileStore = {
    getActiveUploadSessionId: () => sessionId,
    getUploadRoot: () => root,
    getFileLists() {
      const templates = list('templates');
      const colors = list('colors');
      return { templates: { files: templates, count: templates.length }, colors: { files: colors, count: colors.length } };
    },
    getUploadPublicPath: filePath => filePath
  };
  const batch = { batchId: 'batch-existing', tasks: [{ id: 'task-existing', uploadBatchId: sessionId, colorNameWithoutExt: '湖绿' }] };
  let saves = 0;
  const fakeBatchStore = {
    listBatches: () => [{ batchId: batch.batchId }],
    loadBatch: id => id === batch.batchId ? batch : null,
    saveBatch: () => { saves += 1; }
  };
  const validator = {
    autoPair(templates, colors) {
      return [{ id: 'pair-1', templateName: templates[0].name, templatePath: templates[0].path, colorName: colors[0].name, colorPath: colors[0].path }];
    }
  };
  const express = require('express');
  const app = express();
  app.use(createScanRoutes({
    fileStore, validator,
    colorEngine: { async extractColor() { return { success: true, primary: { hex: '#0A8F80' }, candidates: [{ hex: '#0A8F80' }] }; } },
    validationCache: { data: null }, colorMapCache: { data: {} },
    runners: { purgeAll() {} }, batchStore: fakeBatchStore, resultService: {}
  }));
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  const response = await request(`http://127.0.0.1:${address.port}/api/scan?sessionId=${sessionId}`);
  const payload = JSON.parse(response.body.toString('utf8'));

  assert.equal(response.status, 200);
  assert.equal(payload.pairs[0].referenceHex, '#0A8F80');
  assert.equal(batch.tasks[0].referenceHex, '#0A8F80');
  assert.equal(saves, 1);
});

test('导出命名不使用纯序号，同名任务用四位短码区分', () => {
  const names = new Set();
  const first = exporter.semanticImageName({ id: 'task-abcd', templateNameWithoutExt: '椅子', colorNameWithoutExt: '绿色', referenceHex: '#566e51', createdAt: '2026-08-22T14:21:00.000Z', output: 'images/a.png' }, names);
  const second = exporter.semanticImageName({ id: 'task-9F12', templateNameWithoutExt: '椅子', colorNameWithoutExt: '绿色', referenceHex: '#566e51', createdAt: '2026-08-22T14:21:00.000Z', output: 'images/b.png' }, names);
  assert.match(first, /^椅子-绿色-HEX-566E51-20260822-\d{6}\.png$/);
  assert.match(second, /^椅子-绿色-HEX-566E51-20260822-\d{6}-9F12\.png$/);
  assert.equal(/^(01|02)[-_]/.test(first), false);
  assert.equal(exporter.semanticArchiveName([{ templateNameWithoutExt: '椅子' }], '2026-08-22T14:21:00.000Z'), '20260822-椅子-复色结果.zip');
});

test('任务元数据标准化保留 HEX、导出版本和名称待重新导出状态', () => {
  const task = batchStore.__test.normalizeTask({
    id: 'one', executionStatus: 'completed', output: 'images/one.png',
    referenceHex: '#566e51', referenceColorLabel: '森林绿', exportNameStale: true,
    resultVersion: 2, exportedResultVersion: 1
  }, { createdAt: '2026-08-22T00:00:00.000Z' });
  assert.equal(task.referenceHex, '#566E51');
  assert.equal(task.referenceColorLabel, '森林绿');
  assert.equal(task.exportNameStale, true);
  assert.equal(task.exportedResultVersion, 1);
});

function request(url) {
  return new Promise((resolve, reject) => {
    http.get(url, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('按需导出冻结当前结果，成功交付后才标记；改名后可再次导出', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lanvas-recolor-export-route-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const batchId = 'batch-export';
  const batchDir = path.join(root, batchId);
  fs.mkdirSync(path.join(batchDir, 'images'), { recursive: true });
  fs.writeFileSync(path.join(batchDir, 'images', 'result.png'), 'result-v1');
  const batch = {
    batchId,
    tasks: [{
      id: 'task-9F12', executionStatus: 'completed', output: 'images/result.png', resultVersion: 1,
      templateNameWithoutExt: '椅子', colorNameWithoutExt: '森林绿', referenceHex: '#566E51', uploadBatchId: 'upload_1'
    }]
  };
  const fakeStore = {
    listBatches: () => [{ batchId }],
    loadBatch: id => id === batchId ? batch : null,
    saveBatch: () => {},
    batchDir: id => path.join(root, id)
  };
  const fakeExporter = {
    semanticImageName: () => '椅子-森林绿-HEX-566E51-20260822-142100.png',
    semanticArchiveName: () => '20260822-椅子-复色结果.zip',
    async createNamedZip(dir) {
      const file = path.join(dir, '20260822-椅子-复色结果.zip');
      fs.writeFileSync(file, 'frozen-export');
      return file;
    }
  };
  const express = require('express');
  const app = express();
  app.use(require('../routes/outputRoutes')({ batchStore: fakeStore, exporter: fakeExporter, resultService: {} }));
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();

  // 历史结果“下载已选”按 taskId 精确导出，不能把整个批次一起打包。
  const selectedOnly = await request(`http://127.0.0.1:${address.port}/api/recolor/export?taskId=task-9F12`);
  assert.equal(selectedOnly.status, 200);
  assert.equal(selectedOnly.headers['x-recolor-exported-count'], '1');
  await new Promise(resolve => setTimeout(resolve, 15));
  delete batch.tasks[0].exportedAt;
  delete batch.tasks[0].exportedResultVersion;

  const first = await request(`http://127.0.0.1:${address.port}/api/recolor/export?onlyUnexported=1&color=%E6%A3%AE%E6%9E%97%E7%BB%BF`);
  assert.equal(first.status, 200);
  assert.equal(first.headers['x-recolor-exported-count'], '1');
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.ok(batch.tasks[0].exportedAt);
  assert.equal(batch.tasks[0].exportedResultVersion, 1);

  batch.tasks[0].exportNameStale = true;
  const second = await request(`http://127.0.0.1:${address.port}/api/recolor/export?onlyUnexported=1`);
  assert.equal(second.status, 200);
});
