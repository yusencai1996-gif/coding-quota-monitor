[CmdletBinding()]
param(
  [ValidateSet('Describe','Inspect','Enable','Disable','Reconcile')][string]$Mode='Describe',
  [string]$ExecutablePath,
  [string]$DataRoot,
  [switch]$DesiredEnabled,
  [switch]$WasManaged
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$taskName='';$owner='';$expectedArgs=''
function Hash-Text([string]$Text){$sha=[Security.Cryptography.SHA256]::Create();try{return -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))|ForEach-Object{$_.ToString('x2')})}finally{$sha.Dispose()}}
function Check-Path([string]$Path){$p=[IO.Path]::GetFullPath($Path);while($p){if(Test-Path -LiteralPath $p){$item=Get-Item -LiteralPath $p -Force;if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'redirect'}};$parent=[IO.Path]::GetDirectoryName($p);if($parent -eq $p){break};$p=$parent}}
function Is-ProjectExe([string]$Path){try{Check-Path $Path;$leaf=(-join [char[]]@(0x591A,0x6A21,0x578B,0x989D,0x5EA6,0x76D1,0x63A7,0x53F0))+'.exe';if([IO.Path]::GetFileName($Path) -ne $leaf){return $false};$marker=Join-Path ([IO.Path]::GetDirectoryName($Path)) 'resources/product.json';$product=Get-Content -LiteralPath $marker -Raw|ConvertFrom-Json;return [IO.File]::Exists($Path) -and $product.product -eq 'quota-monitor-portable-v1'}catch{return $false}}
function Sid-Of([string]$Value) {
  try { return ([Security.Principal.SecurityIdentifier]::new($Value)).Value } catch {}
  try { return ([Security.Principal.NTAccount]::new($Value)).Translate([Security.Principal.SecurityIdentifier]).Value } catch { return '' }
}
function Get-TaskOrNull {
  try { return $script:folder.GetTask($taskName) } catch {
    $cause=$_.Exception
    while($cause){if($cause.HResult -eq -2147024894){return $null};$cause=$cause.InnerException}
    throw
  }
}
function Is-Owned($Task) {
  if($null -eq $Task){return $false}
  $d=$Task.Definition
  return $d.RegistrationInfo.Description -eq $owner -and $d.Actions.Count -eq 1 -and $d.Actions.Item(1).Type -eq 0 -and
    (Is-ProjectExe $d.Actions.Item(1).Path) -and $d.Actions.Item(1).Arguments -eq $expectedArgs -and
    (Sid-Of $d.Principal.UserId) -eq $script:sid -and $d.Principal.LogonType -eq 3
}
function Task-State($Task) {
  $owned=Is-Owned $Task
  $matches=$false
  if($owned -and $Task.Definition.Triggers.Count -eq 1){
    $d=$Task.Definition;$t=$d.Triggers.Item(1);$s=$d.Settings
    $matches=$d.Principal.RunLevel -eq 0 -and $t.Type -eq 9 -and (Sid-Of $t.UserId) -eq $script:sid -and $t.Delay -eq 'PT20S' -and
      $d.Actions.Item(1).WorkingDirectory -ieq [IO.Path]::GetDirectoryName($ExecutablePath) -and
      $s.ExecutionTimeLimit -eq 'PT0S' -and $s.RestartCount -eq 3 -and $s.RestartInterval -eq 'PT1M' -and $s.MultipleInstances -eq 2 -and
      -not $s.RunOnlyIfIdle -and -not $s.RunOnlyIfNetworkAvailable -and -not $s.DisallowStartIfOnBatteries -and -not $s.StopIfGoingOnBatteries
  }
  return @{exists=($null -ne $Task);owned=$owned;enabled=($owned -and $Task.Enabled);triggerEnabled=($owned -and $Task.Definition.Triggers.Count -eq 1 -and $Task.Definition.Triggers.Item(1).Enabled);definitionMatches=$matches;actionMatches=($owned -and $Task.Definition.Actions.Item(1).Path -ieq $ExecutablePath);legacyExists=$false;legacyOwned=$false;legacyDisabled=$false;taskName=$taskName}
}
function Register-Desired([bool]$Enabled) {
  $d=$script:service.NewTask(0)
  $d.RegistrationInfo.Description=$owner
  $d.Principal.UserId=$script:sid;$d.Principal.LogonType=3;$d.Principal.RunLevel=0
  $t=$d.Triggers.Create(9);$t.UserId=$script:sid;$t.Delay='PT20S';$t.Enabled=$true
  $a=$d.Actions.Create(0);$a.Path=$ExecutablePath;$a.Arguments=$expectedArgs;$a.WorkingDirectory=[IO.Path]::GetDirectoryName($ExecutablePath)
  $d.Settings.Enabled=$Enabled;$d.Settings.AllowDemandStart=$true;$d.Settings.StartWhenAvailable=$true
  $d.Settings.DisallowStartIfOnBatteries=$false;$d.Settings.StopIfGoingOnBatteries=$false
  $d.Settings.RunOnlyIfIdle=$false;$d.Settings.RunOnlyIfNetworkAvailable=$false
  $d.Settings.ExecutionTimeLimit='PT0S';$d.Settings.RestartCount=3;$d.Settings.RestartInterval='PT1M';$d.Settings.MultipleInstances=2
  $null=$script:folder.RegisterTaskDefinition($taskName,$d,6,$script:sid,$null,3,$null)
}
if($Mode -eq 'Describe') {@{ok=$true;namespace='Senge.QuotaMonitor.Portable';profileScoped=$true;legacyAccess=$false;delay='PT20S';restartCount=3;runLevel='Limited'}|ConvertTo-Json -Compress;exit 0}
$mutex=$null;$locked=$false;$changed=$false;$beforeTask=$null;$beforeXml=$null;$beforeLegacy=$null
try {
  $script:sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if(-not [IO.Path]::IsPathRooted($DataRoot) -or $DataRoot -match '["\r\n]'){throw 'data-path'}
  $DataRoot=[IO.Path]::GetFullPath($DataRoot);if($DataRoot.Length -gt 3){$DataRoot=$DataRoot.TrimEnd('\')};Check-Path $DataRoot
  $ownerHash=Hash-Text $script:sid;$id=Hash-Text ('quota-monitor-portable-v1'+[char]0+$script:sid+[char]0+$DataRoot.ToLowerInvariant())
  $profilePath=Join-Path (Join-Path (Join-Path $DataRoot 'users') $ownerHash.Substring(0,24)) 'profile.json';Check-Path $profilePath
  $profile=Get-Content -LiteralPath $profilePath -Raw|ConvertFrom-Json
  if($profile.product -ne 'quota-monitor-portable-v1' -or $profile.owner -ne $ownerHash -or $profile.schema -ne 1 -or $profile.id -notmatch '^[a-f0-9-]{36}$'){throw 'profile-owner'}
  $taskName='Senge.QuotaMonitor.Portable.'+$id.Substring(0,24);$owner='quota-monitor-portable-v1:'+$profile.id+':'+$id
  $expectedArgs='--data-dir "'+$DataRoot+'" --hidden'
  if(-not (Is-ProjectExe $ExecutablePath)){throw 'invalid-path'}
  $ExecutablePath=[IO.Path]::GetFullPath($ExecutablePath)
  if($Mode -in @('Enable','Reconcile') -and -not [IO.File]::Exists($ExecutablePath)){throw 'missing-executable'}
  $script:sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $mutex=[Threading.Mutex]::new($false,('Local\'+$taskName))
  $locked=$mutex.WaitOne(10000);if(-not $locked){throw 'busy'}
  $script:service=New-Object -ComObject 'Schedule.Service';$script:service.Connect();$script:folder=$script:service.GetFolder('\')
  $beforeTask=Get-TaskOrNull
  if(($null -ne $beforeTask -and -not (Is-Owned $beforeTask))){
    @{ok=$false;status='conflict';rollback='not-needed';state=(Task-State $beforeTask)} | ConvertTo-Json -Compress -Depth 5;exit 2
  }
  if($Mode -eq 'Inspect'){@{ok=$true;status='inspected';state=(Task-State $beforeTask)} | ConvertTo-Json -Compress -Depth 5;exit 0}
  if($beforeTask){$beforeXml=$beforeTask.Xml}
  $status='updated';$want=$Mode -eq 'Enable' -or ($Mode -eq 'Reconcile' -and $DesiredEnabled)
  # Reconciliation may update an enabled owned action, but cannot undo an OS disable/removal.
  if($Mode -eq 'Reconcile' -and $want){
    if(($beforeTask -and (-not $beforeTask.Enabled -or $beforeTask.Definition.Triggers.Count -ne 1 -or -not $beforeTask.Definition.Triggers.Item(1).Enabled))){$want=$false;$status='preserved-disabled'}
    elseif(-not $beforeTask -and $WasManaged){$want=$false;$status='preserved-removed'}
  }
  $changed=$true
  if($want){$oldState=Task-State $beforeTask;if($oldState.enabled -and $oldState.triggerEnabled -and $oldState.definitionMatches -and $oldState.actionMatches){$status='unchanged'}else{Register-Desired $true}}
  elseif($beforeTask){$beforeTask.Enabled=$false}
  $after=Get-TaskOrNull;$state=Task-State $after
  if($state.legacyExists -or ($want -and (-not $state.owned -or -not $state.enabled -or -not $state.triggerEnabled -or -not $state.definitionMatches -or -not $state.actionMatches)) -or (-not $want -and $state.enabled)){throw 'verification-failed'}
  @{ok=$true;status=$status;rollback='not-needed';state=$state} | ConvertTo-Json -Compress -Depth 5
} catch {
  $rollback='not-needed'
  if($changed){try{
    $current=Get-TaskOrNull
    if($current -and -not (Is-Owned $current)){throw 'ownership-changed'}
    if($beforeXml){$null=$script:folder.RegisterTask($taskName,$beforeXml,6,$script:sid,$null,3,$null)}elseif($current){$script:folder.DeleteTask($taskName,0)}
    $rollback='complete'
  }catch{$rollback='failed'}}
  @{ok=$false;status='failed';rollback=$rollback} | ConvertTo-Json -Compress
  exit 1
} finally {if($locked){$mutex.ReleaseMutex()};if($mutex){$mutex.Dispose()}}
