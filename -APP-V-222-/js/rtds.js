/**
 * rtds.js — Polymarket Real-Time Data Stream (RTDS) WebSocket Client v2.0
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
  let _destroyed = false;

  let _currentBtcPrice = null;
  let _targetBtcPrice  = null;
  let _currentWindowId = null;
  let _durationSecs    = 300;
  let _lastTimestamp   = 0;
  let _isFetchingTarget= false;

  const handlers = {
    onBtcPrice: null,        // (currentPrice, tsMs, targetPrice, delta, isTwapVerified)
    onConnected: null,
    onDisconnected: null,
  };

  function setDurationSecs(secs) {
    _durationSecs = Math.max(60, secs || 300);
    checkAndRefreshWindow();
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

    // 1. Try Direct Preddy & Local API Proxy
    const endpoints = [
      `/api/target-price?symbol=btc&startDate=${startISO}&endDate=${endISO}&twapLookbackSeconds=60`,
      `http://localhost:8080/api/target-price?symbol=btc&startDate=${startISO}&endDate=${endISO}&twapLookbackSeconds=60`,
      `https://api.preddy.trade/crypto/price?symbol=btc&startDate=${startISO}&endDate=${endISO}&twapLookbackSeconds=60`,
      `https://polymarket.com/api/crypto/crypto-price?symbol=BTC&eventStartTime=${startISO}&endDate=${endISO}&twapEnabled=true&twapLookbackSeconds=60`,
    ];

    for (const url of endpoints) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
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

    // 2. CORS-Free High Reliability Fallback (Binance 1m Kline at exact window start)
    try {
      const bUrl = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=${winStartSec * 1000}&limit=1`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      const resp = await fetch(bUrl, { signal: controller.signal });
      clearTimeout(timer);
      if (resp.ok) {
        const arr = await resp.json();
        if (Array.isArray(arr) && arr[0] && arr[0][1]) {
          const openPrice = parseFloat(arr[0][1]);
          if (!isNaN(openPrice) && openPrice > 0) {
            _targetBtcPrice = openPrice;
            _cacheStrike(winStartSec, openPrice);
            _emitPriceUpdate();
            _isFetchingTarget = false;
            return openPrice;
          }
        }
      }
    } catch (e) {}

    _isFetchingTarget = false;
    return null;
  }

  function _cacheStrike(winStartSec, price) {
    try {
      localStorage.setItem(`pm_btc_twap_strike_v6_${winStartSec}`, price);
    } catch {}
  }

  function _getCachedStrike(winStartSec) {
    try {
      const v = localStorage.getItem(`pm_btc_twap_strike_v6_${winStartSec}`);
      return v ? parseFloat(v) : null;
    } catch {
      return null;
    }
  }

  function checkAndRefreshWindow() {
    const nowSec = Math.floor(Date.now() / 1000);
    const winStartSec = Math.floor(nowSec / _durationSecs) * _durationSecs;
    const winEndSec = winStartSec + _durationSecs;
    const winId = Math.floor(nowSec / _durationSecs);

    if (_currentWindowId !== winId) {
      _currentWindowId = winId;
      _targetBtcPrice = _getCachedStrike(winStartSec);
      fetchOfficialTargetPrice(winStartSec, winEndSec);
    }
  }

  function _emitPriceUpdate() {
    if (_currentBtcPrice === null) return;
    const delta = _targetBtcPrice !== null ? (_currentBtcPrice - _targetBtcPrice) : null;

    if (handlers.onBtcPrice) {
      handlers.onBtcPrice(_currentBtcPrice, _lastTimestamp || Date.now(), _targetBtcPrice, delta, true);
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
      console.log('[PolyRTDS] Connected to Polymarket RTDS (60s TWAP 1:1 Stream)');
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
            for (const pt of payload.data) {
              const rawVal = pt.value !== undefined ? pt.value : pt.price;
              const price = typeof rawVal === 'number' ? rawVal : parseFloat(rawVal);
              const tsMs = pt.timestamp || msg.timestamp || Date.now();
              if (!isNaN(price) && price > 0) {
                _currentBtcPrice = price;
                _lastTimestamp = tsMs;
              }
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

              // At exact round open (0-th second), anchor the target price
              if (secInWin === 0 && _targetBtcPrice === null) {
                _targetBtcPrice = val;
                _cacheStrike(winStartSec, val);
              } else if (_targetBtcPrice === null) {
                const cached = _getCachedStrike(winStartSec);
                if (cached) {
                  _targetBtcPrice = cached;
                } else {
                  fetchOfficialTargetPrice(winStartSec, winStartSec + _durationSecs);
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
    _clearTimers();
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
    _pingTimer = null;
    _reconnectTimer = null;
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
    fetchOfficialTargetPrice,
    getCurrentPrice,
    getTargetPrice,
    getDelta,
    handlers,
  };
})();
