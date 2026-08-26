# Script Version Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Canvas AGENT 增加不可覆盖旧版本的剧本修改、对比、审核和锁定闭环，并让每个任务与成功版本在画布上实时可见。

**Architecture:** 新建独立的 `agentScriptVersionService` 负责不可变版本文件、审核状态、锁定、差异和修改任务；现有 `agentRunService` 只负责 Run 持久化和生命周期接入。Express 路由负责当前画布 Provider/模型的精确预检与授权，原生前端负责版本节点、审核面板和实时状态同步。

**Tech Stack:** Node.js CommonJS、Express、原生 JavaScript、原生 CSS、文件型 JSON/Markdown 持久化、`node:test`/`assert`、现有 Python 离线防复刻脚本。

**Spec:** `docs/superpowers/specs/2026-08-20-script-version-review-design.md`

## Global Constraints

- 旧版本不可覆盖、不可原地修改、不可因取消或失败而丢失。
- 每个成功版本和每个 AI 修改尝试必须在画布上有独立可见节点。
- 只有一个版本可以处于当前锁定状态；没有锁定版本时禁止进入分镜阶段。
- 手动修改不调用模型；AI 修改动态读取画布 API 设置中的 Provider 与模型。
- AI 调用前必须精确确认 Provider、模型、发送范围和不发送范围；设置变化后旧授权失效。
- AI 失败、超时、取消、空返回或防复刻不通过时不得登记成功版本。
- 能勾选的问题不显示文字框；只有勾选“其他修改”才显示补充输入。
- 阶段 2 完成后停止，等待用户验收，不自动执行阶段 3。
- 画布 AGENT 与一键复色完全隔离。
- 每个生产修改前创建精确备份；自动化测试前后校验生产画布 JSON 哈希不变。
- 当前工作区包含既有用户修改。共享脏文件不能直接整文件暂存；只有确认 staged diff 仅包含本任务内容时才能提交，否则使用恢复目录中的 patch/checkpoint，不执行提交。

---

## File Structure

### Create

- `resources/backend/services/agentScriptVersionService.js`：版本文件、元数据、差异、审核、锁定和修改尝试的单一职责服务。
- `resources/backend/tests/agent-script-version-review.test.js`：版本不可变、状态机、失败保护和恢复测试。
- `resources/backend/tests/agent-script-version-routes.test.js`：路由授权、并发、幂等和错误状态测试。

### Modify

- `resources/backend/services/agentRunService.js`：规范化 `scriptReview`，注入版本服务，持久化版本与尝试状态，阻止未锁定剧本进入分镜。
- `resources/backend/routes/canvasRoutes.js`：版本、差异、审核、锁定、预检、AI 修改和取消接口。
- `resources/frontend/smart-canvas-core/smart-canvas.html`：右侧剧本审核容器和操作控件。
- `resources/frontend/smart-canvas-core/smart-canvas-core.js`：版本节点、任务节点、审核面板、API 调用、轮询和刷新恢复。
- `resources/frontend/smart-canvas-core/smart-canvas-core.css`：版本卡、差异视图、多选范围、长文本和状态样式。
- `resources/backend/tests/canvas-workspace-roundtrip.test.js`：前后端能力标记、生产画布哈希和一键复色隔离回归。
- `docs/Canvas-Agent开发进度.md`：阶段 2 实施、测试、备份和用户验收状态。

---

### Task 1: Run 状态契约与版本服务边界

**Files:**

- Create: `resources/backend/services/agentScriptVersionService.js`
- Create: `resources/backend/tests/agent-script-version-review.test.js`
- Modify: `resources/backend/services/agentRunService.js:160-230`

**Interfaces:**

- Produces: `normalizeScriptReview(raw): ScriptReviewState`
- Produces: `createAgentScriptVersionService(options): AgentScriptVersionService`
- Produces: `ensureReviewState(run): ScriptReviewState`
- Consumes: `projectRoot`, `saveRun(run)`,现有 `safeId`/项目路径保护规则。

- [ ] **Step 1: 写 Run 状态规范化失败测试**

在新测试中构造含未知字段、非法状态和重复版本 ID 的 Run，期望输出只保留允许字段、合法状态与唯一 ID：

