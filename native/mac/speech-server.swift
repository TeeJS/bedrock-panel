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

    /// Interleaved PCM16 at `rate` -> one Float32 mono buffer at the same rate (AVAudioConverter mixes
    /// channels down); nil when the input is empty or the formats cannot be built.
    static func monoBuffer(pcm: Data, rate: Int, channels: Int) -> AVAudioPCMBuffer? {
        guard let inFmt = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(rate), channels: AVAudioChannelCount(max(1, channels)), interleaved: true),
              let outFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(rate), channels: 1, interleaved: false) else { return nil }
        let frameCount = pcm.count / (2 * max(1, channels))
        guard frameCount > 0, let inBuf = AVAudioPCMBuffer(pcmFormat: inFmt, frameCapacity: AVAudioFrameCount(frameCount)) else { return nil }
        inBuf.frameLength = AVAudioFrameCount(frameCount)
        pcm.withUnsafeBytes { raw in
            if let base = raw.baseAddress, let dst = inBuf.int16ChannelData { memcpy(dst[0], base, frameCount * 2 * max(1, channels)) }
        }
        // Float32 mono is what the recognizer is happiest with; AVAudioConverter mixes channels down.
        guard let conv = AVAudioConverter(from: inFmt, to: outFmt), let outBuf = AVAudioPCMBuffer(pcmFormat: outFmt, frameCapacity: AVAudioFrameCount(frameCount)) else { return nil }
        var err: NSError?
        var consumed = false
        conv.convert(to: outBuf, error: &err) { _, status in
            if consumed { status.pointee = .noDataNow; return nil }
            consumed = true; status.pointee = .haveData; return inBuf
        }
        if let e = err { Out.err("audio convert failed: \(e.localizedDescription)"); return nil }
        return outBuf
    }

    // Live STT entry point. macOS 26+: Apple's SpeechAnalyzer — on-device, no Dictation setting, no
    // authorization prompt, and it transcribes the 1–3 s utterances the voice pages send; the older
    // SFSpeechRecognizer answered most of those with "No speech detected" (10–25 % of lines came
    // through in Live Translate). A little silence is added on both sides so the analyzer finalizes
    // the last word. Three failures in a row (no model, no download) switch to SFSpeechRecognizer for
    // the rest of the run; macOS 14/15 use it from the start, after the authorization prompt.
    static var analyzerFailures = 0
    static var analyzerUsable: Bool { analyzerFailures < 3 }
    static func engineName() -> String {
        if #available(macOS 26, *), analyzerUsable { return "speechanalyzer" }
        return "sfspeech"
    }
    static func recognize(pcm: Data, rate: Int, channels: Int, language: String, done: @escaping (String) -> Void) {
        if #available(macOS 26, *), analyzerUsable {
            guard let mono = monoBuffer(pcm: pcm, rate: rate, channels: channels), let ch = mono.floatChannelData else { done(""); return }
            let samples = Array(UnsafeBufferPointer(start: ch[0], count: Int(mono.frameLength)))
            let pad = [Float](repeating: 0, count: Int(Double(rate) * 0.3))
            let lang = language.isEmpty ? opts.language : language
            Task {
                if let segs = await FileTranscriber.analyzerTranscribe(samples: pad + samples + pad, rate: Double(rate), language: lang, speaker: "STT", budget: 20) {
                    analyzerFailures = 0
                    done(segs.map { $0.text }.joined(separator: " "))
                    return
                }
                analyzerFailures += 1
                if !analyzerUsable { Out.line(Out.json(["event": "stt-error", "code": "analyzer-off", "message": "SpeechAnalyzer unavailable; using SFSpeechRecognizer"])) }
                ensureAuthorized { transcribe(pcm: pcm, rate: rate, channels: channels, language: language, done: done) }
            }
            return
        }
        // Speech Recognition is asked for on the first transcription, never at startup: TTS-only use
        // then never touches TCC, and the prompt (attributed to the app that spawned us, whose
        // Info.plist carries NSSpeechRecognitionUsageDescription) appears when speech is first used.
        ensureAuthorized { transcribe(pcm: pcm, rate: rate, channels: channels, language: language, done: done) }
    }

    /// Recognize one utterance of interleaved PCM16 and call back with the final text ("" on failure).
    static func transcribe(pcm: Data, rate: Int, channels: Int, language: String, timeout: TimeInterval = 20, done: @escaping (String) -> Void) {
        guard authStatus == .authorized, let r = recognizer(for: language), r.isAvailable else {
            Out.err("STT unavailable: auth=\(authString()) recognizer=\(recognizer(for: language) != nil)")
            done(""); return
        }
        guard let outBuf = monoBuffer(pcm: pcm, rate: rate, channels: channels) else { done(""); return }

        // On-device recognition needs the Dictation assets, which macOS only installs while Keyboard →
        // Dictation (or Siri) is on; with both off the task fails at once with "Siri and Dictation are
        // disabled" (kAFAssistantErrorDomain 1101). Then retry through Apple's servers so recognition
        // still works, and tell the app once so it can point at the setting (on-device is better).
        run(r, outBuf, onDevice: onDevice(r), timeout: timeout) { text, err in
            if let e = err, isDictationDisabled(e), onDevice(r) {
                if !dictationWarned {
                    dictationWarned = true
                    Out.line(Out.json(["event": "stt-error", "code": "dictation-off", "message": "On-device recognition needs Dictation: System Settings → Keyboard → Dictation → on (or Siri on). Using Apple's servers until then."]))
                }
                Out.err("STT: on-device unavailable (Dictation off) — retrying via Apple's servers")
                run(r, outBuf, onDevice: false, timeout: timeout) { text2, err2 in
                    if let e2 = err2, !isNoSpeech(e2) { Out.line(Out.json(["event": "stt-error", "code": "failed", "message": e2.localizedDescription])) }
                    done(text2)
                }
                return
            }
            if let e = err, !isNoSpeech(e), !isDictationDisabled(e) { Out.line(Out.json(["event": "stt-error", "code": "failed", "message": e.localizedDescription])) }
            done(text)
        }
    }
    static var dictationWarned = false
    static func isDictationDisabled(_ e: Error) -> Bool { let n = e as NSError; return n.code == 1101 || n.localizedDescription.localizedCaseInsensitiveContains("Dictation are disabled") }
    static func isNoSpeech(_ e: Error) -> Bool { let n = e as NSError; return n.code == 1110 || n.localizedDescription.localizedCaseInsensitiveContains("No speech") }

    /// One recognition task over `buf`; `done(text, error)` exactly once (text may be partial on error).
    static func run(_ r: SFSpeechRecognizer, _ buf: AVAudioPCMBuffer, onDevice: Bool, timeout: TimeInterval, done: @escaping (String, Error?) -> Void) {
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = false
        if #available(macOS 10.15, *) { request.requiresOnDeviceRecognition = onDevice }
        request.append(buf)
        request.endAudio()
        var finished = false
        var task: SFSpeechRecognitionTask?
        let finish: (String, Error?) -> Void = { text, err in
            if finished { return }
            finished = true
            task?.cancel()
            done(text, err)
        }
        task = r.recognitionTask(with: request) { result, error in
            if let res = result, res.isFinal { finish(res.bestTranscription.formattedString, nil); return }
            if let e = error {
                Out.err("STT: \(e.localizedDescription)")
                finish(result?.bestTranscription.formattedString ?? "", e)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { if !finished { Out.err("STT timed out"); finish("", NSError(domain: "speech-server", code: -1, userInfo: [NSLocalizedDescriptionKey: "timed out"])) } }
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
            Recognizer.recognize(pcm: audio, rate: sttRate, channels: sttChannels, language: sttLanguage) { [weak self] text in
                Out.err("STT -> \(text.isEmpty ? "(empty)" : "\"\(text.prefix(80))\"")")
                self?.send("transcript", data: ["text": text])
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

// MARK: - file transcription (meeting recordings)

// `speech-server transcribe-file <wav> [--language en-US] [--me NAME] [--others NAME]`
// Transcribes a meeting recording on this Mac and prints the diarizer contract (docs/meetings-api.md):
// {"segments":[{"speaker","start","end","text"}, …], "speaker_report": {…}} — segments ordered by
// time. Apple's speech APIs transcribe but do not tell voices apart, so the speakers come from the
// recorder's fixed stereo layout: left = the operator's microphone ("me"), right = system audio
// (everyone else). Each channel is transcribed on its own and the two are merged by time.
//   macOS 26+: SpeechAnalyzer + SpeechTranscriber (time-indexed, on-device; the language model is
//              downloaded by AssetInventory the first time).
//   macOS 14/15: SFSpeechRecognizer on-device, the channel cut into <= 55 s pieces at quiet points
//              (server-based recognition is capped at one minute; on-device is not, but memory is).
enum FileTranscriber {
    struct Seg { let speaker: String; var start: Double; var end: Double; var text: String }

    static func run(path: String, language: String, me: String, others: String) {
        let url = URL(fileURLWithPath: path)
        guard let file = try? AVAudioFile(forReading: url) else { fail("cannot read \(path)"); return }
        let fmt = file.processingFormat
        let channels = Int(fmt.channelCount), rate = fmt.sampleRate, frames = Int(file.length)
        guard frames > 0, let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(frames)) else { fail("empty recording"); return }
        do { try file.read(into: buf) } catch { fail("read failed: \(error.localizedDescription)"); return }
        let duration = Double(frames) / rate
        Out.err("transcribe-file: \(path) \(channels)ch @\(Int(rate))Hz \(String(format: "%.1f", duration)) s")
        // Mono float copies per channel: [0] = me (left), [1] = others (right); a mono file is "others".
        var lanes: [(speaker: String, samples: [Float])] = []
        if let f = buf.floatChannelData {
            for c in 0..<channels {
                let samples = Array(UnsafeBufferPointer(start: f[c], count: frames))
                lanes.append((channels == 1 ? others : (c == 0 ? me : others), samples))
            }
        } else if let i16 = buf.int16ChannelData {
            for c in 0..<channels {
                let raw = UnsafeBufferPointer(start: i16[c], count: frames)
                lanes.append((channels == 1 ? others : (c == 0 ? me : others), raw.map { Float($0) / 32768 }))
            }
        }
        if lanes.count > 2 { lanes = Array(lanes.prefix(2)) }
        Task {
            var all: [Seg] = []
            var engine = "sfspeech"
            for lane in lanes {
                if isSilent(lane.samples) { Out.err("\(lane.speaker): channel is silent, skipped"); continue }
                var segs: [Seg]? = nil
                if #available(macOS 26, *) {
                    segs = await analyzerTranscribe(samples: lane.samples, rate: rate, language: language, speaker: lane.speaker)
                    if segs != nil { engine = "speechanalyzer" }
                }
                if segs == nil { segs = await legacyTranscribe(samples: lane.samples, rate: rate, language: language, speaker: lane.speaker) }
                all.append(contentsOf: segs ?? [])
            }
            all.sort { $0.start < $1.start }
            let bySpeaker = Dictionary(grouping: all, by: { $0.speaker })
            let report: [String: Any] = [
                "engine": engine, "language": language, "on_device": true, "diarization": "stereo-channels",
                "speaker_count": bySpeaker.count,
                "speakers": bySpeaker.map { ["label": $0.key, "identified": $0.key == me, "duration_sec": (($0.value.map { $0.end - $0.start }.reduce(0, +)) * 100).rounded() / 100] },
            ]
            let out: [String: Any] = [
                "engine": engine, "language": language, "duration_sec": (duration * 100).rounded() / 100, "speaker_report": report,
                "segments": all.map { ["speaker": $0.speaker, "start": ($0.start * 100).rounded() / 100, "end": ($0.end * 100).rounded() / 100, "text": $0.text] },
            ]
            Out.line(Out.json(out))
            exit(0)
        }
        RunLoop.main.run()
    }

    static func fail(_ msg: String) { Out.line(Out.json(["error": msg])); exit(1) }

    static func isSilent(_ s: [Float]) -> Bool {
        var acc: Float = 0
        for v in s { acc += v * v }
        return s.isEmpty || (acc / Float(s.count)).squareRoot() < 0.002
    }

    /// Mono Float32 buffer (non-interleaved) for the recognizers.
    static func pcmBuffer(_ samples: ArraySlice<Float>, rate: Double) -> AVAudioPCMBuffer? {
        guard let f = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false),
              let b = AVAudioPCMBuffer(pcmFormat: f, frameCapacity: AVAudioFrameCount(samples.count)) else { return nil }
        b.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { src in b.floatChannelData![0].update(from: src.baseAddress!, count: samples.count) }
        return b
    }

    // -- macOS 26: SpeechAnalyzer --------------------------------------------------------------
    @available(macOS 26, *)
    static func analyzerTranscribe(samples: [Float], rate: Double, language: String, speaker: String, budget: Double? = nil) async -> [Seg]? {
        do {
            let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: language)) ?? Locale(identifier: language)
            let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
            // An installed model is used as is; anything else goes through the installation request
            // (a first-time download of a language takes up to a minute, logged as such).
            if await AssetInventory.status(forModules: [transcriber]) != .installed,
               let req = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                Out.err("\(speaker): downloading the \(locale.identifier) speech model …")
                try await req.downloadAndInstall()
                Out.err("\(speaker): model installed")
            }
            // The analyzer reads from a file: write the lane to a temporary mono WAV. The writer must be
            // closed (deinitialized) before the file is opened for reading, or the reader sees no audio.
            let tmp = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("bedrock-lane-\(UUID().uuidString).wav")
            guard let b = pcmBuffer(samples[...], rate: rate) else { return nil }
            do {
                let outFile = try AVAudioFile(forWriting: tmp, settings: [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: rate, AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false], commonFormat: .pcmFormatFloat32, interleaved: false)
                try outFile.write(from: b)
            }
            defer { try? FileManager.default.removeItem(at: tmp) }
            let inFile = try AVAudioFile(forReading: tmp)
            let seconds = Double(inFile.length) / inFile.processingFormat.sampleRate
            Out.err("\(speaker): analyzing \(String(format: "%.1f", seconds)) s")
            let analyzer = SpeechAnalyzer(modules: [transcriber], options: .init(priority: .userInitiated, modelRetention: .processLifetime))
            let collector = Task { () -> [Seg] in
                var out: [Seg] = []
                for try await r in transcriber.results where r.isFinal {
                    let text = String(r.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
                    if text.isEmpty { continue }
                    out.append(Seg(speaker: speaker, start: r.range.start.seconds, end: r.range.end.seconds, text: text))
                }
                return out
            }
            // Feed the whole file, then close the input explicitly: the results stream ends only once the
            // analyzer has finished, and finishAfterFile alone was seen to leave it waiting.
            let lastTime = try await analyzer.analyzeSequence(from: inFile)
            if let t = lastTime { try await analyzer.finalizeAndFinish(through: t) } else { try await analyzer.finalizeAndFinishThroughEndOfInput() }
            // Watchdog: transcription of a file should not take longer than the file itself several times over.
            let budgetNs = UInt64(budget ?? max(60, seconds * 4)) * 1_000_000_000
            let timeout = Task { try await Task.sleep(nanoseconds: budgetNs); collector.cancel() }
            let segs = try await collector.value
            timeout.cancel()
            Out.err("\(speaker): \(segs.count) segment(s) via SpeechAnalyzer")
            return segs
        } catch {
            Out.err("\(speaker): SpeechAnalyzer unavailable (\(error.localizedDescription)) — falling back to SFSpeechRecognizer")
            return nil
        }
    }

    // -- macOS 14/15: SFSpeechRecognizer in pieces ---------------------------------------------
    static func legacyTranscribe(samples: [Float], rate: Double, language: String, speaker: String) async -> [Seg] {
        await withCheckedContinuation { cont in
            Recognizer.ensureAuthorized {
                guard Recognizer.authStatus == .authorized, let r = Recognizer.recognizer(for: language), r.isAvailable else {
                    Out.err("\(speaker): speech recognition not authorized (\(Recognizer.authString()))"); cont.resume(returning: []); return
                }
                let pieces = split(samples, rate: rate)
                Out.err("\(speaker): \(pieces.count) piece(s) via SFSpeechRecognizer")
                var out: [Seg] = []
                func next(_ i: Int) {
                    if i >= pieces.count { cont.resume(returning: out); return }
                    let (offset, slice) = pieces[i]
                    guard let b = pcmBuffer(slice, rate: rate) else { next(i + 1); return }
                    Recognizer.run(r, b, onDevice: Recognizer.onDevice(r), timeout: 120) { text, err in
                        if let e = err, Recognizer.isDictationDisabled(e) {
                            Recognizer.run(r, b, onDevice: false, timeout: 120) { text2, _ in out.append(contentsOf: group(text2, offset: offset, length: Double(slice.count) / rate, speaker: speaker)); next(i + 1) }
                            return
                        }
                        out.append(contentsOf: group(text, offset: offset, length: Double(slice.count) / rate, speaker: speaker))
                        next(i + 1)
                    }
                }
                next(0)
            }
        }
    }
    /// Cut at the quietest 20 ms window inside the last 15 s of each <= 55 s piece.
    static func split(_ s: [Float], rate: Double) -> [(Double, ArraySlice<Float>)] {
        let maxLen = Int(55 * rate), win = Int(0.02 * rate), search = Int(15 * rate)
        var out: [(Double, ArraySlice<Float>)] = []
        var start = 0
        while start < s.count {
            var end = min(s.count, start + maxLen)
            if end < s.count {
                var best = end, bestE = Float.greatestFiniteMagnitude
                var i = max(start + maxLen - search, start + win)
                while i + win <= end { var e: Float = 0; for j in i..<(i + win) { e += s[j] * s[j] }; if e < bestE { bestE = e; best = i }; i += win }
                end = best
            }
            out.append((Double(start) / rate, s[start..<end]))
            start = end
        }
        return out
    }
    /// One recognized piece becomes one segment (the legacy API's word timings are not reliable enough to cut finer).
    static func group(_ text: String, offset: Double, length: Double, speaker: String) -> [Seg] {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? [] : [Seg(speaker: speaker, start: offset, end: offset + length, text: t)]
    }
}

