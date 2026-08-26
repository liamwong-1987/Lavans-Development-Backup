const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const createCanvasRouter = require('../routes/canvasRoutes');
const { loadAgentSkillRegistry, findAgentSkill } = require('../services/agentSkillRegistry');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function canvasJsonHashes(canvasDir) {
  return new Map(fs.readdirSync(canvasDir)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => [name, sha256(path.join(canvasDir, name))]));
}

function assertHashesEqual(before, after) {
  assert.deepEqual([...after.entries()], [...before.entries()], '回归测试不得修改隔离画布 JSON');
}

const fixtureOutputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lavans-canvas-roundtrip-'));
const fixtureCanvasesDir = path.join(fixtureOutputRoot, 'canvases');
fs.mkdirSync(fixtureCanvasesDir, { recursive: true });
fs.writeFileSync(path.join(fixtureCanvasesDir, 'canvas-roundtrip-stored.json'), JSON.stringify({
  id: 'canvas-roundtrip-stored',
  title: 'Stored roundtrip fixture',
  nodes: [{ id: 'stored-prompt', type: 'prompt', x: 10, y: 20, text: 'stored' }],
  connections: [],
  created_at: 100,
  updated_at: 200,
  deleted_at: null
}, null, 2));
process.once('exit', () => fs.rmSync(fixtureOutputRoot, { recursive: true, force: true }));

const router = createCanvasRouter({ outputRoot: fixtureOutputRoot });
const hooks = router.__canvasWorkspaceTestHooks;
assert(hooks && typeof hooks.normalizeWorkspace === 'function', '缺少画布归一化测试钩子');
assert.equal(hooks.canvasHasVersionConflict({ updated_at: 200 }, { base_updated_at: 100 }), true, '旧版本保存必须触发冲突');
assert.equal(hooks.canvasHasVersionConflict({ updated_at: 200 }, { workspace: { base_updated_at: 200 } }), false, '同版本保存不应冲突');
assert.equal(hooks.canvasHasVersionConflict({ updated_at: 200 }, {}), false, '未携带旧版号的兼容客户端不应被误拦截');
assert.equal(hooks.isCanvasTaskTerminal('completed'), true, 'completed 必须是终态');
assert.equal(hooks.isCanvasTaskTerminal('succeeded'), true, 'succeeded 必须是终态，避免成功任务永久残留');
assert.equal(hooks.isCanvasTaskTerminal('running'), false, 'running 不能被当作终态');
assert.deepEqual(hooks.serializableCanvasTask({ id: 'task-1', status: 'running', type: 'video', upstreamTaskId: 'upstream-1', controller: new AbortController(), createdAt: 1, updatedAt: 2 }), {
  id: 'task-1', status: 'running', type: 'video', providerId: '', model: '', size: '', outputUrl: '', error: '', result: null, archivedAsset: null,
  upstreamTaskId: 'upstream-1', backend: '', promptId: '', createdAt: 1, updatedAt: 2, cancelled: false, interrupted: false, upstreamCancelSupported: false, upstreamCancelled: false
}, '任务持久化不得写入 AbortController，也不能丢失上游任务 ID');

