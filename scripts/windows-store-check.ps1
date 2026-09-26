# Checks the Microsoft Store package on a machine that can be thrown away, such as a CI runner: signs a --test build
# with a throwaway certificate, trusts that certificate machine-wide, installs the package, starts JConnect the way
# Start does, and checks that it runs from the package and answers on its port. Then it runs Microsoft's Windows App
# Certification Kit, which runs the checks Partner Center does. Needs administrator rights.
#   powershell -File scripts/windows-store-check.ps1 <package.appx> [log folder]
param(
  [Parameter(Mandatory = $true)][string]$Package,
  [string]$Logs = 'ci-logs'
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Logs | Out-Null
$Logs = (Resolve-Path $Logs).Path
$Package = (Resolve-Path $Package).Path
function Log($text) { $line = "[$((Get-Date).ToString('HH:mm:ss'))] $text"; Write-Host $line; Add-Content -Path "$Logs\store-check.log" -Value $line }

$kit = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\10.*\x64\signtool.exe" | Sort-Object FullName | Select-Object -Last 1
Log "signtool: $($kit.FullName)"

# The certificate's subject has to match the package's Publisher, which --test sets to CN=JConnect Test.
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=JConnect Test' -CertStoreLocation Cert:\CurrentUser\My `
  -TextExtension @('2.5.29.19={text}') -NotAfter (Get-Date).AddDays(2)
$password = ConvertTo-SecureString -String ([guid]::NewGuid().ToString()) -Force -AsPlainText
$pfx = Join-Path $env:RUNNER_TEMP 'store-test.pfx'
Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $password | Out-Null
Export-Certificate -Cert $cert -FilePath (Join-Path $env:RUNNER_TEMP 'store-test.cer') | Out-Null
Import-Certificate -FilePath (Join-Path $env:RUNNER_TEMP 'store-test.cer') -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($password))
& $kit.FullName sign /fd SHA256 /f $pfx /p $plain $Package 2>&1 | Tee-Object -FilePath "$Logs\store-sign.log"
if ($LASTEXITCODE -ne 0) { throw "signtool failed with $LASTEXITCODE" }

Add-AppxPackage -Path $Package
$app = Get-AppxPackage -Name 'JConnect.Test'
if (-not $app) { throw 'The package did not install' }
Log "installed $($app.PackageFullName) at $($app.InstallLocation)"
$app | Format-List Name, Version, Publisher, PackageFamilyName, InstallLocation, SignatureKind | Out-File "$Logs\store-package.txt"

Start-Process "shell:AppsFolder\$($app.PackageFamilyName)!JConnect"
$proc = $null
for ($i = 0; $i -lt 60 -and -not $proc; $i++) {
  Start-Sleep -Seconds 1
  $proc = Get-Process JConnect -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$($app.InstallLocation)*" } | Select-Object -First 1
}
if (-not $proc) { throw 'JConnect did not start from the package' }
Log "JConnect is running from the package: $($proc.Path)"

$listening = $null
for ($i = 0; $i -lt 60 -and -not $listening; $i++) {
  Start-Sleep -Seconds 1
  $listening = Get-NetTCPConnection -State Listen -LocalPort 47801 -ErrorAction SilentlyContinue | Select-Object -First 1
}
if (-not $listening) { throw 'JConnect is not listening on port 47801' }
$owner = Get-Process -Id $listening.OwningProcess
Log "port 47801 is open, by $($owner.Path)"
if ($owner.Path -notlike "$($app.InstallLocation)*") { throw 'Something other than the packaged JConnect has port 47801' }

Start-Sleep -Seconds 5
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
[System.Drawing.Graphics]::FromImage($bitmap).CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bitmap.Save("$Logs\store-window.png")
Log 'saved a screenshot'

# Windows keeps the startup task's state here once the package has run. 2 = enabled by the user, 1 = disabled by the user.
$task = "HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\SystemAppData\$($app.PackageFamilyName)\JConnectStartup"
if (Test-Path $task) { Log "startup task: $((Get-ItemProperty $task).State)" } else { Log 'startup task: no state yet (enabled by the manifest)' }

Get-Process JConnect -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 3

$appcert = "${env:ProgramFiles(x86)}\Windows Kits\10\App Certification Kit\appcert.exe"
if (Test-Path $appcert) {
  Log 'running the Windows App Certification Kit'
  & $appcert reset | Out-Null
  & $appcert test -appxpackagepath $Package -reportoutputpath "$Logs\wack-report.xml" 2>&1 | Out-File "$Logs\wack.log"
  if (Test-Path "$Logs\wack-report.xml") {
    [xml]$report = Get-Content "$Logs\wack-report.xml"
    Log "certification kit result: $($report.REPORT.OVERALL_RESULT)"
    foreach ($t in $report.SelectNodes('//TEST')) {
      $result = $t.SelectSingleNode('RESULT')
      $line = "  $(if ($result) { $result.InnerText } else { '?' }): $($t.NAME)"
      Add-Content -Path "$Logs\wack-summary.txt" -Value $line
    }
  } else {
    Log 'the certification kit wrote no report; see wack.log'
  }
} else {
  Log 'the Windows App Certification Kit is not installed here'
}
Log 'done'
