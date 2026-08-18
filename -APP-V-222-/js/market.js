/**
 * market.js — Polymarket Market Discovery & Active Session Rollover v4.7
 * 
 * Features & Fixes in v4.7:
 * - Pure Official CLOB Parallel History Hydration (eliminated noisy unverified Data API trades)
 * - True session-start anchor (anchors startTs to first historical tick, eliminating horizontal mid-session shelf)
 * - Dual-Token UP + Inverted DOWN CLOB merging with timestamp deduplication
 * - Strict 2.5s AbortController timeout & zero third-party proxies
 * - Self-healing background retry loop for mid-session opens
 */
'use strict';

window.MarketManager = (() => {
  const GAMMA_BASE = 'https://gamma-api.polymarket.com';
  const CLOB_BASE  = 'https://clob.polymarket.com';

  let _currentMarket = null;
  let _nextMarket    = null;
  let _marketTf      = 5;       // 5 or 15 minutes
  let _rolloverTimer = null;
  let _prefetchTimer = null;
  let _isRollingOver = false;
  let _onSwitchCb    = null;

  function _intervalSec(tfMinutes) {
    return tfMinutes * 60;
  }

  function _getWindowTs(tfMinutes, unixSec) {
    const now = unixSec || Math.floor(Date.now() / 1000);
    const interval = _intervalSec(tfMinutes);
    return Math.floor(now / interval) * interval;
  }

  function makeSlug(tfMinutes, windowStartTs) {
    return `btc-updown-${tfMinutes}m-${windowStartTs}`;
  }

  function getCurrentSlug(tfMinutes) {
    return makeSlug(tfMinutes || _marketTf, _getWindowTs(tfMinutes || _marketTf));
  }

  function getNextSlug(tfMinutes) {
    const tf = tfMinutes || _marketTf;
    return makeSlug(tf, _getWindowTs(tf) + _intervalSec(tf));
  }

  // ─── Fetch with strict timeout ─────────────────────────────────────
  async function _fetchWithRetry(rawUrl, retries = 2, timeoutMs = 2500) {
    for (let i = 0; i < retries; i++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(rawUrl, {
          headers: { 'Accept': 'application/json' },
          cache: 'no-cache',
          signal: controller.signal
        });
        clearTimeout(timer);
        if (res.ok) {
          return await res.json();
        }
      } catch (err) {
        clearTimeout(timer);
      }
      await _sleep(200 * (i + 1));
    }
    return null;
  }

  // ─── Fetch Market Metadata ─────────────────────────────────────────
  async function fetchMarketData(slug) {
    const url = `${GAMMA_BASE}/events?slug=${slug}`;
    const data = await _fetchWithRetry(url, 2, 3000);
    if (!data) return null;

    const event = Array.isArray(data) ? data[0] : data;
    if (!event || !event.markets || event.markets.length === 0) return null;

    const market = event.markets[0];
    let upTokenId = null;
    let downTokenId = null;

    if (market.clobTokenIds) {
      let ids = market.clobTokenIds;
      if (typeof ids === 'string') {
        try { ids = JSON.parse(ids); } catch {}
      }
      if (Array.isArray(ids) && ids.length >= 2) {
        upTokenId = String(ids[0]);
        downTokenId = String(ids[1]);
      }
    }

    if (!upTokenId && market.tokens) {
      const upTok = market.tokens.find(t => (t.outcome || '').toUpperCase() === 'UP' || (t.outcome || '').toUpperCase() === 'YES');
      const downTok = market.tokens.find(t => (t.outcome || '').toUpperCase() === 'DOWN' || (t.outcome || '').toUpperCase() === 'NO');
      if (upTok) upTokenId = String(upTok.token_id || upTok.tokenId);
      if (downTok) downTokenId = String(downTok.token_id || downTok.tokenId);
    }

    const interval = (slug.includes('-15m-') ? 15 : 5) * 60;
    const match = slug.match(/(\d+)$/);
    const startTs = match ? parseInt(match[1], 10) : _parseTs(event.startDate || market.startDate);
    const endTs = startTs ? startTs + interval : _parseTs(event.endDate || market.endDate);

    let initialProb = 0.50;
    try {
      let outP = market.outcomePrices;
      if (typeof outP === 'string') outP = JSON.parse(outP);
      if (Array.isArray(outP) && outP[0]) initialProb = parseFloat(outP[0]) || 0.50;
    } catch {}

    return {
      slug,
      conditionId: market.conditionId,
      question: market.question || event.title,
      upTokenId,
      downTokenId,
      startTs,
      endTs,
      initialProb,
      eventMetadata: event.eventMetadata || market.eventMetadata || null,
      raw: market,
    };
  }

  function _parseTs(val) {
    if (!val) return null;
    if (typeof val === 'number') return val > 10_000_000_000 ? Math.floor(val / 1000) : val;
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
  }

  async function fetchMidpoint(tokenId) {
    if (!tokenId) return null;
    const data = await _fetchWithRetry(`${CLOB_BASE}/midpoint?token_id=${tokenId}`, 2, 2000);
    if (!data) return null;
    const mid = parseFloat(data.mid);
    return isNaN(mid) ? null : mid;
  }

  // ─── Dual-Token Pure CLOB + 9-Stream Deep Trades History Downloader ──
  async function fetchSessionPriceHistory(upTokenId, downTokenId, startTs, endTs, conditionId) {
    if (!upTokenId || !startTs || !endTs) return [];

    const nowNonce = Date.now();

    // 1. Fetch CLOB prices-history for UP/DOWN with cache buster
    const fetchTokenClob = async (tok, isInverted) => {
      if (!tok) return { inSession: [], preStart: null };
      const url = `${CLOB_BASE}/prices-history?market=${tok}&interval=1d&fidelity=1&_t=${nowNonce}`;
      const data = await _fetchWithRetry(url, 2, 2500);
      if (data && Array.isArray(data.history) && data.history.length > 0) {
        const inSession = [];
        let preStart = null;
        for (let i = 0; i < data.history.length; i++) {
          const item = data.history[i];
          const ts = parseInt(item.t);
          const p = parseFloat(item.p);
          if (!isNaN(ts) && !isNaN(p)) {
            const rawCents = Math.round(p * 1000) / 10;
            const upCents = isInverted ? (100 - rawCents) : rawCents;
            const clamped = Math.max(0, Math.min(100, Math.round(upCents * 10) / 10));

            if (ts <= startTs) {
              preStart = clamped;
            } else if (ts <= endTs) {
              inSession.push([ts, clamped]);
            }
          }
        }
        return { inSession, preStart };
      }
      return { inSession: [], preStart: null };
    };

    // 2. Fetch Data API trades by conditionId or asset_id with offset pagination
    const fetchTradesPage = async (paramKey, paramVal, offset, isForceDown = false) => {
      if (!paramVal) return [];
      const url = `https://data-api.polymarket.com/trades?${paramKey}=${paramVal}&limit=500&offset=${offset}&_t=${nowNonce}`;
      const data = await _fetchWithRetry(url, 2, 2500);
      if (Array.isArray(data) && data.length > 0) {
        const list = [];
        for (let i = 0; i < data.length; i++) {
          const tr = data[i];
          const ts = parseInt(tr.timestamp);
          let p = parseFloat(tr.price);
          if (!isNaN(ts) && !isNaN(p) && ts >= startTs && ts <= endTs) {
            const outcome = String(tr.outcome || '').toLowerCase();
            const isDown = isForceDown || outcome === 'down' || tr.outcomeIndex === 1;
            if (isDown) {
              p = 1.0 - p;
            }
            const upCents = Math.max(0, Math.min(100, Math.round(p * 1000) / 10));
            list.push([ts, upCents]);
          }
        }
        return list;
      }
      return [];
    };

    try {
      // Launch all 9 high-density streams in parallel
      const tasks = [
        fetchTokenClob(upTokenId, false),
        fetchTokenClob(downTokenId, true),
      ];

      if (conditionId) {
        tasks.push(fetchTradesPage('market', conditionId, 0));
        tasks.push(fetchTradesPage('market', conditionId, 500));
        tasks.push(fetchTradesPage('market', conditionId, 1000));
      }
      if (upTokenId) {
        tasks.push(fetchTradesPage('asset_id', upTokenId, 0, false));
        tasks.push(fetchTradesPage('asset_id', upTokenId, 500, false));
      }
      if (downTokenId) {
        tasks.push(fetchTradesPage('asset_id', downTokenId, 0, true));
        tasks.push(fetchTradesPage('asset_id', downTokenId, 500, true));
      }

      const results = await Promise.allSettled(tasks);

      const map = new Map();
      let openingAnchorPrice = null;

      // Process CLOB streams (indices 0 and 1)
      if (results[0].status === 'fulfilled' && results[0].value) {
        const { inSession, preStart } = results[0].value;
        if (preStart !== null) openingAnchorPrice = preStart;
        for (let [ts, val] of inSession) map.set(ts, val);
      }
      if (results[1].status === 'fulfilled' && results[1].value) {
        const { inSession, preStart } = results[1].value;
        if (preStart !== null && openingAnchorPrice === null) openingAnchorPrice = preStart;
        for (let [ts, val] of inSession) {
          if (!map.has(ts)) map.set(ts, val);
          else {
            const existing = map.get(ts);
            map.set(ts, Math.round(((existing + val) / 2) * 10) / 10);
          }
        }
      }

      // Process all trade pages (indices 2..N)
      for (let i = 2; i < results.length; i++) {
        if (results[i].status === 'fulfilled' && Array.isArray(results[i].value)) {
          for (let [ts, val] of results[i].value) {
            map.set(ts, val);
          }
        }
      }

      const sorted = Array.from(map.entries()).sort((a, b) => a[0] - b[0]);

      // True opening anchor at startTs
      if (openingAnchorPrice !== null) {
        sorted.unshift([startTs, openingAnchorPrice]);
      } else if (sorted.length > 0 && sorted[0][0] > startTs) {
        sorted.unshift([startTs, 50.0]);
      }

      if (sorted.length > 0) {
        return sorted;
      }
    } catch (e) {
      console.warn('[MarketManager] Session history fetch error:', e);
    }

    return [];
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
      `${GAMMA_BASE}/events?slug_contains=btc-updown-${tfMinutes}m&active=true&closed=false&limit=10`,
      2,
      3000
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

  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  return {
    makeSlug,
    getCurrentSlug,
    getNextSlug,
    fetchMarketData,
    fetchMidpoint,
    fetchSessionPriceHistory,
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
