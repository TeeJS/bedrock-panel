'use strict';
// The built-in Linux speech download: what may be fetched, that it is verified, and that a failed
// verification installs nothing. Runs against a fake server and a temp directory — no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const catalog = require('../app/linuxSpeechCatalog');
const { createSpeechInstaller } = require('../app/linuxSpeechInstall');

function tempBase() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bedrock-speech-test-')); }
function md5(buf) { return crypto.createHash('md5').update(buf).digest('hex'); }

// A fake network: a map of url -> Buffer, served as a stream.
function fakeGet(files) {
  return url => {
    if (!(url in files)) return Promise.reject(new Error('HTTP 404 for ' + url));
    return Promise.resolve(Readable.from([files[url]]));
  };
}

// ---- the catalogue ------------------------------------------------------------------------

test('every shipped voice carries a licence that may actually ship', () => {
  // Piper voices inherit their training data's terms. Non-commercial and share-alike ones sound
  // just as good and cannot go in a product, so the list is curated rather than mirrored.
  const allowed = ['Public domain', 'CC0', 'CC BY 4.0', 'MIT', 'Apache-2.0'];
  for (const v of catalog.voices()) {
    assert.ok(allowed.includes(v.license), v.id + ' has licence "' + v.license + '", which cannot ship');
    assert.ok(!/NC|ShareAlike|SA\b/i.test(v.license), v.id + ' looks restricted: ' + v.license);
  }
});

test('the voice list is wide enough for people who do not speak English', () => {
  const langs = catalog.voiceLanguages();
  assert.ok(langs.length >= 25, 'only ' + langs.length + ' languages on offer');
  const names = new Set(langs.map(l => l.name));
  for (const expected of ['German', 'French', 'Spanish', 'Italian', 'Russian', 'Chinese', 'Polish']) {
    assert.ok(names.has(expected), expected + ' has no voice');
  }
  for (const l of langs) assert.ok(l.voices.length > 0, l.name + ' is listed with no voices');
});

test('every voice is listed with what a person needs to choose one', () => {
  for (const v of catalog.voices()) {
    assert.ok(v.name && v.langName, v.id + ' is missing its display fields');
    assert.ok(['x_low', 'low', 'medium', 'high'].includes(v.quality), v.id + ' quality: ' + v.quality);
    assert.match(catalog.voiceLabel(v), /—/, 'a label says who and how big, not a filename');
  }
  assert.equal(catalog.defaultVoice().lang, 'en_US', 'a fresh install speaks the app\'s own language');
  assert.match(catalog.VOICE_SAMPLES_URL, /^https:\/\//, 'somewhere to hear a voice before downloading it');
});

test('every voice is pinned well enough to verify: a full digest and a real byte count', () => {
  for (const v of catalog.voices()) {
    assert.match(v.md5, /^[0-9a-f]{32}$/, v.id + ' needs a full md5, not a truncated one');
    assert.ok(v.bytes > 1000000, v.id + ' byte count looks wrong: ' + v.bytes);
    assert.match(v.id, /^[a-z]{2}_[A-Z]{2}-/, v.id + ' is not a Piper voice id');
  }
  assert.match(catalog.ENGINE.sha256, /^[0-9a-f]{64}$/);
  assert.ok(catalog.ENGINE.bytes > 1000000);
});

test('a first install fetches the engine too; a second voice does not', () => {
  const v = catalog.defaultVoice();
  assert.equal(catalog.downloadBytes(v, false), catalog.ENGINE.bytes + v.bytes);
  assert.equal(catalog.downloadBytes(v, true), v.bytes);
});

test('a voice is two files, the model and the config Piper reads beside it', () => {
  const files = catalog.voiceFiles(catalog.voiceById('en_US-joe-medium'));
  assert.deepEqual(files.map(f => f.name), ['en_US-joe-medium.onnx', 'en_US-joe-medium.onnx.json']);
  for (const f of files) assert.match(f.url, /^https:\/\/huggingface\.co\//);
  assert.equal(catalog.voiceById('nonsense'), null);
});

// ---- the installer ------------------------------------------------------------------------

function installerFor(base, { engineBody, voiceBody, corruptVoice = false } = {}) {
  const voice = catalog.voiceById('en_US-joe-medium');
  const engine = engineBody || Buffer.from('not a real tarball');
  const model = voiceBody || Buffer.alloc(1024, 7);
  const files = {};
  files[catalog.ENGINE.url] = engine;
  const [modelFile, configFile] = catalog.voiceFiles(voice);
  files[modelFile.url] = model;
  files[configFile.url] = Buffer.from('{"audio":{"sample_rate":22050}}');
  // Pin the catalogue's expectations to this fake content, except when the test wants a mismatch.
  const realMd5 = voice.md5, realBytes = voice.bytes;
  voice.md5 = corruptVoice ? md5(Buffer.from('something else')) : md5(model);
  voice.bytes = model.length;
  const engineSha = catalog.ENGINE.sha256;
  catalog.ENGINE.sha256 = crypto.createHash('sha256').update(engine).digest('hex');
  const restore = () => { voice.md5 = realMd5; voice.bytes = realBytes; catalog.ENGINE.sha256 = engineSha; };
  const logs = [];
  const untarred = [];
  const inst = createSpeechInstaller({
    baseDir: base, log: m => logs.push(m), get: fakeGet(files),
    execFile: (bin, args, cb) => {
      // Stand in for tar: make the binary the extraction would have produced.
      untarred.push([bin, args]);
      const dest = args[args.indexOf('-C') + 1];
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, 'piper'), 'binary');
      cb(null, '', '');
    },
  });
  return { inst, logs, untarred, restore };
}

