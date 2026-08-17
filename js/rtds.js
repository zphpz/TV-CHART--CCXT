/**
 * rtds.js — Polymarket Real-Time Data Stream (RTDS) WebSocket Client
 * 
 * Connects directly to Polymarket's official RTDS stream:
 * wss://ws-live-data.polymarket.com
 * 
 * Topic: crypto_prices_chainlink (symbol: btc/usd)
 * Provides official, zero-delay Chainlink BTC/USD price feeds
 * used by Polymarket for market resolution. Zero reliance on Binance!
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

  const handlers = {
    onBtcPrice: null,        // (currentPrice, ts, targetPrice, delta)
    onConnected: null,
    onDisconnected: null,
  };

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
      console.log('[PolyRTDS] Connected to Polymarket RTDS (Chainlink Price Stream)');
      _subscribeChainlinkPrices();
      _startPing();
      if (handlers.onConnected) handlers.onConnected();
    };

    _ws.onmessage = (event) => {
      if (!event.data || !event.data.trim()) return;
      try {
        const msg = JSON.parse(event.data);
        if (msg.topic === 'crypto_prices_chainlink') {
          const payload = msg.payload || {};
          const points = Array.isArray(payload.data) ? payload.data : (payload.value !== undefined ? [payload] : []);

          for (const pt of points) {
            const rawVal = pt.value !== undefined ? pt.value : pt.price;
            const price = typeof rawVal === 'number' ? rawVal : parseFloat(rawVal);
            const tsMs = pt.timestamp || msg.timestamp || Date.now();
            const tsSec = Math.floor(tsMs / 1000);

            if (!isNaN(price) && price > 0) {
              _currentBtcPrice = price;
              _lastTimestamp = tsMs;

              const winId = Math.floor(tsSec / _durationSecs);
              const secInWin = tsSec % _durationSecs;

              if (_currentWindowId !== winId) {
                _currentWindowId = winId;
                // Only at the true beginning of the round (first 5 seconds) can a tick become the natural strike
                if (secInWin <= 5) {
                  _targetBtcPrice = price;
                  try {
                    localStorage.setItem(`pm_btc_strike_${winId * _durationSecs}`, price);
                  } catch {}
                } else {
                  _targetBtcPrice = null;
                }
              }

              // If opening mid-session and targetPrice not set yet, check local cache
              if (_targetBtcPrice === null) {
                try {
                  const cached = localStorage.getItem(`pm_btc_strike_${winId * _durationSecs}`);
                  if (cached) {
                    _targetBtcPrice = parseFloat(cached);
                  }
                } catch {}
              }

              const effStrike = _targetBtcPrice !== null ? _targetBtcPrice : price;
              const delta = _targetBtcPrice !== null ? (_currentBtcPrice - _targetBtcPrice) : 0;

              if (handlers.onBtcPrice) {
                handlers.onBtcPrice(_currentBtcPrice, tsMs, effStrike, delta);
              }
            }
          }
        }
      } catch (err) {
        // ignore non-JSON heartbeats
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

  function _subscribeChainlinkPrices() {
    if (!_ws || _ws.readyState !== WebSocket.OPEN) return;
    const subMsg = {
      action: 'subscribe',
      subscriptions: [
        {
          topic: 'crypto_prices_chainlink',
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

  function _clearTimers() {
    if (_pingTimer) clearInterval(_pingTimer);
    _pingTimer = null;
    if (_reconnectTimer) clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }

  function _scheduleReconnect() {
    if (_reconnectTimer || _destroyed) return;
    _reconnectTimer = setTimeout(() => {
      _reconnectTimer = null;
      connect();
    }, RECONNECT_DELAY_MS);
  }

  function setDuration(durationSecs) {
    _durationSecs = durationSecs || 300;
  }

  function setTargetPrice(targetPrice) {
    if (typeof targetPrice === 'number' && !isNaN(targetPrice) && targetPrice > 0) {
      _targetBtcPrice = targetPrice;
    }
  }

  function getLatestBtcPrice() {
    return _currentBtcPrice;
  }

  function getTargetBtcPrice() {
    return _targetBtcPrice;
  }

  function destroy() {
    _destroyed = true;
    _clearTimers();
    if (_ws) {
      _ws.close();
      _ws = null;
    }
  }

  return {
    connect,
    getLatestBtcPrice,
    getTargetBtcPrice,
    setTargetPrice,
    setDuration,
    handlers,
    destroy,
  };
})();
