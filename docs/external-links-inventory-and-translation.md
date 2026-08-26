# Lavans 外链跳转点盘点 + 翻译方案

> 盘点范围：`D:\Lavans备份\resources\frontend\`（已排除 `vendor/`、`backup_*`、`*.bak*` 等无关目录）。
> 主进程参照：`D:\Lavans备份\asar-refresh-work-20260814\app\main.js` / `preload.js`（与 `resources\app.asar` 同源，2026-08-14 版本）。
> 后端参照：`D:\Lavans备份\resources\backend\server.js`。

---

## 一、外链跳转点清单（按页面分组）

### 1. API 设置页 `canvas-api-settings.html`

#### 1.1 RunningHub 获取 Key（静态 HTML 硬编码，`<a target="_blank">`）
- `canvas-api-settings.html:6192` — `https://www.runninghub.cn/enterprise-api/consumerApi?inviteCode=rh-v1331` — 文本「国内 Key」— 用途：RH币 API Key 获取（国内）
- `canvas-api-settings.html:6193` — `https://www.runninghub.ai/enterprise-api/consumerApi?inviteCode=rh-v1331` — 文本「国外 Key」— 用途：RH币 API Key 获取（国外）
- `canvas-api-settings.html:6213` — `https://www.runninghub.cn/enterprise-api/sharedApi?inviteCode=rh-v1331` — 文本「国内 Key」— 用途：共享/钱包 Key 获取（国内）
- `canvas-api-settings.html:6214` — `https://www.runninghub.ai/enterprise-api/sharedApi?inviteCode=rh-v1331` — 文本「国外 Key」— 用途：共享/钱包 Key 获取（国外）

#### 1.2 ModelScope 获取 Token（静态 HTML 硬编码，`<a target="_blank">`）
- `canvas-api-settings.html:6276` — `https://www.modelscope.cn/my/access/token` — 文本「获取 Token · 国内」— 用途：获取 Token
- `canvas-api-settings.html:6277` — `https://www.modelscope.ai/my/access/token` — 文本「获取 Token · 国外」— 用途：获取 Token

#### 1.3 ModelScope 模型库（静态 HTML 硬编码，`<a target="_blank">`）
- `canvas-api-settings.html:6448` — `https://www.modelscope.cn/aigc/models` — 文本「中文模型库」— 用途：查看模型库
- `canvas-api-settings.html:6449` — `https://www.modelscope.ai/civision/models` — 文本「英文模型库」— 用途：查看模型库

#### 1.4 推荐 API 平台卡片（JS 数据 `RECOMMENDED_APIS` + 模板动态渲染）
模板渲染位置：`canvas-api-settings.html:8919 / 8920 / 8922`（`href="${api.register_url}"` / `register_url_cn`，`target="_blank"`）。
数据（`register_url` / `register_url_cn`）：
- 土豆API `:6803` — `https://api.ai-tudou.net/register?aff=GmBu` — 「获取 Key」
- EXELLOME `:6821` — `https://new.exellome.online/register?aff=r2dZ` — 「获取 Key」
- FHL `:6840` — `https://www.fhl.mom/register?aff=86L574B4T2N9` — 「获取 Key」
- VIP-GPT `:6855`（常量 `:6725`）— `https://www.vip-gpt.net/vip-gpt/register?aff=YGMS7BDKNY5Y` — 「获取 Key」
- RunningHub `:6869` — `https://www.runninghub.ai/enterprise-api/consumerApi?inviteCode=rh-v1331` — 「获取 Key」
- APIMART `:6880` — `https://apimart.ai/zh/register?aff=1uyAbb` — 「获取 Key（国外）」；`:6881` — `https://apib.ai/register?aff=1uyAbb` — 「获取 Key（国内）」
- 灵境API `:6893`（常量 `:6723`）— `https://apistudio.vip/register?aff=g1CT` — 「获取 Key」
- ModelScope `:6911` — `https://www.modelscope.ai/my/access/token`（国外）；`:6912` — `https://www.modelscope.cn/my/access/token`（国内）
- Agnes AI `:6926` — `https://platform.agnes-ai.com/settings/apiKeys` — 「获取 Key」

