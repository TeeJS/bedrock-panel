# Bedrock Panel - CLI token spike (Phase 0 of docs/claude-token-plan.md)
#
# Checks that a Claude token (`claude setup-token`) and a GitHub Copilot token (fine-grained PAT with
# only the "Copilot Requests" permission) work the way the plan assumes. Run it yourself:
#
#   pwsh -NoProfile -File <path>\tools\cli-token-spike.ps1
#
# - Tokens are read with hidden input, live only in this process's environment, and are never printed
#   (every line of output is redacted before it is shown).
# - Claude runs against an EMPTY temporary config folder (CLAUDE_CONFIG_DIR), so your real `claude`
#   login is never read or changed. Copilot keeps its login in Windows Credential Manager and quietly
#   falls back to it when a token is rejected, so the script reads Copilot's own log (in a temporary
#   COPILOT_HOME) to tell "worked on the token" from "fell back to your login".
# - Nothing is installed, no setting is changed, and the temporary folder is deleted at the end.
# - Cost: about 3 small Claude Haiku calls and 3 Copilot premium requests.
# - Press Enter at a token prompt to skip that CLI's checks.

$ErrorActionPreference = 'Continue'

function Read-Secret([string]$prompt) {
  $s = Read-Host -AsSecureString $prompt
  if ($null -eq $s -or $s.Length -eq 0) { return '' }
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b).Trim() }
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

# Commands that only print SET / UNSET (never the value) for the token variable.
$claudeEnvProbe = @'
Use a shell tool to check whether the environment variable CLAUDE_CODE_OAUTH_TOKEN is set. Never print its value.
If you have a Bash tool, run exactly: printenv CLAUDE_CODE_OAUTH_TOKEN >/dev/null && echo SET || echo UNSET
Otherwise, with a PowerShell tool, run exactly: if ($env:CLAUDE_CODE_OAUTH_TOKEN) { 'SET' } else { 'UNSET' }
Then reply with only the single word the command printed.
'@
$copilotEnvProbe = 'Use your shell tool to check whether the environment variable COPILOT_GITHUB_TOKEN is set, without ever printing its value. In PowerShell run exactly: if ($env:COPILOT_GITHUB_TOKEN) { ''SET'' } else { ''UNSET'' } . In bash run exactly: printenv COPILOT_GITHUB_TOKEN >/dev/null && echo SET || echo UNSET . Then reply with only the single word the command printed.'

function Probe-Word([string]$text) {
  $h = Hide $text   # case-sensitive: "is set" in prose must not count as SET
  if ($h -cmatch '\bUNSET\b') { return 'UNSET' }
  if ($h -cmatch '\bSET\b') { return 'SET' }
  return 'INCONCLUSIVE'
}

Write-Host ''
Write-Host 'Bedrock Panel CLI token spike' -ForegroundColor Cyan
Write-Host 'Paste each token at its prompt (input is hidden). Press Enter to skip one.'
$claudeToken = Read-Secret 'Claude token (from claude setup-token)'
$copilotToken = Read-Secret 'GitHub Copilot token (fine-grained, Copilot Requests only)'
$script:secrets = @($claudeToken, $copilotToken) | Where-Object { $_ }
if (-not $claudeToken -and -not $copilotToken) { Write-Host 'No tokens entered - nothing to do.'; return }

# Hide any auth variables already in this shell so they cannot change the results; restored at the end.
$authVarPattern = '^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE$|CLAUDE_CONFIG_DIR$|COPILOT_|GH_TOKEN$|GITHUB_TOKEN$)'
$savedEnv = @{}
Get-ChildItem env: | Where-Object { $_.Name -match $authVarPattern } | ForEach-Object { $savedEnv[$_.Name] = $_.Value }
foreach ($k in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($k, $null, 'Process') }

