// speech-server — macOS's built-in speech as a local Wyoming server, so the voice apps, dictation,
// and the meeting tools that already speak the Wyoming protocol (faster-whisper / piper on a server
// of your own, or the tts-stt-windows helper on Windows) work on a Mac with nothing to install:
//   - STT: Apple's speech recognition (SFSpeechRecognizer, on-device when the language supports it)
//   - TTS: the system voices (AVSpeechSynthesizer — the same voices as `say`)
// [MIT]
//
//   speech-server [--host 127.0.0.1] [--stt-port 10300] [--tts-port 10200] [--language en-US] [--voice NAME]
//
// Wire format (wyoming 1.x): one JSON header line per event, then an optional data block of
// header.data_length bytes (JSON), then an optional payload of header.payload_length bytes.
// STT session: transcribe{language} → audio-start{rate,width,channels} → audio-chunk(+PCM16) …
// → audio-stop → we reply transcript{text}. TTS: synthesize{text, voice{name}} → we reply
// audio-start{rate,width:2,channels:1} → audio-chunk(+PCM16) … → audio-stop. describe → info.
// Stdout carries one JSON status line for the app (ready / auth / error); stderr is diagnostics.
// Exits when stdin closes (the app spawned it with stdin piped).
import Foundation
import Network
import Speech
import AVFoundation

// MARK: - options

struct Options {
    var host = "127.0.0.1"
    var sttPort: UInt16 = 10300
    var ttsPort: UInt16 = 10200
    var language = Locale.current.identifier.replacingOccurrences(of: "_", with: "-")
    var voice = ""
    init() {
        var args = Array(CommandLine.arguments.dropFirst())
        while !args.isEmpty {
            let a = args.removeFirst()
            let v = args.first ?? ""
            switch a {
            case "--host": host = v; if !args.isEmpty { args.removeFirst() }
            case "--stt-port": sttPort = UInt16(v) ?? sttPort; if !args.isEmpty { args.removeFirst() }
            case "--tts-port": ttsPort = UInt16(v) ?? ttsPort; if !args.isEmpty { args.removeFirst() }
            case "--language": language = v; if !args.isEmpty { args.removeFirst() }
            case "--voice": voice = v; if !args.isEmpty { args.removeFirst() }
            default: break
            }
        }
        if language.isEmpty || language == "en" { language = "en-US" }
    }
}
let opts = Options()

// MARK: - wyoming framing

struct Event {
    let type: String
    let data: [String: Any]
    let payload: Data?
}

/// Encodes an event the way real Wyoming servers do: data externalized into a data_length block.
func encode(_ type: String, data: [String: Any] = [:], payload: Data? = nil) -> Data {
    var header: [String: Any] = ["type": type]
    var dataBytes = Data()
    if !data.isEmpty, let d = try? JSONSerialization.data(withJSONObject: data, options: [.sortedKeys]) {
        dataBytes = d
        header["data_length"] = d.count
    }
    if let p = payload { header["payload_length"] = p.count }
    var out = (try? JSONSerialization.data(withJSONObject: header, options: [.sortedKeys])) ?? Data("{}".utf8)
    out.append(0x0a)
    out.append(dataBytes)
    if let p = payload { out.append(p) }
    return out
}

/// Incremental reader for the header / data block / payload framing (mirrors app/claudevoice-wyoming.js).
final class Framer {
    private var buf = Data()
    private var pendingHeader: [String: Any]?
    private var pendingData: [String: Any]?
    func feed(_ chunk: Data, _ onEvent: (Event) -> Void) {
        buf.append(chunk)
        while true {
            if pendingHeader == nil {
                guard let nl = buf.firstIndex(of: 0x0a) else { return }
                let line = buf.subdata(in: buf.startIndex..<nl)
                buf.removeSubrange(buf.startIndex...nl)
                if line.isEmpty { continue }
                guard let h = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { Out.err("bad header: \(String(data: line, encoding: .utf8) ?? "?")"); continue }
                pendingHeader = h
                pendingData = nil
                continue
            }
            let h = pendingHeader!
            let dataLen = (h["data_length"] as? Int) ?? 0
            if dataLen > 0 && pendingData == nil {
                guard buf.count >= dataLen else { return }
                let block = buf.prefix(dataLen)
                buf.removeFirst(dataLen)
                pendingData = ((try? JSONSerialization.jsonObject(with: block)) as? [String: Any]) ?? [:]
                continue
            }
            let payloadLen = (h["payload_length"] as? Int) ?? 0
            guard buf.count >= payloadLen else { return }
            let payload: Data? = payloadLen > 0 ? Data(buf.prefix(payloadLen)) : nil
            if payloadLen > 0 { buf.removeFirst(payloadLen) }
            let data = pendingData ?? ((h["data"] as? [String: Any]) ?? [:])
            pendingHeader = nil
            pendingData = nil
            onEvent(Event(type: (h["type"] as? String) ?? "", data: data, payload: payload))
        }
    }
}