```js
test('normalizes script review state without dropping later-added run fields', () => {
  const normalized = normalizeScriptReview({
    activeVersionId: 'script-v002',
    versions: [
      { id: 'script-v001', number: 1, status: 'locked', relativePath: 'story/versions/script-v001.md' },
      { id: 'script-v001', number: 99, status: 'bad' }
    ],
    attempts: [{ id: 'attempt-1', status: 'running' }]
  });
  assert.equal(normalized.versions.length, 1);
  assert.equal(normalized.versions[0].status, 'locked');
  assert.equal(normalized.attempts[0].status, 'running');
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run:

```powershell
& 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test 'D:\Lavans备份\resources\backend\tests\agent-script-version-review.test.js'
```

Expected: FAIL，提示 `normalizeScriptReview` 或服务模块不存在。

- [ ] **Step 3: 创建最小状态服务**

服务导出形状固定为：

```js
module.exports = {
  createAgentScriptVersionService,
  normalizeScriptReview,
  VERSION_STATUSES,
  ATTEMPT_STATUSES
};
```

允许状态：

```js
const VERSION_STATUSES = new Set(['draft', 'awaiting-review', 'approved', 'locked', 'superseded']);
const ATTEMPT_STATUSES = new Set(['queued', 'running', 'failed', 'cancelled', 'interrupted', 'completed']);
```

`agentRunService.normalizeRun()` 将 `raw.scriptReview` 交给 `normalizeScriptReview`，其余未知 Run 字段继续按当前兼容策略保留。

- [ ] **Step 4: 验证 GREEN 与现有 Run 回归**

Run:

```powershell
& 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test 'D:\Lavans备份\resources\backend\tests\agent-script-version-review.test.js' 'D:\Lavans备份\resources\backend\tests\agent-run-stage1.test.js'
```

Expected: 两个测试文件全部 PASS。

- [ ] **Step 5: 创建精确检查点**

备份新服务、测试和 `agentRunService.js` 到 `D:\Lavans备份_Recovery\canvas_agent_phase2_<timestamp>\task1`，记录 SHA256。只有 staged diff 不包含既有修改时才提交：

```powershell
git -c safe.directory=D:/Lavans备份 -C D:\Lavans备份 diff --cached --check
```

---

### Task 2: V1 导入与手动不可变版本

**Files:**

- Modify: `resources/backend/services/agentScriptVersionService.js`
- Modify: `resources/backend/tests/agent-script-version-review.test.js`

**Interfaces:**

- Produces: `initializeReview(runId): Run`
- Produces: `createManualVersion(runId, input): Run`
- Input: `{ baseVersionId, content, operationId }`
- Output version: `{ id, number, parentVersionId, source, status, relativePath, metadataPath, contentHash, createdAt }`

- [ ] **Step 1: 写 V1 只导入一次的失败测试**

```js
test('imports final script once and never overwrites v1', () => {
  const first = service.initializeReview(run.id);
  const v1Path = path.join(projectDir, first.scriptReview.versions[0].relativePath);
  const originalHash = sha256(v1Path);
  const second = service.initializeReview(run.id);
  assert.equal(second.scriptReview.versions.length, 1);
  assert.equal(sha256(v1Path), originalHash);
});
```

- [ ] **Step 2: 写手动 V2 不改变 V1 的失败测试**

```js
test('manual revision creates a full immutable child version', () => {
  const v1 = service.initializeReview(run.id).scriptReview.versions[0];
  const before = fs.readFileSync(resolveVersion(v1), 'utf8');
  const updated = service.createManualVersion(run.id, {
    baseVersionId: v1.id,
    content: before.replace('旧开头', '新开头'),
    operationId: 'manual-op-1'
  });
  assert.equal(updated.scriptReview.versions.length, 2);
  assert.equal(fs.readFileSync(resolveVersion(v1), 'utf8'), before);
  assert.equal(updated.scriptReview.versions[1].parentVersionId, v1.id);
});
```

- [ ] **Step 3: 运行确认两个测试 RED**

Expected: FAIL，分别缺少 `initializeReview` 和 `createManualVersion`。

- [ ] **Step 4: 实现原子写入与幂等**

使用同目录临时文件并原子改名：

```js
function atomicWriteFile(targetPath, content) {
  const tempPath = `${targetPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, targetPath);
}
```

版本号在 Run 锁内计算；`operationId` 已存在时返回原结果。先验证完整内容、最小长度和路径，再写 Markdown、元数据，最后保存 Run。

- [ ] **Step 5: 验证 GREEN、哈希和重复请求**

增加断言：重复 `operationId` 仍只有两个版本；V1 内容与哈希不变；V2 Markdown 和 JSON 都存在。

- [ ] **Step 6: 检查点与局部审查**

运行 `node --check`、版本测试和 `git diff --check`，保存 task2 patch；不暂存共享脏文件。

---

### Task 3: 审核、差异、锁定与分镜门禁

**Files:**

- Modify: `resources/backend/services/agentScriptVersionService.js`
- Modify: `resources/backend/services/agentRunService.js`
- Modify: `resources/backend/tests/agent-script-version-review.test.js`

**Interfaces:**

- Produces: `approveVersion(runId, versionId): Run`
- Produces: `lockVersion(runId, versionId, options): Run`
- Produces: `diffVersions(runId, leftId, rightId): VersionDiff`
- Produces: `hasLockedScript(run): boolean`
- `lockVersion` input options: `{ replaceLockedVersionId?: string, confirmed?: boolean }`

- [ ] **Step 1: 写状态机失败测试**

```js
test('requires approval before locking and keeps one current lock', () => {
  assert.throws(() => service.lockVersion(run.id, v2.id, {}), /先通过/);
  service.approveVersion(run.id, v2.id);
  const locked = service.lockVersion(run.id, v2.id, {});
  assert.equal(locked.scriptReview.lockedVersionId, v2.id);
  assert.equal(locked.scriptReview.versions.filter(v => v.status === 'locked').length, 1);
});
```

- [ ] **Step 2: 写未锁定禁止分镜测试**

```js
test('does not advance to shot planning without a locked script', () => {
  const result = runService.resumeRun(run.id);
  assert.equal(result.currentStageId, 'microstory');
  assert.match(result.error, /锁定剧本/);
});
```

- [ ] **Step 3: 运行确认 RED**

Expected: FAIL，当前 Run 会进入 `shot-and-asset-plan` 或缺少锁定方法。

- [ ] **Step 4: 实现审核与原子替换锁定**

规则：

```js
if (target.status !== 'approved') throw new Error('请先通过该剧本版本');
if (review.lockedVersionId && review.lockedVersionId !== target.id) {
  if (!options.confirmed || options.replaceLockedVersionId !== review.lockedVersionId) {
    throw new Error('替换已锁定版本需要再次确认');
  }
}
```

锁定写入 `story/locked-script.json`，包含 `versionId`、`relativePath`、`contentHash`、`lockedAt`。状态和事件在一次 `saveRun` 中提交。

- [ ] **Step 5: 实现本地差异**

`diffVersions` 返回：

```js
{
  leftVersionId,
  rightVersionId,
  addedLines,
  removedLines,
  changedSections,
  rows: [{ type: 'same' | 'added' | 'removed', text: '...' }]
}
```

不调用模型，不写入生产文件；仅在需要缓存时写 `story/reviews/`。

- [ ] **Step 6: 验证 GREEN 与阶段门禁**

覆盖通过替换、显式替换锁定、未确认拒绝、锁定文件哈希、锁定后仍不自动运行阶段 3。

- [ ] **Step 7: 检查点**

保存 task3 备份、测试输出和 patch。

---

### Task 4: AI 修改尝试、授权和失败保护

**Files:**

- Modify: `resources/backend/services/agentScriptVersionService.js`
- Modify: `resources/backend/services/agentRunService.js`
- Modify: `resources/backend/tests/agent-script-version-review.test.js`

**Interfaces:**

- Produces: `startAiRevision(runId, input, runtime): Promise<Run>`
- Produces: `cancelRevisionAttempt(runId, attemptId): Run`
- Input: `{ baseVersionId, changeScopes, customInstruction, operationId }`
- Runtime: `{ providerId, model, generateText, runSimilarityCheck, signal }`

- [ ] **Step 1: 写选项范围与“其他”失败测试**

```js
test('accepts custom text only when other scope is selected', async () => {
  await assert.rejects(() => service.startAiRevision(run.id, {
    baseVersionId: v1.id,
    changeScopes: ['hook'],
    customInstruction: '偷偷发送这段文字',
    operationId: 'ai-op-1'
  }, runtime), /其他修改/);
});
```

- [ ] **Step 2: 写失败不产生版本测试**

分别让 `generateText` 抛错、返回空文本、被 AbortController 取消、相似度不通过；每次断言版本数量不增加，尝试状态准确。

- [ ] **Step 3: 写成功完整版本测试**

断言发送内容只包含基准剧本、勾选范围、产品事实锁和必要制作信息；不包含数据库摘录、API key、一键复色内容。成功后产生 `source:'ai-revision'` 的完整子版本。

- [ ] **Step 4: 运行确认 RED**

Expected: FAIL，缺少 AI 修改方法和尝试状态。

- [ ] **Step 5: 实现单任务锁、取消和成功登记**

运行顺序：

```text
create attempt(queued)
-> save
-> attempt(running)
-> call current Canvas model
-> validate full script
-> similarity check
-> atomic version files
-> register version
-> attempt(completed)
-> save
```

同一 Run 存在 `queued/running` 尝试时返回 409 语义错误。取消只中止该尝试，不调用通用 `cancelRun`。

- [ ] **Step 6: 验证 GREEN 与泄露边界**

检查外部生成器收到的 prompt；明确断言不含合成测试数据库的原句、文件名、密钥和一键复色标记。

- [ ] **Step 7: 检查点**

保存测试输出、尝试状态样例和 task4 patch。

---

### Task 5: Express 版本与审核接口

**Files:**

- Create: `resources/backend/tests/agent-script-version-routes.test.js`
- Modify: `resources/backend/routes/canvasRoutes.js:2140-2240`
- Modify: `resources/backend/services/agentRunService.js:956`

**Interfaces:**

- Consumes: Task 2-4 的版本服务方法。
- Produces: 规格中列出的 initialize、versions、manual、preflight、revise、approve、lock、diff、cancel 路由。

- [ ] **Step 1: 写路由存在与状态码失败测试**

测试至少断言：

```js
assertRoute('post', '/api/canvas/agent-runs/:runId/stages/microstory/review/initialize');
assertRoute('post', '/api/canvas/agent-runs/:runId/stages/microstory/versions/:versionId/approve');
assertRoute('post', '/api/canvas/agent-runs/:runId/stages/microstory/versions/:versionId/lock');
```

预期错误：400 非法输入、404 Run/版本不存在、409 状态冲突/需确认、423 已有运行任务、500 非预期错误。

- [ ] **Step 2: 写 AI 预检精确授权失败测试**

预检返回 `providerId/model/scopes/excluded`。执行请求中任一 Provider 或模型不匹配时必须 409；缺少 `approved:true` 也必须 409。

- [ ] **Step 3: 运行确认 RED**

Expected: FAIL，路由不存在。

- [ ] **Step 4: 接入路由**

复用现有 `agentStoryTextSelection()` 与 `generateApprovedAgentStoryText()`，但 revision prompt 由版本服务构造。路由不读取或返回 API key。

- [ ] **Step 5: 验证 GREEN**

运行新路由测试、现有 microstory 测试和 workspace roundtrip 测试。

- [ ] **Step 6: 检查点**

由于 `canvasRoutes.js` 是共享脏文件，只保存 scoped diff 和 SHA256，不直接整文件提交。

---

### Task 6: 画布版本节点与实时修改任务节点

**Files:**

- Modify: `resources/frontend/smart-canvas-core/smart-canvas-core.js:8528-9395`
- Modify: `resources/frontend/smart-canvas-core/smart-canvas-core.css`
- Modify: `resources/backend/tests/canvas-workspace-roundtrip.test.js`

**Interfaces:**

- Produces: `smartAgentSyncScriptVersionNodes(run, stage, stageIndex)`
- Produces: `smartAgentSyncRevisionAttemptNodes(run, stage, stageIndex)`
- Produces node types: `smart-agent-script-version`, `smart-agent-script-revision`

- [ ] **Step 1: 写前端能力标记与 roundtrip 失败测试**

要求 workspace 保存并恢复：

```js
{
  type: 'smart-agent-script-version',
  agentRunId,
  scriptVersionId,
  parentVersionId,
  versionStatus,
  source,
  changeScopes,
  providerId,
  model
}
```

未知后加字段继续保留。

- [ ] **Step 2: 运行确认 RED**

Expected: FAIL，缺少版本节点同步函数和节点类型。

- [ ] **Step 3: 实现确定性布局与同步**

版本节点从微故事节点右侧开始纵向排列；任务节点位于其父版本与候选新版本之间。节点 ID 使用 Run + version/attempt ID，刷新时更新现有节点而不是重复创建。

状态映射：

```js
const versionLabels = {
  draft:'草稿',
  'awaiting-review':'待审核',
  approved:'已通过',
  locked:'已锁定',
  superseded:'未采用'
};
```

- [ ] **Step 4: 实现节点先出现再执行**

调用 AI 接口前本地创建 `running` 修改任务节点；轮询后以后端状态覆盖。失败和取消节点保留，成功后连接到新版本节点。

- [ ] **Step 5: 验证 GREEN 与无重复节点**

同一后端 Run 连续同步三次，版本节点和连接数量保持不变；状态和元数据更新。

- [ ] **Step 6: 检查点**

保存前端 scoped diff、roundtrip 输出和生产画布哈希报告。

---

### Task 7: 右侧剧本审核面板与操作闭环

**Files:**

- Modify: `resources/frontend/smart-canvas-core/smart-canvas.html:223-268`
- Modify: `resources/frontend/smart-canvas-core/smart-canvas-core.js:118-145, 9680-9760, 20800-20970`
- Modify: `resources/frontend/smart-canvas-core/smart-canvas-core.css:1700-2000`
- Modify: `resources/backend/tests/canvas-workspace-roundtrip.test.js`

**Interfaces:**

- Produces: `renderSmartAgentScriptReview(run)`
- Produces: `openSmartAgentScriptVersion(versionId)`
- Produces: `submitSmartAgentManualVersion()`
- Produces: `executeSmartAgentAiRevision()`
- Produces: `approveSmartAgentScriptVersion(versionId)`
- Produces: `lockSmartAgentScriptVersion(versionId)`

- [ ] **Step 1: 写 DOM 标记失败测试**

要求 HTML/JS/CSS 存在：

```text
smartAgentScriptReview
smartAgentScriptContent
smartAgentRevisionScopes
data-agent-revision-scope
data-agent-script-manual
data-agent-script-ai
data-agent-script-approve
data-agent-script-lock
```

- [ ] **Step 2: 运行确认 RED**

Expected: FAIL，审核面板和操作标记不存在。

- [ ] **Step 3: 创建面板骨架和版本预览**

面板默认隐藏；选择版本节点后显示元数据、完整 Markdown 文本、父版本差异和操作按钮。长剧本区域使用独立滚动，不压缩按钮。

- [ ] **Step 4: 实现选项优先修改范围**

八个常规范围为复选卡；`other` 控制补充输入：

```js
const hasOther = selectedScopes.includes('other');
smartAgentRevisionCustom.hidden = !hasOther;
if (!hasOther) smartAgentRevisionCustom.value = '';
```

至少一个范围才能启用 AI 修改。普通范围选择时不显示通用文字框。

- [ ] **Step 5: 实现手动修改**

点击手动修改后复制当前版本内容到编辑区；保存调用 manual 路由并携带新的 `operationId`。成功后同步 Run 和新版本节点，原节点不变。

- [ ] **Step 6: 实现 AI 预检、确认、轮询和取消**

确认文本必须显示实际 Provider、模型、发送范围与排除范围。确认后先显示任务节点，再调用执行路由并轮询 Run；取消按钮只取消当前 attempt。

- [ ] **Step 7: 实现通过、锁定和二次替换确认**

锁定按钮仅对 `approved` 版本启用。已有锁定版本时明确显示旧、新版本号并二次确认，不允许静默替换。

- [ ] **Step 8: 调整可读性**

- 操作卡最小 56px；带说明卡最小 68px。
- 剧本正文不小于 14px，行高不小于 1.7。
- 状态、版本号和主要按钮在 420px 侧栏内不截断。
- 选项过多时整体区域滚动，卡片不压扁。

- [ ] **Step 9: 运行静态回归与浏览器 DOM 检查**

验证普通范围题无文本框；选中 `other` 后只出现一个补充框；按钮状态与版本状态一致。

- [ ] **Step 10: 检查点**

保存 task7 截图、DOM 断言、测试输出和 scoped patch。

---

### Task 8: 中断恢复、完整回归与用户验收准备

**Files:**

- Modify: `resources/backend/services/agentScriptVersionService.js`
- Modify: `resources/backend/services/agentRunService.js`
- Modify: `resources/frontend/smart-canvas-core/smart-canvas-core.js`
- Modify: `resources/backend/tests/agent-script-version-review.test.js`
- Modify: `resources/backend/tests/agent-script-version-routes.test.js`
- Modify: `resources/backend/tests/canvas-workspace-roundtrip.test.js`
- Modify: `docs/Canvas-Agent开发进度.md`

**Interfaces:**

- Produces: `recoverInterruptedRevisionAttempts(run): Run`
- Produces: `reconcileVersionFiles(run): Run`
- Produces: 阶段 2 最终测试报告与浏览器验收地址。

- [ ] **Step 1: 写服务重启恢复失败测试**

运行中 attempt 在服务启动恢复为 `interrupted`；已完成版本保持不变；孤立临时文件不登记为 Artifact；完整版本文件 + 元数据存在但 Run 未登记时按哈希安全补登记一次。

- [ ] **Step 2: 运行确认 RED**

Expected: FAIL，当前没有版本恢复逻辑。

- [ ] **Step 3: 实现恢复与对账**

只扫描当前 Run 的 `story/versions`，拒绝路径越界、缺失元数据、哈希不匹配和重复版本号。清理范围仅限已知 `.tmp-<pid>-<uuid>` 文件。

- [ ] **Step 4: 运行阶段 2 全部自动化测试**

Run:

```powershell
& 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check 'D:\Lavans备份\resources\backend\services\agentScriptVersionService.js'
& 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check 'D:\Lavans备份\resources\backend\services\agentRunService.js'
& 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check 'D:\Lavans备份\resources\backend\routes\canvasRoutes.js'
& 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --check 'D:\Lavans备份\resources\frontend\smart-canvas-core\smart-canvas-core.js'
& 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test 'D:\Lavans备份\resources\backend\tests\agent-script-version-review.test.js' 'D:\Lavans备份\resources\backend\tests\agent-script-version-routes.test.js' 'D:\Lavans备份\resources\backend\tests\agent-run-microstory.test.js' 'D:\Lavans备份\resources\backend\tests\agent-run-stage1.test.js' 'D:\Lavans备份\resources\backend\tests\canvas-workspace-roundtrip.test.js'
```

Expected: 全部 PASS、0 fail、生产画布 JSON 哈希不变。

- [ ] **Step 5: 浏览器真实操作验收**

在独立预览画布依次执行：初始化 V1、手动 V2、受控 AI V3、对比、通过、锁定、刷新恢复、失败一次、取消一次。生产 AI 调用只有用户确认真实 Provider/模型后才能执行；没有授权故事数据库时使用测试隔离环境验证 AI 边界，不伪装为生产成稿。

- [ ] **Step 6: 检查界面与状态节点**

确认每个版本和 attempt 节点可见；状态灯、父子连接、长剧本滚动、卡片高度、按钮禁用逻辑和“其他”输入显隐正确。

- [ ] **Step 7: 更新进度并交给用户审核**

记录：备份目录、修改文件、测试数量、浏览器地址、截图、已知限制、未修改范围。阶段 2 保持“待用户验收”，阶段 3 保持未开始。

- [ ] **Step 8: 最终差异安全审查**

检查 Git diff 不含 API key、数据库内容、生产画布 JSON、一键复色交叉引用或无关文件。共享脏文件不执行整文件提交；如需提交，先用 staged diff 逐行确认只含已审核改动。

---

## Execution Order and Review Gates

1. Task 1-3 完成后：后端不可变版本、审核和锁定门禁检查点。
2. Task 4-5 完成后：AI 授权、失败保护和接口检查点。
3. Task 6-7 完成后：画布节点与审核面板检查点。
4. Task 8 完成后：自动化、浏览器和用户验收检查点。

每个检查点由执行者先运行测试并立即修复已知问题；只有测试和浏览器检查均无已知问题时才请求用户审核。拿不准的产品行为、付费调用或数据发送范围必须暂停并询问用户。
