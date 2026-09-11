#!/usr/bin/env python3
"""
speaker-embed.py — a voice fingerprint for a span of audio, on Linux.

Why this exists: telling people apart is one job and knowing WHO they are is another. Diarization
gives "this is the same voice as that", which is enough to write Speaker 1 and Speaker 2 in a
transcript and no help at all when the reader wants names. Naming needs a comparable fingerprint --
an embedding -- for a stretch of speech, so it can be matched against people who have been enrolled.

Why ctypes rather than a command: sherpa-onnx ships speaker identification only as live-microphone
and ALSA programs, neither of which can be pointed at a file. The same capability is in its C API,
which is a handful of plain functions over a pointer, so this drives libsherpa-onnx-c-api.so
directly. No pip, no compiler, nothing new downloaded -- the library and the model are already here
for diarization.

The model is a 512-dimension WeSpeaker VoxCeleb embedder (Apache-2.0). Two recordings of one person
score high against each other and low against anyone else; how high is a threshold the caller owns,
because it trades false names against missing ones and only the caller knows which is worse.

Protocol -- one JSON request per line on stdin, one JSON reply per line on stdout:
    {"wav": "/path/file.wav", "spans": [[0.5, 4.2], ...]}  -> {"embedding": [...512 floats...]}
    spans is optional; without it the whole file is used, which is what enrolling a clip wants.
    {"error": "..."} on anything that could not be done.
Exits on stdin EOF, the parent-death guard every helper in this project uses.

Audio is resampled to what the model expects by taking every nth sample, which is crude and
deliberately so: an embedding is a coarse summary of a voice, the recorder already writes 16 kHz,
and pulling in a resampling library for the rare off-rate file would cost more than it is worth.
"""

import ctypes
import json
import struct
import sys
import wave

MODEL_RATE = 16000


class ExtractorConfig(ctypes.Structure):
    _fields_ = [('model', ctypes.c_char_p), ('num_threads', ctypes.c_int32),
                ('debug', ctypes.c_int32), ('provider', ctypes.c_char_p)]


def reply(obj):
    sys.stdout.write(json.dumps(obj) + '\n')
    sys.stdout.flush()


class Embedder:
    def __init__(self, lib_path, model_path):
        lib = ctypes.CDLL(lib_path)
        lib.SherpaOnnxCreateSpeakerEmbeddingExtractor.argtypes = [ctypes.POINTER(ExtractorConfig)]
        lib.SherpaOnnxCreateSpeakerEmbeddingExtractor.restype = ctypes.c_void_p
        lib.SherpaOnnxSpeakerEmbeddingExtractorDim.argtypes = [ctypes.c_void_p]
        lib.SherpaOnnxSpeakerEmbeddingExtractorDim.restype = ctypes.c_int32
        lib.SherpaOnnxSpeakerEmbeddingExtractorCreateStream.argtypes = [ctypes.c_void_p]
        lib.SherpaOnnxSpeakerEmbeddingExtractorCreateStream.restype = ctypes.c_void_p
        lib.SherpaOnnxOnlineStreamAcceptWaveform.argtypes = [
            ctypes.c_void_p, ctypes.c_int32, ctypes.POINTER(ctypes.c_float), ctypes.c_int32]
        lib.SherpaOnnxOnlineStreamInputFinished.argtypes = [ctypes.c_void_p]
        lib.SherpaOnnxSpeakerEmbeddingExtractorComputeEmbedding.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        lib.SherpaOnnxSpeakerEmbeddingExtractorComputeEmbedding.restype = ctypes.POINTER(ctypes.c_float)
        lib.SherpaOnnxSpeakerEmbeddingExtractorDestroyEmbedding.argtypes = [ctypes.POINTER(ctypes.c_float)]
        lib.SherpaOnnxDestroyOnlineStream.argtypes = [ctypes.c_void_p]
        self.lib = lib
        cfg = ExtractorConfig(model=model_path.encode(), num_threads=1, debug=0, provider=b'cpu')
        self.extractor = lib.SherpaOnnxCreateSpeakerEmbeddingExtractor(ctypes.byref(cfg))
        if not self.extractor:
            raise RuntimeError('the speaker model could not be loaded')
        self.dim = lib.SherpaOnnxSpeakerEmbeddingExtractorDim(self.extractor)

    def embed(self, samples):
        """samples: floats in -1..1 at MODEL_RATE. Returns the embedding, or None if too short."""
        if len(samples) < MODEL_RATE // 2:      # under half a second is not a voice, it is a noise
            return None
        arr = (ctypes.c_float * len(samples))(*samples)
        stream = self.lib.SherpaOnnxSpeakerEmbeddingExtractorCreateStream(self.extractor)
        try:
            self.lib.SherpaOnnxOnlineStreamAcceptWaveform(stream, MODEL_RATE, arr, len(samples))
            self.lib.SherpaOnnxOnlineStreamInputFinished(stream)
            ptr = self.lib.SherpaOnnxSpeakerEmbeddingExtractorComputeEmbedding(self.extractor, stream)
            if not ptr:
                return None
            vector = [float(ptr[i]) for i in range(self.dim)]
            self.lib.SherpaOnnxSpeakerEmbeddingExtractorDestroyEmbedding(ptr)
            return vector
        finally:
            self.lib.SherpaOnnxDestroyOnlineStream(stream)


def read_samples(path, spans, channel=None):
    """The named spans of one channel, as floats at MODEL_RATE. No spans means the whole file."""
    with wave.open(path, 'rb') as wav:
        rate, channels, width = wav.getframerate(), wav.getnchannels(), wav.getsampwidth()
        if width != 2:
            raise ValueError('only 16-bit PCM is supported')
        raw = wav.readframes(wav.getnframes())
    ints = struct.unpack('<%dh' % (len(raw) // 2), raw)
    if channels > 1:
        pick = 0 if channel is None else int(channel)
        ints = ints[pick::channels]
    out = []
    ranges = spans or [[0, len(ints) / float(rate)]]
    step = rate / float(MODEL_RATE)
    for start, end in ranges:
        a = max(0, int(float(start) * rate))
        b = min(len(ints), int(float(end) * rate))
        i = 0.0
        while a + int(i) < b:
            out.append(ints[a + int(i)] / 32768.0)
            i += step
    return out


def main():
    if len(sys.argv) < 3:
        reply({'error': 'usage: speaker-embed.py <libsherpa-onnx-c-api.so> <model.onnx>'})
        return 2
    try:
        embedder = Embedder(sys.argv[1], sys.argv[2])
    except (OSError, RuntimeError) as exc:
        reply({'error': str(exc)})
        return 2
    reply({'ready': True, 'dim': embedder.dim})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            samples = read_samples(request['wav'], request.get('spans'), request.get('channel'))
            vector = embedder.embed(samples)
        except (ValueError, KeyError, OSError, wave.Error) as exc:
            reply({'error': str(exc)})
            continue
        reply({'embedding': vector} if vector else {'error': 'not enough speech to fingerprint'})
    return 0


if __name__ == '__main__':
    sys.exit(main())
