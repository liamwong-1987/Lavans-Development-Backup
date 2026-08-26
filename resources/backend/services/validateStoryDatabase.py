from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path


SQLITE_HEADER = b"SQLite format 3\x00"
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def emit(payload: dict) -> int:
    print(json.dumps(payload, ensure_ascii=False))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, required=True)
    args = parser.parse_args()
    database = args.db.resolve()
    base = {"ok": False, "runtime": "local_sqlite", "network_used": False}
    try:
        if not database.is_file():
            return emit({**base, "error": "数据库文件不存在"})
        if database.stat().st_size < 100:
            return emit({**base, "error": "数据库文件为空或不完整"})
        with database.open("rb") as handle:
            if handle.read(len(SQLITE_HEADER)) != SQLITE_HEADER:
                return emit({**base, "error": "文件不是有效的 SQLite 3 数据库"})

        conn = sqlite3.connect(f"file:{database.as_posix()}?mode=ro&immutable=1", uri=True)
        try:
            quick_check = conn.execute("PRAGMA quick_check").fetchone()
            if not quick_check or quick_check[0] != "ok":
                return emit({**base, "error": "SQLite 完整性检查未通过"})
            canonical = int(conn.execute("SELECT COUNT(*) FROM canonical_scripts").fetchone()[0])
            indexed = int(conn.execute("SELECT COUNT(*) FROM scripts_fts").fetchone()[0])
            columns = {row[1] for row in conn.execute("PRAGMA table_info(source_documents)").fetchall()}
            required_columns = {"id", "file_name", "stage", "platform", "content", "char_count"}
            missing_columns = sorted(required_columns - columns)
            if missing_columns:
                return emit({**base, "error": "数据库结构不兼容", "missing_columns": missing_columns})
            if canonical <= 0:
                return emit({**base, "error": "数据库中没有可检索的规范脚本"})
            if canonical != indexed:
                return emit({**base, "error": "全文索引数量与规范脚本数量不一致", "canonical_scripts": canonical, "indexed_scripts": indexed})
            return emit({
                **base,
                "ok": True,
                "canonical_scripts": canonical,
                "indexed_scripts": indexed,
                "byte_size": database.stat().st_size,
            })
        finally:
            conn.close()
    except sqlite3.Error as error:
        return emit({**base, "error": f"SQLite 读取失败：{error}"})
    except OSError as error:
        return emit({**base, "error": f"数据库文件读取失败：{error}"})


if __name__ == "__main__":
    raise SystemExit(main())
