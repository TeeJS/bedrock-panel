#!/usr/bin/env python3
"""
speech-server.py — the built-in speech engine on Linux: Wyoming speech and listening, locally.

Why this exists: Linux is the only platform where a fresh install can neither speak nor listen.
macOS has a built-in engine (native/mac/speech-server) and Windows has the tts-stt-windows helper;
Linux asked the user to stand up their own Wyoming server, which a general audience will never do.

Why it speaks Wyoming on the standard ports rather than something private: every voice path in this
app already speaks Wyoming, and so does Home Assistant and everything else in that ecosystem. Serving
127.0.0.1:10200 means nothing downstream changes and anything else on the machine can use it too,
exactly as the macOS engine and the Windows helper already do. Same convention on all three.

Why a separate process rather than code inside main.js: it holds a ~40 MB model resident and it is
the kind of thing that should survive being restarted on its own. Its lifecycle is a process, not an
object, and if it is ever worth publishing standalone it lifts out without a rewrite.

Why Piper, and why its JSON mode: Piper is the reference implementation behind wyoming-piper, which
is what this app's own client (app/claudevoice-wyoming.js) was built and debugged against, so the
audio matches what the rest of the app already expects. Loading the voice costs about 1.4 s and each
sentence then costs about 0.25 s (measured on an i5-10210U laptop with no GPU), so the process stays
resident and utterances are fed to it. `--json-input` gives a clean end-of-utterance signal: Piper
prints the finished file's path on stdout when the WAV is complete. Raw-stdout mode has no such
marker -- its per-utterance log line reports a CUMULATIVE audio length that does not match the bytes
written, so framing an utterance from it is guesswork. A finished file is not.

Listening is sherpa-onnx rather than Piper, run per utterance rather than kept resident, and that is
a measured choice too: the tiny model loads in about half a second and transcribes 3.85 s of speech
in 0.086 s on the same laptop, so a whole utterance costs about 0.6 s from spawn to transcript.
Holding a second model resident to save half a second of a pause the person is already taking is not
worth the memory on a small machine.

Protocol on the socket (Wyoming, framed as <header-json>\n[data block][payload block]):
  speaking, on the TTS port:
    describe      -> info          what this server is, for clients that discover before using
    synthesize    -> audio-start, audio-chunk*, audio-stop
  listening, on the STT port:
    describe      -> info
    transcribe, audio-start, audio-chunk*, audio-stop  -> transcript
Anything else is ignored rather than answered, because a Wyoming client treats silence as "not
supported" and an error reply as a fault.

Either half runs without the other: pass the Piper arguments, the sherpa-onnx arguments, or both.
A half whose port is already served is skipped rather than fought over -- that is someone else's
Wyoming server and it wins. Exit 3 means neither half could be served.

Exits on stdin EOF, the parent-death guard every helper in this project uses.
"""

import argparse
import json
import os
import socketserver
import subprocess
import sys
import tempfile
import threading
import wave

# Piper emits 16-bit mono; the rate comes from the voice, so it is read off each WAV rather than
# assumed. wyoming-piper streams 1024 samples at a time and the app's player is happy with that.
SAMPLES_PER_CHUNK = 1024


def log(message):
    sys.stderr.write(message + '\n')
    sys.stderr.flush()


class Piper:
    """One resident piper process. Serialized: one utterance at a time, which is all the app asks
    for -- claudevoice-speech.js synthesizes sentence by sentence precisely to avoid overlap."""

    def __init__(self, binary, model, config, lib_dir=None):
        self.binary, self.model, self.config, self.lib_dir = binary, model, config, lib_dir
        self.lock = threading.Lock()
        self.proc = None
        self.tmp = tempfile.mkdtemp(prefix='bedrock-tts-')

    def start(self):
        env = dict(os.environ)
        if self.lib_dir:
            # The shipped piper is a tarball with its own libespeak-ng and onnxruntime beside it.
            env['LD_LIBRARY_PATH'] = self.lib_dir + os.pathsep + env.get('LD_LIBRARY_PATH', '')
        args = [self.binary, '--model', self.model, '--json-input']
        if self.config:
            args += ['--config', self.config]
        self.proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, env=env, text=True, bufsize=1)
        log('piper started, voice ' + os.path.basename(self.model))

    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    def synthesize(self, text):
        """Text in, path to a finished WAV out. None when piper could not produce one."""
        with self.lock:
            if not self.alive():
                # A crashed voice must not take the server down with it: the next request restarts it.
                log('piper is not running; restarting it')
                self.start()
            path = os.path.join(self.tmp, 'utt%d.wav' % threading.get_ident())
            try:
                self.proc.stdin.write(json.dumps({'text': text, 'output_file': path}) + '\n')
                self.proc.stdin.flush()
                line = self.proc.stdout.readline()
            except (BrokenPipeError, OSError) as exc:
                log('piper write failed: %s' % exc)
                return None
            if not line:
                log('piper closed its output')
                return None
            produced = line.strip() or path
            return produced if os.path.exists(produced) else None

    def stop(self):
        if self.proc:
            try:
                self.proc.stdin.close()
            except OSError:
                pass
            try:
                self.proc.terminate()
            except OSError:
                pass


