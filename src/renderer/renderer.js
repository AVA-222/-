'use strict';
/* ============================================================
   专注器 · 渲染层
   ============================================================ */
(() => {
  const api = window.focusAPI;
  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  let currentTags = [];
  let currentState = null;
  let settings = null;
  let trendDays = 7;
  let heatMonth = null; // {year, month}
  let heatSel = null;
  let heatCache = null;
  let history = { range: '30', tag: '' };
  let historyMode = 'list'; // list = 通用筛选视图；tag = 单标签历史视图

  const RING_CIRCUMFERENCE = 2 * Math.PI * 106;

  // ------------------------------------------------------------ 工具
  function fmtMin(min) {
    const m = Math.round(Number(min) || 0);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${h}h${r}m` : `${h}h`;
  }

  function fmtClock(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    if (m >= 60) {
      const h = Math.floor(m / 60);
      return `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function hm(stamp) {
    if (!stamp) return '—';
    return stamp.slice(11, 16);
  }

  function dateObj(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function mdLabel(key) {
    const d = dateObj(key);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  function weekday(key) {
    return ['日', '一', '二', '三', '四', '五', '六'][dateObj(key).getDay()];
  }

  function addDays(key, delta) {
    const d = dateObj(key);
    d.setDate(d.getDate() + delta);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    $('toastWrap').appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0';
      el.style.transform = 'translateX(14px)';
      setTimeout(() => el.remove(), 320);
    }, 2600);
  }

  /** 统一的 IPC 返回处理：{ok, data, error} */
  async function call(promise, { silent = false } = {}) {
    const res = await promise;
    if (!res) return null;
    if (res.ok) return res.data;
    if (!silent) toast(`操作失败：${res.error}`, 'err');
    throw new Error(res.error);
  }

  // ------------------------------------------------------------ 提示音
  let audioCtx = null;
  function playCue(kind) {
    if (!settings || settings.soundEnabled === false) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const vol = Math.max(0, Math.min(1, settings.soundVolume ?? 0.6));
      const now = audioCtx.currentTime;
      const notes = kind === 'stop' ? [660] : [880, 1174.7, 1568];
      notes.forEach((freq, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const t0 = now + i * 0.16;
        gain.gain.setValueAtTime(0, t0);
        gain.gain.linearRampToValueAtTime(0.32 * vol, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.55);
      });
    } catch (error) {
      /* 音频不可用时静默 */
    }
  }

  // ------------------------------------------------------------ 导航
  function navigate(page) {
    $$('.nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.page === page));
    $$('.page').forEach((p) => p.classList.toggle('is-active', p.dataset.page === page));
    if (page === 'stats') refreshStats();
    if (page === 'history') refreshHistory();
    if (page === 'settings') refreshSettings();
  }

  $$('.nav-item').forEach((btn) => btn.addEventListener('click', () => navigate(btn.dataset.page)));

  // ------------------------------------------------------------ 专注页渲染
  function renderFocus(state) {
    const s = state.timer;
    const ring = $('ringProgress');
    const wrap = document.querySelector('.ring-wrap');

    const planned = s.plannedMs || 0;
    const progress = planned ? Math.min(1, s.actualMs / planned) : 0;
    const dash = RING_CIRCUMFERENCE * progress;
    ring.setAttribute('stroke-dasharray', String(RING_CIRCUMFERENCE));
    ring.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE - dash));

    wrap.classList.toggle('is-break', s.mode !== 'focus');
    wrap.classList.toggle('is-paused', s.phase === 'paused');

    const isBreak = s.mode !== 'focus';
    $('ringTag').textContent = isBreak
      ? (s.mode === 'longBreak' ? '长休息' : '短休息')
      : (s.tag ? s.tag.name : '未选择主题');
    $('ringTime').textContent = fmtClock(s.remainingMs);

    const stateText = {
      idle: '准备开始',
      running: isBreak ? '休息中…' : '专注中…',
      paused: '已暂停',
    }[s.phase];
    $('ringState').textContent = stateText;

    const idle = s.phase === 'idle';
    const btn = $('btnPrimary');
    btn.textContent = idle ? '开始专注' : s.phase === 'running' ? '暂停' : '继续';
    $('btnFinish').disabled = idle;
    $('btnAbandon').disabled = idle;
    $('btnReset').disabled = idle;

    const metaParts = [];
    if (!idle) {
      metaParts.push(`计划 ${Math.round(s.plannedMs / 60000)} 分钟`);
      metaParts.push(`已投入 ${fmtClock(s.actualMs)}`);
      if (s.startedAt) metaParts.push(`开始于 ${hm(s.startedAt)}`);
    } else {
      metaParts.push(`默认 ${settings ? settings.focusMinutes : 25} 分钟 · 休息 ${settings ? settings.shortBreakMinutes : 5} 分钟`);
      metaParts.push('快捷键 Ctrl+Alt+F 开始/暂停');
    }
    $('focusMeta').textContent = metaParts.join(' · ');
  }

  function renderSidebar(state) {
    const ov = state.overview;
    $('sideToday').textContent = fmtMin(ov.todayMinutes);
    $('sideTodaySub').textContent = `${ov.todayPomodoro.done} 个番茄 · 连续 ${ov.streak} 天`;
  }

  function renderQuickTags() {
    const box = $('quickTags');
    box.innerHTML = '';
    const list = currentTags.filter((t) => t.session_count > 0).slice(0, 6);
    const fallback = currentTags.filter((t) => t.is_preset).slice(0, 6);
    const show = (list.length ? list : fallback);
    for (const t of show) {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.innerHTML = `<i class="dot" style="background:${t.color}"></i><span>${escapeHtml(t.name)}</span>` +
        (t.session_count ? `<span class="cnt">${t.session_count}次</span>` : '');
      chip.addEventListener('click', () => startWithTag(t.name));
      box.appendChild(chip);
    }
    const add = document.createElement('button');
    add.className = 'chip chip-add';
    add.textContent = '+ 更多标签…';
    add.addEventListener('click', openPicker);
    box.appendChild(add);
    $('quickDurWrap').textContent = `默认 ${settings ? settings.focusMinutes : 25} 分钟`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ------------------------------------------------------------ 标签选择弹窗
  let picker = { tag: null, minutes: 25 };

  function openPicker() {
    picker.tag = null;
    picker.minutes = settings ? settings.focusMinutes : 25;
    $('newTagInput').value = '';
    $('durCustom').value = '';
    $$('#durChips .chip').forEach((c) => c.classList.toggle('is-active', Number(c.dataset.min) === picker.minutes));
    renderPickerTags();
    updatePicked();
    $('pickerMask').hidden = false;
    setTimeout(() => $('newTagInput').focus(), 50);
  }

  function closePicker() {
    $('pickerMask').hidden = true;
  }

  function renderPickerTags() {
    const presets = currentTags.filter((t) => t.is_preset);
    const customs = currentTags.filter((t) => !t.is_preset);
    const draw = (box, list) => {
      box.innerHTML = '';
      for (const t of list) {
        const chip = document.createElement('button');
        chip.className = 'chip' + (picker.tag === t.name ? ' is-active' : '');
        chip.innerHTML = `<i class="dot" style="background:${t.color}"></i><span>${escapeHtml(t.name)}</span>` +
          (t.total_minutes ? `<span class="cnt">${fmtMin(t.total_minutes)}</span>` : '');
        chip.addEventListener('click', () => {
          picker.tag = t.name;
          renderPickerTags();
          updatePicked();
        });
        box.appendChild(chip);
      }
      if (!list.length) box.innerHTML = '<span class="muted">暂无，添加一个吧</span>';
    };
    draw($('presetTags'), presets);
    draw($('customTags'), customs);
  }

  function updatePicked() {
    $('pickedTag').textContent = picker.tag || '—';
    $('pickerStart').disabled = !picker.tag;
  }

  $('addTagBtn').addEventListener('click', async () => {
    const name = $('newTagInput').value.trim();
    if (!name) return;
    try {
      const tag = await call(api.addTag(name));
      currentTags = await call(api.listTags());
      picker.tag = tag.name;
      $('newTagInput').value = '';
      renderPickerTags();
      updatePicked();
      renderQuickTags();
      toast(`已添加标签「${tag.name}」`, 'ok');
    } catch { /* 已提示 */ }
  });

  $('newTagInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('addTagBtn').click();
  });

  $$('#durChips .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      picker.minutes = Number(chip.dataset.min);
      $('durCustom').value = '';
      $$('#durChips .chip').forEach((c) => c.classList.toggle('is-active', c === chip));
    });
  });

  $('durCustom').addEventListener('input', () => {
    const v = Number($('durCustom').value);
    if (v > 0) {
      picker.minutes = Math.min(180, Math.max(1, v));
      $$('#durChips .chip').forEach((c) => c.classList.remove('is-active'));
    }
  });

  $('pickerStart').addEventListener('click', async () => {
    if (!picker.tag) return;
    await startWithTag(picker.tag, picker.minutes);
    closePicker();
  });

  $('pickerCancel').addEventListener('click', closePicker);
  $('pickerClose').addEventListener('click', closePicker);
  $('pickerMask').addEventListener('click', (e) => {
    if (e.target === $('pickerMask')) closePicker();
  });

  async function startWithTag(tagName, minutes) {
    try {
      await call(api.startFocus(tagName, minutes || (settings ? settings.focusMinutes : 25)));
      toast(`开始专注「${tagName}」`, 'ok');
      navigate('focus');
    } catch { /* 已提示 */ }
  }

  // ------------------------------------------------------------ 主按钮
  $('btnPrimary').addEventListener('click', async () => {
    const s = currentState?.timer;
    if (!s || s.phase === 'idle') {
      openPicker();
      return;
    }
    await call(api.toggle());
  });

  $('btnFinish').addEventListener('click', async () => {
    if (!confirm('提前结束本次专注？已投入的时间会如实记录为「提前结束」。')) return;
    await call(api.finishEarly());
  });

  $('btnAbandon').addEventListener('click', async () => {
    if (!confirm('放弃本次专注？记录会标记为「放弃」，是否计入统计取决于设置。')) return;
    await call(api.abandon());
  });

  $('btnReset').addEventListener('click', async () => {
    if (!confirm('重置计时？当前这一段不会写入记录。')) return;
    await call(api.reset());
  });

  $('btnMini').addEventListener('click', async () => {
    const visible = await call(api.showMini());
    toast(visible ? '迷你悬浮窗已显示' : '迷你悬浮窗已隐藏');
  });

  $('btnQuit').addEventListener('click', async () => {
    if (confirm('退出专注器？正在进行的计时会丢失（未写入记录）。')) await call(api.quitApp());
  });

  // ------------------------------------------------------------ 统计页
  async function refreshStats() {
    const [ov, tags] = await Promise.all([call(api.overview()), call(api.listTags())]);
    currentTags = tags;

    $('kpiToday').textContent = fmtMin(ov.todayMinutes);
    $('kpiTodaySub').textContent = `${ov.todaySessions} 段记录 · ${ov.today}`;
    $('kpiPomodoro').textContent = `${ov.todayPomodoro.done}`;
    $('kpiPomodoroSub').textContent =
      `完成 ${ov.todayPomodoro.done} · 提前 ${ov.todayPomodoro.early} · 放弃 ${ov.todayPomodoro.abandoned}`;
    $('kpiStreak').textContent = `${ov.streak} 天`;
    $('kpiTotal').textContent = fmtMin(ov.allTime.minutes);
    $('kpiTotalSub').textContent = `共 ${ov.allTime.sessions} 段 · 完成 ${ov.allTime.done} 个番茄`;

    // 今日各标签
    const box = $('todayTagBars');
    box.innerHTML = '';
    const maxToday = Math.max(1, ...ov.todayByTag.map((t) => t.minutes));
    if (!ov.todayByTag.length) {
      box.innerHTML = '<div class="muted">今天还没有记录，先开始一次专注吧。</div>';
    }
    for (const t of ov.todayByTag) {
      const color = (tags.find((x) => x.name === t.tag_name) || {}).color || 'var(--accent)';
      const row = document.createElement('div');
      row.className = 'tag-bar';
      row.innerHTML =
        `<span class="name" title="查看「${escapeHtml(t.tag_name)}」历史">${escapeHtml(t.tag_name)}</span>` +
        `<span class="track"><i class="fill" style="width:${(t.minutes / maxToday) * 100}%;background:${color}"></i></span>` +
        `<span class="val">${fmtMin(t.minutes)} / ${t.sessions}次</span>`;
      row.querySelector('.name').addEventListener('click', () => openTagHistory(t.tag_name));
      box.appendChild(row);
    }
    $('todayTagHint').textContent = `${ov.todayByTag.length} 个标签`;

    // 全部标签累计
    const tt = $('tagTable');
    tt.innerHTML = '';
    const maxAll = Math.max(1, ...ov.byTag.map((t) => t.minutes));
    if (!ov.byTag.length) tt.innerHTML = '<div class="muted">暂无数据</div>';
    for (const t of ov.byTag) {
      const color = (tags.find((x) => x.name === t.tag_name) || {}).color || '#94a3b8';
      const row = document.createElement('div');
      row.className = 'tag-row';
      row.innerHTML =
        `<i class="tag-dot" style="background:${color}"></i>` +
        `<span class="tname" title="查看历史">${escapeHtml(t.tag_name)}</span>` +
        `<span class="track" style="background:rgba(255,255,255,.05);border-radius:5px;height:8px;overflow:hidden">` +
        `<i style="display:block;height:100%;width:${(t.minutes / maxAll) * 100}%;background:${color}"></i></span>` +
        `<span class="num">${fmtMin(t.minutes)}</span>` +
        `<span class="num">${t.sessions} 次</span>`;
      row.querySelector('.tname').addEventListener('click', () => openTagHistory(t.tag_name));
      tt.appendChild(row);
    }

    await Promise.all([refreshTrend(), refreshHeatmap()]);
    fillHistoryTagSelect();
  }

  async function refreshTrend() {
    const data = await call(api.trend(trendDays));
    const el = $('trend');
    const days = data.days;

    // 最近 7 天横向条
    const seven = days.slice(-7);
    const bars7 = $('bars7');
    bars7.innerHTML = '';
    const max7 = Math.max(1, ...seven.map((d) => d.minutes));
    for (const d of seven) {
      const row = document.createElement('div');
      row.className = 'bar7' + (d.date === data.to ? ' is-today' : '');
      row.innerHTML =
        `<span>${mdLabel(d.date)} 周${weekday(d.date)}</span>` +
        `<span class="col"><i style="width:${(d.minutes / max7) * 100}%"></i></span>` +
        `<span class="val">${fmtMin(d.minutes)}</span>`;
      bars7.appendChild(row);
    }

    // 趋势图
    if (days.length <= 10) {
      const max = Math.max(1, ...days.map((d) => d.minutes));
      el.innerHTML = renderBarChart(days, max, data.to);
    } else {
      el.innerHTML = renderLineChart(days, data.to);
    }
  }

  function renderBarChart(days, max, today) {
    const w = 900, h = 190, padL = 44, padB = 26, padT = 10;
    const inner = w - padL - 12;
    const bw = inner / days.length;
    const y = (v) => h - padB - (v / max) * (h - padB - padT);
    let bars = '';
    days.forEach((d, i) => {
      const x = padL + i * bw + bw * 0.18;
      const bh = Math.max(d.minutes > 0 ? 2 : 0, h - padB - y(d.minutes));
      bars += `<rect class="bar${d.date === today ? ' is-today' : ''}" x="${x.toFixed(1)}" y="${(h - padB - bh).toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${bh.toFixed(1)}" rx="3"></rect>`;
      bars += `<text class="lbl" x="${(padL + i * bw + bw / 2).toFixed(1)}" y="${h - 8}" text-anchor="middle">${mdLabel(d.date)}</text>`;
      if (d.minutes > 0) {
        bars += `<text class="lbl" x="${(padL + i * bw + bw / 2).toFixed(1)}" y="${(y(d.minutes) - 5).toFixed(1)}" text-anchor="middle">${Math.round(d.minutes)}</text>`;
      }
    });
    const grid = [0, 0.5, 1].map((f) => {
      const yy = y(max * f);
      return `<line class="grid-line" x1="${padL}" y1="${yy.toFixed(1)}" x2="${w - 12}" y2="${yy.toFixed(1)}"></line>` +
        `<text class="lbl" x="${padL - 8}" y="${(yy + 3).toFixed(1)}" text-anchor="end">${Math.round(max * f)}</text>`;
    }).join('');
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      ${grid}
      <line class="axis" x1="${padL}" y1="${h - padB}" x2="${w - 12}" y2="${h - padB}"></line>
      ${bars}</svg>`;
  }

  function renderLineChart(days, today) {
    const w = 900, h = 190, padL = 44, padB = 26, padT = 10;
    const inner = w - padL - 12;
    const max = Math.max(1, ...days.map((d) => d.minutes));
    const x = (i) => padL + (i / Math.max(1, days.length - 1)) * inner;
    const y = (v) => h - padB - (v / max) * (h - padB - padT);
    const pts = days.map((d, i) => `${x(i).toFixed(1)},${y(d.minutes).toFixed(1)}`);
    const area = `M ${padL},${h - padB} L ${pts.join(' L ')} L ${(w - 12).toFixed(1)},${h - padB} Z`;
    const step = Math.ceil(days.length / 8);
    const labels = days.map((d, i) => (i % step === 0 || i === days.length - 1)
      ? `<text class="lbl" x="${x(i).toFixed(1)}" y="${h - 8}" text-anchor="middle">${mdLabel(d.date)}</text>` : '').join('');
    const dots = days.map((d, i) => (d.minutes > 0
      ? `<circle class="dot" cx="${x(i).toFixed(1)}" cy="${y(d.minutes).toFixed(1)}" r="${d.date === today ? 3.4 : 1.9}"></circle>` : '')).join('');
    const grid = [0, 0.5, 1].map((f) => {
      const yy = y(max * f);
      return `<line class="grid-line" x1="${padL}" y1="${yy.toFixed(1)}" x2="${w - 12}" y2="${yy.toFixed(1)}"></line>` +
        `<text class="lbl" x="${padL - 8}" y="${(yy + 3).toFixed(1)}" text-anchor="end">${Math.round(max * f)}</text>`;
    }).join('');
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      ${grid}
      <line class="axis" x1="${padL}" y1="${h - padB}" x2="${w - 12}" y2="${h - padB}"></line>
      <path class="area" d="${area}"></path>
      <polyline class="line" points="${pts.join(' ')}"></path>
      ${dots}${labels}</svg>`;
  }

  $$('#trendSeg .seg-item').forEach((b) => {
    b.addEventListener('click', () => {
      trendDays = Number(b.dataset.days);
      $$('#trendSeg .seg-item').forEach((x) => x.classList.toggle('is-active', x === b));
      refreshTrend();
    });
  });

  // ------------------------------------------------------------ 热力图
  function levelOf(min) {
    if (!min) return 0;
    if (min < 25) return 1;
    if (min < 60) return 2;
    if (min < 120) return 3;
    return 4;
  }

  async function refreshHeatmap() {
    heatCache = await call(api.heatmap(14));
    const todayKey = heatCache.to;
    if (!heatMonth) {
      heatMonth = { year: Number(todayKey.slice(0, 4)), month: Number(todayKey.slice(5, 7)) - 1 };
    }
    renderHeatmap();
  }

  function renderHeatmap() {
    if (!heatCache) return;
    const { year, month } = heatMonth;
    const first = new Date(year, month, 1);
    const startPad = (first.getDay() + 6) % 7; // 周一开头
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    $('heatTitle').textContent = `${year} 年 ${month + 1} 月`;

    const box = $('heatmap');
    box.innerHTML = '';
    for (let i = 0; i < startPad; i += 1) {
      const pad = document.createElement('div');
      pad.className = 'heat-day is-empty';
      box.appendChild(pad);
    }
    let monthTotal = 0;
    for (let d = 1; d <= daysInMonth; d += 1) {
      const p = (n) => String(n).padStart(2, '0');
      const key = `${year}-${p(month + 1)}-${p(d)}`;
      const minutes = heatCache.days[key] || 0;
      monthTotal += minutes;
      const cell = document.createElement('div');
      cell.className = 'heat-day';
      cell.dataset.lv = String(levelOf(minutes));
      if (key === heatCache.to) cell.classList.add('is-today');
      if (key === heatSel) cell.classList.add('is-sel');
      cell.title = `${key} 周${weekday(key)} · ${fmtMin(minutes)}` +
        (heatCache.sessions[key] ? ` · ${heatCache.sessions[key]} 段` : '');
      cell.addEventListener('click', () => showDayDetail(key));
      box.appendChild(cell);
    }
    $('heatTip').textContent = `本月合计 ${fmtMin(monthTotal)} · 点击某天查看标签构成`;
  }

  async function showDayDetail(key) {
    heatSel = key;
    renderHeatmap();
    const detail = await call(api.dayDetail(key));
    if (!detail.sessions.length) {
      $('heatDetail').innerHTML = `<b>${key}</b> 周${weekday(key)}：没有记录`;
      return;
    }
    const parts = detail.byTag
      .map((t) => `${escapeHtml(t.tag_name)} <b>${fmtMin(t.minutes)}</b>（${t.sessions}段）`)
      .join(' ｜ ');
    $('heatDetail').innerHTML =
      `<b>${key}</b> 周${weekday(key)} · 共 <b>${fmtMin(detail.totalMinutes)}</b> · ` +
      `${detail.sessions.length} 段：${parts}`;
  }

  $('heatPrev').addEventListener('click', () => {
    heatMonth.month -= 1;
    if (heatMonth.month < 0) { heatMonth.month = 11; heatMonth.year -= 1; }
    renderHeatmap();
  });
  $('heatNext').addEventListener('click', () => {
    heatMonth.month += 1;
    if (heatMonth.month > 11) { heatMonth.month = 0; heatMonth.year += 1; }
    renderHeatmap();
  });

  // ------------------------------------------------------------ 单标签历史
  async function openTagHistory(tag) {
    const data = await call(api.tagHistory(tag));
    historyMode = 'tag';
    history = { range: 'all', tag };
    $('histRange').value = 'all';
    $('histTag').value = tag;
    navigate('history');
    $('histTitle').textContent = `「${tag}」历史专注`;
    renderHistoryRows(data.rows, `「${tag}」累计 ${fmtMin(data.summary.minutes)} · ${data.summary.sessions} 段 · 单日峰值 ${fmtMin(Math.max(0, ...data.byDay.map((d) => d.minutes)))}`);
  }

  // ------------------------------------------------------------ 明细
  function fillHistoryTagSelect() {
    const sel = $('histTag');
    const cur = sel.value;
    sel.innerHTML = '<option value="">全部标签</option>';
    for (const t of currentTags) {
      const o = document.createElement('option');
      o.value = t.name;
      o.textContent = t.name;
      sel.appendChild(o);
    }
    sel.value = cur;
  }

  function rangeToDates(range) {
    if (range === 'all') return {};
    if (range === 'today') {
      const t = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const key = `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
      return { from: key, to: key };
    }
    const days = Number(range);
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - (days - 1));
    const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { from: key(from), to: key(to) };
  }

  function renderHistoryRows(rows, footText) {
    const tbody = $('histTable').querySelector('tbody');
    tbody.innerHTML = '';
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="muted">没有记录</td></tr>';
    }
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td>${r.date}</td>` +
        `<td><i class="tag-dot" style="background:${(currentTags.find((t) => t.name === r.tag_name) || {}).color || '#94a3b8'};display:inline-block;margin-right:6px"></i>${escapeHtml(r.tag_name)}</td>` +
        `<td>${hm(r.start_time)}</td><td>${hm(r.end_time)}</td>` +
        `<td>${Math.round(r.planned_minutes)}m</td>` +
        `<td><b>${r.actual_minutes}</b>m</td>` +
        `<td><span class="pill ${r.status}">${statusText(r.status)}</span></td>`;
      tbody.appendChild(tr);
    }
    $('histFoot').textContent = footText || `共 ${rows.length} 条`;
  }

  function statusText(s) {
    return { done: '已完成', ended_early: '提前结束', abandoned: '放弃', running: '进行中' }[s] || s;
  }

  async function refreshHistory() {
    // 单标签视图由 openTagHistory 自己渲染，避免这里异步覆盖掉它的累计说明（竞态）
    if (historyMode === 'tag') return;
    $('histTitle').textContent = '记录明细';
    const { from, to } = rangeToDates(history.range);
    const rows = await call(api.sessions({ ...(from ? { from, to } : {}), tag: history.tag || undefined, limit: 2000 }));
    const total = rows.reduce((a, r) => a + r.actual_minutes, 0);
    renderHistoryRows(rows, `共 ${rows.length} 条 · 合计 ${fmtMin(total)}`);
  }

  $('histRange').addEventListener('change', (e) => {
    historyMode = 'list';
    history.range = e.target.value;
    refreshHistory();
  });
  $('histTag').addEventListener('change', (e) => {
    historyMode = 'list';
    history.tag = e.target.value;
    refreshHistory();
  });

  // ------------------------------------------------------------ 导出
  async function doExport(filter) {
    const res = await call(api.exportCsv(filter || {}), { silent: true });
    if (res && res.ok) toast(`已导出 ${res.count} 条到 ${res.filePath}`, 'ok');
    else if (res && res.reason === 'empty') toast('没有可导出的记录', 'err');
    else if (res && res.reason === 'canceled') toast('已取消导出');
  }

  $('btnExport').addEventListener('click', () => doExport({}));
  $('btnExport2').addEventListener('click', () => {
    const { from, to } = rangeToDates(history.range);
    doExport({ ...(from ? { from, to } : {}), tag: history.tag || undefined });
  });
  $('btnRefresh').addEventListener('click', () => { refreshStats(); toast('已刷新'); });

  // ------------------------------------------------------------ 设置
  async function refreshSettings() {
    settings = await call(api.getSettings());
    const info = await call(api.appInfo());
    $('setFocus').value = settings.focusMinutes;
    $('setShort').value = settings.shortBreakMinutes;
    $('setLong').value = settings.longBreakMinutes;
    $('setLongEvery').value = settings.longBreakEvery;
    $('setAutoBreak').checked = settings.autoStartBreak !== false;
    $('setSound').checked = settings.soundEnabled !== false;
    $('setVolume').value = settings.soundVolume ?? 0.6;
    $('setNotify').checked = settings.notifyEnabled !== false;
    $('setTray').checked = settings.minimizeToTray !== false;
    $('setMiniTop').checked = settings.alwaysOnTopMini !== false;
    $('setPartial').checked = settings.includePartialInPomodoro === true;
    $$('input[name="abandon"]').forEach((r) => { r.checked = r.value === (settings.abandonedRule || 'counted'); });
    $('setScToggle').value = (info.shortcuts && info.shortcuts.toggle) || '';
    $('setScMini').value = (info.shortcuts && info.shortcuts.mini) || '';
    $('aboutBox').innerHTML =
      `版本 <b>${info.version}</b> · Electron <b>${info.electron}</b> · Node <b>${info.node}</b><br>` +
      `数据库：<b>${info.dbPath}</b><br>` +
      `平台：<b>${info.platform}</b>`;
  }

  $('btnSaveSettings').addEventListener('click', async () => {
    const patch = {
      focusMinutes: clampNum($('setFocus').value, 1, 180, 25),
      shortBreakMinutes: clampNum($('setShort').value, 0, 60, 5),
      longBreakMinutes: clampNum($('setLong').value, 0, 120, 15),
      longBreakEvery: clampNum($('setLongEvery').value, 0, 12, 4),
      autoStartBreak: $('setAutoBreak').checked,
      soundEnabled: $('setSound').checked,
      soundVolume: Number($('setVolume').value),
      notifyEnabled: $('setNotify').checked,
      minimizeToTray: $('setTray').checked,
      alwaysOnTopMini: $('setMiniTop').checked,
      includePartialInPomodoro: $('setPartial').checked,
      abandonedRule: ($$('input[name="abandon"]').find((r) => r.checked) || {}).value || 'counted',
    };
    settings = await call(api.saveSettings(patch));
    toast('设置已保存', 'ok');
    renderFocus(currentState);
    renderQuickTags();
    refreshStats();
  });

  $('btnSaveSc').addEventListener('click', async () => {
    settings = await call(api.saveSettings({
      shortcuts: { toggle: $('setScToggle').value.trim(), mini: $('setScMini').value.trim() },
    }));
    toast('快捷键已保存（若无效说明被系统或其它软件占用）', 'ok');
  });

  $('btnOpenFolder').addEventListener('click', async () => {
    const p = await call(api.openDataFolder());
    toast(`已在资源管理器中定位：${p}`);
  });

  function clampNum(v, min, max, dflt) {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, n));
  }

  // ------------------------------------------------------------ 主循环
  function applyState(payload) {
    currentState = payload;
    renderFocus(payload);
    renderSidebar(payload);
  }

  api.onState((payload) => {
    if (!payload) return;
    if (payload.settings) settings = payload.settings;
    applyState(payload);
  });

  api.onTick((s) => {
    if (!currentState) return;
    currentState = { ...currentState, timer: s };
    const ring = $('ringProgress');
    const progress = s.plannedMs ? Math.min(1, s.actualMs / s.plannedMs) : 0;
    ring.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE - RING_CIRCUMFERENCE * progress));
    $('ringTime').textContent = fmtClock(s.remainingMs);
    document.querySelector('.ring-wrap').classList.toggle('is-paused', s.phase === 'paused');
    if (s.phase === 'idle') renderFocus(currentState);
  });

  api.onFinished((payload) => {
    const r = payload && payload.record;
    if (r) toast(`「${r.tag_name}」${statusText(r.status)} · ${r.actual_minutes} 分钟`, 'ok');
  });

  api.onCue((payload) => playCue(payload && payload.kind));

  api.onNavigate((page) => navigate(page));
  api.onOpenPicker(() => {
    navigate('focus');
    if (currentState && currentState.timer.phase === 'idle') openPicker();
  });
  api.onSettings((next) => {
    settings = next;
    renderQuickTags();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('pickerMask').hidden) closePicker();
    if (e.key === 'Enter' && !$('pickerMask').hidden && !$('pickerStart').disabled) $('pickerStart').click();
    // 空格：开始/暂停（不在输入框内时）
    if (e.code === 'Space' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
      e.preventDefault();
      $('btnPrimary').click();
    }
  });

  // ------------------------------------------------------------ 启动
  (async function init() {
    const state = await call(api.getState());
    settings = state.settings;
    currentTags = state.tags;
    applyState({ timer: state.timer, overview: state.overview });
    renderQuickTags();
    fillHistoryTagSelect();
    // 首次进入若空闲，直接引导选标签
    if (state.timer.phase === 'idle') openPicker();
  })();
})();
