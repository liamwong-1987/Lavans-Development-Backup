'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const canvasRoutes = require('../routes/canvasRoutes');
const moduleConfig = require('../moduleConfigService');
const { normalizeModelId } = moduleConfig;

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

test('模型 ID 只拆除明确包装，并在保存重载后保持精确值', () => {
  assert.equal(normalizeModelId('["seedance-2.0"]'), 'seedance-2.0');
  assert.equal(normalizeModelId('"Qwen/Qwen-Image-2512"'), 'Qwen/Qwen-Image-2512');
  assert.equal(normalizeModelId('doubao-seedance-1-0-pro-quality'), 'doubao-seedance-1-0-pro-quality');
  assert.equal(normalizeModelId('["first","second"]'), '');

  const normalizeCanvasConfig = moduleConfig.__testHooks.normalizeCanvasConfig;
  const first = normalizeCanvasConfig({
    primaryProviderId: 'relay',
    providers: [{
      id: 'relay',
      protocol: 'apimart',
      enabled: true,
      image_models: '["Qwen/Qwen-Image-2512"]',
      chat_models: ['["deepseek-v4-pro"]'],
      vision_models: ['["deepseek-v4-pro"]'],
      video_models: ['["seedance-2.0"]', 'doubao-seedance-1-0-pro-quality'],
      audio_models: ['["mureka-v8"]'],
      unknown_models: ['["future/model-v1"]'],
      video_model_durations: { '["seedance-2.0"]': [5, 10] },
      video_model_resolutions: { '["seedance-2.0"]': ['480p', '720p'] },
      model_names: { '["seedance-2.0"]': 'Seedance 展示名称' },
      model_protocols: { '["seedance-2.0"]': 'apimart' },
      model_category_overrides: { '["seedance-2.0"]': 'video_models', '["mureka-v8"]': 'audio' }
    }]
  });
  const reloaded = normalizeCanvasConfig(JSON.parse(JSON.stringify(first)));
  const provider = reloaded.providers[0];
  assert.deepEqual(provider.image_models, ['Qwen/Qwen-Image-2512']);
  assert.deepEqual(provider.chat_models, ['deepseek-v4-pro']);
  assert.deepEqual(provider.vision_models, ['deepseek-v4-pro']);
  assert.deepEqual(provider.video_models, ['seedance-2.0', 'doubao-seedance-1-0-pro-quality']);
  assert.deepEqual(provider.audio_models, ['mureka-v8']);
  assert.deepEqual(provider.unknown_models, ['future/model-v1']);
  assert.deepEqual(provider.video_model_durations, { 'seedance-2.0': [5, 10] });
  assert.deepEqual(provider.video_model_resolutions, { 'seedance-2.0': ['480p', '720p'] });
  assert.deepEqual(provider.model_names, { 'seedance-2.0': 'Seedance 展示名称' });
  assert.deepEqual(provider.model_protocols, { 'seedance-2.0': 'apimart' });
  assert.deepEqual(provider.model_category_overrides, { 'seedance-2.0': 'video', 'mureka-v8': 'audio' });
});

