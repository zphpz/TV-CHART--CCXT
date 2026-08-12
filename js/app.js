/**
 * app.js — Main application coordinator
 * 
 * Orchestrates: MarketManager, PolyWS, TickBuffer, PriceEngine, ChartManager
 * Handles: UI events, status updates, price display, timer countdown
 */
'use strict';

(async function AppMain() {
  // ─── DOM refs ─────────────────────────────────────────────────────
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
    btnTf1s:           $('btn-tf-1s'),
    btnTf5s:           $('btn-tf-5s'),
    btnTf15s:          $('btn-tf-15s'),
    btnTf30s:          $('btn-tf-30s'),
    btnTf1m:           $('btn-tf-1m'),
    btnResetZoom:      $('btn-reset-zoom'),
    btnRetry:          $('btn-retry'),
  };

  // ─── App state ────────────────────────────────────────────────────
  let _currentTfMinutes = 5;      // 5 or 15 minutes market
  let _currentTfSeconds = 1;      // 1s / 5s / 15s / 30s / 60s chart TF
  let _isInitialized    = false;
  let _marketSwitchCount = 0;
  let _loadingRetries   = 0;

  // ─── Init chart ───────────────────────────────────────────────────
  const chartOk = ChartManager.init(el.chartContainer);
  if (!chartOk) {
    showError('Failed to initialize chart. Please refresh.');
    return;
  }

  // ─── WS event handlers ────────────────────────────────────────────

  PolyWS.handlers.onConnected = () => {
    setStatus('live', 'LIVE');
    hideError();
  };

  PolyWS.handlers.onDisconnected = () => {
    setStatus('connecting', 'RECONNECTING');
  };

  PolyWS.handlers.onError = () => {
    setStatus('connecting', 'ERROR');
  };

  PolyWS.handlers.onBook = (msg) => {
    // Full order book snapshot — extract best bid/ask
    const bids = msg.bids || [];
    const asks = msg.asks || [];

    if (bids.length > 0 && asks.length > 0) {
      // bids are ascending sorted → best bid = last element
      // asks are descending sorted → best ask = last element
      const bestBid = parseFloat(bids[bids.length - 1].price);
      const bestAsk = parseFloat(asks[asks.length - 1].price);
      if (!isNaN(bestBid) && !isNaN(bestAsk)) {
        PriceEngine.updateBidAsk(bestBid, bestAsk);
        _emitPrice();
      }
    }

    // Book snapshot also carries lastTradePrice
    if (msg.lastTradePrice) {
      PriceEngine.updateLastTrade(msg.lastTradePrice);
    }
  };

  PolyWS.handlers.onPriceChange = (msg) => {
    // price_change carries best_bid and best_ask
    if (msg.best_bid !== undefined) {
      PriceEngine.updateBidAsk(msg.best_bid, msg.best_ask);
    } else if (msg.price !== undefined) {
      // Single side update
      if (msg.side === 'BUY')  PriceEngine.updateBidAsk(msg.price, PriceEngine.toAsk());
      if (msg.side === 'SELL') PriceEngine.updateBidAsk(PriceEngine.toBid(), msg.price);
    }
    _emitPrice();
  };

  PolyWS.handlers.onLastTrade = (msg) => {
    if (msg.price !== undefined) {
      PriceEngine.updateLastTrade(msg.price);
      _emitPrice();
    }
  };

  PolyWS.handlers.onBestBidAsk = (msg) => {
    // best_bid_ask event (requires custom_feature_enabled: true)
    if (msg.best_bid !== undefined && msg.best_ask !== undefined) {
      PriceEngine.updateBidAsk(msg.best_bid, msg.best_ask);
      _emitPrice();
    }
  };

  PolyWS.handlers.onMarketResolved = (msg) => {
    console.log('[App] Market resolved:', msg);
    // Visual confirmation — the rollover timer will handle the actual switch
  };

  PolyWS.handlers.onNewMarket = (msg) => {
    console.log('[App] New market event received:', msg);
    // The rollover scheduler handles this via timer — this is just a backup signal
  };

  PolyWS.handlers.onTickSizeChange = (msg) => {
    if (msg.tick_size) {
      ChartManager.updateTickSize(msg.tick_size);
    }
  };

  // ─── Price emission ───────────────────────────────────────────────
  function _emitPrice() {
    const rawPrice = PriceEngine.effectivePrice(); // 0.00–1.00
    const priceCents = rawPrice * 100;             // 0–100¢

    const nowSec = Math.floor(Date.now() / 1000);

    // Push to buffer
    TickBuffer.addTick(nowSec, priceCents);

    // Push to chart (via RAF throttle)
    ChartManager.pushTick(nowSec, priceCents);

    // Update UI price displays
    _updatePriceUI();
  }

  function _updatePriceUI() {
    const bid   = PriceEngine.toBid();
    const ask   = PriceEngine.toAsk();
    const last  = PriceEngine.toLast();
    const mid   = PriceEngine.getMid();
    const eff   = PriceEngine.effectivePrice();
    const spread = PriceEngine.getSpread();
    const ageMs = PriceEngine.getLastUpdateMs();

    const fmt = v => v !== null ? (v * 100).toFixed(1) + '¢' : '--.-¢';
    const fmtDirect = v => v !== null ? v.toFixed(1) + '¢' : '--.-¢';

    const prevCurrent = el.priceCurrent.textContent;
    const newCurrent = fmtDirect(eff * 100);

    el.priceCurrent.textContent = newCurrent;
    el.priceBid.textContent     = fmt(bid);
    el.priceAsk.textContent     = fmt(ask);
    el.priceMid.textContent     = fmtDirect(mid * 100);
    el.priceLast.textContent    = fmt(last);
    el.priceSpread.textContent  = spread !== null ? (spread * 100).toFixed(1) + '¢' : '--.-¢';

    // Flash animation on price change
    if (newCurrent !== prevCurrent && prevCurrent !== '--.-¢') {
      const prev = parseFloat(prevCurrent);
      const cur  = parseFloat(newCurrent);
      if (!isNaN(prev) && !isNaN(cur)) {
        el.priceCurrent.classList.remove('price-flash-up', 'price-flash-down');
        void el.priceCurrent.offsetWidth; // reflow
        if (cur > prev) el.priceCurrent.classList.add('price-flash-up');
        else if (cur < prev) el.priceCurrent.classList.add('price-flash-down');
      }
    }

    // Data age
    if (ageMs) {
      const ageSec = Math.round((Date.now() - ageMs) / 1000);
      el.priceAge.textContent = ageSec < 2 ? 'LIVE' : `${ageSec}s ago`;
      el.priceAge.style.color = ageSec > 10 ? 'var(--red)' : '';
    }
  }

  // ─── Market loading ───────────────────────────────────────────────
  async function loadMarket(tfMinutes) {
    showLoading('Fetching market data…');
    _loadingRetries = 0;
    PriceEngine.reset();

    let market = null;

    while (!market && _loadingRetries < 5) {
      setLoadingSub(`Trying Gamma API… attempt ${_loadingRetries + 1}`);
      market = await MarketManager.loadCurrentMarket(tfMinutes);
      if (!market) {
        _loadingRetries++;
        if (_loadingRetries < 5) await _sleep(2000);
      }
    }

    if (!market) {
      showError('Could not find active market. Retrying in 30s…');
      setTimeout(() => loadMarket(_currentTfMinutes), 30000);
      return;
    }

    console.log('[App] Market loaded:', market);
    MarketManager.setCurrentMarket(market);
    _updateMarketUI(market);

    // Pre-fetch initial price via REST
    setLoadingSub('Getting initial price…');
    const mid = await MarketManager.fetchMidpoint(market.upTokenId);
    if (mid !== null) {
      const midCents = mid * 100;
      const nowSec = Math.floor(Date.now() / 1000);
      TickBuffer.addTick(nowSec, midCents);
      ChartManager.setData([{ time: nowSec, value: midCents }]);
      PriceEngine.updateBidAsk(mid - 0.01, mid + 0.01);
      _updatePriceUI();
    }

    // Connect WebSocket and subscribe
    setLoadingSub('Connecting to live feed…');
    PolyWS.subscribe(market.upTokenId);
    if (!PolyWS.isConnected()) {
      PolyWS.connect();
    }

    // Schedule rollover
    MarketManager.scheduleRollover(market, _onMarketSwitch);

    hideLoading();
    _isInitialized = true;
  }

  // ─── Market switch (rollover) ─────────────────────────────────────
  async function _onMarketSwitch(newMarket, prevMarket) {
    console.log('[App] Switching market:', prevMarket?.slug, '→', newMarket.slug);
    _marketSwitchCount++;

    // Add visual boundary marker to chart
    const boundaryTs = prevMarket ? prevMarket.endTs : Math.floor(Date.now() / 1000);
    ChartManager.addWhitespace(boundaryTs);
    ChartManager.addMarketBoundaryMarker(boundaryTs + 1, '│ New Market');
    TickBuffer.addMarketBoundary(boundaryTs);

    // Reset price engine for new market
    PriceEngine.reset();

    // Update WebSocket subscription (no WS reconnect needed!)
    PolyWS.subscribe(newMarket.upTokenId);

    // Update UI
    _updateMarketUI(newMarket);
    el.marketCount.textContent = `Markets: ${_marketSwitchCount + 1}`;

    // Fetch initial price for new market
    const mid = await MarketManager.fetchMidpoint(newMarket.upTokenId);
    if (mid !== null) {
      const nowSec = Math.floor(Date.now() / 1000);
      TickBuffer.addTick(nowSec, mid * 100);
      ChartManager.pushTick(nowSec, mid * 100);
      PriceEngine.updateBidAsk(mid - 0.01, mid + 0.01);
    }

    showToast(`New market: ${newMarket.slug}`, 'info', 4000);
  }

  // ─── Timeframe switch ─────────────────────────────────────────────
  function switchTf(tfSeconds) {
    _currentTfSeconds = tfSeconds;
    ChartManager.setTimeframe(tfSeconds);

    // Re-aggregate all stored ticks
    const aggregated = TickBuffer.aggregate(tfSeconds);
    if (aggregated.length > 0) {
      ChartManager.setData(aggregated);
    }
  }

  // ─── UI update helpers ────────────────────────────────────────────
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

  // ─── Toast notifications ─────────────────────────────────────────
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

  // ─── Countdown timer ─────────────────────────────────────────────
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
    }, 500);
  }

  // ─── Utility ─────────────────────────────────────────────────────
  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ─── UI event listeners ───────────────────────────────────────────

  // Market TF switch (5m / 15m)
  el.btnMkt5m.addEventListener('click', () => {
    if (_currentTfMinutes === 5) return;
    _currentTfMinutes = 5;
    el.btnMkt5m.classList.add('active');
    el.btnMkt15m.classList.remove('active');
    TickBuffer.reset(false);
    ChartManager.clearMarkers();
    loadMarket(5);
  });

  el.btnMkt15m.addEventListener('click', () => {
    if (_currentTfMinutes === 15) return;
    _currentTfMinutes = 15;
    el.btnMkt15m.classList.add('active');
    el.btnMkt5m.classList.remove('active');
    TickBuffer.reset(false);
    ChartManager.clearMarkers();
    loadMarket(15);
  });

  // Chart TF switch (1s / 5s / 15s / 30s / 1m)
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

  // Reset zoom
  el.btnResetZoom?.addEventListener('click', () => {
    ChartManager.resetZoom();
  });

  // Retry button
  el.btnRetry?.addEventListener('click', () => {
    hideError();
    loadMarket(_currentTfMinutes);
  });

  // ─── Start price age updater ──────────────────────────────────────
  setInterval(_updatePriceUI, 1000);

  // ─── Start countdown timer ────────────────────────────────────────
  _startTimer();

  // ─── Boot ─────────────────────────────────────────────────────────
  setStatus('connecting', 'CONNECTING');
  await loadMarket(_currentTfMinutes);

})().catch(err => {
  console.error('[App] Fatal error:', err);
  const eo = document.getElementById('error-overlay');
  const et = document.getElementById('error-text');
  if (eo) {
    eo.style.display = 'flex';
    et.textContent = 'Startup error: ' + err.message;
  }
});
