# Lavans

Lavans 是一套本地 AI 创意画布，包含普通画布、智能画布、AGENT、Skill 编排和一键复色。

本仓库只保存第一方源码、测试、文档和无密钥配置示例。Provider 密钥、用户上传、生成结果、日志、缓存、Electron 运行时和已打包程序不会提交到 Git。

## 本地开发

要求：Windows、Node.js 18 或更高版本，以及 pnpm 11.19.0。

1. 运行 `pnpm install` 安装锁定依赖。
2. 如需环境变量，把 `resources/.env.example` 复制为 `resources/.env`。
3. 如需文件配置，把 `resources/backend/*.example.json` 复制为同名但去掉 `.example` 的本地配置文件。
4. 运行 `pnpm start` 启动桌面版，或运行 `pnpm run start:backend` 仅启动本地服务。

运行 `pnpm test` 执行自动化测试，运行 `pnpm run check` 做核心 JavaScript 语法检查。

## Windows 构建

Windows 打包要求 Node.js 22.12 或更高版本。运行 `pnpm run build:win`，产物位于 `release/Lavans-win32-x64/`。构建只包含第一方运行源码、生产依赖和无密钥示例；不会带入本地密钥、用户数据、日志或缓存。

## 安全边界

- Provider 与模型必须按现有配置精确选择，不自动切换中转站、模型或协议。
- 真实或付费生成继续经过现有确认门；测试默认使用假 Provider 与临时数据。
- 不要提交 `resources/.env`、`resources/backend/config.json`、`canvas-config.json` 或 `creative-config.json`。
- 本源码仓库不提交已打包 Electron 运行时；经单独授权运行 `pnpm run build:win` 后，`Lavans.exe` 只生成在被 Git 忽略的 `release/` 目录中，不能用旧程序替代。
