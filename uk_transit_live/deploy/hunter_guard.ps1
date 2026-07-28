# Keeps the Oracle A1 capacity hunter alive - silently.
# Run every 5 minutes by the scheduled task "UKTransit-A1-Hunter":
# if the hunter is not running (and has not already won), start it hidden.
#
# Why hunter_run.cmd + Start-Process instead of Win32_Process.Create:
# Win32_Process.Create has no way to hide the window, so every relaunch popped
# a visible cmd console on the desktop - and closing that window killed the
# hunt, which the guard then restarted five minutes later, forever.
# Start-Process -WindowStyle Hidden creates the console with SW_HIDE instead.
#
# ASCII only: Windows PowerShell 5.1 reads a BOM-less UTF-8 script as ANSI,
# which turns non-ASCII punctuation into stray quote characters and breaks
# parsing (the task then exits 1 and the hunt silently never starts).
#
# Path-independent: everything resolves next to this script, so the project
# folder can be moved without editing anything here - only the scheduled
# task's -File argument needs re-pointing.
$base  = $PSScriptRoot
$log   = Join-Path $base "hunter.log"
$guard = Join-Path $base "guard.log"

function note($msg) {
    "{0} {1}" -f (Get-Date -Format 'MM-dd HH:mm:ss'), $msg |
        Add-Content -Path $guard -Encoding utf8
}

# Already succeeded? Stop relaunching - the VM exists - and leave a marker on
# the Desktop, so the win is visible even if nobody is watching the log.
$win = $null
if (Test-Path $log) {
    $hit = Select-String -Path $log -Pattern 'RESULT_PUBLIC_IP=(\S+)' |
           Select-Object -Last 1
    if ($hit) { $win = $hit.Matches[0].Groups[1].Value }
}
if ($win) {
    $marker = Join-Path ([Environment]::GetFolderPath('Desktop')) `
                        'UK Transit VM READY.txt'
    if (Test-Path $marker) {
        note "won already - standing down"
    } else {
        @("Oracle Always Free A1 instance is UP.",
          "",
          "Public IP: $win",
          "",
          "Deploy from Git Bash:",
          "  bash ""$base\push_to_vm.sh"" $win",
          "",
          "Then open:  http://${win}:8620") |
            Set-Content -Path $marker -Encoding utf8
        note "WON: $win - marker written to Desktop"
    }
    exit 0
}

# Hunter (py.exe/python.exe) or its cmd wrapper still alive? Leave it alone.
$filter = "Name like 'py%' or Name like 'python%' or Name='cmd.exe'"
$running = @(Get-CimInstance Win32_Process -Filter $filter -ErrorAction SilentlyContinue |
             Where-Object { $_.CommandLine -match 'oci_launch|hunter_run' })
if ($running.Count) {
    note ("alive: " + (($running |
        ForEach-Object { "$($_.Name)/$($_.ProcessId)" }) -join ' '))
    exit 0
}

try {
    Start-Process -FilePath (Join-Path $base 'hunter_run.cmd') `
                  -WindowStyle Hidden -ErrorAction Stop
    note "started hidden"
} catch {
    note ("start FAILED: " + $_.Exception.Message)
}
