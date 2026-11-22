// Copies the shared editor page into the desktop app and gives it a full HTML document shell.
const fs = require('fs');
const path = require('path');
const src = process.argv[2] || path.join(__dirname, '..', '..', 'canvas-studio', 'index.html');
const body = fs.readFileSync(src, 'utf8');
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' data: blob:">
<style>html,body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style></head><body>
${body}
</body></html>`;
fs.mkdirSync(path.join(__dirname, '..', 'app'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '..', 'app', 'index.html'), html);
console.log('app/index.html written from', src);
