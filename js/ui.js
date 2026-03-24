/**
 * ui.js — Zoom system, tab navigation, status bar, cheat sheet
 */

// ══════════════════════════════════════════════════════════
//  ZOOM / SCALE SYSTEM
// ══════════════════════════════════════════════════════════

const ZOOM_STEP = 0.1;
const ZOOM_MIN  = 0.5;
const ZOOM_MAX  = 2.0;
const ZOOM_KEY  = 'macro-app-zoom';

const ZOOM_TIER = (z) => z <= 0.7 ? 'xs' : z >= 1.4 ? 'lg' : 'md';

let _currentZoom = parseFloat(localStorage.getItem(ZOOM_KEY)) || _detectDefaultZoom();

function _detectDefaultZoom() {
  const w = window.screen.width;
  const h = window.screen.height;
  const maxDim = Math.max(w, h);
  if (maxDim >= 3840) return 0.75;
  if (maxDim >= 2560) return 0.85;
  if (maxDim >= 1920) return 1.0;
  return 1.0;
}

function _applyZoom(z) {
  _currentZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, parseFloat(z.toFixed(2))));
  document.documentElement.style.setProperty('--zoom', _currentZoom);
  document.documentElement.setAttribute('data-zoom', ZOOM_TIER(_currentZoom));

  const pct = Math.round(_currentZoom * 100);
  const lbl = document.getElementById('zoom-label');
  if (lbl) lbl.textContent = `${pct}%`;

  localStorage.setItem(ZOOM_KEY, _currentZoom);
  syncZoomSlider();
  setTimeout(() => { try { renderSyntaxHighlight(); } catch(e) {} }, 50);
}

function syncZoomSlider() {
  const slider = document.getElementById('zoom-slider');
  const val    = document.getElementById('zoom-slider-val');
  const pct    = Math.round(_currentZoom * 100);
  if (slider) slider.value = pct;
  if (val)    val.textContent = `${pct}%`;

  document.querySelectorAll('.zoom-preset').forEach(btn => {
    const btnZ = parseFloat(btn.getAttribute('onclick')?.match(/zoomSet\(([\d.]+)\)/)?.[1] || 0);
    btn.classList.toggle('active', Math.abs(btnZ - _currentZoom) < 0.01);
  });
}

function zoomIn()    { _applyZoom(_currentZoom + ZOOM_STEP); }
function zoomOut()   { _applyZoom(_currentZoom - ZOOM_STEP); }
function zoomReset() { _applyZoom(_detectDefaultZoom()); }
function zoomSet(v)  { _applyZoom(parseFloat(v)); }

_applyZoom(_currentZoom);

document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey) return;
  if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomIn();    return; }
  if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomOut();   return; }
  if (e.key === '0')                  { e.preventDefault(); zoomReset(); return; }
}, { capture: true });

document.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  if (e.deltaY < 0) zoomIn();
  else              zoomOut();
}, { passive: false, capture: true });

// ── TAB NAVIGATION ─────────────────────────────────────────
function showTab(name) {
  // Hide all tab contents
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  // Remove active class from all tab buttons
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));

  // Show the selected tab
  const tabEl = document.getElementById(`tab-${name}`);
  if (tabEl) tabEl.classList.add('active');

  // Activate the corresponding sidebar button (order must match)
  const order = ['macro','templates','learning','logs','settings','movement'];
  const idx = order.indexOf(name);
  const btns = document.querySelectorAll('.tab-btn');
  if (idx >= 0 && btns[idx]) btns[idx].classList.add('active');

  // Load data if needed (with error handling)
  try {
    if (name === 'templates' && typeof loadTemplates === 'function') loadTemplates();
    if (name === 'learning' && typeof loadLearningData === 'function') loadLearningData();
    if (name === 'logs' && typeof refreshLogs === 'function') refreshLogs();
    if (name === 'settings' && typeof loadSettings === 'function') loadSettings();
    if (name === 'movement' && typeof loadMovementSettings === 'function') loadMovementSettings();
  } catch (e) {
    console.error(`Error loading tab ${name}:`, e);
  }
}

