// Yibra Desktop - prototype v0.1
// A thin Electron shell around the live Yibra web app, plus the OS-level
// bits a browser tab can't do: system tray, close-to-tray, global hotkey,
// no background throttling (voice keeps flowing when minimised), and
// sound autoplay without a click first.

const {
  app, BrowserWindow, Tray, Menu, nativeImage, shell, session,
  globalShortcut, ipcMain,
} = require('electron');
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

  if (state.maximized) mainWindow.maximize();
  mainWindow.once('ready-to-show', () => mainWindow.show());

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

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Yibra', click: showWindow },
    { label: 'Reload', click: () => mainWindow?.webContents.reload() },
    { type: 'separator' },
    { label: `Toggle window: ${TOGGLE_HOTKEY.replace('CommandOrControl', 'Ctrl')}`, enabled: false },
    { label: 'Developer tools', click: () => mainWindow?.webContents.toggleDevTools() },
    { type: 'separator' },
    { label: 'Quit Yibra', click: () => { app.isQuitting = true; app.quit(); } },
  ]));

  tray.on('click', toggleWindow);
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
