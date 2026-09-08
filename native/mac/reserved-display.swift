// reserved-display — keeps ordinary application windows off the panel display (macOS port of
// native/reserved-display.cs). [MIT]
//
// Reads the same replaceable configuration snapshots as the Windows helper, JSON lines on stdin
// ({"command":"configure", enabled, suspended, ownProcessId, reserved:{x,y,width,height}|null,
// displays:[{id, primary, bounds, workArea}]} and {"command":"stop"}), and emits concise JSON events
// on stdout. Windows are found with CGWindowList on a 500 ms scan (no hooks) and moved through the
// Accessibility API, which needs the Accessibility permission for the responsible app (Bedrock Panel,
// or the terminal for `npm start`); until it is granted the helper reports that once and keeps scanning.
//
// A window occupies the panel when its center is inside the reserved display or more than half its
// area overlaps it. It goes back to the display it last lived on, else the nearest other display,
// else the primary — same size, kept inside that display's work area. Nothing moves while a mouse
// button is held (a drag in progress); the move happens when the drag ends. Own-process windows,
// non-regular apps (Dock, menu-bar extras, system UI), minimized and off-screen windows are left
// alone. With no other display, eligible windows are minimized and un-minimized onto a display when
// one returns. `suspended` (Monitor Mode) disables enforcement without exiting. Coordinates are the
// global top-left-origin screen points both Electron and CoreGraphics use on macOS.
import Foundation
import AppKit
import ApplicationServices

struct Box: Codable {
    var x: Double; var y: Double; var width: Double; var height: Double
    var rect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
}
struct DisplayInfo: Codable { var id: String; var primary: Bool; var bounds: Box; var workArea: Box }
struct Command: Codable {
    var command: String
    var sequence: Int?
    var enabled: Bool?
    var suspended: Bool?
    var ownProcessId: Int?
    var reserved: Box?
    var displays: [DisplayInfo]?
}

enum AX {
    static func windows(of pid: pid_t) -> [AXUIElement] {
        let app = AXUIElementCreateApplication(pid)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success, let wins = value as? [AXUIElement] else { return [] }
        return wins
    }
    static func frame(_ w: AXUIElement) -> CGRect? {
        var posRef: CFTypeRef?, sizeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(w, kAXPositionAttribute as CFString, &posRef) == .success,
              AXUIElementCopyAttributeValue(w, kAXSizeAttribute as CFString, &sizeRef) == .success,
              let p = posRef, let s = sizeRef else { return nil }
        var pos = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(p as! AXValue, .cgPoint, &pos), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
        return CGRect(origin: pos, size: size)
    }
    /// The AX window of `pid` whose frame matches `rect` (CGWindowList and AX agree to the pixel).
    static func find(pid: pid_t, matching rect: CGRect, tolerance: CGFloat = 3) -> AXUIElement? {
        windows(of: pid).first { w in
            guard let f = frame(w) else { return false }
            return abs(f.minX - rect.minX) <= tolerance && abs(f.minY - rect.minY) <= tolerance && abs(f.width - rect.width) <= tolerance && abs(f.height - rect.height) <= tolerance
        }
    }
    static func move(_ w: AXUIElement, to origin: CGPoint) -> Bool {
        var p = origin
        guard let v = AXValueCreate(.cgPoint, &p) else { return false }
        return AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, v) == .success
    }
    static func setMinimized(_ w: AXUIElement, _ on: Bool) -> Bool {
        AXUIElementSetAttributeValue(w, kAXMinimizedAttribute as CFString, (on ? kCFBooleanTrue : kCFBooleanFalse) as CFTypeRef) == .success
    }
}

@main struct ReservedDisplay {
    struct Win { let id: CGWindowID; let pid: pid_t; let rect: CGRect }
    struct Home { let display: String; let rect: CGRect }

    static var enabled = false
    static var suspended = false
    static var ownPids: Set<pid_t> = [getpid(), getppid()]
    static var reserved: CGRect? = nil
    static var displays: [DisplayInfo] = []
    static var lastHome: [CGWindowID: Home] = [:]           // where each window last lived off the panel
    static var deferred: [CGWindowID: (pid: pid_t, rect: CGRect)] = [:]   // minimized for lack of another display
    static var movedAt: [CGWindowID: Date] = [:]
    static var reportedFailures = Set<CGWindowID>()
    static var permissionReported = false
    static var appCache: [pid_t: Bool] = [:]                 // pid -> is a regular app

    static func emit(_ event: String, _ extra: [String: Any] = [:]) {
        var row: [String: Any] = ["event": event]
        for (k, v) in extra { row[k] = v }
        Out.line(Out.json(row))
    }

    static func isRegularApp(_ pid: pid_t) -> Bool {
        if let cached = appCache[pid] { return cached }
        let regular = NSRunningApplication(processIdentifier: pid)?.activationPolicy == .regular
        appCache[pid] = regular
        return regular
    }

    static func onScreenWindows() -> [Win] {
        let infos = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
        var out: [Win] = []
        for w in infos {
            guard (w[kCGWindowLayer as String] as? Int) == 0,
                  let pidValue = w[kCGWindowOwnerPID as String] as? Int,
                  let number = w[kCGWindowNumber as String] as? Int,
                  let dict = w[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: dict) else { continue }
            let pid = pid_t(pidValue)
            if ownPids.contains(pid) || !isRegularApp(pid) { continue }
            if let alpha = w[kCGWindowAlpha as String] as? Double, alpha < 0.1 { continue }
            if rect.width < 40 || rect.height < 40 { continue }          // tooltips, indicators, helper panels
            out.append(Win(id: CGWindowID(number), pid: pid, rect: rect))
        }
        return out
    }

