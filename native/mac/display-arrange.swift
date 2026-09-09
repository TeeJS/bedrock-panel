// display-arrange — keep the DK-QUAKE where a panel display belongs in the macOS arrangement: not
// mirrored, not the main display, and at the far right of every other display. The same policy
// DK-Suite's own display_manager tool applies, with its exit codes. [MIT]
//
//   display-arrange check   -> one JSON line describing the arrangement. Exit 0 = valid, 2 = the panel
//                              display is mirrored (or another display mirrors it), 3 = the position or
//                              the main-display role needs a fix, 4 = no panel display, 1 = error.
//   display-arrange fix     -> applies the changes (un-mirror, demote from main, move far right) and
//                              prints the same JSON with "changed": [...]. Exit 0, or 1 on error.
//
// Why: with "Displays have separate Spaces" (the default), the display that was clicked last owns the
// active menu bar and receives new windows. A 1920x480 strip arranged under a big display is in the
// cursor's way — moving the cursor down off that display drops it onto the panel, and the next click
// makes the panel the active display, so app menus open behind the panel. Parked at the far right of
// the other displays, at the main display's top, it stays out of the cursor's path. A mirrored panel
// display shows a copy of another display instead of the panel, and a panel display that is the
// main display carries the menu bar, the Dock, and every new window. Only the panel display is
// moved; the other displays keep their relative layout, rotation and resolution are never touched,
// and the arrangement is written permanently (it is what System Settings → Displays would store).
// No permission is involved.
import Foundation
import AppKit
import CoreGraphics

struct DisplayInfo {
    let id: CGDirectDisplayID
    let bounds: CGRect            // points, global coordinates (main display's top-left at 0,0)
    let name: String
    let main: Bool
    let builtin: Bool
    let mirrorOf: CGDirectDisplayID   // kCGNullDirectDisplay when not mirroring another display
    let isPanel: Bool
}

@main struct DisplayArrange {
    // The DK-QUAKE's EDID identity (DisplayVendorID 2533 / DisplayProductID 1433) and its panel size,
    // which is 1920x480 in landscape and 480x1920 when macOS shows it unrotated.
    static let panelVendor: UInt32 = 0x09E5
    static let panelModel: UInt32 = 0x0599

    static func onlineDisplays() -> [CGDirectDisplayID] {
        var count: UInt32 = 0
        var ids = [CGDirectDisplayID](repeating: 0, count: 32)
        guard CGGetOnlineDisplayList(32, &ids, &count) == .success else { return [] }
        return Array(ids.prefix(Int(count)))
    }

    static func names() -> [CGDirectDisplayID: String] {
        var out: [CGDirectDisplayID: String] = [:]
        for s in NSScreen.screens {
            if let n = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber {
                out[CGDirectDisplayID(n.uint32Value)] = s.localizedName
            }
        }
        return out
    }

    static func isPanelSize(_ w: Int, _ h: Int) -> Bool { (w == 1920 && h == 480) || (w == 480 && h == 1920) }

    static func gather() -> [DisplayInfo] {
        let nm = names()
        return onlineDisplays().map { id in
            let b = CGDisplayBounds(id)
            let name = nm[id] ?? ""
            let mirrorOf = CGDisplayMirrorsDisplay(id)
            var isPanel = name.uppercased().contains("DK-QUAKE")
                || (CGDisplayVendorNumber(id) == panelVendor && CGDisplayModelNumber(id) == panelModel)
            if !isPanel, mirrorOf == kCGNullDirectDisplay { isPanel = isPanelSize(Int(b.width.rounded()), Int(b.height.rounded())) }
            if !isPanel, let mode = CGDisplayCopyDisplayMode(id) { isPanel = isPanelSize(mode.pixelWidth, mode.pixelHeight) || isPanelSize(mode.width, mode.height) }
            return DisplayInfo(id: id, bounds: b, name: name, main: CGDisplayIsMain(id) != 0, builtin: CGDisplayIsBuiltin(id) != 0, mirrorOf: mirrorOf, isPanel: isPanel)
        }
    }

    static func rect(_ r: CGRect) -> [String: Any] {
        ["x": Int(r.origin.x.rounded()), "y": Int(r.origin.y.rounded()), "width": Int(r.width.rounded()), "height": Int(r.height.rounded())]
    }

    struct Analysis {
        let all: [DisplayInfo]
        let panel: DisplayInfo?
        let others: [DisplayInfo]        // every non-panel display
        let laidOut: [DisplayInfo]       // non-panel displays with their own bounds (not mirroring anything)
        let preferredMain: DisplayInfo?  // the display that should own (0,0)
        let mirrored: Bool
        let panelIsMain: Bool
        let farRight: Bool
        let rightmost: Int
        var code: Int32 {
            guard panel != nil else { return 4 }
            if others.isEmpty { return 0 }
            if mirrored { return 2 }
            if panelIsMain || !farRight { return 3 }
            return 0
        }
        func json(changed: [String]? = nil) -> [String: Any] {
            var o: [String: Any] = [
                "displays": all.map { d -> [String: Any] in
                    ["id": Int(d.id), "name": d.name, "bounds": rect(d.bounds), "main": d.main, "builtin": d.builtin,
                     "mirrorOf": d.mirrorOf == kCGNullDirectDisplay ? 0 : Int(d.mirrorOf), "panel": d.isPanel]
                },
                "panel": panel.map { ["id": Int($0.id), "name": $0.name, "bounds": rect($0.bounds)] } ?? NSNull(),
                "mirrored": mirrored,
                "panelIsMain": panelIsMain,
                "farRight": farRight,
                "rightmost": rightmost,
                "valid": code == 0,
                "code": Int(code),
            ]
            if let c = changed { o["changed"] = c }
            return o
        }
    }

