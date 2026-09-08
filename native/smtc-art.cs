// smtc-art.exe — prints the current SMTC session's album-art thumbnail to stdout as base64
// (empty output if nothing is playing or the track has no art). [MIT]
//
// Bedrock Panel's now-playing text comes from PowerShell, but the SMTC thumbnail is a WinRT stream that
// Windows PowerShell 5.1 can't read (it returns an unprojected COM object). This tiny .NET-Framework
// helper reads it natively. Build: csc against the Windows union metadata (see package.json build:smtc).
using System;
using System.Threading.Tasks;
using Windows.Media.Control;
using Windows.Storage.Streams;

class SmtcArt {
    static int Main(string[] args) {
        try {
            string appId = args.Length > 0 ? args[0] : null;   // optional: target the session now-playing chose
            byte[] bytes = GetArtAsync(appId).GetAwaiter().GetResult();
            if (bytes != null && bytes.Length > 0)
                Console.Out.Write(Convert.ToBase64String(bytes));
            return 0;
        } catch {
            return 1;   // any failure -> empty stdout, caller falls back to no art
        }
    }

    static async Task<byte[]> GetArtAsync(string appId) {
        var mgr = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
        var session = FindSession(mgr, appId);
        if (session == null) return null;
        var props = await session.TryGetMediaPropertiesAsync();
        var thumb = props.Thumbnail;
        if (thumb == null) return null;
        using (var stream = await thumb.OpenReadAsync()) {
            uint size = (uint)stream.Size;
            if (size == 0) return null;
            var reader = new DataReader(stream);
            await reader.LoadAsync(size);
            byte[] bytes = new byte[size];
            reader.ReadBytes(bytes);
            return bytes;
        }
    }

    // Prefer the session matching the app id now-playing chose (the playing one), else the OS current.
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
