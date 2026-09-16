// sysvolume.exe — the Windows default render device's master volume as an integer 0..100.
// Used by the meeting console's OUTPUT rail so the level display is a REAL read, never a fabricated
// number. Prints "-1" if it can't read it, so the caller shows "—". [MIT]
//
// Modes:
//   (no args)  one-shot: print "LEVEL MUTE" once and exit (LEVEL 0-100 or -1; MUTE 1/0/-1). Used by the
//              settings editor's mic/speaker test to read the level and the mute flag together.
//   watch      long-running: print a line whenever the volume changes (first read prints
//              immediately), checking in-process once a second. This replaced the panel poll
//              spawning this exe ~60×/min — endpoint-security tools flag that much process
//              creation as malware-like churn; one persistent helper is invisible. The default
//              endpoint is re-acquired on every tick so device switches are always honored.
//              Exits when stdin closes (parent died).
//
// Raw Core Audio COM interop (no NuGet), same .NET-Framework csc toolchain as the other helpers —
// vtable order below is load-bearing; unused slots are stubbed to hold their position.
using System;
using System.Runtime.InteropServices;
using System.Threading;

class SysVolume {
    enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
    enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }
    const int CLSCTX_ALL = 0x17;

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumerator { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator {
        void EnumAudioEndpoints();   // slot 1 (unused)
        void GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice device);   // slot 2
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice {
        void Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
            [MarshalAs(UnmanagedType.IUnknown)] out object iface);   // slot 1
    }

    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioEndpointVolume {
        void RegisterControlChangeNotify();     // 1
        void UnregisterControlChangeNotify();   // 2
        void GetChannelCount();                 // 3
        void SetMasterVolumeLevel();            // 4
        void SetMasterVolumeLevelScalar();      // 5
        void GetMasterVolumeLevel();            // 6
        void GetMasterVolumeLevelScalar(out float level);   // 7
        void GetChannelVolumeLevel();           // 8  (unused — holds vtable position)
        void GetChannelVolumeLevelScalar();     // 9  (unused)
        void SetChannelVolumeLevel();           // 10 (unused)
        void SetChannelVolumeLevelScalar();     // 11 (unused)
        void SetMute();                         // 12 (unused)
        void GetMute(out int muted);            // 13 — BOOL: nonzero = muted
    }

    static Guid IID_IAudioEndpointVolume = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");

    static int ReadVolume() {
        try {
            IMMDeviceEnumerator devEnum = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
            IMMDevice dev; devEnum.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eConsole, out dev);
            object volObj; dev.Activate(ref IID_IAudioEndpointVolume, CLSCTX_ALL, IntPtr.Zero, out volObj);
            IAudioEndpointVolume vol = (IAudioEndpointVolume)volObj;
            float level; vol.GetMasterVolumeLevelScalar(out level);
            Marshal.FinalReleaseComObject(volObj);
            Marshal.FinalReleaseComObject(dev);
            Marshal.FinalReleaseComObject(devEnum);
            int pct = (int)Math.Round(level * 100f);
            if (pct < 0) pct = 0; if (pct > 100) pct = 100;
            return pct;
        } catch {
            return -1;
        }
    }

    // 1 = muted, 0 = not muted, -1 = unreadable. Mute is a SEPARATE flag from the volume level, so a
    // device muted at level 50 still reports level 50 — this is the read the level-only path was missing.
    static int ReadMuted() {
        try {
            IMMDeviceEnumerator devEnum = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
            IMMDevice dev; devEnum.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eConsole, out dev);
            object volObj; dev.Activate(ref IID_IAudioEndpointVolume, CLSCTX_ALL, IntPtr.Zero, out volObj);
            IAudioEndpointVolume vol = (IAudioEndpointVolume)volObj;
            int muted; vol.GetMute(out muted);
            Marshal.FinalReleaseComObject(volObj);
            Marshal.FinalReleaseComObject(dev);
            Marshal.FinalReleaseComObject(devEnum);
            return muted != 0 ? 1 : 0;
        } catch {
            return -1;
        }
    }

    static int Main(string[] args) {
        if (args.Length > 0 && args[0] == "watch") {
            Thread stdinWatch = new Thread(delegate() {
                try { while (Console.In.Read() != -1) {} } catch (Exception) {}
                Environment.Exit(0);
            });
            stdinWatch.IsBackground = true;
            stdinWatch.Start();
            int last = int.MinValue;
            while (true) {
                int pct = ReadVolume();
                if (pct != last) { last = pct; Console.WriteLine(pct); }
                Thread.Sleep(1000);
            }
        }
        // One-shot: "LEVEL MUTE" (LEVEL 0-100 or -1; MUTE 1/0/-1) for the settings editor's audio test.
        int once = ReadVolume();
        int mute = ReadMuted();
        Console.Out.Write(once + " " + mute);
        return (once < 0 && mute < 0) ? 1 : 0;
    }
}