const skillRegistry = loadAgentSkillRegistry();
assert.deepEqual(skillRegistry.errors, [], `Skill 注册表不得存在清单错误：${JSON.stringify(skillRegistry.errors)}`);
const registeredSkill = skillRegistry.skills.find(skill => skill.id === 'create-product-microstory-seedance');
assert(registeredSkill, '首个视频 Skill 必须出现在动态注册表中');
assert.equal(registeredSkill.displayName, '放入产品直出短视频', 'Skill 必须使用源文件声明的正式显示名');
assert.equal(registeredSkill.ui?.title, '放入产品直出短视频', '卡片标题必须与真实 Skill 一致');
assert.equal(JSON.stringify(registeredSkill.ui).includes('皮克斯'), false, '可见 Skill 配置不得残留演示品牌名');
assert.equal(registeredSkill.status, 'partial', '依赖未接齐前必须明确标记为部分可用');
assert.equal(registeredSkill.stages.length, 9, '首个视频 Skill 必须公开九个可见阶段');
assert.deepEqual(registeredSkill.stages.map(stage => stage.title), ['产品事实与项目', '抖音微故事成稿', '分镜与资产台账', '角色 · 场景 · 产品 · 道具资产', 'Seedance 2.0 逐镜提示词', '制作包校验', '等待视频 CLI', '视频生成与验收', '最终回执'], '九阶段必须忠实映射源 Skill，不得混入演示阶段');
const registeredQuestions = registeredSkill.ui?.questionGroups?.flatMap(group => group.questions || []) || [];
assert.equal(registeredQuestions.length, 11, '问询必须分别覆盖产品事实、证据、禁说项、受众、发布平台、CTA 和制作偏好');
assert.deepEqual(registeredQuestions.filter(question => question.type === 'text').map(question => question.id), ['productName', 'facts'], '只有无法预设的产品名称和真实事实允许直接文字输入');
assert.deepEqual(registeredQuestions.filter(question => question.type === 'multiple').map(question => question.id), ['evidence', 'prohibitedClaims', 'audience', 'platforms'], '证据、禁说项、受众和平台必须使用多选');
assert.equal(registeredQuestions.filter(question => question.type !== 'text').every(question => Array.isArray(question.choices) && question.choices.length >= 2), true, '所有可枚举问题必须提供可勾选选项');
assert.equal(registeredSkill.ui?.questionGroups?.flatMap(group => group.questions || []).filter(question => question.required !== true).every(question => String(question.emptyValue || '').trim()), true, '可跳过问题必须声明安全缺省值，不能让 Agent 虚构产品事实');
assert.equal(new Set(registeredSkill.stages.map(stage => stage.id)).size, 9, 'Skill 阶段 id 必须唯一');
assert.equal(registeredSkill.stages.some(stage => stage.costClass === 'potentially-paid' && stage.approvalRequired !== true), false, '潜在付费阶段必须要求审批');
assert.equal(registeredSkill.source.available, true, '已审核 Skill 的入口脚本必须存在');
assert.equal(Object.hasOwn(registeredSkill.source, 'path'), false, 'Skill API 不得泄露本机绝对路径');
assert.equal(findAgentSkill('pixar-video-ad')?.skill?.id, registeredSkill.id, '旧 Skill id 必须解析到新的注册表 id');
const storyDependency = registeredSkill.dependencies.find(item => item.id === 'douyin-tiktok-story-skill');
assert.equal(storyDependency?.status, 'database-missing', '故事 Skill 代码已接入但数据库缺失时，必须显示精确依赖状态');