@main struct SpeechServer {
    static var listeners: [NWListener] = []
    static func main() {
        Out.setup()
        // One-shot file transcription for the meeting pipeline (no server, no stdin guard).
        let argv = Array(CommandLine.arguments.dropFirst())
        if argv.first == "transcribe-file" {
            var path = "", language = opts.language, me = "Me", others = "Others"
            var i = 1
            while i < argv.count {
                switch argv[i] {
                case "--language": if i + 1 < argv.count { language = argv[i + 1]; i += 1 }
                case "--me": if i + 1 < argv.count { me = argv[i + 1]; i += 1 }
                case "--others": if i + 1 < argv.count { others = argv[i + 1]; i += 1 }
                default: if path.isEmpty { path = argv[i] }
                }
                i += 1
            }
            if path.isEmpty { FileTranscriber.fail("usage: speech-server transcribe-file <wav> [--language en-US] [--me NAME] [--others NAME]") }
            FileTranscriber.run(path: path, language: language.isEmpty || language == "en" ? "en-US" : language, me: me, others: others)
            return
        }
        ParentGuard.exitOnStdinEOF()
        guard let stt = listen(port: opts.sttPort, kind: "stt"), let tts = listen(port: opts.ttsPort, kind: "tts") else {
            Out.line(Out.json(["event": "error", "message": "could not listen on \(opts.host):\(opts.sttPort)/\(opts.ttsPort) (ports in use?)"]))
            exit(1)
        }
        listeners = [stt, tts]
        let r = Recognizer.recognizer(for: "")
        // No authorization request here (see Recognizer.ensureAuthorized): reading the status is free.
        Out.line(Out.json(["event": "ready", "host": opts.host, "sttPort": Int(opts.sttPort), "ttsPort": Int(opts.ttsPort), "language": opts.language,
                           "speechAuth": Recognizer.authString(), "onDevice": Recognizer.onDevice(r), "recognizerAvailable": r?.isAvailable ?? false, "engine": Recognizer.engineName(),
                           "voice": opts.voice, "voices": Speaker.voices()]))
        // A real main run loop (not just the main dispatch queue): AVSpeechSynthesizer's write
        // callbacks and the Speech framework's replies are delivered through it.
        RunLoop.main.run()
    }
}
