#!/usr/bin/env python3
"""Initialize a local product-microstory production package."""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path


SHANGHAI = timezone(timedelta(hours=8))


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    if slug:
        return slug[:63].rstrip("-")
    return f"product-story-{datetime.now(SHANGHAI):%Y%m%d}"


def unique_directory(root: Path, slug: str) -> Path:
    candidate = root / slug
    if not candidate.exists():
        return candidate
    version = 2
    while (root / f"{slug}-v{version}").exists():
        version += 1
    return root / f"{slug}-v{version}"


def write_text(path: Path, content: str) -> None:
    path.write_text(content.rstrip() + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Create a versioned local package for a product microstory."
    )
    parser.add_argument("--name", required=True, help="Human-facing project name")
    parser.add_argument("--output-root", required=True, help="Parent output directory")
    parser.add_argument("--slug", help="Optional lowercase English slug")
    parser.add_argument("--duration", type=int, default=45, help="Target duration in seconds")
    parser.add_argument("--aspect-ratio", default="9:16", help="Target aspect ratio")
    args = parser.parse_args()

    requested_slug = args.slug or slugify(args.name)
    slug = slugify(requested_slug)
    output_root = Path(args.output_root).expanduser().resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    project_dir = unique_directory(output_root, slug)

    directories = [
        "brief",
        "story",
        "assets/characters",
        "assets/scenes",
        "assets/products",
        "assets/props",
        "assets/keyframes",
        "prompts",
        "production",
        "qa",
        "video",
    ]
    for relative in directories:
        (project_dir / relative).mkdir(parents=True, exist_ok=False)

    created_at = datetime.now(SHANGHAI).isoformat(timespec="seconds")
    project = {
        "schema_version": "1.1",
        "project_name": args.name,
        "project_slug": project_dir.name,
        "created_at": created_at,
        "seedance_version": "2.0",
        "aspect_ratio": args.aspect_ratio,
        "target_duration_seconds": args.duration,
        "shots": [],
    }
    manifest = {
        "schema_version": "1.0",
        "project_slug": project_dir.name,
        "updated_at": created_at,
        "assets": [],
    }

    (project_dir / "project.json").write_text(
        json.dumps(project, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (project_dir / "assets/asset-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    templates = {
        "brief/product-brief.md": """# 产品与项目事实锁

<!-- 待填写：产品名称、真实卖点与证据、禁说项、受众、CTA、时长、风格、已有素材和假设。 -->
""",
        "story/concept-options.md": """# 原创方向

<!-- 待填写：抖音 skill 给出的候选方向，或记录用户已选方向。 -->
""",
        "story/final-script.md": """# 最终分段脚本

<!-- 待填写：原样保存 douyin-tiktok-story-skill 的最终成稿。 -->
""",
        "prompts/image-prompts.md": """# 图片资产提示词

<!-- 待填写：每项资产的最终生成提示词、引用图用途、版本和本地路径。 -->
""",
        "prompts/seedance-prompts.md": """# Seedance 2.0 逐镜提示词

<!-- 待填写：素材映射、一致性设定、逐镜提示词、生成顺序、拼接和风险。 -->
""",
        "production/shot-list.md": """# 分镜计划

<!-- 待填写：镜头 ID、成片时间码、生成时长、动作、声音、产品证明、素材和衔接点。 -->
""",
        "production/edit-guide.md": """# 生成与后期拼接说明

<!-- 待填写：生成顺序、尾帧接首帧、对白、音效、字幕、Logo、CTA 和裁切点。 -->
""",
        "production/video-run.md": """# 视频 CLI 执行回执

<!-- 待填写：由用户提供命令；仅记录脱敏后的执行时间、程序名、退出码、任务状态和输出路径。 -->
""",
        "qa/checklist.md": """# 质量检查

- [ ] 产品事实、证据和禁说项已锁定
- [ ] 抖音 skill 的最终成稿已原样保存
- [ ] 0–3 秒钩子与主冲突同源
- [ ] 产品由剧情阻碍自然触发
- [ ] 反转有伏笔并回扣开场
- [ ] 已记录本地检索和防复刻回执
- [ ] 角色、场景、产品和声音连续
- [ ] 每个 Seedance 镜头符合 2.0 素材与时长限制
- [ ] 所有素材状态、引用和本地路径真实
- [ ] 精确字幕、Logo、包装文字和 CTA 已安排后期
- [ ] 视频 CLI 只来自用户输入，未内置或猜测
""",
    }
    for relative, content in templates.items():
        write_text(project_dir / relative, content)

    result = {
        "ok": True,
        "project_dir": str(project_dir),
        "seedance_version": "2.0",
        "created_files": len(templates) + 2,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