class Recognizer:
    """sherpa-onnx, run once per utterance. No lock and no resident model: each call is its own
    process, so two utterances at once simply do not interfere."""

    def __init__(self, binary, lib_dir, model_dir):
        self.binary, self.lib_dir, self.model_dir = binary, lib_dir, model_dir
        self.tmp = tempfile.mkdtemp(prefix='bedrock-stt-')

    def model_args(self, language=''):
        """Whichever recognition model was downloaded, as command-line arguments.

        Two families are supported and told apart by the files present rather than by configuration,
        so a model directory is self-describing. Whisper is the multilingual one and takes a spoken
        LANGUAGE, which is why the Wyoming transcribe event's language field is threaded all the way
        down here: without it, Live Translate's "source language" setting is decoration.

        Whisper's tail padding is deliberately left at the default. sherpa suggests 300 for
        multilingual models, and measured on real speech that made it repeat the opening words of
        every utterance; the default produced clean text."""
        return self._whisper_args(language) or self._moonshine_args()

    def _whisper_args(self, language=''):
        # Matched by shape rather than by name: every whisper release names its files after the model
        # (tiny-, base-, small-, turbo-), so listing them would mean editing this for each new one.
        # int8 first, which is what the other implementations prefer too: much faster on a CPU for a
        # difference dictation does not notice.
        enc = self._match('-encoder.int8.onnx') or self._match('-encoder.onnx')
        dec = self._match('-decoder.int8.onnx') or self._match('-decoder.onnx')
        tokens = self._match('-tokens.txt')
        if not (enc and dec and tokens):
            return None
        args = ['--whisper-encoder=' + enc, '--whisper-decoder=' + dec, '--tokens=' + tokens,
                '--model-type=whisper', '--num-threads=4']
        # No language given means whisper detects it, which it does well; a wrong one is worse than
        # none, so only a plain two-letter code is passed through.
        code = str(language or '').strip().lower()[:5]
        if code and all(c.isalpha() or c == '-' for c in code):
            args.append('--whisper-language=' + code.split('-')[0])
        return args

    def _moonshine_args(self):
        enc = self._first('encoder_model.ort')
        tokens = self._first('tokens.txt')
        if not (enc and tokens):
            return None
        merged = self._first('decoder_model_merged.ort')
        if merged:
            return ['--moonshine-encoder=' + enc, '--moonshine-merged-decoder=' + merged, '--tokens=' + tokens]
        parts = [self._first(n) for n in ('preprocess.ort', 'uncached_decode.ort', 'cached_decode.ort')]
        if not all(parts):
            return None
        return ['--moonshine-preprocessor=' + parts[0], '--moonshine-encoder=' + enc,
                '--moonshine-uncached-decoder=' + parts[1], '--moonshine-cached-decoder=' + parts[2],
                '--tokens=' + tokens]

    def _first(self, *names):
        for n in names:
            p = os.path.join(self.model_dir, n)
            if os.path.exists(p):
                return p
        return None

    def _match(self, suffix):
        try:
            names = sorted(os.listdir(self.model_dir))
        except OSError:
            return None
        for n in names:
            if n.endswith(suffix):
                return os.path.join(self.model_dir, n)
        return None

    def usable(self):
        return os.path.exists(self.binary) and self.model_args() is not None

    def transcribe(self, pcm, rate, width, channels, language=''):
        """16-bit PCM in, text out. Empty string when nothing could be recognized, which a client
        reads as silence rather than as a fault."""
        args = self.model_args(language)
        if not args or not pcm:
            return ''
        path = os.path.join(self.tmp, 'utt%d.wav' % threading.get_ident())
        try:
            with wave.open(path, 'wb') as wav:
                wav.setnchannels(channels or 1)
                wav.setsampwidth(width or 2)
                wav.setframerate(rate or 16000)
                wav.writeframes(pcm)
            env = dict(os.environ)
            if self.lib_dir:
                env['LD_LIBRARY_PATH'] = self.lib_dir + os.pathsep + env.get('LD_LIBRARY_PATH', '')
            out = subprocess.run([self.binary] + args + [path], capture_output=True, text=True,
                                 env=env, timeout=120)
        except (OSError, wave.Error, subprocess.TimeoutExpired) as exc:
            log('recognition failed: %s' % exc)
            return ''
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass
        # The binary prints its configuration and then one JSON object per file. Only the JSON is
        # wanted, and only its text: everything else on that stream is diagnostics.
        for line in reversed(out.stdout.splitlines()):
            line = line.strip()
            if line.startswith('{'):
                try:
                    return str(json.loads(line).get('text') or '').strip()
                except ValueError:
                    continue
        log('no transcript in recognizer output')
        return ''


