param(
    [Parameter(Mandatory=$true)][string]$RemoteUrl,
    [string]$CommitMessage = 'Initial open-source release'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $repo 'verify-package.ps1')

if ($RemoteUrl -notmatch '^(https://github\.com/[^/]+/[^/]+(?:\.git)?|git@github\.com:[^/]+/[^/]+(?:\.git)?)$') {
    throw 'RemoteUrl must be a GitHub HTTPS or SSH repository URL.'
}

Push-Location $repo
try {
    if (-not (Test-Path -LiteralPath (Join-Path $repo '.git'))) { git init }
    git add --all
    git diff --cached --quiet
    if ($LASTEXITCODE -eq 1) { git commit -m $CommitMessage }
    elseif ($LASTEXITCODE -ne 0) { throw 'Unable to inspect staged changes.' }
    git branch -M main
    $existing = git remote get-url origin 2>$null
    if ($LASTEXITCODE -eq 0) { git remote set-url origin $RemoteUrl } else { git remote add origin $RemoteUrl }
    git push -u origin main
} finally {
    Pop-Location
}
