// nowplaying-monitor — persistent now-playing monitor for the Music page (macOS port of
// native/smtc-monitor.cs). [MIT]
//
// macOS has no public equivalent of Windows' media session manager (MediaRemote is private and
// blocked for third-party processes since 15.4), so this listens to the distributed notifications
// the two big players post on every state change, with no permission at all:
//   Spotify   com.spotify.client.PlaybackStateChanged   Name, Artist, Album, Player State,
//                                                       Playback Position (s), Duration (ms), Track ID
//   Music     com.apple.Music.playerInfo (+ the legacy com.apple.iTunes.playerInfo name)
//                                                       Name, Artist, Album, Player State, Total Time (ms)
// Browser players and other apps are not covered. A player that is already running when we start
// posts nothing until something changes, so it is asked once through AppleScript (Automation
// permission, the grant the transport buttons use) — at start, when it launches, and every 10 s as
// a safety net; the same query gives Music.app's position, which its notification lacks.
//
// Protocol: one JSON line on every change — the same fields as the Windows helper
// {title, artist, album, status, app, position, duration} plus bundleId and trackId (Spotify),
// status normalised to Playing | Paused | Stopped — or "{}" when no player has a track. Prefers the
// app that is actually Playing, else the one that changed last; a source whose app has quit is
// dropped by a 1 s liveness tick. Exits when stdin closes (parent died).
import Foundation
import AppKit

@main struct NowPlayingMonitor {
    struct Track {
        var title: String
        var artist: String?
        var album: String?
        var status: String
        var position: Double
        var duration: Double
        var trackId: String?
        var changedAt: Date
    }
    struct Source { let bundleId: String; let app: String; let notification: String }
    static let sources = [
        Source(bundleId: "com.spotify.client", app: "Spotify", notification: "com.spotify.client.PlaybackStateChanged"),
        Source(bundleId: "com.apple.Music", app: "Music", notification: "com.apple.Music.playerInfo"),
        Source(bundleId: "com.apple.Music", app: "Music", notification: "com.apple.iTunes.playerInfo"),
    ]
    static var tracks: [String: Track] = [:]     // by bundle id
    static var last = ""

    static func status(_ raw: Any?) -> String {
        switch ((raw as? String) ?? "").lowercased() {
        case "playing": return "Playing"
        case "paused": return "Paused"
        default: return "Stopped"
        }
    }
    static func seconds(_ raw: Any?, divisor: Double = 1) -> Double? {
        if let d = raw as? Double { return d / divisor }
        if let i = raw as? Int { return Double(i) / divisor }
        if let n = raw as? NSNumber { return n.doubleValue / divisor }
        return nil
    }

    static func handle(_ source: Source, _ info: [AnyHashable: Any]) {
        guard let title = info["Name"] as? String, !title.isEmpty else {
            tracks[source.bundleId] = nil        // player stopped / cleared its track
            emit(); return
        }
        var duration = seconds(info["Duration"], divisor: 1000) ?? 0
        if let total = seconds(info["Total Time"], divisor: 1000) { duration = total }
        tracks[source.bundleId] = Track(
            title: title,
            artist: info["Artist"] as? String,
            album: info["Album"] as? String,
            status: status(info["Player State"]),
            position: seconds(info["Playback Position"]) ?? 0,
            duration: duration,
            trackId: info["Track ID"] as? String,
            changedAt: Date())
        emit()
    }

