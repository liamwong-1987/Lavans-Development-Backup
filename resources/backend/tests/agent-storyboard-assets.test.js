const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAgentRunService } = require('../services/agentRunService');
const { findAgentSkillRuntime } = require('../services/agentSkillRegistry');
const { createCanvasAgentFoundation } = require('../services/canvasAgentFoundation');
const { parseShotPlan, parseAssetLedger, validateCoverage } = require('../services/agentStoryboardAssetService');

const directions = JSON.stringify({ directions: [
  { id: 'a', title: '深夜守护', hook: '小怪物护住产品', characters: '青年与小怪物', conflict: '青年准备放弃', reversal: '小怪物是在提醒', productPlacement: '产品始终在桌面', ending: '青年重新行动' },
  { id: 'b', title: '清晨信号', hook: '蓝色包装接住晨光', characters: '青年', conflict: '青年睡过头', reversal: '产品旁便签提醒日程', productPlacement: '产品作为桌面视觉锚点', ending: '青年准时出门' },
  { id: 'c', title: '桌面侦探', hook: '小怪物寻找蓝色线索', characters: '小怪物', conflict: '线索中断', reversal: '线索来自产品反光', productPlacement: '调查中展示产品', ending: '谜底揭开' }
] });

const script = `毛星球三十秒竖屏短视频剧本\n\n夜晚室内。青年准备关掉台灯，小怪物冲进画面护住桌上的蓝色毛星球产品。青年问它为什么捣乱。小怪物把“再坚持一步”的便签推到青年面前，产品包装始终完整可见。青年理解提醒，重新打开工作页面。最后青年完成任务，小怪物松一口气，两人一起看向产品。字幕写着：每一次重新出发，都有毛星球陪你。总时长三十秒。`;

const shots = { shots: [
  { id: 'shot-001', order: 1, timeRange: '0 至 6 秒', durationSeconds: 6, scene: '夜晚室内桌面', framing: '中景转近景', cameraMovement: '缓慢推进', visual: '青年伸手关闭台灯，小怪物冲入画面护住蓝色产品', action: '青年停手，小怪物张开双臂', dialogue: '青年：你又要捣乱吗？', narration: '', subtitle: '', sound: '急促脚步声', transition: '直接切换', firstFrame: '青年与台灯同框', lastFrame: '小怪物护住产品', requiredAssets: [{ type: 'character', name: '青年' }, { type: 'character', name: '小怪物' }, { type: 'product', name: '毛星球产品' }, { type: 'scene', name: '夜晚室内桌面' }], immutableConstraints: ['产品包装文字不得改变'] },
  { id: 'shot-002', order: 2, timeRange: '6 至 18 秒', durationSeconds: 12, scene: '夜晚室内桌面', framing: '近景与特写', cameraMovement: '轻微横移', visual: '小怪物推来写着再坚持一步的便签，产品完整可见', action: '青年读便签后重新打开工作页面', dialogue: '', narration: '再坚持一步', subtitle: '再坚持一步', sound: '轻柔提示音', transition: '动作衔接', firstFrame: '小怪物拿着便签', lastFrame: '青年重新工作', requiredAssets: [{ type: 'character', name: '青年' }, { type: 'character', name: '小怪物' }, { type: 'product', name: '毛星球产品' }, { type: 'scene', name: '夜晚室内桌面' }, { type: 'prop', name: '再坚持一步便签' }], immutableConstraints: ['不得增加产品功效'] },
  { id: 'shot-003', order: 3, timeRange: '18 至 30 秒', durationSeconds: 12, scene: '夜晚室内桌面', framing: '双人中景转产品特写', cameraMovement: '先拉远后定格', visual: '青年完成任务，小怪物松一口气，两人看向产品', action: '青年合上电脑并微笑', dialogue: '', narration: '', subtitle: '每一次重新出发，都有毛星球陪你', sound: '温暖收束音乐', transition: '定格结束', firstFrame: '青年敲下最后一个键', lastFrame: '真实产品与品牌名停留', requiredAssets: [{ type: 'character', name: '青年' }, { type: 'character', name: '小怪物' }, { type: 'product', name: '毛星球产品' }, { type: 'scene', name: '夜晚室内桌面' }, { type: 'logo', name: '毛星球 Logo' }], immutableConstraints: ['Logo 不得重绘', '产品包装不得变化'] }
] };

