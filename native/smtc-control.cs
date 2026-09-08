// smtc-control.exe — send a transport command to a Windows SMTC session, targeting the SAME session
// the now-playing display reads (matched by app id, else the OS "current" session). Prints "ok" on
// success; exit 1 on any miss so the caller can fall back. [MIT]
//
// Why: Bedrock Panel's transport used to tap global media keys (audio_play/next/prev), which Windows routes
// to whatever app holds media-key priority — not necessarily the session shown in the now-playing
// display. With several players open (e.g. Audiobookshelf + Music Assistant) that splits the controls
// from what's shown. Driving the specific SMTC session keeps control and display on the same source.
// Build: csc against the Windows union metadata (see build-smtc.js).
using System;
using System.Threading.Tasks;
using Windows.Media.Control;

class SmtcControl {
    static int Main(string[] args) {
        try {
            if (args.Length < 1) return 2;
            string cmd = args[0].ToLowerInvariant();
            string appId = args.Length > 1 ? args[1] : null;
            bool ok = RunAsync(cmd, appId).GetAwaiter().GetResult();
            if (ok) { Console.Out.Write("ok"); return 0; }
            return 1;
        } catch {
            return 1;   // any failure -> caller falls back to the media key
        }
    }

    static async Task<bool> RunAsync(string cmd, string appId) {
        var mgr = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
        var session = FindSession(mgr, appId);
        if (session == null) return false;
        switch (cmd) {
            case "playpause": return await session.TryTogglePlayPauseAsync();
            case "play":      return await session.TryPlayAsync();
            case "pause":     return await session.TryPauseAsync();
            case "next":      return await session.TrySkipNextAsync();
            case "prev":
            case "previous":  return await session.TrySkipPreviousAsync();
            default:          return false;
        }
    }

    // Prefer the session whose SourceAppUserModelId matches what the display is showing; fall back to the
    // OS "current" session if no app id was passed or no match is found.
    static GlobalSystemMediaTransportControlsSession FindSession(
        GlobalSystemMediaTransportControlsSessionManager mgr, string appId) {
        if (!string.IsNullOrEmpty(appId)) {
            try {
                foreach (var s in mgr.GetSessions()) {
                    if (s != null && string.Equals(s.SourceAppUserModelId, appId, StringComparison.OrdinalIgnoreCase))
                        return s;
                }
            } catch { }
        }
        return mgr.GetCurrentSession();
    }
}
