/**
 * buffer.js — High-performance tick buffer & aggregation engine v1.2
 * 
 * - Stores raw UP-token probability ticks (0–100¢)
 * - Dynamic aggregation for timeframes (1s / 5s / 15s / 30s / 60s)
 * - Real-time outcome inversion (DOWN = 100 - UP) on demand
 */
'use strict';

window.TickBuffer = (() => {
  const MAX_TICKS = 500000; // Large capacity for multi-day history

  // Internal storage: always stores UP-token price in cents (0.0–100.0)
  let _ticks = []; // [{ time: unixSec, value: number }]
  let _marketBoundaries = [];

  function addTick(unixSec, rawUpCents) {
    if (typeof unixSec !== 'number' || typeof rawUpCents !== 'number' || isNaN(rawUpCents)) return;
    rawUpCents = Math.max(0, Math.min(100, rawUpCents));

    const last = _ticks[_ticks.length - 1];
    if (last && last.time === unixSec) {
      last.value = rawUpCents;
    } else if (!last || unixSec > last.time) {
      _ticks.push({ time: unixSec, value: rawUpCents });
    } else {
      _ticks.push({ time: unixSec, value: rawUpCents });
      _ticks.sort((a, b) => a.time - b.time);
    }

    if (_ticks.length > MAX_TICKS) {
      _ticks = _ticks.slice(_ticks.length - MAX_TICKS);
    }
  }

  function addBulk(items) {
    if (!Array.isArray(items) || items.length === 0) return;
    const map = new Map();
    for (const t of _ticks) map.set(t.time, t.value);
    for (const pt of items) {
      const time = Array.isArray(pt) ? pt[0] : (pt.time || pt.t);
      const val  = Array.isArray(pt) ? pt[1] : (pt.value || pt.v);
      if (typeof time === 'number' && typeof val === 'number' && !isNaN(val)) {
        map.set(time, Math.max(0, Math.min(100, val)));
      }
    }
    _ticks = Array.from(map.entries())
      .sort(([a], [b]) => a - b)
      .map(([time, value]) => ({ time, value }));

    if (_ticks.length > MAX_TICKS) {
      _ticks = _ticks.slice(_ticks.length - MAX_TICKS);
    }
  }

  /**
   * Aggregate raw ticks into timeframe buckets with outcome transformation.
   * Strictly deduplicates and sorts timestamps for Lightweight Charts v5.
   * @param {number} tfSeconds - 1, 5, 15, 30, 60
   * @param {string} outcomeMode - 'up' | 'down'
   */
  function aggregate(tfSeconds, outcomeMode = 'up') {
    if (_ticks.length === 0) return [];

    const invert = outcomeMode === 'down';
    const tf = Math.max(1, tfSeconds || 1);

    const buckets = new Map();
    for (const tick of _ticks) {
      const bt = tf === 1 ? tick.time : Math.floor(tick.time / tf) * tf;
      const v = invert ? (100 - tick.value) : tick.value;
      buckets.set(bt, v);
    }

    return Array.from(buckets.entries())
      .sort(([a], [b]) => a - b)
      .map(([time, value]) => ({ time, value }));
  }

  function getRawTicks() {
    return [..._ticks];
  }

  function getRecent(count) {
    return _ticks.slice(-count);
  }

  function getLastTick() {
    return _ticks[_ticks.length - 1] || null;
  }

  function getCount() {
    return _ticks.length;
  }

  function addMarketBoundary(unixSec) {
    _marketBoundaries.push(unixSec);
  }

  function getMarketBoundaries() {
    return [..._marketBoundaries];
  }

  function reset(keepHistory = false) {
    if (!keepHistory) {
      _ticks = [];
      _marketBoundaries = [];
    }
  }

  return {
    addTick,
    addBulk,
    aggregate,
    getRawTicks,
    getRecent,
    getLastTick,
    getCount,
    addMarketBoundary,
    getMarketBoundaries,
    reset,
  };
})();
