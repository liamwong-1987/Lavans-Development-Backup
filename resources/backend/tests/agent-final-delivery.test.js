const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildFinalDeliveryPlan, buildQualityReport, planPlainText, reviewPlainText } = require('../services/agentFinalDeliveryService');

const locked = (id, type, metadata) => ({ artifactVersionId: id, artifactType: type, approvalState: 'locked', validityState: 'current', metadata });
const shots = [1, 2, 3].map(order => ({ shotId: `shot-${order}`, order, timeRange: `${order - 1} 至 ${order} 秒`, durationSeconds: 1, subtitle: `字幕 ${order}`, narration: '', dialogue: '' }));
const phase8 = locked('phase8-v1', 'sound-production-package', { shotProductionPackages: shots });
const videos = [1, 2, 3].map(order => locked(`video-${order}-v1`, 'shot-video-candidate', { previewUrl: `/canvas-output/video-${order}.mp4`, durationSeconds: 1 }));
const phase9 = locked('phase9-v1', 'shot-video-package', { shotVideoGroups: videos.map((item, index) => ({ shotId: `shot-${index + 1}`, order: index + 1, selected: { artifactVersionId: item.artifactVersionId } })) });

test('阶段10正式计划只接受锁定且完整的阶段九逐镜视频包', () => {
  const plan = buildFinalDeliveryPlan({ phase8Package: phase8, phase9Package: phase9, selectedVideoArtifacts: videos });
  assert.equal(plan.clipCount, 3);
  assert.equal(plan.output.aspectRatio, '9:16');
  assert.equal(plan.controlledTest, false);
  assert.equal(plan.totalDurationSeconds, 3);
});

test('阶段10缺镜头或阶段九未锁定时禁止合成', () => {
  assert.throws(() => buildFinalDeliveryPlan({ phase8Package: phase8, phase9Package: { ...phase9, approvalState: 'draft' }, selectedVideoArtifacts: videos }), /阶段九逐镜视频包/);
  assert.throws(() => buildFinalDeliveryPlan({ phase8Package: phase8, phase9Package: phase9, selectedVideoArtifacts: videos.slice(0, 2) }), /最终视频/);
});

test('阶段10拒绝逐镜视频总时长与锁定时间线不一致', () => {
  const mismatched = videos.map((item, index) => index === 1 ? { ...item, metadata: { ...item.metadata, durationSeconds: 0.5 } } : item);
  assert.throws(() => buildFinalDeliveryPlan({ phase8Package: phase8, phase9Package: phase9, selectedVideoArtifacts: mismatched }), /总时长/);
});

test('阶段10受控测试计划明确标记且不冒充正式成片', () => {
  const plan = buildFinalDeliveryPlan({ phase8Package: phase8, controlledTest: true, controlledUrls: ['/canvas-output/a.mp4', '/canvas-output/b.mp4', '/canvas-output/c.mp4'] });
  assert.equal(plan.controlledTest, true);
  assert.match(planPlainText(plan), /受控测试素材/);
  assert.equal(plan.clips.every(item => item.testSubstitute), true);
});

test('阶段10质检必须同时通过视频、声音、字幕、画幅和时长', () => {
  const plan = buildFinalDeliveryPlan({ phase8Package: phase8, phase9Package: phase9, selectedVideoArtifacts: videos });
  const good = buildQualityReport(plan, { clipCount: 3, width: 720, height: 1280, durationSeconds: 3.1, hasVideo: true, hasAudio: true, subtitleEmbedded: true, subtitleUrl: '/x.srt' });
  assert.equal(good.allPassed, true);
  const bad = buildQualityReport(plan, { clipCount: 3, width: 1280, height: 720, durationSeconds: 3.1, hasVideo: true, hasAudio: false, subtitleEmbedded: false });
  assert.equal(bad.allPassed, false);
  assert.match(reviewPlainText(plan, bad), /禁止|未通过|存在未通过项/);
});

test('阶段10界面必须提供合成、质检、交付、取消和一次提交标记', () => {
  const ui = fs.readFileSync(path.resolve(__dirname, '../../frontend/smart-canvas-core/smart-canvas-core.js'), 'utf8');
  for (const marker of ['phase10-prepare', 'phase10-test-prepare', 'phase10-compose', 'phase10-cancel', 'phase10-submit', '一次提交并锁定最终交付包']) assert.match(ui, new RegExp(marker));
});
