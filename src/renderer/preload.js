'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** 渲染层可用的全部能力（只暴露这一层，不暴露 Node） */
const api = {
  // 状态
  getState: () => ipcRenderer.invoke('app:getState'),

  // 专注流程
  startFocus: (tagName, plannedMinutes) => ipcRenderer.invoke('timer:start', { tagName, plannedMinutes }),
  pause: () => ipcRenderer.invoke('timer:pause'),
  resume: () => ipcRenderer.invoke('timer:resume'),
  toggle: () => ipcRenderer.invoke('timer:toggle'),
  finishEarly: () => ipcRenderer.invoke('timer:finishEarly'),
  abandon: () => ipcRenderer.invoke('timer:abandon'),
  reset: () => ipcRenderer.invoke('timer:reset'),
  startBreak: (kind, minutes) => ipcRenderer.invoke('timer:startBreak', { kind, minutes }),

  // 标签
  listTags: () => ipcRenderer.invoke('tags:list'),
  addTag: (name, color) => ipcRenderer.invoke('tags:add', { name, color }),
  renameTag: (id, name) => ipcRenderer.invoke('tags:rename', { id, name }),
  deleteTag: (id) => ipcRenderer.invoke('tags:delete', { id }),

  // 统计
  overview: () => ipcRenderer.invoke('stats:overview'),
  trend: (days) => ipcRenderer.invoke('stats:trend', { days }),
  heatmap: (months) => ipcRenderer.invoke('stats:heatmap', { months }),
  tagHistory: (tag) => ipcRenderer.invoke('stats:tagHistory', { tag }),
  dayDetail: (date) => ipcRenderer.invoke('stats:dayDetail', { date }),
  sessions: (filter) => ipcRenderer.invoke('stats:sessions', filter),
  exportCsv: (filter) => ipcRenderer.invoke('stats:exportCsv', filter),

  // 设置
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),

  // 窗口
  showMini: (flag) => ipcRenderer.invoke('window:toggleMini', flag),
  hideMini: () => ipcRenderer.invoke('window:hideMini'),
  hideMain: () => ipcRenderer.invoke('window:hideMain'),
  minimizeMain: () => ipcRenderer.invoke('window:minimizeMain'),
  openPickerInMain: () => ipcRenderer.invoke('window:openPicker'),
  openDataFolder: () => ipcRenderer.invoke('app:openDataFolder'),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  appInfo: () => ipcRenderer.invoke('app:info'),

  // 推送订阅
  onState: (cb) => subscribe('state:push', cb),
  onTick: (cb) => subscribe('timer:tick', cb),
  onFinished: (cb) => subscribe('timer:finished', cb),
  onCue: (cb) => subscribe('ui:cue', cb),
  onNavigate: (cb) => subscribe('ui:navigate', cb),
  onOpenPicker: (cb) => subscribe('ui:openPicker', cb),
  onSettings: (cb) => subscribe('settings:push', cb),

  // 迷你窗拖动（-webkit-app-region 已足够，这里补充键盘微调）
  miniNudge: (dx, dy) => ipcRenderer.invoke('window:nudgeMini', { dx, dy }),

  // 仅自动化测试使用（主进程会校验 FOCUS_TEST 环境变量）
  testSetMinBillable: (ms) => ipcRenderer.invoke('testSetMinBillable', ms),
};

function subscribe(channel, cb) {
  if (typeof cb !== 'function') return () => {};
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('focusAPI', api);