def write_event(conn, event_type, data=None, payload=None):
    header = {'type': event_type}
    if data is not None:
        header['data'] = data
    if payload:
        header['payload_length'] = len(payload)
    conn.sendall((json.dumps(header) + '\n').encode('utf-8'))
    if payload:
        conn.sendall(payload)


def read_event(reader):
    """One Wyoming event, or None at end of stream. Data may arrive inline in the header or as its
    own length-prefixed block; real servers write the block, so both are accepted here."""
    line = reader.readline()
    if not line:
        return None
    try:
        header = json.loads(line.decode('utf-8'))
    except ValueError:
        return {'type': '', 'data': {}, 'payload': b''}
    data = header.get('data') or {}
    if header.get('data_length'):
        block = reader.read(header['data_length'])
        try:
            data = json.loads(block.decode('utf-8'))
        except ValueError:
            data = {}
    payload = reader.read(header['payload_length']) if header.get('payload_length') else b''
    return {'type': header.get('type', ''), 'data': data, 'payload': payload}


def asr_info(model_name, languages):
    return {
        'tts': [], 'wake': [], 'handle': [], 'intent': [], 'satellite': None,
        'asr': [{
            'name': 'bedrock-panel',
            'description': 'Bedrock Panel built-in listening (sherpa-onnx)',
            'attribution': {'name': 'sherpa-onnx', 'url': 'https://github.com/k2-fsa/sherpa-onnx'},
            'installed': True, 'version': None,
            'models': [{
                'name': model_name,
                'description': model_name,
                'attribution': {'name': 'sherpa-onnx', 'url': 'https://github.com/k2-fsa/sherpa-onnx'},
                'installed': True, 'version': None, 'languages': languages,
            }],
        }],
    }


def info_event(voice_name, languages):
    return {
        'asr': [], 'wake': [], 'handle': [], 'intent': [], 'satellite': None,
        'tts': [{
            'name': 'bedrock-panel',
            'description': 'Bedrock Panel built-in speech (Piper)',
            'attribution': {'name': 'Piper', 'url': 'https://github.com/rhasspy/piper'},
            'installed': True, 'version': None,
            'voices': [{
                'name': voice_name,
                'description': voice_name,
                'attribution': {'name': 'Piper', 'url': 'https://github.com/rhasspy/piper'},
                'installed': True, 'version': None, 'languages': languages,
            }],
        }],
    }


class TtsHandler(socketserver.StreamRequestHandler):
    def handle(self):
        while True:
            try:
                event = read_event(self.rfile)
            except (BrokenPipeError, ConnectionResetError):
                return          # the listener interrupted; nothing to clean up
            if event is None:
                return
            if event['type'] == 'describe':
                write_event(self.request, 'info',
                            info_event(self.server.voice_name, self.server.languages))
            elif event['type'] == 'synthesize':
                self.speak(str(event['data'].get('text') or ''))

    def speak(self, text):
        if not text.strip():
            return
        path = self.server.piper.synthesize(text)
        if not path:
            # Say nothing rather than half-say something: the client's audio-stop never arrives, it
            # times out, and the log above named the real cause.
            return
        try:
            with wave.open(path, 'rb') as wav:
                rate, width, channels = wav.getframerate(), wav.getsampwidth(), wav.getnchannels()
                fmt = {'rate': rate, 'width': width, 'channels': channels}
                write_event(self.request, 'audio-start', fmt)
                while True:
                    frames = wav.readframes(SAMPLES_PER_CHUNK)
                    if not frames:
                        break
                    write_event(self.request, 'audio-chunk', fmt, frames)
                write_event(self.request, 'audio-stop', {})
        except (wave.Error, OSError) as exc:
            log('could not read synthesized audio: %s' % exc)
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass


