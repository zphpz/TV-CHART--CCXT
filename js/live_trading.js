/**
 * live_trading.js — Dedicated Fixed 300s (5M) / 900s (15M) Live Trading Engine
 * 
 * Features:
 * - Stationary, non-scrolling full-session canvas locked from second 0 to second 300 (or 900)
 * - Real-time price curve advancing progressively from left to right
 * - Blue dashed vertical second and minute subdivision grid lines
 * - Real-time Chainlink BTC/USD price integration & target comparison
 * - Automatic clean reset on session rollover
 */
'use strict';

window.LiveTradingManager = (() => {
  const LC = window.LightweightCharts;

  let _container          = null;
  let _chart              = null;
  let _series             = null;
  let _overlayCanvas      = null;
  let _overlayCtx         = null;
  let _tooltipEl          = null;

  let _currentMarket      = null;
  let _startTs            = 0;
  let _endTs              = 0;
  let _durationSecs       = 300;    // 300s for 5M, 900s for 15M
  let _outcomeMode        = 'up';   // 'up' | 'down'
  let _rawTicks           = [];     // [[t, val_cents], ...]
  let _lastTickTime       = 0;

  let _btcOpen            = null;
  let _btcCurrent         = null;
  let _btcChange          = null;

  function init(container) {
    if (!LC || !container) {
      console.error('[LiveTradingManager] LightweightCharts or container missing!');
      return false;
    }

    _container = container;

    _chart = LC.createChart(container, {
      layout: {
        background: { type: 'solid', color: '#080b0f' },
        textColor: '#8899aa',
        fontFamily: "'JetBrains Mono', 'Inter', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#0b1320', style: 1 },
        horzLines: { color: '#111720', style: 1 },
      },
      crosshair: {
        mode: LC.CrosshairMode?.Normal ?? 0,
        vertLine: {
          color: '#2a3a50',
          width: 1,
          style: 2,
          labelBackgroundColor: '#161d27',
        },
        horzLine: {
          color: '#2a3a50',
          width: 1,
          style: 2,
          labelBackgroundColor: '#161d27',
        },
      },
      rightPriceScale: {
        borderColor: '#1e2a38',
        scaleMargins: { top: 0.06, bottom: 0.05 },
        autoScale: true,
        entireTextOnly: false,
        visible: true,
      },
      timeScale: {
        visible: false,
      },
      localization: {
        priceFormatter: (p) => p.toFixed(1) + '¢',
      },
      handleScale: false,   // Fixed stationary horizon
      handleScroll: false,  // Non-scrolling stationary canvas
      watermark: { visible: false },
    });

    _series = _chart.addSeries(LC.LineSeries, {
      color: '#00d4aa',
      lineWidth: 2.5,
      lineType: 0,
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineColor: 'rgba(0, 212, 170, 0.6)',
      priceLineWidth: 1,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 5,
      crosshairMarkerBackgroundColor: '#00d4aa',
      crosshairMarkerBorderColor: '#ffffff',
      crosshairMarkerBorderWidth: 1.5,

      autoscaleInfoProvider: () => ({
        priceRange: { minValue: 0, maxValue: 100 },
      }),

      priceFormat: {
        type: 'custom',
        formatter: (v) => v.toFixed(1) + '¢',
        minMove: 0.1,
      },
    });

    _addReferenceLine(50, '#2a3a50', '50¢');
    _setScaleAnchors();

    // Create overlay canvas for blue dashed second division lines & header HUD
    _overlayCanvas = document.createElement('canvas');
    _overlayCanvas.id = 'trading-overlay-canvas';
    _overlayCanvas.style.position = 'absolute';
    _overlayCanvas.style.top = '0';
    _overlayCanvas.style.left = '0';
    _overlayCanvas.style.width = '100%';
    _overlayCanvas.style.height = '100%';
    _overlayCanvas.style.pointerEvents = 'none';
    _overlayCanvas.style.zIndex = '10';
    container.style.position = 'relative';
    container.appendChild(_overlayCanvas);
    _overlayCtx = _overlayCanvas.getContext('2d');

    _setupResize(container);
    _setupInteractions(container);

    console.log('[LiveTradingManager] Initialized with fixed 300s/900s horizon & second grid');
    return true;
  }

  function _addReferenceLine(price, color, title) {
    if (!_series) return;
    _series.createPriceLine({ price, color, lineWidth: 1, lineStyle: 1, axisLabelVisible: false, title });
  }

  function _setScaleAnchors() {
    if (!_series) return;
    _series.createPriceLine({ price: 0,   color: 'transparent', lineWidth: 1, lineStyle: 0, axisLabelVisible: false, title: '' });
    _series.createPriceLine({ price: 100, color: 'transparent', lineWidth: 1, lineStyle: 0, axisLabelVisible: false, title: '' });
  }

  // ─── Set Market (Locks Fixed 300s/900s Horizon) ─────────────────────
  function setMarket(market) {
    if (!market) return;
    _currentMarket = market;
    _startTs = market.startTs || Math.floor(Date.now() / 1000);
    _endTs = market.endTs || (_startTs + 300);
    _durationSecs = Math.max(60, _endTs - _startTs);

    _rawTicks = [];
    _lastTickTime = 0;

    // Reset Chainlink live reference prices
    _btcOpen = parseFloat(market.eventMetadata?.priceToBeat || market.eventMetadata?.targetPrice) || null;
    _btcCurrent = _btcOpen;
    _btcChange = 0;

    // Pre-populate whitespace horizon so the full window is immediately spanned uniformly
    const initData = [];
    const step = (_durationSecs <= 300) ? 5 : 15;
    for (let t = _startTs; t <= _endTs; t += step) {
      initData.push({ time: t });
    }

    try {
      _series.setData(initData);
      _lockVisibleRange();
    } catch {}

    _drawSecondDividers();
  }

  function _lockVisibleRange() {
    if (!_chart || !_startTs || !_endTs) return;
    try {
      _chart.timeScale().setVisibleRange({
        from: _startTs,
        to: _endTs,
      });
    } catch {}
  }

  // ─── Push Real-Time Tick ───────────────────────────────────────────
  function pushTick(unixSec, rawUpCents) {
    if (typeof unixSec !== 'number' || typeof rawUpCents !== 'number' || isNaN(rawUpCents)) return;
    if (!_startTs || !_endTs) {
      _startTs = Math.floor(unixSec / 300) * 300;
      _endTs = _startTs + 300;
      _durationSecs = 300;
    }

    _rawTicks.push([unixSec, rawUpCents]);
    _lastTickTime = unixSec;

    const displayCents = _outcomeMode === 'down' ? (100 - rawUpCents) : rawUpCents;

    try {
      _series.update({ time: unixSec, value: displayCents });
      _updateSeriesColor(displayCents);
    } catch {
      _rebuildSeries();
    }

    _lockVisibleRange();
    _drawSecondDividers();
  }

  function _rebuildSeries() {
    if (!_series || !_startTs || !_endTs) return;
    const pts = [];
    const step = (_durationSecs <= 300) ? 5 : 15;
    for (let t = _startTs; t <= _endTs; t += step) {
      pts.push({ time: t });
    }
    for (const [t, upVal] of _rawTicks) {
      if (t >= _startTs && t <= _endTs) {
        pts.push({
          time: t,
          value: _outcomeMode === 'down' ? (100 - upVal) : upVal,
        });
      }
    }
    pts.sort((a, b) => a.time - b.time);
    _series.setData(pts);
    _lockVisibleRange();
  }

  function _updateSeriesColor(valueCents) {
    if (!_series) return;
    const color = valueCents > 52 ? '#00d4aa' : (valueCents < 48 ? '#ff4d6d' : '#4dabf7');
    _series.applyOptions({
      color,
      crosshairMarkerBackgroundColor: color,
      priceLineColor: color + '88',
    });
  }

  function setOutcomeMode(mode) {
    _outcomeMode = mode;
    _rebuildSeries();
    _drawSecondDividers();
  }

  function updateBtcPrice(btcOpen, btcClose, btcChange) {
    if (btcOpen !== undefined && btcOpen !== null) _btcOpen = btcOpen;
    if (btcClose !== undefined && btcClose !== null) _btcCurrent = btcClose;
    if (btcChange !== undefined && btcChange !== null) _btcChange = btcChange;
    _drawSecondDividers();
  }

  // ─── Blue Dashed Second Grid & Header HUD ──────────────────────────
  function _drawSecondDividers() {
    if (!_overlayCanvas || !_overlayCtx || !_chart || !_startTs || !_endTs) return;

    const dpr = window.devicePixelRatio || 1;
    const w = _overlayCanvas.clientWidth;
    const h = _overlayCanvas.clientHeight;

    if (_overlayCanvas.width !== w * dpr || _overlayCanvas.height !== h * dpr) {
      _overlayCanvas.width = w * dpr;
      _overlayCanvas.height = h * dpr;
    }

    _overlayCtx.save();
    _overlayCtx.scale(dpr, dpr);
    _overlayCtx.clearRect(0, 0, w, h);

    const HEADER_H = 26;

    // 1. Draw Top Slim Header HUD (Single Line Monospace)
    _overlayCtx.fillStyle = 'rgba(9, 17, 30, 0.92)';
    _overlayCtx.fillRect(0, 0, w, HEADER_H);

    _overlayCtx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
    _overlayCtx.lineWidth = 1;
    _overlayCtx.beginPath();
    _overlayCtx.moveTo(0, HEADER_H + 0.5);
    _overlayCtx.lineTo(w, HEADER_H + 0.5);
    _overlayCtx.stroke();

    const slug = _currentMarket?.slug || 'Live Session';
    const is5m = _durationSecs <= 300;
    const labelDuration = is5m ? '5M FIXED (300s)' : '15M FIXED (900s)';

    let curX = 14;
    const textY = 17;

    // Slug Header
    _overlayCtx.font = '600 12px "JetBrains Mono", monospace';
    _overlayCtx.fillStyle = '#ffffff';
    _overlayCtx.fillText(`${slug} ↗`, curX, textY);
    curX += _overlayCtx.measureText(`${slug} ↗`).width + 10;

    // Separator
    _overlayCtx.fillStyle = '#64748b';
    _overlayCtx.fillText('·', curX, textY);
    curX += 14;

    // Live Badge
    _overlayCtx.fillStyle = '#38bdf8';
    _overlayCtx.font = '800 12px "JetBrains Mono", monospace';
    _overlayCtx.fillText(`⏳ LIVE ${labelDuration}`, curX, textY);
    curX += _overlayCtx.measureText(`⏳ LIVE ${labelDuration}`).width + 10;

    // Chainlink BTC Price Feed
    if (_btcCurrent) {
      _overlayCtx.fillStyle = '#64748b';
      _overlayCtx.fillText('·', curX, textY);
      curX += 14;

      const openStr = _btcOpen ? '$' + _btcOpen.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '--';
      const curStr  = '$' + _btcCurrent.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const sign = (_btcChange || 0) >= 0 ? '+' : '';
      const chgStr = _btcChange !== null && _btcChange !== undefined ? ` (${sign}${_btcChange.toFixed(2)}%)` : '';

      _overlayCtx.fillStyle = '#94a3b8';
      _overlayCtx.font = '600 12px "JetBrains Mono", monospace';
      _overlayCtx.fillText('BTC ', curX, textY);
      curX += _overlayCtx.measureText('BTC ').width;

      const priceText = `${openStr} → ${curStr}${chgStr}`;
      _overlayCtx.fillStyle = (_btcChange || 0) >= 0 ? '#34d399' : '#cbd5e1';
      _overlayCtx.fillText(priceText, curX, textY);
      curX += _overlayCtx.measureText(priceText).width + 10;
    }

    // 2. Draw Blue Dashed Second Subdivision Lines
    const stepSecs = is5m ? 30 : 60; // 30s ticks for 5m, 60s ticks for 15m
    const majorStepSecs = is5m ? 60 : 180; // Major 1m lines for 5m, 3m for 15m
    const plotRight = (w > 80) ? (w - 55) : w;

    for (let s = 0; s <= _durationSecs; s += stepSecs) {
      const x = (s / _durationSecs) * plotRight;
      if (x < 0 || x > plotRight) continue;

      const isMajor = (s % majorStepSecs === 0);

      _overlayCtx.beginPath();
      _overlayCtx.strokeStyle = isMajor ? 'rgba(56, 189, 248, 0.75)' : 'rgba(56, 189, 248, 0.28)';
      _overlayCtx.lineWidth = isMajor ? 1.5 : 1;
      _overlayCtx.setLineDash(isMajor ? [4, 4] : [2, 3]);
      _overlayCtx.moveTo(Math.round(x) + 0.5, HEADER_H + 1);
      _overlayCtx.lineTo(Math.round(x) + 0.5, h - 22);
      _overlayCtx.stroke();

      // Second mark label at bottom
      const m = Math.floor(s / 60);
      const secRem = s % 60;
      const timeTag = isMajor ? `${m}m` : `${s}s`;
      const fullTag = `+${String(m).padStart(2, '0')}:${String(secRem).padStart(2, '0')}`;

      _overlayCtx.fillStyle = isMajor ? '#38bdf8' : '#64748b';
      _overlayCtx.font = isMajor ? 'bold 10px "JetBrains Mono", monospace' : '9px "JetBrains Mono", monospace';
      const tagW = _overlayCtx.measureText(isMajor ? fullTag : timeTag).width;
      _overlayCtx.fillText(isMajor ? fullTag : timeTag, Math.round(x - tagW / 2), h - 8);
    }

    _overlayCtx.restore();
  }

  function _setupResize(container) {
    const ro = new ResizeObserver(() => {
      if (_chart && container) {
        const h = container.clientHeight || 500;
        _chart.applyOptions({
          width: container.clientWidth,
          height: h,
        });
        _lockVisibleRange();
        _drawSecondDividers();
      }
    });
    ro.observe(container);
  }

  function _setupInteractions(container) {
    if (!container) return;
    container.addEventListener('click', (e) => {
      const rect = container.getBoundingClientRect();
      const my = e.clientY - rect.top;
      if (my <= 26 && _currentMarket?.slug) {
        window.open(`https://polymarket.com/event/${_currentMarket.slug}`, '_blank');
      }
    });
  }

  function resize() {
    if (_chart && _container) {
      _chart.applyOptions({
        width: _container.clientWidth,
        height: _container.clientHeight,
      });
      _lockVisibleRange();
      _drawSecondDividers();
    }
  }

  function destroy() {
    if (_chart) {
      _chart.remove();
      _chart = null;
      _series = null;
    }
  }

  return {
    init,
    setMarket,
    pushTick,
    setOutcomeMode,
    updateBtcPrice,
    resize,
    destroy,
  };
})();
