param(
    [Parameter(Mandatory=$true)][string]$DatabaseRepoPath,
    [string]$InstallRoot = (Join-Path $HOME '.codex\skills'),
    [string]$SkillName = 'douyin-tiktok-story-skill'
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceSkill = Join-Path $repoRoot 'skill'
$databaseRepo = (Resolve-Path -LiteralPath $DatabaseRepoPath).Path
$database = Join-Path $databaseRepo 'douyin-story.sqlite3'
$metadata = Get-Content -Raw -LiteralPath (Join-Path $databaseRepo 'manifest.json') | ConvertFrom-Json
$targetSkill = Join-Path $InstallRoot $SkillName
$targetAssets = Join-Path $targetSkill 'assets'
$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $database).Hash.ToLowerInvariant()
if ($actualHash -ne "$($metadata.sha256)".ToLowerInvariant()) { throw 'Database SHA256 verification failed' }
New-Item -ItemType Directory -Force -Path $targetSkill | Out-Null
Copy-Item -Path (Join-Path $sourceSkill '*') -Destination $targetSkill -Recurse -Force
New-Item -ItemType Directory -Force -Path $targetAssets | Out-Null
Copy-Item -LiteralPath $database -Destination (Join-Path $targetAssets 'douyin-story.sqlite3') -Force
python (Join-Path $targetSkill 'scripts\local_search.py') status
Write-Output "INSTALLED_SKILL=$targetSkill"
