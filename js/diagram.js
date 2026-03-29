/**
 * diagram.js — Visual Flowchart Diagram View (Blockly-inspired redesign)
 *
 * - Blockly-style colored block headers with white text
 * - Uses existing SVG icon sprites (#i-*) instead of emojis
 * - Instant delete/edit sync fix — diagram re-renders immediately
 * - C-shaped containers for loops & IF blocks
 * - Notch-style connectors between blocks
 */

// ══════════════════════════════════════════════════════════
//  INJECT STYLES
// ══════════════════════════════════════════════════════════

(function _injectDiagramStyles() {
  if (document.getElementById('dg-styles')) return;
  const s = document.createElement('style');
  s.id = 'dg-styles';
  s.textContent = `
/* ── Panel ─────────────────────────────────────────────── */
#dg-panel {
  display: none; flex: 1; min-height: 0;
  overflow-y: auto; overflow-x: hidden;
  background: var(--color-bg);
  padding: 1.2rem 1rem 4rem; position: relative;
}
#dg-panel.dg-active { display: flex; flex-direction: column; align-items: center; }

/* ── Toggle button ─────────────────────────────────────── */
#dg-toggle-btn {
  display: inline-flex; align-items: center; gap: 0.4rem;
  padding: 0.25rem 0.8rem; border-radius: 2rem;
  border: 1.5px solid var(--color-border-light);
  background: var(--color-panel-bg); color: var(--color-text);
  font-size: 0.92rem; cursor: pointer; font-weight: 600;
  transition: all 0.18s; margin-left: auto;
}
#dg-toggle-btn .icon { width: 1.05em; height: 1.05em; }
#dg-toggle-btn:hover { border-color: var(--color-teal); color: var(--color-teal); }
#dg-toggle-btn.active {
  background: var(--color-teal); color: #fff;
  border-color: var(--color-teal); box-shadow: 0 2px 8px rgba(78,141,156,0.3);
}

/* ── Empty state ───────────────────────────────────────── */
.dg-empty {
  display: flex; flex-direction: column; align-items: center;
  gap: 1rem; padding: 4rem 2rem; color: var(--color-teal); opacity: 0.7;
  font-size: 1.1rem; text-align: center;
}
.dg-empty .icon { width: 4rem; height: 4rem; opacity: 0.35; }
.dg-empty-hint { font-size: 0.95rem; opacity: 0.6; }

/* ── Canvas (centred column) ───────────────────────────── */
.dg-canvas {
  display: flex; flex-direction: column; align-items: center;
  width: 100%; max-width: 620px;
}

/* ── Connector between blocks ──────────────────────────── */
.dg-connector {
  display: flex; flex-direction: column; align-items: center; width: 100%;
}
.dg-connector-line {
  width: 2px; height: 13px; background: var(--color-border-light); flex-shrink: 0;
}
.dg-connector-dot {
  width: 9px; height: 9px; border-radius: 50%;
  background: var(--color-border-light);
  border: 2px solid var(--color-bg); flex-shrink: 0;
}

/* ── Add zone (+ button between nodes) ─────────────────── */
.dg-add-zone {
  display: flex; flex-direction: column; align-items: center; width: 100%;
}
.dg-add-zone-line {
  width: 2px; height: 9px; background: var(--color-border-light);
}
.dg-add-btn {
  display: flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; border-radius: 50%;
  border: 2px dashed var(--color-border-light);
  background: var(--color-panel-bg); color: var(--color-teal);
  cursor: pointer; transition: all 0.15s; flex-shrink: 0;
  box-shadow: 0 1px 4px rgba(0,0,0,0.06);
}
.dg-add-btn .icon { width: 0.8em; height: 0.8em; }
.dg-add-btn:hover {
  border-color: var(--color-teal); background: var(--color-teal); color: #fff;
  transform: scale(1.18); box-shadow: 0 2px 10px rgba(78,141,156,0.4);
}

/* ══════════════════════════════════════════════════════════
   BLOCKLY-STYLE BLOCK CARDS
══════════════════════════════════════════════════════════ */

.dg-blk {
  width: 100%; border-radius: 10px; overflow: hidden;
  box-shadow: 0 3px 12px rgba(0,0,0,0.13), 0 1px 4px rgba(0,0,0,0.07);
  transition: box-shadow 0.15s, transform 0.12s;
  position: relative;
}
.dg-blk:hover {
  box-shadow: 0 6px 20px rgba(0,0,0,0.17), 0 2px 6px rgba(0,0,0,0.1);
  transform: translateY(-1px);
}

/* Block header — solid accent colour, white text */
.dg-blk-head {
  display: flex; align-items: center; gap: 0.6rem;
  padding: 0.6rem 0.7rem 0.6rem 0.85rem;
  background: var(--dg-accent, var(--color-teal));
  color: #fff; min-height: 44px;
}
.dg-blk-head .icon {
  width: 1.2em; height: 1.2em; flex-shrink: 0;
  color: rgba(255,255,255,0.9);
}
.dg-blk-head-text { flex: 1; min-width: 0; }
.dg-blk-label {
  font-size: 0.7rem; font-weight: 800; letter-spacing: 0.07em;
  text-transform: uppercase; color: rgba(255,255,255,0.65); line-height: 1;
}
.dg-blk-value {
  font-size: 0.97rem; font-weight: 600; color: #fff;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  margin-top: 0.1rem; line-height: 1.25;
}
.dg-blk-value-only {
  font-size: 1rem; font-weight: 700; color: #fff;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.3;
}

/* Edit / delete action buttons on hover */
.dg-blk-acts {
  display: flex; gap: 0.2rem; flex-shrink: 0;
  opacity: 0; transition: opacity 0.15s;
}
.dg-blk:hover .dg-blk-acts,
.dg-con-head .dg-blk-acts { opacity: 1; }
.dg-act {
  background: rgba(255,255,255,0.18);
  border: 1px solid rgba(255,255,255,0.25);
  border-radius: 6px; cursor: pointer;
  padding: 0.22rem 0.3rem;
  display: flex; align-items: center; justify-content: center;
  transition: background 0.12s; color: #fff;
}
.dg-act .icon { width: 0.85em; height: 0.85em; }
.dg-act:hover { background: rgba(255,255,255,0.35); border-color: rgba(255,255,255,0.55); }
.dg-act.del:hover { background: rgba(200,30,30,0.7); border-color: rgba(255,80,80,0.7); }

/* Comment card — dashed outline, transparent */
.dg-blk.dg-comment-blk {
  box-shadow: none;
  border: 2px dashed var(--color-border-light);
  background: transparent;
}
.dg-blk.dg-comment-blk .dg-blk-head {
  background: transparent; color: var(--color-text);
}
.dg-blk.dg-comment-blk .dg-blk-head .icon { color: var(--color-text); opacity: 0.4; }
.dg-blk.dg-comment-blk .dg-blk-label  { color: var(--color-text); opacity: 0.45; }
.dg-blk.dg-comment-blk .dg-blk-value  { color: var(--color-text); opacity: 0.65; font-style: italic; font-weight: 400; }
.dg-blk.dg-comment-blk .dg-act        { background: rgba(0,0,0,0.05); border-color: var(--color-border-light); color: var(--color-text); }
.dg-blk.dg-comment-blk .dg-act:hover  { background: rgba(0,0,0,0.1); }
.dg-blk.dg-comment-blk .dg-act.del:hover { background: rgba(231,76,60,0.12); border-color: #e74c3c; color: #e74c3c; }
.dg-blk.dg-comment-blk .dg-blk-acts { opacity: 0; }
.dg-blk.dg-comment-blk:hover .dg-blk-acts { opacity: 1; }

/* ══════════════════════════════════════════════════════════
   CONTAINER BLOCKS — Blockly C-shape
══════════════════════════════════════════════════════════ */

.dg-container {
  width: 100%;
  border-radius: 10px; overflow: hidden;
  box-shadow: 0 4px 16px rgba(0,0,0,0.13), 0 1px 4px rgba(0,0,0,0.07);
  transition: box-shadow 0.15s;
  border-left: 5px solid var(--dg-accent, var(--color-teal));
}
.dg-container:hover {
  box-shadow: 0 7px 24px rgba(0,0,0,0.17), 0 2px 8px rgba(0,0,0,0.1);
}

.dg-con-head {
  display: flex; align-items: center; gap: 0.6rem;
  padding: 0.65rem 0.7rem;
  background: var(--dg-accent, var(--color-teal));
  color: #fff;
}
.dg-con-head .icon { width: 1.2em; height: 1.2em; color: rgba(255,255,255,0.9); }
.dg-con-acts { display: flex; gap: 0.2rem; flex-shrink: 0; }

.dg-con-body {
  background: color-mix(in srgb, var(--dg-accent, var(--color-teal)) 5%, var(--color-bg));
  padding: 0.7rem 0.6rem 0.5rem 1.1rem;
  min-height: 3rem;
  display: flex; flex-direction: column; align-items: center;
}
.dg-con-body-empty {
  display: flex; align-items: center; justify-content: center;
  min-height: 3rem; font-size: 0.9rem;
  color: var(--color-text); opacity: 0.32; font-style: italic; gap: 0.35rem;
}
.dg-con-body-empty .icon { width: 1em; height: 1em; opacity: 0.7; }

.dg-add-inside {
  display: flex; align-items: center; gap: 0.3rem;
  padding: 0.28rem 0.7rem; border-radius: 2rem;
  border: 1.5px dashed var(--dg-accent, var(--color-teal));
  background: transparent; color: var(--dg-accent, var(--color-teal));
  font-size: 0.88rem; font-weight: 600;
  cursor: pointer; opacity: 0.6;
  transition: opacity 0.15s, background 0.15s;
  margin: 0.35rem 0 0.1rem; align-self: center;
}
.dg-add-inside .icon { width: 0.82em; height: 0.82em; }
.dg-add-inside:hover {
  opacity: 1; background: color-mix(in srgb, var(--dg-accent) 10%, transparent);
}

.dg-con-foot {
  padding: 0.38rem 0.85rem;
  background: color-mix(in srgb, var(--dg-accent, var(--color-teal)) 16%, var(--color-panel-bg));
  font-size: 0.78rem; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--dg-accent, var(--color-teal));
  cursor: pointer; transition: background 0.12s;
  display: flex; align-items: center; gap: 0.3rem;
}
.dg-con-foot .icon { width: 0.9em; height: 0.9em; opacity: 0.7; }
.dg-con-foot:hover { background: color-mix(in srgb, var(--dg-accent) 26%, var(--color-panel-bg)); }

/* ── IF block — two-branch layout ─────────────────────── */
.dg-container.dg-if-block .dg-con-body {
  padding: 0; flex-direction: row; align-items: stretch; gap: 0; min-height: 5rem;
}
.dg-branch {
  flex: 1; display: flex; flex-direction: column;
  align-items: center; padding: 0.65rem 0.5rem 0.5rem;
}
.dg-branch-label {
  font-size: 0.75rem; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase;
  padding: 0.15rem 0.55rem; border-radius: 2rem; margin-bottom: 0.5rem;
  border: 1.5px solid; display: flex; align-items: center; gap: 0.25rem;
}
.dg-branch-label .icon { width: 0.78em; height: 0.78em; }
.dg-branch-then .dg-branch-label { color: #27ae60; border-color: #27ae60; background: rgba(39,174,96,0.1); }
.dg-branch-else .dg-branch-label { color: #e74c3c; border-color: #e74c3c; background: rgba(231,76,60,0.1); }
.dg-branch-divider {
  width: 1.5px;
  background: color-mix(in srgb, var(--dg-accent) 18%, transparent);
  margin: 0.5rem 0; align-self: stretch;
}
.dg-branch .dg-canvas { max-width: none; width: 100%; }

/* ── Start / End caps ──────────────────────────────────── */
.dg-cap {
  display: flex; align-items: center; justify-content: center; gap: 0.4rem;
  padding: 0.42rem 1.2rem; border-radius: 999px;
  font-size: 0.78rem; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase;
  color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,0.15); align-self: center;
}
.dg-cap .icon { width: 0.9em; height: 0.9em; }
.dg-cap-start { background: var(--color-teal); }
.dg-cap-end   { background: #7f8c8d; }

/* ── Diagram header ────────────────────────────────────── */
.dg-header {
  display: flex; align-items: center; justify-content: space-between;
  width: 100%; max-width: 620px; margin-bottom: 1rem;
}
.dg-header-hint {
  font-size: 0.85rem; color: var(--color-text); opacity: 0.42;
  display: flex; align-items: center; gap: 0.35rem;
}
.dg-header-hint .icon { width: 0.9em; height: 0.9em; }
.dg-header-badge {
  font-size: 0.8rem; font-weight: 700;
  background: color-mix(in srgb, var(--color-teal) 12%, transparent);
  color: var(--color-teal);
  border: 1px solid color-mix(in srgb, var(--color-teal) 25%, transparent);
  padding: 0.14rem 0.5rem; border-radius: 2rem;
}

/* ── Add-command menu ──────────────────────────────────── */
#dg-add-menu {
  position: fixed; z-index: 3500;
  background: var(--color-panel-bg);
  border: 1.5px solid var(--color-border-light);
  border-radius: 14px; padding: 1rem;
  box-shadow: 0 12px 40px rgba(0,0,0,0.2), 0 4px 12px rgba(0,0,0,0.1);
  min-width: 290px;
  animation: dgMenuIn 0.14s cubic-bezier(0.34,1.56,0.64,1);
}
@keyframes dgMenuIn {
  from { opacity:0; transform:scale(0.88) translateY(-8px); }
  to   { opacity:1; transform:scale(1)    translateY(0); }
}
.dg-menu-title {
  font-size: 0.78rem; font-weight: 800; letter-spacing: 0.07em; text-transform: uppercase;
  margin-bottom: 0.75rem; color: var(--color-text); opacity: 0.45; padding-left: 0.2rem;
}
.dg-menu-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.42rem; }
.dg-menu-btn {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.52rem 0.72rem; border-radius: 8px;
  border: 1.5px solid var(--color-border-light);
  background: var(--color-bg); cursor: pointer;
  font-size: 0.88rem; font-weight: 600;
  transition: all 0.12s; color: var(--color-text);
}
.dg-menu-btn .icon { width: 1.05em; height: 1.05em; flex-shrink: 0; color: var(--dg-mb-color, var(--color-teal)); }
.dg-menu-btn:hover {
  border-color: var(--dg-mb-color, var(--color-teal));
  color: var(--dg-mb-color, var(--color-teal));
  background: var(--color-panel-bg);
  transform: translateY(-1px);
  box-shadow: 0 3px 10px rgba(0,0,0,0.08);
}
.dg-menu-close { display: flex; justify-content: center; margin-top: 0.6rem; }
.dg-menu-close button {
  display: flex; align-items: center; gap: 0.3rem;
  background: none; border: 1px solid var(--color-border-light);
  cursor: pointer; font-size: 0.85rem; color: var(--color-text);
  opacity: 0.48; padding: 0.22rem 0.7rem; border-radius: 2rem; transition: opacity 0.12s;
}
.dg-menu-close button .icon { width: 0.82em; height: 0.82em; }
.dg-menu-close button:hover { opacity: 0.85; border-color: var(--color-text); }

/* ── Inner canvas spacing inside blocks ────────────────── */
.dg-con-body .dg-canvas { max-width: none; width: 100%; }
.dg-con-body .dg-connector-line { height: 9px; }

/* ── Responsive ────────────────────────────────────────── */
@media (max-width: 480px) {
  .dg-container.dg-if-block .dg-con-body { flex-direction: column; }
  .dg-branch-divider { width: 100%; height: 1.5px; margin: 0; align-self: auto; }
}
`;
  document.head.appendChild(s);
})();

