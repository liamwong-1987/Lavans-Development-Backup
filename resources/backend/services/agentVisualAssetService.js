const crypto = require('crypto');

const ASSET_TYPES = new Set(['character', 'product', 'scene', 'prop', 'logo']);
const TYPE_LABELS = { character: '角色', product: '产品', scene: '场景', prop: '道具', logo: 'Logo' };

function text(value, limit = 600) {
  return String(value == null ? '' : value).trim().slice(0, limit);
}

function safeAsset(raw = {}, index = 0) {
  const type = ASSET_TYPES.has(text(raw.type, 40)) ? text(raw.type, 40) : 'prop';
  const sourceMaterialIds = [...new Set((Array.isArray(raw.sourceMaterialIds) ? raw.sourceMaterialIds : []).map(item => text(item, 120)).filter(Boolean))];
  const anchorFacts = (Array.isArray(raw.anchorFacts) ? raw.anchorFacts : []).map(item => text(item, 500)).filter(Boolean).slice(0, 20);
  const immutableConstraints = (Array.isArray(raw.immutableConstraints) ? raw.immutableConstraints : []).map(item => text(item, 500)).filter(Boolean).slice(0, 20);
  return {
    id: text(raw.id, 120) || `asset-${index + 1}`,
    type,
    typeLabel: TYPE_LABELS[type],
    name: text(raw.name, 240) || `${TYPE_LABELS[type]} ${index + 1}`,
    usage: text(raw.usage, 1000),
    sourceMaterialIds,
    anchorFacts,
    immutableConstraints
  };
}

function buildVisualAssetPlan(run, strategy, inputVersionIds = []) {
  const assets = (Array.isArray(run?.storyboardPlan?.assets) ? run.storyboardPlan.assets : []).map(safeAsset);
  if (!assets.length) throw new Error('阶段四资产台账为空，不能进入视觉资产生产');
  const materials = new Map((Array.isArray(run?.materials) ? run.materials : []).map(item => [String(item.id || ''), item]));
  const tasks = assets.map((asset, index) => {
    const references = asset.sourceMaterialIds.map(id => materials.get(id)).filter(Boolean).map(item => ({
      id: text(item.id, 120), name: text(item.name || item.originalName, 240), kind: text(item.kind, 40), url: text(item.url, 800)
    }));
    if (asset.type === 'product' && !references.some(item => item.kind === 'image')) {
      const productImages = [...materials.values()].filter(item => item.kind === 'image').map(item => ({ id: text(item.id, 120), name: text(item.name || item.originalName, 240), kind: 'image', url: text(item.url, 800) }));
      references.push(...productImages);
    }
    const productGuard = asset.type === 'product'
      ? '必须以产品实拍图为保真参考。包装、Logo、文字、结构和颜色不得凭空改写。'
      : '保持与已锁定资产锚点一致，不得引入台账以外的新事实。';
    return {
      id: `visual-task-${index + 1}-${asset.id}`,
      assetId: asset.id,
      assetType: asset.type,
      assetTypeLabel: asset.typeLabel,
      assetName: asset.name,
      references,
      prompt: [
        `生成${asset.typeLabel}资产：${asset.name}。`,
        asset.usage ? `用途：${asset.usage}。` : '',
        asset.anchorFacts.length ? `事实锚点：${asset.anchorFacts.join('；')}。` : '',
        asset.immutableConstraints.length ? `不可变化约束：${asset.immutableConstraints.join('；')}。` : '',
        productGuard,
        `输出比例：${strategy.image.ratio}。用于后续分镜制作的清晰单体视觉资产。`
      ].filter(Boolean).join('\n'),
      providerId: strategy.image.providerId,
      providerName: strategy.image.providerName,
      model: strategy.image.model,
      ratio: strategy.image.ratio,
      quantity: strategy.image.quantity,
      status: 'pending'
    };
  });
  const missingProductReferences = tasks.filter(item => item.assetType === 'product' && !item.references.some(ref => ref.kind === 'image')).map(item => item.assetName);
  return {
    schemaVersion: 1,
    planId: `visual-plan-${crypto.createHash('sha256').update(JSON.stringify({ runId: run.id, tasks, strategy, inputVersionIds })).digest('hex').slice(0, 16)}`,
    runId: run.id,
    canvasId: run.canvasId,
    inputVersionIds: [...new Set(inputVersionIds.map(String))].sort(),
    strategy,
    tasks,
    totalAssets: tasks.length,
    totalImages: tasks.reduce((sum, item) => sum + item.quantity, 0),
    maximumAuthorizedCost: strategy.budgetLimit,
    currency: strategy.currency || 'CNY',
    blockedReason: missingProductReferences.length ? `以下产品资产缺少实拍图片：${missingProductReferences.join('、')}` : ''
  };
}

function planPlainText(plan) {
  const lines = [
    '阶段六视觉资产生成批次', '',
    `图片站点：${plan.strategy.image.providerName}`,
    `图片模型：${plan.strategy.image.model}`,
    `输出比例：${plan.strategy.image.ratio}`,
    `每项候选数量：${plan.strategy.image.quantity} 张`,
    `资产数量：${plan.totalAssets} 项`,
    `计划生成：${plan.totalImages} 张`,
    `本批最高授权金额：${plan.maximumAuthorizedCost} 元`,
    `失败重试上限：${plan.strategy.retryLimit} 次`,
    `执行模式：${plan.strategy.mode === 'auto' ? '自动模式，仅限本批且不能跨越审核关' : '手动模式，每个付费批次先确认'}`,
    '', '资产任务：'
  ];
  plan.tasks.forEach((task, index) => {
    lines.push(`${index + 1}. ${task.assetTypeLabel}，${task.assetName}`);
    lines.push(`参考资料：${task.references.length ? task.references.map(item => item.name).join('、') : '没有上传参考图'}`);
    lines.push(`状态：等待授权`);
  });
  if (plan.blockedReason) lines.push('', `当前阻塞：${plan.blockedReason}`);
  lines.push('', '正式执行会逐项建立可见任务节点。排队、运行、失败、中断和成功都会保留，不会静默切换模型。');
  return lines.join('\n');
}

function candidatePlainText(candidate) {
  return [
    `${candidate.assetTypeLabel}资产候选版本`, '',
    `资产名称：${candidate.assetName}`,
    `版本编号：${candidate.candidateNumber}`,
    `生成状态：${candidate.testSubstitute ? '无费用测试替身，不是模型生成结果' : '真实画布图片任务已完成'}`,
    `图片站点：${candidate.providerName || candidate.providerId}`,
    `图片模型：${candidate.model}`,
    `输出比例：${candidate.ratio}`,
    candidate.assetType === 'product' ? '产品保真：已绑定产品实拍图作为参考，禁止改写包装、Logo、文字、结构和颜色。' : '一致性要求：服从已锁定资产锚点和不可变化约束。'
  ].join('\n');
}

function packagePlainText(groups) {
  return [
    '阶段六视觉资产版本包', '',
    ...groups.map((group, index) => `${index + 1}. ${group.assetTypeLabel}，${group.assetName}，请选择 1 个候选版本`),
    '', '请逐项单选。最后只提交一次，统一批准并锁定全部选中版本和本资产包。',
    '锁定完成后阶段六停止，不会自动进入分镜图、故事板或视频生成。'
  ].join('\n');
}

module.exports = { ASSET_TYPES, TYPE_LABELS, buildVisualAssetPlan, candidatePlainText, packagePlainText, planPlainText };
