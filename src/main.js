// Yibra Desktop
// A thin Electron shell around the live Yibra web app, plus the OS-level
// bits a browser tab can't do: system tray, close-to-tray, global hotkey,
// no background throttling (voice keeps flowing when minimised), and
// sound autoplay without a click first. Updates itself from GitHub Releases.

const {
  app, BrowserWindow, Tray, Menu, nativeImage, shell, session,
  globalShortcut, ipcMain, Notification,
} = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('node:path');
const fs = require('node:fs');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const LIVE_URL = 'https://yibra.tuulu.co.za/dashboard';
const DEV_URL = 'https://yibra-dev.tuulu.co.za/dashboard';

const USE_DEV = process.argv.includes('--yibra-dev');
const START_URL = process.env.YIBRA_URL || (USE_DEV ? DEV_URL : LIVE_URL);
const APP_ORIGIN = new URL(START_URL).origin;
const APP_HOST = new URL(START_URL).host;

// Hosts allowed to load inside the window. Cloudflare Access (dev site gate)
// bounces through *.cloudflareaccess.com, so that has to stay in-app too.
const IN_APP_HOSTS = [APP_HOST];
const IN_APP_HOST_SUFFIXES = ['.cloudflareaccess.com'];

// Permissions the Yibra origin gets without nagging.
const ALLOWED_PERMISSIONS = new Set([
  'media',                      // microphone (and camera later)
  'notifications',
  'clipboard-sanitized-write',
  'fullscreen',
  'speaker-selection',          // output device picker
]);

const TOGGLE_HOTKEY = 'CommandOrControl+Shift+Y';

// Launched by Windows at login -> start quietly in the tray
const START_HIDDEN = process.argv.includes('--hidden');
const PARTITION = 'persist:yibra'; // keeps the Laravel session cookie between launches

// Let notification sounds play without the user clicking first.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow = null;
let tray = null;
app.isQuitting = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function asset(name) {
  return path.join(__dirname, '..', 'assets', name);
}

function isInAppUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return true; // our offline page
    if (u.protocol !== 'https:') return false;
    return IN_APP_HOSTS.includes(u.host) ||
      IN_APP_HOST_SUFFIXES.some((s) => u.host.endsWith(s));
  } catch {
    return false;
  }
}

