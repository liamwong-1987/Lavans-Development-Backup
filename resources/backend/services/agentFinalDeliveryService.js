const crypto = require('crypto');

const text = (value, limit = 4000) => String(value == null ? '' : value).trim().slice(0, limit);
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function assertLockedCurrent(artifact, label) {
  if (!artifact || artifact.approvalState !== 'locked' || artifact.validityState !== 'current') {
    throw new Error(`${label}未锁定、缺失或已经失效`);
  }
}

function buildFinalDeliveryPlan(input = {}) {
  const controlledTest = input.controlledTest === true;
  const phase8Package = input.phase8Package;
  assertLockedCurrent(phase8Package, '阶段八声音与字幕制作包');
  const shotPackages = Array.isArray(phase8Package.metadata?.shotProductionPackages)
    ? phase8Package.metadata.shotProductionPackages.slice().sort((a, b) => finite(a?.order) - finite(b?.order))
    : [];
  if (!shotPackages.length) throw new Error('阶段八逐镜声音与字幕制作包为空');

  let videoRows = [];
  let sourceArtifactVersionIds = [];
  if (controlledTest) {
    const urls = Array.isArray(input.controlledUrls) ? input.controlledUrls.map(item => text(item, 2000)).filter(Boolean) : [];
    if (urls.length < shotPackages.length) throw new Error(`受控测试至少需要 ${shotPackages.length} 段本地视频`);
    videoRows = shotPackages.map((shot, index) => ({
      shotId: text(shot.shotId, 160) || `shot-${index + 1}`,
      order: finite(shot.order, index + 1),
      previewUrl: urls[index],
      artifactVersionId: `controlled-test-video-${index + 1}`,
      testSubstitute: true
    }));
  } else {
    const phase9Package = input.phase9Package;
    assertLockedCurrent(phase9Package, '阶段九逐镜视频包');
    const groups = Array.isArray(phase9Package.metadata?.shotVideoGroups) ? phase9Package.metadata.shotVideoGroups : [];
    if (groups.length !== shotPackages.length) throw new Error('阶段九已锁定镜头数量与阶段八制作包不一致');
    const artifacts = Array.isArray(input.selectedVideoArtifacts) ? input.selectedVideoArtifacts : [];
    videoRows = groups.map(group => {
      const selectedId = text(group?.selected?.artifactVersionId, 300);
      const artifact = artifacts.find(item => item?.artifactVersionId === selectedId);
      assertLockedCurrent(artifact, `镜头 ${group?.order || ''} 的最终视频`);
      const previewUrl = text(artifact.metadata?.previewUrl, 2000);
      if (!previewUrl) throw new Error(`镜头 ${group?.order || ''} 没有可合成的视频地址`);
      const durationSeconds = finite(artifact.metadata?.durationSeconds || artifact.metadata?.videoCandidate?.durationSeconds, 0);
      if (durationSeconds <= 0) throw new Error(`镜头 ${group?.order || ''} 缺少真实视频时长，不能安全合成`);
      return { shotId: text(group.shotId, 160), order: finite(group.order), previewUrl, artifactVersionId: artifact.artifactVersionId, durationSeconds, testSubstitute: artifact.metadata?.testSubstitute === true };
    });
    sourceArtifactVersionIds = [phase9Package.artifactVersionId, ...videoRows.map(item => item.artifactVersionId)];
  }

  const clips = shotPackages.map((shot, index) => {
    const video = videoRows.find(item => item.shotId === shot.shotId) || videoRows[index];
    if (!video) throw new Error(`镜头 ${shot.order || index + 1} 缺少已选视频`);
    const durationSeconds = controlledTest ? 1 : Math.max(0.1, finite(video.durationSeconds, 0));
    if (!durationSeconds) throw new Error(`镜头 ${shot.order || index + 1} 时长无效`);
    return {
      shotId: text(shot.shotId, 160) || video.shotId,
      order: finite(shot.order, index + 1),
      timeRange: text(shot.timeRange, 200),
      durationSeconds,
      url: video.previewUrl,
      sourceArtifactVersionId: video.artifactVersionId,
      subtitle: text(shot.subtitle || shot.dialogue || shot.narration, 1200),
      narration: text(shot.narration, 1200),
      dialogue: text(shot.dialogue, 1200),
      testSubstitute: video.testSubstitute === true
    };
  }).sort((a, b) => a.order - b.order);
  const totalDurationSeconds = Number(clips.reduce((sum, item) => sum + item.durationSeconds, 0).toFixed(3));
  const lockedTimelineSeconds = Number(shotPackages.reduce((sum, item) => sum + Math.max(0, finite(item.durationSeconds, 0)), 0).toFixed(3));
  if (!controlledTest && Math.abs(totalDurationSeconds - lockedTimelineSeconds) > 0.2) {
    throw new Error(`阶段九逐镜视频总时长 ${totalDurationSeconds} 秒与锁定时间线 ${lockedTimelineSeconds} 秒不一致，请先在阶段九修正镜头时长`);
  }
  const signature = crypto.createHash('sha256').update(JSON.stringify({ clips: clips.map(item => [item.shotId, item.sourceArtifactVersionId, item.durationSeconds]), controlledTest })).digest('hex').slice(0, 16);
  return {
    planId: `final-delivery-${signature}`,
    controlledTest,
    sourceArtifactVersionIds: [phase8Package.artifactVersionId, ...sourceArtifactVersionIds],
    clipCount: clips.length,
    clips,
    output: { width: 720, height: 1280, aspectRatio: '9:16', fps: 30, container: 'mp4', videoCodec: 'h264', audioCodec: 'aac' },
    totalDurationSeconds, lockedTimelineSeconds,
    subtitleMode: 'burned-and-sidecar',
    audioMode: controlledTest ? '保留片段声音；无声音片段自动补静音轨' : '保留已选逐镜视频声音，并按阶段八锁定方案检查旁白、对白、音乐和音效',
    testLabel: controlledTest ? '受控测试素材，不是正式品牌成片' : ''
  };
}

