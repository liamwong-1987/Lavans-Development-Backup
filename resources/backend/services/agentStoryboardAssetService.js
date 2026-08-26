function safeText(value, limit = 12000) {
  return String(value == null ? '' : value).trim().slice(0, limit);
}

function safeId(value, fallback = '') {
  return String(value || fallback).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
}

function stripFence(value) {
  return String(value == null ? '' : value).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function parseObject(value, label) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try { return JSON.parse(stripFence(value)); }
  catch (_error) { throw new Error(`${label}没有返回可识别的内容`); }
}

function stringList(value, limit = 20, itemLimit = 1200) {
  return [...new Set((Array.isArray(value) ? value : []).map(item => safeText(item, itemLimit)).filter(Boolean))].slice(0, limit);
}

function normalizeRequiredAsset(item) {
  const type = safeId(item?.type, '');
  const name = safeText(item?.name, 160);
  if (!['character', 'product', 'scene', 'prop', 'logo'].includes(type) || !name) return null;
  return { type, name };
}

function parseShotPlan(value, expectedDurationSeconds) {
  const source = parseObject(value, '结构化分镜');
  const list = source.shots;
  if (!Array.isArray(list) || list.length < 2 || list.length > 60) throw new Error('结构化分镜必须包含 2 到 60 个镜头');
  const ids = new Set();
  let totalDurationSeconds = 0;
  const shots = list.map((item, index) => {
    const id = safeId(item?.id, `shot-${String(index + 1).padStart(3, '0')}`);
    const order = Math.floor(Number(item?.order) || index + 1);
    const durationSeconds = Number(item?.durationSeconds);
    if (ids.has(id)) throw new Error('镜头编号不能重复');
    if (order !== index + 1) throw new Error('镜头顺序必须从 1 连续排列');
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 30) throw new Error(`镜头 ${id} 的时长无效`);
    ids.add(id);
    totalDurationSeconds += durationSeconds;
    const shot = {
      id,
      order,
      timeRange: safeText(item?.timeRange, 80),
      durationSeconds,
      scene: safeText(item?.scene, 300),
      framing: safeText(item?.framing, 200),
      cameraMovement: safeText(item?.cameraMovement, 300),
      visual: safeText(item?.visual, 1800),
      action: safeText(item?.action, 1800),
      dialogue: safeText(item?.dialogue, 1600),
      narration: safeText(item?.narration, 1600),
      subtitle: safeText(item?.subtitle, 800),
      sound: safeText(item?.sound, 800),
      transition: safeText(item?.transition, 400),
      firstFrame: safeText(item?.firstFrame, 1200),
      lastFrame: safeText(item?.lastFrame, 1200),
      requiredAssets: (Array.isArray(item?.requiredAssets) ? item.requiredAssets : []).map(normalizeRequiredAsset).filter(Boolean).slice(0, 30),
      immutableConstraints: stringList(item?.immutableConstraints, 20, 800)
    };
    if (!shot.scene || !shot.framing || !shot.visual || !shot.action || !shot.firstFrame || !shot.lastFrame) throw new Error(`镜头 ${id} 缺少场景、景别、画面、动作或首尾帧`);
    if (!shot.requiredAssets.length) throw new Error(`镜头 ${id} 没有登记所需资产`);
    return shot;
  });
  const expected = Number(expectedDurationSeconds);
  if (Number.isFinite(expected) && expected > 0 && Math.abs(totalDurationSeconds - expected) > 0.05) {
    throw new Error(`分镜总时长 ${totalDurationSeconds} 秒与锁定项目时长 ${expected} 秒不一致`);
  }
  return { shots, totalDurationSeconds };
}

