/**
 * chart.js — Lightweight Charts v5 initialization and data management
 *
 * Key rules:
 * - series.update() for live ticks (never setData per tick!)
 * - series.setData() only on TF switch or market switch
 * - Fixed Y scale 0-100 via autoscaleInfoProvider
 * - timeVisible + secondsVisible = true
 * - Whitespace points for market boundaries
 * - requestAnimationFrame throttle for render
 */
'use strict';

window.ChartManager = (() => {
  // Lightweight Charts v5 — global via CDN
  // Available as: LightweightCharts.createChart, LightweightCharts.LineSeries
  const LC = window.LightweightCharts;

  let _chart  = null;
  let _series = null;
  let _markers = [];
  let _lastTime = 0;  // monotone guard
  let _currentTf = 1; // seconds

  // requestAnimationFrame throttle
  let _pendingUpdate = null;
  let _rafId = null;

  function init(container) {
    if (!LC) {
      console.error('[ChartManager] LightweightCharts not loaded!');
      return false;
    }

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
        vertLine: { color: '#2a3a50', labelBackgroundColor: '#0d1117' },
        horzLine: { color: '#2a3a50', labelBackgroundColor: '#0d1117' },
      },
      rightPriceScale: {
        borderColor: '#1e2a38',
        scaleMargins: { top: 0.02, bottom: 0.02 },
        autoScale: false,
        entireTextOnly: false,
      },
      timeScale: {
        borderColor: '#1e2a38',
        timeVisible: true,     // REQUIRED: show time on X axis
        secondsVisible: true,  // REQUIRED: show seconds
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

    // Add LineSeries (v5 API: addSeries(Type, opts))
    _series = _chart.addSeries(LC.LineSeries, {
      color: '#00d4aa',
      lineWidth: 2,
      lineType: 0, // Simple
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineColor: 'rgba(0, 212, 170, 0.4)',
      priceLineWidth: 1,
      priceLineStyle: 1, // Dashed
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      crosshairMarkerBackgroundColor: '#00d4aa',

      // Fixed price range 0-100¢
      autoscaleInfoProvider: () => ({
        priceRange: { minValue: 0, maxValue: 100 },
      }),

      priceFormat: {
        type: 'custom',
        formatter: (v) => v.toFixed(1) + '¢',
        minMove: 0.1,
      },
    });

    // Reference line at 50¢ (starting probability)
    _addReferenceLine(50, '#2a3a50', '50¢');

    // Force Y axis to always show 0-100 range
    _chart.priceScale('right').applyOptions({
      autoScale: false,
    });
    // Set initial visible range via invisible anchor points
    _setScaleAnchors();

    // Auto-resize on window resize
    _setupResize(container);

    // Start render loop
    _startRenderLoop();

    console.log('[ChartManager] Initialized with Lightweight Charts v5');
    return true;
  }

  function _addReferenceLine(price, color, title) {
    if (!_series) return;
    _series.createPriceLine({
      price,
      color,
      lineWidth: 1,
      lineStyle: 1, // Dashed
      axisLabelVisible: false,
      title,
    });
  }

  /**
   * Add invisible price lines at 0 and 100 to anchor the Y scale.
   * This prevents autoscale from zooming in when price is near center.
   */
  function _setScaleAnchors() {
    if (!_series) return;
    // Add transparent anchor lines at extremes to keep scale 0-100
    _series.createPriceLine({ price: 0,   color: 'transparent', lineWidth: 1, lineStyle: 0, axisLabelVisible: false, title: '' });
    _series.createPriceLine({ price: 100, color: 'transparent', lineWidth: 1, lineStyle: 0, axisLabelVisible: false, title: '' });
  }

  // ─── Data management ─────────────────────────────────────────────────

  /**
   * Set full historical data (only on init or TF switch)
   * data: [{time: unixSec, value: number}]
   */
  function setData(data) {
    if (!_series || !data || data.length === 0) return;

    // Deduplicate and sort
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

  /**
   * Add a single new tick (queued via requestAnimationFrame)
   */
  function pushTick(unixSec, valueCents) {
    if (isNaN(valueCents) || isNaN(unixSec)) return;
    const bucket = Math.floor(unixSec / _currentTf) * _currentTf;

    // Monotone guard: never go backwards in time
    if (bucket < _lastTime) return;

    _pendingUpdate = { time: bucket, value: valueCents };
  }

  /**
   * RAF render loop: drains _pendingUpdate max once per frame
   */
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
          // Usually: "Cannot update with non-monotonically increasing time" — ignore
        }
      }
      _rafId = requestAnimationFrame(loop);
    }
    _rafId = requestAnimationFrame(loop);
  }

  /**
   * Add a whitespace point (market boundary — breaks the line visually)
   */
  function addWhitespace(unixSec) {
    if (!_series) return;
    const t = Math.max(unixSec, _lastTime + 1);
    try {
      _series.update({ time: t }); // whitespace: no 'value' field
      _lastTime = t;
    } catch {}
  }

  /**
   * Color the line based on position vs 50¢ (above=green, below=red)
   */
  function _updateSeriesColor(valueCents) {
    if (!_series) return;
    let color;
    if (valueCents > 52) color = '#00d4aa';
    else if (valueCents < 48) color = '#ff4d6d';
    else color = '#4dabf7'; // near 50 = blue
    _series.applyOptions({ color });
  }

  // ─── Markers ─────────────────────────────────────────────────────────

  function addMarketBoundaryMarker(unixSec, label) {
    _markers.push({
      time: unixSec,
      position: 'belowBar',
      color: '#4dabf7',
      shape: 'arrowUp',
      text: label || 'New Market',
      size: 1,
    });
    // Sort markers by time and apply
    _markers.sort((a, b) => a.time - b.time);
    try {
      _series.setMarkers(_markers);
    } catch {}
  }

  function clearMarkers() {
    _markers = [];
    try { _series.setMarkers([]); } catch {}
  }

  // ─── Timeframe switch ─────────────────────────────────────────────────

  function setTimeframe(tfSeconds) {
    _currentTf = tfSeconds;
    // The actual data update is done by app.js (which calls setData with re-aggregated buffer)
  }

  function getCurrentTf() { return _currentTf; }
  function getLastTime()  { return _lastTime; }

  // ─── Reset zoom ──────────────────────────────────────────────────────

  function resetZoom() {
    if (_chart) {
      _chart.timeScale().scrollToRealTime();
      _chart.timeScale().resetTimeScale();
    }
  }

  // ─── Resize ─────────────────────────────────────────────────────────

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

  // ─── Tick size update ────────────────────────────────────────────────

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

  // ─── Cleanup ─────────────────────────────────────────────────────────

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
    getCurrentTf,
    getLastTime,
    resetZoom,
    updateTickSize,
    destroy,
  };
})();
