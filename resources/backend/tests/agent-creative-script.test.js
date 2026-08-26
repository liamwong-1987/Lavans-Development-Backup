const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAgentRunService } = require('../services/agentRunService');
const { findAgentSkillRuntime } = require('../services/agentSkillRegistry');
const { createCanvasAgentFoundation } = require('../services/canvasAgentFoundation');
const { parseCreativeDirections, validateScript } = require('../services/agentCreativeScriptService');

function input(canvasId) {
  return {
    canvasId, skillId: 'create-product-microstory-seedance', brief: '为毛星球制作30秒竖屏原创短视频',
    questionnaireAnswers: {
      productName: '毛星球', facts: '包装为蓝色。产品用于品牌展示。', prohibitedClaims: '不得虚构功效。不得修改包装文字。',
      audience: '年轻消费者', platforms: '抖音', durationSeconds: '30 秒', aspectRatio: '9:16（竖屏）', visualStyle: '温暖原创风格', characterDirection: '小怪物角色'
    },
    materials: [{ id: 'brand-md', name: '品牌资料.md', originalName: '品牌资料.md', kind: 'text', extension: '.md', mime: 'text/markdown', size: 80, previewText: '品牌名：毛星球\n包装为蓝色\n不得虚构功效', archiveEntries: [] }]
  };
}

const directionsResponse = JSON.stringify({ directions: [
  { id: 'warm', title: '深夜守护', hook: '小怪物冲进画面护住蓝色产品', characters: '小怪物与加班青年', conflict: '青年准备放弃今日计划', reversal: '小怪物不是捣乱而是在提醒', productPlacement: '产品作为桌面行动信号自然出现', ending: '青年重新出发，小怪物松一口气', productionNotes: '一人一角色，一个室内场景' },
  { id: 'funny', title: '误会快递', hook: '小怪物抱错蓝色包裹', characters: '小怪物与快递员', conflict: '双方追逐确认归属', reversal: '包裹原来就是给小怪物的品牌礼物', productPlacement: '拆包时完整展示产品', ending: '两人相视一笑', productionNotes: '门口单场景' },
  { id: 'mystery', title: '蓝色线索', hook: '桌面突然出现蓝色光点', characters: '青年与小怪物侦探', conflict: '寻找光点来源', reversal: '光点来自产品包装反射', productPlacement: '调查过程自然完成细节展示', ending: '谜底揭开并回扣品牌名', productionNotes: '桌面微距与两个角色' }
] });

const scriptResponse = `毛星球三十秒竖屏短视频剧本\n\n项目定位\n用一个温暖的小误会展示品牌与角色关系。\n\n人物\n加班青年一名，小怪物一只。\n\n场景\n夜晚室内桌面。\n\n零至三秒\n画面：青年伸手准备关掉台灯，小怪物突然冲入画面，双手护住桌上的蓝色产品。\n青年：你又要捣乱吗？\n音效：急促脚步声。\n\n三至十二秒\n画面：青年试图拿走产品，小怪物认真摇头，并把写着“再坚持一步”的便签推到他面前。产品包装始终完整可见，不改变任何文字。\n\n十二至二十二秒\n画面：青年看到便签愣住，重新打开工作页面。小怪物把产品摆正，示意它只是提醒行动。\n青年：原来你是在等我完成今天的计划。\n\n二十二至三十秒\n画面：青年完成任务，小怪物松一口气。两人一起看向桌面上的毛星球产品。\n字幕：每一次重新出发，都有毛星球陪你。\n结尾：品牌名与真实产品画面停留两秒。\n\n时长估算\n三十秒。`;

test('阶段3从方向选择到纯文字剧本一次提交锁定，缺故事库也不伪造调研', async t => {
  const runtime = findAgentSkillRuntime('create-product-microstory-seedance')?.runtime;
  if (!runtime || !fs.existsSync(runtime.entryPath)) return t.skip('真实 Skill 当前不可用');
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-agent-phase3-'));
  const foundation = createCanvasAgentFoundation({ rootPath: path.join(outputRoot, 'foundation') });
  const service = createAgentRunService({
    outputRoot, findAgentSkillRuntime,
    findAgentDependencyRuntime: id => ({ runtime: { id, codeAvailable: true, databaseAvailable: false, status: 'database-missing' } }),
    foundation
  });
  const created = service.createRun(input('phase3-canvas'));
  await service.executeInitProject(created.id);
  await service.executeProductResearch(created.id);
  const phase2 = foundation.status({ canvasId: 'phase3-canvas', mode: 'legacy-history' }).projection.history.artifacts;
  for (const type of ['product-fact-lock', 'research-boundary']) {
    const node = phase2.find(item => item.artifactType === type);
    foundation.approvalGate.requestReview(node.artifactVersionId);
    foundation.approvalGate.approve(node.artifactVersionId);
    foundation.approvalGate.lock(node.artifactVersionId);
  }
  let modelCalls = 0;
  const generated = await service.executeCreativeDirections(created.id, { generateStoryText: async () => { modelCalls += 1; return { text: directionsResponse, providerId: 'controlled-test', model: 'test-model' }; } });
  assert.equal(generated.creativeScript.storyResearchUsed, false);
  assert.equal(generated.creativeScript.directions.length, 3);
  const choiceNode = foundation.status({ canvasId: 'phase3-canvas', mode: 'legacy-history' }).projection.history.artifacts.find(node => node.artifactType === 'creative-directions');
  assert.equal(choiceNode.reviewOptions.length, 3);
  assert.match(choiceNode.contentPreview, /深夜守护/);
  const selected = service.selectCreativeDirection(created.id, 'warm');
  assert.equal(selected.creativeScript.selectedDirectionId, 'warm');
  assert.equal(foundation.status({ canvasId: 'phase3-canvas', mode: 'legacy-history' }).projection.history.artifacts.find(node => node.artifactType === 'selected-creative-direction').locked, true);
  const scripted = await service.executeScriptDraft(created.id, { generateStoryText: async () => { modelCalls += 1; return { text: scriptResponse, providerId: 'controlled-test', model: 'test-model' }; } });
  assert.equal(scripted.scriptReview.versions.length, 1);
  assert.equal(scripted.scriptReview.versions[0].status, 'awaiting-review');
  const originalHash = scripted.scriptReview.versions[0].contentHash;
  const manual = service.scriptVersions.createManualVersion(created.id, { baseVersionId: 'script-v001', content: scriptResponse.replace('急促脚步声', '轻快脚步声'), operationId: 'manual-v2' });
  assert.equal(manual.scriptReview.versions.length, 2);
  assert.equal(service.scriptVersions.diffVersions(created.id, 'script-v001', 'script-v002').changedSections > 0, true);
  const locked = service.scriptVersions.submitVersion(created.id, 'script-v002');
  assert.equal(locked.scriptReview.lockedVersionId, 'script-v002');
  assert.equal(locked.scriptReview.versions.find(item => item.id === 'script-v001').contentHash, originalHash);
  assert.equal(modelCalls, 2);
});

test('程序格式剧本和不完整方向会被拒绝且不形成可用产物', () => {
  assert.throws(() => parseCreativeDirections('{"directions":[{"title":"只有一个"}]}'), /3 到 6/);
  assert.throws(() => validateScript('{"title":"程序格式","scene":"内容"}'.repeat(10)), /纯文字/);
});
