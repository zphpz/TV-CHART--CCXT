/**
 * price.js — Polymarket price normalization
 * Handles: bid/ask/mid/last_trade → effectivePrice (0-100¢)
 */
'use strict';

window.PriceEngine = (() => {
  // Internal state
  let _bid = null;
  let _ask = null;
  let _last = null;
  let _lastUpdateMs = 0;

  /**
   * Polymarket UI logic:
   * If spread > $0.10 AND last trade exists → show last trade
   * Otherwise → show midpoint
   */
  function effectivePrice() {
    if (_bid !== null && _ask !== null) {
      const spread = _ask - _bid;
      const mid = (_bid + _ask) / 2;
      if (spread > 0.10 && _last !== null) {
        return _last;
      }
      return mid;
    }
    if (_last !== null) return _last;
    return 0.50; // fallback: 50¢
  }

  function getMid() {
    if (_bid !== null && _ask !== null) return (_bid + _ask) / 2;
    if (_last !== null) return _last;
    return 0.50;
  }

  function getSpread() {
    if (_bid !== null && _ask !== null) return _ask - _bid;
    return null;
  }

  function toBid()  { return _bid; }
  function toAsk()  { return _ask; }
  function toLast() { return _last; }
  function getLastUpdateMs() { return _lastUpdateMs; }

  // Convert raw 0-1 value to display cents 0-100
  function toCents(raw) {
    const n = parseFloat(raw);
    if (isNaN(n)) return null;
    return Math.max(0, Math.min(100, n * 100));
  }

  function updateBidAsk(bid, ask) {
    const b = parseFloat(bid);
    const a = parseFloat(ask);
    if (!isNaN(b) && b >= 0) _bid = b;
    if (!isNaN(a) && a >= 0) _ask = a;
    _lastUpdateMs = Date.now();
  }

  function updateLastTrade(price) {
    const p = parseFloat(price);
    if (!isNaN(p) && p >= 0) {
      _last = p;
      _lastUpdateMs = Date.now();
    }
  }

  function reset() {
    _bid = null;
    _ask = null;
    _last = null;
    _lastUpdateMs = 0;
  }

  return {
    effectivePrice,
    getMid,
    getSpread,
    toBid,
    toAsk,
    toLast,
    toCents,
    updateBidAsk,
    updateLastTrade,
    getLastUpdateMs,
    reset,
  };
})();
