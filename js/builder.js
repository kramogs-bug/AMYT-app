/**
 * builder.js — Script builder modals:
 *   - insertCmd (toolbar snippets)
 *   - Key capture modal
 *   - Mouse coord input panel + live tracking
 *   - Drag-and-drop onto editor
 *   - IF IMAGE / WHILE IMAGE modals + palette
 *   - Mini action config popup
 *   - Wait / Toast / Label / Goto config modals
 *   - Image action modal
 */

// ══════════════════════════════════════════════════════════
//  TOOLBAR INSERT COMMANDS
// ══════════════════════════════════════════════════════════

function insertCmd(type) {
  if (_guardRunning('insert a command')) return;
  const keyboardCmds = ['press', 'hold', 'release'];
  if (keyboardCmds.includes(type)) { openKeyCapture(type); return; }

  const x = _lastX || 500;
  const y = _lastY || 300;
  const snippets = {
    'click':     `CLICK ${x} ${y}`,
    'dblclick':  `DOUBLE_CLICK ${x} ${y}`,
    'rclick':    `RIGHT_CLICK ${x} ${y}`,
    'move':      `MOVE ${x} ${y}`,
    'movehuman': `MOVE_HUMAN ${x} ${y}`,
    'scroll':    `SCROLL -3`,
    'drag':      `DRAG ${x} ${y} ${x+100} ${y}`,
    'type':      `TYPE your text here`,
    'hotkey':    `HOTKEY ctrl+c`,
    'clickimg':  `CLICK_IMAGE template_name`,
    'clickrand': `CLICK_RANDOM_OFFSET template_name 8`,
    'waitimg':   `WAIT_IMAGE template_name 30`,
    'waitgone':  `WAIT_IMAGE_GONE template_name 30`,
    'wait':      `WAIT 1`,
    'waitrand':  `WAIT_RANDOM 1.0 3.0`,
    'repeat':    `REPEAT 5\n  CLICK ${x} ${y}\n  WAIT 0.5\nEND`,
    'loop':      `LOOP\n  WAIT 0.5\nEND`,
    'if':        `IF_IMAGE template_name\n  CLICK ${x} ${y}\nELSE\n  WAIT 1\nEND`,
    'while':     `WHILE_IMAGE template_name\n  WAIT 1\nEND`,
    'comment':   `# your comment here`,
    'stop_cmd':   `STOP`,
    'pause_cmd':  `PAUSE_SCRIPT`,
    'read_text':       `READ_TEXT "text to find" -> $my_var`,
    'wait_color':      `WAIT_COLOR #FF0000 tolerance=30 timeout=10`,
    'read_color':      `READ_COLOR ${x} ${y} -> $pixel_color`,
    'if_var':          `IF_VAR $my_var == 1\n  CLICK ${x} ${y}\nELSE\n  WAIT 1\nEND`,
    'while_var':       `WHILE_VAR $count < 10\n  CLICK ${x} ${y}\n  SET count = $count + 1\nEND`,
    'repeat_until':    `REPEAT_UNTIL IMAGE template_name\n  CLICK ${x} ${y}\n  WAIT 1\nEND`,
    'on_error':        `FIND_CLICK template_name\nON_ERROR\n  TOAST "Not found, retrying" warn\n  WAIT 2\nEND`,
    'clipboard_set':   `CLIPBOARD_SET "text to copy"`,
    'clipboard_get':   `CLIPBOARD_GET -> $clipboard_text`,
    'clipboard_copy':  `CLIPBOARD_COPY`,
    'clipboard_paste': `CLIPBOARD_PASTE`,
  };
  const snippet = snippets[type];
  if (!snippet) return;
  insertToEditor(snippet);
}

// ══════════════════════════════════════════════════════════
//  KEY CAPTURE MODAL
// ══════════════════════════════════════════════════════════

let _keyCaptureCmd     = '';
let _keyCaptureKey     = '';
let _keyCaptureHandler = null;
let _ifimgRedirectTarget = null;

function _normalizeKey(e) {
  const map = {
    ' ':'space','Enter':'enter','Tab':'tab','Backspace':'backspace','Delete':'delete',
    'Escape':'escape','ArrowUp':'up','ArrowDown':'down','ArrowLeft':'left','ArrowRight':'right',
    'Home':'home','End':'end','PageUp':'pageup','PageDown':'pagedown','Insert':'insert',
    'CapsLock':'capslock','NumLock':'numlock','ScrollLock':'scrolllock',
    'Control':'ctrl','Shift':'shift','Alt':'alt','Meta':'win',
    'F1':'f1','F2':'f2','F3':'f3','F4':'f4','F5':'f5','F6':'f6',
    'F7':'f7','F8':'f8','F9':'f9','F10':'f10','F11':'f11','F12':'f12',
  };
  if (map[e.key]) return map[e.key];
  if (e.key.length === 1) return e.key.toLowerCase();
  return (e.code || e.key).toLowerCase();
}

const CMD_LABELS = { press: 'PRESS', hold: 'HOLD', release: 'RELEASE' };

function openKeyCapture(cmdType) {
  _keyCaptureCmd = cmdType;
  _keyCaptureKey = '';
  const label = CMD_LABELS[cmdType] || cmdType.toUpperCase();
  document.getElementById('key-modal-title').textContent = `${label} — press a key on your keyboard`;
  document.getElementById('key-display').textContent     = '—';
  document.getElementById('key-display').className       = 'key-display';
  document.getElementById('key-preview').textContent     = '';
  document.getElementById('key-confirm-btn').disabled    = true;
  document.getElementById('key-capture-overlay').classList.remove('hidden');

  _keyCaptureHandler = (e) => {
    e.preventDefault(); e.stopPropagation();
    const key = _normalizeKey(e);
    _keyCaptureKey = key;
    const display = document.getElementById('key-display');
    display.textContent = key.toUpperCase();
    display.className   = 'key-display captured';
    document.getElementById('key-preview').textContent = `→ will insert: ${label} ${key}`;
    document.getElementById('key-confirm-btn').disabled = false;
  };
  document.addEventListener('keydown', _keyCaptureHandler, { capture: true });
}

function keyCaptureConfirm() {
  if (!_keyCaptureKey) return;
  const label   = CMD_LABELS[_keyCaptureCmd] || _keyCaptureCmd.toUpperCase();
  const snippet = `${label} ${_keyCaptureKey}`;

  if (_ifimgRedirectTarget) {
    const cur = _ifimgRedirectTarget.value;
    _ifimgRedirectTarget.value = cur ? cur + '\n' + snippet : snippet;
    _ifimgRedirectTarget.dispatchEvent(new Event('input'));
    _ifimgRedirectTarget = null;
    keyCaptureClose();
    return;
  }

  insertToEditor(snippet);
  toast(`Inserted: ${snippet}`, 'info');
  keyCaptureClose();
}

function keyCaptureCancel() { keyCaptureClose(); }

function keyCaptureClose() {
  document.getElementById('key-capture-overlay').classList.add('hidden');
  if (_keyCaptureHandler) {
    document.removeEventListener('keydown', _keyCaptureHandler, { capture: true });
    _keyCaptureHandler = null;
  }
  _keyCaptureCmd = ''; _keyCaptureKey = '';
  _ifimgRedirectTarget = null;
}

document.addEventListener('keydown', (e) => {
  const overlay = document.getElementById('key-capture-overlay');
  if (e.key === 'Escape' && overlay && !overlay.classList.contains('hidden')) {
    e.preventDefault(); e.stopPropagation(); keyCaptureCancel(); return;
  }
  if (e.key === 'Escape') closeCheatSheet();
});

// ══════════════════════════════════════════════════════════
//  MOUSE COORD INPUT PANEL + LIVE TRACKING
// ══════════════════════════════════════════════════════════

let _dndPendingCmd = null;

const _MOUSE_CMD_LABELS = {
  click:'Left Click', dblclick:'Double Click', rclick:'Right Click',
  move:'Move Mouse', movehuman:'Move (Natural)', scroll:'Scroll', drag:'Drag',
};

const _MOUSE_CMD_FIELDS = {
  click:     [{ id:'x', label:'X', def: ()=>_lastX||500 }, { id:'y', label:'Y', def: ()=>_lastY||300 }],
  dblclick:  [{ id:'x', label:'X', def: ()=>_lastX||500 }, { id:'y', label:'Y', def: ()=>_lastY||300 }],
  rclick:    [{ id:'x', label:'X', def: ()=>_lastX||500 }, { id:'y', label:'Y', def: ()=>_lastY||300 }],
  move:      [{ id:'x', label:'X', def: ()=>_lastX||500 }, { id:'y', label:'Y', def: ()=>_lastY||300 }],
  movehuman: [{ id:'x', label:'X', def: ()=>_lastX||500 }, { id:'y', label:'Y', def: ()=>_lastY||300 }],
  scroll:    [{ id:'amount', label:'Amount (+ up, − down)', def: ()=>-3 }],
  drag:      [
    { id:'x1', label:'From X', def: ()=>_lastX||100 },
    { id:'y1', label:'From Y', def: ()=>_lastY||200 },
    { id:'x2', label:'To X',   def: ()=>(_lastX||100)+200 },
    { id:'y2', label:'To Y',   def: ()=>_lastY||200 },
  ],
};

function _buildMouseSnippet(cmdType, values) {
  switch (cmdType) {
    case 'click':     return `CLICK ${values.x} ${values.y}`;
    case 'dblclick':  return `DOUBLE_CLICK ${values.x} ${values.y}`;
    case 'rclick':    return `RIGHT_CLICK ${values.x} ${values.y}`;
    case 'move':      return `MOVE ${values.x} ${values.y}`;
    case 'movehuman': return `MOVE_HUMAN ${values.x} ${values.y}`;
    case 'scroll':    return `SCROLL ${values.amount}`;
    case 'drag':      return `DRAG ${values.x1} ${values.y1} ${values.x2} ${values.y2}`;
    default:          return '';
  }
}

