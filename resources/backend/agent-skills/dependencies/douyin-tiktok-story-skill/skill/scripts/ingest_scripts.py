from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def clean(text: str) -> str:
    text = text.replace("\r", "\n").replace("\x07", "\n")
    text = re.sub(r"[\t ]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_docx(path: Path) -> str:
    with zipfile.ZipFile(path) as archive:
        root = ET.fromstring(archive.read("word/document.xml"))
    lines = []
    for paragraph in root.iter(W + "p"):
        text = "".join(node.text or "" for node in paragraph.iter(W + "t")).strip()
        if text:
            lines.append(text)
    return clean("\n".join(lines))


def extract_xlsx(path: Path) -> str:
    with zipfile.ZipFile(path) as archive:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            shared = ["".join(t.text or "" for t in item.iter(S + "t")) for item in root.iter(S + "si")]
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = {r.attrib["Id"]: r.attrib["Target"] for r in rels}
        lines = []
        rel_key = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
        for sheet in workbook.iter(S + "sheet"):
            lines.append(f"【工作表：{sheet.attrib.get('name', '')}】")
            target = targets.get(sheet.attrib.get(rel_key, ""), "")
            member = target.lstrip("/") if target.startswith("/xl/") else "xl/" + target.lstrip("/")
            if member not in archive.namelist():
                continue
            sheet_root = ET.fromstring(archive.read(member))
            for row in sheet_root.iter(S + "row"):
                values = []
                for cell in row.iter(S + "c"):
                    kind = cell.attrib.get("t")
                    value = cell.find(S + "v")
                    inline = cell.find(S + "is")
                    if kind == "s" and value is not None and value.text:
                        index = int(value.text)
                        text = shared[index] if index < len(shared) else ""
                    elif kind == "inlineStr" and inline is not None:
                        text = "".join(t.text or "" for t in inline.iter(S + "t"))
                    else:
                        text = value.text if value is not None and value.text else ""
                    if text.strip():
                        values.append(text.strip())
                if values:
                    lines.append(" | ".join(values))
    return clean("\n".join(lines))


def filename_metadata(name: str) -> dict[str, str]:
    lowered = name.lower()
    stage = "unknown"
    for marker, value in (("定稿", "final"), ("自用版", "creator_final"), ("反馈", "feedback"), ("批注", "reviewed"), ("大纲", "outline"), ("模板", "template"), ("脚本", "script")):
        if marker in name:
            stage = value
            break
    platform = "douyin" if "抖音" in name else ("xiaohongshu" if "小红书" in name or "红书" in name else "unspecified")
    duplicate_hint = "副本" in name or re.search(r"\(\d+\)", name) is not None
    return {"stage": stage, "platform": platform, "duplicate_hint": str(duplicate_hint).lower(), "lower_name": lowered}


def create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript("""
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS source_documents(
      id INTEGER PRIMARY KEY, source_path TEXT UNIQUE NOT NULL, file_name TEXT NOT NULL,
      extension TEXT NOT NULL, byte_size INTEGER NOT NULL, content_hash TEXT,
      canonical_document_id INTEGER, extraction_status TEXT NOT NULL, error TEXT,
      stage TEXT, platform TEXT, duplicate_hint INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL DEFAULT '', char_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_source_hash ON source_documents(content_hash);
    CREATE TABLE IF NOT EXISTS corpus_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    DROP VIEW IF EXISTS canonical_scripts;
    CREATE VIEW canonical_scripts AS SELECT * FROM source_documents
      WHERE extraction_status='ok' AND char_count>=100 AND id=canonical_document_id;
    DROP TABLE IF EXISTS scripts_fts;
    CREATE VIRTUAL TABLE scripts_fts USING fts5(document_id UNINDEXED,file_name,content,tokenize='trigram');
    """)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--legacy-json", type=Path)
    args = parser.parse_args()
    source = args.source.resolve()
    legacy = {}
    if args.legacy_json and args.legacy_json.exists():
        records = json.loads(args.legacy_json.read_text(encoding="utf-8-sig"))
        if isinstance(records, dict): records = [records]
        legacy = {str(Path(item["path"]).resolve()).lower(): item for item in records}
    conn = sqlite3.connect(args.db.resolve())
    create_schema(conn)
    conn.execute("DELETE FROM source_documents")
    extracted = failed = unsupported = 0
    for path in sorted((p for p in source.rglob("*") if p.is_file()), key=lambda p: str(p).lower()):
        ext = path.suffix.lower()
        status, error, text = "ok", None, ""
        try:
            if ext == ".docx": text = extract_docx(path)
            elif ext == ".xlsx": text = extract_xlsx(path)
            elif ext in {".doc", ".wps", ".xls"}:
                item = legacy.get(str(path.resolve()).lower())
                if item and item.get("status") == "ok": text = clean(str(item.get("text") or ""))
                else: status, error = "failed", str((item or {}).get("error") or "legacy extraction unavailable")
            else: status, error = "unsupported", "unsupported file type"
        except Exception as exc:
            status, error = "failed", str(exc)
        if status == "ok" and len(text) < 20:
            status, error = "failed", "extracted text too short"
        digest = hashlib.sha256(re.sub(r"\s+", "", text).encode("utf-8")).hexdigest() if text else None
        meta = filename_metadata(path.name)
        conn.execute("""INSERT INTO source_documents(source_path,file_name,extension,byte_size,content_hash,
          extraction_status,error,stage,platform,duplicate_hint,content,char_count)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""", (str(path),path.name,ext,path.stat().st_size,digest,status,error,meta["stage"],meta["platform"],meta["duplicate_hint"]=="true",text,len(text)))
        extracted += status == "ok"; failed += status == "failed"; unsupported += status == "unsupported"
    canonical = {}
    for row_id, digest in conn.execute("SELECT id,content_hash FROM source_documents WHERE extraction_status='ok' ORDER BY duplicate_hint,stage='final' DESC,char_count DESC,id"):
        canonical.setdefault(digest, row_id)
        conn.execute("UPDATE source_documents SET canonical_document_id=? WHERE id=?", (canonical[digest], row_id))
    conn.execute("INSERT INTO scripts_fts(document_id,file_name,content) SELECT id,file_name,content FROM canonical_scripts")
    conn.executemany("INSERT OR REPLACE INTO corpus_metadata(key,value) VALUES(?,?)", [("source_root",str(source)),("schema_version","1")])
    conn.commit()
    payload = {"files": extracted+failed+unsupported,"extracted":extracted,"failed":failed,"unsupported":unsupported,
      "canonical_scripts":conn.execute("SELECT COUNT(*) FROM canonical_scripts").fetchone()[0],
      "duplicate_versions":conn.execute("SELECT COUNT(*) FROM source_documents WHERE extraction_status='ok' AND id<>canonical_document_id").fetchone()[0],
      "indexed":conn.execute("SELECT COUNT(*) FROM scripts_fts").fetchone()[0]}
    print(json.dumps(payload,ensure_ascii=False,indent=2))
    return 0


if __name__ == "__main__": raise SystemExit(main())
