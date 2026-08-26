const crypto = require('crypto');

function text(value, limit = 1200) {
  return String(value == null ? '' : value).trim().slice(0, limit);
}

function list(value, limit = 80) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[\s,，、;；]+/);
  return [...new Set(source.map(item => text(item, 160)).filter(Boolean))].slice(0, limit);
}

function safeShot(raw = {}, index = 0) {
  return {
    id: text(raw.id, 120) || `shot-${String(index + 1).padStart(3, '0')}`,
    order: Math.max(1, Number(raw.order) || index + 1),
    timeRange: text(raw.timeRange, 120),
    durationSeconds: Math.max(0.1, Number(raw.durationSeconds) || 1),
    scene: text(raw.scene, 300),
    framing: text(raw.framing, 300),
    cameraMovement: text(raw.cameraMovement, 300),
    visual: text(raw.visual, 1200),
    action: text(raw.action, 1000),
    transition: text(raw.transition, 300),
    firstFrame: text(raw.firstFrame, 800),
    lastFrame: text(raw.lastFrame, 800),
    immutableConstraints: list(raw.immutableConstraints, 30)
  };
}

function buildStoryboardDispatchPlan(run, strategy, visualPackage, selectedArtifacts = []) {
  const shots = (Array.isArray(run?.storyboardPlan?.shots) ? run.storyboardPlan.shots : []).map(safeShot).sort((a, b) => a.order - b.order);
  if (!shots.length) throw new Error('阶段四没有已锁定镜头，不能进入阶段七');
  const assignmentMap = new Map((Array.isArray(run?.storyboardPlan?.shotAssignments) ? run.storyboardPlan.shotAssignments : []).map(item => [text(item.shotId, 120), list(item.assetIds)]));
  const assets = new Map((Array.isArray(run?.storyboardPlan?.assets) ? run.storyboardPlan.assets : []).map(item => [text(item.id, 120), {
    id: text(item.id, 120), type: text(item.type, 40), name: text(item.name, 240),
    anchorFacts: list(item.anchorFacts, 30), immutableConstraints: list(item.immutableConstraints, 30)
  }]));
  const selectedByAsset = new Map(selectedArtifacts.map(item => [text(item.metadata?.assetId, 120), {
    artifactVersionId: item.artifactVersionId,
    assetId: text(item.metadata?.assetId, 120),
    assetType: text(item.metadata?.assetType, 40),
    assetName: text(item.metadata?.assetName, 240),
    previewUrl: text(item.metadata?.previewUrl, 1200),
    testSubstitute: item.metadata?.testSubstitute === true
  }]));
  const missing = [];
  const frameTasks = [];
  const plannedShots = shots.map(shot => {
    const assetIds = assignmentMap.get(shot.id) || [];
    const selectedAssets = assetIds.map(id => selectedByAsset.get(id)).filter(Boolean);
    assetIds.filter(id => !selectedByAsset.has(id)).forEach(id => missing.push(`${shot.id}：${assets.get(id)?.name || id}`));
    const constraints = [...new Set([...(shot.immutableConstraints || []), ...assetIds.flatMap(id => assets.get(id)?.immutableConstraints || [])])];
    const base = {
      shotId: shot.id, order: shot.order, timeRange: shot.timeRange, durationSeconds: shot.durationSeconds,
      scene: shot.scene, framing: shot.framing, cameraMovement: shot.cameraMovement,
      visual: shot.visual, action: shot.action, transition: shot.transition,
      assetIds, selectedAssets, immutableConstraints: constraints
    };
    [['first', '首帧', shot.firstFrame], ['last', '尾帧', shot.lastFrame]].forEach(([frameRole, frameRoleLabel, frameDescription]) => {
      frameTasks.push({
        id: `frame-task-${shot.id}-${frameRole}`,
        ...base,
        frameRole,
        frameRoleLabel,
        frameDescription,
        references: selectedAssets.filter(item => item.previewUrl),
        prompt: [
          `生成镜头 ${shot.order} 的${frameRoleLabel}。`,
          `时间：${shot.timeRange}。场景：${shot.scene}。景别：${shot.framing}。`,
          `画面：${frameDescription || shot.visual}。动作：${shot.action}。`,
          `镜头运动参考：${shot.cameraMovement}。`,
          selectedAssets.length ? `只使用已锁定资产版本：${selectedAssets.map(item => item.assetName).join('、')}。` : '',
          constraints.length ? `不可变化：${constraints.join('；')}。` : '',
          '产品包装、Logo、文字、规格和颜色必须服从实拍参考；角色、场景和道具必须跨镜连续。',
          `输出比例：${strategy.image.ratio}。画面中不得出现分镜编号、说明文字或水印。`
        ].filter(Boolean).join('\n'),
        providerId: strategy.image.providerId,
        providerName: strategy.image.providerName,
        model: strategy.image.model,
        ratio: strategy.image.ratio,
        quantity: strategy.image.quantity,
        status: 'pending'
      });
    });
    return base;
  });
  const inputVersionIds = [run.storyboardPlan.coverageArtifactVersionId, visualPackage.artifactVersionId, ...selectedArtifacts.map(item => item.artifactVersionId)].filter(Boolean);
  const planCore = { runId: run.id, canvasId: run.canvasId, shots: plannedShots, frameTasks, inputVersionIds, strategy };
  return {
    schemaVersion: 1,
    planId: `storyboard-dispatch-${crypto.createHash('sha256').update(JSON.stringify(planCore)).digest('hex').slice(0, 16)}`,
    ...planCore,
    shotCount: plannedShots.length,
    frameTaskCount: frameTasks.length,
    totalImages: frameTasks.reduce((sum, item) => sum + item.quantity, 0),
    maximumAuthorizedCost: strategy.budgetLimit,
    currency: strategy.currency || 'CNY',
    blockedReason: missing.length ? `以下镜头缺少阶段六锁定资产版本：${[...new Set(missing)].join('、')}` : ''
  };
}