function openMouseCmd(cmdType) { if (_guardRunning('insert a mouse command')) return; openMouseCmdCoordPanel(cmdType); }

// Live tracking inside coord panel
let _mouseCmdTracking   = false;
let _mouseCmdTrackPoll  = null;
let _mouseCmdTrackField = null;

function mouseCmdStartTrack() {
  if (_mouseCmdTracking) { _mouseCmdStopTrack(false); return; }
  if (!checkApi()) return;

  const isDrag = _dndPendingCmd === 'drag';
  if (isDrag) {
    _mouseCmdTrackField = _mouseCmdTrackField === 'x1y1' ? 'x2y2' : 'x1y1';
    const label = _mouseCmdTrackField === 'x1y1' ? 'FROM position' : 'TO position';
    document.getElementById('mouse-cmd-track-btn').textContent = `🎯 Tracking ${label} — click to stop`;
  } else {
    _mouseCmdTrackField = 'xy';
    document.getElementById('mouse-cmd-track-btn').textContent = '🎯 Tracking — click to stop';
  }

  _mouseCmdTracking = true;
  document.getElementById('mouse-cmd-track-btn').style.color       = 'var(--accent)';
  document.getElementById('mouse-cmd-track-btn').style.borderColor = 'var(--accent)';
  document.getElementById('mouse-cmd-track-hint').style.display    = 'inline';

  _mouseCmdTrackPoll = setInterval(async () => {
    try {
      const pos = await window.pywebview.api.get_mouse_pos();
      if (!pos || _dndPendingCmd === null) { _mouseCmdStopTrack(false); return; }
      _mouseCmdApplyPos(pos.x, pos.y);
    } catch(e) {}
  }, 50);

  document.addEventListener('keydown', _mouseCmdTrackKey, { capture: true });
}

function _mouseCmdTrackKey(e) {
  if (e.key === 'F2') {
    e.preventDefault(); e.stopPropagation(); _mouseCmdStopTrack(true);
  } else if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation(); _mouseCmdStopTrack(false);
  }
}

function _mouseCmdApplyPos(x, y) {
  if (_mouseCmdTrackField === 'xy') {
    const fx = document.getElementById('mccp-x'); const fy = document.getElementById('mccp-y');
    if (fx) fx.value = x; if (fy) fy.value = y;
  } else if (_mouseCmdTrackField === 'x1y1') {
    const fx = document.getElementById('mccp-x1'); const fy = document.getElementById('mccp-y1');
    if (fx) fx.value = x; if (fy) fy.value = y;
  } else if (_mouseCmdTrackField === 'x2y2') {
    const fx = document.getElementById('mccp-x2'); const fy = document.getElementById('mccp-y2');
    if (fx) fx.value = x; if (fy) fy.value = y;
  }
  _updateMouseCmdPreview();
}

function _mouseCmdStopTrack(captured) {
  _mouseCmdTracking = false;
  clearInterval(_mouseCmdTrackPoll); _mouseCmdTrackPoll = null;
  document.removeEventListener('keydown', _mouseCmdTrackKey, { capture: true });

  const btn = document.getElementById('mouse-cmd-track-btn');
  if (btn) {
    btn.style.color = ''; btn.style.borderColor = '';
    const isDrag = _dndPendingCmd === 'drag';
    btn.textContent = isDrag
      ? (_mouseCmdTrackField === 'x1y1' ? '🎯 Track TO position' : '🎯 Track FROM position')
      : '🎯 Track Mouse Position';
  }
  document.getElementById('mouse-cmd-track-hint').style.display = 'none';

  if (captured) {
    toast('Position captured', 'info');
    if (_dndPendingCmd === 'drag') {
      _mouseCmdTrackField = _mouseCmdTrackField === 'x1y1' ? 'x2y2' : 'x1y1';
      if (btn) btn.textContent = `🎯 Track ${_mouseCmdTrackField === 'x1y1' ? 'FROM' : 'TO'} position`;
    }
  }
}

function mouseCmdCoordCancel() {
  if (_mouseCmdTracking) _mouseCmdStopTrack(false);
  _mouseCmdTrackField  = null;
  _ifimgRedirectTarget = null;
  _origMouseCmdCoordCancel();
}

function openMouseCmdCoordPanel(cmdType) {
  _mouseCmdTracking   = false;
  _mouseCmdTrackField = null;
  clearInterval(_mouseCmdTrackPoll); _mouseCmdTrackPoll = null;
  _origOpenMouseCmdCoordPanel(cmdType);

  const btn  = document.getElementById('mouse-cmd-track-btn');
  const hint = document.getElementById('mouse-cmd-track-hint');
  if (btn)  { btn.textContent = '🎯 Track Mouse Position'; btn.style.color = ''; btn.style.borderColor = ''; }
  if (hint) hint.style.display = 'none';

  const trackRow = document.getElementById('mouse-cmd-track-row');
  if (trackRow) trackRow.style.display = (cmdType === 'scroll') ? 'none' : 'flex';
}

function _origOpenMouseCmdCoordPanel(cmdType) {
  _dndPendingCmd = cmdType;
  const label  = _MOUSE_CMD_LABELS[cmdType] || cmdType;
  const fields = _MOUSE_CMD_FIELDS[cmdType] || [];

  document.getElementById('mouse-cmd-coord-title').innerHTML =
    `<svg class="icon" aria-hidden="true"><use href="#i-mouse"/></svg> ${label} — Enter Coordinates`;

  const container = document.getElementById('mouse-cmd-coord-fields');
  container.innerHTML = '';

  if (fields.length === 2 && fields[0].id !== 'amount') {
    const row = document.createElement('div');
    row.className = 'cfg-row'; row.style.gap = '12px';
    fields.forEach(f => {
      const group = document.createElement('div');
      group.className = 'cfg-field'; group.style.flex = '1';
      group.innerHTML = `<label class="cfg-label">${f.label}</label>
        <input type="number" id="mccp-${f.id}" class="cfg-input" value="${f.def()}"
          oninput="_updateMouseCmdPreview()" style="width:100%"/>`;
      row.appendChild(group);
    });
    container.appendChild(row);
  } else if (fields.length === 4) {
    [[fields[0], fields[1]], [fields[2], fields[3]]].forEach(pair => {
      const row = document.createElement('div');
      row.className = 'cfg-row'; row.style.cssText = 'gap:12px;margin-bottom:6px';
      pair.forEach(f => {
        const group = document.createElement('div');
        group.className = 'cfg-field'; group.style.flex = '1';
        group.innerHTML = `<label class="cfg-label">${f.label}</label>
          <input type="number" id="mccp-${f.id}" class="cfg-input" value="${f.def()}"
            oninput="_updateMouseCmdPreview()" style="width:100%"/>`;
        row.appendChild(group);
      });
      container.appendChild(row);
    });
  } else {
    fields.forEach(f => {
      const group = document.createElement('div');
      group.className = 'cfg-field';
      group.innerHTML = `<label class="cfg-label">${f.label}</label>
        <input type="number" id="mccp-${f.id}" class="cfg-input" value="${f.def()}"
          oninput="_updateMouseCmdPreview()" style="width:120px"/>`;
      container.appendChild(group);
    });
  }

  _updateMouseCmdPreview();
  document.getElementById('mouse-cmd-coord-overlay').classList.remove('hidden');
  setTimeout(() => { const first = container.querySelector('input'); if (first) first.focus(); }, 50);
}

function _updateMouseCmdPreview() {
  const fields = _MOUSE_CMD_FIELDS[_dndPendingCmd] || [];
  const values = {};
  fields.forEach(f => {
    const el = document.getElementById(`mccp-${f.id}`);
    values[f.id] = el ? (parseInt(el.value) || 0) : 0;
  });
  document.getElementById('mouse-cmd-coord-preview').textContent =
    _buildMouseSnippet(_dndPendingCmd, values);
}

function mouseCmdCoordConfirm() {
  const fields = _MOUSE_CMD_FIELDS[_dndPendingCmd] || [];
  const values = {};
  fields.forEach(f => {
    const el = document.getElementById(`mccp-${f.id}`);
    values[f.id] = el ? (parseInt(el.value) || 0) : 0;
  });
  const snippet = _buildMouseSnippet(_dndPendingCmd, values);
  if (!snippet) return;

  if (_ifimgRedirectTarget) {
    const cur = _ifimgRedirectTarget.value;
    _ifimgRedirectTarget.value = cur ? cur + '\n' + snippet : snippet;
    _ifimgRedirectTarget.dispatchEvent(new Event('input'));
    _ifimgRedirectTarget = null;
    if (_mouseCmdTracking) _mouseCmdStopTrack(false);
    document.getElementById('mouse-cmd-coord-overlay').classList.add('hidden');
    _dndPendingCmd = null;
    return;
  }

  document.getElementById('mouse-cmd-coord-overlay').classList.add('hidden');
  openDndConfirmPanel(snippet);
}

function _origMouseCmdCoordCancel() {
  document.getElementById('mouse-cmd-coord-overlay').classList.add('hidden');
  _dndPendingCmd = null;
}

// ── Drag & drop onto editor ────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.bld-btn[draggable="true"]').forEach(btn => {
    btn.addEventListener('dragstart', (e) => {
      const cmdType = btn.dataset.cmd;
      if (cmdType) {
        e.dataTransfer.setData('text/macro-cmd', cmdType);
        e.dataTransfer.effectAllowed = 'copy';
        btn.classList.add('bld-btn-dragging');
      }
    });
    btn.addEventListener('dragend', () => btn.classList.remove('bld-btn-dragging'));
  });
});

