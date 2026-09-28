# Yibra Desktop

Electron shell for [Yibra](https://yibra.tuulu.co.za), the squad voice app. It loads the live web app and adds the OS-level extras a browser tab can't do.

## Prototype v0.1: what it does

- Loads `https://yibra.tuulu.co.za/dashboard` (or the dev site with `--yibra-dev`)
- **System tray**: the close button hides the window to the tray, left-click the tray icon to toggle it, and right-click for Open / Reload / DevTools / Quit
- **Global hotkey** `Ctrl+Shift+Y` shows or hides Yibra from anywhere, even mid-game
- **Single instance**: launching it a second time focuses the running window
- **Remembers window size, position and maximised state** between launches
- **Persistent login**: cookies live in the `persist:yibra` partition
- **Mic permission granted automatically**, but only for the Yibra origin
- **No background throttling**, so voice and the keepalive heartbeat keep running when the window is hidden
- **Autoplay allowed**, so notification sounds play without a click first
- **External links open in your default browser**. Yibra and Cloudflare Access pages stay in the app
- **Offline page** in Yibra colours that retries every 10s
- Adds `window.yibraDesktop` (`isDesktop`, `platform`, `getVersion()`) so the Vue app can detect it's running in the desktop client
- Appends `YibraDesktop/<version>` to the User-Agent

## Run it

```powershell
pnpm install
pnpm add -D electron
pnpm start          # live site
pnpm start:dev      # yibra-dev.tuulu.co.za (Cloudflare Access login appears in-window)
```

Override the URL with `$env:YIBRA_URL="https://..."; pnpm start`.

Shortcuts: `F5` / `Ctrl+R` reload, `F12` / `Ctrl+Shift+I` DevTools.

## Gotchas

- **"Electron failed to install correctly"**: pnpm 10+ blocks install scripts by default, and Electron's postinstall is what downloads the binary. `onlyBuiltDependencies` in `package.json` and `pnpm-workspace.yaml` should allow it. If pnpm still reports "Ignored build scripts: electron", run `pnpm approve-builds`, select electron, then `pnpm rebuild electron`.
- `icon.png` / `tray.png` are placeholder orange "Y" badges. Swap in the real logo (e.g. copy `..\yibra\public\web-app-manifest-512x512.png` to `assets\icon.png`).

## Roadmap

1. Packaging: electron-builder, NSIS `.exe` installer, and a real `.ico`
2. Auto-update from GitHub Releases
3. Push-to-talk: `globalShortcut` only fires on key press, not release, so PTT needs `uiohook-napi` for keydown/keyup plus a hook in the Vue voice code via `window.yibraDesktop`
4. Game detection: poll running processes and map them to a game list, then broadcast "Playing X"
5. Native notifications and an unread badge on the taskbar/tray
6. Screen share via `setDisplayMediaRequestHandler`
