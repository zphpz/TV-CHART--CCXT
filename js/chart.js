/**
 * chart.js — Lightweight Charts v5 Manager v1.3
 * 
 * Fixes in v1.3:
 * - autoScale: true with fixed autoscaleInfoProvider (0–100¢) ensures the right scale is always fully visible on boot
 * - No need to double-click the scale to reset or show full range
 * - Smooth live updates without sawtooth jitter
 * - Floating price tooltip on crosshair hover (rounded badge above dot)
 */
'use strict';

window.ChartManager = (() => {
  const LC = window.LightweightCharts;

  let _chart         = null;
  let _series        = null;
  let _markers       = [];
  let _lastTime      = 0;
  let _currentTf     = 1;
  let _outcomeMode   = 'up'; // 'up' | 'down'
  let _tooltipEl     = null;
  let _overlayCanvas = null;
  let _overlayCtx    = null;
  let _sessionBoundaries = new Set(); // set of unixSec timestamps for session dividers
  let _sessionCardsData  = [];        // array of session card metadata
  let _clickableRegions  = [];        // array of interactive clickable bounding boxes

  let _pendingUpdate = null;
  let _rafId         = null;

  function init(container) {
    if (!LC) {
      console.error('[ChartManager] LightweightCharts library not found!');
      return false;
    }

    _tooltipEl = document.getElementById('chart-tooltip');

    _chart = LC.createChart(container, {
      layout: {
        background: { type: 'solid', color: '#080b0f' },
        textColor: '#8899aa',
        fontFamily: "'JetBrains Mono', 'Inter', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#0d1117', style: 1 },
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
        scaleMargins: { top: 0.18, bottom: 0.04 }, // Generous 18% top zone reserved for session info cards
        autoScale: true,          // TRUE: allows autoscaleInfoProvider to calculate full 0-100 scale on load
        entireTextOnly: false,
        visible: true,
      },
      timeScale: {
        borderColor: '#1e2a38',
        timeVisible: true,
        secondsVisible: true,
        rightOffset: 8,
        tickMarkFormatter: (time) => {
          const d = new Date(time * 1000);
          const h = String(d.getHours()).padStart(2, '0');
          const m = String(d.getMinutes()).padStart(2, '0');
          const s = String(d.getSeconds()).padStart(2, '0');
          return `${h}:${m}:${s}`;
        },
      },
      localization: {
        priceFormatter: (p) => p.toFixed(1) + '¢',
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: true,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      watermark: { visible: false },
    });

    // Create main LineSeries
    _series = _chart.addSeries(LC.LineSeries, {
      color: '#00d4aa',
      lineWidth: 2,
      lineType: 0,
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineColor: 'rgba(0, 212, 170, 0.5)',
      priceLineWidth: 1,
      priceLineStyle: 1,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 5,
      crosshairMarkerBackgroundColor: '#00d4aa',
      crosshairMarkerBorderColor: '#ffffff',
      crosshairMarkerBorderWidth: 1,

      // Fixed 0–100¢ range guaranteed
      autoscaleInfoProvider: () => ({
        priceRange: { minValue: 0, maxValue: 100 },
      }),

      priceFormat: {
        type: 'custom',
        formatter: (v) => v.toFixed(1) + '¢',
        minMove: 0.1,
      },
    });

    // Reference line at 50¢
    _addReferenceLine(50, '#2a3a50', '50¢');

    // Anchor invisible price lines at 0 and 100
    _setScaleAnchors();

    // Create overlay canvas for dashed blue session separators
    _overlayCanvas = document.createElement('canvas');
    _overlayCanvas.id = 'chart-overlay-canvas';
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

    // Redraw dashed blue separators on visible range changes & scroll
    _chart.timeScale().subscribeVisibleTimeRangeChange(_drawSessionDividers);
    _chart.timeScale().subscribeVisibleLogicalRangeChange(_drawSessionDividers);

    // Setup interactive canvas clicks & hover for session badges
    _setupCanvasInteractions(container);

    // Setup Crosshair Tooltip Hover listener
    _setupCrosshairTooltip(container);

    // Auto-resize observer
    _setupResize(container);

    // Start RAF rendering loop
    _startRenderLoop();

    console.log('[ChartManager] Lightweight Charts v5 initialized with visible 0–100 scale & session dividers');
    return true;
  }

  function _addReferenceLine(price, color, title) {
    if (!_series) return;
    _series.createPriceLine({
      price,
      color,
      lineWidth: 1,
      lineStyle: 1,
      axisLabelVisible: false,
      title,
    });
  }

  function _setScaleAnchors() {
    if (!_series) return;
    _series.createPriceLine({ price: 0,   color: 'transparent', lineWidth: 1, lineStyle: 0, axisLabelVisible: false, title: '' });
    _series.createPriceLine({ price: 100, color: 'transparent', lineWidth: 1, lineStyle: 0, axisLabelVisible: false, title: '' });
  }

  // ─── Floating Tooltip on Hover ──────────────────────────────────────
  function _setupCrosshairTooltip(container) {
    if (!_chart || !_tooltipEl) return;

    _chart.subscribeCrosshairMove((param) => {
      if (
        !param ||
        !param.point ||
        param.point.x < 0 ||
        param.point.x > container.clientWidth ||
        param.point.y < 0 ||
        param.point.y > container.clientHeight
      ) {
        _tooltipEl.style.display = 'none';
        return;
      }

      const seriesData = param.seriesData.get(_series);
      if (!seriesData || typeof seriesData.value !== 'number') {
        _tooltipEl.style.display = 'none';
        return;
      }

      const val = seriesData.value;
      const formattedPrice = val.toFixed(1) + '¢';

      let timeStr = '';
      if (param.time) {
        const d = new Date(param.time * 1000);
        timeStr = d.toLocaleTimeString('en-US', { hour12: false });
      }

      _tooltipEl.innerHTML = `<span class="tt-val">${formattedPrice}</span>${timeStr ? ` <span class="tt-time" style="font-size:10px; opacity:0.7; font-weight:normal; margin-left:4px;">${timeStr}</span>` : ''}`;

      _tooltipEl.className = '';
      if (val > 52) _tooltipEl.className = 'tt-green';
      else if (val < 48) _tooltipEl.className = 'tt-red';
      else _tooltipEl.className = 'tt-blue';

      const x = param.point.x;
      const y = param.point.y;

      _tooltipEl.style.left = `${x}px`;
      _tooltipEl.style.top = `${y}px`;
      _tooltipEl.style.display = 'block';
    });
  }

  // ─── Data Management ────────────────────────────────────────────────
  function setData(data) {
    if (!_series || !data || data.length === 0) return;

    const sorted = [...data].sort((a, b) => a.time - b.time);
    if (sorted.length === 0) return;

    _lastTime = sorted[sorted.length - 1].time;
    _series.setData(sorted);
    if (_markers.length > 0) {
      try { _series.setMarkers(_markers); } catch {}
    }

    for (let i = sorted.length - 1; i >= 0; i--) {
      if (typeof sorted[i].value === 'number' && !isNaN(sorted[i].value)) {
        _updateSeriesColor(sorted[i].value);
        break;
      }
    }

    _drawSessionDividers();
  }

  function pushTick(unixSec, valueCents) {
    if (isNaN(valueCents) || isNaN(unixSec)) return;
    const bucket = Math.floor(unixSec / _currentTf) * _currentTf;

    if (bucket < _lastTime) return;

    _pendingUpdate = { time: bucket, value: valueCents };
  }

  function _startRenderLoop() {
    function loop() {
      if (_pendingUpdate && _series) {
        const { time, value } = _pendingUpdate;
        _pendingUpdate = null;

        try {
          _series.update({ time, value });
          _lastTime = Math.max(_lastTime, time);
          _updateSeriesColor(value);
        } catch (e) {
          // Ignore non-monotone exceptions during boundary transitions
        }
      }
      _rafId = requestAnimationFrame(loop);
    }
    _rafId = requestAnimationFrame(loop);
  }

  function addWhitespace(unixSec) {
    if (!_series) return;
    const t = Math.max(unixSec, _lastTime + 1);
    try {
      _series.update({ time: t });
      _lastTime = t;
    } catch {}
  }

  function _updateSeriesColor(valueCents) {
    if (!_series) return;
    let color;
    if (valueCents > 52) color = '#00d4aa';
    else if (valueCents < 48) color = '#ff4d6d';
    else color = '#4dabf7';

    _series.applyOptions({
      color,
      crosshairMarkerBackgroundColor: color,
      priceLineColor: color + '88',
    });
  }

  // ─── Markers ────────────────────────────────────────────────────────
  function addMarketBoundaryMarker(unixSec, label) {
    _markers.push({
      time: unixSec,
      position: 'belowBar',
      color: '#4dabf7',
      shape: 'arrowUp',
      text: label || 'New Market',
      size: 1,
    });
    _markers.sort((a, b) => a.time - b.time);
    try {
      _series.setMarkers(_markers);
    } catch {}
  }

  /**
   * Winner Badge Marker:
   * - UP WON: White badge (#ffffff)
   * - DOWN WON: Coral red badge (#ff4d6d)
   */
  function addWinnerBadgeMarker(unixSec, label, side = 'up') {
    const isUp = side === 'up' || (typeof label === 'string' && label.includes('UP'));
    _markers.push({
      time: unixSec,
      position: 'aboveBar',
      color: isUp ? '#ffffff' : '#ff4d6d',
      shape: 'arrowDown',
      text: label || (isUp ? '🏆 UP WON' : '🏆 DOWN WON'),
      size: 2,
    });
    _markers.sort((a, b) => a.time - b.time);
    try {
      _series.setMarkers(_markers);
    } catch {}
  }

  // ─── Dashed Blue Session Dividers ──────────────────────────────────
  function _drawSessionDividers() {
    if (!_overlayCanvas || !_overlayCtx || !_chart) return;

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

    if (_sessionBoundaries.size === 0) {
      _overlayCtx.restore();
      return;
    }

    const timeScale = _chart.timeScale();
    const HEADER_H = 72; // Dedicated top header panel height (px)

    // 1. Draw top session header panels for each session
    _drawSessionHeaderPanels(w, h, timeScale, HEADER_H);

    // 2. Draw continuous horizontal dividing line below the top header panel
    _overlayCtx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
    _overlayCtx.lineWidth = 1;
    _overlayCtx.setLineDash([]); // solid line
    _overlayCtx.beginPath();
    _overlayCtx.moveTo(0, HEADER_H + 0.5);
    _overlayCtx.lineTo(w, HEADER_H + 0.5);
    _overlayCtx.stroke();

    // 3. Draw vertical session dividers (thicker, brighter electric cyan/blue dashed lines)
    _overlayCtx.strokeStyle = 'rgba(56, 189, 248, 0.85)';
    _overlayCtx.lineWidth = 2;
    _overlayCtx.setLineDash([6, 4]);

    const sorted = Array.from(_sessionBoundaries).sort((a, b) => a - b);
    let lastDrawnX = -9999;
    const minPixelGap = 20;

    for (const ts of sorted) {
      let x = timeScale.timeToCoordinate(ts);
      if (x === null) {
        for (let delta = 1; delta <= 30; delta++) {
          x = timeScale.timeToCoordinate(ts + delta);
          if (x !== null) break;
          x = timeScale.timeToCoordinate(ts - delta);
          if (x !== null) break;
        }
      }

      if (x !== null && x >= 0 && x <= w) {
        if (Math.abs(x - lastDrawnX) < minPixelGap) {
          continue;
        }
        lastDrawnX = x;

        _overlayCtx.beginPath();
        _overlayCtx.moveTo(Math.round(x) + 0.5, 0);
        _overlayCtx.lineTo(Math.round(x) + 0.5, h);
        _overlayCtx.stroke();
      }
    }

    _overlayCtx.restore();
  }

  function _drawSessionHeaderPanels(w, h, timeScale, HEADER_H) {
    _clickableRegions = [];
    if (!_sessionCardsData || _sessionCardsData.length === 0) return;

    for (const s of _sessionCardsData) {
      let xStart = timeScale.timeToCoordinate(s.startTs);
      if (xStart === null && s.startTs) {
        for (let delta = 1; delta <= 300; delta += 2) {
          xStart = timeScale.timeToCoordinate(s.startTs + delta);
          if (xStart !== null) break;
          xStart = timeScale.timeToCoordinate(s.startTs - delta);
          if (xStart !== null) break;
        }
      }

      let xEnd = timeScale.timeToCoordinate(s.endTs);
      if (xEnd === null && s.endTs) {
        for (let delta = 1; delta <= 300; delta += 2) {
          xEnd = timeScale.timeToCoordinate(s.endTs - delta);
          if (xEnd !== null) break;
          xEnd = timeScale.timeToCoordinate(s.endTs + delta);
          if (xEnd !== null) break;
        }
      }

      if (xStart === null && xEnd === null) continue;
      if (xStart === null) xStart = xEnd - 250;
      if (xEnd === null) xEnd = xStart + 250;

      if (xEnd < 0 || xStart > w) continue;
      const spanW = Math.abs(xEnd - xStart);
      if (spanW < 25) continue; // too compact when zoomed far out

      // Panel spans from xStart to xEnd in the top HEADER_H zone
      const panelX = Math.round(xStart);
      const panelW = Math.round(spanW);

      // Background fill for this session's header column
      _overlayCtx.fillStyle = 'rgba(9, 17, 30, 0.88)';
      _overlayCtx.fillRect(panelX, 0, panelW, HEADER_H);

      // Subtle right divider border for the header column
      _overlayCtx.strokeStyle = 'rgba(56, 189, 248, 0.3)';
      _overlayCtx.lineWidth = 1;
      _overlayCtx.setLineDash([]);
      _overlayCtx.beginPath();
      _overlayCtx.moveTo(panelX + panelW + 0.5, 0);
      _overlayCtx.lineTo(panelX + panelW + 0.5, HEADER_H);
      _overlayCtx.stroke();

      const isUp = s.winner === 'UP';
      const isDown = s.winner === 'DOWN';
      const isLive = s.winner === 'LIVE' || s.isLive || s.winner === 'PENDING';
      const badgeText = isUp ? '🏆 UP WON' : (isDown ? '🏆 DOWN WON' : '⏳ LIVE');
      const badgeBg = isUp ? '#f8fafc' : (isDown ? '#e11d48' : '#0284c7');
      const badgeFg = isUp ? '#090d16' : '#ffffff';

      // ── Level of Detail 1: Ultra-compact when zoomed far out (< 85px)
      if (spanW < 85) {
        const miniW = isLive ? 48 : (isUp ? 68 : 82);
        const miniH = 18;
        const miniX = Math.round(panelX + (spanW - miniW) / 2);
        const miniY = 27;

        _overlayCtx.fillStyle = badgeBg;
        _roundRect(_overlayCtx, miniX, miniY, miniW, miniH, 4, true, false);

        _overlayCtx.fillStyle = badgeFg;
        _overlayCtx.font = '800 9px "Inter", system-ui, sans-serif';
        _overlayCtx.fillText(badgeText, miniX + 4, miniY + 13);
        continue;
      }

      // ── Level of Detail 2: Standard & Full-Width Header Panel
      const padX = 14;
      const contentX = panelX + padX;
      const maxContentW = panelW - padX * 2;

      // Row 1: Session Slug Header & Time Window (y ≈ 24px)
      const slugText = (s.slug || 'Session') + ' ↗';
      _overlayCtx.font = 'bold 13px "Inter", system-ui, -apple-system, sans-serif';
      _overlayCtx.fillStyle = '#ffffff';
      _overlayCtx.fillText(slugText, contentX, 26, maxContentW);

      const slugW = _overlayCtx.measureText(slugText).width;
      _clickableRegions.push({
        x: contentX,
        y: 4,
        w: Math.min(slugW + 10, maxContentW),
        h: 28,
        slug: s.slug,
        url: `https://polymarket.com/event/${s.slug}`,
      });

      // Optional time window string on the right of Row 1
      if (spanW >= 240 && s.startTs && s.endTs) {
        const fmtTime = ts => {
          const d = new Date(ts * 1000);
          return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        };
        const windowStr = `${fmtTime(s.startTs)} – ${fmtTime(s.endTs)}`;
        _overlayCtx.font = '600 11px "Inter", system-ui, sans-serif';
        _overlayCtx.fillStyle = '#64748b';
        const winW = _overlayCtx.measureText(windowStr).width;
        if (contentX + slugW + 16 < panelX + panelW - winW - padX) {
          _overlayCtx.fillText(windowStr, panelX + panelW - winW - padX, 26);
        }
      }

      // Row 2: Winner Pill Badge + BTC Prices (y ≈ 56px)
      const badgeW = isLive ? 64 : (isUp ? 82 : 100);
      const badgeH = 22;
      const badgeY = 38;

      _overlayCtx.fillStyle = badgeBg;
      _roundRect(_overlayCtx, contentX, badgeY, badgeW, badgeH, 4, true, false);

      _overlayCtx.fillStyle = badgeFg;
      _overlayCtx.font = '800 11px "Inter", system-ui, -apple-system, sans-serif';
      _overlayCtx.fillText(badgeText, contentX + 6, badgeY + 15);

      // BTC Reference Prices
      if (spanW >= 170 && s.btcOpen && s.btcClose) {
        const btcOpenFmt = '$' + (typeof s.btcOpen === 'number' ? s.btcOpen.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : s.btcOpen);
        const btcCloseFmt = '$' + (typeof s.btcClose === 'number' ? s.btcClose.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : s.btcClose);
        const sign = s.btcClose >= s.btcOpen ? '+' : '';
        const chgFmt = s.btcChange !== null && s.btcChange !== undefined ? ` (${sign}${s.btcChange.toFixed(2)}%)` : '';
        
        _overlayCtx.fillStyle = '#94a3b8';
        _overlayCtx.font = 'bold 11px "JetBrains Mono", monospace';
        const labelText = 'BTC ';
        _overlayCtx.fillText(labelText, contentX + badgeW + 8, badgeY + 15);
        const labelWidth = _overlayCtx.measureText(labelText).width;

        const priceText = `${btcOpenFmt} → ${btcCloseFmt}${chgFmt}`;
        _overlayCtx.fillStyle = s.btcClose >= s.btcOpen ? '#34d399' : '#cbd5e1';
        _overlayCtx.font = 'bold 12px "JetBrains Mono", monospace';
        _overlayCtx.fillText(priceText, contentX + badgeW + 8 + labelWidth, badgeY + 15, maxContentW - badgeW - labelWidth - 10);
      }
    }
  }

  function _roundRect(ctx, x, y, width, height, radius, fill, stroke) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    if (fill) ctx.fill();
    if (stroke) ctx.stroke();
  }

  function setSessionCardsData(cards) {
    _sessionCardsData = Array.isArray(cards) ? cards : [];
    _drawSessionDividers();
  }

  function addSessionBoundary(unixSec) {
    if (typeof unixSec === 'number') {
      _sessionBoundaries.add(unixSec);
      _drawSessionDividers();
    }
  }

  function setSessionBoundaries(timestampsArray) {
    _sessionBoundaries = new Set();
    if (Array.isArray(timestampsArray)) {
      for (const t of timestampsArray) {
        if (typeof t === 'number') _sessionBoundaries.add(t);
      }
    }
    _drawSessionDividers();
  }

  function clearSessionBoundaries() {
    _sessionBoundaries.clear();
    _sessionCardsData = [];
    _drawSessionDividers();
  }

  function updateLiveSessionBtc(slug, btcOpen, btcClose, btcChange) {
    if (!_sessionCardsData || _sessionCardsData.length === 0) return;
    let card = _sessionCardsData.find(c => c.slug === slug);
    if (!card) {
      const last = _sessionCardsData[_sessionCardsData.length - 1];
      if (last && (last.isLive || last.winner === 'LIVE' || last.winner === 'PENDING')) {
        card = last;
      }
    }
    if (card) {
      if (btcOpen !== undefined && btcOpen !== null) card.btcOpen = btcOpen;
      if (btcClose !== undefined && btcClose !== null) card.btcClose = btcClose;
      if (btcChange !== undefined && btcChange !== null) card.btcChange = btcChange;
      _drawSessionDividers();
    }
  }

  function clearMarkers() {
    _markers = [];
    try { _series.setMarkers([]); } catch {}
  }

  // ─── Controls ───────────────────────────────────────────────────────
  function setTimeframe(tfSeconds) {
    _currentTf = tfSeconds;
  }

  function setOutcomeMode(mode) {
    _outcomeMode = mode;
  }

  function getCurrentTf() { return _currentTf; }
  function getLastTime()  { return _lastTime; }

  function resetZoom() {
    if (_chart) {
      _chart.timeScale().fitContent();
      _drawSessionDividers();
    }
  }

  function scrollToStart() {
    if (!_chart) return;
    let minTime = Infinity;
    if (_sessionCardsData && _sessionCardsData.length > 0) {
      for (const s of _sessionCardsData) {
        if (s.startTs && s.startTs < minTime) minTime = s.startTs;
      }
    }
    if (minTime === Infinity) {
      const raw = window.TickBuffer?.getRawTicks() || [];
      if (raw.length > 0) minTime = raw[0].time;
    }
    if (minTime < Infinity) {
      _chart.timeScale().setVisibleRange({
        from: minTime,
        to: minTime + 1800, // Show first 30 minutes / ~6 sessions
      });
      _drawSessionDividers();
    }
  }

  function scrollToEnd() {
    if (!_chart) return;
    _chart.timeScale().scrollToRealTime();
    _drawSessionDividers();
  }

  function _setupResize(container) {
    const ro = new ResizeObserver(() => {
      if (_chart && container) {
        const h = container.clientHeight || 500;
        const topMargin = Math.min(0.25, Math.max(0.15, 80 / h));
        _chart.applyOptions({
          width:  container.clientWidth,
          height: h,
          rightPriceScale: {
            scaleMargins: { top: topMargin, bottom: 0.04 },
          },
        });
        _drawSessionDividers();
      }
    });
    ro.observe(container);
  }

  function updateTickSize(tickSize) {
    if (!_series) return;
    const ts = parseFloat(tickSize);
    if (isNaN(ts) || ts <= 0) return;
    _series.applyOptions({
      priceFormat: {
        type: 'custom',
        formatter: (v) => v.toFixed(ts < 0.01 ? 2 : 1) + '¢',
        minMove: ts * 100,
      },
    });
  }

  function _setupCanvasInteractions(container) {
    if (!_overlayCanvas) return;

    _overlayCanvas.addEventListener('mousemove', (e) => {
      const rect = _overlayCanvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      let hovered = false;
      for (const reg of _clickableRegions) {
        if (mx >= reg.x && mx <= reg.x + reg.w && my >= reg.y && my <= reg.y + reg.h) {
          hovered = true;
          break;
        }
      }
      _overlayCanvas.style.pointerEvents = hovered ? 'auto' : 'none';
      if (container) container.style.cursor = hovered ? 'pointer' : 'default';
    });

    _overlayCanvas.addEventListener('click', (e) => {
      const rect = _overlayCanvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      for (const reg of _clickableRegions) {
        if (mx >= reg.x && mx <= reg.x + reg.w && my >= reg.y && my <= reg.y + reg.h) {
          if (reg.url) {
            window.open(reg.url, '_blank');
          }
          break;
        }
      }
    });
  }

  function destroy() {
    if (_rafId) cancelAnimationFrame(_rafId);
    if (_chart) {
      _chart.remove();
      _chart = null;
      _series = null;
    }
  }

  return {
    init,
    setData,
    pushTick,
    addWhitespace,
    addMarketBoundaryMarker,
    addWinnerBadgeMarker,
    addSessionBoundary,
    setSessionBoundaries,
    clearSessionBoundaries,
    setSessionCardsData,
    updateLiveSessionBtc,
    clearMarkers,
    setTimeframe,
    setOutcomeMode,
    getCurrentTf,
    getLastTime,
    resetZoom,
    scrollToStart,
    scrollToEnd,
    updateTickSize,
    destroy,
  };
})();
