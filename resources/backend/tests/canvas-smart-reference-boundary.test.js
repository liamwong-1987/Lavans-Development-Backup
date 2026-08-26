'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');

const repoRoot = path.resolve(__dirname, '../../..');
const corePath = path.join(repoRoot, 'resources/frontend/smart-canvas-core/smart-canvas-core.js');
const canvasRoutesPath = path.join(repoRoot, 'resources/backend/routes/canvasRoutes.js');

function takeFunction(source, name) {
  const marker = source.indexOf(`function ${name}(`);
  assert.ok(marker >= 0, `缺少 ${name}`);
  const start = source.lastIndexOf('\n', marker) + 1;
  const open = source.indexOf('{', marker);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`无法提取 ${name}`);
}

function temporaryRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const expectedPrefix = `${path.resolve(os.tmpdir())}${path.sep}${prefix}`;
  assert.ok(path.resolve(root).startsWith(expectedPrefix), '临时目录必须位于系统临时目录内');
  return root;
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function postJson(baseUrl, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { response, body: await response.json() };
}

async function waitForTask(baseUrl, taskId) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/canvas/tasks/${encodeURIComponent(taskId)}`);
    const payload = await response.json();
    if (payload?.task?.status === 'completed' || payload?.task?.status === 'failed') return payload.task;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('假任务没有在等待窗口内完成');
}

test('R1 前端：智能图片请求保留所选 Provider，回执不再伪装成 lavans', async () => {
  const source = fs.readFileSync(corePath, 'utf8');
  const calls = [];
  const context = {
    window: {
      LavansCanvasAdapter: {
        async createTask(payload) {
          calls.push(payload);
          return { task: { id: `fixture-task-${calls.length}`, providerId: payload.providerId } };
        }
      }
    },
    settings: {},
    BRAND: { name: 'Lavans' },
    SMART_REFERENCE_IMAGE_MAX: 20,
    API_RATIO_VALUES: { wide: '16:9' },
    tr(key) { return key; },
    sizeForRun() { return '1280x720'; },
    imageRefsOnly(refs) { return refs.filter(item => item.kind !== 'video'); }
  };
  vm.runInNewContext(`${takeFunction(source, 'runApiGeneration')}\nthis.runApiGeneration = runApiGeneration;`, context);

  const result = await context.runApiGeneration('fixture prompt', [
    { url: '/canvas-assets/a.jpg', name: '图1', kind: 'image' },
    { url: '/canvas-assets/b.jpg', name: '图2', kind: 'image' }
  ], {
    provider_id: 'fixture-secondary',
    model: 'same-model',
    count: 1,
    ratio: 'wide',
    resolution: '1k',
    quality: 'auto'
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].providerId, 'fixture-secondary');
  assert.deepEqual(calls[0].assets.map(item => item.url), ['/canvas-assets/a.jpg', '/canvas-assets/b.jpg']);
  assert.equal(result.providerId, 'fixture-secondary');
  assert.notEqual(result.providerId, 'lavans');
});

test('R1 后端：双 Provider 同名模型只执行请求中精确选择的 Provider', async t => {
  const outputRoot = temporaryRoot('lanvas-r1-');
  const captures = [];
  const canvasConfig = {
    primaryProviderId: 'fixture-primary',
    providers: [
      { id: 'fixture-primary', name: 'Primary', enabled: true, protocol: 'openai', image_models: ['same-model'] },
      { id: 'fixture-secondary', name: 'Secondary', enabled: true, protocol: 'openai', image_models: ['same-model'] }
    ]
  };
  delete require.cache[require.resolve(canvasRoutesPath)];
  const canvasRoutes = require(canvasRoutesPath);
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(canvasRoutes({
    outputRoot,
    canvasConfig,
    async performCanvasGeneration(input) {
      captures.push({ providerId: input.providerId, model: input.model, assets: input.assets });
      return { outputUrl: '/canvas-output/fixture.png', name: 'fixture.png', mime: 'image/png', size: 1 };
    }
  }));
  const { server, baseUrl } = await listen(app);
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    const safePrefix = `${path.resolve(os.tmpdir())}${path.sep}lanvas-r1-`;
    if (path.resolve(outputRoot).startsWith(safePrefix)) fs.rmSync(outputRoot, { recursive: true, force: true });
  });

  const submitted = await postJson(baseUrl, '/api/canvas/tasks', {
    type: 'generator',
    providerId: 'fixture-secondary',
    model: 'same-model',
    prompt: 'fixture prompt',
    size: '1024x1024',
    assets: [{ url: '/canvas-assets/a.jpg', name: '图1' }]
  });
  assert.equal(submitted.response.status, 202);
  assert.equal(submitted.body.task.providerId, 'fixture-secondary');
  const completed = await waitForTask(baseUrl, submitted.body.task.id);
  assert.equal(completed.status, 'completed');
  assert.equal(captures.length, 1);
  assert.equal(captures[0].providerId, 'fixture-secondary');
  assert.equal(captures[0].model, 'same-model');

  const rejected = await postJson(baseUrl, '/api/canvas/tasks', {
    type: 'generator',
    providerId: 'missing-provider',
    model: 'same-model',
    prompt: 'must fail closed',
    assets: []
  });
  assert.equal(rejected.response.status, 409);
  assert.equal(captures.length, 1, '未知 Provider 不能回退并执行主 Provider');
});

test('R2 本地图片：LLM 请求按顺序解析受限画布图片，非法路径在 Provider 前失败', async t => {
  const outputRoot = temporaryRoot('lanvas-r2-');
  const localPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(path.join(outputRoot, 'fixture.png'), localPng);
  const captures = [];

  const upstream = express();
  upstream.use(express.json({ limit: '3mb' }));
  upstream.post('/v1/chat/completions', (req, res) => {
    captures.push(req.body);
    res.json({ choices: [{ message: { content: 'fixture answer' } }] });
  });
  const upstreamListener = await listen(upstream);

  const canvasConfig = {
    primaryProviderId: 'fixture-vision',
    providers: [{
      id: 'fixture-vision',
      name: 'Fixture Vision',
      enabled: true,
      protocol: 'openai',
      base_url: `${upstreamListener.baseUrl}/v1`,
      api_key: 'fixture-key',
      chat_models: ['gpt-4o-mini'],
      image_models: [],
      vision_models: ['gpt-4o-mini']
    }]
  };
  delete require.cache[require.resolve(canvasRoutesPath)];
  const canvasRoutes = require(canvasRoutesPath);
  const app = express();
  app.use(express.json({ limit: '3mb' }));
  app.use(canvasRoutes({ outputRoot, canvasConfig }));
  const listener = await listen(app);
  t.after(async () => {
    await Promise.all([
      new Promise(resolve => listener.server.close(resolve)),
      new Promise(resolve => upstreamListener.server.close(resolve))
    ]);
    const safePrefix = `${path.resolve(os.tmpdir())}${path.sep}lanvas-r2-`;
    if (path.resolve(outputRoot).startsWith(safePrefix)) fs.rmSync(outputRoot, { recursive: true, force: true });
  });

  const inlineImage = `data:image/png;base64,${localPng.toString('base64')}`;
  const accepted = await postJson(listener.baseUrl, '/api/canvas-llm', {
    provider: 'fixture-vision',
    model: 'gpt-4o-mini',
    message: '按顺序查看三张图',
    images: ['/canvas-output/fixture.png', inlineImage, 'https://example.invalid/reference.png']
  });
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.body.text, 'fixture answer');
  assert.equal(captures.length, 1);
  const content = captures[0].messages.at(-1).content;
  assert.equal(content[0].text, '按顺序查看三张图');
  assert.equal(content.length, 4);
  assert.match(content[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal(content[2].image_url.url, inlineImage);
  assert.equal(content[3].image_url.url, 'https://example.invalid/reference.png');

  const rejected = await postJson(listener.baseUrl, '/api/canvas-llm', {
    provider: 'fixture-vision',
    model: 'gpt-4o-mini',
    message: '这个路径必须失败',
    images: ['/canvas-output/missing.png']
  });
  assert.equal(rejected.response.status, 400);
  assert.match(rejected.body.detail, /无法解析/);
  assert.equal(captures.length, 1, '非法本地路径不能触发 Provider 请求');

  fs.writeFileSync(path.join(outputRoot, 'fixture.mp4'), Buffer.from('fixture-video'));
  const unsupportedVideo = await postJson(listener.baseUrl, '/api/canvas-llm', {
    provider: 'fixture-vision',
    model: 'gpt-4o-mini',
    message: '分析视频',
    videos: ['/canvas-output/fixture.mp4']
  });
  assert.equal(unsupportedVideo.response.status, 409);
  assert.match(unsupportedVideo.body.detail, /APIMART Gemini/);
  assert.equal(captures.length, 1, '不支持视频的 Provider 不能收到请求');

  const mixedMedia = await postJson(listener.baseUrl, '/api/canvas-llm', {
    provider: 'fixture-vision',
    model: 'gpt-4o-mini',
    message: '不能混合',
    images: [inlineImage],
    videos: ['/canvas-output/fixture.mp4']
  });
  assert.equal(mixedMedia.response.status, 409);
  assert.match(mixedMedia.body.detail, /混合图片和视频/);

  const multipleVideos = await postJson(listener.baseUrl, '/api/canvas-llm', {
    provider: 'fixture-vision',
    model: 'gpt-4o-mini',
    message: '不能多视频',
    videos: ['/canvas-output/fixture.mp4', '/canvas-output/fixture.mp4']
  });
  assert.equal(multipleVideos.response.status, 400);
  assert.match(multipleVideos.body.detail, /一次只支持 1 个视频/);
  assert.equal(captures.length, 1, '混合媒体或多视频都不能触发 Provider 请求');
});

test('R2 视频：只为精确 APIMART Gemini 构造一次原生视频请求', () => {
  const source = fs.readFileSync(canvasRoutesPath, 'utf8');
  const root = temporaryRoot('lanvas-r2-video-');
  const videoPath = path.join(root, 'fixture.mp4');
  fs.writeFileSync(videoPath, Buffer.from('fixture-video'));
  const context = {
    fs,
    path,
    Buffer,
    URL,
    validAssetPath() { return videoPath; }
  };
  try {
    vm.runInNewContext(`${takeFunction(source, 'canvasLlmVideoInput')}\n${takeFunction(source, 'canvasLlmGeminiVideoRequest')}\nthis.videoInput=canvasLlmVideoInput;this.videoRequest=canvasLlmGeminiVideoRequest;`, context);
    const video = context.videoInput('/canvas-output/fixture.mp4');
    assert.equal(video.mimeType, 'video/mp4');
    assert.equal(Buffer.from(video.data, 'base64').toString(), 'fixture-video');

    const request = context.videoRequest({
      id: 'apimart',
      protocol: 'apimart',
      base_url: 'https://api.apimart.ai/v1',
      chat_models: ['gemini-3.6-flash']
    }, 'gemini-3.6-flash', '分析镜头', '只描述事实', [{ role: 'user', content: '前文' }], video);
    assert.equal(request.url, 'https://api.apimart.ai/v1beta/models/gemini-3.6-flash:generateContent');
    assert.equal(request.body.systemInstruction.parts[0].text, '只描述事实');
    assert.equal(request.body.contents[0].role, 'user');
    assert.equal(request.body.contents[1].parts[0].inlineData.mimeType, 'video/mp4');
    assert.equal(request.body.contents[1].parts[1].text, '分析镜头');

    assert.throws(() => context.videoRequest({
      id: 'other', protocol: 'apimart', base_url: 'https://example.com/v1', chat_models: ['gemini-3.6-flash']
    }, 'gemini-3.6-flash', '分析', '', [], video), /APIMART Gemini/);

    const oversizedPath = path.join(root, 'oversized.mp4');
    fs.closeSync(fs.openSync(oversizedPath, 'w'));
    fs.truncateSync(oversizedPath, 14 * 1024 * 1024 + 1);
    context.validAssetPath = () => oversizedPath;
    assert.throws(() => context.videoInput('/canvas-output/oversized.mp4'), /超过 14 MB/);
  } finally {
    const safePrefix = `${path.resolve(os.tmpdir())}${path.sep}lanvas-r2-video-`;
    if (path.resolve(root).startsWith(safePrefix)) fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R2.5 已生成图片：重跑复用原节点，成功归档旧图，失败可原样恢复', () => {
  const source = fs.readFileSync(corePath, 'utf8');
  const history = { id: 'history-1', type: 'smart-image', images: [], historyFor: 'generated-1', isHistoryGroup: true };
  const context = {
    JSON,
    MEDIA_GROUP_DEFAULT_SCALE: 0.31,
    isSmartImageNode: node => node?.type === 'smart-image',
    isHistoryGroupNode: node => Boolean(node?.historyFor || node?.isHistoryGroup),
    cleanHistoryImages: images => (images || []).filter(item => item?.url).map(item => ({ ...item })),
    ensureHistoryGroupForNode: () => history
  };
  vm.runInNewContext(`${takeFunction(source, 'smartGeneratedOutputRerunsInPlace')}\n${takeFunction(source, 'beginSmartOutputReplacement')}\n${takeFunction(source, 'restoreSmartOutputReplacement')}\n${takeFunction(source, 'prepareSmartOutputReplacement')}\nthis.canReplace=smartGeneratedOutputRerunsInPlace;this.begin=beginSmartOutputReplacement;this.restore=restoreSmartOutputReplacement;this.prepare=prepareSmartOutputReplacement;`, context);

  const generated = {
    id: 'generated-1',
    type: 'smart-image',
    images: [{ url: '/canvas-output/old.png', kind: 'image' }],
    runAt: 100,
    runSettings: { engine: 'api', model: 'fixture-image' },
    runStartedAt: 80,
    runFinishedAt: 100,
    runElapsedMs: 20,
    runTimerHidden: true
  };
  assert.equal(context.canReplace(generated, true, false), true);
  assert.equal(context.canReplace({ ...generated, runAt: 0, runSettings: null }, true, false), false, '导入/参考图仍需保留分支语义');
  assert.equal(context.canReplace({ ...generated, agentNative: { workspaceScope: 'canvas-agent' } }, true, false), false, 'AGENT 原生节点不能进入普通重跑路径');
  assert.equal(context.canReplace({ ...generated, agentNative: {} }, true, false), false, '历史 AGENT 节点即使缺少 workspaceScope 也不得进入普通重跑路径');
  assert.equal(context.canReplace({ ...generated, type: 'smart-group' }, true, false), false);

  const nextMeta = { prompt: 'new prompt', settings: { engine: 'api', model: 'fixture-image' }, createdAt: 200 };
  context.begin(generated, nextMeta);
  assert.equal(generated.replaceOutputsOnComplete, true);
  assert.equal(generated.pendingRunMeta.prompt, 'new prompt');
  const recovered = JSON.parse(JSON.stringify(generated));
  assert.equal(recovered.replaceOutputsOnComplete, true, '待替换状态必须跨刷新持久化');
  assert.equal(recovered.outputReplacementPreviousState.runFinishedAt, 100);

  generated.runStartedAt = 200;
  delete generated.runFinishedAt;
  assert.equal(context.prepare(generated, 'image'), true);
  assert.equal(history.images.map(item => item.url).join(','), '/canvas-output/old.png');
  assert.equal(generated.images.length, 0);
  assert.equal(generated.replaceOutputsOnComplete, undefined);
  assert.equal(generated.pendingRunMeta.prompt, 'new prompt', '成功结果落地前必须保留新一轮元数据');

  const failed = {
    id: 'generated-failed', type: 'smart-image', images: [{ url: '/canvas-output/keep.png' }],
    runAt: 300, runSettings: { engine: 'api' }, runStartedAt: 280, runFinishedAt: 300,
    runElapsedMs: 20, runTimerHidden: false
  };
  context.begin(failed, nextMeta);
  failed.runStartedAt = 400;
  delete failed.runFinishedAt;
  context.restore(failed);
  assert.equal(failed.images[0].url, '/canvas-output/keep.png');
  assert.equal(failed.runStartedAt, 280);
  assert.equal(failed.runFinishedAt, 300);
  assert.equal(failed.replaceOutputsOnComplete, undefined);
  assert.equal(failed.pendingRunMeta, undefined);

  const finalizeContext = {
    JSON,
    MEDIA_NODE_DEFAULT_SCALE: 0.4,
    MEDIA_GROUP_DEFAULT_SCALE: 0.31,
    MEDIA_GROUP_PREVIOUS_DEFAULT_SCALE: 0.3,
    nowMs: () => 500,
    smartPendingTasks: node => Array.isArray(node.pendingTasks) ? node.pendingTasks : [],
    resultMediaUrls: items => Array.isArray(items) ? items : [],
    cleanHistoryImages: context.cleanHistoryImages,
    stripImageGenerationMeta: item => item,
    copyMediaSizeFields: (item, patch) => ({ ...(item && typeof item === 'object' ? item : {}), ...patch }),
    generatedMediaNameForItem: (_item, _kind, ext) => `generated.${ext}`,
    ensureHistoryGroupForNode: context.ensureHistoryGroupForNode,
    attachRunMeta: (node, meta) => { node.appliedRunMeta = meta; },
    mediaNodeDefaultScale: () => 0.4,
    tr: key => key
  };
  vm.runInNewContext(`${takeFunction(source, 'prepareSmartOutputReplacement')}\n${takeFunction(source, 'finalizeSmartPendingTask')}\nthis.finalize=finalizeSmartPendingTask;`, finalizeContext);
  history.images = [];
  const asyncNode = {
    id: 'generated-1', type: 'smart-image', images: [{ url: '/canvas-output/old.png', kind: 'image' }],
    pending: 2, pendingTasks: [{ taskId: 'task-1' }, { taskId: 'task-2' }],
    replaceOutputsOnComplete: true, pendingRunMeta: nextMeta,
    outputReplacementPreviousState: { runStartedAt: 80, runFinishedAt: 100, runElapsedMs: 20, runTimerHidden: true }
  };
  finalizeContext.finalize(asyncNode, 'task-1', ['/canvas-output/new-1.png'], 'image');
  finalizeContext.finalize(asyncNode, 'task-2', ['/canvas-output/new-2.png'], 'image');
  assert.equal(asyncNode.images.map(item => item.url).join(','), '/canvas-output/new-1.png,/canvas-output/new-2.png');
  assert.equal(history.images.map(item => item.url).join(','), '/canvas-output/old.png');
  assert.equal(asyncNode.appliedRunMeta.prompt, 'new prompt');
  assert.equal(asyncNode.pendingTasks, undefined);
  assert.equal(asyncNode.replaceOutputsOnComplete, undefined);

  const emptyNode = {
    id: 'generated-empty', type: 'smart-image', images: [{ url: '/canvas-output/keep-empty.png', kind: 'image' }],
    pending: 1, pendingTasks: [{ taskId: 'task-empty' }], replaceOutputsOnComplete: true,
    pendingRunMeta: nextMeta, outputReplacementPreviousState: { runStartedAt: 80, runFinishedAt: 100 }
  };
  assert.throws(() => finalizeContext.finalize(emptyNode, 'task-empty', [], 'image'), /smart\.errNoOutImages/);
  assert.equal(emptyNode.images[0].url, '/canvas-output/keep-empty.png');
  assert.equal(emptyNode.pendingTasks[0].taskId, 'task-empty');
  assert.equal(emptyNode.replaceOutputsOnComplete, true);

  const runSource = takeFunction(source, 'runGeneration');
  assert.match(runSource, /const rerunInPlace\s*=\s*smartGeneratedOutputRerunsInPlace/);
  assert.match(runSource, /shouldCreateBranchOutput\s*=\s*groupRun\s*\|\|\s*\(nodeHasImages\s*&&\s*!workflowModeRun\s*&&\s*!rerunInPlace\)/);
  assert.match(runSource, /restoreSmartOutputReplacement/);
  assert.match(takeFunction(source, 'finalizePendingNode'), /prepareSmartOutputReplacement/);
});