// MARK: - speech recognition (STT)

final class Recognizer {
    static var authStatus: SFSpeechRecognizerAuthorizationStatus = SFSpeechRecognizer.authorizationStatus()
    static func authString() -> String {
        switch authStatus { case .authorized: return "authorized"; case .denied: return "denied"; case .restricted: return "restricted"; default: return "notDetermined" }
    }
    /// Asks for Speech Recognition once (macOS shows the prompt, or returns the recorded answer),
    /// reports the outcome on stdout for the app, then runs `then` on the main queue.
    static var authWaiters: [() -> Void] = []
    static func ensureAuthorized(_ then: @escaping () -> Void) {
        authStatus = SFSpeechRecognizer.authorizationStatus()
        if authStatus != .notDetermined { then(); return }
        authWaiters.append(then)
        if authWaiters.count > 1 { return }
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                authStatus = status
                Out.line(Out.json(["event": "auth", "speechAuth": authString()]))
                let waiters = authWaiters; authWaiters = []
                waiters.forEach { $0() }
            }
        }
    }
    static var lastLocale = ""
    static var recognizer: SFSpeechRecognizer?
    static func recognizer(for language: String) -> SFSpeechRecognizer? {
        let id = language.isEmpty ? opts.language : language
        if recognizer == nil || lastLocale != id {
            recognizer = SFSpeechRecognizer(locale: Locale(identifier: id)) ?? SFSpeechRecognizer()
            lastLocale = id
        }
        return recognizer
    }
    static func onDevice(_ r: SFSpeechRecognizer?) -> Bool {
        if #available(macOS 10.15, *), let r = r { return r.supportsOnDeviceRecognition }
        return false
    }

    /// Recognize one utterance of interleaved PCM16 and call back with the final text ("" on failure).
    static func transcribe(pcm: Data, rate: Int, channels: Int, language: String, timeout: TimeInterval = 20, done: @escaping (String) -> Void) {
        guard authStatus == .authorized, let r = recognizer(for: language), r.isAvailable else {
            Out.err("STT unavailable: auth=\(authString()) recognizer=\(recognizer(for: language) != nil)")
            done(""); return
        }
        guard let inFmt = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(rate), channels: AVAudioChannelCount(max(1, channels)), interleaved: true),
              let outFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(rate), channels: 1, interleaved: false) else { done(""); return }
        let frameCount = pcm.count / (2 * max(1, channels))
        guard frameCount > 0, let inBuf = AVAudioPCMBuffer(pcmFormat: inFmt, frameCapacity: AVAudioFrameCount(frameCount)) else { done(""); return }
        inBuf.frameLength = AVAudioFrameCount(frameCount)
        pcm.withUnsafeBytes { raw in
            if let base = raw.baseAddress, let dst = inBuf.int16ChannelData { memcpy(dst[0], base, frameCount * 2 * max(1, channels)) }
        }
        // Float32 mono is what the recognizer is happiest with; AVAudioConverter mixes channels down.
        guard let conv = AVAudioConverter(from: inFmt, to: outFmt), let outBuf = AVAudioPCMBuffer(pcmFormat: outFmt, frameCapacity: AVAudioFrameCount(frameCount)) else { done(""); return }
        var err: NSError?
        var consumed = false
        conv.convert(to: outBuf, error: &err) { _, status in
            if consumed { status.pointee = .noDataNow; return nil }
            consumed = true; status.pointee = .haveData; return inBuf
        }
        if let e = err { Out.err("audio convert failed: \(e.localizedDescription)"); done(""); return }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = false
        if #available(macOS 10.15, *), r.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        request.append(outBuf)
        request.endAudio()
        var finished = false
        var task: SFSpeechRecognitionTask?
        let finish: (String) -> Void = { text in
            if finished { return }
            finished = true
            task?.cancel()
            done(text)
        }
        task = r.recognitionTask(with: request) { result, error in
            if let res = result, res.isFinal { finish(res.bestTranscription.formattedString); return }
            if let e = error {
                // "No speech detected" and cancellations are ordinary outcomes for a silent clip.
                Out.err("STT: \(e.localizedDescription)")
                finish(result?.bestTranscription.formattedString ?? "")
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { if !finished { Out.err("STT timed out"); finish("") } }
    }
}

// MARK: - speech synthesis (TTS)

