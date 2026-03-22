/**
 * tracking.js — Coordinate tracking, click capture, coord panel tracking
 */

// ── COORDINATE TRACKING ────────────────────────────────────
let _coordInterval        = null;
let _coordCaptureInterval = null;
let _coordTracking        = false;
let _lastX                = 0;
let _lastY                = 0;

function _onTrackRightClick(e) {
  if (e.button === 2) { e.preventDefault(); _captureCoord(); }
}

function _onTrackKey(e) {
  if (e.key === 'F2')     { e.preventDefault(); _captureCoord(); }
  if (e.key === 'Escape') { e.preventDefault(); _cancelCoordTracking(); }
}

function _captureCoord() {
  if (!_coordTracking) return;
  insertToEditor(`CLICK ${_lastX} ${_lastY}`);
  const display = document.getElementById('coord-display');
  display.style.background = '#d4f7dc';
  display.style.color = '#1a7a3a';
  setTimeout(() => { display.style.background = '#fff'; display.style.color = '#1a73e8'; }, 400);
  toast(`📌 Captured CLICK ${_lastX} ${_lastY}`, 'info');
  toggleCoordTracking();
}

function _cancelCoordTracking() {
  if (!_coordTracking) return;
  toggleCoordTracking();
  toast('Tracking cancelled', 'warn');
}

async function _pollCapturedCoords() {
  if (!checkApi() || !_coordTracking) return;
  try {
    const r = await window.pywebview.api.get_captured_coords();
    if (r.coords && r.coords.length > 0) {
      r.coords.forEach(c => {
        _lastX = c.x; _lastY = c.y;
        document.getElementById('coord-display').textContent = `X: ${c.x}   Y: ${c.y}`;
        insertToEditor(`CLICK ${c.x} ${c.y}`);
        const display = document.getElementById('coord-display');
        display.style.background = '#d4f7dc';
        display.style.color = '#1a7a3a';
        setTimeout(() => { display.style.background = '#fff'; display.style.color = '#1a73e8'; }, 400);
        toast(`📌 Captured CLICK ${c.x} ${c.y}`, 'info');
      });
      if (_coordTracking) toggleCoordTracking();
    }
  } catch(e) {}
}

function toggleCoordTracking() {
  if (!_coordTracking && _guardRunning('start coordinate tracking')) return;
  _coordTracking = !_coordTracking;
  const btn  = document.getElementById('coord-track-btn');
  const hint = document.getElementById('coord-hint');
  if (_coordTracking) {
    btn.textContent = '⏹ Stop';
    btn.style.background = '#e74c3c';
    _coordInterval = setInterval(pollMousePos, 80);
    _coordCaptureInterval = setInterval(_pollCapturedCoords, 200);
    if (checkApi()) {
      withLoading(window.pywebview.api.start_coord_capture()).catch(() => {});
    }
    document.addEventListener('contextmenu', _onTrackRightClick);
    document.addEventListener('keydown', _onTrackKey);
    if (hint) hint.textContent = 'Right-click or F2 to capture • ESC to cancel';
    toast('Tracking ON — right-click or F2 in any app/game to capture', 'info');
  } else {
    btn.textContent = '▶ Track';
    btn.style.background = '';
    clearInterval(_coordInterval);
    clearInterval(_coordCaptureInterval);
    _coordInterval = _coordCaptureInterval = null;
    if (checkApi()) {
      withLoading(window.pywebview.api.stop_coord_capture()).catch(() => {});
    }
    document.removeEventListener('contextmenu', _onTrackRightClick);
    document.removeEventListener('keydown', _onTrackKey);
    if (hint) hint.textContent = '';
    toast('Tracking stopped', 'warn');
  }
}

async function pollMousePos() {
  if (!checkApi()) return;
  try {
    const r = await window.pywebview.api.get_mouse_pos();
    _lastX = r.x; _lastY = r.y;
    document.getElementById('coord-display').textContent = `X: ${r.x}   Y: ${r.y}`;
  } catch(e) {}
}

function insertCursorPos() {
  if (!_coordTracking && _lastX === 0 && _lastY === 0) {
    toast('Start tracking first!', 'warn'); return;
  }
  _captureCoord();
}

// ── CLICK CAPTURE ──────────────────────────────────────────
let _clickCaptureActive   = false;
let _lastCapturedClick    = null;
let _clickCaptureInterval = null;

async function toggleClickCapture() {
  if (!_clickCaptureActive && _guardRunning('start click capture')) return;
  if (!checkApi()) return;
  _clickCaptureActive = !_clickCaptureActive;
  const btn     = document.getElementById('btn-click-capture');
  const display = document.getElementById('click-capture-display');

  if (_clickCaptureActive) {
    btn.textContent = '🔴 Stop';
    btn.style.background = '#e74c3c';
    display.style.display = 'flex';
    document.getElementById('click-capture-coords').textContent = 'Click anywhere...';
    try { await withLoading(window.pywebview.api.start_coord_capture()); } catch(e) {}
    _clickCaptureInterval = setInterval(async () => {
      try {
        const r = await window.pywebview.api.get_captured_coords();
        if (r && r.coords && r.coords.length > 0) {
          const c = r.coords[r.coords.length - 1];
          _lastCapturedClick = c;
          document.getElementById('click-capture-coords').textContent = `X:${c.x} Y:${c.y}`;
          document.getElementById('click-capture-coords').style.color = '#27ae60';
          setTimeout(() => { document.getElementById('click-capture-coords').style.color = ''; }, 400);
          _lastX = c.x; _lastY = c.y;
          document.getElementById('coord-display').textContent = `X: ${c.x}   Y: ${c.y}`;
        }
      } catch(e) {}
    }, 200);
    toast('Click anywhere to capture coordinates. Right-click or F2.', 'info');
  } else {
    btn.textContent = '🎯 Capture';
    btn.style.background = '';
    display.style.display = 'none';
    clearInterval(_clickCaptureInterval);
    try { await withLoading(window.pywebview.api.stop_coord_capture()); } catch(e) {}
  }
}

function insertCapturedClick() {
  if (!_lastCapturedClick) { toast('No coordinates captured yet', 'warn'); return; }
  insertToEditor(`CLICK ${_lastCapturedClick.x} ${_lastCapturedClick.y}`);
  toast(`Inserted: CLICK ${_lastCapturedClick.x} ${_lastCapturedClick.y}`, 'info');
}