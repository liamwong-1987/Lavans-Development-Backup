# Canvas AGENT 阶段 2：剧本审核与版本管理设计

最后更新：2026-08-20（Asia/Shanghai）

## 1. 目标

在“纯文字剧本真实执行”之后增加一个可持久化、可恢复、不可覆盖旧版本的剧本审核阶段。用户可以查看完整剧本、勾选局部修改范围、手动修改或调用当前画布 API 设置中的文字模型生成新版本，最后通过并锁定一个版本，作为后续分镜阶段的唯一输入。

本阶段采用用户确认的 B 方案：整篇剧本审核，同时支持按开头、人物关系、冲突、反转、产品植入、结尾、台词和时长等范围进行局部修改；每次保存仍产生一个完整的新版本。

## 2. 强制约束

1. 旧版本不可覆盖、不可原地修改、不可因取消或失败而丢失。
2. 每个成功剧本版本都必须在画布上拥有独立可见节点。
3. 运行中、待审核、已通过、已锁定、失败和取消状态必须在节点上可见。
4. 只有一个版本可以处于“已锁定”状态。
5. 没有已锁定版本时，禁止进入分镜阶段。
6. 锁定版本需要继续修改时，必须从该版本派生新草稿，锁定文件本身保持不变。
7. 手动修改不调用模型；AI 修改必须使用画布 API 设置中当前选定且已配置的 Provider 与模型，不写死 GPT 或 DeepSeek。
8. 每次 AI 调用前显示真实 Provider、模型和发送范围，并要求精确授权；设置变化后旧授权失效。
9. AI 修改失败、超时、被取消或返回空内容时，不登记成功版本，不覆盖任何已有文件。
10. 画布 AGENT 与一键复色保持完全隔离，不共享素材、模板、设置、模型选择或任务。
11. 阶段 2 完成后停止，等待用户验收，不自动执行阶段 3。

## 3. 方案选择

### 采用：不可变版本文件 + Run 状态索引

每个剧本版本保存为独立 Markdown 文件，Run 中只保存可序列化的版本元数据和当前选择。版本文件是事实来源，Run 状态用于界面、恢复和路由校验。

优点：

- 与现有 Artifact 和项目目录结构一致。
- 可以直接打开、下载、对比和备份。
- 旧版本天然不可覆盖。
- 不需要引入新数据库。
- 刷新和崩溃恢复沿用现有 Run JSON 持久化。

不采用覆盖 `final-script.md` 后另存快照的方案，因为错误顺序可能先覆盖再快照；不采用独立数据库版本表，因为当前规模下会增加迁移、备份和一致性成本。

## 4. 文件结构

项目目录新增：

```text
story/
  versions/
    script-v001.md
    script-v002.md
    script-v003.md
    version-v001.json
    version-v002.json
    version-v003.json
  reviews/
    diff-v001-v002.json
    diff-v002-v003.json
  locked-script.json
```

- `script-vNNN.md`：该版本完整剧本，创建后不再修改。
- `version-vNNN.json`：版本来源、父版本、修改范围、Provider、模型、时间、摘要和内容哈希。
- `diff-vNNN-vNNN.json`：按行和章节计算的本地差异摘要，不调用模型。
- `locked-script.json`：当前唯一锁定版本的 ID、文件路径、内容哈希和锁定时间。

原有 `story/final-script.md` 在首次进入阶段 2 时导入为 V1。导入完成后，所有版本操作只写入 `story/versions/`。后续分镜阶段读取 `locked-script.json` 指向的不可变版本文件，不依赖可能变化的工作文件。

## 5. Run 与 Stage 数据结构

`microstory` 阶段增加可序列化字段：

```json
{
  "reviewStatus": "awaiting-review",
  "activeVersionId": "script-v003",
  "approvedVersionId": "script-v003",
  "lockedVersionId": "script-v003",
  "scriptVersions": []
}
```

每个 `scriptVersions` 项包含：

