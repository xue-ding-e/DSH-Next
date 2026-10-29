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
    // Extended Win32 syntax is internal only. It must not turn caller-supplied device,
    // network, stream, or ambiguous DOS aliases into new accepted namespaces.
    public static string LocalDrivePath(string path) {
        if (String.IsNullOrEmpty(path) || path.Length<3 ||
            !((path[0]>='A' && path[0]<='Z') || (path[0]>='a' && path[0]<='z')) ||
            path[1]!=':' || (path[2]!='\\' && path[2]!='/'))
            throw new Exception("Only absolute local drive paths are accepted");
        string local=path.Replace('/','\\');
        if (local.Length+4>=32767) throw new Exception("Owned local path exceeds the extended Win32 bound");
        foreach (char value in local.Substring(2))
            if (value<32 || ":<>\"|?*".IndexOf(value)>=0) throw new Exception("Ambiguous local path character rejected");
        string[] segments=local.Substring(3).Split('\\');
        for (int index=0; index<segments.Length; index++) {
            string segment=segments[index];
            if (segment.Length==0 && index==segments.Length-1) continue; // drive root or trailing directory separator
            if (segment.Length==0 || segment.Length>255 || segment.EndsWith(".") || segment.EndsWith(" "))
                throw new Exception("Ambiguous local path component rejected");
            string stem=segment.Split('.')[0].ToUpperInvariant();
            if (stem=="CON" || stem=="PRN" || stem=="AUX" || stem=="NUL" ||
                ((stem.StartsWith("COM") || stem.StartsWith("LPT")) && stem.Length==4 && "123456789\u00b9\u00b2\u00b3".IndexOf(stem[3])>=0))
                throw new Exception("DOS device component rejected");
        }
        return local;
    }
    public static string NativePath(string normalized) { return @"\\?\"+LocalDrivePath(normalized); }
    static string Context(string stage,string path,int error) {
        return stage+"; path=["+path+"]; utf16Length="+path.Length+"; win32Error="+error;
    }
    static Win32Exception NativeFailure(string stage,string path,int error) {
        return new Win32Exception(error,Context(stage,path,error));
    }
    public static string Canonical(string path,bool mustExist) {
        string full=LocalDrivePath(Path.GetFullPath(LocalDrivePath(path))), cursor=full, existing=null;
        var suffix=new List<string>(); bool found=false;
        while (cursor!=null) {
            uint attributes=GetFileAttributes(NativePath(cursor));
            if (attributes==0xffffffff) {
                int error=Marshal.GetLastWin32Error();
                if (error!=2 && error!=3) throw NativeFailure("Cannot inspect path ancestor",cursor,error);
                if (found) throw NativeFailure("An existing path has an unavailable ancestor",cursor,error);
                if (mustExist && cursor==full) throw NativeFailure("Required owned path does not exist",cursor,error);
                suffix.Add(Path.GetFileName(cursor));
            } else {
                if ((attributes & 0x400)!=0) throw new Exception("Reparse point or junction rejected: "+cursor);
                if (!found) { existing=cursor; found=true; }
            }
            var parent=Directory.GetParent(cursor); cursor=parent==null ? null : parent.FullName;
        }
        if (existing==null) throw new Exception("No existing local ancestor establishes ownership");
        IntPtr handle=CreateFile(NativePath(existing),0x80,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
        if (handle==new IntPtr(-1)) throw NativeFailure("Cannot canonicalize owned path",existing,Marshal.GetLastWin32Error());
        string result;
        try {
            var name=new StringBuilder(32768); uint count=GetFinalPathNameByHandle(handle,name,(uint)name.Capacity,0);
            if (count==0) throw NativeFailure("Canonical path unavailable",existing,Marshal.GetLastWin32Error());
            if (count>=name.Capacity) throw new Exception("Canonical path exceeded its fixed buffer; path=["+existing+"]; utf16Length="+existing.Length);
            result=name.ToString();
        } finally { CloseHandle(handle); }
        if (result.StartsWith(@"\\?\UNC\")) throw new Exception("Network path is outside the disposable local fixture");
        if (result.StartsWith(@"\\?\")) result=result.Substring(4);
        result=LocalDrivePath(result);
        suffix.Reverse(); foreach(string segment in suffix) result=Path.Combine(result,segment);
        return LocalDrivePath(Path.GetFullPath(result));
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
