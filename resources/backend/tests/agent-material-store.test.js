'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAgentMaterialStore, visionModelError } = require('../services/agentMaterialStore');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lanvas-agent-material-'));
  const materialRoot = path.join(root, 'uploads');
  const registryRoot = path.join(root, 'registry');
  fs.mkdirSync(materialRoot, { recursive: true });
  return {
    root,
    materialRoot,
    registryRoot,
    store: createAgentMaterialStore({ materialRoot, registryRoot })
  };
}

test('Skill 资产登记保存摘要和文本预览，重启后仍可安全恢复', () => {
  const state = fixture();
  const storedName = 'agent-fixture-brief.md';
  fs.writeFileSync(path.join(state.materialRoot, storedName), '# 产品卖点\n德式小麦啤酒，麦香明显。', 'utf8');

  const material = state.store.register({
    id: 'material_1234567890abcdef',
    storedName,
    originalName: '产品卖点.md',
    name: '产品卖点.md',
    mime: 'text/markdown',
    kind: 'text'
  });

  assert.equal(material.size, fs.statSync(path.join(state.materialRoot, storedName)).size);
  assert.match(material.sha256, /^[a-f0-9]{64}$/);
  assert.match(material.previewText, /麦香明显/);

  const restarted = createAgentMaterialStore({ materialRoot: state.materialRoot, registryRoot: state.registryRoot });
  const resolved = restarted.resolve(material.id);
  assert.equal(resolved.originalName, '产品卖点.md');
  assert.equal(resolved.sha256, material.sha256);
  assert.match(resolved.previewText, /德式小麦啤酒/);
});

test('Markdown 进入文字上下文，图片进入 OpenAI 兼容多模态消息块', () => {
  const state = fixture();
  const textName = 'brief.txt';
  const imageName = 'product.png';
  fs.writeFileSync(path.join(state.materialRoot, textName), '核心卖点：28 天慢酿。', 'utf8');
  fs.writeFileSync(path.join(state.materialRoot, imageName), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  state.store.register({ id: 'material_aaaaaaaaaaaaaaaa', storedName: textName, originalName: '卖点.txt', mime: 'text/plain', kind: 'text' });
  state.store.register({ id: 'material_bbbbbbbbbbbbbbbb', storedName: imageName, originalName: '产品.png', mime: 'image/png', kind: 'image' });

  const content = state.store.messageContent({
    role: 'user',
    content: '请根据资料做广告',
    attachments: [
      { assetId: 'material_aaaaaaaaaaaaaaaa', kind: 'text', name: '卖点.txt' },
      { assetId: 'material_bbbbbbbbbbbbbbbb', kind: 'image', name: '产品.png' }
    ]
  }, {
    provider: { id: 'fixture', protocol: 'openai' },
    model: 'fixture-vision-model',
    visionModelError: () => ''
  });

  assert.ok(Array.isArray(content));
  assert.match(content[0].text, /28 天慢酿/);
  assert.match(content[0].text, /用户上传资料/);
  assert.equal(content[1].type, 'image_url');
  assert.match(content[1].image_url.url, /^data:image\/png;base64,/);
});

test('Provider 可精确声明视觉模型，同名模型不会跨 Provider 误放行', () => {
  const openLux = {
    id: 'openlux',
    protocol: 'openai',
    chat_models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    vision_models: ['deepseek-v4-flash', 'deepseek-v4-pro']
  };
  const apiMart = {
    id: 'apimart',
    protocol: 'apimart',
    chat_models: ['deepseek-v4-flash', 'deepseek-v4-pro']
  };
  const openLuxAfterLegacyProviderSave = {
    id: 'custom-api',
    protocol: 'openai',
    base_url: 'https://api.openlux.ai/v1',
    chat_models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    vision_models: []
  };

  assert.equal(visionModelError(openLux, 'deepseek-v4-flash'), '');
  assert.equal(visionModelError(openLux, 'deepseek-v4-pro'), '');
  assert.equal(visionModelError(openLuxAfterLegacyProviderSave, 'deepseek-v4-flash'), '');
  assert.equal(visionModelError(openLuxAfterLegacyProviderSave, 'deepseek-v4-pro'), '');
  assert.match(visionModelError(apiMart, 'deepseek-v4-flash'), /未确认支持视觉输入/);
  assert.match(visionModelError(apiMart, 'deepseek-v4-pro'), /未确认支持视觉输入/);
  assert.match(visionModelError(openLux, 'unknown-model'), /未配置模型/);
});

test('图片遇到非视觉模型时在 Provider 调用前明确阻断', () => {
  const state = fixture();
  const storedName = 'product.png';
  fs.writeFileSync(path.join(state.materialRoot, storedName), Buffer.from('89504e470d0a1a0a', 'hex'));
  state.store.register({ id: 'material_cccccccccccccccc', storedName, originalName: '产品.png', mime: 'image/png', kind: 'image' });

  assert.throws(() => state.store.messageContent({
    role: 'user',
    content: '看图回答',
    attachments: [{ assetId: 'material_cccccccccccccccc', kind: 'image', name: '产品.png' }]
  }, {
    provider: { id: 'fixture', protocol: 'openai' },
    model: 'fixture-text-model',
    visionModelError: () => '模型 fixture-text-model 未确认支持视觉输入'
  }), error => error?.code === 'AGENT_CHAT_MODEL_VISION_REQUIRED' && /请选择视觉模型/.test(error.message));
});

test('视频只交给精确 APIMART Gemini，分析结果按文件和模型缓存并进入后续上下文', () => {
  const state = fixture();
  const storedName = 'product.mp4';
  fs.writeFileSync(path.join(state.materialRoot, storedName), Buffer.from('00000018667479706d703432', 'hex'));
  state.store.register({
    id: 'material_1212121212121212',
    storedName,
    originalName: '产品演示.mp4',
    mime: 'video/mp4',
    kind: 'video'
  });
  const message = {
    role: 'user',
    content: '请分析这个视频',
    attachments: [{ assetId: 'material_1212121212121212', kind: 'video', name: '产品演示.mp4', mimeType: 'video/mp4' }]
  };
  const context = {
    providerId: 'apimart',
    provider: {
      id: 'apimart',
      protocol: 'apimart',
      base_url: 'https://api.apimart.ai/v1',
      chat_models: ['gemini-3.6-flash']
    },
    model: 'gemini-3.6-flash'
  };

  const pending = state.store.pendingVideoAnalysis(message, context);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].mime, 'video/mp4');
  assert.equal(Buffer.from(pending[0].data, 'base64').length, fs.statSync(path.join(state.materialRoot, storedName)).size);
  state.store.saveVideoAnalysis(pending[0], context, '00:00 展示产品外观；00:03 出现品牌名称。', { totalTokenCount: 42 });
  assert.equal(state.store.pendingVideoAnalysis(message, context).length, 0, '同一文件、Provider 和模型不得重复分析');

  const content = state.store.messageContent(message, context);
  assert.match(content, /Gemini 视频分析/);
  assert.match(content, /展示产品外观/);
  assert.match(content, /Provider: apimart \/ 模型: gemini-3\.6-flash/);

  assert.throws(() => state.store.pendingVideoAnalysis(message, {
    providerId: 'other',
    provider: { id: 'other', protocol: 'openai', base_url: 'https://example.invalid/v1', chat_models: ['gemini-3.6-flash'] },
    model: 'gemini-3.6-flash'
  }), error => error?.code === 'AGENT_CHAT_VIDEO_MODEL_REQUIRED' && /不会切换/.test(error.message));
});

