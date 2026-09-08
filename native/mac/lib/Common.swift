// Common.swift — shared runtime bits for the macOS helper binaries under native/mac. [MIT]
//
// Every helper is a small standalone Mach-O compiled by build-mac-helpers.js and spawned by the
// main process, mirroring the Windows C# helpers: JSON or plain lines on stdout, diagnostics on
// stderr, and a parent-death guard so a helper can never outlive Bedrock Panel.
import Foundation

enum Out {
    /// stdout is a pipe when we are spawned, and pipes are fully buffered by default — without this
    /// the JS side would see nothing until the helper exits.
    static func setup() { setvbuf(stdout, nil, _IOLBF, 0) }
    static func line(_ s: String) { print(s); fflush(stdout) }
    static func err(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

    static func json(_ obj: [String: Any]) -> String {
        guard JSONSerialization.isValidJSONObject(obj),
              let d = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
              let s = String(data: d, encoding: .utf8) else { return "{}" }
        return s
    }
    static func json(_ arr: [[String: Any]]) -> String {
        guard JSONSerialization.isValidJSONObject(arr),
              let d = try? JSONSerialization.data(withJSONObject: arr, options: [.sortedKeys]),
              let s = String(data: d, encoding: .utf8) else { return "[]" }
        return s
    }
}

enum ParentGuard {
    /// For helpers the wrapper spawns with stdin piped: EOF means the app is gone (or is shutting us
    /// down), so exit. Runs on a background thread; the caller keeps the main run loop.
    static func exitOnStdinEOF() {
        Thread.detachNewThread {
            let h = FileHandle.standardInput
            while true {
                let d = h.availableData          // blocks until data or EOF
                if d.isEmpty { exit(0) }
            }
        }
    }
    /// For helpers spawned with stdin ignored: an orphan is re-parented to launchd (pid 1).
    static func exitWhenOrphaned(every seconds: Double = 1.0) {
        let t = DispatchSource.makeTimerSource(queue: .global())
        t.schedule(deadline: .now() + seconds, repeating: seconds)
        t.setEventHandler { if getppid() == 1 { exit(0) } }
        t.resume()
        orphanTimer = t
    }
    private static var orphanTimer: DispatchSourceTimer?
}

/// Windows process-name tokens the editor and the meeting defaults still use ("Zoom.exe",
/// "ms-teams.exe", "chrome"), mapped to the macOS bundle ids they mean, so a config authored on
/// Windows keeps working on a Mac. Extend as apps are verified.
enum AppAliases {
    static let bundleIds: [String: [String]] = [
        "zoom": ["us.zoom.xos"],
        "teams": ["com.microsoft.teams2", "com.microsoft.teams"],
        "ms-teams": ["com.microsoft.teams2", "com.microsoft.teams"],
        "msteams": ["com.microsoft.teams2", "com.microsoft.teams"],
        "discord": ["com.hnc.Discord"],
        "slack": ["com.tinyspeck.slackmacgap"],
        "webex": ["Cisco-Systems.Spark"],
        "chrome": ["com.google.Chrome"],
        "msedge": ["com.microsoft.edgemac"],
        "firefox": ["org.mozilla.firefox"],
        "safari": ["com.apple.Safari"],
        "outlook": ["com.microsoft.Outlook"],
        "olk": ["com.microsoft.Outlook"],
        "winword": ["com.microsoft.Word"],
        "excel": ["com.microsoft.Excel"],
        "powerpnt": ["com.microsoft.Powerpoint"],
        "onenote": ["com.microsoft.onenote.mac"],
        "spotify": ["com.spotify.client"],
        "music": ["com.apple.Music"],
        "facetime": ["com.apple.FaceTime"],
        "quicktime player": ["com.apple.QuickTimePlayerX"],
        "quicktimeplayer": ["com.apple.QuickTimePlayerX"],
        "obs": ["com.obsproject.obs-studio"],
        "obs64": ["com.obsproject.obs-studio"],
    ]

    /// "Zoom.exe" / "ms-teams.exe" / "Microsoft Teams" -> "zoom" / "ms-teams" / "microsoft teams".
    static func normalize(_ token: String) -> String {
        var t = token.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        for suffix in [".exe", ".app"] where t.hasSuffix(suffix) { t.removeLast(suffix.count) }
        return t
    }

    /// Everything a running app can be called by, lowercased: localized name, executable name,
    /// bundle id, and the bundle id's last component ("teams2", "Discord").
    static func aliases(name: String?, executable: String?, bundleId: String?) -> Set<String> {
        var out = Set<String>()
        if let n = name { out.insert(normalize(n)) }
        if let e = executable { out.insert(normalize(e)) }
        if let b = bundleId {
            out.insert(b.lowercased())
            if let last = b.split(separator: ".").last { out.insert(String(last).lowercased()) }
        }
        return out
    }

    /// Does a user token ("Teams.exe") name this app (aliases from `aliases(...)`)?
    static func matches(token: String, appAliases: Set<String>, bundleId: String?) -> Bool {
        let t = normalize(token)
        if t.isEmpty { return false }
        if appAliases.contains(t) { return true }
        if let b = bundleId?.lowercased(), let ids = bundleIds[t], ids.contains(where: { $0.lowercased() == b }) { return true }
        return false
    }
}