test('Provider 模型目录优先使用官方分类，并为普通中转站安全回退', async () => {
  const requests = [];
  const upstream = express();
  upstream.get('/v1/models', (req, res) => {
    requests.push(req.originalUrl);
    if (req.query.expand === 'category') {
      return res.json({ data: [
        { id: '["seedance-2.0"]', category: 'video' },
        { id: 'doubao-seedance-1-0-pro-quality', name_en: '["doubao-seedance-1-0-pro-quality"]', category: 'video' },
        { id: 'seedance-2.5', category: 'chat' },
        { id: 'gpt-image-2', category: 'image' },
        { id: 'mureka-v8', category: 'audio' },
        { id: 'gpt-4o-mini-tts', category: 'chat' },
        { id: 'suno', category: 'chat' },
        { id: 'flowmusic', category: 'text' },
        { id: 'gemini-vision-chat', category: 'chat', input_modalities: ['text', 'image'], output_modalities: ['text'] },
        { id: 'future-opaque-model', category: 'unknown' }
      ] });
    }
    return res.json({ data: [
      { id: 'doubao-seedance-1-0-pro-quality' },
      { id: 'seedance-1-0-pro-fast' },
      { id: 'seedance-1-0-pro-quality' },
      { id: 'seedance-1-5-pro' },
      { id: 'seedance-2.0' },
      { id: 'seedance-2.0-face' },
      { id: 'seedance-2.0-fast' },
      { id: 'seedance-2.0-fast-face' },
      { id: 'seedance-2.0-mini' },
      { id: 'seedance-2.5' },
      { id: 'gpt-image-2' },
      { id: 'eleven-music-v3' },
      { id: 'deepseek-v4-pro' },
      { id: 'future-opaque-model' }
    ] });
  });
  const upstreamServer = await listen(upstream);
  const upstreamUrl = `http://127.0.0.1:${upstreamServer.address().port}/v1`;
  const outputRoot = path.join(os.tmpdir(), `lavans-provider-models-${process.pid}-${Date.now()}`);
  const app = express();
  app.use(express.json());
  app.use(canvasRoutes({
    outputRoot,
    canvasConfig: {
      primaryProviderId: 'apimart-fixture',
      providers: [
        { id: 'apimart-fixture', name: 'APIMART fixture', enabled: true, protocol: 'apimart', api_key: 'fixture', base_url: upstreamUrl },
        { id: 'custom-fixture', name: 'Custom fixture', enabled: true, protocol: 'custom', api_key: 'fixture', base_url: upstreamUrl }
      ]
    }
  }));
  const appServer = await listen(app);
  const baseUrl = `http://127.0.0.1:${appServer.address().port}`;

  try {
    const apimartResponse = await fetch(`${baseUrl}/api/canvas/providers/models`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider_id: 'apimart-fixture' })
    });
    assert.equal(apimartResponse.status, 200);
    const apimart = await apimartResponse.json();
    assert.deepEqual(apimart.video_models, ['seedance-2.0', 'doubao-seedance-1-0-pro-quality', 'seedance-2.5']);
    assert.deepEqual(apimart.image_models, ['gpt-image-2']);
    assert.deepEqual(apimart.audio_models, ['mureka-v8', 'gpt-4o-mini-tts', 'suno', 'flowmusic']);
    assert.deepEqual(apimart.chat_models, ['gemini-vision-chat']);
    assert.deepEqual(apimart.unknown_models, ['future-opaque-model']);
    assert(!apimart.models.includes('["doubao-seedance-1-0-pro-quality"]'));
    assert.equal(apimart.model_categories['future-opaque-model'], 'unknown_models');
    assert.equal(requests[0], '/v1/models?expand=category');

    const customResponse = await fetch(`${baseUrl}/api/canvas/providers/models`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider_id: 'custom-fixture' })
    });
    assert.equal(customResponse.status, 200);
    const custom = await customResponse.json();
    assert.deepEqual(custom.video_models, [
      'doubao-seedance-1-0-pro-quality',
      'seedance-1-0-pro-fast',
      'seedance-1-0-pro-quality',
      'seedance-1-5-pro',
      'seedance-2.0',
      'seedance-2.0-face',
      'seedance-2.0-fast',
      'seedance-2.0-fast-face',
      'seedance-2.0-mini',
      'seedance-2.5'
    ]);
    assert.deepEqual(custom.image_models, ['gpt-image-2']);
    assert.deepEqual(custom.audio_models, ['eleven-music-v3']);
    assert.deepEqual(custom.chat_models, ['deepseek-v4-pro']);
    assert.deepEqual(custom.unknown_models, ['future-opaque-model']);
    assert(!custom.chat_models.includes('future-opaque-model'));
    assert.equal(requests[1], '/v1/models');

  } finally {
    await close(appServer);
    await close(upstreamServer);
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});