function shotPlanPlainText(plan) {
  const lines = [`结构化分镜脚本`, `共 ${plan.shots.length} 个镜头，总时长 ${plan.totalDurationSeconds} 秒。`, ''];
  plan.shots.forEach(shot => {
    lines.push(`镜头 ${shot.order}，${shot.timeRange || `${shot.durationSeconds} 秒`}，时长 ${shot.durationSeconds} 秒`);
    lines.push(`场景：${shot.scene}`);
    lines.push(`景别与镜头：${shot.framing}；${shot.cameraMovement || '固定镜头'}`);
    lines.push(`画面：${shot.visual}`);
    lines.push(`动作：${shot.action}`);
    if (shot.dialogue) lines.push(`对白：${shot.dialogue}`);
    if (shot.narration) lines.push(`旁白：${shot.narration}`);
    if (shot.subtitle) lines.push(`字幕：${shot.subtitle}`);
    if (shot.sound) lines.push(`声音：${shot.sound}`);
    if (shot.transition) lines.push(`转场：${shot.transition}`);
    lines.push(`首帧：${shot.firstFrame}`);
    lines.push(`尾帧：${shot.lastFrame}`);
    lines.push(`所需资产：${shot.requiredAssets.map(asset => `${asset.name}（${assetTypeLabel(asset.type)}）`).join('、')}`);
    if (shot.immutableConstraints.length) lines.push(`不可变化：${shot.immutableConstraints.join('；')}`);
    lines.push('');
  });
  return lines.join('\n').trim();
}

function assetTypeLabel(type) {
  return ({ character: '角色', product: '产品', scene: '场景', prop: '道具', logo: 'Logo' })[type] || type;
}

function parseAssetLedger(value, shotPlan, allowedMaterialIds = null) {
  const source = parseObject(value, '资产台账');
  if (!Array.isArray(source.assets) || !source.assets.length || source.assets.length > 200) throw new Error('资产台账没有有效资产');
  const shotIds = new Set(shotPlan.shots.map(shot => shot.id));
  const assetIds = new Set();
  const allowedMaterials = Array.isArray(allowedMaterialIds) ? new Set(allowedMaterialIds.map(value => safeId(value, '')).filter(Boolean)) : null;
  const assets = source.assets.map((item, index) => {
    const id = safeId(item?.id, `asset-${String(index + 1).padStart(3, '0')}`);
    const type = safeId(item?.type, '');
    const name = safeText(item?.name, 160);
    if (assetIds.has(id)) throw new Error('资产编号不能重复');
    if (!['character', 'product', 'scene', 'prop', 'logo'].includes(type)) throw new Error(`资产 ${id} 的类型无效`);
    if (!name) throw new Error(`资产 ${id} 缺少名称`);
    assetIds.add(id);
    const sourceMaterialIds = stringList(item?.sourceMaterialIds, 40, 160).map(value => safeId(value, '')).filter(Boolean);
    if (allowedMaterials) sourceMaterialIds.forEach(materialId => { if (!allowedMaterials.has(materialId)) throw new Error(`资产 ${id} 引用了不存在的上传资料 ${materialId}`); });
    return {
      id, type, name,
      usage: safeText(item?.usage, 1600),
      sourceMaterialIds,
      anchorFacts: stringList(item?.anchorFacts, 30, 1000),
      immutableConstraints: stringList(item?.immutableConstraints, 30, 1000)
    };
  });
  const assignments = (Array.isArray(source.shotAssignments) ? source.shotAssignments : []).map(item => ({
    shotId: safeId(item?.shotId, ''),
    assetIds: [...new Set((Array.isArray(item?.assetIds) ? item.assetIds : []).map(value => safeId(value, '')).filter(Boolean))]
  }));
  const assignmentIds = new Set();
  assignments.forEach(item => {
    if (!shotIds.has(item.shotId)) throw new Error(`资产台账引用了不存在的镜头 ${item.shotId}`);
    if (assignmentIds.has(item.shotId)) throw new Error(`镜头 ${item.shotId} 的资产引用重复`);
    if (!item.assetIds.length) throw new Error(`镜头 ${item.shotId} 没有关联资产`);
    item.assetIds.forEach(id => { if (!assetIds.has(id)) throw new Error(`镜头 ${item.shotId} 引用了不存在的资产 ${id}`); });
    assignmentIds.add(item.shotId);
  });
  shotIds.forEach(id => { if (!assignmentIds.has(id)) throw new Error(`镜头 ${id} 没有资产引用`); });
  return { assets, shotAssignments: assignments };
}

