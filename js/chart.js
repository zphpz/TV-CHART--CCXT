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
        scaleMargins: { top: 0.04, bottom: 0.04 },
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
    _overlayCtx.strokeStyle = 'rgba(77, 171, 247, 0.45)'; // Semi-transparent blue dashed line
    _overlayCtx.lineWidth = 1;
    _overlayCtx.setLineDash([4, 4]);

    // Sort boundaries chronologically
    const sorted = Array.from(_sessionBoundaries).sort((a, b) => a - b);
    let lastDrawnX = -9999;
    const minPixelGap = 20; // Minimum 20px gap to avoid barcode moiré when zoomed out

    for (const ts of sorted) {
      let x = timeScale.timeToCoordinate(ts);
      if (x === null) {
        // Try nearby offsets in case boundary point was bucketed
        for (let delta = 1; delta <= 30; delta++) {
          x = timeScale.timeToCoordinate(ts + delta);
          if (x !== null) break;
          x = timeScale.timeToCoordinate(ts - delta);
          if (x !== null) break;
        }
      }

      if (x !== null && x >= 0 && x <= w) {
        if (Math.abs(x - lastDrawnX) < minPixelGap) {
          continue; // Skip lines that are too densely packed
        }
        lastDrawnX = x;

        _overlayCtx.beginPath();
        _overlayCtx.moveTo(Math.round(x) + 0.5, 0);
        _overlayCtx.lineTo(Math.round(x) + 0.5, h);
        _overlayCtx.stroke();
      }
    }

    // Draw interactive session header cards
    _drawSessionCards(w, h, timeScale);

    _overlayCtx.restore();
  }

  function _drawSessionCards(w, h, timeScale) {
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

      // Center horizontally inside the session window
      const sessionMidX = (xStart + xEnd) / 2;

      const isUp = s.winner === 'UP';
      const isDown = s.winner === 'DOWN';
      const isLive = s.winner === 'LIVE' || s.isLive || s.winner === 'PENDING';
      const badgeText = isUp ? '🏆 UP WON' : (isDown ? '🏆 DOWN WON' : '⏳ LIVE');
      const badgeBg = isUp ? '#ffffff' : (isDown ? '#e11d48' : '#0284c7');
      const badgeFg = isUp ? '#090d16' : '#ffffff';

      // ── Level of Detail 1: Ultra-compact when zoomed far out (< 85px)
      if (spanW < 85) {
        const miniW = isLive ? 48 : (isUp ? 68 : 82);
        const miniH = 18;
        const miniX = Math.round(sessionMidX - miniW / 2);
        const miniY = 8;

        _overlayCtx.fillStyle = badgeBg;
        _roundRect(_overlayCtx, miniX, miniY, miniW, miniH, 4, true, false);

        _overlayCtx.fillStyle = badgeFg;
        _overlayCtx.font = '800 9px "Inter", system-ui, sans-serif';
        _overlayCtx.fillText(badgeText, miniX + 4, miniY + 13);
        continue;
      }

      // ── Level of Detail 2: Standard and Large view (>= 85px)
      const cardW = Math.max(140, Math.min(360, spanW - 12));
      const cardH = spanW < 180 ? 40 : 66;
      const cardX = Math.round(sessionMidX - cardW / 2);
      const cardY = 8;

      // Dark Matte Card Background
      _overlayCtx.fillStyle = '#131822';
      _overlayCtx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
      _overlayCtx.lineWidth = 1;
      _roundRect(_overlayCtx, cardX, cardY, cardW, cardH, 8, true, true);

      // 1. Session Slug Header (Pure White bold font, clickable)
      const slugText = (s.slug || 'Session') + ' ↗';
      _overlayCtx.font = spanW < 180 ? 'bold 11px "Inter", sans-serif' : 'bold 13px "Inter", system-ui, -apple-system, sans-serif';
      _overlayCtx.fillStyle = '#ffffff';
      _overlayCtx.fillText(slugText, cardX + 10, cardY + (spanW < 180 ? 16 : 22), cardW - 20);

      _clickableRegions.push({
        x: cardX,
        y: cardY,
        w: cardW,
        h: spanW < 180 ? 22 : 28,
        slug: s.slug,
        url: `https://polymarket.com/event/${s.slug}`,
      });

      // 2. Winner Pill Badge
      const badgeW = isLive ? 60 : (isUp ? 78 : 96);
      const badgeH = spanW < 180 ? 16 : 22;
      const badgeX = cardX + 10;
      const badgeY = cardY + (spanW < 180 ? 20 : 34);

      _overlayCtx.fillStyle = badgeBg;
      _roundRect(_overlayCtx, badgeX, badgeY, badgeW, badgeH, 4, true, false);

      _overlayCtx.fillStyle = badgeFg;
      _overlayCtx.font = spanW < 180 ? '800 9px "Inter", sans-serif' : '800 11px "Inter", system-ui, -apple-system, sans-serif';
      _overlayCtx.fillText(badgeText, badgeX + 5, badgeY + (spanW < 180 ? 12 : 15));

      // 3. BTC Reference Prices (Shown when spanW >= 180px)
      if (spanW >= 180 && s.btcOpen && s.btcClose) {
        const btcOpenFmt = '$' + Math.round(s.btcOpen).toLocaleString();
        const btcCloseFmt = '$' + Math.round(s.btcClose).toLocaleString();
        const sign = s.btcClose >= s.btcOpen ? '+' : '';
        const chgFmt = s.btcChange !== null && s.btcChange !== undefined ? ` (${sign}${s.btcChange.toFixed(2)}%)` : '';
        
        _overlayCtx.fillStyle = '#94a3b8';
        _overlayCtx.font = 'bold 11px "JetBrains Mono", monospace';
        const labelText = 'BTC ';
        _overlayCtx.fillText(labelText, badgeX + badgeW + 8, badgeY + 15);
        const labelWidth = _overlayCtx.measureText(labelText).width;

        const priceText = `${btcOpenFmt} → ${btcCloseFmt}${chgFmt}`;
        _overlayCtx.fillStyle = s.btcClose >= s.btcOpen ? '#34d399' : '#cbd5e1';
        _overlayCtx.font = 'bold 12px "JetBrains Mono", monospace';
        _overlayCtx.fillText(priceText, badgeX + badgeW + 8 + labelWidth, badgeY + 15, cardW - badgeW - labelWidth - 20);
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

  function _setupResize(container) {
    const ro = new ResizeObserver(() => {
      if (_chart && container) {
        _chart.applyOptions({
          width:  container.clientWidth,
          height: container.clientHeight,
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
    clearMarkers,
    setTimeframe,
    setOutcomeMode,
    getCurrentTf,
    getLastTime,
    resetZoom,
    updateTickSize,
    destroy,
  };
})();