function onEditorDragOver(e) {
  if (!e.dataTransfer.types.includes('text/macro-cmd')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  document.getElementById('script-editor').classList.add('editor-drop-target');
}

function onEditorDragLeave(e) {
  document.getElementById('script-editor').classList.remove('editor-drop-target');
}

function onEditorDrop(e) {
  document.getElementById('script-editor').classList.remove('editor-drop-target');
  if (_guardRunning('drop a command into the editor')) return;
  const cmdType = e.dataTransfer.getData('text/macro-cmd');
  if (!cmdType || !_MOUSE_CMD_FIELDS[cmdType]) return;
  e.preventDefault();
  openMouseCmdCoordPanel(cmdType);
}

// ── Confirm panel ──────────────────────────────────────────
let _dndPendingSnippet = null;

function openDndConfirmPanel(snippet) {
  _dndPendingSnippet = snippet;
  document.getElementById('dnd-confirm-preview').textContent = snippet;
  document.getElementById('dnd-confirm-overlay').classList.remove('hidden');
  setTimeout(() => {
    document.getElementById('dnd-confirm-overlay').querySelector('.btn-play')?.focus();
  }, 50);
}

function dndConfirmAccept() {
  if (_guardRunning('insert a command')) return;
  if (!_dndPendingSnippet) return;
  insertToEditor(_dndPendingSnippet);
  toast(`Inserted: ${_dndPendingSnippet.split('\n')[0]}`, 'info');
  dndConfirmCancel();
}

function dndConfirmCancel() {
  document.getElementById('dnd-confirm-overlay').classList.add('hidden');
  _dndPendingSnippet = null; _dndPendingCmd = null;
}

document.addEventListener('keydown', (e) => {
  const coordOverlay = document.getElementById('mouse-cmd-coord-overlay');
  if (coordOverlay && !coordOverlay.classList.contains('hidden')) {
    if (e.key === 'Enter')  { e.preventDefault(); mouseCmdCoordConfirm(); return; }
    if (e.key === 'Escape') { e.preventDefault(); mouseCmdCoordCancel();  return; }
  }
  const confirmOverlay = document.getElementById('dnd-confirm-overlay');
  if (confirmOverlay && !confirmOverlay.classList.contains('hidden')) {
    if (e.key === 'Enter')  { e.preventDefault(); dndConfirmAccept(); return; }
    if (e.key === 'Escape') { e.preventDefault(); dndConfirmCancel(); return; }
  }
});

// ══════════════════════════════════════════════════════════
//  IF IMAGE / WHILE IMAGE MODALS
// ══════════════════════════════════════════════════════════

let _ifimgFocus    = 'found';
let _whileimgFocus = 'loop';
let _miniActionTarget    = null;
let _miniActionCmd       = null;
let _miniActionPreviewFn = null;

async function _loadTemplatesInto(selId, typeFilter) {
  // typeFilter: 'IMAGE' | 'TEXT' | 'COLOR' | undefined (= all)
  if (!checkApi()) return;
  const sel = document.getElementById(selId);
  const cur = sel ? sel.value : '';
  try {
    const r = await withLoading(window.pywebview.api.get_templates());
    if (!sel) return;
    sel.innerHTML = '<option value="">— select template —</option>';
    (r.templates || []).forEach(t => {
      const tType = t.type || 'IMAGE';
      if (typeFilter && tType !== typeFilter) return; // skip wrong types
      const opt = document.createElement('option');
      const dispName = (t.name || t).replace('.png', '');
      opt.value = t.name || t;
      opt.textContent = dispName;
      sel.appendChild(opt);
    });
    if (cur) sel.value = cur;
  } catch(e) {}
}

async function refreshIfImageTemplates()    { await _loadTemplatesInto('ifimg-template'); ifImagePreview(); }
async function refreshWhileImageTemplates() { await _loadTemplatesInto('whileimg-template'); whileImagePreview(); }

function openIfImageModal() {
  if (_guardRunning('open IF Image builder')) return;
  const conf  = document.getElementById('ifimg-confidence');
  const found = document.getElementById('ifimg-found-body');
  const els   = document.getElementById('ifimg-else-body');
  if (conf) conf.value  = '0.8';
  if (found) found.value = '';
  if (els)   els.value   = '';
  _ifimgFocus = 'found';
  document.getElementById('if-image-overlay').classList.remove('hidden');
  refreshIfImageTemplates();
  _initPaletteDragDrop('if-image-overlay', ifImagePreview);
  ifImagePreview();
}

function openWhileImageModal() {
  if (_guardRunning('open While Image builder')) return;
  const conf = document.getElementById('whileimg-confidence');
  const body = document.getElementById('whileimg-loop-body');
  if (conf) conf.value = '0.8';
  if (body) body.value = '';
  _whileimgFocus = 'loop';
  document.getElementById('while-image-overlay').classList.remove('hidden');
  refreshWhileImageTemplates();
  _initPaletteDragDrop('while-image-overlay', whileImagePreview);
  whileImagePreview();
}

function ifImageCancel()    { document.getElementById('if-image-overlay').classList.add('hidden'); }
function whileImageCancel() { document.getElementById('while-image-overlay').classList.add('hidden'); }
function ifImageOverlayClick(e)    { if (e.target.id === 'if-image-overlay')    ifImageCancel(); }
function whileImageOverlayClick(e) { if (e.target.id === 'while-image-overlay') whileImageCancel(); }

function _indentBlock(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text.split('\n').map(l => l.trim() ? pad + l.trim() : '').join('\n');
}

function _buildIfImageSnippet(tpl, conf, foundBody, elseBody) {
    const foundLines = foundBody.split('\n').map(l => l.trim()).filter(Boolean);
    const foundIndented = foundLines.length ? foundLines.map(l => '  ' + l).join('\n') : '  # actions when image is found';
    const elseLines = elseBody.split('\n').map(l => l.trim()).filter(Boolean);
    let confStr = (parseFloat(conf) === 0.8) ? '' : `confidence=${conf}`;
    let snippet = 'IF_IMAGE ' + tpl + (confStr ? ' ' + confStr : '') + '\n' + foundIndented;
    if (elseLines.length) snippet += '\nELSE\n' + elseLines.map(l => '  ' + l).join('\n');
    snippet += '\nEND';
    return snippet;
}

function _buildWhileImageSnippet(tpl, conf, loopBody) {
    const lines = loopBody.split('\n').map(l => l.trim()).filter(Boolean);
    const indented = lines.length ? lines.map(l => '  ' + l).join('\n') : '  # loop actions';
    let confStr = (parseFloat(conf) === 0.8) ? '' : `confidence=${conf}`;
    return 'WHILE_IMAGE ' + tpl + (confStr ? ' ' + confStr : '') + '\n' + indented + '\nEND';
}

function ifImagePreview() {
  const tpl   = ((document.getElementById('ifimg-template')   || {}).value || 'template.png').replace(/\.png$/i, '');
  const conf  = (document.getElementById('ifimg-confidence') || {}).value || '0.8';
  const found = (document.getElementById('ifimg-found-body') || {}).value || '';
  const els   = (document.getElementById('ifimg-else-body')  || {}).value || '';
  const el = document.getElementById('ifimg-preview');
  if (el) el.textContent = _buildIfImageSnippet(tpl, conf, found, els);
}

function whileImagePreview() {
  const tpl  = ((document.getElementById('whileimg-template')   || {}).value || 'template.png').replace(/\.png$/i, '');
  const conf = (document.getElementById('whileimg-confidence') || {}).value || '0.8';
  const body = (document.getElementById('whileimg-loop-body')  || {}).value || '';
  const el = document.getElementById('whileimg-preview');
  if (el) el.textContent = _buildWhileImageSnippet(tpl, conf, body);
}

function ifImageConfirm() {
  const tplRawIf = document.getElementById('ifimg-template').value;
  if (!tplRawIf) { toast('Select a template first', 'warn'); return; }
  const tpl   = tplRawIf.replace(/\.png$/i, '');
  const conf  = document.getElementById('ifimg-confidence').value || '0.8';
  const found = document.getElementById('ifimg-found-body').value || '';
  const els   = document.getElementById('ifimg-else-body').value  || '';
  _pushUndo();
  insertToEditor(_buildIfImageSnippet(tpl, conf, found, els));
  formatScript();
  toast('IF_IMAGE block inserted', 'info');
  ifImageCancel();
}

function whileImageConfirm() {
  const tplRawWhile = document.getElementById('whileimg-template').value;
  if (!tplRawWhile) { toast('Select a template first', 'warn'); return; }
  const tpl  = tplRawWhile.replace(/\.png$/i, '');
  const conf = document.getElementById('whileimg-confidence').value || '0.8';
  const body = document.getElementById('whileimg-loop-body').value  || '';
  _pushUndo();
  insertToEditor(_buildWhileImageSnippet(tpl, conf, body));
  formatScript();
  toast('WHILE_IMAGE block inserted', 'info');
  whileImageCancel();
}

// ── Palette drag & drop ────────────────────────────────────
function _initPaletteDragDrop(overlayId, previewFn) {
  const overlay = document.getElementById(overlayId);
  if (!overlay) return;

  overlay.querySelectorAll('.ifimg-pal-btn').forEach(btn => {
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);

    newBtn.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/ifimg-cmd', newBtn.dataset.cmd);
      e.dataTransfer.effectAllowed = 'copy';
      newBtn.classList.add('dragging');
    });
    newBtn.addEventListener('dragend', () => newBtn.classList.remove('dragging'));

    newBtn.addEventListener('click', () => {
      const isWhile = overlayId === 'while-image-overlay';
      const targetId = isWhile ? 'whileimg-loop-body'
        : (_ifimgFocus === 'else' ? 'ifimg-else-body' : 'ifimg-found-body');
      _openMiniActionConfig(newBtn.dataset.cmd, document.getElementById(targetId), previewFn);
    });
  });

  overlay.querySelectorAll('.ifimg-drop-zone').forEach(zone => {
    const targetId = zone.dataset.target;
    const newZone  = zone.cloneNode(true);
    zone.parentNode.replaceChild(newZone, zone);
    const textarea = document.getElementById(targetId);

    newZone.addEventListener('dragover', e => {
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; newZone.classList.add('drag-over');
    });
    newZone.addEventListener('dragleave', e => {
      if (!newZone.contains(e.relatedTarget)) newZone.classList.remove('drag-over');
    });
    newZone.addEventListener('drop', e => {
      e.preventDefault(); newZone.classList.remove('drag-over');
      const cmd = e.dataTransfer.getData('text/ifimg-cmd');
      if (cmd && textarea) _openMiniActionConfig(cmd, textarea, previewFn);
    });
  });
}

