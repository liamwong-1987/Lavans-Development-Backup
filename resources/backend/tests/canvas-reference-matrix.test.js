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
const classicPath = path.join(repoRoot, 'resources/frontend/canvas.js');
const smartPath = path.join(repoRoot, 'resources/frontend/smart-canvas-core/smart-canvas-core.js');
const routesPath = path.join(repoRoot, 'resources/backend/routes/canvasRoutes.js');

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

function uniqueRefs(refs) {
  const seen = new Set();
  return (refs || []).filter(ref => {
    if (!ref?.url || seen.has(ref.url)) return false;
    seen.add(ref.url);
    return true;
  });
}

function refs(kind, count, prefix = kind) {
  return Array.from({ length: count }, (_, index) => ({
    url: `/canvas-${kind === 'image' ? 'assets' : 'output'}/${prefix}-${index + 1}.${kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'mp3'}`,
    name: `${prefix}-${index + 1}`,
    kind
  }));
}

function temporaryRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  assert.ok(path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}${prefix}`));
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

test('R4 RunningHub：经典画布与智能画布共用真实存在的 /api/runninghub 命名空间', () => {
  const classicSource = fs.readFileSync(classicPath, 'utf8');
  const routesSource = fs.readFileSync(routesPath, 'utf8');
  assert.doesNotMatch(classicSource, /\/api\/canvas\/providers\/runninghub\//);
  for (const route of ['submit', 'workflow-submit', 'query', 'upload-asset']) {
    assert.match(classicSource, new RegExp(`/api/runninghub/${route}`));
    assert.match(routesSource, new RegExp(`/api/runninghub/${route}`));
  }
});

test('R4 RunningHub：本地、素材库与生成输出都会上传，不能把本机 URL 直接交给远端', async () => {
  const smartSource = fs.readFileSync(smartPath, 'utf8');
  const classicSource = fs.readFileSync(classicPath, 'utf8');
  const localUrls = [
    '/canvas-local-assets/folder/local.png',
    '/canvas-assets/library.png',
    '/canvas-output/generated.png'
  ];

  const smartCalls = [];
  const smartContext = {
    settings: { rhPayment: 'free' },
    tr: key => key,
    async fetch(url, options) {
      smartCalls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, async json() { return { success: true, data: { fileName: `smart-${smartCalls.length}.png` } }; } };
    }
  };
  vm.runInNewContext(`${takeFunction(smartSource, 'rhUploadValueIfNeeded')}\nthis.upload = rhUploadValueIfNeeded;`, smartContext);
  const smartResults = [];
  for (const url of localUrls) smartResults.push(await smartContext.upload(url, { rhPayment: 'free' }));
  assert.deepEqual(smartResults, ['smart-1.png', 'smart-2.png', 'smart-3.png']);
  assert.deepEqual(smartCalls.map(call => call.url), Array(3).fill('/api/runninghub/upload-asset'));
  assert.deepEqual(smartCalls.map(call => call.body.url), localUrls);

  const classicCalls = [];
  const classicContext = {
    rhUseWallet: () => false,
    tr: key => key,
    async fetch(url, options) {
      classicCalls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, async json() { return { success: true, data: { fileName: `classic-${classicCalls.length}.png` } }; } };
    }
  };
  vm.runInNewContext(`${takeFunction(classicSource, 'rhUploadValueIfNeeded')}\nthis.upload = rhUploadValueIfNeeded;`, classicContext);
  const classicResults = [];
  for (const url of localUrls) classicResults.push(await classicContext.upload(url, { rhPayment: 'free' }));
  assert.deepEqual(classicResults, ['classic-1.png', 'classic-2.png', 'classic-3.png']);
  assert.deepEqual(classicCalls.map(call => call.url), Array(3).fill('/api/runninghub/upload-asset'));
  assert.deepEqual(classicCalls.map(call => call.body.url), localUrls);
});

test('R4 MiniMax：经典与智能节点保留全部引用，再由显式上限检查拒绝超限', () => {
  const smartSource = fs.readFileSync(smartPath, 'utf8');
  const smartContext = {
    smartMinimaxSelectedSegment: node => node.segments[0],
    uniqueReferenceImages: uniqueRefs,
    mediaKindForItem: item => item.kind,
    inputImagesFor: node => node.upstream || [],
    smartMinimaxMaxForKind: kind => kind === 'image' ? 9 : 3,
    SMART_MINIMAX_REF_IMAGE_MAX: 9,
    SMART_MINIMAX_REF_VIDEO_MAX: 3,
    SMART_MINIMAX_REF_AUDIO_MAX: 3
  };
  vm.runInNewContext(`${takeFunction(smartSource, 'smartMinimaxRefsForKind')}\n${takeFunction(smartSource, 'smartMinimaxAssertReferenceLimits')}\nthis.refsForKind=smartMinimaxRefsForKind;this.assertLimits=smartMinimaxAssertReferenceLimits;`, smartContext);
  const smartNode = { segments: [{ refItems: refs('image', 10) }] };
  assert.equal(smartContext.refsForKind(smartNode, 'image').length, 10, '智能 MiniMax 不得先截成 9 张');
  assert.throws(() => smartContext.assertLimits(smartNode), /最多支持 9 张参考图/);

  const classicSource = fs.readFileSync(classicPath, 'utf8');
  const mixed = [...refs('image', 9), ...refs('video', 3), ...refs('audio', 4)];
  const classicContext = {
    miniMaxExplicitRefsForSegment: () => [],
    miniMaxRefsForNode: () => ({ refs: mixed }),
    miniMaxUniqueRefs: uniqueRefs,
    imageRefsOnly: items => items.filter(item => item.kind === 'image'),
    videoRefsOnly: items => items.filter(item => item.kind === 'video'),
    audioRefsOnly: items => items.filter(item => item.kind === 'audio'),
    CANVAS_MINIMAX_REF_IMAGE_MAX: 9,
    CANVAS_MINIMAX_REF_VIDEO_MAX: 3,
    CANVAS_MINIMAX_REF_AUDIO_MAX: 3
  };
  vm.runInNewContext(`${takeFunction(classicSource, 'miniMaxRefsForSegment')}\n${takeFunction(classicSource, 'miniMaxAssertReferenceLimits')}\nthis.refsForSegment=miniMaxRefsForSegment;this.assertLimits=miniMaxAssertReferenceLimits;`, classicContext);
  const classicRefs = classicContext.refsForSegment({}, {});
  assert.equal(classicRefs.length, 16, '经典 MiniMax 不得先截成 15 个素材');
  assert.throws(() => classicContext.assertLimits(classicRefs), /最多支持 3 段参考音频/);
});

test('R4 刷新恢复：经典与智能 MiniMax 的来源、种类和顺序原样保留', t => {
  const outputRoot = temporaryRoot('lanvas-r4-roundtrip-');
  t.after(() => {
    const safePrefix = `${path.resolve(os.tmpdir())}${path.sep}lanvas-r4-roundtrip-`;
    if (path.resolve(outputRoot).startsWith(safePrefix)) fs.rmSync(outputRoot, { recursive: true, force: true });
  });
  delete require.cache[require.resolve(routesPath)];
  const createCanvasRouter = require(routesPath);
  const router = createCanvasRouter({ outputRoot });
  const normalizeWorkspace = router.__canvasWorkspaceTestHooks?.normalizeWorkspace;
  assert.equal(typeof normalizeWorkspace, 'function');
  const orderedRefs = [
    { url: '/canvas-local-assets/a.png', kind: 'image', name: 'local' },
    { url: '/canvas-assets/b.png', kind: 'image', name: 'library' },
    { url: '/canvas-output/c.png', kind: 'image', name: 'generated' },
    { url: '/canvas-output/d.mp4', kind: 'video', name: 'video' },
    { url: '/canvas-assets/e.mp3', kind: 'audio', name: 'audio' }
  ];
  const workspace = normalizeWorkspace({
    id: 'r4-roundtrip',
    nodes: [
      { id: 'classic', type: 'minimax', x: 0, y: 0, selectedSegmentId: 'c1', segments: [{ id: 'c1', refs: orderedRefs }] },
      { id: 'smart', type: 'smart-minimax', x: 10, y: 10, selectedSegmentId: 's1', segments: [{ id: 's1', refItems: orderedRefs }] }
    ],
    connections: []
  });
  assert.deepEqual(workspace.nodes.find(node => node.id === 'classic').segments[0].refs, orderedRefs);
  assert.deepEqual(workspace.nodes.find(node => node.id === 'smart').segments[0].refItems, orderedRefs);
});

test('R4 图片任务：经典、智能与兼容入口超过 10 张时在假 Provider 前明确失败', async t => {
  const outputRoot = temporaryRoot('lanvas-r4-limit-');
  const captures = [];
  const canvasConfig = {
    primaryProviderId: 'fixture-image',
    providers: [{ id: 'fixture-image', name: 'Fixture', enabled: true, protocol: 'openai', image_models: ['fixture-model'] }]
  };
  delete require.cache[require.resolve(routesPath)];
  const createCanvasRouter = require(routesPath);
  const app = express();
  app.use(express.json({ limit: '3mb' }));
  app.use(createCanvasRouter({
    outputRoot,
    canvasConfig,
    async performCanvasGeneration(input) {
      captures.push(input);
      return { outputUrl: '/canvas-output/fixture.png', name: 'fixture.png', mime: 'image/png', size: 1 };
    }
  }));
  const listener = await listen(app);
  t.after(async () => {
    await new Promise(resolve => listener.server.close(resolve));
    const safePrefix = `${path.resolve(os.tmpdir())}${path.sep}lanvas-r4-limit-`;
    if (path.resolve(outputRoot).startsWith(safePrefix)) fs.rmSync(outputRoot, { recursive: true, force: true });
  });

  const tooManyAssets = refs('image', 11);
  const smart = await postJson(listener.baseUrl, '/api/canvas/tasks', {
    type: 'generator', providerId: 'fixture-image', model: 'fixture-model', prompt: 'smart', assets: tooManyAssets
  });
  const compatible = await postJson(listener.baseUrl, '/api/canvas/generate', {
    providerId: 'fixture-image', model: 'fixture-model', prompt: 'compatible', assets: tooManyAssets
  });
  const classic = await postJson(listener.baseUrl, '/api/canvas-image-tasks', {
    provider_id: 'fixture-image', model: 'fixture-model', prompt: 'classic', reference_images: tooManyAssets
  });
  assert.deepEqual([smart.response.status, compatible.response.status, classic.response.status], [400, 400, 400]);
  assert.match(`${smart.body.error || ''} ${compatible.body.error || ''} ${classic.body.detail || ''}`, /最多.*10 张/);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(captures.length, 0, '超限不能触发假 Provider，更不能触发真实 Provider');
});
