# 旧版代码说明

本目录下的文件是旧版实现，当前系统不使用。

## api.js
- 旧版 API 调用实现，使用 OpenAI `/images/edits` 端点
- 当前系统使用 `apiClient.js`（Chat Completions 端点）
- 旧版包含独立的颜色提取 + Mask 生成 + FormData POST 流程

## queue.js
- 旧版任务队列实现（TaskQueue 类）
- 当前系统在 `server.js` 中内联实现了批次运行器
- 旧版依赖 `api.js`

## 使用说明
- 当前系统真实入口：`backend/server.js`
- 当前主流程不依赖 `backend/legacy/` 内任何文件
- 本目录文件仅用于历史参考，**不要优先修改**
- 如需恢复旧代码，可从本目录查看原始实现
