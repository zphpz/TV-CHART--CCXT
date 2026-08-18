/**
 * app.js — Main Application Coordinator v6.0
 * 
 * Features & Fixes in v6.0:
 * - High-Legibility Large Font Scales (bold 14px / 12px Mono) across Left & Right Scales and Bottom Timeline
 * - 1:1 Accurate STRIKE Price for 15M & 5M Markets (direct Preddy API TWAP 60s priority & duration binding)
 * - Identical 5-Cent Step Price Scales on Both Left and Right (0¢, 5¢, 10¢ ... 95¢, 100¢)
 * - Dedicated Left Scale for Option Tokens (0–100¢) with Large Bold Text
 * - Dual-Badge Interactive System: Floating Live Head Badge + Interactive Hover Cursor Info Badge
 * - Clean Integer Cent Price Display (48¢, 50¢, 51¢, 99¢ matching official Polymarket UI without 0.5 fractions)
 * - F5-Proof Live Stream Cache (preserves high-frequency second-by-second live resolution across page reloads)
 * - Clean Multi-Page Market Pagination (eliminates asset_id spurious trades and sawtooth spikes)
 * - Anti-Cloudflare Cache Busting (_t=nonce): eliminates stale cached history from CDN
 * - High-Density History Merge: Merges Dual-Token CLOB prices-history with Data API individual trades
 * - True Pre-Start Opening Anchor: Captures pre-round baseline price and preserves early price steps
 * - Real Executed Trade Prices prioritized over mathematical midpoint
 * - Eliminated Blind Spot Gap: WebSocket subscribes immediately prior to history hydration
 * - Zero-clamping fixes in ws.js & market.js (preserves full 0-100¢ range)
 * - Safe 0.00 price handling in PriceEngine (never drops zero trades)
 * - Out-of-order tick auto-sorting in LiveTradingManager prevents dropped frames
 * - In-flight market slug race condition guards
 * - Clean timer cleanup preventing background memory/interval leaks
 * - Step-Curve Financial Zero-Order Hold Rendering for Option Probabilities
 * - 100% Direct Polymarket REST APIs with Zero Third-Party Proxies & Strict 2.5s Timeout
 * - Dual-token WebSocket subscription (tracks both UP and DOWN orderbook trades)
 * - Clean market rollover price initialization
 * - Dual Graph Modes: ₿ BTC ($) live curve vs ¢ PROB (%) option token curve
 * - Eliminated DOM layout thrashing & Auto-pruning memory manager
 * - Large prominent floating live head badge (18px/15px, 10px offset, semi-transparent background)
 * - 1:1 Polymarket TWAP 60s live stream parity & accurate Target Price
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

    liveBtcDelta:      $('live-btc-delta'),
    liveBtcCurrent:    $('live-btc-current'),
    liveBtcStrike:     $('live-btc-strike'),

    chkHeadTag:        $('chk-head-tag'),
    btnModeBtc:        $('btn-mode-btc'),
    btnModeToken:      $('btn-mode-token'),

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

  let _currentSessionTicks = [];

  // ─── View Switching (Trading vs All Sessions vs History) ───────────
  function switchView(viewName) {
    _activeView = viewName;

    el.tradingView?.classList.toggle('hidden-view', viewName !== 'trading');
    el.tradingView?.classList.toggle('active-view', viewName === 'trading');

    el.chartView?.classList.toggle('hidden-view', viewName !== 'chart');
    el.chartView?.classList.toggle('active-view', viewName === 'chart');

    el.historyView?.classList.toggle('hidden-view', viewName !== 'history');
    el.historyView?.classList.toggle('active-view', viewName === 'history');

    el.tabTrading?.classList.toggle('active', viewName === 'trading');
    el.tabChart?.classList.toggle('active', viewName === 'chart');
    el.tabHistory?.classList.toggle('active', viewName === 'history');

    if (viewName === 'trading' && window.LiveTradingManager) {
      LiveTradingManager.resize();
    } else if (viewName === 'chart' && window.ChartManager) {
      ChartManager.setData(TickBuffer.aggregate(_currentTfSeconds, _outcomeMode));
      ChartManager.resetZoom();
    }
  }

  // ─── Boot Sequence ────────────────────────────────────────────────
  async function boot() {
    console.log('[App] Initializing Polymarket BTC Live Chart & TWAP Parity v6.0...');

    if (window.LiveTradingManager) {
      LiveTradingManager.init(el.tradingContainer);
      if (el.chkHeadTag) {
        el.chkHeadTag.checked = LiveTradingManager.getShowHeadBadge();
      }
      const initialMode = LiveTradingManager.getChartMode();
      el.btnModeBtc?.classList.toggle('active', initialMode === 'btc');
      el.btnModeToken?.classList.toggle('active', initialMode === 'token');
    }

    const chartOk = ChartManager.init(el.chartContainer);
    if (!chartOk) {
      showError('Failed to initialize chart engine. Please refresh.');
      return;
    }

    if (window.DBManager) {
      await window.DBManager.tryAutoConnect();
    }

    if (window.HistoryPanel) {
      window.HistoryPanel.init();
    }

    // Bind View Switcher
    el.tabTrading?.addEventListener('click', () => switchView('trading'));
    el.tabChart?.addEventListener('click', () => switchView('chart'));
    el.tabHistory?.addEventListener('click', () => switchView('history'));
    el.btnQuickLoadDb?.addEventListener('click', () => {
      window.HistoryPanel?.loadHistoryToChart(true);
    });

    // Timer Toggle (Remaining <-> Elapsed)
    el.timerCenter?.addEventListener('click', () => {
      _timerMode = (_timerMode === 'remaining' ? 'elapsed' : 'remaining');
      _updateTimer();
      showToast(_timerMode === 'remaining' ? '⏱ Timer: Countdown (Remaining)' : '⏱ Timer: Count-up (Elapsed)', 'info', 2000);
    });

    _setupWSHandlers();
    _setupRTDSHandlers();
    _bindUIControls();

    _startTimer();
    
    // Continuous 1-second price emission ticker
    if (window._emitPriceInterval) clearInterval(window._emitPriceInterval);
    window._emitPriceInterval = setInterval(() => {
      _emitPrice();
    }, 1000);

    // Periodic Midpoint Watchdog & Memory Pruning
    if (window._watchdogInterval) clearInterval(window._watchdogInterval);
    window._watchdogInterval = setInterval(async () => {
      _flushLiveTicksToDB();
      const nowSec = Math.floor(Date.now() / 1000);
      if (window.TickBuffer) {
        TickBuffer.pruneOld(nowSec - 86400);
      }

      // Midpoint Watchdog: if price hasn't updated from WS in > 3s, refresh from CLOB
      const cur = MarketManager.getCurrentMarket();
      if (cur && cur.upTokenId) {
        const lastUp = PriceEngine.getLastUpdateMs();
        if (!lastUp || (Date.now() - lastUp > 3000)) {
          try {
            const mid = await MarketManager.fetchMidpoint(cur.upTokenId);
            if (mid !== null) {
              PriceEngine.updateLastTrade(mid);
              _emitPrice();
            }
          } catch {}
        }
      }
    }, 3000);

    setStatus('connecting', 'CONNECTING');
    await loadMarket(_currentTfMinutes);
  }

  // ─── RTDS 1:1 TWAP BTC Price Feed Handlers ───────────────────────
  let _liveBtcOpen = null;
  let _liveBtcCurrent = null;
  let _liveBtcChange = null;

  function _setupRTDSHandlers() {
    if (!window.PolyRTDS) return;

    PolyRTDS.handlers.onBtcPrice = (price, ts, targetPrice, delta) => {
      const cur = MarketManager.getCurrentMarket();
      _liveBtcCurrent = price;
      if (targetPrice) _liveBtcOpen = targetPrice;

      const effStrike = _liveBtcOpen || targetPrice || price;
      const effDelta = _liveBtcOpen !== null ? (_liveBtcCurrent - _liveBtcOpen) : (delta !== undefined ? delta : 0);

      if (effStrike > 0) {
        _liveBtcChange = Math.round((effDelta / effStrike) * 10000) / 100;
      }

      _updateBtcHeroMetrics(effDelta, _liveBtcCurrent, effStrike);

      if (cur && _activeView === 'chart') {
        ChartManager.updateLiveSessionBtc(cur.slug, effStrike, _liveBtcCurrent, _liveBtcChange);
      }
      if (window.LiveTradingManager && _activeView === 'trading') {
        const nowSec = Math.floor(Date.now() / 1000);
        LiveTradingManager.updateBtcPrice(effStrike, _liveBtcCurrent, _liveBtcChange);
        LiveTradingManager.pushBtcTick(nowSec, _liveBtcCurrent, effStrike);
      }
    };

    PolyRTDS.connect();
  }

  function _updateBtcHeroMetrics(delta, currentPrice, strikePrice) {
    if (el.liveBtcDelta) {
      const isPos = (delta || 0) >= 0;
      const sign = isPos ? '+$' : '-$';
      const absVal = Math.abs(delta || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      el.liveBtcDelta.textContent = `${sign}${absVal}`;
      el.liveBtcDelta.classList.toggle('green', isPos);
      el.liveBtcDelta.classList.toggle('red', !isPos);
    }

    if (el.liveBtcCurrent && currentPrice !== null && !isNaN(currentPrice)) {
      el.liveBtcCurrent.textContent = '$' + currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    if (el.liveBtcStrike && strikePrice !== null && !isNaN(strikePrice)) {
      el.liveBtcStrike.textContent = '$' + strikePrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
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
        _emitPrice();
      }
    };

    PolyWS.handlers.onPriceChange = (msg) => {
      if (msg.best_bid !== undefined && msg.best_ask !== undefined) {
        PriceEngine.updateBidAsk(msg.best_bid, msg.best_ask);
      } else if (msg.price !== undefined) {
        PriceEngine.updateLastTrade(msg.price);
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
      if (msg.winning_outcome) {
        showToast(`Market resolved: ${msg.winning_outcome.toUpperCase()} WON`, 'warn', 5000);
      }
    };

    PolyWS.handlers.onTickSizeChange = (msg) => {
      if (msg.tick_size && _activeView === 'chart') {
        ChartManager.updateTickSize(msg.tick_size);
      }
    };
  }

  // ─── Price Flow & Emission ────────────────────────────────────────
  function _emitPrice() {
    if (!_isInitialized) return;

    const rawUpPrice = PriceEngine.effectivePrice();
    const rawUpCents = rawUpPrice * 100;
    const nowSec = Math.floor(Date.now() / 1000);

    TickBuffer.addTick(nowSec, rawUpCents);
    _currentSessionTicks.push([nowSec, Math.round(rawUpCents * 10) / 10]);

    if (_activeView === 'chart') {
      const displayCents = _outcomeMode === 'down' ? (100 - rawUpCents) : rawUpCents;
      ChartManager.pushTick(nowSec, displayCents);
    }

    if (window.LiveTradingManager && _activeView === 'trading') {
      LiveTradingManager.pushTick(nowSec, rawUpCents);
      if (_liveBtcCurrent) {
        LiveTradingManager.pushBtcTick(nowSec, _liveBtcCurrent, _liveBtcOpen);
      }
    }

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

    const fmt = v => v !== null ? Math.round(v) + '¢' : '--¢';
    const prevCurrent = el.priceCurrent ? el.priceCurrent.textContent : '';
    const newCurrent  = fmt(effCents);

    let displaySpread = null;
    if (askCents !== null && bidCents !== null) {
      displaySpread = Math.abs(askCents - bidCents);
    } else if (spread !== null) {
      displaySpread = Math.abs(spread * 100);
    }

    if (el.priceCurrent) el.priceCurrent.textContent = newCurrent;
    if (el.priceBid)     el.priceBid.textContent     = fmt(bidCents);
    if (el.priceAsk)     el.priceAsk.textContent     = fmt(askCents);
    if (el.priceMid)     el.priceMid.textContent     = fmt(midCents);
    if (el.priceLast)    el.priceLast.textContent    = fmt(lastCents);
    if (el.priceSpread)  el.priceSpread.textContent  = displaySpread !== null ? Math.round(displaySpread) + '¢' : '--¢';

    if (el.priceCurrent && newCurrent !== prevCurrent && prevCurrent !== '--¢') {
      const prev = parseFloat(prevCurrent);
      const cur  = parseFloat(newCurrent);
      if (!isNaN(prev) && !isNaN(cur) && cur !== prev) {
        const cls = cur > prev ? 'price-flash-up' : 'price-flash-down';
        el.priceCurrent.classList.remove('price-flash-up', 'price-flash-down');
        requestAnimationFrame(() => {
          el.priceCurrent.classList.add(cls);
          setTimeout(() => el.priceCurrent.classList.remove(cls), 500);
        });
      }
    }

    if (el.priceAge && ageMs) {
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

    if (_activeView === 'chart') {
      const aggregated = TickBuffer.aggregate(_currentTfSeconds, _outcomeMode);
      if (aggregated.length > 0) {
        ChartManager.setData(aggregated);
      }
    }

    _updatePriceUI();
    showToast(mode === 'up' ? '📈 Viewing UP Outcome' : '📉 Viewing DOWN Outcome', 'info', 2000);
  }

  // ─── Market Loading ───────────────────────────────────────────────
  async function loadMarket(tfMinutes) {
    showLoading('Fetching market discovery...');
    _loadingRetries = 0;
    _isInitialized = false;
    PriceEngine.reset();
    _currentSessionTicks = [];

    if (window.PolyRTDS) {
      PolyRTDS.setDurationSecs(tfMinutes * 60);
    }

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
    _updateMarketUI(market);

    // Initial strike from metadata
    const metaStrike = parseFloat(market.eventMetadata?.priceToBeat || market.eventMetadata?.targetPrice);
    if (!isNaN(metaStrike) && metaStrike > 0) {
      _liveBtcOpen = metaStrike;
      _updateBtcHeroMetrics(0, _liveBtcCurrent, _liveBtcOpen);
    }

    // 1. Immediately subscribe to Dual-Token WebSocket (UP & DOWN) to eliminate blind spot gap
    setLoadingSub('Connecting to live CLOB Dual-Token WebSocket...');
    PolyWS.subscribe(market.upTokenId, market.downTokenId);
    if (!PolyWS.isConnected()) {
      PolyWS.connect();
    }

    // 2. Fetch rich CLOB + Trades session price history in parallel
    setLoadingSub('Fetching rich CLOB + Trades session history...');
    let hist = [];
    try {
      hist = await MarketManager.fetchSessionPriceHistory(market.upTokenId, market.downTokenId, market.startTs, market.endTs, market.conditionId);
    } catch (e) {}

    // Seed PriceEngine and TickBuffer with history
    if (Array.isArray(hist) && hist.length > 0) {
      TickBuffer.reset(false);
      _currentSessionTicks = [];
      hist.forEach(([t, p]) => {
        TickBuffer.addTick(t, p);
        _currentSessionTicks.push([t, p]);
      });
      const lastP = hist[hist.length - 1][1];
      PriceEngine.updateLastTrade(lastP / 100);
      if (_activeView === 'chart') {
        ChartManager.setData(TickBuffer.aggregate(_currentTfSeconds, _outcomeMode));
      }
    } else {
      const initialProb = market.initialProb || 0.50;
      PriceEngine.updateLastTrade(initialProb);
    }

    // 3. Initialize stationary Live Trading chart with direct history handoff
    if (window.LiveTradingManager) {
      await LiveTradingManager.setMarket(market, hist);
    }

    MarketManager.scheduleRollover(market, _onMarketSwitch);

    // 4. Fetch official target strike
    if (window.PolyRTDS) {
      const dur = (market.startTs && market.endTs) ? (market.endTs - market.startTs) : (tfMinutes * 60);
      PolyRTDS.setDurationSecs(dur);
      if (market.startTs && market.endTs) {
        PolyRTDS.fetchOfficialTargetPrice(market.startTs, market.endTs).then(openP => {
          if (openP) {
            _liveBtcOpen = openP;
            _updateBtcHeroMetrics((_liveBtcCurrent ? _liveBtcCurrent - openP : 0), _liveBtcCurrent, openP);
            if (window.LiveTradingManager) {
              LiveTradingManager.updateBtcPrice(openP, _liveBtcCurrent, _liveBtcChange);
            }
          }
        }).catch(() => {});
      }
    }

    // 5. Fetch accurate midpoint for UP and DOWN tokens
    MarketManager.fetchMidpoint(market.upTokenId).then(mid => {
      if (mid !== null) {
        PriceEngine.updateLastTrade(mid);
        _emitPrice();
      }
    }).catch(() => {});

    _isInitialized = true;
    _updatePriceUI();
    hideLoading();
  }

  // ─── Market Switch (Rollover Callback) ────────────────────────────
  async function _onMarketSwitch(newMarket, prevMarket) {
    console.log('[App] Market rollover:', prevMarket?.slug, '→', newMarket.slug);
    _marketSwitchCount++;

    try {
      const boundaryTs = prevMarket ? prevMarket.endTs : Math.floor(Date.now() / 1000);

      if (prevMarket && (prevMarket.upTokenId || prevMarket.downTokenId)) {
        try { PolyWS.unsubscribe(prevMarket.upTokenId, prevMarket.downTokenId); } catch {}
      }

      if (prevMarket && prevMarket.slug) {
        try {
          const finalPrice = PriceEngine.effectivePrice();
          const isUpWon = finalPrice >= 0.5;
          const winnerStr = isUpWon ? 'UP' : 'DOWN';

          ChartManager.addWinnerBadgeMarker(
            boundaryTs,
            isUpWon ? '🏆 UP WON' : '🏆 DOWN WON',
            isUpWon ? 'up' : 'down'
          );

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
        } catch (e) {
          console.warn('[App] Error saving previous session:', e);
        }
      }

      // Add visual boundary separator to chart
      try {
        ChartManager.addWhitespace(boundaryTs);
        ChartManager.addSessionBoundary(boundaryTs);
        ChartManager.addMarketBoundaryMarker(boundaryTs + 1, '│ New Market');
        TickBuffer.addMarketBoundary(boundaryTs);
      } catch (e) {
        console.warn('[App] Error adding chart boundary:', e);
      }

      // Clean price initialization for the new market
      PriceEngine.reset();
      const newProb = newMarket.initialProb || 0.50;
      PriceEngine.updateLastTrade(newProb);
      _currentSessionTicks = [];

      const nowSec = Math.floor(Date.now() / 1000);
      const initialRawCents = newProb * 100;

      // Seed new session in LiveTradingManager immediately
      if (window.LiveTradingManager) {
        await LiveTradingManager.setMarket(newMarket);
        LiveTradingManager.pushTick(newMarket.startTs || nowSec, initialRawCents);
        LiveTradingManager.pushTick(nowSec, initialRawCents);
        if (_liveBtcCurrent) {
          LiveTradingManager.pushBtcTick(nowSec, _liveBtcCurrent, _liveBtcOpen);
        }
      }

      TickBuffer.addTick(newMarket.startTs || nowSec, initialRawCents);
      TickBuffer.addTick(nowSec, initialRawCents);
      _currentSessionTicks.push([newMarket.startTs || nowSec, initialRawCents]);
      _currentSessionTicks.push([nowSec, initialRawCents]);

      if (_activeView === 'chart') {
        const displayCents = _outcomeMode === 'down' ? (100 - initialRawCents) : initialRawCents;
        ChartManager.pushTick(nowSec, displayCents);
      }

      if (window.PolyRTDS) {
        PolyRTDS.setDurationSecs(_currentTfMinutes * 60);
        PolyRTDS.checkAndRefreshWindow();
      }

      // Dual-token subscription for new market
      PolyWS.subscribe(newMarket.upTokenId, newMarket.downTokenId);
      _updateMarketUI(newMarket);
      if (el.marketCount) el.marketCount.textContent = `Markets: ${_marketSwitchCount + 1}`;

      // Immediate midpoint lookup for new market
      MarketManager.fetchMidpoint(newMarket.upTokenId).then(mid => {
        if (mid !== null) {
          PriceEngine.updateBidAsk(mid - 0.01, mid + 0.01);
          _emitPrice();
        }
      }).catch(() => {});

      _updatePriceUI();
      showToast(`Rollover: ${newMarket.slug}`, 'info', 3500);
    } catch (err) {
      console.error('[App] Rollover error:', err);
    }
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

  function switchTf(tfSeconds) {
    _currentTfSeconds = tfSeconds;
    ChartManager.setTimeframe(tfSeconds);

    if (_activeView === 'chart') {
      const aggregated = TickBuffer.aggregate(tfSeconds, _outcomeMode);
      if (aggregated.length > 0) {
        ChartManager.setData(aggregated);
      }
    }
  }

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
        if (nowSec >= current.endTs + 2) {
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

    el.chkHeadTag?.addEventListener('change', (e) => {
      if (window.LiveTradingManager) {
        LiveTradingManager.setShowHeadBadge(e.target.checked);
        showToast(e.target.checked ? '🏷️ Live Head Badge: ON' : '🏷️ Live Head Badge: OFF', 'info', 1500);
      }
    });

    el.btnModeBtc?.addEventListener('click', () => {
      if (window.LiveTradingManager) {
        LiveTradingManager.setChartMode('btc');
        el.btnModeBtc.classList.add('active');
        el.btnModeToken.classList.remove('active');
        showToast('₿ Mode: BTC Price ($) Live Curve', 'info', 2000);
      }
    });

    el.btnModeToken?.addEventListener('click', () => {
      if (window.LiveTradingManager) {
        LiveTradingManager.setChartMode('token');
        el.btnModeToken.classList.add('active');
        el.btnModeBtc.classList.remove('active');
        showToast('¢ Mode: Option Token Probability (0–100¢)', 'info', 2000);
      }
    });

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