const fixture = {
  id: 'roundtrip-fixture',
  title: 'Roundtrip fixture',
  nodes: [
    { id: 'prompt-1', type: 'prompt', x: 1, y: 2, w: 321, h: 123, text: 'A' },
    { id: 'prompt-2', type: 'prompt', x: 3, y: 4, text: 'B' },
    { id: 'prompt-group', type: 'promptGroup', x: 5, y: 6, w: 480, h: 260, items: ['prompt-1', 'prompt-2'], laterAddedFeature: { enabled: true } },
    { id: 'loop-1', type: 'loop', x: 7, y: 8, w: 410, h: 390, count: 7, mode: 'parallel', showPrompt: true, imageInput: true, videoInput: true, loopStart: 2, imageBatchSize: 4, videoBatchSize: 2, variablePrompt: 'v', fixedPrompt: 'f', laterAddedFeature: { keep: 'yes' } },
    { id: 'minimax-1', type: 'minimax', x: 9, y: 10, w: 980, h: 720, minimaxEngine: 'runninghub', workflow: 'MiniMax_H3.json', minimaxRunningHubWorkflowId: 'workflow-1', rhPayment: 'wallet', duration: 8.5, aspectRatio: '9:16', megapixels: 0.8, selectedSegmentId: 'seg-1', playhead: 1.5, segments: [{ id: 'seg-1', prompt: 'shot', refs: [{ url: '/canvas-output/ref.png' }], result: { url: '/canvas-output/result.mp4' }, results: [{ url: '/canvas-output/result.mp4' }] }], materials: [{ url: '/canvas-output/material.mp4' }], inputs: ['prompt-1'], videoStatus: 'succeeded', laterAddedLayout: { preview: 240 } },
    { id: 'smart-source', type: 'smart-image', x: 11, y: 12, images: [] },
    { id: 'smart-target', type: 'smart-image', x: 13, y: 14, images: [], inputNodeIds: ['smart-source'] },
    { id: 'smart-history', type: 'smart-image', x: 15, y: 16, images: [], historyFor: 'smart-source', isHistoryGroup: true },
    { id: 'agent-stage-1', type: 'smart-agent-stage', x: 17, y: 18, w: 304, h: 194, title: '需求分析', agentRunId: 'agent-run-1', agentStageIndex: 0, agentOutput: 'visible output', taskState: { status: 'running', label: '执行中' }, laterAddedAgentField: { keep: true } },
    { id: 'agent-script-version-v1', type: 'smart-agent-script-version', x: 321, y: 18, w: 360, h: 210, title: '剧本 V1', agentRunId: 'agent-run-1', scriptVersionId: 'version-v1', parentVersionId: '', versionStatus: 'draft', source: 'skill', changeScopes: [], providerId: '', model: '', laterAddedVersionField: { keep: 'version' } },
    { id: 'agent-script-revision-a1', type: 'smart-agent-script-revision', x: 705, y: 18, w: 330, h: 188, title: 'AI 修订', agentRunId: 'agent-run-1', agentRevisionAttemptId: 'attempt-a1', agentRevisionOperationId: 'operation-a1', baseVersionId: 'version-v1', revisionStatus: 'running', providerId: 'configured-provider', model: 'configured-model', changeScopes: ['hook', 'ending'], laterAddedRevisionField: { keep: 'revision' } }
  ],
  connections: [
    { id: 'legacy-dup', from: 'prompt-1', to: 'loop-1', kind: 'flow', customEdgeData: { keep: true } },
    { id: 'legacy-dup', from: 'smart-source', to: 'smart-target' },
    { id: 'legacy-dup', from: 'smart-source', to: 'smart-history' },
    { from: 'prompt-group', to: 'minimax-1', kind: 'custom-kind' }
  ],
  viewport: { x: 10, y: 20, scale: 1.25 },
  agentRuns: [{ id: 'agent-run-1', skillId: 'pixar-video-ad', skillTitle: '皮克斯 3D 卡通广告', questionnaireAnswers: { product: '毛球星球', ratio: '9:16（竖屏）' }, materials: [{ id: 'material-1', name: '产品实拍图.jpg', kind: 'image', url: '/canvas-assets/agent-materials/agent-test.jpg', size: 1234 }], brief: '一句话视频需求', status: 'running', nextStageIndex: 0, activeStageIndex: 0, stageNodeIds: ['agent-stage-1'], events: [{ id: 'event-1', message: '节点已创建', createdAt: 123 }], origin: { x: 100, y: 200 }, laterAddedRunField: { keep: true } }],
  activeAgentRunId: 'agent-run-1'
};

const normalized = hooks.normalizeWorkspace(fixture);
assert.equal(normalized.nodes.length, fixture.nodes.length, '合法节点不得被过滤');

const byId = new Map(normalized.nodes.map(node => [node.id, node]));
assert.equal(byId.get('prompt-1').w, 321, '普通节点宽度必须保留');
assert.equal(byId.get('prompt-1').h, 123, '普通节点高度必须保留');
assert.deepEqual(byId.get('prompt-group').items, ['prompt-1', 'prompt-2'], '提示词分组成员必须保留');
assert.deepEqual(byId.get('prompt-group').laterAddedFeature, { enabled: true }, '提示词分组后加字段必须保留');
assert.deepEqual(byId.get('agent-script-version-v1').laterAddedVersionField, { keep: 'version' }, '剧本版本节点的后加字段必须保留');
assert.equal(byId.get('agent-script-version-v1').scriptVersionId, 'version-v1', '剧本版本节点标识必须保留');
assert.deepEqual(byId.get('agent-script-revision-a1').laterAddedRevisionField, { keep: 'revision' }, 'AI 修订节点的后加字段必须保留');
assert.equal(byId.get('agent-script-revision-a1').agentRevisionAttemptId, 'attempt-a1', 'AI 修订尝试标识必须保留');

