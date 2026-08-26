const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { buildStoryboardDispatchPlan, framePlainText, packagePlainText, planPlainText, reviewPlainText } = require('../services/agentStoryboardDispatchService');

const strategy = { image: { providerId: 'site-a', providerName: '站点甲', model: 'image-a', ratio: '9:16', quantity: 2 }, mode: 'manual', budgetLimit: 50, currency: 'CNY', retryLimit: 1 };
const run = {
  id: 'run-phase7', canvasId: 'canvas-phase7',
  storyboardPlan: {
    coverageArtifactVersionId: 'coverage-v1',
    shots: [
      { id: 'shot-001', order: 1, timeRange: '0 至 3 秒', durationSeconds: 3, scene: '夜间桌面', framing: '中景', cameraMovement: '轻推', visual: '角色护住产品', action: '护住产品', transition: '动作衔接', firstFrame: '角色伸手', lastFrame: '产品完整可见', immutableConstraints: ['产品真实'] },
      { id: 'shot-002', order: 2, timeRange: '3 至 6 秒', durationSeconds: 3, scene: '夜间桌面', framing: '特写', cameraMovement: '固定', visual: '产品特写', action: '产品停留', transition: '定格', firstFrame: '产品进入中央', lastFrame: 'Logo 清楚', immutableConstraints: ['包装不变'] }
    ],
    assets: [
      { id: 'character-a', type: 'character', name: '主角', immutableConstraints: ['外观一致'] },
      { id: 'product-a', type: 'product', name: '真实产品', immutableConstraints: ['包装文字不得变化'] }
    ],
    shotAssignments: [
      { shotId: 'shot-001', assetIds: ['character-a', 'product-a'] },
      { shotId: 'shot-002', assetIds: 'product-a' }
    ]
  }
};
const visualPackage = { artifactVersionId: 'visual-package-v1' };
const selected = [
  { artifactVersionId: 'character-v1', metadata: { assetId: 'character-a', assetType: 'character', assetName: '主角', previewUrl: '/character.png' } },
  { artifactVersionId: 'product-v1', metadata: { assetId: 'product-a', assetType: 'product', assetName: '真实产品', previewUrl: '/product.png' } }
];

test('阶段7为每个镜头建立首尾帧任务并绑定阶段6锁定版本', () => {
  const plan = buildStoryboardDispatchPlan(run, strategy, visualPackage, selected);
  assert.equal(plan.shotCount, 2);
  assert.equal(plan.frameTaskCount, 4);
  assert.equal(plan.totalImages, 8);
  assert.equal(plan.blockedReason, '');
  assert.ok(plan.inputVersionIds.includes('visual-package-v1'));
  assert.ok(plan.frameTasks.every(task => task.references.length > 0));
  assert.match(plan.frameTasks[0].prompt, /只使用已锁定资产版本/);
  assert.match(plan.frameTasks[0].prompt, /产品包装、Logo、文字、规格和颜色/);
});

test('阶段7缺少任一锁定资产版本时保持阻塞', () => {
  const plan = buildStoryboardDispatchPlan(run, strategy, visualPackage, selected.filter(item => item.metadata.assetId !== 'product-a'));
  assert.match(plan.blockedReason, /缺少阶段六锁定资产版本/);
  assert.match(plan.blockedReason, /真实产品/);
});

test('阶段7用户可见说明是纯文字并明确一次提交与阶段边界', () => {
  const plan = buildStoryboardDispatchPlan(run, strategy, visualPackage, selected);
  assert.match(planPlainText(plan), /最终只提交一次审核/);
  assert.match(framePlainText({ order: 1, frameRoleLabel: '首帧', timeRange: '0 至 3 秒', framing: '中景', cameraMovement: '轻推', frameDescription: '角色伸手', testSubstitute: true }), /不是模型生成结果/);
  const groups = [{ order: 1, timeRange: '0 至 3 秒' }];
  assert.match(reviewPlainText(groups), /只提交一次/);
  assert.match(packagePlainText(groups), /没有进入声音或视频生成阶段/);
});

test('阶段7界面包含真实任务、状态节点、中断、分镜单选、故事板和调度图', () => {
  const frontend = fs.readFileSync(path.resolve(__dirname, '../../frontend/smart-canvas-core/smart-canvas-core.js'), 'utf8');
  const css = fs.readFileSync(path.resolve(__dirname, '../../frontend/smart-canvas-core/smart-canvas-core.css'), 'utf8');
  assert.match(frontend, /storyboard-dispatch\/prepare/);
  assert.match(frontend, /storyboard-dispatch\/authorize/);
  assert.match(frontend, /canvas_kind:'agent-storyboard-frames'/);
  assert.match(frontend, /storyboard-dispatch\/attempts\/register/);
  assert.match(frontend, /data-agent-frame-choice/);
  assert.match(frontend, /一次提交并锁定阶段七全部成果/);
  assert.match(frontend, /phase7-cancel/);
  assert.match(frontend, /smart-agent-dispatch-preview/);
  assert.match(css, /smart-agent-storyboard-frame-row/);
  assert.match(css, /font-size:17px/);
});