class SttHandler(socketserver.StreamRequestHandler):
    """Collects one utterance and answers with its transcript. Wyoming sends the audio as a run of
    chunks between audio-start and audio-stop; the format comes from audio-start rather than being
    assumed, because a client that resamples is entitled to tell us so."""

    def handle(self):
        pcm = bytearray()
        fmt = {'rate': 16000, 'width': 2, 'channels': 1}
        language = ''
        while True:
            try:
                event = read_event(self.rfile)
            except (BrokenPipeError, ConnectionResetError):
                return
            kind = event['type']
            if kind == 'describe':
                write_event(self.request, 'info', asr_info(self.server.model_name, self.server.languages))
            elif kind == 'transcribe':
                # The client naming the spoken language, which is what Live Translate sets.
                language = str(event['data'].get('language') or '')
            elif kind == 'audio-start':
                pcm = bytearray()
                for key in ('rate', 'width', 'channels'):
                    if event['data'].get(key):
                        fmt[key] = int(event['data'][key])
            elif kind == 'audio-chunk':
                pcm.extend(event['payload'])
            elif kind == 'audio-stop':
                text = self.server.recognizer.transcribe(bytes(pcm), fmt['rate'], fmt['width'], fmt['channels'], language)
                write_event(self.request, 'transcript', {'text': text})
                pcm = bytearray()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = False   # a bind failure must be visible: something else owns the port
    daemon_threads = True

    def handle_error(self, request, client_address):
        """A client hanging up mid-sentence is normal, not an error. The voice apps cancel speech by
        dropping the socket -- that IS the barge-in signal -- so every interruption would otherwise
        print a traceback, and a log full of tracebacks hides the ones that mean something."""
        kind = sys.exc_info()[0]
        if kind is not None and issubclass(kind, (BrokenPipeError, ConnectionResetError)):
            return
        socketserver.ThreadingTCPServer.handle_error(self, request, client_address)


def main():
    ap = argparse.ArgumentParser(description='Bedrock Panel built-in speech (Wyoming)')
    ap.add_argument('--piper', default='', help='the piper binary (omit to serve listening only)')
    ap.add_argument('--model', default='', help='the voice .onnx')
    ap.add_argument('--config', default='', help='the voice .onnx.json (default: model + .json)')
    ap.add_argument('--lib-dir', default='', help="directory holding piper's own shared libraries")
    ap.add_argument('--stt-binary', default='', help='the sherpa-onnx-offline binary (omit to serve speaking only)')
    ap.add_argument('--stt-lib-dir', default='', help="directory holding sherpa-onnx's shared libraries")
    ap.add_argument('--stt-model-dir', default='', help='the recognition model directory')
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=10200, help='the TTS port')
    ap.add_argument('--stt-port', type=int, default=10300)
    args = ap.parse_args()

    servers = []
    served = []

    def listen(port, handler, attrs):
        """Bind one half, or report that someone else already serves it. A taken port is not an
        error: it is another Wyoming server doing this job, and it wins."""
        try:
            server = Server((args.host, port), handler)
        except OSError as exc:
            log('port %d is already in use, leaving it alone: %s' % (port, exc))
            return None
        for key, value in attrs.items():
            setattr(server, key, value)
        servers.append(server)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return server

    piper = None
    if args.piper and args.model:
        if not (os.path.exists(args.piper) and os.path.exists(args.model)):
            log('the voice is not where it should be; speaking is off')
        else:
            piper = Piper(args.piper, args.model, args.config or (args.model + '.json'), args.lib_dir or None)
            try:
                piper.start()
            except OSError as exc:
                log('cannot start piper: %s' % exc)
                piper = None
    if piper:
        name = os.path.splitext(os.path.basename(args.model))[0]
        if listen(args.port, TtsHandler, {
                'piper': piper, 'voice_name': name,
                'languages': [name.split('-')[0]] if '-' in name else []}):
            served.append('tts')
        else:
            piper.stop()
            piper = None

    recognizer = None
    if args.stt_binary and args.stt_model_dir:
        recognizer = Recognizer(args.stt_binary, args.stt_lib_dir, args.stt_model_dir)
        if not recognizer.usable():
            log('the recognition model is incomplete; listening is off')
            recognizer = None
    if recognizer:
        name = os.path.basename(args.stt_model_dir.rstrip(os.sep))
        if listen(args.stt_port, SttHandler, {
                'recognizer': recognizer, 'model_name': name,
                'languages': ['en'] if '-en' in name else ['multilingual']}):
            served.append('stt')

    if not served:
        log('nothing could be served')
        if piper:
            piper.stop()
        return 3

    log('ready on %s (%s)' % (args.host, ', '.join(served)))
    sys.stdout.write('ready ' + ' '.join(served) + '\n')
    sys.stdout.flush()

    # Parent-death guard: the app closes our stdin when it goes away.
    done = threading.Event()

    def wait_for_parent():
        try:
            for _ in sys.stdin:
                pass
        except (OSError, ValueError):
            pass
        done.set()

    threading.Thread(target=wait_for_parent, daemon=True).start()
    try:
        done.wait()
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()
        if piper:
            piper.stop()
    return 0


if __name__ == '__main__':
    sys.exit(main())
