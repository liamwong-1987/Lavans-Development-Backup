'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../../..');
const source = fs.readFileSync(path.join(repoRoot, 'resources/frontend/smart-canvas-core/smart-canvas-core.js'), 'utf8');
const css = fs.readFileSync(path.join(repoRoot, 'resources/frontend/smart-canvas-core/smart-canvas-core.css'), 'utf8');

function sourceBetween(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.notEqual(start, -1, `缺少源码起点：${startText}`);
  assert.notEqual(end, -1, `缺少源码终点：${endText}`);
  return source.slice(start, end);
}

test('M8R-3C：依赖卡覆盖 missing/link-required/ready/drift 且位于 composer 前', () => {
  const render = sourceBetween('function renderSmartAgentSkillComposition', 'async function refreshSmartAgentSkillComposition');

  assert.match(render, /smartAgentChatComposer\.before\(card\)/);
  assert.match(render, /missing/);
  assert.match(render, /link-required/);
  assert.match(render, /ready/);
  assert.match(render, /drift/);
  assert.match(render, /导入并关联/);
  assert.match(render, /选择已导入 Skill/);
  assert.match(render, /暂不使用 Skill/);
  assert.match(render, /继续本条消息/);
  assert.match(render, /不会运行脚本或自动生成媒体/);
  assert.match(css, /\.smart-agent-skill-composition\s*\{/);
  assert.match(css, /\.smart-agent-skill-composition\[hidden\]/);
  assert.doesNotMatch(css, /\.smart-agent-skill-composition[^}]*#(?:7c3aed|6d28d9|8b5cf6)/s);
});

test('M8R-3C：导入沿用两阶段确认，成功后关联主 Skill 而不替换主 chip', () => {
  const confirmImport = sourceBetween('async function confirmSmartAgentSkillImport', 'async function discardSmartAgentSkillImport');
  const confirmComposition = sourceBetween('async function confirmSmartAgentSkillComposition', 'function startSmartAgentSkillDependencyImport');

  assert.match(confirmImport, /requestSmartAgentSkillImportPreview\(files\)/);
  assert.match(confirmImport, /\/api\/canvas\/agent-skills\/imports\/confirm/);
  assert.match(confirmImport, /pendingCompositionImport[\s\S]*?confirmSmartAgentSkillComposition/);
  assert.match(confirmComposition, /\/api\/canvas\/agent-skills\/\$\{encodeURIComponent\(primarySkillId\)\}\/composition\/confirm/);
  assert.match(confirmComposition, /confirm:true/);
  assert.match(confirmImport, /if\(pendingCompositionImport\)\{[\s\S]*?confirmSmartAgentSkillComposition\(\)[\s\S]*?\}\s*else\s*\{[\s\S]*?stageSmartAgentSkill\(importedId\)/);
});

test('M8R-3C：Provider 前依赖失败只记待继续消息，关联后也不自动重发', () => {
  const respond = sourceBetween('async function requestSmartAgentResponse', 'function queueSmartAgentResponse');
  const confirmComposition = sourceBetween('async function confirmSmartAgentSkillComposition', 'function startSmartAgentSkillDependencyImport');
  const continueTrigger = sourceBetween('async function continueSmartAgentCompositionTrigger', 'async function handleSmartAgentSkillCompositionAction');

  assert.match(respond, /smartAgentIsCompositionDependencyError\(error\)/);
  assert.match(respond, /rememberSmartAgentCompositionTrigger/);
  assert.match(respond, /refreshSmartAgentSkillComposition/);
  assert.match(respond, /clearSmartAgentCompositionTrigger[\s\S]*?renderSmartAgentSkillComposition/);
  assert.doesNotMatch(confirmComposition, /queueSmartAgentResponse|requestSmartAgentResponse/);
  assert.match(continueTrigger, /queueSmartAgentResponse\(pending\.triggerMessage/);
  assert.match(continueTrigger, /triggerMessageEventId/);
  assert.match(source, /function smartAgentCompositionPendingKey[\s\S]*?localStorage/);
});

test('M8R-3C：刷新恢复组合状态，composer 与右键隔离保持原合同', () => {
  const ensureSession = sourceBetween('async function ensureSmartAgentSession', 'function closeSmartAgentHeadPanels');
  const landing = sourceBetween('function renderSmartAgentLanding', 'function smartAgentQuestionGroups');

  assert.match(ensureSession, /refreshSmartAgentSkillComposition/);
  assert.match(ensureSession, /smartAgentReadCompositionTrigger/);
  assert.match(ensureSession, /pendingComposition\?\.sessionId\s*===\s*smartAgentActiveSession\.id/);
  assert.match(ensureSession, /pendingMessageExists/);
  assert.match(source, /function stageSmartAgentSkill[\s\S]*?refreshSmartAgentSkillComposition/);
  assert.match(landing, /smartAgentQuestionInput\.disabled\s*=\s*smartAgentMaterialUploadBusy\s*\|\|\s*smartAgentSessionMessageBusy/);
  assert.match(source, /element\.addEventListener\('contextmenu',\s*event\s*=>\s*event\.stopPropagation\(\)\)/);
  assert.doesNotMatch(landing, /smartAgentSkillCompositionBusy[\s\S]*?smartAgentQuestionInput\.disabled/);
});

test('用户可见 Skill 显示头脑风暴并隐藏旧产品直出入口', () => {
  const lookup = sourceBetween('function smartAgentSkillById', 'function smartAgentSkillIconHtml');
  const catalog = sourceBetween('function renderSmartAgentSkillCatalog', 'function smartAgentIsImportedSkill');
  const library = sourceBetween('function renderSmartAgentSkillLibrary', 'function setSmartAgentSkillCreateMenuOpen');
  const composition = sourceBetween('function renderSmartAgentSkillComposition', 'async function refreshSmartAgentSkillComposition');
  const hidden = sourceBetween('const SMART_AGENT_HIDDEN_SKILL_IDS', 'let smartAgentSkillsLoaded');

  assert.match(hidden, /'create-product-microstory-seedance'/);
  assert.doesNotMatch(hidden, /'brainstorming-obra-share'/);
  assert.doesNotMatch(hidden, /'ecommerce-video-director-skill'/);
  assert.match(catalog, /smartAgentVisibleSkills\(\)/);
  assert.match(library, /smartAgentVisibleSkills\(\)/);
  assert.match(composition, /status === 'ready' && !pending\?\.triggerMessage[\s\S]*?card\.hidden = true/,
    '依赖健康时不应向用户展示内部头脑风暴 Skill');
  assert.doesNotMatch(composition, /已包含：\$\{dependencyLabel\}/);
  assert.match(lookup, /SMART_AGENT_SKILLS\.find/,
    '内部依赖和旧会话恢复仍须查询完整 Registry，不能从底层删除');
});
