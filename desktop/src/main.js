const { app, BrowserWindow, Menu, dialog, ipcMain, shell, net } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('node:fs');
const path = require('node:path');

const APP_ID = 'com.helium5.assignmentboard';
const DATA_VERSION = 1;
let mainWindow = null;
let updaterConfigured = false;
let updateCheckInFlight = false;
let updateCheckRequestedByUser = false;

app.setName('Helium-5');
app.setAppUserModelId(APP_ID);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

function dataPath() {
  return path.join(app.getPath('userData'), 'helium-5-data.json');
}

function statePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, file);
}

function validSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > 200 || JSON.stringify(value).length > 20_000_000) return false;
  return entries.every(([key, item]) => key.startsWith('assignment-') && typeof item === 'string' && item.length < 12_000_000);
}

function cleanSnapshot(value) {
  return Object.fromEntries(Object.entries(value || {}));
}

async function fetchCalendar(_event, rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || '').trim());
  } catch {
    throw new Error('Enter a valid calendar subscription link.');
  }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Calendar links must start with https:// or http://.');
  const response = await net.fetch(url.toString(), { redirect: 'follow' });
  if (!response.ok) throw new Error(`Calendar refresh failed (${response.status}).`);
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > 10_000_000) throw new Error('That calendar is larger than 10 MB.');
  const text = await response.text();
  if (text.length > 10_000_000) throw new Error('That calendar is larger than 10 MB.');
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('That link did not return an .ics calendar.');
  return { text, finalUrl: response.url || url.toString() };
}

function readSnapshot() {
  const record = readJson(dataPath(), {});
  if (record && record.version === DATA_VERSION && validSnapshot(record.data)) return cleanSnapshot(record.data);
  return validSnapshot(record) ? cleanSnapshot(record) : {};
}

function saveSnapshot(data) {
  if (!validSnapshot(data)) throw new Error('The board data is not valid.');
  const cleaned = cleanSnapshot(data);
  atomicWrite(dataPath(), { app: 'Helium-5', version: DATA_VERSION, savedAt: new Date().toISOString(), data: cleaned });
}

function windowBounds() {
  const saved = readJson(statePath(), {});
  return {
    width: Number.isFinite(saved.width) ? Math.max(900, saved.width) : 1380,
    height: Number.isFinite(saved.height) ? Math.max(650, saved.height) : 900,
    x: Number.isFinite(saved.x) ? saved.x : undefined,
    y: Number.isFinite(saved.y) ? saved.y : undefined
  };
}

async function exportData() {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Back up Helium-5',
    defaultPath: path.join(app.getPath('documents'), `Helium-5 backup ${new Date().toISOString().slice(0, 10)}.json`),
    filters: [{ name: 'Helium-5 backup', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const payload = { app: 'Helium-5', version: DATA_VERSION, exportedAt: new Date().toISOString(), data: readSnapshot() };
  atomicWrite(result.filePath, payload);
  return { canceled: false, filePath: result.filePath };
}

async function importData() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Restore or transfer Helium-5 data',
    properties: ['openFile'],
    filters: [{ name: 'Helium-5 backup', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const input = readJson(result.filePaths[0], null);
  const data = input && input.data ? input.data : input;
  if (!validSnapshot(data)) throw new Error('That file is not a valid Helium-5 backup.');
  const cleaned = cleanSnapshot(data);
  saveSnapshot(cleaned);
  return { canceled: false, data: cleaned };
}

function createMenu() {
  return Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'Back Up Data…', accelerator: 'CmdOrCtrl+Shift+S', click: () => mainWindow?.webContents.send('menu:export') },
      { label: 'Restore or Transfer Data…', accelerator: 'CmdOrCtrl+Shift+O', click: () => mainWindow?.webContents.send('menu:import') },
      { type: 'separator' },
      { role: 'quit' }
    ]},
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
    ]},
    { label: 'View', submenu: [
      { role: 'reload' }, { role: 'togglefullscreen' }
    ]},
    { label: 'Help', submenu: [
      { label: 'Check for Updates…', click: () => checkForUpdates(true) },
      { type: 'separator' },
      { label: 'Open Data Folder', click: () => shell.openPath(app.getPath('userData')) }
    ]}
  ]);
}

