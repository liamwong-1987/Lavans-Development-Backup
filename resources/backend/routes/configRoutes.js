// configRoutes.js — 配置与页面路由
const path = require('path');
const fs = require('fs');
const { getModuleConfig } = require('../moduleConfigService');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const DEFAULT_PROMPT_PROFILES = [
  { id: 'bedding', name: '床品', prompt: '只改图1的床品颜色为图2的床品颜色，禁止修改图中任何文字（内容、字体、颜色一概不动）。必须保持原摄影光照、阴影、布料纹理与细节完全不变，不新增任何元素，不改变结构。8K，超真实感，细节丰富。', builtIn: true },
  { id: 'clothing', name: '衣服', prompt: '在不改变原始构图、光照、材质结构与细节的前提下，将参考图1中的衣服颜色精准映射为参考图2的衣服颜色风格，使其呈现一致的综合色调与真实摄影级换色效果。要求只改变衣服的底色，衣服上的图案与文字，以及衣服细节如领口、袖子、版型、材质等必须保持一致。', builtIn: true }
];
function normalizePromptProfiles(cfg) {
  const saved = Array.isArray(cfg.promptProfiles) ? cfg.promptProfiles : [];
  const byId = new Map(saved.map(item => [String(item.id || ''), item]));
  const builtIns = DEFAULT_PROMPT_PROFILES.map(item => {
    const savedItem = byId.get(item.id);
    return savedItem && String(savedItem.prompt || '').trim() ? { ...item, prompt: String(savedItem.prompt).trim() } : item;
  });
  const custom = saved.filter(item => item && item.id && !DEFAULT_PROMPT_PROFILES.some(def => def.id === item.id))
    .map(item => ({ id: String(item.id).slice(0, 80), name: String(item.name || '').trim().slice(0, 40), prompt: String(item.prompt || '').trim().slice(0, 4000), builtIn: false }))
    .filter(item => item.name && item.prompt);
  return [...builtIns, ...custom];
}

// 读取持久化配置
function readConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {}
  return {};
}

// 写入持久化配置
function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

// 隐藏 API Key 中间部分
function maskKey(key) {
  if (!key || key.length < 8) return key || '';
  return key.slice(0, 3) + '***' + key.slice(-4);
}

// 画布 Provider 列表（脱敏），对齐源端 canvas.js 期望的 /api/config.api_providers 结构
function canvasPublicApiProviders() {
  try {
    const cfg = getModuleConfig('canvas');
    return (cfg.providers || []).map(p => ({
      id: p.id,
      name: p.name || p.id,
      protocol: p.protocol || 'openai',
      base_url: p.base_url || '',
      enabled: p.enabled !== false,
      image_models: Array.isArray(p.image_models) ? p.image_models : [],
      chat_models: Array.isArray(p.chat_models) ? p.chat_models : [],
      video_models: Array.isArray(p.video_models) ? p.video_models : [],
      video_model_durations: (p.video_model_durations && typeof p.video_model_durations === 'object') ? p.video_model_durations : {},
      video_model_resolutions: (p.video_model_resolutions && typeof p.video_model_resolutions === 'object') ? p.video_model_resolutions : {},
      has_key: Boolean(p.api_key),
      key_preview: maskKey(p.api_key || '')
    }));
  } catch (e) {
    return [];
  }
}

const ALLOWED_IMAGE_MODELS = [
  'gpt-image-2',
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image'
];

function normalizeImageModel(model) {
  const value = String(model || '').trim();
  return ALLOWED_IMAGE_MODELS.includes(value) ? value : null;
}