// ══════════════════════════════════════════════════════════
//  CONSTANTS — category meta (using existing SVG icon IDs)
// ══════════════════════════════════════════════════════════

const _DG_CAT = {
  mouse:      { icon: '#i-mouse',       color: '#2980b9', label: 'Mouse' },
  key:        { icon: '#i-keyboard',    color: '#8e44ad', label: 'Keyboard' },
  img:        { icon: '#i-image',       color: '#d35400', label: 'Image' },
  findimg:    { icon: '#i-target',      color: '#7c4ab8', label: 'Find & Act' },
  ocr:        { icon: '#i-type',        color: '#e94560', label: 'OCR / Text' },
  colordet:   { icon: '#i-palette',     color: '#16a085', label: 'Color' },
  flow:       { icon: '#i-repeat',      color: '#27ae60', label: 'Flow' },
  cond:       { icon: '#i-help',        color: '#e67e22', label: 'Condition' },
  wait:       { icon: '#i-pause',       color: '#7f8c8d', label: 'Wait' },
  waitrandom: { icon: '#i-zap',         color: '#d4860b', label: 'Wait Random' },
  stop:       { icon: '#i-square-stop', color: '#e74c3c', label: 'Stop' },
  pause:      { icon: '#i-pause',       color: '#e67e22', label: 'Pause' },
  toast:      { icon: '#i-bell',        color: '#3498db', label: 'Toast' },
  label:      { icon: '#i-tag',         color: '#607d8b', label: 'Label' },
  goto:       { icon: '#i-goto-arrow',  color: '#607d8b', label: 'Goto' },
  onerror:    { icon: '#i-bug',         color: '#ff5722', label: 'On Error' },
  clip:       { icon: '#i-clipboard',   color: '#1abc9c', label: 'Clipboard' },
  comment:    { icon: '#i-file-text',   color: '#95a5a6', label: 'Comment' },
  unknown:    { icon: '#i-zap',         color: '#95a5a6', label: 'Command' },
};

