---
name: create-product-microstory-seedance
description: 放入产品直出短视频：用户放入产品信息和图片后，调用 douyin-tiktok-story-skill 创作带钩子、冲突、反转和产品植入的微故事，使用内置 imagegen 直接生成并保存角色、场景和产品资产，再用 seedance-prompt-zh 输出 Seedance 2.0 逐镜提示词，最后自动询问并接入用户提供的 CLI 生成视频。适合个人创作者和电商团队批量产出剧情式种草、品牌植入与产品短视频。不得内置、猜测或包装任何视频生成 CLI。
---

# 放入产品直出短视频

只编排现有能力，不创建第二套故事框架：

1. 使用 `douyin-tiktok-story-skill` 完成选题、钩子、冲突、反转、产品植入和最终脚本。
2. 使用系统 `imagegen` 按最终脚本生成角色、场景、产品、道具或关键帧资产并保存到本地。
3. 使用 `seedance-prompt-zh` 编写可直接复制的 Seedance 2.0 逐镜提示词。
4. 询问用户提供其现有视频生成 CLI 命令，在用户授权后原样执行并验收输出。

不得调用 `convert-script-to-seedance`、Seedance 2.5 规范或另一套故事提示词。不得把视频 CLI、SDK、API 调用、可执行文件、provider 参数或 runner 脚本放进本 skill。

## 读取依赖

每次执行先从当前可用 skills 目录按 `name` 定位并完整读取：

- `douyin-tiktok-story-skill`
- `imagegen`
- `seedance-prompt-zh`

不要复制这三个依赖的正文或私有素材库到本 skill。找不到依赖时，说明缺失能力，只继续能够如实完成的阶段，不得伪造检索、图片生成或提示词校验结果。

需要规划或生成图片资产时读取 [references/asset-workflow.md](references/asset-workflow.md)。进入视频生成阶段前读取 [references/cli-handoff.md](references/cli-handoff.md)。下文 `scripts/...` 均相对于本 skill 目录；解析绝对路径后执行。

## 1. 收集事实并建立项目

优先让用户一次输入：产品名称、真实卖点与证据、禁说项、目标人群、CTA、期望时长/风格、产品实拍图或已有素材。只追问会阻塞结果的缺失项；用户未指定时默认 9:16、45 秒、原创 stylized 角色。不得虚构功效、数据、认证、价格或包装文字。

运行：

```powershell
python scripts/init_project.py --name "<项目名>" --output-root "<workspace>/output/product-microstories"
```

从 JSON 取得 `project_dir`。把事实与缺口写入 `brief/product-brief.md`。项目目录已存在时使用脚本自动创建 `-v2`、`-v3`，不要覆盖旧项目。

## 2. 直接使用抖音 skill 成稿

把产品 brief 交给 `douyin-tiktok-story-skill`，严格执行它的本地状态检查、两次互补检索、机制提炼和防复刻检查。把它的最终脚本原样保存到 `story/final-script.md`，并保留定位、人物、时间码、动作、台词、字幕、音效、植入说明和结尾钩子。

若抖音 skill 先给出多个方向，把方向保存到 `story/concept-options.md`；用户选择后仍由同一个抖音 skill 深化。若用户已经提供该 skill 的成稿，直接沿用，除非用户要求诊断、润色或复检。

后续只能解析制作需求，不得改变台词、人物关系、卖点、反转或结局。发现生成难点时优先拆镜或调整资产；必须改稿时回到 `douyin-tiktok-story-skill`。

## 3. 提取分镜与资产

读取最终脚本，只提取：

- 角色固定外观、服装、身高关系、表情和动作。
- 场景时间、光线、空间布局、轴线和关键物位置。
- 产品外观、包装方向、使用动作和状态变化。
- 参与伏笔、冲突或反转的关键道具。
- 必须固定构图或衔接的首帧、尾帧和关键帧。

先写 `production/shot-list.md` 和 `assets/asset-manifest.json`。资产 ID 使用 `IMG-01`、`VID-01`、`AUD-01`；记录类型、用途、镜头、状态、真实本地路径、Seedance 占位符和不可变化特征。

## 4. 生成并保存图片资产

按 `references/asset-workflow.md` 使用内置 `imagegen`。不同资产分别调用：先生成角色锚点，再用锚点生成必要衍生图，然后生成场景、产品、道具和关键帧。默认生成原创、非真实可识别人物的 stylized、3D 或插画角色；不要向 Seedance 提供写实真人脸部素材。

每次生成后：

1. 使用 `view_image` 检查角色、场景、产品和构图连续性。
2. 只保留合格成品，复制到 `<project_dir>/assets/...`。
3. 不覆盖已有文件；使用 `-v2`、`-v3`。
4. 把最终图片提示词写入 `prompts/image-prompts.md`。
5. 在 `assets/asset-manifest.json` 写入真实状态与路径。

已有真实产品图时优先保真使用，不重绘精确 Logo 或包装文字。图片生成不可用时，交付完整提示词和“待生成”清单，不得用占位图冒充成品。

## 5. 生成 Seedance 2.0 逐镜提示词

把以下材料直接交给 `seedance-prompt-zh`：

- `story/final-script.md` 的原始成稿。
- `production/shot-list.md`。
- `assets/asset-manifest.json` 中实际可用或待准备素材。
- 角色、场景、产品和声音的不可变化特征。

严格使用该 skill 的 `@图片N`、`@视频N`、`@音频N` 语法、4–15 秒时长、素材预算、运镜、声音和避坑规范。故事超过 15 秒时按自然停顿拆为多个生成镜头，不改变原脚本或说话人。

将结果保存到 `prompts/seedance-prompts.md`，包含素材映射、每镜时长、可复制提示词、一致性约束、生成顺序、尾帧接首帧、后期拼接，以及需后期完成的精确字幕、Logo、包装文字和 CTA。同步更新 `project.json` 的 `shots`。

## 6. 校验制作包

运行：

```powershell
python scripts/validate_package.py "<project_dir>"
```

修复全部 `errors`。未生成资产或未执行 CLI 可以保留为 `warnings`，但必须逐项说明。

## 7. 询问并执行用户的 CLI

读取并严格遵守 `references/cli-handoff.md`。完成提示词和预检后暂停，向用户索取其现有的完整视频生成 CLI 命令。不要提供猜测的命令或 provider 专属示例，不要创建任何 CLI wrapper。

用户粘贴命令即表示授权在本项目范围内执行该命令；若命令包含明文密钥、破坏性操作或项目外写入，先停止并要求用户改为环境变量或给出明确确认。其他情况下，在 `project_dir` 中原样执行，保留交互式终端，检查退出码与实际视频文件。

若用户选择自己运行，只返回项目目录、提示词文件和建议输出目录，不要代执行。

## 8. 最终回执

如实报告：

- 抖音 skill 是直接创作还是沿用成稿，以及其本地检索与防复刻回执。
- 已生成资产数量、待生成项和本地目录。
- Seedance 2.0 镜头数量与提示词路径。
- CLI 由用户提供、已执行/未执行、退出状态与视频路径。
- 仍需后期完成的字幕、Logo、包装文字、CTA 或拼接项。

不得声称已完成任何未实际执行的检索、生成、保存、校验或 CLI 调用。
