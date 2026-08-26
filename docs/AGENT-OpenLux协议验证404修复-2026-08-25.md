# AGENT OpenLux 协议验证 404 修复

## 最终目标

“验证协议”只验证用户当前明确选择的协议。OpenLux 选择 `openai` 时验证标准 `/v1/models`；只有选择 `apimart` 时才探测 `/v1/tasks/healthcheck_probe_do_not_submit`。验证不得自动切换协议，也不得刷新、覆盖或重分模型列表。

参考画布只用于核对“不同协议使用各自端点和鉴权方式”的结构，不照搬它的模型分类。Lavans 继续保留已经确认的五类模型列表：

1. 图片 `image`
2. LLM `chat`
3. 视频 `video`
4. 音频 `audio`
5. 未知 `unknown`

## 根因

旧界面把“验证协议”固定送往 APIMart 异步任务探针。OpenLux 是 OpenAI Compatible Provider，不提供 APIMart 的 `/v1/tasks/` 路径，所以该探针返回 404；与此同时，它的标准 `/v1/models` 正常返回 200。

## 最终修复

- 前端先读取当前选中的协议。
- `openai`、`gemini`、`volcengine` 等协议调用通用连通验证，由后端按所选协议选择正确的模型端点和鉴权头。
- `apimart` 才调用异步任务探针；其 404 不再被拿来判定 OpenLux 的 OpenAI 协议失败。
- 协议验证不调用自动协议切换，也不写入模型选择器状态。
- 拉取模型仍是独立动作；五类模型、人工分类覆盖和精确模型 ID 规则保持不变。

## 验收证据

- 自动测试：`canvas-provider-model-classification.test.js` 与 `canvas-api-model-category-ui.test.js`，4/4 通过。
- 测试同时锁定五类标签、五类列表、人工分类覆盖、精确模型 ID，以及协议验证不调用 `applyDetectedProtocol` / `setFetchedModelState`。
- 隔离端口真实 OpenLux：当前选择 `openai`，`api.openlux.ai` 的协议验证返回 HTTP 200，消息为 `Provider 连通测试成功`。
- 未执行图片、视频、音频或 LLM 生成；无付费请求。

## 加载与恢复

- 修改文件：`resources/frontend/canvas-api-settings.html`
- 注释校准：`resources/backend/routes/canvasRoutes.js`
- 回归文件：`resources/backend/tests/canvas-api-model-category-ui.test.js`、`resources/backend/tests/canvas-provider-model-classification.test.js`
- 当前 3132 实例未被重启；刷新 API 设置页面即可重新加载前端修复。
- 未执行 Git 提交或推送。
