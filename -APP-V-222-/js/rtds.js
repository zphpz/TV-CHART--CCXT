/**
 * rtds.js — Polymarket Real-Time Data Stream (RTDS) WebSocket Client v6.6
 * 
 * 1:1 Parity Engine:
 * - Topic: crypto_prices_twap_sixty (symbol: btc/usd) with type: "*"
 * - Official 60-second TWAP feed used by Polymarket for 5M/15M market resolution
 * - Accurate Target Price (openPrice) fetcher with multi-tier CORS/server fallback
 * - Real-time continuous Delta computation: (Live TWAP - Target Price)
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
  let _reconciliationTimeout = null;
  let _destroyed = false;

  let _currentBtcPrice = null;
  let _targetBtcPrice  = null;
  let _currentWindowId = null;
  let _durationSecs    = 300;
  let _lastTimestamp   = 0;
  let _isFetchingTarget= false;
  let _isOfficialStrikeVerified = false;
  let _isReconciling   = false;

  const handlers = {
    onBtcPrice: null,        // (currentPrice, tsMs, targetPrice, delta, isTwapVerified)
    onConnected: null,
    onDisconnected: null,
  };

  function setDurationSecs(secs) {
    const newDur = Math.max(60, secs || 300);
    if (_durationSecs !== newDur) {
      _durationSecs = newDur;
      _currentWindowId = null;
      _isOfficialStrikeVerified = false;
      checkAndRefreshWindow();
    }
  }

  function getDurationSecs() {
    return _durationSecs;
  }

  // ─── Target Price (OpenPrice / Strike) Multi-Tier Fetcher ─────────
  async function fetchOfficialTargetPrice(winStartSec, winEndSec) {
    if (!winStartSec) return null;
    const duration = (winEndSec && winEndSec > winStartSec) ? (winEndSec - winStartSec) : _durationSecs;
    const endSec = winEndSec || (winStartSec + duration);

    const startISO = new Date(winStartSec * 1000).toISOString().replace('.000Z', 'Z');
    const endISO = new Date(endSec * 1000).toISOString().replace('.000Z', 'Z');

    // 1. Direct Preddy & Local API Proxies (Strict 1:1 Polymarket Chainlink 60s TWAP Strike API)
    const endpoints = [
      `/api/target-price?symbol=btc&startDate=${startISO}&endDate=${endISO}&twapLookbackSeconds=60`,
      `http://localhost:8088/api/target-price?symbol=btc&startDate=${startISO}&endDate=${endISO}&twapLookbackSeconds=60`,
      `http://127.0.0.1:8088/api/target-price?symbol=btc&startDate=${startISO}&endDate=${endISO}&twapLookbackSeconds=60`,
      `https://api.preddy.trade/crypto/price?symbol=btc&startDate=${startISO}&endDate=${endISO}&twapLookbackSeconds=60`,
    ];

    for (const url of endpoints) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2500);
        const resp = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: controller.signal });
        clearTimeout(timer);
        if (resp.ok) {
          const data = await resp.json();
          const openPrice = typeof data.openPrice === 'number' ? data.openPrice : parseFloat(data.openPrice);
          if (!isNaN(openPrice) && openPrice > 0) {
            _targetBtcPrice = openPrice;
            _cacheStrike(winStartSec, openPrice);
            _emitPriceUpdate();
            _isFetchingTarget = false;
            return openPrice;
          }
        }
      } catch (e) {}
    }

    _isFetchingTarget = false;
    return null;
  }

  function _cacheStrike(winStartSec, price) {
    try {
      localStorage.setItem(`pm_btc_twap_strike_v7_${winStartSec}`, price);
    } catch {}
  }

  function _getCachedStrike(winStartSec) {
    try {
      const v = localStorage.getItem(`pm_btc_twap_strike_v7_${winStartSec}`);
      return v ? parseFloat(v) : null;
    } catch {
      return null;
    }
  }

  function _stopReconciliation() {
    if (_reconciliationTimer) {
      clearInterval(_reconciliationTimer);
      _reconciliationTimer = null;
    }
    if (_reconciliationTimeout) {
      clearTimeout(_reconciliationTimeout);
      _reconciliationTimeout = null;
    }
    _isReconciling = false;
  }

  function _startFastStrikeReconciliation(winStartSec) {
    _stopReconciliation();
    if (!winStartSec) return;

    let attempts = 0;
    const maxAttempts = 15; // Fast polling: 15 attempts * 2.5s = ~37s

    const poll = async () => {
      if (_destroyed || _isOfficialStrikeVerified || attempts >= maxAttempts) {
        _stopReconciliation();
        return;
      }
      if (_isReconciling) return;
      _isReconciling = true;
      attempts++;

      try {
        const endSec = winStartSec + _durationSecs;
        const officialPrice = await fetchOfficialTargetPrice(winStartSec, endSec);
        if (officialPrice !== null && !isNaN(officialPrice) && officialPrice > 0) {
          _targetBtcPrice = officialPrice;
          _isOfficialStrikeVerified = true;
          _cacheStrike(winStartSec, officialPrice);
          _emitPriceUpdate();
          _stopReconciliation();
          return;
        }
      } catch (err) {
        // network retry
      } finally {
        _isReconciling = false;
      }

      if (attempts >= maxAttempts) {
        _stopReconciliation();
      }
    };

    // Fast initial check after 1.2s, then interval loop
    _reconciliationTimeout = setTimeout(() => {
      poll();
      if (!_isOfficialStrikeVerified && !_destroyed) {
        _reconciliationTimer = setInterval(poll, 2500);
      }
    }, 1200);
  }

  function checkAndRefreshWindow() {
    const nowSec = _lastTimestamp > 0 ? Math.floor(_lastTimestamp / 1000) : Math.floor(Date.now() / 1000);
    const winStartSec = Math.floor(nowSec / _durationSecs) * _durationSecs;
    const winId = Math.floor(nowSec / _durationSecs);

    if (_currentWindowId !== winId) {
      _currentWindowId = winId;
      _isOfficialStrikeVerified = false;
      _targetBtcPrice = _getCachedStrike(winStartSec);
      if (_targetBtcPrice === null) {
        _startFastStrikeReconciliation(winStartSec);
      }
    }
  }

  function resetForNewWindow(winStartSec) {
    if (!winStartSec) {
      const nowSec = _lastTimestamp > 0 ? Math.floor(_lastTimestamp / 1000) : Math.floor(Date.now() / 1000);
      winStartSec = Math.floor(nowSec / _durationSecs) * _durationSecs;
    }
    _currentWindowId = Math.floor(winStartSec / _durationSecs);
    _isOfficialStrikeVerified = false;
    _targetBtcPrice = _getCachedStrike(winStartSec);
    _startFastStrikeReconciliation(winStartSec);
  }

  function _emitPriceUpdate() {
    if (_currentBtcPrice === null) return;
    const delta = _targetBtcPrice !== null ? (_currentBtcPrice - _targetBtcPrice) : null;

    if (handlers.onBtcPrice) {
      handlers.onBtcPrice(_currentBtcPrice, _lastTimestamp || Date.now(), _targetBtcPrice, delta, Boolean(_isOfficialStrikeVerified));
    }
  }

  // ─── WebSocket Stream ─────────────────────────────────────────────
  function connect() {
    if (_destroyed) return;
    if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      _ws = new WebSocket(WS_URL);
    } catch (e) {
      console.error('[PolyRTDS] Connection error:', e);
      _scheduleReconnect();
      return;
    }

    _ws.onopen = () => {
      console.log('[PolyRTDS] Connected to Polymarket RTDS (60s TWAP 1:1 Stream v6.6)');
      _subscribeTwapPrices();
      _startPing();
      checkAndRefreshWindow();
      if (handlers.onConnected) handlers.onConnected();
    };

    _ws.onmessage = (event) => {
      if (!event.data || !event.data.trim()) return;
      try {
        const msg = JSON.parse(event.data);
        const topic = msg.topic;

        if (topic === 'crypto_prices_twap_sixty' || topic === 'crypto_prices_chainlink') {
          const payload = msg.payload || {};

          // 1. Batch historical points on initial connection
          if (Array.isArray(payload.data) && payload.data.length > 0) {
            const nowSec = Math.floor(Date.now() / 1000);
            const winStartSec = Math.floor(nowSec / _durationSecs) * _durationSecs;
            let strikeCandidate = null;
            let minDiff = Infinity;
            let latestPrice = null;
            let maxTsMs = 0;

            for (const pt of payload.data) {
              const rawVal = pt.value !== undefined ? pt.value : pt.price;
              const price = typeof rawVal === 'number' ? rawVal : parseFloat(rawVal);
              const tsMs = pt.timestamp || msg.timestamp || Date.now();
              const ptSec = Math.floor(tsMs / 1000);

              if (!isNaN(price) && price > 0) {
                if (tsMs >= maxTsMs) {
                  maxTsMs = tsMs;
                  latestPrice = price;
                }

                // Strict boundary check: strike MUST be at or after winStartSec (never previous round!)
                if (ptSec >= winStartSec) {
                  const diff = ptSec - winStartSec;
                  if (diff < minDiff && diff <= 5) {
                    minDiff = diff;
                    strikeCandidate = price;
                  }
                }
              }
            }

            if (latestPrice !== null) {
              _currentBtcPrice = latestPrice;
              _lastTimestamp = maxTsMs || Date.now();
            }

            if (strikeCandidate !== null) {
              _targetBtcPrice = strikeCandidate;
              _isOfficialStrikeVerified = true;
              _cacheStrike(winStartSec, strikeCandidate);
              _stopReconciliation();
            }

            _emitPriceUpdate();
          }

          // 2. Single live tick (every second)
          if (payload.value !== undefined && payload.value !== null) {
            const val = typeof payload.value === 'number' ? payload.value : parseFloat(payload.value);
            if (!isNaN(val) && val > 0) {
              _currentBtcPrice = val;
              _lastTimestamp = payload.timestamp || msg.timestamp || Date.now();

              const nowSec = Math.floor(_lastTimestamp / 1000);
              const winStartSec = Math.floor(nowSec / _durationSecs) * _durationSecs;
              const secInWin = nowSec % _durationSecs;

              // At exact round open (0-th second), anchor the initial target price directly from live RTDS
              if (secInWin === 0) {
                _targetBtcPrice = val;
                _cacheStrike(winStartSec, val);
                _isOfficialStrikeVerified = false;
                _startFastStrikeReconciliation(winStartSec);
              } else if (_targetBtcPrice === null) {
                const cached = _getCachedStrike(winStartSec);
                if (cached) {
                  _targetBtcPrice = cached;
                } else {
                  _startFastStrikeReconciliation(winStartSec);
                }
              }

              _emitPriceUpdate();
            }
          }
        }
      } catch (err) {
        // non-JSON heartbeats ignored
      }
    };

    _ws.onerror = (err) => {
      console.warn('[PolyRTDS] WebSocket error:', err);
    };

    _ws.onclose = () => {
      _clearTimers();
      if (handlers.onDisconnected) handlers.onDisconnected();
      if (!_destroyed) _scheduleReconnect();
    };
  }

  function _subscribeTwapPrices() {
    if (!_ws || _ws.readyState !== WebSocket.OPEN) return;
    const subMsg = {
      action: 'subscribe',
      subscriptions: [
        {
          topic: 'crypto_prices_twap_sixty',
          type: '*',
          filters: JSON.stringify({ symbol: 'btc/usd' }),
        }
      ]
    };
    try {
      _ws.send(JSON.stringify(subMsg));
    } catch {}
  }

  function _startPing() {
    clearInterval(_pingTimer);
    _pingTimer = setInterval(() => {
      if (_ws && _ws.readyState === WebSocket.OPEN) {
        try {
          _ws.send(JSON.stringify({ action: 'ping' }));
        } catch {}
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
    clearTimeout(_reconciliationTimeout);
    _pingTimer = null;
    _reconnectTimer = null;
    _reconciliationTimer = null;
    _reconciliationTimeout = null;
    _isReconciling = false;
  }

  function destroy() {
    _destroyed = true;
    _clearTimers();
    if (_ws) {
      _ws.onclose = null;
      _ws.close();
      _ws = null;
    }
  }

  function isConnected() {
    return _ws && _ws.readyState === WebSocket.OPEN;
  }

  function getCurrentPrice() { return _currentBtcPrice; }
  function getTargetPrice()  { return _targetBtcPrice; }
  function getDelta()        { return (_currentBtcPrice !== null && _targetBtcPrice !== null) ? (_currentBtcPrice - _targetBtcPrice) : null; }

  return {
    connect,
    destroy,
    isConnected,
    setDurationSecs,
    getDurationSecs,
    checkAndRefreshWindow,
    resetForNewWindow,
    fetchOfficialTargetPrice,
    getCurrentPrice,
    getTargetPrice,
    getDelta,
    handlers,
  };
})();
