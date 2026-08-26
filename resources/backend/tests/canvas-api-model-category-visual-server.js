'use strict';

const express = require('express');
const http = require('node:http');
const path = require('node:path');

const canvasRoutes = require('../routes/canvasRoutes');

const frontendRoot = path.resolve(__dirname, '../../frontend');

function listen(app) {
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function publicProvider(provider) {
  const { api_key: _secret, ...safe } = provider;
  return { ...safe, has_api_key: true, api_key_masked: 'sk-***stage5' };
}

async function main() {
  const upstream = express();
  upstream.get('/v1/models', (_req, res) => res.json({ data: [
    { id: '["gpt-image-2"]', category: 'image' },
    { id: '["deepseek-v4-pro"]', category: 'chat' },
    { id: '["seedance-2.5"]', category: 'video' },
    { id: '["mureka-v8"]', category: 'audio' },
    { id: '["future/model-v1"]', category: 'unknown' },
    { id: '["opaque/manual-model"]', category: 'unknown' }
  ] }));
  const upstreamServer = await listen(upstream);
  const upstreamUrl = `http://127.0.0.1:${upstreamServer.address().port}/v1`;

  let provider = {
    id: 'apimart-stage5-fixture',
    name: '阶段 5 本地假中转站',
    base_url: upstreamUrl,
    protocol: 'apimart',
    image_request_mode: 'openai',
    enabled: true,
    primary: true,
    api_key: 'fixture-only',
    image_models: ['gpt-image-2'],
    // 历史错误：视频模型曾被放进 LLM；拉取官方分类后应自动纠正。
    chat_models: ['deepseek-v4-pro', 'seedance-2.5'],
    video_models: [],
    audio_models: ['mureka-v8'],
    unknown_models: ['future/model-v1', 'opaque/manual-model'],
    model_names: {},
    model_protocols: {},
    model_category_overrides: {}
  };

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.get('/api/canvas/providers', (_req, res) => res.json({
    success: true,
    primaryProviderId: provider.id,
    providers: [publicProvider(provider)]
  }));
  app.put('/api/canvas/providers', (req, res) => {
    const saved = Array.isArray(req.body?.providers) ? req.body.providers[0] : null;
    if (!saved || saved.id !== provider.id) return res.status(400).json({ success: false, error: '验收 Provider 无效' });
    provider = { ...provider, ...saved, api_key: 'fixture-only' };
    res.json({ success: true, primaryProviderId: provider.id, providers: [publicProvider(provider)] });
  });
  app.get('/__fixture/state', (_req, res) => res.json(publicProvider(provider)));
  app.get('/__fixture/theme/:theme', (req, res) => {
    const theme = req.params.theme === 'dark' ? 'dark' : 'light';
    res.type('html').send(`<!doctype html><meta charset="utf-8"><style>html,body,iframe{width:100%;height:100%;margin:0;border:0;display:block}</style><iframe id="app" src="/canvas-api-settings.html"></iframe><script>app.addEventListener('load',()=>app.contentWindow.postMessage({type:'studio-theme',theme:'${theme}'},'*'));</script>`);
  });
  app.use(canvasRoutes({
    outputRoot: path.resolve(__dirname, '.stage5-output-unused'),
    canvasConfig: { primaryProviderId: provider.id, providers: [provider] }
  }));
  app.use(express.static(frontendRoot, { etag: false, lastModified: false }));

  const appServer = await listen(app);
  const close = async () => {
    await Promise.all([
      new Promise(resolve => appServer.close(resolve)),
      new Promise(resolve => upstreamServer.close(resolve))
    ]);
  };
  process.once('SIGINT', () => close().finally(() => process.exit(0)));
  process.once('SIGTERM', () => close().finally(() => process.exit(0)));
  console.log(`STAGE5_URL=http://127.0.0.1:${appServer.address().port}/canvas-api-settings.html`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
