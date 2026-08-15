/**
 * app.js — Main Application Coordinator v1.3
 * 
 * Orchestrates: MarketManager, PolyWS, TickBuffer, PriceEngine, ChartManager
 * Features:
 * - Real-time Polymarket order book & price feeds
 * - Clean switching between 5M and 15M markets with full unsubscription
 * - UP / DOWN outcome toggle with inverted probability math
 * - Automated 5m/15m rollover with watchdog safeguard
 * - Centered large countdown timer with urgency state
 */
'use strict';

(async function AppMain() {
  const $ = id => document.getElementById(id);

  const el = {
    chartContainer:    $('chart-container'),
    loadingOverlay:    $('loading-overlay'),
    loadingSub:        $('loading-sub'),
    errorOverlay:      $('error-overlay'),
    errorText:         $('error-text'),

    statusIndicator:   $('status-indicator'),
    statusText:        $('status-text'),
    timerValue:        $('timer-value'),

    priceCurrent:      $('price-current'),
    priceBid:          $('price-bid'),
    priceAsk:          $('price-ask'),
    priceMid:          $('price-mid'),
    priceLast:         $('price-last'),
    priceSpread:       $('price-spread'),
    priceAge:          $('price-age'),

    marketSlug:        $('market-slug-display'),
    marketWindow:      $('market-window-display'),
    marketCount:       $('market-count-display'),

    btnMkt5m:          $('btn-mkt-5m'),
    btnMkt15m:         $('btn-mkt-15m'),
    btnOutcomeUp:      $('btn-outcome-up'),
    btnOutcomeDown:    $('btn-outcome-down'),
    btnResetZoom:      $('btn-reset-zoom'),
    btnRetry:          $('btn-retry'),
  };

  // ─── App State ────────────────────────────────────────────────────
  let _currentTfMinutes  = 5;      // 5 or 15 minutes market
  let _currentTfSeconds  = 1;      // 1s / 5s / 15s / 30s / 60s chart TF
  let _isInitialized     = false;
  let _marketSwitchCount = 0;
  let _loadingRetries    = 0;
  let _outcomeMode       = 'up';   // 'up' | 'down'

  // ─── Init Chart ───────────────────────────────────────────────────
  const chartOk = ChartManager.init(el.chartContainer);
  if (!chartOk) {
    showError('Failed to initialize chart engine. Please refresh.');
    return;
  }

  // ─── WebSocket Handlers ───────────────────────────────────────────

  PolyWS.handlers.onConnected = () => {
    setStatus('live', 'LIVE');
    hideError();
  };

  PolyWS.handlers.onDisconnected = () => {
    setStatus('connecting', 'RECONNECTING');
  };

  PolyWS.handlers.onError = () => {
    setStatus('connecting', 'RECONNECTING');
  };

  PolyWS.handlers.onBook = (msg) => {
    const bids = msg.bids || [];
    const asks = msg.asks || [];

    if (bids.length > 0 && asks.length > 0) {
      const bestBid = parseFloat(bids[bids.length - 1].price);
      const bestAsk = parseFloat(asks[asks.length - 1].price);
      if (!isNaN(bestBid) && !isNaN(bestAsk)) {
        PriceEngine.updateBidAsk(bestBid, bestAsk);
        _emitPrice();
      }
    }

    if (msg.last_trade_price || msg.lastTradePrice) {
      PriceEngine.updateLastTrade(msg.last_trade_price || msg.lastTradePrice);
    }
  };

  PolyWS.handlers.onPriceChange = (msg) => {
    if (msg.best_bid !== undefined && msg.best_ask !== undefined) {
      PriceEngine.updateBidAsk(msg.best_bid, msg.best_ask);
    } else if (msg.price !== undefined) {
      if (msg.side === 'BUY')  PriceEngine.updateBidAsk(msg.price, PriceEngine.toAsk());
      if (msg.side === 'SELL') PriceEngine.updateBidAsk(PriceEngine.toBid(), msg.price);
    }
    _emitPrice();
  };

  PolyWS.handlers.onBestBidAsk = (msg) => {
    if (msg.best_bid !== undefined && msg.best_ask !== undefined) {
      PriceEngine.updateBidAsk(msg.best_bid, msg.best_ask);
      _emitPrice();
    }
  };

  PolyWS.handlers.onLastTrade = (msg) => {
    if (msg.price !== undefined) {
      PriceEngine.updateLastTrade(msg.price);
      _emitPrice();
    }
  };

  PolyWS.handlers.onMarketResolved = (msg) => {
    console.log('[App] Market resolved event:', msg);
  };

  PolyWS.handlers.onNewMarket = (msg) => {
    console.log('[App] New market event:', msg);
  };

  PolyWS.handlers.onTickSizeChange = (msg) => {
    if (msg.tick_size) {
      ChartManager.updateTickSize(msg.tick_size);
    }
  };

  // ─── Price Flow & Emission ────────────────────────────────────────
  function _emitPrice() {
    const rawUpPrice = PriceEngine.effectivePrice(); // 0.00–1.00 (Up token)
    const rawUpCents = rawUpPrice * 100;             // 0.0–100.0¢

    const nowSec = Math.floor(Date.now() / 1000);

    // Save raw Up price to historical buffer
    TickBuffer.addTick(nowSec, rawUpCents);

    // Compute display value for current outcome mode
    const displayCents = _outcomeMode === 'down' ? (100 - rawUpCents) : rawUpCents;

    // Send tick to chart
    ChartManager.pushTick(nowSec, displayCents);

    // Update UI numbers
    _updatePriceUI();
  }

  function _updatePriceUI() {
    const rawBid  = PriceEngine.toBid();
    const rawAsk  = PriceEngine.toAsk();
    const rawLast = PriceEngine.toLast();
    const rawMid  = PriceEngine.getMid();
    const rawEff  = PriceEngine.effectivePrice();
    const spread  = PriceEngine.getSpread();
    const ageMs   = PriceEngine.getLastUpdateMs();

    let effCents, bidCents, askCents, midCents, lastCents;

    if (_outcomeMode === 'down') {
      effCents  = 100 - (rawEff * 100);
      bidCents  = rawAsk !== null ? (1 - rawAsk) * 100 : null;
      askCents  = rawBid !== null ? (1 - rawBid) * 100 : null;
      midCents  = 100 - (rawMid * 100);
      lastCents = rawLast !== null ? (100 - rawLast * 100) : null;
    } else {
      effCents  = rawEff * 100;
      bidCents  = rawBid !== null ? rawBid * 100 : null;
      askCents  = rawAsk !== null ? rawAsk * 100 : null;
      midCents  = rawMid * 100;
      lastCents = rawLast !== null ? rawLast * 100 : null;
    }

    const fmt = v => v !== null ? v.toFixed(1) + '¢' : '--.-¢';

    const prevCurrent = el.priceCurrent.textContent;
    const newCurrent  = fmt(effCents);

    let displaySpread = null;
    if (askCents !== null && bidCents !== null) {
      displaySpread = Math.abs(askCents - bidCents);
    } else if (spread !== null) {
      displaySpread = Math.abs(spread * 100);
    }

    el.priceCurrent.textContent = newCurrent;
    el.priceBid.textContent     = fmt(bidCents);
    el.priceAsk.textContent     = fmt(askCents);
    el.priceMid.textContent     = fmt(midCents);
    el.priceLast.textContent    = fmt(lastCents);
    el.priceSpread.textContent  = displaySpread !== null ? displaySpread.toFixed(1) + '¢' : '--.-¢';

    // Flash animation on change
    if (newCurrent !== prevCurrent && prevCurrent !== '--.-¢') {
      const prev = parseFloat(prevCurrent);
      const cur  = parseFloat(newCurrent);
      if (!isNaN(prev) && !isNaN(cur)) {
        el.priceCurrent.classList.remove('price-flash-up', 'price-flash-down');
        void el.priceCurrent.offsetWidth;
        if (cur > prev) el.priceCurrent.classList.add('price-flash-up');
        else if (cur < prev) el.priceCurrent.classList.add('price-flash-down');
      }
    }

    // Data latency age
    if (ageMs) {
      const ageSec = Math.round((Date.now() - ageMs) / 1000);
      el.priceAge.textContent = ageSec < 2 ? 'LIVE' : `${ageSec}s ago`;
      el.priceAge.style.color = ageSec > 10 ? 'var(--red)' : '';
    }
  }

  // ─── Outcome Switching (UP / DOWN) ─────────────────────────────────
  function switchOutcome(mode) {
    if (_outcomeMode === mode) return;
    _outcomeMode = mode;

    el.btnOutcomeUp?.classList.toggle('active', mode === 'up');
    el.btnOutcomeDown?.classList.toggle('active', mode === 'down');

    // Notify chart of mode change
    ChartManager.setOutcomeMode(mode);

    // Re-aggregate historical buffer with new outcome orientation
    const aggregated = TickBuffer.aggregate(_currentTfSeconds, mode);
    if (aggregated.length > 0) {
      ChartManager.setData(aggregated);
    }

    _updatePriceUI();
    showToast(mode === 'up' ? '📈 Viewing UP Outcome' : '📉 Viewing DOWN Outcome', 'info', 2000);
  }

  // ─── Market Loading ───────────────────────────────────────────────
  async function loadMarket(tfMinutes) {
    showLoading('Fetching market discovery...');
    _loadingRetries = 0;
    PriceEngine.reset();

    let market = null;

    while (!market && _loadingRetries < 5) {
      setLoadingSub(`Connecting to Gamma API... attempt ${_loadingRetries + 1}`);
      market = await MarketManager.loadCurrentMarket(tfMinutes);
      if (!market) {
        _loadingRetries++;
        if (_loadingRetries < 5) await _sleep(1500);
      }
    }

    if (!market) {
      showError('Could not find active market. Retrying...');
      setTimeout(() => loadMarket(_currentTfMinutes), 10000);
      return;
    }

    console.log('[App] Market loaded successfully:', market);
    MarketManager.setCurrentMarket(market);
    _updateMarketUI(market);

    // Initial price via REST
    setLoadingSub('Fetching initial price...');
    const mid = await MarketManager.fetchMidpoint(market.upTokenId);
    if (mid !== null) {
      PriceEngine.updateBidAsk(mid - 0.01, mid + 0.01);
      const rawUpCents = mid * 100;
      const nowSec = Math.floor(Date.now() / 1000);
      TickBuffer.addTick(nowSec, rawUpCents);

      const displayCents = _outcomeMode === 'down' ? (100 - rawUpCents) : rawUpCents;
      ChartManager.setData([{ time: nowSec, value: displayCents }]);
      _updatePriceUI();
    }

    // Connect WebSocket and subscribe (PolyWS.subscribe will automatically unsubscribe from previous token!)
    setLoadingSub('Connecting to live CLOB WebSocket...');
    PolyWS.subscribe(market.upTokenId);
    if (!PolyWS.isConnected()) {
      PolyWS.connect();
    }

    // Schedule next rollover
    MarketManager.scheduleRollover(market, _onMarketSwitch);

    hideLoading();
    _isInitialized = true;
  }

  // ─── Market Switch (Rollover Callback) ────────────────────────────
  async function _onMarketSwitch(newMarket, prevMarket) {
    console.log('[App] Market rollover transition:', prevMarket?.slug, '→', newMarket.slug);
    _marketSwitchCount++;

    const boundaryTs = prevMarket ? prevMarket.endTs : Math.floor(Date.now() / 1000);
    ChartManager.addWhitespace(boundaryTs);
    ChartManager.addMarketBoundaryMarker(boundaryTs + 1, '│ New Market');
    TickBuffer.addMarketBoundary(boundaryTs);

    PriceEngine.reset();

    // Subscribe to new market's token (cleanly unsubscribes from old one)
    PolyWS.subscribe(newMarket.upTokenId);

    _updateMarketUI(newMarket);
    el.marketCount.textContent = `Markets: ${_marketSwitchCount + 1}`;

    const mid = await MarketManager.fetchMidpoint(newMarket.upTokenId);
    if (mid !== null) {
      PriceEngine.updateBidAsk(mid - 0.01, mid + 0.01);
      const rawUpCents = mid * 100;
      const nowSec = Math.floor(Date.now() / 1000);
      TickBuffer.addTick(nowSec, rawUpCents);

      const displayCents = _outcomeMode === 'down' ? (100 - rawUpCents) : rawUpCents;
      ChartManager.pushTick(nowSec, displayCents);
      _updatePriceUI();
    }

    showToast(`Rollover: ${newMarket.slug}`, 'info', 3500);
  }

  // ─── Timeframe Switch ─────────────────────────────────────────────
  function switchTf(tfSeconds) {
    _currentTfSeconds = tfSeconds;
    ChartManager.setTimeframe(tfSeconds);

    const aggregated = TickBuffer.aggregate(tfSeconds, _outcomeMode);
    if (aggregated.length > 0) {
      ChartManager.setData(aggregated);
    }
  }

  // ─── UI Helpers ───────────────────────────────────────────────────
  function _updateMarketUI(market) {
    el.marketSlug.textContent = market.slug || '---';

    if (market.startTs && market.endTs) {
      const fmtTime = ts => {
        const d = new Date(ts * 1000);
        return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
      };
      el.marketWindow.textContent = `${fmtTime(market.startTs)} – ${fmtTime(market.endTs)}`;
    }
  }

  function setStatus(type, text) {
    el.statusIndicator.className = `status-${type}`;
    el.statusText.textContent = text;
  }

  function showLoading(text) {
    el.loadingOverlay.style.display = 'flex';
    el.loadingOverlay.querySelector('#loading-text').textContent = text;
    el.errorOverlay.style.display = 'none';
  }

  function setLoadingSub(text) {
    el.loadingSub.textContent = text;
    el.loadingSub.style.display = 'block';
  }

  function hideLoading() {
    el.loadingOverlay.style.display = 'none';
    el.loadingSub.style.display = 'none';
  }

  function showError(text) {
    el.errorOverlay.style.display = 'flex';
    el.errorText.textContent = text;
    hideLoading();
  }

  function hideError() {
    el.errorOverlay.style.display = 'none';
  }

  function showToast(message, type = 'info', duration = 3000) {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 400);
    }, duration);
  }

  // ─── Countdown Timer & Rollover Watchdog ──────────────────────────
  function _startTimer() {
    setInterval(() => {
      const secs = MarketManager.getSecondsRemaining();
      if (secs === null) {
        el.timerValue.textContent = '--:--';
        return;
      }

      const m = Math.floor(secs / 60);
      const s = secs % 60;
      el.timerValue.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      el.timerValue.classList.toggle('urgent', secs <= 30);

      // Watchdog: If 0s reached and market expired > 3s ago without rollover, force trigger
      const current = MarketManager.getCurrentMarket();
      if (current && current.endTs) {
        const nowSec = Math.floor(Date.now() / 1000);
        if (nowSec >= current.endTs + 3) {
          console.warn('[App] Watchdog: Market expired past endTs, triggering rollover...');
          MarketManager.triggerRollover();
        }
      }
    }, 500);
  }

  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ─── Event Listeners ──────────────────────────────────────────────
  el.btnMkt5m?.addEventListener('click', () => {
    if (_currentTfMinutes === 5) return;
    _currentTfMinutes = 5;
    el.btnMkt5m.classList.add('active');
    el.btnMkt15m.classList.remove('active');
    TickBuffer.reset(false);
    ChartManager.clearMarkers();
    loadMarket(5);
  });

  el.btnMkt15m?.addEventListener('click', () => {
    if (_currentTfMinutes === 15) return;
    _currentTfMinutes = 15;
    el.btnMkt15m.classList.add('active');
    el.btnMkt5m.classList.remove('active');
    TickBuffer.reset(false);
    ChartManager.clearMarkers();
    loadMarket(15);
  });

  // Outcome buttons
  el.btnOutcomeUp?.addEventListener('click', () => switchOutcome('up'));
  el.btnOutcomeDown?.addEventListener('click', () => switchOutcome('down'));

  // Timeframe buttons
  const tfBtns = {
    'btn-tf-1s':  1,
    'btn-tf-5s':  5,
    'btn-tf-15s': 15,
    'btn-tf-30s': 30,
    'btn-tf-1m':  60,
  };

  Object.entries(tfBtns).forEach(([id, secs]) => {
    const btn = $(id);
    if (!btn) return;
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      switchTf(secs);
    });
  });

  el.btnResetZoom?.addEventListener('click', () => {
    ChartManager.resetZoom();
  });

  el.btnRetry?.addEventListener('click', () => {
    hideError();
    loadMarket(_currentTfMinutes);
  });

  // Periodic price UI updater
  setInterval(_updatePriceUI, 1000);

  // Start countdown timer
  _startTimer();

  // Boot
  setStatus('connecting', 'CONNECTING');
  await loadMarket(_currentTfMinutes);

})().catch(err => {
  console.error('[App] Fatal boot error:', err);
  const eo = document.getElementById('error-overlay');
  const et = document.getElementById('error-text');
  if (eo) {
    eo.style.display = 'flex';
    et.textContent = 'Startup error: ' + err.message;
  }
});