function assetLedgerPlainText(ledger, materialNames = {}) {
  const groups = ['character', 'product', 'scene', 'prop', 'logo'];
  const lines = ['资产锚点台账', `共 ${ledger.assets.length} 项资产，已关联 ${ledger.shotAssignments.length} 个镜头。`, ''];
  groups.forEach(type => {
    const items = ledger.assets.filter(asset => asset.type === type);
    if (!items.length) return;
    lines.push(`${assetTypeLabel(type)}资产`);
    items.forEach((asset, index) => {
      lines.push(`${index + 1}。${asset.name}`);
      if (asset.usage) lines.push(`用途：${asset.usage}`);
      const readableMaterials = asset.sourceMaterialIds.map(id => safeText(materialNames[id], 240) || id);
      lines.push(`参考资料：${readableMaterials.length ? readableMaterials.join('、') : '无指定上传资料，后续生成前必须确认'}`);
      lines.push(`锚点事实：${asset.anchorFacts.length ? asset.anchorFacts.join('；') : '暂无可扩写事实'}`);
      lines.push(`不可变化：${asset.immutableConstraints.length ? asset.immutableConstraints.join('；') : '遵守已锁定产品事实与剧本'}`);
    });
    lines.push('');
  });
  lines.push('逐镜引用');
  ledger.shotAssignments.forEach(item => lines.push(`${item.shotId}：${item.assetIds.join('、')}`));
  return lines.join('\n').trim();
}

function validateCoverage(shotPlan, ledger) {
  const assetsById = new Map(ledger.assets.map(asset => [asset.id, asset]));
  const assignmentsByShot = new Map(ledger.shotAssignments.map(item => [item.shotId, item.assetIds]));
  const issues = [];
  const rows = shotPlan.shots.map(shot => {
    const assigned = (assignmentsByShot.get(shot.id) || []).map(id => assetsById.get(id)).filter(Boolean);
    const missing = shot.requiredAssets.filter(required => !assigned.some(asset => asset.type === required.type && asset.name.trim().toLowerCase() === required.name.trim().toLowerCase()));
    if (missing.length) issues.push(`${shot.id} 缺少：${missing.map(item => `${item.name}（${assetTypeLabel(item.type)}）`).join('、')}`);
    return { shotId: shot.id, requiredCount: shot.requiredAssets.length, assignedCount: assigned.length, missing };
  });
  const productAssets = ledger.assets.filter(asset => asset.type === 'product');
  if (!productAssets.length) issues.push('资产台账缺少产品资产');
  productAssets.forEach(asset => {
    if (!asset.anchorFacts.length) issues.push(`产品资产“${asset.name}”缺少事实锚点`);
    if (!asset.immutableConstraints.length) issues.push(`产品资产“${asset.name}”缺少不可变化约束`);
  });
  return { valid: issues.length === 0, shotCount: shotPlan.shots.length, assetCount: ledger.assets.length, coveredShotCount: rows.filter(row => !row.missing.length).length, issues, rows };
}

function coveragePlainText(report) {
  const lines = ['分镜与资产覆盖校验', `校验结果：${report.valid ? '通过' : '未通过'}`, `镜头：${report.shotCount} 个`, `资产：${report.assetCount} 项`, `完整覆盖：${report.coveredShotCount} 个镜头`, ''];
  if (report.issues.length) {
    lines.push('需要修复的问题');
    report.issues.forEach((issue, index) => lines.push(`${index + 1}。${issue}`));
  } else {
    lines.push('所有镜头均已关联所需角色、产品、场景、道具和 Logo。');
    lines.push('产品资产已登记事实锚点和不可变化约束。');
    lines.push('本阶段只完成制作规划，没有生成图片或视频，也没有产生付费调用。');
  }
  return lines.join('\n');
}

module.exports = { parseShotPlan, shotPlanPlainText, parseAssetLedger, assetLedgerPlainText, validateCoverage, coveragePlainText, assetTypeLabel };