$work = Join-Path $env:LOCALAPPDATA ('BedrockPanel-token-spike-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$claudeDir = Join-Path $work 'claude-config'
$copilotDir = Join-Path $work 'copilot-home'
$cwd = Join-Path $work 'cwd'
New-Item -ItemType Directory -Force -Path $claudeDir, $copilotDir, $cwd | Out-Null
Push-Location $cwd

try {
  # ---------------- Claude ----------------
  if ($claudeToken) {
    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Add-Result 'Claude' 'SKIP' 'claude not found on PATH' }
    else {
      $base = @{ CLAUDE_CONFIG_DIR = $claudeDir; CLAUDE_CODE_OAUTH_TOKEN = $claudeToken }
      $isolation = @('-p', '--safe-mode', '--tools=', '--strict-mcp-config', '--no-session-persistence', '--model', 'haiku')

      Write-Host 'B  Claude: one-word prompt with --safe-mode on the token...'
      $r = With-Env $base { Invoke-Cli 'claude' $isolation 'Reply with exactly: OK' }
      $pass = ($r.Code -eq 0) -and ((Hide $r.Out) -match '\bOK\b')
      Add-Result 'B  Claude -p --safe-mode on token' ($(if ($pass) { 'PASS' } else { 'FAIL' })) ("exit $($r.Code): " + $r.Out)

      $toolArgs = @('-p', '--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--model', 'haiku', '--allowedTools', 'Bash', 'PowerShell')
      Write-Host 'E1 Claude: can a tool command see the token (no scrub)?'
      $r = With-Env $base { Invoke-Cli 'claude' $toolArgs $claudeEnvProbe }
      Add-Result 'E1 Claude tool sees token, no scrub (expect SET)' (Probe-Word $r.Out) ("exit $($r.Code): " + $r.Out)

      Write-Host 'E2 Claude: same, with CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1...'
      $scrub = $base.Clone(); $scrub['CLAUDE_CODE_SUBPROCESS_ENV_SCRUB'] = '1'
      $r = With-Env $scrub { Invoke-Cli 'claude' $toolArgs $claudeEnvProbe }
      Add-Result 'E2 Claude tool sees token, SCRUB=1 (want UNSET)' (Probe-Word $r.Out) ("exit $($r.Code): " + $r.Out)
    }
  }

  # ---------------- Copilot ----------------
  if ($copilotToken) {
    if (-not (Get-Command copilot -ErrorAction SilentlyContinue)) { Add-Result 'Copilot' 'SKIP' 'copilot not found on PATH' }
    else {
      $cbase = @{ COPILOT_HOME = $copilotDir; COPILOT_GITHUB_TOKEN = $copilotToken; COPILOT_AUTO_UPDATE = 'false' }
      # Copilot quietly falls back to your normal (Credential Manager) login when the env token is
      # rejected, so a plain "OK" proves nothing. Its log records the rejection; count those lines.
      function Count-PatRejections {
        @(Get-ChildItem (Join-Path $copilotDir 'logs') -Filter *.log -ErrorAction SilentlyContinue |
          Select-String -SimpleMatch 'Failed to fetch PAT user login').Count
      }
      $fallbackNote = 'token REJECTED - Copilot fell back to your normal login. '

      Write-Host 'F  Copilot: one-word prompt on the token...'
      $n0 = Count-PatRejections
      $r = With-Env $cbase { Invoke-Cli 'copilot' @('-p', 'Reply with exactly: OK', '-s', '--allow-all-tools') '' }
      $rejected = (Count-PatRejections) -gt $n0
      $pass = (-not $rejected) -and ($r.Code -eq 0) -and ((Hide $r.Out) -match '\bOK\b')
      Add-Result 'F  Copilot -p on token' ($(if ($pass) { 'PASS' } else { 'FAIL' })) ($(if ($rejected) { $fallbackNote } else { '' }) + "exit $($r.Code): " + $r.Out)

      Write-Host 'E3 Copilot: can a tool command see the token (no flag)?'
      $n0 = Count-PatRejections
      $r = With-Env $cbase { Invoke-Cli 'copilot' @('-p', $copilotEnvProbe, '-s', '--allow-all-tools') '' }
      $word = if ((Count-PatRejections) -gt $n0) { 'INCONCLUSIVE' } else { Probe-Word $r.Out }
      Add-Result 'E3 Copilot tool sees token, no flag (expect SET)' $word ("exit $($r.Code): " + $r.Out)

      Write-Host 'E4 Copilot: same, with --secret-env-vars=COPILOT_GITHUB_TOKEN...'
      $n0 = Count-PatRejections
      $r = With-Env $cbase { Invoke-Cli 'copilot' @('-p', $copilotEnvProbe, '-s', '--allow-all-tools', '--secret-env-vars=COPILOT_GITHUB_TOKEN') '' }
      $word = if ((Count-PatRejections) -gt $n0) { 'INCONCLUSIVE' } else { Probe-Word $r.Out }
      Add-Result 'E4 Copilot tool sees token, --secret-env-vars (want UNSET)' $word ("exit $($r.Code): " + $r.Out)
    }

    Write-Host 'H  GitHub API: GET /user with the Copilot token...'
    if ($PSVersionTable.PSVersion.Major -lt 6) {   # Windows PowerShell 5.1 may not offer TLS 1.2 by default
      [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    }
    $headers = @{ Authorization = "Bearer $copilotToken"; 'X-GitHub-Api-Version' = '2022-11-28'; 'User-Agent' = 'bedrock-panel-spike'; Accept = 'application/vnd.github+json' }
    $code = $null; $hdrs = $null; $err = ''
    try {
      $resp = Invoke-WebRequest -Uri 'https://api.github.com/user' -Headers $headers -UseBasicParsing -ErrorAction Stop
      $code = [int]$resp.StatusCode; $hdrs = $resp.Headers
    } catch {
      $resp = $_.Exception.Response
      if ($resp) { $code = [int]$resp.StatusCode; $hdrs = $resp.Headers } else { $err = $_.Exception.Message }
    }
    $pairs = @()
    if ($hdrs -is [System.Net.WebHeaderCollection]) { foreach ($k in $hdrs.AllKeys) { $pairs += ,@($k, [string]$hdrs[$k]) } }
    elseif ($null -ne $hdrs) { foreach ($kv in $hdrs.GetEnumerator()) { $pairs += ,@([string]$kv.Key, (@($kv.Value) -join ',')) } }
    $interesting = ($pairs | Where-Object { $_[0] -match 'expir|accepted-github-permissions' } | ForEach-Object { $_[0] + ': ' + $_[1] }) -join ' | '
    if (-not $interesting) { $interesting = 'no expiry header' }
    $hResult = if ($code -eq 200) { 'PASS' } elseif ($code) { 'FAIL' } else { 'ERROR' }
    Add-Result 'H  GET api.github.com/user' $hResult ($(if ($code) { "HTTP $code; $interesting" } else { $err }))
  }
}
finally {
  Pop-Location
  foreach ($k in @('CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB', 'COPILOT_HOME', 'COPILOT_GITHUB_TOKEN', 'COPILOT_AUTO_UPDATE')) {
    [Environment]::SetEnvironmentVariable($k, $null, 'Process')
  }
  foreach ($k in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($k, $savedEnv[$k], 'Process') }
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  $claudeToken = $null; $copilotToken = $null; $script:secrets = @()
}

Write-Host ''
Write-Host '----- copy from here -----' -ForegroundColor Cyan
Write-Host ("PowerShell {0}; claude {1}; copilot {2}" -f $PSVersionTable.PSVersion,
  ((& claude --version 2>$null) -join ' '), ((& copilot --version 2>$null | Select-Object -First 1) -join ' '))
$results | Format-List Check, Result, Detail
Write-Host '----- copy to here -----' -ForegroundColor Cyan
