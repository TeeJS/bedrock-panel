'use strict';
// AI Voice markdown: the vendored parser (lifted from the Open WebUI chat widget) renders the same
// constructs on the AI Voice page, and the page keeps its copyable fenced-code contract.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appDir = path.join(__dirname, '..', 'app');
const read = name => fs.readFileSync(path.join(appDir, name), 'utf8');

function loadParser() {
  const sandbox = { window: {}, console };
  vm.runInNewContext(read('claudevoice-markdown.js'), sandbox, { filename: 'claudevoice-markdown.js' });
  return sandbox.window.aiVoiceMarkdown;
}

test('vendored parser renders the Open WebUI widget feature set with the same options', () => {
  const md = loadParser();
  assert.equal(typeof md.render, 'function');
  const html = md.parse([
    '# Title', '', 'Some **bold**, *em*, `code`, ~~del~~ and a [link](https://example.com).', '',
    '- one', '- two', '', '1. first', '', '| a | b |', '|---|:-:|', '| 1 | 2 |', '',
    '> quote', '', '---', '', '```bash', 'echo "hi" && ls -la', '```', '',
    '![alt](https://example.com/x.png)', '', 'line one', 'line two',
  ].join('\n'));
  for (const needle of ['<h1', '<strong>bold</strong>', '<em>em</em>', '<code>code</code>', '<del>del</del>',
    '<a href="https://example.com">', '<ul>', '<ol>', '<table>', '<blockquote>', '<hr', '<pre><code class="language-bash">',
    '<img src="https://example.com/x.png"', 'line one<br>line two']) {
    assert.ok(html.includes(needle), 'expected ' + needle + ' in\n' + html);
  }
  // Fenced code is escaped, never interpreted -- the copy button hands back the exact command.
  assert.ok(html.includes('echo &quot;hi&quot; &amp;&amp; ls -la'));
});

test('the sanitizer allow-list is the widget\'s original, unchanged', () => {
  const vendored = read('claudevoice-markdown.js');
  assert.match(vendored, /const OQ_MARKDOWN_ALLOWED_TAGS = new Set\(\[\s*"a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6",\s*"hr", "img", "li", "ol", "p", "pre", "s", "span", "strong", "table", "tbody", "td",\s*"th", "thead", "tr", "ul"\s*\]\)/);
  assert.match(vendored, /OQ_MARKDOWN_URL_PROTOCOLS = new Set\(\["http:", "https:", "mailto:"\]\)/);
  const allowList = vendored.match(/const OQ_MARKDOWN_ALLOWED_TAGS = new Set\(\[[\s\S]*?\]\)/)[0];
  assert.doesNotMatch(allowList, /"script"|"iframe"|"style"|"object"|"embed"|"form"|"input"/);
});

test('the AI Voice page loads the parser and keeps the copyable code-block contract', () => {
  const html = read('claudevoiceview.html');
  const js = read('claudevoiceview.js');
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  assert.ok(scripts.indexOf('claudevoice-markdown.js') < scripts.indexOf('claudevoiceview.js'), scripts.join(','));
  assert.match(js, /var md = window\.aiVoiceMarkdown;\s*if \(!md\) return renderPlain\(text\);/);
  assert.match(js, /wrap\.className = 'codeblock'/);
  assert.match(js, /btn\.className = 'copybtn'/);
  assert.match(js, /code\.textContent\.replace\(\/\\n\$\/, ''\)/);
  assert.match(js, /function renderPlain\(text\)/);
  // User bars (mostly STT output) stay raw text; only assistant replies are markdown.
  assert.match(js, /m\.role === 'user' \? renderPlain\(m\.text\) : renderContent\(m\.text\)/);
});
