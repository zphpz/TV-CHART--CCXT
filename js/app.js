/**
 * app.js — Main Application Coordinator v1.4
 * 
 * Orchestrates: MarketManager, PolyWS, TickBuffer, PriceEngine, ChartManager, DBManager, BackfillEngine, HistoryPanel
 * Features:
 * - View switcher: Live Chart vs History & Database Control Panel
 * - Real-time auto-saving of completed sessions into local database file
 * - Live official winner badges (White for UP, Coral-red for DOWN)
 * - Seamless integration with Polymarket CLOB WebSocket & Gamma API
 */
'use strict';

window.App = (() => {
  const $ = id => document.getElementById(id);

  const el = {
    tradingView:       $('trading-view'),
    chartView:         $('chart-view'),
    historyView:       $('history-panel-view'),
    tabTrading:        $('tab-view-trading'),
    tabChart:          $('tab-view-chart'),
    tabHistory:        $('tab-view-history'),

    tradingContainer:  $('trading-chart-container'),
    chartContainer:    $('chart-container'),
    loadingOverlay:    $('loading-overlay'),
    loadingSub:        $('loading-sub'),
    errorOverlay:      $('error-overlay'),
    errorText:         $('error-text'),

    statusIndicator:   $('status-indicator'),
    statusText:        $('status-text'),
    timerCenter:       $('timer-center'),
    timerLabelTop:     $('timer-label-top'),
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
    btnScrollStart:    $('btn-scroll-start'),
    btnScrollLive:     $('btn-scroll-live'),
    btnQuickLoadDb:    $('btn-quick-load-db'),
    btnRetry:          $('btn-retry'),
  };

  let _currentTfMinutes  = 5;      // 5 or 15 minutes market
  let _currentTfSeconds  = 1;      // 1s / 5s / 15s / 30s / 60s chart TF
  let _isInitialized     = false;
  let _marketSwitchCount = 0;
  let _loadingRetries    = 0;
  let _outcomeMode       = 'up';   // 'up' | 'down'
  let _timerMode         = 'remaining'; // 'remaining' | 'elapsed'
  let _activeView        = 'trading'; // 'trading' | 'chart' | 'history'

  // In-memory buffer of current live session ticks: [[t, v_cents], ...]
  let _currentSessionTicks = [];

  // ─── View Switching (Trading vs All Sessions vs History) ───────────
  function switchView(viewName) {
    _activeView = viewName;

    // Reset visibility
    el.tradingView?.classList.toggle('hidden-view', viewName !== 'trading');
    el.tradingView?.classList.toggle('active-view', viewName === 'trading');

    el.chartView?.classList.toggle('hidden-view', viewName !== 'chart');
    el.chartView?.classList.toggle('active-view', viewName === 'chart');

    el.historyView?.classList.toggle('hidden-view', viewName !== 'history');
    el.historyView?.classList.toggle('active-view', viewName === 'history');

    // Update tab styling
    el.tabTrading?.classList.toggle('active', viewName === 'trading');
    el.tabChart?.classList.toggle('active', viewName === 'chart');
    el.tabHistory?.classList.toggle('active', viewName === 'history');

    if (viewName === 'trading') {
      setTimeout(() => window.LiveTradingManager?.resize(), 50);
    } else if (viewName === 'chart') {
      setTimeout(() => ChartManager.resetZoom(), 50);
    }
  }

  // ─── Boot Sequence ────────────────────────────────────────────────
  async function boot() {
    // 1. Initialize Stationary Live Trading Chart
    if (window.LiveTradingManager) {
      LiveTradingManager.init(el.tradingContainer);
    }

    // 2. Initialize Multi-Session Timeline Chart
    const chartOk = ChartManager.init(el.chartContainer);
    if (!chartOk) {
      showError('Failed to initialize chart engine. Please refresh.');
      return;
    }

    // 3. Try auto-connecting DB handle from cache
    if (window.DBManager) {
      await window.DBManager.tryAutoConnect();
    }

    // 4. Initialize History Panel
    if (window.HistoryPanel) {
      window.HistoryPanel.init();
    }

    // 5. Bind View Switcher
    el.tabTrading?.addEventListener('click', () => switchView('trading'));
    el.tabChart?.addEventListener('click', () => switchView('chart'));
    el.tabHistory?.addEventListener('click', () => switchView('history'));
    el.btnQuickLoadDb?.addEventListener('click', () => {
      window.HistoryPanel?.loadHistoryToChart(true);
    });

    // 6. Bind Interactive Timer Toggle (Remaining <-> Elapsed)
    el.timerCenter?.addEventListener('click', () => {
      _timerMode = (_timerMode === 'remaining' ? 'elapsed' : 'remaining');
      _updateTimer();
      showToast(_timerMode === 'remaining' ? '⏱ Timer: Countdown (Remaining)' : '⏱ Timer: Count-up (Elapsed)', 'info', 2000);
    });

    // 5. Connect WebSocket Handlers (CLOB + RTDS Chainlink Stream)
    _setupWSHandlers();
    _setupRTDSHandlers();

    // 6. Bind UI Controls
    _bindUIControls();

    // 7. Start Timers
    _startTimer();
    setInterval(_updatePriceUI, 1000);
    setInterval(_flushLiveTicksToDB, 30000); // periodic auto-save

    // 8. Load Current Active Market
    setStatus('connecting', 'CONNECTING');
    await loadMarket(_currentTfMinutes);
  }

  // ─── RTDS Chainlink BTC Price Feed Handlers ───────────────────────
  let _liveBtcOpen = null;
  let _liveBtcCurrent = null;
  let _liveBtcChange = null;

  function _setupRTDSHandlers() {
    if (!window.PolyRTDS) return;

    PolyRTDS.handlers.onBtcPrice = (price, ts) => {
      const cur = MarketManager.getCurrentMarket();
      if (!cur) return;

      if (_liveBtcOpen === null) {
        _liveBtcOpen = price;
      }
      _liveBtcCurrent = price;
      if (_liveBtcOpen > 0) {
        _liveBtcChange = Math.round(((_liveBtcCurrent - _liveBtcOpen) / _liveBtcOpen) * 10000) / 100;
      }

      ChartManager.updateLiveSessionBtc(cur.slug, _liveBtcOpen, _liveBtcCurrent, _liveBtcChange);
      if (window.LiveTradingManager) {
        LiveTradingManager.updateBtcPrice(_liveBtcOpen, _liveBtcCurrent, _liveBtcChange);
      }
    };

    PolyRTDS.connect();
  }

  // ─── WebSocket Handlers ───────────────────────────────────────────
  function _setupWSHandlers() {
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

    PolyWS.handlers.onTickSizeChange = (msg) => {
      if (msg.tick_size) {
        ChartManager.updateTickSize(msg.tick_size);
      }
    };
  }

  // ─── Price Flow & Emission ────────────────────────────────────────
  function _emitPrice() {
    const rawUpPrice = PriceEngine.effectivePrice(); // 0.00–1.00 (Up token)
    const rawUpCents = rawUpPrice * 100;             // 0.0–100.0¢
    const nowSec = Math.floor(Date.now() / 1000);

    // Save to historical tick buffer
    TickBuffer.addTick(nowSec, rawUpCents);

    // Save to current live session buffer for DB
    _currentSessionTicks.push([nowSec, Math.round(rawUpCents * 10) / 10]);

    // Compute display value for current outcome mode
    const displayCents = _outcomeMode === 'down' ? (100 - rawUpCents) : rawUpCents;

    // Send tick to multi-session chart
    ChartManager.pushTick(nowSec, displayCents);

    // Send tick to stationary 300s/900s LiveTradingManager chart
    if (window.LiveTradingManager) {
      LiveTradingManager.pushTick(nowSec, rawUpCents);
    }

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

    // Flash animation on price change
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

    ChartManager.setOutcomeMode(mode);
    if (window.LiveTradingManager) {
      LiveTradingManager.setOutcomeMode(mode);
    }

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
    _currentSessionTicks = [];

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

    console.log('[App] Market loaded:', market);
    MarketManager.setCurrentMarket(market);
    // 5. Update UI
    _updateMarketUI(market);
    if (window.LiveTradingManager) {
      LiveTradingManager.setMarket(market);
    }

    // Initial price via REST
    setLoadingSub('Fetching initial price...');
    const mid = await MarketManager.fetchMidpoint(market.upTokenId);
    if (mid !== null) {
      PriceEngine.updateBidAsk(mid - 0.01, mid + 0.01);
      const rawUpCents = mid * 100;
      const nowSec = Math.floor(Date.now() / 1000);
      TickBuffer.addTick(nowSec, rawUpCents);
      _currentSessionTicks.push([nowSec, Math.round(rawUpCents * 10) / 10]);

      const displayCents = _outcomeMode === 'down' ? (100 - rawUpCents) : rawUpCents;
      ChartManager.setData([{ time: nowSec, value: displayCents }]);
      _updatePriceUI();
    }

    // Connect WebSocket
    setLoadingSub('Connecting to live CLOB WebSocket...');
    PolyWS.subscribe(market.upTokenId);
    if (!PolyWS.isConnected()) {
      PolyWS.connect();
    }

    // Schedule next rollover
    MarketManager.scheduleRollover(market, _onMarketSwitch);

    // Initialize Chainlink live prices for active session
    _liveBtcOpen = parseFloat(market.eventMetadata?.priceToBeat || market.eventMetadata?.targetPrice) || PolyRTDS?.getLatestBtcPrice() || null;
    _liveBtcCurrent = PolyRTDS?.getLatestBtcPrice() || _liveBtcOpen;
    if (_liveBtcOpen && _liveBtcCurrent) {
      _liveBtcChange = Math.round(((_liveBtcCurrent - _liveBtcOpen) / _liveBtcOpen) * 10000) / 100;
      ChartManager.updateLiveSessionBtc(market.slug, _liveBtcOpen, _liveBtcCurrent, _liveBtcChange);
    }

    hideLoading();
    _isInitialized = true;
  }

  // ─── Market Switch (Rollover Callback) ────────────────────────────
  async function _onMarketSwitch(newMarket, prevMarket) {
    console.log('[App] Market rollover:', prevMarket?.slug, '→', newMarket.slug);
    _marketSwitchCount++;

    _liveBtcOpen = PolyRTDS?.getLatestBtcPrice() || null;
    _liveBtcCurrent = _liveBtcOpen;
    _liveBtcChange = 0;

    const boundaryTs = prevMarket ? prevMarket.endTs : Math.floor(Date.now() / 1000);

    // 4. Update stationary Live Trading chart for new session
    if (window.LiveTradingManager) {
      LiveTradingManager.setMarket(newMarket);
    }

    // 5. Query resolution for previous market after small delay to DB
    if (prevMarket && prevMarket.slug) {
      const finalPrice = PriceEngine.effectivePrice(); // 0.0–1.0
      const isUpWon = finalPrice >= 0.5;
      const winnerStr = isUpWon ? 'UP' : 'DOWN';

      // Add winner badge marker on chart:
      // UP WON = White badge, DOWN WON = Coral Red badge
      ChartManager.addWinnerBadgeMarker(
        boundaryTs,
        isUpWon ? '🏆 UP WON' : '🏆 DOWN WON',
        isUpWon ? 'up' : 'down'
      );

      // Save initial completed session to local DB
      if (window.DBManager) {
        window.DBManager.upsertSession({
          slug: prevMarket.slug,
          tf: prevMarket.slug.includes('-15m-') ? 15 : 5,
          startTs: prevMarket.startTs,
          endTs: prevMarket.endTs,
          winner: winnerStr,
          ticks: _currentSessionTicks,
        }, true);
      }

      // Schedule async query of official Gamma API resolution & Chainlink TWAP prices
      const completedSlug = prevMarket.slug;
      setTimeout(async () => {
        try {
          const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${completedSlug}`);
          if (res.ok) {
            const data = await res.json();
            const ev = Array.isArray(data) ? data[0] : data;
            if (ev && Array.isArray(ev.markets) && ev.markets[0]) {
              const m = ev.markets[0];
              let outP = m.outcomePrices;
              if (typeof outP === 'string') outP = JSON.parse(outP);
              let resolvedWinner = null;
              if (Array.isArray(outP) && outP.length >= 2) {
                const upP = parseFloat(outP[0]);
                if (!isNaN(upP)) {
                  if (upP > 0.5) resolvedWinner = 'UP';
                  else if (upP < 0.5) resolvedWinner = 'DOWN';
                }
              }

              const meta = ev.eventMetadata || m.eventMetadata;
              let bOpen = null, bClose = null, bChg = null;
              if (meta && typeof meta === 'object') {
                bOpen = parseFloat(meta.priceToBeat || meta.targetPrice);
                bClose = parseFloat(meta.finalPrice || meta.settlementPrice);
                if (!isNaN(bOpen) && !isNaN(bClose) && bOpen > 0) {
                  bChg = Math.round(((bClose - bOpen) / bOpen) * 10000) / 100;
                }
              }

              if (window.DBManager) {
                const updatePayload = { slug: completedSlug };
                if (resolvedWinner) updatePayload.winner = resolvedWinner;
                if (bOpen !== null) updatePayload.btcOpen = bOpen;
                if (bClose !== null) updatePayload.btcClose = bClose;
                if (bChg !== null) updatePayload.btcChange = bChg;
                window.DBManager.upsertSession(updatePayload, true);
              }
            }
          }
        } catch (err) {
          console.warn('[App] Could not fetch post-resolution metadata:', err);
        }
      }, 15000);
    }

    // 2. Add visual boundary separator to chart
    ChartManager.addWhitespace(boundaryTs);
    ChartManager.addSessionBoundary(boundaryTs);
    ChartManager.addMarketBoundaryMarker(boundaryTs + 1, '│ New Market');
    TickBuffer.addMarketBoundary(boundaryTs);

    // 3. Reset state for new market
    PriceEngine.reset();
    _currentSessionTicks = [];

    PolyWS.subscribe(newMarket.upTokenId);
    _updateMarketUI(newMarket);
    el.marketCount.textContent = `Markets: ${_marketSwitchCount + 1}`;

    const mid = await MarketManager.fetchMidpoint(newMarket.upTokenId);
    if (mid !== null) {
      PriceEngine.updateBidAsk(mid - 0.01, mid + 0.01);
      const rawUpCents = mid * 100;
      const nowSec = Math.floor(Date.now() / 1000);
      TickBuffer.addTick(nowSec, rawUpCents);
      _currentSessionTicks.push([nowSec, Math.round(rawUpCents * 10) / 10]);

      const displayCents = _outcomeMode === 'down' ? (100 - rawUpCents) : rawUpCents;
      ChartManager.pushTick(nowSec, displayCents);
      _updatePriceUI();
    }

    showToast(`Rollover: ${newMarket.slug}`, 'info', 3500);
  }

  function _flushLiveTicksToDB() {
    const cur = MarketManager.getCurrentMarket();
    if (!cur || !cur.slug || _currentSessionTicks.length === 0) return;
    if (window.DBManager && window.DBManager.isConnected() && window.DBManager.isAutoSave()) {
      window.DBManager.upsertSession({
        slug: cur.slug,
        tf: cur.slug.includes('-15m-') ? 15 : 5,
        startTs: cur.startTs,
        endTs: cur.endTs,
        winner: 'PENDING',
        ticks: _currentSessionTicks,
      }, true);
    }
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
  function _updateTimer() {
    const secs = MarketManager.getSecondsRemaining();
    const current = MarketManager.getCurrentMarket();
    if (secs === null || !current) {
      el.timerValue.textContent = '--:--';
      return;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const totalDuration = (_currentTfMinutes || 5) * 60;
    const startTs = current.startTs || (nowSec - Math.max(0, totalDuration - secs));
    const elapsedSecs = Math.max(0, nowSec - startTs);

    if (_timerMode === 'elapsed') {
      if (el.timerLabelTop) el.timerLabelTop.textContent = 'ELAPSED';
      const m = Math.floor(elapsedSecs / 60);
      const s = elapsedSecs % 60;
      el.timerValue.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      el.timerValue.classList.remove('urgent');
    } else {
      if (el.timerLabelTop) el.timerLabelTop.textContent = 'ENDS IN';
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      el.timerValue.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      el.timerValue.classList.toggle('urgent', secs <= 30);
    }
  }

  function _startTimer() {
    setInterval(() => {
      _updateTimer();

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

  function _bindUIControls() {
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

    el.btnOutcomeUp?.addEventListener('click', () => switchOutcome('up'));
    el.btnOutcomeDown?.addEventListener('click', () => switchOutcome('down'));

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
    el.btnScrollStart?.addEventListener('click', () => ChartManager.scrollToStart());
    el.btnScrollLive?.addEventListener('click', () => ChartManager.scrollToEnd());
    el.btnRetry?.addEventListener('click', () => {
      hideError();
      loadMarket(_currentTfMinutes);
    });
  }

  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function getOutcomeMode() { return _outcomeMode; }

  // ─── Self Execution ───────────────────────────────────────────────
  boot().catch(err => {
    console.error('[App] Boot error:', err);
  });

  return {
    switchView,
    showToast,
    getOutcomeMode,
    getCurrentSessionTicks: () => _currentSessionTicks,
  };
})();
