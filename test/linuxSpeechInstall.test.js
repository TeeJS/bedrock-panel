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

test('every shipped voice is public domain, because Piper voices inherit their dataset licence', () => {
  const allowed = ['Public domain', 'CC0'];
  for (const v of catalog.voices()) {
    assert.ok(allowed.includes(v.license), v.id + ' has licence "' + v.license + '", which cannot ship');
  }
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
  assert.equal(catalog.sttDownloadBytes(m, false), catalog.STT_ENGINE.bytes + m.bytes + catalog.VAD_MODEL.bytes);
  assert.equal(catalog.sttDownloadBytes(m, true), m.bytes + catalog.VAD_MODEL.bytes);
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
  const realSha = model.sha256, realBytes = model.bytes, engineSha = catalog.STT_ENGINE.sha256;
  const vadSha = catalog.VAD_MODEL.sha256, vadBytes = catalog.VAD_MODEL.bytes;
  const sha = b => crypto.createHash('sha256').update(b).digest('hex');
  model.sha256 = corrupt ? sha(Buffer.from('other')) : sha(bundle);
  model.bytes = bundle.length;
  catalog.STT_ENGINE.sha256 = sha(engine);
  catalog.VAD_MODEL.sha256 = sha(vad);
  catalog.VAD_MODEL.bytes = vad.length;
  const restore = () => {
    model.sha256 = realSha; model.bytes = realBytes; catalog.STT_ENGINE.sha256 = engineSha;
    catalog.VAD_MODEL.sha256 = vadSha; catalog.VAD_MODEL.bytes = vadBytes;
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
