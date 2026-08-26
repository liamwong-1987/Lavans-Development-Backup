'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '../../..');
const frontendPath = path.join(repoRoot, 'resources/frontend/smart-canvas-core/smart-canvas-core.js');
const frontendSource = fs.readFileSync(frontendPath, 'utf8');

function loadFacadeFactory() {
  const start = frontendSource.indexOf('function createAgentNativeNodeHostFacade(deps={}){');
  const end = frontendSource.indexOf('\nconst agentNativeNodeHost = createAgentNativeNodeHostFacade({', start);
  assert.ok(start >= 0 && end > start, '尚未建立可独立验证的 Agent 原生节点 Host façade');
  const context = { factory: null };
  vm.runInNewContext(`${frontendSource.slice(start, end)}\nfactory = createAgentNativeNodeHostFacade;`, context);
  assert.equal(typeof context.factory, 'function');
  return context.factory;
}

function fixtureInput(overrides = {}) {
  return {
    workspaceScope: 'canvas-agent',
    nodeId: 'node-agent-image-1',
    sourceNodeId: 'node-source-1',
    agentSessionId: 'agent-session-1',
    toolRunId: 'tool-image-1',
    kind: 'image',
    nodeRole: 'storyboard-frame',
    parentNodeRef: '',
    branchRootRef: 'node-agent-image-1',
    supersedesRef: '',
    ...overrides
  };
}

function createFixtureHost() {
  const calls = [];
  const deps = {};
  for (const name of ['createPlaceholder', 'attachTask', 'completeTask', 'failTask', 'cancelTask', 'markRemoteUnknown', 'resumeTask', 'getNode']) {
    deps[name] = input => {
      calls.push({ name, input });
      return { name, nodeId: input.nodeId, input };
    };
  }
  return { host: loadFacadeFactory()(deps), calls };
}

function throwsCode(code) {
  return error => error?.code === code;
}

test('M2C：Host 冻结、固定 canvas-agent 且声明不提交 Provider', () => {
  const { host } = createFixtureHost();
  assert.equal(Object.isFrozen(host), true);
  assert.equal(Object.isFrozen(host.capabilities), true);
  assert.equal(host.capabilities.workspaceScope, 'canvas-agent');
  assert.equal(host.capabilities.preservesFailedBranch, true);
  assert.equal(host.capabilities.submitsProviderTasks, false);
  assert.equal(host.capabilities.completesInPlace, true);

  assert.throws(
    () => host.createPlaceholder(fixtureInput({ workspaceScope: 'recolor' })),
    throwsCode('INVALID_WORKSPACE_SCOPE')
  );
  assert.throws(
    () => host.createPlaceholder(fixtureInput({ nodeId: '' })),
    throwsCode('INVALID_NODE_ID')
  );
  assert.throws(
    () => host.createPlaceholder(fixtureInput({ agentSessionId: '' })),
    throwsCode('INVALID_SESSION_ID')
  );
  assert.throws(
    () => host.attachTask(fixtureInput({ taskId: '' })),
    throwsCode('INVALID_TASK_ID')
  );
  assert.throws(
    () => host.completeTask(fixtureInput({ taskId: 'canvas-task-1', results: [] })),
    throwsCode('INVALID_RESULTS')
  );
});

test('M2C：创建占位强制保留失败分支，完成与失败始终指向同一 nodeId', () => {
  const { host, calls } = createFixtureHost();
  const input = fixtureInput();
  const before = JSON.stringify(input);
  const created = host.createPlaceholder(input);
  assert.equal(created.nodeId, input.nodeId);
  assert.equal(calls[0].name, 'createPlaceholder');
  assert.equal(calls[0].input.preserveFailedBranch, true);
  assert.equal(JSON.stringify(input), before, 'Host 不得修改协调器传入对象');

  const taskInput = fixtureInput({ taskId: 'canvas-task-1', providerId: 'fixture-provider', model: 'fixture-model' });
  host.attachTask(taskInput);
  host.completeTask({ ...taskInput, results: [{ url: '/fixture/result.png', kind: 'image' }] });
  host.failTask({ ...taskInput, error: 'fixture failure' });
  assert.deepEqual(calls.slice(1).map(call => call.name), ['attachTask', 'completeTask', 'failTask']);
  assert.equal(calls.slice(1).every(call => call.input.nodeId === input.nodeId), true);
  assert.equal(calls.at(-1).input.preserveFailedBranch, true);
});

