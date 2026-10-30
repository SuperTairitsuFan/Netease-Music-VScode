const fs=require('fs');const dll='d:\\new folder\\x64\\toppingusbaudioasio_x64.dll';
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Native {
 [DllImport("kernel32", CharSet=CharSet.Unicode)] public static extern IntPtr LoadLibrary(string p);
 [DllImport("kernel32", CharSet=CharSet.Ansi)] public static extern IntPtr GetProcAddress(IntPtr h,string n);
}
"@; $h=[Native]::LoadLibrary($dll); [Runtime.InteropServices.Marshal]::GetLastWin32Error(); foreach($n in @('ASIOInit','ASIOExit','ASIOStart','ASIOStop','ASIOGetChannels','ASIOGetBufferSize','ASIOGetSampleRate','ASIOSetSampleRate','ASIOGetChannelInfo','ASIOCreateBuffers','ASIODisposeBuffers','ASIOOutputReady','AsioInit','ASIOInit@4')){ $p=[Native]::GetProcAddress($h,$n); "$n=$p" }
