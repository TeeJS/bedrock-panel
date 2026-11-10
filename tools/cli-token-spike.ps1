# Bedrock Panel - Claude token spike (Phase 0 of docs/claude-token-plan.md)
#
# Checks that a Claude token (`claude setup-token`) works the way the plan assumes. Run it yourself:
#
#   pwsh -NoProfile -File <path>\tools\cli-token-spike.ps1
#
# - The token is read with hidden input, lives only in this process's environment, is never printed
#   (every line of output is redacted before it is shown), and is cleaned of stray whitespace and
#   newlines first (a real paste once included trailing text and failed with "Invalid bearer token").
# - Claude runs against an EMPTY temporary config folder (CLAUDE_CONFIG_DIR), so your real `claude`
#   login is never read or changed.
# - Nothing is installed, no setting is changed, and the temporary folder is deleted at the end.
# - Cost: about 3 small Claude Haiku calls.
#
# All of these already passed on 2026-11-09; the script is kept for reproducibility.

$ErrorActionPreference = 'Continue'

function Read-Secret([string]$prompt) {
  $s = Read-Host -AsSecureString $prompt
  if ($null -eq $s -or $s.Length -eq 0) { return '' }
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

$script:secrets = @()
function Hide([string]$text) {
  if ($null -eq $text) { return '' }
  foreach ($s in $script:secrets) { if ($s) { $text = $text.Replace($s, '<token>') } }
  return $text
}
function Short([string]$text) {
  $t = (Hide $text) -replace '\s+', ' '
  $t = $t.Trim()
  if ($t.Length -gt 220) { $t = $t.Substring(0, 220) + '...' }
  return $t
}

# Run a script block with extra process-scope env vars, restoring the previous values afterwards.
function With-Env([hashtable]$vars, [scriptblock]$body) {
  $old = @{}
  foreach ($k in $vars.Keys) {
    $old[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
    [Environment]::SetEnvironmentVariable($k, $vars[$k], 'Process')
  }
  try { & $body }
  finally { foreach ($k in $old.Keys) { [Environment]::SetEnvironmentVariable($k, $old[$k], 'Process') } }
}

# Run a native command; returns @{ Code; Out } with stderr merged in.
function Invoke-Cli([string]$exe, [string[]]$cliArgs, [string]$stdin) {
  if ($stdin) { $out = $stdin | & $exe @cliArgs 2>&1 | ForEach-Object { "$_" } }
  else { $out = & $exe @cliArgs 2>&1 | ForEach-Object { "$_" } }
  return @{ Code = $LASTEXITCODE; Out = ($out -join "`n") }
}

$results = New-Object System.Collections.Generic.List[object]
function Add-Result([string]$check, [string]$result, [string]$detail) {
  $results.Add([pscustomobject]@{ Check = $check; Result = $result; Detail = (Short $detail) })
}

# A prompt that makes the agent print only SET / UNSET for the token variable (never the value).
$claudeEnvProbe = @'
Use a shell tool to check whether the environment variable CLAUDE_CODE_OAUTH_TOKEN is set. Never print its value.
If you have a Bash tool, run exactly: printenv CLAUDE_CODE_OAUTH_TOKEN >/dev/null && echo SET || echo UNSET
Otherwise, with a PowerShell tool, run exactly: if ($env:CLAUDE_CODE_OAUTH_TOKEN) { 'SET' } else { 'UNSET' }
Then reply with only the single word the command printed.
'@

function Probe-Word([string]$text) {
  $h = Hide $text   # case-sensitive: "is set" in prose must not count as SET
  if ($h -cmatch '\bUNSET\b') { return 'UNSET' }
  if ($h -cmatch '\bSET\b') { return 'SET' }
  return 'INCONCLUSIVE'
}

Write-Host ''
Write-Host 'Bedrock Panel Claude token spike' -ForegroundColor Cyan
Write-Host 'Paste the token at the prompt (input is hidden). Press Enter to skip.'
$claudeToken = (Read-Secret 'Claude token (from claude setup-token)').Trim() -replace '\s', ''
$script:secrets = @($claudeToken) | Where-Object { $_ }
if (-not $claudeToken) { Write-Host 'No token entered - nothing to do.'; return }
if ($claudeToken -notmatch '^sk-ant-oat') { Write-Host "Warning: that doesn't look like a setup-token (expected sk-ant-oat...). Continuing anyway." -ForegroundColor Yellow }

# Hide any auth variables already in this shell so they cannot change the results; restored at the end.
$authVarPattern = '^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE$|CLAUDE_CONFIG_DIR$)'
$savedEnv = @{}
Get-ChildItem env: | Where-Object { $_.Name -match $authVarPattern } | ForEach-Object { $savedEnv[$_.Name] = $_.Value }
foreach ($k in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($k, $null, 'Process') }

$work = Join-Path $env:LOCALAPPDATA ('BedrockPanel-token-spike-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$claudeDir = Join-Path $work 'claude-config'
$cwd = Join-Path $work 'cwd'
New-Item -ItemType Directory -Force -Path $claudeDir, $cwd | Out-Null
Push-Location $cwd

try {
  if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Add-Result 'Claude' 'SKIP' 'claude not found on PATH' }
  else {
    $base = @{ CLAUDE_CONFIG_DIR = $claudeDir; CLAUDE_CODE_OAUTH_TOKEN = $claudeToken }

    Write-Host 'B  Claude: one-word prompt with --safe-mode on the token...'
    $r = With-Env $base { Invoke-Cli 'claude' @('-p', '--safe-mode', '--tools=', '--strict-mcp-config', '--no-session-persistence', '--model', 'haiku') 'Reply with exactly: OK' }
    $pass = ($r.Code -eq 0) -and ((Hide $r.Out) -match '\bOK\b')
    Add-Result 'B  Claude -p --safe-mode on token' ($(if ($pass) { 'PASS' } else { 'FAIL' })) ("exit $($r.Code): " + $r.Out)

    $toolArgs = @('-p', '--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--model', 'haiku', '--allowedTools', 'Bash', 'PowerShell')
    Write-Host 'E1 Claude: can a tool command see the token (no scrub)?'
    $r = With-Env $base { Invoke-Cli 'claude' $toolArgs $claudeEnvProbe }
    Add-Result 'E1 Claude tool sees token, no scrub' (Probe-Word $r.Out) ("exit $($r.Code): " + $r.Out)

    Write-Host 'E2 Claude: same, with CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1...'
    $scrub = $base.Clone(); $scrub['CLAUDE_CODE_SUBPROCESS_ENV_SCRUB'] = '1'
    $r = With-Env $scrub { Invoke-Cli 'claude' $toolArgs $claudeEnvProbe }
    Add-Result 'E2 Claude tool sees token, SCRUB=1 (want UNSET)' (Probe-Word $r.Out) ("exit $($r.Code): " + $r.Out)
  }
}
finally {
  Pop-Location
  foreach ($k in @('CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB')) {
    [Environment]::SetEnvironmentVariable($k, $null, 'Process')
  }
  foreach ($k in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($k, $savedEnv[$k], 'Process') }
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  $claudeToken = $null; $script:secrets = @()
}

Write-Host ''
Write-Host '----- copy from here -----' -ForegroundColor Cyan
Write-Host ("PowerShell {0}; claude {1}" -f $PSVersionTable.PSVersion, ((& claude --version 2>$null) -join ' '))
$results | Format-List Check, Result, Detail
Write-Host '----- copy to here -----' -ForegroundColor Cyan
