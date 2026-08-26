# Lavans

Lavans 是一套本地 AI 创意画布，包含普通画布、智能画布、AGENT、Skill 编排和一键复色。

本仓库只保存第一方源码、测试、文档和无密钥配置示例。Provider 密钥、用户上传、生成结果、日志、缓存、Electron 运行时和已打包程序不会提交到 Git。

## 本地开发

要求：Windows、Node.js 18 或更高版本。

1. 运行 `npm install` 安装依赖。
2. 如需环境变量，把 `resources/.env.example` 复制为 `resources/.env`。
3. 如需文件配置，把 `resources/backend/*.example.json` 复制为同名但去掉 `.example` 的本地配置文件。
4. 运行 `npm start` 启动桌面版，或运行 `npm run start:backend` 仅启动本地服务。

运行 `npm test` 执行自动化测试，运行 `npm run check` 做核心 JavaScript 语法检查。

## 安全边界

- Provider 与模型必须按现有配置精确选择，不自动切换中转站、模型或协议。
- 真实或付费生成继续经过现有确认门；测试默认使用假 Provider 与临时数据。
- 不要提交 `resources/.env`、`resources/backend/config.json`、`canvas-config.json` 或 `creative-config.json`。
- 本源码仓库不包含已打包 Electron 运行时。正式 `Lavans.exe` 需要在后续单独授权的构建步骤中生成，不能用旧程序替代。