// ── MOVEMENT SETTINGS ──────────────────────────────────────
async function loadMovementSettings() {
  if (!checkApi()) return;
  try {
    const s = await withLoading(window.pywebview.api.get_movement_settings());
    document.getElementById('movement-player-x').value = s.player_x;
    document.getElementById('movement-player-y').value = s.player_y;
    document.getElementById('movement-key-up').value = s.key_up;
    document.getElementById('movement-key-down').value = s.key_down;
    document.getElementById('movement-key-left').value = s.key_left;
    document.getElementById('movement-key-right').value = s.key_right;
    document.getElementById('movement-step-time').value = s.step_time;
    document.getElementById('movement-stop-radius').value = s.stop_radius;
    document.getElementById('movement-stuck-threshold').value = s.stuck_threshold;
    const ar  = s.arrival_region   ?? 200;
    const arh = s.arrival_region_h ?? ar;
    const ac = s.arrival_confidence ?? 0.85;
    document.getElementById('movement-arrival-region').value   = ar;
    document.getElementById('arrival-region-slider').value     = ar;
    document.getElementById('movement-arrival-region-h').value = arh;
    document.getElementById('arrival-region-h-slider').value   = arh;
    document.getElementById('movement-arrival-confidence').value = ac;
    document.getElementById('arrival-conf-slider').value        = ac;
    // Target window
    const tw = s.target_window || '';
    document.getElementById('movement-target-window').value = tw;
    document.getElementById('movement-auto-focus').checked  = s.auto_focus !== false;
    _arrBox = _arrBoxFromSettings();
    arrivalUpdateToolbar();
    // Refresh window list and pre-select saved window
    await movRefreshWindows(tw);
  } catch(e) { console.warn('loadMovementSettings error:', e); }
}

async function saveMovementSettings() {
  if (!checkApi()) return;
  const settings = {
    player_x: parseInt(document.getElementById('movement-player-x').value) || 960,
    player_y: parseInt(document.getElementById('movement-player-y').value) || 540,
    key_up: document.getElementById('movement-key-up').value.trim() || 'up',
    key_down: document.getElementById('movement-key-down').value.trim() || 'down',
    key_left: document.getElementById('movement-key-left').value.trim() || 'left',
    key_right: document.getElementById('movement-key-right').value.trim() || 'right',
    step_time: parseFloat(document.getElementById('movement-step-time').value) || 0.1,
    stop_radius: parseInt(document.getElementById('movement-stop-radius').value) || 20,
    stuck_threshold: parseInt(document.getElementById('movement-stuck-threshold').value) || 3,
    arrival_region:   parseInt(document.getElementById('movement-arrival-region').value)   || 200,
    arrival_region_h: parseInt(document.getElementById('movement-arrival-region-h').value) || 200,
    arrival_confidence: parseFloat(document.getElementById('movement-arrival-confidence').value) || 0.85,
    target_window: (document.getElementById('movement-target-window').value || '').trim(),
    auto_focus: document.getElementById('movement-auto-focus')?.checked !== false,
  };
  try {
    await withLoading(window.pywebview.api.save_movement_settings(settings));
    toast('Movement settings saved!', 'info');
  } catch(e) { toast(`Error: ${e}`, 'error'); }
}

// ══════════════════════════════════════════════════════════════
//  ARRIVAL REGION INTERACTIVE EDITOR
// ══════════════════════════════════════════════════════════════

// State
let _arrImg       = null;   // screenshot Image object
let _arrScale     = 1;      // canvas-pixel / screen-pixel
let _arrBox       = null;   // { x, y, w, h } in SCREEN pixels
let _arrDrag      = null;   // { mode:'move'|'resize', startMx, startMy, startBox }
let _arrCanvasW   = 0;
let _arrCanvasH   = 0;

// ── TARGET WINDOW PICKER ──────────────────────────────────────────────────

async function movRefreshWindows(preselect) {
  if (!checkApi()) return;
  try {
    const result = await window.pywebview.api.get_open_windows();
    const sel = document.getElementById('movement-window-select');
    if (!sel) return;
    const current = (preselect !== undefined ? preselect : null)
      ?? document.getElementById('movement-target-window')?.value ?? '';
    sel.innerHTML = '<option value="">— select a window —</option>';
    (result.windows || []).forEach(title => {
      const opt = document.createElement('option');
      opt.value = title;
      opt.textContent = title.length > 55 ? title.slice(0, 52) + '…' : title;
      if (current && (title === current || title.toLowerCase().includes(current.toLowerCase()))) {
        opt.selected = true;
      }
      sel.appendChild(opt);
    });
  } catch(e) { console.warn('movRefreshWindows error:', e); }
}