const assets = { assets: [
  { id: 'character-youth', type: 'character', name: '青年', usage: '三个镜头中的主角', sourceMaterialIds: [], anchorFacts: ['青年加班'], immutableConstraints: ['同一人物外观保持一致'] },
  { id: 'character-monster', type: 'character', name: '小怪物', usage: '三个镜头中的提醒者', sourceMaterialIds: [], anchorFacts: ['原创小怪物'], immutableConstraints: ['颜色与轮廓保持一致'] },
  { id: 'product-maoxingqiu', type: 'product', name: '毛星球产品', usage: '品牌视觉锚点', sourceMaterialIds: ['brand-md'], anchorFacts: ['包装为蓝色', '品牌名为毛星球'], immutableConstraints: ['包装文字不得改变', '不得虚构功效'] },
  { id: 'scene-night-desk', type: 'scene', name: '夜晚室内桌面', usage: '全部镜头场景', sourceMaterialIds: [], anchorFacts: ['夜晚室内'], immutableConstraints: ['空间连续'] },
  { id: 'prop-note', type: 'prop', name: '再坚持一步便签', usage: '第二镜头剧情道具', sourceMaterialIds: [], anchorFacts: ['文字为再坚持一步'], immutableConstraints: ['便签文字不变'] },
  { id: 'logo-maoxingqiu', type: 'logo', name: '毛星球 Logo', usage: '结尾品牌展示', sourceMaterialIds: ['brand-md'], anchorFacts: ['品牌名为毛星球'], immutableConstraints: ['不得重绘或变形'] }
], shotAssignments: [
  { shotId: 'shot-001', assetIds: ['character-youth', 'character-monster', 'product-maoxingqiu', 'scene-night-desk'] },
  { shotId: 'shot-002', assetIds: ['character-youth', 'character-monster', 'product-maoxingqiu', 'scene-night-desk', 'prop-note'] },
  { shotId: 'shot-003', assetIds: ['character-youth', 'character-monster', 'product-maoxingqiu', 'scene-night-desk', 'logo-maoxingqiu'] }
] };

async function readyService(canvasId) {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-phase4-'));
  const foundation = createCanvasAgentFoundation({ rootPath: path.join(outputRoot, 'foundation') });
  const service = createAgentRunService({ outputRoot, findAgentSkillRuntime, findAgentDependencyRuntime: id => ({ runtime: { id, codeAvailable: true, databaseAvailable: false } }), foundation });
  let run = service.createRun({ canvasId, skillId: 'create-product-microstory-seedance', brief: '真实品牌测试', questionnaireAnswers: { productName: '毛星球', facts: '包装为蓝色', prohibitedClaims: '不得虚构功效', audience: '年轻消费者', durationSeconds: '30 秒', aspectRatio: '9:16' }, materials: [{ id: 'brand-md', name: '品牌资料.md', kind: 'text', previewText: '包装为蓝色' }] });
  run = await service.executeInitProject(run.id);
  run = await service.executeProductResearch(run.id);
  const phase2 = foundation.status({ canvasId, mode: 'legacy-history' }).projection.history.artifacts;
  for (const type of ['product-fact-lock', 'research-boundary']) {
    const node = phase2.find(item => item.artifactType === type);
    foundation.approvalGate.requestReview(node.artifactVersionId); foundation.approvalGate.approve(node.artifactVersionId); foundation.approvalGate.lock(node.artifactVersionId);
  }
  await service.executeCreativeDirections(run.id, { generateStoryText: async () => ({ text: directions, providerId: 'controlled-test', model: 'test-model' }) });
  service.selectCreativeDirection(run.id, 'a');
  run = await service.executeScriptDraft(run.id, { generateStoryText: async () => ({ text: script, providerId: 'controlled-test', model: 'test-model' }) });
  service.scriptVersions.submitVersion(run.id, run.scriptReview.activeVersionId);
  return { service, foundation, runId: run.id, outputRoot };
}