    static func analyze() -> Analysis {
        let all = gather()
        let panel = all.first { $0.isPanel }
        let others = all.filter { !$0.isPanel }
        let laidOut = others.filter { $0.mirrorOf == kCGNullDirectDisplay }
        let preferred = laidOut.first { $0.main } ?? laidOut.first { $0.builtin }
            ?? laidOut.max { $0.bounds.width * $0.bounds.height < $1.bounds.width * $1.bounds.height }
        var mirrored = false, panelIsMain = false, farRight = true
        var rightmost = 0
        if let p = panel, !others.isEmpty {
            mirrored = p.mirrorOf != kCGNullDirectDisplay || others.contains { $0.mirrorOf == p.id }
            panelIsMain = p.main
            rightmost = Int((laidOut.map { $0.bounds.maxX }.max() ?? 0).rounded())
            farRight = Int(p.bounds.minX.rounded()) >= rightmost - 1
        }
        return Analysis(all: all, panel: panel, others: others, laidOut: laidOut, preferredMain: preferred,
                        mirrored: mirrored, panelIsMain: panelIsMain, farRight: farRight, rightmost: rightmost)
    }

    /// Apply the fix for `a`. Returns the list of changes made, or nil on a CoreGraphics failure.
    static func fix(_ a: Analysis) -> [String]? {
        guard let panel = a.panel, let preferred = a.preferredMain else { return [] }
        var config: CGDisplayConfigRef?
        guard CGBeginDisplayConfiguration(&config) == .success, let cfg = config else { Out.err("CGBeginDisplayConfiguration failed"); return nil }
        var changed: [String] = []
        var ok = true
        func check(_ e: CGError, _ what: String) { if e != .success { ok = false; Out.err(what + " failed: \(e.rawValue)") } }

        if panel.mirrorOf != kCGNullDirectDisplay {
            check(CGConfigureDisplayMirrorOfDisplay(cfg, panel.id, kCGNullDirectDisplay), "un-mirror panel")
            changed.append("unmirrored-panel")
        }
        for o in a.others where o.mirrorOf == panel.id {
            check(CGConfigureDisplayMirrorOfDisplay(cfg, o.id, kCGNullDirectDisplay), "un-mirror \(o.id)")
            changed.append("unmirrored-\(o.id)")
        }
        // Origins. The main display is whichever ends up at (0,0): when the panel holds that spot, shift
        // every other display so the preferred one lands there; otherwise leave the others exactly where
        // they are. The panel goes to the right edge of the rightmost other display, at the preferred
        // display's top.
        var placed: [(id: CGDirectDisplayID, x: Int, y: Int, w: Int)] = []
        let shift: (x: Int, y: Int) = a.panelIsMain
            ? (-Int(preferred.bounds.origin.x.rounded()), -Int(preferred.bounds.origin.y.rounded()))
            : (0, 0)
        for o in a.laidOut {
            let x = Int(o.bounds.origin.x.rounded()) + shift.x, y = Int(o.bounds.origin.y.rounded()) + shift.y
            placed.append((o.id, x, y, Int(o.bounds.width.rounded())))
            if a.panelIsMain { check(CGConfigureDisplayOrigin(cfg, o.id, Int32(x), Int32(y)), "move \(o.id)") }
        }
        if a.panelIsMain { changed.append("main-display-\(preferred.id)") }
        let right = placed.map { $0.x + $0.w }.max() ?? 0
        let top = placed.first { $0.id == preferred.id }?.y ?? 0
        let curX = Int(panel.bounds.origin.x.rounded()), curY = Int(panel.bounds.origin.y.rounded())
        if a.mirrored || a.panelIsMain || curX != right || curY != top {
            check(CGConfigureDisplayOrigin(cfg, panel.id, Int32(right), Int32(top)), "move panel")
            changed.append("panel-to-\(right),\(top)")
        }
        guard ok else { CGCancelDisplayConfiguration(cfg); return nil }
        let done = CGCompleteDisplayConfiguration(cfg, .permanently)
        guard done == .success else { Out.err("CGCompleteDisplayConfiguration failed: \(done.rawValue)"); return nil }
        return changed
    }

    static func main() {
        Out.setup()
        let cmd = CommandLine.arguments.dropFirst().first ?? "check"
        guard cmd == "check" || cmd == "fix" else { Out.err("usage: display-arrange check|fix"); exit(1) }
        let a = analyze()
        if cmd == "check" || a.code == 0 || a.code == 4 {
            Out.line(Out.json(a.json()))
            exit(cmd == "check" ? a.code : 0)
        }
        guard let changed = fix(a) else { Out.line(Out.json(a.json(changed: []))); exit(1) }
        // Re-read so the caller sees the arrangement macOS actually applied.
        let after = analyze()
        Out.line(Out.json(after.json(changed: changed)))
        exit(after.code == 0 || after.code == 4 ? 0 : 1)
    }
}