test('a first install downloads, verifies, extracts, and reports progress that adds up', async () => {
  const base = tempBase();
  const { inst, untarred, restore } = installerFor(base);
  try {
    const seen = [];
    const result = await inst.install('en_US-joe-medium', p => seen.push(p));
    assert.equal(result.voice, 'en_US-joe-medium');
    assert.equal(inst.engineInstalled(), true);
    assert.deepEqual(inst.installedVoices(), ['en_US-joe-medium']);
    assert.equal(seen[0].phase, 'start');
    assert.equal(seen[seen.length - 1].phase, 'done');
    assert.ok(seen.some(p => p.phase === 'extract'), 'the engine is a tarball and must be extracted');
    const done = seen[seen.length - 1];
    assert.equal(done.received, done.total, 'the bar must reach the end it promised at the start');
    assert.equal(untarred[0][0], 'tar');
    assert.ok(untarred[0][1].includes('--strip-components=1'), 'the tarball has a wrapping directory');
  } finally { restore(); fs.rmSync(base, { recursive: true, force: true }); }
});

test('a voice that fails its checksum installs nothing and says why', async () => {
  const base = tempBase();
  const { inst, restore } = installerFor(base, { corruptVoice: true });
  try {
    await assert.rejects(() => inst.install('en_US-joe-medium'), /checksum mismatch/);
    assert.deepEqual(inst.installedVoices(), [], 'a bad download must not look installed');
    const stray = fs.readdirSync(path.join(base, 'speech', 'voices', 'en_US-joe-medium'));
    assert.deepEqual(stray, [], 'not even a .part file is left behind');
  } finally { restore(); fs.rmSync(base, { recursive: true, force: true }); }
});

test('installing a second voice keeps the engine and does not download it again', async () => {
  const base = tempBase();
  const { inst, logs, restore } = installerFor(base);
  try {
    await inst.install('en_US-joe-medium');
    const before = logs.filter(l => /speech engine installed/.test(l)).length;
    await inst.install('en_US-joe-medium');
    const after = logs.filter(l => /speech engine installed/.test(l)).length;
    assert.equal(before, 1);
    assert.equal(after, 1, 'the engine is fetched once, not once per voice');
  } finally { restore(); fs.rmSync(base, { recursive: true, force: true }); }
});

test('removing a voice leaves the engine, since another voice may still need it', async () => {
  const base = tempBase();
  const { inst, restore } = installerFor(base);
  try {
    await inst.install('en_US-joe-medium');
    assert.equal(inst.removeVoice('en_US-joe-medium'), true);
    assert.deepEqual(inst.installedVoices(), []);
    assert.equal(inst.engineInstalled(), true);
  } finally { restore(); fs.rmSync(base, { recursive: true, force: true }); }
});

// ---- listening, a separate download from speaking ---------------------------------------------

