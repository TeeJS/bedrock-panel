// app-icon — the icon macOS shows for an application (or any file), as a PNG on stdout. [MIT]
//
// Backs the "App icon" tile option on a Mac. Electron's own app.getFileIcon() is what Windows and
// Linux use, but on macOS 26+ its 'large' size (the only one big enough for a panel tile) trips a
// CHECK inside Chromium's icon loader and takes the whole process down with SIGTRAP (issue #67). The
// same icon through AppKit directly is a few lines, so the main process asks this helper instead.
//
// Usage: app-icon <path-or-name> [pixels]
//   <path-or-name>  an absolute path (any file or .app bundle), or a bare application name — the
//                   same word `open -a` gets at launch time ("Microsoft Outlook", "zoom.us") or a
//                   Windows token a config brought over ("outlook", "chrome.exe"). Names resolve the
//                   way the launch does: known aliases through their bundle id, otherwise
//                   "<name>.app" in the standard application folders (case-insensitive).
//   [pixels]        edge length of the square PNG, 16...1024, default 256.
// Exit 0 with the PNG bytes on stdout; exit 1 and nothing on stdout when nothing resolves or the
// icon cannot be rendered (diagnostic on stderr). No permissions involved.
import Foundation
import AppKit

@main struct AppIcon {
    static let appDirs = [
        "/Applications", "/Applications/Utilities",
        "/System/Applications", "/System/Applications/Utilities",
        NSHomeDirectory() + "/Applications",
    ]

    /// Absolute path for a path-or-name, or nil when nothing on this Mac matches.
    static func resolve(_ value: String) -> String? {
        let v = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if v.isEmpty { return nil }
        let fm = FileManager.default
        if v.contains("/") { return fm.fileExists(atPath: v) ? v : nil }
        // Windows token -> bundle id -> wherever LaunchServices says that app lives.
        var bare = v
        if bare.lowercased().hasSuffix(".exe") { bare = String(bare.dropLast(4)) }
        if let ids = AppAliases.bundleIds[bare.lowercased()] {
            for id in ids {
                if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) { return url.path }
            }
        }
        // Plain name: "<name>.app" in the usual folders, exact first, then case-insensitive.
        let name = bare.lowercased().hasSuffix(".app") ? String(bare.dropLast(4)) : bare
        let wanted = (name + ".app").lowercased()
        for dir in appDirs {
            let exact = dir + "/" + name + ".app"
            if fm.fileExists(atPath: exact) { return exact }
            if let items = try? fm.contentsOfDirectory(atPath: dir),
               let hit = items.first(where: { $0.lowercased() == wanted }) { return dir + "/" + hit }
        }
        return nil
    }

    /// The Finder icon for `path`, rasterised at px x px with transparency.
    static func png(_ path: String, _ px: Int) -> Data? {
        let icon = NSWorkspace.shared.icon(forFile: path)
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px,
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        rep.size = NSSize(width: px, height: px)
        guard let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = ctx
        ctx.imageInterpolation = .high
        icon.draw(in: NSRect(x: 0, y: 0, width: px, height: px))
        ctx.flushGraphics()
        NSGraphicsContext.restoreGraphicsState()
        return rep.representation(using: .png, properties: [:])
    }

    static func main() {
        let args = Array(CommandLine.arguments.dropFirst())
        guard let target = args.first, !target.isEmpty else { Out.err("usage: app-icon <path-or-name> [pixels]"); exit(2) }
        let px = max(16, min(1024, args.count > 1 ? (Int(args[1]) ?? 256) : 256))
        guard let path = resolve(target) else { Out.err("app-icon: nothing resolves for \"" + target + "\""); exit(1) }
        guard let data = png(path, px), !data.isEmpty else { Out.err("app-icon: could not render " + path); exit(1) }
        FileHandle.standardOutput.write(data)
        exit(0)
    }
}
