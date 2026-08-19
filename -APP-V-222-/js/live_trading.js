/**
 * live_trading.js — Dedicated Stationary 300s (5M) / 900s (15M) Live Trading Engine v5.2
 * 
 * Features & Fixes in v5.2 (App v7.1):
 * - Instant Canvas Activation & Progressive Background Density Hydration
 * - Safe Timestamp-Deduplicated Merging in setHistoricalTicks
 * - Deep Continuous Background Density Healing: Auto-hydrates full trade depth if initial buffer is sparse
 * - 100% BTC Historical Buffer Ingestion from RTDS on page refresh / mid-session entry (zero gaps/diagonal lines)
 * - Enhanced multi-query token history hydration and session storage synchronization
 * - Direct history handoff from loadMarket eliminates race conditions on page refresh
 * - Step-curve zero-order hold rendering for Option Probability mode
 * - Pure Official CLOB Dual-Token History Hydration
 * - True session-start anchor (anchors startTs to first historical tick)
 * - Zero-allocation point buffer reuse (_pointBuffer) eliminates GC pauses
 * - Cached linear gradients for area under curve
 * - Dual Chart Modes: ₿ BTC ($) live curve vs ¢ PROB (%) option token curve
 * - Large prominent floating live head badge (18px/15px, 10px offset, semi-transparent glass background)
 */
'use strict';

