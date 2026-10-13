/** Each PowerShell session owns a Windows Job before executing user code. */
export function windowsCommand(script: string, ownerPid: number): string {
  return `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [Console]::OutputEncoding
$__bgtPreference = $ErrorActionPreference
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class BetterGptJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveLimit;
    public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadCount, WriteCount, OtherCount, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
    public BasicLimit Basic; public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimit info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint rights, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static IntPtr job;
  public static void Start(int ownerPid) {
    job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception();
    var limits = new ExtendedLimit(); limits.Basic.Flags = 0x2000;
    if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimit)))) throw new Win32Exception();
    if (!AssignProcessToJobObject(job, Process.GetCurrentProcess().Handle)) throw new Win32Exception();
    IntPtr owner = OpenProcess(0x00100000, false, ownerPid);
    if (owner == IntPtr.Zero) throw new Win32Exception();
    var watcher = new Thread(() => {
      if (WaitForSingleObject(owner, 0xffffffff) == 0) TerminateJobObject(job, 1);
      CloseHandle(owner);
    });
    watcher.IsBackground = true; watcher.Start();
  }
  public static bool HasChildren() {
    Accounting info;
    if (!QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) throw new Win32Exception();
    return info.ActiveProcesses > 1;
  }
  static string Quote(string value) {
    var result = new System.Text.StringBuilder(); result.Append((char)34); int slashes = 0;
    foreach (char c in value) {
      if (c == (char)92) { slashes++; continue; }
      if (c == (char)34) { result.Append((char)92, slashes * 2 + 1); result.Append(c); slashes = 0; continue; }
      result.Append((char)92, slashes); result.Append(c); slashes = 0;
    }
    result.Append((char)92, slashes * 2); result.Append((char)34); return result.ToString();
  }
  public static int RunNative(string executable, string[] args) {
    var command = new System.Text.StringBuilder();
    foreach (string arg in args) { if (command.Length > 0) command.Append(' '); command.Append(Quote(arg)); }
    var child = new Process();
    child.StartInfo = new ProcessStartInfo(executable, command.ToString()) {
      UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true
    };
    child.Start();
    if (!AssignProcessToJobObject(job, child.Handle)) {
      int error = Marshal.GetLastWin32Error(); child.Kill(); throw new Win32Exception(error);
    }
    Console.WriteLine("__BETTER_GPT_NATIVE__" + child.Id + "|" + child.StartTime.ToUniversalTime().ToString("O"));
    child.OutputDataReceived += (sender, data) => { if (data.Data != null) Console.Out.WriteLine(data.Data); };
    child.ErrorDataReceived += (sender, data) => { if (data.Data != null) Console.Error.WriteLine(data.Data); };
    child.BeginOutputReadLine(); child.BeginErrorReadLine(); child.WaitForExit();
    int code = child.ExitCode; child.Dispose(); return code;
  }
}

'@
[BetterGptJob]::Start(${ownerPid})
$ErrorActionPreference = $__bgtPreference
$script:__bgtExit = 0
& {
${script}
$script:__bgtExit = if ($?) { 0 } elseif ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }
}
$__bgtSuccess = $?
if (-not $__bgtSuccess -and $script:__bgtExit -eq 0) { $script:__bgtExit = 1 }
while ([BetterGptJob]::HasChildren()) { Start-Sleep -Milliseconds 100 }
exit $script:__bgtExit
`;
}

/** Explicitly assign the native connector as well as its supervisor to the same Job. */
export function windowsTunnelCommand(executable: string, args: string[], ownerPid: number): string {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  return windowsCommand(`exit ([BetterGptJob]::RunNative(${quote(executable)}, [string[]]@(${args.map(quote).join(',')})))`, ownerPid);
}
