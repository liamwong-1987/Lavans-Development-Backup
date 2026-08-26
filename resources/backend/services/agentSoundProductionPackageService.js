const crypto = require('crypto');

function text(value, limit = 1600) {
  return String(value == null ? '' : value).trim().slice(0, limit);
}

function list(value, limit = 80) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[\s,，、;；]+/);
  return [...new Set(source.map(item => text(item, 240)).filter(Boolean))].slice(0, limit);
}

const SOUND_POLICY_OPTIONS = {
  voiceStyle: [
    { id: 'natural-warm', label: '自然温暖', description: '生活化、可信、不过度表演，适合品牌叙事。' },
    { id: 'calm-premium', label: '克制高级', description: '语气沉稳、留白更多，适合质感产品片。' },
    { id: 'bright-friendly', label: '轻快亲和', description: '节奏明快、亲切有活力，适合社交媒体。' }
  ],
  voiceSpeed: [
    { id: 'slow', label: '舒缓', description: '约零点九倍语速，情绪停顿更充分。' },
    { id: 'normal', label: '自然', description: '约一倍语速，默认推荐。' },
    { id: 'fast', label: '紧凑', description: '约一点一倍语速，信息密度更高。' }
  ],
  subtitleStyle: [
    { id: 'bottom-single', label: '底部单行', description: '默认推荐，优先保证画面主体完整。' },
    { id: 'bottom-double', label: '底部双行', description: '适合较长对白或旁白。' },
    { id: 'key-words', label: '重点词字幕', description: '只突出品牌、产品和关键卖点。' }
  ],
  musicStyle: [
    { id: 'warm-cinematic', label: '温暖电影感', description: '情绪递进自然，适合完整品牌故事。' },
    { id: 'minimal-premium', label: '极简高级感', description: '减少旋律干扰，突出产品与声音细节。' },
    { id: 'light-rhythm', label: '轻快节奏感', description: '节奏明确，适合短视频观看习惯。' }
  ]
};

const DEFAULT_POLICY = { voiceStyle: 'natural-warm', voiceSpeed: 'normal', subtitleStyle: 'bottom-single', musicStyle: 'warm-cinematic' };

function selectedFrameMap(storyboard) {
  return new Map((Array.isArray(storyboard?.metadata?.storyboardGroups) ? storyboard.metadata.storyboardGroups : []).map(group => [text(group.shotId, 120), group]));
}

function selectedAssetsForShot(run, shotId, selectedArtifacts) {
  const assignment = (Array.isArray(run?.storyboardPlan?.shotAssignments) ? run.storyboardPlan.shotAssignments : []).find(item => text(item?.shotId, 120) === shotId);
  const wanted = new Set(list(assignment?.assetIds));
  return selectedArtifacts.filter(item => wanted.has(text(item?.metadata?.assetId, 120))).map(item => ({
    artifactVersionId: item.artifactVersionId,
    assetId: text(item.metadata?.assetId, 120),
    assetType: text(item.metadata?.assetType, 80),
    assetName: text(item.metadata?.assetName, 240),
    previewUrl: text(item.metadata?.previewUrl, 1600)
  }));
}

