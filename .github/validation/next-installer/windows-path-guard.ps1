<# Refuse redirected ancestors before reading, executing, seeding, or uninstalling owned paths. #>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Native Windows path inspection is required.' }
if (-not ('NextPathGuard' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class NextPathGuard {
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFileAttributes(string path);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandle(IntPtr file,StringBuilder path,uint length,uint flags);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public static string Canonical(string path,bool mustExist) {
        if (!Path.IsPathFullyQualified(path) || path.StartsWith(@"\\")) throw new Exception("Only absolute local drive paths are accepted");
        string full=Path.GetFullPath(path), cursor=full, existing=null;
        var suffix=new List<string>(); bool found=false;
        while (cursor!=null) {
            uint attributes=GetFileAttributes(cursor);
            if (attributes==0xffffffff) {
                int error=Marshal.GetLastWin32Error();
                if (error!=2 && error!=3) throw new Win32Exception(error,"Cannot inspect path ancestor");
                if (found) throw new Exception("An existing path has an unavailable ancestor");
                if (mustExist && cursor==full) throw new Exception("Required owned path does not exist");
                suffix.Add(Path.GetFileName(cursor));
            } else {
                if ((attributes & 0x400)!=0) throw new Exception("Reparse point or junction rejected: "+cursor);
                if (!found) { existing=cursor; found=true; }
            }
            var parent=Directory.GetParent(cursor); cursor=parent==null ? null : parent.FullName;
        }
        if (existing==null) throw new Exception("No existing local ancestor establishes ownership");
        IntPtr handle=CreateFile(existing,0x80,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
        if (handle==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(),"Cannot canonicalize owned path");
        string result;
        try {
            var name=new StringBuilder(32768); uint count=GetFinalPathNameByHandle(handle,name,(uint)name.Capacity,0);
            if (count==0 || count>=name.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error(),"Canonical path unavailable");
            result=name.ToString();
        } finally { CloseHandle(handle); }
        if (result.StartsWith(@"\\?\UNC\")) throw new Exception("Network path is outside the disposable local fixture");
        if (result.StartsWith(@"\\?\")) result=result.Substring(4);
        suffix.Reverse(); foreach(string segment in suffix) result=Path.Combine(result,segment);
        return Path.GetFullPath(result);
    }
}
'@
}
function Assert-NextPath {
    param([Parameter(Mandatory)][string]$Path, [string]$Within, [switch]$AllowRoot, [switch]$MustExist)
    $canonical = [NextPathGuard]::Canonical($Path,[bool]$MustExist)
    if ($Within) {
        $parent = [NextPathGuard]::Canonical($Within,$true).TrimEnd('\')
        $same = $canonical.TrimEnd('\').Equals($parent,[StringComparison]::OrdinalIgnoreCase)
        if (-not (($AllowRoot -and $same) -or $canonical.StartsWith($parent + '\',[StringComparison]::OrdinalIgnoreCase))) { throw 'Canonical path escaped its owned parent.' }
    }
    return $canonical
}
function Assert-NextInstallTree {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$OwnedRoot)
    $start = Assert-NextPath -Path $Path -Within $OwnedRoot -MustExist
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($start)
    $count = 0
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($entry in Get-ChildItem -LiteralPath $directory -Force) {
            if (++$count -gt 500000) { throw 'Owned install-tree inventory exceeded its bound.' }
            $safe = Assert-NextPath -Path $entry.FullName -Within $start -MustExist
            if ($entry.PSIsContainer) { $pending.Push($safe) }
        }
    }
}