// ══════════════════════════════════════════════════════════
//  MINI ACTION CONFIG POPUP
// ══════════════════════════════════════════════════════════

const _MINI_COORD_CMDS = new Set(['CLICK','DOUBLE_CLICK','RIGHT_CLICK','MOVE','MOVE_HUMAN']);
const _MINI_FIND_CMDS  = new Set(['FIND_CLICK','FIND_DOUBLE_CLICK','FIND_RIGHT_CLICK','FIND_MOVE',
                                   'FIND_HOLD','FIND_DRAG','CLICK_IMAGE','WAIT_IMAGE','WAIT_IMAGE_GONE']);

function _openMiniActionConfig(cmd, targetTextarea, previewFn) {
  _miniActionTarget    = targetTextarea;
  _miniActionCmd       = cmd;
  _miniActionPreviewFn = previewFn;

  const keyboardCmds = { 'PRESS':'press', 'HOLD':'hold', 'RELEASE':'release' };
  if (keyboardCmds[cmd]) {
    _ifimgRedirectTarget = targetTextarea;
    openKeyCapture(keyboardCmds[cmd]);
    return;
  }

  const mouseCmdMap = {
    'CLICK':'click','DOUBLE_CLICK':'dblclick','RIGHT_CLICK':'rclick',
    'MOVE':'move','MOVE_HUMAN':'movehuman','SCROLL':'scroll','DRAG':'drag',
  };
  if (mouseCmdMap[cmd]) {
    _ifimgRedirectTarget = targetTextarea;
    openMouseCmdCoordPanel(mouseCmdMap[cmd]);
    return;
  }

  const title = document.getElementById('mini-action-title');
  const body  = document.getElementById('mini-action-body');
  title.textContent = _miniCmdLabel(cmd);
  body.innerHTML    = _miniActionFields(cmd);

  if (_MINI_FIND_CMDS.has(cmd)) _loadTemplatesInto('mini-tpl-sel');

  document.getElementById('mini-action-overlay').classList.remove('hidden');
  const first = body.querySelector('input, select, textarea');
  if (first) setTimeout(() => first.focus(), 60);
}

function _miniCmdLabel(cmd) {
  const map = {
    'CLICK':'Left Click','DOUBLE_CLICK':'Double Click','RIGHT_CLICK':'Right Click',
    'MOVE':'Move Mouse','MOVE_HUMAN':'Move (Natural)','SCROLL':'Scroll','DRAG':'Drag',
    'TYPE':'Type Text','PRESS':'Press Key','HOLD':'Hold Key',
    'RELEASE':'Release Key','HOTKEY':'Hotkey Combo',
    'FIND_CLICK':'Find & Click','FIND_DOUBLE_CLICK':'Find & Dbl-Click',
    'FIND_RIGHT_CLICK':'Find & R-Click','FIND_MOVE':'Find & Move',
    'FIND_HOLD':'Find & Hold','FIND_DRAG':'Find & Drag','CLICK_IMAGE':'Click Image','CLICK_RANDOM_OFFSET':'Click (Random Offset)','DOUBLE_CLICK_RANDOM_OFFSET':'Double-Click (Random Offset)','RIGHT_CLICK_RANDOM_OFFSET':'Right-Click (Random Offset)',
    'WAIT_IMAGE':'Wait for Image','WAIT_IMAGE_GONE':'Wait Image Gone',
    'WAIT':'Wait (pause)','REPEAT':'Repeat Block','LOOP':'Loop Forever',
    'TOAST':'Toast Message','STOP':'Stop Script','PAUSE_SCRIPT':'Pause Script',
    'LABEL':'Label','GOTO':'Goto Label'
  };
  return map[cmd] || cmd;
}

function _miniActionFields(cmd) {
  const lx = _lastX || 500, ly = _lastY || 300;

  if (_MINI_COORD_CMDS.has(cmd)) {
    return '<div class="mini-field"><label class="mini-label">Coordinates (X, Y)</label>' +
      '<div class="mini-row">' +
      '<label class="mini-hint">X</label><input type="number" id="mini-x" class="mini-input mini-xy" value="' + lx + '"/>' +
      '<label class="mini-hint">Y</label><input type="number" id="mini-y" class="mini-input mini-xy" value="' + ly + '"/>' +
      '</div><div class="mini-hint">Move the mouse cursor to capture coordinates automatically</div></div>';
  }
  if (cmd === 'DRAG') {
    return '<div class="mini-field"><label class="mini-label">From (X1, Y1)</label>' +
      '<div class="mini-row"><label class="mini-hint">X1</label><input type="number" id="mini-x1" class="mini-input mini-xy" value="' + lx + '"/>' +
      '<label class="mini-hint">Y1</label><input type="number" id="mini-y1" class="mini-input mini-xy" value="' + ly + '"/></div></div>' +
      '<div class="mini-field"><label class="mini-label">To (X2, Y2)</label>' +
      '<div class="mini-row"><label class="mini-hint">X2</label><input type="number" id="mini-x2" class="mini-input mini-xy" value="' + (lx+100) + '"/>' +
      '<label class="mini-hint">Y2</label><input type="number" id="mini-y2" class="mini-input mini-xy" value="' + ly + '"/></div></div>';
  }
  if (cmd === 'SCROLL') {
    return '<div class="mini-field"><label class="mini-label">Scroll amount</label>' +
      '<div class="mini-row"><input type="number" id="mini-scroll" class="mini-input" value="-3" style="width:90px"/>' +
      '<span class="mini-hint">Negative = up, Positive = down</span></div></div>';
  }
  if (cmd === 'TYPE') {
    return '<div class="mini-field"><label class="mini-label">Text to type</label>' +
      '<input type="text" id="mini-type-text" class="mini-input" placeholder="Hello world" autocomplete="off"/></div>';
  }
  if (cmd === 'PRESS' || cmd === 'HOLD' || cmd === 'RELEASE') {
    return '<div class="mini-field"><label class="mini-label">Key name</label>' +
      '<input type="text" id="mini-key" class="mini-input" placeholder="enter, space, ctrl, f1" autocomplete="off"/>' +
      '<div class="mini-hint">Examples: enter, space, tab, escape, f1, ctrl, shift, a, 1</div></div>';
  }
  if (cmd === 'HOTKEY') {
    return '<div class="mini-field"><label class="mini-label">Key combination</label>' +
      '<input type="text" id="mini-hotkey" class="mini-input" placeholder="ctrl+c, alt+f4" autocomplete="off"/>' +
      '<div class="mini-hint">Join keys with +: ctrl+c, ctrl+shift+s</div></div>';
  }
  if (_MINI_FIND_CMDS.has(cmd)) {
    const showTimeout = cmd === 'WAIT_IMAGE' || cmd === 'WAIT_IMAGE_GONE';
    let html = '<div class="mini-field"><label class="mini-label">Template Image</label>' +
      '<select id="mini-tpl-sel" class="mini-select"><option value="">— select template —</option></select></div>';
    if (!showTimeout) {
      html += '<div class="mini-field"><label class="mini-label">Confidence (0.5–1.0)</label>' +
        '<input type="number" id="mini-conf" class="mini-input" min="0.5" max="1.0" step="0.05" value="0.8" style="width:90px"/></div>';
    } else {
      html += '<div class="mini-field"><label class="mini-label">Timeout (seconds)</label>' +
        '<input type="number" id="mini-timeout-val" class="mini-input" value="30" min="1" style="width:90px"/></div>';
    }
    return html;
  }
  if (cmd === 'WAIT') {
    return '<div class="mini-field"><label class="mini-label">Seconds</label>' +
      '<div class="mini-row"><input type="number" id="mini-wait-sec" class="mini-input" value="1" min="0" step="0.1" style="width:100px"/>' +
      '<span class="mini-hint">Decimals OK, e.g. 0.5</span></div></div>';
  }
  if (cmd === 'REPEAT') {
    return '<div class="mini-field"><label class="mini-label">Repetitions</label>' +
      '<input type="number" id="mini-repeat-n" class="mini-input" value="5" min="1" style="width:90px"/>' +
      '<div class="mini-hint">Inserts REPEAT N … END — add actions inside manually</div></div>';
  }
  if (cmd === 'TOAST') {
    return '<div class="mini-field"><label class="mini-label">Message</label>' +
      '<input type="text" id="mini-toast-msg" class="mini-input" placeholder="Notification text" autocomplete="off"/></div>' +
      '<div class="mini-field"><label class="mini-label">Type</label>' +
      '<select id="mini-toast-type" class="mini-select" style="width:auto">' +
      '<option value="info">Info</option><option value="warn">Warning</option><option value="error">Error</option></select></div>';
  }
  if (cmd === 'STOP') {
    return '<div class="mini-hint" style="padding:0.6rem 0;font-size:1.2rem">Inserts a <b>STOP</b> command — halts the script immediately. No parameters needed.</div>';
  }
  if (cmd === 'LOOP') {
    return '<div class="mini-hint" style="padding:0.6rem 0;font-size:1.2rem">Inserts a <b>LOOP … END</b> block — loops forever until Stop is pressed. Add actions inside manually.</div>';
  }
  if (cmd === 'PAUSE_SCRIPT') {
    return '<div class="mini-hint" style="padding:0.6rem 0;font-size:1.2rem">Inserts a <b>PAUSE_SCRIPT</b> command — pauses execution until resumed. No parameters needed.</div>';
  }
  if (cmd === 'LABEL') {
    return '<div class="mini-field"><label class="mini-label">Label Name</label>' +
      '<input type="text" id="mini-label-name" class="mini-input" placeholder="e.g. start, loop_begin" autocomplete="off"/>' +
      '<div class="mini-hint">Use letters, numbers, underscores only. GOTO jumps here.</div></div>';
  }
  if (cmd === 'GOTO') {
    return '<div class="mini-field"><label class="mini-label">Jump to Label</label>' +
      '<input type="text" id="mini-goto-name" class="mini-input" placeholder="e.g. start, loop_begin" autocomplete="off"/>' +
      '<div class="mini-hint">Must match a LABEL name already in the script.</div></div>';
  }
  return '<div class="mini-hint">No parameters needed.</div>';
}