function showUpdateMessage(options) {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve({ response: -1 });
  return dialog.showMessageBox(mainWindow, options);
}

function configureUpdater() {
  if (updaterConfigured || !app.isPackaged) return;
  updaterConfigured = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.autoRunAppAfterInstall = true;

  autoUpdater.on('update-available', async info => {
    updateCheckInFlight = false;
    const version = info?.version ? ` ${info.version}` : '';
    const result = await showUpdateMessage({
      type: 'info',
      title: 'Helium-5 update available',
      message: `Helium-5${version} is ready to download.`,
      detail: 'Your assignments and settings will stay on this computer.',
      buttons: ['Download update', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (result.response !== 0) return;
    updateCheckRequestedByUser = true;
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      console.error('Update download failed:', error);
    }
  });

  autoUpdater.on('update-not-available', () => {
    updateCheckInFlight = false;
    if (!updateCheckRequestedByUser) return;
    updateCheckRequestedByUser = false;
    showUpdateMessage({
      type: 'info',
      title: 'Helium-5 is up to date',
      message: `You already have the newest version (${app.getVersion()}).`,
      buttons: ['OK'],
      defaultId: 0,
      noLink: true
    });
  });

  autoUpdater.on('download-progress', progress => {
    const value = Number(progress?.percent) / 100;
    if (mainWindow && Number.isFinite(value)) mainWindow.setProgressBar(Math.min(1, Math.max(0, value)));
  });

  autoUpdater.on('update-downloaded', async info => {
    if (mainWindow) mainWindow.setProgressBar(-1);
    updateCheckRequestedByUser = false;
    const version = info?.version ? ` ${info.version}` : '';
    const result = await showUpdateMessage({
      type: 'info',
      title: 'Update ready to install',
      message: `Helium-5${version} has been downloaded.`,
      detail: 'Restart Helium-5 to finish installing the update. Your assignments and settings will remain in place.',
      buttons: ['Restart and install', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (result.response === 0) autoUpdater.quitAndInstall(false, true);
  });

  autoUpdater.on('error', error => {
    console.error('Update check failed:', error);
    updateCheckInFlight = false;
    if (mainWindow) mainWindow.setProgressBar(-1);
    if (!updateCheckRequestedByUser) return;
    updateCheckRequestedByUser = false;
    showUpdateMessage({
      type: 'error',
      title: 'Could not check for updates',
      message: 'Helium-5 could not reach the update server.',
      detail: 'Check your internet connection and try again from Help → Check for Updates.',
      buttons: ['OK'],
      defaultId: 0,
      noLink: true
    });
  });
}

async function checkForUpdates(requestedByUser = false) {
  if (!app.isPackaged) {
    if (requestedByUser) {
      await showUpdateMessage({
        type: 'info',
        title: 'Updates are available in the installed app',
        message: 'Automatic updates run after Helium-5 is installed.',
        buttons: ['OK'],
        defaultId: 0,
        noLink: true
      });
    }
    return;
  }
  configureUpdater();
  if (updateCheckInFlight) return;
  updateCheckRequestedByUser = requestedByUser;
  updateCheckInFlight = true;
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    console.error('Update check request failed:', error);
  }
}

function createWindow() {
  const bounds = windowBounds();
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 650,
    show: false,
    backgroundColor: '#ffffff',
    title: 'Helium-5',
    icon: path.join(__dirname, '..', 'build', 'helium-5.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', () => atomicWrite(statePath(), mainWindow.getBounds()));
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

ipcMain.on('store:get', event => { event.returnValue = readSnapshot(); });
ipcMain.on('store:save', (_event, data) => {
  try { saveSnapshot(data); } catch (error) { console.error(error); }
});
ipcMain.handle('data:export', exportData);
ipcMain.handle('data:import', importData);
ipcMain.handle('calendar:fetch', fetchCalendar);

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(createMenu());
  createWindow();
  configureUpdater();
  setTimeout(() => checkForUpdates(false), 5000);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