// Render an <svg> using the sprite system
function _dgIcon(id, cls) {
  return `<svg class="icon${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="${id}"/></svg>`;
}

// Category lookup
function _dgCatOf(cmd) {
  if (!cmd) return 'unknown';
  const upper = cmd.toUpperCase();
  if (upper === 'LABEL')        return 'label';
  if (upper === 'GOTO')         return 'goto';
  if (upper === 'ON_ERROR')     return 'onerror';
  if (upper === 'STOP')         return 'stop';
  if (upper === 'PAUSE_SCRIPT') return 'pause';
  if (upper === 'WAIT_RANDOM')  return 'waitrandom';
  if (typeof SH !== 'undefined' && SH.keywords[upper]) return SH.keywords[upper];
  return 'unknown';
}

// ══════════════════════════════════════════════════════════
//  SUMMARY FORMATTER
// ══════════════════════════════════════════════════════════

function _dgSummary(cmd, args) {
  const c = cmd.toUpperCase();
  const a = args || [];
  const t = (i) => (a[i] || '').replace(/\.png$/i, '');

  if (['CLICK','DOUBLE_CLICK','RIGHT_CLICK','MOVE','MOVE_HUMAN'].includes(c))
    return a.length >= 2 ? `(${a[0]}, ${a[1]})` : '';
  if (c === 'SCROLL') return a[0] ? (parseInt(a[0]) > 0 ? `↓ ${a[0]}` : `↑ ${Math.abs(a[0])}`) : '';
  if (c === 'DRAG')   return a.length >= 4 ? `(${a[0]},${a[1]}) → (${a[2]},${a[3]})` : '';

  if (['PRESS','HOLD','RELEASE'].includes(c)) return a[0] ? `[ ${a[0]} ]` : '';
  if (c === 'HOTKEY') return a[0] || '';
  if (c === 'TYPE')   { const s = a.join(' '); return s.length > 30 ? s.slice(0,30)+'…' : s; }

  if (c === 'WAIT')        return a[0] ? `${a[0]}s` : '';
  if (c === 'WAIT_RANDOM') return a.length >= 2 ? `${a[0]}–${a[1]}s` : '';

  if (['CLICK_IMAGE','DOUBLE_CLICK_IMAGE','RIGHT_CLICK_IMAGE',
       'CLICK_RANDOM_OFFSET','DOUBLE_CLICK_RANDOM_OFFSET','RIGHT_CLICK_RANDOM_OFFSET'].includes(c))
    return t(0);
  if (['WAIT_IMAGE','WAIT_IMAGE_GONE'].includes(c)) {
    const sn = t(0); const to = a[1] || '30';
    return sn ? `${sn}  ⏱ ${to}s` : '';
  }
  if (['FIND_CLICK','FIND_DOUBLE_CLICK','FIND_RIGHT_CLICK','FIND_MOVE','FIND_HOLD'].includes(c))
    return t(0);
  if (c === 'FIND_DRAG') return `${t(0)} → (${a[1]||0},${a[2]||0})`;
  if (c === 'NAVIGATE_TO_IMAGE') return t(0);
  if (['IF_IMAGE','IF_NOT_IMAGE','WHILE_IMAGE'].includes(c)) return t(0);

  if (c === 'REPEAT') return a[0] ? `${a[0]} times` : '';
  if (c === 'LOOP')   return 'forever';
  if (c === 'REPEAT_UNTIL') return a.slice(0,3).join(' ');
  if (c === 'SET')    return a.join(' ');
  if (['IF_VAR','WHILE_VAR'].includes(c)) return a.slice(0,3).join(' ');

  if (c === 'TOAST') {
    const k = ['info','warn','error'];
    const msg = a.filter(x => !k.includes(x.toLowerCase())).join(' ');
    return msg.length > 30 ? msg.slice(0,30)+'…' : msg;
  }
  if (c === 'LABEL') return a[0] ? `⚑ ${a[0]}` : '';
  if (c === 'GOTO')  return a[0] ? `→ ${a[0]}` : '';
  if (c === 'ON_ERROR') return 'error handler';

  if (/^TEXT_/.test(c))  return (a[0]||'').replace(/^\"|\"$/g,'');
  if (/^COLOR_/.test(c)) return a[0] || '';

  if (c === 'CLIPBOARD_SET') return (a[0]||'').replace(/^\"|\"$/g,'');
  if (c === 'CLIPBOARD_GET') { const arr = a.join(' ').split('->'); return arr[1]?.trim() || ''; }

  return a.slice(0,3).join(' ');
}

// ══════════════════════════════════════════════════════════
//  PARSER — script lines → nested AST
// ══════════════════════════════════════════════════════════

const _DG_BLOCK_OPENERS = new Set([
  'REPEAT','LOOP','WHILE_IMAGE','WHILE_VAR','REPEAT_UNTIL','ON_ERROR',
]);
const _DG_IF_OPENERS = new Set(['IF_IMAGE','IF_NOT_IMAGE','IF_VAR']);

function _dgParseLine(raw) {
  if (!raw || !raw.trim()) return { empty: true, raw };
  const trimmed = raw.trim();
  if (trimmed.startsWith('#')) return { comment: true, raw, text: trimmed };
  const toks = trimmed.match(/(?:"[^"]*"|\S+)/g) || [];
  const cmd  = (toks[0] || '').toUpperCase();
  return { cmd, args: toks.slice(1), raw, trimmed };
}

function _dgParseBlock(lines, start, stopAt) {
  const nodes = [];
  let i = start;
  while (i < lines.length) {
    const p = _dgParseLine(lines[i]);

    if (p.empty || p.comment) {
      if (!p.empty) nodes.push({ type: 'line', lineIdx: i, ...p, cat: 'comment' });
      i++; continue;
    }

    if (stopAt.has(p.cmd)) return { nodes, nextIdx: i };

    if (_DG_IF_OPENERS.has(p.cmd)) {
      const cat = _dgCatOf(p.cmd);
      const { nodes: thenNodes, nextIdx: afterThen } = _dgParseBlock(lines, i + 1, new Set(['ELSE','END']));
      let elseNodes = [], elseLineIdx = -1, endLineIdx = afterThen;
      const stopper = _dgParseLine(lines[afterThen] || '');
      if (stopper.cmd === 'ELSE') {
        elseLineIdx = afterThen;
        const { nodes: en, nextIdx: afterElse } = _dgParseBlock(lines, afterThen + 1, new Set(['END']));
        elseNodes = en; endLineIdx = afterElse;
      }
      nodes.push({
        type: 'if', lineIdx: i, cmd: p.cmd, args: p.args, cat,
        children: thenNodes, elseChildren: elseNodes,
        elseLineIdx, endLineIdx,
      });
      i = endLineIdx + 1;
      continue;
    }

    if (_DG_BLOCK_OPENERS.has(p.cmd)) {
      const cat = _dgCatOf(p.cmd);
      const { nodes: bodyNodes, nextIdx: afterBody } = _dgParseBlock(lines, i + 1, new Set(['END']));
      nodes.push({
        type: 'block', lineIdx: i, cmd: p.cmd, args: p.args, cat,
        children: bodyNodes, endLineIdx: afterBody,
      });
      i = afterBody + 1;
      continue;
    }

    const cat = _dgCatOf(p.cmd);
    nodes.push({ type: 'line', lineIdx: i, cmd: p.cmd, args: p.args, cat, raw: p.raw });
    i++;
  }
  return { nodes, nextIdx: lines.length };
}

function _dgParseScript(text) {
  const lines = (text || '').split('\n');
  return _dgParseBlock(lines, 0, new Set()).nodes;
}

// ══════════════════════════════════════════════════════════
//  RENDERER — AST → HTML  (Blockly-inspired)
// ══════════════════════════════════════════════════════════

function _dgRenderNodes(nodes, depth) {
  if (!nodes || !nodes.length) return '';
  let html = '';
  nodes.forEach((n, idx) => {
    if (idx === 0) {
      html += _dgAddZone(n.lineIdx - 1);
    } else {
      html += _dgConnectorHTML();
      html += _dgAddZone(n.lineIdx - 1);
    }
    if (n.type === 'if')         html += _dgRenderIf(n, depth);
    else if (n.type === 'block') html += _dgRenderBlock(n, depth);
    else                         html += _dgRenderCard(n, depth);
  });
  return html;
}

function _dgConnectorHTML() {
  return `<div class="dg-connector">
    <div class="dg-connector-line"></div>
    <div class="dg-connector-dot"></div>
    <div class="dg-connector-line"></div>
  </div>`;
}

function _dgAddZone(afterLine) {
  return `<div class="dg-add-zone">
    <div class="dg-add-zone-line"></div>
    <button class="dg-add-btn" onclick="_dgOpenAddMenu(event,${afterLine})" title="Add command here">
      ${_dgIcon('#i-plus')}
    </button>
    <div class="dg-add-zone-line"></div>
  </div>`;
}

function _dgRenderCard(node, _depth) {
  const meta    = _DG_CAT[node.cat] || _DG_CAT.unknown;
  const color   = meta.color;
  const isComment = !!node.comment;

  if (isComment) {
    return `<div class="dg-blk dg-comment-blk" style="--dg-accent:${color}">
      <div class="dg-blk-head">
        ${_dgIcon(meta.icon)}
        <div class="dg-blk-head-text">
          <div class="dg-blk-label">Comment</div>
          <div class="dg-blk-value">${_esc(node.text || '')}</div>
        </div>
        <div class="dg-blk-acts">
          <button class="dg-act" onclick="lpEdit(${node.lineIdx})" title="Edit">${_dgIcon('#i-pencil')}</button>
          <button class="dg-act del" onclick="_dgDelete(${node.lineIdx})" title="Delete">${_dgIcon('#i-trash')}</button>
        </div>
      </div>
    </div>`;
  }

  const summary    = _dgSummary(node.cmd || '', node.args || []);
  const hasSummary = summary && summary.trim();

  return `<div class="dg-blk" style="--dg-accent:${color}">
    <div class="dg-blk-head">
      ${_dgIcon(meta.icon)}
      <div class="dg-blk-head-text">
        ${hasSummary
          ? `<div class="dg-blk-label">${_esc(node.cmd || '')}</div>
             <div class="dg-blk-value">${_esc(summary)}</div>`
          : `<div class="dg-blk-value-only">${_esc(node.cmd || '')}</div>`
        }
      </div>
      <div class="dg-blk-acts">
        <button class="dg-act" onclick="lpEdit(${node.lineIdx})" title="Edit line">${_dgIcon('#i-pencil')}</button>
        <button class="dg-act del" onclick="_dgDelete(${node.lineIdx})" title="Delete line">${_dgIcon('#i-trash')}</button>
      </div>
    </div>
  </div>`;
}

function _dgRenderBlock(node, depth) {
  const meta       = _DG_CAT[node.cat] || _DG_CAT.unknown;
  const color      = meta.color;
  const summary    = _dgSummary(node.cmd, node.args);
  const hasSummary = summary && summary.trim();

  const bodyHtml = node.children && node.children.length
    ? `<div class="dg-canvas">${_dgRenderNodes(node.children, depth + 1)}</div>`
    : `<div class="dg-con-body-empty">${_dgIcon('#i-box-dashed')} empty block</div>`;

  const lastChildLine = node.children && node.children.length
    ? (node.children[node.children.length - 1].endLineIdx ?? node.children[node.children.length - 1].lineIdx)
    : node.lineIdx;

  return `<div class="dg-container" style="--dg-accent:${color}">
    <div class="dg-con-head">
      ${_dgIcon(meta.icon)}
      <div class="dg-blk-head-text">
        ${hasSummary
          ? `<div class="dg-blk-label">${_esc(node.cmd)}</div>
             <div class="dg-blk-value">${_esc(summary)}</div>`
          : `<div class="dg-blk-value-only">${_esc(node.cmd)}</div>`
        }
      </div>
      <div class="dg-con-acts">
        <button class="dg-act" onclick="lpEdit(${node.lineIdx})" title="Edit">${_dgIcon('#i-pencil')}</button>
        <button class="dg-act del" onclick="_dgDelete(${node.lineIdx})" title="Delete block">${_dgIcon('#i-trash')}</button>
      </div>
    </div>
    <div class="dg-con-body">
      ${bodyHtml}
      <button class="dg-add-inside" onclick="_dgOpenAddMenu(event,${lastChildLine})">
        ${_dgIcon('#i-plus')} Add step inside
      </button>
    </div>
    <div class="dg-con-foot" onclick="lpEdit(${node.endLineIdx})">
      ${_dgIcon('#i-square-stop')} END
    </div>
  </div>`;
}

function _dgRenderIf(node, depth) {
  const meta       = _DG_CAT[node.cat] || _DG_CAT.unknown;
  const color      = meta.color;
  const summary    = _dgSummary(node.cmd, node.args);
  const hasSummary = summary && summary.trim();

  const thenHtml = node.children && node.children.length
    ? `<div class="dg-canvas">${_dgRenderNodes(node.children, depth + 1)}</div>`
    : `<div class="dg-con-body-empty">${_dgIcon('#i-box-dashed')} empty</div>`;

  const elseHtml = node.elseChildren && node.elseChildren.length
    ? `<div class="dg-canvas">${_dgRenderNodes(node.elseChildren, depth + 1)}</div>`
    : `<div class="dg-con-body-empty">${_dgIcon('#i-box-dashed')} empty</div>`;

  const lastThen = node.children?.length
    ? (node.children[node.children.length-1].endLineIdx ?? node.children[node.children.length-1].lineIdx)
    : node.lineIdx;
  const lastElse = node.elseChildren?.length
    ? (node.elseChildren[node.elseChildren.length-1].endLineIdx ?? node.elseChildren[node.elseChildren.length-1].lineIdx)
    : (node.elseLineIdx ?? node.lineIdx);

  return `<div class="dg-container dg-if-block" style="--dg-accent:${color}">
    <div class="dg-con-head">
      ${_dgIcon(meta.icon)}
      <div class="dg-blk-head-text">
        ${hasSummary
          ? `<div class="dg-blk-label">${_esc(node.cmd)}</div>
             <div class="dg-blk-value">${_esc(summary)}</div>`
          : `<div class="dg-blk-value-only">${_esc(node.cmd)}</div>`
        }
      </div>
      <div class="dg-con-acts">
        <button class="dg-act" onclick="lpEdit(${node.lineIdx})" title="Edit condition">${_dgIcon('#i-pencil')}</button>
        <button class="dg-act del" onclick="_dgDelete(${node.lineIdx})" title="Delete block">${_dgIcon('#i-trash')}</button>
      </div>
    </div>
    <div class="dg-con-body">
      <div class="dg-branch dg-branch-then">
        <div class="dg-branch-label">${_dgIcon('#i-play')} THEN</div>
        ${thenHtml}
        <button class="dg-add-inside" onclick="_dgOpenAddMenu(event,${lastThen})">
          ${_dgIcon('#i-plus')} Add
        </button>
      </div>
      <div class="dg-branch-divider"></div>
      <div class="dg-branch dg-branch-else">
        <div class="dg-branch-label">${_dgIcon('#i-x-close')} ELSE</div>
        ${elseHtml}
        <button class="dg-add-inside" onclick="_dgOpenAddMenu(event,${lastElse})">
          ${_dgIcon('#i-plus')} Add
        </button>
      </div>
    </div>
    <div class="dg-con-foot" onclick="lpEdit(${node.endLineIdx})">
      ${_dgIcon('#i-square-stop')} END
    </div>
  </div>`;
}

function _esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ══════════════════════════════════════════════════════════
//  RENDER DIAGRAM
// ══════════════════════════════════════════════════════════

function _dgRender() {
  const panel = document.getElementById('dg-panel');
  if (!panel || !_dgActive) return;

  const script   = document.getElementById('script-editor')?.value || '';
  const ast      = _dgParseScript(script);
  const lines    = script.split('\n');
  const cmdCount = lines.filter(l => l.trim() && !l.trim().startsWith('#')).length;

  if (!ast.length && !script.trim()) {
    panel.innerHTML = `
      <div class="dg-empty">
        ${_dgIcon('#i-box-dashed', 'icon-xl')}
        <div>Your macro diagram will appear here</div>
        <div class="dg-empty-hint">Add commands using the toolbar above, or switch to Script view.</div>
      </div>`;
    return;
  }

  const lastLine = lines.length - 1;

  panel.innerHTML = `
    <div class="dg-header">
      <span class="dg-header-hint">
        ${_dgIcon('#i-compass')} Diagram view — hover a block to edit or delete
      </span>
      <span class="dg-header-badge">${cmdCount} command${cmdCount !== 1 ? 's' : ''}</span>
    </div>
    <div class="dg-canvas">
      <div class="dg-cap dg-cap-start">${_dgIcon('#i-play')} START</div>
      ${_dgRenderNodes(ast, 0)}
      ${_dgAddZone(lastLine)}
      <div class="dg-connector"><div class="dg-connector-line" style="height:16px"></div></div>
      <div class="dg-cap dg-cap-end">${_dgIcon('#i-square-stop')} END</div>
    </div>`;
}

// ══════════════════════════════════════════════════════════
//  FIX: Instant delete sync — replaces emoji lpDelete in diagram
// ══════════════════════════════════════════════════════════

function _dgDelete(idx) {
  if (typeof _guardRunning === 'function' && _guardRunning('delete a script line')) return;
  if (typeof _pushUndo === 'function') _pushUndo();
  const editor = document.getElementById('script-editor');
  if (!editor) return;
  const lines = editor.value.split('\n');
  lines.splice(idx, 1);
  editor.value = lines.join('\n');
  // Fire onEditorInput so all views (line count, syntax, diagram) sync together
  if (typeof onEditorInput === 'function') onEditorInput();
  else _dgRender();
}

// ══════════════════════════════════════════════════════════
//  ADD-COMMAND MENU
// ══════════════════════════════════════════════════════════

let _dgInsertAfterLine = null;

function _dgOpenAddMenu(e, afterLine) {
  e.stopPropagation();
  _dgInsertAfterLine = afterLine;
  document.getElementById('dg-add-menu')?.remove();

  const items = [
    { icon: '#i-mouse',       color: '#2980b9', label: 'Mouse',      fn: "openMouseCmd('click')" },
    { icon: '#i-keyboard',    color: '#8e44ad', label: 'Keyboard',   fn: "insertCmd('press')" },
    { icon: '#i-target',      color: '#7c4ab8', label: 'Find & Act', fn: "openImgAction('FIND_CLICK')" },
    { icon: '#i-image',       color: '#d35400', label: 'Image',      fn: "openImgAction('CLICK_IMAGE')" },
    { icon: '#i-pause',       color: '#7f8c8d', label: 'Wait',       fn: "openWaitConfig()" },
    { icon: '#i-repeat',      color: '#27ae60', label: 'Repeat',     fn: "_dgInsertSnippet('REPEAT 5\\n  # actions\\nEND')" },
    { icon: '#i-help',        color: '#e67e22', label: 'IF Image',   fn: "openIfImageModal()" },
    { icon: '#i-refresh',     color: '#27ae60', label: 'While',      fn: "openWhileImageModal()" },
    { icon: '#i-keyboard',    color: '#5c6bc0', label: 'Type',       fn: "insertCmd('type')" },
    { icon: '#i-bell',        color: '#3498db', label: 'Toast',      fn: "openToastConfig()" },
    { icon: '#i-tag',         color: '#607d8b', label: 'Label',      fn: "openLabelConfig()" },
    { icon: '#i-goto-arrow',  color: '#607d8b', label: 'Goto',       fn: "openGotoConfig()" },
    { icon: '#i-square-stop', color: '#e74c3c', label: 'Stop',       fn: "_dgInsertSnippet('STOP')" },
    { icon: '#i-file-text',   color: '#95a5a6', label: 'Comment',    fn: "_dgInsertSnippet('# your comment')" },
  ];

  const btns = items.map(it =>
    `<button class="dg-menu-btn" style="--dg-mb-color:${it.color}"
       onclick="_dgMenuAct(function(){${it.fn}})" title="${it.label}">
       ${_dgIcon(it.icon)}${it.label}
     </button>`
  ).join('');

  const menu = document.createElement('div');
  menu.id = 'dg-add-menu';
  menu.innerHTML = `
    <div class="dg-menu-title">Insert command</div>
    <div class="dg-menu-grid">${btns}</div>
    <div class="dg-menu-close">
      <button onclick="_dgCloseAddMenu()">${_dgIcon('#i-x-close')} Close</button>
    </div>`;
  document.body.appendChild(menu);

  const rect = e.currentTarget
    ? e.currentTarget.getBoundingClientRect()
    : { left: e.clientX, top: e.clientY, height: 0 };
  const mw = 310, mh = menu.offsetHeight || 340;
  let left = rect.left - mw / 2;
  let top  = rect.top + rect.height + 10;
  left = Math.max(8, Math.min(left, window.innerWidth  - mw - 8));
  top  = Math.max(8, Math.min(top,  window.innerHeight - mh - 8));
  menu.style.left = left + 'px';
  menu.style.top  = top  + 'px';

  setTimeout(() => document.addEventListener('mousedown', _dgMenuOutside, { capture: true }), 10);
}

function _dgMenuAct(fn) { _dgCloseAddMenu(); fn(); }

function _dgCloseAddMenu() {
  document.getElementById('dg-add-menu')?.remove();
  document.removeEventListener('mousedown', _dgMenuOutside, { capture: true });
}

function _dgMenuOutside(e) {
  if (!document.getElementById('dg-add-menu')?.contains(e.target)) {
    _dgCloseAddMenu();
    _dgInsertAfterLine = null;
  }
}

function _dgInsertSnippet(code) { insertToEditor(code); }

// ══════════════════════════════════════════════════════════
//  PATCH insertToEditor — diagram-aware position insert
// ══════════════════════════════════════════════════════════

window.addEventListener('DOMContentLoaded', () => {
  const _origInsert = window.insertToEditor;
  window.insertToEditor = function(code, fromGuide) {
    if (_dgInsertAfterLine !== null && _dgActive) {
      if (typeof _guardRunning === 'function' && _guardRunning('insert a command')) return;
      if (typeof _pushUndo === 'function') _pushUndo();
      const editor = document.getElementById('script-editor');
      if (!editor) { _dgInsertAfterLine = null; return; }
      const lines    = editor.value.split('\n');
      const insertAt = Math.max(0, Math.min(_dgInsertAfterLine + 1, lines.length));
      lines.splice(insertAt, 0, ...code.split('\n'));
      editor.value = lines.join('\n');
      _dgInsertAfterLine = null;
      if (typeof onEditorInput === 'function') onEditorInput();
      else _dgRender();
      if (typeof toast === 'function') toast('Command added', 'info');
      return;
    }
    _origInsert(code, fromGuide);
  };
});

// ══════════════════════════════════════════════════════════
//  PATCH onEditorInput — keep diagram in sync as user types
// ══════════════════════════════════════════════════════════

window.addEventListener('DOMContentLoaded', () => {
  const _origOnInput = window.onEditorInput;
  window.onEditorInput = function() {
    if (typeof _origOnInput === 'function') _origOnInput();
    if (_dgActive) _dgRender();
  };
});

// ══════════════════════════════════════════════════════════
//  TOGGLE
// ══════════════════════════════════════════════════════════

let _dgActive = false;

function toggleDiagramView() {
  _dgActive = !_dgActive;
  const editorSplit = document.querySelector('.editor-split');
  const dgPanel     = document.getElementById('dg-panel');
  const toggleBtn   = document.getElementById('dg-toggle-btn');
  if (!editorSplit || !dgPanel) return;

  if (_dgActive) {
    editorSplit.style.display = 'none';
    dgPanel.classList.add('dg-active');
    toggleBtn?.classList.add('active');
    _dgRender();
  } else {
    editorSplit.style.display = '';
    dgPanel.classList.remove('dg-active');
    toggleBtn?.classList.remove('active');
  }
}

// ══════════════════════════════════════════════════════════
//  INIT — inject panel + toggle button
// ══════════════════════════════════════════════════════════

window.addEventListener('DOMContentLoaded', () => {
  // 1. Diagram panel (sibling to .editor-split)
  const editorSplit = document.querySelector('.editor-split');
  if (editorSplit && !document.getElementById('dg-panel')) {
    const panel = document.createElement('div');
    panel.id = 'dg-panel';
    editorSplit.parentNode.insertBefore(panel, editorSplit.nextSibling);
  }

  // 2. Toggle button using existing SVG sprite — no extra icons needed
  const footer = document.querySelector('.editor-footer');
  if (footer && !document.getElementById('dg-toggle-btn')) {
    const btn = document.createElement('button');
    btn.id      = 'dg-toggle-btn';
    btn.title   = 'Toggle visual diagram view';
    btn.onclick = toggleDiagramView;
    btn.innerHTML = `
      <svg class="icon" aria-hidden="true"><use href="#i-compass"/></svg>
      Diagram
    `;
    footer.insertBefore(btn, footer.querySelector('#script-status') || null);
  }
});
