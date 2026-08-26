# Lavans 全软件 UI 改造：技术与恢复架构

统一执行入口：`LANVAS_UI_DECISION_REGISTER_V1.md`。本文件只描述实现分层和数据边界，不自行改变页面几何结构或产品功能。

## 当前结构

- `resources/frontend/index.html` 是全软件外壳，负责全局左侧栏、主题入口和 iframe 页面切换。
- `resources/frontend/smart-canvas-core/theme.js` 提供全局深浅主题与缩放状态。
- 每个功能页面保持独立 HTML、CSS、JavaScript 与业务逻辑；一键复色核心位于 `recolor.html`、`app.js` 与既有样式文件。
- 画布 Agent 位于智能画布及其后端服务，已存在独立的审核、产物、恢复与执行账本能力。
- API 设置是全软件唯一 Provider、模型、密钥与 CLI 设置来源。

## 阶段二已落地的样式分层

1. `lanvas-tokens.css`：只定义字体、深浅主题、深紫主色、状态色、阴影、圆角和动效令牌，不声明页面几何结构。
2. `lanvas-components.css`：只提供显式启用的 `.lanvas-primary`、`.lanvas-surface` 和 `.lanvas-status-*` 公共组件；不再覆盖 `.card`、`.panel`、`.sidebar` 或 `.primary-btn` 等页面通用类名。
3. `lanvas-shell.css`：所有规则均由 `body[data-lanvas-page="shell"]` 限定，只能作用于全软件外壳和全局左侧栏。
4. `lanvas-pages.css`：所有规则均按页面身份限定；一键复色保留已批准的内部布局规则，API 设置、画布和其他页面只接受视觉令牌，不改几何结构。
5. `lanvas-unified.css`：仅作为稳定入口导入上述四层，现有 13 个页面无需更改资源链接。
6. `lanvas-unified.js`：根据当前 HTML 文件写入稳定的 `data-lanvas-page`，全局导航图标、致敬入口与主题桥只在 `shell` 页面安装。

## 页面身份边界

- 全软件外壳：`shell`。
- 一键复色：`recolor`，是唯一允许按已批准效果图调整内部版面的页面。
- API 设置：`api-settings`，版块、顺序、字段、按钮和位置冻结。
- 智能画布与 Agent：`smart-canvas`，保持画布工具栏、节点位置、右栏宽度和现有工作流。
- 其余页面按文件名获得独立身份，公共层不得通过宽泛选择器改变其版面。

## 一键复色实施边界

- 可新增稳定的展示类、数据属性和非业务包装容器，以解决旧 CSS 互相覆盖的问题。
- 可重写任务列表与右栏的视觉布局规则，但不得改变上传、扫描、生成、状态、日志、重试、预览、详情、下载、重置及键盘切换的业务函数。
- 三图详情保持模板、生成、参考色的原有顺序；任务列表隐藏而不删除参考色单元，避免破坏既有详情和选择逻辑。

## 已知风险

- 当前工作区已包含大量未提交的前端、后端和 Agent 修改，不能通过 Git 重置或整文件覆盖回滚。
- 现有页面存在旧 CSS、内联样式和动态渲染样式并存的情况；后续必须继续使用页面专属选择器。
- 外壳与 iframe 均存在主题/缩放逻辑；软件内浏览器必须在连接恢复后补做真实窗口验证。