module.exports = function(deps) {
  const express = require('express');
  const router = express.Router();

  // 首页
  router.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
  });

  // 获取配置
  router.get('/api/config', (req, res) => {
    const cfg = readConfig();
    const promptProfiles = normalizePromptProfiles(cfg);
    const selectedPromptProfileId = promptProfiles.some(item => item.id === cfg.selectedPromptProfileId) ? cfg.selectedPromptProfileId : 'bedding';
    const theme = cfg.theme === 'light' ? 'light' : 'dark';
    res.json({
      success: true,
      api_providers: canvasPublicApiProviders(),
      config: {
        hasKey: Boolean(process.env.API_KEY),
        apiKeyMasked: maskKey(process.env.API_KEY || ''),
        baseUrl: process.env.BASE_URL || 'https://yunwu.ai/v1',
        // 持久化存储的值
        storedBaseUrl: cfg.baseUrl || '',
        storedKeyMasked: maskKey(cfg.apiKey || ''),
        imageModel: cfg.imageModel || process.env.IMAGE_MODEL || 'gpt-image-2',
        imageModelOptions: ALLOWED_IMAGE_MODELS,
        visionModel: process.env.VISION_MODEL || 'gpt-4o',
        imageSize: process.env.IMAGE_SIZE || '1024x1024',
        maxConcurrency: deps.MAX_CONCURRENCY,
        costPerCallFen: deps.API_COST_FEN,
        visionCostFen: deps.VISION_COST_FEN,
        costCurrency: 'CNY',
        costType: 'estimated',
        promptProfiles,
        selectedPromptProfileId,
        theme,
        restartRequired: false
      }
    });
  });

  // 更新配置
  router.post('/api/config', (req, res) => {
    const { apiKey, baseUrl, imageModel, promptProfiles, selectedPromptProfileId, theme } = req.body;
    const cfg = readConfig();

    // 校验 baseUrl
    if (baseUrl !== undefined && baseUrl !== null) {
      const trimmed = String(baseUrl).trim();
      if (trimmed && !/^https?:\/\/.+/.test(trimmed)) {
        return res.status(400).json({ success: false, error: 'URL 格式无效，需以 http:// 或 https:// 开头' });
      }
      cfg.baseUrl = trimmed;
    }

    // 校验 apiKey。前端显示的是脱敏值（如 sk-***abcd），不能回写覆盖真实 Key。
    if (apiKey !== undefined && apiKey !== null) {
      const trimmed = String(apiKey).trim();
      const isMaskedPlaceholder = /\*{3,}/.test(trimmed);
      if (!isMaskedPlaceholder) {
        if (trimmed && trimmed.length < 10) {
          return res.status(400).json({ success: false, error: 'API Key 格式无效（最少 10 个字符）' });
        }
        // 空值代表未修改 Key，不清空已有有效 Key；只有真实输入的新 Key 才替换。
        if (trimmed) cfg.apiKey = trimmed;
      }
    }

    if (promptProfiles !== undefined) {
      if (!Array.isArray(promptProfiles)) return res.status(400).json({ success: false, error: '提示词类型数据格式无效' });
      if (promptProfiles.length > 50) return res.status(400).json({ success: false, error: '提示词类型最多保存 50 个' });
      cfg.promptProfiles = normalizePromptProfiles({ promptProfiles });
    }
    if (selectedPromptProfileId !== undefined) {
      const profiles = normalizePromptProfiles(cfg);
      const selectedId = String(selectedPromptProfileId || '');
      if (!profiles.some(item => item.id === selectedId)) return res.status(400).json({ success: false, error: '选择的提示词类型不存在' });
      cfg.selectedPromptProfileId = selectedId;
    }

    if (theme !== undefined) {
      if (theme !== 'dark' && theme !== 'light') return res.status(400).json({ success: false, error: '主题类型无效' });
      cfg.theme = theme;
    }

    // 校验生图模型
    if (imageModel !== undefined && imageModel !== null) {
      const normalized = normalizeImageModel(imageModel);
      if (!normalized) {
        return res.status(400).json({ success: false, error: '生图模型无效，请从下拉列表选择' });
      }
      cfg.imageModel = normalized;
      process.env.IMAGE_MODEL = normalized;
    }

    writeConfig(cfg);
    console.log('[CONFIG] Updated: baseUrl=' + (cfg.baseUrl || '(default)') + ', key=' + (cfg.apiKey ? '***' : '(empty)'));

    res.json({
      success: true,
      config: {
        apiKeyMasked: maskKey(cfg.apiKey || ''),
        baseUrl: cfg.baseUrl || 'https://yunwu.ai/v1',
        imageModel: cfg.imageModel || process.env.IMAGE_MODEL || 'gpt-image-2',
        imageModelOptions: ALLOWED_IMAGE_MODELS,
        promptProfiles: normalizePromptProfiles(cfg),
        selectedPromptProfileId: cfg.selectedPromptProfileId || 'bedding',
        theme: cfg.theme === 'light' ? 'light' : 'dark',
        restartRequired: false
      }
    });
  });

  return router;
};