test('M5B：聊天发起的媒体任务不需要伪造源节点', () => {
  const { host, calls } = createFixtureHost();
  const input = fixtureInput({ sourceNodeId: '' });
  const created = host.createPlaceholder(input);
  assert.equal(created.nodeId, input.nodeId);
  assert.equal(calls[0].input.sourceNodeId, '');
  assert.equal(calls[0].input.preserveFailedBranch, true);
});

test('M5E-8：多项 Host 占位保持独立 nodeId，同源视频各自保留 flow 来源', () => {
  const { host, calls } = createFixtureHost();
  host.createPlaceholder(fixtureInput({ nodeId: 'node-stage-image-1', sourceNodeId: '', kind: 'image' }));
  host.createPlaceholder(fixtureInput({ nodeId: 'node-stage-video-1', sourceNodeId: 'node-stage-image-1', kind: 'video' }));
  host.createPlaceholder(fixtureInput({ nodeId: 'node-stage-video-2', sourceNodeId: 'node-stage-image-1', kind: 'video' }));

  assert.deepEqual(calls.map(call => call.input.nodeId), ['node-stage-image-1', 'node-stage-video-1', 'node-stage-video-2']);
  assert.deepEqual(calls.slice(1).map(call => call.input.sourceNodeId), ['node-stage-image-1', 'node-stage-image-1']);
  assert.equal(new Set(calls.map(call => call.input.nodeId)).size, 3);
  assert.equal('submitTask' in host, false);
});

test('M2C：remote-unknown 与恢复只委托既有 taskId，不存在提交方法', () => {
  const { host, calls } = createFixtureHost();
  const input = fixtureInput({ taskId: 'canvas-task-existing', remoteTaskId: 'remote-task-existing' });
  host.markRemoteUnknown(input);
  host.resumeTask(input);
  assert.deepEqual(calls.map(call => call.name), ['markRemoteUnknown', 'resumeTask']);
  assert.equal('submitTask' in host, false);
  assert.equal('generate' in host, false);
});

test('M2C：生产 façade 复用原生 placeholder、原位完成、恢复和保存', () => {
  const factoryStart = frontendSource.indexOf('function createAgentNativeNodeHostFacade(deps={}){');
  const hostStart = frontendSource.indexOf('const agentNativeNodeHost = createAgentNativeNodeHostFacade({', factoryStart);
  const hostEnd = frontendSource.indexOf("Object.defineProperty(window, 'AgentNativeNodeHost'", hostStart);
  assert.ok(factoryStart >= 0 && hostStart > factoryStart && hostEnd > hostStart);
  const hostSource = frontendSource.slice(hostStart, hostEnd);

  assert.match(frontendSource, /id:options\.nodeId\s*\|\|\s*uid\('smart'\)/, 'placeholder 必须接受协调器预留的稳定 nodeId');
  assert.match(hostSource, /createPendingOutputFromSource\(/);
  assert.match(hostSource, /smartAgentLayoutOrigin\(\)/);
  assert.match(hostSource, /nodes\.push\(output\)/);
  assert.match(hostSource, /finalizeSmartPendingTask\(/);
  assert.match(hostSource, /resumeSmartPendingNode\(/);
  assert.match(hostSource, /await saveCanvas\(\)/);
  assert.doesNotMatch(hostSource, /LavansCanvasAdapter\.createTask|runApiGeneration\(|runApiVideoGeneration\(|performCanvasGeneration/,
    'Host 只操作本地节点；Provider 提交必须由协调器和后端安全门完成');
  assert.match(frontendSource, /nodes\s*=\s*nodes\.filter\(n\s*=>\s*n\.id\s*!==\s*branchNode\.id\)/,
    '普通画布原有失败分支清理行为必须保持原样，Agent 只通过独立 Host 保留失败节点');
});