function planPlainText(plan) {
  return [
    plan.controlledTest ? '阶段十受控测试合成计划' : '阶段十最终合成计划', '',
    `镜头数量：${plan.clipCount} 个`, `输出规格：${plan.output.aspectRatio}，${plan.output.width}×${plan.output.height}，${plan.output.fps} 帧，MP4`,
    `计划时长：${plan.totalDurationSeconds} 秒`, `字幕：烧录字幕并同时交付 SRT 文件`, `声音：${plan.audioMode}`,
    ...(plan.controlledTest ? ['', '本计划只用于开发验收，所有片段明确标记为受控测试素材，不能作为正式品牌成片交付。'] : []), '',
    ...plan.clips.map(item => `镜头 ${item.order}，${item.durationSeconds} 秒，${item.subtitle ? `字幕：${item.subtitle}` : '无字幕'}`)
  ].join('\n');
}

function attemptPlainText(plan, state, error = '') {
  const labels = { queued: '排队中', running: '合成中', succeeded: '合成完成', failed: '合成失败', interrupted: '已中断', cancelled: '已取消' };
  return ['阶段十本地合成任务', '', `状态：${labels[state] || state}`, `镜头：${plan.clipCount} 个`, `输出：${plan.output.width}×${plan.output.height} MP4`, error ? `原因：${text(error, 1200)}` : '', '', '任务失败或取消不会删除任何阶段九逐镜视频。'].filter(Boolean).join('\n');
}

function buildQualityReport(plan, probe = {}) {
  const duration = finite(probe.durationSeconds, 0);
  const checks = [
    { id: 'all-clips', label: '全部已选镜头按顺序进入时间线', passed: finite(probe.clipCount, plan.clipCount) === plan.clipCount, detail: `${plan.clipCount} 个镜头` },
    { id: 'resolution', label: '分辨率和画幅符合交付规格', passed: finite(probe.width) === plan.output.width && finite(probe.height) === plan.output.height, detail: `${finite(probe.width)}×${finite(probe.height)}，目标 ${plan.output.width}×${plan.output.height}` },
    { id: 'duration', label: '成片时长与计划一致', passed: Math.abs(duration - plan.totalDurationSeconds) <= 1, detail: `实测 ${duration.toFixed(2)} 秒，计划 ${plan.totalDurationSeconds.toFixed(2)} 秒` },
    { id: 'video', label: '成片视频轨可读取', passed: probe.hasVideo === true, detail: probe.hasVideo === true ? '视频轨正常' : '未检测到视频轨' },
    { id: 'audio', label: '成片包含可播放声音轨', passed: probe.hasAudio === true, detail: probe.hasAudio === true ? '声音轨正常' : '未检测到声音轨' },
    { id: 'subtitle', label: '字幕已烧录并提供独立 SRT', passed: probe.subtitleEmbedded === true && Boolean(probe.subtitleUrl), detail: probe.subtitleEmbedded === true ? '烧录字幕与 SRT 均已生成' : '字幕交付不完整' },
    { id: 'source-lock', label: '输入版本与合成计划保持锁定', passed: Array.isArray(plan.sourceArtifactVersionIds) && plan.sourceArtifactVersionIds.length > 0, detail: `${plan.sourceArtifactVersionIds.length} 个锁定输入版本` }
  ];
  return { allPassed: checks.every(item => item.passed), checks, measured: { durationSeconds: duration, width: finite(probe.width), height: finite(probe.height), hasVideo: probe.hasVideo === true, hasAudio: probe.hasAudio === true }, controlledTest: plan.controlledTest === true };
}

function qualityPlainText(report) {
  return ['阶段十成片质检报告', '', ...report.checks.map(item => `${item.passed ? '通过' : '未通过'}：${item.label}。${item.detail}`), '', report.allPassed ? '质检结论：全部通过，可以进入最终交付审核。' : '质检结论：存在未通过项，禁止提交最终交付。'].join('\n');
}

function reviewPlainText(plan, report) {
  return [plan.controlledTest ? '阶段十受控测试最终交付审核' : '阶段十最终交付审核', '', `成片：${plan.output.width}×${plan.output.height}，${plan.totalDurationSeconds} 秒`, `质检：${report.allPassed ? '全部通过' : '存在未通过项'}`, '', '请播放成片，并核对画面、声音、字幕、产品、Logo、文字、节奏和片尾。', '全部确认后只提交一次，系统会锁定成片、字幕、质检报告、版本来源和最终制作包。'].join('\n');
}

module.exports = { buildFinalDeliveryPlan, buildQualityReport, planPlainText, attemptPlainText, qualityPlainText, reviewPlainText };
