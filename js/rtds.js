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
  let _lastTimestamp = 0;

  const handlers = {
    onBtcPrice: null,
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
      try {
        const msg = JSON.parse(event.data);
        if (msg.topic === 'crypto_prices_chainlink') {
          const payload = msg.payload;
          if (payload && payload.symbol === 'btc/usd') {
            const price = typeof payload.value === 'number' ? payload.value : parseFloat(payload.value);
            const ts = payload.timestamp || msg.timestamp || Date.now();
            if (!isNaN(price) && price > 0) {
              _currentBtcPrice = price;
              _lastTimestamp = ts;
              if (handlers.onBtcPrice) {
                handlers.onBtcPrice(price, ts);
              }
            }
          }
        }
      } catch (err) {
        // ignore non-JSON or heartbeat acks
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
          filters: '',
        }
      ]
    };
    _ws.send(JSON.stringify(subMsg));
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

  function getLatestBtcPrice() {
    return _currentBtcPrice;
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
    handlers,
    destroy,
  };
})();
