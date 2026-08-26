const crypto = require('crypto');

const IMAGE_RATIOS = new Set(['16:9', '4:3', '1:1', '3:4', '9:16']);
const VIDEO_RATIOS = new Set(['16:9', '9:16']);
const BUDGET_LIMITS = new Set([10, 30, 50, 100, 200]);
const RETRY_LIMITS = new Set([0, 1, 2]);

function text(value, limit = 300) {
  return String(value == null ? '' : value).trim().slice(0, limit);
}

function uniqueStrings(value, limit = 120) {
  return [...new Set((Array.isArray(value) ? value : []).map(item => text(item, 240)).filter(Boolean))].slice(0, limit);
}

function buildModelCatalog(config = {}) {
  const providers = (Array.isArray(config.providers) ? config.providers : [])
    .filter(provider => provider && provider.enabled !== false)
    .map(provider => ({
      id: text(provider.id, 80),
      name: text(provider.name || provider.id, 120),
      protocol: text(provider.protocol, 80),
      imageModels: uniqueStrings(provider.image_models),
      videoModels: uniqueStrings(provider.video_models),
      chatModels: uniqueStrings(provider.chat_models),
      videoDurations: provider.video_model_durations && typeof provider.video_model_durations === 'object'
        ? Object.fromEntries(Object.entries(provider.video_model_durations).slice(0, 120).map(([model, range]) => [text(model, 240), {
          min: Math.max(1, Number(range?.min) || 1), max: Math.max(1, Number(range?.max) || 60)
        }]))
        : {}
    }))
    .filter(provider => provider.id);
  const primaryProviderId = providers.some(provider => provider.id === config.primaryProviderId)
    ? config.primaryProviderId
    : (providers[0]?.id || '');
  return { primaryProviderId, providers, imageRatios: [...IMAGE_RATIOS], videoRatios: [...VIDEO_RATIOS], budgetLimits: [...BUDGET_LIMITS], retryLimits: [...RETRY_LIMITS] };
}

function providerFor(catalog, providerId, kind) {
  const listKey = kind === 'image' ? 'imageModels' : 'videoModels';
  const providers = catalog.providers.filter(provider => provider[listKey].length);
  return providers.find(provider => provider.id === providerId)
    || providers.find(provider => provider.id === catalog.primaryProviderId)
    || providers[0]
    || null;
}

function normalizeSelection(input = {}, catalog = {}) {
  const imageProvider = providerFor(catalog, text(input.imageProviderId, 80), 'image');
  const videoProvider = providerFor(catalog, text(input.videoProviderId, 80), 'video');
  if (!imageProvider) throw new Error('画布 API 设置中没有可用的图片模型');
  if (!videoProvider) throw new Error('画布 API 设置中没有可用的视频模型');
  const imageModel = imageProvider.imageModels.includes(text(input.imageModel, 240)) ? text(input.imageModel, 240) : imageProvider.imageModels[0];
  const videoModel = videoProvider.videoModels.includes(text(input.videoModel, 240)) ? text(input.videoModel, 240) : videoProvider.videoModels[0];
  const imageRatio = IMAGE_RATIOS.has(text(input.imageRatio, 20)) ? text(input.imageRatio, 20) : '9:16';
  const videoRatio = VIDEO_RATIOS.has(text(input.videoRatio, 20)) ? text(input.videoRatio, 20) : '9:16';
  const imageQuantity = Math.max(1, Math.min(4, Math.round(Number(input.imageQuantity) || 1)));
  const videoQuantity = Math.max(1, Math.min(4, Math.round(Number(input.videoQuantity) || 1)));
  const mode = input.mode === 'auto' ? 'auto' : 'manual';
  const budgetLimit = BUDGET_LIMITS.has(Number(input.budgetLimit)) ? Number(input.budgetLimit) : 30;
  const retryLimit = RETRY_LIMITS.has(Number(input.retryLimit)) ? Number(input.retryLimit) : 1;
  const fallbackEnabled = input.fallbackEnabled === true;
  const fallbackProviderId = fallbackEnabled
    ? text(input.fallbackProviderId, 80)
    : '';
  const fallbackProvider = fallbackEnabled ? catalog.providers.find(provider => provider.id === fallbackProviderId && provider.videoModels.length) : null;
  if (fallbackEnabled && !fallbackProvider) throw new Error('备用站点必须来自已启用且支持视频的画布 API 配置');
  const fallbackModel = fallbackProvider
    ? (fallbackProvider.videoModels.includes(text(input.fallbackModel, 240)) ? text(input.fallbackModel, 240) : fallbackProvider.videoModels[0])
    : '';
  return {
    image: { providerId: imageProvider.id, providerName: imageProvider.name, model: imageModel, ratio: imageRatio, quantity: imageQuantity },
    video: { providerId: videoProvider.id, providerName: videoProvider.name, model: videoModel, ratio: videoRatio, quantity: videoQuantity },
    mode,
    budgetLimit,
    currency: 'CNY',
    retryLimit,
    fallback: fallbackProvider ? { enabled: true, providerId: fallbackProvider.id, providerName: fallbackProvider.name, model: fallbackModel } : { enabled: false, providerId: '', providerName: '', model: '' },
    confirmationPolicy: 'always-before-paid-batch',
    priorityPolicy: 'node-project-skill-global',
    reviewGatePolicy: 'never-cross-human-review-gates'
  };
}