function buildShotPackage(run, shot, index, frameGroup, selectedArtifacts, strategy) {
  const shotId = text(shot?.id, 120) || `shot-${String(index + 1).padStart(3, '0')}`;
  if (!frameGroup?.selectedFirst?.artifactVersionId || !frameGroup?.selectedLast?.artifactVersionId) throw new Error(`镜头 ${index + 1} 缺少阶段七已锁定首帧或尾帧`);
  const durationSeconds = Math.max(0.1, Number(shot?.durationSeconds) || Number(frameGroup?.durationSeconds) || 1);
  const narration = text(shot?.narration, 1600) || '本镜头无旁白。';
  const dialogue = text(shot?.dialogue, 1600) || '本镜头无对白。';
  const subtitle = text(shot?.subtitle, 1000) || (text(shot?.dialogue, 1000) || text(shot?.narration, 1000) || '本镜头不显示字幕。');
  const sound = text(shot?.sound, 1000) || '保留现场环境声，并与前后镜头自然衔接。';
  const assets = selectedAssetsForShot(run, shotId, selectedArtifacts);
  const immutableConstraints = list(shot?.immutableConstraints, 40);
  const prompt = [
    `制作镜头 ${Number(shot?.order) || index + 1}，时长 ${durationSeconds} 秒，输出比例 ${text(strategy?.video?.ratio, 40) || '按阶段五锁定比例'}。`,
    `从已锁定首帧自然运动到已锁定尾帧。`,
    `场景：${text(shot?.scene, 500) || text(frameGroup?.scene, 500)}。`,
    `画面：${text(shot?.visual, 1200) || text(frameGroup?.visual, 1200)}。`,
    `动作：${text(shot?.action, 1000) || text(frameGroup?.action, 1000)}。`,
    `景别与镜头运动：${text(shot?.framing, 300) || text(frameGroup?.framing, 300)}，${text(shot?.cameraMovement, 500) || text(frameGroup?.cameraMovement, 500)}。`,
    `转场：${text(shot?.transition, 400) || text(frameGroup?.transition, 400) || '自然衔接'}。`,
    assets.length ? `必须使用已锁定资产：${assets.map(item => item.assetName).join('、')}。` : '',
    immutableConstraints.length ? `不可变化：${immutableConstraints.join('；')}。` : '',
    `对白：${dialogue} 旁白：${narration} 字幕：${subtitle} 声音：${sound}`,
    '不得改变产品包装、Logo、文字、规格、颜色、角色外观、场景连续性或道具关系。不得生成画外说明、水印或无关文字。'
  ].filter(Boolean).join('\n');
  return {
    id: `phase8-shot-${shotId}`,
    shotId,
    order: Number(shot?.order) || index + 1,
    timeRange: text(shot?.timeRange, 120) || text(frameGroup?.timeRange, 120),
    durationSeconds,
    narration,
    dialogue,
    subtitle,
    musicCue: '按用户最终选择的全片音乐风格延续，本镜头在情绪变化点做轻微推进或收束。',
    soundEffects: sound,
    videoPrompt: prompt,
    firstFrame: frameGroup.selectedFirst,
    lastFrame: frameGroup.selectedLast,
    selectedAssets: assets,
    immutableConstraints,
    videoProviderId: text(strategy?.video?.providerId, 120),
    videoProviderName: text(strategy?.video?.providerName, 240),
    videoModel: text(strategy?.video?.model, 240),
    videoRatio: text(strategy?.video?.ratio, 40)
  };
}

function buildSoundProductionPlan(run, inputs = {}) {
  const shots = (Array.isArray(run?.storyboardPlan?.shots) ? run.storyboardPlan.shots : []).slice().sort((a, b) => Number(a?.order) - Number(b?.order));
  if (!shots.length) throw new Error('阶段四没有已锁定分镜，不能建立阶段八制作包');
  const frameMap = selectedFrameMap(inputs.storyboard);
  const shotPackages = shots.map((shot, index) => buildShotPackage(run, shot, index, frameMap.get(text(shot?.id, 120)), inputs.selectedArtifacts || [], inputs.strategy || {}));
  const totalDurationSeconds = shotPackages.reduce((sum, item) => sum + item.durationSeconds, 0);
  const core = {
    runId: run.id,
    canvasId: run.canvasId,
    inputVersionIds: [inputs.phase7Package?.artifactVersionId, inputs.storyboard?.artifactVersionId, inputs.dispatch?.artifactVersionId, ...(inputs.selectedFrames || []).map(item => item.artifactVersionId), ...(inputs.selectedArtifacts || []).map(item => item.artifactVersionId), ...(inputs.strategyArtifacts || []).map(item => item.artifactVersionId)].filter(Boolean),
    soundPolicyOptions: SOUND_POLICY_OPTIONS,
    defaultPolicy: DEFAULT_POLICY,
    shotPackages,
    totalDurationSeconds
  };
  return { schemaVersion: 1, planId: `sound-production-${crypto.createHash('sha256').update(JSON.stringify(core)).digest('hex').slice(0, 16)}`, ...core, shotCount: shotPackages.length };
}

