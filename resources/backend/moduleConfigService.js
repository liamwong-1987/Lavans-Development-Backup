const fs = require('fs');
const path = require('path');

const CONFIG_ROOT = path.resolve(__dirname);
const LEGACY_CONFIG_PATH = path.join(CONFIG_ROOT, 'config.json');
const MODULE_CONFIGS = {
  creative: path.join(CONFIG_ROOT, 'creative-config.json'),
  canvas: path.join(CONFIG_ROOT, 'canvas-config.json')
};
const ALLOWED_IMAGE_MODELS = [
  'gpt-image-2',
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image'
];
const CANVAS_PROTOCOLS = new Set(['openai', 'apimart', 'gemini', 'volcengine', 'runninghub', 'comfyui', 'modelscope', 'jimeng', 'codex', 'gemini-cli', 'midjourney', 'ltx-director', 'minimax', 'custom']);

function readJson(filePath, fallback = {}) {
  try {
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : fallback;
  } catch (_error) {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function trim(value, limit = 4000) {
  return String(value || '').trim().slice(0, limit);
}

function normalizeUrl(value, fieldName = 'URL') {
  const url = trim(value, 1000).replace(/\/$/, '');
  if (url && !/^https?:\/\/.+/i.test(url)) throw new Error(`${fieldName} 格式无效，需以 http:// 或 https:// 开头`);
  return url;
}

function normalizeModelId(value) {
  let candidate = value;
  if (Array.isArray(candidate)) {
    if (candidate.length !== 1 || typeof candidate[0] !== 'string') return '';
    candidate = candidate[0];
  }
  let id = trim(candidate, 200);
  if (!id) return '';
  if ((id.startsWith('[') && id.endsWith(']')) || (id.startsWith('"') && id.endsWith('"'))) {
    try {
      const parsed = JSON.parse(id);
      if (typeof parsed === 'string') id = trim(parsed, 200);
      else if (Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0] === 'string') id = trim(parsed[0], 200);
      else if (Array.isArray(parsed)) return '';
    } catch (_error) {}
  }
  return id;
}

function normalizeStringList(value, limit = 120) {
  let list = Array.isArray(value) ? value : null;
  if (!list) {
    const text = String(value || '').trim();
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) list = parsed;
      } catch (_error) {}
    }
    if (!list) list = text.split(/[,\n]/);
  }
  return [...new Set(list.map(normalizeModelId).filter(Boolean))].slice(0, limit);
}

function normalizeModelKeyedObject(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = {};
  Object.entries(source).forEach(([key, item]) => {
    const id = normalizeModelId(key);
    if (!id || ['__proto__', 'prototype', 'constructor'].includes(id) || Object.hasOwn(normalized, id)) return;
    normalized[id] = item;
  });
  return normalized;
}

function normalizeModelCategoryOverrides(value) {
  const allowed = new Set(['image', 'chat', 'video', 'audio', 'unknown']);
  return Object.fromEntries(Object.entries(normalizeModelKeyedObject(value)).flatMap(([id, category]) => {
    const normalized = trim(category, 40).toLowerCase().replace(/_models$/, '');
    return allowed.has(normalized) ? [[id, normalized]] : [];
  }));
}

function safeProviderId(value, fallback = 'provider') {
  const id = trim(value, 80).toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
  return id || fallback;
}

function validateModelScopeLoras(value, providerId = 'modelscope') {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`Provider ${providerId} 的 LoRA 列表格式无效`);
  const seen = new Set();
  value.slice(0, 100).forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`Provider ${providerId} 的第 ${index + 1} 个 LoRA 格式无效`);
    const id = trim(raw.id, 180);
    const targetModel = trim(raw.target_model ?? raw.model, 180);
    if (!id) throw new Error(`Provider ${providerId} 的第 ${index + 1} 个 LoRA 缺少 LoRA ID`);
    if (!targetModel) throw new Error(`Provider ${providerId} 的第 ${index + 1} 个 LoRA 缺少目标模型`);
    const strength = Number(raw.strength ?? raw.default_strength ?? 0.8);
    if (!Number.isFinite(strength) || strength < 0 || strength > 2) throw new Error(`Provider ${providerId} 的第 ${index + 1} 个 LoRA 强度必须在 0 到 2 之间`);
    const key = `${targetModel}\u0000${id}`;
    if (seen.has(key)) throw new Error(`Provider ${providerId} 存在重复 LoRA：${id} + ${targetModel}`);
    seen.add(key);
  });
}

