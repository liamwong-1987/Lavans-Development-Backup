const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const createTaskRunner = require('../services/taskRunner');
const createTaskService = require('../services/taskService');

const clone = value => JSON.parse(JSON.stringify(value));

function makeStore(root, initial) {
  const dir = path.join(root, initial.batchId);
  const file = path.join(dir, 'batch.json');
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'attempts'), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(initial, null, 2));
  return {
    batchDir: () => dir,
    loadBatch: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    saveBatch(batch) {
      fs.writeFileSync(file, JSON.stringify(batch, null, 2));
      return batch;
    }
  };
}

async function startFakeProvider(imageBase64) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization || '',
        contentType: req.headers['content-type'] || '',
        body: Buffer.concat(chunks).toString('latin1')
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.end(JSON.stringify({ data: [{ id: 'local-fake-image-model' }] }));
      } else {
        res.end(JSON.stringify({ data: [{ b64_json: imageBase64 }] }));
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, requests, port: server.address().port };
}

test('本地伪造 Provider 贯通 FIFO、一次提交、费用记账和原子结果保存', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lanvas-recolor-stage-g-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const png = await sharp({
    create: { width: 8, height: 8, channels: 3, background: '#566e51' }
  }).png().toBuffer();
  const provider = await startFakeProvider(png.toString('base64'));
  t.after(() => new Promise(resolve => provider.server.close(resolve)));

  const previousEnv = {
    BASE_URL: process.env.BASE_URL,
    API_KEY: process.env.API_KEY,
    IMAGE_MODEL: process.env.IMAGE_MODEL
  };
  process.env.BASE_URL = `http://127.0.0.1:${provider.port}/v1`;
  process.env.API_KEY = 'local-fake-key';
  process.env.IMAGE_MODEL = 'local-fake-image-model';
  t.after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const apiClientPath = require.resolve('../apiClient');
  delete require.cache[apiClientPath];
  const apiClient = require('../apiClient');
  t.after(() => { delete require.cache[apiClientPath]; });

  const templatePath = path.join(root, 'template.png');
  const colorPath = path.join(root, 'reference.png');
  fs.writeFileSync(templatePath, png);
  fs.writeFileSync(colorPath, png);

  const now = () => new Date().toISOString();
  const batch = {
    batchId: 'batch_stage_g',
    status: 'running',
    active: true,
    cancelRequested: false,
    userPauseRequested: false,
    systemPauseRequested: false,
    concurrency: 8,
    promptSnapshot: '仅根据参考图片进行整图自然复色',
    imageSizeSnapshot: '1024x1024',
    qualitySnapshot: 'low',
    providerIdSnapshot: '',
    modelSnapshot: 'local-fake-image-model',
    costPerCallFenSnapshot: 8,
    tasks: [{
      id: 'task-stage-g-1',
      order: 1,
      queueSequence: 1,
      queueAttempt: 0,
      templatePath,
      colorPath,
      templateNameWithoutExt: '单椅场景图',
      colorNameWithoutExt: '森林绿',
      referenceHex: '#566E51',
      executionStatus: 'pending',
      runtimeStatus: null,
      qualityStatus: 'review_required',
      generationSubmissionState: 'not_submitted',
      apiAttempts: 0,
      costFen: 0,
      resultVersion: 0,
      costPerCallFenSnapshot: 8
    }]
  };
  const store = makeStore(root, clone(batch));
  const taskService = createTaskService({
    batchStore: store,
    apiClient,
    safeFileStem: value => String(value || 'image').replace(/[^\w\u4e00-\u9fa5-]+/g, '_'),
    now,
    errorMessage: error => error?.message || '未知错误'
  });
  const runner = createTaskRunner({ batchStore: store, now });
  runner.injectTaskService(taskService);

  await runner.start(batch.batchId);
  const completed = store.loadBatch(batch.batchId);
  const task = completed.tasks[0];

  assert.equal(provider.requests.length, 1);
  assert.equal(provider.requests[0].method, 'POST');
  assert.equal(provider.requests[0].url, '/v1/images/edits');
  assert.equal(provider.requests[0].authorization, 'Bearer local-fake-key');
  assert.match(provider.requests[0].contentType, /^multipart\/form-data;/);
  assert.equal((provider.requests[0].body.match(/name="image"/g) || []).length, 2);
  assert.match(provider.requests[0].body, /local-fake-image-model/);
  assert.doesNotMatch(provider.requests[0].body, /#566E51/);

  assert.equal(task.executionStatus, 'completed');
  assert.equal(task.generationSubmissionState, 'resolved');
  assert.equal(task.apiAttempts, 1);
  assert.equal(task.costFen, 8);
  assert.equal(task.resultVersion, 1);
  assert.equal(task.qualityStatus, 'review_required');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.active, false);

  const outputPath = path.join(store.batchDir(batch.batchId), task.output);
  assert.ok(fs.existsSync(outputPath));
  assert.equal((await sharp(outputPath).metadata()).format, 'jpeg');
  assert.deepEqual(fs.readdirSync(path.join(store.batchDir(batch.batchId), 'attempts')), []);

  await runner.start(batch.batchId);
  assert.equal(provider.requests.length, 1, '已完成任务恢复后不得再次提交');

  const health = await apiClient.checkHealth({});
  assert.equal(health.success, true);
  assert.equal(provider.requests.filter(request => request.method === 'POST').length, 1, '免费健康检查不得提交生成请求');
  assert.equal(provider.requests.filter(request => request.method === 'GET' && request.url === '/v1/models').length, 1);
});
