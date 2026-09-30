'use strict';
/**
 * Electron 端到端验证。
 * 启动真实主进程，然后从渲染页调用 preload 暴露的 API（等于用户操作路径），
 * 验证：原生模块加载 / 建表 / 标签 / 计时入库 / 统计 / 设置 / 窗口 / 托盘 / 快捷键 / UI 交互。
 *
 * 用法：npx electron scripts/electron-e2e.js
 * 使用临时数据库（FOCUS_DB），不会污染真实数据。
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, globalShortcut, BrowserWindow, Tray } = require('electron');

{
  const before = app.hasSingleInstanceLock();
  const req = app.requestSingleInstanceLock();
  console.log('[e2e] lock probe -> before:', before, '| request:', req,
    '| after:', app.hasSingleInstanceLock(), '| ready:', app.isReady());
}

const MAIN = path.join(__dirname, '..', 'src', 'main', 'main.js');
console.log('[e2e] requiring main.js from', MAIN, '| exists =', fs.existsSync(MAIN));
try {
  require(MAIN);
  console.log('[e2e] main.js required OK');
} catch (error) {
  console.log('[e2e] main.js require THREW:', error && error.stack);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-e2e-'));
process.env.FOCUS_DB = path.join(tmpDir, 'e2e.db');
process.env.FOCUS_TEST = '1';

let failures = 0;
let passes = 0;
function check(name, cond, extra) {
  if (cond) { passes += 1; console.log(`PASS  ${name}`); }
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''}`);
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从渲染页真实调用 preload 暴露的 API */
function pageCall(win, method, ...args) {
  const expr = `window.focusAPI.${method}(${args.map((a) => JSON.stringify(a)).join(', ')})`;
  return win.webContents.executeJavaScript(expr);
}

async function data(win, method, ...args) {
  const res = await pageCall(win, method, ...args);
  if (!res || res.ok !== true) throw new Error(`${method} 失败: ${res && res.error}`);
  return res.data;
}

async function waitForMainWindow() {
  for (let i = 0; i < 40; i += 1) {
    const all = BrowserWindow.getAllWindows();
    const urls = all.map((x) => x.webContents.getURL());
    const w = all.find((x) => x.webContents.getURL().includes('index.html'));
    if (i % 8 === 0) console.log(`[wait ${i}] windows=${all.length}`, urls);
    if (w) {
      const probe = await w.webContents
        .executeJavaScript('({ api: typeof window.focusAPI, ring: !!document.getElementById("ringTime") })')
        .catch((e) => ({ error: e.message }));
      if (i % 8 === 0) console.log(`[wait ${i}] probe`, probe);
      if (probe && probe.api === 'object' && probe.ring) return w;
    }
    await wait(250);
  }
  throw new Error('主窗口未在 10 秒内就绪');
}