const loop = byId.get('loop-1');
assert.equal(loop.count, 7);
assert.equal(loop.loopCount, 7);
assert.equal(loop.mode, 'parallel');
assert.equal(loop.loopMode, 'parallel');
assert.equal(loop.showPrompt, true);
assert.equal(loop.imageInput, true);
assert.equal(loop.videoInput, true);
assert.equal(loop.imageBatchSize, 4);
assert.equal(loop.videoBatchSize, 2);
assert.equal(loop.w, 410);
assert.equal(loop.h, 390);
assert.deepEqual(loop.laterAddedFeature, { keep: 'yes' }, '循环节点后加字段必须保留');

const minimax = byId.get('minimax-1');
assert.equal(minimax.workflow, 'MiniMax_H3.json');
assert.equal(minimax.minimaxRunningHubWorkflowId, 'workflow-1');
assert.equal(minimax.rhPayment, 'wallet');
assert.equal(minimax.videoStatus, 'succeeded');
assert.deepEqual(minimax.segments, fixture.nodes[4].segments, 'MiniMax 分镜数据必须保留');
assert.deepEqual(minimax.materials, fixture.nodes[4].materials, 'MiniMax 素材数据必须保留');
assert.deepEqual(minimax.laterAddedLayout, { preview: 240 }, 'MiniMax 后加字段必须保留');

const agentStage = byId.get('agent-stage-1');
assert(agentStage, 'AGENT 阶段节点不得被后端过滤');
assert.equal(agentStage.agentRunId, 'agent-run-1');
assert.equal(agentStage.taskState.status, 'running');
assert.deepEqual(agentStage.laterAddedAgentField, { keep: true }, 'AGENT 节点后加字段必须保留');
assert.equal(normalized.agentRuns.length, 1, 'AGENT Run 必须随画布持久化');
assert.equal(normalized.agentRuns[0].activeStageIndex, 0, 'AGENT 当前阶段必须保留');
assert.equal(normalized.agentRuns[0].skillId, 'pixar-video-ad', 'AGENT Run 必须保留 Skill 绑定');
assert.deepEqual(normalized.agentRuns[0].questionnaireAnswers, fixture.agentRuns[0].questionnaireAnswers, 'AGENT Run 必须保留问询答案');
assert.deepEqual(normalized.agentRuns[0].materials, fixture.agentRuns[0].materials, 'AGENT Run 必须保留上传资料');
assert.deepEqual(normalized.agentRuns[0].laterAddedRunField, { keep: true }, 'AGENT Run 后加字段必须保留');
assert.equal(normalized.activeAgentRunId, 'agent-run-1');
const normalizedBlockedRun = hooks.normalizeWorkspace({
  nodes: [], connections: [],
  agentRuns: [{ id: 'agent-run-blocked', status: 'blocked', nextStageIndex: 1, activeStageIndex: null, blockedStageIndex: 1 }],
  activeAgentRunId: 'agent-run-blocked'
});
assert.equal(normalizedBlockedRun.agentRuns[0].status, 'blocked', '后端阻塞状态必须随画布持久化，不能被降级成暂停');

const connectionIds = normalized.connections.map(connection => connection.id);
assert.equal(new Set(connectionIds).size, connectionIds.length, '连线 ID 必须永久唯一');
assert.deepEqual(normalized.connections.map(connection => connection.kind), ['flow', 'input', 'history', 'custom-kind']);
assert.deepEqual(normalized.connections[0].customEdgeData, { keep: true }, '后加连线字段必须保留');

const normalizedAgain = hooks.normalizeWorkspace(normalized);
assert.deepEqual(normalizedAgain.connections.map(connection => connection.id), connectionIds, '连线 ID 二次读取必须稳定');
assert.deepEqual(normalizedAgain.connections.map(connection => connection.kind), normalized.connections.map(connection => connection.kind), '连线语义二次读取必须稳定');

const normalizedMeta = hooks.normalizeCanvasRecord({
  ...fixture,
  kind: 'smart',
  project: 'project-custom',
  owner: 'owner-custom',
  color: '#123456',
  pinned: true,
  created_at: 111,
  updated_at: 222,
  board_x: 33,
  board_y: 44
}, fixture.id);
assert.equal(normalizedMeta.kind, 'smart');
assert.equal(normalizedMeta.project, 'project-custom');
assert.equal(normalizedMeta.owner, 'owner-custom');
assert.equal(normalizedMeta.color, '#123456');
assert.equal(normalizedMeta.pinned, true);
assert.equal(normalizedMeta.created_at, 111);
assert.equal(normalizedMeta.updated_at, 222);
assert.equal(normalizedMeta.board_x, 33);
assert.equal(normalizedMeta.board_y, 44);

