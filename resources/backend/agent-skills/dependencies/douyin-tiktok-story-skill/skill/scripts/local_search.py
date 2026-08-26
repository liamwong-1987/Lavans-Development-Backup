from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "assets" / "douyin-story.sqlite3"
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def emit(value, code=0):
    print(json.dumps(value, ensure_ascii=False, indent=2))
    return code


def connect():
    return sqlite3.connect(f"file:{DB.as_posix()}?mode=ro", uri=True)


def units(text: str, n: int = 2) -> set[str]:
    value = re.sub(r"\s+", "", text.lower())
    return {value[i:i+n] for i in range(max(0, len(value)-n+1))}


def excerpt(text: str, query: str, limit: int = 700) -> str:
    tokens = re.findall(r"[\u3400-\u9fff]{2,}|[a-z0-9]+", query.lower())
    positions = [text.lower().find(token) for token in tokens if text.lower().find(token) >= 0]
    start = max(0, (min(positions) if positions else 0) - 120)
    return text[start:start+limit].strip()


def search(query: str, top_k: int):
    conn = connect(); conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT id,file_name,stage,platform,content,char_count FROM canonical_scripts").fetchall()
    qu = units(query)
    tokens = re.findall(r"[\u3400-\u9fff]{2,}|[a-z0-9]+", query.lower())
    ranked = []
    for row in rows:
        hay = (row["file_name"] + "\n" + row["content"]).lower()
        score = len(qu & units(hay)) + 8 * sum(token in hay for token in tokens)
        score += 4 if row["platform"] == "douyin" else 0
        ranked.append((score, row))
    ranked.sort(key=lambda item: (-item[0], -item[1]["char_count"], item[1]["id"]))
    selected = []
    selected_units = []
    for score, row in ranked:
        candidate_units = units(row["content"], 4)
        if any(len(candidate_units & prior) / max(1, len(candidate_units | prior)) >= 0.72 for prior in selected_units):
            continue
        selected.append((score, row)); selected_units.append(candidate_units)
        if len(selected) >= max(1, min(top_k, 20)):
            break
    results = [{"document_id": row["id"], "file_name": row["file_name"], "stage": row["stage"],
                "platform": row["platform"], "char_count": row["char_count"], "relevance_score": score,
                "excerpt": excerpt(row["content"], query)} for score, row in selected]
    return {"ok": True, "runtime": "local_sqlite", "network_used": False, "query": query, "result_count": len(results), "results": results}


def similarity(path: Path):
    draft = path.read_text(encoding="utf-8")
    du = units(draft, 4)
    rows = connect().execute("SELECT id,file_name,content FROM canonical_scripts").fetchall()
    scores = []
    for doc_id, name, content in rows:
        su = units(content, 4)
        score = len(du & su) / max(1, len(du))
        scores.append((score, doc_id, name))
    scores.sort(reverse=True); top = scores[:5]
    return {"ok": True, "runtime": "local_sqlite", "network_used": False,
            "max_similarity": round(top[0][0], 4) if top else 0, "threshold": 0.18,
            "pass": not top or top[0][0] < 0.18,
            "closest": [{"similarity": round(s,4), "document_id": i, "file_name": n} for s,i,n in top]}


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status")
    p = commands.add_parser("search"); p.add_argument("query"); p.add_argument("--top-k", type=int, default=6)
    p = commands.add_parser("similarity-check"); p.add_argument("path", type=Path)
    args = parser.parse_args()
    if args.command == "status":
        conn = connect(); canonical=conn.execute("SELECT COUNT(*) FROM canonical_scripts").fetchone()[0]; indexed=conn.execute("SELECT COUNT(*) FROM scripts_fts").fetchone()[0]
        return emit({"ok": canonical>0 and canonical==indexed, "runtime":"local_sqlite", "network_used":False, "canonical_scripts":canonical, "indexed_scripts":indexed})
    if args.command == "search": return emit(search(args.query,args.top_k))
    return emit(similarity(args.path.resolve()))


if __name__ == "__main__": raise SystemExit(main())