```json
{
  "id": "script-v003",
  "number": 3,
  "parentVersionId": "script-v002",
  "source": "ai-revision",
  "status": "locked",
  "relativePath": "story/versions/script-v003.md",
  "metadataPath": "story/versions/version-v003.json",
  "changeScopes": ["hook", "conflict"],
  "customInstruction": "",
  "providerId": "canvas-provider-id",
  "model": "configured-model",
  "contentHash": "sha256",
  "createdAt": 0,
  "approvedAt": 0,
  "lockedAt": 0
}
```

允许的版本状态：

- `draft`
- `awaiting-review`
- `approved`
- `locked`
- `superseded`

生成尝试不是成功版本。运行、失败和取消使用独立的 `revisionAttempts` 记录，避免失败任务占用正式版本号。

## 6. 修改范围

AI 修改面板默认使用勾选项，不要求用户打字：

- `hook`：修改开头钩子
- `character-relation`：修改人物关系
- `conflict`：加强或调整冲突
- `reversal`：调整反转
- `product-placement`：调整产品植入
- `ending`：修改结尾
- `dialogue`：调整台词
- `duration`：调整整体时长
- `other`：其他修改

只有勾选 `other` 时显示文字输入框。至少选择一个修改范围后才能提交 AI 修改。用户可以选择多个范围。

## 7. 画布与右侧面板

### 7.1 可见节点

首次进入阶段 2 时，从已有最终剧本创建 V1 节点。后续每个成功版本都创建独立节点：

```text
抖音微故事成稿
      |
      +-- 剧本 V1 · 已通过
      +-- 剧本 V2 · 未采用
      +-- 剧本 V3 · 已锁定
```

版本节点显示：

- 版本号和状态灯。
- 来源：首次生成、手动修改或 AI 修改。
- 修改范围。
- Provider 和模型；手动版本显示“手动修改”。
- 创建时间。
- 父版本。
- 打开、对比和选择入口。

节点创建顺序：AI 修改开始前先创建“修改任务节点”；执行成功后再创建不可变版本节点。失败或取消保留任务节点及真实状态，但不创建伪版本节点。

### 7.2 右侧审核面板

点击版本节点后显示：

- 完整剧本预览。
- 当前版本元数据。
- 与父版本的差异。
- `手动修改`
- `AI 修改`
- `通过本版本`
- `锁定并结束阶段 2`
- `查看修改记录`

手动修改以所选版本为基础打开完整编辑区。保存时创建新版本，不修改原版本。

AI 修改先显示勾选项，再显示 Provider、模型、发送范围和不发送范围。用户确认后才调用模型。

## 8. 后端接口

新增接口：

```text
POST /api/canvas/agent-runs/:runId/stages/microstory/review/initialize
GET  /api/canvas/agent-runs/:runId/stages/microstory/versions
GET  /api/canvas/agent-runs/:runId/stages/microstory/versions/:versionId
POST /api/canvas/agent-runs/:runId/stages/microstory/versions/manual
GET  /api/canvas/agent-runs/:runId/stages/microstory/versions/:versionId/revise/preflight
POST /api/canvas/agent-runs/:runId/stages/microstory/versions/:versionId/revise
POST /api/canvas/agent-runs/:runId/stages/microstory/versions/:versionId/approve
POST /api/canvas/agent-runs/:runId/stages/microstory/versions/:versionId/lock
GET  /api/canvas/agent-runs/:runId/stages/microstory/versions/:versionId/diff/:otherVersionId
POST /api/canvas/agent-runs/:runId/stages/microstory/revision-attempts/:attemptId/cancel
```

接口规则：

- 所有写接口校验 Run、阶段、基准版本和当前状态。
- 手动与 AI 修改都携带 `baseVersionId`，防止用户基于过期页面覆盖新选择。
- AI 修改授权必须精确匹配当前 Provider 与模型。
- 同一个 Run 同时最多允许一个 AI 修改任务。
- 重复请求使用操作 ID 保证幂等。
- 版本号只在内容文件和元数据文件安全写入成功后分配。
- 文件先写入同目录临时文件，校验内容和哈希后再原子改名。

## 9. AI 数据边界

AI 修改只发送：

- 基准剧本全文。
- 用户勾选的修改范围。
- 勾选“其他”时的补充说明。
- 已确认的产品事实锁和禁说项。
- 必要的时长、比例和平台信息。