const canvasesDir = fixtureCanvasesDir;
const beforeHashes = canvasJsonHashes(canvasesDir);

function invokeRoute(routePath, method, req) {
  const layer = router.stack.find(item => item.route?.path === routePath && item.route.methods?.[method]);
  assert(layer, `缺少路由 ${method.toUpperCase()} ${routePath}`);
  const result = { statusCode: 200, payload: null };
  const res = {
    status(code) { result.statusCode = code; return this; },
    json(payload) { result.payload = payload; return this; }
  };
  layer.route.stack.at(-1).handle(req, res);
  return result;
}

for (const [routePath, method] of [
  ['/api/canvas/agent-skills', 'get'],
  ['/api/canvas/agent-skills/:skillId', 'get'],
  ['/api/canvas/agent-runs', 'get'],
  ['/api/canvas/agent-runs', 'post'],
  ['/api/canvas/agent-runs/:runId', 'get'],
  ['/api/canvas/agent-runs/:runId/stages/init-project/execute', 'post'],
  ['/api/canvas/agent-runs/:runId/stages/microstory/preflight', 'get'],
  ['/api/canvas/agent-runs/:runId/stages/microstory/execute', 'post'],
  ['/api/canvas/agent-runs/:runId/stages/microstory/review/initialize', 'post'],
  ['/api/canvas/agent-runs/:runId/stages/microstory/versions', 'get'],
  ['/api/canvas/agent-runs/:runId/stages/microstory/versions/:versionId', 'get'],
  ['/api/canvas/agent-runs/:runId/stages/microstory/versions/manual', 'post'],
  ['/api/canvas/agent-runs/:runId/stages/microstory/versions/:versionId/revise/preflight', 'get'],
  ['/api/canvas/agent-runs/:runId/stages/microstory/versions/:versionId/revise', 'post'],
  ['/api/canvas/agent-runs/:runId/stages/microstory/versions/:versionId/approve', 'post'],
  ['/api/canvas/agent-runs/:runId/stages/microstory/versions/:versionId/lock', 'post'],
  ['/api/canvas/agent-runs/:runId/stages/microstory/versions/:versionId/diff/:otherVersionId', 'get'],
  ['/api/canvas/agent-runs/:runId/stages/microstory/revision-attempts/:attemptId/cancel', 'post'],
  ['/api/canvas/agent-runs/:runId/dependencies/douyin-tiktok-story-skill/database', 'post'],
  ['/api/canvas/agent-runs/:runId/pause', 'post'],
  ['/api/canvas/agent-runs/:runId/resume', 'post'],
  ['/api/canvas/agent-runs/:runId/cancel', 'post'],
  ['/api/canvas/agent-runs/:runId/artifacts', 'get'],
  ['/api/canvas/agent-runs/:runId/artifacts/:artifactId/content', 'get'],
  ['/api/canvas/agent-materials', 'post'],
  ['/api/canvas/tasks/:taskId/cancel', 'post'],
  ['/api/canvas-image-tasks/:taskId/cancel', 'post'],
  ['/api/canvas-video/:taskId/cancel', 'post'],
  ['/api/canvas-comfy-tasks/:taskId/cancel', 'post']
]) {
  assert(router.stack.some(item => item.route?.path === routePath && item.route.methods?.[method]), `缺少任务中断路由 ${method.toUpperCase()} ${routePath}`);
}

