# 品牌改名 SOP（BRAND-LOCATIONS）

> 维护者：项目所有人
> 目的：把 Lavans → Lavans 这种全局品牌改名**一处生效（JS 部分）+ 几步完成（其余部分）**，不再需要满世界搜索硬编码。

---

## 一、配置源（单一修改点）

**`resources/frontend/brand-config.js`** —— **唯一**需要改的文件。改完保存即可。

```js
var BRAND = {
  name: 'Lavans',                          // 主品牌名（窗口/托盘/Logo 主文字）
  subtitle: 'AI Creative Canvas',           // 副标题（Logo 副文字、About）
  title: 'Lavans — AI Creative Canvas',      // 浏览器/启动横幅/托盘 tooltip
  appName: 'Lavans'                          // 应用名（窗口 title/任务栏）
};
```

兼容性：
- 浏览器：经典 `<script>` 加载后，`var BRAND` 成为 window 全局，其他脚本可直接 `BRAND.name` / `BRAND.title`。
- Node.js（server.js）：`require('../frontend/brand-config.js')` 返回 BRAND 对象。
- Electron 主进程（asar 内 main.js）：通过 `process.resourcesPath/frontend/brand-config.js` 运行时读（无需重打包 asar 也能生效）。

---

## 二、自动应用 BRAND 的位置（改 brand-config.js 后**立即生效**）

这些位置都用 `${BRAND.name}` 等模板字符串引用，改一处全部更新。

### 2.1 JS 模板字符串

| 文件 | 引用 | 说明 |
|---|---|---|
| `resources/frontend/canvasStudio.js` | `BRAND.name` × 3 处 | 返回按钮 title、LLM 节点标签、生图占位文案 |
| `resources/frontend/smart-canvas-core/smart-canvas-core.js` | `BRAND.name` × 6 处 | 节点提示「被 ... 校验」、Provider 提示「尚未接入 ... Adapter」、4 处「... Canvas Adapter 未加载」 |
| `resources/frontend/canvas-api-settings.html` | `BRAND.name` × 5 处 | 5 条 CLI 帮助提示文案 |

### 2.2 后端启动横幅

| 文件 | 引用 |
|---|---|
| `resources/backend/server.js` | `const BRAND = require('../frontend/brand-config.js'); ... console.log(\`  \${BRAND.title}\`)` |

### 2.3 主进程（Electron）

| 文件 | 引用 |
|---|---|
| `resources/app.asar` 内 `main.js` | `BRAND.title`（托盘 tooltip）、`BRAND.appName`（窗口 title） |

main.js 已内置运行时读 brand-config.js 逻辑：

```js
let BRAND = { name: 'Lavans', title: 'Lavans — AI Creative Canvas', appName: 'Lavans' };
try {
  const brandPath = path.join(process.resourcesPath || '', 'frontend', 'brand-config.js');
  if (fs.existsSync(brandPath)) BRAND = require(brandPath);
} catch (_e) {}
```

**改 brand-config.js 后无需重打包 asar**，下次启动 Electron 自动读新值。

---

## 三、静态 HTML 硬编码位置（下次改名需**手动**改）

这些位置是 HTML 静态文字（`<title>`、`<span>` 等），纯 HTML 不能引用 JS 变量。下次改名按本清单替换。

| 文件 | 行 | 位置 | 备注 |
|---|---|---|---|
| `resources/frontend/index.html` | 6 | `<title>` | 浏览器标题 |
| `resources/frontend/index.html` | 16 | `.window-title` | 窗口标题栏文字 |
| `resources/frontend/index.html` | 27 | 顶栏 `.logo` | `.logo-text strong` |
| `resources/frontend/index.html` | 48 | 侧栏 `.sidebar-logo` | `.logo-text strong` |
| `resources/frontend/smart-canvas-core/smart-canvas.html` | 143 | `.create-card-sub` | "API 生成"卡片副标题 |
| `resources/frontend/canvas-api-settings.html` | 7 | `<title>` | API 设置页标题（功能页标题，不一定需要改） |

每个位置改成后，请同步刷新文档（本表）。

### 3.1 HTML 副标题位置

`<small>AI Creative Canvas</small>` 在 `.logo-text` 里（顶栏 logo 和侧栏 logo 各 1 处）。这些副标题下次改名也需手动改（但因 BRAND.subtitle 也可引用，**下一步优化方向**：把 logo 文字部分改成 JS 渲染）。

---

## 四、辅助文件（开发/打包辅助）

| 文件 | 位置 | 备注 |
|---|---|---|
| `resources/backend/启动.bat` | 第 3 行 `title` 和第 6 行 `echo` | 开发辅助脚本，已有注释指向 brand-config.js |
| `D:/Lavans备份/_asar_main_extracted.js` | 根目录解包参考文件 | 已过期（与 app.asar 内容不一致），下次清理时删 |
| `resources/output/canvas/library/storage_settings.json` | `D:\Lavans备份\...` 路径 | 用户数据里的项目目录路径，不改 |
| `resources/output/canvas/*/chat-conversations.json` 等用户数据 | | 历史数据，不改 |
| 各 `*.log` 文件 | 历史启动日志里的 "元创Lavans V2" | 历史记录，不改 |

