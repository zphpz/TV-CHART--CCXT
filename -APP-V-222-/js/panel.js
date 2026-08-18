/**
 * panel.js — History & Database Management Panel Controller v1.4
 * 
 * Features:
 * - Full-screen interactive history & database panel
 * - Storage connection management & auto-save settings
 * - Polymarket history downloader with visual progress & presets (6h, 12h, 24h, 3d, 7d)
 * - Session table with selection checkboxes [✓], filters, and bulk operations
 * - Win-rate statistics & aggregated metrics
 */
'use strict';

window.HistoryPanel = (() => {
  const $ = id => document.getElementById(id);

  let _selectedSlugs = new Set();
  let _selectedTfMinutes = 5;
  let _selectedPresetCount = 72; // default 6h for 5m

  function init() {
    _bindEvents();
    _renderStorageInfo();
    _renderSessionTable();
    _renderStats();

    // Subscribe to DB updates
    if (window.DBManager) {
      window.DBManager.subscribe((event, data) => {
        _renderStorageInfo();
        _renderSessionTable();
        _renderStats();
      });
    }
  }

  function _bindEvents() {
    // DB File Actions
    $('btn-connect-file')?.addEventListener('click', async () => {
      const ok = await window.DBManager.connectFile();
      if (ok) {
        window.App?.showToast('Database file connected successfully', 'info', 3000);
      }
    });

    $('btn-save-file')?.addEventListener('click', async () => {
      const ok = await window.DBManager.saveFile();
      if (ok) {
        window.App?.showToast('Saved to database file', 'info', 2000);
      } else {
        window.App?.showToast('Please connect a file first or start local server', 'warn', 2500);
      }
    });

    $('btn-export-json')?.addEventListener('click', () => {
      window.DBManager.exportJSON();
    });

    $('btn-import-json')?.addEventListener('click', () => {
      $('file-import-input')?.click();
    });

    $('file-import-input')?.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (file) {
        try {
          const count = await window.DBManager.importJSON(file);
          window.App?.showToast(`Imported ${count} sessions successfully`, 'info', 3000);
          _renderStats();
          _renderSessionTable();
          _renderStorageInfo();
        } catch {
          window.App?.showToast('Failed to import JSON', 'error', 3000);
        }
      }
    });

    $('chk-autosave')?.addEventListener('change', (e) => {
      window.DBManager.setAutoSave(e.target.checked);
    });

    // Backfill TF selector (5M / 15M)
    const bfTfBtns = document.querySelectorAll('.bf-tf-btn');
    bfTfBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        bfTfBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _selectedTfMinutes = parseInt(btn.dataset.tf, 10) || 5;
        _updatePresetCounts();
      });
    });

    // Backfill Presets
    const presetBtns = document.querySelectorAll('.preset-btn');
    presetBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        presetBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const hours = parseInt(btn.dataset.hours, 10);
        _selectedPresetCount = Math.round((hours * 60) / _selectedTfMinutes);
        $('bf-count-display').textContent = `${_selectedPresetCount} sessions (${hours}h)`;
      });
    });

    // Start / Stop Backfill
    $('btn-start-backfill')?.addEventListener('click', _handleStartBackfill);
    $('btn-stop-backfill')?.addEventListener('click', () => {
      window.BackfillEngine.stop();
      $('btn-stop-backfill').disabled = true;
    });

    // Table Select All / Deselect All
    $('chk-select-all')?.addEventListener('change', (e) => {
      const all = window.DBManager.getAllSessions();
      if (e.target.checked) {
        all.forEach(s => _selectedSlugs.add(s.slug));
      } else {
        _selectedSlugs.clear();
      }
      _renderSessionTable(false);
    });

    // Bulk Actions
    $('btn-delete-selected')?.addEventListener('click', () => {
      if (_selectedSlugs.size === 0) return;
      if (confirm(`Delete ${_selectedSlugs.size} selected session(s) from database?`)) {
        window.DBManager.deleteSessions(Array.from(_selectedSlugs));
        _selectedSlugs.clear();
        window.App?.showToast('Deleted selected sessions', 'info', 2000);
      }
    });

    $('btn-load-to-chart')?.addEventListener('click', () => {
      _loadHistoryToChart();
    });

    $('btn-clear-db')?.addEventListener('click', () => {
      if (confirm('Clear all sessions from database?')) {
        window.DBManager.clearAll();
        _selectedSlugs.clear();
        window.App?.showToast('Database cleared', 'info', 2000);
      }
    });
  }

  function _updatePresetCounts() {
    const activePreset = document.querySelector('.preset-btn.active');
    if (activePreset) {
      const hours = parseInt(activePreset.dataset.hours, 10);
      _selectedPresetCount = Math.round((hours * 60) / _selectedTfMinutes);
      $('bf-count-display').textContent = `${_selectedPresetCount} sessions (${hours}h)`;
    }
  }

  // ─── Backfill Process ───────────────────────────────────────────────
  async function _handleStartBackfill() {
    if (window.BackfillEngine.isRunning()) return;

    const startBtn = $('btn-start-backfill');
    const stopBtn = $('btn-stop-backfill');
    const progWrap = $('bf-progress-wrap');
    const progBar = $('bf-progress-bar');
    const progText = $('bf-progress-text');
    const smartMerge = $('chk-smart-merge')?.checked ?? true;

    startBtn.disabled = true;
    stopBtn.disabled = false;
    progWrap.style.display = 'block';
    progBar.style.width = '0%';
    progText.textContent = 'Initializing backfill...';

    const res = await window.BackfillEngine.startBackfill(
      {
        tfMinutes: _selectedTfMinutes,
        sessionCount: _selectedPresetCount,
        smartMerge,
      },
      ({ current, total, slug, savedCount, skippedCount, status }) => {
        const pct = Math.round((current / total) * 100);
        progBar.style.width = `${pct}%`;
        progText.innerHTML = `<span>[${current}/${total}] <b>${pct}%</b> — ${status}</span> <span class="bf-slug">${slug}</span>`;
      }
    );

    startBtn.disabled = false;
    stopBtn.disabled = true;
    progText.textContent = `Completed! Saved: ${res.saved}, Skipped (already in DB): ${res.skipped}`;

    window.App?.showToast(`Backfill complete: ${res.saved} new sessions saved`, 'info', 3500);
    _renderSessionTable();
    _renderStats();

    // Auto-update chart with new history
    _loadHistoryToChart(false);
  }

  // ─── Render Storage Info ────────────────────────────────────────────
  function _renderStorageInfo() {
    if (!window.DBManager) return;
    const isConn = window.DBManager.isConnected();
    const fileName = window.DBManager.getFileName();
    const fileSize = window.DBManager.getFileSize();
    const lastSaved = window.DBManager.getLastSavedMs();

    const statusBadge = $('db-status-badge');
    if (statusBadge) {
      statusBadge.className = isConn ? 'badge-connected' : 'badge-disconnected';
      statusBadge.textContent = isConn ? `CONNECTED: ${fileName}` : 'NOT CONNECTED (Using In-Memory DB)';
    }

    const sizeEl = $('db-file-size');
    if (sizeEl) {
      sizeEl.textContent = fileSize > 0 ? (fileSize / 1024).toFixed(1) + ' KB' : '-- KB';
    }

    const lastSavedEl = $('db-last-saved');
    if (lastSavedEl) {
      lastSavedEl.textContent = lastSaved ? new Date(lastSaved).toLocaleTimeString() : 'Never';
    }
  }

  // ─── Render Stats ───────────────────────────────────────────────────
  function _renderStats() {
    if (!window.DBManager) return;
    const sessions = window.DBManager.getAllSessions();
    const totalSessions = sessions.length;
    const totalTicks = window.DBManager.getTotalTickCount();

    let upWins = 0;
    let downWins = 0;
    let totalVolume = 0;

    for (const s of sessions) {
      if (s.winner === 'UP') upWins++;
      else if (s.winner === 'DOWN') downWins++;
      totalVolume += s.volume || 0;
    }

    const upPct = totalSessions > 0 ? ((upWins / totalSessions) * 100).toFixed(1) : '0.0';
    const downPct = totalSessions > 0 ? ((downWins / totalSessions) * 100).toFixed(1) : '0.0';

    $('stat-total-sessions') && ($('stat-total-sessions').textContent = totalSessions);
    $('stat-total-ticks') && ($('stat-total-ticks').textContent = totalTicks.toLocaleString());
    $('stat-up-pct') && ($('stat-up-pct').textContent = `${upPct}% (${upWins})`);
    $('stat-down-pct') && ($('stat-down-pct').textContent = `${downPct}% (${downWins})`);
    $('stat-total-volume') && ($('stat-total-volume').textContent = '$' + totalVolume.toLocaleString(undefined, { maximumFractionDigits: 0 }));
  }

  // ─── Render Session Table ───────────────────────────────────────────
  function _renderSessionTable(rebuildSelectAll = true) {
    if (!window.DBManager) return;
    const tbody = $('session-table-body');
    if (!tbody) return;

    const sessions = window.DBManager.getAllSessions().reverse(); // newest first

    if (sessions.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-table-msg">No historical sessions in database yet. Use "Start Backfill" above or let the live chart record sessions.</td></tr>`;
      return;
    }

    let html = '';
    for (const s of sessions) {
      const isChecked = _selectedSlugs.has(s.slug) ? 'checked' : '';
      const fmtTime = ts => ts ? new Date(ts * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '--';

      let winnerBadge = '<span class="badge-pending">PENDING</span>';
      if (s.winner === 'UP') {
        winnerBadge = '<span class="badge-winner-up">🏆 UP WON</span>';
      } else if (s.winner === 'DOWN') {
        winnerBadge = '<span class="badge-winner-down">🏆 DOWN WON</span>';
      }

      const openFmt = s.open !== null && s.open !== undefined ? s.open.toFixed(1) + '¢' : '--';
      const highFmt = s.high !== null && s.high !== undefined ? s.high.toFixed(1) + '¢' : '--';
      const lowFmt = s.low !== null && s.low !== undefined ? s.low.toFixed(1) + '¢' : '--';
      const closeFmt = s.close !== null && s.close !== undefined ? s.close.toFixed(1) + '¢' : '--';
      const tickCount = Array.isArray(s.ticks) ? s.ticks.length : 0;
      const volFmt = s.volume ? '$' + Math.round(s.volume).toLocaleString() : '--';

      let btcFmt = '--';
      if (s.btcOpen && s.btcClose) {
        const sign = s.btcClose >= s.btcOpen ? '+' : '';
        const chg = s.btcChange !== null && s.btcChange !== undefined ? `(${sign}${s.btcChange.toFixed(2)}%)` : '';
        const cls = s.btcClose >= s.btcOpen ? 'btc-up' : 'btc-down';
        btcFmt = `<span class="${cls}">$${Math.round(s.btcOpen).toLocaleString()} → $${Math.round(s.btcClose).toLocaleString()} ${chg}</span>`;
      }

      html += `
        <tr data-slug="${s.slug}" class="${isChecked ? 'row-selected' : ''}">
          <td class="col-chk"><input type="checkbox" class="session-chk" data-slug="${s.slug}" ${isChecked} /></td>
          <td class="col-time">
            <a href="https://polymarket.com/event/${s.slug}" target="_blank" class="session-link-title" title="Open on Polymarket">
              <b>${s.slug}</b> ↗
            </a>
            <div class="session-time-sub">${fmtTime(s.startTs)} <span class="time-sep">→</span> ${fmtTime(s.endTs)} · ${btcFmt}</div>
          </td>
          <td class="col-tf"><span class="badge-tf">${s.tf}M</span></td>
          <td class="col-winner">${winnerBadge}</td>
          <td class="col-ohlc"><span class="o">${openFmt}</span> / <span class="h">${highFmt}</span> / <span class="l">${lowFmt}</span> / <span class="c">${closeFmt}</span></td>
          <td class="col-ticks"><span class="badge-ticks">${tickCount} pts</span></td>
          <td class="col-vol">${volFmt}</td>
          <td class="col-actions">
            <button class="tbl-btn-del" data-slug="${s.slug}" title="Delete session">✕</button>
          </td>
        </tr>
      `;
    }

    tbody.innerHTML = html;

    tbody.querySelectorAll('.session-chk').forEach(chk => {
      chk.addEventListener('change', (e) => {
        const slug = e.target.dataset.slug;
        if (e.target.checked) _selectedSlugs.add(slug);
        else _selectedSlugs.delete(slug);
        const row = e.target.closest('tr');
        row?.classList.toggle('row-selected', e.target.checked);
        _updateSelectedCount();
      });
    });

    tbody.querySelectorAll('.tbl-btn-del').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const slug = e.target.dataset.slug;
        if (slug && confirm(`Delete session ${slug}?`)) {
          window.DBManager.deleteSessions([slug]);
          _selectedSlugs.delete(slug);
        }
      });
    });

    _updateSelectedCount();
  }

  function _updateSelectedCount() {
    const selCountEl = $('selected-sessions-count');
    if (selCountEl) {
      selCountEl.textContent = `${_selectedSlugs.size} selected`;
    }
  }

  // ─── Load Merged History into Chart ─────────────────────────────────
  async function _loadHistoryToChart(switchView = true) {
    if (!window.DBManager || !window.ChartManager || !window.TickBuffer) return;

    let allSessions = window.DBManager.getAllSessions();
    if (allSessions.length === 0) {
      try {
        const res = await fetch('./history.json');
        if (res.ok) {
          const text = await res.text();
          await window.DBManager.importJSON(text);
          allSessions = window.DBManager.getAllSessions();
        }
      } catch {}
    }

    if (allSessions.length === 0) {
      window.App?.showToast('No sessions in database to load', 'warn', 2000);
      return;
    }

    function _expandSessionTicks(ticks, startTs, endTs, stepSec = 2) {
      if (!ticks || ticks.length === 0) return [];
      const sorted = ticks
        .map(pt => [
          Array.isArray(pt) ? pt[0] : (pt.t || pt.time),
          Array.isArray(pt) ? pt[1] : (pt.v || pt.value)
        ])
        .filter(([t, v]) => typeof t === 'number' && typeof v === 'number' && !isNaN(v))
        .sort((a, b) => a[0] - b[0]);

      if (sorted.length === 0) return [];

      const filled = [];
      let curVal = sorted[0][1];
      let tickIdx = 0;

      for (let t = startTs + 1; t < endTs; t += stepSec) {
        while (tickIdx < sorted.length && sorted[tickIdx][0] <= t) {
          curVal = sorted[tickIdx][1];
          tickIdx++;
        }
        filled.push([t, curVal]);
      }

      const lastVal = sorted[sorted.length - 1][1];
      filled.push([endTs - 1, lastVal]);
      return filled;
    }

    const bulkTicks = [];

    for (const s of allSessions) {
      if (Array.isArray(s.ticks) && s.ticks.length > 0) {
        const start = s.startTs || 0;
        const end = s.endTs || (start ? start + (s.tf || 5) * 60 : 0);
        if (start > 0 && end > start) {
          const expanded = _expandSessionTicks(s.ticks, start, end, 2);
          for (const pt of expanded) {
            bulkTicks.push(pt);
          }
        } else {
          for (const pt of s.ticks) {
            const t = Array.isArray(pt) ? pt[0] : (pt.t || pt.time);
            const v = Array.isArray(pt) ? pt[1] : (pt.v || pt.value);
            if (typeof t === 'number' && typeof v === 'number' && !isNaN(v)) {
              bulkTicks.push([t, v]);
            }
          }
        }
      }
    }

    if (window.App && typeof window.App.getCurrentSessionTicks === 'function') {
      const liveTicks = window.App.getCurrentSessionTicks();
      if (Array.isArray(liveTicks)) {
        for (const pt of liveTicks) {
          const t = Array.isArray(pt) ? pt[0] : (pt.t || pt.time);
          const v = Array.isArray(pt) ? pt[1] : (pt.v || pt.value);
          if (typeof t === 'number' && typeof v === 'number' && !isNaN(v)) {
            bulkTicks.push([t, v]);
          }
        }
      }
    }

    TickBuffer.reset(false);
    TickBuffer.addBulk(bulkTicks);

    const curTf = ChartManager.getCurrentTf();
    const outcomeMode = window.App?.getOutcomeMode() || 'up';
    const aggregated = TickBuffer.aggregate(curTf, outcomeMode);

    const seriesWithGaps = [];
    const seenTimes = new Set();
    
    for (const item of aggregated) {
      seriesWithGaps.push(item);
      seenTimes.add(item.time);
    }
    
    for (const s of allSessions) {
      if (s.endTs && !seenTimes.has(s.endTs)) {
        seriesWithGaps.push({ time: s.endTs });
        seenTimes.add(s.endTs);
      }
    }

    seriesWithGaps.sort((a, b) => a.time - b.time);

    if (seriesWithGaps.length > 0) {
      ChartManager.setData(seriesWithGaps);
    }

    ChartManager.clearMarkers();
    const boundaries = [];
    const sessionCards = [];

    if (aggregated.length > 0) {
      for (const s of allSessions) {
        if (s.startTs) boundaries.push(s.startTs);
        if (s.endTs) {
          boundaries.push(s.endTs);
          ChartManager.addWhitespace(s.endTs);
        }

        sessionCards.push({
          slug: s.slug,
          startTs: s.startTs,
          endTs: s.endTs,
          winner: s.winner,
          btcOpen: s.btcOpen,
          btcClose: s.btcClose,
          btcChange: s.btcChange,
        });

        if (s.winner && s.winner !== 'PENDING') {
          const isUp = s.winner === 'UP';
          const targetTs = s.endTs || (Array.isArray(s.ticks) && s.ticks.length > 0 ? s.ticks[s.ticks.length - 1][0] : null);
          if (targetTs) {
            let closestPt = aggregated[0];
            let minDiff = Infinity;
            for (const pt of aggregated) {
              const diff = Math.abs(pt.time - targetTs);
              if (diff < minDiff) {
                minDiff = diff;
                closestPt = pt;
              }
            }
            if (closestPt) {
              ChartManager.addWinnerBadgeMarker(
                closestPt.time,
                isUp ? '🏆 UP WON' : '🏆 DOWN WON',
                isUp ? 'up' : 'down'
              );
            }
          }
        }
      }
      ChartManager.setSessionBoundaries(boundaries);
      ChartManager.setSessionCardsData(sessionCards);
      ChartManager.resetZoom();
    }

    if (switchView && window.App) {
      window.App.switchView('chart');
      window.App.showToast(`Loaded ${allSessions.length} sessions (${bulkTicks.length} ticks) to chart`, 'info', 3000);
    }
  }

  return {
    init,
    loadHistoryToChart: _loadHistoryToChart,
  };
})();