#### 1.5 内置平台 Onboarding 引导卡片（JS 模板渲染 `ONBOARDING_GUIDES`）
模板位置：`canvas-api-settings.html:7322 / 7323 / 7362 / 7375`（`href="${guide.primaryUrl}"` / `secondaryUrl` / `walletPrimaryUrl`，`target="_blank"`）。
数据（`ONBOARDING_GUIDES`，`canvas-api-settings.html:6742-6765`）：
- ModelScope：`primaryUrl`=`https://www.modelscope.cn/my/access/token`、`secondaryUrl`=`https://www.modelscope.ai/my/access/token`
- RunningHub：`primaryUrl`=`https://www.runninghub.ai/enterprise-api/consumerApi?inviteCode=rh-v1331`、`walletPrimaryUrl`=`https://www.runninghub.ai/enterprise-api/sharedApi?inviteCode=rh-v1331`
- 灵境API：`primaryUrl`=`https://apistudio.vip/register?aff=g1CT`

#### 1.6 Seedance 私信链接（静态 HTML，`<a target="_blank">`）
- `canvas-api-settings.html:8965` — `https://space.bilibili.com/78652351` — 文本「私信获取 Seedance」（i18n `api.recommendSeedancePrivateAction`）— 用途：B站私信联系

#### 1.7 即梦 CLI / GPT CLI / Antigravity CLI 账户卡片 —— **无外链**
- 「帮助」按钮 `:6293`（即梦）/ `:6309`（Codex）/ `:6324`（Antigravity）分别调用 `openJimengHelp()` / `openCodexHelp()` / `openGeminiCliHelp()`，打开的是**本地帮助弹窗**（`:6519-6595`），内容来自后端 CLI 命令输出，**不含外部 URL**。
- 三张卡片整体不含注册/下载/文档外链。

#### 1.8 仅作展示 / 默认配置的 URL（**不是**可点击外链，不计入跳转点）
- `:6155 / 6157 / 6158 / 6161 / 6164 / 6167`：`api-inference.modelscope.cn/v1`、`api-inference.modelscope.ai/v1`、`www.runninghub.ai`、`apib.ai`、`ark.cn-beijing.volces.com/api/v3` 等——是「请求地址」提示文案（`inline-code` 展示），非 `<a>`。
- `:6711 / 6720 / 6721 / 6722 / 6724 / 6726` 及 `RECOMMENDED_APIS` 里的 `base_url` 字段——API 默认请求地址，非浏览器外链。

### 2. 画布侧栏 `studio-sidebar.html` + `studio-sidebar.js`
作者「wuli大雄」旁 4 个社交图标，HTML 与 JS 各一份（JS 为动态重建侧栏时的模板字符串）：
- `studio-sidebar.html:159` / `studio-sidebar.js:193` — `https://space.bilibili.com/78652351` — B站 — `<a target="_blank">` — 作者社交
- `studio-sidebar.html:164` / `studio-sidebar.js:198` — `https://www.xiaohongshu.com/user/profile/6433c34c000000001a023538` — 小红书 — `<a target="_blank">` — 作者社交
- `studio-sidebar.html:169` / `studio-sidebar.js:203` — `https://www.youtube.com/@大雄dx`（URL 编码 `%E5%A4%A7%E9%9B%84dx`）— YouTube — `<a target="_blank">` — 作者社交
- `studio-sidebar.html:174` / `studio-sidebar.js:208` — `https://x.com/dx8152?s=21` — X — `<a target="_blank">` — 作者社交

### 3. 画布节点 `canvas.html` / `canvas.js` / `smart-canvas-core/smart-canvas-core.js` + `smart-canvas.html`
- **结论：节点错误信息里没有外链**。错误提示全部走 `toast()` / `showErrorModal()` / `apiErrorMessage()` 纯文本，无 URL。
- **无 RunningHub 数据集链接、无文档链接**（`canvas.js` / `smart-canvas-core.js` 中唯一的 `http(s)` 匹配是 SVG 命名空间 `http://www.w3.org/2000/svg` 和占位符 `https://example.com/media`）。
- `smart-canvas-core.js:7154` — `window.open(displayMediaUrl({url}), '_blank')` — 打开**生成的视频**（经 `/api/download-output?inline=1&url=...` 代理），非外部网页跳转。
- `canvas.js:14894` / `asset-manager.js:2564` — `downloadUrl()` 里 `<a download target="_blank">` 是**下载文件**，非外链。

### 4. `asset-manager` / `online-studio` / `text-studio`
- `asset-manager.js` 的 4 处 `window.open`（`:3377` 本地上传、`:3427` 画布素材、`:3789` 素材项、`:4389` 本地项）打开的是**素材/资源预览 URL**（本地 `/uploads`、`asset://`、blob 或经 `/api` 代理的媒体），**非「跳转外部网页」**。
- `asset-manager.html`、`online-studio.html/js`、`text-studio.html/js`：**无外链**。