test('旧历史附件未登记时保留文字记录，但当前消息仍严格阻断', () => {
  const state = fixture();
  const message = {
    role: 'user',
    content: '旧消息里曾上传产品资料',
    attachments: [{ assetId: 'material_ffffffffffffffff', kind: 'image', name: '旧产品.png' }]
  };

  const historical = state.store.messageContent(message, { historical: true });
  assert.match(historical, /旧消息里曾上传产品资料/);
  assert.match(historical, /旧产品\.png/);
  assert.match(historical, /历史附件不可用/);

  assert.throws(() => state.store.messageContent(message), error => error?.code === 'AGENT_MATERIAL_NOT_REGISTERED');
});

test('登记文件路径逃逸和登记后内容漂移都会失败关闭', () => {
  const state = fixture();
  const outside = path.join(state.root, 'outside.txt');
  fs.writeFileSync(outside, 'outside', 'utf8');
  assert.throws(() => state.store.register({
    id: 'material_dddddddddddddddd',
    storedName: '..\\outside.txt',
    originalName: 'outside.txt',
    mime: 'text/plain',
    kind: 'text'
  }), error => error?.code === 'AGENT_MATERIAL_PATH_INVALID');

  const storedName = 'safe.md';
  fs.writeFileSync(path.join(state.materialRoot, storedName), '初始内容', 'utf8');
  state.store.register({ id: 'material_eeeeeeeeeeeeeeee', storedName, originalName: 'safe.md', mime: 'text/markdown', kind: 'text' });
  fs.writeFileSync(path.join(state.materialRoot, storedName), '已被修改', 'utf8');
  assert.throws(() => state.store.resolve('material_eeeeeeeeeeeeeeee'), error => error?.code === 'AGENT_MATERIAL_INTEGRITY_MISMATCH');
});
