// foreground-watch.cs — foreground-window tracking + window find/focus/list for Bedrock Panel. [MIT]
//
// Replaces the per-call powershell.exe spawns that desktopFocus.js and meetingControl.js used:
// endpoint-security tools flag continuous PowerShell process creation as malware-like behavior,
// so this one small signed helper covers all four operations natively.
//
// Modes (first argument):
//   watch            long-running: prints the foreground process name (bare, no ".exe") to stdout,
//                    one line per change, via SetWinEventHook(EVENT_SYSTEM_FOREGROUND) — purely
//                    event-driven, zero polling. Prints the current foreground app immediately on
//                    start. Exits when stdin closes (parent died) so it can never be orphaned.
//   list             one-shot: JSON array of {Hwnd, ProcessName, MainWindowTitle, Minimized} for
//                    EVERY top-level visible titled window (EnumWindows — minimized included,
//                    tool windows and DWM-cloaked ghosts excluded). One entry PER WINDOW, so
//                    multi-window apps (four Chrome windows) list all of them — a Process-based
//                    enumeration only ever sees one MainWindowTitle per process.
//   find <name...>   one-shot: "OK" (exit 0) if any named process owns a main window, else
//                    "NOTFOUND" (exit 1). Names may include or omit ".exe".
//   focus <name...>  one-shot: force-focus the first named process's main window ("OK"/"NOTFOUND").
//                    Uses AttachThreadInput to the current foreground thread first — the standard
//                    workaround for Windows' foreground-lock blocking background processes.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;

static class ForegroundWatch {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr hmod, WinEventDelegate proc, uint idProcess, uint idThread, uint flags);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hWnd, uint min, uint max);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder sb, int max);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out int val, int size);
  delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  const int GWL_EXSTYLE = -20;
  const int WS_EX_TOOLWINDOW = 0x00000080;
  const int DWMWA_CLOAKED = 14;

  delegate void WinEventDelegate(IntPtr hook, uint evt, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
  [StructLayout(LayoutKind.Sequential)]
  struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int ptX; public int ptY; }

  const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
  const uint WINEVENT_OUTOFCONTEXT = 0x0000;
  const int SW_RESTORE = 9;

  static WinEventDelegate _hookProc;   // held in a static so the GC can never collect the native callback
  static string _last = null;

  static int Main(string[] args) {
    try { Console.OutputEncoding = System.Text.Encoding.UTF8; } catch (Exception) {}
    string mode = args.Length > 0 ? args[0] : "watch";
    if (mode == "watch") return Watch();
    if (mode == "list") return List();
    if (mode == "find" || mode == "focus") {
      Process target = FindWindowProcess(args);
      if (target == null) { Console.WriteLine("NOTFOUND"); return 1; }
      if (mode == "find") { Console.WriteLine("OK"); return 0; }
      return Focus(target.MainWindowHandle);
    }
    Console.Error.WriteLine("usage: foreground-watch [watch|list|find <name...>|focus <name...>]");
    return 2;
  }

  static string ProcName(IntPtr hWnd) {
    if (hWnd == IntPtr.Zero) return "";
    uint pid;
    GetWindowThreadProcessId(hWnd, out pid);
    if (pid == 0) return "";
    try { return Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { return ""; }
  }

  static void Emit(IntPtr hWnd) {
    string name = ProcName(hWnd);
    if (string.IsNullOrEmpty(name) || name == _last) return;
    _last = name;
    Console.WriteLine(name);
  }

  static int Watch() {
    // Parent-death guard: the JS side keeps our stdin open; EOF means it's gone, so exit rather
    // than linger as an orphaned hook. Read on a background thread — GetMessage blocks this one.
    Thread stdinWatch = new Thread(delegate() {
      try { while (Console.In.Read() != -1) {} } catch (Exception) {}
      Environment.Exit(0);
    });
    stdinWatch.IsBackground = true;
    stdinWatch.Start();

    Emit(GetForegroundWindow());   // seed with the current app so the consumer never starts blind
    _hookProc = delegate(IntPtr hook, uint evt, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) { Emit(hwnd); };
    IntPtr h = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, _hookProc, 0, 0, WINEVENT_OUTOFCONTEXT);
    if (h == IntPtr.Zero) { Console.Error.WriteLine("SetWinEventHook failed"); return 1; }
    MSG msg;
    while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) {}   // WINEVENT_OUTOFCONTEXT delivery needs a message pump
    return 0;
  }

  static int List() {
    List<Dictionary<string, object>> rows = new List<Dictionary<string, object>>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      try {
        if (!IsWindowVisible(h)) return true;                                  // hidden (incl. our own capture windows)
        int len = GetWindowTextLength(h);
        if (len == 0) return true;                                             // untitled = not a user-facing window
        if ((GetWindowLong(h, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0) return true;   // palettes/overlays
        int cloaked = 0;
        try { DwmGetWindowAttribute(h, DWMWA_CLOAKED, out cloaked, 4); } catch (Exception) {}
        if (cloaked != 0) return true;                                         // suspended-UWP ghosts
        System.Text.StringBuilder sb = new System.Text.StringBuilder(len + 1);
        GetWindowText(h, sb, sb.Capacity);
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        string pname = "";
        try { pname = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) {}
        Dictionary<string, object> row = new Dictionary<string, object>();
        row["Hwnd"] = (long)h;
        row["ProcessName"] = pname;
        row["MainWindowTitle"] = sb.ToString();
        row["Minimized"] = IsIconic(h);
        rows.Add(row);
      } catch (Exception) {}
      return true;
    }, IntPtr.Zero);
    Console.WriteLine(new JavaScriptSerializer().Serialize(rows));
    return 0;
  }

  static Process FindWindowProcess(string[] args) {
    for (int i = 1; i < args.Length; i++) {
      string n = args[i] ?? "";
      if (n.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) n = n.Substring(0, n.Length - 4);
      if (n.Length == 0) continue;
      foreach (Process p in Process.GetProcessesByName(n)) {
        try { if (p.MainWindowHandle != IntPtr.Zero) return p; } catch (Exception) {}
      }
    }
    return null;
  }

  static int Focus(IntPtr hWnd) {
    IntPtr fg = GetForegroundWindow();
    uint fgPid;
    uint fgThread = fg != IntPtr.Zero ? GetWindowThreadProcessId(fg, out fgPid) : 0;   // return value IS the thread id
    uint cur = GetCurrentThreadId();
    if (IsIconic(hWnd)) ShowWindowAsync(hWnd, SW_RESTORE);
    if (fgThread != 0 && fgThread != cur) AttachThreadInput(cur, fgThread, true);
    SetForegroundWindow(hWnd);
    if (fgThread != 0 && fgThread != cur) AttachThreadInput(cur, fgThread, false);
    Console.WriteLine("OK");
    return 0;
  }
}
