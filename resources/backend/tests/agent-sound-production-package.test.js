const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { buildSoundProductionPlan, validatePolicy, planPlainText, shotPlainText, reviewPlainText, packagePlainText } = require('../services/agentSoundProductionPackageService');

const run = {
  id: 'run-phase8', canvasId: 'canvas-phase8',
  storyboardPlan: {
    shots: [
      { id: 'shot-001', order: 1, timeRange: '0 至 5 秒', durationSeconds: 5, scene: '夜间桌面', framing: '中景', cameraMovement: '缓慢推进', visual: '角色拿起产品', action: '从桌面拿起产品', dialogue: '今晚也要照顾好自己。', narration: '温暖从一个小动作开始。', subtitle: '照顾好自己', sound: '轻柔环境声与拿起产品的摩擦声', transition: '动作衔接', immutableConstraints: ['产品包装不变'] },
      { id: 'shot-002', order: 2, timeRange: '5 至 10 秒', durationSeconds: 5, scene: '夜间桌面', framing: '特写', cameraMovement: '固定', visual: '产品正面特写', action: '产品保持稳定', dialogue: '', narration: '真实产品信息清晰可见。', subtitle: '真实产品', sound: '轻微提示音', transition: '自然淡出', immutableConstraints: ['Logo 不变'] }
    ],
    shotAssignments: [{ shotId: 'shot-001', assetIds: ['character-a', 'product-a'] }, { shotId: 'shot-002', assetIds: ['product-a'] }]
  }
};

const inputs = {
  phase7Package: { artifactVersionId: 'phase7-package-v1' },
  storyboard: { artifactVersionId: 'storyboard-v1', metadata: { storyboardGroups: [
    { shotId: 'shot-001', selectedFirst: { artifactVersionId: 'shot1-first-v1', previewUrl: '/shot1-first.png' }, selectedLast: { artifactVersionId: 'shot1-last-v1', previewUrl: '/shot1-last.png' } },
    { shotId: 'shot-002', selectedFirst: { artifactVersionId: 'shot2-first-v1', previewUrl: '/shot2-first.png' }, selectedLast: { artifactVersionId: 'shot2-last-v1', previewUrl: '/shot2-last.png' } }
  ] } },
  dispatch: { artifactVersionId: 'dispatch-v1' },
  selectedFrames: [{ artifactVersionId: 'shot1-first-v1' }, { artifactVersionId: 'shot1-last-v1' }, { artifactVersionId: 'shot2-first-v1' }, { artifactVersionId: 'shot2-last-v1' }],
  selectedArtifacts: [
    { artifactVersionId: 'character-v1', metadata: { assetId: 'character-a', assetType: 'character', assetName: '主角', previewUrl: '/character.png' } },
    { artifactVersionId: 'product-v1', metadata: { assetId: 'product-a', assetType: 'product', assetName: '真实产品', previewUrl: '/product.png' } }
  ],
  strategy: { video: { providerId: 'video-site', providerName: '视频站点', model: 'video-model', ratio: '9:16' } },
  strategyArtifacts: [{ artifactVersionId: 'strategy-v1' }]
};

test('阶段8逐镜建立声音与视频制作包并精确绑定锁定输入', () => {
  const plan = buildSoundProductionPlan(run, inputs);
  assert.equal(plan.shotCount, 2);
  assert.equal(plan.totalDurationSeconds, 10);
  assert.ok(plan.inputVersionIds.includes('phase7-package-v1'));
  assert.ok(plan.inputVersionIds.includes('shot1-first-v1'));
  assert.ok(plan.inputVersionIds.includes('product-v1'));
  assert.equal(plan.shotPackages[0].firstFrame.artifactVersionId, 'shot1-first-v1');
  assert.equal(plan.shotPackages[0].lastFrame.artifactVersionId, 'shot1-last-v1');
  assert.deepEqual(plan.shotPackages[1].selectedAssets.map(item => item.assetName), ['真实产品']);
  assert.match(plan.shotPackages[0].videoPrompt, /产品包装、Logo、文字、规格、颜色/);
});

test('阶段8缺少任一锁定首尾帧时真实阻塞', () => {
  const broken = { ...inputs, storyboard: { ...inputs.storyboard, metadata: { storyboardGroups: [inputs.storyboard.metadata.storyboardGroups[0]] } } };
  assert.throws(() => buildSoundProductionPlan(run, broken), /缺少阶段七已锁定首帧或尾帧/);
});

test('阶段8四组设置只能从单选范围提交', () => {
  const selected = validatePolicy({ voiceStyle: 'natural-warm', voiceSpeed: 'normal', subtitleStyle: 'bottom-single', musicStyle: 'warm-cinematic' });
  assert.equal(selected.voiceStyle, 'natural-warm');
  assert.throws(() => validatePolicy({ voiceStyle: '任意输入', voiceSpeed: 'normal', subtitleStyle: 'bottom-single', musicStyle: 'warm-cinematic' }), /请选择旁白音色/);
});

test('阶段8用户可见内容是纯中文说明并明确一次提交和停止边界', () => {
  const plan = buildSoundProductionPlan(run, inputs);
  assert.match(planPlainText(plan), /不调用配音或视频接口/);
  assert.match(shotPlainText(plan.shotPackages[0]), /逐镜视频提示词/);
  assert.match(reviewPlainText(plan), /只提交一次/);
  assert.match(packagePlainText(plan, plan.defaultPolicy), /没有进入阶段九/);
});

test('阶段8画布界面包含单选卡、逐镜制作包和一次提交入口', () => {
  const frontend = fs.readFileSync(path.resolve(__dirname, '../../frontend/smart-canvas-core/smart-canvas-core.js'), 'utf8');
  const css = fs.readFileSync(path.resolve(__dirname, '../../frontend/smart-canvas-core/smart-canvas-core.css'), 'utf8');
  const routes = fs.readFileSync(path.resolve(__dirname, '../routes/canvasRoutes.js'), 'utf8');
  assert.match(frontend, /sound-production\/prepare/);
  assert.match(frontend, /data-agent-sound-policy-choice/);
  assert.match(frontend, /一次提交并锁定阶段八全部成果/);
  assert.match(frontend, /smart-agent-shot-production-packages/);
  assert.match(routes, /sound-production-package-review/);
  assert.match(routes, /没有调用配音或视频接口，也没有进入阶段九/);
  assert.match(css, /smart-agent-sound-policy/);
  assert.match(css, /font-size:17px/);
});
