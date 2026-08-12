/**
 * app.js — Main application coordinator v1.1
 * 
 * Changes v1.1:
 * - Fixed: data stops after market rollover (WS filter was blocking new token)
 * - Added: UP / DOWN outcome selector (inverts price: DOWN = 100 - UP)
 * - Moved: countdown timer to price bar (center, larger)
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
    btnOutcomeUp:      $('btn-outcome-up'),
    btnOutcomeDown:    $('btn-outcome-down'),
    btnResetZoom:      $('btn-reset-zoom'),
    btnRetry:          $('btn-retry'),
  };

  // ─── App state ────────────────────────────────────────────────────
  let _currentTfMinutes = 5;
  let _currentTfSeconds = 1;
  let _isInitialized    = false;
  let _marketSwitchCount = 0;
  let _loadingRetries   = 0;

  // UP/DOWN outcome state: 'up' shows Up-token price, 'down' shows 100-price
  let _outcomeMode = 'up'; // 'up' | 'down'

  // ─── Init chart ───────────────────────────────────────────────────
  const chartOk = ChartManager.init(el.chartContainer);
  if (!chartOk) {
    showError('Failed to initialize chart. Please refresh.');
    return;
  }

  // ─── Price conversion based on outcome mode ────────────────────────
  function _toDisplayCents(rawPrice01) {
    // rawPrice01 is 0.00–1.00 (Up token price)
    const cents = rawPrice01 * 100;
    return _outcomeMode === 'down' ? (100 - cents) : cents;
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
    const bids = msg.bids || [];
    const asks = msg.asks || [];

    if (bids.length > 0 && asks.length > 0) {
      // bids ascending → best bid = last; asks descending → best ask = last
      const bestBid = parseFloat(bids[bids.length - 1].price);
      const bestAsk = parseFloat(asks[asks.length - 1].price);
      if (!isNaN(bestBid) && !isNaN(bestAsk)) {
        PriceEngine.updateBidAsk(bestBid, bestAsk);
        _emitPrice();
      }
    }

    if (msg.lastTradePrice) {
      PriceEngine.updateLastTrade(msg.lastTradePrice);
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

  PolyWS.handlers.onLastTrade = (msg) => {
    if (msg.price !== undefined) {
      PriceEngine.updateLastTrade(msg.price);
      _emitPrice();
    }
  };

  PolyWS.handlers.onBestBidAsk = (msg) => {
    if (msg.best_bid !== undefined && msg.best_ask !== undefined) {
      PriceEngine.updateBidAsk(msg.best_bid, msg.best_ask);
      _emitPrice();
    }
  };

  PolyWS.handlers.onMarketResolved = (msg) => {
    console.log('[App] Market resolved:', msg);
  };

  PolyWS.handlers.onNewMarket = (msg) => {
    console.log('[App] New market event received:', msg);
  };

  PolyWS.handlers.onTickSizeChange = (msg) => {
    if (msg.tick_size) {
      ChartManager.updateTickSize(msg.tick_size);
    }
  };

  // ─── Price emission ───────────────────────────────────────────────
  function _emitPrice() {
    const rawPrice = PriceEngine.effectivePrice(); // 0.00–1.00
    const displayCents = _toDisplayCents(rawPrice); // 0–100¢ adjusted for mode

    const nowSec = Math.floor(Date.now() / 1000);

    TickBuffer.addTick(nowSec, displayCents);
    ChartManager.pushTick(nowSec, displayCents);

    _updatePriceUI();
  }

  function _updatePriceUI() {
    const bid    = PriceEngine.toBid();
    const ask    = PriceEngine.toAsk();
    const last   = PriceEngine.toLast();
    const mid    = PriceEngine.getMid();
    const eff    = PriceEngine.effectivePrice();
    const spread = PriceEngine.getSpread();
    const ageMs  = PriceEngine.getLastUpdateMs();

    // In DOWN mode, invert bid/ask: bid becomes (1-ask), ask becomes (1-bid)
    const fmtRaw = v => v !== null
      ? (_outcomeMode === 'down' ? (100 - v * 100) : v * 100).toFixed(1) + '¢'
      : '--.-¢';

    const newCurrent = _toDisplayCents(eff).toFixed(1) + '¢';
    const prevCurrent = el.priceCurrent.textContent;

    el.priceCurrent.textContent = newCurrent;
    // In down mode, bid/ask are swapped visually
    el.priceBid.textContent    = bid !== null ? (_outcomeMode === 'down' ? (100 - ask * 100) : bid * 100).toFixed(1) + '¢' : '--.-¢';
    el.priceAsk.textContent    = ask !== null ? (_outcomeMode === 'down' ? (100 - bid * 100) : ask * 100).toFixed(1) + '¢' : '--.-¢';
    el.priceMid.textContent    = (_toDisplayCents(mid)).toFixed(1) + '¢';
    el.priceLast.textContent   = last !== null ? _toDisplayCents(last).toFixed(1) + '¢' : '--.-¢';
    el.priceSpread.textContent = spread !== null ? (spread * 100).toFixed(1) + '¢' : '--.-¢';

    // Flash on price change
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
      const displayCents = _toDisplayCents(mid);
      const nowSec = Math.floor(Date.now() / 1000);
      TickBuffer.addTick(nowSec, displayCents);
      ChartManager.setData([{ time: nowSec, value: displayCents }]);
      PriceEngine.updateBidAsk(mid - 0.01, mid + 0.01);
      _updatePriceUI();
    }

    // Connect WebSocket and subscribe
    setLoadingSub('Connecting to live feed…');
    // FIX: clear the WS token filter BEFORE subscribing so new token isn't blocked
    PolyWS.clearTokenFilter();
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

    // Visual boundary on chart
    const boundaryTs = prevMarket ? prevMarket.endTs : Math.floor(Date.now() / 1000);
    ChartManager.addWhitespace(boundaryTs);
    ChartManager.addMarketBoundaryMarker(boundaryTs + 1, '│ New Market');
    TickBuffer.addMarketBoundary(boundaryTs);

    // Reset price engine
    PriceEngine.reset();

    // FIX: clear token filter so new subscription isn't blocked by old token check
    PolyWS.clearTokenFilter();
    PolyWS.subscribe(newMarket.upTokenId);

    // Update UI
    _updateMarketUI(newMarket);
    el.marketCount.textContent = `Markets: ${_marketSwitchCount + 1}`;

    // Get initial price for new market
    const mid = await MarketManager.fetchMidpoint(newMarket.upTokenId);
    if (mid !== null) {
      const displayCents = _toDisplayCents(mid);
      const nowSec = Math.floor(Date.now() / 1000);
      TickBuffer.addTick(nowSec, displayCents);
      ChartManager.pushTick(nowSec, displayCents);
      PriceEngine.updateBidAsk(mid - 0.01, mid + 0.01);
      _updatePriceUI();
    }

    showToast(`New market: ${newMarket.slug}`, 'info', 4000);
  }

  // ─── Outcome mode switch (UP / DOWN) ─────────────────────────────
  function _switchOutcome(mode) {
    if (_outcomeMode === mode) return;
    _outcomeMode = mode;

    // Update button states
    el.btnOutcomeUp?.classList.toggle('active', mode === 'up');
    el.btnOutcomeDown?.classList.toggle('active', mode === 'down');

    // Rebuild chart from buffer with new display
    const rawTicks = TickBuffer.getRawTicks();
    if (rawTicks.length > 0) {
      // Re-convert all ticks according to new mode
      const converted = TickBuffer.aggregate(_currentTfSeconds, mode);
      ChartManager.setData(converted);
    }

    // Update color scheme
    ChartManager.setOutcomeMode(mode);

    showToast(mode === 'up' ? '📈 Showing UP probability' : '📉 Showing DOWN probability', 'info', 2000);
  }

  // ─── Timeframe switch ─────────────────────────────────────────────
  function switchTf(tfSeconds) {
    _currentTfSeconds = tfSeconds;
    ChartManager.setTimeframe(tfSeconds);
    const aggregated = TickBuffer.aggregate(tfSeconds, _outcomeMode);
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

  // ─── Toast ────────────────────────────────────────────────────────
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

  // UP / DOWN outcome buttons
  el.btnOutcomeUp?.addEventListener('click', () => _switchOutcome('up'));
  el.btnOutcomeDown?.addEventListener('click', () => _switchOutcome('down'));

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

  el.btnResetZoom?.addEventListener('click', () => ChartManager.resetZoom());

  el.btnRetry?.addEventListener('click', () => {
    hideError();
    loadMarket(_currentTfMinutes);
  });

  // ─── Periodic UI updater ─────────────────────────────────────────
  setInterval(_updatePriceUI, 1000);

  // ─── Start timer ─────────────────────────────────────────────────
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
