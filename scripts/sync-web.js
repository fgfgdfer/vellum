// Copies the shared editor page into the desktop app and gives it a full HTML document shell.
const fs = require('fs');
const path = require('path');
const src = process.argv[2] || path.join(__dirname, '..', '..', 'canvas-studio', 'index.html');
const body = fs.readFileSync(src, 'utf8');
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' data: blob:">
<style>html,body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style></head><body>
<script src="icons.js"></script>
${body}
</body></html>`;
fs.mkdirSync(path.join(__dirname, '..', 'app'), { recursive: true });
// libraries the editor loads next to itself: geometry (booleans) and the icon library
const dir = path.dirname(src);
for (const f of ['paper-core.min.js', 'LICENSE-lucide.txt', 'fflate.min.js', 'fzstd.min.js', 'fig.js', 'LICENSE-fflate.txt', 'LICENSE-fzstd.txt']) { if (fs.existsSync(path.join(dir, f))) fs.copyFileSync(path.join(dir, f), path.join(__dirname, '..', 'app', f)); }
if (fs.existsSync(path.join(dir, 'icons.json'))) fs.writeFileSync(path.join(__dirname, '..', 'app', 'icons.js'), 'window.__ICONS=' + fs.readFileSync(path.join(dir, 'icons.json'), 'utf8') + ';');
fs.writeFileSync(path.join(__dirname, '..', 'app', 'index.html'), html);
console.log('app/index.html written from', src);
