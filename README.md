# Yibra Desktop

Electron shell for [Yibra](https://yibra.tuulu.co.za), the squad voice app. It loads the live web app and adds the OS-level extras a browser tab can't do.

**Download:** [Yibra-Setup.exe](https://github.com/Rayza73/yibra-desktop/releases/latest/download/Yibra-Setup.exe) (latest release)

## What it does

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
- **Auto-updates** from GitHub Releases (v0.3+). It checks on launch and every 4h, downloads in the background, then a toast and tray item offer "Restart to update". See [RELEASING.md](RELEASING.md)

## Run it

```powershell
pnpm install
pnpm add -D electron
pnpm start          # live site
pnpm start:dev      # yibra-dev.tuulu.co.za (Cloudflare Access login appears in-window)
```

Override the URL with `$env:YIBRA_URL="https://..."; pnpm start`.

Shortcuts: `F5` / `Ctrl+R` reload, `F12` / `Ctrl+Shift+I` DevTools.

## Build the Windows installer (v0.2)

```powershell
pnpm add -D electron-builder   # once
pnpm pack                      # unpacked test build in dist\win-unpacked\Yibra.exe
pnpm dist                      # dist\Yibra-Setup.exe (local only, not published)
```

Real releases are built by GitHub Actions when a version tag is pushed. See [RELEASING.md](RELEASING.md).

- One-click, per-user install to `%LOCALAPPDATA%\Programs\Yibra`: no admin prompt, desktop and Start Menu shortcuts, and it launches when done (the way Discord installs)
- Uninstall from Windows Settings > Apps. Your login and window state in `%APPDATA%\Yibra` are kept
- Bump the version with `pnpm version patch` before each release. Never reuse a version number
- The tray has a **Start with Windows** toggle (installed app only). At login it starts hidden in the tray

### Installer gotchas

- **SmartScreen "Windows protected your PC"**: the exe isn't code-signed. Click *More info > Run anyway*. Proper signing needs a paid certificate, which is overkill for the squad
- **"Cannot create symbolic link: A required privilege is not held by the client"**: electron-builder unpacks its `winCodeSign` tools with symlinks. Turn on Windows **Developer Mode** (Settings > System > For developers), or run the terminal as Administrator once, then retry `pnpm dist`
- The first build downloads NSIS and signing tools from GitHub, so it's slow once and quick after that
- If packaging complains about missing modules under pnpm, add `node-linker=hoisted` to a `.npmrc`, delete `node_modules`, and run `pnpm install` again

## Gotchas

- **"Electron failed to install correctly"**: pnpm 10+ blocks install scripts by default, and Electron's postinstall is what downloads the binary. `onlyBuiltDependencies` in `package.json` and `pnpm-workspace.yaml` should allow it. If pnpm still reports "Ignored build scripts: electron", run `pnpm approve-builds`, select electron, then `pnpm rebuild electron`.
- Icons (`icon.png`, `icon.ico` with 16-256px sizes, and `tray.png`) are generated from `yibra/public/web-app-manifest-512x512.png`.

## Roadmap

1. ~~Packaging: electron-builder, NSIS `.exe` installer, and a real `.ico`~~ done in v0.2
2. ~~Auto-update from GitHub Releases~~ done in v0.3
3. Push-to-talk: `globalShortcut` only fires on key press, not release, so PTT needs `uiohook-napi` for keydown/keyup plus a hook in the Vue voice code via `window.yibraDesktop`
4. Game detection: poll running processes and map them to a game list, then broadcast "Playing X"
5. Native notifications and an unread badge on the taskbar/tray
6. Screen share via `setDisplayMediaRequestHandler`
