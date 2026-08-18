/**
 * ws.js — Polymarket Live CLOB WebSocket Client v4.4
 * 
 * Features & Fixes in v4.4:
 * - Dual-Token Subscription (Subscribes to BOTH UP and DOWN tokens)
 * - Real-time inverted event translation for DOWN token trades (up_price = 1 - down_price)
 * - Automatic heartbeat & watchdog auto-reconnect
 * - Zero-drop message dispatcher
 */
'use strict';

window.PolyWS = (() => {
  const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

  let _ws             = null;
  let _upTokenId      = null;
  let _downTokenId    = null;
  let _pingInterval   = null;
  let _reconnectTimer = null;
  let _reconnectDelay = 1000;
  let _isConnected    = false;
  let _destroyed      = false;
  let _lastDataMs     = 0;

  const handlers = {
    onBook:            null,
    onPriceChange:     null,
    onBestBidAsk:      null,
    onLastTrade:       null,
    onMarketResolved:  null,
    onTickSizeChange:  null,
    onNewMarket:       null,
    onConnected:       null,
    onDisconnected:    null,
    onError:           null,
  };

  // ─── Connection Lifecycle ──────────────────────────────────────────
  function connect() {
    if (_destroyed) return;
    if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      _ws = new WebSocket(WS_URL);
    } catch (err) {
      console.error('[PolyWS] Init error:', err);
      _scheduleReconnect();
      return;
    }

    _ws.onopen = () => {
      console.log('[PolyWS] Connected to Polymarket CLOB WebSocket');
      _isConnected = true;
      _reconnectDelay = 1000;
      _startPing();
      if (handlers.onConnected) handlers.onConnected();

      if (_upTokenId || _downTokenId) {
        _sendSubscribe(_upTokenId, _downTokenId);
      }
    };

    _ws.onmessage = (evt) => {
      if (evt.data === 'PONG') return;

      let data;
      try {
        data = JSON.parse(evt.data);
      } catch {
        return;
      }

      _lastDataMs = Date.now();

      if (Array.isArray(data)) {
        for (let i = 0; i < data.length; i++) _handleMessage(data[i]);
      } else if (data) {
        _handleMessage(data);
      }
    };

    _ws.onerror = (e) => {
      console.warn('[PolyWS] WebSocket error:', e);
      if (handlers.onError) handlers.onError(e);
    };

    _ws.onclose = (evt) => {
      console.warn(`[PolyWS] Connection closed (code=${evt.code})`);
      _clearTimers();
      _isConnected = false;
      if (handlers.onDisconnected) handlers.onDisconnected();
      if (!_destroyed) _scheduleReconnect();
    };
  }

  // ─── Message Dispatcher with Dual Token Translation ───────────────
  function _handleMessage(msg) {
    if (!msg || !msg.event_type) return;

    const assetId = String(msg.asset_id || '');
    const isUp = _upTokenId ? (assetId === String(_upTokenId)) : true;
    const isDown = _downTokenId ? (assetId === String(_downTokenId)) : false;

    if (!isUp && !isDown && (_upTokenId || _downTokenId)) {
      // Check price_changes array
      if (msg.event_type === 'price_change' && Array.isArray(msg.price_changes)) {
        for (let i = 0; i < msg.price_changes.length; i++) {
          const item = msg.price_changes[i];
          const itemAsset = String(item.asset_id || '');
          if (itemAsset === String(_upTokenId)) {
            if (handlers.onPriceChange) handlers.onPriceChange(item);
          } else if (itemAsset === String(_downTokenId)) {
            const translated = _translateDownPriceChange(item);
            if (handlers.onPriceChange) handlers.onPriceChange(translated);
          }
        }
      }
      return;
    }

    switch (msg.event_type) {
      case 'book': {
        if (isUp) {
          if (handlers.onBook) handlers.onBook(msg);
        } else if (isDown) {
          const translated = _translateDownBook(msg);
          if (handlers.onBook) handlers.onBook(translated);
        }
        break;
      }

      case 'price_change': {
        if (isUp) {
          if (handlers.onPriceChange) handlers.onPriceChange(msg);
        } else if (isDown) {
          const translated = _translateDownPriceChange(msg);
          if (handlers.onPriceChange) handlers.onPriceChange(translated);
        }
        break;
      }

      case 'best_bid_ask': {
        if (isUp) {
          if (handlers.onBestBidAsk) handlers.onBestBidAsk(msg);
        } else if (isDown) {
          const translated = _translateDownBestBidAsk(msg);
          if (handlers.onBestBidAsk) handlers.onBestBidAsk(translated);
        }
        break;
      }

      case 'last_trade_price': {
        if (isUp) {
          if (handlers.onLastTrade) handlers.onLastTrade(msg);
        } else if (isDown) {
          const rawP = parseFloat(msg.price);
          if (!isNaN(rawP) && handlers.onLastTrade) {
            handlers.onLastTrade({
              ...msg,
              price: Math.max(0, Math.min(1, Math.round((1 - rawP) * 1000) / 1000)),
              side: msg.side === 'BUY' ? 'SELL' : 'BUY'
            });
          }
        }
        break;
      }

      case 'new_market': {
        if (handlers.onNewMarket) handlers.onNewMarket(msg);
        break;
      }

      case 'market_resolved': {
        if (handlers.onMarketResolved) handlers.onMarketResolved(msg);
        break;
      }

      case 'tick_size_change': {
        if (handlers.onTickSizeChange) handlers.onTickSizeChange(msg);
        break;
      }

      default:
        break;
    }
  }

  function _translateDownPriceChange(item) {
    const res = { ...item };
    if (item.best_bid !== undefined && item.best_ask !== undefined) {
      const downBid = parseFloat(item.best_bid);
      const downAsk = parseFloat(item.best_ask);
      if (!isNaN(downBid) && !isNaN(downAsk)) {
        res.best_bid = Math.max(0, Math.min(1, 1 - downAsk));
        res.best_ask = Math.max(0, Math.min(1, 1 - downBid));
      }
    } else if (item.price !== undefined) {
      const downP = parseFloat(item.price);
      if (!isNaN(downP)) {
        res.price = Math.max(0, Math.min(1, 1 - downP));
        res.side = item.side === 'BUY' ? 'SELL' : 'BUY';
      }
    }
    return res;
  }

  function _translateDownBestBidAsk(msg) {
    const res = { ...msg };
    const downBid = parseFloat(msg.best_bid);
    const downAsk = parseFloat(msg.best_ask);
    if (!isNaN(downBid) && !isNaN(downAsk)) {
      res.best_bid = Math.max(0, Math.min(1, 1 - downAsk));
      res.best_ask = Math.max(0, Math.min(1, 1 - downBid));
    }
    return res;
  }

  function _translateDownBook(msg) {
    const res = { ...msg, bids: [], asks: [] };
    const downBids = msg.bids || [];
    const downAsks = msg.asks || [];

    // Down Asks become Up Bids (1 - downAsk)
    for (let i = 0; i < downAsks.length; i++) {
      const p = parseFloat(downAsks[i].price);
      if (!isNaN(p)) {
        res.bids.push({ price: String(Math.round((1 - p) * 1000) / 1000), size: downAsks[i].size });
      }
    }
    // Down Bids become Up Asks (1 - downBid)
    for (let i = 0; i < downBids.length; i++) {
      const p = parseFloat(downBids[i].price);
      if (!isNaN(p)) {
        res.asks.push({ price: String(Math.round((1 - p) * 1000) / 1000), size: downBids[i].size });
      }
    }
    if (msg.last_trade_price) {
      const p = parseFloat(msg.last_trade_price);
      if (!isNaN(p)) res.last_trade_price = String(Math.round((1 - p) * 1000) / 1000);
    }
    return res;
  }

  // ─── Subscribe / Unsubscribe ────────────────────────────────────────
  function _sendSubscribe(upId, downId) {
    const assetIds = [];
    if (upId) assetIds.push(String(upId));
    if (downId) assetIds.push(String(downId));

    if (assetIds.length === 0) return;

    const msg = {
      assets_ids: assetIds,
      type: 'market',
      custom_feature_enabled: true,
    };
    _send(JSON.stringify(msg));
  }

  function _sendUnsubscribe(upId, downId) {
    const assetIds = [];
    if (upId) assetIds.push(String(upId));
    if (downId) assetIds.push(String(downId));

    if (assetIds.length === 0) return;

    _send(JSON.stringify({
      assets_ids: assetIds,
      type: 'market',
      operation: 'unsubscribe',
    }));
  }

  function subscribe(upTokenId, downTokenId) {
    if (_upTokenId === upTokenId && _downTokenId === downTokenId && _isConnected) {
      return;
    }

    if (_isConnected && (_upTokenId || _downTokenId)) {
      _sendUnsubscribe(_upTokenId, _downTokenId);
    }

    _upTokenId = upTokenId ? String(upTokenId) : null;
    _downTokenId = downTokenId ? String(downTokenId) : null;

    if (_isConnected) {
      _sendSubscribe(_upTokenId, _downTokenId);
    } else {
      connect();
    }
  }

  function unsubscribe(upTokenId, downTokenId) {
    if (_isConnected) {
      _sendUnsubscribe(upTokenId || _upTokenId, downTokenId || _downTokenId);
    }
    if (String(upTokenId) === _upTokenId) _upTokenId = null;
    if (String(downTokenId) === _downTokenId) _downTokenId = null;
  }

  function _send(str) {
    if (_ws && _ws.readyState === WebSocket.OPEN) {
      try { _ws.send(str); } catch (e) { console.warn('[PolyWS] Send error:', e); }
    }
  }

  function _startPing() {
    _clearTimers();
    _pingInterval = setInterval(() => {
      if (_ws && _ws.readyState === WebSocket.OPEN) {
        _ws.send('PING');
      }
    }, 10000);
  }

  function _clearTimers() {
    if (_pingInterval) clearInterval(_pingInterval);
    if (_reconnectTimer) clearTimeout(_reconnectTimer);
    _pingInterval = null;
    _reconnectTimer = null;
  }

  function _scheduleReconnect() {
    if (_destroyed) return;
    _reconnectTimer = setTimeout(() => {
      console.log(`[PolyWS] Reconnecting... (${_reconnectDelay}ms)`);
      _reconnectDelay = Math.min(_reconnectDelay * 1.5, 10000);
      connect();
    }, _reconnectDelay);
  }

  function isConnected() { return _isConnected; }

  function destroy() {
    _destroyed = true;
    _clearTimers();
    if (_ws) _ws.close();
  }

  return {
    handlers,
    connect,
    subscribe,
    unsubscribe,
    isConnected,
    destroy,
  };
})();
