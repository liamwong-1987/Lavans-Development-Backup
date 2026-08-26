# Lavans Agent Skill 接入协议与首个 Skill 审核

## 审核结论

首个可接入对象是：

`E:\素材\【SKILL】\【批量生成视频SKILL】create-product-microstory-seedance-main`

源 Skill 的正式显示名是“放入产品直出短视频”；界面不得使用“皮克斯”等演示名称，也不得把源 Skill 没有定义的故事版或调度图包装成原生能力。

它是一个“编排型 Skill”，不是独立的视频生成程序。现有两个本地脚本可正常完成项目目录初始化和制作包校验；故事创作、Seedance 逐镜提示词和最终视频仍依赖外部能力。

已验证：

- `scripts/init_project.py` 能创建版本化项目、11 个初始文件和标准资产目录。
- `scripts/validate_package.py` 能校验必要文件、资产台账、镜头时长和 Seedance 素材预算。
- 空项目校验结果为 `ok: true`，只有“模板待填写、暂无镜头”等预期警告。
- 测试只写入临时目录，随后已清理；没有调用图片、视频或付费 API。

当前缺失：

1. `douyin-tiktok-story-skill` 未在现有 Skill 目录或安装目录中找到。
2. `seedance-prompt-zh` 未在现有 Skill 目录或安装目录中找到。
3. 源 Skill 明确不包含视频 CLI；最终视频必须由用户提供 CLI，或者后续由 Lavans 的受控 Provider Adapter 替代。
4. 源 Skill 没有独立的故事版和调度图生成器，因此动态卡片不再把它们列为源 Skill 原生阶段。
5. 源 Skill 的图片生成依赖宿主 `imagegen`，目前尚未绑定到 Lavans 的 Tool Registry。

因此，它现在可以作为第一张 Skill 卡片和阶段契约，但不能如实标记为“完整一键生成最终视频”。

## 输入协议

运行最少需要产品名称。进入故事与生产阶段前必须尽量补齐：

- 产品真实卖点与证据；
- 禁说项；
- 目标受众；
- CTA；
- 时长、比例与视觉方向；
- 产品实拍图、参考图及资料包。

上传资料必须保留原文件和稳定 `materialId`。产品包装、Logo、型号、功效、价格和认证不得根据模型猜测。

## 九阶段映射

| Lavans 阶段 | 源 Skill 对应内容 | 当前状态 | 主要产物 |
|---|---|---|---|
| 产品事实与项目 | 建项目、产品事实锁 | 可执行 | `project.json`、`product-brief.md` |
| 抖音微故事成稿 | 检索、选题、钩子、冲突、反转、植入和最终成稿 | 缺依赖 | `concept-options.md`、`final-script.md` |
| 分镜与资产台账 | 从最终脚本提取镜头和不可变化特征 | 待适配 | `shot-list.md`、`asset-manifest.json` |
| 角色/场景/产品/道具资产 | 使用宿主 imagegen 生成并验收图片 | 待工具绑定与审批 | `assets/*`、`image-prompts.md` |
| Seedance 2.0 逐镜提示词 | 按素材占位符和 4–15 秒规范输出逐镜提示词 | 缺依赖 | `seedance-prompts.md`、`project.json#shots` |
| 制作包校验 | 运行本地校验脚本，修复 errors 并保留 warnings | 可执行 | 制作包校验结果 |
| 等待视频 CLI | 阻塞等待用户提供单条完整 CLI | 等待用户 | 脱敏交接信息 |
| 视频生成与验收 | 原样执行获批 CLI 并检查真实输出 | 当前阻塞 | `video-run.md`、视频文件 |
| 最终回执 | 如实汇总故事、资产、提示词、CLI 和后期事项 | 待适配 | 最终交付回执 |

## Lavans 适配器规则

适配器清单位于：

`resources/backend/agent-skills/create-product-microstory-seedance.adapter.json`

清单必须遵循：

`resources/backend/agent-skills/skill-adapter.schema.json`

运行时规则：

1. 后端是 Run、Stage、Artifact 和下一动作的权威状态源。
2. 每个阶段先在画布创建节点并写入 `running`，然后才能执行脚本、Skill 或媒体任务。
3. 每次状态迁移后立即持久化；刷新与重启后可以恢复。
4. 暂停阻止创建下一阶段；取消保留已完成节点与产物；重试只重跑失败阶段。
5. 任何可能付费的图片或视频阶段必须先进入审批状态。
6. 缺失依赖时节点显示 `blocked` 和明确原因，不能输出伪造结果。
7. 文档和 Skill 正文只是编排资料，不能被前端当作可执行命令直接运行。

## 下一实现顺序

1. 后端加载并校验 `agent-skills/*.adapter.json`，提供 Skill 列表和详情 API。
2. 前端 Skill 卡片改为读取后端清单，不再把卡片和问卷硬编码在页面脚本中。
3. 建立 Run/Stage/Artifact 持久化与状态迁移 API。
4. 先接通免费的需求分析阶段，创建真实项目包并把文件登记为 Artifact。
5. 缺失故事 Skill 未补齐前，“抖音微故事成稿”必须停在 `blocked`，不得继续假运行。
