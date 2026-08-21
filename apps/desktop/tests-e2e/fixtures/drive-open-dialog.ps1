# S12 helper: drive the official Windows folder picker (IFileOpenDialog) that
# the DSH host's native directory-picker backend raises on the operator's
# desktop. Production code has zero test hooks — this script is UI automation
# against the OS dialog itself (UIAutomation), used only by the packaged
# acceptance suite.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File drive-open-dialog.ps1 -Path "C:\dir"
#   powershell -NoProfile -ExecutionPolicy Bypass -File drive-open-dialog.ps1 -Cancel
# Exit codes: 0 = dialog driven; 1 = dialog not found; 2 = action button not found.
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
    if ($name -match 'Select Workspace Directory|选择一个文件夹|Select Folder|选择文件夹') { break }
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
if ($edit -ne $null) {
  $valuePattern = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  $valuePattern.SetValue($Path)
  Start-Sleep -Milliseconds 400
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
