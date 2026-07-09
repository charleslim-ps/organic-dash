<#
  Publish organic-dash to its own GitHub repo (charleslim-ps account).
  Run from projects/organic-dash on your Windows machine.

  Prereq: repo exists at git@github-ps:charleslim-ps/organic-dash.git
#>
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path .git)) {
  git init
  git branch -M main
  git remote add origin git@github-ps:charleslim-ps/organic-dash.git
}

git add -A
$status = git status --porcelain
if ($status) {
  git commit -m "Publish organic-dash dashboard"
}
git push -u origin main
Write-Host "Pushed to https://github.com/charleslim-ps/organic-dash"
Write-Host "Next: Settings -> Pages -> main / root -> https://charleslim-ps.github.io/organic-dash/"