test('listening offers a multilingual model, because an English one invents English', () => {
  // Live Translate is the case that made this non-optional: an English-only recognizer handed German
  // returns confident English nonsense, and the translator downstream translates the nonsense.
  const models = catalog.sttModels();
  assert.ok(models.some(m => m.languages.includes('en')), 'no English model');
  const multi = models.find(m => m.languages.includes('multilingual'));
  assert.ok(multi, 'nothing for anyone who does not speak English');
  assert.equal(multi.family, 'whisper', 'multilingual means whisper here');
  assert.match(multi.label, /Live Translate/, 'the label has to say what it is for');
});

test('the helper honours the spoken language the client declares', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'app', 'linux', 'speech-server.py'), 'utf8');
  assert.match(src, /--whisper-language=/, 'the language must reach the recognizer');
  assert.match(src, /elif kind == 'transcribe'/, "the Wyoming event carrying it must be read");
  assert.ok(!/--whisper-tail-paddings/.test(src),
    'tail padding stays at the default: 300 made it repeat the opening words of every utterance');
});

test('every recognition model is permissively licensed and fully pinned', () => {
  for (const m of catalog.sttModels()) {
    assert.ok(['MIT', 'Apache-2.0', 'CC0', 'Public domain'].includes(m.license), m.id + ' licence: ' + m.license);
    assert.match(m.sha256, /^[0-9a-f]{64}$/, m.id + ' needs a full sha256');
    assert.ok(m.bytes > 1000000, m.id + ' byte count looks wrong');
    assert.ok(Array.isArray(m.languages) && m.languages.length, m.id + ' must say what it understands');
  }
  assert.match(catalog.STT_ENGINE.sha256, /^[0-9a-f]{64}$/);
});

test('a first listening install fetches its own engine and the VAD, not the speaking engine', () => {
  const m = catalog.defaultSttModel();
  // The VAD is always counted: it is tiny, and without it a meeting recording cannot be split into
  // timestamped utterances at all.
  const extras = catalog.VAD_MODEL.bytes + catalog.DIARIZATION.segmentation.bytes + catalog.DIARIZATION.embedding.bytes;
  assert.equal(catalog.sttDownloadBytes(m, false), catalog.STT_ENGINE.bytes + m.bytes + extras);
  assert.equal(catalog.sttDownloadBytes(m, true), m.bytes + extras);
  assert.notEqual(catalog.STT_ENGINE.url, catalog.ENGINE.url, 'two engines, two downloads');
  assert.match(catalog.VAD_MODEL.sha256, /^[0-9a-f]{64}$/);
});

