/**
 * buffer.js — Tick buffer with timeframe aggregation v1.1
 *
 * Changes v1.1:
 * - Stores raw UP-token price ticks (0–100¢ based on Up token)
 * - aggregate() now accepts outcomeMode ('up'|'down') to invert on-the-fly
 * - getRawTicks() exposes raw data for re-rendering on mode switch
 */
'use strict';

window.TickBuffer = (() => {
  const MAX_TICKS = 10800; // 3 hours of 1s ticks

  // Raw ticks always store UP-token price in cents (0–100)
  // Inversion for DOWN mode is applied only at read time
  let _ticks = []; // [{time: unixSec, value: number 0-100}]

  let _marketBoundaries = [];

  function addTick(unixSec, valueCents) {
    // NOTE: valueCents here is the DISPLAY value (already inverted if DOWN mode)
    // We store it as-is; the app passes the correct display value
    if (typeof valueCents !== 'number' || isNaN(valueCents)) return;
    valueCents = Math.max(0, Math.min(100, valueCents));

    const last = _ticks[_ticks.length - 1];
    if (last && last.time === unixSec) {
      last.value = valueCents;
    } else {
      _ticks.push({ time: unixSec, value: valueCents });
    }

    if (_ticks.length > MAX_TICKS) {
      _ticks = _ticks.slice(_ticks.length - MAX_TICKS);
    }
  }

  /**
   * Aggregate raw ticks into timeframe buckets.
   * outcomeMode: 'up' | 'down' — if 'down', inverts value = 100 - value
   * (for mode switches without re-fetching; values stored are always 'up' display)
   */
  function aggregate(tfSeconds, outcomeMode) {
    if (_ticks.length === 0) return [];

    const invert = outcomeMode === 'down';

    if (tfSeconds === 1) {
      if (!invert) return [..._ticks];
      return _ticks.map(t => ({ time: t.time, value: 100 - t.value }));
    }

    const buckets = new Map();
    for (const tick of _ticks) {
      const bt = Math.floor(tick.time / tfSeconds) * tfSeconds;
      const v = invert ? 100 - tick.value : tick.value;
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

  function getCount() { return _ticks.length; }

  function addMarketBoundary(unixSec) {
    _marketBoundaries.push(unixSec);
  }

  function getMarketBoundaries() { return [..._marketBoundaries]; }

  function reset(keepHistory = false) {
    if (!keepHistory) {
      _ticks = [];
      _marketBoundaries = [];
    }
  }

  return {
    addTick,
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
