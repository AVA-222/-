'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** 本地时间戳 -> 'YYYY-MM-DDTHH:mm:ss'（本地时区，可直接字典序比较） */
function stamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** 本地日期 -> 'YYYY-MM-DD' */
function dayKey(ms) {
  return stamp(ms).slice(0, 10);
}

function shiftDay(key, delta) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d + delta);
  return dayKey(dt.getTime());
}

function nowMs() {
  return Date.now();
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  color       TEXT NOT NULL DEFAULT '#5b8def',
  is_preset   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_name        TEXT NOT NULL,
  start_time      TEXT NOT NULL,
  end_time        TEXT,
  planned_minutes REAL NOT NULL,
  actual_minutes  REAL NOT NULL DEFAULT 0,
  status          TEXT NOT NULL,
  date            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_date     ON sessions(date);
CREATE INDEX IF NOT EXISTS idx_sessions_tag      ON sessions(tag_name);
CREATE INDEX IF NOT EXISTS idx_sessions_tag_date ON sessions(tag_name, date);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const PRESET_TAGS = [
  ['写代码', '#5b8def'],
  ['学习', '#f2994a'],
  ['计算机', '#9b51e0'],
  ['阅读', '#27ae60'],
  ['写作', '#eb5757'],
];

/** 默认设置 */
const DEFAULT_SETTINGS = {
  focusMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  longBreakEvery: 4,
  autoStartBreak: true,
  // 'abandoned' 计入今日统计但单独标记（默认）；'excluded' 完全不计入
  abandonedRule: 'counted',
  includePartialInPomodoro: false,
  soundEnabled: true,
  soundVolume: 0.6,
  notifyEnabled: true,
  minimizeToTray: true,
  alwaysOnTopMini: true,
};

class Store {
  /**
   * @param {string} dbPath
   */
  constructor(dbPath) {
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    // 延迟 require，便于在 Electron ABI 不匹配时给出可读报错
    const Database = require('better-sqlite3');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);
    this.migrate();
    this.seedTags();
    this.seedSettings();
  }

  migrate() {
    const cols = new Set(
      this.db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name),
    );
    if (!cols.has('ended_early')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN ended_early INTEGER NOT NULL DEFAULT 0');
    }
    if (!cols.has('note')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN note TEXT');
    }
  }

  seedTags() {
    const insert = this.db.prepare(
      `INSERT INTO tags (name, color, is_preset, created_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(name) DO NOTHING`,
    );
    const t = stamp(nowMs());
    const tx = this.db.transaction(() => {
      for (const [name, color] of PRESET_TAGS) insert.run(name, color, t);
    });
    tx();
  }

  seedSettings() {
    const insert = this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING',
    );
    const tx = this.db.transaction(() => {
      for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        insert.run(k, JSON.stringify(v));
      }
    });
    tx();
  }

  // ---------------------------------------------------------------- settings

  getSettings() {
    const rows = this.db.prepare('SELECT key, value FROM settings').all();
    const out = { ...DEFAULT_SETTINGS };
    for (const row of rows) {
      try {
        out[row.key] = JSON.parse(row.value);
      } catch {
        /* 忽略坏值，回落到默认 */
      }
    }
    return out;
  }

  saveSettings(patch) {
    const stmt = this.db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    const allowed = new Set(Object.keys(DEFAULT_SETTINGS));
    const tx = this.db.transaction(() => {
      for (const [k, v] of Object.entries(patch || {})) {
        if (!allowed.has(k)) continue;
        stmt.run(k, JSON.stringify(v));
      }
    });
    tx();
    return this.getSettings();
  }

  // -------------------------------------------------------------------- tags

  listTags() {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.name, t.color, t.is_preset, t.created_at,
                COALESCE(s.cnt, 0)  AS session_count,
                COALESCE(s.mins, 0) AS total_minutes
         FROM tags t
         LEFT JOIN (
           SELECT tag_name, COUNT(*) AS cnt, SUM(actual_minutes) AS mins
           FROM sessions GROUP BY tag_name
         ) s ON s.tag_name = t.name
         ORDER BY t.is_preset DESC, t.id ASC`,
      )
      .all();
    // 记录里出现过但 tags 表没有的标签（例如外部导入）也一并返回
    const known = new Set(rows.map((r) => r.name));
    const orphans = this.db
      .prepare(
        `SELECT tag_name AS name, COUNT(*) AS session_count, SUM(actual_minutes) AS total_minutes
         FROM sessions GROUP BY tag_name`,
      )
      .all()
      .filter((r) => !known.has(r.name));
    for (const o of orphans) {
      rows.push({
        id: null,
        name: o.name,
        color: '#9aa4b2',
        is_preset: 0,
        created_at: null,
        session_count: o.session_count,
        total_minutes: o.total_minutes,
      });
    }
    return rows.map((r) => ({
      ...r,
      is_preset: !!r.is_preset,
      total_minutes: round2(r.total_minutes),
    }));
  }

  ensureTag(name, color) {
    const clean = String(name || '').trim();
    if (!clean) throw new Error('标签名不能为空');
    if (clean.length > 24) throw new Error('标签名最长 24 个字符');
    const existing = this.db.prepare('SELECT * FROM tags WHERE name = ?').get(clean);
    if (existing) return { ...existing, is_preset: !!existing.is_preset };
    const info = this.db
      .prepare('INSERT INTO tags (name, color, is_preset, created_at) VALUES (?, ?, 0, ?)')
      .run(clean, color || pickColor(clean), stamp(nowMs()));
    const row = this.db.prepare('SELECT * FROM tags WHERE id = ?').get(info.lastInsertRowid);
    return { ...row, is_preset: !!row.is_preset };
  }

  renameTag(id, name) {
    const clean = String(name || '').trim();
    if (!clean) throw new Error('标签名不能为空');
    if (clean.length > 24) throw new Error('标签名最长 24 个字符');
    const old = this.db.prepare('SELECT name FROM tags WHERE id = ?').get(id);
    if (!old) throw new Error('标签不存在');
    if (old.name === clean) return this.listTags();
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(clean, id);
      this.db.prepare('UPDATE sessions SET tag_name = ? WHERE tag_name = ?').run(clean, old.name);
    });
    tx();
    return this.listTags();
  }

  deleteTag(id) {
    const row = this.db.prepare('SELECT name, is_preset FROM tags WHERE id = ?').get(id);
    if (!row) throw new Error('标签不存在');
    if (row.is_preset) throw new Error('预设标签不可删除');
    this.db.prepare('DELETE FROM tags WHERE id = ?').run(id);
    return this.listTags();
  }

  // ---------------------------------------------------------------- sessions

  insertSession(rec) {
    const info = this.db
      .prepare(
        `INSERT INTO sessions
           (tag_name, start_time, end_time, planned_minutes, actual_minutes, status, date, ended_early, note)
         VALUES (@tag_name, @start_time, @end_time, @planned_minutes, @actual_minutes, @status, @date, @ended_early, @note)`,
      )
      .run({
        tag_name: rec.tag_name,
        start_time: rec.start_time,
        end_time: rec.end_time,
        planned_minutes: round2(rec.planned_minutes),
        actual_minutes: round2(rec.actual_minutes),
        status: rec.status,
        date: rec.date,
        ended_early: rec.ended_early ? 1 : 0,
        note: rec.note ?? null,
      });
    this.ensureTag(rec.tag_name);
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(info.lastInsertRowid);
  }

  listSessions({ from, to, tag, limit = 500 } = {}) {
    const where = [];
    const params = {};
    if (from) {
      where.push('date >= @from');
      params.from = from;
    }
    if (to) {
      where.push('date <= @to');
      params.to = to;
    }
    if (tag) {
      where.push('tag_name = @tag');
      params.tag = tag;
    }
    const sql =
      `SELECT * FROM sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ` +
      `ORDER BY start_time DESC LIMIT @limit`;
    params.limit = limit;
    return this.db.prepare(sql).all(params);
  }

  /**
   * 按本地日期聚合实际时长。
   * abandonedRule='excluded' 时排除 status='abandoned' 的记录，
   * 且该规则统一作用于今日总时长 / 趋势 / 热力图 / 连续天数。
   */
  dailyTotals(from, to) {
    const inc = this.getSettings().abandonedRule !== 'excluded';
    const rows = this.db
      .prepare(
        `SELECT start_time, end_time, actual_minutes, status, date
         FROM sessions
         WHERE date >= ? AND date <= ?${inc ? '' : " AND status <> 'abandoned'"}`,
      )
      .all(from, to);
    const out = new Map();
    for (const r of rows) {
      addDay(out, r.date, shareOfDay(r));
    }
    return out;
  }

  // ------------------------------------------------------------------- stats

  overview(settings) {
    const today = dayKey(nowMs());
    const totals = this.dailyTotals(shiftDay(today, -400), today);
    const todayMinutes = round2(totals.get(today) || 0);

    const inc = settings.abandonedRule !== 'excluded';
    const suffix = inc ? '' : " AND status <> 'abandoned'";

    // 今日按标签：与 todayMinutes 同源（受 abandonedRule 影响）
    const todayRows = this.db
      .prepare(
        `SELECT tag_name, COUNT(*) AS sessions, SUM(actual_minutes) AS minutes,
                SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS completed
         FROM sessions WHERE date = ?${suffix} GROUP BY tag_name ORDER BY minutes DESC`,
      )
      .all(today);
    const byTagAll = this.db
      .prepare(
        `SELECT tag_name, COUNT(*) AS sessions, SUM(actual_minutes) AS minutes,
                SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS completed
         FROM sessions GROUP BY tag_name ORDER BY minutes DESC`,
      )
      .all();

    const statusClause = inc ? '1 = 1' : "status <> 'abandoned'";
    const statusClauseAll = statusClause;

    const todayFiltered = this.db
      .prepare(
        `SELECT COALESCE(SUM(actual_minutes), 0) AS minutes,
                SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done_count,
                SUM(CASE WHEN status IN ('done','ended_early') THEN 1 ELSE 0 END) AS finished_count,
                SUM(CASE WHEN status = 'abandoned' THEN 1 ELSE 0 END) AS abandoned_count,
                SUM(CASE WHEN status = 'ended_early' THEN 1 ELSE 0 END) AS early_count
         FROM sessions WHERE date = ? AND ${statusClause}`,
      )
      .get(today);

    const totalFiltered = this.db
      .prepare(
        `SELECT COALESCE(SUM(actual_minutes), 0) AS minutes,
                COUNT(*) AS sessions,
                SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done_count
         FROM sessions WHERE ${statusClauseAll}`,
      )
      .get();

    // 连续天数（按有记录的日期，含今天或昨天结尾）
    const days = [...totals.entries()]
      .filter(([, v]) => v >= 0.5)
      .map(([k]) => k)
      .sort();
    let streak = 0;
    if (days.length) {
      const set = new Set(days);
      let cursor = set.has(today) ? today : shiftDay(today, -1);
      while (set.has(cursor)) {
        streak += 1;
        cursor = shiftDay(cursor, -1);
      }
    }

    return {
      today,
      todayMinutes,
      todaySessions: todayRows.reduce((a, r) => a + r.sessions, 0),
      todayByTag: todayRows.map((r) => ({ ...r, minutes: round2(r.minutes) })),
      byTag: byTagAll.map((r) => ({ ...r, minutes: round2(r.minutes) })),
      todayPomodoro: {
        done: todayFiltered.done_count || 0,
        finished: todayFiltered.finished_count || 0,
        abandoned: todayFiltered.abandoned_count || 0,
        early: todayFiltered.early_count || 0,
        minutes: round2(todayFiltered.minutes || 0),
      },
      allTime: {
        minutes: round2(totalFiltered.minutes || 0),
        sessions: totalFiltered.sessions || 0,
        done: totalFiltered.done_count || 0,
      },
      streak,
      totalsByDay: Object.fromEntries([...totals.entries()].map(([k, v]) => [k, round2(v)])),
    };
  }

  trend(days, settings) {
    const today = dayKey(nowMs());
    const from = shiftDay(today, -(days - 1));
    const totals = this.dailyTotals(from, today);
    const out = [];
    for (let i = 0; i < days; i += 1) {
      const key = shiftDay(from, i);
      out.push({ date: key, minutes: round2(totals.get(key) || 0) });
    }
    const perTag = this.db
      .prepare(
        `SELECT date, tag_name, SUM(actual_minutes) AS minutes
         FROM sessions WHERE date >= ? AND date <= ?
         GROUP BY date, tag_name`,
      )
      .all(from, today);
    return { days: out, perTag, from, to: today };
  }

  heatmap(months) {
    const today = new Date();
    const end = dayKey(today.getTime());
    const start = new Date(today.getFullYear(), today.getMonth() - (months - 1), 1);
    const from = dayKey(start.getTime());
    const totals = this.dailyTotals(from, end);
    const sessionCounts = new Map(
      this.db
        .prepare(
          `SELECT date, COUNT(*) AS cnt FROM sessions
           WHERE date >= ? AND date <= ? GROUP BY date`,
        )
        .all(from, end)
        .map((r) => [r.date, r.cnt]),
    );
    const dayStatus = new Map(
      this.db
        .prepare(
          `SELECT date, tag_name, SUM(actual_minutes) AS minutes
           FROM sessions WHERE date >= ? AND date <= ? GROUP BY date, tag_name`,
        )
        .all(from, end)
        .map((r) => [`${r.date}|${r.tag_name}`, round2(r.minutes)]),
    );
    return {
      from,
      to: end,
      days: Object.fromEntries([...totals.entries()].map(([k, v]) => [k, round2(v)])),
      sessions: Object.fromEntries(sessionCounts),
      topTagByDay: topTagsByDay(dayStatus),
    };
  }

  tagHistory(tag, limit = 1000) {
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE tag_name = ? ORDER BY start_time DESC LIMIT ?')
      .all(tag, limit);
    const totals = this.db
      .prepare(
        `SELECT COALESCE(SUM(actual_minutes),0) AS minutes, COUNT(*) AS sessions,
                SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done_count,
                MIN(date) AS first_date, MAX(date) AS last_date
         FROM sessions WHERE tag_name = ?`,
      )
      .get(tag);
    const byDay = this.db
      .prepare(
        `SELECT date, SUM(actual_minutes) AS minutes FROM sessions
         WHERE tag_name = ? GROUP BY date ORDER BY date ASC`,
      )
      .all(tag)
      .map((r) => ({ ...r, minutes: round2(r.minutes) }));
    return { tag, rows, summary: { ...totals, minutes: round2(totals.minutes) }, byDay };
  }

  /** 某一天的明细：按标签汇总 + 逐条记录（热力图点击某天用，避免在渲染层做长时间跨度的筛选） */
  dayDetail(date) {
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE date = ? ORDER BY start_time ASC')
      .all(date);
    const byTagMap = new Map();
    for (const r of rows) {
      const cur = byTagMap.get(r.tag_name) || { tag_name: r.tag_name, minutes: 0, sessions: 0, done: 0 };
      cur.minutes += Number(r.actual_minutes) || 0;
      cur.sessions += 1;
      if (r.status === 'done') cur.done += 1;
      byTagMap.set(r.tag_name, cur);
    }
    const byTag = [...byTagMap.values()]
      .map((t) => ({ ...t, minutes: round2(t.minutes) }))
      .sort((a, b) => b.minutes - a.minutes);
    return {
      date,
      totalMinutes: round2(rows.reduce((a, r) => a + (Number(r.actual_minutes) || 0), 0)),
      sessions: rows,
      byTag,
    };
  }

  exportRows({ from, to, tag } = {}) {
    const rows = this.listSessions({ from, to, tag, limit: 1000000 });
    return rows
      .slice()
      .sort((a, b) => (a.start_time < b.start_time ? -1 : 1))
      .map((r) => ({
        日期: r.date,
        标签: r.tag_name,
        开始时间: r.start_time.replace('T', ' '),
        结束时间: (r.end_time || '').replace('T', ' '),
        计划时长分钟: round2(r.planned_minutes),
        实际时长分钟: round2(r.actual_minutes),
        状态: statusLabel(r.status),
        是否完成: r.status === 'done' ? '是' : '否',
        是否提前结束: r.status === 'ended_early' ? '是' : '否',
        备注: r.note || '',
      }));
  }
}

function statusLabel(s) {
  return (
    { done: '已完成', ended_early: '提前结束', abandoned: '已放弃', running: '进行中' }[s] || s
  );
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function addDay(map, key, minutes) {
  map.set(key, (map.get(key) || 0) + minutes);
}

/** 一条记录按日期归属的分钟数：跨午夜时按比例切分 */
function shareOfDay(row) {
  const sameDay = !row.end_time || row.end_time.slice(0, 10) === row.start_time.slice(0, 10);
  if (sameDay) return Number(row.actual_minutes) || 0;
  return Number(row.actual_minutes) || 0; // 跨夜记录整体记在开始日，保持语义简单可解释
}

function topTagsByDay(pairs) {
  const acc = new Map();
  for (const [key, minutes] of pairs) {
    const [date, tag] = key.split('|');
    const cur = acc.get(date);
    if (!cur || minutes > cur.minutes) acc.set(date, { tag, minutes });
  }
  return Object.fromEntries(acc);
}

const TAG_COLORS = [
  '#5b8def', '#f2994a', '#9b51e0', '#27ae60', '#eb5757',
  '#2d9cdb', '#00b8a9', '#f2c94c', '#bb6bd9', '#6fcf97',
];

function pickColor(seed) {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return TAG_COLORS[h % TAG_COLORS.length];
}

module.exports = {
  Store,
  stamp,
  dayKey,
  shiftDay,
  nowMs,
  round2,
  statusLabel,
  DEFAULT_SETTINGS,
  PRESET_TAGS,
  pickColor,
};
