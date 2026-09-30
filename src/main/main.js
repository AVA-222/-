'use strict';

const path = require('node:path');
const { app, ipcMain, dialog, globalShortcut, Notification, shell } = require('electron');

const { Store, dayKey } = require('./db');
const { Timer } = require('./timer');
const { Windows } = require('./windows');
const { appIconPng } = require('./icon');

const isDev = process.argv.includes('--dev');

// ---------------------------------------------------------------- 单实例
console.log('[focus-timer] module loaded, hasSingleInstanceLock(before) =', app.hasSingleInstanceLock());
const gotLock = app.requestSingleInstanceLock();
console.log('[focus-timer] requestSingleInstanceLock =', gotLock, '| appPath =', app.getAppPath(),
  '| name =', app.name);
if (!gotLock) {
  console.log('[focus-timer] 已有实例在运行，本实例退出（把窗口让给已有实例）');
  app.quit();
}

let store;
let timer;
let wins;
let tickHandle = null;

const DEFAULT_SHORTCUTS = {
  toggle: 'Control+Alt+F',
  mini: 'Control+Alt+M',
};

function currentShortcutSettings() {
  return { ...DEFAULT_SHORTCUTS, ...(store?.getSettings().shortcuts || {}) };
}

function boot() {
  const dbPath = process.env.FOCUS_DB || path.join(app.getPath('userData'), 'focus.db');
  console.log('[focus-timer] boot start, db =', dbPath);
  store = new Store(dbPath);
  timer = new Timer(store);
  wins = new Windows({ store, timer, finishSession, abandonSession, exportCsv });

  wins.createTray();
  wins.createMainWindow();
  registerIpc();
  registerShortcuts();
  startTicker();
  console.log('[focus-timer] boot done, windows =', wins.all.length);

  timer.on('tick', () => {
    wins.broadcast('state:push', { timer: timer.snapshot(), overview: store.overview(store.getSettings()) });
    wins.refreshTray();
  });

  console.log('[focus-timer] db:', dbPath);
  if (isDev) {
    wins.mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

// ---------------------------------------------------------------- 计时驱动

function startTicker() {
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = setInterval(() => {
    const s = timer.snapshot();
    wins.broadcast('timer:tick', s);
    if (s.phase === 'running') {
      const done = timer.checkExpiry();
      if (done) onNaturalFinish(done);
    }
  }, 250);
}

function onNaturalFinish(result) {
  const settings = store.getSettings();
  const label = result.wasFocus ? (result.record ? result.record.tag_name : '专注') : '休息';
  const minutes = Math.round((result.actualMs / 60_000) * 10) / 10;

  if (settings.notifyEnabled) {
    notify(
      result.wasFocus ? '专注完成 🍅' : '休息结束',
      result.wasFocus
        ? `「${label}」完成了 ${minutes} 分钟专注`
        : `该回到专注了（${minutes} 分钟休息结束）`,
    );
  }
  wins.broadcast('ui:cue', { kind: 'finish', mode: result.mode });
  wins.broadcast('timer:finished', {
    record: result.record,
    mode: result.mode,
    wasFocus: result.wasFocus,
    actualMs: result.actualMs,
  });

  if (result.wasFocus && settings.autoStartBreak !== false) {
    const todayDone = store.overview(settings).todayPomodoro.done;
    const long = settings.longBreakEvery > 0 && todayDone % settings.longBreakEvery === 0;
    const minutes = long ? settings.longBreakMinutes : settings.shortBreakMinutes;
    if (minutes > 0) timer.startBreak(long ? 'longBreak' : 'shortBreak', minutes);
  }
  wins.broadcast('state:push', { timer: timer.snapshot(), overview: store.overview(settings) });
  wins.refreshTray();
}

function finishSession(reason = 'ended_early') {
  const res = timer.stop(reason);
  if (res && res.wasFocus) {
    const settings = store.getSettings();
    if (settings.notifyEnabled && res.record) {
      notify('已结束本次专注', `「${res.record.tag_name}」记录 ${res.record.actual_minutes} 分钟`);
    }
    wins.broadcast('ui:cue', { kind: 'stop', mode: res.mode });
    wins.broadcast('timer:finished', {
      record: res.record,
      mode: res.mode,
      wasFocus: res.wasFocus,
      actualMs: res.actualMs,
    });
  }
  wins.broadcast('state:push', { timer: timer.snapshot(), overview: store.overview(store.getSettings()) });
  wins.refreshTray();
  return res;
}

function abandonSession() {
  // 放弃：仍落库（status=abandoned），实际时长按真实投入记录
  return finishSession('abandoned');
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: require('electron').nativeImage.createFromBuffer(appIconPng()) });
  n.on('click', () => wins.showMain());
  n.show();
}

function registerShortcuts() {
  globalShortcut.unregisterAll();
  const sc = currentShortcutSettings();
  const map = {
    toggle: () => {
      const s = timer.snapshot();
      if (s.phase === 'idle') {
        wins.showMain();
        wins.broadcast('ui:openPicker', null);
      } else if (s.phase === 'running') {
        timer.pause();
      } else {
        timer.resume();
      }
    },
    mini: () => wins.toggleMini(),
  };
  const results = {};
  for (const [key, accel] of Object.entries(sc)) {
    if (!accel) continue;
    try {
      results[key] = globalShortcut.register(accel, map[key]);
    } catch {
      results[key] = false;
    }
  }
  return results;
}

// ------------------------------------------------------------------- CSV

