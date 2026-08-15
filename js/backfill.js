/**
 * backfill.js — Polymarket Historical Data Backfill Engine v1.4
 * 
 * Responsibilities:
 * - Download past 5M / 15M sessions from Polymarket Gamma API
 * - Fetch historical price curve from CLOB /prices-history
 * - Parse official settlement winner (outcomePrices)
 * - Rate-limited batching with live progress updates
 * - Smart Merge with local database (skips already downloaded sessions)
 * - Cancellation support
 */
'use strict';

window.BackfillEngine = (() => {
  const GAMMA_BASE = 'https://gamma-api.polymarket.com';
  const CLOB_BASE  = 'https://clob.polymarket.com';

  let _isRunning = false;
  let _abortRequested = false;

  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function _fetchJSON(url, retries = 2) {
    for (let i = 0; i < retries; i++) {
      try {
        const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
        if (resp.ok) return await resp.json();
        if (resp.status === 404) return null;
        if (resp.status === 429) {
          await _sleep(800 * (i + 1));
          continue;
        }
      } catch (e) {
        if (i < retries - 1) await _sleep(600);
      }
    }
    return null;
  }

  /**
   * Fetch single session metadata and price history
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
    if (Array.isArray(outcomePrices) && outcomePrices.length >= 2) {
      const upP = parseFloat(outcomePrices[upIdx !== -1 ? upIdx : 0]);
      if (!isNaN(upP)) {
        if (upP > 0.5) winner = 'UP';
        else if (upP < 0.5) winner = 'DOWN';
      }
    }

    // Extract start and end ts
    let startTs = null;
    const slugMatch = slug.match(/(\d+)$/);
    if (slugMatch) startTs = parseInt(slugMatch[1], 10);
    const intervalSec = tfMinutes * 60;
    const endTs = startTs ? (startTs + intervalSec) : null;

    // Fetch price history points from CLOB
    let ticks = [];
    if (upTokenId) {
      const ph = await _fetchJSON(`${CLOB_BASE}/prices-history?market=${upTokenId}&interval=all&fidelity=1`);
      if (ph && Array.isArray(ph.history)) {
        // [{ t: unixSec, p: price01 }]
        // Convert to [[t, v_cents]]
        ticks = ph.history
          .map(pt => [pt.t, Math.round(pt.p * 1000) / 10])
          .filter(pt => typeof pt[0] === 'number' && !isNaN(pt[1]))
          .sort((a, b) => a[0] - b[0]);
      }
    }

    // Volume
    const volume = parseFloat(event.volume || market.volume || 0);

    return {
      slug,
      tf: tfMinutes,
      startTs,
      endTs,
      winner,
      outcomePrices,
      volume,
      ticks,
    };
  }

  /**
   * Start batch download of historical sessions.
   * @param {Object} options
   * @param {number} options.tfMinutes - 5 or 15
   * @param {number} options.sessionCount - e.g. 72 (6h), 144 (12h), 288 (24h)
   * @param {boolean} options.smartMerge - skip sessions already in DBManager with ticks
   * @param {Function} onProgress - ({ current, total, slug, savedCount, status })
   */
  async function startBackfill({ tfMinutes = 5, sessionCount = 72, smartMerge = true }, onProgress) {
    if (_isRunning) return false;
    _isRunning = true;
    _abortRequested = false;

    const intervalSec = tfMinutes * 60;
    const nowSec = Math.floor(Date.now() / 1000);
    const currentWindowTs = Math.floor(nowSec / intervalSec) * intervalSec;

    // Generate past slugs in descending order (most recent first)
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

      // Smart Merge check
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
            window.DBManager.upsertSession(data, false); // batch in memory
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

      // Polite rate-limit delay (80ms)
      await _sleep(80);
    }

    // Flush all to disk
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
