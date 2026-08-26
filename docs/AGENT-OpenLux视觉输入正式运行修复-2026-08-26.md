# AGENT OpenLux 视觉输入正式运行修复

## 目标

让 OpenLux `https://api.openlux.ai/v1` 下的 `deepseek-v4-flash` 与 `deepseek-v4-pro` 在 Lavans AGENT 中接收图片，同时继续禁止系统静默切换 Provider 或模型。

## 根因

- 隔离 AGENT 真实请求已证明 Flash/Pro 都能读取图片；问题不在模型能力或 OpenLux 多模态协议。
- 正式软件的 Provider 配置中 `vision_models` 被保存为 `[]`，视觉安全门因此按设计阻断。
- API 设置页完整保存 Provider 时遗漏 `vision_models`，重启或再次保存会丢失这项隐藏能力登记。

## 已完成

- 视觉安全门增加精确兼容规则：仅限 HTTPS 主机 `api.openlux.ai`、路径为空或 `/v1`、模型 ID 精确为 `deepseek-v4-flash` / `deepseek-v4-pro`。
- APIMART 以及其他中转站的同名模型不会因此放行。
- API 设置页新建、规范化和保存 Provider 时均保留 `vision_models`。
- OpenLux 持久配置恢复 Flash/Pro 的视觉能力登记。

## 验证

- 失败回归：修改前 2 项失败，分别复现 OpenLux 被阻断和设置页遗漏保存字段。
- 聚焦回归：10/10 通过。
- AGENT 会话、Skill 组合、整轮生成与恢复邻近回归：24/24 通过。
- 合计：34/34 通过。
- JSON 解析、Node 语法和差异空白检查通过。

## 未完成的现场验收

记录时正式 Lavans 进程已关闭，尚未在重新启动后的正式界面再次发送图片。下次启动会加载本次后端补丁；只需用 OpenLux `deepseek-v4-flash` 发送一张图片，确认不再出现“未确认支持视觉输入”的阻断，并由模型正确描述图片。

## 安全边界

- 没有再次调用付费 API。
- 没有自动重试、切换 Provider 或切换模型。
- 没有修改现有聊天记录、节点、GenerationRound 或恢复逻辑。
- 没有提交、推送或杀进程。
