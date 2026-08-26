const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number(process.argv[2] || 41740);
const frontend = path.resolve(__dirname, '..', '..', '..', 'frontend');
const now = new Date().toISOString();

const colors = [
  ['森林绿', '#566E51'], ['陶土橙', '#B46B38'], ['暮光紫', '#8B5BA7'], ['曜石黑', '#24262B'],
  ['海蓝色', '#3D6F93'], ['湖绿色', '#4D8876'], ['暖沙色', '#C2A37A'], ['雾灰色', '#85888D']
];
const states = ['completed', 'completed', 'completed', 'completed', 'running', 'error', 'pending', 'pending'];
const tasks = colors.map((entry, index) => {
  const state = states[index];
  return {
    id: `stage-g-task-${index + 1}`,
    order: index + 1,
    queueSequence: index + 1,
    template: index < 4 ? '单椅场景图.png' : '手提包正面图.png',
    templateNameWithoutExt: index < 4 ? '单椅场景图' : '手提包正面图',
    templatePath: index < 4 ? '单椅场景图.png' : '手提包正面图.png',
    colorRef: `${entry[0]}.png`,
    colorNameWithoutExt: entry[0],
    colorPath: `${entry[0]}.png`,
    referenceHex: entry[1],
    executionStatus: state,
    runtimeStatus: state === 'running' ? 'awaiting_remote' : null,
    generationSubmissionState: state === 'completed' ? 'resolved' : state === 'running' ? 'submitted' : state === 'error' ? 'failed' : 'not_submitted',
    output: state === 'completed' ? `images/stage-g-result-${index + 1}.jpg` : '',
    resultVersion: state === 'completed' ? 1 : 0,
    exportedAt: index === 0 ? now : null,
    exportedResultVersion: index === 0 ? 1 : 0,
    apiAttempts: ['completed', 'running', 'error'].includes(state) ? 1 : 0,
    costFen: ['completed', 'running', 'error'].includes(state) ? 8 : 0,
    elapsedMs: state === 'completed' ? 54321 + index * 1000 : null,
    error: state === 'error' ? '接口响应超时' : null,
    modelSnapshot: 'Seedream 4.0',
    providerIdSnapshot: 'local-ui-fixture',
    qualityStatus: 'review_required',
    uploadBatchId: index < 4 ? 'upload-20260822-A' : 'upload-20260822-B'
  };
});
const batch = {
  batchId: 'batch_stage_g_ui',
  status: 'running', active: true, concurrency: 8,
  createdAt: now, updatedAt: now, providerIdSnapshot: 'local-ui-fixture', modelSnapshot: 'Seedream 4.0',
  costPerCallFenSnapshot: 8,
  totals: { total: 8, pending: 2, running: 1, completed: 4, success: 4, failed: 1, cancelled: 0, interrupted: 0, done: 5, costFen: 48, apiAttempts: 6 },
  tasks
};

const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420"><defs><linearGradient id="g"><stop stop-color="#ebe7df"/><stop offset="1" stop-color="#b8c2aa"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><rect x="210" y="95" width="220" height="170" rx="42" fill="#566e51"/><rect x="235" y="250" width="28" height="110" fill="#6d4c35"/><rect x="377" y="250" width="28" height="110" fill="#6d4c35"/><circle cx="320" cy="176" r="28" fill="#8ca17f" opacity=".55"/></svg>`);

function json(res, data, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname.startsWith('/output/') || url.pathname.startsWith('/uploads/')) {
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
    return res.end(svg);
  }
  const relative = decodeURIComponent(url.pathname === '/' ? '/recolor.html' : url.pathname).replace(/^[/\\]+/, '');
  const file = path.resolve(frontend, relative);
  if (!file.startsWith(frontend + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); return res.end('not found');
  }
  const ext = path.extname(file).toLowerCase();
  const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' }[ext] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname === '/api/config') return json(res, {
    success: true,
    config: { theme: 'light', promptProfiles: [], selectedPromptProfileId: 'bedding', costPerCallFen: 8 },
    api_providers: [{ id: 'local-ui-fixture', name: '本地验收服务', api_key: true, image_models: ['Seedream 4.0'] }]
  });
  if (url.pathname === '/api/batches/latest' || url.pathname === `/api/batches/${batch.batchId}`) {
    return json(res, { success: true, batch });
  }
  if (url.pathname === '/api/logs/recent') return json(res, {
    ok: true,
    logs: [
      { timestamp: now, level: 'success', message: '任务 stage-g-task-4 已写入最新结果' },
      { timestamp: now, level: 'info', message: '队列剩余 2 项等待生成' },
      { timestamp: now, level: 'error', message: '任务 stage-g-task-6 接口响应超时' }
    ]
  });
  if (url.pathname === '/api/recolor/export/options') return json(res, {
    success: true, total: 4, uploads: ['upload-20260822-A'], colors: colors.slice(0, 4).map(item => item[0]), templates: ['单椅场景图']
  });
  if (url.pathname === '/api/recolor/history') return json(res, { success: true, items: [] });
  if (url.pathname.startsWith('/api/')) return json(res, { success: true });
  return serveStatic(req, res);
});

server.listen(port, '127.0.0.1', () => console.log(`recolor-stage-g-ui http://127.0.0.1:${port}`));
