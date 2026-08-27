const { app, BrowserWindow, BrowserView, dialog, Tray, Menu, nativeImage, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const RESOURCES_ROOT = app.isPackaged
  ? path.resolve(process.resourcesPath || '')
  : path.resolve(__dirname, '..', 'resources');

// ===== 品牌配置（运行时读 resources/frontend/brand-config.js，改名后无需重打包 asar） =====
let BRAND = { name: 'Lavans', title: 'Lavans — AI Creative Canvas', appName: 'Lavans' };
try {
  const brandPath = path.join(RESOURCES_ROOT, 'frontend', 'brand-config.js');
  if(fs.existsSync(brandPath)) BRAND = require(brandPath);
} catch(_e) {}
app.setName(BRAND.appName);

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {

let mainWindow = null;
let externalWindows = []; // 持有外部浏览器窗口引用，防止被 GC 回收
let tray = null;
let firstCloseAttempt = true;

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

const NAVBAR_HEIGHT = 40;
const PREFERRED_PORT = 43127;
const LAST_PORT = 43147;
let appPort = PREFERRED_PORT;
const appUrl = () => `http://127.0.0.1:${appPort}`;

// ===== 窗口控制（fromWebContents 定位目标窗口，主窗口/外部窗口通用） =====
ipcMain.handle('window-control', (event, action) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  if (!target) return false;
  if (action === 'minimize') target.minimize();
  else if (action === 'toggle-maximize') target.isMaximized() ? target.unmaximize() : target.maximize();
  else if (action === 'close') target.close();
  return true;
});

ipcMain.handle('window-is-maximized', event => {
  const target = BrowserWindow.fromWebContents(event.sender);
  return Boolean(target && target.isMaximized());
});

// ===== 导航控制（fromWebContents 定位外部窗口的 BrowserView） =====
function viewOfSender(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win ? win.getBrowserView() : null;
}
ipcMain.handle('nav-back', (event) => { const v = viewOfSender(event); if (v && v.webContents.canGoBack()) v.webContents.goBack(); return true; });
ipcMain.handle('nav-forward', (event) => { const v = viewOfSender(event); if (v && v.webContents.canGoForward()) v.webContents.goForward(); return true; });
ipcMain.handle('nav-reload', (event) => { const v = viewOfSender(event); if (v) v.webContents.reload(); return true; });
ipcMain.handle('nav-load-url', (event, url) => {
  const v = viewOfSender(event);
  if (!v) return false;
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return false;
  v.webContents.loadURL(u);
  return true;
});
ipcMain.handle('nav-get-state', (event) => {
  const v = viewOfSender(event);
  if (!v) return { url: '', canGoBack: false, canGoForward: false, title: '' };
  const wc = v.webContents;
  return { url: wc.getURL(), canGoBack: wc.canGoBack(), canGoForward: wc.canGoForward(), title: wc.getTitle() };
});

// ===== 绑定外部窗口 BrowserView 的导航事件 → 推送状态给 shell 工具栏 =====
function bindBrowserViewEvents(win, view) {
  const push = () => {
    if (!win || win.isDestroyed() || !view || view.webContents.isDestroyed()) return;
    win.webContents.send('nav-state', {
      url: view.webContents.getURL(),
      canGoBack: view.webContents.canGoBack(),
      canGoForward: view.webContents.canGoForward(),
      title: view.webContents.getTitle()
    });
  };
  view.webContents.on('did-navigate', push);
  view.webContents.on('did-navigate-in-page', push);
  view.webContents.on('page-title-updated', push);
}

// ===== 创建外部浏览器窗口（带导航工具栏 + 窗口控制） =====
function createExternalBrowserWindow(url) {
  const win = new BrowserWindow({
    width: 1200, height: 800,
    minWidth: 720,
    minHeight: 480,
    title: BRAND.appName,
    show: true,
    frame: false,
    backgroundColor: '#111113',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  win.setMenuBarVisibility(false);
  Menu.setApplicationMenu(null);

  win.loadFile(path.join(__dirname, 'shell.html'));

  const view = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  win.setBrowserView(view);
  view.webContents.loadURL(url);

  const layout = () => {
    if (win.isDestroyed()) return;
    const [w, h] = win.getContentSize();
    view.setBounds({ x: 0, y: NAVBAR_HEIGHT, width: w, height: Math.max(0, h - NAVBAR_HEIGHT) });
  };
  layout();
  win.on('resize', layout);

  bindBrowserViewEvents(win, view);

  // 外部窗口内再点 target=_blank 链接，仍在同一 BrowserView 内导航（可后退）
  const handleNewWindow = ({ url: u }) => {
    if (/^https?:\/\//i.test(u)) view.webContents.loadURL(u);
    else shell.openExternal(u).catch(() => {});
    return { action: 'deny' };
  };
  view.webContents.setWindowOpenHandler(handleNewWindow);
  win.webContents.setWindowOpenHandler(handleNewWindow);

  // 最大化状态推送给 shell 工具栏（更新最大化图标）
  win.on('maximize', () => { if (!win.isDestroyed()) win.webContents.send('window-state', { maximized: true }); });
  win.on('unmaximize', () => { if (!win.isDestroyed()) win.webContents.send('window-state', { maximized: false }); });

  win.on('closed', () => {
    const idx = externalWindows.indexOf(win);
    if (idx >= 0) externalWindows.splice(idx, 1);
  });

  externalWindows.push(win);
  return win;
}

function createTray() {
  const possiblePaths = [
    path.join(__dirname, 'assets', 'logo.png'),
    path.join(RESOURCES_ROOT, 'frontend', 'logo.png'),
  ];
  let trayIcon = null;
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) { trayIcon = nativeImage.createFromPath(p).resize({ width: 16, height: 16 }); break; }
  }
  if (!trayIcon) return;

  tray = new Tray(trayIcon);
  const contextMenu = Menu.buildFromTemplate([
    { label: '显示窗口', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { label: '退出', click: () => { tray = null; app.quit(); } }
  ]);
  tray.setToolTip(BRAND.title);
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
}

app.whenReady().then(async () => {
  ['output','uploads','logs'].forEach(d => {
    const p = path.join(RESOURCES_ROOT, d);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  });

  process.env.PORT = String(PREFERRED_PORT);
  process.env.PORT_RANGE_END = String(LAST_PORT);
  process.env.MAX_CONCURRENCY = '5';
  process.env.OUTPUT_DIR = path.join(RESOURCES_ROOT, 'output');
  process.env.UPLOAD_DIR = path.join(RESOURCES_ROOT, 'uploads');
  process.env.LOG_DIR = path.join(RESOURCES_ROOT, 'logs');

  const Module = require('module');
  if (!Module.globalPaths.includes(RESOURCES_ROOT)) {
    Module.globalPaths.unshift(RESOURCES_ROOT);
  }

  if (!global.__BACKEND_STARTED__) {
    global.__BACKEND_STARTED__ = true;
    const backendPath = path.join(RESOURCES_ROOT, 'backend', 'server.js');
    try {
      const started = await require(backendPath);
      appPort = started.port;
    } catch (error) {
      console.error('[FATAL] Backend startup failed:', error);
      dialog.showErrorBox('Lavans 启动失败', error && error.message ? error.message : '没有可用的本地端口');
      app.quit();
      return;
    }
  }

  createTray();

  setTimeout(() => {
    // ===== 主窗口：直接加载应用（复色/画布/API设置），无顶部导航栏，沉浸式 =====
    mainWindow = new BrowserWindow({
      width: 1440, height: 900,
      minWidth: 1080,
      minHeight: 680,
      title: BRAND.appName,
      show: true,
      frame: false,
      backgroundColor: '#111113',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js')
      }
    });
    mainWindow.setMenuBarVisibility(false);
    Menu.setApplicationMenu(null);

    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.isAutoRepeat) return;
      if (!input.control || input.alt || input.meta) return;
      if (String(input.key || '').toLowerCase() !== 'r') return;
      event.preventDefault();
      if (input.shift) {
        mainWindow.webContents.reloadIgnoringCache();
      } else {
        mainWindow.webContents.reload();
      }
    });

    mainWindow.loadURL(appUrl());

    // 拦截 target=_blank / window.open：http(s) 弹外部浏览器窗口，其余走系统浏览器
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) {
        createExternalBrowserWindow(url);
      } else {
        shell.openExternal(url).catch(() => {});
      }
      return { action: 'deny' };
    });

    mainWindow.once('ready-to-show', () => { mainWindow.maximize(); });

    mainWindow.on('maximize', () => mainWindow.webContents.send('window-state', { maximized: true }));
    mainWindow.on('unmaximize', () => mainWindow.webContents.send('window-state', { maximized: false }));

    mainWindow.on('close', async (e) => {
      if (firstCloseAttempt) {
        e.preventDefault();
        firstCloseAttempt = false;
        const result = await dialog.showMessageBox(mainWindow, {
          type: 'question',
          buttons: ['最小化到系统托盘', '关闭'],
          defaultId: 0,
          cancelId: 0,
          title: '确认操作',
          message: '关闭窗口还是最小化到系统托盘？',
          detail: '选择"最小化到系统托盘"后，软件将继续在后台运行。'
        });
        if (result.response === 0) {
          mainWindow.hide();
          firstCloseAttempt = true;
          return;
        }
        try {
          const http = require('http');
          await new Promise(resolve => {
            const req = http.request({ hostname: 'localhost', port: appPort, path: '/api/save-all', method: 'POST', timeout: 2000 }, () => resolve());
            req.on('error', () => resolve());
            req.end();
          });
          await new Promise(r => setTimeout(r, 800));
        } catch {}
        app.quit();
      }
    });

    mainWindow.on('closed', () => { mainWindow = null; });
  }, 1500);
});

app.on('before-quit', async () => {
  try {
    await new Promise((resolve) => {
      const http = require('http');
      const req = http.request({ hostname: 'localhost', port: appPort, path: '/api/save-all', method: 'POST', timeout: 3000 }, () => resolve());
      req.on('error', () => resolve());
      req.end();
    });
    await new Promise(r => setTimeout(r, 800));
  } catch {}
});

app.on('window-all-closed', () => {
  if (tray) return;
  app.quit();
});
}
