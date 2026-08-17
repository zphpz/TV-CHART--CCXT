/**
 * live_trading.js — Dedicated Stationary 300s (5M) / 900s (15M) Live Trading Engine
 * 
 * Features:
 * - 100% stationary, non-scrolling full-session canvas locked from second 0 to second 300 (or 900)
 * - Anti-aliased glowing live price line with gradient under-fill
 * - Pulsing live leading dot at the current second
 * - Blue dashed vertical second & minute grid lines (+01:00, +02:00 ... / 30s, 90s ...)
 * - 0–100¢ right price scale & horizontal reference grid (50¢ anchor)
 * - Interactive hover crosshair with exact price & elapsed second tooltip
 * - Single-line top header HUD with slug link, ⏳ LIVE session badge & Chainlink BTC price stream
 * - Immediate historical pre-fill from session startTs to now
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
  let _outcomeMode   = 'up';    // 'up' | 'down'
  let _rawTicks      = [];      // Array of [unixSec, rawUpCents]
  let _lastPrice     = 50.0;

  let _btcOpen       = null;
  let _btcCurrent    = null;
  let _btcChange     = null;

  let _hoverX        = null;
  let _hoverY        = null;
  let _rafId         = null;
  let _pulsePhase    = 0;

  const TOP_HUD_H    = 26;
  const RIGHT_SCALE_W= 52;
  const BOTTOM_AXIS_H= 22;

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
    _ctx = _canvas.getContext('2d');

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

    console.log('[LiveTradingManager] Custom 300s/900s Live Trading Canvas initialized');
    return true;
  }

  // ─── Market Initialization & History Population ────────────────────
  function setMarket(market) {
    if (!market) return;
    _currentMarket = market;
    _startTs = market.startTs || Math.floor(Date.now() / 1000);
    _endTs = market.endTs || (_startTs + 300);
    _durationSecs = Math.max(60, _endTs - _startTs);

    _rawTicks = [];

    // Pre-populate with any ticks already recorded for this session in TickBuffer
    if (window.TickBuffer) {
      const bufferTicks = window.TickBuffer.getRawTicks() || [];
      for (const t of bufferTicks) {
        if (t.time >= _startTs && t.time <= _endTs && typeof t.value === 'number') {
          _rawTicks.push([t.time, t.value]);
        }
      }
    }

    // If no ticks yet, start with current price from PriceEngine or midpoint
    const nowSec = Math.floor(Date.now() / 1000);
    const eff = window.PriceEngine ? window.PriceEngine.effectivePrice() : 0.5;
    const curCents = (eff !== null && !isNaN(eff)) ? eff * 100 : 50.0;
    _lastPrice = curCents;

    if (_rawTicks.length === 0) {
      _rawTicks.push([_startTs, curCents]);
      if (nowSec > _startTs && nowSec <= _endTs) {
        _rawTicks.push([nowSec, curCents]);
      }
    } else {
      // Ensure starting anchor at startTs
      if (_rawTicks[0][0] > _startTs) {
        _rawTicks.unshift([_startTs, _rawTicks[0][1]]);
      }
    }

    _btcOpen = parseFloat(market.eventMetadata?.priceToBeat || market.eventMetadata?.targetPrice) || null;
    _btcCurrent = _btcOpen;
    _btcChange = 0;

    _render();
  }

  // ─── Real-Time Tick Ingestion ──────────────────────────────────────
  function pushTick(unixSec, rawUpCents) {
    if (typeof unixSec !== 'number' || typeof rawUpCents !== 'number' || isNaN(rawUpCents)) return;
    if (!_startTs || !_endTs) {
      _startTs = Math.floor(unixSec / 300) * 300;
      _endTs = _startTs + 300;
      _durationSecs = 300;
    }

    _lastPrice = rawUpCents;

    // Ensure start anchor
    if (_rawTicks.length === 0) {
      _rawTicks.push([_startTs, rawUpCents]);
    }

    // Avoid duplicate timestamp overwriting
    if (_rawTicks.length > 0 && _rawTicks[_rawTicks.length - 1][0] === unixSec) {
      _rawTicks[_rawTicks.length - 1][1] = rawUpCents;
    } else {
      _rawTicks.push([unixSec, rawUpCents]);
    }
  }

  function setOutcomeMode(mode) {
    _outcomeMode = mode;
    _render();
  }

  function updateBtcPrice(btcOpen, btcClose, btcChange) {
    if (btcOpen !== undefined && btcOpen !== null) _btcOpen = btcOpen;
    if (btcClose !== undefined && btcClose !== null) _btcCurrent = btcClose;
    if (btcChange !== undefined && btcChange !== null) _btcChange = btcChange;
  }

  // ─── Core Rendering Engine ─────────────────────────────────────────
  function _render() {
    if (!_canvas || !_ctx || !_container) return;

    const dpr = window.devicePixelRatio || 1;
    const w = _container.clientWidth;
    const h = _container.clientHeight;

    if (w <= 0 || h <= 0) return;

    if (_canvas.width !== Math.round(w * dpr) || _canvas.height !== Math.round(h * dpr)) {
      _canvas.width = Math.round(w * dpr);
      _canvas.height = Math.round(h * dpr);
    }

    _ctx.save();
    _ctx.scale(dpr, dpr);
    _ctx.clearRect(0, 0, w, h);

    const plotLeft   = 0;
    const plotTop    = TOP_HUD_H;
    const plotRight  = w - RIGHT_SCALE_W;
    const plotBottom = h - BOTTOM_AXIS_H;
    const plotW      = Math.max(10, plotRight - plotLeft);
    const plotH      = Math.max(10, plotBottom - plotTop);

    // 1. Background Grid & Horizontal Price Lines (0¢, 20¢, 40¢, 50¢, 60¢, 80¢, 100¢)
    _ctx.lineWidth = 1;
    _ctx.font = '10px "JetBrains Mono", monospace';
    _ctx.textBaseline = 'middle';

    const priceLevels = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    for (const p of priceLevels) {
      const y = plotBottom - (p / 100) * plotH;
      const is50 = (p === 50);
      const isBoundary = (p === 0 || p === 100);

      _ctx.beginPath();
      _ctx.strokeStyle = is50 ? 'rgba(56, 189, 248, 0.45)' : (isBoundary ? 'rgba(255,255,255,0.1)' : 'rgba(255, 255, 255, 0.04)');
      _ctx.setLineDash(is50 ? [4, 4] : []);
      _ctx.moveTo(plotLeft, y);
      _ctx.lineTo(plotRight, y);
      _ctx.stroke();

      // Right price scale label
      if (p % 20 === 0 || p === 50) {
        _ctx.fillStyle = is50 ? '#38bdf8' : '#64748b';
        _ctx.fillText(`${p.toFixed(1)}¢`, plotRight + 6, y);
      }
    }

    // 2. Vertical Blue Dashed Second Subdivision Lines
    const is5m = _durationSecs <= 300;
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

      // Bottom Axis Time Tag
      const m = Math.floor(s / 60);
      const secRem = s % 60;
      const fullTag = `+${String(m).padStart(2, '0')}:${String(secRem).padStart(2, '0')}`;
      const timeTag = isMajor ? `${m}m` : `${s}s`;

      _ctx.fillStyle = isMajor ? '#38bdf8' : '#64748b';
      _ctx.font = isMajor ? 'bold 10px "JetBrains Mono", monospace' : '9px "JetBrains Mono", monospace';
      _ctx.fillText(isMajor ? fullTag : timeTag, x, h - 4);
    }

    // 3. Price Movement Curve & Gradient Under-Fill
    _ctx.setLineDash([]);
    if (_rawTicks.length > 0 && _durationSecs > 0) {
      const points = [];
      for (const [ts, upCents] of _rawTicks) {
        if (ts >= _startTs && ts <= _endTs) {
          const val = _outcomeMode === 'down' ? (100 - upCents) : upCents;
          const x = plotLeft + ((ts - _startTs) / _durationSecs) * plotW;
          const y = plotBottom - (Math.min(100, Math.max(0, val)) / 100) * plotH;
          points.push({ x, y, val, ts });
        }
      }

      if (points.length >= 1) {
        // If single point, duplicate to startTs
        if (points.length === 1) {
          points.unshift({ x: plotLeft, y: points[0].y, val: points[0].val, ts: _startTs });
        }

        const latestPt = points[points.length - 1];
        const isUpWinning = latestPt.val >= 50;
        const mainColor = latestPt.val > 52 ? '#00d4aa' : (latestPt.val < 48 ? '#ff4d6d' : '#38bdf8');

        // Draw Area Fill Under Curve
        const grad = _ctx.createLinearGradient(0, plotTop, 0, plotBottom);
        grad.addColorStop(0, mainColor + '33'); // 20% opacity
        grad.addColorStop(1, mainColor + '00'); // 0% opacity

        _ctx.beginPath();
        _ctx.moveTo(points[0].x, plotBottom);
        for (let i = 0; i < points.length; i++) {
          _ctx.lineTo(points[i].x, points[i].y);
        }
        _ctx.lineTo(latestPt.x, plotBottom);
        _ctx.closePath();
        _ctx.fillStyle = grad;
        _ctx.fill();

        // Draw Price Line with Glow
        _ctx.save();
        _ctx.shadowColor = mainColor;
        _ctx.shadowBlur = 8;
        _ctx.strokeStyle = mainColor;
        _ctx.lineWidth = 2.5;
        _ctx.lineJoin = 'round';
        _ctx.lineCap = 'round';

        _ctx.beginPath();
        _ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
          _ctx.lineTo(points[i].x, points[i].y);
        }
        _ctx.stroke();
        _ctx.restore();

        // Draw Pulsing Live Head Dot
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

        // Current Price Line to Right Scale
        _ctx.beginPath();
        _ctx.strokeStyle = mainColor + '66';
        _ctx.lineWidth = 1;
        _ctx.setLineDash([3, 3]);
        _ctx.moveTo(latestPt.x, latestPt.y);
        _ctx.lineTo(plotRight, latestPt.y);
        _ctx.stroke();
        _ctx.setLineDash([]);

        // Right Scale Highlight Badge
        _ctx.fillStyle = mainColor;
        _roundRect(_ctx, plotRight + 2, latestPt.y - 9, RIGHT_SCALE_W - 4, 18, 4, true, false);
        _ctx.fillStyle = '#090d16';
        _ctx.font = 'bold 11px "JetBrains Mono", monospace';
        _ctx.textAlign = 'left';
        _ctx.textBaseline = 'middle';
        _ctx.fillText(`${latestPt.val.toFixed(1)}¢`, plotRight + 6, latestPt.y);
      }
    }

    // 4. Hover Crosshair & Tooltip
    if (_hoverX !== null && _hoverY !== null && _hoverX >= plotLeft && _hoverX <= plotRight && _hoverY >= plotTop && _hoverY <= plotBottom) {
      _ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
      _ctx.lineWidth = 1;
      _ctx.setLineDash([3, 3]);

      _ctx.beginPath();
      _ctx.moveTo(_hoverX, plotTop);
      _ctx.lineTo(_hoverX, plotBottom);
      _ctx.moveTo(plotLeft, _hoverY);
      _ctx.lineTo(plotRight, _hoverY);
      _ctx.stroke();
      _ctx.setLineDash([]);

      // Compute hovered price & second
      const hoverSec = Math.round(((_hoverX - plotLeft) / plotW) * _durationSecs);
      const hoverPrice = (1 - ((_hoverY - plotTop) / plotH)) * 100;
      const m = Math.floor(hoverSec / 60);
      const s = hoverSec % 60;
      const timeTag = `+${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} (${hoverSec}s)`;

      if (_tooltipEl) {
        _tooltipEl.style.display = 'block';
        _tooltipEl.style.left = `${Math.min(w - 140, _hoverX + 12)}px`;
        _tooltipEl.style.top = `${Math.min(h - 40, _hoverY - 28)}px`;
        _tooltipEl.innerHTML = `<span style="color:#38bdf8; font-weight:bold;">${hoverPrice.toFixed(1)}¢</span> · <span style="color:#94a3b8;">${timeTag}</span>`;
      }
    } else if (_tooltipEl) {
      _tooltipEl.style.display = 'none';
    }

    // 5. Top Slim Header HUD (Single-Line Monospace)
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

    let curX = isMobile ? 8 : 14;
    const textY = 17;

    _ctx.textAlign = 'left';
    _ctx.textBaseline = 'alphabetic';

    // Slug Header
    _ctx.font = isMobile ? '600 11px "JetBrains Mono", monospace' : '600 12px "JetBrains Mono", monospace';
    _ctx.fillStyle = '#ffffff';
    _ctx.fillText(slugText, curX, textY);
    curX += _ctx.measureText(slugText).width + (isMobile ? 6 : 10);

    // Separator
    _ctx.fillStyle = '#64748b';
    _ctx.fillText('·', curX, textY);
    curX += isMobile ? 10 : 14;

    // Live Badge
    _ctx.fillStyle = '#38bdf8';
    _ctx.font = isMobile ? '800 11px "JetBrains Mono", monospace' : '800 12px "JetBrains Mono", monospace';
    _ctx.fillText(`⏳ ${labelDuration}`, curX, textY);
    curX += _ctx.measureText(`⏳ ${labelDuration}`).width + (isMobile ? 6 : 10);

    // Chainlink BTC Price Feed
    if (_btcCurrent && curX + 110 < w - RIGHT_SCALE_W) {
      _ctx.fillStyle = '#64748b';
      _ctx.fillText('·', curX, textY);
      curX += isMobile ? 10 : 14;

      const sign = (_btcChange || 0) >= 0 ? '+' : '';
      const chgStr = _btcChange !== null && _btcChange !== undefined ? ` (${sign}${_btcChange.toFixed(2)}%)` : '';

      _ctx.fillStyle = '#94a3b8';
      _ctx.font = isMobile ? '600 11px "JetBrains Mono", monospace' : '600 12px "JetBrains Mono", monospace';
      _ctx.fillText('BTC ', curX, textY);
      curX += _ctx.measureText('BTC ').width;

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
    function loop() {
      _pulsePhase += 0.08;
      _render();
      _rafId = requestAnimationFrame(loop);
    }
    _rafId = requestAnimationFrame(loop);
  }

  function _setupInteractions() {
    if (!_canvas) return;

    // Mouse interactions
    _canvas.addEventListener('mousemove', (e) => {
      const rect = _canvas.getBoundingClientRect();
      _hoverX = e.clientX - rect.left;
      _hoverY = e.clientY - rect.top;

      if (_hoverY <= TOP_HUD_H) {
        _canvas.style.cursor = 'pointer';
      } else {
        _canvas.style.cursor = 'crosshair';
      }
    });

    _canvas.addEventListener('mouseleave', () => {
      _hoverX = null;
      _hoverY = null;
      if (_tooltipEl) _tooltipEl.style.display = 'none';
    });

    // Mobile touch interactions
    _canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length > 0) {
        const rect = _canvas.getBoundingClientRect();
        _hoverX = e.touches[0].clientX - rect.left;
        _hoverY = e.touches[0].clientY - rect.top;
      }
    }, { passive: true });

    _canvas.addEventListener('touchmove', (e) => {
      if (e.touches.length > 0) {
        const rect = _canvas.getBoundingClientRect();
        _hoverX = e.touches[0].clientX - rect.left;
        _hoverY = e.touches[0].clientY - rect.top;
      }
    }, { passive: true });

    _canvas.addEventListener('touchend', () => {
      setTimeout(() => {
        _hoverX = null;
        _hoverY = null;
        if (_tooltipEl) _tooltipEl.style.display = 'none';
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
      _render();
    });
    ro.observe(_container);
  }

  function resize() {
    _render();
  }

  function destroy() {
    if (_rafId) cancelAnimationFrame(_rafId);
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