function _gv(id) { const el = document.getElementById(id); return el ? el.value : ''; }

function _buildMiniCommand(cmd) {
  if (_MINI_COORD_CMDS.has(cmd)) return cmd + ' ' + (_gv('mini-x')||500) + ' ' + (_gv('mini-y')||300);
  if (cmd === 'DRAG')   return 'DRAG ' + _gv('mini-x1') + ' ' + _gv('mini-y1') + ' ' + _gv('mini-x2') + ' ' + _gv('mini-y2');
  if (cmd === 'SCROLL') return 'SCROLL ' + (_gv('mini-scroll')||-3);
  if (cmd === 'TYPE')   { const t = _gv('mini-type-text').trim(); return t ? 'TYPE ' + t : null; }
  if (cmd === 'PRESS' || cmd === 'HOLD' || cmd === 'RELEASE') {
    const k = _gv('mini-key').trim(); return k ? cmd + ' ' + k : null;
  }
  if (cmd === 'HOTKEY') { const k = _gv('mini-hotkey').trim(); return k ? 'HOTKEY ' + k : null; }
  if (_MINI_FIND_CMDS.has(cmd)) {
    const tpl = _gv('mini-tpl-sel').replace(/\.png$/i, '');
    if (!tpl) return null;
    if (cmd === 'WAIT_IMAGE' || cmd === 'WAIT_IMAGE_GONE') {
      return cmd + ' ' + tpl + ' ' + (_gv('mini-timeout-val')||30);
    }
    const conf = _gv('mini-conf') || '0.8';
    // Use confidence= keyword if not default
    if (parseFloat(conf) !== 0.8) {
      return cmd + ' ' + tpl + ' confidence=' + conf;
    } else {
      return cmd + ' ' + tpl;
    }
  }
  if (cmd === 'WAIT')   return 'WAIT ' + (_gv('mini-wait-sec')||1);
  if (cmd === 'REPEAT') return 'REPEAT ' + (_gv('mini-repeat-n')||5) + '\n  # actions\nEND';
  if (cmd === 'TOAST') {
    const msg = _gv('mini-toast-msg').trim();
    return msg ? 'TOAST ' + msg + ' ' + (_gv('mini-toast-type')||'info') : null;
  }
  if (cmd === 'STOP')         return 'STOP';
  if (cmd === 'LOOP')         return 'LOOP\n  # actions\nEND';
  if (cmd === 'PAUSE_SCRIPT') return 'PAUSE_SCRIPT';
  if (cmd === 'LABEL') { const n = _gv('mini-label-name').trim(); return n ? 'LABEL ' + n : null; }
  if (cmd === 'GOTO')  { const n = _gv('mini-goto-name').trim();  return n ? 'GOTO '  + n : null; }
  return null;
}

function miniActionConfirm() {
  const line = _buildMiniCommand(_miniActionCmd);
  if (line === null) { toast('Please fill in the required field', 'warn'); return; }
  if (!_miniActionTarget) return;
  const cur = _miniActionTarget.value;
  _miniActionTarget.value = cur ? cur + '\n' + line : line;
  _miniActionTarget.dispatchEvent(new Event('input'));
  miniActionCancel();
}

function miniActionCancel() {
  document.getElementById('mini-action-overlay').classList.add('hidden');
}

function miniActionOverlayClick(e) {
  if (e.target.id === 'mini-action-overlay') miniActionCancel();
}

// ══════════════════════════════════════════════════════════
//  WAIT CONFIG MODAL
// ══════════════════════════════════════════════════════════

let _waitMode = 'fixed';

function openWaitConfig() {
  if (_guardRunning('insert a Wait')) return;
  // Reset to fixed mode
  setWaitMode('fixed');
  document.getElementById('wait-duration').value = '1';
  document.getElementById('wait-unit').value = 's';
  document.getElementById('wait-rand-min').value = '1.0';
  document.getElementById('wait-rand-max').value = '3.0';
  updateWaitRandomPreview();
  document.getElementById('wait-config-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('wait-duration').focus(), 50);
}

function setWaitMode(mode) {
  _waitMode = mode;
  document.getElementById('wait-mode-fixed').classList.toggle('active', mode === 'fixed');
  document.getElementById('wait-mode-random').classList.toggle('active', mode === 'random');
  document.getElementById('wait-fixed-fields').style.display  = mode === 'fixed'  ? '' : 'none';
  document.getElementById('wait-random-fields').style.display = mode === 'random' ? '' : 'none';
  if (mode === 'random') {
    setTimeout(() => document.getElementById('wait-rand-min').focus(), 50);
  } else {
    setTimeout(() => document.getElementById('wait-duration').focus(), 50);
  }
}

function updateWaitRandomPreview() {
  const mn = parseFloat(document.getElementById('wait-rand-min').value) || 1.0;
  const mx = parseFloat(document.getElementById('wait-rand-max').value) || 3.0;
  document.getElementById('wait-random-preview').textContent = `WAIT_RANDOM ${mn} ${mx}`;
}

function waitConfigConfirm() {
  if (_waitMode === 'random') {
    let mn = parseFloat(document.getElementById('wait-rand-min').value) || 1.0;
    let mx = parseFloat(document.getElementById('wait-rand-max').value) || 3.0;
    mn = Math.round(mn * 1000) / 1000;
    mx = Math.round(mx * 1000) / 1000;
    if (mn > mx) [mn, mx] = [mx, mn];
    insertToEditor(`WAIT_RANDOM ${mn} ${mx}`);
    toast(`Inserted: WAIT_RANDOM ${mn} ${mx}`, 'info');
  } else {
    let dur = parseFloat(document.getElementById('wait-duration').value) || 1;
    const unit = document.getElementById('wait-unit').value;
    if (unit === 'ms') dur = dur / 1000;
    dur = Math.round(dur * 1000) / 1000;
    insertToEditor(`WAIT ${dur}`);
    toast(`Inserted: WAIT ${dur}`, 'info');
  }
  waitConfigCancel();
}

function waitConfigCancel() {
  document.getElementById('wait-config-overlay').classList.add('hidden');
}

// ══════════════════════════════════════════════════════════
//  IMAGE ACTION MODAL
// ══════════════════════════════════════════════════════════

async function refreshImgActionTemplates() {
  await _loadTemplatesInto('img-action-template', 'IMAGE');
  imgActionPreview();
}

async function refreshOcrTemplateList() {
  await _loadTemplatesInto('img-ocr-template-sel', 'TEXT');
}

async function refreshColorTemplateList() {
  await _loadTemplatesInto('img-color-template-sel', 'COLOR');
}

function imgOcrTemplateSelected(name) {
  if (!name || !checkApi()) return;
  // Load the meta template and auto-fill text and confidence
  window.pywebview.api.get_meta_template(name).then(r => {
    if (r.status === 'ok' && r.meta) {
      const textEl = document.getElementById('img-text-input');
      const confEl = document.getElementById('img-ocr-conf');
      if (textEl && r.meta.text)       textEl.value = r.meta.text;
      if (confEl && r.meta.confidence) confEl.value = r.meta.confidence;
      imgActionPreview();
    }
  }).catch(() => {});
}

function imgColorTemplateSelected(name) {
  if (!name || !checkApi()) return;
  // Load the meta template and auto-fill color and tolerance
  window.pywebview.api.get_meta_template(name).then(r => {
    if (r.status === 'ok' && r.meta) {
      const colorEl  = document.getElementById('img-color-input');
      const pickerEl = document.getElementById('img-color-picker');
      const swatchEl = document.getElementById('img-color-swatch');
      const tolEl    = document.getElementById('img-tolerance');
      if (colorEl  && r.meta.color)     { colorEl.value  = r.meta.color; }
      if (pickerEl && r.meta.color)     { pickerEl.value = r.meta.color; }
      if (swatchEl && r.meta.color)     { swatchEl.style.background = r.meta.color; }
      if (tolEl    && r.meta.tolerance) { tolEl.value    = r.meta.tolerance; }
      imgActionPreview();
    }
  }).catch(() => {});
}

let _imgActiveAction = 'FIND_CLICK';

const _LEGACY_ACTIONS = new Set(['CLICK_IMAGE','DOUBLE_CLICK_IMAGE','RIGHT_CLICK_IMAGE','CLICK_RANDOM_OFFSET','DOUBLE_CLICK_RANDOM_OFFSET','RIGHT_CLICK_RANDOM_OFFSET',
                                  'WAIT_IMAGE','WAIT_IMAGE_GONE','IF_IMAGE','WHILE_IMAGE']);
const _FIND_ACTIONS   = new Set(['FIND_CLICK','FIND_DOUBLE_CLICK','FIND_RIGHT_CLICK',
                                  'FIND_MOVE','FIND_HOLD','FIND_DRAG']);

function openImgActionModal(defaultAction) {
  if (_guardRunning('open Image Action builder')) return;
  _imgActiveAction = defaultAction || 'FIND_CLICK';
  document.getElementById('img-confidence').value = '0.8';
  document.getElementById('img-offset-x').value   = '0';
  document.getElementById('img-offset-y').value   = '0';
  document.getElementById('img-timeout').value     = '30';
  document.getElementById('img-drag-dest-x').value = '0';
  document.getElementById('img-drag-dest-y').value = '0';
  // Arrival fields (NAVIGATE_TO_IMAGE) — sync defaults from Movement AI tab
  const arEl   = document.getElementById('img-arrival-region');
  const arhEl  = document.getElementById('img-arrival-region-h');
  const acEl   = document.getElementById('img-arrival-confidence');
  const mtEl   = document.getElementById('img-miss-tolerance');
  const movAr  = parseInt(document.getElementById('movement-arrival-region')?.value)   || 200;
  const movArh = parseInt(document.getElementById('movement-arrival-region-h')?.value) || movAr;
  const movAc  = parseFloat(document.getElementById('movement-arrival-confidence')?.value) || 0.85;
  if (arEl)  arEl.value  = String(movAr);
  if (arhEl) arhEl.value = String(movArh);
  const arhSlider = document.getElementById('img-arrival-region-h-slider');
  if (arhSlider) arhSlider.value = String(movArh);
  if (acEl) acEl.value = movAc.toFixed(2);
  if (mtEl) mtEl.value = '3';

  document.querySelectorAll('#img-action-tabs .img-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.action === _imgActiveAction);
  });
  document.querySelectorAll('.anchor-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.anchor-btn[data-anchor="center"]').classList.add('active');
  document.getElementById('anchor-selected-label').textContent = 'center';

  document.getElementById('img-action-overlay').classList.remove('hidden');
  // Load the correct template list for the current detection type
  if (_detectionType === 'IMAGE') refreshImgActionTemplates();
  else if (_detectionType === 'TEXT')  refreshOcrTemplateList();
  else if (_detectionType === 'COLOR') refreshColorTemplateList();
  _updateImgActionVisibility();
  imgActionPreview();
}

