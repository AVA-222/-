'use strict';

const { EventEmitter } = require('node:events');
const { stamp, dayKey, round2 } = require('./db');

/**
 * 专注计时核心。
 *
 * 只统计"真正在跑"的时间：暂停时结算 accumulatedMs，恢复时重置 runStartedAt。
 * 因此 actual = accumulatedMs + (now - runStartedAt)（仅在 running 时）。
 *
 * 状态机：idle -> running <-> paused -> idle
 * 结束状态：done(自然走完) / ended_early(提前结束且有实际投入) / abandoned(无实际投入)
 */
class Timer extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    /**
     * 低于此实际投入时长的结束视为"放弃"而非"提前结束"，避免误点造成无意义的记录。
     * 15 秒以内基本可以认定是误操作；真正的"放弃"按钮走 abandon() 独立路径。
     */
    this.minBillableMs = 15_000;
    this.reset();
  }

  reset() {
    this.phase = 'idle'; // idle | running | paused
    this.mode = 'focus'; // focus | shortBreak | longBreak
    this.tag = null;
    this.plannedMs = 0;
    this.accumulatedMs = 0;
    this.runStartedAt = null;
    this.startedAt = null;
    this.remainingAtPause = null;
    this.sessionStartStamp = null;
  }

  snapshot() {
    const running = this.phase === 'running';
    const actualMs = this.accumulatedMs + (running ? Date.now() - this.runStartedAt : 0);
    const remainingMs =
      this.phase === 'idle'
        ? Math.max(0, this.plannedMs || this.defaultFocusMs())
        : Math.max(0, this.plannedMs - actualMs);
    return {
      phase: this.phase,
      mode: this.mode,
      tag: this.tag,
      plannedMs: this.plannedMs || this.defaultFocusMs(),
      remainingMs,
      actualMs,
      startedAt: this.startedAt ? stamp(this.startedAt) : null,
      sessionStartStamp: this.sessionStartStamp,
      progress: this.plannedMs ? Math.min(1, actualMs / this.plannedMs) : 0,
    };
  }

  defaultFocusMs() {
    return (this.store.getSettings().focusMinutes || 25) * 60_000;
  }

  /** 开始一段新的专注；必须先有标签 */
  startFocus(tagName, plannedMinutes) {
    if (this.phase !== 'idle') throw new Error('已有进行中的计时，请先结束');
    const tag = this.store.ensureTag(tagName);
    const minutes = Number(plannedMinutes) > 0 ? Number(plannedMinutes) : this.store.getSettings().focusMinutes;
    const now = Date.now();
    this.phase = 'running';
    this.mode = 'focus';
    this.tag = tag;
    this.plannedMs = minutes * 60_000;
    this.accumulatedMs = 0;
    this.runStartedAt = now;
    this.startedAt = now;
    this.sessionStartStamp = stamp(now);
    this.emit('tick', this.snapshot());
    return this.snapshot();
  }

  /** 休息计时（休息不入库，只做提醒） */
  startBreak(kind, minutes) {
    if (this.phase !== 'idle') throw new Error('已有进行中的计时，请先结束');
    const now = Date.now();
    this.phase = 'running';
    this.mode = kind === 'longBreak' ? 'longBreak' : 'shortBreak';
    this.tag = null;
    this.plannedMs = minutes * 60_000;
    this.accumulatedMs = 0;
    this.runStartedAt = now;
    this.startedAt = now;
    this.sessionStartStamp = stamp(now);
    this.emit('tick', this.snapshot());
    return this.snapshot();
  }

  pause() {
    if (this.phase !== 'running') throw new Error('当前不在计时中');
    this.accumulatedMs += Date.now() - this.runStartedAt;
    this.runStartedAt = null;
    this.phase = 'paused';
    this.emit('tick', this.snapshot());
    return this.snapshot();
  }

  resume() {
    if (this.phase !== 'paused') throw new Error('当前不在暂停中');
    this.runStartedAt = Date.now();
    this.phase = 'running';
    this.emit('tick', this.snapshot());
    return this.snapshot();
  }

  toggle() {
    if (this.phase === 'running') return this.pause();
    if (this.phase === 'paused') return this.resume();
    return null;
  }

  /**
   * 结束当前计时并落库。
   * @param {'done'|'ended_early'|'abandoned'} reason
   */
  stop(reason) {
    if (this.phase === 'idle') return null;
    const s = this.snapshot();
    const wasFocus = this.mode === 'focus';
    const actualMs = this.phase === 'running'
      ? this.accumulatedMs + (Date.now() - this.runStartedAt)
      : this.accumulatedMs;
    const endStamp = stamp(Date.now());
    const startStamp = this.sessionStartStamp;

    let record = null;
    if (wasFocus) {
      const actualMinutes = round2(actualMs / 60_000);
      let status = reason;
      if (!status) status = s.remainingMs <= 0 ? 'done' : 'ended_early';
      if (status === 'ended_early' && actualMs < this.minBillableMs) status = 'abandoned';
      record = this.store.insertSession({
        tag_name: this.tag.name,
        start_time: startStamp,
        end_time: endStamp,
        planned_minutes: round2(this.plannedMs / 60_000),
        actual_minutes: actualMinutes,
        status,
        date: dayKey(this.startedAt),
        ended_early: status === 'ended_early',
      });
    }

    const finishedMode = this.mode;
    const result = {
      record,
      wasFocus,
      mode: finishedMode,
      plannedMs: this.plannedMs,
      actualMs,
      startStamp,
      endStamp,
      natural: s.remainingMs <= 0,
    };
    this.reset();
    this.emit('finished', result);
    this.emit('tick', this.snapshot());
    return result;
  }

  /** 每秒调用：到点自动结束 */
  checkExpiry() {
    if (this.phase !== 'running') return null;
    const s = this.snapshot();
    if (s.remainingMs <= 0) return this.stop('done');
    return null;
  }
}

module.exports = { Timer };
