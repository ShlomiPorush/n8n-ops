# n8n-ops for agents on Windows: runs the Node version when Node 20+ is installed, and otherwise does the same
# itself with Windows PowerShell 5.1 (built into Windows 10 and 11) or PowerShell 7.
#
# One of three versions with one contract (see n8n-ops.mjs): same commands, same JSON output and error codes,
# same files and the same lock, so they can run side by side. Tokens never appear in the output.
#
# Run it as: powershell -NoProfile -ExecutionPolicy Bypass -File n8n-ops.ps1 <command> ...
# (the policy is bypassed for this one process only; nothing on the computer changes).

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

# ==== Product constants: the same values in all three versions and the entry point. ====
$Product = 'n8n-ops'
$Cmd = 'n8n-ops'
# Environment variables are this prefix plus URL, CREDENTIALS, AGENT_NAME, NO_NODE, WAIT_SECONDS, LOCK_WAIT_MS.
$EnvPrefix = 'N8N_OPS_'
# The credentials folder, in the user's profile.
$CredentialsFolder = '.n8n-ops'
$ClientId = 'n8n-ops-cli'
$Scope = 'ops:read ops:access'
# The REST API as a resource (RFC 8707): the audience its access tokens are bound to.
$Resource = '/api/v1'
# Every API call is under one of these prefixes, so the token goes only to the API.
$Prefixes = @('/api/v1/')
# A path template in the endpoints list: under $Prefixes, with {name} and {name:path} parts.
$TemplatePattern = '^/api/v1/[A-Za-z0-9._~{}:/-]*\z'
$AccessPath = '/api/v1/agent/access'
$EndpointsPath = '/api/v1/agent/endpoints'
# The authorization server's device, token and revocation endpoints, after the address.
$DevicePath = '/oauth/device'
$TokenPath = '/oauth/token'
$RevokePath = '/oauth/revoke'
$SkillHeaderName = 'x-n8n-ops-skill'
$PolicyHeaderName = 'x-n8n-ops-policy'
# The header that carries the kind (read or act) the client found for a call, with the policy revision.
$KindHeaderName = 'x-n8n-ops-kind'
$KindsMagic = 'n8n-ops-kinds'
# Filled in with the address when the server serves this file.
$DefaultUrl = '__N8N_OPS_URL__'
# Filled in with the skill's version when the server serves this file; access then says when a newer one is out.
$SkillVersion = '__N8N_OPS_SKILL_VERSION__'
# A copy that was not served (installed from Git) sends r<SkillRevision> instead; raise it with the server's copy.
$SkillRevision = 1
# ==== End of product constants. ====

function Get-Env([string]$name) { [Environment]::GetEnvironmentVariable("$EnvPrefix$name") }

if (-not (Get-Env 'NO_NODE')) {
  $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($node) {
    & $node.Source -e "process.exit(Number(process.versions.node.split('.')[0])>=20?0:1)" 2>$null
    if ($LASTEXITCODE -eq 0) {
      & $node.Source (Join-Path $PSScriptRoot "$Cmd.mjs") @args
      exit $LASTEXITCODE
    }
  }
}

$SkillHeader = $SkillVersion
if ($SkillVersion.StartsWith('__')) { $SkillHeader = "r$SkillRevision" }
$WaitSeconds = 90
if (Get-Env 'WAIT_SECONDS') { $WaitSeconds = [int](Get-Env 'WAIT_SECONDS') }
# A pending code is dropped locally only this long after its expiry: until then the server decides.
$StaleCodeSeconds = 600
# A refresh is retried only once it cannot be in flight any more: twice the request timeout (tests shorten it).
$RefreshGrace = 30
if ($null -ne (Get-Env 'TEST_REFRESH_GRACE')) { $RefreshGrace = [long](Get-Env 'TEST_REFRESH_GRACE') }
$PollSeconds = 5
if (Get-Env 'TEST_POLL_SECONDS') { $PollSeconds = [long](Get-Env 'TEST_POLL_SECONDS') }
$LockWaitMs = 20000
if (Get-Env 'LOCK_WAIT_MS') { $LockWaitMs = [int](Get-Env 'LOCK_WAIT_MS') }
# The server answers an API call within 60 s (or says the outcome is unknown); tests shorten it.
$ApiTimeoutMs = 75000
if (Get-Env 'TEST_API_TIMEOUT_MS') { $ApiTimeoutMs = [int](Get-Env 'TEST_API_TIMEOUT_MS') }
# Wait before the one retry of a call the server refused as busy (tests shorten it).
$BusyWaitMs = 2000
if ($null -ne (Get-Env 'TEST_BUSY_WAIT_MS')) { $BusyWaitMs = [int](Get-Env 'TEST_BUSY_WAIT_MS') }
$KindsMaxAge = 3600
$KindsFormat = '2'
# \z, not $: in .NET a $ also matches before a final line break, which would let one into a stored value.
$Secret = '^[A-Za-z0-9._~+/=-]{1,4096}\z'
# The policy revision the server gives with its list: a short token, safe in a header and in the kinds file.
$RevisionPattern = '^[A-Za-z0-9._-]{1,128}\z'
$Plain = '^[^"\\\x00-\x1f\x7f]*\z'
# The only address shape kept (the server serves its own address in this shape too): no character an agent's
# shell would treat specially can reach the commands this one prints.
$SafeOrigin = '^https?://(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:[1-9][0-9]{0,4})?\z'
# The file that keeps the address of the last working connection, so a copy of the skill without one finds it.
$AddressFile = 'address'
$PathChars = "^[A-Za-z0-9._~!$&'()*+,;=:@/?%-]+\z"
$UnknownOutcome = 'The action may have run. Read its state before trying again.'
$NotListed = "This connection has no such call. Take the path from ``$Cmd endpoints``, with its {...} parts filled in; never guess it."
$Unavailable = "The list of allowed calls could not be read from $Product, so nothing was sent. Try again in a moment."
$NoAccessScope = "This agent may not request access to n8n instances. Ask the person to allow it, then run: $Cmd connect --replace"
$PolicyChanged = "$Product's calls changed, or this path names a different call than the list says. Nothing ran. Run ``$Cmd endpoints`` and take the path from it."
$Fields = @(
  @('v', 'n'), @('issuer', 's'), @('label', 's'), @('generation', 's'), @('refreshToken', 's'), @('accessToken', 's'),
  @('accessExpiresAt', 'n'), @('scope', 's'), @('refreshStartedAt', 'n'), @('refreshRetried', 'n'), @('deviceCode', 's'),
  @('userCode', 's'), @('link', 's'), @('deviceExpiresAt', 'n'), @('interval', 'n'), @('nextPollAt', 'n'), @('toRevoke', 's')
)
$Utf8 = New-Object System.Text.UTF8Encoding($false)
# Windows tools by their full path: started from Git Bash, for one, whoami.exe may be a different program.
$Icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
$Whoami = Join-Path $env:SystemRoot 'System32\whoami.exe'

class ClientFail : System.Exception {
  [string]$Code
  [object]$Body
  [bool]$Sent
  # Set when the API request itself failed (not the token or the lock on the way to it).
  [bool]$Api
  [int]$Status
  ClientFail([string]$code, [string]$message) : base($message) { $this.Code = $code; $this.Sent = $true; $this.Api = $false; $this.Status = 0 }
}

function Fail([string]$code, [string]$message) { throw [ClientFail]::new($code, $message) }
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
function ConvertTo-JsonString([string]$text) { ConvertTo-Json -InputObject $text -Compress }

$Help = @"
${Cmd}: use $Product after a person approves it.

  connect [--replace]   Ask to connect; prints a link and a code to show the person.
  connect --wait        Wait up to $WaitSeconds s for the approval; run again while it answers still_waiting.
  access                What this connection may read or act on, and until when.
  endpoints [area]      The calls this connection may make, with their kind (read or act).
  get <path>            GET a path, for example: get '/api/v1/problems?status=open'
  post <path> [--json <body> | --json-file <file>]
  status                Whether this computer user is connected (no secrets).
  disconnect            End this computer user's connection.

  --url <address>       The $Product address (or ${EnvPrefix}URL). Kept once connected, for the commands after.
"@