function setImgTab(btn) {
  // Clear active from whichever set this button belongs to
  const parentTabs = btn.closest('.img-action-tabs');
  if (parentTabs) parentTabs.querySelectorAll('.img-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _imgActiveAction = btn.dataset.action;
  _updateImgActionVisibility();
  imgActionPreview();
}

function setAnchor(btn) {
  document.querySelectorAll('.anchor-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('anchor-selected-label').textContent = btn.dataset.anchor;
  imgActionPreview();
}

function _getAnchor() {
  return document.querySelector('.anchor-btn.active')?.dataset.anchor || 'center';
}

function _updateImgActionVisibility() {
  const act     = _imgActiveAction;
  const det     = _detectionType;
  const isFind  = _FIND_ACTIONS.has(act);
  const isDrag  = act === 'FIND_DRAG' || act === 'DRAG';
  const isWait  = act === 'WAIT_IMAGE' || act === 'WAIT_IMAGE_GONE';
  const isNav   = act === 'NAVIGATE_TO_IMAGE';
  // TEXT and COLOR actions always support anchor+offset (they find a point/box)
  const isDetectionAction = det === 'TEXT' || det === 'COLOR';

  document.getElementById('img-anchor-row').style.display     = (isFind || isDetectionAction) && !isNav ? '' : 'none';
  document.getElementById('img-offset-row').style.display     = ((isFind && !isDrag) || isNav || isDetectionAction) ? '' : 'none';
  document.getElementById('img-drag-dest-row').style.display  = isDrag ? '' : 'none';
  document.getElementById('img-timeout-row').style.display    = isWait ? '' : 'none';
  document.getElementById('img-confidence-row').style.display = (isWait || det !== 'IMAGE') ? 'none' : '';
  // Arrival region rows — only for NAVIGATE_TO_IMAGE
  const navArrivalRow = document.getElementById('img-arrival-row');
  if (navArrivalRow) navArrivalRow.style.display = isNav ? '' : 'none';
}

function imgActionPreview() {
  const act     = _imgActiveAction;
  const det = _detectionType;
  let preview = '';

  if (det === 'IMAGE') {
    
    const tpl     = (document.getElementById('img-action-template').value || 'template.png').replace(/\.png$/i, '');
    const conf    = document.getElementById('img-confidence').value || '0.8';
    const timeout = document.getElementById('img-timeout').value || '30';
    const anchor  = _getAnchor();
    const oxRaw = document.getElementById('img-offset-x')?.value;
    const oyRaw = document.getElementById('img-offset-y')?.value;
    const ox = oxRaw ? parseInt(oxRaw) : 0;
    const oy = oyRaw ? parseInt(oyRaw) : 0;
    const dx = document.getElementById('img-drag-dest-x')?.value || '0';
    const dy = document.getElementById('img-drag-dest-y')?.value || '0';
    let snippet = '';

    if (_FIND_ACTIONS.has(act)) {
      let parts = [act, tpl];
      if (act === 'FIND_DRAG') {
        parts = [act, tpl, dx, dy];
        if (anchor !== 'center') parts.push(anchor);
        if (ox !== 0) parts.push(`offsetX=${ox}`);
        if (oy !== 0) parts.push(`offsetY=${oy}`);
        if (parseFloat(conf) !== 0.8) parts.push(`confidence=${conf}`);
      } else {
        if (anchor !== 'center') parts.push(anchor);
        if (ox !== 0) parts.push(`offsetX=${ox}`);
        if (oy !== 0) parts.push(`offsetY=${oy}`);
        if (parseFloat(conf) !== 0.8) parts.push(`confidence=${conf}`);
      }
      snippet = parts.join(' ');
      } else if (act === 'WAIT_IMAGE' || act === 'WAIT_IMAGE_GONE') {
        snippet = `${act} ${tpl} ${timeout}`;
      } else if (act === 'IF_IMAGE') {
        snippet = `IF_IMAGE ${tpl} ${conf}\n  # actions here\nELSE\n  # else actions\nEND`;
      } else if (act === 'WHILE_IMAGE') {
        snippet = `WHILE_IMAGE ${tpl}\n  # loop actions\nEND`;
      } else if (act === 'NAVIGATE_TO_IMAGE') {
        let parts = [act, tpl];
        if (parseFloat(conf) !== 0.8) parts.push(`confidence=${conf}`);
        if (ox !== 0) parts.push(`offsetX=${ox}`);
        if (oy !== 0) parts.push(`offsetY=${oy}`);
        const ar  = parseInt(document.getElementById('img-arrival-region')?.value   || '200');
        const arh = parseInt(document.getElementById('img-arrival-region-h')?.value || String(ar));
        const ac  = parseFloat(document.getElementById('img-arrival-confidence')?.value || '0.85');
        const mt  = parseInt(document.getElementById('img-miss-tolerance')?.value   || '3');
        if (ar  !== 200)  parts.push(`arrival_region=${ar}`);
        if (arh !== ar)   parts.push(`arrival_region_h=${arh}`);
        if (ac  !== 0.85) parts.push(`arrival_confidence=${ac}`);
        if (mt  !== 3)    parts.push(`miss_tolerance=${mt}`);
        // Update description labels
        const lbl1 = document.getElementById('img-arrival-region-label');
        const lbl2 = document.getElementById('img-arrival-region-label2');
        const lbl3 = document.getElementById('img-arrival-conf-label');
        if (lbl1) lbl1.textContent = ar;
        if (lbl2) lbl2.textContent = arh;
        if (lbl3) lbl3.textContent = Math.round(ac * 100) + '%';
        snippet = parts.join(' ');
      } else {
          snippet = `${act} ${tpl} ${conf}`;
      }
      preview = snippet;

    } else if (det === 'TEXT') {
        const text = document.getElementById('img-text-input').value || 'text';
        const conf = document.getElementById('img-ocr-conf').value || 80;
        const anchor = _getAnchor();
        const ox = document.getElementById('img-offset-x').value || 0;
        const oy = document.getElementById('img-offset-y').value || 0;
        const region = window._detectRegion ? `${window._detectRegion.x} ${window._detectRegion.y} ${window._detectRegion.w} ${window._detectRegion.h}` : '';
        let cmd = `TEXT_${act} "${text}" confidence=${conf}`;
        if (anchor !== 'center') cmd += ` anchor=${anchor}`;
        if (ox != 0) cmd += ` offsetX=${ox}`;
        if (oy != 0) cmd += ` offsetY=${oy}`;
        if (region) cmd += ` region=${region}`;
        if (act === 'DRAG') {
            const destX = document.getElementById('img-drag-dest-x').value || 0;
            const destY = document.getElementById('img-drag-dest-y').value || 0;
            cmd += ` ${destX} ${destY}`;
        }
        preview = cmd;
    } else if (det === 'COLOR') {
        const color = document.getElementById('img-color-input').value || '#FF0000';
        const tol = document.getElementById('img-tolerance').value || 30;
        const anchor = _getAnchor();
        const ox = document.getElementById('img-offset-x').value || 0;
        const oy = document.getElementById('img-offset-y').value || 0;
        const region = window._detectRegion ? `${window._detectRegion.x} ${window._detectRegion.y} ${window._detectRegion.w} ${window._detectRegion.h}` : '';
        let cmd = `COLOR_${act} ${color} tolerance=${tol}`;
        if (anchor !== 'center') cmd += ` anchor=${anchor}`;
        if (ox != 0) cmd += ` offsetX=${ox}`;
        if (oy != 0) cmd += ` offsetY=${oy}`;
        if (region) cmd += ` region=${region}`;
        if (act === 'DRAG') {
            const destX = document.getElementById('img-drag-dest-x').value || 0;
            const destY = document.getElementById('img-drag-dest-y').value || 0;
            cmd += ` ${destX} ${destY}`;
        }
        preview = cmd;
    }
    document.getElementById('img-action-preview').textContent = preview;
}

async function captureDragDest() {
  if (!checkApi()) return;
  toast('Right-click or F2 to capture drag destination', 'info');
  try {
    await withLoading(window.pywebview.api.start_coord_capture());
    const poll = setInterval(async () => {
      const r = await window.pywebview.api.get_captured_coords();
      if (r && r.coords && r.coords.length > 0) {
        clearInterval(poll);
        await window.pywebview.api.stop_coord_capture();
        const c = r.coords[r.coords.length - 1];
        document.getElementById('img-drag-dest-x').value = c.x;
        document.getElementById('img-drag-dest-y').value = c.y;
        imgActionPreview();
        toast(`Destination captured: ${c.x}, ${c.y}`, 'info');
      }
    }, 200);
    setTimeout(() => clearInterval(poll), 30000);
  } catch(e) {}
}

function imgActionConfirm() {
  const act = _imgActiveAction;
  const det = _detectionType;
  let snippet = '';

  if (det === 'IMAGE') {
    const tplRaw = document.getElementById('img-action-template').value;
    if (!tplRaw) { toast('Select a template first', 'warn'); return; }
    const tpl = tplRaw.replace(/\.png$/i, '');

    const conf    = document.getElementById('img-confidence').value || '0.8';
    const timeout = document.getElementById('img-timeout').value || '30';
    const anchor  = _getAnchor();
    const oxRaw = document.getElementById('img-offset-x')?.value;
    const oyRaw = document.getElementById('img-offset-y')?.value;
    const ox = oxRaw ? parseInt(oxRaw) : 0;
    const oy = oyRaw ? parseInt(oyRaw) : 0;
    const dx = document.getElementById('img-drag-dest-x')?.value || '0';
    const dy = document.getElementById('img-drag-dest-y')?.value || '0';

        if (_FIND_ACTIONS.has(act)) {
      let parts = [act, tpl];
      if (act === 'FIND_DRAG') {
        parts = [act, tpl, dx, dy];
        if (anchor !== 'center') parts.push(anchor);
        if (ox !== 0) parts.push(`offsetX=${ox}`);
        if (oy !== 0) parts.push(`offsetY=${oy}`);
        if (parseFloat(conf) !== 0.8) parts.push(`confidence=${conf}`);
      } else {
        if (anchor !== 'center') parts.push(anchor);
        if (ox !== 0) parts.push(`offsetX=${ox}`);
        if (oy !== 0) parts.push(`offsetY=${oy}`);
        if (parseFloat(conf) !== 0.8) parts.push(`confidence=${conf}`);
      }
      snippet = parts.join(' ');
    } else if (act === 'WAIT_IMAGE' || act === 'WAIT_IMAGE_GONE') {
      snippet = `${act} ${tpl} ${timeout}`;
    } else if (act === 'IF_IMAGE') {
      snippet = `IF_IMAGE ${tpl} ${conf}\n  # actions here\nELSE\n  # else actions\nEND`;
    } else if (act === 'WHILE_IMAGE') {
      snippet = `WHILE_IMAGE ${tpl}\n  # loop actions\nEND`;
    } else if (act === 'NAVIGATE_TO_IMAGE') {
      let parts = [act, tpl];
      if (parseFloat(conf) !== 0.8) parts.push(`confidence=${conf}`);
      if (ox !== 0) parts.push(`offsetX=${ox}`);
      if (oy !== 0) parts.push(`offsetY=${oy}`);
      const ar  = parseInt(document.getElementById('img-arrival-region')?.value   || '200');
      const arh = parseInt(document.getElementById('img-arrival-region-h')?.value || String(ar));
      const ac  = parseFloat(document.getElementById('img-arrival-confidence')?.value || '0.85');
      const mt  = parseInt(document.getElementById('img-miss-tolerance')?.value   || '3');
      if (ar  !== 200)  parts.push(`arrival_region=${ar}`);
      if (arh !== ar)   parts.push(`arrival_region_h=${arh}`);
      if (ac  !== 0.85) parts.push(`arrival_confidence=${ac}`);
      if (mt  !== 3)    parts.push(`miss_tolerance=${mt}`);
      snippet = parts.join(' ');
    } else {
        snippet = `${act} ${tpl} ${conf}`;
    }
  } else if (det === 'TEXT') {
        const text = document.getElementById('img-text-input').value || 'text';
        const conf = document.getElementById('img-ocr-conf').value || 80;
        const anchor = _getAnchor();
        const ox = document.getElementById('img-offset-x').value || 0;
        const oy = document.getElementById('img-offset-y').value || 0;
        const region = window._detectRegion ? `${window._detectRegion.x} ${window._detectRegion.y} ${window._detectRegion.w} ${window._detectRegion.h}` : '';
        let cmd = `TEXT_${act} "${text}" confidence=${conf}`;
        if (anchor !== 'center') cmd += ` anchor=${anchor}`;
        if (ox != 0) cmd += ` offsetX=${ox}`;
        if (oy != 0) cmd += ` offsetY=${oy}`;
        if (region) cmd += ` region=${region}`;
        if (act === 'DRAG') {
            const destX = document.getElementById('img-drag-dest-x').value || 0;
            const destY = document.getElementById('img-drag-dest-y').value || 0;
            cmd += ` ${destX} ${destY}`;
        }
        snippet = cmd;
    } else if (det === 'COLOR') {
        const color = document.getElementById('img-color-input').value || '#FF0000';
        const tol = document.getElementById('img-tolerance').value || 30;
        const anchor = _getAnchor();
        const ox = document.getElementById('img-offset-x').value || 0;
        const oy = document.getElementById('img-offset-y').value || 0;
        const region = window._detectRegion ? `${window._detectRegion.x} ${window._detectRegion.y} ${window._detectRegion.w} ${window._detectRegion.h}` : '';
        let cmd = `COLOR_${act} ${color} tolerance=${tol}`;
        if (anchor !== 'center') cmd += ` anchor=${anchor}`;
        if (ox != 0) cmd += ` offsetX=${ox}`;
        if (oy != 0) cmd += ` offsetY=${oy}`;
        if (region) cmd += ` region=${region}`;
        if (act === 'DRAG') {
            const destX = document.getElementById('img-drag-dest-x').value || 0;
            const destY = document.getElementById('img-drag-dest-y').value || 0;
            cmd += ` ${destX} ${destY}`;
        }
        snippet = cmd;
    }
    if (!snippet) return;
    insertToEditor(snippet);
    toast(`Inserted: ${snippet.split('\n')[0]}`, 'info');
    imgActionCancel();
}

function imgActionCancel() {
  document.getElementById('img-action-overlay').classList.add('hidden');
}

// ══════════════════════════════════════════════════════════
//  TOAST / LABEL / GOTO CONFIG MODALS
// ══════════════════════════════════════════════════════════

function openToastConfig() {
  if (_guardRunning('insert a Toast')) return;
  document.getElementById('toast-msg-input').value = '';
  document.querySelector('input[name="toast-kind"][value="info"]').checked = true;
  document.getElementById('toast-config-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('toast-msg-input').focus(), 50);

  const update = () => {
    const msg  = document.getElementById('toast-msg-input').value || 'Your message';
    const kind = document.querySelector('input[name="toast-kind"]:checked')?.value || 'info';
    document.getElementById('toast-preview').textContent = `TOAST ${msg} ${kind}`;
  };
  document.getElementById('toast-msg-input').oninput = update;
  document.querySelectorAll('input[name="toast-kind"]').forEach(r => r.onchange = update);
}

function toastConfigConfirm() {
  const msg  = document.getElementById('toast-msg-input').value.trim() || 'Script message';
  const kind = document.querySelector('input[name="toast-kind"]:checked')?.value || 'info';
  insertToEditor(`TOAST ${msg} ${kind}`);
  toast('Inserted: TOAST', 'info');
  document.getElementById('toast-config-overlay').classList.add('hidden');
}

function openLabelConfig() {
  if (_guardRunning('insert a Label')) return;
  document.getElementById('label-name-input').value = '';
  document.getElementById('label-config-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('label-name-input').focus(), 50);
}

function labelConfigConfirm() {
  const name = document.getElementById('label-name-input').value.trim().replace(/\s+/g,'_');
  if (!name) { toast('Enter a label name', 'warn'); return; }
  insertToEditor(`LABEL ${name}`);
  toast(`Inserted: LABEL ${name}`, 'info');
  document.getElementById('label-config-overlay').classList.add('hidden');
}

function openGotoConfig() {
  if (_guardRunning('insert a Goto')) return;
  document.getElementById('goto-label-input').value = '';
  const editor = document.getElementById('script-editor');
  const labels = [];
  editor.value.split('\n').forEach(line => {
    const parts = line.trim().split(/\s+/);
    if (parts[0]?.toUpperCase() === 'LABEL' && parts[1]) labels.push(parts[1]);
  });
  const el = document.getElementById('goto-available-labels');
  if (labels.length > 0) {
    el.innerHTML = labels.map(l =>
      `<span class="goto-label-chip" onclick="document.getElementById('goto-label-input').value='${l}'">${l}</span>`
    ).join('');
  } else {
    el.textContent = '— no LABEL commands found in script —';
  }
  document.getElementById('goto-config-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('goto-label-input').focus(), 50);
}

function gotoConfigConfirm() {
  const name = document.getElementById('goto-label-input').value.trim().replace(/\s+/g,'_');
  if (!name) { toast('Enter a label name', 'warn'); return; }
  insertToEditor(`GOTO ${name}`);
  toast(`Inserted: GOTO ${name}`, 'info');
  document.getElementById('goto-config-overlay').classList.add('hidden');
}

// ── Enter key in modals ────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (!document.getElementById('wait-config-overlay').classList.contains('hidden')) {
      e.preventDefault(); waitConfigConfirm(); return;
    }
    if (!document.getElementById('img-action-overlay').classList.contains('hidden')) {
      e.preventDefault(); imgActionConfirm(); return;
    }
    if (!document.getElementById('goto-config-overlay').classList.contains('hidden')) {
      e.preventDefault(); gotoConfigConfirm(); return;
    }
    if (!document.getElementById('toast-config-overlay').classList.contains('hidden')) {
      e.preventDefault(); toastConfigConfirm(); return;
    }
    if (!document.getElementById('label-config-overlay').classList.contains('hidden')) {
      e.preventDefault(); labelConfigConfirm(); return;
    }
  }
  if (e.key === 'Escape') {
    waitConfigCancel(); imgActionCancel();
    ifImageCancel(); whileImageCancel();
    miniActionCancel(); lineEditCancel();
  }
}, { capture: false });

// ── VARIABLE MODAL ──────────────────────────────────────────
function openSetVariableDialog() {
    document.getElementById('var-name-input').value = '';
    document.getElementById('var-expr-input').value = '';
    updateVarPreview();
    document.getElementById('variable-config-overlay').classList.remove('hidden');
    setTimeout(() => document.getElementById('var-name-input').focus(), 50);
}

function closeVariableDialog() {
    document.getElementById('variable-config-overlay').classList.add('hidden');
}

function updateVarPreview() {
    const name = document.getElementById('var-name-input').value.trim();
    const expr = document.getElementById('var-expr-input').value.trim();
    const preview = name && expr ? `SET ${name} = ${expr}` : 'SET variable = expression';
    document.getElementById('var-preview').textContent = preview;
}

function insertVariable() {
    const name = document.getElementById('var-name-input').value.trim();
    const expr = document.getElementById('var-expr-input').value.trim();
    if (!name) { toast('Enter a variable name', 'warn'); return; }
    if (!expr) { toast('Enter an expression', 'warn'); return; }
    // Basic validation: variable name should be alphanumeric + underscore
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        toast('Invalid variable name – use letters, numbers, underscore', 'warn');
        return;
    }
    insertToEditor(`SET ${name} = ${expr}`);
    closeVariableDialog();
}

