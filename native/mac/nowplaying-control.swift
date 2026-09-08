// nowplaying-control — media transport for the Music page, aimed at the player the now-playing
// display is showing (macOS port of native/smtc-control.cs). [MIT]
//
// One-shot: `nowplaying-control <playpause|play|pause|next|prev|previous> [app]` where `app` is a
// bundle id ("com.spotify.client"), an app name, or a Windows-style token, resolved through
// AppAliases; without it, the first running player (Spotify, then Music) is used. Only apps that are
// already running are addressed — an AppleScript `tell` would otherwise launch them. Prints "ok" and
// exits 0 on success; exits 1 when no player is running or the command was refused, and the caller
// falls back to a media key. The first use prompts for the Automation permission (the embedded
// Info.plist section carries the usage string; the app's own Info.plist has it too).
import Foundation
import AppKit

@main struct NowPlayingControl {
    struct Player { let bundleId: String; let names: [String] }
    static let players = [Player(bundleId: "com.spotify.client", names: ["spotify"]), Player(bundleId: "com.apple.Music", names: ["music", "itunes"])]

    static func isRunning(_ bundleId: String) -> Bool { !NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).isEmpty }

    static func target(_ hint: String?) -> String? {
        if let h = hint, !h.isEmpty {
            let n = AppAliases.normalize(h)
            for p in players {
                let byAlias = (AppAliases.bundleIds[n] ?? []).contains { $0.lowercased() == p.bundleId.lowercased() }
                if p.bundleId.lowercased() == n || p.names.contains(n) || byAlias { return isRunning(p.bundleId) ? p.bundleId : nil }
            }
        }
        return players.first(where: { isRunning($0.bundleId) })?.bundleId
    }

    static func main() {
        Out.setup()
        let args = Array(CommandLine.arguments.dropFirst())
        let verbs = ["playpause": "playpause", "play": "play", "pause": "pause", "next": "next track", "prev": "previous track", "previous": "previous track"]
        guard let cmd = args.first?.lowercased(), let verb = verbs[cmd] else {
            Out.err("usage: nowplaying-control playpause|play|pause|next|prev [app]"); exit(2)
        }
        guard let bundleId = target(args.count > 1 ? args[1] : nil) else { exit(1) }
        var error: NSDictionary?
        guard let script = NSAppleScript(source: "tell application id \"\(bundleId)\" to \(verb)") else { exit(1) }
        script.executeAndReturnError(&error)
        if let e = error { Out.err("AppleScript failed: \(e)"); exit(1) }
        print("ok", terminator: ""); fflush(stdout)
    }
}
