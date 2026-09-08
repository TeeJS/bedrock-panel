// sysvolume — the default output device's volume as an integer 0..100 (macOS port of
// native/sysvolume.cs). Used by the meeting console's OUTPUT rail so the level display is a REAL
// read, never a fabricated number. Prints "-1" when the device has no software volume control
// (HDMI / DisplayPort audio), so the caller shows "—". [MIT]
//
// Modes:
//   (no args)  one-shot: print the volume once and exit (exit 1 on failure).
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

    static func main() {
        Out.setup()
        let args = CommandLine.arguments.dropFirst()
        if args.first != "watch" {
            let v = readVolume()
            Out.line(String(v))
            exit(v < 0 ? 1 : 0)
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
