const crypto = require('crypto');

function text(value, limit = 1600) {
  return String(value == null ? '' : value).trim().slice(0, limit);
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function classifyShotVideoFailure(value, status = 'failed') {
  const message = text(value, 1600);
  const normalized = message.toLowerCase();
  if (status === 'cancelled' || status === 'interrupted' || /已中断|取消|cancel|interrupt/.test(normalized)) return 'interrupted';
  if (/内容政策|内容安全|违规|公众人物|未成年人|版权|content\s*policy|safety|moderation/.test(normalized)) return 'policy';
  if (/限流|余额|欠费|模型下线|中转站|网关|网络|超时|timeout|rate\s*limit|http\s*(402|408|409|429|5\d\d)/.test(normalized)) return 'provider';
  return 'generation';
}

function buildSafePromptRevision(originalPrompt, issueCodes = []) {
  const original = text(originalPrompt, 6000);
  const selected = [...new Set((Array.isArray(issueCodes) ? issueCodes : []).map(item => text(item, 80)).filter(Boolean))];
  if (!selected.length) throw new Error('请至少勾选一个需要修改的内容安全方向');
  const rules = {
    identity: '使用完全虚构的成年角色，不模仿、不暗示也不指向任何现实公众人物，不出现未成年人。',
    copyright: '不生成、模仿或引用任何受版权保护的音乐、歌词、声音或配音，画面保持静音。',
    dangerous: '所有动作保持安全、非暴力，不展示危险、违法、伤害或可能被模仿的高风险行为。',
    branding: '仅展示已经审核的自有品牌和产品信息，不新增文字、水印、商标或第三方标识。',
    other: '遵守内容安全要求，删除或替换任何敏感、受限、容易误解或无法确认授权的表达。'
  };
  const additions = selected.map(code => rules[code]).filter(Boolean);
  if (!additions.length) throw new Error('所选修改方向无效');
  const proposed = [original, '', '本镜头内容安全修订要求：', ...additions.map((item, index) => `${index + 1}、${item}`)].join('\n').trim();
  return {
    originalPrompt: original,
    proposedPrompt: text(proposed, 7600),
    issueCodes: selected,
    changeSummary: additions
  };
}

function buildShotVideoPlan(run, inputs = {}, requested = {}) {
  const phase8Package = inputs.phase8Package;
  if (!phase8Package || phase8Package.approvalState !== 'locked' || phase8Package.validityState !== 'current') throw new Error('请先一次提交并锁定阶段八制作包');
  const sourcePackages = Array.isArray(phase8Package.metadata?.shotProductionPackages) ? phase8Package.metadata.shotProductionPackages : [];
  const shotArtifacts = Array.isArray(inputs.shotArtifacts) ? inputs.shotArtifacts : [];
  if (!sourcePackages.length || sourcePackages.length !== shotArtifacts.length) throw new Error('阶段八逐镜制作包不完整或已经失效');
  const providerId = text(requested.providerId || inputs.strategy?.video?.providerId, 120);
  const providerName = text(requested.providerName || inputs.strategy?.video?.providerName || providerId, 240);
  const model = text(requested.model || inputs.strategy?.video?.model, 240);
  if (!providerId || !model) throw new Error('阶段九缺少视频 API 站点或模型');
  const durationSeconds = Math.max(1, Math.round(number(requested.durationSeconds, 5)));
  const resolution = text(requested.resolution || inputs.strategy?.video?.resolution || '480P', 40);
  const ratio = text(requested.ratio || inputs.strategy?.video?.ratio || sourcePackages[0]?.videoRatio || '16:9', 40);
  const retryLimit = Math.max(0, Math.min(3, Math.round(number(requested.retryLimit, inputs.strategy?.retryLimit || 1))));
  const unitRate = Math.max(0, number(requested.unitRate, 0));
  const estimatedCost = Math.round(unitRate * durationSeconds * sourcePackages.length * 100) / 100;
  const tasks = sourcePackages.map((item, index) => {
    const sourceArtifact = shotArtifacts.find(artifact => artifact.metadata?.shotId === item.shotId);
    if (!sourceArtifact || sourceArtifact.approvalState !== 'locked' || sourceArtifact.validityState !== 'current') throw new Error(`镜头 ${index + 1} 的阶段八制作包未锁定或已经失效`);
    if (!item.firstFrame?.artifactVersionId || !item.lastFrame?.artifactVersionId) throw new Error(`镜头 ${index + 1} 缺少锁定首帧或尾帧`);
    return {
      id: `phase9-video-${item.shotId}`,
      shotId: text(item.shotId, 120),
      order: number(item.order, index + 1),
      timeRange: text(item.timeRange, 120),
      outputDurationSeconds: durationSeconds,
      sourceDurationSeconds: number(item.durationSeconds, durationSeconds),
      prompt: text(item.videoPrompt, 6000),
      firstFrame: item.firstFrame,
      lastFrame: item.lastFrame,
      sourceArtifactVersionId: sourceArtifact.artifactVersionId,
      providerId,
      providerName,
      model,
      resolution,
      ratio,
      retryLimit
    };
  });
  const core = {
    runId: run.id,
    canvasId: run.canvasId,
    inputVersionIds: [phase8Package.artifactVersionId, ...shotArtifacts.map(item => item.artifactVersionId)],
    providerId,
    providerName,
    model,
    resolution,
    ratio,
    durationSeconds,
    retryLimit,
    quantity: tasks.length,
    unitRate,
    estimatedCost,
    currency: text(requested.currency || 'CNY', 12),
    executionMode: text(requested.executionMode || inputs.strategy?.mode || 'manual', 40),
    tasks
  };
  return { schemaVersion: 1, planId: `shot-video-${crypto.createHash('sha256').update(JSON.stringify(core)).digest('hex').slice(0, 16)}`, ...core };
}

function planPlainText(plan) {
  return ['阶段九逐镜视频生产工作台', '', `API 站点：${plan.providerName}`, `视频模型：${plan.model}`, `分辨率：${plan.resolution}`, `单镜头测试时长：${plan.durationSeconds} 秒`, `镜头数量：${plan.quantity} 个`, `预计费用上限：${plan.estimatedCost.toFixed(2)} 元`, `失败重试：每个镜头最多 ${plan.retryLimit} 次`, '', '每个镜头独立排队、生成、停止、重试和验收。', '某个镜头失败只影响该镜头，已有成功版本不会被覆盖。', '批量付费前必须集中确认一次；自动模式也不能越过逐镜人工审核。'].join('\n');
}

function taskPlainText(task, status = 'pending', detail = '') {
  const labels = { pending: '等待授权', queued: '排队中', running: '生成中', succeeded: '已生成，等待审核', failed: '生成失败，可单独重试', cancelled: '已中断，可恢复', interrupted: '服务中断，可恢复' };
  return [`镜头 ${task.order} 视频任务`, '', `时间：${task.timeRange}`, `测试时长：${task.outputDurationSeconds} 秒`, `模型：${task.providerName} · ${task.model}`, `画面：${task.resolution} · ${task.ratio}`, `状态：${labels[status] || status}`, detail ? `说明：${text(detail, 1200)}` : '', '', '首帧、尾帧和阶段八逐镜提示词均已精确绑定。', '失败时只重试当前镜头，不会重新生成其他镜头。'].filter(Boolean).join('\n');
}

function reviewPlainText(plan, groups) {
  return ['阶段九逐镜视频审核', '', ...groups.map(group => group.options.length ? `镜头 ${group.order}，${group.timeRange}，已有 ${group.options.length} 个可播放版本，请单选一个版本` : `镜头 ${group.order}，${group.timeRange}，尚无可审核视频。${group.requiresPromptRevision ? '内容安全拦截，需要先确认提示词修改再重做。' : '可以单独恢复或重做本镜头。'}`), '', '不满意或失败的镜头只处理当前镜头，其他镜头保持不变。', '全部镜头都有已选版本后，只提交一次即可锁定阶段九。', '提交后停止，不进入合成、质检或最终交付。'].join('\n');
}

function packagePlainText(groups) {
  return ['阶段九逐镜视频已锁定', '', ...groups.map(group => `镜头 ${group.order}，已锁定视频版本 ${group.selected.candidateNumber}`), '', '所有镜头已逐一验收并一次提交锁定。', '阶段九已经停止，没有进入阶段十，也没有生成最终成片。'].join('\n');
}

module.exports = { buildShotVideoPlan, classifyShotVideoFailure, buildSafePromptRevision, planPlainText, taskPlainText, reviewPlainText, packagePlainText };
