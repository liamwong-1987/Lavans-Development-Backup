'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '../../..');
const html = fs.readFileSync(path.join(repoRoot, 'resources/frontend/smart-canvas-core/smart-canvas.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'resources/frontend/smart-canvas-core/smart-canvas-core.css'), 'utf8');
const source = fs.readFileSync(path.join(repoRoot, 'resources/frontend/smart-canvas-core/smart-canvas-core.js'), 'utf8');
const routes = fs.readFileSync(path.join(repoRoot, 'resources/backend/routes/canvasRoutes.js'), 'utf8');
const chatService = fs.readFileSync(path.join(repoRoot, 'resources/backend/services/agentSessionChatService.js'), 'utf8');

function sourceBetween(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.notEqual(start, -1, `缺少源码起点：${startText}`);
  assert.notEqual(end, -1, `缺少源码终点：${endText}`);
  return source.slice(start, end);
}

function renderMediaReceiptFixture({images, type = 'native-image', status = 'succeeded', nodeStatus = 'completed', expanded = false}) {
  const receiptSource = sourceBetween('function smartAgentMediaReceiptHtml', 'function bindSmartAgentMediaReceiptGroups');
  const toolRun = {id: 'tool-media-fixture', nodeId: 'node-media-fixture', type, status};
  const context = {
    nodes: [{
      id: toolRun.nodeId,
      images,
      taskState: {status: nodeStatus},
      agentNative: {workspaceScope: 'canvas-agent', agentSessionId: 'agent-session-fixture', toolRunId: toolRun.id}
    }],
    smartAgentActiveSession: {id: 'agent-session-fixture'},
    smartAgentExpandedMediaReceipts: new Set(expanded ? [toolRun.id] : []),
    escapeAttr: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'),
    escapeHtml: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  };
  vm.runInNewContext(`${receiptSource}\nglobalThis.renderMediaReceipt = smartAgentMediaReceiptHtml;`, context);
  return context.renderMediaReceipt(toolRun);
}

function renderRoundReceiptFixture({kind = 'image', count = 10, statuses = [], expanded = false}) {
  const receiptSource = sourceBetween('function smartAgentMediaReceiptHtml', 'function smartAgentSessionMessageHtml');
  const roundId = 'round-media-fixture';
  const stageId = kind === 'video' ? 'videos' : 'images';
  const items = Array.from({length: count}, (_, index) => ({
    itemId: `${kind}-${index + 1}`,
    stageId,
    kind,
    status: statuses[index] || 'succeeded',
    toolRunId: `tool-${kind}-${index + 1}`,
    nodeId: `node-${kind}-${index + 1}`
  }));
  const toolRuns = items.map(item => ({
    id: item.toolRunId,
    nodeId: item.nodeId,
    type: `native-${kind}`,
    status: item.status,
    error: item.status === 'failed' ? 'fixture failed' : ''
  }));
  const nodes = items.map((item, index) => ({
    id: item.nodeId,
    images: item.status === 'succeeded' ? [{kind, url: `/canvas-output/round-${kind}-${index + 1}.${kind === 'video' ? 'mp4' : 'png'}`}] : [],
    taskState: {status: item.status === 'succeeded' ? 'completed' : item.status},
    agentNative: {workspaceScope: 'canvas-agent', agentSessionId: 'agent-session-fixture', toolRunId: item.toolRunId}
  }));
  const round = {roundId, status: 'running', stages: [{stageId, label: kind === 'video' ? '视频成片' : '图片资产'}], items};
  const context = {
    nodes,
    smartAgentActiveSession: {
      id: 'agent-session-fixture',
      toolRuns,
      currentNodeRefs: items.map(item => ({nodeId: item.nodeId, toolRunId: item.toolRunId, workspaceScope: 'canvas-agent'}))
    },
    smartAgentExpandedMediaReceipts: new Set(expanded ? [`${roundId}:${stageId}:${kind}`] : []),
    escapeAttr: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'),
    escapeHtml: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  };
  vm.runInNewContext(`${receiptSource}\nglobalThis.renderRoundReceipt = smartAgentGenerationRoundReceiptHtml;`, context);
  return context.renderRoundReceipt(round);
}

test('M5A：composer 模型按钮和顶部智能体设置打开各自视图', () => {
  assert.match(source, /smartAgentResourcePicker\.onclick[\s\S]*?openSmartAgentSettings\('models'\)/);
  assert.match(source, /smartAgentSettingsToggle\.onclick[\s\S]*?openSmartAgentSettings\('agent'\)/);
  assert.match(html, /id="smartAgentResourcePicker"[^>]+title="选择 LLM、图片、视频和音频模型"/);
});

test('U6：当前会话标题就地编辑并通过持久化路由同步历史列表', () => {
  const titleFlow = sourceBetween('function beginSmartAgentTitleEdit', 'function smartAgentHistoryStatusLabel');

  assert.match(titleFlow, /contenteditable['"],['"]plaintext-only/);
  assert.match(titleFlow, /event\.key === 'Enter'[\s\S]*?\.blur\(\)/);
  assert.match(titleFlow, /addEventListener\('blur'/);
  assert.match(titleFlow, /method:'PATCH'/);
  assert.match(titleFlow, /\/api\/canvas\/agent-sessions\/\$\{encodeURIComponent\(sessionId\)\}/);
  assert.match(titleFlow, /smartAgentActiveSession\s*=\s*session/);
  assert.match(titleFlow, /smartAgentSessionHistory\s*=\s*smartAgentSessionHistory\.map/);
  assert.match(routes, /router\.patch\('\/api\/canvas\/agent-sessions\/:sessionId'/);
  assert.match(routes, /renameSession\(req\.params\.sessionId/);
  assert.match(source, /ensureSmartAgentSession\(\{createIfMissing:false\}\)\.then\(\(\) => renderSmartAgentDrawer\(\)\)/);
  assert.match(html, /smart-canvas-core\.js[^"']*u6=20260826-session-title/);
});

test('M5A：设置只使用 AgentSession，并提供自动媒体及图片视频规格', () => {
  const settings = sourceBetween('function smartAgentSettingsStorageKey', 'async function syncSmartAgentFoundationProjection');

  assert.match(settings, /name="autoGenerateMedia"/);
  assert.match(settings, /\['1K','2K','4K'\]/);
  assert.match(settings, /\['480p','720p','1080p'\]/);
  assert.match(settings, /name="imageResolution"/);
  assert.match(settings, /name="videoResolution"/);
  assert.match(settings, /name="chatProviderId"/);
  assert.match(settings, /name="chatModel"/);
  assert.match(settings, /文字对话/);
  assert.match(settings, /下一条消息立即生效/);
  assert.match(settings, /\/api\/canvas\/agent-sessions\/\$\{encodeURIComponent\(session\.id\)\}\/status/);

  assert.doesNotMatch(settings, /\/api\/canvas\/agent-runs/);
  assert.doesNotMatch(settings, /smartAgentLegacyReadOnlyNotice/);
  assert.doesNotMatch(settings, /budgetLimit|fallbackEnabled|fallbackProviderId|fallbackModel|积分|预算|备用模型/);
});

test('M5A：LLM 绑定读取当前 Session 已保存值，不静默退回主 Provider', () => {
  const binding = sourceBetween('function smartAgentExactChatBinding', 'function smartAgentResponseRequestKey');
  assert.match(binding, /smartAgentStoredSettings\(\)/);
  assert.match(binding, /chatProviderId/);
  assert.match(binding, /chatModel/);
  assert.match(binding, /smartAgentResolvedProviderId\('chat'/);
  assert.match(binding, /smartAgentResolvedModel\('chat'/);
});

test('M5A：已发送附件只从 composer 消失，聊天记录和 Skill 资产仍保留', () => {
  const collections = sourceBetween('function renderSmartAgentMaterialCollections', 'async function smartAgentSessionRequest');
  const attachments = sourceBetween('function smartAgentSessionAttachments', 'function smartAgentSessionOutboxKey');
  assert.match(source, /function smartAgentPendingMaterials\(\)/);
  assert.match(collections, /const pendingMaterials\s*=\s*smartAgentPendingMaterials\(\)/);
  assert.match(collections, /smartAgentMaterialDrafts\.innerHTML\s*=\s*pendingMaterials/);
  assert.match(collections, /smartAgentWorkspaceMaterials[\s\S]*?smartAgentMaterials/);
  assert.match(attachments, /smartAgentPendingMaterials\(\)/);
  assert.match(source, /message\?\.attachments[\s\S]*?smartAgentMaterialChipHtml/);
});

test('U4：加号选择和拖放共用附件上传入口，发送前后都保留可见文件卡片', () => {
  const upload = sourceBetween('async function uploadSmartAgentMaterials', 'function smartAgentNeedsStoryDatabase');
  const bindings = sourceBetween('if(smartAgentMaterialPicker)', 'if(smartAgentMaterialPreviewClose)');

  assert.match(html, /id="smartAgentMaterialDrafts"[\s\S]*?id="smartAgentQuestionInput"/);
  assert.match(bindings, /smartAgentMaterialPicker\.onclick[\s\S]*?smartAgentMaterialInput\?\.click\(\)/);
  assert.match(bindings, /smartAgentMaterialInput\?\.addEventListener\('change',[\s\S]*?uploadSmartAgentMaterials\(smartAgentMaterialInput\.files\)/);
  assert.match(bindings, /addEventListener\('drop',[\s\S]*?uploadSmartAgentMaterials\(event\.dataTransfer\?\.files \|\| \[\]\)/);
  assert.match(upload, /smartAgentMaterials\.push\([\s\S]*?renderSmartAgentQuestionnaire\(\)/);
  assert.match(css, /\.smart-agent-material-drafts[\s\S]*?\.smart-agent-material-chip/);
});

test('M8S：电商 Skill 使用独立展示名与图片封面，不改真实 Skill ID', () => {
  const presentation = sourceBetween('const SMART_AGENT_SKILL_PRESENTATIONS', 'let SMART_AGENT_SKILLS');
  const icon = sourceBetween('function smartAgentSkillIconHtml', 'function smartAgentSkillFromAdapter');
  const coverPath = path.join(repoRoot, 'resources/frontend/smart-canvas-core/assets/ecommerce-video-skill-cover.webp');

  assert.match(presentation, /'ecommerce-video-director-skill'[\s\S]*?title:\s*'电商视频'/);
  assert.match(presentation, /coverAsset:\s*'\/smart-canvas-core\/assets\/ecommerce-video-skill-cover\.webp'/);
  assert.match(icon, /presentation\?\.coverAsset/);
  assert.match(icon, /<img class="smart-agent-skill-cover"/);
  assert.equal(fs.existsSync(coverPath), true);
  assert.match(source, /id:String\(adapter\.id\)[\s\S]*?title:String\(presentation\.title/);
  assert.match(source, /assetId:skill\.id[\s\S]*?kind:'agent-skill'/);
  assert.match(css, /\.smart-agent-skill-card-thumb img[^}]*object-fit:cover/);
});

test('M8S：Skill 推荐只在空会话显示，卡片随一条消息发送后从 composer 清空', () => {
  const landing = sourceBetween('function renderSmartAgentLanding', 'function smartAgentQuestionGroups');
  const composer = sourceBetween('function renderSmartAgentComposerSkill', 'function renderSmartAgentSkillComposition');
  const submit = sourceBetween('async function submitSmartAgentChatMessage', 'function enterSmartAgentWorkspace');
  const message = sourceBetween('function smartAgentSessionMessageHtml', 'function renderSmartAgentQuestionnaire');

  assert.match(html, /id="smartAgentSkillPicker"/);
  assert.match(landing, /smartAgentSkillPicker\.hidden\s*=\s*smartAgentHasSentUserMessage\(\)/);
  assert.match(composer, /smartAgentSkillById\(smartAgentStagedSkillId\)/);
  assert.match(submit, /smartAgentSkillAttachment\(stagedSkill\)/);
  assert.match(submit, /smartAgentStagedSkillId\s*=\s*''/);
  assert.match(message, /attachment\?\.kind\s*===\s*'agent-skill'/);
  assert.match(message, /smartAgentSkillMessageCardHtml/);
  assert.match(css, /\.smart-agent-chat-skill-card/);
});

test('M8：普通单选立即前进，其他、多选和文本仍等待手动提交', () => {
  const handler = sourceBetween("smartAgentQuestionOptions?.addEventListener('click'", 'if(smartAgentQuestionContinue)');
  assert.match(handler, /if\(!isMultiple\s*&&\s*value\s*!==\s*'__custom__'\)/);
  assert.match(handler, /advanceSmartAgentStructuredQuestion\(\)/);
  assert.match(handler, /advanceSmartAgentQuestionnaire\(\)/);
});

test('M5A：未选 Skill 的普通聊天进入 AgentSession respond，显式绑定 Provider 和模型', () => {
  const submit = sourceBetween('async function submitSmartAgentChatMessage', 'function enterSmartAgentWorkspace');
  const respond = sourceBetween('async function requestSmartAgentResponse', 'function queueSmartAgentResponse');

  assert.match(submit, /else\s*\{[\s\S]*?queueSmartAgentResponse\(triggerMessage,\{videoAnalysisConfirmed\}\)[\s\S]*?\}/);
  assert.match(respond, /\/api\/canvas\/agent-sessions\/\$\{encodeURIComponent\(session\.id\)\}\/respond/);
  assert.match(respond, /const binding\s*=\s*smartAgentExactChatBinding\(\)/);
  assert.match(respond, /JSON\.stringify\(\{requestId:[\s\S]*?\.\.\.binding/);
  assert.match(source, /return\s*\{providerId:provider\.id,model\}/);

  assert.match(routes, /router\.post\('\/api\/canvas\/agent-sessions\/:sessionId\/respond'/);
  assert.match(chatService, /const providerId\s*=\s*identifier\(String\(input\.providerId/);
  assert.match(chatService, /const model\s*=\s*text\(input\.model/);
});

test('M8：LLM 结构化提问在持续右栏渲染真实选项卡，整组提交后继续同一 Session', () => {
  const landing = sourceBetween('function renderSmartAgentLanding', 'function smartAgentQuestionGroups');
  const messages = sourceBetween('function smartAgentSessionMessageHtml', 'function renderSmartAgentQuestionnaire');
  const submit = sourceBetween('async function submitSmartAgentChatMessage', 'function enterSmartAgentWorkspace');
  const append = sourceBetween('async function appendSmartAgentSessionMessage', 'function smartAgentExactChatBinding');

  assert.match(chatService, /name:\s*STRUCTURED_QUESTION_TOOL_NAME/);
  assert.match(chatService, /STRUCTURED_QUESTION_TOOL_NAME\s*=\s*'ask_user_questions'/);
  assert.match(messages, /message\?\.structuredQuestion/);
  assert.match(source, /data-agent-structured-question/);
  assert.match(source, /smart-agent-structured-question-count/);
  assert.match(landing, /renderSmartAgentStructuredQuestionComposer\(\)/);
  assert.match(source, /function currentSmartAgentStructuredQuestion/);
  assert.match(source, /function advanceSmartAgentStructuredQuestion/);
  assert.match(source, /structuredAnswer:/);
  assert.match(append, /structuredAnswer/);
  assert.match(submit, /currentSmartAgentStructuredQuestion\(\)[\s\S]*?advanceSmartAgentStructuredQuestion\(\)/);
  assert.match(source, /smartAgentQuestionOptions\?\.addEventListener\('click'[\s\S]*?currentSmartAgentInteractiveQuestion\(\)/);
  assert.doesNotMatch(source, /parseStructuredQuestionFromMarkdown|inferStructuredQuestionFromText/);
});

test('U1：Skill 首次发送先要求精确 Session 身份，结构化问题仍可切到同 Session 自由交流', () => {
  const ensure = sourceBetween('async function ensureSmartAgentSession', 'function closeSmartAgentHeadPanels');
  const append = sourceBetween('async function appendSmartAgentSessionMessage', 'function smartAgentExactChatBinding');
  const respond = sourceBetween('async function requestSmartAgentResponse', 'function queueSmartAgentResponse');
  const submit = sourceBetween('async function submitSmartAgentChatMessage', 'function enterSmartAgentWorkspace');

  assert.match(html, /id="smartAgentQuestionModeToggle"/);
  assert.match(html, /id="smartAgentConversationInput"/);
  assert.match(ensure, /requiredSkillId/);
  assert.match(ensure, /smartAgentActiveSession\.skillId\s*===\s*requestedSkillId/);
  assert.match(ensure, /session\?\.id\s*===\s*sourceSessionId/);
  assert.match(ensure, /smartAgentStableRequestId\(`create-\$\{sourceSessionId\s*\|\|\s*'empty'\}`\)/);
  assert.match(append, /requiredSkillId/);
  assert.match(submit, /appendSmartAgentUserTurn\(\{[\s\S]*?requiredSkillId:activeSkillId/);
  assert.match(respond, /conversationOnly/);
  assert.match(respond, /selectedSkillId/);
  assert.match(source, /function submitSmartAgentQuestionChatMessage/);
  assert.match(source, /smartAgentQuestionComposerMode\s*===\s*'chat'/);
  assert.match(chatService, /requestedSkillId\s*!==\s*String\(initialSession\.skillId/);
  assert.match(chatService, /conversationOnly\s*\?\s*\[\]\s*:\s*AGENT_TOOLS/);
  assert.match(html, /smart-canvas-core\.css\?[^"']*u1=20260826-skill-flow-chat/);
  assert.match(html, /smart-canvas-core\.js\?[^"']*u1=20260826-skill-flow-chat/);
});

test('M5B：媒体工具先授权后建普通节点，并且提交后只恢复同一任务', () => {
  const execute = sourceBetween('async function executeSmartAgentMediaExecution', 'function queueSmartAgentMediaExecutions');
  const respond = sourceBetween('async function requestSmartAgentResponse', 'function queueSmartAgentResponse');

  assert.match(respond, /payload\?\.mediaExecutions[\s\S]*?queueSmartAgentMediaExecutions\(payload\.mediaExecutions\)/);
  assert.match(execute, /\/authorization`/);
  assert.match(execute, /\/authorization\/\$\{encodeURIComponent\(authorizationId\)\}\/consume/);
  assert.match(execute, /AgentNativeNodeBridge\.execute\(bound\)[\s\S]*?AgentNativeNodeBridge\.recover\(bound\)/);
  assert.match(execute, /\['running','remote-unknown','submitting'\][\s\S]*?AgentNativeNodeBridge\.recover\(bound\)/);
  assert.match(execute, /confirmSmartAgentMediaExecution\(execution\)/);
  assert.match(execute, /execution\.authorizationId[\s\S]*?execution\.authorizationState\s*!==\s*'consumed'/);
  assert.match(execute, /function smartAgentMediaExecutionFromToolRun[\s\S]*?workspaceScope:'canvas-agent'/);
  assert.match(execute, /function smartAgentRunSettingsForExecution[\s\S]*?videoProvider[\s\S]*?provider_id/);
  assert.match(execute, /function syncSmartAgentNativeNodeRunSettings[\s\S]*?node\.runSettings/);
  assert.match(source, /ensureSmartAgentSession[\s\S]*?resumeSmartAgentMediaExecutions\(smartAgentActiveSession\)/);
  assert.match(source, /确认后才会创建画布占位节点并提交真实模型/);
});

test('M5E-9：GenerationRound 手动只确认一次，自动模式和后续阶段直接由服务端推进', () => {
  const roundConfirm = sourceBetween('function confirmSmartAgentGenerationRound', 'async function cancelSmartAgentPreparedMediaExecution');
  const roundFlow = sourceBetween('function smartAgentGenerationRoundRequestId', 'async function requestSmartAgentResponse');
  const respond = sourceBetween('async function requestSmartAgentResponse', 'function queueSmartAgentResponse');

  assert.match(roundConfirm, /确认本轮生成/);
  assert.match(roundConfirm, /本轮只确认一次，后续就绪阶段不再逐项弹窗/);
  assert.match(roundFlow, /currentRound\.mode\s*===\s*'manual'[\s\S]*?confirmSmartAgentGenerationRound\(currentRound\)/);
  assert.match(roundFlow, /const endpoint\s*=\s*action\s*===\s*'authorize'\s*\?\s*'authorization'\s*:\s*action/);
  assert.match(roundFlow, /generation-rounds\/\$\{encodeURIComponent\(currentRound\.roundId\)\}\/\$\{endpoint\}/);
  assert.match(roundFlow, /smartAgentGenerationRoundRequest\(currentRound,'authorize'\)/);
  assert.match(roundFlow, /smartAgentGenerationRoundRequest\(currentRound,'advance'\)/);
  assert.match(roundFlow, /smartAgentGenerationRoundRequest\(currentRound,'cancel'\)/);
  assert.match(roundFlow, /if\(!approved\)\{[\s\S]*?smartAgentGenerationRoundRequest\(currentRound,'cancel'\)[\s\S]*?return cancelled;/);
  assert.doesNotMatch(roundFlow, /confirmSmartAgentMediaExecution\(/);
  assert.doesNotMatch(roundFlow, /smartAgentStoredValue|smartAgentStoreValue|localStorage|new Set/);

  assert.match(respond, /payload\?\.generationRound[\s\S]*?queueSmartAgentGenerationRound\(payload\.generationRound/);
});

test('M5E-9：每个就绪阶段批量 executeStage，刷新只从 Session Round 恢复且不限制任务数量', () => {
  const queue = sourceBetween('function resumeSmartAgentMediaExecutions', 'async function requestSmartAgentResponse');

  assert.match(queue, /session\?\.generationRounds/);
  assert.match(queue, /smartAgentMediaExecutionFromRoundItem/);
  assert.match(queue, /AgentNativeNodeBridge\.executeStage\(stageExecutions\)/);
  assert.match(queue, /Promise\.allSettled\(stageExecutions\.map\(execution\s*=>\s*window\.AgentNativeNodeBridge\.recover\(execution\)\)\)/);
  assert.match(queue, /refreshSmartAgentSessionById\(currentSession\.id\)/);
  assert.match(queue, /queueSmartAgentGenerationRound/);
  assert.doesNotMatch(queue, /\.slice\(0\s*,\s*1\)/);
  assert.doesNotMatch(queue, /new Set|localStorage|smartAgentStoredValue|smartAgentStoreValue/);
  assert.doesNotMatch(queue, /for\s*\([^)]*execution[^)]*\)\s*await\s+executeSmartAgentMediaExecution/);

  const questionnaire = sourceBetween('function renderSmartAgentQuestionnaire', 'async function submitSmartAgentChatMessage');
  assert.match(questionnaire, /smartAgentQuestionInput\.disabled\s*=\s*smartAgentMaterialUploadBusy\s*\|\|\s*smartAgentSessionMessageBusy/);
  assert.doesNotMatch(questionnaire, /smartAgentMediaExecutionQueue[\s\S]*?smartAgentQuestionInput\.disabled/);
});

test('M5C：选中 Agent 图片可绑定参考视频，完成媒体直接显示在聊天记录', () => {
  const respond = sourceBetween('async function requestSmartAgentResponse', 'function queueSmartAgentResponse');
  const messages = sourceBetween('function smartAgentSessionToolRunHtml', 'function renderSmartAgentQuestionnaire');

  assert.match(source, /function smartAgentSelectedReferenceImage[\s\S]*?agentNative\?\.kind\s*!==\s*'image'/);
  assert.match(respond, /selectedImageNodeId:selectedReference\.nodeId/);
  assert.match(source, /function smartAgentMediaExecutionFromToolRun[\s\S]*?sourceNodeId/);
  assert.match(messages, /function smartAgentMediaReceiptHtml[\s\S]*?<video[\s\S]*?<img/);
  assert.match(messages, /attachment\?\.kind\s*===\s*'agent-media-tool-run'/);
  assert.match(messages, /node\?\.taskState\?\.status\s*===\s*'completed'/);
  assert.match(messages, /mediaItems\.length\s*>\s*1/);
  assert.match(messages, /<details class="smart-agent-media-receipt smart-agent-media-receipt-group/);
  assert.match(messages, /\$\{escapeHtml\(label\)\}已生成 ×\$\{count\}/);
  assert.match(messages, /smart-agent-media-receipt-count/);
  assert.match(messages, /\+\$\{count\s*-\s*1\}/);
  assert.match(source, /function bindSmartAgentMediaReceiptGroups[\s\S]*?querySelectorAll\('\[data-agent-media-group\]'\)[\s\S]*?addEventListener\('toggle'/);
  assert.match(source, /smartAgentLandingMessages\.innerHTML\s*=\s*turns\.join\(''\)[\s\S]*?bindSmartAgentMediaReceiptGroups\(smartAgentLandingMessages\)/);
  assert.match(source, /smartAgentConversationMessages\.innerHTML\s*=\s*turns\.join\(''\)[\s\S]*?bindSmartAgentMediaReceiptGroups\(smartAgentConversationMessages\)/);
  assert.doesNotMatch(messages, /node\?\.images\)\s*\?\s*node\.images\[0\]/);
  assert.match(css, /\.smart-agent-media-receipt\s*\{[^}]*width:min\(100%,130px\)[^}]*max-width:100%/s);
  assert.match(css, /\.smart-agent-media-receipt\s*>\s*img,.smart-agent-media-receipt\s*>\s*video\s*\{[^}]*max-height:210px[^}]*object-fit:contain/s);
  assert.match(css, /\.smart-agent-media-receipt-collapsed\s*\{[^}]*width:min\(100%,130px\)/s);
  assert.match(css, /\.smart-agent-media-receipt-grid\s*\{[^}]*grid-template-columns:repeat\(2,minmax\(0,130px\)\)/s);
  assert.match(css, /\.smart-agent-media-receipt-stack[\s\S]*?\.smart-agent-media-receipt-count[\s\S]*?\.smart-agent-media-receipt-grid/);
  assert.match(messages, /<video[^>]*controls[^>]*preload="metadata"[^>]*playsinline/);
  assert.doesNotMatch(messages, /<video[^>]*autoplay/);
  assert.doesNotMatch(css, /\.smart-agent-landing-messages\s*\{[^}]*justify-content\s*:\s*flex-end/s);
  assert.match(css, /\.smart-agent-landing-messages\s*>\s*:first-child\s*\{[^}]*margin-top\s*:\s*auto/s);
});

test('M6：音频模型设置、原生节点恢复和聊天 WAV 播放器都走同一 AgentSession', () => {
  assert.match(source, /audioModels:\[\.\.\.new Set\(\(item\?\.audio_models/);
  assert.match(source, /name="audioProviderId"[\s\S]*?name="audioModel"[\s\S]*?name="audioVoice"[\s\S]*?name="audioFormat"/);
  assert.match(source, /smartAgentValidateMediaBinding\('audio',settingsValue\)/);
  assert.match(source, /async function pollCanvasAudio[\s\S]*?\/api\/canvas-audio-tasks\//);
  assert.match(source, /async function pollCanvasAudio[\s\S]*?for\(let i = 0; i < 900; i\+\+\)[\s\S]*?data\.status === 'succeeded'/);
  assert.match(source, /\['video','audio','comfy'\]\.includes\(task\.taskType\)/);
  assert.match(source, /task\.taskType === 'audio'[\s\S]*?pollCanvasAudio/);
  assert.match(source, /function smartAgentMediaExecutionFromToolRun[\s\S]*?\['image','video','audio'\]/);
  const rendered = renderMediaReceiptFixture({
    type: 'native-audio',
    images: [{url: '/canvas-output/agent-audio.wav', kind: 'audio'}]
  });
  assert.match(rendered, /<audio[^>]*agent-audio\.wav[^>]*controls/);
  assert.match(rendered, /音频已生成/);
  assert.match(css, /\.smart-agent-media-receipt\s*>\s*audio/);
});

test('M5D：同节点三图折叠为堆叠缩略图，展开显示全部结果；单视频仍可播放', () => {
  const images = [1, 2, 3].map(index => ({kind: 'image', url: `/canvas-output/fixture-${index}.png`}));
  const collapsed = renderMediaReceiptFixture({images});
  assert.match(collapsed, /<details[^>]*data-agent-media-group="tool-media-fixture"/);
  assert.doesNotMatch(collapsed, /<details[^>]*\sopen(?:\s|>)/);
  assert.match(collapsed, /图片已生成 ×3/);
  assert.match(collapsed, /smart-agent-media-receipt-count[^>]*>\+2</);
  assert.equal((collapsed.match(/smart-agent-media-receipt-thumb/g) || []).length, 3);

  const expanded = renderMediaReceiptFixture({images, expanded: true});
  assert.match(expanded, /<details[^>]*\sopen>/);

  const single = renderMediaReceiptFixture({images: images.slice(0, 1)});
  assert.match(single, /<figure[^>]*is-image is-succeeded/);
  assert.doesNotMatch(single, /smart-agent-media-receipt-group|\+0/);

  const video = renderMediaReceiptFixture({images: [{kind: 'video', url: '/canvas-output/fixture.mp4'}], type: 'native-video'});
  assert.match(video, /<video[^>]*controls[^>]*preload="metadata"[^>]*playsinline/);
  assert.doesNotMatch(video, /autoplay/);

  const external = renderMediaReceiptFixture({images: [{kind: 'image', url: 'https://example.com/forged.png'}]});
  assert.match(external, /smart-agent-media-receipt-placeholder/);
  assert.doesNotMatch(external, /<img/);
  assert.doesNotMatch(source, /turns\.push\(\.\.\.\(smartAgentActiveSession\?\.toolRuns\s*\|\|\s*\[\]\)\.map\(smartAgentSessionToolRunHtml\)\)/);
});

test('M5D：AGENT 右栏右键不冒泡到画布新增节点，同时保留系统原生菜单', () => {
  assert.match(source, /\[smartAgentDrawer, smartAgentToggle\][\s\S]*?addEventListener\('contextmenu',\s*event\s*=>\s*event\.stopPropagation\(\)\)/);
  assert.doesNotMatch(source, /smartAgentDrawer[^\n]*addEventListener\('contextmenu'[\s\S]{0,120}?preventDefault\(\)/);
});

test('M5E-10：Round 同阶段同类型的十个独立节点折叠为一个可信媒体组', () => {
  const grouped = renderRoundReceiptFixture({kind: 'image', count: 10});
  assert.match(grouped, /data-agent-media-group="round-media-fixture:images:image"/);
  assert.match(grouped, /data-agent-round-id="round-media-fixture"/);
  assert.match(grouped, /data-agent-stage-id="images"/);
  assert.match(grouped, /图片已生成 ×10/);
  assert.match(grouped, /smart-agent-media-receipt-count[^>]*>\+9</);
  assert.equal((grouped.match(/<img[^>]*data-agent-locate-node="node-image-/g) || []).length, 10);

  const messages = sourceBetween('function smartAgentMediaReceiptHtml', 'function renderSmartAgentQuestionnaire');
  assert.match(messages, /attachment\?\.kind\s*===\s*'agent-generation-round'/);
  assert.match(messages, /round\.items/);
  assert.match(messages, /currentNodeRefs[\s\S]*?toolRunId/);
  assert.doesNotMatch(messages, /nodes\.filter\([^)]*round|nodes\.forEach\([^)]*round/);
});

test('M5E-10：多视频可折叠、单视频保留 controls，状态原位投影且定位不写节点', () => {
  const groupedVideos = renderRoundReceiptFixture({kind: 'video', count: 3});
  assert.match(groupedVideos, /视频已生成 ×3/);
  assert.equal((groupedVideos.match(/<video[^>]*controls/g) || []).length, 3);

  const singleVideo = renderRoundReceiptFixture({kind: 'video', count: 1});
  assert.match(singleVideo, /<video[^>]*controls[^>]*preload="metadata"[^>]*playsinline/);
  assert.doesNotMatch(singleVideo, /data-agent-media-group=/);

  const partial = renderRoundReceiptFixture({kind: 'image', count: 3, statuses: ['succeeded', 'failed', 'cancelled']});
  assert.match(partial, /data-agent-media-state="partial"/);
  assert.match(partial, /图片部分完成 ×3/);

  const binding = sourceBetween('function smartAgentLocateMediaNode', 'function smartAgentSessionMessageHtml');
  assert.match(binding, /querySelectorAll\('\[data-agent-locate-node\]'\)/);
  assert.match(binding, /selectedId\s*=\s*node\.id[\s\S]*?render\(\)[\s\S]*?focusSmartAgentNode\(node\)/);
  assert.doesNotMatch(binding, /nodes\.push|saveCanvas|addNode|createNode/);
  assert.match(css, /\.smart-agent-media-receipt-item[^}]*max-width:130px/s);
  assert.match(css, /\.smart-agent-media-receipt-item\s*>\s*img,.smart-agent-media-receipt-item\s*>\s*video\s*\{[^}]*max-height:210px/s);

  const locateSource = sourceBetween('function smartAgentLocateMediaNode', 'function bindSmartAgentMediaReceiptGroups');
  const locateContext = {
    nodes: [{id: 'node-locate', agentNative: {workspaceScope: 'canvas-agent', agentSessionId: 'session-locate', toolRunId: 'tool-locate'}}],
    smartAgentActiveSession: {id: 'session-locate', currentNodeRefs: [{nodeId: 'node-locate', toolRunId: 'tool-locate', workspaceScope: 'canvas-agent'}]},
    selectedId: '', selectedIds: ['old'], renderCalls: 0, focused: ''
  };
  locateContext.render = () => { locateContext.renderCalls += 1; };
  locateContext.focusSmartAgentNode = node => { locateContext.focused = node.id; };
  vm.runInNewContext(`${locateSource}\nglobalThis.locateMediaNode = smartAgentLocateMediaNode;`, locateContext);
  const beforeCount = locateContext.nodes.length;
  const located = locateContext.locateMediaNode('node-locate');
  assert.equal(located.id, 'node-locate');
  assert.equal(locateContext.selectedId, 'node-locate');
  assert.equal(locateContext.selectedIds.length, 0);
  assert.equal(locateContext.renderCalls, 1);
  assert.equal(locateContext.focused, 'node-locate');
  assert.equal(locateContext.nodes.length, beforeCount);
});

test('M5A：自定义 Skill 默认代码编辑态，上传菜单默认关闭且选择后收起', () => {
  const openEditor = sourceBetween('function openSmartAgentSkillEditor', 'async function closeSmartAgentSkillEditor');
  const importEvents = sourceBetween('if(smartAgentImportExistingSkill)', 'smartAgentSkillCreatorQuestion?.addEventListener');

  assert.match(html, /id="smartAgentSkillEditorUploadMenu"[^>]*\shidden/);
  assert.match(openEditor, /smartAgentSkillEditorUploadMenu\.hidden\s*=\s*true/);
  assert.match(openEditor, /setSmartAgentSkillEditorView\('code'\)/);
  assert.doesNotMatch(importEvents, /smartAgentSkillEditorUploadMenu\.hidden\s*=\s*false/);
  assert.match(importEvents, /smartAgentImportSkillFile\.onclick[\s\S]*?smartAgentSkillEditorUploadMenu\.hidden\s*=\s*true[\s\S]*?aria-expanded','false'/);
  assert.match(importEvents, /smartAgentImportSkillFolder\.onclick[\s\S]*?smartAgentSkillEditorUploadMenu\.hidden\s*=\s*true[\s\S]*?aria-expanded','false'/);
});

test('M5A：composer 输入框局部清除所有焦点边框与外发光', () => {
  assert.match(css, /#smartAgentQuestionInput,#smartAgentQuestionInput:focus,#smartAgentQuestionInput:focus-visible\s*\{[^}]*border\s*:\s*0\s*!important[^}]*outline\s*:\s*0\s*!important[^}]*box-shadow\s*:\s*none\s*!important[^}]*\}/s);
});

test('M5A：正式页面的 CSS 和 JS 使用同一资源版本', () => {
  assert.match(html, /smart-canvas-core\.css\?v=20260824-agent-m5i/);
  assert.match(html, /smart-canvas-core\.js\?v=20260824-agent-m5i/);
  assert.match(html, /agent-native-node-bridge\.js\?v=20260824-agent-m5i/);
  assert.doesNotMatch(html, /20260824-agent-m4c2/);
});

test('M6B4：Agent 终态节点的生成按钮先建立 branch-redo Round，普通生成路径不被接管', () => {
  const branch = sourceBetween('function smartAgentBranchRedoSource', 'async function runGeneration');
  const run = sourceBetween('async function runGeneration', 'async function runPromptLLMNode');
  const roundItem = sourceBetween('function smartAgentMediaExecutionFromRoundItem', 'function smartAgentSelectedReferenceImage');

  assert.match(branch, /current-nodes\/\$\{encodeURIComponent\(node\.id\)\}\/branch-redo/);
  assert.match(branch, /body:JSON\.stringify\(\{requestId:pending\.outbox\.requestId,prompt:normalizedPrompt\}\)/);
  assert.match(branch, /smartAgentApplySessionSnapshot\(session\)[\s\S]*?queueSmartAgentGenerationRound\(round\)/);
  assert.match(branch, /item\.parentNodeRef\s*!==\s*node\.id[\s\S]*?item\.supersedesRef\s*!==\s*node\.id/);
  assert.doesNotMatch(branch, /runApiGeneration|runApiVideoGeneration|AgentNativeNodeBridge\.execute/);
  assert.doesNotMatch(branch, /nodes\.push|nodes\s*=|createPendingOutputFromSource/);
  assert.match(run, /if\(node\?\.agentNative\?\.workspaceScope\s*===\s*'canvas-agent'\)[\s\S]*?queueSmartAgentBranchRedo\(node,prompt\)[\s\S]*?return;/);
  assert.ok(run.indexOf('queueSmartAgentBranchRedo(node,prompt)') < run.indexOf('pushUndo()'), 'Agent 分支必须先于普通占位和撤销写入');
  assert.match(roundItem, /parentNodeRef:item\.parentNodeRef[\s\S]*?branchRootRef:item\.branchRootRef[\s\S]*?supersedesRef:item\.supersedesRef/);
  assert.match(html, /smart-canvas-core\.js\?v=20260824-agent-m5i&amp;rev=20260825-agent-m6a2&amp;m6b4=20260825-agent-m6b4&amp;m6c=20260825-agent-m6c/);
});

test('M6B4：branch-redo 请求失败可按同一 requestId 安全重放，成功后只排入既有 Round 队列', async () => {
  const branchSource = sourceBetween('function smartAgentBranchRedoSource', 'async function runGeneration');
  const storage = new Map();
  const requests = [];
  const queued = [];
  const sourceNode = {
    id: 'node-old-image',
    taskState: {status: 'completed'},
    agentNative: {workspaceScope: 'canvas-agent', agentSessionId: 'session-redo', toolRunId: 'tool-old-image', kind: 'image'}
  };
  const session = {
    id: 'session-redo',
    currentNodeRefs: [{nodeId: sourceNode.id, workspaceScope: 'canvas-agent', kind: 'image', toolRunId: 'tool-old-image', branchRootRef: 'node-root'}],
    toolRuns: [{id: 'tool-old-image', nodeId: sourceNode.id, type: 'native-image', status: 'succeeded', inputHash: 'hash-old'}]
  };
  const round = {
    roundId: 'round-redo',
    items: [{itemId: 'redo-image', kind: 'image', parentNodeRef: sourceNode.id, branchRootRef: 'node-root', supersedesRef: sourceNode.id}]
  };
  let failOnce = true;
  let uidCount = 0;
  const context = {
    smartAgentActiveSession: session,
    smartAgentSessionLocalKey: (scope, suffix) => `${scope}:${suffix}`,
    smartAgentStoredValue: key => storage.get(key) || '',
    smartAgentStoreValue: (key, value) => value ? storage.set(key, String(value)) : storage.delete(key),
    uid: prefix => `${prefix}-${++uidCount}`,
    smartAgentSessionRequest: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({url, body});
      if(failOnce){ failOnce = false; throw new Error('fixture response lost'); }
      return {session, generationRound: round};
    },
    smartAgentApplySessionSnapshot: value => { context.appliedSession = value; },
    queueSmartAgentGenerationRound: value => { queued.push(value); },
    toast: () => {}
  };
  vm.runInNewContext(`${branchSource}\nglobalThis.queueBranchRedo = queueSmartAgentBranchRedo;`, context);

  await assert.rejects(context.queueBranchRedo(sourceNode, '新的电影光影'), /fixture response lost/);
  await context.queueBranchRedo(sourceNode, '新的电影光影');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.requestId, requests[1].body.requestId, '响应丢失后必须复用同一个 requestId');
  assert.deepEqual(Object.keys(requests[1].body).sort(), ['prompt', 'requestId']);
  assert.equal(queued.length, 1);
  assert.equal(queued[0], round);
  assert.equal(context.appliedSession, session);
  assert.equal(storage.size, 0, '收到可信 Round 后清除本地待重放记录');

  const forged = {...sourceNode, agentNative: {...sourceNode.agentNative, agentSessionId: 'session-forged'}};
  await assert.rejects(context.queueBranchRedo(forged, '不能回退到普通生成'), /不属于当前对话/);
  assert.equal(requests.length, 2, '不可信 Agent 节点不得发送 branch-redo，更不得回退普通 Provider');
});

test('M6B4：视频首帧 sourceNodeId 与 Prompt 重做血缘独立传入 Bridge', () => {
  const mapperSource = sourceBetween('function smartAgentRunSettingsForExecution', 'function smartAgentSelectedReferenceImage');
  const context = {};
  vm.runInNewContext(`${mapperSource}\nglobalThis.fromRoundItem = smartAgentMediaExecutionFromRoundItem;`, context);
  const session = {
    id: 'session-video-redo',
    currentNodeRefs: [{nodeId: 'node-first-frame', branchRootRef: 'node-first-frame'}],
    toolRuns: [{
      id: 'tool-new-video', nodeId: 'node-new-video', type: 'native-video', status: 'queued',
      provider: 'fixture-provider', model: 'seedance-2.0', operationId: 'operation-video', inputVersion: 'version-video', inputHash: 'hash-video',
      executionPayload: {prompt: '视频重做', images: [{referenceId: 'node-first-frame', sourceImageIndex: 0}]}
    }]
  };
  const execution = context.fromRoundItem(session, {roundId: 'round-video-redo'}, {
    itemId: 'item-video-redo', stageId: 'stage-branch-redo', toolRunId: 'tool-new-video',
    parentNodeRef: 'node-old-video', branchRootRef: 'node-root-video', supersedesRef: 'node-old-video'
  });
  assert.equal(execution.sourceNodeId, 'node-first-frame');
  assert.equal(execution.parentNodeRef, 'node-old-video');
  assert.equal(execution.branchRootRef, 'node-root-video');
  assert.equal(execution.supersedesRef, 'node-old-video');
});

test('M6C3：只有绑定 Skill 的最新成功 Round 才能建立本地智能剪辑，异常数量明确阻断', () => {
  const candidateSource = sourceBetween('function smartAgentLocalCompositionCandidate', 'function smartAgentLocalStableToken');
  const context = {};
  vm.runInNewContext(`${candidateSource}\nglobalThis.pickLocalComposition = smartAgentLocalCompositionCandidate;`, context);

  const makeSession = ({skill = true, roundStatus = 'completed', kinds = ['video'], itemStatuses = []} = {}) => {
    const items = kinds.map((kind, index) => ({
      itemId: `item-${kind}-${index + 1}`,
      kind,
      status: itemStatuses[index] || 'succeeded',
      toolRunId: `tool-${kind}-${index + 1}`,
      nodeId: `node-${kind}-${index + 1}`
    }));
    return {
      id: 'session-m6c3',
      skillRef: skill ? {skillId: 'ecommerce-video-director-skill', version: '1.7.0'} : null,
      generationRounds: [{roundId: 'round-m6c3', status: roundStatus, items}],
      toolRuns: items.map(item => ({
        id: item.toolRunId,
        nodeId: item.nodeId,
        type: `native-${item.kind}`,
        status: item.status
      })),
      currentNodeRefs: items.map(item => ({
        nodeId: item.nodeId,
        toolRunId: item.toolRunId,
        kind: item.kind,
        workspaceScope: 'canvas-agent'
      }))
    };
  };

  assert.equal(context.pickLocalComposition(makeSession({skill: false})), null, '普通无 Skill 对话不得自动建立剪辑');
  assert.equal(context.pickLocalComposition(makeSession({kinds: ['image', 'image']})), null, '纯图片 Round 不建立视频剪辑');

  const eligible = context.pickLocalComposition(makeSession({kinds: ['video', 'video', 'audio']}));
  assert.equal(eligible?.eligible, true);
  assert.equal(eligible?.roundId, 'round-m6c3');
  assert.equal(Array.from(eligible?.sourceNodeIds || []).join(','), 'node-video-1,node-video-2,node-audio-3');

  const partial = context.pickLocalComposition(makeSession({
    roundStatus: 'failed',
    kinds: ['video', 'video'],
    itemStatuses: ['succeeded', 'failed']
  }));
  assert.equal(partial?.blocked, true);
  assert.match(String(partial?.reason || ''), /未完整成功|失败|无法建立/);

  const tooManyVideos = context.pickLocalComposition(makeSession({kinds: ['video', 'video', 'video', 'video']}));
  assert.equal(tooManyVideos?.blocked, true);
  assert.equal((tooManyVideos?.sourceNodeIds || []).length, 4, '不得静默 slice 成三个视频');

  const tooManyAudio = context.pickLocalComposition(makeSession({kinds: ['video', 'audio', 'audio']}));
  assert.equal(tooManyAudio?.blocked, true);
  assert.match(String(tooManyAudio?.reason || ''), /音频|BGM|一条/);
});

test('M6C3：本地工作集身份由 Session、Round 和动作稳定派生，响应丢失复用同一请求', () => {
  const identitySource = sourceBetween('function smartAgentLocalStableToken', 'async function ensureSmartAgentLocalComposition');
  const context = {};
  vm.runInNewContext(`${identitySource}\nglobalThis.localIdentity = smartAgentLocalWorksetIdentity;`, context);

  const first = context.localIdentity('session-m6c3', 'round-m6c3', 'smart-edit');
  const replay = context.localIdentity('session-m6c3', 'round-m6c3', 'smart-edit');
  assert.equal(JSON.stringify(first), JSON.stringify(replay));
  for(const key of ['requestId', 'toolRunId', 'nodeId', 'eventId']) {
    assert.match(String(first[key] || ''), /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
  }
  const exportIdentity = context.localIdentity('session-m6c3', 'round-m6c3', 'canvas-export');
  assert.notEqual(exportIdentity.toolRunId, first.toolRunId);
  assert.match(String(exportIdentity.exportId || ''), /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/);
  assert.doesNotMatch(identitySource, /uid\(|Date\.now|Math\.random/);

  const ensureSource = sourceBetween('async function ensureSmartAgentLocalComposition', 'function smartAgentGenerationRoundRequestId');
  assert.match(ensureSource, /local-workset-actions/);
  assert.match(ensureSource, /action:'establish-smart-edit'/);
  assert.match(ensureSource, /requestId:identity\.requestId/);
  assert.match(ensureSource, /toolRunId:identity\.toolRunId/);
  assert.match(ensureSource, /nodeId:identity\.nodeId/);
  assert.match(ensureSource, /eventId:identity\.eventId/);
  assert.match(ensureSource, /sourceNodeIds:candidate\.sourceNodeIds/);
  assert.doesNotMatch(ensureSource, /AgentNativeNodeBridge\.execute|\/api\/canvas-video|\/api\/canvas-image/);
});

test('M6C3：Agent 智能剪辑默认紧凑、可原位展开关闭，普通 MiniMax 保持完整工作台', () => {
  const layoutSource = sourceBetween('function smartMinimaxIsAgentWorkbench', 'function nodeRect');
  const context = {};
  vm.runInNewContext(`${layoutSource}\nglobalThis.minimaxSize = smartMinimaxLayoutSize;`, context);
  const agentNode = {
    type: 'smart-minimax', w: 1040, h: 640, minimaxExpanded: false,
    agentNative: {workspaceScope: 'canvas-agent', kind: 'tool', nodeRole: 'smart-edit-workbench'}
  };
  const compact = context.minimaxSize(agentNode);
  const expanded = context.minimaxSize({...agentNode, minimaxExpanded: true});
  const ordinary = context.minimaxSize({type: 'smart-minimax', w: 1040, h: 640});
  assert.ok(compact.width < 860 && compact.height < 520, 'Agent 默认节点必须是紧凑入口');
  assert.ok(expanded.width >= 860 && expanded.height >= 520, '展开后复用完整工作台');
  assert.ok(ordinary.width >= 860 && ordinary.height >= 520, '普通 MiniMax 节点不可被缩小');

  const body = sourceBetween('function smartMinimaxBodyHtml', 'function nodeBodyHtml');
  const bindings = sourceBetween('function bindMinimaxNodeControls', 'function bindNodeEvents');
  const renderer = sourceBetween('function render()', 'function bindNodeEvents');
  const ordinaryCreate = sourceBetween('function createMinimaxNode', 'function createSmartGroupNode');
  assert.match(body, /data-minimax-open-workbench/);
  assert.match(body, /data-minimax-close-workbench/);
  assert.match(bindings, /data-minimax-open-workbench[\s\S]*?minimaxExpanded\s*=\s*true/);
  assert.match(bindings, /data-minimax-close-workbench[\s\S]*?minimaxExpanded\s*=\s*false/);
  assert.match(renderer, /agent-minimax-compact/);
  assert.match(css, /\.minimax-smart-node\.agent-minimax-compact/);
  assert.match(ordinaryCreate, /w:1040[\s\S]*?h:640/);
});

test('M6C3：智能剪辑提供导出本地与导出画布两条路径，画布导出先锁定整份计划', () => {
  const body = sourceBetween('function smartMinimaxBodyHtml', 'function nodeBodyHtml');
  const bindings = sourceBetween('function bindMinimaxNodeControls', 'function bindNodeEvents');
  const agentExport = sourceBetween('function smartAgentLocalExportPlan', 'async function exportMinimaxTimeline');

  assert.match(body, /data-minimax-export-local/);
  assert.match(body, /data-minimax-export-canvas/);
  assert.match(bindings, /data-minimax-export-local[\s\S]*?exportMinimaxTimeline\(node\)/);
  assert.match(bindings, /data-minimax-export-canvas[\s\S]*?exportAgentMinimaxToCanvas\(node\)/);
  assert.match(agentExport, /action:'prepare-canvas-export'/);
  assert.match(agentExport, /exportPlan/);
  assert.match(agentExport, /smartEditNodeId:node\.id/);
  assert.match(agentExport, /local-workset-actions/);
  assert.match(agentExport, /\/api\/smart-canvas\/minimax-export/);
  assert.match(agentExport, /agentSessionId/);
  assert.match(agentExport, /toolRunId/);
  assert.match(agentExport, /exportId/);
  assert.doesNotMatch(agentExport, /Date\.now|Math\.random|uid\(/);
});

test('M6C3：画布导出在同一视频占位原位完成，并在聊天消息显示视频缩略图', () => {
  const applySource = sourceBetween('function smartAgentApplyLocalExportResult', 'async function exportAgentMinimaxToCanvas');
  const placeholder = {
    id: 'node-local-export',
    type: 'smart-image',
    images: [],
    pending: 1,
    taskState: {status: 'queued'},
    agentNative: {
      workspaceScope: 'canvas-agent',
      agentSessionId: 'session-m6c3',
      toolRunId: 'tool-local-export',
      kind: 'video',
      nodeRole: 'local-video-export'
    }
  };
  const context = {
    nodes: [placeholder],
    nowMs: () => 123456,
    renderCalls: 0,
    saveCalls: 0,
    render(){ this.renderCalls += 1; },
    scheduleSave(){ this.saveCalls += 1; }
  };
  vm.runInNewContext(`${applySource}\nglobalThis.applyLocalExport = smartAgentApplyLocalExportResult;`, context);
  const before = context.nodes.length;
  const updated = context.applyLocalExport('session-m6c3', {
    nodeId: 'node-local-export',
    toolRunId: 'tool-local-export'
  }, {url: '/canvas-output/agent-local-export-export-m6c3.mp4', name: 'final.mp4', kind: 'video'});
  assert.equal(context.nodes.length, before);
  assert.equal(updated, placeholder);
  assert.equal(updated.id, 'node-local-export');
  assert.equal(updated.images[0].kind, 'video');
  assert.equal(updated.images[0].url, '/canvas-output/agent-local-export-export-m6c3.mp4');
  assert.equal(updated.taskState.status, 'completed');
  assert.doesNotMatch(applySource, /nodes\.push|createImageNodeAt|createMinimaxNode/);

  const receipt = sourceBetween('function smartAgentMediaReceiptHtml', 'function bindSmartAgentMediaReceiptGroups');
  const message = sourceBetween('function smartAgentSessionMessageHtml', 'function renderSmartAgentQuestionnaire');
  assert.match(receipt, /canvas-local-video-export[\s\S]*?'video'/);
  assert.match(message, /agent-local-video/);
  assert.match(message, /smartAgentMediaReceiptHtml\(toolRun\)/);
});

test('M6C3：刷新只恢复同一智能剪辑与本地导出身份，不重发图片视频 Provider', () => {
  const resume = sourceBetween('function resumeSmartAgentMediaExecutions', 'function smartAgentGenerationRoundRequestId');
  assert.match(resume, /ensureSmartAgentLocalComposition\(session\)/);
  assert.match(resume, /resumeSmartAgentLocalWorkset\(session\)/);

  const localRecovery = sourceBetween('async function resumeSmartAgentLocalWorkset', 'function smartAgentGenerationRoundRequestId');
  assert.match(localRecovery, /canvas-smart-edit/);
  assert.match(localRecovery, /canvas-local-video-export/);
  assert.match(localRecovery, /smartAgentApplyLocalExportResult/);
  assert.match(localRecovery, /\/api\/smart-canvas\/minimax-export/);
  assert.doesNotMatch(localRecovery, /AgentNativeNodeBridge\.execute|runApiGeneration|runApiVideoGeneration|\/api\/canvas-video|\/api\/canvas-image/);

  const ordinaryExport = sourceBetween('async function exportMinimaxTimeline', 'function smartPendingTasks');
  assert.match(ordinaryExport, /downloadPreviewFile/);
  assert.match(ordinaryExport, /body:JSON\.stringify\(\{clips, filename:/);
  assert.doesNotMatch(ordinaryExport, /local-workset-actions|agentSessionId|toolRunId|exportId/);
});

test('U5：本地视频发送前明确显示 Provider、模型和两次调用，确认值随同原回复请求提交', () => {
  const confirmation = sourceBetween('async function confirmSmartAgentVideoAnalysis', 'function smartAgentSkillAttachment');
  const request = sourceBetween('async function requestSmartAgentResponse', 'function queueSmartAgentResponse');
  const submit = sourceBetween('async function submitSmartAgentQuestionChatMessage', 'function enterSmartAgentWorkspace');

  assert.match(confirmation, /videos\.length > 1/);
  assert.match(confirmation, /APIMART Gemini/);
  assert.match(confirmation, /Provider：\$\{binding\.providerId\}/);
  assert.match(confirmation, /模型：\$\{binding\.model\}/);
  assert.match(confirmation, /调用次数：2 次/);
  assert.match(confirmation, /不会切换 Provider 或模型，不会自动重试/);
  assert.match(request, /videoAnalysisConfirmed:Boolean\(videoAnalysisConfirmed\)/);
  assert.match(request, /\/respond/);
  assert.match(submit, /confirmSmartAgentVideoAnalysis\(attachments\)/);
  assert.match(submit, /queueSmartAgentResponse\(triggerMessage,\{selectedSkillId,conversationOnly:true,videoAnalysisConfirmed\}\)/);
  assert.match(html, /u5=20260826-gemini-video-analysis/);
});
