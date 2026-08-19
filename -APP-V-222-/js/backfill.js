/**
 * backfill.js — Polymarket Historical Data Backfill Engine v1.5
 * 
 * Responsibilities:
 * - Download past 5M / 15M sessions from Polymarket Gamma API
 * - Fetch historical price curve from CLOB /prices-history
 * - Parse official settlement winner (outcomePrices)
 * - Rate-limited batching with live progress updates
 * - Smart Merge with local database (skips already downloaded sessions)
 * - Proxy fallbacks for local file:/// execution
 * - Cancellation support
 */
'use strict';

window.BackfillEngine = (() => {
  const GAMMA_BASE = 'https://gamma-api.polymarket.com';
  const CLOB_BASE  = 'https://clob.polymarket.com';
  const DATA_BASE  = 'https://data-api.polymarket.com';

  let _isRunning = false;
  let _abortRequested = false;

  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function _fetchJSON(url, retries = 2) {
    for (let i = 0; i < retries; i++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const resp = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: controller.signal });
        clearTimeout(timer);
        if (resp.ok) return await resp.json();
        if (resp.status === 404) return null;
        if (resp.status === 429) {
          await _sleep(800 * (i + 1));
          continue;
        }
      } catch (e) {
        clearTimeout(timer);
        if (i < retries - 1) await _sleep(400);
      }
    }
    return null;
  }

  /**
   * Fetch single session metadata, real intraday trades (Data API), and orderbook price changes (CLOB API).
   */
  async function fetchSessionData(slug, tfMinutes) {
    const event = await _fetchJSON(`${GAMMA_BASE}/events/slug/${slug}`);
    if (!event || !event.markets || event.markets.length === 0) return null;

    const market = event.markets[0];
    let tokenIds, outcomes, outcomePrices;

    try {
      tokenIds = typeof market.clobTokenIds === 'string' ? JSON.parse(market.clobTokenIds) : market.clobTokenIds;
      outcomes = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : market.outcomes;
      outcomePrices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;
    } catch {
      return null;
    }

    if (!Array.isArray(tokenIds) || tokenIds.length < 2) return null;

    // Determine Up token ID
    const upIdx = Array.isArray(outcomes)
      ? outcomes.findIndex(o => /^up$/i.test(String(o).trim()) || /^yes$/i.test(String(o).trim()))
      : 0;
    const upTokenId = tokenIds[upIdx !== -1 ? upIdx : 0];

    // Determine official winner
    let winner = 'PENDING';
    let upWon = null;
    if (Array.isArray(outcomePrices) && outcomePrices.length >= 2) {
      const upP = parseFloat(outcomePrices[upIdx !== -1 ? upIdx : 0]);
      if (!isNaN(upP)) {
        if (upP > 0.5) { winner = 'UP'; upWon = true; }
        else if (upP < 0.5) { winner = 'DOWN'; upWon = false; }
      }
    }

    // Extract start and end ts
    let startTs = null;
    const slugMatch = slug.match(/(\d+)$/);
    if (slugMatch) startTs = parseInt(slugMatch[1], 10);
    const intervalSec = tfMinutes * 60;
    const endTs = startTs ? (startTs + intervalSec) : null;

    const tickMap = new Map();

    // 1. Fetch real individual trades from Data API
    if (market.conditionId) {
      const trades = await _fetchJSON(`${DATA_BASE}/trades?market=${market.conditionId}&limit=500`);
      if (Array.isArray(trades)) {
        for (const tr of trades) {
          const ts = tr.timestamp;
          if (startTs && endTs && ts >= startTs && ts <= endTs) {
            let p = tr.price;
            if (tr.outcome === 'Down' || tr.outcomeIndex === 1) p = 1 - p;
            if (typeof p === 'number' && !isNaN(p)) {
              tickMap.set(ts, Math.round(p * 1000) / 10);
            }
          }
        }
      }
    }

    // 2. Fetch orderbook price changes from CLOB strictly bounded by startTs & endTs
    if (upTokenId && startTs && endTs) {
      const ph = await _fetchJSON(`${CLOB_BASE}/prices-history?market=${upTokenId}&startTs=${startTs}&endTs=${endTs}&fidelity=1`);
      if (ph && Array.isArray(ph.history)) {
        for (const pt of ph.history) {
          if (pt.t >= startTs && pt.t <= endTs) {
            tickMap.set(pt.t, Math.round(pt.p * 1000) / 10);
          }
        }
      }
    }

    // 3. Anchor start and end of the session
    if (startTs && !tickMap.has(startTs)) {
      const firstVal = tickMap.size > 0 ? Array.from(tickMap.values())[0] : 50.0;
      tickMap.set(startTs, firstVal);
    }
    if (endTs && !tickMap.has(endTs) && upWon !== null) {
      tickMap.set(endTs, upWon ? 100.0 : 0.0);
    }

    // 4. Extract official Polymarket BTC Target & Final settlement prices (Chainlink TWAP)
    let btcOpen = null, btcClose = null, btcHigh = null, btcLow = null, btcChange = null;

    const meta = event.eventMetadata || market.eventMetadata || event.metadata || market.metadata;
    if (meta && typeof meta === 'object') {
      const pToBeat = parseFloat(meta.priceToBeat || meta.targetPrice || meta.openPrice);
      const fPrice = parseFloat(meta.finalPrice || meta.settlementPrice || meta.closePrice);
      if (!isNaN(pToBeat) && pToBeat > 0) btcOpen = pToBeat;
      if (!isNaN(fPrice) && fPrice > 0) btcClose = fPrice;
    }

    // Try Preddy API for 1:1 Chainlink 60s TWAP strike if not in metadata
    if (btcOpen === null && startTs && endTs) {
      try {
        const startISO = new Date(startTs * 1000).toISOString().replace('.000Z', 'Z');
        const endISO = new Date(endTs * 1000).toISOString().replace('.000Z', 'Z');
        const pData = await _fetchJSON(`https://api.preddy.trade/crypto/price?symbol=btc&startDate=${startISO}&endDate=${endISO}&twapLookbackSeconds=60`);
        if (pData && pData.openPrice) {
          const p = parseFloat(pData.openPrice);
          if (!isNaN(p) && p > 0) btcOpen = p;
        }
      } catch {}
    }

    // Fallback to Binance BTCUSDT kline if eventMetadata is not yet available
    if ((btcOpen === null || btcClose === null) && startTs) {
      try {
        const kline = await _fetchJSON(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${tfMinutes}m&startTime=${startTs * 1000}&limit=1`);
        if (Array.isArray(kline) && kline[0]) {
          if (btcOpen === null) btcOpen = parseFloat(kline[0][1]);
          btcHigh = parseFloat(kline[0][2]);
          btcLow = parseFloat(kline[0][3]);
          if (btcClose === null) btcClose = parseFloat(kline[0][4]);
        }
      } catch {}
    }

    if (btcOpen !== null && btcClose !== null && btcOpen > 0) {
      btcChange = Math.round(((btcClose - btcOpen) / btcOpen) * 10000) / 100;
    }

    const ticks = Array.from(tickMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([t, v]) => [t, v]);

    const tickCount = ticks.length;
    const spanSec = tickCount > 0 ? (ticks[ticks.length - 1][0] - ticks[0][0]) : 0;
    const quality = tickCount >= 30 ? 'EXCELLENT' : (tickCount >= 10 ? 'GOOD' : 'SPARSE');
    const volume = parseFloat(event.volume || market.volume || 0);

    return {
      slug,
      tf: tfMinutes,
      startTs,
      endTs,
      winner,
      outcomePrices,
      volume,
      btcOpen,
      btcClose,
      btcHigh,
      btcLow,
      btcChange,
      quality,
      tickCount,
      spanSec,
      ticks,
    };
  }

  async function startBackfill({ tfMinutes = 5, sessionCount = 72, smartMerge = true }, onProgress) {
    if (_isRunning) return false;
    _isRunning = true;
    _abortRequested = false;

    const intervalSec = tfMinutes * 60;
    const nowSec = Math.floor(Date.now() / 1000);
    const currentWindowTs = Math.floor(nowSec / intervalSec) * intervalSec;

    const targetSlugs = [];
    for (let i = 1; i <= sessionCount; i++) {
      const ts = currentWindowTs - (i * intervalSec);
      const slug = `btc-updown-${tfMinutes}m-${ts}`;
      targetSlugs.push({ slug, ts });
    }

    let processed = 0;
    let saved = 0;
    let skipped = 0;

    for (const item of targetSlugs) {
      if (_abortRequested) {
        console.log('[BackfillEngine] Abort requested by user');
        break;
      }

      const { slug } = item;

      if (smartMerge && window.DBManager) {
        const existing = window.DBManager.getSession(slug);
        if (existing && Array.isArray(existing.ticks) && existing.ticks.length > 10 && existing.winner !== 'PENDING') {
          skipped++;
          processed++;
          if (onProgress) {
            onProgress({
              current: processed,
              total: targetSlugs.length,
              slug,
              savedCount: saved,
              skippedCount: skipped,
              status: 'SKIPPED (Already in DB)',
            });
          }
          continue;
        }
      }

      if (onProgress) {
        onProgress({
          current: processed + 1,
          total: targetSlugs.length,
          slug,
          savedCount: saved,
          skippedCount: skipped,
          status: 'DOWNLOADING...',
        });
      }

      try {
        const data = await fetchSessionData(slug, tfMinutes);
        if (data && data.ticks.length > 0) {
          if (window.DBManager) {
            window.DBManager.upsertSession(data, false);
          }
          saved++;
        }
      } catch (e) {
        console.warn('[BackfillEngine] Failed for slug:', slug, e);
      }

      processed++;

      if (onProgress) {
        onProgress({
          current: processed,
          total: targetSlugs.length,
          slug,
          savedCount: saved,
          skippedCount: skipped,
          status: 'SAVED',
        });
      }

      await _sleep(80);
    }

    if (window.DBManager && window.DBManager.isAutoSave()) {
      await window.DBManager.saveFile();
    }

    _isRunning = false;
    _abortRequested = false;

    return { processed, saved, skipped };
  }

  function stop() {
    if (_isRunning) {
      _abortRequested = true;
    }
  }

  function isRunning() { return _isRunning; }

  return {
    fetchSessionData,
    startBackfill,
    stop,
    isRunning,
  };
})();
