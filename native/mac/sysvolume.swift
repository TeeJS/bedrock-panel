// sysvolume — the default output device's volume as an integer 0..100 (macOS port of
// native/sysvolume.cs). Used by the meeting console's OUTPUT rail so the level display is a REAL
// read, never a fabricated number. Prints "-1" when the device has no software volume control
// (HDMI / DisplayPort audio), so the caller shows "—". [MIT]
//
// Modes:
//   (no args)  one-shot: print "LEVEL MUTE" once and exit (LEVEL 0-100 or -1; MUTE 1/0/-1). Used by
//              the settings editor's mic/speaker test to read the level and the mute flag together.
//   watch      long-running: print a line whenever the volume changes (first read prints
//              immediately), re-resolving the default device once a second so device switches
//              are honored. Exits when stdin closes (parent died). No permissions involved.
import Foundation
import CoreAudio

@main struct SysVolume {
    static func defaultOutputDevice() -> AudioDeviceID? {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice,
                                              mScope: kAudioObjectPropertyScopeGlobal,
                                              mElement: kAudioObjectPropertyElementMain)
        var dev = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        let st = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &dev)
        return (st == noErr && dev != 0) ? dev : nil
    }

    static func scalar(_ dev: AudioDeviceID, element: UInt32) -> Float32? {
        var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyVolumeScalar,
                                              mScope: kAudioDevicePropertyScopeOutput,
                                              mElement: element)
        guard AudioObjectHasProperty(dev, &addr) else { return nil }
        var v = Float32(0)
        var size = UInt32(MemoryLayout<Float32>.size)
        return AudioObjectGetPropertyData(dev, &addr, 0, nil, &size, &v) == noErr ? v : nil
    }

    /// 0...100, or -1 when there is no default device or it exposes no volume control.
    static func readVolume() -> Int {
        guard let dev = defaultOutputDevice() else { return -1 }
        if let v = scalar(dev, element: kAudioObjectPropertyElementMain) { return Int((v * 100).rounded()) }
        let channels = [UInt32(1), UInt32(2)].compactMap { scalar(dev, element: $0) }
        if !channels.isEmpty { return Int((channels.reduce(0, +) / Float32(channels.count) * 100).rounded()) }
        return -1
    }

    /// 1 = muted, 0 = not muted, -1 = no default device or no mute control. Mute is a SEPARATE property
    /// from volume on macOS (kAudioDevicePropertyMute), so a device muted at level 50 still reads 50.
    static func readMuted() -> Int {
        guard let dev = defaultOutputDevice() else { return -1 }
        var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyMute,
                                              mScope: kAudioDevicePropertyScopeOutput,
                                              mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectHasProperty(dev, &addr) else { return -1 }
        var m = UInt32(0)
        var size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(dev, &addr, 0, nil, &size, &m) == noErr ? (m != 0 ? 1 : 0) : -1
    }

    static func main() {
        Out.setup()
        let args = CommandLine.arguments.dropFirst()
        if args.first != "watch" {
            // One-shot: "LEVEL MUTE" (LEVEL 0-100 or -1; MUTE 1/0/-1). watch stays level-only below.
            let v = readVolume()
            let mu = readMuted()
            Out.line(String(v) + " " + String(mu))
            exit((v < 0 && mu < 0) ? 1 : 0)
        }
        ParentGuard.exitOnStdinEOF()
        var last = Int.min
        let t = DispatchSource.makeTimerSource(queue: .main)
        t.schedule(deadline: .now(), repeating: 1.0)
        t.setEventHandler {
            let v = readVolume()
            if v != last { last = v; Out.line(String(v)) }
        }
        t.resume()
        dispatchMain()
    }
}