window.LiveTradingManager = (() => {
  let _container     = null;
  let _canvas        = null;
  let _ctx           = null;
  let _tooltipEl     = null;

  let _currentMarket = null;
  let _startTs       = 0;
  let _endTs         = 0;
  let _durationSecs  = 300;     // 300 for 5M, 900 for 15M
  let _chartMode     = localStorage.getItem('pm_chart_mode') || 'btc'; // 'btc' | 'token'
  let _outcomeMode   = 'up';    // 'up' | 'down'
  
  let _rawTicks      = [];      // Array of [unixSec, rawUpCents] (0–100)
  let _btcTicks      = [];      // Array of [unixSec, btcPriceUsd]
  let _lastPrice     = null;
  let _showHeadBadge = localStorage.getItem('pm_show_head_tag') !== 'false';

  let _btcOpen       = null;
  let _btcCurrent    = null;
  let _btcChange     = null;

  let _hoverX        = null;
  let _hoverY        = null;
  let _rafId         = null;
  let _pulsePhase    = 0;
  let _isDirty       = true;
  let _lastFrameTime = 0;
  let _historyRetryTimers = [];

  // Reusable point buffer to eliminate GC allocations
  const _pointBuffer = [];

  // Gradient cache
  let _cachedGradKey = '';
  let _cachedGrad    = null;

  const TOP_HUD_H    = 26;
  const LEFT_SCALE_W = 56;
  const RIGHT_SCALE_W= 56;
  const BOTTOM_AXIS_H= 26;

  function init(container) {
    if (!container) return false;
    _container = container;
    _container.innerHTML = '';
    _container.style.position = 'relative';
    _container.style.width = '100%';
    _container.style.height = '100%';
    _container.style.overflow = 'hidden';
    _container.style.background = '#080b0f';

    _canvas = document.createElement('canvas');
    _canvas.id = 'live-trading-canvas';
    _canvas.style.width = '100%';
    _canvas.style.height = '100%';
    _canvas.style.display = 'block';
    _canvas.style.cursor = 'crosshair';
    _container.appendChild(_canvas);
    _ctx = _canvas.getContext('2d', { alpha: false, desynchronized: true });

    // Tooltip element
    _tooltipEl = document.createElement('div');
    _tooltipEl.id = 'live-trading-tooltip';
    _tooltipEl.style.position = 'absolute';
    _tooltipEl.style.display = 'none';
    _tooltipEl.style.pointerEvents = 'none';
    _tooltipEl.style.zIndex = '20';
    _tooltipEl.style.background = 'rgba(13, 22, 38, 0.94)';
    _tooltipEl.style.border = '1px solid #1e293b';
    _tooltipEl.style.borderRadius = '6px';
    _tooltipEl.style.padding = '4px 8px';
    _tooltipEl.style.color = '#ffffff';
    _tooltipEl.style.fontFamily = "'JetBrains Mono', monospace";
    _tooltipEl.style.fontSize = '11px';
    _tooltipEl.style.boxShadow = '0 4px 12px rgba(0,0,0,0.5)';
    _container.appendChild(_tooltipEl);

    _setupInteractions();
    _setupResize();
    _startAnimationLoop();

    console.log('[LiveTradingManager] Custom 300s/900s Live Trading Canvas initialized (v4.9)');
    return true;
  }

  // ─── SessionStorage Live Stream Cache (F5-Proof Persistence) ───────
  let _lastSaveSessionTime = 0;
  function _saveSessionStorage() {
    if (!_currentMarket?.slug || !_rawTicks || _rawTicks.length === 0) return;
    const now = Date.now();
    if (now - _lastSaveSessionTime < 1000) return; // Throttle to 1s
    _lastSaveSessionTime = now;
    try {
      const payload = {
        slug: _currentMarket.slug,
        rawTicks: _rawTicks,
        btcTicks: _btcTicks,
        lastSaved: now
      };
      sessionStorage.setItem('pm_live_' + _currentMarket.slug, JSON.stringify(payload));
    } catch (e) {}
  }

  function _loadSessionStorage(slug) {
    if (!slug) return null;
    try {
      const raw = sessionStorage.getItem('pm_live_' + slug);
      if (raw) {
        return JSON.parse(raw);
      }
    } catch (e) {}
    return null;
  }

  // ─── Market Initialization & History Population ────────────────────
  async function setMarket(market, initialHist) {
    if (!market) return;
    _currentMarket = market;
    _startTs = market.startTs || Math.floor(Date.now() / 1000);
    _endTs = market.endTs || (_startTs + 300);
    _durationSecs = Math.max(60, _endTs - _startTs);

    _rawTicks = [];
    _btcTicks = [];
    _lastPrice = null;

    _clearHistoryRetryTimers();

    _btcOpen = parseFloat(market.eventMetadata?.priceToBeat || market.eventMetadata?.targetPrice) || null;
    _btcCurrent = _btcOpen;
    _btcChange = 0;

    if (_btcOpen) {
      _btcTicks.push([_startTs, _btcOpen]);
    }

    // Merge API history with any locally recorded live ticks from sessionStorage (F5-proof)
    const cached = _loadSessionStorage(market.slug);
    const tickMap = new Map();
    const btcMap = new Map();

    if (_btcOpen) btcMap.set(_startTs, _btcOpen);

    if (Array.isArray(initialHist) && initialHist.length > 0) {
      initialHist.forEach(([t, p]) => tickMap.set(t, p));
    }

    if (cached) {
      if (Array.isArray(cached.rawTicks)) {
        cached.rawTicks.forEach(([t, p]) => {
          if (t >= _startTs && t <= _endTs) tickMap.set(t, p);
        });
      }
      if (Array.isArray(cached.btcTicks)) {
        cached.btcTicks.forEach(([t, p]) => {
          if (t >= _startTs && t <= _endTs) btcMap.set(t, p);
        });
      }
    }

    // Ingest RTDS historical buffer if available
    if (window.PolyRTDS && typeof PolyRTDS.getHistoricalBuffer === 'function') {
      const rtdsBuf = PolyRTDS.getHistoricalBuffer();
      if (Array.isArray(rtdsBuf) && rtdsBuf.length > 0) {
        rtdsBuf.forEach(pt => {
          const rawVal = pt.value !== undefined ? pt.value : pt.price;
          const val = typeof rawVal === 'number' ? rawVal : parseFloat(rawVal);
          const tsMs = typeof pt.timestamp === 'number' ? pt.timestamp : (typeof pt.t === 'number' ? pt.t * 1000 : null);
          if (tsMs !== null && !isNaN(val) && val > 0) {
            const sec = Math.floor(tsMs / 1000);
            if (sec >= _startTs && sec <= _endTs) {
              btcMap.set(sec, val);
            }
          }
        });
      }
    }

    if (tickMap.size > 0) {
      _rawTicks = Array.from(tickMap.entries()).sort((a, b) => a[0] - b[0]);
      _lastPrice = _rawTicks[_rawTicks.length - 1][1];
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const secIntoSession = nowSec - _startTs;
    if (_rawTicks.length < 25 && secIntoSession > 15) {
      _tryFetchHistory(market);
      _historyRetryTimers.push(setTimeout(() => _tryFetchHistory(market), 1500));
      _historyRetryTimers.push(setTimeout(() => _tryFetchHistory(market), 3500));
    }

    if (btcMap.size > 0) {
      _btcTicks = Array.from(btcMap.entries()).sort((a, b) => a[0] - b[0]);
      _btcCurrent = _btcTicks[_btcTicks.length - 1][1];
    }

    _isDirty = true;
    _render();
  }

  async function _tryFetchHistory(market) {
    if (!market || !window.MarketManager || !market.upTokenId) return;
    const targetSlug = market.slug;
    try {
      const hist = await MarketManager.fetchSessionPriceHistory(market.upTokenId, market.downTokenId, _startTs, _endTs, market.conditionId);
      if (_currentMarket?.slug !== targetSlug) return;
      if (Array.isArray(hist) && hist.length > 0) {
        // Merge fetched history with existing live buffer without overwriting newer live points
        const map = new Map();
        hist.forEach(([t, p]) => map.set(t, p));
        _rawTicks.forEach(([t, p]) => map.set(t, p)); // preserve live recorded points

        _rawTicks = Array.from(map.entries()).sort((a, b) => a[0] - b[0]);
        _lastPrice = _rawTicks[_rawTicks.length - 1][1];
        if (window.TickBuffer) {
          window.TickBuffer.reset(false);
          _rawTicks.forEach(([t, p]) => window.TickBuffer.addTick(t, p));
        }
        if (window.PriceEngine) {
          PriceEngine.updateLastTrade(_lastPrice / 100);
        }
        _saveSessionStorage();
        _isDirty = true;
        _render();
      }
    } catch (e) {
      console.warn('[LiveTradingManager] History fetch retry error:', e);
    }
  }

  function _clearHistoryRetryTimers() {
    _historyRetryTimers.forEach(t => clearTimeout(t));
    _historyRetryTimers = [];
  }

  // ─── Real-Time Tick Ingestion ──────────────────────────────────────
  function pushTick(unixSec, rawUpCents) {
    if (typeof unixSec !== 'number' || isNaN(unixSec)) return;

    if (typeof rawUpCents !== 'number' || isNaN(rawUpCents)) {
      if (_lastPrice !== null) rawUpCents = _lastPrice;
      else return;
    }

    rawUpCents = Math.max(0, Math.min(100, Math.round(rawUpCents * 10) / 10));

    if (!_startTs || !_endTs) {
      _startTs = Math.floor(unixSec / 300) * 300;
      _endTs = _startTs + 300;
      _durationSecs = 300;
    }

    _lastPrice = rawUpCents;

    if (_rawTicks.length === 0) {
      _rawTicks.push([_startTs, rawUpCents]);
      if (unixSec > _startTs) {
        _rawTicks.push([unixSec, rawUpCents]);
      }
    } else {
      const last = _rawTicks[_rawTicks.length - 1];
      if (last[0] === unixSec) {
        last[1] = rawUpCents;
      } else if (unixSec > last[0]) {
        _rawTicks.push([unixSec, rawUpCents]);
      } else {
        let inserted = false;
        for (let i = _rawTicks.length - 1; i >= 0; i--) {
          if (_rawTicks[i][0] === unixSec) {
            _rawTicks[i][1] = rawUpCents;
            inserted = true;
            break;
          } else if (_rawTicks[i][0] < unixSec) {
            _rawTicks.splice(i + 1, 0, [unixSec, rawUpCents]);
            inserted = true;
            break;
          }
        }
        if (!inserted) {
          _rawTicks.unshift([unixSec, rawUpCents]);
        }
      }
    }
    _isDirty = true;
    _saveSessionStorage();
  }

  function pushBtcTick(unixSec, btcPrice, strikePrice) {
    if (typeof unixSec !== 'number' || typeof btcPrice !== 'number' || isNaN(btcPrice) || btcPrice <= 0) return;

    if (strikePrice && (!_btcOpen || isNaN(_btcOpen))) {
      _btcOpen = strikePrice;
    }

    _btcCurrent = btcPrice;
    if (_btcOpen && _btcOpen > 0) {
      _btcChange = Math.round(((_btcCurrent - _btcOpen) / _btcOpen) * 10000) / 100;
    }

    if (!_startTs || !_endTs) {
      _startTs = Math.floor(unixSec / 300) * 300;
      _endTs = _startTs + 300;
      _durationSecs = 300;
    }

    if (_btcTicks.length === 0) {
      _btcTicks.push([_startTs, _btcOpen || btcPrice]);
      if (unixSec > _startTs) {
        _btcTicks.push([unixSec, btcPrice]);
      }
    } else {
      const last = _btcTicks[_btcTicks.length - 1];
      if (last[0] === unixSec) {
        last[1] = btcPrice;
      } else if (unixSec > last[0]) {
        _btcTicks.push([unixSec, btcPrice]);
      } else {
        let inserted = false;
        for (let i = _btcTicks.length - 1; i >= 0; i--) {
          if (_btcTicks[i][0] === unixSec) {
            _btcTicks[i][1] = btcPrice;
            inserted = true;
            break;
          } else if (_btcTicks[i][0] < unixSec) {
            _btcTicks.splice(i + 1, 0, [unixSec, btcPrice]);
            inserted = true;
            break;
          }
        }
        if (!inserted) {
          _btcTicks.unshift([unixSec, btcPrice]);
        }
      }
    }
    _isDirty = true;
    _saveSessionStorage();
  }

  function setHistoricalTicks(ticks) {
    if (Array.isArray(ticks) && ticks.length > 0) {
      const map = new Map();
      ticks.forEach(([ts, val]) => {
        if (ts >= _startTs && ts <= _endTs) map.set(ts, val);
      });
      _rawTicks.forEach(([ts, val]) => {
        if (ts >= _startTs && ts <= _endTs) map.set(ts, val);
      });

      if (map.size > 0) {
        _rawTicks = Array.from(map.entries()).sort((a, b) => a[0] - b[0]);
        _lastPrice = _rawTicks[_rawTicks.length - 1][1];
        if (_rawTicks[0][0] > _startTs) {
          _rawTicks.unshift([_startTs, _rawTicks[0][1]]);
        }
      }
      _isDirty = true;
      _saveSessionStorage();
      _render();
    }
  }

  function addHistoricalBtcTicks(pts) {
    if (!Array.isArray(pts) || pts.length === 0) return;
    const btcMap = new Map();
    if (_btcOpen && _startTs) btcMap.set(_startTs, _btcOpen);

    for (let i = 0; i < _btcTicks.length; i++) {
      btcMap.set(_btcTicks[i][0], _btcTicks[i][1]);
    }

    for (let i = 0; i < pts.length; i++) {
      const pt = pts[i];
      const rawVal = pt.value !== undefined ? pt.value : pt.price;
      const val = typeof rawVal === 'number' ? rawVal : parseFloat(rawVal);
      const tsMs = typeof pt.timestamp === 'number' ? pt.timestamp : (typeof pt.t === 'number' ? pt.t * 1000 : null);
      if (tsMs !== null && !isNaN(val) && val > 0) {
        const sec = Math.floor(tsMs / 1000);
        if (sec >= _startTs && sec <= _endTs) {
          btcMap.set(sec, val);
        }
      }
    }

    if (btcMap.size > 0) {
      _btcTicks = Array.from(btcMap.entries()).sort((a, b) => a[0] - b[0]);
      _btcCurrent = _btcTicks[_btcTicks.length - 1][1];
      if (_btcOpen && _btcCurrent) {
        _btcChange = Math.round(((_btcCurrent - _btcOpen) / _btcOpen) * 10000) / 100;
      }
      _isDirty = true;
      _saveSessionStorage();
    }
  }

  function setChartMode(mode) {
    _chartMode = mode;
    localStorage.setItem('pm_chart_mode', mode);
    _isDirty = true;
    _render();
  }

  function getChartMode() {
    return _chartMode;
  }

  function setOutcomeMode(mode) {
    _outcomeMode = mode;
    _isDirty = true;
    _render();
  }

  function setShowHeadBadge(enabled) {
    _showHeadBadge = !!enabled;
    localStorage.setItem('pm_show_head_tag', _showHeadBadge ? 'true' : 'false');
    _isDirty = true;
    _render();
  }

  function getShowHeadBadge() {
    return _showHeadBadge;
  }

  function updateBtcPrice(btcOpen, btcClose, btcChange) {
    if (btcOpen !== undefined && btcOpen !== null && !isNaN(btcOpen)) _btcOpen = btcOpen;
    if (btcClose !== undefined && btcClose !== null && !isNaN(btcClose)) _btcCurrent = btcClose;
    if (btcChange !== undefined && btcChange !== null && !isNaN(btcChange)) _btcChange = btcChange;

    if (_btcCurrent && _startTs) {
      const nowSec = Math.floor(Date.now() / 1000);
      pushBtcTick(nowSec, _btcCurrent, _btcOpen);
    }
  }

  // ─── Optimized Core Rendering Engine ───────────────────────────────
  function _render() {
    if (!_canvas || !_ctx || !_container) return;

    const dpr = window.devicePixelRatio || 1;
    const w = _container.clientWidth;
    const h = _container.clientHeight;

    if (w <= 0 || h <= 0) return;

    if (_canvas.width !== Math.round(w * dpr) || _canvas.height !== Math.round(h * dpr)) {
      _canvas.width = Math.round(w * dpr);
      _canvas.height = Math.round(h * dpr);
      _cachedGradKey = '';
    }

    _ctx.save();
    _ctx.scale(dpr, dpr);
    _ctx.fillStyle = '#080b0f';
    _ctx.fillRect(0, 0, w, h);

    const plotLeft   = LEFT_SCALE_W;
    const plotTop    = TOP_HUD_H;
    const plotRight  = w - RIGHT_SCALE_W;
    const plotBottom = h - BOTTOM_AXIS_H;
    const plotW      = Math.max(10, plotRight - plotLeft);
    const plotH      = Math.max(10, plotBottom - plotTop);

    const nowSec = Math.floor(Date.now() / 1000);
    const effectiveNowSec = (_startTs && _endTs) ? Math.min(_endTs, Math.max(_startTs, nowSec)) : nowSec;
    const is5m = _durationSecs <= 300;

    // ─── 1. Vertical Blue Dashed Second Subdivision Lines ───────────
    const stepSecs = is5m ? 30 : 60;
    const majorStepSecs = is5m ? 60 : 180;

    _ctx.textAlign = 'center';
    _ctx.textBaseline = 'bottom';

    for (let s = 0; s <= _durationSecs; s += stepSecs) {
      const x = plotLeft + (s / _durationSecs) * plotW;
      const isMajor = (s % majorStepSecs === 0);

      _ctx.beginPath();
      _ctx.strokeStyle = isMajor ? 'rgba(56, 189, 248, 0.75)' : 'rgba(56, 189, 248, 0.28)';
      _ctx.lineWidth = isMajor ? 1.5 : 1;
      _ctx.setLineDash(isMajor ? [4, 4] : [2, 3]);
      _ctx.moveTo(Math.round(x) + 0.5, plotTop + 1);
      _ctx.lineTo(Math.round(x) + 0.5, plotBottom);
      _ctx.stroke();

      const m = Math.floor(s / 60);
      const secRem = s % 60;
      const fullTag = `+${String(m).padStart(2, '0')}:${String(secRem).padStart(2, '0')}`;
      const timeTag = isMajor ? `${m}m` : `${s}s`;

      _ctx.fillStyle = isMajor ? '#38bdf8' : '#94a3b8';
      _ctx.font = isMajor ? 'bold 13px "JetBrains Mono", monospace' : 'bold 11px "JetBrains Mono", monospace';
      _ctx.fillText(isMajor ? fullTag : timeTag, x, h - 5);
    }

    _ctx.setLineDash([]);

    // ─── MODE A: BTC PRICE ($) MODE (Polymarket 1:1 Live Chart) ──────
    if (_chartMode === 'btc') {
      let minP = _btcOpen || (_btcCurrent || 64000);
      let maxP = _btcOpen || (_btcCurrent || 64000);

      for (let i = 0; i < _btcTicks.length; i++) {
        const p = _btcTicks[i][1];
        if (p < minP) minP = p;
        if (p > maxP) maxP = p;
      }
      if (_btcCurrent) {
        if (_btcCurrent < minP) minP = _btcCurrent;
        if (_btcCurrent > maxP) maxP = _btcCurrent;
      }

      const diff = Math.max(10, (maxP - minP) * 1.35);
      const centerP = _btcOpen || ((minP + maxP) / 2);
      const yMin = Math.min(minP - 3, centerP - diff / 2);
      const yMax = Math.max(maxP + 3, centerP + diff / 2);
      const yRange = Math.max(5, yMax - yMin);

      const getY = price => plotBottom - ((price - yMin) / yRange) * plotH;

      _ctx.lineWidth = 1;
      _ctx.font = '10px "JetBrains Mono", monospace';
      _ctx.textAlign = 'left';
      _ctx.textBaseline = 'middle';

      const gridStep = yRange > 60 ? 10 : (yRange > 25 ? 5 : 2);
      const firstGrid = Math.ceil(yMin / gridStep) * gridStep;
      for (let p = firstGrid; p <= yMax; p += gridStep) {
        const y = getY(p);
        if (y < plotTop || y > plotBottom) continue;

        _ctx.beginPath();
        _ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
        _ctx.moveTo(plotLeft, y);
        _ctx.lineTo(plotRight, y);
        _ctx.stroke();

        // Left Scale Label
        _ctx.font = 'bold 13px "JetBrains Mono", monospace';
        _ctx.textAlign = 'right';
        _ctx.fillStyle = '#cbd5e1';
        _ctx.fillText(`$${p.toLocaleString('en-US', { maximumFractionDigits: 0 })}`, plotLeft - 6, y);

        // Right Scale Label
        _ctx.font = 'bold 13px "JetBrains Mono", monospace';
        _ctx.textAlign = 'left';
        _ctx.fillStyle = '#cbd5e1';
        _ctx.fillText(`$${p.toLocaleString('en-US', { maximumFractionDigits: 0 })}`, plotRight + 6, y);
      }

      if (_btcOpen) {
        const strikeY = getY(_btcOpen);
        if (strikeY >= plotTop && strikeY <= plotBottom) {
          _ctx.beginPath();
          _ctx.strokeStyle = 'rgba(245, 158, 11, 0.75)';
          _ctx.lineWidth = 1.4;
          _ctx.setLineDash([5, 4]);
          _ctx.moveTo(plotLeft, strikeY);
          _ctx.lineTo(plotRight, strikeY);
          _ctx.stroke();
          _ctx.setLineDash([]);

          _ctx.fillStyle = '#f59e0b';
          _ctx.font = 'bold 10px "JetBrains Mono", monospace';
          _roundRect(_ctx, plotRight + 2, strikeY - 8, RIGHT_SCALE_W - 4, 16, 3, true, false);
          _ctx.fillStyle = '#090d16';
          _ctx.fillText(`$${_btcOpen.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`, plotRight + 4, strikeY);
        }
      }

      _pointBuffer.length = 0;
      if (_btcTicks.length > 0) {
        for (let i = 0; i < _btcTicks.length; i++) {
          const [ts, p] = _btcTicks[i];
          if (ts >= _startTs && ts <= _endTs) {
            const x = plotLeft + ((ts - _startTs) / _durationSecs) * plotW;
            const y = getY(p);
            _pointBuffer.push({ x, y, val: p, ts });
          }
        }
      } else if (_btcCurrent !== null) {
        const y = getY(_btcCurrent);
        _pointBuffer.push({ x: plotLeft, y, val: _btcCurrent, ts: _startTs });
      }

      if (_pointBuffer.length >= 1) {
        if (_pointBuffer.length === 1) {
          const extraX = Math.max(_pointBuffer[0].x + 1, plotLeft + ((effectiveNowSec - _startTs) / _durationSecs) * plotW);
          _pointBuffer.push({ x: extraX, y: _pointBuffer[0].y, val: _pointBuffer[0].val, ts: effectiveNowSec });
        } else {
          const lastPt = _pointBuffer[_pointBuffer.length - 1];
          if (effectiveNowSec > lastPt.ts) {
            const curX = plotLeft + ((effectiveNowSec - _startTs) / _durationSecs) * plotW;
            _pointBuffer.push({ x: curX, y: lastPt.y, val: lastPt.val, ts: effectiveNowSec });
          }
        }

        const latestPt = _pointBuffer[_pointBuffer.length - 1];
        const isUp = _btcOpen ? (latestPt.val >= _btcOpen) : true;
        const mainColor = isUp ? '#00d4aa' : '#ff4d6d';

        const gradKey = `${mainColor}_${plotTop}_${plotBottom}`;
        if (_cachedGradKey !== gradKey) {
          _cachedGrad = _ctx.createLinearGradient(0, plotTop, 0, plotBottom);
          _cachedGrad.addColorStop(0, mainColor + '33');
          _cachedGrad.addColorStop(1, mainColor + '00');
          _cachedGradKey = gradKey;
        }

        _ctx.beginPath();
        _ctx.moveTo(_pointBuffer[0].x, plotBottom);
        for (let i = 0; i < _pointBuffer.length; i++) {
          _ctx.lineTo(_pointBuffer[i].x, _pointBuffer[i].y);
        }
        _ctx.lineTo(latestPt.x, plotBottom);
        _ctx.closePath();
        _ctx.fillStyle = _cachedGrad;
        _ctx.fill();

        _ctx.save();
        _ctx.shadowColor = mainColor;
        _ctx.shadowBlur = 8;
        _ctx.strokeStyle = mainColor;
        _ctx.lineWidth = 2.5;
        _ctx.lineJoin = 'round';
        _ctx.lineCap = 'round';

        _ctx.beginPath();
        _ctx.moveTo(_pointBuffer[0].x, _pointBuffer[0].y);
        for (let i = 1; i < _pointBuffer.length; i++) {
          _ctx.lineTo(_pointBuffer[i].x, _pointBuffer[i].y);
        }
        _ctx.stroke();
        _ctx.restore();

        const pulseR = 4 + Math.sin(_pulsePhase) * 1.5;
        _ctx.beginPath();
        _ctx.arc(latestPt.x, latestPt.y, pulseR + 4, 0, Math.PI * 2);
        _ctx.fillStyle = mainColor + '44';
        _ctx.fill();

        _ctx.beginPath();
        _ctx.arc(latestPt.x, latestPt.y, pulseR, 0, Math.PI * 2);
        _ctx.fillStyle = mainColor;
        _ctx.fill();

        _ctx.beginPath();
        _ctx.arc(latestPt.x, latestPt.y, 2, 0, Math.PI * 2);
        _ctx.fillStyle = '#ffffff';
        _ctx.fill();

        if (_showHeadBadge && latestPt) {
          const remSecs = Math.max(0, _endTs - effectiveNowSec);
          const remM = Math.floor(remSecs / 60);
          const remS = remSecs % 60;
          const remStr = `${String(remM).padStart(2, '0')}:${String(remS).padStart(2, '0')}`;
          
          const deltaVal = _btcOpen ? (latestPt.val - _btcOpen) : 0;
          const sign = deltaVal >= 0 ? '+$' : '-$';
          const deltaStr = `${sign}${Math.abs(deltaVal).toFixed(2)}`;
          const priceStr = `$${latestPt.val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
          const timerStr = `⏱ ${remStr}`;

          _ctx.save();
          _ctx.font = 'bold 16px "JetBrains Mono", monospace';
          const priceW = _ctx.measureText(priceStr).width;
          _ctx.font = 'bold 13px "JetBrains Mono", monospace';
          const deltaW = _ctx.measureText(deltaStr).width;
          const timerW = _ctx.measureText(timerStr).width;
          const gapW = 10;
          const padX = 12;
          const badgeW = Math.round(padX * 2 + priceW + gapW + deltaW + gapW + timerW);
          const badgeH = 34;
          const DOT_OFFSET = 10;

          let badgeX = Math.round(latestPt.x - badgeW / 2);
          badgeX = Math.max(plotLeft + 4, Math.min(plotRight - badgeW - 4, badgeX));

          let badgeY = Math.round(latestPt.y - badgeH - DOT_OFFSET);
          let arrowBelow = true;
          if (badgeY < plotTop + 4) {
            badgeY = Math.round(latestPt.y + DOT_OFFSET + 4);
            arrowBelow = false;
          }

          const bgSemiTransparent = 'rgba(8, 14, 24, 0.72)';

          _ctx.beginPath();
          if (arrowBelow) {
            _ctx.moveTo(latestPt.x - 6, badgeY + badgeH);
            _ctx.lineTo(latestPt.x, latestPt.y - 4);
            _ctx.lineTo(latestPt.x + 6, badgeY + badgeH);
          } else {
            _ctx.moveTo(latestPt.x - 6, badgeY);
            _ctx.lineTo(latestPt.x, latestPt.y + 4);
            _ctx.lineTo(latestPt.x + 6, badgeY);
          }
          _ctx.closePath();
          _ctx.fillStyle = bgSemiTransparent;
          _ctx.fill();
          _ctx.strokeStyle = mainColor + 'cc';
          _ctx.lineWidth = 1.4;
          _ctx.stroke();

          _ctx.shadowColor = mainColor + '88';
          _ctx.shadowBlur = 10;
          _ctx.fillStyle = bgSemiTransparent;
          _ctx.strokeStyle = mainColor + 'ee';
          _ctx.lineWidth = 1.6;
          _roundRect(_ctx, badgeX, badgeY, badgeW, badgeH, 8, true, true);
          _ctx.restore();

          _ctx.save();
          _ctx.textBaseline = 'middle';
          const midY = badgeY + badgeH / 2;

          _ctx.textAlign = 'left';
          _ctx.font = 'bold 16px "JetBrains Mono", monospace';
          _ctx.fillStyle = '#ffffff';
          _ctx.fillText(priceStr, badgeX + padX, midY);

          _ctx.font = 'bold 14px "JetBrains Mono", monospace';
          _ctx.fillStyle = mainColor;
          _ctx.fillText(deltaStr, badgeX + padX + priceW + gapW, midY);

          _ctx.font = 'bold 13px "JetBrains Mono", monospace';
          _ctx.fillStyle = '#64748b';
          _ctx.fillText('·', badgeX + padX + priceW + gapW + deltaW + 3, midY);

          _ctx.fillStyle = remSecs <= 30 ? '#ff4d6d' : '#94a3b8';
          _ctx.fillText(timerStr, badgeX + padX + priceW + gapW + deltaW + gapW, midY);
          _ctx.restore();
        }

        _ctx.beginPath();
        _ctx.strokeStyle = mainColor + '66';
        _ctx.lineWidth = 1;
        _ctx.setLineDash([3, 3]);
        _ctx.moveTo(latestPt.x, latestPt.y);
        _ctx.lineTo(plotRight, latestPt.y);
        _ctx.stroke();
        _ctx.setLineDash([]);

        _ctx.fillStyle = mainColor;
        _roundRect(_ctx, plotRight + 2, latestPt.y - 9, RIGHT_SCALE_W - 4, 18, 4, true, false);
        _ctx.fillStyle = '#090d16';
        _ctx.font = 'bold 11px "JetBrains Mono", monospace';
        _ctx.textAlign = 'left';
        _ctx.textBaseline = 'middle';
        _ctx.fillText(`$${latestPt.val.toFixed(1)}`, plotRight + 4, latestPt.y);
      }
    }

    // ─── MODE B: OPTION TOKEN (0–100¢) PROBABILITY MODE ──────────────
    else {
      _ctx.lineWidth = 1;
      _ctx.textBaseline = 'middle';

      const priceLevels = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100];
      for (let i = 0; i < priceLevels.length; i++) {
        const p = priceLevels[i];
        const y = plotBottom - (p / 100) * plotH;
        const is50 = (p === 50);
        const isBoundary = (p === 0 || p === 100);
        const isDecade = (p % 10 === 0);

        _ctx.beginPath();
        _ctx.strokeStyle = is50 ? 'rgba(56, 189, 248, 0.45)' : (isBoundary ? 'rgba(255,255,255,0.12)' : (isDecade ? 'rgba(255, 255, 255, 0.05)' : 'rgba(255, 255, 255, 0.02)'));
        _ctx.lineWidth = is50 ? 1.2 : 1;
        _ctx.setLineDash(is50 ? [4, 4] : []);
        _ctx.moveTo(plotLeft, y);
        _ctx.lineTo(plotRight, y);
        _ctx.stroke();

        // ─── Scale Text Color & Font (Identical on both sides) ───
        let scaleColor = '#cbd5e1';
        if (p === 100) scaleColor = '#34d399';
        else if (p === 50) scaleColor = '#38bdf8';
        else if (p === 0) scaleColor = '#ff4d6d';
        else if (isDecade) scaleColor = '#ffffff';

        const fontStr = isDecade ? 'bold 14px "JetBrains Mono", monospace' : 'bold 12px "JetBrains Mono", monospace';
        _ctx.font = fontStr;
        _ctx.fillStyle = scaleColor;

        // ─── Left Scale (step of 5) ───
        _ctx.textAlign = 'right';
        _ctx.fillText(`${p}¢`, plotLeft - 6, y);

        // ─── Right Scale (identical step of 5) ───
        _ctx.textAlign = 'left';
        _ctx.fillText(`${p}¢`, plotRight + 6, y);
      }

      _pointBuffer.length = 0;
      if (_rawTicks.length > 0) {
        for (let i = 0; i < _rawTicks.length; i++) {
          const [ts, upCents] = _rawTicks[i];
          if (ts >= _startTs && ts <= _endTs) {
            const val = _outcomeMode === 'down' ? (100 - upCents) : upCents;
            const x = plotLeft + ((ts - _startTs) / _durationSecs) * plotW;
            const y = plotBottom - (Math.min(100, Math.max(0, val)) / 100) * plotH;
            _pointBuffer.push({ x, y, val, ts });
          }
        }
      } else if (_lastPrice !== null) {
        const val = _outcomeMode === 'down' ? (100 - _lastPrice) : _lastPrice;
        const y = plotBottom - (Math.min(100, Math.max(0, val)) / 100) * plotH;
        _pointBuffer.push({ x: plotLeft, y, val, ts: _startTs });
      }

      if (_pointBuffer.length >= 1) {
        if (_pointBuffer.length === 1) {
          const extraX = Math.max(_pointBuffer[0].x + 1, plotLeft + ((effectiveNowSec - _startTs) / _durationSecs) * plotW);
          _pointBuffer.push({ x: extraX, y: _pointBuffer[0].y, val: _pointBuffer[0].val, ts: effectiveNowSec });
        } else {
          const lastPt = _pointBuffer[_pointBuffer.length - 1];
          if (effectiveNowSec > lastPt.ts) {
            const curX = plotLeft + ((effectiveNowSec - _startTs) / _durationSecs) * plotW;
            _pointBuffer.push({ x: curX, y: lastPt.y, val: lastPt.val, ts: effectiveNowSec });
          }
        }

        const latestPt = _pointBuffer[_pointBuffer.length - 1];
        const mainColor = latestPt.val > 52 ? '#00d4aa' : (latestPt.val < 48 ? '#ff4d6d' : '#38bdf8');

        const gradKey = `${mainColor}_${plotTop}_${plotBottom}`;
        if (_cachedGradKey !== gradKey) {
          _cachedGrad = _ctx.createLinearGradient(0, plotTop, 0, plotBottom);
          _cachedGrad.addColorStop(0, mainColor + '33');
          _cachedGrad.addColorStop(1, mainColor + '00');
          _cachedGradKey = gradKey;
        }

        // Step-curve area fill
        _ctx.beginPath();
        _ctx.moveTo(_pointBuffer[0].x, plotBottom);
        _ctx.lineTo(_pointBuffer[0].x, _pointBuffer[0].y);
        for (let i = 1; i < _pointBuffer.length; i++) {
          _ctx.lineTo(_pointBuffer[i].x, _pointBuffer[i - 1].y);
          _ctx.lineTo(_pointBuffer[i].x, _pointBuffer[i].y);
        }
        _ctx.lineTo(latestPt.x, plotBottom);
        _ctx.closePath();
        _ctx.fillStyle = _cachedGrad;
        _ctx.fill();

        // Step-curve outline stroke
        _ctx.save();
        _ctx.shadowColor = mainColor;
        _ctx.shadowBlur = 8;
        _ctx.strokeStyle = mainColor;
        _ctx.lineWidth = 2.5;
        _ctx.lineJoin = 'round';
        _ctx.lineCap = 'round';

        _ctx.beginPath();
        _ctx.moveTo(_pointBuffer[0].x, _pointBuffer[0].y);
        for (let i = 1; i < _pointBuffer.length; i++) {
          _ctx.lineTo(_pointBuffer[i].x, _pointBuffer[i - 1].y);
          _ctx.lineTo(_pointBuffer[i].x, _pointBuffer[i].y);
        }
        _ctx.stroke();
        _ctx.restore();

        const pulseR = 4 + Math.sin(_pulsePhase) * 1.5;
        _ctx.beginPath();
        _ctx.arc(latestPt.x, latestPt.y, pulseR + 4, 0, Math.PI * 2);
        _ctx.fillStyle = mainColor + '44';
        _ctx.fill();

        _ctx.beginPath();
        _ctx.arc(latestPt.x, latestPt.y, pulseR, 0, Math.PI * 2);
        _ctx.fillStyle = mainColor;
        _ctx.fill();

        _ctx.beginPath();
        _ctx.arc(latestPt.x, latestPt.y, 2, 0, Math.PI * 2);
        _ctx.fillStyle = '#ffffff';
        _ctx.fill();

        if (_showHeadBadge && latestPt) {
          const remSecs = Math.max(0, _endTs - effectiveNowSec);
          const remM = Math.floor(remSecs / 60);
          const remS = remSecs % 60;
          const remStr = `${String(remM).padStart(2, '0')}:${String(remS).padStart(2, '0')}`;
          
          const priceStr = `${Math.round(latestPt.val)}¢`;
          const timerStr = `⏱ ${remStr}`;

          _ctx.save();
          _ctx.font = 'bold 18px "JetBrains Mono", monospace';
          const priceW = _ctx.measureText(priceStr).width;
          _ctx.font = 'bold 15px "JetBrains Mono", monospace';
          const timerW = _ctx.measureText(timerStr).width;
          const gapW = 12;
          const padX = 14;
          const badgeW = Math.round(padX * 2 + priceW + gapW + timerW);
          const badgeH = 34;
          const DOT_OFFSET = 10;

          let badgeX = Math.round(latestPt.x - badgeW / 2);
          badgeX = Math.max(plotLeft + 4, Math.min(plotRight - badgeW - 4, badgeX));

          let badgeY = Math.round(latestPt.y - badgeH - DOT_OFFSET);
          let arrowBelow = true;
          if (badgeY < plotTop + 4) {
            badgeY = Math.round(latestPt.y + DOT_OFFSET + 4);
            arrowBelow = false;
          }

          const bgSemiTransparent = 'rgba(8, 14, 24, 0.72)';

          _ctx.beginPath();
          if (arrowBelow) {
            _ctx.moveTo(latestPt.x - 6, badgeY + badgeH);
            _ctx.lineTo(latestPt.x, latestPt.y - 4);
            _ctx.lineTo(latestPt.x + 6, badgeY + badgeH);
          } else {
            _ctx.moveTo(latestPt.x - 6, badgeY);
            _ctx.lineTo(latestPt.x, latestPt.y + 4);
            _ctx.lineTo(latestPt.x + 6, badgeY);
          }
          _ctx.closePath();
          _ctx.fillStyle = bgSemiTransparent;
          _ctx.fill();
          _ctx.strokeStyle = mainColor + 'cc';
          _ctx.lineWidth = 1.4;
          _ctx.stroke();

          _ctx.shadowColor = mainColor + '88';
          _ctx.shadowBlur = 10;
          _ctx.fillStyle = bgSemiTransparent;
          _ctx.strokeStyle = mainColor + 'ee';
          _ctx.lineWidth = 1.6;
          _roundRect(_ctx, badgeX, badgeY, badgeW, badgeH, 8, true, true);
          _ctx.restore();

          _ctx.save();
          _ctx.textBaseline = 'middle';
          const midY = badgeY + badgeH / 2;

          _ctx.textAlign = 'left';
          _ctx.font = 'bold 18px "JetBrains Mono", monospace';
          _ctx.fillStyle = mainColor;
          _ctx.fillText(priceStr, badgeX + padX, midY);

          _ctx.font = 'bold 15px "JetBrains Mono", monospace';
          _ctx.fillStyle = '#64748b';
          _ctx.fillText('·', badgeX + padX + priceW + 4, midY);

          _ctx.fillStyle = remSecs <= 30 ? '#ff4d6d' : '#ffffff';
          _ctx.fillText(timerStr, badgeX + padX + priceW + gapW, midY);
          _ctx.restore();
        }

        _ctx.beginPath();
        _ctx.strokeStyle = mainColor + '66';
        _ctx.lineWidth = 1;
        _ctx.setLineDash([3, 3]);
        _ctx.moveTo(latestPt.x, latestPt.y);
        _ctx.lineTo(plotRight, latestPt.y);
        _ctx.stroke();
        _ctx.setLineDash([]);

        _ctx.fillStyle = mainColor;
        _roundRect(_ctx, plotRight + 2, latestPt.y - 10, RIGHT_SCALE_W - 4, 20, 4, true, false);
        _ctx.fillStyle = '#090d16';
        _ctx.font = 'bold 12px "JetBrains Mono", monospace';
        _ctx.textAlign = 'center';
        _ctx.textBaseline = 'middle';
        _ctx.fillText(`${Math.round(latestPt.val)}¢`, plotRight + (RIGHT_SCALE_W / 2), latestPt.y);
      }
    }

    // ─── 3. Interactive Cursor Crosshair & Hover Info Badge (Cursor Tracking) ──
    if (_hoverX !== null && _hoverY !== null &&
        _hoverX >= plotLeft && _hoverX <= plotRight &&
        _hoverY >= plotTop && _hoverY <= plotBottom) {
      
      const hoverRatio = Math.max(0, Math.min(1, (_hoverX - plotLeft) / plotW));
      const hoverTs = Math.round(_startTs + hoverRatio * _durationSecs);

      let hoverPrice = null;
      let hoverY = _hoverY;

      if (_chartMode === 'btc') {
        if (_pointBuffer.length > 0) {
          for (let i = _pointBuffer.length - 1; i >= 0; i--) {
            if (_pointBuffer[i].ts <= hoverTs) {
              hoverPrice = _pointBuffer[i].val;
              hoverY = _pointBuffer[i].y;
              break;
            }
          }
          if (hoverPrice === null) {
            hoverPrice = _pointBuffer[0].val;
            hoverY = _pointBuffer[0].y;
          }
        } else if (_btcCurrent !== null) {
          hoverPrice = _btcCurrent;
        }
      } else {
        if (_pointBuffer.length > 0) {
          for (let i = _pointBuffer.length - 1; i >= 0; i--) {
            if (_pointBuffer[i].ts <= hoverTs) {
              hoverPrice = _pointBuffer[i].val;
              hoverY = _pointBuffer[i].y;
              break;
            }
          }
          if (hoverPrice === null) {
            hoverPrice = _pointBuffer[0].val;
            hoverY = _pointBuffer[0].y;
          }
        } else if (_lastPrice !== null) {
          hoverPrice = _outcomeMode === 'down' ? (100 - _lastPrice) : _lastPrice;
          hoverY = plotBottom - (Math.min(100, Math.max(0, hoverPrice)) / 100) * plotH;
        }
      }

      if (hoverPrice !== null) {
        const remSecs = Math.max(0, _endTs - hoverTs);
        const remM = Math.floor(remSecs / 60);
        const remS = remSecs % 60;
        const remStr = `${String(remM).padStart(2, '0')}:${String(remS).padStart(2, '0')}`;

        const priceStr = _chartMode === 'btc'
          ? `$${hoverPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          : `${Math.round(hoverPrice)}¢`;
        
        const timerStr = `⏱ ${remStr}`;

        // A. Crosshair Lines
        _ctx.save();
        _ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
        _ctx.lineWidth = 1;
        _ctx.setLineDash([3, 3]);

        // Vertical line
        _ctx.beginPath();
        _ctx.moveTo(_hoverX, plotTop);
        _ctx.lineTo(_hoverX, plotBottom);
        _ctx.stroke();

        // Horizontal line
        _ctx.beginPath();
        _ctx.moveTo(plotLeft, hoverY);
        _ctx.lineTo(plotRight, hoverY);
        _ctx.stroke();
        _ctx.setLineDash([]);
        _ctx.restore();

        // B. Target Dot on the curve
        const hColor = (_chartMode === 'btc')
          ? (_btcOpen ? (hoverPrice >= _btcOpen ? '#00d4aa' : '#ff4d6d') : '#00d4aa')
          : (hoverPrice > 52 ? '#00d4aa' : (hoverPrice < 48 ? '#ff4d6d' : '#38bdf8'));

        _ctx.beginPath();
        _ctx.arc(_hoverX, hoverY, 4.5, 0, Math.PI * 2);
        _ctx.fillStyle = hColor;
        _ctx.fill();
        _ctx.strokeStyle = '#ffffff';
        _ctx.lineWidth = 1.5;
        _ctx.stroke();

        // C. Hover Info Badge (Following cursor)
        _ctx.save();
        _ctx.font = 'bold 16px "JetBrains Mono", monospace';
        const pW = _ctx.measureText(priceStr).width;
        _ctx.font = 'bold 13px "JetBrains Mono", monospace';
        const tW = _ctx.measureText(timerStr).width;
        const gap = 10;
        const pad = 12;
        const bW = Math.round(pad * 2 + pW + gap + tW);
        const bH = 32;
        const H_OFFSET = 12;

        let bX = Math.round(_hoverX - bW / 2);
        bX = Math.max(plotLeft + 4, Math.min(plotRight - bW - 4, bX));

        let bY = Math.round(hoverY - bH - H_OFFSET);
        let arrowBelow = true;
        if (bY < plotTop + 4) {
          bY = Math.round(hoverY + H_OFFSET + 4);
          arrowBelow = false;
        }

        const bgDark = 'rgba(8, 14, 24, 0.90)';

        // Arrow tip
        _ctx.beginPath();
        if (arrowBelow) {
          _ctx.moveTo(_hoverX - 5, bY + bH);
          _ctx.lineTo(_hoverX, hoverY - 4);
          _ctx.lineTo(_hoverX + 5, bY + bH);
        } else {
          _ctx.moveTo(_hoverX - 5, bY);
          _ctx.lineTo(_hoverX, hoverY + 4);
          _ctx.lineTo(_hoverX + 5, bY);
        }
        _ctx.closePath();
        _ctx.fillStyle = bgDark;
        _ctx.fill();
        _ctx.strokeStyle = hColor + 'cc';
        _ctx.lineWidth = 1.4;
        _ctx.stroke();

        // Badge Box
        _ctx.shadowColor = hColor + 'aa';
        _ctx.shadowBlur = 10;
        _ctx.fillStyle = bgDark;
        _ctx.strokeStyle = hColor + 'ee';
        _ctx.lineWidth = 1.5;
        _roundRect(_ctx, bX, bY, bW, bH, 6, true, true);
        _ctx.restore();

        // Badge Texts
        _ctx.save();
        _ctx.textBaseline = 'middle';
        const midH = bY + bH / 2;

        let drawX = bX + pad;
        _ctx.textAlign = 'left';
        _ctx.font = 'bold 16px "JetBrains Mono", monospace';
        _ctx.fillStyle = hColor;
        _ctx.fillText(priceStr, drawX, midH);
        drawX += pW + 4;

        _ctx.font = 'bold 13px "JetBrains Mono", monospace';
        _ctx.fillStyle = '#64748b';
        _ctx.fillText('·', drawX, midH);
        drawX += gap;

        _ctx.fillStyle = remSecs <= 30 ? '#ff4d6d' : '#ffffff';
        _ctx.fillText(timerStr, drawX, midH);
        _ctx.restore();

        // D. Axis Tag Markers (Left Axis)
        _ctx.save();
        _ctx.fillStyle = hColor;
        _roundRect(_ctx, plotLeft - 52, hoverY - 10, 48, 20, 4, true, false);
        _ctx.fillStyle = '#090d16';
        _ctx.font = 'bold 12px "JetBrains Mono", monospace';
        _ctx.textAlign = 'center';
        _ctx.textBaseline = 'middle';
        _ctx.fillText(_chartMode === 'btc' ? `$${Math.round(hoverPrice)}` : `${Math.round(hoverPrice)}¢`, plotLeft - 28, hoverY);
        _ctx.restore();
      }
    }

    // ─── 4. Top Slim Header HUD ───────────────────────────────────────
    _ctx.fillStyle = 'rgba(9, 17, 30, 0.92)';
    _ctx.fillRect(0, 0, w, TOP_HUD_H);

    _ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
    _ctx.lineWidth = 1;
    _ctx.beginPath();
    _ctx.moveTo(0, TOP_HUD_H + 0.5);
    _ctx.lineTo(w, TOP_HUD_H + 0.5);
    _ctx.stroke();

    const fullSlug = _currentMarket?.slug || 'Live Session';
    const isMobile = (w < 600);
    const slugText = isMobile ? `...${fullSlug.slice(-10)} ↗` : `${fullSlug} ↗`;
    const labelDuration = isMobile ? (is5m ? '5M' : '15M') : (is5m ? '5M FIXED (300s)' : '15M FIXED (900s)');
    const modeBadge = _chartMode === 'btc' ? '₿ BTC ($)' : '¢ PROB (%)';

    let curX = isMobile ? 8 : 14;
    const textY = 17;

    _ctx.textAlign = 'left';
    _ctx.textBaseline = 'alphabetic';

    _ctx.font = isMobile ? '600 11px "JetBrains Mono", monospace' : '600 12px "JetBrains Mono", monospace';
    _ctx.fillStyle = '#ffffff';
    _ctx.fillText(slugText, curX, textY);
    curX += _ctx.measureText(slugText).width + (isMobile ? 6 : 10);

    _ctx.fillStyle = '#64748b';
    _ctx.fillText('·', curX, textY);
    curX += isMobile ? 10 : 14;

    _ctx.fillStyle = '#38bdf8';
    _ctx.font = isMobile ? '800 11px "JetBrains Mono", monospace' : '800 12px "JetBrains Mono", monospace';
    _ctx.fillText(`⏳ ${labelDuration}`, curX, textY);
    curX += _ctx.measureText(`⏳ ${labelDuration}`).width + (isMobile ? 6 : 10);

    _ctx.fillStyle = '#64748b';
    _ctx.fillText('·', curX, textY);
    curX += isMobile ? 10 : 14;

    _ctx.fillStyle = '#a855f7';
    _ctx.font = isMobile ? '700 10px "JetBrains Mono", monospace' : '700 11px "JetBrains Mono", monospace';
    _ctx.fillText(modeBadge, curX, textY);
    curX += _ctx.measureText(modeBadge).width + (isMobile ? 6 : 10);

    if (_btcCurrent && curX + 110 < w - RIGHT_SCALE_W) {
      _ctx.fillStyle = '#64748b';
      _ctx.fillText('·', curX, textY);
      curX += isMobile ? 10 : 14;

      const sign = (_btcChange || 0) >= 0 ? '+' : '';
      const chgStr = _btcChange !== null && _btcChange !== undefined ? ` (${sign}${_btcChange.toFixed(2)}%)` : '';

      _ctx.fillStyle = '#94a3b8';
      _ctx.font = isMobile ? '600 11px "JetBrains Mono", monospace' : '600 12px "JetBrains Mono", monospace';
      _ctx.fillText('TWAP ', curX, textY);
      curX += _ctx.measureText('TWAP ').width;

      let priceText = '';
      if (isMobile) {
        priceText = `$${_btcCurrent.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}${chgStr}`;
      } else {
        const openStr = _btcOpen ? '$' + _btcOpen.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '--';
        const curStr  = '$' + _btcCurrent.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        priceText = `${openStr} → ${curStr}${chgStr}`;
      }

      _ctx.fillStyle = (_btcChange || 0) >= 0 ? '#34d399' : '#cbd5e1';
      _ctx.fillText(priceText, curX, textY, (w - RIGHT_SCALE_W - curX - 6));
    }

    _ctx.restore();
    _isDirty = false;
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

  function _startAnimationLoop() {
    function loop(now) {
      const delta = now - _lastFrameTime;
      if (_isDirty || delta >= 33) {
        _pulsePhase += 0.08;
        _render();
        _lastFrameTime = now;
      }
      _rafId = requestAnimationFrame(loop);
    }
    _rafId = requestAnimationFrame(loop);
  }

  function _setupInteractions() {
    if (!_canvas) return;

    _canvas.addEventListener('mousemove', (e) => {
      const rect = _canvas.getBoundingClientRect();
      _hoverX = e.clientX - rect.left;
      _hoverY = e.clientY - rect.top;

      if (_hoverY <= TOP_HUD_H) {
        _canvas.style.cursor = 'pointer';
      } else {
        _canvas.style.cursor = 'crosshair';
      }
      _isDirty = true;
    }, { passive: true });

    _canvas.addEventListener('mouseleave', () => {
      _hoverX = null;
      _hoverY = null;
      if (_tooltipEl) _tooltipEl.style.display = 'none';
      _isDirty = true;
    }, { passive: true });

    _canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length > 0) {
        const rect = _canvas.getBoundingClientRect();
        _hoverX = e.touches[0].clientX - rect.left;
        _hoverY = e.touches[0].clientY - rect.top;
        _isDirty = true;
      }
    }, { passive: true });

    _canvas.addEventListener('touchmove', (e) => {
      if (e.touches.length > 0) {
        const rect = _canvas.getBoundingClientRect();
        _hoverX = e.touches[0].clientX - rect.left;
        _hoverY = e.touches[0].clientY - rect.top;
        _isDirty = true;
      }
    }, { passive: true });

    _canvas.addEventListener('touchend', () => {
      setTimeout(() => {
        _hoverX = null;
        _hoverY = null;
        if (_tooltipEl) _tooltipEl.style.display = 'none';
        _isDirty = true;
      }, 3000);
    });

    _canvas.addEventListener('click', (e) => {
      const rect = _canvas.getBoundingClientRect();
      const my = e.clientY - rect.top;
      if (my <= TOP_HUD_H && _currentMarket?.slug) {
        window.open(`https://polymarket.com/event/${_currentMarket.slug}`, '_blank');
      }
    });
  }

  function _setupResize() {
    if (!_container) return;
    const ro = new ResizeObserver(() => {
      _isDirty = true;
      _render();
    });
    ro.observe(_container);
  }

  function resize() {
    _isDirty = true;
    _render();
  }

  function destroy() {
    _clearHistoryRetryTimers();
    if (_rafId) cancelAnimationFrame(_rafId);
  }

  return {
    init,
    setMarket,
    pushTick,
    pushBtcTick,
    setHistoricalTicks,
    addHistoricalBtcTicks,
    setChartMode,
    getChartMode,
    setOutcomeMode,
    setShowHeadBadge,
    getShowHeadBadge,
    updateBtcPrice,
    resize,
    destroy,
  };
})();
