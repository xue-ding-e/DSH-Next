// Disposable-runner test helper. Assign suspended process to a kill-on-close Job
// before any target instruction runs; all descendants remain owned by that Job.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class OwnedProcessJob {
  [StructLayout(LayoutKind.Sequential)] struct SI { public uint cb; public IntPtr reserved, desktop, title; public uint x,y,xSize,ySize,xChars,yChars,fill,flags; public ushort show,reserved2; public IntPtr reservedPtr,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public uint pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct Limits {public long processTime,jobTime;public uint flags;public UIntPtr minWorking,maxWorking;public uint activeLimit;public UIntPtr affinity;public uint priority,scheduling;}
  [StructLayout(LayoutKind.Sequential)] struct IO {public ulong a,b,c,d,e,f;}
  [StructLayout(LayoutKind.Sequential)] struct Extended {public Limits basic;public IO io;public UIntPtr processMemory,jobMemory,peakProcess,peakJob;}
  [StructLayout(LayoutKind.Sequential)] struct Accounting {public long a,b,c,d;public uint faults,total,active,terminated;}
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attrs,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref Extended value,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,out Accounting value,uint size,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr environment,string cwd,ref SI startup,out PI process);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint exitCode);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint exitCode);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint exitCode);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static Exception Error(string action){return new Win32Exception(Marshal.GetLastWin32Error(),action);}
  static uint Active(IntPtr job){Accounting a;if(!QueryInformationJobObject(job,1,out a,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero))throw Error("query job");return a.active;}
  // StartupOnly observes the actual parent process alive, then intentionally closes its whole tree.
  // It is not a window/UI test. Non-startup invocations require parent exit=0 and all descendants gone.
  public static string Run(string file,string args,string cwd,int timeoutSeconds,bool startupOnly) {
    if(timeoutSeconds<1||timeoutSeconds>600)throw new ArgumentOutOfRangeException("timeoutSeconds");
    IntPtr job=IntPtr.Zero;PI p=new PI();bool assigned=false;string result=null;
    try {
      job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw Error("create job");
      var limits=new Extended();limits.basic.flags=0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway allowed.
      if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Extended))))throw Error("set job limits");
      var startup=new SI();startup.cb=(uint)Marshal.SizeOf(typeof(SI));
      if(!CreateProcess(file,new StringBuilder("\""+file+"\" "+args),IntPtr.Zero,IntPtr.Zero,false,4,IntPtr.Zero,cwd,ref startup,out p))throw Error("create suspended child");
      if(!AssignProcessToJobObject(job,p.process))throw Error("assign child");assigned=true;
      if(ResumeThread(p.thread)==UInt32.MaxValue)throw Error("resume child");
      var clock=Stopwatch.StartNew();
      while(clock.Elapsed.TotalSeconds<timeoutSeconds){
        uint state=WaitForSingleObject(p.process,0);if(state==UInt32.MaxValue)throw Error("wait child");
        if(startupOnly){if(state==0)throw new Exception("application exited before observation");if(clock.Elapsed.TotalSeconds>=10){result="observed parent alive; no UI assertion";break;}}
        else if(Active(job)==0){uint exit;if(!GetExitCodeProcess(p.process,out exit))throw Error("read exit");if(exit!=0)throw new Exception("child exit "+exit);result="parent exit 0 and owned job empty";break;}
        Thread.Sleep(100);
      }
      if(result==null)throw new TimeoutException("owned process tree timed out");
      return result;
    } finally {
      try {
        if(job!=IntPtr.Zero && assigned){
          if(!TerminateJobObject(job,1))throw Error("terminate owned job");
          var stop=Stopwatch.StartNew();while(Active(job)!=0 && stop.Elapsed.TotalSeconds<15)Thread.Sleep(100);
          if(Active(job)!=0)throw new TimeoutException("owned tree remains after bounded termination");
        } else if(p.process!=IntPtr.Zero){
          if(!TerminateProcess(p.process,1))throw Error("terminate unassigned suspended child");
          if(WaitForSingleObject(p.process,15000)!=0)throw new TimeoutException("suspended child termination failed");
        }
      } finally {
        if(p.thread!=IntPtr.Zero)CloseHandle(p.thread);if(p.process!=IntPtr.Zero)CloseHandle(p.process);if(job!=IntPtr.Zero)CloseHandle(job);
      }
    }
  }
}