function validatePolicy(selections = {}) {
  const selected = {};
  Object.keys(SOUND_POLICY_OPTIONS).forEach(key => {
    const value = text(selections[key], 80);
    if (!SOUND_POLICY_OPTIONS[key].some(option => option.id === value)) throw new Error(`请选择${key === 'voiceStyle' ? '旁白音色' : key === 'voiceSpeed' ? '语速' : key === 'subtitleStyle' ? '字幕样式' : '音乐风格'}`);
    selected[key] = value;
  });
  return selected;
}

function optionLabel(key, id) {
  return SOUND_POLICY_OPTIONS[key].find(item => item.id === id)?.label || id;
}

function planPlainText(plan) {
  return ['阶段八声音与逐镜制作包工作台', '', `镜头数量：${plan.shotCount} 个`, `总时长：${plan.totalDurationSeconds} 秒`, '本阶段整理旁白、对白、字幕、音乐、音效和逐镜视频提示词。', '所有首帧、尾帧、资产和模型设置只读取已锁定版本。', '本阶段不调用配音或视频接口，不产生媒体生成费用。', '用户核对全部内容后只提交一次；提交后停止，不自动进入阶段九。'].join('\n');
}

function shotPlainText(item) {
  return [`镜头 ${item.order} 制作包`, '', `时间：${item.timeRange}，共 ${item.durationSeconds} 秒`, `旁白：${item.narration}`, `对白：${item.dialogue}`, `字幕：${item.subtitle}`, `音乐：${item.musicCue}`, `音效：${item.soundEffects}`, '', '逐镜视频提示词', item.videoPrompt, '', `首帧：已绑定阶段七锁定版本`, `尾帧：已绑定阶段七锁定版本`, `资产：${item.selectedAssets.map(asset => asset.assetName).join('、') || '无额外资产'}`].join('\n');
}

function reviewPlainText(plan) {
  return ['阶段八声音与逐镜制作包审核', '', '请选择一项旁白音色、一项语速、一项字幕样式和一项音乐风格。', '所有选项均使用单选卡，不需要手动输入。', '', ...plan.shotPackages.map(item => `镜头 ${item.order}，${item.timeRange}，旁白、对白、字幕、音乐、音效和视频提示词已准备`), '', '确认全部镜头后只提交一次。提交时统一锁定声音方案和全部逐镜制作包。', '提交后停止，不生成配音、逐镜视频或最终成片。'].join('\n');
}

function packagePlainText(plan, policy) {
  return ['阶段八声音与逐镜制作包已锁定', '', `旁白音色：${optionLabel('voiceStyle', policy.voiceStyle)}`, `语速：${optionLabel('voiceSpeed', policy.voiceSpeed)}`, `字幕样式：${optionLabel('subtitleStyle', policy.subtitleStyle)}`, `音乐风格：${optionLabel('musicStyle', policy.musicStyle)}`, '', ...plan.shotPackages.map(item => `镜头 ${item.order}，${item.timeRange}，声音和逐镜视频提示词已锁定`), '', '阶段八已停止，等待用户验收；没有调用配音或视频接口，也没有进入阶段九。'].join('\n');
}

module.exports = { SOUND_POLICY_OPTIONS, DEFAULT_POLICY, buildSoundProductionPlan, validatePolicy, optionLabel, planPlainText, shotPlainText, reviewPlainText, packagePlainText };
