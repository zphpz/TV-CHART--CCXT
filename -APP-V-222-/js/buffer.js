/**
 * buffer.js — High-performance tick buffer & aggregation engine v4.3
 * 
 * Features & Optimizations in v4.3:
 * - High-speed in-memory ring buffer with automatic pruning (pruneOld)
 * - Dynamic aggregation for timeframes (1s / 5s / 15s / 30s / 60s)
 * - Real-time outcome inversion (DOWN = 100 - UP) on demand
 * - Stores raw UP-token probability ticks (0–100¢)
 */
'use strict';

window.TickBuffer = (() => {
  const MAX_TICKS = 100000; // Capacity for multiple sessions

  // Internal storage: always stores UP-token price in cents (0.0–100.0)
  let _ticks = []; // [{ time: unixSec, value: number }]
  let _marketBoundaries = [];

  function addTick(unixSec, rawUpCents) {
    if (typeof unixSec !== 'number' || typeof rawUpCents !== 'number' || isNaN(rawUpCents)) return;
    rawUpCents = Math.max(0, Math.min(100, rawUpCents));

    const len = _ticks.length;
    if (len > 0 && _ticks[len - 1].time === unixSec) {
      _ticks[len - 1].value = rawUpCents;
    } else if (len === 0 || unixSec > _ticks[len - 1].time) {
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
    for (let i = 0; i < _ticks.length; i++) {
      map.set(_ticks[i].time, _ticks[i].value);
    }
    for (let i = 0; i < items.length; i++) {
      const pt = items[i];
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
   */
  function aggregate(tfSeconds, outcomeMode = 'up') {
    if (_ticks.length === 0) return [];

    const invert = outcomeMode === 'down';
    const tf = Math.max(1, tfSeconds || 1);

    const buckets = new Map();
    for (let i = 0; i < _ticks.length; i++) {
      const tick = _ticks[i];
      const bt = tf === 1 ? tick.time : Math.floor(tick.time / tf) * tf;
      const v = invert ? (100 - tick.value) : tick.value;
      buckets.set(bt, v);
    }

    return Array.from(buckets.entries())
      .sort(([a], [b]) => a - b)
      .map(([time, value]) => ({ time, value }));
  }

  function pruneOld(cutoffTs) {
    if (!cutoffTs) return;
    _ticks = _ticks.filter(t => t.time >= cutoffTs);
    _marketBoundaries = _marketBoundaries.filter(t => t >= cutoffTs);
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

  function reset(keepBoundaries = false) {
    _ticks = [];
    if (!keepBoundaries) _marketBoundaries = [];
  }

  return {
    addTick,
    addBulk,
    aggregate,
    pruneOld,
    getRawTicks,
    getRecent,
    getLastTick,
    getCount,
    addMarketBoundary,
    getMarketBoundaries,
    reset,
  };
})();