### 5. 其他页面 / 全局 JS
- `ltx-director-timeline.js:1075` — `window.open("https://github.com/WhatDreamsCost/WhatDreamsCost-ComfyUI", "_blank")` — 文本「? / Help / Documentation」— 用途：打开 GitHub 文档（LTX Director 工具栏帮助按钮）。
- `ltx-director-timeline.js:3124` — `window.open()` 无 URL（空窗口，疑似打印用），非外链。
- `app.js`（`api-config-url` 占位 `https://yunwu.ai/v1`）、`creativeStudio.js:163`（`https://api.openlux.ai/v1` 占位）、`canvasStudio.js:780`（同占位）、`index.html`、`canvas.html`、`canvas-list.html/js`、`system-switcher.js`：**均无外部网页外链**（仅输入框 placeholder 与内部路由跳转）。

---

## 二、跳转方式分析

- **前端触发方式**：全部是 `<a href="https://..." target="_blank">` 或 `window.open(url, '_blank')`。**没有**任何 `shell.openExternal` 调用。
- **主进程**：`app.asar` 的 `main.js` 里**没有** `shell.openExternal`、**没有** `setWindowOpenHandler`、**没有** `will-navigate`/`new-window` 拦截。`webPreferences` 为 `nodeIntegration:false, contextIsolation:true`，`preload.js` 仅通过 `contextBridge` 暴露 `lavansWindow`（最小化/最大化/关闭/窗口状态）。
- **因此当前行为**：点击外链时走 Electron 默认逻辑——在 **Electron 内部新建一个子 `BrowserWindow`** 加载该 URL，**不是**打开系统默认浏览器。这是一个与常规预期不同的现状，也是翻译方案需要顺带修正的点。
- **后端**：`backend/server.js` 及 `routes/`、`services/` 中**没有** `shell.openExternal` 代理、没有 `exec('start')` / `cmd /c start` 之类的"打开外链"基础设施。后端是纯 HTTP 服务（Express），只负责 API/文件，不参与外链跳转。

> 说明：以上"Electron 内子窗口"为 Electron 未注册 `setWindowOpenHandler` 时的文档默认行为；因本任务为只读盘点，未实际运行程序验证，但代码侧可确认「未走系统默认浏览器」。

---

## 三、翻译方案设计（推荐 + 备选）

### 推荐方案 C（混合，主推）：保留原链接 + 每个外链旁新增「翻译」按钮
- 每个外链呈现两个动作：「打开」（原行为，用系统浏览器）＋「翻译」（用 Google 翻译网页打开）。
- 优点：用户有选择权、不改变默认行为、可对中文站（B站/小红书/国内注册页）跳过翻译。
- 缺点：UI 略复杂（但本项目外链基本是按钮/图标形式，改动可控）。

### 方案 A（等价实现）：Google 翻译网页 + 「翻译」按钮
- `window.open('https://translate.google.com/translate?sl=auto&tl=zh-CN&u=' + encodeURIComponent(url))`
  （等价现代写法：`https://translate.google.com/?sl=auto&tl=zh-CN&op=websites&u=`）
- 优点：零成本、零依赖、零维护。
- 缺点：Google 翻译网页偶发验证码；**`translate.google.com` 在大陆可能无法访问**；JS 重的前端站点（x.com、平台控制台）经 `translate.goog` 代理可能渲染异常。

### 方案 B（可选全局开关）：API 设置页顶部「开启翻译」开关
- 开启后所有外链自动走 Google 翻译。
- 优点：一次开启、全自动。
- 缺点：默认行为改变；**对所有外链无差别翻译**（B站/小红书等中文站会被误翻、注册页可能因代理破坏登录），体验差。不建议作为默认，仅可作为 C 之上的可选项。

### 最终建议
- **主推 C（=A 的落地形态）**，并把「翻译服务基础地址」抽成一个**可配置常量**，便于大陆用户替换为其他翻译服务或自建代理。
- **翻译按钮只对"英文/外文站点"有意义**：B站、小红书、ModelScope 国内站、RunningHub 国内站、APIMART 国内注册页、Agnes 的中文路径等**应跳过翻译**（白名单/按域名判断）。
- 注册/获取 Key 类链接**保留 `aff=` / `inviteCode=` 推广参数**——`encodeURIComponent(url)` 会完整保留 query，不影响推广归因。

---

## 四、关键技术约束

