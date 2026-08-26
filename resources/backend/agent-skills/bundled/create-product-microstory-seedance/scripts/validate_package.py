#!/usr/bin/env python3
"""Validate a product-microstory package and Seedance 2.0 shot budgets."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path


REQUIRED_FILES = [
    "project.json",
    "brief/product-brief.md",
    "story/concept-options.md",
    "story/final-script.md",
    "assets/asset-manifest.json",
    "prompts/image-prompts.md",
    "prompts/seedance-prompts.md",
    "production/shot-list.md",
    "production/edit-guide.md",
    "production/video-run.md",
    "qa/checklist.md",
]

TYPE_LIMITS = {"image": 9, "video": 3, "audio": 3}
SIZE_LIMITS = {
    "image": 30 * 1024 * 1024,
    "video": 50 * 1024 * 1024,
    "audio": 15 * 1024 * 1024,
}


def load_json(path: Path, errors: list[str]) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (json.JSONDecodeError, OSError) as exc:
        errors.append(f"无法读取 JSON：{path}：{exc}")
        return {}
    if not isinstance(data, dict):
        errors.append(f"JSON 顶层必须是对象：{path}")
        return {}
    return data


def resolve_asset_path(project_dir: Path, raw_path: str) -> Path:
    path = Path(raw_path)
    return path if path.is_absolute() else project_dir / path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project_dir", help="Project package directory")
    parser.add_argument("--strict", action="store_true", help="Treat warnings as errors")
    args = parser.parse_args()

    project_dir = Path(args.project_dir).expanduser().resolve()
    errors: list[str] = []
    warnings: list[str] = []
    checks: list[str] = []

    if not project_dir.is_dir():
        errors.append(f"项目目录不存在：{project_dir}")
    else:
        for relative in REQUIRED_FILES:
            path = project_dir / relative
            if not path.is_file():
                errors.append(f"缺少文件：{relative}")
            elif path.suffix == ".md":
                content = path.read_text(encoding="utf-8")
                if "<!-- 待填写" in content:
                    warnings.append(f"仍含待填写模板：{relative}")
        checks.append("required-files")

    project = load_json(project_dir / "project.json", errors)
    manifest = load_json(project_dir / "assets/asset-manifest.json", errors)

    if project and project.get("seedance_version") != "2.0":
        errors.append("project.json 的 seedance_version 必须为 2.0")
    if project:
        duration = project.get("target_duration_seconds")
        if not isinstance(duration, (int, float)) or duration <= 0:
            errors.append("target_duration_seconds 必须为正数")

    raw_assets = manifest.get("assets", []) if manifest else []
    if not isinstance(raw_assets, list):
        errors.append("asset-manifest.json 的 assets 必须是数组")
        raw_assets = []

    assets: dict[str, dict] = {}
    for index, asset in enumerate(raw_assets, start=1):
        if not isinstance(asset, dict):
            errors.append(f"assets[{index}] 必须是对象")
            continue
        asset_id = asset.get("id")
        asset_type = asset.get("type")
        if not isinstance(asset_id, str) or not asset_id:
            errors.append(f"assets[{index}] 缺少 id")
            continue
        if asset_id in assets:
            errors.append(f"重复资产 ID：{asset_id}")
            continue
        if asset_type not in TYPE_LIMITS:
            errors.append(f"资产 {asset_id} 的 type 必须为 image/video/audio")
        assets[asset_id] = asset

        status = asset.get("status")
        raw_path = asset.get("path")
        if status in {"已提供", "已生成"}:
            if not isinstance(raw_path, str) or not raw_path:
                errors.append(f"资产 {asset_id} 状态为 {status}，但没有 path")
            else:
                path = resolve_asset_path(project_dir, raw_path)
                if not path.is_file():
                    errors.append(f"资产文件不存在：{asset_id} -> {path}")
                elif asset_type in SIZE_LIMITS and path.stat().st_size >= SIZE_LIMITS[asset_type]:
                    errors.append(f"资产文件超过 Seedance 2.0 大小限制：{asset_id}")
        elif status not in {"待准备", "待生成", "可选", None}:
            warnings.append(f"资产 {asset_id} 使用了非标准状态：{status}")

    shots = project.get("shots", []) if project else []
    if not isinstance(shots, list):
        errors.append("project.json 的 shots 必须是数组")
        shots = []
    if not shots:
        warnings.append("project.json 尚未登记任何镜头")

    shot_ids: set[str] = set()
    total_shot_duration = 0.0
    for index, shot in enumerate(shots, start=1):
        if not isinstance(shot, dict):
            errors.append(f"shots[{index}] 必须是对象")
            continue
        shot_id = shot.get("id")
        if not isinstance(shot_id, str) or not shot_id:
            errors.append(f"shots[{index}] 缺少 id")
            shot_id = f"shots[{index}]"
        elif shot_id in shot_ids:
            errors.append(f"重复镜头 ID：{shot_id}")
        shot_ids.add(shot_id)

        duration = shot.get("duration_seconds")
        if not isinstance(duration, (int, float)):
            errors.append(f"镜头 {shot_id} 缺少数值 duration_seconds")
        else:
            total_shot_duration += float(duration)
            if not 4 <= duration <= 15:
                errors.append(f"镜头 {shot_id} 时长 {duration} 秒，不在 4–15 秒范围")

        asset_ids = shot.get("assets", [])
        if not isinstance(asset_ids, list):
            errors.append(f"镜头 {shot_id} 的 assets 必须是数组")
            continue
        counts: Counter[str] = Counter()
        for asset_id in asset_ids:
            asset = assets.get(asset_id)
            if asset is None:
                errors.append(f"镜头 {shot_id} 引用了未登记资产：{asset_id}")
                continue
            asset_type = asset.get("type")
            if asset_type in TYPE_LIMITS:
                counts[asset_type] += 1
        for asset_type, limit in TYPE_LIMITS.items():
            if counts[asset_type] > limit:
                errors.append(
                    f"镜头 {shot_id} 的 {asset_type} 资产 {counts[asset_type]} 个，超过 {limit} 个"
                )
        if sum(counts.values()) > 12:
            errors.append(f"镜头 {shot_id} 的总素材数超过 12 个")

    if shots and project:
        target = project.get("target_duration_seconds")
        if isinstance(target, (int, float)) and abs(total_shot_duration - float(target)) > 2:
            warnings.append(
                f"镜头生成时长合计 {total_shot_duration:g} 秒，与目标 {target:g} 秒相差超过 2 秒；如需裁切请在后期说明中标注"
            )
    checks.extend(["project-schema", "asset-manifest", "seedance-shot-budgets"])

    if args.strict and warnings:
        errors.extend(f"严格模式：{warning}" for warning in warnings)
        warnings = []

    result = {
        "ok": not errors,
        "project_dir": str(project_dir),
        "checks": checks,
        "asset_count": len(assets),
        "shot_count": len(shots),
        "errors": errors,
        "warnings": warnings,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