final class Speaker {
    static let synth = AVSpeechSynthesizer()
    static func voices() -> [[String: Any]] {
        AVSpeechSynthesisVoice.speechVoices().map { v in
            ["name": v.name, "identifier": v.identifier, "language": v.language, "quality": v.quality == .enhanced ? "enhanced" : (v.quality.rawValue >= 3 ? "premium" : "default")]
        }
    }
    static func voice(named name: String) -> AVSpeechSynthesisVoice? {
        let wanted = name.isEmpty ? opts.voice : name
        if !wanted.isEmpty {
            if let v = AVSpeechSynthesisVoice.speechVoices().first(where: { $0.name.caseInsensitiveCompare(wanted) == .orderedSame || $0.identifier == wanted }) { return v }
            Out.err("voice not found: \(wanted) — using the default for \(opts.language)")
        }
        return AVSpeechSynthesisVoice(language: opts.language) ?? AVSpeechSynthesisVoice(language: nil)
    }

    /// Synthesize `text`; `onStart(rate, channels)` once, `onChunk(pcm16)` per buffer, `onDone()` at the end.
    static func speak(text: String, voiceName: String, onStart: @escaping (Int, Int) -> Void, onChunk: @escaping (Data) -> Void, onDone: @escaping () -> Void) {
        let utt = AVSpeechUtterance(string: text)
        utt.voice = voice(named: voiceName)
        var started = false
        var ended = false
        // Serialize: AVSpeechSynthesizer.write handles one utterance at a time on the main thread.
        DispatchQueue.main.async {
            synth.write(utt) { buffer in
                guard let pcm = buffer as? AVAudioPCMBuffer else { return }
                if pcm.frameLength == 0 { if !ended { ended = true; if !started { started = true; onStart(22050, 1) }; onDone() }; return }
                let rate = Int(pcm.format.sampleRate), channels = Int(pcm.format.channelCount)
                if !started { started = true; onStart(rate, channels) }
                onChunk(int16Interleaved(pcm))
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 60) { if !ended { ended = true; Out.err("TTS timed out"); if !started { started = true; onStart(22050, 1) }; onDone() } }
    }

    static func int16Interleaved(_ pcm: AVAudioPCMBuffer) -> Data {
        let frames = Int(pcm.frameLength), channels = Int(pcm.format.channelCount)
        var out = Data(count: frames * channels * 2)
        out.withUnsafeMutableBytes { raw in
            let dst = raw.bindMemory(to: Int16.self)
            if let f = pcm.floatChannelData {
                for i in 0..<frames { for c in 0..<channels {
                    let s = max(-1, min(1, f[pcm.format.isInterleaved ? 0 : c][pcm.format.isInterleaved ? i * channels + c : i]))
                    dst[i * channels + c] = Int16(s * 32767)
                } }
            } else if let s16 = pcm.int16ChannelData {
                for i in 0..<frames { for c in 0..<channels { dst[i * channels + c] = s16[pcm.format.isInterleaved ? 0 : c][pcm.format.isInterleaved ? i * channels + c : i] } }
            }
        }
        return out
    }
}

// MARK: - connections

final class Session {
    let conn: NWConnection
    let kind: String   // "stt" | "tts"
    let framer = Framer()
    var sttLanguage = ""
    var sttRate = 16000, sttChannels = 1
    var sttAudio = Data()
    init(_ conn: NWConnection, kind: String) { self.conn = conn; self.kind = kind }

