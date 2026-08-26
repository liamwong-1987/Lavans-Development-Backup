const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { buildShotVideoPlan, classifyShotVideoFailure, buildSafePromptRevision, planPlainText, taskPlainText, reviewPlainText, packagePlainText } = require('../services/agentShotVideoProductionService');

const run = { id: 'run-phase9', canvasId: 'canvas-phase9' };
const packages = [1, 2].map(order => ({
  shotId: `shot-00${order}`, order, timeRange: `${(order - 1) * 5} 至 ${order * 5} 秒`, durationSeconds: 5,
  videoPrompt: `镜头 ${order} 提示词`, videoRatio: '9:16',
  firstFrame: { artifactVersionId: `first-${order}`, previewUrl: `/first-${order}.png` },
  lastFrame: { artifactVersionId: `last-${order}`, previewUrl: `/last-${order}.png` }
}));
const inputs = {
  phase8Package: { artifactVersionId: 'phase8-package-v1', approvalState: 'locked', validityState: 'current', metadata: { shotProductionPackages: packages } },
  shotArtifacts: packages.map((item, index) => ({ artifactVersionId: `phase8-shot-${index + 1}`, approvalState: 'locked', validityState: 'current', metadata: { shotId: item.shotId } })),
  strategy: { mode: 'manual', retryLimit: 1, video: { providerId: 'old-site', providerName: '旧站点', model: 'old-model', ratio: '9:16' } }
};
const requested = { providerId: 'apimart', providerName: 'APIMART', model: 'seedance-2.0', resolution: '480P', durationSeconds: 4, ratio: '9:16', retryLimit: 1, unitRate: 0.0825 };

test('阶段9用锁定阶段8输入建立最低成本逐镜视频计划', () => {
  const plan = buildShotVideoPlan(run, inputs, requested);
  assert.equal(plan.quantity, 2);
  assert.equal(plan.model, 'seedance-2.0');
  assert.equal(plan.resolution, '480P');
  assert.equal(plan.durationSeconds, 4);
  assert.equal(plan.estimatedCost, 0.66);
  assert.equal(plan.tasks[0].firstFrame.artifactVersionId, 'first-1');
  assert.equal(plan.tasks[0].lastFrame.artifactVersionId, 'last-1');
});

test('阶段9拒绝未锁定阶段8制作包和缺首尾帧输入', () => {
  assert.throws(() => buildShotVideoPlan(run, { ...inputs, phase8Package: { ...inputs.phase8Package, approvalState: 'approved' } }, requested), /锁定阶段八/);
  const brokenPackages = [{ ...packages[0], lastFrame: null }, packages[1]];
  assert.throws(() => buildShotVideoPlan(run, { ...inputs, phase8Package: { ...inputs.phase8Package, metadata: { shotProductionPackages: brokenPackages } } }, requested), /缺少锁定首帧或尾帧/);
});

test('阶段9用户文字明确批次确认、单镜重试和停止边界', () => {
  const plan = buildShotVideoPlan(run, inputs, requested);
  assert.match(planPlainText(plan), /批量付费前必须集中确认一次/);
  assert.match(taskPlainText(plan.tasks[0], 'failed'), /只重试当前镜头/);
  const groups = plan.tasks.map(task => ({ ...task, options: [{ candidateNumber: 1 }], selected: { candidateNumber: 1 } }));
  assert.match(reviewPlainText(plan, groups), /只提交一次/);
  assert.match(packagePlainText(groups), /没有进入阶段十/);
});

test('阶段9计划固定每镜头独立任务且重试上限不超过三次', () => {
  const plan = buildShotVideoPlan(run, inputs, { ...requested, retryLimit: 99 });
  assert.equal(plan.retryLimit, 3);
  assert.notEqual(plan.tasks[0].id, plan.tasks[1].id);
  assert.equal(plan.tasks[0].sourceArtifactVersionId, 'phase8-shot-1');
});

test('阶段9画布界面包含可播放单选、单镜重做、停止和一次提交', () => {
  const frontend = fs.readFileSync(path.resolve(__dirname, '../../frontend/smart-canvas-core/smart-canvas-core.js'), 'utf8');
  const css = fs.readFileSync(path.resolve(__dirname, '../../frontend/smart-canvas-core/smart-canvas-core.css'), 'utf8');
  const routes = fs.readFileSync(path.resolve(__dirname, '../routes/canvasRoutes.js'), 'utf8');
  assert.match(frontend, /data-agent-shot-video-choice/);
  assert.match(frontend, /data-agent-video-recovery/);
  assert.match(frontend, /data-agent-video-revision-preview/);
  assert.match(frontend, /data-agent-video-fee-confirm/);
  assert.match(frontend, /中断当前视频任务/);
  assert.match(frontend, /一次提交并锁定阶段九全部镜头/);
  assert.match(routes, /shot-videos\/retry\/authorize/);
  assert.match(routes, /阶段九已一次提交并锁定；已经停止/);
  assert.match(css, /smart-agent-shot-video-options video/);
});

test('阶段9区分中转站故障和内容安全拦截', () => {
  assert.equal(classifyShotVideoFailure('HTTP 502 中转站网关超时'), 'provider');
  assert.equal(classifyShotVideoFailure('因特定内容政策被拦截，可能涉及公众人物'), 'policy');
  assert.equal(classifyShotVideoFailure('用户已取消', 'cancelled'), 'interrupted');
  assert.equal(classifyShotVideoFailure('模型生成失败'), 'generation');
});

test('阶段9提示词安全修改保留原词并只追加用户勾选规则', () => {
  const revision = buildSafePromptRevision('产品在夜景中缓慢旋转。', ['identity', 'copyright']);
  assert.equal(revision.originalPrompt, '产品在夜景中缓慢旋转。');
  assert.match(revision.proposedPrompt, /完全虚构的成年角色/);
  assert.match(revision.proposedPrompt, /受版权保护的音乐/);
  assert.deepEqual(revision.issueCodes, ['identity', 'copyright']);
  assert.throws(() => buildSafePromptRevision('原提示词', []), /至少勾选一个/);
});

test('阶段9部分审核用纯文字说明失败镜头并阻止提前一次提交', () => {
  const plan = buildShotVideoPlan(run, inputs, requested);
  const groups = [
    { ...plan.tasks[0], options: [{ candidateNumber: 1 }] },
    { ...plan.tasks[1], options: [], requiresPromptRevision: true }
  ];
  const content = reviewPlainText(plan, groups);
  assert.match(content, /尚无可审核视频/);
  assert.match(content, /需要先确认提示词修改再重做/);
  assert.doesNotMatch(content, /JSON|\{|\}/);
});

test('阶段9受控测试入口只能在明确测试环境开放', () => {
  const routes = fs.readFileSync(path.resolve(__dirname, '../routes/canvasRoutes.js'), 'utf8');
  assert.match(routes, /CANVAS_AGENT_CONTROLLED_TEST/);
  assert.match(routes, /无费用测试替身只在受控测试服务中开放/);
  assert.match(routes, /替身不是模型生成结果/);
});