---

## 五、保留不动的项（技术标识/历史兼容）

按 Lavans 改名 Lavans 任务约定，以下**技术标识保留原名**，与品牌解耦：

- `package.json` 的 `name: "lavans"`（npm package name）
- `window.LavansCanvasAdapter`（JS 全局变量）
- `lavans-canvas-adapter.js`（文件名/模块标识）
- `smart-canvas-core/`（模块目录名）
- `lavansSetMode()` 等函数名（"lavans" = 色度/复色的技术命名，非品牌）
- `Lavans.exe` / `Uninstall Lavans.exe`（可执行文件名，改名会导致 Electron 无法加载 app.asar）
- `D:\Lavans备份\`（项目根目录，所有绝对路径都依赖）
- 用户数据里的绝对路径（`storage_settings.json` 等）
- 代码注释里的 "Lavans"（开发者笔记，不可见）
- 历史 `.log` 启动横幅（"元创Lavans V2"）
- `.bak` / `.before-` 备份文件

---

## 六、下次改名的标准 SOP

按以下步骤顺序执行，预计总时间 **15-30 分钟**：

### 步骤 1：改配置源（1 分钟）

```bash
# 编辑 resources/frontend/brand-config.js，改 4 个字段：
#   name / subtitle / title / appName
```

### 步骤 2：JS 部分立即生效（自动）

无需操作。canvasStudio.js / smart-canvas-core.js / canvas-api-settings.html / server.js 启动横幅 下次启动自动应用新品牌。

### 步骤 3：静态 HTML 硬编码（10 分钟）

按本文档**第三节**表格，grep + 替换：

```bash
cd D:/Lavans备份/resources/frontend
grep -rn "Lavans\|AI Creative Canvas" --include="*.html" | grep -v ".bak\|.before"
```

按输出逐个 Edit。常见位置：index.html（4 处）、smart-canvas.html（1 处）、canvas-api-settings.html title（可选）。

### 步骤 4：辅助文件（5 分钟）

- `resources/backend/启动.bat`：同步改 title 和 echo
- `_asar_main_extracted.js`（如果保留）：同步删或更新
- 清理过期备份文件（可选）

### 步骤 5：asar 主进程（**无需操作**）

main.js 已内置运行时读 brand-config.js 逻辑。asar 不需要重新打包。下次启动 Electron 自动应用新品牌。

> ⚠️ **asar 何时需要重新打包？** 只有改 main.js 本身（非品牌字段，比如加新功能）才需要重新打包 asar。改 brand-config.js **不需要重打包**。

### 步骤 6：验证 + 更新文档（5 分钟）

1. 重启后端服务，确认启动横幅是 `BRAND.title`
2. 浏览器访问，确认 index.html title 和 logo 是新品牌
3. 重启 Electron，确认托盘 tooltip 和窗口 title 是新品牌
4. 更新本文档**第三节**表格（记录新硬编码位置）

---

## 七、紧急回滚

如果改名出问题：

1. **JS 部分**：回滚 brand-config.js（git revert 或手动改回）
2. **asar**：从备份 `app.asar.before-brand-rename-20260815.asar` 恢复
3. **HTML/启动.bat**：grep 旧品牌名，回滚

asar 备份位置：`resources/app.asar.before-brand-rename-20260815.asar`

---

## 八、为什么 HTML 不能自动改？

技术上可以让主进程在 `loadURL` 后用 `webContents.executeJavaScript` 注入占位符替换所有 DOM 文本，但：
- 破坏 SPA 状态（React/组件可能重新渲染后丢失）
- 复杂度过高（需要解析所有 HTML 节点）
- 实际改名频率极低（每 1-2 年一次），手动替换 6 处 HTML 性价比更高

当前方案（JS 自动 + HTML 手动清单）是**务实可靠**的折中。

---

## 九、命名约定（防止品牌再次混淆）

- **主品牌名**：`BRAND.name`（如 Lavans），所有窗口/Logo/品牌文字都用这个
- **副标题**：`BRAND.subtitle`（如 AI Creative Canvas），用于 Logo 副文字
- **完整品牌**：`BRAND.title`（如 Lavans — AI Creative Canvas），用于浏览器标题/启动横幅/托盘
- **应用名**：`BRAND.appName`（如 Lavans），用于窗口 title/任务栏应用名（可与主品牌名相同）

下次给产品起名时，优先用**画布/Canvas** 词根嵌入（如 Lavans = Liam + Canvas），保持「私人作品个人 IP 化」原则（不挂公司前缀）。