# Reads a file the other commands may replace or delete meanwhile. ReadAllText shares it for reading only, so on
# Windows a concurrent replace or delete of that file would fail while it is open.
function Read-Shared([string]$file) {
  $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
  $fs = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
  try { (New-Object IO.StreamReader($fs, $Utf8)).ReadToEnd() } finally { $fs.Dispose() }
}

# Context: the server's address and where its connection is kept, one per address for this computer user. The
# connection belongs to the computer user, not to the skill's folder, which is never written.
# The address: --url, the environment, the one filled in when the server served this file, or the one kept on
# connecting.

function Get-Context([string]$urlOption) {
  $dir = Get-CredentialsDir
  $raw = $urlOption
  if (-not $raw) { $raw = Get-Env 'URL' }
  if (-not $raw -and -not $DefaultUrl.StartsWith('__')) { $raw = $DefaultUrl }
  $kept = ''
  if (-not $raw) { $kept = Get-KeptAddress $dir; $raw = $kept }
  if (-not $raw) { Fail 'no_url' "No $Product address. Ask the person for it, then run: $Cmd connect --url `"<address>`"" }
  try {
    # A kept address is one line: anything else in the file makes it invalid, not a different address.
    if ($kept -and $kept -match '\s') { Fail 'insecure_url' '' }
    $issuer = Get-Issuer $raw
  } catch [ClientFail] {
    if (-not $kept) { throw }
    Fail 'no_url' "The address kept in $(Join-Path $dir $AddressFile) is not valid. Pass --url `"<address>`"."
  }
  $sha = [Security.Cryptography.SHA256]::Create().ComputeHash($Utf8.GetBytes($issuer))
  $key = (-join ($sha | ForEach-Object { $_.ToString('x2') })).Substring(0, 32)
  @{
    issuer = $issuer; dir = $dir
    file = Join-Path $dir "$key.json"; lock = Join-Path $dir "$key.lock"; kinds = Join-Path $dir "$key.kinds"
    label = Get-Label
  }
}

# An IPv6 address (without its brackets) as a browser writes it, or $null when it is not one: the WHATWG URL
# standard's parser and serializer, as Node and the sh version have them. Lower case without leading zeros, the
# first longest run of two or more zero groups as ::, and a dotted IPv4 end in hex. .NET writes some addresses
# otherwise (Windows PowerShell in full and upper case) and reads some wrongly (Windows PowerShell takes
# [::1:2:3:4:5:6:7] for all zeros, and drops a %25 zone), so the address is read from the text.
function ConvertTo-Ipv6Text([string]$text) {
  $s = $text.ToLowerInvariant(); $n = $s.Length
  $hex = '0123456789abcdef'
  $a = New-Object int[] 8
  $p = 0; $piece = 0; $compress = -1
  if ($n -gt 0 -and $s[0] -eq ':') {
    if ($n -lt 2 -or $s[1] -ne ':') { return $null }
    $p = 2; $piece = 1; $compress = 1
  }
  while ($p -lt $n) {
    if ($piece -eq 8) { return $null }
    if ($s[$p] -eq ':') {
      if ($compress -ge 0) { return $null }
      $p++; $piece++; $compress = $piece; continue
    }
    $value = 0; $length = 0
    while ($length -lt 4 -and $p -lt $n -and $hex.IndexOf($s[$p]) -ge 0) { $value = $value * 16 + $hex.IndexOf($s[$p]); $p++; $length++ }
    if ($p -lt $n -and $s[$p] -eq '.') {
      # A dotted IPv4 end: four decimal numbers of 0 to 255 without leading zeros, as the last two groups.
      if ($length -eq 0 -or $piece -gt 6) { return $null }
      $p -= $length
      $seen = 0
      while ($p -lt $n) {
        if ($seen -gt 0) { if ($s[$p] -eq '.' -and $seen -lt 4) { $p++ } else { return $null } }
        if ($p -ge $n -or $hex.IndexOf($s[$p]) -lt 0 -or $hex.IndexOf($s[$p]) -gt 9) { return $null }
        $v4 = -1
        while ($p -lt $n -and $hex.IndexOf($s[$p]) -ge 0 -and $hex.IndexOf($s[$p]) -le 9) {
          if ($v4 -eq 0) { return $null }
          if ($v4 -lt 0) { $v4 = 0 }
          $v4 = $v4 * 10 + $hex.IndexOf($s[$p])
          if ($v4 -gt 255) { return $null }
          $p++
        }
        $a[$piece] = $a[$piece] * 256 + $v4
        $seen++
        if ($seen -eq 2 -or $seen -eq 4) { $piece++ }
      }
      if ($seen -ne 4) { return $null }
      break
    }
    if ($p -lt $n) {
      if ($s[$p] -ne ':') { return $null }
      $p++
      if ($p -ge $n) { return $null }
    }
    $a[$piece] = $value; $piece++
  }
  if ($compress -ge 0) {
    $swaps = $piece - $compress; $piece = 7
    while ($piece -ne 0 -and $swaps -gt 0) {
      $t = $a[$piece]; $a[$piece] = $a[$compress + $swaps - 1]; $a[$compress + $swaps - 1] = $t
      $piece--; $swaps--
    }
  } elseif ($piece -ne 8) { return $null }
  $best = -1; $bestLength = 1; $i = 0
  while ($i -lt 8) {
    if ($a[$i] -ne 0) { $i++; continue }
    $j = $i
    while ($j -lt 8 -and $a[$j] -eq 0) { $j++ }
    if ($j - $i -gt $bestLength) { $best = $i; $bestLength = $j - $i }
    $i = $j
  }
  $out = ''
  for ($i = 0; $i -lt 8; $i++) {
    if ($i -eq $best) {
      if ($i -eq 0) { $out += '::' } else { $out += ':' }
      $i += $bestLength - 1
      continue
    }
    $out += $a[$i].ToString('x')
    if ($i -ne 7) { $out += ':' }
  }
  $out
}

# The host of an address as a browser writes it.
function Get-HostName([Uri]$u) {
  if ($u.HostNameType -eq [UriHostNameType]::IPv6) { return "[$(ConvertTo-Ipv6Text $u.Host.Trim('[', ']'))]" }
  $u.Host
}
function Get-Origin([Uri]$u) { "$($u.Scheme)://$(Get-HostName $u)$($u.Authority.Substring($u.Host.Length))" }

# The origin of an address: https (http only on this computer), with nothing after it.
function Get-Issuer([string]$raw) {
  $u = $null
  if (-not [Uri]::TryCreate($raw, [UriKind]::Absolute, [ref]$u)) { Fail 'insecure_url' "`"$raw`" is not an address." }
  $name = Get-HostName $u
  if ($raw -match '^[a-z][a-z0-9+.-]*://\[([^\]]*)\]') {
    $v6 = ConvertTo-Ipv6Text $Matches[1]
    if ($null -eq $v6) { Fail 'insecure_url' "`"$raw`" is not an address." }
    $name = "[$v6]"
  }
  $loopback = @('127.0.0.1', '[::1]', 'localhost') -contains $name
  if (-not ($u.Scheme -eq 'https' -or ($u.Scheme -eq 'http' -and $loopback))) {
    Fail 'insecure_url' 'The address must start with https:// (http only for this computer).'
  }
  if ($u.UserInfo -or $u.Query -or $u.Fragment -or ($u.AbsolutePath -ne '/')) {
    Fail 'insecure_url' 'Use the address alone, for example https://n8n-ops.example.com.'
  }
  $issuer = "$($u.Scheme)://$name$($u.Authority.Substring($u.Host.Length))"
  if ($issuer -cnotmatch $SafeOrigin) { Fail 'insecure_url' 'Use the address alone, for example https://n8n-ops.example.com.' }
  $issuer
}

function Get-KeptAddress([string]$dir) {
  $file = Join-Path $dir $AddressFile
  # Attributes of the path itself, without following a link: a folder or a broken link is refused, not missing.
  try { $attr = [IO.File]::GetAttributes($file) } catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] { return '' }
  if (($attr -band [IO.FileAttributes]::ReparsePoint) -or ($attr -band [IO.FileAttributes]::Directory)) {
    Fail 'insecure_credentials' "$file must be a plain file."
  }
  try { $text = Read-Shared $file } catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] { return '' }
  $text -replace '[\r\n]+\z', ''
}

