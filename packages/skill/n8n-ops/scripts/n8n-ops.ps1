# n8n-ops for agents on Windows: runs the Node version when Node 20+ is installed, and otherwise does the same
# itself with Windows PowerShell 5.1 (built into Windows 10 and 11) or PowerShell 7.
#
# One of three versions with one contract (see n8n-ops.mjs): same commands, same JSON output and error codes, same
# files and the same lock, so they can run side by side. Tokens never appear in the output.
#
# Run it as: powershell -NoProfile -ExecutionPolicy Bypass -File n8n-ops.ps1 <command> ...
# (the policy is bypassed for this one process only; nothing on the computer changes).

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

if (-not $env:N8N_OPS_NO_NODE) {
  $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($node) {
    & $node.Source -e "process.exit(Number(process.versions.node.split('.')[0])>=20?0:1)" 2>$null
    if ($LASTEXITCODE -eq 0) {
      & $node.Source (Join-Path $PSScriptRoot 'n8n-ops.mjs') @args
      exit $LASTEXITCODE
    }
  }
}

# Filled in with the n8n-ops address when the file is downloaded from n8n-ops.
$DefaultUrl = '__N8N_OPS_URL__'
$ClientId = 'n8n-ops-cli'
$Scope = 'ops:read ops:access offline_access'
$WaitSeconds = 90
if ($env:N8N_OPS_WAIT_SECONDS) { $WaitSeconds = [int]$env:N8N_OPS_WAIT_SECONDS }
# A refresh is retried only once it cannot be in flight any more: twice the request timeout (tests shorten it).
$RefreshGrace = 30
if ($null -ne $env:N8N_OPS_TEST_REFRESH_GRACE) { $RefreshGrace = [long]$env:N8N_OPS_TEST_REFRESH_GRACE }
$PollSeconds = 5
if ($env:N8N_OPS_TEST_POLL_SECONDS) { $PollSeconds = [long]$env:N8N_OPS_TEST_POLL_SECONDS }
$LockWaitMs = 20000
if ($env:N8N_OPS_LOCK_WAIT_MS) { $LockWaitMs = [int]$env:N8N_OPS_LOCK_WAIT_MS }
$Secret = '^[A-Za-z0-9._~+/=-]{1,4096}$'
$Plain = '^[^"\\\x00-\x1f\x7f]*$'
$PathChars = "^[A-Za-z0-9._~!$&'()*+,;=:@/?%-]+$"
$Fields = @(
  @('v', 'n'), @('issuer', 's'), @('label', 's'), @('generation', 's'), @('refreshToken', 's'), @('accessToken', 's'),
  @('accessExpiresAt', 'n'), @('scope', 's'), @('refreshStartedAt', 'n'), @('refreshRetried', 'n'), @('deviceCode', 's'),
  @('userCode', 's'), @('link', 's'), @('deviceExpiresAt', 'n'), @('interval', 'n'), @('nextPollAt', 'n'), @('toRevoke', 's')
)
$Utf8 = New-Object System.Text.UTF8Encoding($false)
# Windows tools by their full path: started from Git Bash, for one, whoami.exe may be a different program.
$Icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
$Whoami = Join-Path $env:SystemRoot 'System32\whoami.exe'

class OpsFail : System.Exception {
  [string]$Code
  [object]$Body
  [bool]$Sent
  OpsFail([string]$code, [string]$message) : base($message) { $this.Code = $code; $this.Sent = $true }
}