    static func occupies(_ w: CGRect, _ r: CGRect) -> Bool {
        if r.contains(CGPoint(x: w.midX, y: w.midY)) { return true }
        let i = w.intersection(r)
        return !i.isNull && i.width * i.height > 0.5 * w.width * w.height
    }
    static func distance(_ p: CGPoint, _ r: CGRect) -> CGFloat {
        let dx = max(r.minX - p.x, 0, p.x - r.maxX), dy = max(r.minY - p.y, 0, p.y - r.maxY)
        return (dx * dx + dy * dy).squareRoot()
    }
    static func display(containing p: CGPoint) -> DisplayInfo? { displays.first { $0.bounds.rect.contains(p) } }

    static func target(for win: Win) -> (DisplayInfo, String)? {
        if let home = lastHome[win.id], let d = displays.first(where: { $0.id == home.display }) { return (d, "cached") }
        let c = CGPoint(x: win.rect.midX, y: win.rect.midY)
        if let nearest = displays.min(by: { distance(c, $0.bounds.rect) < distance(c, $1.bounds.rect) }) { return (nearest, "nearest") }
        if let primary = displays.first(where: { $0.primary }) ?? displays.first { return (primary, "primary") }
        return nil
    }

    /// Same size, the remembered spot on that display when there is one, else the same offset the
    /// window had on the panel — always kept inside the display's work area.
    static func placement(_ win: Win, on d: DisplayInfo, reservedRect: CGRect) -> CGPoint {
        let wa = d.workArea.rect
        var origin: CGPoint
        if let home = lastHome[win.id], home.display == d.id { origin = home.rect.origin }
        else { origin = CGPoint(x: wa.minX + (win.rect.minX - reservedRect.minX), y: wa.minY + (win.rect.minY - reservedRect.minY)) }
        origin.x = min(max(origin.x, wa.minX), max(wa.minX, wa.maxX - win.rect.width))
        origin.y = min(max(origin.y, wa.minY), max(wa.minY, wa.maxY - win.rect.height))
        return origin
    }

    static func restoreDeferred() {
        guard !deferred.isEmpty, let d = displays.first(where: { $0.primary }) ?? displays.first else { return }
        for (id, entry) in deferred {
            guard let w = AX.find(pid: entry.pid, matching: entry.rect) else { deferred[id] = nil; continue }
            let fake = Win(id: id, pid: entry.pid, rect: entry.rect)
            let origin = placement(fake, on: d, reservedRect: reserved ?? entry.rect)
            if AX.setMinimized(w, false), AX.move(w, to: origin) { emit("restored", ["hwnd": Int(id)]) }
            deferred[id] = nil
        }
    }

    static func scan() {
        guard enabled, !suspended, let r = reserved else { return }
        let wins = onScreenWindows()
        for w in wins where !occupies(w.rect, r) {
            if let d = display(containing: CGPoint(x: w.rect.midX, y: w.rect.midY)) { lastHome[w.id] = Home(display: d.id, rect: w.rect) }
        }
        let offenders = wins.filter { occupies($0.rect, r) }
        if offenders.isEmpty { restoreDeferred(); return }
        guard AXIsProcessTrusted() else {
            if !permissionReported {
                permissionReported = true
                emit("permission", ["message": "Accessibility permission is needed to move windows off the panel — System Settings → Privacy & Security → Accessibility (Bedrock Panel, or the terminal app for npm start)"])
            }
            return
        }
        if CGEventSource.buttonState(.combinedSessionState, button: .left) { return }   // a drag is in progress
        let now = Date()
        for w in offenders {
            if let t = movedAt[w.id], now.timeIntervalSince(t) < 2 { continue }   // give an app that snaps back a moment
            guard let ax = AX.find(pid: w.pid, matching: w.rect) else {
                if !reportedFailures.contains(w.id) { reportedFailures.insert(w.id); emit("move-failed", ["hwnd": Int(w.id), "message": "window not addressable through Accessibility"]) }
                continue
            }
            movedAt[w.id] = now
            if let (d, how) = target(for: w) {
                let origin = placement(w, on: d, reservedRect: r)
                if AX.move(ax, to: origin) {
                    lastHome[w.id] = Home(display: d.id, rect: CGRect(origin: origin, size: w.rect.size))
                    emit("moved", ["hwnd": Int(w.id), "fallback": how])
                } else if !reportedFailures.contains(w.id) { reportedFailures.insert(w.id); emit("move-failed", ["hwnd": Int(w.id)]) }
            } else if AX.setMinimized(ax, true) {
                deferred[w.id] = (w.pid, w.rect)
                emit("minimized", ["hwnd": Int(w.id)])
            }
        }
    }

    static func apply(_ c: Command) {
        if c.command == "stop" { exit(0) }
        guard c.command == "configure" else { return }
        enabled = c.enabled ?? false
        suspended = c.suspended ?? false
        if let own = c.ownProcessId { ownPids.insert(pid_t(own)) }
        reserved = c.reserved?.rect
        displays = c.displays ?? []
        appCache.removeAll()
        emit("configured", ["sequence": c.sequence ?? 0, "enabled": enabled, "suspended": suspended, "displays": displays.count])
    }

    static func main() {
        Out.setup()
        let decoder = JSONDecoder()
        Thread.detachNewThread {
            while let line = readLine() {
                guard let data = line.data(using: .utf8), let c = try? decoder.decode(Command.self, from: data) else { continue }
                DispatchQueue.main.async { apply(c) }
            }
            exit(0)                                  // stdin closed: the app is gone
        }
        let t = DispatchSource.makeTimerSource(queue: .main)
        t.schedule(deadline: .now() + 0.5, repeating: 0.5)
        t.setEventHandler { scan() }
        t.resume()
        emit("ready")
        dispatchMain()
    }
}