function movWindowSelectChange() {
  const sel = document.getElementById('movement-window-select');
  const inp = document.getElementById('movement-target-window');
  if (sel && inp && sel.value) inp.value = sel.value;
  _movWindowStatus('', '');
}

function movWindowInputChange() {
  _movWindowStatus('', '');
}

function _movWindowStatus(msg, color) {
  const el = document.getElementById('movement-window-status');
  if (!el) return;
  el.textContent  = msg;
  el.style.color  = color || 'var(--text2)';
}

async function movDetectCurrentWindow() {
  if (!checkApi()) return;
  try {
    const result = await window.pywebview.api.get_foreground_window();
    const title  = (result.title || '').trim();
    if (!title) { toast('No active window detected', 'warn'); return; }
    document.getElementById('movement-target-window').value = title;
    const sel = document.getElementById('movement-window-select');
    if (sel) {
      for (const opt of sel.options) {
        if (opt.value === title) { opt.selected = true; break; }
      }
    }
    _movWindowStatus(`✓ Detected: "${title}"`, '#27ae60');
    toast(`Active window set: "${title}"`, 'info');
  } catch(e) { toast(`Error: ${e}`, 'error'); }
}

async function movTestFocus() {
  if (!checkApi()) return;
  const title = (document.getElementById('movement-target-window')?.value || '').trim();
  if (!title) { toast('Enter or select a window title first', 'warn'); return; }
  try {
    const result = await window.pywebview.api.focus_target_window();
    if (result.status === 'ok') {
      _movWindowStatus(`✓ ${result.message}`, '#27ae60');
      toast(result.message, 'info');
    } else {
      _movWindowStatus(`✗ ${result.message}`, '#e74c3c');
      toast(result.message, 'warn');
    }
  } catch(e) { toast(`Focus error: ${e}`, 'error'); }
}

// ── Sync sliders ↔ number inputs ──────────────────────────────
function arrivalSliderChange() {
  const v = document.getElementById('arrival-region-slider').value;
  document.getElementById('movement-arrival-region').value = v;
  _arrBox = _arrBoxFromSettings();
  arrivalRedraw();
  arrivalUpdateToolbar();
}
function arrivalInputChange() {
  const v = document.getElementById('movement-arrival-region').value;
  document.getElementById('arrival-region-slider').value = v;
  _arrBox = _arrBoxFromSettings();
  arrivalRedraw();
  arrivalUpdateToolbar();
}
function arrivalHSliderChange() {
  const v = document.getElementById('arrival-region-h-slider').value;
  document.getElementById('movement-arrival-region-h').value = v;
  _arrBox = _arrBoxFromSettings();
  arrivalRedraw();
  arrivalUpdateToolbar();
}
function arrivalHInputChange() {
  const v = document.getElementById('movement-arrival-region-h').value;
  document.getElementById('arrival-region-h-slider').value = v;
  _arrBox = _arrBoxFromSettings();
  arrivalRedraw();
  arrivalUpdateToolbar();
}
function arrivalConfSliderChange() {
  const v = document.getElementById('arrival-conf-slider').value;
  document.getElementById('movement-arrival-confidence').value = parseFloat(v).toFixed(2);
}
function arrivalConfInputChange() {
  const v = document.getElementById('movement-arrival-confidence').value;
  document.getElementById('arrival-conf-slider').value = v;
}

// ── Build box from current settings ──────────────────────────
function _arrBoxFromSettings() {
  const px = parseInt(document.getElementById('movement-player-x').value)      || 960;
  const py = parseInt(document.getElementById('movement-player-y').value)      || 540;
  const w  = parseInt(document.getElementById('movement-arrival-region').value) || 200;
  const h  = parseInt(document.getElementById('movement-arrival-region-h').value) || w;
  return { x: px - w / 2, y: py - h / 2, w, h };
}