function sttInstallerFor(base, { corrupt = false } = {}) {
  const model = catalog.sttModelById('moonshine-tiny-en');
  const engine = Buffer.from('fake sherpa tarball');
  const bundle = Buffer.from('fake model tarball');
  const vad = Buffer.from('fake silero vad');
  const files = {};
  files[catalog.STT_ENGINE.url] = engine;
  files[model.url] = bundle;
  files[catalog.VAD_MODEL.url] = vad;
  const seg = Buffer.from('fake segmentation tarball');
  const emb = Buffer.from('fake speaker embedder');
  files[catalog.DIARIZATION.segmentation.url] = seg;
  files[catalog.DIARIZATION.embedding.url] = emb;
  const realSha = model.sha256, realBytes = model.bytes, engineSha = catalog.STT_ENGINE.sha256;
  const vadSha = catalog.VAD_MODEL.sha256, vadBytes = catalog.VAD_MODEL.bytes;
  const dz = catalog.DIARIZATION;
  const dzWas = { segSha: dz.segmentation.sha256, segBytes: dz.segmentation.bytes,
                  embSha: dz.embedding.sha256, embBytes: dz.embedding.bytes };
  const sha = b => crypto.createHash('sha256').update(b).digest('hex');
  model.sha256 = corrupt ? sha(Buffer.from('other')) : sha(bundle);
  model.bytes = bundle.length;
  catalog.STT_ENGINE.sha256 = sha(engine);
  catalog.VAD_MODEL.sha256 = sha(vad);
  catalog.VAD_MODEL.bytes = vad.length;
  dz.segmentation.sha256 = sha(seg); dz.segmentation.bytes = seg.length;
  dz.embedding.sha256 = sha(emb); dz.embedding.bytes = emb.length;
  const restore = () => {
    model.sha256 = realSha; model.bytes = realBytes; catalog.STT_ENGINE.sha256 = engineSha;
    catalog.VAD_MODEL.sha256 = vadSha; catalog.VAD_MODEL.bytes = vadBytes;
    dz.segmentation.sha256 = dzWas.segSha; dz.segmentation.bytes = dzWas.segBytes;
    dz.embedding.sha256 = dzWas.embSha; dz.embedding.bytes = dzWas.embBytes;
  };
  const inst = createSpeechInstaller({
    baseDir: base, log: () => {}, get: fakeGet(files),
    execFile: (bin, args, cb) => {
      const dest = args[args.indexOf('-C') + 1];
      fs.mkdirSync(dest, { recursive: true });
      // Stand in for tar: produce whichever artifact that destination is supposed to hold.
      if (dest.endsWith('sherpa')) {
        fs.mkdirSync(path.join(dest, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(dest, 'bin', 'sherpa-onnx-offline'), 'binary');
      } else if (dest.endsWith('segmentation')) {
        fs.writeFileSync(path.join(dest, 'model.onnx'), 'segmentation');
      } else {
        fs.writeFileSync(path.join(dest, 'tokens.txt'), 'tokens');
      }
      cb(null, '', '');
    },
  });
  return { inst, restore };
}

test('listening installs its engine and model, and reports progress that adds up', async () => {
  const base = tempBase();
  const { inst, restore } = sttInstallerFor(base);
  try {
    const seen = [];
    const result = await inst.installStt('moonshine-tiny-en', p => seen.push(p));
    assert.equal(result.model, 'moonshine-tiny-en');
    assert.equal(inst.sttEngineInstalled(), true);
    assert.deepEqual(inst.installedSttModels(), ['moonshine-tiny-en']);
    assert.ok(fs.existsSync(path.join(base, 'speech', 'sherpa', 'silero_vad.onnx')), 'the VAD came too');
    assert.ok(fs.existsSync(path.join(base, 'speech', 'sherpa', 'segmentation', 'model.onnx')), 'and the segmenter');
    assert.ok(fs.existsSync(path.join(base, 'speech', 'sherpa', 'speaker-embedding.onnx')), 'and the speaker embedder');
    const done = seen[seen.length - 1];
    assert.equal(done.phase, 'done');
    assert.equal(done.received, done.total);
  } finally { restore(); fs.rmSync(base, { recursive: true, force: true }); }
});

test('a recognition model that fails its checksum installs nothing', async () => {
  const base = tempBase();
  const { inst, restore } = sttInstallerFor(base, { corrupt: true });
  try {
    await assert.rejects(() => inst.installStt('moonshine-tiny-en'), /checksum mismatch/);
    assert.deepEqual(inst.installedSttModels(), []);
  } finally { restore(); fs.rmSync(base, { recursive: true, force: true }); }
});

test('the two halves are independent: removing one leaves the other alone', async () => {
  const base = tempBase();
  const speak = installerFor(base);
  const hear = sttInstallerFor(base);
  try {
    await speak.inst.install('en_US-joe-medium');
    await hear.inst.installStt('moonshine-tiny-en');
    assert.equal(hear.inst.removeSttModel('moonshine-tiny-en'), true);
    assert.deepEqual(hear.inst.installedSttModels(), []);
    assert.deepEqual(speak.inst.installedVoices(), ['en_US-joe-medium'], 'the voice is untouched');
    assert.equal(speak.inst.engineInstalled(), true);
  } finally { speak.restore(); hear.restore(); fs.rmSync(base, { recursive: true, force: true }); }
});

test('the diarization models are permissively licensed and fully pinned', () => {
  // Piper voices taught this lesson: a model that sounds good is not a model that may ship.
  assert.match(catalog.DIARIZATION.license, /MIT|Apache/);
  for (const part of [catalog.DIARIZATION.segmentation, catalog.DIARIZATION.embedding]) {
    assert.match(part.sha256, /^[0-9a-f]{64}$/);
    assert.ok(part.bytes > 100000);
  }
  // Measured, not the tool's default: 0.60 merged two speakers into one.
  assert.ok(catalog.DIARIZATION.clusterThreshold > 0 && catalog.DIARIZATION.clusterThreshold < 0.5);
});