    func send(_ type: String, data: [String: Any] = [:], payload: Data? = nil, then: (() -> Void)? = nil) {
        conn.send(content: encode(type, data: data, payload: payload), completion: .contentProcessed { _ in then?() })
    }
    /// Live sessions, retained here: Network.framework only holds the connection, not this object.
    static var active: [ObjectIdentifier: Session] = [:]
    func start() {
        Session.active[ObjectIdentifier(self)] = self
        // Read only once the connection is ready: a receive queued before that is dropped by Network.framework.
        conn.stateUpdateHandler = { [weak self] st in
            guard let self = self else { return }
            switch st {
            case .ready: self.receive()
            case .failed(let e): Out.err("connection failed: \(e)"); self.conn.cancel()
            case .cancelled: Session.active.removeValue(forKey: ObjectIdentifier(self))
            default: break
            }
        }
        conn.start(queue: .main)
    }
    private func receive() {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] data, _, complete, error in
            guard let self = self else { return }
            if let d = data, !d.isEmpty { self.framer.feed(d) { self.handle($0) } }
            if complete || error != nil { self.conn.cancel(); return }
            self.receive()
        }
    }
    private func handle(_ ev: Event) {
        switch ev.type {
        case "describe":
            send("info", data: Info.describe())
        case "transcribe":
            sttLanguage = (ev.data["language"] as? String) ?? ""
        case "audio-start":
            sttRate = (ev.data["rate"] as? Int) ?? 16000
            sttChannels = (ev.data["channels"] as? Int) ?? 1
            sttAudio = Data()
        case "audio-chunk":
            if let p = ev.payload { sttAudio.append(p) }
        case "audio-stop":
            let audio = sttAudio; sttAudio = Data()
            Out.err("STT: \(audio.count) bytes @\(sttRate)Hz x\(sttChannels) lang=\(sttLanguage.isEmpty ? opts.language : sttLanguage)")
            // Speech Recognition is asked for on the first transcription, never at startup: TTS-only use
            // then never touches TCC, and the prompt (attributed to the app that spawned us, whose
            // Info.plist carries NSSpeechRecognitionUsageDescription) appears when speech is first used.
            Recognizer.ensureAuthorized { [weak self] in
                guard let self = self else { return }
                Recognizer.transcribe(pcm: audio, rate: self.sttRate, channels: self.sttChannels, language: self.sttLanguage) { [weak self] text in
                    Out.err("STT -> \(text.isEmpty ? "(empty)" : "\"\(text.prefix(80))\"")")
                    self?.send("transcript", data: ["text": text])
                }
            }
        case "synthesize":
            let text = (ev.data["text"] as? String) ?? ""
            let voiceName = ((ev.data["voice"] as? [String: Any])?["name"] as? String) ?? ""
            guard !text.isEmpty else { send("audio-start", data: ["rate": 22050, "width": 2, "channels": 1]); send("audio-stop"); return }
            Out.err("TTS: \"\(text.prefix(60))\" voice=\(voiceName.isEmpty ? (opts.voice.isEmpty ? "default" : opts.voice) : voiceName)")
            Speaker.speak(text: text, voiceName: voiceName,
                          onStart: { [weak self] rate, ch in self?.send("audio-start", data: ["rate": rate, "width": 2, "channels": ch, "timestamp": 0]) },
                          onChunk: { [weak self] pcm in self?.send("audio-chunk", data: ["rate": 0, "width": 2, "channels": 1], payload: pcm) },
                          onDone: { [weak self] in self?.send("audio-stop", data: ["timestamp": 0]) })
        default:
            break
        }
    }
}

enum Info {
    static func describe() -> [String: Any] {
        let r = Recognizer.recognizer(for: "")
        return [
            "asr": [["name": "macos-speech", "installed": true, "attribution": ["name": "Apple Speech", "url": "https://developer.apple.com/documentation/speech"],
                     "description": "Apple speech recognition" + (Recognizer.onDevice(r) ? " (on-device)" : ""),
                     "models": [["name": "apple", "installed": true, "languages": [opts.language], "attribution": ["name": "Apple", "url": ""], "description": Recognizer.onDevice(r) ? "on-device" : "Apple servers"]]]],
            "tts": [["name": "macos-voices", "installed": true, "attribution": ["name": "Apple", "url": ""], "description": "macOS system voices",
                     "voices": Speaker.voices().map { ["name": $0["name"] ?? "", "installed": true, "languages": [$0["language"] ?? ""], "attribution": ["name": "Apple", "url": ""], "description": $0["quality"] ?? ""] }]],
        ]
    }
}

func listen(port: UInt16, kind: String) -> NWListener? {
    guard let p = NWEndpoint.Port(rawValue: port) else { return nil }
    let params = NWParameters.tcp
    params.allowLocalEndpointReuse = true
    params.requiredLocalEndpoint = NWEndpoint.hostPort(host: NWEndpoint.Host(opts.host), port: p)
    guard let l = try? NWListener(using: params) else { return nil }
    l.newConnectionHandler = { conn in Session(conn, kind: kind).start() }
    l.start(queue: .main)
    return l
}

@main struct SpeechServer {
    static var listeners: [NWListener] = []
    static func main() {
        Out.setup()
        ParentGuard.exitOnStdinEOF()
        guard let stt = listen(port: opts.sttPort, kind: "stt"), let tts = listen(port: opts.ttsPort, kind: "tts") else {
            Out.line(Out.json(["event": "error", "message": "could not listen on \(opts.host):\(opts.sttPort)/\(opts.ttsPort) (ports in use?)"]))
            exit(1)
        }
        listeners = [stt, tts]
        let r = Recognizer.recognizer(for: "")
        // No authorization request here (see Recognizer.ensureAuthorized): reading the status is free.
        Out.line(Out.json(["event": "ready", "host": opts.host, "sttPort": Int(opts.sttPort), "ttsPort": Int(opts.ttsPort), "language": opts.language,
                           "speechAuth": Recognizer.authString(), "onDevice": Recognizer.onDevice(r), "recognizerAvailable": r?.isAvailable ?? false,
                           "voice": opts.voice, "voices": Speaker.voices()]))
        // A real main run loop (not just the main dispatch queue): AVSpeechSynthesizer's write
        // callbacks and the Speech framework's replies are delivered through it.
        RunLoop.main.run()
    }
}