// ── Load screen ───────────────────────────────────────────────
async function arrivalLoadScreen() {
  if (!checkApi()) return;
  try {
    const result = await window.pywebview.api.capture_screen();
    if (!result || result.status !== 'ok') { toast('Screen capture failed', 'error'); return; }

    const img = new Image();
    img.onload = () => {
      _arrImg = img;
      const canvas = document.getElementById('arrival-canvas');
      // Natural screen size from image (it's a downscaled JPEG from capture_screen)
      const SW = window.screen.width  || 1920;
      const SH = window.screen.height || 1080;
      _arrScale  = img.width / SW;    // canvas units per screen pixel
      _arrCanvasW = img.width;
      _arrCanvasH = img.height;
      canvas.width  = img.width;
      canvas.height = img.height;
      document.getElementById('arrival-canvas-empty').style.display = 'none';

      if (!_arrBox) _arrBox = _arrBoxFromSettings();
      arrivalRedraw();
      arrivalUpdateToolbar();
    };
    img.src = result.screen;
  } catch(e) { toast(`Capture error: ${e}`, 'error'); }
}

// ── Reset box to current player position ─────────────────────
function arrivalResetBox() {
  _arrBox = _arrBoxFromSettings();
  arrivalRedraw();
  arrivalUpdateToolbar();
  _arrWriteBoxToInputs();
}

// ── Redraw canvas ─────────────────────────────────────────────
function arrivalRedraw() {
  const canvas = document.getElementById('arrival-canvas');
  if (!canvas || !_arrImg) return;
  const ctx = canvas.getContext('2d');
  const s   = _arrScale;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(_arrImg, 0, 0);

  if (!_arrBox) return;

  const bx = _arrBox.x * s, by = _arrBox.y * s;
  const bw = _arrBox.w * s, bh = _arrBox.h * s;

  // Dimmed overlay outside the box
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0,  0,  canvas.width, by);
  ctx.fillRect(0,  by, bx, bh);
  ctx.fillRect(bx + bw, by, canvas.width - bx - bw, bh);
  ctx.fillRect(0,  by + bh, canvas.width, canvas.height - by - bh);

  // Box fill
  ctx.fillStyle = 'rgba(52,152,219,0.12)';
  ctx.fillRect(bx, by, bw, bh);

  // Box border
  ctx.strokeStyle = '#3498db';
  ctx.lineWidth   = Math.max(1.5, 2 * s);
  ctx.setLineDash([8 * s, 4 * s]);
  ctx.strokeRect(bx, by, bw, bh);
  ctx.setLineDash([]);

  // Corner handles
  const hs = Math.max(6, 9 * s);
  const corners = [
    [bx,      by     ],
    [bx + bw, by     ],
    [bx,      by + bh],
    [bx + bw, by + bh],
  ];
  corners.forEach(([cx, cy]) => {
    ctx.fillStyle = '#3498db';
    ctx.fillRect(cx - hs/2, cy - hs/2, hs, hs);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(cx - hs/2, cy - hs/2, hs, hs);
  });

  // Player dot
  const px = parseInt(document.getElementById('movement-player-x').value) || 960;
  const py = parseInt(document.getElementById('movement-player-y').value) || 540;
  const vpx = px * s, vpy = py * s;
  ctx.beginPath();
  ctx.arc(vpx, vpy, Math.max(5, 7 * s), 0, Math.PI * 2);
  ctx.fillStyle = '#27ae60';
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Labels
  const fs = Math.max(11, 13 * s);
  ctx.font = `bold ${fs}px Segoe UI,sans-serif`;

  // Box label
  ctx.fillStyle = '#3498db';
  const lbl = `Arrival region  ${_arrBox.w}×${_arrBox.h}px`;
  const tw = ctx.measureText(lbl).width;
  const lx = Math.min(bx + 6, canvas.width - tw - 8);
  const ly = by > fs + 6 ? by - 6 : by + bh + fs + 4;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(lx - 3, ly - fs, tw + 6, fs + 4);
  ctx.fillStyle = '#3498db';
  ctx.fillText(lbl, lx, ly);

  // Player label
  ctx.font = `${Math.max(10, 12 * s)}px Segoe UI,sans-serif`;
  ctx.fillStyle = '#27ae60';
  ctx.fillText('Player', vpx + Math.max(8, 10 * s), vpy + 4);
}