const classicFrontend = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'canvas.js'), 'utf8');
const smartFrontend = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'smart-canvas-core', 'smart-canvas-core.js'), 'utf8');
const smartCss = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'smart-canvas-core', 'smart-canvas-core.css'), 'utf8');
const smartHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'smart-canvas-core', 'smart-canvas.html'), 'utf8');
const recolorFrontend = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'app.js'), 'utf8');
const recolorHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'recolor.html'), 'utf8');
for (const marker of ['openSharedAssetPicker', 'importSelectedSharedAssets', 'shareTaskAssets', '/api/canvas/recolor-bridge/import']) {
  assert.equal(recolorFrontend.includes(marker), false, `一键复色不得读取或写入画布素材：${marker}`);
}
for (const marker of ['shared-asset-modal', '从共享素材库选择', '选择共享模板图']) {
  assert.equal(recolorHtml.includes(marker), false, `一键复色不得显示画布共享入口：${marker}`);
}
assert.equal(router.stack.some(item => item.route?.path === '/api/canvas/recolor-bridge/import'), false, '后端不得存在复色与画布素材桥接路由');
for (const marker of ['output-task-cancel', 'cancelPendingOutputTask', 'resumeClassicCanvasComfyTask', '/api/canvas-comfy-tasks/${encodeURIComponent(taskId)}/cancel']) {
  assert(classicFrontend.includes(marker), `经典画布缺少可见任务控制：${marker}`);
}
for (const marker of ['smart-task-status-badge', 'data-smart-task-cancel', 'cancelSmartPendingNodeTasks', "task.taskType === 'comfy'"]) {
  assert(smartFrontend.includes(marker), `Smart 画布缺少可见任务控制：${marker}`);
}
for (const marker of ['SMART_AGENT_STAGES', 'smart-agent-stage', 'advanceSmartAgentRun', 'pauseSmartAgentRun', 'resumeSmartAgentRuns']) {
  assert(smartFrontend.includes(marker), `Smart 画布缺少 AGENT 可见执行骨架：${marker}`);
}
for (const marker of ['SMART_AGENT_SKILLS', 'renderSmartAgentSkillCatalog', 'renderSmartAgentQuestionnaire', 'finishSmartAgentQuestionnaire', 'questionnaireAnswers', 'uploadSmartAgentMaterials', 'smartAgentMaterialPreview']) {
  assert(smartFrontend.includes(marker), `Smart 画布缺少可扩展 Skill 问询层：${marker}`);
}
for (const marker of ['smartAgentQuestionUsesTextInput', 'selectedValues', "question?.type === 'multiple'", 'has-choice-question']) {
  assert(smartFrontend.includes(marker), `Smart 画布缺少选项优先问询能力：${marker}`);
}
for (const marker of ['min-height:56px', 'align-items:flex-start', 'overflow-wrap:anywhere']) {
  assert(smartCss.includes(marker), `Smart 画布的大字体选项卡缺少自适应尺寸规则：${marker}`);
}
for (const marker of ['loadSmartAgentSkills', 'smartAgentSkillFromAdapter', '/api/canvas/agent-skills']) {
  assert(smartFrontend.includes(marker), `Smart 画布缺少动态 Skill 注册表接入：${marker}`);
}
for (const marker of ['backend-real-stage1', 'executeSmartAgentInitStage', 'smartAgentApplyBackendRun', '/api/canvas/agent-runs', 'smartAgentArtifactListHtml', '真实项目已创建']) {
  assert(smartFrontend.includes(marker), `Smart 画布缺少真实第一阶段接入：${marker}`);
}
for (const marker of ['smartAgentSyncExecutionStepNodes', '/stages/microstory/preflight', '确认后将发送']) {
  assert(smartFrontend.includes(marker), `Smart 画布缺少微故事可见执行标记：${marker}`);
}
for (const marker of ['smart-agent-script-version', 'smart-agent-script-revision', 'smartAgentSyncScriptReviewNodes', 'scriptVersionId', 'agentRevisionAttemptId']) {
  assert(smartFrontend.includes(marker), `Smart 画布缺少剧本版本/修订可见节点：${marker}`);
}
for (const marker of ['smartAgentScriptReview', 'smartAgentScriptContent', 'smartAgentRevisionScopes', 'data-agent-revision-scope', 'data-agent-script-manual', 'data-agent-script-ai', 'data-agent-script-submit', 'data-agent-script-review-check']) {
  assert(smartHtml.includes(marker), `Smart 画布缺少右侧剧本审核界面：${marker}`);
}
for (const marker of ['openSmartAgentScriptVersion', 'submitSmartAgentManualVersion', 'executeSmartAgentAiRevision', 'submitSmartAgentScriptVersion', 'cancelSmartAgentRevisionAttempt']) {
  assert(smartFrontend.includes(marker), `Smart 画布缺少剧本审核交互：${marker}`);
}
for (const marker of ['min-height:68px', 'font-size:14px', 'line-height:1.7']) {
  assert(smartCss.includes(marker), `剧本审核界面缺少大字体与自适应卡片规则：${marker}`);
}
for (const marker of ['smartAgentStoryDatabaseInput', 'installSmartAgentStoryDatabase', 'rightsConfirmed', '故事数据库']) {
  assert(smartFrontend.includes(marker), `Smart 画布缺少故事数据库安全安装入口：${marker}`);
}
for (const marker of ["stage?.readiness === 'blocked'", "run.status = 'blocked'", "blocked:'缺少依赖'", '真实执行已阻塞 · 未伪造任何产出']) {
  assert(smartFrontend.includes(marker), `Smart 画布缺少真实依赖阻塞保护：${marker}`);
}
assert.equal(smartFrontend.includes('皮克斯 3D 卡通广告'), false, 'Smart 画布可见配置不得残留演示 Skill 名称');

