/**
 * market.js — Polymarket market discovery & rollover scheduler
 * 
 * Responsibilities:
 * - Compute current rolling market slug from timestamp
 * - Fetch market metadata from Gamma API
 * - Parse clobTokenIds / outcomes (JSON strings!)
 * - Schedule rollover at market boundary (pre-fetch + switch)
 */
'use strict';

window.MarketManager = (() => {
  const GAMMA_BASE  = 'https://gamma-api.polymarket.com';
  const CLOB_BASE   = 'https://clob.polymarket.com';

  // Current state
  let _currentMarket = null;   // { slug, upTokenId, downTokenId, startTs, endTs }
  let _nextMarket    = null;   // preloaded next market
  let _rolloverTimer = null;
  let _prefetchTimer = null;
  let _onSwitchCb    = null;   // callback when market switches
  let _marketTf      = 5;      // 5 or 15 minutes

  // ─── Slug calculation ──────────────────────────────────────────────
  function _intervalSec(tfMinutes) {
    return tfMinutes * 60; // 300 or 900
  }

  function _getWindowTs(tfMinutes, now) {
    const interval = _intervalSec(tfMinutes);
    const nowSec = Math.floor((now || Date.now()) / 1000);
    return Math.floor(nowSec / interval) * interval;
  }

  function makeSlug(tfMinutes, windowTs) {
    return `btc-updown-${tfMinutes}m-${windowTs}`;
  }

  function getCurrentSlug(tfMinutes) {
    return makeSlug(tfMinutes, _getWindowTs(tfMinutes));
  }

  function getNextSlug(tfMinutes) {
    const cur = _getWindowTs(tfMinutes);
    return makeSlug(tfMinutes, cur + _intervalSec(tfMinutes));
  }

  // ─── Gamma API fetch ───────────────────────────────────────────────
  async function _fetchWithRetry(url, retries = 3, delayMs = 800) {
    let lastErr;
    for (let i = 0; i < retries; i++) {
      try {
        const resp = await fetch(url, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'PM-Chart/1.0',
          },
        });
        if (resp.ok) {
          return await resp.json();
        }
        if (resp.status === 404) return null;           // market doesn't exist yet
        if (resp.status === 429) {
          await _sleep(delayMs * Math.pow(2, i));
          continue;
        }
        throw new Error(`HTTP ${resp.status}`);
      } catch (e) {
        lastErr = e;
        if (i < retries - 1) await _sleep(delayMs * Math.pow(2, i));
      }
    }
    console.warn('[MarketManager] fetchWithRetry failed:', url, lastErr);
    return null;
  }

  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /**
   * Fetch market metadata from Gamma API.
   * Returns { upTokenId, downTokenId, startTs, endTs, slug } or null
   */
  async function fetchMarketData(slug) {
    // Try /events/slug/ first
    let data = await _fetchWithRetry(`${GAMMA_BASE}/events/slug/${slug}`);
    
    // Fallback: try /events?slug=
    if (!data) {
      const arr = await _fetchWithRetry(`${GAMMA_BASE}/events?slug=${encodeURIComponent(slug)}&limit=1`);
      if (Array.isArray(arr) && arr.length > 0) data = arr[0];
      else if (arr && arr.id) data = arr;
    }

    if (!data) return null;

    // The event has markets[]
    const markets = data.markets || [];
    if (markets.length === 0) return null;
    const market = markets[0];

    // Parse JSON strings (CRITICAL: these are JSON strings, not arrays!)
    let tokenIds, outcomes;
    try {
      tokenIds = typeof market.clobTokenIds === 'string'
        ? JSON.parse(market.clobTokenIds)
        : market.clobTokenIds;
      outcomes = typeof market.outcomes === 'string'
        ? JSON.parse(market.outcomes)
        : market.outcomes;
    } catch (e) {
      console.error('[MarketManager] Failed to parse clobTokenIds/outcomes:', e);
      return null;
    }

    if (!Array.isArray(tokenIds) || tokenIds.length < 2) return null;

    // Map "Up" outcome to correct token index (don't hardcode index 0!)
    const upIdx = outcomes.findIndex(o => /^up$/i.test(String(o).trim()) || /^yes$/i.test(String(o).trim()));
    const upTokenId   = tokenIds[upIdx !== -1 ? upIdx : 0];
    const downTokenId = tokenIds[upIdx !== -1 ? (upIdx === 0 ? 1 : 0) : 1];

    if (!upTokenId) return null;

    // Parse timestamps
    // IMPORTANT: Extract startTs from slug itself (btc-updown-5m-{TIMESTAMP})
    // The event-level startDate can be for the whole series, not this 5m window
    let startTs = null;
    const slugMatch = slug.match(/(\d+)$/);
    if (slugMatch) startTs = parseInt(slugMatch[1], 10);
    
    // endTs = start + duration
    const tf = slug.includes('-15m-') ? 900 : 300;
    const endTs = startTs ? startTs + tf : _parseTs(data.endDate || market.endDate || null);

    return {
      slug,
      upTokenId,
      downTokenId,
      startTs,
      endTs,
      conditionId: market.conditionId || null,
    };
  }

  function _parseTs(val) {
    if (!val) return null;
    if (typeof val === 'number') return val > 10_000_000_000 ? Math.floor(val / 1000) : val;
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
  }

  // ─── Fetch initial midpoint from CLOB REST ─────────────────────────
  async function fetchMidpoint(tokenId) {
    if (!tokenId) return null;
    let data = await _fetchWithRetry(`${CLOB_BASE}/midpoint?token_id=${tokenId}`, 2);
    if (data && data.mid) {
      const mid = parseFloat(data.mid);
      if (!isNaN(mid) && mid > 0) return mid;
    }
    
    // Fallback: query CLOB orderbook REST endpoint
    const book = await _fetchWithRetry(`${CLOB_BASE}/book?token_id=${tokenId}`, 2);
    if (book && Array.isArray(book.bids) && Array.isArray(book.asks) && book.bids.length > 0 && book.asks.length > 0) {
      const bestBid = parseFloat(book.bids[book.bids.length - 1].price);
      const bestAsk = parseFloat(book.asks[book.asks.length - 1].price);
      if (!isNaN(bestBid) && !isNaN(bestAsk)) {
        return (bestBid + bestAsk) / 2;
      }
    }
    return null;
  }

  // ─── Market initialization ─────────────────────────────────────────
  /**
   * Find and load the current active market for given TF.
   * Tries current window and surrounding candidate windows.
   * Returns market data or null.
   */
  async function loadCurrentMarket(tfMinutes) {
    _marketTf = tfMinutes;
    const interval = _intervalSec(tfMinutes);
    const nowSec = Math.floor(Date.now() / 1000);
    const curTs = Math.floor(nowSec / interval) * interval;
    
    const candidateTimestamps = [
      curTs,
      curTs + interval,
      curTs - interval,
      curTs + 2 * interval,
      curTs - 2 * interval,
    ];

    let fallbackMarket = null;

    for (const ts of candidateTimestamps) {
      const slug = makeSlug(tfMinutes, ts);
      console.log('[MarketManager] Trying slug:', slug);
      const md = await fetchMarketData(slug);
      if (!md) continue;

      if (!fallbackMarket || (md.endTs && md.endTs > (fallbackMarket.endTs || 0))) {
        fallbackMarket = md;
      }

      if (md.endTs && md.endTs >= nowSec - 30) {
        console.log('[MarketManager] Found active market:', md.slug);
        return md;
      }
    }

    if (fallbackMarket) {
      console.warn('[MarketManager] Using fallback market:', fallbackMarket.slug);
      return fallbackMarket;
    }

    return null;
  }

  // ─── Rollover scheduler ────────────────────────────────────────────
  /**
   * Schedule the rollover for the current market.
   * - 20s before endTs: start pre-fetching next market
   * - At endTs: switch to next market
   */
  function scheduleRollover(market, onSwitch) {
    if (!market || !market.endTs) return;
    _onSwitchCb = onSwitch;
    
    clearTimeout(_rolloverTimer);
    clearTimeout(_prefetchTimer);
    _nextMarket = null;

    const nowMs = Date.now();
    const endMs = market.endTs * 1000;
    const msUntilEnd = endMs - nowMs;

    // Pre-fetch 20 seconds before end
    const prefetchDelay = Math.max(0, msUntilEnd - 20000);

    console.log(`[MarketManager] Market ends in ${Math.round(msUntilEnd / 1000)}s`);
    console.log(`[MarketManager] Will pre-fetch next in ${Math.round(prefetchDelay / 1000)}s`);

    _prefetchTimer = setTimeout(() => {
      _prefetchNextMarket(market);
    }, prefetchDelay);

    // Switch at endTs
    _rolloverTimer = setTimeout(() => {
      _doRollover();
    }, Math.max(0, msUntilEnd));
  }

  async function _prefetchNextMarket(currentMarket) {
    const interval = _intervalSec(_marketTf);
    const nextSlug = makeSlug(_marketTf, currentMarket.endTs);

    console.log('[MarketManager] Pre-fetching next market:', nextSlug);

    // Retry up to 20 times with 1s interval
    for (let i = 0; i < 20; i++) {
      const md = await fetchMarketData(nextSlug);
      if (md) {
        _nextMarket = md;
        console.log('[MarketManager] Next market ready:', md.slug);
        return;
      }
      await _sleep(1000);
    }
    console.warn('[MarketManager] Could not prefetch next market');
  }

  async function _doRollover() {
    console.log('[MarketManager] Rolling over to next market...');
    
    // If we already have next market prefetched, use it
    let next = _nextMarket;

    // If not prefetched, try to load it now
    if (!next) {
      const interval = _intervalSec(_marketTf);
      const nextTs = _currentMarket ? _currentMarket.endTs : _getWindowTs(_marketTf) + interval;
      const nextSlug = makeSlug(_marketTf, nextTs);
      
      for (let i = 0; i < 10; i++) {
        next = await fetchMarketData(nextSlug);
        if (next) break;
        await _sleep(1000);
      }
    }

    if (!next) {
      // Fallback: reload current timeframe
      next = await loadCurrentMarket(_marketTf);
    }

    if (next) {
      const prev = _currentMarket;
      _currentMarket = next;
      _nextMarket = null;

      if (_onSwitchCb) {
        _onSwitchCb(next, prev);
      }

      // Schedule next rollover
      scheduleRollover(next, _onSwitchCb);
    } else {
      console.error('[MarketManager] Rollover failed: no next market found');
      // Retry in 5 seconds
      setTimeout(_doRollover, 5000);
    }
  }

  // ─── Public API ────────────────────────────────────────────────────
  function setCurrentMarket(market) {
    _currentMarket = market;
  }

  function getCurrentMarket() { return _currentMarket; }
  function getNextMarket()    { return _nextMarket; }
  function getMarketTf()      { return _marketTf; }

  /**
   * Get seconds remaining until market end
   */
  function getSecondsRemaining() {
    if (!_currentMarket || !_currentMarket.endTs) return null;
    return Math.max(0, _currentMarket.endTs - Math.floor(Date.now() / 1000));
  }

  return {
    makeSlug,
    getCurrentSlug,
    getNextSlug,
    fetchMarketData,
    fetchMidpoint,
    loadCurrentMarket,
    scheduleRollover,
    setCurrentMarket,
    getCurrentMarket,
    getNextMarket,
    getMarketTf,
    getSecondsRemaining,
  };
})();
