/**
 * market.js — Polymarket market discovery & rollover scheduler v1.5
 * 
 * Responsibilities:
 * - Compute current rolling market slug from timestamp
 * - Fetch market metadata from Gamma API (with direct & CORS-proxy fallback)
 * - Accurately parse clobTokenIds / outcomes (Up vs Down)
 * - Schedule seamless rollover at market boundary (pre-fetch + switch)
 * - Guard against stale or expired markets
 */
'use strict';

window.MarketManager = (() => {
  const GAMMA_BASE = 'https://gamma-api.polymarket.com';
  const CLOB_BASE  = 'https://clob.polymarket.com';

  let _currentMarket = null; // { slug, upTokenId, downTokenId, startTs, endTs, conditionId }
  let _nextMarket    = null; // prefetched next market
  let _rolloverTimer = null;
  let _prefetchTimer = null;
  let _onSwitchCb    = null;
  let _marketTf      = 5;    // 5 or 15 minutes
  let _isRollingOver = false;

  // ─── Slug Calculations ──────────────────────────────────────────────
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

  // ─── Gamma API Fetch with CORS Fallback ─────────────────────────────
  async function _fetchWithRetry(url, retries = 3, delayMs = 600) {
    let lastErr;
    for (let i = 0; i < retries; i++) {
      try {
        const resp = await fetch(url, {
          headers: { 'Accept': 'application/json' },
        });
        if (resp.ok) {
          return await resp.json();
        }
        if (resp.status === 404) return null;
        if (resp.status === 429) {
          await _sleep(delayMs * Math.pow(1.5, i));
          continue;
        }
        throw new Error(`HTTP ${resp.status}`);
      } catch (e) {
        lastErr = e;
        // If file:/// or network failure, try public CORS proxies
        if (window.location.protocol === 'file:' || i === retries - 1) {
          try {
            const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
            const pResp = await fetch(proxyUrl);
            if (pResp.ok) return await pResp.json();
          } catch {}
        }
        if (i < retries - 1) await _sleep(delayMs * Math.pow(1.5, i));
      }
    }
    console.warn('[MarketManager] fetchWithRetry failed:', url, lastErr);
    return null;
  }

  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /**
   * Fetch market metadata from Gamma API.
   * Returns { slug, upTokenId, downTokenId, startTs, endTs, conditionId } or null
   */
  async function fetchMarketData(slug) {
    // 1. Try /events/slug/{slug}
    let data = await _fetchWithRetry(`${GAMMA_BASE}/events/slug/${slug}`);

    // 2. Fallback: try /events?slug={slug}
    if (!data) {
      const arr = await _fetchWithRetry(`${GAMMA_BASE}/events?slug=${encodeURIComponent(slug)}&limit=1`);
      if (Array.isArray(arr) && arr.length > 0) data = arr[0];
      else if (arr && arr.id) data = arr;
    }

    if (!data) return null;

    const markets = data.markets || [];
    if (markets.length === 0) return null;
    const market = markets[0];

    // Parse JSON string token IDs and outcomes
    let tokenIds, outcomes;
    try {
      tokenIds = typeof market.clobTokenIds === 'string'
        ? JSON.parse(market.clobTokenIds)
        : market.clobTokenIds;
      outcomes = typeof market.outcomes === 'string'
        ? JSON.parse(market.outcomes)
        : market.outcomes;
    } catch (e) {
      console.error('[MarketManager] Failed to parse tokenIds/outcomes:', e);
      return null;
    }

    if (!Array.isArray(tokenIds) || tokenIds.length < 2) return null;

    // Map "Up" outcome to correct token index
    const upIdx = Array.isArray(outcomes)
      ? outcomes.findIndex(o => /^up$/i.test(String(o).trim()) || /^yes$/i.test(String(o).trim()))
      : 0;

    const upTokenId   = tokenIds[upIdx !== -1 ? upIdx : 0];
    const downTokenId = tokenIds[upIdx !== -1 ? (upIdx === 0 ? 1 : 0) : 1];

    if (!upTokenId) return null;

    // Derive startTs from slug timestamp
    let startTs = null;
    const slugMatch = slug.match(/(\d+)$/);
    if (slugMatch) startTs = parseInt(slugMatch[1], 10);

    const tfSec = slug.includes('-15m-') ? 900 : 300;
    const endTs = startTs ? (startTs + tfSec) : _parseTs(data.endDate || market.endDate || null);

    return {
      slug,
      upTokenId,
      downTokenId,
      startTs,
      endTs,
      conditionId: market.conditionId || null,
      question: market.question || data.title || '',
      eventMetadata: data.eventMetadata || market.eventMetadata || null,
    };
  }

  function _parseTs(val) {
    if (!val) return null;
    if (typeof val === 'number') return val > 10_000_000_000 ? Math.floor(val / 1000) : val;
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
  }

  async function fetchMidpoint(tokenId) {
    const data = await _fetchWithRetry(`${CLOB_BASE}/midpoint?token_id=${tokenId}`, 2);
    if (!data) return null;
    const mid = parseFloat(data.mid);
    return isNaN(mid) ? null : mid;
  }

  // ─── Market Initialization & Active Search ─────────────────────────
  async function loadCurrentMarket(tfMinutes) {
    _marketTf = tfMinutes;
    const interval = _intervalSec(tfMinutes);
    const nowSec = Math.floor(Date.now() / 1000);

    const candidates = [
      _getWindowTs(tfMinutes),
      _getWindowTs(tfMinutes) + interval,
      _getWindowTs(tfMinutes) - interval,
    ];

    for (const ts of candidates) {
      const slug = makeSlug(tfMinutes, ts);
      const md = await fetchMarketData(slug);
      if (!md) continue;

      if (md.endTs && md.endTs <= nowSec) continue;

      console.log('[MarketManager] Active market selected:', md.slug, 'ends in:', md.endTs - nowSec, 's');
      return md;
    }

    console.warn('[MarketManager] Searching active markets via Gamma search');
    const arr = await _fetchWithRetry(
      `${GAMMA_BASE}/events?slug_contains=btc-updown-${tfMinutes}m&active=true&closed=false&limit=10`
    );

    if (Array.isArray(arr) && arr.length > 0) {
      const activeEvents = arr
        .map(e => {
          const match = (e.slug || '').match(/(\d+)$/);
          const startTs = match ? parseInt(match[1], 10) : _parseTs(e.startDate);
          const endTs = startTs ? startTs + interval : _parseTs(e.endDate);
          return { slug: e.slug, startTs, endTs };
        })
        .filter(e => e.endTs && e.endTs > nowSec)
        .sort((a, b) => a.endTs - b.endTs);

      if (activeEvents.length > 0) {
        return await fetchMarketData(activeEvents[0].slug);
      }
    }

    return null;
  }

  // ─── Rollover Scheduler ────────────────────────────────────────────
  function scheduleRollover(market, onSwitch) {
    if (!market || !market.endTs) return;
    _onSwitchCb = onSwitch;

    clearTimeout(_rolloverTimer);
    clearTimeout(_prefetchTimer);
    _nextMarket = null;

    const nowMs = Date.now();
    const endMs = market.endTs * 1000;
    const msUntilEnd = endMs - nowMs;

    const prefetchDelay = Math.max(0, msUntilEnd - 25000);

    console.log(`[MarketManager] Scheduled rollover in ${Math.round(msUntilEnd / 1000)}s (pre-fetch in ${Math.round(prefetchDelay / 1000)}s)`);

    _prefetchTimer = setTimeout(() => {
      _prefetchNextMarket(market);
    }, prefetchDelay);

    _rolloverTimer = setTimeout(() => {
      _doRollover();
    }, Math.max(200, msUntilEnd));
  }

  async function _prefetchNextMarket(currentMarket) {
    const interval = _intervalSec(_marketTf);
    const nextSlug = makeSlug(_marketTf, currentMarket.endTs);

    console.log('[MarketManager] Pre-fetching next market:', nextSlug);

    for (let i = 0; i < 25; i++) {
      const md = await fetchMarketData(nextSlug);
      if (md) {
        _nextMarket = md;
        console.log('[MarketManager] Next market pre-fetched successfully:', md.slug);
        return;
      }
      await _sleep(1000);
    }
    console.warn('[MarketManager] Could not pre-fetch next market in advance');
  }

  async function _doRollover() {
    if (_isRollingOver) return;
    _isRollingOver = true;

    try {
      console.log('[MarketManager] Rolling over to new market slot...');

      let next = _nextMarket;

      if (!next) {
        const interval = _intervalSec(_marketTf);
        const nextTs = _currentMarket ? _currentMarket.endTs : _getWindowTs(_marketTf);
        const nextSlug = makeSlug(_marketTf, nextTs);

        for (let i = 0; i < 15; i++) {
          next = await fetchMarketData(nextSlug);
          if (next) break;
          await _sleep(600);
        }
      }

      if (!next) {
        next = await loadCurrentMarket(_marketTf);
      }

      if (next) {
        const prev = _currentMarket;
        _currentMarket = next;
        _nextMarket = null;

        if (_onSwitchCb) {
          _onSwitchCb(next, prev);
        }

        scheduleRollover(next, _onSwitchCb);
      } else {
        console.error('[MarketManager] Rollover retry: no active market found, retrying in 3s...');
        setTimeout(() => {
          _isRollingOver = false;
          _doRollover();
        }, 3000);
        return;
      }
    } finally {
      _isRollingOver = false;
    }
  }

  function setCurrentMarket(market) {
    _currentMarket = market;
  }

  function getCurrentMarket() { return _currentMarket; }
  function getNextMarket()    { return _nextMarket; }
  function getMarketTf()      { return _marketTf; }

  function getSecondsRemaining() {
    if (!_currentMarket || !_currentMarket.endTs) return null;
    return Math.max(0, _currentMarket.endTs - Math.floor(Date.now() / 1000));
  }

  function triggerRollover() {
    _doRollover();
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
    triggerRollover,
  };
})();
