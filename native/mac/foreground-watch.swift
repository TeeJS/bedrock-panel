// foreground-watch — foreground-app tracking + window find/focus/list (macOS port of
// native/foreground-watch.cs). [MIT]
//
// Modes (first argument):
//   watch            long-running: prints the frontmost app's name to stdout, one line per change
//                    (NSWorkspace activation notifications, with a 2 s safety poll). Prints the
//                    current app immediately on start. Exits when stdin closes (parent died).
//   list             one-shot: JSON array of {Hwnd, ProcessName, MainWindowTitle, Minimized} for
//                    every normal window of a regular app (CGWindowList, layer 0), one entry PER
//                    WINDOW. Hwnd is the CGWindowID, which is what Electron's desktopCapturer uses in
//                    its "window:<id>:0" source ids. Window titles need the Screen Recording
//                    permission; without it the owner's name stands in so pickers still list entries.
//                    Our own parent's windows (Bedrock Panel) are left out.
//   find <name...>   one-shot: "OK" (exit 0) if any named app is running, else "NOTFOUND" (exit 1).
//                    Names are matched like the Windows helper's ("Teams", "ms-teams.exe") through
//                    AppAliases, so Windows-authored settings keep working.
//   focus <name...>  one-shot: bring the first named app to the front ("OK"/"NOTFOUND"). Uses
//                    NSWorkspace's activation (what still works from a background process under
//                    macOS 14's cooperative activation rules), then unhide + activate as a fallback.
import Foundation
import AppKit

@main struct ForegroundWatch {
    static func appAliases(_ app: NSRunningApplication) -> Set<String> {
        AppAliases.aliases(name: app.localizedName, executable: app.executableURL?.lastPathComponent, bundleId: app.bundleIdentifier)
    }

    static func findApp(_ names: [String]) -> NSRunningApplication? {
        let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
        for name in names {
            if let hit = apps.first(where: { AppAliases.matches(token: name, appAliases: appAliases($0), bundleId: $0.bundleIdentifier) }) { return hit }
        }
        return nil
    }

    static func printFront(_ last: inout String?) {
        guard let app = NSWorkspace.shared.frontmostApplication, let name = app.localizedName, !name.isEmpty else { return }
        if name != last { last = name; Out.line(name) }
    }

    static func watch() {
        ParentGuard.exitOnStdinEOF()
        var last: String? = nil
        printFront(&last)
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { _ in
            printFront(&last)
        }
        let t = DispatchSource.makeTimerSource(queue: .main)     // safety net if a notification is missed
        t.schedule(deadline: .now() + 2, repeating: 2.0)
        t.setEventHandler { printFront(&last) }
        t.resume()
        RunLoop.main.run()
    }

    static func list() {
        let parent = getppid()
        var rows: [[String: Any]] = []
        let infos = (CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
        var appCache: [pid_t: NSRunningApplication?] = [:]
        for w in infos {
            guard (w[kCGWindowLayer as String] as? Int) == 0,
                  let pid = w[kCGWindowOwnerPID as String] as? pid_t, pid != parent,
                  let number = w[kCGWindowNumber as String] as? Int else { continue }
            let app: NSRunningApplication?
            if let cached = appCache[pid] { app = cached } else { app = NSRunningApplication(processIdentifier: pid); appCache[pid] = app }
            guard let a = app, a.activationPolicy == .regular else { continue }
            let owner = (w[kCGWindowOwnerName as String] as? String) ?? a.localizedName ?? ""
            let title = (w[kCGWindowName as String] as? String) ?? ""
            let onscreen = (w[kCGWindowIsOnscreen as String] as? Bool) ?? false
            rows.append([
                "Hwnd": number,
                "ProcessName": a.localizedName ?? owner,
                "MainWindowTitle": title.isEmpty ? owner : title,
                "Minimized": !onscreen,
            ])
        }
        Out.line(Out.json(rows))
    }

    static func focus(_ app: NSRunningApplication) -> Bool {
        var ok = false
        if let url = app.bundleURL {
            let cfg = NSWorkspace.OpenConfiguration()
            cfg.activates = true
            let done = DispatchSemaphore(value: 0)
            NSWorkspace.shared.openApplication(at: url, configuration: cfg) { running, error in
                ok = running != nil && error == nil
                done.signal()
            }
            _ = done.wait(timeout: .now() + 2.0)
        }
        if app.isHidden { app.unhide() }
        if !ok { ok = app.activate(options: [.activateAllWindows]) }
        return ok
    }

    static func main() {
        Out.setup()
        let args = Array(CommandLine.arguments.dropFirst())
        let mode = args.first ?? "watch"
        switch mode {
        case "watch": watch()
        case "list": list()
        case "find", "focus":
            let names = Array(args.dropFirst()).filter { !$0.isEmpty }
            guard let app = findApp(names) else { Out.line("NOTFOUND"); exit(1) }
            if mode == "focus" && !focus(app) { Out.line("NOTFOUND"); exit(1) }
            Out.line("OK")
        default:
            Out.err("usage: foreground-watch watch|list|find <name...>|focus <name...>")
            exit(2)
        }
    }
}
