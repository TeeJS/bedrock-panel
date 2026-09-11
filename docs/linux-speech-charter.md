# Built-in speech on Linux — charter

## The bar

**No harder than installing tts-stt-windows on a Windows box.** That is: download something, run it,
pick your language, and the models arrive on their own. No Docker, no Python packages, no compiler,
no second machine, no cloud. It must work on an ordinary laptop with no GPU.

Anything that assumes a GPU, a home server, or a spare box on the network is a demo, not a feature.

## Where speech stands today

Every voice path in Bedrock Panel speaks **Wyoming** — Whisper STT on port 10300, Piper TTS on
10200. Three platforms, three experiences:

| Platform | Today |
|---|---|
| macOS | Built in. `native/mac/speech-server` wraps Apple recognition and the system voices and serves Wyoming on loopback, so every consumer dials it unchanged. |
| Windows | Point at [tts-stt-windows](https://github.com/TeeJS/tts-stt-windows): an 11 MB download that serves both on loopback. |
| Linux | Nothing. The host is blank by default, so voice stays off until the user stands up their own Wyoming server. |

Linux is the only platform where a fresh install cannot speak or listen at all.

## What was measured

Everything below was run on the target-shaped machine — an Intel i5-10210U laptop from 2019, four
cores, no GPU, CPU inference only. Not on a workstation.

| | Model | Download | On disk | Speed |
|---|---|---|---|---|
| Engine | sherpa-onnx 1.13.8 prebuilt, trimmed to two binaries and its libs | 27 MB | 36 MB | — |
| STT | Moonshine tiny, English, quantized | 28 MB | 43 MB | 3.85 s of speech in **0.086 s** (45× real time) |
| TTS | Piper `en_US-amy-low`, int8 | 20 MB | 37 MB | 4.93 s of audio in **0.92 s** (5× real time) |

**Roughly 75 MB to download and 116 MB on disk for a machine that both listens and speaks.**

The transcript was exact, punctuation included: *"Ask not what your country can do for you. Ask what
you can do for your country."* Model load costs about 0.5 s for STT and 1.9 s for TTS, paid once by a
resident server rather than per utterance.

For comparison, the Windows helper is an 11 MB app that then downloads its own models. We land in the
same class.

## Why sherpa-onnx rather than the obvious choices

- **whisper.cpp** has to be compiled. This port has held a no-compiler rule since the beginning —
  there is no `native/linux` tree and the deb depends only on `python3` and `python3-gi`. Adding a
  build toolchain to install a voice feature fails the bar outright.
- **faster-whisper** and **piper-tts** are Python packages, and `pip` is not guaranteed present. It
  is absent on the very machine this was measured on, which ships Python 3.14 without it. A feature
  that starts with "first install pip" fails the bar.
- **sherpa-onnx** ships prebuilt Linux x64 binaries, covers **both** halves from one dependency, runs
  on CPU, and is Apache-2.0. One download, no toolchain, no packaging system. It remains the plan for
  phase 2; phase 1 shipped Piper's own prebuilt release instead, because Piper is the implementation
  this app's Wyoming client was built against and its JSON mode gives a clean per-utterance signal.
- **speech-dispatcher** (`spd-say`) is on every desktop already and needs no download, but espeak-ng
  quality is a machine from 1990. Worth keeping as a last-resort fallback, never as the default.

## The design

A **loopback Wyoming server**, exactly the shape macOS already uses, so nothing downstream changes.
`voiceConfig.js` already has the `engine` setting — `''` decides by platform, `'wyoming'` points at
hosts, `'macos'` uses the built-in. Linux adds `'linux'` alongside it and the same rule applies: with
no hosts configured, the built-in engine wins.

- `app/linux/speech-server.py` — a Wyoming server on 127.0.0.1:10300 and :10200, wrapping the two
  sherpa-onnx binaries as long-lived processes so model load is paid once. Python because it already
  is a dependency and the protocol is plain framed JSON over TCP, which the app already speaks as a
  client in `app/claudevoice-wyoming.js`.
- **Nothing ships in the package.** The engine and models download on first use into
  `~/.config/bedrock-panel/speech/`, which keeps the deb and the AppImage the size they are today and
  means the AppImage behaves identically. Downloads are checksum-verified.
- **The editor asks once.** The TTS/STT tab gains "Set up speech on this computer": pick a language,
  watch a progress bar, done. Same flow as the Windows helper, minus the download-and-unzip step,
  because the app is already installed.
- **Pointing at a server stays.** Anyone with a beefier box keeps the existing host fields, and they
  win over the built-in engine when set.

## Phasing

- **Phase 1 — TTS. Done.** The app speaks on a fresh install. `app/linux/speech-server.py` holds a
  resident Piper and serves Wyoming on 127.0.0.1:10200; `app/linuxSpeech.js` supervises it;
  `app/linuxSpeechInstall.js` downloads and verifies the engine and voice; `app/linuxSpeechCatalog.js`
  pins what may be fetched; the editor's TTS/STT tab sets it up. Two findings worth carrying forward:
  Piper's raw-stdout mode has no usable end-of-utterance marker (its log line undercounts the audio
  it wrote), and the built-in engine must key off the TTS host alone rather than both hosts, or
  configuring only a Whisper server silently mutes the machine.
- **Phase 2 — STT.** Dictation and the voice apps listen. Reuses Phase 1's downloader and server.
- **Phase 3 — languages.** The picker offers more than English, which decides which model is fetched.

## Open questions

1. ~~**Voice licensing varies per voice.**~~ Settled by reading the MODEL_CARD of every English
   voice: most of the good ones are CC BY-NC-SA or carry a bespoke research licence and cannot ship.
   Twelve are public domain or CC0, and the four in the catalogue come from that set. Any voice added
   later must be checked the same way.
2. **Non-English is unmeasured.** Moonshine tiny is English-only; other languages mean Whisper tiny
   at 112 MB or the per-language Moonshine builds, and neither size nor accuracy has been checked.
3. **arm64 is unmeasured**, along with the rest of the Linux port.
4. **Resident vs per-utterance.** The numbers above argue for resident, but a long-idle panel holding
   a loaded TTS model costs memory that a 4 GB machine may not want to spare. Worth measuring the
   resident footprint before deciding whether to unload after an idle period.
