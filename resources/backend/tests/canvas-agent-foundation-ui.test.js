const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const frontendPath = path.resolve(__dirname, '../../frontend/smart-canvas-core/smart-canvas-core.js');
const cssPath = path.resolve(__dirname, '../../frontend/smart-canvas-core/smart-canvas-core.css');
const source = fs.readFileSync(frontendPath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');

function functionPrefix(name, length = 240) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `缺少函数 ${name}`);
  const bodyStart = source.indexOf('{', start);
  assert.notEqual(bodyStart, -1, `缺少函数体 ${name}`);
  return source.slice(bodyStart + 1, bodyStart + 1 + length);
}

test('启动不再同步 Foundation 投影或创建审核外壳', () => {
  assert.match(source, /async function syncSmartAgentFoundationProjection\(\)\{\s*return false;\s*\}/);
  assert.doesNotMatch(source, /\/api\/canvas-agent\/foundation\/status/);
  assert.doesNotMatch(source, /type:\s*'smart-agent-approval-artifact'/);
  const onload = source.match(/window\.onload = async \(\) => \{[\s\S]*?\n\};/)?.[0] || '';
  assert.ok(onload, '缺少画布启动函数');
  assert.doesNotMatch(onload, /syncSmartAgentFoundationProjection|resumeSmartAgentRuns/);
});

test('旧审核节点仍可展示版本、状态、有效性和下游影响', () => {
  const match = source.match(/function smartAgentApprovalArtifactBodyHtml\(node\)\{[\s\S]*?\n\}/);
  assert.ok(match, '审核节点渲染函数不存在');
  const context = {
    escapeAttr: value => String(value).replace(/"/g, '&quot;'),
    escapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  };
  vm.createContext(context);
  vm.runInContext(`${match[0]}; this.renderFoundation = smartAgentApprovalArtifactBodyHtml;`, context);
  const rendered = context.renderFoundation({ artifactVersionId: 'script-v002', artifactType: '剧本', artifactVersion: 2, approvalState: 'locked', validityState: 'needs-review', affectedCount: 3 });
  assert.match(rendered, /data-agent-foundation-version="script-v002"/);
  assert.match(rendered, /需要复核/);
  assert.match(rendered, /已锁定/);
  assert.match(rendered, /3 个下游成果受此版本影响/);
});

test('普通保存保留旧投影节点和连线，仍只过滤日志预览幽灵节点', () => {
  assert.doesNotMatch(source, /!node\.agentFoundationProjection/);
  assert.doesNotMatch(source, /!connection\.agentFoundationProjection/);
  assert.match(source, /node\.id !== SMART_LOG_PREVIEW_NODE_ID/);
  for (const state of ['current', 'needs-review', 'stale', 'invalid']) assert.match(css, new RegExp(`smart-agent-foundation-card\\.is-${state}`));
  assert.doesNotMatch(source, /recolor[^\n]*agentFoundation|agentFoundation[^\n]*recolor/i);
});

test('旧 Foundation 与 AgentRun 写动作统一在动作根入口提示只读', () => {
  const roots = [
    'installSmartAgentStoryDatabase',
    'saveSmartAgentSettings',
    'runSmartAgentFoundationReviewAction',
    'openSmartAgentShotVideoRecovery',
    'previewSmartAgentShotVideoPromptRevision',
    'confirmSmartAgentShotVideoRecovery',
    'startSmartAgentRun',
    'pauseSmartAgentRun',
    'continueSmartAgentRun',
    'cancelSmartAgentRun',
    'retrySmartAgentRun',
    'submitSmartAgentManualVersion',
    'executeSmartAgentAiRevision',
    'submitSmartAgentScriptVersion',
    'cancelSmartAgentRevisionAttempt'
  ];
  for (const name of roots) assert.match(functionPrefix(name), /^\s*smartAgentLegacyReadOnlyNotice\(\);\s*return;/, `${name} 未在任何本地修改前停止`);
  assert.match(source, /LEGACY_AGENT_RUN_READ_ONLY/);
  assert.match(source, /旧版 AGENT 运行已转为只读历史/);
});

test('旧阶段内容仍可转换为中文纯文字历史视图', () => {
  const match = source.match(/function smartAgentNumberedLines[\s\S]*?\nfunction renderSmartAgentDrawer/);
  assert.ok(match, '阶段纯文字转换函数不存在');
  const helperSource = match[0].replace(/\nfunction renderSmartAgentDrawer$/, '');
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${helperSource}; this.toPlainText = smartAgentFoundationPlainText;`, context);
  const raw = JSON.stringify({
    productName: '测试产品',
    sources: [{ name: '产品说明.md', evidenceGrade: 'A', readable: true }],
    claims: [{ text: '净含量：100 克', evidenceGrade: 'A' }],
    conflicts: [],
    prohibitedClaims: [{ text: '不得夸大功效' }]
  });
  const text = context.toPlainText({ artifactType: 'evidence-ledger', contentPreview: raw });
  assert.match(text, /产品名称：测试产品/);
  assert.match(text, /产品说明\.md，证据等级 A 级，正文可以读取/);
  assert.match(text, /未发现事实冲突/);
  assert.doesNotMatch(text, /[{}\[\]"]/);
  assert.doesNotMatch(text, /claims|evidenceGrade|readable/);
});

test('持续聊天 AgentSession 入口保持可写且未被旧流程门冻结', () => {
  const chatPrefix = functionPrefix('submitSmartAgentChatMessage', 420);
  assert.doesNotMatch(chatPrefix, /smartAgentLegacyReadOnlyNotice/);
  assert.match(source, /\/api\/canvas\/agent-sessions\/\$\{encodeURIComponent\(smartAgentActiveSession\.id\)\}\/messages/);
  assert.match(source, /method:'POST'/);
});
