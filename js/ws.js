/**
 * ws.js — Polymarket CLOB WebSocket client
 * 
 * Features:
 * - Connect to wss://ws-subscriptions-clob.polymarket.com/ws/market
 * - Subscribe by asset_id (token ID)
 * - Dynamic subscribe/unsubscribe without reconnect
 * - PING every 10s (text frame "PING")
 * - Exponential backoff reconnect (1s → 30s max)
 * - WATCHDOG: 15s silence → force reconnect (zombie connection detection!)
 * - Dispatches: onBook, onPriceChange, onLastTrade, onBestBidAsk, onNewMarket, onMarketResolved
 */
'use strict';

window.PolyWS = (() => {
  const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
  const PING_INTERVAL_MS  = 10_000;  // 10 seconds
  const WATCHDOG_MS       = 15_000;  // 15 seconds silence = zombie
  const MAX_RECONNECT_MS  = 30_000;
  const BASE_RECONNECT_MS = 1_000;

  let _ws              = null;
  let _currentTokenId  = null;  // active subscribed token
  let _pingTimer       = null;
  let _watchdogTimer   = null;
  let _reconnectTimer  = null;
  let _reconnectAttempt = 0;
  let _destroyed       = false;
  let _lastDataMs      = 0;

  // Event handlers (set by caller)
  const handlers = {
    onBook:           null,
    onPriceChange:    null,
    onLastTrade:      null,
    onBestBidAsk:     null,
    onNewMarket:      null,
    onMarketResolved: null,
    onTickSizeChange: null,
    onConnected:      null,
    onDisconnected:   null,
    onError:          null,
  };

  // ─── Connect ────────────────────────────────────────────────────────
  function connect() {
    if (_destroyed) return;
    
    try {
      _ws = new WebSocket(WS_URL);
    } catch (e) {
      console.error('[PolyWS] WebSocket creation failed:', e);
      _scheduleReconnect();
      return;
    }

    _ws.onopen = () => {
      console.log('[PolyWS] Connected');
      _reconnectAttempt = 0;
      _lastDataMs = Date.now();

      // Subscribe to current token if we have one
      if (_currentTokenId) {
        _sendSubscribe(_currentTokenId);
      }

      _startPing();
      _startWatchdog();

      if (handlers.onConnected) handlers.onConnected();
    };

    _ws.onmessage = (evt) => {
      // Handle PONG
      if (evt.data === 'PONG') {
        _lastDataMs = Date.now();
        return;
      }

      let data;
      try {
        data = JSON.parse(evt.data);
      } catch {
        return;
      }

      // Reset watchdog on any data
      _lastDataMs = Date.now();
      _resetWatchdog();

      // Handle array or single message
      if (Array.isArray(data)) {
        data.forEach(_handleMessage);
      } else if (data) {
        _handleMessage(data);
      }
    };

    _ws.onerror = (e) => {
      console.warn('[PolyWS] WebSocket error');
      if (handlers.onError) handlers.onError(e);
    };

    _ws.onclose = (evt) => {
      console.warn(`[PolyWS] Connection closed: code=${evt.code}`);
      _clearTimers();
      if (handlers.onDisconnected) handlers.onDisconnected();
      if (!_destroyed) _scheduleReconnect();
    };
  }

  // ─── Message dispatcher ─────────────────────────────────────────────
  function _handleMessage(msg) {
    if (!msg || !msg.event_type) return;

    // Security: ignore messages from wrong token
    if (msg.asset_id && _currentTokenId && msg.asset_id !== _currentTokenId) {
      return;
    }

    switch (msg.event_type) {
      case 'book':
        if (handlers.onBook) handlers.onBook(msg);
        break;
      case 'price_change':
        if (handlers.onPriceChange) handlers.onPriceChange(msg);
        break;
      case 'last_trade_price':
        if (handlers.onLastTrade) handlers.onLastTrade(msg);
        break;
      case 'best_bid_ask':
        if (handlers.onBestBidAsk) handlers.onBestBidAsk(msg);
        break;
      case 'new_market':
        if (handlers.onNewMarket) handlers.onNewMarket(msg);
        break;
      case 'market_resolved':
        if (handlers.onMarketResolved) handlers.onMarketResolved(msg);
        break;
      case 'tick_size_change':
        if (handlers.onTickSizeChange) handlers.onTickSizeChange(msg);
        break;
      default:
        // Unknown event — ignore
        break;
    }
  }

  // ─── Subscribe / Unsubscribe ────────────────────────────────────────
  function _sendSubscribe(tokenId, useCustomFeature = true) {
    const msg = {
      assets_ids: [tokenId],
      type: 'market',
    };
    if (useCustomFeature) {
      msg.custom_feature_enabled = true; // enables: best_bid_ask, new_market, market_resolved
    }
    _send(JSON.stringify(msg));
  }

  function _sendUnsubscribe(tokenId) {
    _send(JSON.stringify({
      assets_ids: [tokenId],
      type: 'market',
      operation: 'unsubscribe',
    }));
  }

  /**
   * Subscribe to a new token. Unsubscribes from previous if needed.
   * Does NOT reconnect the WebSocket — sends new subscribe frame.
   */
  function subscribe(newTokenId) {
    const prev = _currentTokenId;
    _currentTokenId = newTokenId;

    if (_ws && _ws.readyState === WebSocket.OPEN) {
      if (prev && prev !== newTokenId) {
        _sendUnsubscribe(prev);
      }
      _sendSubscribe(newTokenId);
    } else {
      // Not connected — will subscribe on reconnect
      if (!_ws || _ws.readyState === WebSocket.CLOSED) {
        connect();
      }
    }
  }

  // ─── Send helper ────────────────────────────────────────────────────
  function _send(data) {
    if (_ws && _ws.readyState === WebSocket.OPEN) {
      try {
        _ws.send(data);
      } catch (e) {
        console.warn('[PolyWS] Send failed:', e);
      }
    }
  }

  // ─── Ping / Pong ────────────────────────────────────────────────────
  function _startPing() {
    clearInterval(_pingTimer);
    _pingTimer = setInterval(() => {
      if (_ws && _ws.readyState === WebSocket.OPEN) {
        _ws.send('PING'); // Must be text, not JSON!
      }
    }, PING_INTERVAL_MS);
  }

  // ─── Watchdog ───────────────────────────────────────────────────────
  // Detects "zombie" connections: open but no data for 15+ seconds
  function _startWatchdog() {
    clearInterval(_watchdogTimer);
    _lastDataMs = Date.now();
    _watchdogTimer = setInterval(() => {
      const silence = Date.now() - _lastDataMs;
      if (silence > WATCHDOG_MS) {
        console.warn(`[PolyWS] Watchdog triggered: ${Math.round(silence / 1000)}s of silence. Forcing reconnect.`);
        if (_ws) _ws.close();
      }
    }, 5000);
  }

  function _resetWatchdog() {
    // Called on every real message — watchdog timer doesn't need explicit reset
    // because we just update _lastDataMs
  }

  // ─── Reconnect ──────────────────────────────────────────────────────
  function _scheduleReconnect() {
    clearTimeout(_reconnectTimer);
    const delay = Math.min(BASE_RECONNECT_MS * Math.pow(2, _reconnectAttempt), MAX_RECONNECT_MS);
    _reconnectAttempt++;
    console.log(`[PolyWS] Reconnecting in ${delay}ms (attempt ${_reconnectAttempt})`);
    _reconnectTimer = setTimeout(connect, delay);
  }

  function _clearTimers() {
    clearInterval(_pingTimer);
    clearInterval(_watchdogTimer);
    clearTimeout(_reconnectTimer);
    _pingTimer = null;
    _watchdogTimer = null;
    _reconnectTimer = null;
  }

  // ─── Cleanup ────────────────────────────────────────────────────────
  function destroy() {
    _destroyed = true;
    _clearTimers();
    if (_ws) {
      _ws.onclose = null; // prevent reconnect
      _ws.close();
      _ws = null;
    }
  }

  // ─── Status ─────────────────────────────────────────────────────────
  function isConnected() {
    return _ws && _ws.readyState === WebSocket.OPEN;
  }

  function getStatus() {
    if (!_ws) return 'disconnected';
    switch (_ws.readyState) {
      case WebSocket.CONNECTING: return 'connecting';
      case WebSocket.OPEN:       return 'connected';
      case WebSocket.CLOSING:    return 'closing';
      case WebSocket.CLOSED:     return 'disconnected';
      default: return 'unknown';
    }
  }

  function getLastDataAge() {
    return _lastDataMs ? Date.now() - _lastDataMs : null;
  }

  function getCurrentTokenId() { return _currentTokenId; }

  return {
    connect,
    subscribe,
    destroy,
    isConnected,
    getStatus,
    getLastDataAge,
    getCurrentTokenId,
    handlers,
  };
})();