function signature(selection) {
  return crypto.createHash('sha256').update(JSON.stringify(selection)).digest('hex').slice(0, 16);
}

function capabilityPlainText(selection) {
  return [
    '模型能力与站点选择',
    '',
    `图片站点：${selection.image.providerName}`,
    `图片模型：${selection.image.model}`,
    `图片比例：${selection.image.ratio}`,
    `每次图片数量：${selection.image.quantity} 张`,
    '',
    `视频站点：${selection.video.providerName}`,
    `视频模型：${selection.video.model}`,
    `视频比例：${selection.video.ratio}`,
    `每次视频数量：${selection.video.quantity} 条`,
    '',
    '选择优先级：单个节点设置优先，其次是当前项目、当前 Skill，最后才是画布 AGENT 默认设置。',
    '站点和模型分别保存。模型下线或站点不可用时，不会偷偷切换到未批准模型。'
  ].join('\n');
}

function modePlainText(selection) {
  const modeText = selection.mode === 'auto' ? '自动模式' : '手动模式';
  return [
    '执行模式',
    '',
    `当前模式：${modeText}`,
    selection.mode === 'auto'
      ? '自动模式只会在当前已经批准的批次内连续执行，不能越过任何人工审核关。遇到剧本、分镜、旁白、资产、逐镜视频或最终合成的审核关时必须停下。'
      : '手动模式会在每个付费生成批次前停下，等待用户查看模型、数量、预计费用和输入版本后确认。',
    '',
    '无论使用哪种模式，都不能一键跨过关键审核直接成片。',
    '上游内容发生变化时，旧授权立即失效，受影响的下游节点保留但标记为需要复核。'
  ].join('\n');
}

function safetyPlainText(selection) {
  return [
    '费用、备用与重试安全门',
    '',
    `单批预算上限：${selection.budgetLimit} 元`,
    `失败重试上限：${selection.retryLimit} 次`,
    selection.fallback.enabled
      ? `备用视频站点：${selection.fallback.providerName}，备用模型：${selection.fallback.model}`
      : '备用模型：关闭，不会自动切换站点或模型',
    '',
    '每次付费批次必须绑定已经锁定的输入版本、站点、模型、数量、预计费用、预算和重试上限。',
    '预计费用超过预算时直接阻止执行。备用模型价格更高、能力不兼容或比例不支持时，必须重新提交确认。',
    '本阶段只保存策略和授权边界，没有调用图片或视频生成接口，也没有产生媒体费用。'
  ].join('\n');
}

module.exports = { buildModelCatalog, normalizeSelection, signature, capabilityPlainText, modePlainText, safetyPlainText };
