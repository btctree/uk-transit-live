# Keeps the Oracle A1 capacity hunter alive.
# Run every few minutes by the scheduled task "UKTransit-A1-Hunter":
# if the hunter is not running (and has not already won), start it.
$base = "C:\Users\user\OneDrive\Desktop\UK Transit\uk_transit_live\deploy"
$log  = Join-Path $base "hunter.log"

# Already succeeded? Stop relaunching — the VM exists.
if ((Test-Path $log) -and (Select-String -Path $log -Pattern 'RESULT_PUBLIC_IP' -Quiet)) { exit 0 }

$running = Get-CimInstance Win32_Process -Filter "Name like 'py%'" |
           Where-Object { $_.CommandLine -match 'oci_launch' }
if ($running) { exit 0 }

$cmd = "cmd.exe /c py `"$base\oci_launch.py`" >> `"$log`" 2>&1"
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$cmd} | Out-Null
