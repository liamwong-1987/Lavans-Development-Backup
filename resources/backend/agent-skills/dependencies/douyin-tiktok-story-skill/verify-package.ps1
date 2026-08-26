$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$forbidden = Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object { $_.Name -match '\.sqlite3(-shm|-wal)?$' }
if ($forbidden) { throw 'Skill repository must not contain the database.' }
python -m py_compile (Join-Path $root 'skill\scripts\local_search.py') (Join-Path $root 'skill\scripts\ingest_scripts.py')
Write-Output 'SKILL_PACKAGE_OK=true'
