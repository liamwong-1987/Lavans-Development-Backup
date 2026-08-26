# Lavans 一键复色最终证据索引 V1

更新时间：2026-08-24  
状态：第④档收口索引；不替代用户实际软件 100% 人工验收。

## 1. 验收结论边界

- 一键复色主界面、浅深主题和 14 个正式产品场景已获得用户实际软件 100% 人工验收。
- 自动测试用于证明结构、功能、安全和防回归，不单独构成视觉通过。
- 本轮没有真实或付费 Provider 调用，没有上传真实素材，没有写入真实批次、费用、提示词或画布数据，没有 Git 提交或推送。

## 2. 权威设计与实施资料

1. `LANVAS_RECOLOR_FINAL_DESIGN_SPEC_V1.md`：最终视觉与交互规则。
2. `LANVAS_RECOLOR_LIGHT_MASTER_V0.html`：浅色母版结构。
3. `LANVAS_RECOLOR_FINAL_V3.html`：14 场景与深浅结构基线。
4. `LANVAS_RECOLOR_EXACT_UI_MIGRATION_TASK_CARD_V1.md`：生产迁移边界和最终清单。
5. `LANVAS_FULL_SOFTWARE_RECOLOR_MIGRATION_EXPERIENCE_V1.md`：向其他独立页面复用的方法。

## 3. 最终截图证据

### 主界面、暂停、空态与改绑

- `D:\Lavans备份\outputs\dark-audit-after-compare-running-100pct.png`
- `D:\Lavans备份\outputs\recolor-v2-compare-paused-light-100pct.png`
- `D:\Lavans备份\outputs\recolor-v2-compare-paused-dark-100pct.png`
- `D:\Lavans备份\outputs\recolor-v2-compare-empty-light-100pct.png`
- `D:\Lavans备份\outputs\recolor-v2-compare-empty-dark-100pct.png`
- `D:\Lavans备份\outputs\recolor-v2-compare-rebind-light-100pct.png`
- `D:\Lavans备份\outputs\recolor-v2-compare-rebind-dark-100pct.png`

### 剩余 10 个正式弹窗

- 证据目录：`D:\Lavans备份\outputs\recolor-stage3-current`
- 浅色总览：`light-modal-master-current-contact-sheet.png`
- 深色总览：`dark-modal-master-current-contact-sheet.png`
- 高风险单图：提示词、历史、计费、三图、导出、裁剪、参考色、开始、重做、彻底清空的浅深 2560×1392 截图均保存在同目录。

### 实际软件公共弹窗居中与完整遮罩

- 浅色：`D:\Lavans备份\outputs\recolor-actual-center-correction\light-palette-1920x1080.png`
  - SHA256：`D44EC81B175D103C5AF42638913E3551183312966EDCEF3A16169A8380ADEAA6`
- 深色：`D:\Lavans备份\outputs\recolor-actual-center-correction\dark-palette-1920x1080.png`
  - SHA256：`F7D5E78E082468033017B65B9603988A260359A5D3A7A48B6CB264A4CE5EAA38`
- 最终几何测量：浅深真实面板映射到完整软件窗口后的中心误差均约 `0.0015 px / 0.0005 px`。
- 用户随后在实际软件 100% 明确回复“可以验收了”。

## 4. 自动与安全证据

- 外壳专项：`resources/backend/tests/lanvas-shell-v3.test.js`
  - 验证 Tokens → Components → Shell V3、212 px 左栏、近黑灰深色外壳、完整弹窗遮罩、100% 密度与响应式铺满。
- V3 页面专项：`resources/backend/tests/lanvas-recolor-v3.test.js`
  - 验证正式 DOM、14 场景入口、生成中无确定进度、任务级模型快照等。
- 结构阻断与模型改绑：`resources/backend/tests/recolor-structural-blockers.test.js`
  - 验证改绑资格、竞态、幂等、回滚、FIFO、重启恢复、远端未知保护和继续暂停。
- 正式无付费场景夹具：`resources/backend/tests/recolor-scene-fixture.test.js`
  - 验证 paused、empty、rebind 从正式状态和正式入口到达，Provider 生成与新增费用为 0。
- 阶段 A～G 与上传、历史、导出、队列和恢复回归：`resources/backend/tests/*recolor*.test.js`。

第④档最终交付已重新运行：

```text
node --check resources/frontend/app.js
node --test resources/backend/tests/lanvas-shell-v3.test.js
node --test <resources/backend/tests 下全部 *recolor*.test.js>
```

2026-08-24 真实结果：

- `resources/frontend/app.js` 语法检查：PASS。
- 外壳专项：9/9 PASS。
- `resources/backend/tests` 下全部 `*recolor*.test.js`：93/93 PASS。
- 全部测试使用内存夹具或本地伪造 Provider；真实图片生成请求 0，真实 Provider 调用 0，新增真实费用 0。

结果已同步外置大脑、状态真相表和交接事件日志。

## 5. 可恢复状态

- 第④档修改前备份：`D:\Lavans备份\backup_before_recolor_stage4_20260824-104500`
- 实际软件弹窗根因修复前备份：`D:\Lavans备份\backup_before_recolor_actual_center_20260824-001607`
- 项目工作区已有大量用户未提交修改；恢复时只可按明确文件逐项比较，不得对整个仓库执行 reset、checkout 或覆盖。

## 6. 权威跨窗口记录

- `D:\Backup\Documents\temu\canvas-development\docs\外置大脑\00-启动入口.md`
- `D:\Backup\Documents\temu\canvas-development\docs\状态真相表.md`
- `D:\Backup\Documents\temu\canvas-development\docs\交接事件日志.md`
- `D:\Backup\Documents\temu\canvas-development\docs\外置大脑\window-20260823-recolor-next-stage-guardian-decision.md`

如截图、聊天摘要与状态真相表冲突，以状态真相表和实际代码／测试重新核对结果为准。