    // ---- AppleScript state query: initial state, player launch, 10 s safety net ---------------
    // Apple Events need the Automation permission ("Bedrock Panel wants to control Spotify/Music");
    // a refusal (-1743) or an undecidable prompt (-1744) is logged once and that player is then left
    // to its notifications for the rest of the run, so nobody is nagged.
    static var refused: Set<String> = []
    static var queried: [String: Source] { Dictionary(sources.map { ($0.bundleId, $0) }, uniquingKeysWith: { a, _ in a }) }
    static func query(_ source: Source) {
        guard !refused.contains(source.bundleId),
              !NSRunningApplication.runningApplications(withBundleIdentifier: source.bundleId).isEmpty else { return }
        let isSpotify = source.bundleId == "com.spotify.client"
        // Spotify: duration in ms, `spotify url` = the track id the art lookup uses. Music: duration in s.
        let script = """
        tell application id "\(source.bundleId)"
            if player state is stopped then return ""
            set t to current track
            return (player state as string) & linefeed & (name of t) & linefeed & (artist of t) & linefeed & (album of t) & linefeed & \(isSpotify ? "(duration of t)" : "((duration of t) * 1000)") & linefeed & (player position) & linefeed & \(isSpotify ? "(spotify url of t)" : "\"\"")
        end tell
        """
        var err: NSDictionary?
        guard let s = NSAppleScript(source: script) else { return }
        let result = s.executeAndReturnError(&err)
        if let e = err {
            let code = (e[NSAppleScript.errorNumber] as? Int) ?? 0
            if code == -1743 || code == -1744 { refused.insert(source.bundleId) }
            Out.err("\(source.app): state query failed (\(code)): \(e[NSAppleScript.errorMessage] ?? "")")
            return
        }
        let parts = (result.stringValue ?? "").components(separatedBy: "\n")
        if parts.count < 6 || parts[1].isEmpty { handle(source, [:]); return }   // stopped: no track
        handle(source, ["Player State": parts[0], "Name": parts[1], "Artist": parts[2], "Album": parts[3],
                        "Duration": Double(parts[4]) ?? 0, "Playback Position": Double(parts[5]) ?? 0, "Track ID": parts.count > 6 ? parts[6] : ""])
    }
    static func queryAll() { for source in queried.values { query(source) } }

    static func chosen() -> (String, Track)? {
        if let p = tracks.first(where: { $0.value.status == "Playing" }) { return (p.key, p.value) }
        return tracks.max(by: { $0.value.changedAt < $1.value.changedAt }).map { ($0.key, $0.value) }
    }

    static func emit() {
        var line = "{}"
        if let (bundleId, t) = chosen() {
            var row: [String: Any] = [
                "title": t.title, "artist": t.artist ?? "", "album": t.album ?? "",
                "status": t.status, "app": sources.first(where: { $0.bundleId == bundleId })?.app ?? bundleId,
                "position": t.position, "duration": t.duration, "bundleId": bundleId,
            ]
            if let id = t.trackId { row["trackId"] = id }
            line = Out.json(row)
        }
        if line != last { last = line; Out.line(line) }
    }

    static func liveness() {
        var changed = false
        for bundleId in Array(tracks.keys) where NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).isEmpty {
            tracks[bundleId] = nil; changed = true
        }
        if changed { emit() }
    }

    static func main() {
        Out.setup()
        ParentGuard.exitOnStdinEOF()
        let center = DistributedNotificationCenter.default()
        for source in sources {
            center.addObserver(forName: Notification.Name(source.notification), object: nil, queue: .main) { n in
                handle(source, n.userInfo ?? [:])
            }
        }
        let t = DispatchSource.makeTimerSource(queue: .main)
        t.schedule(deadline: .now() + 1, repeating: 1.0)
        t.setEventHandler { liveness() }
        t.resume()
        // A player launched later is asked once it is scriptable (a few seconds in); the 10 s poll covers
        // the rest: a missed notification, position drift for the progress bar.
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { n in
            guard let app = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication, let id = app.bundleIdentifier, let source = queried[id] else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { query(source) }
        }
        let poll = DispatchSource.makeTimerSource(queue: .main)
        poll.schedule(deadline: .now() + 10, repeating: 10.0)
        poll.setEventHandler { queryAll() }
        poll.resume()
        emit()                                    // "{}" until a player answers or posts
        queryAll()                                // what is playing right now, before any change
        RunLoop.main.run()
    }
}