// ── Drag logic ────────────────────────────────────────────────
function _arrHitTest(mx, my) {
  // Returns 'resize-tl'|'resize-tr'|'resize-bl'|'resize-br'|'move'|null
  if (!_arrBox || !_arrImg) return null;
  const s  = _arrScale;
  const bx = _arrBox.x * s, by = _arrBox.y * s;
  const bw = _arrBox.w * s, bh = _arrBox.h * s;
  const hs = Math.max(10, 12 * s);
  const corners = [
    ['resize-tl', bx,      by     ],
    ['resize-tr', bx + bw, by     ],
    ['resize-bl', bx,      by + bh],
    ['resize-br', bx + bw, by + bh],
  ];
  for (const [name, cx, cy] of corners) {
    if (Math.abs(mx - cx) <= hs && Math.abs(my - cy) <= hs) return name;
  }
  if (mx >= bx && mx <= bx + bw && my >= by && my <= by + bh) return 'move';
  return null;
}

function arrivalMouseDown(e) {
  if (!_arrBox || !_arrImg) return;
  const canvas = document.getElementById('arrival-canvas');
  const rect   = canvas.getBoundingClientRect();
  const scaleX = canvas.width  / rect.width;
  const scaleY = canvas.height / rect.height;
  const mx = (e.clientX - rect.left) * scaleX;
  const my = (e.clientY - rect.top)  * scaleY;
  const hit = _arrHitTest(mx, my);
  if (!hit) return;
  _arrDrag = { mode: hit, startMx: mx, startMy: my, startBox: { ..._arrBox } };
  canvas.style.cursor = hit === 'move' ? 'grabbing' : 'nwse-resize';
  e.preventDefault();
}

function arrivalMouseMove(e) {
  const canvas = document.getElementById('arrival-canvas');
  const rect   = canvas.getBoundingClientRect();
  const scaleX = canvas.width  / rect.width;
  const scaleY = canvas.height / rect.height;
  const mx = (e.clientX - rect.left) * scaleX;
  const my = (e.clientY - rect.top)  * scaleY;

  if (!_arrDrag) {
    // Cursor hint
    const hit = _arrHitTest(mx, my);
    const cursorMap = { 'move': 'grab', 'resize-tl': 'nwse-resize', 'resize-br': 'nwse-resize', 'resize-tr': 'nesw-resize', 'resize-bl': 'nesw-resize' };
    canvas.style.cursor = hit ? (cursorMap[hit] || 'crosshair') : 'crosshair';
    return;
  }

  const s   = _arrScale;
  const dx  = (mx - _arrDrag.startMx) / s;
  const dy  = (my - _arrDrag.startMy) / s;
  const sb  = _arrDrag.startBox;
  const SW  = window.screen.width  || 1920;
  const SH  = window.screen.height || 1080;

  if (_arrDrag.mode === 'move') {
    _arrBox.x = Math.max(0, Math.min(SW - sb.w, sb.x + dx));
    _arrBox.y = Math.max(0, Math.min(SH - sb.h, sb.y + dy));
  } else {
    // Resize: each corner controls the two edges it touches independently.
    let nw = sb.w, nh = sb.h, nx = sb.x, ny = sb.y;

    if (_arrDrag.mode === 'resize-br') {
      nw = Math.max(50, sb.w + dx);
      nh = Math.max(50, sb.h + dy);
    } else if (_arrDrag.mode === 'resize-bl') {
      nw = Math.max(50, sb.w - dx);
      nh = Math.max(50, sb.h + dy);
      nx = sb.x + sb.w - nw;
    } else if (_arrDrag.mode === 'resize-tr') {
      nw = Math.max(50, sb.w + dx);
      nh = Math.max(50, sb.h - dy);
      ny = sb.y + sb.h - nh;
    } else if (_arrDrag.mode === 'resize-tl') {
      nw = Math.max(50, sb.w - dx);
      nh = Math.max(50, sb.h - dy);
      nx = sb.x + sb.w - nw;
      ny = sb.y + sb.h - nh;
    }

    nw = Math.min(Math.round(nw / 10) * 10, 800);
    nh = Math.min(Math.round(nh / 10) * 10, 800);
    _arrBox.x = Math.max(0, nx);
    _arrBox.y = Math.max(0, ny);
    _arrBox.w = nw;
    _arrBox.h = nh;
  }

  // Keep player centred in box
  const newPx = Math.round(_arrBox.x + _arrBox.w / 2);
  const newPy = Math.round(_arrBox.y + _arrBox.h / 2);
  document.getElementById('movement-player-x').value = newPx;
  document.getElementById('movement-player-y').value = newPy;

  _arrWriteBoxToInputs();
  arrivalRedraw();
  arrivalUpdateToolbar();
}

