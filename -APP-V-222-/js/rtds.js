/**
 * rtds.js — Polymarket Real-Time Data Stream (RTDS) WebSocket Client v6.8
 *
 * Strike Architecture:
 * - Stage 0: market.startTs fed in via resetForNewWindow() -> locks winStartSec
 * - Stage 1: live tick at second 0 -> preliminary strike (unverified)
 * - Stage 1b: payload.data historical buffer (on connect) -> earliest point >= winStartSec
 * - Stage 2: Fast API reconciliation loop (Preddy / local proxy / multi-tier CORS) -> official Chainlink TWAP
 * - onStrikeConfirmed callback fires directly (does NOT need live price to be received first)
 */
'use strict';

window.PolyRTDS = (() => {
  const WS_URL = 'wss://ws-live-data.polymarket.com';
  const PING_INTERVAL_MS = 5_000;
  const RECONNECT_DELAY_MS = 2_000;

  let _ws = null;
  let _pingTimer = null;
  let _reconnectTimer = null;
  let _reconciliationTimer = null;
  let _destroyed = false;

  let _currentBtcPrice = null;
  let _targetBtcPrice  = null;
  let _activeWinStartSec  = null;  // authoritative startTs from market metadata
  let _activeDurationSecs = 300;
  let _currentWindowId = null;
  let _durationSecs    = 300;
  let _lastTimestamp   = 0;
  let _isOfficialStrikeVerified = false;
  let _isReconciling   = false;

  const handlers = {
    onBtcPrice: null,          // (currentPrice, tsMs, targetPrice, delta, isTwapVerified)
    onStrikeConfirmed: null,   // (price, winStartSec) -- fires independently of live price
    onConnected: null,
    onDisconnected: null,
  };

  // ---- Duration -------------------------------------------------------
  function setDurationSecs(secs) {
    const newDur = Math.max(60, secs || 300);
    if (_durationSecs !== newDur) {
      _durationSecs = newDur;
      _currentWindowId = null;
      _isOfficialStrikeVerified = false;
    }
  }

  function getDurationSecs() { return _durationSecs; }

  // ---- Official Strike Injection from metadata ------------------------
  function setVerifiedStrike(price, winStartSec) {
    if (!price || isNaN(price) || price <= 0) return;
    _targetBtcPrice = price;
    _isOfficialStrikeVerified = true;
    if (winStartSec) {
      _cacheStrike(winStartSec, price);
      _activeWinStartSec = winStartSec;
    }
    _stopReconciliation();
    _emitStrikeConfirmed(price, winStartSec || _activeWinStartSec);
    _emitPriceUpdate();
    console.log('[PolyRTDS] Strike injected from metadata: $' + price.toFixed(2));
  }

  // ---- Multi-Tier API Fetcher -----------------------------------------
  async function fetchOfficialTargetPrice(winStartSec, winEndSec) {
    if (!winStartSec) return null;
    const duration = (winEndSec && winEndSec > winStartSec) ? (winEndSec - winStartSec) : _durationSecs;
    const endSec = winEndSec || (winStartSec + duration);

    const startISO = new Date(winStartSec * 1000).toISOString().replace('.000Z', 'Z');
    const endISO   = new Date(endSec   * 1000).toISOString().replace('.000Z', 'Z');

    const preddyDirect = 'https://api.preddy.trade/crypto/price?symbol=btc&startDate=' + startISO + '&endDate=' + endISO + '&twapLookbackSeconds=60';
    const endpoints = [
      '/api/target-price?symbol=btc&startDate=' + startISO + '&endDate=' + endISO + '&twapLookbackSeconds=60',
      'http://localhost:8088/api/target-price?symbol=btc&startDate=' + startISO + '&endDate=' + endISO + '&twapLookbackSeconds=60',
      'http://127.0.0.1:8088/api/target-price?symbol=btc&startDate=' + startISO + '&endDate=' + endISO + '&twapLookbackSeconds=60',
      preddyDirect,
      'https://corsproxy.io/?url=' + encodeURIComponent(preddyDirect),
      'https://api.allorigins.win/raw?url=' + encodeURIComponent(preddyDirect),
    ];

    for (const url of endpoints) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3000);
        const resp = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: controller.signal });
        clearTimeout(timer);
        if (resp.ok) {
          const data = await resp.json();
          const openPrice = typeof data.openPrice === 'number' ? data.openPrice : parseFloat(data.openPrice);
          if (!isNaN(openPrice) && openPrice > 0) {
            console.log('[PolyRTDS] Official strike from API: $' + openPrice.toFixed(2));
            return openPrice;
          }
        }
      } catch (e) {}
    }
    return null;
  }

  function _cacheStrike(winStartSec, price) {
    try { localStorage.setItem('pm_btc_twap_strike_v7_' + winStartSec, price); } catch {}
  }

  function _getCachedStrike(winStartSec) {
    try {
      const v = localStorage.getItem('pm_btc_twap_strike_v7_' + winStartSec);
      return v ? parseFloat(v) : null;
    } catch { return null; }
  }

  // ---- Reconciliation Loop -------------------------------------------
  function _stopReconciliation() {
    if (_reconciliationTimer) { clearInterval(_reconciliationTimer); _reconciliationTimer = null; }
    _isReconciling = false;
  }

  function _startFastStrikeReconciliation(winStartSec, durationSecs) {
    _stopReconciliation();
    if (!winStartSec) return;
    const dur = durationSecs || _activeDurationSecs || _durationSecs;

    let attempts = 0;
    const maxAttempts = 20; // 20 x 2s = 40s coverage

    const poll = async () => {
      if (_destroyed || _isOfficialStrikeVerified || attempts >= maxAttempts) {
        _stopReconciliation();
        return;
      }
      if (_isReconciling) return;
      _isReconciling = true;
      attempts++;

      try {
        const officialPrice = await fetchOfficialTargetPrice(winStartSec, winStartSec + dur);
        if (officialPrice !== null && !isNaN(officialPrice) && officialPrice > 0) {
          _targetBtcPrice = officialPrice;
          _isOfficialStrikeVerified = true;
          _cacheStrike(winStartSec, officialPrice);
          _stopReconciliation();
          _emitStrikeConfirmed(officialPrice, winStartSec);
          _emitPriceUpdate();
          return;
        }
      } catch (err) {
        // will retry
      } finally {
        _isReconciling = false;
      }
    };

    // Immediate first attempt, then every 2 seconds
    poll();
    _reconciliationTimer = setInterval(poll, 2000);
  }

  // ---- Emitters -------------------------------------------------------
  function _emitStrikeConfirmed(price, winStartSec) {
    if (handlers.onStrikeConfirmed) {
      try { handlers.onStrikeConfirmed(price, winStartSec); } catch (e) {}
    }
  }

  function _emitPriceUpdate() {
    // KEY FIX: emit even when currentBtcPrice is null — strike update must reach app.js
    if (_currentBtcPrice === null && _targetBtcPrice === null) return;
    const delta = (_currentBtcPrice !== null && _targetBtcPrice !== null)
      ? (_currentBtcPrice - _targetBtcPrice) : null;
    if (handlers.onBtcPrice) {
      handlers.onBtcPrice(
        _currentBtcPrice,
        _lastTimestamp || Date.now(),
        _targetBtcPrice,
        delta,
        Boolean(_isOfficialStrikeVerified)
      );
    }
  }

  // ---- Window Management ----------------------------------------------
  function checkAndRefreshWindow() {
    const nowSec = _lastTimestamp > 0
      ? Math.floor(_lastTimestamp / 1000)
      : Math.floor(Date.now() / 1000);
    const winStartSec = Math.floor(nowSec / _durationSecs) * _durationSecs;
    const winId = Math.floor(nowSec / _durationSecs);

    if (_currentWindowId !== winId) {
      _currentWindowId = winId;
      _isOfficialStrikeVerified = false;
      _targetBtcPrice = _getCachedStrike(winStartSec);
      _startFastStrikeReconciliation(winStartSec, _durationSecs);
    }
  }

  // Called by app.js at market load / rollover with the market's authoritative startTs
  function resetForNewWindow(winStartSec, durationSecs) {
    if (!winStartSec) {
      const nowSec = Math.floor(Date.now() / 1000);
      winStartSec = Math.floor(nowSec / _durationSecs) * _durationSecs;
    }
    const dur = durationSecs || _durationSecs;

    console.log('[PolyRTDS] resetForNewWindow: winStartSec=' + winStartSec + ' dur=' + dur + 's');

    _activeWinStartSec  = winStartSec;
    _activeDurationSecs = dur;
    _currentWindowId    = Math.floor(winStartSec / dur);
    _isOfficialStrikeVerified = false;

    // Always start fresh — no stale data
    _targetBtcPrice = null;
    _stopReconciliation();

    // Use cache as preliminary display while API fetches
    const cached = _getCachedStrike(winStartSec);
    if (cached && !isNaN(cached) && cached > 0) {
      _targetBtcPrice = cached;
      _emitPriceUpdate();
      console.log('[PolyRTDS] Strike from cache (preliminary): $' + cached.toFixed(2));
    }

    // Always reconcile to get confirmed official value
    _startFastStrikeReconciliation(winStartSec, dur);
  }

  // ---- WebSocket Stream -----------------------------------------------
  function connect() {
    if (_destroyed) return;
    if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) return;

    try {
      _ws = new WebSocket(WS_URL);
    } catch (e) {
      console.error('[PolyRTDS] Connection error:', e);
      _scheduleReconnect();
      return;
    }

    _ws.onopen = () => {
      console.log('[PolyRTDS] Connected to Polymarket RTDS (60s TWAP 1:1 Stream v6.7)');
      _subscribeTwapPrices();
      _startPing();
      if (handlers.onConnected) handlers.onConnected();
    };

    _ws.onmessage = (event) => {
      if (!event.data || !event.data.trim()) return;
      try {
        const msg = JSON.parse(event.data);
        const topic = msg.topic;

        if (topic === 'crypto_prices_twap_sixty' || topic === 'crypto_prices_chainlink') {
          const payload = msg.payload || {};

          // -- 1. Batch historical points (sent once on (re)connect) --
          if (Array.isArray(payload.data) && payload.data.length > 0) {
            // Use authoritative winStartSec if available; fallback to computed
            const winStartSec = _activeWinStartSec != null ? _activeWinStartSec
              : (Math.floor((_lastTimestamp > 0 ? Math.floor(_lastTimestamp / 1000) : Math.floor(Date.now() / 1000)) / _durationSecs) * _durationSecs);

            let strikeCandidate = null;
            let minDiff = Infinity;
            let latestPrice = null;
            let maxTsMs = 0;

            for (const pt of payload.data) {
              const rawVal = pt.value !== undefined ? pt.value : pt.price;
              const price = typeof rawVal === 'number' ? rawVal : parseFloat(rawVal);
              const tsMs = typeof pt.timestamp === 'number' ? pt.timestamp : (msg.timestamp || Date.now());
              const ptSec = Math.floor(tsMs / 1000);

              if (!isNaN(price) && price > 0) {
                if (tsMs >= maxTsMs) { maxTsMs = tsMs; latestPrice = price; }

                // Strike candidate: earliest point at or after winStartSec
                if (ptSec >= winStartSec) {
                  const diff = ptSec - winStartSec;
                  if (diff < minDiff) { minDiff = diff; strikeCandidate = price; }
                }
              }
            }

            if (latestPrice !== null) {
              _currentBtcPrice = latestPrice;
              _lastTimestamp = maxTsMs || Date.now();
            }

            // Accept RTDS buffer strike if it's from within the first 30s of the round
            // and we don't yet have a verified official strike
            if (strikeCandidate !== null && minDiff <= 30 && !_isOfficialStrikeVerified) {
              _targetBtcPrice = strikeCandidate;
              _isOfficialStrikeVerified = true;
              _cacheStrike(winStartSec, strikeCandidate);
              _stopReconciliation();
              _emitStrikeConfirmed(strikeCandidate, winStartSec);
              console.log('[PolyRTDS] Strike from RTDS buffer: $' + strikeCandidate.toFixed(2) + ' (diff=' + minDiff + 's)');
            }

            _emitPriceUpdate();
          }

          // -- 2. Single live tick (every second) --
          if (payload.value !== undefined && payload.value !== null) {
            const val = typeof payload.value === 'number' ? payload.value : parseFloat(payload.value);
            if (!isNaN(val) && val > 0) {
              _currentBtcPrice = val;
              _lastTimestamp = payload.timestamp || msg.timestamp || Date.now();

              const nowSec = Math.floor(_lastTimestamp / 1000);
              const winStartSec = _activeWinStartSec != null ? _activeWinStartSec
                : (Math.floor(nowSec / _durationSecs) * _durationSecs);
              const dur = _activeDurationSecs || _durationSecs;
              const secInWin = nowSec - winStartSec;

              if (secInWin === 0 && !_isOfficialStrikeVerified) {
                // Exact second 0: live TWAP tick = preliminary strike
                _targetBtcPrice = val;
                _cacheStrike(winStartSec, val);
                console.log('[PolyRTDS] Strike from second-0 tick: $' + val.toFixed(2) + ' (preliminary)');
                _startFastStrikeReconciliation(winStartSec, dur);
              } else if (_targetBtcPrice === null) {
                const cached = _getCachedStrike(winStartSec);
                if (cached && !isNaN(cached) && cached > 0) {
                  _targetBtcPrice = cached;
                } else if (!_isReconciling && !_reconciliationTimer) {
                  _startFastStrikeReconciliation(winStartSec, dur);
                }
              }

              _emitPriceUpdate();
            }
          }
        }
      } catch (err) {}
    };

    _ws.onerror = (err) => { console.warn('[PolyRTDS] WebSocket error:', err); };

    _ws.onclose = () => {
      _clearTimers();
      if (handlers.onDisconnected) handlers.onDisconnected();
      if (!_destroyed) _scheduleReconnect();
    };
  }

  function _subscribeTwapPrices() {
    if (!_ws || _ws.readyState !== WebSocket.OPEN) return;
    try {
      _ws.send(JSON.stringify({
        action: 'subscribe',
        subscriptions: [{ topic: 'crypto_prices_twap_sixty', type: '*', filters: JSON.stringify({ symbol: 'btc/usd' }) }]
      }));
    } catch {}
  }

  function _startPing() {
    clearInterval(_pingTimer);
    _pingTimer = setInterval(() => {
      if (_ws && _ws.readyState === WebSocket.OPEN) {
        try { _ws.send(JSON.stringify({ action: 'ping' })); } catch {}
      }
    }, PING_INTERVAL_MS);
  }

  function _scheduleReconnect() {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
  }

  function _clearTimers() {
    clearInterval(_pingTimer);
    clearTimeout(_reconnectTimer);
    clearInterval(_reconciliationTimer);
    _pingTimer = null;
    _reconnectTimer = null;
    _reconciliationTimer = null;
    _isReconciling = false;
  }

  function destroy() {
    _destroyed = true;
    _clearTimers();
    if (_ws) { _ws.onclose = null; _ws.close(); _ws = null; }
  }

  function isConnected() { return _ws && _ws.readyState === WebSocket.OPEN; }
  function getCurrentPrice() { return _currentBtcPrice; }
  function getTargetPrice()  { return _targetBtcPrice; }
  function getDelta() {
    return (_currentBtcPrice !== null && _targetBtcPrice !== null)
      ? (_currentBtcPrice - _targetBtcPrice) : null;
  }

  return {
    connect,
    destroy,
    isConnected,
    setDurationSecs,
    getDurationSecs,
    checkAndRefreshWindow,
    resetForNewWindow,
    setVerifiedStrike,
    fetchOfficialTargetPrice,
    getCurrentPrice,
    getTargetPrice,
    getDelta,
    handlers,
  };
})();
