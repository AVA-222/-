'use strict';

const path = require('node:path');
const {
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  screen,
  app,
} = require('electron');
const { appIconPng, trayIconPng } = require('./icon');

const ROOT = path.join(__dirname, '..', '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');

/** 迷你窗尺寸 */
const MINI_SIZE = { width: 300, height: 108 };

class Windows {
  /**
   * @param {{store: any, timer: any, onQuit: () => void}} ctx
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.mainWindow = null;
    this.miniWindow = null;
    this.tray = null;
    this.isQuitting = false;
    this.miniVisible = false;
    this.lastMiniPos = null;
  }

  get all() {
    return [this.mainWindow, this.miniWindow].filter((w) => w && !w.isDestroyed());
  }

  broadcast(channel, payload) {
    for (const w of this.all) {
      try {
        w.webContents.send(channel, payload);
      } catch {
        /* 窗口正在销毁 */
      }
    }
  }

  createMainWindow() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) return this.mainWindow;
    const icon = nativeImage.createFromBuffer(appIconPng());
    this.mainWindow = new BrowserWindow({
      width: 1060,
      height: 740,
      minWidth: 900,
      minHeight: 640,
      title: '专注器',
      icon,
      backgroundColor: '#0f1420',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(RENDERER, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    this.mainWindow.loadFile(path.join(RENDERER, 'index.html'));
    this.mainWindow.once('ready-to-show', () => {
      this.mainWindow.show();
      this.broadcast('state:request', null);
    });

    // 关闭主窗口 -> 收进托盘继续计时（可在设置里关掉）
    this.mainWindow.on('close', (event) => {
      if (this.isQuitting) return;
      const { minimizeToTray } = this.ctx.store.getSettings();
      if (minimizeToTray) {
        event.preventDefault();
        this.mainWindow.hide();
      }
    });
    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });
    return this.mainWindow;
  }

  showMain() {
    const w = this.createMainWindow();
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  }

  createMiniWindow() {
    if (this.miniWindow && !this.miniWindow.isDestroyed()) return this.miniWindow;
    const display = screen.getPrimaryDisplay().workArea;
    const pos = this.lastMiniPos || {
      x: display.x + display.width - MINI_SIZE.width - 24,
      y: display.y + 24,
    };
    this.miniWindow = new BrowserWindow({
      ...MINI_SIZE,
      x: pos.x,
      y: pos.y,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: this.ctx.store.getSettings().alwaysOnTopMini !== false,
      show: false,
      hasShadow: false,
      webPreferences: {
        preload: path.join(RENDERER, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    this.miniWindow.loadFile(path.join(RENDERER, 'mini.html'));
    this.miniWindow.setAlwaysOnTop(this.ctx.store.getSettings().alwaysOnTopMini !== false, 'floating');
    this.miniWindow.on('moved', () => {
      if (!this.miniWindow || this.miniWindow.isDestroyed()) return;
      const [x, y] = this.miniWindow.getPosition();
      this.lastMiniPos = { x, y };
    });
    this.miniWindow.on('closed', () => {
      this.miniWindow = null;
      this.miniVisible = false;
    });
    return this.miniWindow;
  }

  toggleMini(force) {
    const target = typeof force === 'boolean' ? force : !this.miniVisible;
    if (target) {
      const w = this.createMiniWindow();
      w.showInactive();
      this.miniVisible = true;
    } else if (this.miniWindow && !this.miniWindow.isDestroyed()) {
      this.miniWindow.hide();
      this.miniVisible = false;
    }
    this.refreshTray();
    return this.miniVisible;
  }

  setMiniAlwaysOnTop(flag) {
    if (this.miniWindow && !this.miniWindow.isDestroyed()) {
      this.miniWindow.setAlwaysOnTop(!!flag, 'floating');
    }
  }

  // ------------------------------------------------------------------- tray

  trayStatusLine() {
    const { timer } = this.ctx;
    const s = timer.snapshot();
    if (s.phase === 'idle') return '当前：空闲';
    const mm = String(Math.floor(s.remainingMs / 60_000)).padStart(2, '0');
    const ss = String(Math.floor((s.remainingMs % 60_000) / 1000)).padStart(2, '0');
    const label = s.mode === 'focus' ? (s.tag ? s.tag.name : '专注') : s.mode === 'longBreak' ? '长休息' : '短休息';
    const state = s.phase === 'paused' ? '（已暂停）' : '';
    return `${label} · ${mm}:${ss}${state}`;
  }

  refreshTray() {
    if (!this.tray) return;
    const { timer, store } = this.ctx;
    const s = timer.snapshot();
    const item = (label, click, extra = {}) => ({ label, click, ...extra });

    const running = s.phase === 'running';
    const paused = s.phase === 'paused';
    const idle = s.phase === 'idle';

    const template = [
      { label: `专注器 — ${this.trayStatusLine()}`, enabled: false },
      { type: 'separator' },
      item(idle ? '开始专注…' : running ? '暂停' : '继续', () => {
        if (idle) {
          this.showMain();
          this.broadcast('ui:openPicker', null);
        } else if (running) {
          timer.pause();
        } else {
          timer.resume();
        }
        this.refreshTray();
      }),
      item('结束本次（提前结束）', () => {
        if (!idle) this.ctx.finishSession('ended_early');
        this.refreshTray();
      }, { enabled: !idle }),
      item('放弃本次（不计时长）', () => {
        if (!idle) this.ctx.abandonSession();
        this.refreshTray();
      }, { enabled: !idle }),
      { type: 'separator' },
      item('显示主窗口', () => this.showMain()),
      item(this.miniVisible ? '隐藏迷你悬浮窗' : '显示迷你悬浮窗', () => this.toggleMini()),
      { type: 'separator' },
      item('今日统计', () => {
        this.showMain();
        this.broadcast('ui:navigate', 'stats');
      }),
      item('导出 CSV…', () => this.ctx.exportCsv({})),
      { type: 'separator' },
      item('退出', () => {
        this.isQuitting = true;
        app.quit();
      }),
    ];

    const menu = Menu.buildFromTemplate(template);
    this.tray.setContextMenu(menu);
    this.tray.setToolTip(`专注器 — ${this.trayStatusLine()}`);
    const icon = nativeImage.createFromBuffer(trayIconPng());
    this.tray.setImage(icon);
  }

  createTray() {
    const icon = nativeImage.createFromBuffer(trayIconPng());
    this.tray = new Tray(icon);
    this.tray.on('click', () => this.showMain());
    this.tray.on('double-click', () => this.showMain());
    this.refreshTray();
    return this.tray;
  }

  markQuitting() {
    this.isQuitting = true;
  }
}

module.exports = { Windows, MINI_SIZE };
