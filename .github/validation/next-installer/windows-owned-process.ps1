<# Each command starts suspended, enters one kill-on-close Job Object, and only then executes. #>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'The owned-process driver requires native Windows PowerShell 7.' }
if (-not ('NextOwnedProcess' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class NextOwnedProcess {
    private static bool safeToStart=true;
    public static bool SafeToStart { get { return safeToStart; } }
    [StructLayout(LayoutKind.Sequential)] struct SA { public int length; public IntPtr descriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI {
        public int cb; public string reserved, desktop, title; public uint x,y,xsize,ysize,xchars,ychars,fill,flags;
        public short show, reserved2; public IntPtr reserved3, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process, thread; public uint pid, tid; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC {
        public long processTime, jobTime; public uint flags; public UIntPtr min, max; public uint activeLimit;
        public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO { public ulong ro,wo,oo,rt,wt,ot; }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED { public BASIC basic; public IO io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
    [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING { public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref EXTENDED info,uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out ACCOUNTING info,uint size,IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string path,uint access,uint share,ref SA security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr environment,string directory,ref SI start,out PI process);
    static void Check(bool ok,string message) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(),message); }
    static string Quote(string value) {
        if (value.Length>0 && value.IndexOfAny(new[]{' ','\t','\n','\r','\v','"'})<0) return value;
        var result = new StringBuilder("\""); int slashes=0;
        foreach (char c in value) {
            if (c=='\\') { slashes++; continue; }
            if (c=='"') { result.Append('\\',slashes*2+1).Append(c); slashes=0; continue; }
            result.Append('\\',slashes).Append(c); slashes=0;
        }
        return result.Append('\\',slashes*2).Append('"').ToString();
    }
    static uint Active(IntPtr job) { ACCOUNTING a; Check(QueryInformationJobObject(job,1,out a,(uint)Marshal.SizeOf<ACCOUNTING>(),IntPtr.Zero),"query owned job"); return a.active; }
    public sealed class Result { public uint pid,exitCode; public bool timedOut,outputExceeded; public long elapsedMs; }
    public static Result Run(string executable,string[] args,string cwd,int seconds,string stdout,string stderr,string stdin,string rawTail,bool simulateUncertainCleanup) {
        if (!safeToStart) throw new InvalidOperationException("Owned process cleanup is uncertain; this driver cannot start another process");
        if (seconds<1 || seconds>9000) throw new ArgumentOutOfRangeException("seconds");
        IntPtr job=IntPtr.Zero,output=IntPtr.Zero,error=IntPtr.Zero,input=IntPtr.Zero; PI p=new PI();
        bool created=false,assigned=false; var timer=Stopwatch.StartNew(); var result=new Result();
        try {
            job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero,"create owned job");
            var limits=new EXTENDED(); limits.basic.flags=0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf<EXTENDED>()),"limit owned job");
            var sa=new SA { length=Marshal.SizeOf<SA>(),inherit=1 };
            output=CreateFile(stdout,0x40000000,3,ref sa,1,0x80,IntPtr.Zero);
            Check(output!=new IntPtr(-1),"create owned stdout");
            error=CreateFile(stderr,0x40000000,3,ref sa,1,0x80,IntPtr.Zero);
            Check(error!=new IntPtr(-1),"create owned stderr");
            input=CreateFile(stdin,0x80000000,3,ref sa,3,0x80,IntPtr.Zero);
            Check(input!=new IntPtr(-1),"open null input");
            var si=new SI { cb=Marshal.SizeOf<SI>(),flags=0x100,input=input,output=output,error=error };
            var line=new StringBuilder(Quote(executable)); foreach(var arg in args) line.Append(' ').Append(Quote(arg));
            // NSIS documents /D= and _?= as final, unquoted absolute paths, even when they contain spaces.
            if (!String.IsNullOrEmpty(rawTail)) {
                if (!(rawTail.StartsWith("/D=") || rawTail.StartsWith("_?=")) || rawTail.IndexOfAny(new[]{'"','\r','\n','\0'})>=0)
                    throw new ArgumentException("Only a final owned NSIS directory parameter is accepted");
                if (!Path.IsPathFullyQualified(rawTail.Substring(3))) throw new ArgumentException("NSIS directory must be absolute");
                line.Append(' ').Append(rawTail);
            }
            Check(CreateProcess(executable,line,IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,cwd,ref si,out p),"create suspended command");
            created=true; safeToStart=false; result.pid=p.pid;
            Check(AssignProcessToJobObject(job,p.process),"assign command before execution"); assigned=true;
            Check(ResumeThread(p.thread)!=0xffffffff,"resume owned command");
            long rootExit=-1;
            while (true) {
                uint wait=WaitForSingleObject(p.process,100);
                Check(wait!=0xffffffff,"wait owned command");
                if (wait==0 && rootExit<0) rootExit=timer.ElapsedMilliseconds;
                // Observe quiescence before the final size read, so a last write cannot race a successful break.
                uint active=Active(job);
                result.outputExceeded=new FileInfo(stdout).Length+new FileInfo(stderr).Length>32*1024*1024;
                result.timedOut=timer.ElapsedMilliseconds>seconds*1000L || (rootExit>=0 && timer.ElapsedMilliseconds-rootExit>15000);
                if (rootExit>=0 && active==0 && !result.outputExceeded && !result.timedOut) break;
                if (result.timedOut || result.outputExceeded) {
                    Check(TerminateJobObject(job,124),"terminate only owned job");
                    var cleanup=Stopwatch.StartNew(); while (Active(job)!=0 && cleanup.ElapsedMilliseconds<10000) System.Threading.Thread.Sleep(50);
                    if (Active(job)!=0) throw new Exception("Owned descendants did not reach quiescence");
                    break;
                }
            }
            uint code; Check(GetExitCodeProcess(p.process,out code),"read owned exit"); result.exitCode=code;
            result.elapsedMs=timer.ElapsedMilliseconds; return result;
        } finally {
            Exception cleanupFailure=null;
            try {
                if (assigned && Active(job)!=0) {
                    Check(TerminateJobObject(job,125),"stop owned descendants after driver failure");
                    var cleanup=Stopwatch.StartNew(); while (Active(job)!=0 && cleanup.ElapsedMilliseconds<10000) System.Threading.Thread.Sleep(50);
                    if (Active(job)!=0) throw new Exception("Owned descendants did not stop after driver failure");
                }
                // If assignment failed, only the exact still-suspended process handle is terminated and awaited.
                if (created && !assigned) {
                    Check(TerminateProcess(p.process,125),"stop suspended unassigned command");
                    if (WaitForSingleObject(p.process,10000)!=0) throw new Exception("Suspended owned command did not stop");
                }
                if (created && simulateUncertainCleanup) throw new Exception("Injected failure to establish quiescence");
                if (created) safeToStart=true;
            } catch(Exception errorDuringCleanup) { cleanupFailure=errorDuringCleanup; }
            finally {
                if (job!=IntPtr.Zero) CloseHandle(job);
                foreach(var handle in new[]{p.thread,p.process,input,output,error}) if(handle!=IntPtr.Zero && handle!=new IntPtr(-1)) CloseHandle(handle);
            }
            if (cleanupFailure!=null) throw new Exception("Owned cleanup failed; no subsequent stage is safe",cleanupFailure);
        }
    }
}
'@
}

function Invoke-NextOwnedProcess {
    param([Parameter(Mandatory)][string]$FilePath, [string[]]$Arguments = @(),
        [Parameter(Mandatory)][string]$WorkingDirectory, [Parameter(Mandatory)][int]$TimeoutSeconds,
        [Parameter(Mandatory)][string]$EvidencePrefix, [string]$InputFile = 'NUL', [string]$RawTail = '', [switch]$SimulateUncertainCleanup)
    if (-not [IO.Path]::IsPathFullyQualified($FilePath) -or -not (Test-Path -LiteralPath $FilePath -PathType Leaf)) { throw 'Owned executable must be an existing absolute path.' }
    if (Test-Path -LiteralPath ($EvidencePrefix + '.result.json')) { throw 'Evidence label was already used.' }
    $result = [NextOwnedProcess]::Run($FilePath, $Arguments, $WorkingDirectory, $TimeoutSeconds,
        ($EvidencePrefix + '.stdout.log'), ($EvidencePrefix + '.stderr.log'), $InputFile, $RawTail, [bool]$SimulateUncertainCleanup)
    $result | ConvertTo-Json | Set-Content -LiteralPath ($EvidencePrefix + '.result.json') -Encoding utf8
    if ($result.outputExceeded) { throw "Owned output exceeded 32 MiB; retained files are not read back: $EvidencePrefix" }
    Get-Content -LiteralPath ($EvidencePrefix + '.stdout.log') | Write-Host
    Get-Content -LiteralPath ($EvidencePrefix + '.stderr.log') | Write-Host
    if ($result.timedOut -or $result.outputExceeded -or $result.exitCode -ne 0) { throw "Owned command did not complete successfully: $EvidencePrefix" }
    return $result
}