function arrivalMouseUp(e) {
  if (_arrDrag) {
    _arrDrag = null;
    document.getElementById('arrival-canvas').style.cursor = 'crosshair';
  }
}

function _arrWriteBoxToInputs() {
  if (!_arrBox) return;
  document.getElementById('movement-arrival-region').value   = _arrBox.w;
  document.getElementById('arrival-region-slider').value     = _arrBox.w;
  document.getElementById('movement-arrival-region-h').value = _arrBox.h;
  document.getElementById('arrival-region-h-slider').value   = _arrBox.h;
}

function arrivalUpdateToolbar() {
  const el = document.getElementById('arrival-toolbar-info');
  if (!el || !_arrBox) return;
  const px = parseInt(document.getElementById('movement-player-x').value) || 960;
  const py = parseInt(document.getElementById('movement-player-y').value) || 540;
  el.textContent = `Region: ${_arrBox.w}×${_arrBox.h}px  ·  Player: (${px}, ${py})`;
}

// Backwards compat stubs (called from old references)
function updateArrivalViz() { arrivalRedraw(); }
function testArrivalRegion() { arrivalLoadScreen(); }
function arrivalPreviewFullscreen() {}


// ── STATUS ─────────────────────────────────────────────────
function setStatus(state, text) {
  const dot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  if (dot) dot.className = `dot ${state}`;
  if (statusText) statusText.textContent = text;
  const nav = document.querySelector('.navbar');
  if (nav) {
    nav.classList.remove('is-running', 'is-recording');
    if (state === 'running')   nav.classList.add('is-running');
    if (state === 'recording') nav.classList.add('is-recording');
  }
  // ── Reflect state in the OS window title bar ──────────────
  // Users can see the status even when the app is minimised or
  // behind another window (e.g. the game they are automating).
  const BASE = 'AMYT';
  const titles = {
    running:   '\u25B6 Running — ' + BASE,
    recording: '\u23FA Recording — ' + BASE,
    idle:      BASE,
  };
  // 'idle' catches: Idle, Stopped, Paused, Error, Done — all non-active states
  const key = (state === 'running' || state === 'recording') ? state : 'idle';
  // Special-case paused: show pause symbol
  if (text && text.toLowerCase().includes('pause')) {
    document.title = '\u23F8 Paused — ' + BASE;
  } else {
    document.title = titles[key] || BASE;
  }
}

// ── CHEAT SHEET MODAL ──────────────────────────────────────
function showCheatSheet() {
  document.getElementById('cheatsheet-overlay')?.classList.remove('hidden');
}

function closeCheatSheet() {
  document.getElementById('cheatsheet-overlay')?.classList.add('hidden');
}

function hideCheatSheet(event) {
  if (event.target.id === 'cheatsheet-overlay') closeCheatSheet();
}

function onCheatSheetKey(e) {
  if (e.key === 'Escape') closeCheatSheet();
}

function showCsTab(name) {
  document.querySelectorAll('.cs-section').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.cs-tab').forEach(el => el.classList.remove('active'));
  const section = document.getElementById(`cs-${name}`);
  if (section) section.classList.add('active');
  const tabs = document.querySelectorAll('.cs-tab');
  const order = ['basics','mouse','keyboard','images','navigation','logic','variables','ocr','colordet','clipboard','debug','examples'];
  const idx = order.indexOf(name);
  if (idx >= 0 && tabs[idx]) tabs[idx].classList.add('active');
}

// ── ESC closes any open modal ──────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const overlays = [
    'wait-config-overlay',
    'img-action-overlay',
    'line-edit-overlay',
    'toast-config-overlay',
    'label-config-overlay',
    'goto-config-overlay',
    'key-capture-overlay',
    'cheatsheet-overlay',
  ];
  for (const id of overlays) {
    const el = document.getElementById(id);
    if (el && !el.classList.contains('hidden')) {
      el.classList.add('hidden');
      if (id === 'key-capture-overlay' && typeof keyCaptureCancel === 'function') {
        keyCaptureCancel();
      }
      break;
    }
  }
});