function Fail([string]$code, [string]$message) { throw [OpsFail]::new($code, $message) }
function Now { [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }
function Hex([int]$n) {
  $b = New-Object byte[] $n
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  -join ($b | ForEach-Object { $_.ToString('x2') })
}
function HostName { if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { [Environment]::MachineName } }
function Write-Raw([byte[]]$bytes) {
  $out = [Console]::OpenStandardOutput()
  $out.Write($bytes, 0, $bytes.Length)
  $out.Flush()
}
function Write-Line([string]$text) { Write-Raw $Utf8.GetBytes("$text`n") }
function Write-Json($value) { Write-Line (ConvertTo-Json -InputObject $value -Compress -Depth 20) }

$Help = @"
n8n-ops: use n8n-ops after a person approves it.

  connect [--replace]   Ask to connect; prints a link and a code to show the person.
  connect --wait        Wait up to $WaitSeconds s for the approval; run again while it answers still_waiting.
  get <path>            GET /api/v1<path>, for example: get 'problems?status=open'
  post <path> [--json <body> | --json-file <file>]
  status                Whether this agent is connected (no secrets).
  disconnect            End this agent's connection.

  --url <address>       The n8n-ops address (or N8N_OPS_URL).
"@

# Context: the n8n-ops address, this agent's identity (the folder it is installed in) and where its connection is kept.

function Get-Context([string]$urlOption) {
  $raw = $urlOption
  if (-not $raw) { $raw = $env:N8N_OPS_URL }
  if (-not $raw -and -not $DefaultUrl.StartsWith('__')) { $raw = $DefaultUrl }
  if (-not $raw) { Fail 'no_url' 'No n8n-ops address. Pass --url https://<your n8n-ops> or set N8N_OPS_URL.' }
  $u = $null
  if (-not [Uri]::TryCreate($raw, [UriKind]::Absolute, [ref]$u)) { Fail 'insecure_url' "`"$raw`" is not an address." }
  $loopback = @('127.0.0.1', '[::1]', 'localhost') -contains $u.Host
  if (-not ($u.Scheme -eq 'https' -or ($u.Scheme -eq 'http' -and $loopback))) {
    Fail 'insecure_url' 'The n8n-ops address must start with https:// (http only for this computer).'
  }
  if ($u.UserInfo -or $u.Query -or $u.Fragment -or ($u.AbsolutePath -ne '/')) {
    Fail 'insecure_url' 'Use the n8n-ops address alone, for example https://ops.example.com.'
  }
  $issuer = "$($u.Scheme)://$($u.Authority)"
  $install = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\', '/').ToLowerInvariant()
  $dir = Get-CredentialsDir
  $sha = [Security.Cryptography.SHA256]::Create().ComputeHash($Utf8.GetBytes("$issuer`n$(Get-InstallId $install)"))
  $key = (-join ($sha | ForEach-Object { $_.ToString('x2') })).Substring(0, 32)
  @{
    issuer = $issuer; install = $install; dir = $dir
    file = Join-Path $dir "$key.json"; lock = Join-Path $dir "$key.lock"; label = Get-Label $install
  }
}

# This install's id, kept in the skill's folder (.install-id), so every version agrees on it however each one spells
# the folder's path. Published in one step: written aside, then moved into place, which fails if one is there.
function Get-InstallId([string]$install) {
  $file = Join-Path $install '.install-id'
  $read = {
    try { $id = ([IO.File]::ReadAllText($file)).Trim(); if ($id -match '^[0-9a-f]{32}$') { return $id } } catch {}
    return $null
  }
  $id = & $read
  if ($id) { return $id }
  $tmp = "$file.$(Hex 6)"
  try { [IO.File]::WriteAllText($tmp, "$(Hex 16)`n"); [IO.File]::Move($tmp, $file) } catch {} finally {
    try { if ([IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) } } catch {}
  }
  $id = & $read
  if ($id) { return $id }
  Fail 'cannot_save' "Cannot write in $install. The agent's id is kept there; allow writing it."
}

# icacls over the folder and its files; tried again while other commands add or replace files in it.
function Invoke-Icacls([string[]]$arguments) {
  for ($i = 0; ; $i++) {
    $ErrorActionPreference = 'Continue'
    & $Icacls @arguments *> $null
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($code -eq 0) { return }
    if ($i -ge 4) { throw "icacls $($arguments[1]) failed" }
    Start-Sleep -Milliseconds (100 + (Get-Random -Maximum 200))
  }
}

# What in saved ACLs (icacls /save: one SDDL line per object) lets anyone but this user, SYSTEM and Administrators
# in. Anything but plain allow and deny entries (conditional or callback ones) counts too: refused, not guessed.
function Find-OtherAllowed([string]$saved, [string]$userSid) {
  $allowed = @($userSid, 'SY', 'BA', 'S-1-5-18', 'S-1-5-32-544')
  # SDDL writes the built-in Administrator account (RID 500) as LA, so a user who is that account shows as LA.
  if ($userSid -match '^S-1-5-21-[0-9-]+-500$') { $allowed += 'LA' }
  foreach ($line in ($saved -split "`r?`n")) {
    $at = $line.IndexOf('D:')
    if ($at -lt 0) { continue }
    $dacl = ($line.Substring($at + 2) -split 'S:')[0]
    $depth = 0; $ace = ''
    foreach ($ch in $dacl.ToCharArray()) {
      if ($ch -eq '(') {
        $depth++
        if ($depth -gt 1) { return 'a conditional entry' }
        $ace = ''
      } elseif ($ch -eq ')') {
        $depth--
        $f = $ace -split ';'
        if (@('A', 'D', 'OA', 'OD') -cnotcontains $f[0]) { return "an entry of type $($f[0])" }
        if (($f[0] -ceq 'A' -or $f[0] -ceq 'OA') -and ($f.Count -lt 6 -or $allowed -notcontains $f[5])) { return $f[-1] }
      } elseif ($depth -eq 1) { $ace += $ch }
    }
  }
  $null
}

function Get-Label([string]$install) {
  if ($env:N8N_OPS_AGENT_NAME) { $l = $env:N8N_OPS_AGENT_NAME; if ($l.Length -gt 60) { $l = $l.Substring(0, 60) }; return $l }
  $agent = 'Agent'
  foreach ($part in ($install -split '[\\/]')) {
    $p = $part.ToLowerInvariant()
    if ($p.StartsWith('.claude')) { if ($p -eq '.claude') { $agent = 'Claude Code' } else { $agent = "Claude Code ($p)" }; break }
    if ($p.StartsWith('.codex')) { if ($p -eq '.codex') { $agent = 'Codex' } else { $agent = "Codex ($p)" }; break }
    if ($p.StartsWith('.cursor')) { $agent = 'Cursor'; break }
  }
  $l = "$agent on $(HostName)"
  if ($l.Length -gt 60) { $l = $l.Substring(0, 60) }
  $l
}

function Get-CredentialsDir {
  if ([Environment]::OSVersion.Platform -ne 'Win32NT') { Fail 'failed' 'On Linux and macOS, run n8n-ops (or n8n-ops.sh).' }
  $appData = $env:APPDATA
  if (-not $appData) { $appData = Join-Path $env:USERPROFILE 'AppData\Roaming' }
  $dir = $env:N8N_OPS_CREDENTIALS
  if (-not $dir) { $dir = Join-Path $appData 'n8n-ops' }
  $dir = [IO.Path]::GetFullPath($dir).TrimEnd('\')
  $userHome = [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\').ToLowerInvariant()
  $lower = $dir.ToLowerInvariant()
  if ($lower -ne $userHome -and -not $lower.StartsWith("$userHome\")) {
    Fail 'insecure_credentials' "Keep the n8n-ops folder inside your user profile ($userHome), not $dir."
  }
  $dir
}

$script:Secured = $false
function Protect-Dir([string]$dir) {
  if ($script:Secured) { return }
  try { [void][IO.Directory]::CreateDirectory($dir) } catch { Fail 'cannot_save' "Cannot create $dir. Allow this agent to write there." }
  $item = Get-Item -LiteralPath $dir -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $item.PSIsContainer) {
    Fail 'insecure_credentials' "$dir must be a plain folder, not a link."
  }
  # Limited to this user, SYSTEM and Administrators (well-known SIDs, so no localized names).
  try {
    $who = (& $Whoami /user /fo csv /nh) -join ''
    if ($who -notmatch '"(S-1-[0-9-]+)"\s*$') { throw 'no SID' }
    $sid = $Matches[1]
    & $Icacls $dir /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /Q *> $null
    if ($LASTEXITCODE -ne 0) { throw 'icacls' }
    # The owner may always change an ACL, so the folder and its files must be this user's. (Only now: taking
    # ownership needs the full control just granted. No /C, which would hide a failure behind exit code 0.)
    Invoke-Icacls @($dir, '/setowner', "*$sid", '/T', '/Q')
    # Granting does not remove other entries: read the folder's and its files' ACLs back and allow no one else.
    # (icacls, not Get-Acl: started from PowerShell 7, Windows PowerShell may fail to load the module Get-Acl is in.)
    $saved = Join-Path $dir ".acl-$(Hex 4)"
    try {
      Invoke-Icacls @($dir, '/save', $saved, '/T', '/Q')
      $other = Find-OtherAllowed ([IO.File]::ReadAllText($saved, [Text.Encoding]::Unicode)) $sid
      if ($other) { Fail 'insecure_credentials' "Others can open $dir ($other). Remove their access." }
    } finally { if ([IO.File]::Exists($saved)) { [IO.File]::Delete($saved) } }
  } catch [OpsFail] { throw } catch {
    Fail 'insecure_credentials' "Could not limit $dir to your user ($($_.Exception.Message))."
  }
  $script:Secured = $true
}

function Test-PlainFile([string]$file) {
  $item = Get-Item -LiteralPath $file -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.PSIsContainer) {
    Fail 'insecure_credentials' "$file must be a plain file."
  }
}

# The connection's file: flat JSON with plain values, written in one step.

function New-Record($ctx) {
  $rec = @{}
  foreach ($f in $Fields) { if ($f[1] -eq 'n') { $rec[$f[0]] = [long]0 } else { $rec[$f[0]] = '' } }
  $rec.v = [long]1; $rec.issuer = $ctx.issuer; $rec.label = $ctx.label
  $rec
}

function Read-Record($ctx) {
  if (-not [IO.File]::Exists($ctx.file)) { return $null }
  Test-PlainFile $ctx.file
  try { $parsed = [IO.File]::ReadAllText($ctx.file, $Utf8) | ConvertFrom-Json } catch {
    Fail 'insecure_credentials' "$($ctx.file) is damaged. Delete it and connect again."
  }
  $rec = @{}
  foreach ($f in $Fields) {
    $value = $null
    if ($parsed.PSObject.Properties[$f[0]]) { $value = $parsed.($f[0]) }
    if ($f[1] -eq 'n') { $n = [long]0; if ($null -ne $value) { [void][long]::TryParse([string]$value, [ref]$n) }; $rec[$f[0]] = $n }
    elseif ($null -eq $value) { $rec[$f[0]] = '' } else { $rec[$f[0]] = [string]$value }
  }
  $rec
}

function Format-Record($rec) {
  $parts = foreach ($f in $Fields) {
    if ($f[1] -eq 'n') { $n = [long]0; [void][long]::TryParse([string]$rec[$f[0]], [ref]$n); if ($n -lt 0) { $n = 0 }; "`"$($f[0])`":$n" }
    else {
      $value = [string]$rec[$f[0]]
      if ($value -notmatch $Plain) { Fail 'unexpected_answer' "n8n-ops sent a value that cannot be stored ($($f[0]))." }
      "`"$($f[0])`":`"$value`""
    }
  }
  '{' + ($parts -join ',') + "}`n"
}

function Write-Record($ctx, $rec) {
  Protect-Dir $ctx.dir
  $text = Format-Record $rec
  $tmp = "$($ctx.file).$(Hex 6).tmp"
  try {
    $fs = [IO.File]::Open($tmp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $bytes = $Utf8.GetBytes($text); $fs.Write($bytes, 0, $bytes.Length); $fs.Flush($true) } finally { $fs.Dispose() }
  } catch { Fail 'cannot_save' "Cannot write in $($ctx.dir). Allow this agent to write there." }
  Move-Over $tmp $ctx.file
}

function Move-Over([string]$from, [string]$to) {
  # An open handle (an antivirus scan) can refuse the replace for a moment.
  $until = [DateTime]::UtcNow.AddSeconds(5)
  while ($true) {
    try {
      if ([IO.File]::Exists($to)) { [IO.File]::Replace($from, $to, [NullString]::Value) } else { [IO.File]::Move($from, $to) }
      return
    } catch {
      if ([DateTime]::UtcNow -gt $until) {
        try { [IO.File]::Delete($from) } catch {}
        Fail 'cannot_save' "Cannot replace $to."
      }
      Start-Sleep -Milliseconds 100
    }
  }
}

function Remove-Record($ctx) { if ([IO.File]::Exists($ctx.file)) { [IO.File]::Delete($ctx.file) } }

# The lock: a file created exclusively, naming its holder. Never taken from a live holder, however old.

function Read-Lock([string]$file) {
  if (-not [IO.File]::Exists($file)) { return $null }
  try {
    $text = [IO.File]::ReadAllText($file, $Utf8)
    $held = $text | ConvertFrom-Json
    if ($held -and $held.PSObject.Properties['token']) { return $held }
  } catch {}
  try { return [pscustomobject]@{ empty = $true; mtime = [IO.File]::GetLastWriteTimeUtc($file) } } catch { return $null }
}

function Test-Alive([int]$id) { [bool](Get-Process -Id $id -ErrorAction SilentlyContinue) }

function Invoke-Hook([string]$point) {
  $at = [Environment]::GetEnvironmentVariable('N8N_OPS_TEST_HOLD_' + $point.ToUpperInvariant().Replace('-', '_'))
  if (-not $at) { return }
  [IO.File]::WriteAllText("$at.reached", [string]$PID)
  for ($i = 0; $i -lt 1200 -and -not [IO.File]::Exists("$at.go"); $i++) { Start-Sleep -Milliseconds 50 }
}

function Test-LockEmpty($held) { $held.PSObject.Properties['empty'] -and $held.empty }

# Takes the lock; $own is a lock this process held before, which counts as taken if it is back in place.
function Enter-Lock($ctx, [string]$own) {
  Protect-Dir $ctx.dir
  $token = Hex 16
  $line = ConvertTo-Json -Compress -InputObject ([ordered]@{ pid = $PID; host = (HostName); token = $token; startedAt = (Now) })
  $deadline = [DateTime]::UtcNow.AddMilliseconds($LockWaitMs)
  while ($true) {
    $created = $false
    try {
      $fs = [IO.File]::Open($ctx.lock, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
      try { $bytes = $Utf8.GetBytes($line); $fs.Write($bytes, 0, $bytes.Length) } finally { $fs.Dispose() }
      $created = $true
    } catch [IO.IOException] {
      if (-not [IO.File]::Exists($ctx.lock) -and -not [IO.Directory]::Exists($ctx.dir)) { Fail 'cannot_save' "Cannot create a lock in $($ctx.dir)." }
    } catch [UnauthorizedAccessException] {
      # Windows refuses for a moment to create a file whose name is still being deleted (a lock just released).
      if ([DateTime]::UtcNow -gt $deadline) { Fail 'cannot_save' "Cannot create a lock in $($ctx.dir)." }
      Start-Sleep -Milliseconds (50 + (Get-Random -Maximum 100))
      continue
    } catch { Fail 'cannot_save' "Cannot create a lock in $($ctx.dir)." }
    if ($created) { Invoke-Hook 'locked'; return $token }
    $held = Read-Lock $ctx.lock
    # Another process moved this one's lock away by mistake and has put it back.
    if ($own -and $held -and -not (Test-LockEmpty $held) -and $held.token -eq $own) { return $own }
    $dead = $false
    if ($held) {
      # A holder that died between creating the lock and writing its name leaves it empty; that takes a moment.
      if (Test-LockEmpty $held) { $dead = ([DateTime]::UtcNow - $held.mtime).TotalSeconds -gt 60 }
      else { $dead = ([string]$held.host).ToLowerInvariant() -eq (HostName).ToLowerInvariant() -and -not (Test-Alive ([int]$held.pid)) }
    }
    if ($dead) {
      Invoke-Hook 'break-observed'
      if (Remove-DeadLock $ctx $held) { continue }
    }
    if ([DateTime]::UtcNow -gt $deadline) {
      if ($held -and -not (Test-LockEmpty $held) -and ((Now) - [long]$held.startedAt) -gt 600) {
        Fail 'busy' "Another n8n-ops command has held $($ctx.lock) for over 10 minutes. If none is running, delete that file."
      }
      Fail 'busy' 'Another n8n-ops command is using this connection. Nothing was sent; run it again.'
    }
    Start-Sleep -Milliseconds (100 + (Get-Random -Maximum 200))
  }
}

# Moving the dead lock away is atomic, so of two that try only one moves it; if what was moved is not the dead lock
# (another process had just taken a fresh one), it goes back unless a newer one is there (Move never overwrites).
function Remove-DeadLock($ctx, $held) {
  $moved = "$($ctx.lock).$(Hex 6).dead"
  try { [IO.File]::Move($ctx.lock, $moved) } catch { return $true }
  Invoke-Hook 'break-moved'
  $got = Read-Lock $moved
  $same = $false
  if ($got) {
    if (Test-LockEmpty $held) { $same = [bool](Test-LockEmpty $got) }
    elseif (-not (Test-LockEmpty $got)) { $same = $got.token -eq $held.token }
  }
  if ($same) { [IO.File]::Delete($moved); return $true }
  try { [IO.File]::Move($moved, $ctx.lock) } catch { try { [IO.File]::Delete($moved) } catch {} }
  $false
}

function Test-Mine($ctx, [string]$token) {
  $held = Read-Lock $ctx.lock
  [bool]($held -and -not (Test-LockEmpty $held) -and $held.token -eq $token)
}

function Exit-Lock($ctx, [string]$token) { if (Test-Mine $ctx $token) { [IO.File]::Delete($ctx.lock) } }

function Assert-Mine($ctx, [string]$token) {
  if (-not (Test-Mine $ctx $token)) { Fail 'busy' 'Another n8n-ops command took over this connection. Run it again.' }
}

# Requests

Add-Type -AssemblyName System.Net.Http
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$Handler = New-Object System.Net.Http.HttpClientHandler
# No redirects: a secret never follows one to another address.
$Handler.AllowAutoRedirect = $false
$Handler.UseCookies = $false
$Client = New-Object System.Net.Http.HttpClient($Handler)
$Client.Timeout = [TimeSpan]::FromSeconds(15)

# Whether a failed request may have reached n8n-ops: not when the name, the connection or TLS failed first.
function Test-NotSent($err) {
  $e = $err
  while ($e) {
    if ($e -is [System.Net.WebException]) {
      if (@('NameResolutionFailure', 'ConnectFailure', 'TrustFailure', 'SecureChannelFailure', 'ProxyNameResolutionFailure') -contains [string]$e.Status) { return $true }
    }
    if ($e -is [System.Net.Sockets.SocketException]) {
      if (@('HostNotFound', 'ConnectionRefused', 'NetworkUnreachable', 'HostUnreachable', 'TryAgain', 'NoData') -contains [string]$e.SocketErrorCode) { return $true }
    }
    if ($e -is [System.Security.Authentication.AuthenticationException]) { return $true }
    $e = $e.InnerException
  }
  $false
}

function Invoke-Ops($ctx, [string]$method, [string]$url, $form, [string]$bearer, $json) {
  $req = New-Object System.Net.Http.HttpRequestMessage((New-Object System.Net.Http.HttpMethod($method)), $url)
  $req.Headers.Accept.ParseAdd('application/json')
  if ($bearer) { $req.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', $bearer) }
  if ($form) {
    $pairs = New-Object 'System.Collections.Generic.List[System.Collections.Generic.KeyValuePair[string,string]]'
    foreach ($k in $form.Keys) { $pairs.Add((New-Object 'System.Collections.Generic.KeyValuePair[string,string]' -ArgumentList $k, ([string]$form[$k]))) }
    $req.Content = [System.Net.Http.FormUrlEncodedContent]::new($pairs)
  } elseif ($null -ne $json) {
    $req.Content = New-Object System.Net.Http.StringContent($json, $Utf8, 'application/json')
  }
  try { $res = $Client.SendAsync($req).GetAwaiter().GetResult() } catch {
    $f = [OpsFail]::new('unreachable', "Cannot reach $($ctx.issuer) ($($_.Exception.GetBaseException().Message)).")
    $f.Sent = -not (Test-NotSent $_.Exception)
    throw $f
  }
  try { $bytes = $res.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult() } catch {
    # The answer started and broke off: n8n-ops got the request and may have spent a one-time secret.
    throw [OpsFail]::new('unreachable', "The answer from $($ctx.issuer) broke off.")
  }
  $text = $Utf8.GetString($bytes)
  $parsed = $null
  try { $parsed = $text | ConvertFrom-Json } catch {}
  @{ status = [int]$res.StatusCode; text = $text; bytes = $bytes; json = $parsed }
}

function Invoke-OAuth($ctx, [string]$path, $form) {
  $form['client_id'] = $ClientId
  Invoke-Ops $ctx 'POST' "$($ctx.issuer)$path" $form '' $null
}

function Get-Field($r, [string]$name) {
  if ($r.json -and $r.json -is [pscustomobject] -and $r.json.PSObject.Properties[$name]) { return [string]$r.json.$name }
  ''
}

function New-HttpFail($r, [string]$what) {
  $detail = Get-Field $r 'error_description'
  if (-not $detail) { $detail = Get-Field $r 'message' }
  if (-not $detail) { $detail = Get-Field $r 'error' }
  $msg = "$what failed ($($r.status)"
  if ($detail) { $msg += ": $detail" }
  $f = [OpsFail]::new("http_$($r.status)", "$msg).")
  if ($r.json -is [pscustomobject] -or $r.json -is [array]) { $f.Body = $r.json }
  $f
}

function Get-Tokens($r) {
  $access = Get-Field $r 'access_token'; $refresh = Get-Field $r 'refresh_token'; $scope = Get-Field $r 'scope'
  if ($access -notmatch $Secret -or $refresh -notmatch $Secret -or $scope -notmatch $Plain) {
    Fail 'unexpected_answer' 'n8n-ops answered without usable tokens.'
  }
  $expires = [long]0; [void][long]::TryParse((Get-Field $r 'expires_in'), [ref]$expires)
  @{ refreshToken = $refresh; accessToken = $access; accessExpiresAt = (Now) + [Math]::Max([long]0, $expires); scope = $scope }
}

function Merge($rec, $values) { $next = $rec.Clone(); foreach ($k in $values.Keys) { $next[$k] = $values[$k] }; $next }

function Invoke-RevokePending($ctx, $rec) {
  if (-not $rec.toRevoke) { return $rec }
  $left = @()
  foreach ($token in ($rec.toRevoke -split ' ' | Where-Object { $_ })) {
    $ok = $false
    try { $r = Invoke-OAuth $ctx '/oauth/revoke' ([ordered]@{ token = $token; token_type_hint = 'refresh_token' }); $ok = $r.status -eq 200 } catch {}
    if (-not $ok) { $left += $token }
  }
  $next = Merge $rec @{ toRevoke = ($left -join ' ') }
  if ($next.toRevoke -ne $rec.toRevoke) { Write-Record $ctx $next }
  $next
}

# Commands

function Show-Status($ctx) {
  $rec = Read-Record $ctx
  $state = 'not_connected'
  if ($rec -and $rec.refreshToken) { $state = 'connected' } elseif ($rec -and $rec.deviceCode) { $state = 'pending' }
  $label = $ctx.label
  if ($rec -and $rec.label) { $label = $rec.label }
  $out = [ordered]@{ status = $state; url = $ctx.issuer; label = $label }
  if ($state -eq 'connected') { $out.scope = $rec.scope; $out.accessExpiresIn = [Math]::Max([long]0, $rec.accessExpiresAt - (Now)) }
  Write-Json $out
}

function Get-Pending($rec) {
  [ordered]@{
    status = 'pending'; link = $rec.link; code = $rec.userCode; expiresIn = [Math]::Max([long]0, $rec.deviceExpiresAt - (Now))
    next = 'End your turn with a reply that shows the person the link and the code and asks them to reply once they approve. When they reply, run: n8n-ops connect --wait'
  }
}

function Clear-Pending($rec) { Merge $rec @{ deviceCode = ''; userCode = ''; link = ''; deviceExpiresAt = [long]0; interval = [long]0; nextPollAt = [long]0 } }

function Invoke-Connect($ctx, [bool]$replace) {
  # Before any code exists: can it keep a connection here, and is n8n-ops there?
  Protect-Dir $ctx.dir
  $probe = Join-Path $ctx.dir ".probe-$(Hex 4)"
  try { [IO.File]::Open($probe, [IO.FileMode]::CreateNew).Dispose(); [IO.File]::Delete($probe) } catch {
    Fail 'cannot_save' "Cannot write in $($ctx.dir). Allow this agent to write there."
  }
  $meta = Invoke-Ops $ctx 'GET' "$($ctx.issuer)/.well-known/oauth-authorization-server" $null '' $null
  if ($meta.status -ne 200 -or (Get-Field $meta 'issuer') -ne $ctx.issuer) {
    Fail 'unreachable' "$($ctx.issuer) does not answer as n8n-ops ($($meta.status)). Check the address."
  }
  $lock = Enter-Lock $ctx
  try {
    $rec = Read-Record $ctx
    if (-not $rec) { $rec = New-Record $ctx }
    $rec = Invoke-RevokePending $ctx $rec
    if ($rec.refreshToken -and -not $replace) { return Write-Json ([ordered]@{ status = 'already_connected'; label = $rec.label; scope = $rec.scope }) }
    # The open code again, unless asked for a new one (--replace: the link did not work for the person).
    if ($rec.deviceCode -and ($rec.deviceExpiresAt - (Now)) -gt 30 -and -not $replace) { return Write-Json (Get-Pending $rec) }
    Assert-Mine $ctx $lock
    $r = Invoke-OAuth $ctx '/oauth/device' ([ordered]@{ scope = $Scope; resource = "$($ctx.issuer)/api/v1"; client_label = $ctx.label })
    if ($r.status -ne 200) { throw (New-HttpFail $r 'Asking to connect') }
    $deviceCode = Get-Field $r 'device_code'; $userCode = Get-Field $r 'user_code'; $link = Get-Field $r 'verification_uri_complete'
    if ($deviceCode -notmatch $Secret -or $userCode -notmatch '^[A-Z0-9-]{4,20}$' -or $link -notmatch $Plain) {
      Fail 'unexpected_answer' 'n8n-ops answered without a code.'
    }
    if (-not $link.StartsWith("$($ctx.issuer)/")) { Fail 'unexpected_answer' 'The approval link is not on n8n-ops.' }
    $interval = [long]0; [void][long]::TryParse((Get-Field $r 'interval'), [ref]$interval); if ($interval -le 0) { $interval = $PollSeconds }; $interval = [Math]::Max([long]$PollSeconds, $interval)
    $expires = [long]0; [void][long]::TryParse((Get-Field $r 'expires_in'), [ref]$expires); if ($expires -le 0) { $expires = 600 }
    $rec = Merge $rec @{
      label = $ctx.label; deviceCode = $deviceCode; userCode = $userCode; link = $link
      deviceExpiresAt = (Now) + [Math]::Max([long]60, $expires); interval = $interval; nextPollAt = (Now) + $interval
    }
    Write-Record $ctx $rec
    Write-Json (Get-Pending $rec)
  } finally { Exit-Lock $ctx $lock }
}

function Invoke-Wait($ctx) {
  $until = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
  while ($true) {
    $wait = 0; $done = $null
    $lock = Enter-Lock $ctx
    try {
      $rec = Read-Record $ctx
      if (-not $rec -or -not $rec.deviceCode) {
        if ($rec -and $rec.refreshToken) { $done = [ordered]@{ status = 'connected'; label = $rec.label; scope = $rec.scope } }
        else { Fail 'not_connected' 'No connection is being made. Run: n8n-ops connect' }
      } else {
        $t = Now
        if ($rec.deviceExpiresAt -le $t) {
          Write-Record $ctx (Clear-Pending $rec)
          Fail 'expired' 'The code expired before it was approved. Run: n8n-ops connect'
        }
        if ($rec.nextPollAt -gt $t) { $wait = $rec.nextPollAt - $t }
        else {
          Assert-Mine $ctx $lock
          try {
            $r = Invoke-OAuth $ctx '/oauth/token' ([ordered]@{ grant_type = 'urn:ietf:params:oauth:grant-type:device_code'; device_code = $rec.deviceCode })
          } catch [OpsFail] {
            if ($_.Exception.Code -eq 'unreachable') { Write-Record $ctx (Merge $rec @{ nextPollAt = $t + $rec.interval }) }
            throw
          }
          $oauthError = Get-Field $r 'error'
          if ($r.status -eq 200) {
            $tokens = Get-Tokens $r
            # Connecting again (--replace): the old connection is ended once the new one is stored.
            $old = ''
            if ($rec.refreshToken -and $rec.refreshToken -ne $tokens.refreshToken) { $old = $rec.refreshToken }
            $rec = Merge (Clear-Pending $rec) $tokens
            $rec = Merge $rec @{ generation = (Hex 8); refreshStartedAt = [long]0; refreshRetried = [long]0; toRevoke = ((@($rec.toRevoke, $old) | Where-Object { $_ }) -join ' ') }
            Write-Record $ctx $rec
            $rec = Invoke-RevokePending $ctx $rec
            $done = [ordered]@{ status = 'connected'; label = $rec.label; scope = $rec.scope }
          } elseif ($oauthError -eq 'authorization_pending' -or $oauthError -eq 'slow_down') {
            $interval = $rec.interval
            if ($oauthError -eq 'slow_down') { $interval += 5 }
            Write-Record $ctx (Merge $rec @{ interval = $interval; nextPollAt = $t + $interval })
            $wait = $interval
          } elseif ($oauthError -eq 'access_denied') {
            Write-Record $ctx (Clear-Pending $rec)
            Fail 'denied' 'The person did not approve the connection.'
          } elseif ($oauthError -eq 'expired_token' -or $oauthError -eq 'invalid_grant') {
            Write-Record $ctx (Clear-Pending $rec)
            Fail 'expired' 'The code is no longer valid. Run: n8n-ops connect'
          } else { throw (New-HttpFail $r 'Waiting for the approval') }
        }
      }
    } finally { Exit-Lock $ctx $lock }
    if ($done) { return Write-Json $done }
    if ([DateTime]::UtcNow.AddSeconds($wait) -gt $until) {
      return Write-Json ([ordered]@{ status = 'still_waiting'; next = 'Not approved yet. Run again: n8n-ops connect --wait' })
    }
    Start-Sleep -Seconds $wait
  }
}

function Test-Usable($rec) { $rec.accessToken -and ($rec.accessExpiresAt - (Now)) -gt 60 -and -not $rec.refreshStartedAt }

# A live access token: the stored one while it lasts, else one refresh under the lock.
function Get-AccessToken($ctx, [string]$stale) {
  $first = Read-Record $ctx
  if (-not $first -or -not $first.refreshToken) { Fail 'not_connected' 'Not connected. Run: n8n-ops connect' }
  if (-not $stale -and (Test-Usable $first)) { return $first.accessToken }
  $lock = Enter-Lock $ctx
  try {
    $rec = Read-Record $ctx
    if (-not $rec -or -not $rec.refreshToken) { Fail 'not_connected' 'Not connected. Run: n8n-ops connect' }
    $rec = Invoke-RevokePending $ctx $rec
    # Another command refreshed while this one waited for the lock.
    if ((Test-Usable $rec) -and $rec.accessToken -ne $stale) { return $rec.accessToken }
    $before = @{ refreshStartedAt = $rec.refreshStartedAt; refreshRetried = $rec.refreshRetried }
    # A refresh that started moments ago may still be on its way (its holder lost the lock): never send it twice.
    if ($rec.refreshStartedAt -and ((Now) - $rec.refreshStartedAt) -lt $RefreshGrace) {
      Fail 'busy' 'Another n8n-ops command is refreshing this connection. Nothing was sent; run it again.'
    }
    if ($rec.refreshStartedAt) {
      # The last refresh got no answer; trying once more either continues the connection or ends it there.
      if ($rec.refreshRetried) { Fail 'connection_ended' 'Two refreshes got no answer, so this connection cannot be trusted. Run: n8n-ops connect --replace' }
      $rec.refreshRetried = [long]1
    }
    $rec.refreshStartedAt = Now
    Write-Record $ctx $rec
    Assert-Mine $ctx $lock
    Invoke-Hook 'before-refresh'
    try {
      $r = Invoke-OAuth $ctx '/oauth/token' ([ordered]@{ grant_type = 'refresh_token'; refresh_token = $rec.refreshToken })
    } catch [OpsFail] {
      # Nothing left the computer: the token is as good as before.
      if ($_.Exception.Code -eq 'unreachable' -and -not $_.Exception.Sent) { Write-Record $ctx (Merge $rec $before) }
      throw
    }
    if ($r.status -eq 200) {
      $next = Merge (Merge $rec (Get-Tokens $r)) @{ refreshStartedAt = [long]0; refreshRetried = [long]0 }
      Invoke-Hook 'before-write'
      if (-not (Test-Mine $ctx $lock)) {
        # The lock was taken while this one waited for n8n-ops: keep the new tokens anyway, under a fresh lock.
        $again = Enter-Lock $ctx $lock
        try { Write-Record $ctx $next } finally { Exit-Lock $ctx $again }
      } else { Write-Record $ctx $next }
      return $next.accessToken
    }
    if ((Get-Field $r 'error') -eq 'invalid_grant') {
      # An old connection still to be ended (after --replace) keeps its place until n8n-ops confirms it.
      if ($rec.toRevoke) { Write-Record $ctx (Merge (New-Record $ctx) @{ label = $rec.label; toRevoke = $rec.toRevoke }) }
      else { Remove-Record $ctx }
      Fail 'connection_ended' 'This connection has ended (disconnected in n8n-ops, unused for 90 days, or its token was used twice). Run: n8n-ops connect'
    }
    # n8n-ops answered with an error before spending the token (a 4xx); a 5xx may have come after.
    if ($r.status -lt 500) { Write-Record $ctx (Merge $rec $before) }
    throw (New-HttpFail $r 'Refreshing the connection')
  } finally { Exit-Lock $ctx $lock }
}

function Get-ApiUrl($ctx, [string]$p) {
  $bad = 'Give a path of the API, for example: problems?status=open (percent-encode anything else)'
  # Encoded dots too: a server or proxy that decodes them would take the token out of the API.
  if (-not $p -or $p -notmatch $PathChars -or $p.Contains('://') -or $p.StartsWith('//') -or $p -match '%2e') { Fail 'bad_path' $bad }
  $sep = '/'; if ($p.StartsWith('/')) { $sep = '' }
  $u = $null
  if (-not [Uri]::TryCreate("$($ctx.issuer)/api/v1$sep$p", [UriKind]::Absolute, [ref]$u)) { Fail 'bad_path' $bad }
  if ("$($u.Scheme)://$($u.Authority)" -ne $ctx.issuer -or -not $u.AbsolutePath.StartsWith('/api/v1/')) { Fail 'bad_path' $bad }
  $u.AbsoluteUri
}

function Invoke-Api($ctx, [string]$method, [string]$p, $json) {
  $url = Get-ApiUrl $ctx $p
  if ($null -ne $json) { try { [void]($json | ConvertFrom-Json) } catch { Fail 'bad_body' 'The body is not JSON.' } }
  $token = Get-AccessToken $ctx ''
  $r = Invoke-Ops $ctx $method $url $null $token $json
  if ($r.status -eq 401) {
    $token = Get-AccessToken $ctx $token
    $r = Invoke-Ops $ctx $method $url $null $token $json
  }
  if ($r.status -ge 200 -and $r.status -lt 300) {
    Write-Raw $r.bytes
    if (-not $r.text.EndsWith("`n")) { Write-Raw $Utf8.GetBytes("`n") }
    return
  }
  if ($r.status -eq 403 -and (Get-Field $r 'error') -eq 'not_allowed') {
    Fail 'insufficient_scope' 'This agent was connected without instance access. Ask the person, then run: n8n-ops connect --replace'
  }
  throw (New-HttpFail $r "$method $p")
}

function Invoke-Disconnect($ctx) {
  $lock = Enter-Lock $ctx
  try {
    $rec = Read-Record $ctx
    if (-not $rec) { return Write-Json ([ordered]@{ status = 'not_connected' }) }
    Assert-Mine $ctx $lock
    $left = @()
    foreach ($token in (@($rec.refreshToken) + ($rec.toRevoke -split ' ') | Where-Object { $_ })) {
      $ok = $false
      try { $r = Invoke-OAuth $ctx '/oauth/revoke' ([ordered]@{ token = $token; token_type_hint = 'refresh_token' }); $ok = $r.status -eq 200 } catch {}
      if (-not $ok) { $left += $token }
    }
    if ($left.Count) {
      Write-Record $ctx (Merge $rec @{ refreshToken = ''; accessToken = ''; accessExpiresAt = [long]0; toRevoke = ($left -join ' ') })
      Fail 'disconnect_failed' 'n8n-ops did not confirm the disconnect. Run it again, or disconnect this agent in n8n-ops Settings.'
    }
    Remove-Record $ctx
    Write-Json ([ordered]@{ status = 'disconnected' })
  } finally { Exit-Lock $ctx $lock }
}

function Invoke-Main([string[]]$argv) {
  $list = New-Object System.Collections.Generic.List[string]
  foreach ($a in $argv) { $list.Add($a) }
  $command = 'help'
  if ($list.Count) { $command = $list[0]; $list.RemoveAt(0) }
  $o = @{ url = ''; replace = $false; wait = $false; json = $null; jsonFile = $null; positional = @() }
  for ($i = 0; $i -lt $list.Count; $i++) {
    $a = $list[$i]
    if ($a -eq '--url') { $i++; $o.url = $list[$i] }
    elseif ($a -eq '--replace') { $o.replace = $true }
    elseif ($a -eq '--wait') { $o.wait = $true }
    elseif ($a -eq '--json') { $i++; $o.json = $list[$i] }
    elseif ($a -eq '--json-file') { $i++; $o.jsonFile = $list[$i] }
    else { $o.positional += $a }
  }
  if (@('help', '--help', '-h') -contains $command) { Write-Line $Help; return }
  $ctx = Get-Context $o.url
  $first = $null
  if ($o.positional.Count) { $first = $o.positional[0] }
  switch ($command) {
    'status' { Show-Status $ctx }
    'connect' { if ($o.wait) { Invoke-Wait $ctx } else { Invoke-Connect $ctx $o.replace } }
    'get' { Invoke-Api $ctx 'GET' $first $null }
    'post' {
      $body = $o.json
      if ($null -ne $o.jsonFile) { try { $body = [IO.File]::ReadAllText($o.jsonFile, $Utf8) } catch { Fail 'bad_body' "Cannot read $($o.jsonFile)." } }
      if ($null -eq $body) { $body = '{}' }
      Invoke-Api $ctx 'POST' $first $body
    }
    'disconnect' { Invoke-Disconnect $ctx }
    default { Fail 'unknown_command' "Unknown command `"$command`". Run: n8n-ops help" }
  }
}

try {
  Invoke-Main $args
  exit 0
} catch {
  $e = $_.Exception
  if ($e -is [OpsFail]) {
    $out = [ordered]@{ error = $e.Code; message = $e.Message }
    if ($null -ne $e.Body) { $out.body = $e.Body }
    Write-Json $out
  } else {
    Write-Json ([ordered]@{ error = 'failed'; message = $e.Message })
  }
  exit 1
}