function planPlainText(plan) {
  const lines = [
    '阶段七分镜图、故事板与调度工作台', '',
    `镜头数量：${plan.shotCount} 个`,
    `首尾帧任务：${plan.frameTaskCount} 项`,
    `图片站点：${plan.strategy.image.providerName || plan.strategy.image.providerId}`,
    `图片模型：${plan.strategy.image.model}`,
    `输出比例：${plan.strategy.image.ratio}`,
    `每个首尾帧候选：${plan.strategy.image.quantity} 张`,
    `本批最多生成：${plan.totalImages} 张`,
    `本批最高授权金额：${plan.maximumAuthorizedCost} 元`, '',
    '执行顺序：先生成逐镜首尾帧，再组装故事板，最后生成机位、站位和运动路线调度图。',
    '所有步骤都会在画布显示状态，可随时中断；最终只提交一次审核。'
  ];
  plan.shots.forEach(shot => lines.push(`${shot.order}. ${shot.timeRange}，${shot.scene}，${shot.framing}，${shot.cameraMovement}`));
  if (plan.blockedReason) lines.push('', `当前阻塞：${plan.blockedReason}`);
  return lines.join('\n');
}

function framePlainText(candidate) {
  return [
    `镜头 ${candidate.order} ${candidate.frameRoleLabel}候选`, '',
    `时间：${candidate.timeRange}`,
    `景别：${candidate.framing}`,
    `镜头运动：${candidate.cameraMovement}`,
    `画面：${candidate.frameDescription}`,
    `状态：${candidate.testSubstitute ? '无费用测试替身，不是模型生成结果' : '真实画布图片任务已完成'}`,
    '一致性：服从阶段六锁定资产版本和产品实拍图。'
  ].join('\n');
}

function reviewPlainText(groups) {
  return [
    '阶段七逐镜画面审核', '',
    ...groups.map(group => `镜头 ${group.order}，${group.timeRange}，分别选择 1 张首帧和 1 张尾帧`),
    '', '所有镜头选择完成后只提交一次。提交时同时锁定逐镜画面、故事板和调度图。',
    '提交后停止，不会自动生成配音、逐镜视频或最终成片。'
  ].join('\n');
}

function packagePlainText(groups) {
  return [
    '阶段七分镜图、故事板与调度包已锁定', '',
    ...groups.map(group => `镜头 ${group.order}，${group.timeRange}，首帧、尾帧、机位、站位和运动路线均已锁定`),
    '', '阶段七已停止，等待用户验收；没有进入声音或视频生成阶段。'
  ].join('\n');
}

module.exports = { buildStoryboardDispatchPlan, framePlainText, packagePlainText, planPlainText, reviewPlainText };