# Keeps the address of a working connection, in one step. Only a convenience: a failure changes nothing.
function Save-Address($ctx) {
  try {
    if ((Get-KeptAddress $ctx.dir) -ceq $ctx.issuer) { return }
    Write-Private $ctx (Join-Path $ctx.dir $AddressFile) "$($ctx.issuer)`n"
  } catch {
    # The connection works without it: --url, the environment or the served address still find it.
  }
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

# What the connection is called on the approval page and in the product's list of connections.
function Get-Label {
  $l = "Agents on $(HostName)"
  if (Get-Env 'AGENT_NAME') { $l = Get-Env 'AGENT_NAME' }
  if ($l.Length -gt 60) { $l = $l.Substring(0, 60) }
  $l
}

function Get-CredentialsDir {
  if ([Environment]::OSVersion.Platform -ne 'Win32NT') { Fail 'failed' "On Linux and macOS, run $Cmd (or $Cmd.sh)." }
  $dir = Get-Env 'CREDENTIALS'
  if (-not $dir) { $dir = Join-Path $env:USERPROFILE $CredentialsFolder }
  $dir = [IO.Path]::GetFullPath($dir).TrimEnd('\')
  $userHome = [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\').ToLowerInvariant()
  $lower = $dir.ToLowerInvariant()
  if ($lower -ne $userHome -and -not $lower.StartsWith("$userHome\")) {
    Fail 'insecure_credentials' "Keep the $Cmd folder inside your user profile ($userHome), not $dir."
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
    $sid = Get-UserSid
    & $Icacls $dir /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /Q *> $null
    if ($LASTEXITCODE -ne 0) { throw 'icacls' }
    # The owner may always change an ACL, so the folder and its files must be this user's. (Only now: taking
    # ownership needs the full control just granted. No /C, which would hide a failure behind exit code 0.)
    Invoke-Icacls @($dir, '/setowner', "*$sid", '/T', '/Q')
    # Granting does not remove other entries: read the folder's and its files' ACLs back and allow no one else.
    Assert-OnlyUser $dir $sid
  } catch [ClientFail] { throw } catch {
    Fail 'insecure_credentials' "Could not limit $dir to your user ($($_.Exception.Message))."
  }
  $script:Secured = $true
}

# Before the connection's file is read: the folder must still be one only this user can open, since a restore or a
# change of its permissions may have opened it since Protect-Dir set it up. Checks only, never changes it; once per
# command.
$script:Checked = $false
function Test-Dir([string]$dir) {
  if ($script:Secured -or $script:Checked) { return }
  $item = Get-Item -LiteralPath $dir -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $item.PSIsContainer) {
    Fail 'insecure_credentials' "$dir must be a plain folder, not a link."
  }
  try { Assert-OnlyUser $dir (Get-UserSid) } catch [ClientFail] { throw } catch {
    Fail 'insecure_credentials' "Could not check who can open $dir ($($_.Exception.Message))."
  }
  $script:Checked = $true
}

function Get-UserSid {
  $who = (& $Whoami /user /fo csv /nh) -join ''
  if ($who -notmatch '"(S-1-[0-9-]+)"\s*$') { throw 'no SID' }
  $Matches[1]
}

# Reads the folder's and its files' ACLs back and allows no one but this user, SYSTEM and Administrators. (icacls,
# not Get-Acl: started from PowerShell 7, Windows PowerShell may fail to load the module Get-Acl is in.)
function Assert-OnlyUser([string]$dir, [string]$sid) {
  $saved = Join-Path $dir ".acl-$(Hex 4)"
  try {
    Invoke-Icacls @($dir, '/save', $saved, '/T', '/Q')
    $other = Find-OtherAllowed ([IO.File]::ReadAllText($saved, [Text.Encoding]::Unicode)) $sid
    if ($other) { Fail 'insecure_credentials' "Others can open $dir ($other). Remove their access." }
  } finally { if ([IO.File]::Exists($saved)) { [IO.File]::Delete($saved) } }
}

# Attributes of the path itself, without following a link. Not Get-Item: while another command replaces the file,
# Get-Item can report it as a folder (PowerShell 7), which would refuse a plain file.
function Test-PlainFile([string]$file) {
  $attr = [IO.File]::GetAttributes($file)
  if (($attr -band [IO.FileAttributes]::ReparsePoint) -or ($attr -band [IO.FileAttributes]::Directory)) {
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
  try { Test-PlainFile $ctx.file } catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] { return $null }
  Test-Dir $ctx.dir
  try { $text = Read-Shared $ctx.file } catch [IO.FileNotFoundException] { return $null }
  try { $parsed = $text | ConvertFrom-Json } catch {
    Fail 'insecure_credentials' "$($ctx.file) is damaged. Delete it and connect again."
  }
  if ($null -eq $parsed) { Fail 'insecure_credentials' "$($ctx.file) is damaged. Delete it and connect again." }
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
      if ($value -notmatch $Plain) { Fail 'unexpected_answer' "$Product sent a value that cannot be stored ($($f[0]))." }
      "`"$($f[0])`":`"$value`""
    }
  }
  '{' + ($parts -join ',') + "}`n"
}

# Writes a file of the connection in one step: a new private file, flushed, moved over the old one.
function Write-Private($ctx, [string]$file, [string]$text) {
  Protect-Dir $ctx.dir
  $tmp = "$file.$(Hex 6).tmp"
  try {
    $fs = [IO.File]::Open($tmp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $bytes = $Utf8.GetBytes($text); $fs.Write($bytes, 0, $bytes.Length); $fs.Flush($true) } finally { $fs.Dispose() }
  } catch { Fail 'cannot_save' "Cannot write in $($ctx.dir). Allow this agent to write there." }
  Move-Over $tmp $file
}

function Write-Record($ctx, $rec) { Write-Private $ctx $ctx.file (Format-Record $rec) }

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

function Remove-Kinds($ctx) { if ([IO.File]::Exists($ctx.kinds)) { [IO.File]::Delete($ctx.kinds) } }
function Remove-Record($ctx) { if ([IO.File]::Exists($ctx.file)) { [IO.File]::Delete($ctx.file) }; Remove-Kinds $ctx }

# The lock: a file created exclusively, naming its holder. Never taken from a live holder, however old.

function Read-Lock([string]$file) {
  if (-not [IO.File]::Exists($file)) { return $null }
  try {
    $text = Read-Shared $file
    $held = $text | ConvertFrom-Json
    if ($held -and $held.PSObject.Properties['token']) { return $held }
  } catch {}
  try { return [pscustomobject]@{ empty = $true; mtime = [IO.File]::GetLastWriteTimeUtc($file) } } catch { return $null }
}

function Test-Alive([int]$id) { [bool](Get-Process -Id $id -ErrorAction SilentlyContinue) }

function Invoke-Hook([string]$point) {
  $at = Get-Env ('TEST_HOLD_' + $point.ToUpperInvariant().Replace('-', '_'))
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
        Fail 'busy' "Another $Cmd command has held $($ctx.lock) for over 10 minutes. If none is running, delete that file."
      }
      Fail 'busy' "Another $Cmd command is using this connection. Nothing was sent; run it again."
    }
    # Reached only while another live process holds the lock: the tests wait for it instead of for a fixed time.
    Invoke-Hook 'lock-busy'
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
  if (-not (Test-Mine $ctx $token)) { Fail 'busy' "Another $Cmd command took over this connection. Run it again." }
}

# Requests

# Plain HTTP/1.1 over one new connection per request, never HttpClient: .NET's HttpClient sends a request again by
# itself when its connection breaks before the answer (PowerShell 7 sent a dropped request four times), and
# neither an action nor a one-time refresh token may ever be sent twice. No redirects are followed.

function Find-Bytes([byte[]]$hay, [byte[]]$needle, [int]$from) {
  for ($i = $from; $i -le $hay.Length - $needle.Length; $i++) {
    $ok = $true
    for ($j = 0; $j -lt $needle.Length; $j++) { if ($hay[$i + $j] -ne $needle[$j]) { $ok = $false; break } }
    if ($ok) { return $i }
  }
  -1
}

