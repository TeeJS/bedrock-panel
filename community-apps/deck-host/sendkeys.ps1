# Keystroke helper for the Stream Deck Host drop-in app. Runs as a persistent hidden child of the
# Bedrock Panel main process and sends REAL keyboard input via user32 SendInput -- the only reliable
# zero-dependency way to fire hotkeys like Win+Shift+C from Node on Windows.
#
# Protocol: one JSON object per stdin line ->
#   {"combo":[{"vk":67,"ctrl":false,"shift":true,"alt":false,"win":true}, ...]}   press each in order
#   {"text":"hello\nworld"}                                                       type as unicode input
# Each line is answered with one stdout line: "ok" or "err <message>".
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class OQKeys {
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUT {
    [FieldOffset(0)] public uint type;
    [FieldOffset(8)] public KEYBDINPUT ki;   // x64 offsets; the union must span MOUSEINPUT's 32 bytes
    [FieldOffset(32)] public long _pad;      // pads Marshal.SizeOf to the real 40-byte x64 INPUT
  }
  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  const uint KEYUP = 2, UNICODE = 4;
  static INPUT Key(ushort vk, bool up) {
    var i = new INPUT(); i.type = 1; i.ki.wVk = vk; i.ki.dwFlags = up ? KEYUP : 0; return i;
  }
  static INPUT Chr(char c, bool up) {
    var i = new INPUT(); i.type = 1; i.ki.wScan = (ushort)c; i.ki.dwFlags = UNICODE | (up ? KEYUP : 0); return i;
  }
  public static void Combo(ushort vk, bool ctrl, bool shift, bool alt, bool win) {
    var list = new System.Collections.Generic.List<INPUT>();
    if (ctrl)  list.Add(Key(0x11, false));
    if (shift) list.Add(Key(0x10, false));
    if (alt)   list.Add(Key(0x12, false));
    if (win)   list.Add(Key(0x5B, false));
    list.Add(Key(vk, false)); list.Add(Key(vk, true));
    if (win)   list.Add(Key(0x5B, true));
    if (alt)   list.Add(Key(0x12, true));
    if (shift) list.Add(Key(0x10, true));
    if (ctrl)  list.Add(Key(0x11, true));
    var arr = list.ToArray();
    if (SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT))) != arr.Length)
      throw new Exception("SendInput failed: " + Marshal.GetLastWin32Error());
  }
  public static void Type(string text) {
    foreach (char c in text) {
      if (c == '\r') continue;
      if (c == '\n') { Combo(0x0D, false, false, false, false); continue; }   // Return, like the real app
      var arr = new INPUT[] { Chr(c, false), Chr(c, true) };
      if (SendInput(2, arr, Marshal.SizeOf(typeof(INPUT))) != 2)
        throw new Exception("SendInput failed: " + Marshal.GetLastWin32Error());
      System.Threading.Thread.Sleep(3);   // pace it; some apps drop bursts
    }
  }
}
"@

Write-Output 'ready'
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $m = $line | ConvertFrom-Json
    if ($m.combo) {
      foreach ($k in $m.combo) {
        [OQKeys]::Combo([uint16]$k.vk, [bool]$k.ctrl, [bool]$k.shift, [bool]$k.alt, [bool]$k.win)
        Start-Sleep -Milliseconds 30
      }
    } elseif ($null -ne $m.text) {
      [OQKeys]::Type([string]$m.text)
    }
    Write-Output 'ok'
  } catch { Write-Output ("err " + $_.Exception.Message) }
}
