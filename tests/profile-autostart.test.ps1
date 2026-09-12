param([string]$Helper,[string]$FixtureExe)
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null;$null=[Management.Automation.Language.Parser]::ParseFile($Helper,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'syntax'}
$text=Get-Content -LiteralPath $Helper -Raw
# Load only helper definitions, never its real Task Scheduler entry point.
. ([ScriptBlock]::Create($text.Substring(0,$text.IndexOf("if(`$Mode -eq 'Describe')"))))
$script:sid='S-1-5-21-1-2-3-1001';$owner='test-owned-profile';$expectedArgs='--data-dir "synthetic" --hidden'
$action=[pscustomobject]@{Type=0;Path=$FixtureExe;Arguments=$expectedArgs}
$actions=[pscustomobject]@{Count=1;action=$action};$actions|Add-Member ScriptMethod Item {param($index) return $this.action}
$principal=[pscustomobject]@{UserId=$script:sid;LogonType=3}
$definition=[pscustomobject]@{RegistrationInfo=[pscustomobject]@{Description=$owner};Actions=$actions;Principal=$principal}
$task=[pscustomobject]@{Definition=$definition}
if(-not (Is-Owned $task)){throw 'valid'}
$definition.RegistrationInfo.Description='foreign';if(Is-Owned $task){throw 'foreign-description'};$definition.RegistrationInfo.Description=$owner
$action.Arguments='--hidden';if(Is-Owned $task){throw 'foreign-profile'};$action.Arguments=$expectedArgs
$principal.UserId='S-1-5-21-1-2-3-1002';if(Is-Owned $task){throw 'foreign-user'};$principal.UserId=$script:sid
$action.Path=Join-Path ([IO.Path]::GetDirectoryName($FixtureExe)) 'other.exe';if(Is-Owned $task){throw 'wrong-exe'}
if($text -match 'CurrentUser.OpenSubKey|CurrentUser.CreateSubKey|Senge.QuotaMonitor.Autostart'){throw 'legacy-access'}
'{"syntax":true,"ownership":true,"legacyUntouched":true}'