function normalizeModelScopeLoras(value) {
  const normalized = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    if (!raw || typeof raw !== 'object') continue;
    const id = trim(raw.id, 180);
    const targetModel = trim(raw.target_model ?? raw.model, 180);
    if (!id || !targetModel) continue;
    const key = `${targetModel}\u0000${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const parsedStrength = Number(raw.strength ?? raw.default_strength ?? 0.8);
    normalized.push({
      id,
      name: trim(raw.name, 80) || id,
      target_model: targetModel,
      strength: Number.isFinite(parsedStrength) ? Math.max(0, Math.min(2, parsedStrength)) : 0.8,
      enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
      note: trim(raw.note, 300)
    });
    if (normalized.length >= 100) break;
  }
  return normalized;
}

function maskSecret(value) {
  const secret = trim(value, 4000);
  return secret && secret.length >= 8 ? `${secret.slice(0, 3)}***${secret.slice(-4)}` : secret;
}

function secretPatch(value, current) {
  if (value === undefined || value === null) return current;
  const next = trim(value, 4000);
  return /\*{3,}/.test(next) ? current : next;
}

function normalizeProvider(raw = {}, index = 0, existing = {}) {
  const id = safeProviderId(raw.id || existing.id, `provider-${index + 1}`);
  const protocolValue = trim(raw.protocol ?? existing.protocol ?? 'openai', 80).toLowerCase();
  const protocol = CANVAS_PROTOCOLS.has(protocolValue) ? protocolValue : 'custom';
  const apiKey = secretPatch(raw.api_key ?? raw.apiKey, existing.api_key || '');
  const runningHubKey = secretPatch(raw.runninghub_key ?? raw.runningHubKey, existing.runninghub_key || '');
  const runningHubWalletKey = secretPatch(raw.runninghub_wallet_key ?? raw.runningHubWalletKey, existing.runninghub_wallet_key || '');
  const modelScopeKey = secretPatch(raw.modelscope_key ?? raw.modelScopeKey, existing.modelscope_key || '');
  const volcengineKey = secretPatch(raw.volcengine_key ?? raw.volcengineKey, existing.volcengine_key || '');
  const volcengineAccessKey = secretPatch(raw.volcengine_access_key ?? raw.volcengineAccessKey, existing.volcengine_access_key || '');
  const volcengineSecretKey = secretPatch(raw.volcengine_secret_key ?? raw.volcengineSecretKey, existing.volcengine_secret_key || '');
  const baseUrlInput = raw.base_url ?? raw.baseUrl ?? existing.base_url ?? '';
  const comfyUrlInput = raw.comfy_url ?? raw.comfyUrl ?? existing.comfy_url ?? '';
  return {
    id,
    name: trim(raw.name ?? raw.providerName ?? existing.name ?? id, 120) || id,
    protocol,
    base_url: normalizeUrl(baseUrlInput, 'Base URL'),
    enabled: raw.enabled === undefined ? existing.enabled !== false : Boolean(raw.enabled),
    primary: Boolean(raw.primary),
    image_request_mode: trim(raw.image_request_mode ?? raw.imageRequestMode ?? existing.image_request_mode ?? 'openai', 80) || 'openai',
    image_generation_endpoint: trim(raw.image_generation_endpoint ?? existing.image_generation_endpoint, 500),
    image_edit_endpoint: trim(raw.image_edit_endpoint ?? existing.image_edit_endpoint, 500),
    image_models: normalizeStringList(raw.image_models ?? raw.imageModels ?? existing.image_models),
    chat_models: normalizeStringList(raw.chat_models ?? raw.chatModels ?? existing.chat_models),
    vision_models: normalizeStringList(raw.vision_models ?? raw.visionModels ?? existing.vision_models),
    video_models: normalizeStringList(raw.video_models ?? raw.videoModels ?? existing.video_models),
    audio_models: normalizeStringList(raw.audio_models ?? raw.audioModels ?? existing.audio_models),
    unknown_models: normalizeStringList(raw.unknown_models ?? raw.unknownModels ?? existing.unknown_models),
    video_model_durations: normalizeModelKeyedObject(raw.video_model_durations ?? existing.video_model_durations),
    video_model_resolutions: normalizeModelKeyedObject(raw.video_model_resolutions ?? existing.video_model_resolutions),
    model_names: normalizeModelKeyedObject(raw.model_names ?? existing.model_names),
    model_protocols: normalizeModelKeyedObject(raw.model_protocols ?? existing.model_protocols),
    model_category_overrides: normalizeModelCategoryOverrides(raw.model_category_overrides ?? raw.modelCategoryOverrides ?? existing.model_category_overrides),
    api_key: apiKey,
    comfy_url: normalizeUrl(comfyUrlInput, 'ComfyUI 地址'),
    runninghub_key: runningHubKey,
    runninghub_wallet_key: runningHubWalletKey,
    modelscope_key: modelScopeKey,
    volcengine_key: volcengineKey,
    volcengine_access_key: volcengineAccessKey,
    volcengine_secret_key: volcengineSecretKey,
    volcengine_project_name: trim(raw.volcengine_project_name ?? raw.volcengineProjectName ?? existing.volcengine_project_name, 160),
    volcengine_region: trim(raw.volcengine_region ?? raw.volcengineRegion ?? existing.volcengine_region, 120),
    ms_loras: normalizeModelScopeLoras(Array.isArray(raw.ms_loras) ? raw.ms_loras : existing.ms_loras),
    rh_apps: Array.isArray(raw.rh_apps) ? raw.rh_apps.slice(0, 100) : (Array.isArray(existing.rh_apps) ? existing.rh_apps : []),
    rh_workflows: Array.isArray(raw.rh_workflows) ? raw.rh_workflows.slice(0, 100) : (Array.isArray(existing.rh_workflows) ? existing.rh_workflows : [])
  };
}

function canvasDefaultProvider() {
  return normalizeProvider({
    id: 'openai',
    name: 'OpenAI Compatible',
    protocol: 'openai',
    enabled: true,
    primary: true,
    image_models: ['gpt-image-2']
  });
}

function normalizeCanvasConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const legacyProvider = source.providers ? null : normalizeProvider({
    id: source.provider || 'openai',
    name: source.providerName || 'OpenAI Compatible',
    protocol: source.provider || 'openai',
    base_url: source.baseUrl || '',
    api_key: source.apiKey || '',
    image_models: source.imageModel ? [source.imageModel] : [],
    chat_models: source.chatModel ? [source.chatModel] : [],
    video_models: source.videoModel ? [source.videoModel] : [],
    comfy_url: source.comfyUrl || '',
    runninghub_key: source.runningHubKey || '',
    modelscope_key: source.modelScopeKey || '',
    volcengine_key: source.volcengineKey || ''
  });
  const rawProviders = Array.isArray(source.providers) && source.providers.length ? source.providers : [legacyProvider];
  const ids = new Set();
  const providers = rawProviders.map((item, index) => {
    const normalized = normalizeProvider(item, index);
    let id = normalized.id;
    let duplicate = 2;
    while (ids.has(id)) id = `${normalized.id}-${duplicate++}`;
    ids.add(id);
    return { ...normalized, id };
  }).filter(provider => provider.id);
  if (!providers.length) providers.push(canvasDefaultProvider());
  const requestedPrimary = safeProviderId(source.primaryProviderId || source.primary_provider_id || '', '');
  const selectedPrimary = providers.find(provider => provider.id === requestedPrimary && provider.enabled !== false)
    || providers.find(provider => provider.primary && provider.enabled !== false)
    || providers.find(provider => provider.enabled !== false)
    || providers[0];
  providers.forEach(provider => { provider.primary = provider.id === selectedPrimary.id; });
  return { version: 2, primaryProviderId: selectedPrimary.id, providers, comfy_instances: Array.isArray(source.comfy_instances) ? source.comfy_instances : [] };
}

function legacyDefaults() {
  const legacy = readJson(LEGACY_CONFIG_PATH);
  return {
    version: 1,
    apiKey: trim(legacy.apiKey || process.env.API_KEY || '', 4000),
    baseUrl: normalizeUrl(legacy.baseUrl || process.env.BASE_URL || 'https://api.openlux.ai/v1', 'Base URL'),
    imageModel: trim(legacy.imageModel || process.env.IMAGE_MODEL || 'gpt-image-2', 200)
  };
}

function normalizeCreativeConfig(input = {}) {
  return {
    version: 1,
    apiKey: trim(input.apiKey, 4000),
    baseUrl: normalizeUrl(input.baseUrl, 'Base URL'),
    imageModel: trim(input.imageModel, 200)
  };
}

function getCreativeConfig() {
  const current = normalizeCreativeConfig(readJson(MODULE_CONFIGS.creative));
  const defaults = legacyDefaults();
  const complete = {
    version: 1,
    apiKey: current.apiKey || defaults.apiKey,
    baseUrl: current.baseUrl || defaults.baseUrl,
    imageModel: current.imageModel || defaults.imageModel
  };
  if (JSON.stringify(current) !== JSON.stringify(complete)) writeJson(MODULE_CONFIGS.creative, complete);
  return complete;
}

function getModuleConfig(moduleName) {
  if (moduleName === 'creative') return getCreativeConfig();
  if (moduleName === 'canvas') {
    const configPath = MODULE_CONFIGS.canvas;
    const current = normalizeCanvasConfig(readJson(configPath));
    const stored = readJson(configPath);
    if (JSON.stringify(stored) !== JSON.stringify(current)) writeJson(configPath, current);
    return current;
  }
  throw new Error('未知模块配置');
}

function updateCreativeConfig(patch = {}) {
  const current = getCreativeConfig();
  const next = { ...current };
  if (patch.baseUrl !== undefined) next.baseUrl = normalizeUrl(patch.baseUrl, 'Base URL') || next.baseUrl;
  if (patch.apiKey !== undefined && !/\*{3,}/.test(String(patch.apiKey || ''))) {
    const key = trim(patch.apiKey, 4000);
    if (key && key.length < 10) throw new Error('API Key 格式无效（最少 10 个字符）');
    if (key) next.apiKey = key;
  }
  if (patch.imageModel !== undefined) {
    const model = trim(patch.imageModel, 200);
    if (!ALLOWED_IMAGE_MODELS.includes(model)) throw new Error('生图模型无效，请从下拉列表选择');
    next.imageModel = model;
  }
  writeJson(MODULE_CONFIGS.creative, next);
  return next;
}

function updateCanvasConfig(patch = {}) {
  const current = getModuleConfig('canvas');
  const existingById = new Map(current.providers.map(provider => [provider.id, provider]));
  const rawProviders = Array.isArray(patch.providers) ? patch.providers : current.providers;
  rawProviders.forEach((provider, index) => validateModelScopeLoras(provider?.ms_loras, safeProviderId(provider?.id, `provider-${index + 1}`)));
  const config = normalizeCanvasConfig({
    version: 2,
    primaryProviderId: patch.primaryProviderId ?? patch.primary_provider_id ?? current.primaryProviderId,
    providers: rawProviders.map((provider, index) => normalizeProvider(provider, index, existingById.get(safeProviderId(provider?.id, '')) || {})),
    comfy_instances: Array.isArray(patch.comfy_instances) ? patch.comfy_instances : (current.comfy_instances || [])
  });
  writeJson(MODULE_CONFIGS.canvas, config);
  return config;
}

function updateModuleConfig(moduleName, patch = {}) {
  if (moduleName === 'creative') return updateCreativeConfig(patch);
  if (moduleName === 'canvas') return updateCanvasConfig(patch);
  throw new Error('未知模块配置');
}

function publicProvider(provider) {
  return {
    ...provider,
    api_key: undefined,
    runninghub_key: undefined,
    runninghub_wallet_key: undefined,
    modelscope_key: undefined,
    volcengine_key: undefined,
    volcengine_access_key: undefined,
    volcengine_secret_key: undefined,
    has_api_key: Boolean(provider.api_key),
    api_key_masked: maskSecret(provider.api_key),
    has_runninghub_key: Boolean(provider.runninghub_key),
    has_runninghub_wallet_key: Boolean(provider.runninghub_wallet_key),
    has_modelscope_key: Boolean(provider.modelscope_key),
    has_volcengine_key: Boolean(provider.volcengine_key),
    has_volcengine_asset_keys: Boolean(provider.volcengine_access_key && provider.volcengine_secret_key)
  };
}

function publicConfig(config) {
  if (config?.version === 2 && Array.isArray(config.providers)) {
    const primary = config.providers.find(provider => provider.id === config.primaryProviderId) || config.providers[0] || canvasDefaultProvider();
    return {
      version: 2,
      primaryProviderId: primary.id,
      api_providers: config.providers.map(publicProvider),
      providers: config.providers.map(publicProvider),
      provider: primary.id,
      providerName: primary.name,
      baseUrl: primary.base_url,
      imageModel: primary.image_models[0] || '',
      imageModelOptions: primary.image_models,
      videoModel: primary.video_models[0] || '',
      chatModel: primary.chat_models[0] || ''
    };
  }
  const apiKey = trim(config?.apiKey, 4000);
  return {
    hasKey: Boolean(apiKey),
    apiKeyMasked: maskSecret(apiKey),
    baseUrl: config?.baseUrl || 'https://api.openlux.ai/v1',
    imageModel: config?.imageModel || 'gpt-image-2',
    imageModelOptions: ALLOWED_IMAGE_MODELS
  };
}

const exported = {
  ALLOWED_IMAGE_MODELS,
  CANVAS_PROTOCOLS: [...CANVAS_PROTOCOLS],
  getModuleConfig,
  updateModuleConfig,
  publicConfig,
  normalizeModelId
};

Object.defineProperty(exported, '__testHooks', {
  value: Object.freeze({ normalizeCanvasConfig }),
  enumerable: false
});

module.exports = exported;
