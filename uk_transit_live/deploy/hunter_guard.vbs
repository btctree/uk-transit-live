' Zero-flash launcher for hunter_guard.ps1.
'
' Task Scheduler runs this with wscript.exe, which is a GUI-subsystem host:
' no console is allocated for it, so nothing can appear on the desktop.
' It then starts PowerShell with SW_HIDE (the 0 below) from the very first
' instruction, so that console is created hidden rather than shown-then-hidden.
'
' Why this is needed: "powershell.exe -WindowStyle Hidden" still flashes.
' Task Scheduler creates the process with the default show state, PowerShell
' only hides its window after the host has started, and the gap is visible as
' a black window blinking once every scheduled run.
Option Explicit

Dim shell, fso, here, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & _
      here & "\hunter_guard.ps1"""

shell.Run cmd, 0, False    ' 0 = hidden, False = do not wait
