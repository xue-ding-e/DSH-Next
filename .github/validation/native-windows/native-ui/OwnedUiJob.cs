// Disposable-runner test helper. Assign suspended process to a kill-on-close Job
// before any target instruction runs; all descendants remain owned by that Job.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class OwnedUiJob {
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

  public static string Run(string app,string appArgs,string probe,string probeArgs,string cwd,int timeoutSeconds) {
    if(timeoutSeconds<1||timeoutSeconds>180)throw new ArgumentOutOfRangeException("timeoutSeconds");
    IntPtr job=IntPtr.Zero;PI a=new PI(),d=new PI();bool appOwned=false,probeOwned=false;
    try {
      job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw Error("create job");
      var limits=new Extended();limits.basic.flags=0x2000;
      if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Extended))))throw Error("set job limits");
      var si=new SI();si.cb=(uint)Marshal.SizeOf(typeof(SI));
      if(!CreateProcess(app,new StringBuilder(((char)34)+app+((char)34)+" "+appArgs),IntPtr.Zero,IntPtr.Zero,false,4,IntPtr.Zero,cwd,ref si,out a))throw Error("create suspended app");
      if(!AssignProcessToJobObject(job,a.process))throw Error("assign app");appOwned=true;
      if(ResumeThread(a.thread)==UInt32.MaxValue)throw Error("resume app");
      si=new SI();si.cb=(uint)Marshal.SizeOf(typeof(SI));
      string args=probeArgs.Replace("{OWNED_APP_PID}",a.pid.ToString(System.Globalization.CultureInfo.InvariantCulture));
      if(!CreateProcess(probe,new StringBuilder(((char)34)+probe+((char)34)+" "+args),IntPtr.Zero,IntPtr.Zero,false,4,IntPtr.Zero,cwd,ref si,out d))throw Error("create suspended probe");
      if(!AssignProcessToJobObject(job,d.process))throw Error("assign probe");probeOwned=true;
      if(ResumeThread(d.thread)==UInt32.MaxValue)throw Error("resume probe");
      var clock=Stopwatch.StartNew();
      while(clock.Elapsed.TotalSeconds<timeoutSeconds) {
        uint appState=WaitForSingleObject(a.process,0),probeState=WaitForSingleObject(d.process,0);
        if(appState==UInt32.MaxValue||probeState==UInt32.MaxValue)throw Error("wait owned process");
        if(appState==0)throw new Exception("installed application exited before probe completed");
        if(probeState==0){uint code;if(!GetExitCodeProcess(d.process,out code))throw Error("read probe exit");if(code!=0)throw new Exception("UI probe exit "+code);return "probe exited 0; finally terminates owned application and descendants";}
        Thread.Sleep(100);
      }
      throw new TimeoutException("native UI probe exceeded deadline");
    } finally {
      try {
        if(d.process!=IntPtr.Zero&&!probeOwned){if(!TerminateProcess(d.process,1))throw Error("terminate suspended probe");if(WaitForSingleObject(d.process,15000)!=0)throw new TimeoutException("suspended probe remains");}
        if(a.process!=IntPtr.Zero&&!appOwned){if(!TerminateProcess(a.process,1))throw Error("terminate suspended app");if(WaitForSingleObject(a.process,15000)!=0)throw new TimeoutException("suspended app remains");}
      } finally {
        try {
          if(job!=IntPtr.Zero&&(appOwned||probeOwned)){if(!TerminateJobObject(job,1))throw Error("terminate owned UI job");var stop=Stopwatch.StartNew();while(Active(job)!=0&&stop.Elapsed.TotalSeconds<15)Thread.Sleep(100);if(Active(job)!=0)throw new TimeoutException("owned UI descendants remain");}
        } finally {
          if(d.thread!=IntPtr.Zero)CloseHandle(d.thread);if(d.process!=IntPtr.Zero)CloseHandle(d.process);
          if(a.thread!=IntPtr.Zero)CloseHandle(a.thread);if(a.process!=IntPtr.Zero)CloseHandle(a.process);if(job!=IntPtr.Zero)CloseHandle(job);
        }
      }
    }
  }
}