async function exportCsv(filter = {}) {
  const rows = store.exportRows(filter);
  if (!rows.length) return { ok: false, reason: 'empty' };
  const headers = Object.keys(rows[0]);
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\r\n');
  const stampName = filter.from || filter.to ? `${filter.from || 'all'}_${filter.to || 'now'}` : dayKey(Date.now());
  const { canceled, filePath } = await dialog.showSaveDialog(wins.mainWindow ?? undefined, {
    title: '导出专注记录',
    defaultPath: path.join(app.getPath('downloads'), `focus-${stampName}.csv`),
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (canceled || !filePath) return { ok: false, reason: 'canceled' };
  // 带 BOM，Excel 打开中文不乱码
  require('node:fs').writeFileSync(filePath, '\uFEFF' + csv, 'utf8');
  return { ok: true, filePath, count: rows.length };
}

// ------------------------------------------------------------------- IPC

function registerIpc() {
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (_event, payload) => {
      try {
        return { ok: true, data: await fn(payload) };
      } catch (error) {
        if (isDev) console.error(`[ipc:${channel}]`, error);
        return { ok: false, error: error?.message || String(error) };
      }
    });
  };

  handle('app:getState', () => ({
    timer: timer.snapshot(),
    overview: store.overview(store.getSettings()),
    settings: store.getSettings(),
    tags: store.listTags(),
    dbPath: store.dbPath,
    version: app.getVersion(),
  }));

  handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    dbPath: store.dbPath,
    platform: process.platform,
    shortcuts: currentShortcutSettings(),
  }));

  handle('app:quit', () => {
    wins.markQuitting();
    app.quit();
    return true;
  });

  handle('timer:start', ({ tagName, plannedMinutes }) => timer.startFocus(tagName, plannedMinutes));
  handle('timer:pause', () => timer.pause());
  handle('timer:resume', () => timer.resume());
  handle('timer:toggle', () => timer.toggle());
  handle('timer:finishEarly', () => finishSession('ended_early'));
  handle('timer:abandon', () => abandonSession());
  handle('timer:reset', () => {
    timer.reset();
    wins.broadcast('state:push', { timer: timer.snapshot(), overview: store.overview(store.getSettings()) });
    wins.refreshTray();
    return timer.snapshot();
  });
  handle('timer:startBreak', ({ kind, minutes }) => timer.startBreak(kind, minutes));

  handle('tags:list', () => store.listTags());
  handle('tags:add', ({ name, color }) => store.ensureTag(name, color));
  handle('tags:rename', ({ id, name }) => store.renameTag(id, name));
  handle('tags:delete', ({ id }) => store.deleteTag(id));

  handle('stats:overview', () => store.overview(store.getSettings()));
  handle('stats:trend', ({ days }) => store.trend(days || 7, store.getSettings()));
  handle('stats:heatmap', ({ months }) => store.heatmap(months || 6));
  handle('stats:tagHistory', ({ tag }) => store.tagHistory(tag));
  handle('stats:dayDetail', ({ date }) => store.dayDetail(date));
  handle('stats:sessions', (filter) => store.listSessions(filter || {}));
  handle('stats:exportCsv', (filter) => exportCsv(filter || {}));

  handle('settings:get', () => store.getSettings());
  handle('settings:save', (patch) => {
    const next = store.saveSettings(patch || {});
    wins.setMiniAlwaysOnTop(next.alwaysOnTopMini !== false);
    if (patch && patch.shortcuts) registerShortcuts();
    wins.broadcast('settings:push', next);
    wins.broadcast('state:push', { timer: timer.snapshot(), overview: store.overview(next) });
    wins.refreshTray();
    return next;
  });

  handle('window:toggleMini', (flag) => wins.toggleMini(flag));
  handle('window:hideMini', () => wins.toggleMini(false));
  handle('window:hideMain', () => {
    wins.mainWindow?.hide();
    return true;
  });
  handle('window:minimizeMain', () => {
    wins.mainWindow?.minimize();
    return true;
  });
  handle('window:nudgeMini', ({ dx, dy }) => {
    const w = wins.miniWindow;
    if (!w || w.isDestroyed()) return false;
    const [x, y] = w.getPosition();
    w.setPosition(Math.round(x + dx), Math.round(y + dy));
    return true;
  });
  handle('window:openPicker', () => {
    wins.showMain();
    wins.broadcast('ui:openPicker', null);
    return true;
  });
  handle('app:openDataFolder', () => {
    shell.showItemInFolder(store.dbPath);
    return store.dbPath;
  });

  // 仅测试用：调整"误操作阈值"，避免自动化测试空等 15 秒
  handle('testSetMinBillable', (ms) => {
    if (!process.env.FOCUS_TEST) return { skipped: true };
    timer.minBillableMs = Number(ms) || 0;
    return timer.minBillableMs;
  });
}

// ---------------------------------------------------------------- 生命周期

app.on('second-instance', () => wins?.showMain());

app.whenReady().then(() => {
  try {
    boot();
  } catch (error) {
    console.error('[focus-timer] boot failed:', error);
    dialog.showErrorBox('专注器启动失败', String(error && error.stack ? error.stack : error));
    app.exit(1);
    return;
  }
  app.on('activate', () => wins.showMain());
});

app.on('before-quit', () => {
  wins?.markQuitting();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (tickHandle) clearInterval(tickHandle);
});

// 关闭所有窗口不退出（托盘常驻）
app.on('window-all-closed', () => {
  // 保持常驻；只有显式退出或非托盘模式才退
  const minimizeToTray = store ? store.getSettings().minimizeToTray : true;
  if (!minimizeToTray) app.quit();
});