const skillListResponse = invokeRoute('/api/canvas/agent-skills', 'get', {});
assert.equal(skillListResponse.statusCode, 200, 'Skill 列表 API 必须可读');
const listedSkills = skillListResponse.payload?.skills || [];
const listedLegacySkill = listedSkills.find(skill => skill.id === 'create-product-microstory-seedance');
const listedEcommerceSkill = listedSkills.find(skill => skill.id === 'ecommerce-video-director-skill');
assert(listedLegacySkill, 'Skill 列表 API 必须保留旧内置视频 Skill');
assert(listedEcommerceSkill, 'Skill 列表 API 必须包含冻结的权威电商 Skill');
assert.equal(listedLegacySkill.stages?.length, 9, '旧内置 Skill 列表项必须带回九个可见阶段');
const legacySkillResponse = invokeRoute('/api/canvas/agent-skills/:skillId', 'get', { params: { skillId: 'pixar-video-ad' } });
assert.equal(legacySkillResponse.statusCode, 200, '旧 Skill id 详情 API 必须兼容');
assert.equal(legacySkillResponse.payload?.skill?.id, 'create-product-microstory-seedance');

const missingWorkspace = invokeRoute('/api/canvas/workspace', 'get', { query: { canvasId: 'canvas-that-does-not-exist' } });
assert.equal(missingWorkspace.statusCode, 404, '不存在的 Smart Canvas 必须返回 404，不能回退到默认画布');

const firstCanvasId = [...beforeHashes.keys()]
  .map(name => ({ name, record: JSON.parse(fs.readFileSync(path.join(canvasesDir, name), 'utf8')) }))
  .find(item => !item.record.deleted_at)?.name.replace(/\.json$/i, '');
assert(firstCanvasId, '缺少可用于冲突测试的未删除画布');
const staleSave = invokeRoute('/api/canvas/canvases/:canvasId', 'put', { params: { canvasId: firstCanvasId }, body: { base_updated_at: 1, nodes: [], connections: [] } });
assert.equal(staleSave.statusCode, 409, '过期的经典画布保存必须返回 409');
assert(staleSave.payload?.canvas?.id === firstCanvasId, '409 必须返回远端画布供前端处理');

let isolatedNodes = 0;
let isolatedConnections = 0;

for (const name of beforeHashes.keys()) {
  const raw = JSON.parse(fs.readFileSync(path.join(canvasesDir, name), 'utf8'));
  const roundtrip = hooks.normalizeWorkspace(raw);
  assert.equal(roundtrip.nodes.length, Array.isArray(raw.nodes) ? raw.nodes.length : 0, `${name}: 节点数量发生变化`);
  assert.equal(roundtrip.connections.length, Array.isArray(raw.connections) ? raw.connections.length : 0, `${name}: 连线数量发生变化`);
  assert.equal(new Set(roundtrip.connections.map(connection => connection.id)).size, roundtrip.connections.length, `${name}: 仍有重复连线 ID`);
  isolatedNodes += roundtrip.nodes.length;
  isolatedConnections += roundtrip.connections.length;
}

assertHashesEqual(beforeHashes, canvasJsonHashes(canvasesDir));
console.log(JSON.stringify({
  ok: true,
  fixtureNodes: normalized.nodes.length,
  fixtureConnections: normalized.connections.length,
  isolatedCanvasFiles: beforeHashes.size,
  isolatedNodes,
  isolatedConnections,
  isolatedFilesModified: 0
}, null, 2));
