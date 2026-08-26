# Douyin TikTok Story Skill

本仓库只包含抖音/TikTok达人剧情Skill代码。数据库独立放在 `douyin-tiktok-story-database` 仓库，两者安装后组合使用。

## 目录

```text
skill/
├── SKILL.md
├── agents/openai.yaml
├── assets/
└── scripts/
    ├── local_search.py
    ├── ingest_scripts.py
    └── extract_legacy.ps1
install.ps1
```

## 安装

将两个仓库克隆到同一级目录：

```powershell
git clone <SKILL_REPO_URL> douyin-tiktok-story-skill
git clone <DATABASE_REPO_URL> douyin-tiktok-story-database
cd .\douyin-tiktok-story-skill
.\install.ps1 -DatabaseRepoPath ..\douyin-tiktok-story-database
```

安装器会把Skill复制到 `$HOME\.codex\skills\douyin-tiktok-story-skill`，校验并复制数据库，然后执行本地健康检查。整个运行过程不访问网络。

## 本地测试

```powershell
python "$HOME\.codex\skills\douyin-tiktok-story-skill\scripts\local_search.py" status
python "$HOME\.codex\skills\douyin-tiktok-story-skill\scripts\local_search.py" search "校园 师生误会 前三秒冲突" --top-k 5
```

本仓库不包含真实数据库。数据库内容的许可范围由数据库仓库单独声明。

## License

Skill代码采用 [MIT License](LICENSE)。数据库不受本仓库MIT许可证覆盖。