function lock(foundation, artifactVersionId) {
  foundation.approvalGate.requestReview(artifactVersionId); foundation.approvalGate.approve(artifactVersionId); foundation.approvalGate.lock(artifactVersionId);
}

test('阶段4依次生成纯文字分镜、资产台账和覆盖校验，每项一次提交后锁定', async t => {
  if (!findAgentSkillRuntime('create-product-microstory-seedance')?.runtime) return t.skip('真实 Skill 当前不可用');
  const { service, foundation, runId, outputRoot } = await readyService('phase4-canvas');
  let modelCalls = 0;
  let run = await service.executeStructuredShots(runId, { generateStoryText: async () => { modelCalls += 1; return { text: JSON.stringify(shots), providerId: 'controlled-test', model: 'test-model' }; } });
  assert.equal(run.storyboardPlan.shots.length, 3);
  let node = foundation.status({ canvasId: 'phase4-canvas', mode: 'legacy-history' }).projection.history.artifacts.find(item => item.artifactType === 'structured-shot-plan');
  assert.match(node.contentPreview, /结构化分镜脚本/);
  assert.doesNotMatch(node.contentPreview, /^\s*[\[{]/);
  lock(foundation, node.artifactVersionId); run = service.syncStoryboardPlan(runId); assert.equal(run.storyboardPlan.status, 'shots-locked');
  run = await service.executeAssetLedger(runId, { generateStoryText: async () => { modelCalls += 1; return { text: JSON.stringify(assets), providerId: 'controlled-test', model: 'test-model' }; } });
  assert.equal(run.storyboardPlan.assets.length, 6);
  node = foundation.status({ canvasId: 'phase4-canvas', mode: 'legacy-history' }).projection.history.artifacts.find(item => item.artifactType === 'asset-anchor-ledger');
  assert.match(node.contentPreview, /角色、产品|资产锚点台账/);
  assert.match(node.contentPreview, /品牌资料\.md/);
  assert.doesNotMatch(node.contentPreview, /参考资料：brand-md/);
  lock(foundation, node.artifactVersionId); run = service.syncStoryboardPlan(runId); assert.equal(run.storyboardPlan.status, 'assets-locked');
  run = service.executeStoryboardCoverage(runId);
  assert.equal(run.storyboardPlan.coverage.valid, true);
  assert.equal(modelCalls, 2, '覆盖校验必须是本地确定性检查，不额外调用模型');
  node = foundation.status({ canvasId: 'phase4-canvas', mode: 'legacy-history' }).projection.history.artifacts.find(item => item.artifactType === 'shot-asset-coverage');
  assert.match(node.contentPreview, /校验结果：通过/);
  lock(foundation, node.artifactVersionId); run = service.syncStoryboardPlan(runId);
  assert.equal(run.storyboardPlan.status, 'locked');
  assert.equal(run.stages.find(item => item.id === 'shot-and-asset-plan').status, 'completed');
  assert.equal(fs.existsSync(path.join(outputRoot, 'agent-projects', run.project.slug, 'production', 'shot-list.md')), true);
  assert.equal(fs.existsSync(path.join(outputRoot, 'agent-projects', run.project.slug, 'assets', 'asset-manifest.json')), true);
});

test('阶段4拒绝时长错误、无效资产引用和不完整覆盖', () => {
  const wrongDuration = JSON.parse(JSON.stringify(shots)); wrongDuration.shots[2].durationSeconds = 11;
  assert.throws(() => parseShotPlan(wrongDuration, 30), /总时长/);
  const plan = parseShotPlan(shots, 30);
  const brokenAssets = JSON.parse(JSON.stringify(assets)); brokenAssets.shotAssignments[0].assetIds.push('missing-asset');
  assert.throws(() => parseAssetLedger(brokenAssets, plan), /不存在的资产/);
  assert.throws(() => parseAssetLedger(assets, plan, ['another-material']), /不存在的上传资料/);
  const parsed = parseAssetLedger(assets, plan);
  parsed.shotAssignments[2].assetIds = parsed.shotAssignments[2].assetIds.filter(id => id !== 'logo-maoxingqiu');
  const report = validateCoverage(plan, parsed);
  assert.equal(report.valid, false);
  assert.match(report.issues.join('\n'), /毛星球 Logo/);
});