# The body of a chunked answer, or $null when it is cut short.
function Get-Unchunked([byte[]]$raw) {
  $out = New-Object System.IO.MemoryStream
  $crlf = [byte[]](13, 10)
  $at = 0
  while ($true) {
    $end = Find-Bytes $raw $crlf $at
    if ($end -lt 0) { return $null }
    $sizeText = ([Text.Encoding]::ASCII.GetString($raw, $at, $end - $at) -split ';')[0].Trim()
    $size = 0
    if (-not [int]::TryParse($sizeText, [Globalization.NumberStyles]::HexNumber, $null, [ref]$size)) { return $null }
    if ($size -eq 0) { return , $out.ToArray() }
    $start = $end + 2
    if ($start + $size + 2 -gt $raw.Length) { return $null }
    $out.Write($raw, $start, $size)
    $at = $start + $size + 2
  }
}

# A socket of the address's own family when the host is an IP address: Windows PowerShell's default TcpClient reaches
# IPv4 only, so an IPv6 address such as [::1] needs an IPv6 one. A host name keeps the default.
function New-TcpClient([string]$hostName) {
  $ip = $null
  if ([Net.IPAddress]::TryParse($hostName, [ref]$ip)) { return New-Object System.Net.Sockets.TcpClient($ip.AddressFamily) }
  New-Object System.Net.Sockets.TcpClient
}

# One request. $bearer marks an API call (with its longer time limit); $policy is the revision to send with it, and
# $kind the kind the client found for the call.
function Invoke-Http($ctx, [string]$method, [string]$url, $form, [string]$bearer, $json, [string]$policy = '', [string]$kind = '') {
  $timeoutMs = 15000
  if ($bearer) { $timeoutMs = $ApiTimeoutMs }
  $u = [Uri]$url
  $bodyBytes = $null; $contentType = ''
  if ($form) {
    $pairs = foreach ($k in $form.Keys) { [Uri]::EscapeDataString([string]$k) + '=' + [Uri]::EscapeDataString([string]$form[$k]) }
    $bodyBytes = $Utf8.GetBytes(($pairs -join '&')); $contentType = 'application/x-www-form-urlencoded'
  } elseif ($null -ne $json) {
    $bodyBytes = $Utf8.GetBytes([string]$json); $contentType = 'application/json'
  }
  $head = "$method $($u.PathAndQuery) HTTP/1.1`r`nHost: $($u.Authority)`r`nAccept: application/json`r`nConnection: close`r`nUser-Agent: $Cmd`r`n"
  if ($bearer) { $head += "Authorization: Bearer $bearer`r`n${SkillHeaderName}: $SkillHeader`r`n" }
  # The revision and the kind go together: the server runs the call only when both still hold for the route it picks.
  if ($policy) { $head += "${PolicyHeaderName}: $policy`r`n${KindHeaderName}: $kind`r`n" }
  if ($null -ne $bodyBytes) { $head += "Content-Type: $contentType`r`nContent-Length: $($bodyBytes.Length)`r`n" }
  elseif ($method -ceq 'POST') { $head += "Content-Length: 0`r`n" }
  $head += "`r`n"
  $tcp = New-TcpClient $u.DnsSafeHost
  $stream = $null; $sent = $false
  $clock = [Diagnostics.Stopwatch]::StartNew()
  try {
    try {
      $connect = $tcp.ConnectAsync($u.DnsSafeHost, $u.Port)
      if (-not $connect.Wait(10000)) { throw 'the connection timed out' }
      $stream = $tcp.GetStream()
      if ($u.Scheme -eq 'https') {
        $ssl = New-Object System.Net.Security.SslStream($stream, $false)
        # The system's TLS versions; the certificate is checked as usual. The handshake gets
        # what is left of the request's time: a server that stops in it cannot hold the lock.
        $left = $timeoutMs - [int]$clock.ElapsedMilliseconds
        if ($left -le 0) { throw 'the connection timed out' }
        $tcp.ReceiveTimeout = $left; $tcp.SendTimeout = $left
        $handshake = $ssl.AuthenticateAsClientAsync($u.DnsSafeHost, $null, [Security.Authentication.SslProtocols]::None, $true)
        if (-not $handshake.Wait($left)) { $tcp.Close(); throw 'the TLS handshake timed out' }
        $stream = $ssl
      }
    } catch {
      # The name, the connection or TLS failed first: nothing reached the server.
      $f = [ClientFail]::new('unreachable', "Cannot reach $($ctx.issuer) ($($_.Exception.GetBaseException().Message)).")
      $f.Sent = $false
      throw $f
    }
    $raw = New-Object System.IO.MemoryStream
    try {
      $sent = $true
      $stream.WriteTimeout = $timeoutMs
      $headBytes = [Text.Encoding]::ASCII.GetBytes($head)
      $stream.Write($headBytes, 0, $headBytes.Length)
      if ($null -ne $bodyBytes) { $stream.Write($bodyBytes, 0, $bodyBytes.Length) }
      $stream.Flush()
      $buf = New-Object byte[] 65536
      while ($true) {
        $left = $timeoutMs - [int]$clock.ElapsedMilliseconds
        if ($left -le 0) { throw 'no answer in time' }
        $stream.ReadTimeout = $left
        $n = $stream.Read($buf, 0, $buf.Length)
        if ($n -le 0) { break }
        $raw.Write($buf, 0, $n)
      }
    } catch {
      $f = [ClientFail]::new('unreachable', "Cannot reach $($ctx.issuer) ($($_.Exception.GetBaseException().Message)).")
      $f.Sent = $true
      throw $f
    }
  } finally {
    if ($stream) { try { $stream.Dispose() } catch {} }
    try { $tcp.Close() } catch {}
  }
  $all = $raw.ToArray()
  $split = Find-Bytes $all ([byte[]](13, 10, 13, 10)) 0
  $status = 0
  if ($split -gt 0) {
    $lines = [Text.Encoding]::ASCII.GetString($all, 0, $split) -split "`r`n"
    if ($lines[0] -match '^HTTP/1\.[01] (\d{3})') { $status = [int]$Matches[1] }
  }
  # The answer started and broke off (or never came): the server got the request and may have acted on it.
  if ($status -eq 0) { throw [ClientFail]::new('unreachable', "The answer from $($ctx.issuer) broke off.") }
  $headers = @{}
  foreach ($line in ($lines | Select-Object -Skip 1)) {
    $at = $line.IndexOf(':')
    if ($at -gt 0) { $headers[$line.Substring(0, $at).Trim().ToLowerInvariant()] = $line.Substring($at + 1).Trim() }
  }
  $rest = New-Object byte[] ($all.Length - $split - 4)
  [Array]::Copy($all, $split + 4, $rest, 0, $rest.Length)
  $bytes = $rest
  if ($headers.ContainsKey('transfer-encoding') -and $headers['transfer-encoding'] -match 'chunked') {
    $bytes = Get-Unchunked $rest
  } elseif ($headers.ContainsKey('content-length')) {
    $length = 0
    if (-not [int]::TryParse($headers['content-length'], [ref]$length) -or $rest.Length -lt $length) { $bytes = $null }
    else { $bytes = New-Object byte[] $length; [Array]::Copy($rest, 0, $bytes, 0, $length) }
  }
  if ($null -eq $bytes) { throw [ClientFail]::new('unreachable', "The answer from $($ctx.issuer) broke off.") }
  $text = $Utf8.GetString($bytes)
  $parsed = $null
  $fields = $null
  # Only strict JSON is read (see Read-JsonText): ConvertFrom-Json alone also reads text that is not JSON. The answer
  # is JSON even when ConvertFrom-Json cannot hold it; its markers come from the strict reader's fields.
  $doc = Read-JsonText $text
  $isJson = $null -ne $doc
  if ($isJson) {
    $fields = $doc.fields
    try { $parsed = $text | ConvertFrom-Json } catch {}
  }
  $challenge = ''
  if ($headers.ContainsKey('www-authenticate')) { $challenge = $headers['www-authenticate'] }
  @{ status = $status; text = $text; bytes = $bytes; json = $parsed; isJson = $isJson; fields = $fields; challenge = $challenge }
}

# One JSON token, after any whitespace: a string, a number or a literal, or a structural character (RFC 8259).
$JsonToken = [regex]'\G[ \t\n\r]*(?:("(?:[^"\\\x00-\x1f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*")|(-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null)|([{}\[\]:,]))'

$JsonEscape = [regex]'\\(?:u([0-9a-fA-F]{4})|(.))'