// Attach input listeners for live preview
document.addEventListener('DOMContentLoaded', () => {
    const nameInput = document.getElementById('var-name-input');
    const exprInput = document.getElementById('var-expr-input');
    if (nameInput) nameInput.addEventListener('input', updateVarPreview);
    if (exprInput) exprInput.addEventListener('input', updateVarPreview);
});

let _detectionType = 'IMAGE'; // 'IMAGE', 'TEXT', 'COLOR'

function setDetectionType(btn) {
  document.querySelectorAll('#img-detection-tabs .img-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _detectionType = btn.dataset.detection;
  updateDetectionTypeUI();
  imgActionPreview();
}

function updateDetectionTypeUI() {
  const isImage = _detectionType === 'IMAGE';
  const isText  = _detectionType === 'TEXT';
  const isColor = _detectionType === 'COLOR';

  // Show/hide input rows
  document.getElementById('img-template-row').classList.toggle('hidden', !isImage);
  document.getElementById('img-text-row').classList.toggle('hidden', !isText);
  document.getElementById('img-color-row').classList.toggle('hidden', !isColor);
  document.getElementById('img-ocr-conf-row').classList.toggle('hidden', !isText);
  document.getElementById('img-tolerance-row').classList.toggle('hidden', !isColor);
  document.getElementById('img-confidence-row').style.display = isImage ? '' : 'none';

  // Switch action tab set
  document.getElementById('img-action-tabs-image').classList.toggle('hidden', !isImage);
  document.getElementById('img-action-tabs-text').classList.toggle('hidden',  !isText);
  document.getElementById('img-action-tabs-color').classList.toggle('hidden', !isColor);

  // Reset active action tab to Click for the visible set
  const activeTabSet = isImage ? 'img-action-tabs-image'
                     : isText  ? 'img-action-tabs-text'
                     :           'img-action-tabs-color';
  const tabs = document.querySelectorAll(`#${activeTabSet} .img-tab`);
  tabs.forEach(t => t.classList.remove('active'));
  if (tabs[0]) {
    tabs[0].classList.add('active');
    _imgActiveAction = tabs[0].dataset.action;
  }

  // Load the right template list for the active detection type
  if (isText)  refreshOcrTemplateList();
  if (isColor) refreshColorTemplateList();

  _updateImgActionVisibility();
}

function openImageAction(defaultAction) {
    _detectionType = 'IMAGE';
    document.querySelector('#img-detection-tabs .img-tab[data-detection="IMAGE"]').click(); // sets active
    openImgActionModal(defaultAction);
}

function openTextAction(defaultAction) {
  _detectionType = 'TEXT';
  // Set the TEXT detection tab active (without triggering click cascade)
  document.querySelectorAll('#img-detection-tabs .img-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.detection === 'TEXT'));
  // Map TEXT action name: bare 'CLICK' -> used directly in TEXT_ commands
  _imgActiveAction = defaultAction || 'CLICK';
  openImgActionModal(defaultAction || 'CLICK');
}

function openColorAction(defaultAction) {
  _detectionType = 'COLOR';
  document.querySelectorAll('#img-detection-tabs .img-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.detection === 'COLOR'));
  _imgActiveAction = defaultAction || 'CLICK';
  openImgActionModal(defaultAction || 'CLICK');
}

function openImgAction(defaultAction) {
    openImageAction(defaultAction);
}
// ══════════════════════════════════════════════════════════
//  COMMAND BUILDER DROPDOWN PILLS
// ══════════════════════════════════════════════════════════

let _openDropId = null;

function toggleBuilderDropbar() {
  const toolbar = document.getElementById('builder-toolbar');
  const icon    = document.getElementById('bld-toggle-icon');
  if (!toolbar) return;
  const isCollapsed = toolbar.classList.toggle('dropbar-collapsed');
  // Persist preference so it survives tab switches
  try { localStorage.setItem('bld-dropbar-collapsed', isCollapsed ? '1' : '0'); } catch(e) {}
  // Rotate the chevron icon
  if (icon) icon.style.transform = isCollapsed ? 'rotate(-90deg)' : '';
  // Update button title for discoverability
  const btn = document.getElementById('bld-toolbar-toggle');
  if (btn) btn.title = isCollapsed ? 'Show Insert categories' : 'Hide Insert categories';
}

// Restore collapsed state on page load
(function restoreDropbarState() {
  try {
    if (localStorage.getItem('bld-dropbar-collapsed') === '1') {
      const toolbar = document.getElementById('builder-toolbar');
      const icon    = document.getElementById('bld-toggle-icon');
      const btn     = document.getElementById('bld-toolbar-toggle');
      if (toolbar) toolbar.classList.add('dropbar-collapsed');
      if (icon)    icon.style.transform = 'rotate(-90deg)';
      if (btn)     btn.title = 'Show Insert categories';
    }
  } catch(e) {}
})();

function toggleBuilderDrop(id) {
  const panel = document.getElementById('bld-drop-panel-' + id);
  const pill  = panel && panel.previousElementSibling;
  if (!panel) return;

  // Close already-open one
  if (_openDropId && _openDropId !== id) {
    closeBuilderDrop();
  }

  const isOpen = panel.classList.contains('open');
  if (isOpen) {
    closeBuilderDrop();
  } else {
    panel.classList.add('open');
    if (pill) pill.classList.add('open');
    _openDropId = id;

    // Close when clicking outside
    setTimeout(() => {
      document.addEventListener('click', _builderDropOutside, { capture: true, once: true });
    }, 0);
  }
}

function closeBuilderDrop() {
  if (_openDropId) {
    const panel = document.getElementById('bld-drop-panel-' + _openDropId);
    if (panel) {
      panel.classList.remove('open');
      const pill = panel.previousElementSibling;
      if (pill) pill.classList.remove('open');
    }
    _openDropId = null;
  }
}

function _builderDropOutside(e) {
  // If click is inside any dropdown, keep it open and re-attach listener
  if (e.target.closest('.bld-dropdown')) {
    setTimeout(() => {
      document.addEventListener('click', _builderDropOutside, { capture: true, once: true });
    }, 0);
    return;
  }
  closeBuilderDrop();
}

// Close dropdowns on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && _openDropId) closeBuilderDrop();
});
