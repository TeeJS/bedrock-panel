'use strict';

// Render the canvas face without starting the full launcher or touching hardware.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const output = process.argv[2] || path.join(process.cwd(), 'face-preview.png');
const background = /^#[0-9a-f]{6}$/i.test(process.argv[3] || '') ? process.argv[3] : '#05070a';
const collar = process.argv[4] === 'collar';
const style = process.argv[4] === 'rocky' ? 'rocky' : 'cartoon';
const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'app', 'face', 'renderer.js'), 'utf8');
app.setPath('userData', path.join(os.tmpdir(), 'codex-norm-face-preview'));
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 420,
    height: collar ? 260 : 450,
    useContentSize: true,
    show: false,
    backgroundColor: '#05070a',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  await window.loadFile(path.join(__dirname, 'face-preview.html'));
  await window.webContents.executeJavaScript(rendererSource);
  await window.webContents.executeJavaScript(`
    document.body.style.background = ${JSON.stringify(background)};
    if (${collar}) {
      // Move only this preview's canvas to show the collar and tie at portrait scale.
      document.documentElement.style.overflow = 'hidden';
      const canvas = document.querySelector('#face');
      canvas.style.height = '800px';
      canvas.style.transform = 'translateY(-550px)';
    }
    const renderer = window.OqxFace.create(document.querySelector('#face'), {
      persona: { id: ${JSON.stringify(style)}, face: { style: ${JSON.stringify(style)}, dozeAfterSeconds: 0 } },
      background: ${JSON.stringify(background)},
    });
    renderer.setReducedMotion(true);
    renderer.start();
  `);
  await new Promise(resolve => setTimeout(resolve, 200));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, (await window.webContents.capturePage()).toPNG());
  process.stdout.write(`Saved ${output}\n`);
  await window.close();
  app.quit();
}).catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