function openExternalSafely(url) {
  try {
    const { protocol } = new URL(url);
    if (protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:') {
      shell.openExternal(url);
    }
  } catch { /* ignore junk URLs */ }
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

// ---------------------------------------------------------------------------
// Window state (size / position / maximised) persisted in userData
// ---------------------------------------------------------------------------
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return { width: 1280, height: 800, maximized: false };
  }
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  const state = { ...win.getNormalBounds(), maximized: win.isMaximized() };
  try { fs.writeFileSync(stateFile(), JSON.stringify(state)); } catch { /* not fatal */ }
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------
function createWindow() {
  const state = loadWindowState();

  mainWindow = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 940,
    minHeight: 560,
    title: 'Yibra',
    icon: asset('icon.png'),
    backgroundColor: '#2a2728', // Clove Shadow - no white flash on boot
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      partition: PARTITION,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep voice + heartbeat alive when hidden
      spellcheck: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (START_HIDDEN) return; // stay in the tray until summoned
    if (state.maximized) mainWindow.maximize();
    mainWindow.show();
  });

  mainWindow.loadURL(START_URL);

  // Keyboard shortcuts we lose by hiding the menu bar
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    if (input.key === 'F5' || (ctrl && input.key.toLowerCase() === 'r')) {
      mainWindow.webContents.reload();
      event.preventDefault();
    } else if (input.key === 'F12' || (ctrl && input.shift && input.key.toLowerCase() === 'i')) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  // External links -> default browser. Yibra links stay in the window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isInAppUrl(url)) {
      mainWindow.loadURL(url);
    } else {
      openExternalSafely(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isInAppUrl(url)) {
      event.preventDefault();
      openExternalSafely(url);
    }
  });

  // Server unreachable -> friendly offline page with auto-retry
  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDesc, url, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // -3 = aborted (normal on redirects)
    console.warn(`[yibra] load failed (${errorCode} ${errorDesc}) for ${url}`);
    mainWindow.loadFile(path.join(__dirname, 'offline.html'), {
      query: { error: `${errorDesc} (${errorCode})` },
    });
  });

  // Close button hides to tray; real quit comes from the tray menu
  mainWindow.on('close', (event) => {
    saveWindowState(mainWindow);
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function showWindow() {
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function toggleWindow() {
  if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
  } else {
    showWindow();
  }
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function createTray() {
  let icon = nativeImage.createFromPath(asset('tray.png'));
  if (icon.isEmpty()) icon = nativeImage.createFromPath(asset('icon.png'));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip(USE_DEV ? 'Yibra (DEV)' : 'Yibra');
  buildTrayMenu();
  tray.on('click', toggleWindow);
}

// Rebuilt whenever update state changes, so the menu can offer a restart.
function buildTrayMenu() {
  if (!tray) return;

  const updateItems = [];
  if (updateState.downloaded) {
    updateItems.push({
      label: `Restart to update (v${updateState.version})`,
      click: installUpdateNow,
    });
  } else if (updateState.downloading) {
    updateItems.push({ label: `Downloading update ${updateState.progress}%...`, enabled: false });
  } else {
    updateItems.push({
      label: updateState.checking ? 'Checking for updates...' : 'Check for updates',
      enabled: app.isPackaged && !updateState.checking,
      click: () => checkForUpdates({ manual: true }),
    });
  }

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Yibra v${app.getVersion()}${USE_DEV ? ' (DEV)' : ''}`, enabled: false },
    { type: 'separator' },
    { label: 'Open Yibra', click: showWindow },
    { label: 'Reload', click: () => mainWindow?.webContents.reload() },
    { type: 'separator' },
    { label: `Toggle window: ${TOGGLE_HOTKEY.replace('CommandOrControl', 'Ctrl')}`, enabled: false },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      // Only makes sense for the installed app - in dev it would register electron.exe
      enabled: app.isPackaged,
      checked: app.isPackaged && app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin, // Windows matches on args too
      click: (item) => app.setLoginItemSettings({
        openAtLogin: item.checked,
        args: ['--hidden'],
      }),
    },
    { label: 'Developer tools', click: () => mainWindow?.webContents.toggleDevTools() },
    { type: 'separator' },
    ...updateItems,
    { type: 'separator' },
    { label: 'Quit Yibra', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

// ---------------------------------------------------------------------------
// Auto-update (GitHub Releases on Rayza73/yibra-desktop, public repo, no token)
// ---------------------------------------------------------------------------
// Flow: check on launch + every few hours -> download quietly in the background
// -> toast + tray item "Restart to update". If nobody clicks it, the update
// installs the next time Yibra actually quits (not just hides to tray).
const UPDATE_CHECK_EVERY_MS = 4 * 60 * 60 * 1000; // 4 hours
const UPDATE_FIRST_CHECK_DELAY_MS = 10 * 1000;    // let the window settle first

const updateState = {
  checking: false,
  downloading: false,
  downloaded: false,
  progress: 0,
  version: null,
  manual: false, // user clicked "Check for updates" -> tell them the result
};

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: asset('icon.png'), silent: false });
  if (onClick) n.on('click', onClick);
  n.show();
}

function checkForUpdates({ manual = false } = {}) {
  if (!app.isPackaged) return; // dev runs have no update feed (no app-update.yml)
  if (updateState.checking || updateState.downloading || updateState.downloaded) return;
  updateState.manual = manual;
  autoUpdater.checkForUpdates().catch((err) => {
    console.warn('[yibra] update check failed:', err?.message || err);
  });
}

function installUpdateNow() {
  // Our close handler hides to tray unless we're quitting - so flag it first,
  // otherwise the installer waits forever for a window that never closes.
  app.isQuitting = true;
  saveWindowState(mainWindow);
  // isSilent = true (one-click NSIS, no wizard), isForceRunAfter = true (relaunch)
  autoUpdater.quitAndInstall(true, true);
}

function setupAutoUpdater() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = console;

  autoUpdater.on('checking-for-update', () => {
    updateState.checking = true;
    buildTrayMenu();
  });

  autoUpdater.on('update-not-available', () => {
    updateState.checking = false;
    buildTrayMenu();
    if (updateState.manual) {
      notify('Yibra is up to date', `You're on the latest version (v${app.getVersion()}).`);
    }
  });

  autoUpdater.on('update-available', (info) => {
    updateState.checking = false;
    updateState.downloading = true;
    updateState.progress = 0;
    updateState.version = info.version;
    buildTrayMenu();
    if (updateState.manual) {
      notify('Yibra update found', `Downloading v${info.version} in the background...`);
    }
  });

  autoUpdater.on('download-progress', (p) => {
    const pct = Math.floor(p.percent || 0);
    // Only rebuild the menu every 10% - no need to spam it
    if (pct - updateState.progress >= 10) {
      updateState.progress = pct;
      buildTrayMenu();
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateState.downloading = false;
    updateState.downloaded = true;
    updateState.version = info.version;
    buildTrayMenu();
    tray?.setToolTip(`Yibra - update v${info.version} ready`);
    notify(
      `Yibra v${info.version} is ready`,
      'Click here (or use the tray menu) to restart and update. Otherwise it installs next time you quit.',
      installUpdateNow,
    );
  });

  autoUpdater.on('error', (err) => {
    console.warn('[yibra] updater error:', err?.message || err);
    const wasManual = updateState.manual;
    updateState.checking = false;
    updateState.downloading = false;
    buildTrayMenu();
    if (wasManual) {
      notify('Update check failed', 'Could not reach the update server. Try again later.');
    }
  });

  setTimeout(() => checkForUpdates(), UPDATE_FIRST_CHECK_DELAY_MS);
  setInterval(() => checkForUpdates(), UPDATE_CHECK_EVERY_MS);
}

// ---------------------------------------------------------------------------
// Session: permissions + user agent
// ---------------------------------------------------------------------------
function configureSession() {
  const ses = session.fromPartition(PARTITION);

  // Tag the UA so Laravel can tell desktop from browser if it ever wants to
  ses.setUserAgent(`${ses.getUserAgent()} YibraDesktop/${app.getVersion()}`);

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const origin = originOf(details.requestingUrl || webContents.getURL());
    callback(origin === APP_ORIGIN && ALLOWED_PERMISSIONS.has(permission));
  });

  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return requestingOrigin === APP_ORIGIN && ALLOWED_PERMISSIONS.has(permission);
  });
}

// ---------------------------------------------------------------------------
// IPC (exposed via preload as window.yibraDesktop)
// ---------------------------------------------------------------------------
ipcMain.handle('yibra:version', () => app.getVersion());
ipcMain.on('yibra:retry', () => mainWindow?.loadURL(START_URL));

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  // A Yibra is already running - hand over and bow out
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    app.setAppUserModelId('za.co.tuulu.yibra'); // proper name on Windows notifications
    Menu.setApplicationMenu(null);
    configureSession();
    createWindow();
    createTray();
    setupAutoUpdater();

    if (!globalShortcut.register(TOGGLE_HOTKEY, toggleWindow)) {
      console.warn(`[yibra] could not register ${TOGGLE_HOTKEY} - something else owns it`);
    }
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
    saveWindowState(mainWindow);
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());

  // We live in the tray, so don't quit when the window is gone
  app.on('window-all-closed', () => {});
}
