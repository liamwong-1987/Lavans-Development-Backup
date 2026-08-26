# Canvas AGENT 恢复协议

每次上下文压缩、换窗口、服务重启或开发中断后，严格按以下顺序恢复：

1. 读取 `docs/superpowers/specs/2026-08-20-canvas-agent-delivery-foundation-design.md`。
2. 读取 `docs/canvas-agent/execution-ledger.json`，只接受其中唯一的 `nextAction`。
3. 读取 `docs/Canvas-Agent开发任务总表.md`、`docs/Canvas-Agent开发进度.md`、`docs/canvas-agent/decisions.md` 和 `docs/canvas-agent/phase-mapping.md`。
4. 查看 Git 工作区；所有未提交内容默认属于用户，不覆盖、不回退、不批量提交。
5. 核对账本中列出的备份、修改文件和测试证据。
6. 调用画布 AGENT foundation 状态接口，运行 Recovery Auditor。
7. 如果账本、Artifact、Dependency Graph、Run 或画布投影不一致，停止业务执行，只生成差异报告。
8. `running` 外部调用在重启后必须变为 `interrupted`，不得自动重发或重复扣费。
9. 已验收阶段不得重做；`awaiting-user` 必须等待用户确认。
10. 一键复色不属于恢复范围，禁止读取、迁移或绑定其素材与设置。

恢复入口：`GET /api/canvas-agent/foundation/status`

健康条件：`recovery.healthy === true`，且返回的 `ledger.nextAction` 与开发账本一致。