1. **Electron 外链应走主进程 `shell.openExternal`**：当前缺失。建议在主进程 `main.js` 增加：
   - `mainWindow.webContents.setWindowOpenHandler(({url}) => { shell.openExternal(url); return {action:'deny'}; })`
   - 并对 `will-navigate`（外部域名）做同样的 `shell.openExternal` + `preventDefault`。
   - 这样「打开」和「翻译」都落到**系统默认浏览器**（Google 翻译网页需要完整浏览器 + cookie 才稳定）。
2. **翻译按钮的注入方式（三选一/组合）**：
   - **A1 手动**：在每个外链 DOM 旁手写翻译按钮——改动面大、易遗漏（尤其 JS 模板字符串里的外链）。
   - **A2 通用 utility（推荐）**：新增 `wrapExternalLink(url)` / `openTranslated(url)` / `openExternal(url)`，所有外链（含动态渲染）统一调用。改动集中在模板渲染函数与静态 HTML。
   - **A3 MutationObserver**：全局监听 DOM，自动给 `a[href^="http"]` / `[target="_blank"]` 追加翻译按钮——零散改造少、覆盖广，但要排除 `download` 链接、内部路由、媒体预览，误伤风险需白名单。
   - 建议：**以 A2 为主，A3 作为兜底**（覆盖侧栏/ltx 等零散外链）。
3. **后端无 `shell.openExternal` 代理**：无需后端配合；翻译纯前端 + 主进程即可完成。若未来要"可配置翻译服务/自建翻译代理"，才需后端加一个转发端点（本期不需要）。
4. **`window.open` 会被 `setWindowOpenHandler` 拦截**：新增 handler 后需保证原有 `downloadUrl()`（`<a download>`）、媒体预览 `window.open('/api/...')` 不受影响——handler 里只对 `http(s)://` 外部 URL 调 `shell.openExternal`，对 `/api/`、`asset://`、`blob:`、`data:` 放行或 `deny` 走原逻辑。
5. **翻译目标语言**：默认 `zh-CN`，与现有 i18n 默认 `zh` 一致；可做成常量。

---

## 五、推荐实施顺序

- **T1（主进程）**：`main.js` 增加 `setWindowOpenHandler` + `shell.openExternal`；`preload.js` 可选暴露 `openExternal(url)`。→ 修复「外链在 Electron 内打开」并成为翻译方案的地基。
- **T2（前端工具层）**：新增通用 utility（`translateUrl(url)`、`openExternal(url)`、`openTranslated(url)`），集中定义翻译服务地址常量与「跳过翻译」域名白名单。
- **T3（API 设置页）**：`canvas-api-settings.html` 的静态外链（1.1/1.2/1.3/1.6）＋ JS 模板（1.4 推荐平台、1.5 Onboarding 引导）全部接入「打开/翻译」。
- **T4（侧栏 + 零散）**：`studio-sidebar.html/js` 的 4 个社交图标、`ltx-director-timeline.js` 的 GitHub 帮助按钮接入；用 MutationObserver（A3）兜底遗漏点。
- **T5（可选增强）**：全局「开启翻译」开关（方案 B）+ 翻译服务地址可配置 + 中文站白名单跳过。

---

## 六、与已有功能的冲突 / 风险

- **已有 i18n 系统**（`smart-canvas-core/i18n-core.js`，`StudioI18n`，zh/en 双语 + `data-i18n`）：只负责**界面文案**，与「翻译外部网页」无冲突；翻译按钮文案应走 i18n key。
- **改变现有外链打开行为**：把「Electron 内子窗口」改为「系统默认浏览器」属于行为变更，需回归测试所有外链（确保原本能打开的现在仍能打开、下载链接不受影响）。
- **登录态/ Cookie**：注册与获取 Key 链接（APIMART / Agnes / ModelScope / RunningHub 等）经 Google 翻译代理后，站点登录态、OAuth、JS 交互可能失效；因此「翻译」必须作为**可选**动作，不能默认翻译注册类链接。
- **推广参数**：`aff`/`inviteCode` 会随 `encodeURIComponent` 完整保留，无冲突，但需在实现时确认不丢参。
- **视频/SPA 站点**：YouTube、X、GitHub 等经 Google 翻译代理可能渲染异常或无法登录，建议这类链接**默认只提供「打开」，不提供「翻译」**（或提示）。
- **大陆网络**：`translate.google.com` 可能不可达；建议翻译服务地址可配置，或提示用户「翻译需可访问 Google 翻译」。
