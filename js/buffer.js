/**
 * buffer.js — Tick buffer with timeframe aggregation
 * Stores raw 1-second resolution ticks in memory
 * Supports aggregation for: 1s / 5s / 15s / 30s / 60s
 */
'use strict';

window.TickBuffer = (() => {
  const MAX_TICKS = 10800; // 3 hours of 1s ticks

  // Raw ticks: [{time: unixSec, value: 0-100}]
  let _ticks = [];

  // Market boundary timestamps (for whitespace markers)
  let _marketBoundaries = [];

  function addTick(unixSec, valueCents) {
    if (typeof valueCents !== 'number' || isNaN(valueCents)) return;
    valueCents = Math.max(0, Math.min(100, valueCents));

    // Avoid duplicate timestamps — update existing instead
    const last = _ticks[_ticks.length - 1];
    if (last && last.time === unixSec) {
      last.value = valueCents;
    } else {
      _ticks.push({ time: unixSec, value: valueCents });
    }

    // Trim buffer
    if (_ticks.length > MAX_TICKS) {
      _ticks = _ticks.slice(_ticks.length - MAX_TICKS);
    }
  }

  /**
   * Aggregate raw ticks into timeframe buckets.
   * Uses "last value in bucket" strategy for line chart.
   * Returns array sorted ascending by time.
   */
  function aggregate(tfSeconds) {
    if (_ticks.length === 0) return [];
    if (tfSeconds === 1) return [..._ticks]; // no aggregation needed

    const buckets = new Map();
    for (const tick of _ticks) {
      const bt = Math.floor(tick.time / tfSeconds) * tfSeconds;
      buckets.set(bt, tick.value);
    }

    return Array.from(buckets.entries())
      .sort(([a], [b]) => a - b)
      .map(([time, value]) => ({ time, value }));
  }

  /**
   * Get the last N ticks for quick recent display
   */
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

  /**
   * Reset the buffer (called on new market or when starting fresh)
   * optionally keep existing data (keepHistory=true for rolling display)
   */
  function reset(keepHistory = false) {
    if (!keepHistory) {
      _ticks = [];
      _marketBoundaries = [];
    }
  }

  return {
    addTick,
    aggregate,
    getRecent,
    getLastTick,
    getCount,
    addMarketBoundary,
    getMarketBoundaries,
    reset,
  };
})();
