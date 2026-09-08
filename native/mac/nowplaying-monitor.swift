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
// Browser players and other apps are not covered. Music.app's position is not in its notification,
// so it reports 0 until the AppleScript enrichment (Automation permission) is added.
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
        emit()                                    // "{}" until a player posts (an idle session manager)
        RunLoop.main.run()
    }
}
