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
using System.Collections.Generic;
using System.Security.Cryptography;
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
    [DllImport("kernel32.dll", EntryPoint="QueryInformationJobObject", SetLastError=true)] static extern bool QueryJobIds(IntPtr job,int kind,IntPtr info,uint size,IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder name,ref uint length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
    [DllImport("kernel32.dll", CharSet=CharSet.Ansi, ExactSpelling=true)] static extern IntPtr GetProcAddress(IntPtr module,string name);
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_BASIC { public IntPtr exitStatus,peb,affinity,priority,pid,parent; }
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate int QueryBasic(IntPtr process,int kind,out PROCESS_BASIC info,uint size,out uint returned);
    public sealed class ProcessObservation {
        public uint pid; public string state="unknown",imageBasename,createdUtc,exitedUtc,parentRelation="unknown";
        public string parentQueryStatus="unavailable"; public uint? exitCode,parentPid; public int? queryError;
        internal long created,exited; public string imagePath;
    }
    public sealed class JobObservation {
        public string phase,utc,queryState="unknown"; public long elapsedMs; public uint assigned,listed;
        public bool truncated; public int? queryError; public ProcessObservation root;
        public List<ProcessObservation> processes=new List<ProcessObservation>();
    }
    // Diagnostic reads never select or terminate processes outside this exact job.
    static ProcessObservation Inspect(IntPtr handle,uint pid) {
        var o=new ProcessObservation { pid=pid,state="owned-handle" };
        uint code;
        if (GetExitCodeProcess(handle,out code)) { o.exitCode=code; o.state=code==259 ? "running" : "exited"; }
        else o.queryError=Marshal.GetLastWin32Error();
        long created,exited,kernel,user;
        if (GetProcessTimes(handle,out created,out exited,out kernel,out user)) {
            o.created=created; o.createdUtc=DateTime.FromFileTimeUtc(created).ToString("O");
            // GetProcessTimes leaves exit time undefined while the process is running.
            if (o.exitCode.HasValue && o.exitCode.Value!=259) { o.exited=exited; o.exitedUtc=DateTime.FromFileTimeUtc(exited).ToString("O"); }
        } else o.queryError=Marshal.GetLastWin32Error();
        var name=new StringBuilder(32768); uint length=(uint)name.Capacity;
        if (QueryFullProcessImageName(handle,0,name,ref length)) { o.imagePath=Path.GetFullPath(name.ToString()); o.imageBasename=Path.GetFileName(o.imagePath); }
        else o.queryError=Marshal.GetLastWin32Error();
        // This optional OS query supplies only a reported parent ID, never permission to open that parent.
        try {
        var module=GetModuleHandle("ntdll.dll"); var address=module==IntPtr.Zero ? IntPtr.Zero : GetProcAddress(module,"NtQueryInformationProcess");
        if (address!=IntPtr.Zero) {
            var query=Marshal.GetDelegateForFunctionPointer<QueryBasic>(address); PROCESS_BASIC basic; uint returned;
            int status=query(handle,0,out basic,(uint)Marshal.SizeOf<PROCESS_BASIC>(),out returned);
            if (status!=0) o.parentQueryStatus="ntstatus-"+status.ToString("X8");
            else if (returned!=Marshal.SizeOf<PROCESS_BASIC>()) o.parentQueryStatus="unexpected-size";
            else if (basic.pid.ToInt64()!=pid) o.parentQueryStatus="pid-mismatch";
            else if (basic.parent.ToInt64()<=0 || basic.parent.ToInt64()>UInt32.MaxValue) o.parentQueryStatus="unavailable-parent-id";
            else { o.parentPid=(uint)basic.parent.ToInt64(); o.parentQueryStatus="reported"; }
        }
        } catch(Exception error) { o.parentPid=null; o.parentRelation="unknown"; o.parentQueryStatus="query-exception-"+error.GetType().Name; }
        return o;
    }
    static JobObservation Observe(IntPtr job,PI root,string phase,long elapsed) {
        var o=new JobObservation { phase=phase,utc=DateTime.UtcNow.ToString("O"),elapsedMs=elapsed };
        const int maximum=256; int size=8+maximum*IntPtr.Size; IntPtr buffer=IntPtr.Zero;
        var budget=Stopwatch.StartNew();
        try {
            o.root=Inspect(root.process,root.pid); // The original handle is retained, so PID reuse cannot replace this root.
            buffer=Marshal.AllocHGlobal(size);
            for (int offset=0;offset<size;offset+=4) Marshal.WriteInt32(buffer,offset,0);
            bool ok=QueryJobIds(job,3,buffer,(uint)size,IntPtr.Zero); int error=ok ? 0 : Marshal.GetLastWin32Error();
            if (!ok && error!=234) { o.queryError=error; o.queryState="query-failed"; return o; }
            o.assigned=unchecked((uint)Marshal.ReadInt32(buffer,0)); o.listed=unchecked((uint)Marshal.ReadInt32(buffer,4));
            if (o.listed>maximum) { o.queryState="invalid-count"; return o; }
            o.truncated=!ok || o.listed<o.assigned; o.queryState=o.truncated ? "partial" : "complete";
            for (int index=0;index<o.listed;index++) {
                if (budget.ElapsedMilliseconds>2000) { o.truncated=true; o.queryState="time-bounded-partial"; break; }
                long value=Marshal.ReadIntPtr(buffer,8+index*IntPtr.Size).ToInt64();
                if (value<=0 || value>UInt32.MaxValue) { o.queryState="invalid-pid"; o.truncated=true; continue; }
                uint pid=(uint)value; var item=new ProcessObservation { pid=pid }; o.processes.Add(item);
                IntPtr handle=OpenProcess(0x1000,false,pid); // PROCESS_QUERY_LIMITED_INFORMATION, never terminate or VM-read access.
                if (handle==IntPtr.Zero) { item.state="gone-or-unavailable"; item.queryError=Marshal.GetLastWin32Error(); continue; }
                try {
                    bool member;
                    if (!IsProcessInJob(handle,job,out member)) { item.state="membership-unknown"; item.queryError=Marshal.GetLastWin32Error(); continue; }
                    if (!member) { item.state="gone-or-no-longer-owned"; continue; }
                    item=Inspect(handle,pid); o.processes[o.processes.Count-1]=item;
                } finally { CloseHandle(handle); }
            }
            foreach(var child in o.processes) {
                if (!child.parentPid.HasValue || child.created<=0) continue;
                ProcessObservation parent=child.parentPid.Value==root.pid ? o.root : o.processes.Find(x=>x.pid==child.parentPid.Value && x.created>0);
                // A reported PID is not an identity: only a known owned lifetime covering this child's birth can confirm it.
                if (parent!=null && parent.exitCode.HasValue && parent.created>0 && parent.created<=child.created && (parent.exited==0 || parent.exited>=child.created))
                    child.parentRelation="reported-parent-matches-observed-owned-lifetime";
                else child.parentRelation="reported-parent-not-verified";
            }
        } catch(Exception error) { o.queryState="observation-unknown-"+error.GetType().Name; }
        finally { if(buffer!=IntPtr.Zero) Marshal.FreeHGlobal(buffer); }
        return o;
    }
    public sealed class ToolCandidate {
        public bool policyPresent,timeBudgetExceeded,outputExceeded,truncated;
        public uint rootCode,assigned,listed; public int observedCount;
        public string queryState,imagePath,expectedPath,state;
        public long created,rootCreated,rootExited;
    }
    // This pure predicate is necessary but not sufficient: live handles and the locked file are rechecked below.
    public static bool IsToolCandidate(ToolCandidate c) {
        return c.policyPresent && c.rootCode==0 && !c.timeBudgetExceeded && !c.outputExceeded && !c.truncated
            && c.queryState=="complete" && c.assigned==1 && c.listed==1 && c.observedCount==1 && c.state=="running"
            && !String.IsNullOrEmpty(c.expectedPath) && String.Equals(c.imagePath,c.expectedPath,StringComparison.OrdinalIgnoreCase)
            && String.Equals(Path.GetFileName(c.expectedPath),"vctip.exe",StringComparison.OrdinalIgnoreCase)
            && c.rootCreated>0 && c.created>=c.rootCreated && c.rootExited>=c.created;
    }
    // Diagnostic only: acceptance continues to use the unchanged predicate above.
    public static string ExplainToolCandidateRejection(ToolCandidate c) {
        if (!c.policyPresent) return "policy-not-enabled";
        if (c.rootCode!=0) return "root-exit-not-zero";
        if (c.timeBudgetExceeded) return "command-time-budget";
        if (c.outputExceeded) return "output-byte-budget";
        if (c.truncated || c.queryState!="complete") return "snapshot-incomplete";
        if (c.assigned!=1 || c.listed!=1 || c.observedCount!=1) return "member-count-not-one";
        if (c.state!="running") return "candidate-not-running";
        if (String.IsNullOrEmpty(c.expectedPath)) return "expected-path-missing";
        if (!String.Equals(c.imagePath,c.expectedPath,StringComparison.OrdinalIgnoreCase)) return "image-path-mismatch";
        if (!String.Equals(Path.GetFileName(c.expectedPath),"vctip.exe",StringComparison.OrdinalIgnoreCase)) return "expected-image-not-vctip";
        if (c.rootCreated<=0 || c.created<c.rootCreated || c.rootExited<c.created) return "creation-outside-root-lifetime";
        return null;
    }
    public sealed class ToolCleanup {
        public string status,verifiedPath,sha256,createdUtc,startedUtc,endedUtc,error;
        public uint pid; public uint? exitCode,totalProcessesBefore,totalProcessesAfter; public bool attempted,terminated,jobEmpty,inventoryVerificationFailed;
    }
    static string LockedHash(FileStream file) { file.Position=0; string hash=Convert.ToHexString(SHA256.HashData(file)).ToLowerInvariant(); file.Position=0; return hash; }
    static ACCOUNTING Accounting(IntPtr job) {
        ACCOUNTING a; Check(QueryInformationJobObject(job,1,out a,(uint)Marshal.SizeOf<ACCOUNTING>(),IntPtr.Zero),"query owned job accounting"); return a;
    }
    // TotalProcesses includes terminated members, so even a child born and gone between samples is rejected.
    public static bool IsCleanupInventory(bool complete,uint baselineTotal,uint observedTotal,uint active,uint assigned,uint listed,long listedPid,uint candidatePid) {
        return complete && baselineTotal>0 && observedTotal==baselineTotal
            && ((active==0 && assigned==0 && listed==0) || (active<=1 && assigned==1 && listed==1 && listedPid==candidatePid));
    }
    static bool CleanupInventory(IntPtr job,uint pid,uint total,out bool empty,out uint observedTotal) {
        empty=false; observedTotal=0; int size=8+2*IntPtr.Size; IntPtr buffer=Marshal.AllocHGlobal(size);
        try {
            var before=Accounting(job); observedTotal=before.total;
            if (before.total!=total || !QueryJobIds(job,3,buffer,(uint)size,IntPtr.Zero)) return false;
            uint assigned=unchecked((uint)Marshal.ReadInt32(buffer,0)),listed=unchecked((uint)Marshal.ReadInt32(buffer,4));
            if (listed>2) return false;
            long listedPid=listed==1 ? Marshal.ReadIntPtr(buffer,8).ToInt64() : 0;
            var after=Accounting(job); observedTotal=after.total;
            if (!IsCleanupInventory(true,total,after.total,after.active,assigned,listed,listedPid,pid)) return false;
            empty=after.active==0 && listed==0; return true;
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    static bool UniqueMember(IntPtr job,uint pid,uint total) {
        var before=Accounting(job);
        bool empty; uint observed;
        if (before.total!=total || before.active!=1 || !CleanupInventory(job,pid,total,out empty,out observed) || empty) return false;
        var after=Accounting(job); return after.total==total && after.active==1;
    }
    static bool SameOwnedHandle(IntPtr handle,IntPtr job,uint pid,long created,string path) {
        bool member;
        if (!IsProcessInJob(handle,job,out member) || !member) return false;
        var actual=Inspect(handle,pid);
        return actual.state=="running" && actual.created==created && String.Equals(actual.imagePath,path,StringComparison.OrdinalIgnoreCase);
    }
    static bool CleanupVerifiedTool(IntPtr job,PI root,JobObservation snapshot,FileStream lockedFile,string expectedPath,string expectedHash,
        Stopwatch timer,int seconds,string stdout,string stderr,Result result) {
        result.toolExpectedImagePath=expectedPath;
        if (lockedFile==null) { result.toolCandidateRejectionReason="policy-not-enabled"; return false; }
        if (snapshot.root==null || !snapshot.root.exitCode.HasValue) { result.toolCandidateRejectionReason="root-observation-missing"; return false; }
        if (snapshot.processes.Count!=1) { result.toolCandidateRejectionReason="member-count-not-one"; return false; }
        var candidate=snapshot.processes[0];
        var check=new ToolCandidate { policyPresent=true,rootCode=snapshot.root.exitCode.Value,
            timeBudgetExceeded=timer.ElapsedMilliseconds>seconds*1000L,outputExceeded=result.outputExceeded,
            queryState=snapshot.queryState,truncated=snapshot.truncated,assigned=snapshot.assigned,listed=snapshot.listed,
            observedCount=snapshot.processes.Count,state=candidate.state,imagePath=candidate.imagePath,expectedPath=expectedPath,
            created=candidate.created,rootCreated=snapshot.root.created,rootExited=snapshot.root.exited };
        if (!IsToolCandidate(check)) {
            result.toolCandidateRejectionReason=ExplainToolCandidateRejection(check) ?? "unclassified-predicate-rejection";
            return false;
        }
        var evidence=new ToolCleanup { pid=candidate.pid,verifiedPath=expectedPath,sha256=expectedHash,createdUtc=candidate.createdUtc,
            startedUtc=DateTime.UtcNow.ToString("O"),status="identity-recheck" }; result.toolCleanup=evidence;
        IntPtr limited=IntPtr.Zero,terminating=IntPtr.Zero;
        try {
            // Pin cumulative membership before either live-handle recheck, not after the last PID sample.
            var baseline=Accounting(job); uint baselineTotal=baseline.total; evidence.totalProcessesBefore=baselineTotal;
            if (baseline.active!=1) return false;
            limited=OpenProcess(0x1000,false,candidate.pid);
            if (limited==IntPtr.Zero || !SameOwnedHandle(limited,job,candidate.pid,candidate.created,expectedPath)) return false;
            if (!String.Equals(LockedHash(lockedFile),expectedHash,StringComparison.Ordinal)) return false;
            // Keep the first identity handle open until the second handle has been fully checked and released.
            terminating=OpenProcess(0x00101001,false,candidate.pid); // SYNCHRONIZE | QUERY_LIMITED_INFORMATION | TERMINATE
            if (terminating==IntPtr.Zero || !SameOwnedHandle(terminating,job,candidate.pid,candidate.created,expectedPath)
                || !UniqueMember(job,candidate.pid,baselineTotal) || timer.ElapsedMilliseconds>seconds*1000L
                || new FileInfo(stdout).Length+new FileInfo(stderr).Length>32*1024*1024) return false;
            evidence.attempted=true;
            var cleanup=Stopwatch.StartNew();
            Check(TerminateProcess(terminating,125),"stop exact verified owned compiler telemetry handle"); evidence.terminated=true;
            bool targetExited=false;
            while (cleanup.ElapsedMilliseconds<10000) {
                if (!targetExited) {
                    uint wait=WaitForSingleObject(terminating,0);
                    if (wait!=0 && wait!=258) throw new Win32Exception(Marshal.GetLastWin32Error(),"wait verified tool handle");
                    if (wait==0) {
                        uint code; Check(GetExitCodeProcess(terminating,out code),"read verified tool exit"); evidence.exitCode=code;
                        if (code!=125) throw new Exception("Verified tool termination did not retain its explicit teardown exit code");
                        targetExited=true;
                        // The object identity is settled; release both handles before waiting for final job accounting.
                        CloseHandle(terminating); terminating=IntPtr.Zero; CloseHandle(limited); limited=IntPtr.Zero;
                    }
                }
                bool empty; uint total;
                bool known=CleanupInventory(job,candidate.pid,baselineTotal,out empty,out total); evidence.totalProcessesAfter=total;
                if (!known) { evidence.inventoryVerificationFailed=true; return false; }
                if (targetExited && empty) {
                    evidence.jobEmpty=true;
                    if (timer.ElapsedMilliseconds>seconds*1000L || new FileInfo(stdout).Length+new FileInfo(stderr).Length>32*1024*1024) return false;
                    evidence.status="completed-with-verified-tool-cleanup"; return true;
                }
                System.Threading.Thread.Sleep(50);
            }
            return false;
        } catch(Exception error) { evidence.error=error.GetType().Name; return false; }
        finally {
            evidence.endedUtc=DateTime.UtcNow.ToString("O");
            if (evidence.status!="completed-with-verified-tool-cleanup") evidence.status="rejected-or-incomplete";
            if (terminating!=IntPtr.Zero) CloseHandle(terminating);
            if (limited!=IntPtr.Zero) CloseHandle(limited);
        }
    }
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
    public sealed class Result {
        public uint pid,exitCode; public bool timedOut,outputExceeded,quiescenceConfirmed,rootExitGraceExceeded,naturalQuiescence; public ToolCleanup toolCleanup; public long elapsedMs,rootExitObservedMs=-1;
        public string terminationReason,toolExpectedImagePath,toolCandidateRejectionReason; public List<JobObservation> snapshots=new List<JobObservation>();
    }
    public static Result Run(string executable,string[] args,string cwd,int seconds,string stdout,string stderr,string stdin,string rawTail,bool simulateUncertainCleanup,string verifiedToolPath,string verifiedToolSha256) {
        if (!safeToStart) throw new InvalidOperationException("Owned process cleanup is uncertain; this driver cannot start another process");
        if (seconds<1 || seconds>9000) throw new ArgumentOutOfRangeException("seconds");
        IntPtr job=IntPtr.Zero,output=IntPtr.Zero,error=IntPtr.Zero,input=IntPtr.Zero; PI p=new PI();
        FileStream toolLock=null; bool created=false,assigned=false; var timer=Stopwatch.StartNew(); var result=new Result();
        try {
            if (!String.IsNullOrEmpty(verifiedToolPath) || !String.IsNullOrEmpty(verifiedToolSha256)) {
                if (!Path.IsPathFullyQualified(verifiedToolPath) || !String.Equals(Path.GetFileName(verifiedToolPath),"vctip.exe",StringComparison.OrdinalIgnoreCase)
                    || verifiedToolSha256==null || verifiedToolSha256.Length!=64) throw new ArgumentException("Unsealed verified compiler tool identity");
                toolLock=File.Open(verifiedToolPath,FileMode.Open,FileAccess.Read,FileShare.Read);
                if (LockedHash(toolLock)!=verifiedToolSha256) throw new Exception("Verified compiler tool file hash changed before command creation");
            }
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
                if (wait==0 && rootExit<0) {
                    rootExit=timer.ElapsedMilliseconds; result.rootExitObservedMs=rootExit;
                    result.snapshots.Add(Observe(job,p,"root-exit",rootExit));
                }
                // Observe quiescence before the final size read, so a last write cannot race a successful break.
                uint active=Active(job);
                result.outputExceeded=new FileInfo(stdout).Length+new FileInfo(stderr).Length>32*1024*1024;
                result.rootExitGraceExceeded=rootExit>=0 && timer.ElapsedMilliseconds-rootExit>15000;
                result.timedOut=timer.ElapsedMilliseconds>seconds*1000L || result.rootExitGraceExceeded;
                if (rootExit>=0 && active==0 && !result.outputExceeded && !result.timedOut) { result.naturalQuiescence=true; break; }
                if (result.timedOut || result.outputExceeded) {
                    result.terminationReason=result.outputExceeded ? "output-byte-budget" :
                        (timer.ElapsedMilliseconds>seconds*1000L ? "command-time-budget" : "root-exit-descendants");
                    var snapshot=Observe(job,p,"before-owned-termination",timer.ElapsedMilliseconds); result.snapshots.Add(snapshot);
                    if (result.rootExitGraceExceeded && !result.outputExceeded && CleanupVerifiedTool(job,p,snapshot,toolLock,verifiedToolPath,verifiedToolSha256,timer,seconds,stdout,stderr,result)) {
                        // This explicit opt-in is active tool teardown, not a claim that descendants exited naturally.
                        result.timedOut=false; result.terminationReason="verified-tool-cleanup"; break;
                    }
                    Check(TerminateJobObject(job,124),"terminate only owned job");
                    var cleanup=Stopwatch.StartNew(); while (Active(job)!=0 && cleanup.ElapsedMilliseconds<10000) System.Threading.Thread.Sleep(50);
                    if (Active(job)!=0) throw new Exception("Owned descendants did not reach quiescence");
                    break;
                }
            }
            // A failure-path teardown can overlap a final write; never read back oversized logs after cleanup.
            result.outputExceeded=result.outputExceeded || new FileInfo(stdout).Length+new FileInfo(stderr).Length>32*1024*1024;
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
                if (created) { safeToStart=true; result.quiescenceConfirmed=true; }
            } catch(Exception errorDuringCleanup) { cleanupFailure=errorDuringCleanup; }
            finally {
                if (job!=IntPtr.Zero) CloseHandle(job);
                foreach(var handle in new[]{p.thread,p.process,input,output,error}) if(handle!=IntPtr.Zero && handle!=new IntPtr(-1)) CloseHandle(handle);
                if (toolLock!=null) toolLock.Dispose();
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
        [Parameter(Mandatory)][string]$EvidencePrefix, [string]$InputFile = 'NUL', [string]$RawTail = '', [switch]$SimulateUncertainCleanup, [string]$VerifiedToolPath = '', [string]$VerifiedToolSha256 = '')
    if (-not [IO.Path]::IsPathFullyQualified($FilePath) -or -not (Test-Path -LiteralPath $FilePath -PathType Leaf)) { throw 'Owned executable must be an existing absolute path.' }
    if (Test-Path -LiteralPath ($EvidencePrefix + '.result.json')) { throw 'Evidence label was already used.' }
    $result = [NextOwnedProcess]::Run($FilePath, $Arguments, $WorkingDirectory, $TimeoutSeconds,
        ($EvidencePrefix + '.stdout.log'), ($EvidencePrefix + '.stderr.log'), $InputFile, $RawTail, [bool]$SimulateUncertainCleanup, $VerifiedToolPath, $VerifiedToolSha256)
    $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath ($EvidencePrefix + '.result.json') -Encoding utf8
    if ($result.outputExceeded) { throw "Owned output exceeded 32 MiB; retained files are not read back: $EvidencePrefix" }
    Get-Content -LiteralPath ($EvidencePrefix + '.stdout.log') | Write-Host
    Get-Content -LiteralPath ($EvidencePrefix + '.stderr.log') | Write-Host
    if ($result.timedOut -or $result.outputExceeded -or $result.exitCode -ne 0) { throw "Owned command did not complete successfully: $EvidencePrefix" }
    return $result
}