# A JSON string token as JSON.parse reads it, escapes and all ("busy" is busy).
function ConvertFrom-JsonStringToken([string]$token) {
  $inner = $token.Substring(1, $token.Length - 2)
  if (-not $inner.Contains('\')) { return $inner }
  $JsonEscape.Replace($inner, [Text.RegularExpressions.MatchEvaluator] {
      param($m)
      if ($m.Groups[1].Success) { return [string][char][Convert]::ToInt32($m.Groups[1].Value, 16) }
      switch -CaseSensitive ($m.Groups[2].Value) {
        'b' { "`b" } 'f' { "`f" } 'n' { "`n" } 'r' { "`r" } 't' { "`t" } default { $m.Groups[2].Value }
      }
    })
}

# A top field's value that is neither a string nor true or false (a number, null, an object or an array).
$NotTextOrBool = [DBNull]::Value

# Reads a text that is one complete JSON value with nothing after it but whitespace, as JSON.parse reads it (the Node
# version) and json_scan in the sh version, or returns $null when it is not. ConvertFrom-Json alone also takes single
# quotes, names without quotes, comments, trailing commas, NaN and leading zeros, so a broken answer could read as one
# of the server's refusals. The result holds the top object's own fields (`fields`, empty for any other value): a
# string, $true or $false, or $NotTextOrBool, by their exact keys with escapes read, the last value of a key given
# twice, as JSON.parse reads them. The refusal and failure markers come only from these fields, never from
# ConvertFrom-Json, which matches keys in any case, turns other values into strings, unrolls a top array (PowerShell
# 7) and cannot hold some valid JSON (an empty key, two keys that differ only in case, or in Windows PowerShell a
# number beyond the double range).
function Read-JsonText([string]$text) {
  $stack = New-Object System.Collections.Generic.List[string]
  # Ordinal, so case-sensitive: "Error" is not "error".
  $fields = New-Object 'System.Collections.Generic.Dictionary[string,object]'
  $key = ''
  $state = 'value'
  $at = 0
  while ($true) {
    $m = $JsonToken.Match($text, $at)
    if (-not $m.Success) { break }
    $at += $m.Length
    if ($state -eq 'end') { return $null }
    # Inside the top object itself (not nested deeper).
    $inTop = $stack.Count -eq 1 -and $stack[0] -eq '{'
    if ($m.Groups[1].Success -and ($state -eq 'key' -or $state -eq 'firstKey')) {
      if ($inTop) { $key = ConvertFrom-JsonStringToken $m.Groups[1].Value }
      $state = 'colon'; continue
    }
    $top = ''
    if ($stack.Count) { $top = $stack[$stack.Count - 1] }
    if ($m.Groups[3].Success) {
      $t = $m.Groups[3].Value
      if ($t -eq '{' -or $t -eq '[') {
        if ($state -ne 'value' -and $state -ne 'first') { return $null }
        if ($inTop) { $fields[$key] = $NotTextOrBool }
        $stack.Add($t)
        if ($t -eq '{') { $state = 'firstKey' } else { $state = 'first' }
        continue
      }
      if ($t -eq ':') {
        if ($state -ne 'colon') { return $null }
        $state = 'value'; continue
      }
      if ($t -eq ',') {
        if ($state -ne 'next') { return $null }
        if ($top -eq '{') { $state = 'key' } else { $state = 'value' }
        continue
      }
      # A closing bracket: of an empty container, or after a value in one of its kind.
      $open = '['; $empty = 'first'
      if ($t -eq '}') { $open = '{'; $empty = 'firstKey' }
      if (-not ($state -eq $empty -or ($state -eq 'next' -and $top -eq $open))) { return $null }
      $stack.RemoveAt($stack.Count - 1)
    } elseif ($state -ne 'value' -and $state -ne 'first') { return $null }
    elseif ($inTop) {
      # A string, number or literal as a value of the top object.
      if ($m.Groups[1].Success) { $fields[$key] = ConvertFrom-JsonStringToken $m.Groups[1].Value }
      elseif ($m.Groups[2].Value -ceq 'true') { $fields[$key] = $true }
      elseif ($m.Groups[2].Value -ceq 'false') { $fields[$key] = $false }
      else { $fields[$key] = $NotTextOrBool }
    }
    # A value ended.
    if ($stack.Count) { $state = 'next' } else { $state = 'end' }
  }
  if (-not ($state -eq 'end' -and $text.Substring($at) -match '^[ \t\n\r]*\z')) { return $null }
  @{ fields = $fields }
}

function Test-JsonText([string]$text) { $null -ne (Read-JsonText $text) }

# The top object's string field, by its exact key, or $null (no such field, another type, or no JSON object).
function Get-TopText($r, [string]$name) {
  if ($null -ne $r.fields -and $r.fields.ContainsKey($name) -and $r.fields[$name] -is [string]) { return $r.fields[$name] }
  $null
}

function Invoke-OAuth($ctx, [string]$path, $form) {
  $form['client_id'] = $ClientId
  Invoke-Http $ctx 'POST' "$($ctx.issuer)$path" $form '' $null
}

function Test-Object($value) { $null -ne $value -and $value -is [pscustomobject] }

function Get-Field($r, [string]$name) {
  if ((Test-Object $r.json) -and $r.json.PSObject.Properties[$name]) { return [string]$r.json.$name }
  ''
}

function New-HttpFail($r, [string]$what) {
  $detail = Get-Field $r 'error_description'
  if (-not $detail) { $detail = Get-Field $r 'message' }
  if (-not $detail -and (Test-Object $r.json) -and $r.json.PSObject.Properties['detail'] -and $r.json.detail -is [string]) { $detail = $r.json.detail }
  if (-not $detail) { $detail = Get-Field $r 'error' }
  $msg = "$what failed ($($r.status)"
  if ($detail) { $msg += ": $detail" }
  $f = [ClientFail]::new("http_$($r.status)", "$msg).")
  if ((Test-Object $r.json) -or $r.json -is [array]) { $f.Body = $r.json }
  $f
}

function Get-Tokens($r) {
  $access = Get-Field $r 'access_token'; $refresh = Get-Field $r 'refresh_token'; $scope = Get-Field $r 'scope'
  if ($access -notmatch $Secret -or $refresh -notmatch $Secret -or $scope -notmatch $Plain) {
    Fail 'unexpected_answer' "$Product answered without usable tokens."
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
    try { $r = Invoke-OAuth $ctx $RevokePath ([ordered]@{ token = $token; token_type_hint = 'refresh_token' }); $ok = $r.status -eq 200 } catch {}
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

# The hint names the address, so the wait asks the same server even if the kept address changes meanwhile. Quoted:
# a shell would take the brackets of an IPv6 address as a file pattern.
function Get-Pending($ctx, $rec) {
  [ordered]@{
    status = 'pending'; link = $rec.link; code = $rec.userCode; expiresIn = [Math]::Max([long]0, $rec.deviceExpiresAt - (Now))
    next = "End your turn with a reply that shows the person the link and the code and asks them to reply once they approve. When they reply, run: $Cmd connect --wait --url `"$($ctx.issuer)`""
  }
}

function Clear-Pending($rec) { Merge $rec @{ deviceCode = ''; userCode = ''; link = ''; deviceExpiresAt = [long]0; interval = [long]0; nextPollAt = [long]0 } }

function Invoke-Connect($ctx, [bool]$replace) {
  # Before any code exists: can it keep a connection here, and is the server there?
  Protect-Dir $ctx.dir
  $probe = Join-Path $ctx.dir ".probe-$(Hex 4)"
  try { [IO.File]::Open($probe, [IO.FileMode]::CreateNew).Dispose(); [IO.File]::Delete($probe) } catch {
    Fail 'cannot_save' "Cannot write in $($ctx.dir). Allow this agent to write there."
  }
  $meta = Invoke-Http $ctx 'GET' "$($ctx.issuer)/.well-known/oauth-authorization-server" $null '' $null
  if ($meta.status -ne 200 -or (Get-Field $meta 'issuer') -ne $ctx.issuer) {
    Fail 'unreachable' "$($ctx.issuer) does not answer as $Product with agents allowed ($($meta.status)). Check the address, and ask an administrator to allow agents in $Product's settings."
  }
  $lock = Enter-Lock $ctx
  try {
    $rec = Read-Record $ctx
    if (-not $rec) { $rec = New-Record $ctx }
    $rec = Invoke-RevokePending $ctx $rec
    if ($rec.refreshToken -and -not $replace) {
      Save-Address $ctx
      return Write-Json ([ordered]@{ status = 'already_connected'; label = $rec.label; scope = $rec.scope })
    }
    # The open code again, unless asked for a new one (--replace: the link did not work for the person).
    if ($rec.deviceCode -and ($rec.deviceExpiresAt - (Now)) -gt 30 -and -not $replace) { return Write-Json (Get-Pending $ctx $rec) }
    Assert-Mine $ctx $lock
    $r = Invoke-OAuth $ctx $DevicePath ([ordered]@{ scope = $Scope; resource = "$($ctx.issuer)$Resource"; client_label = $ctx.label })
    if ($r.status -ne 200) { throw (New-HttpFail $r 'Asking to connect') }
    $deviceCode = Get-Field $r 'device_code'; $userCode = Get-Field $r 'user_code'; $link = Get-Field $r 'verification_uri_complete'
    if ($deviceCode -notmatch $Secret -or $userCode -cnotmatch '^[A-Z0-9-]{4,20}\z' -or $link -notmatch $Plain) {
      Fail 'unexpected_answer' "$Product answered without a code."
    }
    if (-not $link.StartsWith("$($ctx.issuer)/")) { Fail 'unexpected_answer' "The approval link is not on $Product." }
    $interval = [long]0; [void][long]::TryParse((Get-Field $r 'interval'), [ref]$interval); if ($interval -le 0) { $interval = $PollSeconds }; $interval = [Math]::Max([long]$PollSeconds, $interval)
    $expires = [long]0; [void][long]::TryParse((Get-Field $r 'expires_in'), [ref]$expires); if ($expires -le 0) { $expires = 600 }
    $rec = Merge $rec @{
      label = $ctx.label; deviceCode = $deviceCode; userCode = $userCode; link = $link
      deviceExpiresAt = (Now) + [Math]::Max([long]60, $expires); interval = $interval; nextPollAt = (Now) + $interval
    }
    Write-Record $ctx $rec
    Write-Json (Get-Pending $ctx $rec)
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
        else { Fail 'not_connected' "No connection is being made. Run: $Cmd connect" }
      } else {
        $t = Now
        if ($rec.deviceExpiresAt + $StaleCodeSeconds -le $t) {
          Write-Record $ctx (Clear-Pending $rec)
          Fail 'expired' "The code expired before it was approved. Run: $Cmd connect"
        }
        if ($rec.nextPollAt -gt $t) { $wait = $rec.nextPollAt - $t }
        else {
          Assert-Mine $ctx $lock
          try {
            $r = Invoke-OAuth $ctx $TokenPath ([ordered]@{ grant_type = 'urn:ietf:params:oauth:grant-type:device_code'; device_code = $rec.deviceCode })
          } catch [ClientFail] {
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
            Remove-Kinds $ctx
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
            Fail 'expired' "The code is no longer valid. Run: $Cmd connect"
          } else { throw (New-HttpFail $r 'Waiting for the approval') }
        }
      }
    } finally { Exit-Lock $ctx $lock }
    if ($done) { Save-Address $ctx; return Write-Json $done }
    if ([DateTime]::UtcNow.AddSeconds($wait) -gt $until) {
      return Write-Json ([ordered]@{ status = 'still_waiting'; next = "Not approved yet. Run again: $Cmd connect --wait --url `"$($ctx.issuer)`"" })
    }
    Start-Sleep -Seconds $wait
  }
}

function Test-Usable($rec) { $rec.accessToken -and ($rec.accessExpiresAt - (Now)) -gt 60 -and -not $rec.refreshStartedAt }

# A live access token: the stored one while it lasts, else one refresh under the lock.
function Get-AccessToken($ctx, [string]$stale) {
  $first = Read-Record $ctx
  if (-not $first -or -not $first.refreshToken) { Fail 'not_connected' "Not connected. Run: $Cmd connect" }
  if (-not $stale -and (Test-Usable $first)) { return $first.accessToken }
  $lock = Enter-Lock $ctx
  try {
    $rec = Read-Record $ctx
    if (-not $rec -or -not $rec.refreshToken) { Fail 'not_connected' "Not connected. Run: $Cmd connect" }
    $rec = Invoke-RevokePending $ctx $rec
    # Another command refreshed while this one waited for the lock.
    if ((Test-Usable $rec) -and $rec.accessToken -ne $stale) { return $rec.accessToken }
    $before = @{ refreshStartedAt = $rec.refreshStartedAt; refreshRetried = $rec.refreshRetried }
    # A refresh that started moments ago may still be on its way (its holder lost the lock): never send it twice.
    if ($rec.refreshStartedAt -and ((Now) - $rec.refreshStartedAt) -lt $RefreshGrace) {
      Fail 'busy' "Another $Cmd command is refreshing this connection. Nothing was sent; run it again."
    }
    if ($rec.refreshStartedAt) {
      # The last refresh got no answer; trying once more either continues the connection or ends it there.
      if ($rec.refreshRetried) { Fail 'connection_ended' "Two refreshes got no answer, so this connection cannot be trusted. Run: $Cmd connect --replace" }
      $rec.refreshRetried = [long]1
    }
    $rec.refreshStartedAt = Now
    Write-Record $ctx $rec
    Assert-Mine $ctx $lock
    Invoke-Hook 'before-refresh'
    try {
      $r = Invoke-OAuth $ctx $TokenPath ([ordered]@{ grant_type = 'refresh_token'; refresh_token = $rec.refreshToken; resource = "$($ctx.issuer)$Resource" })
    } catch [ClientFail] {
      # Nothing left the computer: the token is as good as before.
      if ($_.Exception.Code -eq 'unreachable' -and -not $_.Exception.Sent) { Write-Record $ctx (Merge $rec $before) }
      throw
    }
    if ($r.status -eq 200) {
      $next = Merge (Merge $rec (Get-Tokens $r)) @{ refreshStartedAt = [long]0; refreshRetried = [long]0 }
      Invoke-Hook 'before-write'
      if (-not (Test-Mine $ctx $lock)) {
        # The lock was taken while this one waited for the server: keep the new tokens anyway, under a fresh lock.
        $again = Enter-Lock $ctx $lock
        try { Write-Record $ctx $next } finally { Exit-Lock $ctx $again }
      } else { Write-Record $ctx $next }
      return $next.accessToken
    }
    if ((Get-Field $r 'error') -eq 'invalid_grant') {
      # An old connection still to be ended (after --replace) keeps its place until the server confirms it.
      if ($rec.toRevoke) { Write-Record $ctx (Merge (New-Record $ctx) @{ label = $rec.label; toRevoke = $rec.toRevoke }) }
      else { Remove-Record $ctx }
      Fail 'connection_ended' "This connection has ended (disconnected in $Product, its time ran out, sign-in settings changed, or its token was used twice). Run: $Cmd connect"
    }
    # The server answered with an error before spending the token (a 4xx); a 5xx may have come after.
    if ($r.status -lt 500) { Write-Record $ctx (Merge $rec $before) }
    throw (New-HttpFail $r 'Refreshing the connection')
  } finally { Exit-Lock $ctx $lock }
}

# The full path of a call (with its query) and the URL to send it to: a path under one of $Prefixes, never anywhere
# else, so the token goes only to the API.
function Test-Prefixed([string]$pathOnly) {
  foreach ($x in $Prefixes) { if ($pathOnly.StartsWith($x) -and $pathOnly.Length -gt $x.Length) { return $true } }
  $false
}

function Get-ApiTarget($ctx, [string]$p) {
  $bad = "Give a path from ``$Cmd endpoints``, for example: get '/api/v1/problems?status=open' (percent-encode anything else)"
  if (-not $p) { Fail 'bad_path' $bad }
  # Encoded dots too: a server or proxy that decodes them would take the token out of the API.
  if ($p -notmatch $PathChars -or $p.Contains('://') -or $p.StartsWith('//') -or $p -match '%2e') { Fail 'bad_path' $bad }
  $pathOnly = ($p -split '\?', 2)[0]
  # The kind is found from the path as it is sent, but a server may decode the path before it routes it. So in the
  # path an escape may not stand for a character a route template holds as it is (A-Z a-z 0-9 . _ ~ : -), nor for
  # / \ or % (/api/v1/problems/7%2Fsend would match /api/v1/problems/{id} here and may run /api/v1/problems/{id}/send
  # there), and
  # every % must start an escape. The query keeps any escape.
  if ($pathOnly -match '%(?![0-9a-f]{2})|%(2[5def]|3[0-9a]|4[1-9a-f]|5[0-9acf]|6[1-9a-f]|7[0-9ae])') { Fail 'bad_path' $bad }
  # Some servers drop ;parameters from a segment before they route (/api/v1/problems/export;x runs
  # /api/v1/problems/export).
  # The server's check of the declared kind stops such a call too; this refuses it before it is sent.
  if ($pathOnly.Contains(';')) { Fail 'bad_path' $bad }
  if (-not (Test-Prefixed $pathOnly)) { Fail 'bad_path' $bad }
  foreach ($s in ($pathOnly -split '/')) { if ($s -eq '.' -or $s -eq '..') { Fail 'bad_path' $bad } }
  $u = $null
  if (-not [Uri]::TryCreate("$($ctx.issuer)$p", [UriKind]::Absolute, [ref]$u)) { Fail 'bad_path' $bad }
  if ((Get-Origin $u) -ne $ctx.issuer -or -not (Test-Prefixed $u.AbsolutePath)) { Fail 'bad_path' $bad }
  @{ url = $u.AbsoluteUri; path = $u.AbsolutePath; hasQuery = $p.Contains('?') }
}

# Kinds: whether a call is a read or an act, from the server's own list of this connection's calls, kept with the
# list's revision for the current connection only. Access and the listing itself are reads, exempt from the list.

function Test-Exempt([string]$method, [string]$path) { $method -ceq 'GET' -and ($path -ceq $AccessPath -or $path -ceq $EndpointsPath) }

# The usable part of a listing answer, or $null when it is not a list with a valid revision.
function ConvertTo-KindList($r) {
  # The top level must be an object with these exact keys (ConvertFrom-Json in PowerShell 7 unwraps a top array).
  if ($null -eq (Get-TopText $r 'revision') -or $null -eq $r.fields -or -not $r.fields.ContainsKey('endpoints')) { return $null }
  $data = $r.json
  if (-not (Test-Object $data) -or -not $data.PSObject.Properties['endpoints'] -or -not $data.PSObject.Properties['revision']) { return $null }
  if ($data.endpoints -isnot [array] -or $data.revision -isnot [string] -or $data.revision -cnotmatch $RevisionPattern) { return $null }
  $entries = New-Object System.Collections.Generic.List[object]
  foreach ($e in $data.endpoints) {
    if (-not (Test-Object $e)) { continue }
    $method = ''; $template = ''; $kind = 'act'
    if ($e.PSObject.Properties['method']) { $method = [string]$e.method }
    if ($e.PSObject.Properties['path']) { $template = [string]$e.path }
    # Anything but an explicit read counts as an act.
    if ($e.PSObject.Properties['kind'] -and [string]$e.kind -ceq 'read') { $kind = 'read' }
    if ($method -cmatch '^[A-Z]{3,7}\z' -and $template -cmatch $TemplatePattern) { $entries.Add(@{ method = $method; template = $template; kind = $kind }) }
  }
  @{ revision = [string]$data.revision; entries = $entries }
}

function Read-Kinds($ctx, $rec) {
  if (-not $rec.generation) { return $null }
  try { $text = Read-Shared $ctx.kinds } catch { return $null }
  $lines = $text -split "`r?`n"
  $head = $lines[0] -split ' '
  if ($head.Count -lt 5 -or $head[0] -cne $KindsMagic -or $head[1] -cne $KindsFormat -or $head[2] -cne $rec.generation) { return $null }
  $at = [long]0; [void][long]::TryParse($head[3], [ref]$at)
  if ((Now) - $at -gt $KindsMaxAge) { return $null }
  if ($head[4] -cnotmatch $RevisionPattern) { return $null }
  $entries = New-Object System.Collections.Generic.List[object]
  for ($i = 1; $i -lt $lines.Count; $i++) {
    $f = $lines[$i] -split ' '
    if ($f.Count -eq 3 -and $f[0] -cmatch '^[A-Z]{3,7}\z' -and $f[1] -cmatch $TemplatePattern -and ($f[2] -ceq 'read' -or $f[2] -ceq 'act')) {
      $entries.Add(@{ method = $f[0]; template = $f[1]; kind = $f[2] })
    }
  }
  @{ revision = $head[4]; entries = $entries }
}

# Keeps a list for the connection it was fetched under. Only a cache: a failure changes nothing.
function Save-Kinds($ctx, [string]$generation, $list) {
  try {
    $rec = Read-Record $ctx
    if (-not $generation -or -not $rec -or $rec.generation -cne $generation) { return }
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add("$KindsMagic $KindsFormat $generation $(Now) $($list.revision)")
    foreach ($e in $list.entries) { $lines.Add("$($e.method) $($e.template) $($e.kind)") }
    Write-Private $ctx $ctx.kinds (($lines -join "`n") + "`n")
  } catch {}
}

# The list from the server, kept for this connection. Fails closed: when the listing cannot be read, or its answer
# is not a list, nothing is sent (endpoints_unavailable). Errors of the connection itself are passed on as they are.
function Get-FreshKinds($ctx) {
  $generation = ''
  $rec = Read-Record $ctx
  if ($rec) { $generation = $rec.generation }
  try {
    $r = Send-Api $ctx 'GET' "$($ctx.issuer)$EndpointsPath" $null @{ kind = 'read'; revision = ''; path = $EndpointsPath }
  } catch [ClientFail] {
    if ($_.Exception.Api) { Fail 'endpoints_unavailable' $Unavailable }
    throw
  }
  $list = $null
  if ($r.status -eq 200) { $list = ConvertTo-KindList $r }
  if ($null -eq $list) { Fail 'endpoints_unavailable' $Unavailable }
  Save-Kinds $ctx $generation $list
  $list
}

function Test-TemplateMatch([string]$template, [string]$path) {
  $t = $template -split '/'
  $s = $path -split '/'
  for ($i = 0; $i -lt $t.Count; $i++) {
    if ($t[$i] -match '^\{[^}]*:path\}$') {
      return ($i -eq $t.Count - 1 -and $s.Count -gt $i -and (($s[$i..($s.Count - 1)]) -join '') -ne '')
    }
    if ($i -ge $s.Count) { return $false }
    if ($t[$i] -match '^\{[^}]*\}$') { if ($s[$i] -eq '') { return $false } }
    elseif ($t[$i] -cne $s[$i]) { return $false }
  }
  $t.Count -eq $s.Count
}

# 'read', 'act', 'both' (a read and an act both match the path, such as /api/v1/problems/export and
# /api/v1/problems/{id}), or
# $null when the list does not hold the call.
function Find-Kind($list, [string]$method, [string]$path) {
  $read = $false; $act = $false
  foreach ($e in $list.entries) {
    if ($e.method -ceq $method -and (Test-TemplateMatch $e.template $path)) { if ($e.kind -ceq 'act') { $act = $true } else { $read = $true } }
  }
  if ($read -and $act) { return 'both' }
  if ($act) { return 'act' }
  if ($read) { return 'read' }
  $null
}

# How a call is sent: its kind, and the revision of the list it was classified with. A path the list does not hold is
# not sent (bad_path), after the list was fetched again in case it changed. A path that a read and an act both match
# goes as an act first (both: Send-Api may send it once more as a read).
function Get-CallPlan($ctx, [string]$method, [string]$path) {
  if (Test-Exempt $method $path) { return @{ kind = 'read'; revision = ''; path = $path; both = $false } }
  $rec = Read-Record $ctx
  $list = $null
  if ($rec -and $rec.refreshToken) { $list = Read-Kinds $ctx $rec }
  $fresh = $false
  while ($true) {
    if ($null -eq $list) { $list = Get-FreshKinds $ctx; $fresh = $true }
    $kind = Find-Kind $list $method $path
    if ($kind -eq 'both') { return @{ kind = 'act'; revision = $list.revision; path = $path; both = $true } }
    if ($kind) { return @{ kind = $kind; revision = $list.revision; path = $path; both = $false } }
    if ($fresh) { Fail 'bad_path' $NotListed }
    $list = $null
  }
}

# The three refusals the server makes before any route code runs. Nothing ran, so the call may go again. The markers
# are read as JSON.parse reads them: the top object's exact key error with a string value (Get-TopText).
function Test-TokenRefused($r) { $r.status -eq 401 -and $r.challenge.Contains('error="invalid_token"') }
function Test-BusyRefused($r) { $r.status -eq 429 -and (Get-TopText $r 'error') -ceq 'busy' }
function Test-PolicyRefused($r) { $r.status -eq 409 -and (Get-TopText $r 'error') -ceq 'policy_changed' }

# One API call with its retries, each at most once: after a 401 with the invalid_token challenge, a refresh and the
# call again; after a 429 busy, a wait and the call again; after a 409 policy_changed, the list again and the call
# again under its new kind. A path that a read and an act both match went as an act; when the list read again still
# has both for it, it goes once more as a read (the router picked the read route). Every one of these follows a
# refusal made before any route code ran. Any other answer is the answer. For a read, one retry after a network
# failure; an act is never sent again once it may have reached the server.
function Send-Api($ctx, [string]$method, [string]$url, $json, $call) {
  $token = Get-AccessToken $ctx ''
  $refreshed = $false; $busyRetried = $false; $netRetried = $false; $policyRetried = $false
  while ($true) {
    try { $r = Invoke-Http $ctx $method $url $null $token $json $call.revision $call.kind } catch [ClientFail] {
      $e = $_.Exception
      if ($e.Code -ne 'unreachable') { throw }
      $e.Api = $true
      if ($call.kind -eq 'act') {
        if (-not $e.Sent) { throw }
        Fail 'outcome_unknown' $UnknownOutcome
      }
      if ($netRetried) { throw }
      $netRetried = $true
      continue
    }
    if ((Test-TokenRefused $r) -and -not $refreshed) { $refreshed = $true; $token = Get-AccessToken $ctx $token; continue }
    if ((Test-BusyRefused $r) -and -not $busyRetried) {
      $busyRetried = $true
      Start-Sleep -Milliseconds $BusyWaitMs
      continue
    }
    if ($call.revision -and (Test-PolicyRefused $r)) {
      if ($policyRetried) { $f = [ClientFail]::new('policy_changed', $PolicyChanged); $f.Status = $r.status; throw $f }
      $policyRetried = $true
      $list = Get-FreshKinds $ctx
      $kind = Find-Kind $list $method $call.path
      if (-not $kind) { Fail 'bad_path' $NotListed }
      if ($kind -eq 'both') { if ($call.both) { $kind = 'read' } else { $kind = 'act' } }
      $call.kind = $kind
      $call.revision = $list.revision
      continue
    }
    if ($call.kind -eq 'act' -and $r.status -ge 500) {
      $f = [ClientFail]::new('outcome_unknown', $UnknownOutcome); $f.Status = $r.status; throw $f
    }
    return $r
  }
}

# The answer as JSON text on one line: a JSON answer as it is (its line breaks are only spacing), text as a string.
function Get-DataText($r) {
  if ($r.isJson) { return ($r.text -replace "[`r`n]", '').Trim() }
  ConvertTo-JsonString $r.text
}

# Whether an answer says it failed: its top object's own "success": false, or "status": "error", by their exact keys.
function Test-FailedAnswer($r) {
  if ($null -eq $r.fields) { return $false }
  if ($r.fields.ContainsKey('success') -and $r.fields['success'] -is [bool] -and -not $r.fields['success']) { return $true }
  (Get-TopText $r 'status') -ceq 'error'
}

function Invoke-Api($ctx, [string]$method, [string]$p, $json) {
  $target = Get-ApiTarget $ctx $p
  if ($null -ne $json -and -not (Test-JsonText $json)) { Fail 'bad_body' 'The body is not JSON.' }
  $listing = $method -ceq 'GET' -and $target.path -ceq $EndpointsPath -and -not $target.hasQuery
  $generation = ''
  if ($listing) { $rec = Read-Record $ctx; if ($rec) { $generation = $rec.generation } }
  $call = Get-CallPlan $ctx $method $target.path
  $r = Send-Api $ctx $method $target.url $json $call
  if ($r.status -ge 200 -and $r.status -lt 300) {
    if ($listing) { $list = ConvertTo-KindList $r; if ($null -ne $list) { Save-Kinds $ctx $generation $list } }
    $data = Get-DataText $r
    if (Test-FailedAnswer $r) {
      Write-Line ('{"error":"failed","message":' + (ConvertTo-JsonString "$method $p answered that it failed.") + ',"status":' + $r.status + ',"data":' + $data + '}')
      $script:ExitCode = 1
      return
    }
    Write-Line ('{"status":' + $r.status + ',"data":' + $data + '}')
    return
  }
  # Exact keys and string values, read from the document's structure, as the other versions read them.
  $code = Get-TopText $r 'error'; $message = Get-TopText $r 'message'
  # A connection the person did not allow to ask for instance access: it needs a new approval to get it.
  if ($r.status -eq 403 -and $code -ceq 'not_allowed') {
    $f = [ClientFail]::new('insufficient_scope', $NoAccessScope); $f.Status = $r.status; throw $f
  }
  # The server's own refusals for agents carry a code and a message: passed on as they are.
  if ($code -cmatch '^[a-z_]{1,40}\z' -and $null -ne $message) {
    $f = [ClientFail]::new($code, $message); $f.Status = $r.status; throw $f
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
      try { $r = Invoke-OAuth $ctx $RevokePath ([ordered]@{ token = $token; token_type_hint = 'refresh_token' }); $ok = $r.status -eq 200 } catch {}
      if (-not $ok) { $left += $token }
    }
    if ($left.Count) {
      Write-Record $ctx (Merge $rec @{ refreshToken = ''; accessToken = ''; accessExpiresAt = [long]0; toRevoke = ($left -join ' ') })
      Fail 'disconnect_failed' "$Product did not confirm the disconnect. Run it again, or end the connection in $Product."
    }
    Remove-Record $ctx
    Write-Json ([ordered]@{ status = 'disconnected' })
  } finally { Exit-Lock $ctx $lock }
}

function Get-Body($o, $fallback) {
  $body = $o.json
  # The file as it is, as the other versions read it: ReadAllText would drop a byte order mark, which is not JSON.
  if ($null -ne $o.jsonFile) { try { $body = $Utf8.GetString([IO.File]::ReadAllBytes($o.jsonFile)) } catch { Fail 'bad_body' "Cannot read $($o.jsonFile)." } }
  if ($null -eq $body) { $body = $fallback }
  $body
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
  switch -CaseSensitive ($command) {
    'status' { Show-Status $ctx }
    'connect' { if ($o.wait) { Invoke-Wait $ctx } else { Invoke-Connect $ctx $o.replace } }
    'access' { Invoke-Api $ctx 'GET' $AccessPath $null }
    'endpoints' {
      if ($null -eq $first) { Invoke-Api $ctx 'GET' $EndpointsPath $null }
      elseif ($first -cnotmatch '^[a-z_]{1,40}\z') { Fail 'bad_path' 'Give an area name, for example: read' }
      else { Invoke-Api $ctx 'GET' "$($EndpointsPath)?area=$first" $null }
    }
    'get' { Invoke-Api $ctx 'GET' $first $null }
    'post' { Invoke-Api $ctx 'POST' $first (Get-Body $o '{}') }
    'disconnect' { Invoke-Disconnect $ctx }
    default { Fail 'unknown_command' "Unknown command `"$command`". Run: $Cmd help" }
  }
}

$script:ExitCode = 0
try {
  Invoke-Main $args
  exit $script:ExitCode
} catch {
  $e = $_.Exception
  if ($e -is [ClientFail]) {
    $out = [ordered]@{ error = $e.Code; message = $e.Message }
    if ($e.Status) { $out.status = $e.Status }
    if ($null -ne $e.Body) { $out.body = $e.Body }
    Write-Json $out
  } else {
    Write-Json ([ordered]@{ error = 'failed'; message = $e.Message })
  }
  exit 1
}
