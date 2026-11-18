/* eslint-disable */
// TEMPORARY (PETTY-510): wall time of PowerShell ways to read Credential Manager on the Windows runner.
import { spawnSync } from "node:child_process";
const ps = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const pwsh = spawnSync("where.exe", ["pwsh"], { encoding: "utf8" }).stdout.split(/\r?\n/)[0].trim();
const enc = (s) => Buffer.from(s, "utf16le").toString("base64");
const time = (label, exe, script) => {
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    const r = spawnSync(exe, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", enc(`$ProgressPreference = 'SilentlyContinue'\n${script}`)], { encoding: "utf8", windowsHide: true });
    console.log(`${label} #${i + 1}: ${Math.round(performance.now() - t)} ms, exit ${r.status}, out ${JSON.stringify((r.stdout || "").trim().slice(0, 120))}, err ${JSON.stringify((r.stderr || "").trim().slice(0, 400))}`);
  }
};
const EMIT = String.raw`$ErrorActionPreference = 'Stop'
$an = New-Object Reflection.AssemblyName 'PettyCredential'
$ab = [Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly($an, [Reflection.Emit.AssemblyBuilderAccess]::Run)
$mb = $ab.DefineDynamicModule('PettyCredential')
$tb = $mb.DefineType('PettyCredential', [Reflection.TypeAttributes]'Public, Abstract, Sealed')
$di = [Runtime.InteropServices.DllImportAttribute]
$ctor = $di.GetConstructor([Type[]]@([string]))
$fields = [Reflection.FieldInfo[]]@($di.GetField('SetLastError'), $di.GetField('CharSet'))
$values = [object[]]@($true, [Runtime.InteropServices.CharSet]::Unicode)
$sp = [Runtime.InteropServices.DefaultDllImportSearchPathsAttribute]
$spAttr = New-Object Reflection.Emit.CustomAttributeBuilder($sp.GetConstructor([Type[]]@([Runtime.InteropServices.DllImportSearchPath])), [object[]]@([Runtime.InteropServices.DllImportSearchPath]::System32))
function Def([string]$n, [Type]$r, [Type[]]$a) {
  $m = $tb.DefineMethod($n, [Reflection.MethodAttributes]'Public, Static, PinvokeImpl, HideBySig', $r, $a)
  $m.SetCustomAttribute((New-Object Reflection.Emit.CustomAttributeBuilder($ctor, [object[]]@('advapi32.dll'), $fields, $values)))
  $m.SetCustomAttribute($spAttr)
}
Def 'CredReadW' ([bool]) @([string], [int], [int], [IntPtr].MakeByRefType())
Def 'CredDeleteW' ([bool]) @([string], [int], [int])
Def 'CredFree' ([void]) @([IntPtr])
$t = $tb.CreateType()
$p = [IntPtr]::Zero
$ok = $t::CredReadW('petty:https://ci.invalid', 1, 0, [ref]$p)
$e = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
"ok=$ok err=$e"`;
const VAULT = String.raw`$null = [Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType = WindowsRuntime]
$v = New-Object Windows.Security.Credentials.PasswordVault
try { $null = $v.Retrieve('petty', 'https://ci.invalid'); 'found' } catch { 'not found: ' + $_.Exception.HResult }`;
const ADDTYPE = String.raw`Add-Type -TypeDefinition 'public static class PettyX { public static int One() { return 1; } }'
[PettyX]::One()`;
time("powershell.exe startup", ps, "exit 0");
time("powershell.exe Add-Type of a one-line class", ps, ADDTYPE);
time("powershell.exe emit CredReadW", ps, EMIT);
time("powershell.exe PasswordVault", ps, VAULT);
if (pwsh) { time("pwsh startup", pwsh, "exit 0"); time("pwsh emit CredReadW", pwsh, EMIT); }
const t = performance.now(); spawnSync(process.execPath, ["-e", "0"]); console.log(`node startup: ${Math.round(performance.now() - t)} ms`);
