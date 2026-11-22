# Vellum (desktop)

Interface design editor for Windows (Mac later). Everything runs on your computer and costs nothing.

## Install on Windows
1. Unzip `Vellum-windows-x64.zip` anywhere (for example `Documents\Vellum`).
2. Double-click `Vellum.exe`.
3. Windows may show "Windows protected your PC" because the app is not code-signed yet. Click **More info → Run anyway**. This happens once.

## Where your work is saved
- Database: `%APPDATA%\Vellum\vellum.db` (SQLite). Every change is saved within a second; a crash never leaves a half-written file.
- Daily backups: `%APPDATA%\Vellum\backups\` (last 14 days).
- You can also export any file or all files as `.json` from the app.

## Connect Claude (free with your Claude account)
In Vellum: main menu (top-left logo) → **Connect Claude…**
- **Claude Desktop:** click *Connect Claude Desktop*, then restart Claude Desktop. Ask: "In Vellum, design a 4-screen onboarding flow".
- **Claude Code:** copy the command shown and run it once in a terminal.
Keep Vellum open while Claude works. Claude can list, open and create files, read the canvas and selection, create/update/delete layers, add pages, make components, and take snapshots to check its work.

## Developers
- `npm install`, then `npm start` (copies the shared editor page from `../canvas-studio/index.html` into `app/`).
- `npm run pack:win` builds `dist/Vellum-win32-x64`.
- Files: `main.js` (window, SQLite, local command port), `preload.js` (bridge), `mcp-server.mjs` (Claude connector), `app/index.html` (editor).