默认不发送：

- 故事数据库原文、检索摘录或数据库文件名。
- 未选择上传的本地文件。
- 其他画布节点内容。
- API 密钥。
- 一键复色的任何素材、模板或设置。

模型必须返回完整剧本，不能只返回片段。后端检查非空、最小长度和产品事实锁，再运行现有防复刻检查。防复刻未通过时，任务保持阻塞或失败，不登记成功版本。

## 10. 审核与锁定状态机

```text
awaiting-review
  -> approved
  -> locked

awaiting-review
  -> manual revision attempt
  -> new awaiting-review version

awaiting-review
  -> AI revision attempt
  -> running / cancelled / failed
  -> new awaiting-review version (success only)
```

- “通过本版本”只改变审核选择，不自动锁定。
- 通过另一个版本时，原 `approved` 版本变为 `superseded`；已锁定版本不受影响。
- 锁定需要版本已通过。
- 锁定成功后阶段 2 标记完成，Run 保持在用户验收点。
- 已有锁定版本时再次修改，会从锁定版本派生新草稿；原锁定版本保持 `locked`，直到新版本通过并执行显式“替换锁定版本”。
- 替换锁定版本需要二次确认，并保留旧锁定记录到事件日志。

## 11. 失败、取消与恢复

- AI 调用前失败：任务节点显示失败，不产生版本文件。
- AI 返回后校验失败：保留失败回执，不登记成功版本。
- 用户取消：中止请求，任务节点显示取消，已有版本不变。
- 服务重启：运行中的尝试恢复为 `interrupted`，允许只重试该尝试。
- 文件写入中断：临时文件不进入 Artifact；启动时清理本阶段遗留的已知临时文件。
- Run 保存失败：版本文件虽然存在但未登记时，通过恢复扫描按元数据和哈希补登记，禁止重复分配版本号。
- 页面刷新：从后端 Run 重新生成版本节点与审核面板，不依赖临时前端状态。

## 12. 测试策略

所有生产代码先有失败测试，再做最小实现。至少覆盖：

1. 现有 `final-script.md` 只导入一次并成为 V1。
2. 手动修改生成新版本，父版本内容和哈希不变。
3. AI 修改使用当前画布 Provider 与模型，不写死模型。
4. Provider 或模型变化后旧授权失效。
5. 只有勾选 `other` 才接受和发送补充文字。
6. AI 失败、超时、空返回、取消和防复刻不通过均不创建成功版本。
7. 同一 Run 同时只允许一个 AI 修改任务。
8. 重复操作 ID 不产生重复版本。
9. 通过版本时保持旧文件；同一时间只有一个普通 `approved` 选择。
10. 锁定前必须通过；同一时间只有一个当前锁定版本。
11. 锁定版本不能原地修改。
12. 未锁定时阶段 3 保持阻塞。
13. 刷新和服务重启后版本、节点、状态和事件恢复一致。
14. 每个成功版本生成独立可见画布节点。
15. 失败和取消保留真实任务节点，不生成伪版本节点。
16. 差异接口返回本地计算结果，不调用模型。
17. 生产画布 JSON 在自动化测试前后哈希一致。
18. 一键复色文件、路由和配置未发生交叉引用。

浏览器验收覆盖：

- V1、V2、V3 节点布局与状态灯。
- 分段修改多选和“其他”输入显隐。
- 手动修改、AI 修改、通过、锁定和版本对比。
- 刷新恢复。
- 取消与失败状态。
- 字体、卡片高度和长剧本滚动可读性。

## 13. 阶段完成条件

以下条件全部满足才交给用户审核：

- 自动化测试全部通过。
- 浏览器实际操作通过。
- 至少完成一次手动新版本闭环。
- AI 路径在受控测试中通过；生产调用只在用户确认真实 Provider、模型和发送范围后执行。
- 旧版本内容哈希保持不变。
- 刷新后节点和状态恢复。
- 没有已知错误。
- 阶段 3 未自动启动。

用户审核通过后，阶段 2 才标记为完成并允许制定阶段 3 的详细设计。
