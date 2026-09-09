// privacy — the macOS privacy (TCC) checks and prompts Electron cannot drive itself. [MIT]
//
//   privacy preflight listenEvent|screenCapture   -> {"granted":true|false}   (no prompt, no side effects)
//   privacy request   listenEvent|screenCapture   -> raises the system prompt (macOS shows it once per
//                                                   app until the grant is reset) and prints the state
//                                                   at return: the prompt itself is asynchronous, so
//                                                   the caller re-runs `preflight` to see the answer.
//
// Input Monitoring ("ListenEvent") is what the DK-QUAKE touch controller needs, and macOS never asks
// for it on its own when a HID device is opened: until CGRequestListenEventAccess has been called the
// app is not even listed under System Settings → Privacy & Security → Input Monitoring, and the
// person has to add it with "+". One call lists the app and raises the "would like to receive
// keystrokes from any application" prompt, attributed to the responsible app — Bedrock Panel for the
// installed build, the terminal app for `npm start` — exactly where the touch open is attributed.
// DK-Suite does the same through an FFI call into CoreGraphics; this is the helper-process form.
import Foundation
import CoreGraphics

@main struct Privacy {
    static func main() {
        Out.setup()
        let args = Array(CommandLine.arguments.dropFirst())
        guard args.count == 2, ["preflight", "request"].contains(args[0]), ["listenEvent", "screenCapture"].contains(args[1]) else {
            Out.err("usage: privacy preflight|request listenEvent|screenCapture")
            exit(2)
        }
        let granted: Bool
        switch (args[0], args[1]) {
        case ("preflight", "listenEvent"):   granted = CGPreflightListenEventAccess()
        case ("request", "listenEvent"):     granted = CGRequestListenEventAccess()
        case ("preflight", "screenCapture"): granted = CGPreflightScreenCaptureAccess()
        default:                             granted = CGRequestScreenCaptureAccess()
        }
        Out.line(Out.json(["granted": granted]))
        exit(0)
    }
}
