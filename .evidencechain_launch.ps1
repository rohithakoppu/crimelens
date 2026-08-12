<#
  Launches ScriptPath in a new visible cmd.exe /k window and writes the
  REAL process id of that window to PidFile.

  Why this exists instead of "start Title cmd /k script.cmd" + tasklist
  lookup: Windows cmd windows launched that way don't reliably keep the
  title "start" gave them (cmd.exe appends the script path to it, and a
  child process like Vite can overwrite the title again after it starts),
  so tasklist /FI "WINDOWTITLE eq ..." can silently fail to find the
  window afterwards. Start-Process -PassThru instead hands back the exact
  process id straight from Windows' own CreateProcess call -- no
  string-matching involved, so it can't drift out of sync with reality.
#>
param(
    [Parameter(Mandatory = $true)][string]$ScriptPath,
    [Parameter(Mandatory = $true)][string]$PidFile
)

$proc = Start-Process -FilePath "cmd.exe" -ArgumentList @("/k", $ScriptPath) -PassThru
Set-Content -Path $PidFile -Value $proc.Id -Encoding ascii
Write-Output $proc.Id