async function main() {
  console.log('[e2e] main() entered; app ready =', app.isReady(),
    '| windows =', BrowserWindow.getAllWindows().length);
  console.log('electron', process.versions.electron, '| node', process.versions.node,
    '| chrome', process.versions.chrome, '| abi', process.versions.modules);
  console.log('tmp db:', process.env.FOCUS_DB);

  const win = await waitForMainWindow();
  check('better-sqlite3 在 Electron 下可加载（主进程已启动）', true);

  // ---------------------------------------------------------- 初始状态
  const state = await data(win, 'getState');
  check('getState 返回计时快照', !!state.timer && state.timer.phase === 'idle', state.timer.phase);
  check('预设标签已就绪', state.tags.length >= 5, state.tags.map((t) => t.name));
  check('数据库文件已创建', fs.existsSync(state.dbPath), state.dbPath);
  check('设置已加载', state.settings && state.settings.focusMinutes === 25, state.settings);

  // ---------------------------------------------------------- 窗口 / 托盘 / 快捷键
  check('主窗口加载了渲染页', !!win, win.webContents.getURL());
  check('preload 已生效',
    await win.webContents.executeJavaScript('typeof window.focusAPI.getState === "function"'));
  check('界面渲染出环形计时器',
    await win.webContents.executeJavaScript('document.getElementById("ringTime").textContent.length > 0'));
  check('首次进入自动弹出标签选择器',
    await win.webContents.executeJavaScript('document.getElementById("pickerMask").hidden === false'));
  check('托盘常驻能力可用', typeof Tray === 'function' && !!require('electron').nativeImage);
  check('全局快捷键已注册（开始/暂停）', globalShortcut.isRegistered('Control+Alt+F'));
  check('全局快捷键已注册（迷你窗）', globalShortcut.isRegistered('Control+Alt+M'));

  // ---------------------------------------------------------- 标签
  const t1 = await data(win, 'addTag', '写代码');
  check('addTag 复用预设标签', t1.name === '写代码');
  const t2 = await data(win, 'addTag', 'E2E测试标签');
  check('addTag 可创建新标签', t2.name === 'E2E测试标签' && t2.is_preset === false, t2.color);

  // ---------------------------------------------------------- 专注流程
  // 把 minBillableMs 调小，避免为了跨过"误操作阈值"而空等（真实默认是 15 秒）
  await data(win, 'testSetMinBillable', 200);

  const started = await data(win, 'startFocus', 'E2E测试标签', 25);
  check('startFocus 进入 running', started.phase === 'running' && started.tag.name === 'E2E测试标签', started.phase);

  await wait(400);
  const paused = await data(win, 'pause');
  check('pause 生效', paused.phase === 'paused');
  const accAtPause = paused.actualMs;

  await wait(500); // 暂停期间不应计入
  const stillPaused = await data(win, 'getState');
  check('暂停期间实际时长冻结', stillPaused.timer.actualMs === accAtPause,
    { before: accAtPause, after: stillPaused.timer.actualMs });

  const resumed = await data(win, 'resume');
  check('resume 生效', resumed.phase === 'running');
  await wait(300);

  const finished = await data(win, 'finishEarly');
  check('finishEarly 落库为 ended_early', finished.record && finished.record.status === 'ended_early',
    finished.record && finished.record.status);
  check('实际时长不含暂停时段（约 0.7 秒）',
    finished.record.actual_minutes > 0.005 && finished.record.actual_minutes < 0.05,
    finished.record.actual_minutes);
  check('记录含日期与起止时间',
    /^\d{4}-\d{2}-\d{2}$/.test(finished.record.date) && !!finished.record.start_time && !!finished.record.end_time,
    { date: finished.record.date, start: finished.record.start_time, end: finished.record.end_time });
  check('结束后回到 idle', (await data(win, 'getState')).timer.phase === 'idle');

  await data(win, 'startFocus', 'E2E测试标签', 25);
  const abandoned = await data(win, 'abandon');
  check('abandon 记为 abandoned', abandoned.record.status === 'abandoned', abandoned.record.status);

  // ---------------------------------------------------------- 统计
  const ov = await data(win, 'overview');
  check('今日段数 = 2', ov.todaySessions === 2, ov.todaySessions);
  check('今日标签分组含新标签', ov.todayByTag.some((t) => t.tag_name === 'E2E测试标签'),
    ov.todayByTag.map((t) => t.tag_name));
  check('今日番茄统计：提前 1、放弃 1',
    ov.todayPomodoro.early === 1 && ov.todayPomodoro.abandoned === 1, ov.todayPomodoro);

  const trend = await data(win, 'trend', 7);
  check('趋势返回 7 天', trend.days.length === 7, trend.days.length);
  check('趋势末日为今天且有分钟数', trend.days[6].minutes > 0, trend.days[6]);

  const heat = await data(win, 'heatmap', 3);
  check('热力图含今天', !!heat.days[trend.to], heat.days[trend.to]);

  const hist = await data(win, 'tagHistory', 'E2E测试标签');
  check('单标签历史有 2 条', hist.rows.length === 2, hist.rows.length);

  const rows = await data(win, 'sessions', { tag: 'E2E测试标签' });
  check('明细查询可用', rows.length === 2, rows.length);

  // ---------------------------------------------------------- 设置
  // 设置：切换"放弃不计入"后，放弃的那一段应从统计中消失（到分钟粒度上 0.01 分钟看不出来，
  // 所以验证标签分组里不再出现该标签，这更精确）
  const saved = await data(win, 'saveSettings', { focusMinutes: 30, abandonedRule: 'excluded' });
  check('设置已保存', saved.focusMinutes === 30 && saved.abandonedRule === 'excluded');
  const ov2 = await data(win, 'overview');
  const tagAfter = ov2.todayByTag.find((t) => t.tag_name === 'E2E测试标签');
  check('"放弃不计入"后段数由 2 降为 1', ov2.todaySessions === 1, ov2.todaySessions);
  check('"放弃不计入"后该标签只剩 1 段', !!tagAfter && tagAfter.sessions === 1, tagAfter);
  await data(win, 'saveSettings', { focusMinutes: 25, abandonedRule: 'counted' });
  check('切回计入后段数恢复为 2', (await data(win, 'overview')).todaySessions === 2);

  // ---------------------------------------------------------- 迷你窗
  const miniShown = await pageCall(win, 'showMini', true);
  check('迷你窗可显示', miniShown && miniShown.data === true, miniShown);
  await wait(700);
  const miniWin = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('mini.html'));
  check('迷你窗已创建并加载页面', !!miniWin,
    BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()));
  if (miniWin) {
    check('迷你窗渲染出剩余时间',
      await miniWin.webContents.executeJavaScript('document.getElementById("time").textContent.length > 0'));
  }
  await pageCall(win, 'showMini', false);

  // ---------------------------------------------------------- 渲染层真实点击流程
  const clicked = await win.webContents.executeJavaScript(`(async () => {
    document.getElementById('pickerMask').hidden = false;
    const chips = document.querySelectorAll('#presetTags .chip');
    if (!chips.length) return { ok: false, reason: 'no-preset-chips' };
    chips[0].click();
    await new Promise(r => setTimeout(r, 80));
    const picked = document.getElementById('pickedTag').textContent;
    document.getElementById('pickerStart').click();
    await new Promise(r => setTimeout(r, 300));
    const st = await window.focusAPI.getState();
    return { ok: true, picked, phase: st.data.timer.phase, tag: st.data.timer.tag && st.data.timer.tag.name,
             shownTag: document.getElementById('ringTag').textContent };
  })()`);
  check('UI：点标签 → 开始专注 全链路可用',
    clicked.ok && clicked.phase === 'running' && clicked.picked === clicked.tag, clicked);
  check('UI：环形区显示当前标签', clicked.shownTag === clicked.picked, clicked.shownTag);

  await win.webContents.executeJavaScript('window.focusAPI.finishEarly()');
  await wait(250);

  // ---------------------------------------------------------- 自然走完 → 自动休息
  await data(win, 'saveSettings', { autoStartBreak: true, shortBreakMinutes: 5 });
  const natural = await data(win, 'startFocus', '学习', 0.01); // 0.6 秒
  check('短时专注已开始', natural.phase === 'running', natural.phase);
  let afterDone = null;
  let sawBreak = false;
  for (let i = 0; i < 30; i += 1) {
    await wait(250);
    const st = await data(win, 'getState');
    if (st.timer.phase === 'idle') { afterDone = st; break; }
    if (st.timer.mode !== 'focus') { sawBreak = true; afterDone = st; break; }
  }
  check('自然走完后自动进入休息（autoStartBreak 生效）',
    sawBreak && afterDone && afterDone.timer.mode === 'shortBreak', afterDone && afterDone.timer.mode);
  check('自动休息时长 = 设置里的短休息 5 分钟',
    !!afterDone && afterDone.timer.plannedMs === 5 * 60_000, afterDone && afterDone.timer.plannedMs);
  const doneRec = (await data(win, 'sessions', { tag: '学习', limit: 5 }))
    .find((r) => r.status === 'done');
  check('自然走完落库 status=done', !!doneRec, doneRec && doneRec.status);
  check('done 记录 ended_early = 0', doneRec && doneRec.ended_early === 0);
  check('进度环已重置为休息态', await win.webContents.executeJavaScript(
    'document.querySelector(".ring-wrap").classList.contains("is-break")'));
  // 收尾：结束休息，避免影响后续断言
  await data(win, 'reset');
  await data(win, 'saveSettings', { autoStartBreak: true });

  // 切页不报错
  const nav = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    for (const p of ['stats','history','settings']) {
      document.querySelector('.nav-item[data-page="' + p + '"]').click();
      await new Promise(r => setTimeout(r, 350));
      out.push({ page: p, visible: document.querySelector('.page[data-page="' + p + '"]').classList.contains('is-active') });
    }
    return out;
  })()`);
  check('四个页面均可切换', nav.every((n) => n.visible), nav);
  check('统计页渲染出 KPI',
    await win.webContents.executeJavaScript('document.getElementById("kpiToday").textContent !== "—"'));
  check('热力图渲染出格子',
    await win.webContents.executeJavaScript('document.querySelectorAll("#heatmap .heat-day").length > 25'));
  check('趋势图渲染出 SVG',
    await win.webContents.executeJavaScript('!!document.querySelector("#trend svg")'));

  // 热力图点击某天 -> 当天标签构成（走新增的 stats:dayDetail）
  const dayDetail = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav-item[data-page="stats"]').click();
    await new Promise(r => setTimeout(r, 300));
    const today = new Date();
    const p = n => String(n).padStart(2, '0');
    const key = today.getFullYear() + '-' + p(today.getMonth() + 1) + '-' + p(today.getDate());
    const cells = [...document.querySelectorAll('#heatmap .heat-day')];
    // 第 startPad + 日 个格子对应今天
    const dom = Number(key.slice(8));
    const cell = cells.find(c => c.title && c.title.startsWith(key));
    if (!cell) return { ok: false, reason: 'cell-not-found', key, count: cells.length };
    cell.click();
    await new Promise(r => setTimeout(r, 400));
    return { ok: true, text: document.getElementById('heatDetail').textContent,
             sel: !!document.querySelector('#heatmap .heat-day.is-sel') };
  })()`);
  check('热力图点击某天有响应', dayDetail.ok, dayDetail);
  check('当天详情含记录条数与标签构成',
    dayDetail.ok && dayDetail.text.includes('段：') && dayDetail.text.includes('E2E测试标签'), dayDetail.text);
  check('选中态高亮生效', dayDetail.ok && dayDetail.sel === true);

  // 点击标签 -> 历史视图
  const tagHist = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav-item[data-page="stats"]').click();
    await new Promise(r => setTimeout(r, 300));
    const row = [...document.querySelectorAll('#tagTable .tname')].find(el => el.textContent === 'E2E测试标签');
    if (!row) return { ok: false, reason: 'tag-row-missing' };
    row.click();
    await new Promise(r => setTimeout(r, 500));
    return { ok: true, title: document.getElementById('histTitle').textContent,
             rows: document.querySelectorAll('#histTable tbody tr').length,
             foot: document.getElementById('histFoot').textContent };
  })()`);
  check('点击标签进入该标签历史', tagHist.ok && tagHist.title.includes('E2E测试标签'), tagHist);
  check('历史页有记录行与累计说明',
    tagHist.ok && tagHist.rows >= 1 && tagHist.foot.includes('累计'), tagHist);

  console.log(`\n${passes} 项通过，${failures} 项失败`);
  app.exit(failures === 0 ? 0 : 1);
}

process.on('uncaughtException', (e) => {
  failures += 1;
  console.error('uncaught:', e);
});

app.whenReady().then(() => {
  main().catch((e) => {
    failures += 1;
    console.error('E2E 异常:', e);
    app.exit(1);
  });
});

app.on('web-contents-created', (_e, contents) => {
  contents.on('console-message', (_ev, level, message) => {
    if (level >= 2) console.log(`[renderer:${level}] ${message}`);
  });
  contents.on('render-process-gone', (_ev, details) => console.error('渲染进程崩溃', details));
});
