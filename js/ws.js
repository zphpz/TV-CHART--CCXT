/**
 * ws.js — Polymarket CLOB WebSocket client v1.1
 *
 * FIX v1.1: The old version blocked messages from new token after rollover
 * because _currentTokenId was checked against msg.asset_id before subscribe
 * completed. Now clearTokenFilter() must be called before subscribe().
 *
 * Features:
 * - Connect to wss://ws-subscriptions-clob.polymarket.com/ws/market
 * - Subscribe by asset_id (token ID)
 * - Dynamic subscribe/unsubscribe without reconnect
 * - PING every 10s (text frame "PING")
 * - Exponential backoff reconnect (1s → 30s max)
 * - WATCHDOG: 15s silence → force reconnect (zombie connection detection!)
 */
'use strict';

window.PolyWS = (() => {
  const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
  const PING_INTERVAL_MS  = 10_000;
  const WATCHDOG_MS       = 15_000;
  const MAX_RECONNECT_MS  = 30_000;
  const BASE_RECONNECT_MS = 1_000;

  let _ws              = null;
  let _currentTokenId  = null;
  let _pingTimer       = null;
  let _watchdogTimer   = null;
  let _reconnectTimer  = null;
  let _reconnectAttempt = 0;
  let _destroyed       = false;
  let _lastDataMs      = 0;

  // Event handlers
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

      if (_currentTokenId) {
        _sendSubscribe(_currentTokenId);
      }

      _startPing();
      _startWatchdog();

      if (handlers.onConnected) handlers.onConnected();
    };

    _ws.onmessage = (evt) => {
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

      _lastDataMs = Date.now();

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

    // FIX: Only filter if we have a token set AND the message has an asset_id.
    // During rollover, _currentTokenId is briefly null (cleared) before new subscribe.
    // Also allow messages with no asset_id (they may be market lifecycle events).
    if (msg.asset_id && _currentTokenId && msg.asset_id !== _currentTokenId) {
      return; // message is for a token we don't care about (e.g., old token lingering)
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
      msg.custom_feature_enabled = true;
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
   * FIX: clearTokenFilter must be called BEFORE subscribe() during rollover.
   * This prevents the message filter from blocking messages from the new token
   * during the brief window when both old and new tokens are being switched.
   */
  let _subscribedTokenId = null;

  function clearTokenFilter() {
    _currentTokenId = null;
  }

  /**
   * Subscribe to a new token. Unsubscribes from previous if needed.
   */
  function subscribe(newTokenId) {
    if (!newTokenId) return;
    const prev = _subscribedTokenId;
    _subscribedTokenId = newTokenId;
    _currentTokenId = newTokenId;

    if (_ws && _ws.readyState === WebSocket.OPEN) {
      if (prev && prev !== newTokenId) {
        console.log('[PolyWS] Unsubscribing from old token:', prev);
        _sendUnsubscribe(prev);
      }
      console.log('[PolyWS] Subscribing to new token:', newTokenId);
      _sendSubscribe(newTokenId);
    } else {
      if (!_ws || _ws.readyState === WebSocket.CLOSED) {
        connect();
      }
    }
  }

  // ─── Send ────────────────────────────────────────────────────────────
  function _send(data) {
    if (_ws && _ws.readyState === WebSocket.OPEN) {
      try { _ws.send(data); } catch (e) { console.warn('[PolyWS] Send failed:', e); }
    }
  }

  // ─── Ping ────────────────────────────────────────────────────────────
  function _startPing() {
    clearInterval(_pingTimer);
    _pingTimer = setInterval(() => {
      if (_ws && _ws.readyState === WebSocket.OPEN) {
        _ws.send('PING');
      }
    }, PING_INTERVAL_MS);
  }

  // ─── Watchdog ────────────────────────────────────────────────────────
  function _startWatchdog() {
    clearInterval(_watchdogTimer);
    _lastDataMs = Date.now();
    _watchdogTimer = setInterval(() => {
      const silence = Date.now() - _lastDataMs;
      if (silence > WATCHDOG_MS) {
        console.warn(`[PolyWS] Watchdog: ${Math.round(silence / 1000)}s silence → reconnect`);
        if (_ws) _ws.close();
      }
    }, 5000);
  }

  // ─── Reconnect ───────────────────────────────────────────────────────
  function _scheduleReconnect() {
    clearTimeout(_reconnectTimer);
    const delay = Math.min(BASE_RECONNECT_MS * Math.pow(2, _reconnectAttempt), MAX_RECONNECT_MS);
    _reconnectAttempt++;
    console.log(`[PolyWS] Reconnect in ${delay}ms (attempt ${_reconnectAttempt})`);
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

  // ─── Cleanup ─────────────────────────────────────────────────────────
  function destroy() {
    _destroyed = true;
    _clearTimers();
    if (_ws) {
      _ws.onclose = null;
      _ws.close();
      _ws = null;
    }
  }

  // ─── Status ──────────────────────────────────────────────────────────
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
    clearTokenFilter,
    destroy,
    isConnected,
    getStatus,
    getLastDataAge,
    getCurrentTokenId,
    handlers,
  };
})();
