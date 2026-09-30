'use strict';
/* 迷你悬浮窗：只显示当前标签 + 剩余时间，并保留最小操作 */
(() => {
  const api = window.focusAPI;
  const $ = (id) => document.getElementById(id);
  const box = $('mini');

  function fmtClock(ms) {
    const total = Math.max(0, Math.round((ms || 0) / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  let last = null;

  function render(s) {
    if (!s) return;
    last = s;
    const isBreak = s.mode !== 'focus';
    box.classList.toggle('is-break', isBreak);
    box.classList.toggle('is-paused', s.phase === 'paused');

    const label = s.phase === 'idle'
      ? '空闲'
      : isBreak
        ? (s.mode === 'longBreak' ? '长休息' : '短休息')
        : (s.tag ? s.tag.name : '专注');
    $('tag').textContent = label;
    $('time').textContent = fmtClock(s.plannedMs ? s.remainingMs : (s.plannedMs || 25 * 60000));
    if (s.tag && s.tag.color) document.querySelector('.dot').style.background = s.tag.color;

    $('state').textContent = s.phase === 'paused' ? '已暂停' : s.phase === 'running' ? '' : '';

    const progress = s.plannedMs ? Math.min(1, s.actualMs / s.plannedMs) : 0;
    $('bar').style.width = `${(progress * 100).toFixed(1)}%`;

    $('btnToggle').textContent = s.phase === 'idle' ? '开始' : s.phase === 'running' ? '暂停' : '继续';
    $('btnFinish').disabled = s.phase === 'idle';
    $('btnFinish').style.opacity = s.phase === 'idle' ? 0.45 : 1;
  }

  $('btnToggle').addEventListener('click', async (e) => {
    e.stopPropagation();
    // 空闲时点击"开始"：交给主进程唤起主窗口并弹出标签选择
    if (!last || last.phase === 'idle') {
      await api.openPickerInMain();
      return;
    }
    await api.toggle();
  });

  $('btnFinish').addEventListener('click', async (e) => {
    e.stopPropagation();
    await api.finishEarly();
  });

  $('btnOpen').addEventListener('click', async (e) => {
    e.stopPropagation();
    await api.hideMini();
  });

  api.onTick((s) => render(s));
  api.onState((payload) => {
    if (payload && payload.timer) render(payload.timer);
  });

  (async () => {
    const state = await api.getState();
    if (state && state.ok) render(state.data.timer);
  })();
})();
