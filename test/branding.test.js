'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '../docs/bedrock-panel-branding');

test('brand exports have their documented dimensions and portable SVG artwork', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'asset-manifest.json')));
  for (const asset of manifest) {
    const data = fs.readFileSync(path.join(root, asset.file));
    assert.equal(data.subarray(1, 4).toString(), 'PNG');
    assert.equal(data.readUInt32BE(16), asset.width, asset.file);
    assert.equal(data.readUInt32BE(20), asset.height, asset.file);
  }
  for (const [file, width, height] of [
    ['discord/discord-server-icon.png', 512, 512],
    ['discord/discord-server-banner.png', 960, 540],
    ['favicon/apple-touch-icon-180.png', 180, 180],
    ['favicon/android-chrome-192.png', 192, 192],
    ['favicon/android-chrome-512.png', 512, 512],
    ['logo/primary/bedrock-panel-logo-horizontal.png', 1000, 220],
    ['logo/primary/bedrock-panel-logo-stacked.png', 1000, 680],
  ]) {
    const data = fs.readFileSync(path.join(root, file));
    assert.equal(data.readUInt32BE(16), width);
    assert.equal(data.readUInt32BE(20), height);
  }
  for (const file of fs.readdirSync(path.join(root, 'logo'), { recursive: true })) {
    if (!file.endsWith('.svg')) continue;
    const svg = fs.readFileSync(path.join(root, 'logo', file), 'utf8');
    assert.match(svg, /<path /);
    assert.doesNotMatch(svg, /<(?:text|image|script|foreignObject)\b|(?:href|font-family)=/);
  }
  const ico = fs.readFileSync(path.join(root, 'favicon/favicon.ico'));
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 3);
  assert.deepEqual([0, 1, 2].map(i => ico[6 + i * 16]), [16, 32, 48]);
});

test('approved brand text colors meet WCAG AA contrast', () => {
  const colors = JSON.parse(fs.readFileSync(path.join(root, 'tokens.json')));
  const pairs = JSON.parse(fs.readFileSync(path.join(root, 'contrast-report.json')));
  function luminance(hex) {
    const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
  }
  for (const pair of pairs) {
    const values = [luminance(colors[pair.foreground]), luminance(colors[pair.background])].sort((a, b) => a - b);
    const ratio = (values[1] + 0.05) / (values[0] + 0.05);
    assert.ok(ratio >= 4.5, `${pair.foreground} on ${pair.background}: ${ratio}`);
    assert.ok(Math.abs(ratio - pair.ratio) < 0.01);
  }
});


test('final brand kit uses Slate + Blue consistently and retains the original mark', () => {
  const colors = JSON.parse(fs.readFileSync(path.join(root, 'tokens.json')));
  assert.equal(colors.primary, '#285A87');
  assert.equal(colors.primaryDark, '#99C8F0');
  assert.equal(colors.background, '#F5F7FA');
  assert.equal(colors.darkBackground, '#202C3A');
  for (const name of ['directions', 'color-studies']) assert.equal(fs.existsSync(path.join(root, name)), false);
  for (const layout of ['horizontal', 'stacked']) {
    const light = fs.readFileSync(path.join(root, 'logo/primary', `bedrock-panel-logo-${layout}.svg`), 'utf8');
    const dark = fs.readFileSync(path.join(root, 'logo/primary', `bedrock-panel-logo-${layout}-dark.svg`), 'utf8');
    const paths = svg => [...svg.matchAll(/\sd="([^"]+)"/g)].map(m => m[1]);
    assert.deepEqual(paths(light), paths(dark));
    assert.match(light, /fill="#285A87"/);
    assert.match(dark, /fill="#99C8F0"/);
  }
  const mark = fs.readFileSync(path.join(root, 'logo/mark/bedrock-panel-mark.svg'), 'utf8');
  assert.match(mark, /d="M200 140L380 140L380 860L200 860Z"/);
  for (const size of [16, 32]) {
    for (const suffix of ['', '-dark']) {
      const png = fs.readFileSync(path.join(root, 'logo/mark', `bedrock-panel-mark-${size}${suffix}.png`));
      assert.equal(png.readUInt32BE(16), size);
      assert.equal(png.readUInt32BE(20), size);
    }
  }
});
