// mic-session-monitor — app-scoped microphone-in-use monitor for the meeting recorder (macOS port
// of native/mic-session-monitor.cs). [MIT]
//
// Polls Core Audio's process objects (macOS 14.2+) for processes that are RUNNING AUDIO INPUT and
// reports, on stdout, whether any app from a caller-supplied allowlist (e.g. Zoom.exe, Teams.exe,
// ms-teams.exe — the Windows tokens the editor still uses, resolved through AppAliases) currently
// holds the microphone, i.e. "a call is in progress". Reading these properties needs no permission;
// only creating a tap does. It never opens the mic itself.
//
// Chromium/Electron apps (Teams, Discord, Slack, Chrome) capture from a helper process, so the
// owner is found by walking up to the first ancestor that is a regular app.
//
// Protocol: identical to the Windows helper — one JSON line per state transition, nothing until a
// real transition is observed (no initial baseline line; see the C# source for why):
//   {"active":true,"app":"Zoom.exe","apps":["Zoom.exe","Discord.exe"]}
//   {"active":false,"apps":[]}
// "apps" carries EVERY allowlisted app currently capturing, as the caller's own tokens, verbatim,
// in allowlist order, because each consumer (recorder, busy light) filters it against its own list.
// Args: allowlist tokens, comma- or space-separated. Defaults to Zoom.exe,Teams.exe,ms-teams.exe.
// Exits 3 on macOS < 14.2 (no per-process capture state there). Spawned with stdin ignored, so the
// parent-death guard is the re-parenting check rather than stdin EOF.
import Foundation
import CoreAudio
import AppKit

@main struct MicSessionMonitor {
    static func parentPid(_ pid: pid_t) -> pid_t? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0) == 0, size > 0 else { return nil }
        let ppid = info.kp_eproc.e_ppid
        return ppid > 0 ? ppid : nil
    }

    static func processName(_ pid: pid_t) -> String? {
        var buf = [CChar](repeating: 0, count: 4096)
        let n = proc_name(pid, &buf, UInt32(buf.count))
        return n > 0 ? String(cString: buf) : nil
    }

    /// The regular app that owns a capturing pid (walks pid -> ppid a few levels for helper processes).
    static func owningApp(_ pid: pid_t) -> NSRunningApplication? {
        var current: pid_t? = pid
        for _ in 0..<6 {
            guard let p = current, p > 1 else { return nil }
            if let app = NSRunningApplication(processIdentifier: p), app.activationPolicy == .regular { return app }
            current = parentPid(p)
        }
        return nil
    }

    static func u32(_ obj: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
        var addr = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var v = UInt32(0)
        var size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &v) == noErr ? v : nil
    }

    static func string(_ obj: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
        var addr = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var ref: Unmanaged<CFString>? = nil
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &ref) == noErr, let s = ref?.takeRetainedValue() else { return nil }
        return s as String
    }

    /// (pid, bundle id) of every process currently running audio input.
    @available(macOS 14.2, *)
    static func capturingProcesses() -> [(pid: pid_t, bundleId: String?)] {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        let system = AudioObjectID(kAudioObjectSystemObject)
        var size = UInt32(0)
        guard AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
        var objects = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &objects) == noErr else { return [] }
        var out: [(pid_t, String?)] = []
        for o in objects {
            guard let running = u32(o, kAudioProcessPropertyIsRunningInput), running != 0 else { continue }
            guard let pidValue = u32(o, kAudioProcessPropertyPID), pidValue > 0 else { continue }
            out.append((pid_t(pidValue), string(o, kAudioProcessPropertyBundleID)))
        }
        return out
    }

    /// Allowlist tokens (verbatim, allowlist order, de-duplicated) whose app is currently capturing.
    @available(macOS 14.2, *)
    static func activeAllowlisted(_ allow: [String]) -> [String] {
        var matched = Set<String>()
        for (pid, bundleId) in capturingProcesses() {
            let aliases: Set<String>
            let bid: String?
            if let app = owningApp(pid) {
                bid = app.bundleIdentifier ?? bundleId
                aliases = AppAliases.aliases(name: app.localizedName, executable: app.executableURL?.lastPathComponent, bundleId: bid)
            } else {
                bid = bundleId
                aliases = AppAliases.aliases(name: processName(pid), executable: nil, bundleId: bid)
            }
            for token in allow where AppAliases.matches(token: token, appAliases: aliases, bundleId: bid) {
                matched.insert(token.lowercased())
            }
        }
        return allow.filter { matched.contains($0.lowercased()) }
    }

    static func main() {
        Out.setup()
        guard #available(macOS 14.2, *) else {
            Out.err("mic-session-monitor needs macOS 14.2 or newer (per-process capture state); auto-record is unavailable")
            exit(3)
        }
        var allow: [String] = []
        for arg in CommandLine.arguments.dropFirst() {
            for part in arg.split(whereSeparator: { $0 == "," || $0 == " " || $0 == ";" }) {
                let t = part.trimmingCharacters(in: .whitespaces)
                if !t.isEmpty && !allow.contains(where: { $0.lowercased() == t.lowercased() }) { allow.append(t) }
            }
        }
        if allow.isEmpty { allow = ["Zoom.exe", "Teams.exe", "ms-teams.exe"] }

        ParentGuard.exitWhenOrphaned()
        var lastActive = false
        var lastApps = Set<String>()
        let t = DispatchSource.makeTimerSource(queue: .main)
        t.schedule(deadline: .now(), repeating: 1.0)
        t.setEventHandler {
            // The transition test compares the whole SET, not just the first match: with Discord already
            // holding the mic, Teams joining a call must still be reported.
            let apps = activeAllowlisted(allow)
            let active = !apps.isEmpty
            let now = Set(apps.map { $0.lowercased() })
            if active != lastActive || now != lastApps {
                var row: [String: Any] = ["active": active, "apps": apps]
                if active { row["app"] = apps[0] }
                Out.line(Out.json(row))
                lastActive = active; lastApps = now
            }
        }
        t.resume()
        dispatchMain()
    }
}
