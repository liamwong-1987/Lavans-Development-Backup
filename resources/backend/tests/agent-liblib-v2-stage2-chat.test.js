'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fixture = require('./agent-liblib-v2-golden.fixture');
const repoRoot = path.resolve(__dirname, '../../..');
const html = fs.readFileSync(path.join(repoRoot, 'resources/frontend/smart-canvas-core/smart-canvas.html'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'resources/frontend/smart-canvas-core/smart-canvas-core.css'), 'utf8');
const source = fs.readFileSync(path.join(repoRoot, 'resources/frontend/smart-canvas-core/smart-canvas-core.js'), 'utf8');

function functionBlock(name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  assert.notEqual(start, -1, `缺少函数 ${name}`);
  assert.notEqual(end, -1, `缺少函数边界 ${nextName}`);
  return source.slice(start, end);
}

test('Stage 2 黄金聊天回放覆盖全状态且始终保留输入区', () => {
  const replay = fixture.chatReplay;
  assert.ok(replay);
  assert.deepEqual(replay.stateCheckpoints.map(item => item.status), ['collecting', 'running', 'paused', 'blocked', 'completed']);
  assert.equal(replay.stateCheckpoints.every(item => item.composerAvailable === true), true);
  assert.equal(new Set(replay.messages.map(item => item.kind)).has('document'), true);
  assert.equal(new Set(replay.messages.map(item => item.kind)).has('tool-status'), true);
  assert.equal(new Set(replay.messages.map(item => item.kind)).has('media'), true);
});

test('Stage 2 黄金聊天回放严格零网络、零 Provider、零费用', () => {
  assert.equal(fixture.safety.networkAllowed, false);
  assert.equal(fixture.safety.providerCallCount, 0);
  assert.equal(fixture.safety.generationRequestCount, 0);
  assert.equal(fixture.safety.addedCost, 0);
});

test('红灯：composer 是问卷和旧工作区共用的抽屉固定底栏', () => {
  const questionnaireIndex = html.indexOf('id="smartAgentQuestionnaireView"');
  const workspaceIndex = html.indexOf('id="smartAgentWorkspaceView"');
  const composerIndex = html.indexOf('class="smart-agent-chat-composer"');
  assert.ok(questionnaireIndex > -1 && workspaceIndex > questionnaireIndex);
  assert.ok(composerIndex > workspaceIndex, 'composer 仍嵌在问卷视图，进入旧工作区后会消失');
  assert.match(source, /smartAgentQuestionnaireView\.hidden\s*=\s*isSkills/,
    '问卷时间线仍和旧工作区互斥，不能持续存在');
});

test('红灯：主输入在问询、运行、暂停、失败和完成状态都可写', () => {
  assert.doesNotMatch(source, /smartAgentQuestionInput\.hidden\s*=\s*smartAgentQuestionnaireComplete/);
  assert.doesNotMatch(source, /smartAgentQuestionInput\.disabled\s*=\s*smartAgentQuestionnaireComplete/);
  assert.doesNotMatch(css, /\.smart-agent-chat-composer\.has-choice-question textarea\s*\{[^}]*display\s*:\s*none/);
  assert.match(source, /async function submitSmartAgentChatMessage\(/,
    '缺少问卷回答与完成后自由消息共用的发送入口');
});

test('红灯：正式前端创建、恢复并幂等追加 AgentSession 消息', () => {
  assert.match(source, /let smartAgentActiveSession\s*=\s*null/);
  assert.match(source, /async function ensureSmartAgentSession\(/);
  assert.match(source, /\/api\/canvas\/agent-sessions\?canvasId=/);
  assert.match(source, /\/api\/canvas\/agent-sessions\/\$\{encodeURIComponent\(smartAgentActiveSession\.id\)\}\/messages/);
  assert.match(source, /requestId\s*:/, 'AgentSession 消息写入必须携带稳定 requestId');
});

test('红灯：消息时间线按 kind 渲染文档、工具状态、媒体和最终回执', () => {
  const block = functionBlock('smartAgentSessionMessageHtml', 'renderSmartAgentQuestionnaire');
  for (const kind of ['document', 'tool-status', 'media', 'final-receipt']) assert.match(block, new RegExp(kind));
  assert.match(block, /data-agent-message-kind/);
  assert.match(block, /createdAt/);
});

test('红灯：聊天文档只留在消息 DOM，不触发画布节点写入', () => {
  const block = functionBlock('smartAgentSessionMessageHtml', 'renderSmartAgentQuestionnaire');
  assert.doesNotMatch(block, /current-nodes|attachCurrentNode|createNode|nodes\.push/);
  assert.equal(fixture.chatReplay.messages.filter(item => item.kind === 'document').every(item => item.canvasNode === false), true);
});

test('红灯：Stage 2 会话桥接不调用旧 Run、生成接口或 Provider', () => {
  const block = functionBlock('smartAgentSessionRequest', 'smartAgentSessionMessageHtml');
  assert.doesNotMatch(block, /\/api\/canvas\/agent-runs|\/api\/canvas-(?:llm|video)|current-nodes|providerExecutor|generate(?:Image|Video)/i);
  assert.match(block, /\/api\/canvas\/agent-sessions/);
});

test('红灯：AGENT 右栏采用录像关系的全高并列布局', () => {
  assert.match(css, /--smart-agent-drawer-share\s*:\s*\.412/);
  assert.match(css, /\.smart-agent-drawer\s*\{[^}]*top\s*:\s*0[^}]*right\s*:\s*0[^}]*bottom\s*:\s*0/s);
  assert.match(css, /\.smart-agent-drawer\s*\{[^}]*width\s*:\s*41\.2%/s);
});

