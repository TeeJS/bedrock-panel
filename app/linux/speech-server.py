#!/usr/bin/env python3
"""
speech-server.py — the built-in speech engine on Linux: a Wyoming TTS server over a resident Piper.

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

Protocol on the socket (Wyoming, framed as <header-json>\n[data block][payload block]):
    describe      -> info          what this server is, for clients that discover before using
    synthesize    -> audio-start, audio-chunk*, audio-stop
Anything else is ignored rather than answered, because a Wyoming client treats silence as "not
supported" and an error reply as a fault.

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


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        while True:
            event = read_event(self.rfile)
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


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = False   # a bind failure must be visible: something else owns the port
    daemon_threads = True


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[1])
    ap.add_argument('--piper', required=True, help='the piper binary')
    ap.add_argument('--model', required=True, help='the voice .onnx')
    ap.add_argument('--config', default='', help='the voice .onnx.json (default: model + .json)')
    ap.add_argument('--lib-dir', default='', help='directory holding piper\'s own shared libraries')
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=10200)
    args = ap.parse_args()

    for path in (args.piper, args.model):
        if not os.path.exists(path):
            log('missing: ' + path)
            return 2

    piper = Piper(args.piper, args.model, args.config or (args.model + '.json'), args.lib_dir or None)
    try:
        piper.start()
    except OSError as exc:
        log('cannot start piper: %s' % exc)
        return 2

    try:
        server = Server((args.host, args.port), Handler)
    except OSError as exc:
        # Something already serves this port. The caller decides what that means -- the rule is to
        # use the existing server rather than fight it -- so say it plainly and exit distinctly.
        log('port %d is already in use: %s' % (args.port, exc))
        piper.stop()
        return 3

    server.piper = piper
    server.voice_name = os.path.splitext(os.path.basename(args.model))[0]
    server.languages = [server.voice_name.split('-')[0]] if '-' in server.voice_name else []
    log('ready on %s:%d' % (args.host, args.port))
    sys.stdout.write('ready\n')
    sys.stdout.flush()

    # Parent-death guard: the app closes our stdin when it goes away.
    def wait_for_parent():
        try:
            for _ in sys.stdin:
                pass
        except (OSError, ValueError):
            pass
        server.shutdown()

    threading.Thread(target=wait_for_parent, daemon=True).start()
    try:
        server.serve_forever()
    finally:
        piper.stop()
        server.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
