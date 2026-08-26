/**
 * brand-config.js —— 品牌统一配置源（单一修改点）
 *
 * 下次改名 SOP（参考 docs/BRAND-LOCATIONS.md）：
 *   1. 改本文件的 BRAND 对象（只改 4 个字段：name / subtitle / title / appName）
 *   2. 静态 HTML 硬编码位置（BRAND-LOCATIONS.md 清单里的 *.html 静态文字）手动替换
 *   3. 主进程 asar 重新打包（解包 resources/app.asar → 改 main.js 引用 BRAND → asar pack）
 *   4. 启动.bat / *_main_extracted.js 等辅助文件手动同步
 *
 * 浏览器：通过 <script src="brand-config.js"></script> 引入
 *   - 经典 <script> 顶层 var BRAND 让 BRAND 成为 window 全局，其他脚本可直接 BRAND.name 引用
 *   - 同时 window.BRAND 显式挂载兼容 ES module 风格访问
 * Node.js：通过 require('./brand-config.js') 或 require('../frontend/brand-config.js') 导入
 */
var BRAND = {
  name: 'Lavans',
  subtitle: 'AI Creative Canvas',
  title: 'Lavans — AI Creative Canvas',
  appName: 'Lavans'
};

if (typeof window !== 'undefined') {
  window.BRAND = BRAND;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BRAND;
}