test('M4C：composer 无可见边框且 Skill 完整编辑字段不会静默丢失', () => {
  assert.match(css, /\.smart-agent-chat-composer\s*\{[^}]*border\s*:\s*1px solid transparent[^}]*box-shadow\s*:\s*none/s);
  assert.match(css, /\.smart-agent-chat-composer:focus-within[^}]*border-color\s*:\s*transparent[^}]*box-shadow\s*:\s*none/s);
  for (const id of ['smartAgentSkillEditorScenario', 'smartAgentSkillEditorUsage', 'smartAgentSkillEditorOutput', 'smartAgentSkillEditorType', 'smartAgentSkillEditorCover']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  const markdown = functionBlock('smartAgentSkillMarkdown', 'smartAgentSkillEditorFiles');
  for (const key of ['usage_scenario', 'how_to_use', 'output_content', 'skill_type']) assert.match(markdown, new RegExp(key));
  const confirm = functionBlock('confirmSmartAgentSkillImport', 'discardSmartAgentSkillImport');
  for (const field of ['scenario', 'usage', 'output']) assert.match(confirm, new RegExp(`if\\(!pendingCompositionImport && !${field}\\)`));
});

test('M8R-3D：编辑已导入 Skill 时保留 slug、版本与发布者身份', () => {
  const markdown = functionBlock('smartAgentSkillMarkdown', 'smartAgentSkillEditorFiles');
  assert.match(markdown, /smartAgentSkillEditorMode\s*===\s*'import'/);
  assert.match(markdown, /smartAgentSkillImportPreviewState/);
  for (const key of ['slug', 'version', 'publisher']) assert.match(markdown, new RegExp(`${key}:`));
});

test('M8R-3D：组合依赖导入保留上传包原文，不用展示字段改写身份', () => {
  const confirm = functionBlock('confirmSmartAgentSkillImport', 'discardSmartAgentSkillImport');
  assert.match(confirm, /pendingCompositionImport\s*\?\s*smartAgentSkillEditorSourceFiles/);
  for (const field of ['scenario', 'usage', 'output']) {
    assert.match(confirm, new RegExp(`if\\(!pendingCompositionImport && !${field}\\)`));
  }
});

test('M4C：Skill 编辑页可切换预览/代码并让新目录和新文件按钮产生包内容', () => {
  assert.match(html, /id="smartAgentSkillEditorPreviewPane"/);
  assert.match(html, /id="smartAgentSkillEditorNewFolder"/);
  assert.match(html, /id="smartAgentSkillEditorNewFile"/);
  assert.match(source, /function setSmartAgentSkillEditorView\(/);
  assert.match(source, /function smartAgentSkillEditorAddFolder\(/);
  assert.match(source, /function smartAgentSkillEditorAddFile\(/);
  assert.match(source, /smartAgentSkillEditorSourceFiles\.push/);
  assert.match(source, /data-agent-skill-editor-view/);
});
