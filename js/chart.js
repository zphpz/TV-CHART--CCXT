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

    // Setup Crosshair Tooltip Hover listener
    _setupCrosshairTooltip(container);

    // Auto-resize observer
    _setupResize(container);

    // Start RAF rendering loop
    _startRenderLoop();

    console.log('[ChartManager] Lightweight Charts v5 initialized with visible 0–100 scale');
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

    const map = new Map();
    for (const pt of data) {
      if (typeof pt.time === 'number' && typeof pt.value === 'number' && !isNaN(pt.value)) {
        map.set(pt.time, pt.value);
      }
    }

    const sorted = Array.from(map.entries())
      .sort(([a], [b]) => a - b)
      .map(([time, value]) => ({ time, value }));

    if (sorted.length === 0) return;

    _lastTime = sorted[sorted.length - 1].time;
    _series.setData(sorted);
    _updateSeriesColor(sorted[sorted.length - 1].value);
    _chart.timeScale().scrollToRealTime();
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
      _chart.timeScale().scrollToRealTime();
      _chart.timeScale().resetTimeScale();
    }
  }

  function _setupResize(container) {
    const ro = new ResizeObserver(() => {
      if (_chart && container) {
        _chart.applyOptions({
          width:  container.clientWidth,
          height: container.clientHeight,
        });
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
