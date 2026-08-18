/**
 * db.js — Local File Database Manager v1.5
 * 
 * Features:
 * - Uses File System Access API for direct local file reading/writing (history.json)
 * - IndexedDB handle persistence for 1-click reconnect across page reloads
 * - In-memory structured cache of sessions and ticks
 * - Smart merge to prevent duplicate sessions
 * - Server-side auto-save synchronization (when run_app.py / server.js is running)
 * - JSON import/export fallback
 */
'use strict';

window.DBManager = (() => {
  const IDB_NAME = 'PM_Chart_DB';
  const IDB_VERSION = 1;
  const IDB_STORE = 'handles';
  const HANDLE_KEY = 'history_file_handle';

  // In-memory state
  let _fileHandle = null;
  let _fileName = 'history.json';
  let _fileSize = 0;
  let _lastSavedMs = 0;
  let _autoSaveEnabled = true;

  // Database structure:
  let _db = {
    version: '1.5',
    updatedAt: 0,
    sessions: {},
  };

  // Event listeners for DB updates
  const _listeners = new Set();

  function subscribe(fn) {
    _listeners.add(fn);
    return () => _listeners.delete(fn);
  }

  function _notify(eventType, data) {
    _listeners.forEach(fn => {
      try { fn(eventType, data); } catch (e) { console.error('[DBManager] Listener error:', e); }
    });
  }

  // ─── IndexedDB Handle Cache ──────────────────────────────────────────
  function _openIDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function _saveHandleToIDB(handle) {
    try {
      const idb = await _openIDB();
      const tx = idb.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(handle, HANDLE_KEY);
      return new Promise(r => { tx.oncomplete = r; });
    } catch (e) {
      console.warn('[DBManager] Could not save handle to IDB:', e);
    }
  }

  async function _getHandleFromIDB() {
    try {
      const idb = await _openIDB();
      const tx = idb.transaction(IDB_STORE, 'readonly');
      return new Promise(resolve => {
        const req = tx.objectStore(IDB_STORE).get(HANDLE_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  // ─── File Connection via File System Access API ─────────────────────
  async function connectFile(createIfMissing = true) {
    if (!('showOpenFilePicker' in window)) {
      console.warn('[DBManager] File System Access API not supported in this browser');
      return false;
    }

    try {
      let handle;
      if (createIfMissing && 'showSaveFilePicker' in window) {
        handle = await window.showSaveFilePicker({
          suggestedName: 'history.json',
          types: [{
            description: 'JSON Database File',
            accept: { 'application/json': ['.json'] },
          }],
        });
      } else {
        const handles = await window.showOpenFilePicker({
          types: [{
            description: 'JSON Database File',
            accept: { 'application/json': ['.json'] },
          }],
          multiple: false,
        });
        handle = handles[0];
      }

      if (handle) {
        _fileHandle = handle;
        _fileName = handle.name || 'history.json';
        await _saveHandleToIDB(handle);
        await readFile();
        _notify('connected', { fileName: _fileName });
        return true;
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.error('[DBManager] File pick error:', e);
      }
    }
    return false;
  }

  async function tryAutoConnect() {
    try {
      const cached = await _getHandleFromIDB();
      if (cached && 'queryPermission' in cached) {
        const perm = await cached.queryPermission({ mode: 'readwrite' });
        if (perm === 'granted') {
          _fileHandle = cached;
          _fileName = cached.name || 'history.json';
          await readFile();
          _notify('connected', { fileName: _fileName });
          return true;
        }
      }
    } catch (e) {
      console.warn('[DBManager] Auto-connect failed:', e);
    }

    // Fallback: automatically load history.json next to HTML file if DB is empty
    try {
      const res = await fetch('./history.json');
      if (res.ok) {
        const text = await res.text();
        const count = await importJSON(text);
        if (count > 0) {
          console.log(`[DBManager] Auto-loaded ${count} sessions from ./history.json`);
          _notify('loaded', { fileName: 'history.json', count });
          return true;
        }
      }
    } catch {}

    return false;
  }

  // ─── File Read & Write ──────────────────────────────────────────────
  async function readFile() {
    if (!_fileHandle) return false;

    try {
      const file = await _fileHandle.getFile();
      _fileSize = file.size;
      const text = await file.text();

      if (text && text.trim().length > 0) {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
          if (parsed.sessions && typeof parsed.sessions === 'object') {
            const rawList = Array.isArray(parsed.sessions) ? parsed.sessions : Object.values(parsed.sessions);
            _db.sessions = {};
            for (const s of rawList) {
              if (s && s.slug) {
                const tf = s.tf || (s.slug.includes('-15m-') ? 15 : 5);
                s.ticks = _sanitizeTicks(s.ticks, s.startTs, s.endTs, tf);
                _db.sessions[s.slug] = s;
              }
            }
          }
          _db.version = parsed.version || '1.5';
          _db.updatedAt = parsed.updatedAt || Date.now();
        }
      }

      _notify('read', { sessionCount: Object.keys(_db.sessions).length });
      return true;
    } catch (e) {
      console.error('[DBManager] Read file failed:', e);
      return false;
    }
  }

  async function saveFile() {
    _db.updatedAt = Math.floor(Date.now() / 1000);
    const jsonStr = JSON.stringify(_db, null, 2);

    // 1. Try Local File Handle
    if (_fileHandle) {
      try {
        const writable = await _fileHandle.createWritable();
        await writable.write(jsonStr);
        await writable.close();

        _fileSize = new Blob([jsonStr]).size;
        _lastSavedMs = Date.now();
        _notify('saved', { size: _fileSize, lastSavedMs: _lastSavedMs });
        return true;
      } catch (e) {
        console.error('[DBManager] Save file via FileHandle failed:', e);
      }
    }

    // 2. Try Server API auto-save if server is running
    try {
      const res = await fetch('/api/save-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: jsonStr
      });
      if (res.ok) {
        _fileSize = new Blob([jsonStr]).size;
        _lastSavedMs = Date.now();
        _notify('saved', { size: _fileSize, lastSavedMs: _lastSavedMs });
        return true;
      }
    } catch {}

    return false;
  }

  // ─── Data Access & Mutations ────────────────────────────────────────
  function getSession(slug) {
    return _db.sessions[slug] || null;
  }

  function getAllSessions() {
    return Object.values(_db.sessions).sort((a, b) => (a.startTs || 0) - (b.startTs || 0));
  }

  function getSessionCount() {
    return Object.keys(_db.sessions).length;
  }

  function getTotalTickCount() {
    let total = 0;
    for (const slug in _db.sessions) {
      const s = _db.sessions[slug];
      if (s && Array.isArray(s.ticks)) {
        total += s.ticks.length;
      }
    }
    return total;
  }

  function _sanitizeTicks(ticks, startTs, endTs, tfMinutes) {
    if (!Array.isArray(ticks)) return [];
    const intervalSec = (tfMinutes || 5) * 60;
    const start = startTs || 0;
    const end = endTs || (start ? start + intervalSec : 0);

    const valid = [];
    for (const pt of ticks) {
      const time = Array.isArray(pt) ? pt[0] : (pt.t || pt.time);
      const val  = Array.isArray(pt) ? pt[1] : (pt.v || pt.value);
      if (typeof time === 'number' && typeof val === 'number' && !isNaN(val)) {
        if (start > 0 && end > 0) {
          if (time >= start - 5 && time <= end + 5) {
            valid.push([time, Math.max(0, Math.min(100, Math.round(val * 10) / 10))]);
          }
        } else {
          valid.push([time, Math.max(0, Math.min(100, Math.round(val * 10) / 10))]);
        }
      }
    }
    return valid.sort((a, b) => a[0] - b[0]);
  }

  function upsertSession(sessionData, autoFlush = false) {
    if (!sessionData || !sessionData.slug) return;
    const slug = sessionData.slug;
    const existing = _db.sessions[slug] || null;

    const tf = sessionData.tf || (existing ? existing.tf : (slug.includes('-15m-') ? 15 : 5));
    const startTs = sessionData.startTs || (existing ? existing.startTs : null);
    const endTs = sessionData.endTs || (existing ? existing.endTs : (startTs ? startTs + tf * 60 : null));

    let existingTicks = existing && Array.isArray(existing.ticks) ? existing.ticks : [];
    let newTicks = Array.isArray(sessionData.ticks) ? sessionData.ticks : [];

    const tickMap = new Map();
    for (const [time, val] of _sanitizeTicks(existingTicks, startTs, endTs, tf)) {
      tickMap.set(time, val);
    }
    for (const [time, val] of _sanitizeTicks(newTicks, startTs, endTs, tf)) {
      tickMap.set(time, val);
    }

    const mergedTicks = Array.from(tickMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([time, val]) => [time, Math.round(val * 10) / 10]);

    let open = null, high = null, low = null, close = null;
    if (mergedTicks.length > 0) {
      open = mergedTicks[0][1];
      close = mergedTicks[mergedTicks.length - 1][1];
      high = open;
      low = open;
      for (const pt of mergedTicks) {
        const v = pt[1];
        if (v > high) high = v;
        if (v < low) low = v;
      }
    }

    _db.sessions[slug] = {
      slug,
      tf: sessionData.tf || (slug.includes('-15m-') ? 15 : 5),
      startTs: sessionData.startTs || (existing ? existing.startTs : null),
      endTs: sessionData.endTs || (existing ? existing.endTs : null),
      winner: sessionData.winner || (existing ? existing.winner : 'PENDING'),
      outcomePrices: sessionData.outcomePrices || (existing ? existing.outcomePrices : null),
      volume: sessionData.volume !== undefined ? sessionData.volume : (existing ? existing.volume : 0),
      open: sessionData.open !== undefined ? sessionData.open : open,
      high: sessionData.high !== undefined ? sessionData.high : high,
      low: sessionData.low !== undefined ? sessionData.low : low,
      close: sessionData.close !== undefined ? sessionData.close : close,
      btcOpen: sessionData.btcOpen !== undefined ? sessionData.btcOpen : (existing ? existing.btcOpen : null),
      btcClose: sessionData.btcClose !== undefined ? sessionData.btcClose : (existing ? existing.btcClose : null),
      btcHigh: sessionData.btcHigh !== undefined ? sessionData.btcHigh : (existing ? existing.btcHigh : null),
      btcLow: sessionData.btcLow !== undefined ? sessionData.btcLow : (existing ? existing.btcLow : null),
      btcChange: sessionData.btcChange !== undefined ? sessionData.btcChange : (existing ? existing.btcChange : null),
      quality: sessionData.quality || (existing ? existing.quality : (mergedTicks.length >= 30 ? 'EXCELLENT' : (mergedTicks.length >= 10 ? 'GOOD' : 'SPARSE'))),
      ticks: mergedTicks,
    };

    _notify('session_updated', { slug, session: _db.sessions[slug] });

    if (autoFlush && _autoSaveEnabled) {
      saveFile();
    }
  }

  function deleteSessions(slugs) {
    if (!Array.isArray(slugs)) slugs = [slugs];
    let changed = false;
    for (const slug of slugs) {
      if (_db.sessions[slug]) {
        delete _db.sessions[slug];
        changed = true;
      }
    }
    if (changed) {
      _notify('sessions_deleted', { slugs });
      if (_autoSaveEnabled) saveFile();
    }
  }

  function clearAll() {
    _db.sessions = {};
    _notify('cleared', {});
    if (_autoSaveEnabled) saveFile();
  }

  function getAllTicksFlattened() {
    const sessions = getAllSessions();
    const result = [];
    for (const s of sessions) {
      if (Array.isArray(s.ticks)) {
        for (const pt of s.ticks) {
          const time = Array.isArray(pt) ? pt[0] : pt.t || pt.time;
          const value = Array.isArray(pt) ? pt[1] : pt.v || pt.value;
          if (typeof time === 'number' && typeof value === 'number') {
            result.push({ time, value, slug: s.slug });
          }
        }
      }
    }
    return result.sort((a, b) => a.time - b.time);
  }

  function isConnected() { return _fileHandle !== null; }
  function getFileName() { return _fileName; }
  function getFileSize() { return _fileSize; }
  function getLastSavedMs() { return _lastSavedMs; }
  function isAutoSave() { return _autoSaveEnabled; }
  function setAutoSave(enabled) { _autoSaveEnabled = !!enabled; }

  function exportJSON() {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(_db, null, 2));
    const a = document.createElement('a');
    a.setAttribute('href', dataStr);
    a.setAttribute('download', `pm_history_${Date.now()}.json`);
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function importJSON(fileOrText) {
    if (typeof fileOrText === 'string' || (fileOrText && typeof fileOrText === 'object' && !('size' in fileOrText))) {
      try {
        const parsed = typeof fileOrText === 'string' ? JSON.parse(fileOrText) : fileOrText;
        if (parsed && parsed.sessions) {
          const list = Array.isArray(parsed.sessions) ? parsed.sessions : Object.values(parsed.sessions);
          for (const s of list) {
            if (s && s.slug) upsertSession(s);
          }
          if (_autoSaveEnabled) saveFile();
          return Promise.resolve(list.length);
        }
      } catch (err) {
        return Promise.reject(err);
      }
    }

    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => {
        try {
          const parsed = JSON.parse(e.target.result);
          if (parsed && parsed.sessions) {
            const list = Array.isArray(parsed.sessions) ? parsed.sessions : Object.values(parsed.sessions);
            for (const s of list) {
              if (s && s.slug) upsertSession(s);
            }
            if (_autoSaveEnabled) saveFile();
            resolve(list.length);
          } else {
            reject(new Error('Invalid JSON format'));
          }
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = reject;
      reader.readAsText(fileOrText);
    });
  }

  return {
    connectFile,
    tryAutoConnect,
    readFile,
    saveFile,
    getSession,
    getAllSessions,
    getSessionCount,
    getTotalTickCount,
    upsertSession,
    deleteSessions,
    clearAll,
    getAllTicksFlattened,
    subscribe,
    isConnected,
    getFileName,
    getFileSize,
    getLastSavedMs,
    isAutoSave,
    setAutoSave,
    exportJSON,
    importJSON,
  };
})();
