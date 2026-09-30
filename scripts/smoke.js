'use strict';
/**
 * 冒烟测试：不启动 Electron 界面，直接验证
 *   1) better-sqlite3 在当前 Node ABI 下能加载
 *   2) 建表 / 标签 / 记录的写入与统计 SQL 正确
 *   3) 计时核心的状态机与"暂停不计时长"规则正确
 *
 * 用法：node scripts/smoke.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store, dayKey, shiftDay } = require('../src/main/db');
const { Timer } = require('../src/main/timer');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-smoke-'));
const dbPath = path.join(tmpDir, 'smoke.db');

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''}`);
}

console.log('node', process.version, '| abi', process.versions.modules, '| tmp', tmpDir);

const store = new Store(dbPath);

// ---------------------------------------------------------------- 基础数据层
const tables = store.db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map((r) => r.name);
check('sessions 表存在', tables.includes('sessions'), tables);
check('tags 表存在', tables.includes('tags'));

const tags = store.listTags();
check('预设标签已植入', tags.filter((t) => t.is_preset).length >= 5, tags.map((t) => t.name));
check('预设标签含"写代码"', tags.some((t) => t.name === '写代码'));

const custom = store.ensureTag('练吉他');
check('自定义标签可创建', custom.name === '练吉他' && custom.is_preset === false, custom.color);
check('重复创建不报错且不重复', store.ensureTag('练吉他').id === custom.id);

// ---------------------------------------------------------------- 会话写入
const today = dayKey(Date.now());
store.insertSession({
  tag_name: '写代码',
  start_time: `${today}T09:00:00`,
  end_time: `${today}T09:25:00`,
  planned_minutes: 25,
  actual_minutes: 25,
  status: 'done',
  date: today,
  ended_early: false,
});
store.insertSession({
  tag_name: '学习',
  start_time: `${today}T10:00:00`,
  end_time: `${today}T10:18:30`,
  planned_minutes: 25,
  actual_minutes: 18.5,
  status: 'ended_early',
  date: today,
  ended_early: true,
});
store.insertSession({
  tag_name: '写代码',
  start_time: `${today}T11:00:00`,
  end_time: `${today}T11:04:00`,
  planned_minutes: 25,
  actual_minutes: 4,
  status: 'abandoned',
  date: today,
  ended_early: false,
});

const settings = store.getSettings();
const ov = store.overview(settings);
check('今日总时长 = 25 + 18.5 + 4 = 47.5', ov.todayMinutes === 47.5, ov.todayMinutes);
check('今日番茄（done）= 1', ov.todayPomodoro.done === 1, ov.todayPomodoro);
check('今日提前结束 = 1', ov.todayPomodoro.early === 1);
check('今日放弃 = 1', ov.todayPomodoro.abandoned === 1);
const codeTag = ov.todayByTag.find((t) => t.tag_name === '写代码');
check('按标签分组：写代码 29 分钟', codeTag && codeTag.minutes === 29, codeTag);
const studyTag = ov.todayByTag.find((t) => t.tag_name === '学习');
check('按标签分组：学习 18.5 分钟', studyTag && studyTag.minutes === 18.5, studyTag);
check('标签按分钟降序', ov.todayByTag[0].tag_name === '写代码', ov.todayByTag.map((t) => t.tag_name));

store.saveSettings({ abandonedRule: 'excluded' });
const ov2 = store.overview(store.getSettings());
check('切换"放弃不计入"后总时长 = 43.5', ov2.todayMinutes === 43.5, ov2.todayMinutes);
check('不计入时趋势同步排除放弃', store.trend(7, store.getSettings()).days[6].minutes === 43.5,
  store.trend(7, store.getSettings()).days[6]);
check('不计入时热力图同步排除放弃', store.heatmap(3).days[today] === 43.5, store.heatmap(3).days[today]);
store.saveSettings({ abandonedRule: 'counted' });
check('切回计入后总时长回到 47.5', store.overview(store.getSettings()).todayMinutes === 47.5);

check('连续天数 = 1', ov.streak === 1, ov.streak);
check('标签历史可查', store.tagHistory('写代码').rows.length === 2);
check('标签历史汇总正确', store.tagHistory('写代码').summary.minutes === 29, store.tagHistory('写代码').summary);

const trend = store.trend(7, store.getSettings());
check('趋势 7 天', trend.days.length === 7, trend.days.map((d) => d.minutes));
check('趋势最后一天为今天且 47.5', trend.days[6].date === today && trend.days[6].minutes === 47.5, trend.days[6]);

const heat = store.heatmap(3);
check('热力图为 3 个月区间', heat.from < heat.to, { from: heat.from, to: heat.to });
check('热力图含今日 47.5', heat.days[today] === 47.5, heat.days[today]);
check('热力图每日主标签', heat.topTagByDay[today] && heat.topTagByDay[today].tag === '写代码', heat.topTagByDay[today]);

const csvRows = store.exportRows();
check('CSV 导出行数 = 3', csvRows.length === 3, csvRows.length);
check('CSV 含中文表头', '标签' in csvRows[0] && '实际时长分钟' in csvRows[0], Object.keys(csvRows[0]));

// 跨天日聚合（昨天只记一次，验证 dailyTotals 覆盖范围）
const yesterday = shiftDay(today, -1);
store.insertSession({
  tag_name: '阅读',
  start_time: `${yesterday}T20:00:00`,
  end_time: `${yesterday}T20:30:00`,
  planned_minutes: 25,
  actual_minutes: 30,
  status: 'done',
  date: yesterday,
  ended_early: false,
});
const trend2 = store.trend(7, store.getSettings());
check('趋势含昨天 30 分钟', trend2.days[5].minutes === 30, trend2.days[5]);

// ---------------------------------------------------------------- 计时核心
const timer = new Timer(store);
timer.minBillableMs = 100; // 测试里把"有投入"阈值调小，避免为了几百毫秒等 3 秒
let finished = null;
timer.on('finished', (r) => { finished = r; });

check('初始状态 idle', timer.snapshot().phase === 'idle');
const started = timer.startFocus('写代码', 25);
check('开始后 running 且标签正确', started.phase === 'running' && started.tag.name === '写代码');
check('计划时长 25 分钟', started.plannedMs === 25 * 60_000);

timer.pause();
const paused = timer.snapshot();
check('暂停后 phase = paused', paused.phase === 'paused');
const accAfterPause = paused.actualMs;

// 暂停期间真实等待 600ms，这段时间不应计入
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await wait(600);
  const stillPaused = timer.snapshot();
  check('暂停期间实际时长不增长', stillPaused.actualMs === accAfterPause, {
    before: accAfterPause, after: stillPaused.actualMs,
  });

  timer.resume();
  await wait(400);
  const running = timer.snapshot();
  check('恢复后实际时长增长约 400ms', running.actualMs - accAfterPause >= 350, running.actualMs - accAfterPause);

  // 再多跑一会儿，让实际时长超过"有投入"阈值（50ms），才能验证 ended_early 而非 abandoned
  await wait(300);
  const beforeStop = timer.snapshot().actualMs;

  // 提前结束：应记为 ended_early 且实际时长 > 0
  const res = timer.stop('ended_early');
  check('提前结束产生记录', !!res.record, res.record && res.record.status);
  check('记录状态 ended_early', res.record.status === 'ended_early', {
    status: res.record.status, actualMs: beforeStop,
  });
  check('实际时长 > 0 且小于计划', res.record.actual_minutes > 0 && res.record.actual_minutes < 25, res.record.actual_minutes);
  check('ended_early 标记入库', res.record.ended_early === 1);
  check('记录含日期', /^\d{4}-\d{2}-\d{2}$/.test(res.record.date), res.record.date);
  check('返回 idle', timer.snapshot().phase === 'idle');
  check('finished 事件已派发', finished !== null && finished.wasFocus === true);

  // 立刻放弃：实际时长≈0 -> abandoned
  timer.startFocus('学习', 25);
  const res2 = timer.stop('ended_early');
  check('零投入的结束记为 abandoned', res2.record.status === 'abandoned', res2.record.status);

  // 自然走完：用极短计划时长验证 checkExpiry
  timer.startFocus('计算机', 0.01); // 0.6 秒
  await wait(800);
  const expired = timer.checkExpiry();
  check('到点自动结束', expired !== null && expired.record.status === 'done', expired && expired.record.status);
  check('自动结束落库时长≈0.01', expired.record.actual_minutes >= 0.01, expired.record.actual_minutes);

  // 休息模式不入库
  timer.startBreak('shortBreak', 5);
  const brk = timer.stop();
  check('休息结束不写 sessions', brk.record === null && brk.wasFocus === false);

  // 统计复核：上面新增 3 条（ended_early / abandoned / done）
  const ov3 = store.overview(store.getSettings());
  check('今日记录数 = 3 + 3 = 6', ov3.todaySessions === 6, ov3.todaySessions);
  check('今日总时长约 47.5 + 0.01 + 小量', ov3.todayMinutes > 47.5, ov3.todayMinutes);

  // ---------------------------------------------------------------- 某天明细
  const detail = store.dayDetail(today);
  const codeInDetail = detail.byTag.find((t) => t.tag_name === '写代码');
  check('dayDetail 返回 6 条', detail.sessions.length === 6, detail.sessions.length);
  check('dayDetail 总时长与 overview 一致', detail.totalMinutes === ov3.todayMinutes,
    { detail: detail.totalMinutes, overview: ov3.todayMinutes });
  check('dayDetail 按标签降序且含写代码', detail.byTag[0].tag_name === '写代码',
    detail.byTag.map((t) => `${t.tag_name}:${t.minutes}`));
  check('dayDetail 里写代码 = 3 段（含计时核心那 1 段）且 ≥29 分钟',
    codeInDetail.sessions === 3 && codeInDetail.minutes >= 29, codeInDetail);
  check('dayDetail 空日期返回空', store.dayDetail('1999-01-01').sessions.length === 0);

  // ---------------------------------------------------------------- CSV 编码
  const beforeExport = store.exportRows().length;
  store.ensureTag('带,逗号"引号');
  store.insertSession({
    tag_name: '带,逗号"引号',
    start_time: `${today}T23:00:00`,
    end_time: `${today}T23:05:00`,
    planned_minutes: 25,
    actual_minutes: 5,
    status: 'ended_early',
    date: today,
    ended_early: true,
    note: '备注里有,逗号和"引号',
  });
  const csvRows = store.exportRows();
  check('CSV 导出条数 +1', csvRows.length === beforeExport + 1, { before: beforeExport, after: csvRows.length });
  const weird = csvRows.find((r) => r.标签 === '带,逗号"引号');
  check('CSV 含逗号/引号的标签原样保留', !!weird, weird && weird.标签);
  check('CSV 状态中文化', weird.状态 === '提前结束', weird.状态);
  check('CSV 是否提前结束列正确', weird.是否提前结束 === '是' && weird.是否完成 === '否',
    { 完成: weird.是否完成, 提前: weird.是否提前结束 });
  check('CSV 备注字段带出', weird.备注 === '备注里有,逗号和"引号', weird.备注);

  // 复刻 main.js 的 CSV 序列化逻辑，验证转义与 BOM
  const headers = Object.keys(csvRows[0]);
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.join(','), ...csvRows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\r\n');
  check('CSV 含中文表头', csv.startsWith('日期,标签,开始时间,结束时间'), csv.slice(0, 40));
  check('CSV 用 CRLF 换行', csv.includes('\r\n'));
  check('CSV 正确转义双引号', csv.includes('"带,逗号""引号"'), csv.split('\r\n').find((l) => l.includes('逗号')));
  check('CSV 行数 = 表头 + 数据行', csv.split('\r\n').length === csvRows.length + 1, csv.split('\r\n').length);
  check('CSV 加 BOM 后首字符正确', ('\uFEFF' + csv).charCodeAt(0) === 0xfeff);

  console.log('\n' + (failures === 0 ? `全部通过（0 失败）` : `${failures} 项失败`));
  console.log('db file:', dbPath);
  process.exit(failures === 0 ? 0 : 1);
})();
