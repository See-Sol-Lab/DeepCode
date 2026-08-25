# S12 helper: drive the official Windows folder picker (IFileOpenDialog) that
# the DSH host's native directory-picker backend raises on the operator's
# desktop. Production code has zero test hooks — this script is UI automation
# against the OS dialog itself (UIAutomation), used only by the packaged
# acceptance suite.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File drive-open-dialog.ps1 -Path "C:\dir"
#   powershell -NoProfile -ExecutionPolicy Bypass -File drive-open-dialog.ps1 -Cancel
# Exit codes: 0 = dialog driven; 1 = dialog not found; 2 = action button not
#   found; 3 = path edit box not found; 4 = edit box did not take the path.
param(
  [string]$Path = '',
  [switch]$Cancel
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$dialogClass = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ClassNameProperty, '#32770')

$deadline = (Get-Date).AddSeconds(40)
$dialog = $null
while ((Get-Date) -lt $deadline) {
  $dialog = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $dialogClass)
  if ($dialog -ne $null) {
    $name = $dialog.Current.Name
    # Accept both the Chinese and English folder-picker titles. The DSH host
    # sets its own dialog title ("Select Workspace Directory"): the generic
    # localized names below would miss it (measured on a packaged run), so the
    # host's title is the primary match and the generic ones stay as fallbacks.
    # NOTE: keep this file's non-ASCII text inside string literals only, and
    # keep the file UTF-8 WITH BOM - PowerShell 5.1 decodes BOM-less UTF-8 as
    # ANSI and non-ASCII comment bytes swallow the following lines.
    if ($name -match 'Select Workspace Directory|选择工作区目录|选择一个文件夹|Select Folder|选择文件夹') { break }
    $dialog = $null
  }
  Start-Sleep -Milliseconds 250
}
if ($dialog -eq $null) {
  Write-Error 'folder picker dialog not found'
  exit 1
}

if ($Cancel) {
  $button = $null
  foreach ($candidate in @('取消', 'Cancel')) {
    $cond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::NameProperty, $candidate)
    $button = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
    if ($button -ne $null) { break }
  }
  if ($button -eq $null) {
    Write-Error 'cancel button not found in folder picker'
    exit 2
  }
  $invoke = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $invoke.Invoke()
  Write-Output 'folder picker cancelled'
  exit 0
}

# The file-name edit box (traditional control id 1148) accepts a full path.
$editId = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1148')
$edit = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editId)
# A missing edit box used to be skipped silently: the script would then click
# "Select Folder" on whatever directory the dialog happened to be showing and
# still report success ("folder picker driven", exit 0) for a pick that never
# went to the requested path. Fail loudly instead - a green signal has to mean
# the real thing, or the suite spends its time chasing the wrong end.
# 1148 is the classic Win32 common-dialog control id. The modern IFileDialog
# folder picker does not always carry it, so fall back to the first descendant
# Edit that actually supports ValuePattern (measured: exit 3 on a packaged run
# with the id-only lookup).
if ($edit -eq $null) {
  $editType = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Edit)
  $candidates = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editType)
  foreach ($candidate in $candidates) {
    try {
      $null = $candidate.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      $edit = $candidate
      break
    } catch {
      continue
    }
  }
}
if ($edit -eq $null) {
  # Dump what the dialog actually contains: without it the next run only
  # repeats "not found" and we are back to guessing.
  Write-Output '--- dialog dump (controlType | automationId | name) ---'
  $all = $dialog.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition)
  $shown = 0
  foreach ($node in $all) {
    if ($shown -ge 40) { break }
    Write-Output ("  {0} | {1} | {2}" -f `
      $node.Current.ControlType.ProgrammaticName, $node.Current.AutomationId, $node.Current.Name)
    $shown = $shown + 1
  }
  Write-Error 'file-name edit box not found in folder picker'
  exit 3
}
$valuePattern = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
$valuePattern.SetValue($Path)
Start-Sleep -Milliseconds 400
# Confirm the value actually landed: SetValue can be accepted by the pattern
# and still be reverted by the dialog (measured on some shells).
$actual = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
if ($actual -ne $Path) {
  Write-Error "edit box did not take the path (wanted '$Path', got '$actual')"
  exit 4
}

# Invoke the open button by its localized name.
$button = $null
foreach ($candidate in @('选择文件夹', '选择一个文件夹', 'Select Folder')) {
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, $candidate)
  $button = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
  if ($button -ne $null) { break }
}
if ($button -eq $null) {
  Write-Error 'open button not found in folder picker'
  exit 2
}
$invoke = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
$invoke.Invoke()
Write-Output 'folder picker driven'
exit 0
