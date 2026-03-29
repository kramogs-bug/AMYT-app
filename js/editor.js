/**
 * editor.js — Script editor: syntax highlighting, auto-indent, undo,
 *             line panel, save/load dialogs, settings.
 */

// ══════════════════════════════════════════════════════════
//  SYNTAX HIGHLIGHTING
// ══════════════════════════════════════════════════════════

const SH = {
  keywords: {
    // Mouse
    CLICK:'mouse', DOUBLE_CLICK:'mouse', RIGHT_CLICK:'mouse',
    MOVE:'mouse', MOVE_HUMAN:'mouse', SCROLL:'mouse', DRAG:'mouse',
    // Keyboard
    TYPE:'key', PRESS:'key', HOLD:'key', RELEASE:'key', HOTKEY:'key',
    // Image detection
    CLICK_IMAGE:'img', DOUBLE_CLICK_IMAGE:'img', RIGHT_CLICK_IMAGE:'img',
    CLICK_RANDOM_OFFSET:'img', DOUBLE_CLICK_RANDOM_OFFSET:'img', RIGHT_CLICK_RANDOM_OFFSET:'img',
    WAIT_IMAGE:'img', WAIT_IMAGE_GONE:'img', NAVIGATE_TO_IMAGE:'img',
    // Find & act (image)
    FIND_CLICK:'findimg', FIND_DOUBLE_CLICK:'findimg', FIND_RIGHT_CLICK:'findimg',
    FIND_MOVE:'findimg', FIND_HOLD:'findimg', FIND_DRAG:'findimg',
    // OCR (text detection)
    TEXT_CLICK:'ocr', TEXT_DOUBLE_CLICK:'ocr', TEXT_RIGHT_CLICK:'ocr',
    TEXT_MOVE:'ocr', TEXT_HOLD:'ocr', TEXT_DRAG:'ocr',
    READ_TEXT:'ocr',
    // Color detection
    COLOR_CLICK:'colordet', COLOR_DOUBLE_CLICK:'colordet', COLOR_RIGHT_CLICK:'colordet',
    COLOR_MOVE:'colordet', COLOR_HOLD:'colordet', COLOR_DRAG:'colordet',
    WAIT_COLOR:'colordet', READ_COLOR:'colordet',
    // Flow control
    REPEAT:'flow', LOOP:'flow', END:'flow', ELSE:'flow', SET:'flow',
    REPEAT_UNTIL:'flow',
    // Conditions
    IF_IMAGE:'cond', IF_NOT_IMAGE:'cond', WHILE_IMAGE:'cond',
    IF_VAR:'cond', WHILE_VAR:'cond',
    // Control
    WAIT:'wait', WAIT_RANDOM:'waitrandom', STOP:'stop', PAUSE_SCRIPT:'pause',
    TOAST:'toast', LABEL:'label', GOTO:'goto',
    // Error handling
    ON_ERROR:'onerror',
    // Clipboard
    CLIPBOARD_SET:'clip', CLIPBOARD_GET:'clip',
    CLIPBOARD_COPY:'clip', CLIPBOARD_PASTE:'clip',
  }
};

function _escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _highlightLine(rawLine) {
  if (!rawLine) return '\n';
  const trimmed  = rawLine.trimStart();
  const indentLen = rawLine.length - trimmed.length;
  const indent    = indentLen > 0 ? rawLine.slice(0, indentLen).replace(/ /g, '\u00a0') : '';

  if (trimmed.startsWith('#')) {
    return indent + `<span class="sh-comment">${_escapeHtml(trimmed)}</span>`;
  }

  const tokens   = trimmed.split(/\s+/);
  const cmd      = tokens[0] || '';
  const cmdUpper = cmd.toUpperCase();
  const cat      = SH.keywords[cmdUpper];

  if (!cat) return indent + `<span class="sh-unknown">${_escapeHtml(trimmed)}</span>`;

  // Build the line with colored tokens
  const cmdHtml = `<span class="sh-${cat}">${_escapeHtml(cmd)}</span>`;
  const argTokens = tokens.slice(1).map(tok => {
    // Variable reference: $name or $name_found etc.
    if (/^\$[a-zA-Z_][a-zA-Z0-9_]*$/.test(tok)) {
      return `<span class="sh-var">${_escapeHtml(tok)}</span>`;
    }
    // Arrow operator for READ_TEXT / READ_COLOR / CLIPBOARD_GET
    if (tok === '->') {
      return `<span class="sh-arrow">${_escapeHtml(tok)}</span>`;
    }
    // Quoted string: "text here"
    if (tok.startsWith('"') && tok.endsWith('"')) {
      return `<span class="sh-str">${_escapeHtml(tok)}</span>`;
    }
    // Number (int or float, optionally negative)
    if (/^-?\d+(\.\d+)?$/.test(tok)) {
      return `<span class="sh-num">${_escapeHtml(tok)}</span>`;
    }
    // Hex colour: #RRGGBB
    if (/^#[0-9a-fA-F]{3,8}$/.test(tok)) {
      return `<span class="sh-hex">${_escapeHtml(tok)}</span>`;
    }
    // Keyword parameter: key=value
    if (tok.includes('=')) {
      const [k, v] = tok.split('=', 2);
      return `<span class="sh-param">${_escapeHtml(k)}</span><span class="sh-arrow">=</span><span class="sh-paramval">${_escapeHtml(v)}</span>`;
    }
    // Comparison operators used in IF_VAR / WHILE_VAR
    if (['==','!=','<=','>=','<','>','contains','startswith','endswith'].includes(tok)) {
      return `<span class="sh-op">${_escapeHtml(tok)}</span>`;
    }
    // Default argument (template name, label name, etc.)
    return `<span class="sh-arg">${_escapeHtml(tok)}</span>`;
  });

  const argsHtml = argTokens.length ? ' ' + argTokens.join(' ') : '';
  return indent + cmdHtml + argsHtml;
}

function renderSyntaxHighlight() {
  const editor = document.getElementById('script-editor');
  const bg     = document.getElementById('syntax-bg');
  if (!editor || !bg) return;

  const lines = editor.value.split('\n');
  bg.innerHTML = lines.map(l => `<div class="sh-line">${_highlightLine(l)}</div>`).join('');
  bg.scrollTop  = editor.scrollTop;
  bg.scrollLeft = editor.scrollLeft;
}

function syncSyntaxScroll() {
  const editor = document.getElementById('script-editor');
  const bg     = document.getElementById('syntax-bg');
  if (editor && bg) {
    bg.scrollTop  = editor.scrollTop;
    bg.scrollLeft = editor.scrollLeft;
  }
}

// ══════════════════════════════════════════════════════════
//  AUTO-INDENT / FORMAT ENGINE
// ══════════════════════════════════════════════════════════

const _INDENT_OPENERS  = new Set([
  'IF_IMAGE','IF_NOT_IMAGE','LOOP','REPEAT','WHILE_IMAGE',
  'IF_VAR','WHILE_VAR','REPEAT_UNTIL','ON_ERROR',
]);
const _INDENT_CLOSERS  = new Set(['END']);
const _INDENT_MIDPOINT = new Set(['ELSE']);
const _INDENT_FLUSH    = new Set(['LABEL']);
const _INDENT_UNIT     = '  ';

function formatScript() {
  const editor = document.getElementById('script-editor');
  if (!editor) return;

  const raw   = editor.value;
  const lines = raw.split('\n');
  let depth   = 0;
  const out   = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) { out.push(trimmed); continue; }

    const cmd = trimmed.split(/\s+/)[0].toUpperCase();

    if (_INDENT_CLOSERS.has(cmd)) {
      depth = Math.max(0, depth - 1);
      out.push(_INDENT_UNIT.repeat(depth) + trimmed);
      continue;
    }
    if (_INDENT_MIDPOINT.has(cmd)) {
      out.push(_INDENT_UNIT.repeat(Math.max(0, depth - 1)) + trimmed);
      continue;
    }
    if (_INDENT_FLUSH.has(cmd)) { out.push(trimmed); continue; }

    out.push(_INDENT_UNIT.repeat(depth) + trimmed);
    if (_INDENT_OPENERS.has(cmd)) depth += 1;
  }

  const selStart  = editor.selectionStart;
  const oldLines  = raw.split('\n');
  let charCount = 0, cursorLine = 0;
  for (let i = 0; i < oldLines.length; i++) {
    charCount += oldLines[i].length + 1;
    if (charCount > selStart) { cursorLine = i; break; }
  }

  editor.value = out.join('\n');

  let newPos = 0;
  for (let i = 0; i < Math.min(cursorLine, out.length); i++) newPos += out[i].length + 1;
  editor.selectionStart = editor.selectionEnd = Math.min(newPos, editor.value.length);

  updateLineCount();
  renderScriptLines();
  renderSyntaxHighlight();
}

// ══════════════════════════════════════════════════════════
//  UNDO HISTORY
// ══════════════════════════════════════════════════════════

const _undoStack  = [];
const _UNDO_LIMIT = 100;

function _pushUndo() {
  const editor = document.getElementById('script-editor');
  if (!editor) return;
  _undoStack.push({ value: editor.value, selStart: editor.selectionStart, selEnd: editor.selectionEnd });
  if (_undoStack.length > _UNDO_LIMIT) _undoStack.shift();
}

function editorUndo() {
  if (_undoStack.length === 0) return;
  const editor = document.getElementById('script-editor');
  const state  = _undoStack.pop();
  editor.value = state.value;
  editor.selectionStart = state.selStart;
  editor.selectionEnd   = state.selEnd;
  editor.focus();
  updateLineCount();
  renderScriptLines();
  renderSyntaxHighlight();
}

document.addEventListener('keydown', (e) => {
  const editor = document.getElementById('script-editor');
  if (e.ctrlKey && e.key === 'z' && document.activeElement === editor) {
    e.preventDefault();
    editorUndo();
  }
}, { capture: true });

// ── INSERT TO EDITOR ───────────────────────────────────────
function insertToEditor(code, fromGuide) {
  // Allow inserts from the guide even while a script is running
  if (!fromGuide && _guardRunning('insert into the editor')) return;
  _pushUndo();
  const editor = document.getElementById('script-editor');
  const wasReadOnly = editor.readOnly;
  if (wasReadOnly) editor.readOnly = false;  // temporarily allow write from guide
  const start  = editor.selectionStart;
  const end    = editor.selectionEnd;
  const val    = editor.value;

  const before      = val.slice(0, start);
  const after       = val.slice(end);
  const needsBefore = before.length > 0 && !before.endsWith('\n');
  const needsAfter  = after.length  > 0 && !after.startsWith('\n');

  const insertion = (needsBefore ? '\n' : '') + code + (needsAfter ? '\n' : '');
  editor.value = before + insertion + after;

  const newPos = before.length + insertion.length;
  editor.selectionStart = editor.selectionEnd = newPos;
  if (wasReadOnly) editor.readOnly = true;  // restore
  editor.focus();
  updateLineCount();
  renderScriptLines();
  renderSyntaxHighlight();
}

// ══════════════════════════════════════════════════════════
//  EDITOR UI — line count, clear, example, tab/enter keys
// ══════════════════════════════════════════════════════════

function updateLineCount() {
  const editor  = document.getElementById('script-editor');
  const counter = document.getElementById('line-count');
  if (!editor || !counter) return;
  const val   = editor.value;
  const lines = val.split('\n').length;
  counter.textContent = `${lines} line${lines !== 1 ? 's' : ''}`;
  // ── Cursor position (Ln / Col) ────────────────────────────
  const posEl = document.getElementById('cursor-pos');
  if (posEl) {
    const pos    = editor.selectionStart ?? 0;
    const before = val.slice(0, pos);
    const ln     = before.split('\n').length;
    const col    = pos - before.lastIndexOf('\n');
    posEl.textContent = `Ln ${ln}, Col ${col}`;
  }
}

async function clearScript() {
  if (_guardRunning('clear the script')) return;
  const ok = await appConfirm({
    title:   'Clear Script',
    warning: 'All script content will be removed.',
    okLabel: 'Clear', icon: 'i-trash', kind: 'warn',
  });
  if (ok) {
    _pushUndo();
    document.getElementById('script-editor').value = '';
    updateLineCount();
    renderScriptLines();
    renderSyntaxHighlight();
  }
}

function loadExample() {
  if (_guardRunning('load an example script')) return;
  _pushUndo();
  document.getElementById('script-editor').value =
`# Example macro script
WAIT 1
CLICK 500 300
TYPE Hello World
PRESS enter
HOTKEY ctrl+c
SCROLL -3
DRAG 100 200 400 200
CLICK_IMAGE start_button
WAIT_IMAGE loading_screen 30
IF_IMAGE enemy.png
  PRESS space
ELSE
  WAIT 2
END
REPEAT 5
  CLICK 300 400
  WAIT 0.5
END
WHILE_IMAGE progress_bar
  WAIT 1
END
LABEL start
GOTO start`;
  updateLineCount();
  renderScriptLines();
  renderSyntaxHighlight();
}

function onEditorInput() {
    updateLineCount();
    renderScriptLines();
    renderSyntaxHighlight();
    scheduleValidation();   // re-validate after typing pauses
    const card = document.getElementById('welcome-card');
    if (card) {
        const empty = !document.getElementById('script-editor').value.trim();
        card.classList.toggle('hidden', !empty);
    }
    // Mark dirty
    if (!_scriptDirty) {
        _scriptDirty = true;
        updateFilenameDisplay();
        if (typeof _setUnsavedDot === 'function') _setUnsavedDot(true);
    }
}

function updateFilenameDisplay() {
    const el = document.getElementById('savload-filename');
    if (!el) return;
    let name = el.textContent.replace(/\*$/, ''); // remove existing asterisk
    if (_scriptDirty && name !== 'unsaved') {
        el.textContent = name + '*';
    } else {
        el.textContent = name;
    }
}

document.addEventListener('DOMContentLoaded', () => {
  const editor = document.getElementById('script-editor');
  if (editor) {
    editor.addEventListener('input',   updateLineCount);
    editor.addEventListener('keyup',   updateLineCount);
    editor.addEventListener('mouseup', updateLineCount);
    editor.addEventListener('select',  updateLineCount);
    editor.addEventListener('keydown', (e) => {
      if (e.key === 'z' && e.ctrlKey) return;

      if (e.key === 'Tab') {
        e.preventDefault();
        _pushUndo();
        const start = editor.selectionStart;
        const end   = editor.selectionEnd;
        editor.value = editor.value.slice(0, start) + _INDENT_UNIT + editor.value.slice(end);
        editor.selectionStart = editor.selectionEnd = start + _INDENT_UNIT.length;
        updateLineCount();
        renderScriptLines();
        renderSyntaxHighlight();
        return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        _pushUndo();
        const val   = editor.value;
        const pos   = editor.selectionStart;
        const lineStart   = val.lastIndexOf('\n', pos - 1) + 1;
        const currentLine = val.slice(lineStart, pos).trim();
        const currentCmd  = currentLine.split(/\s+/)[0]?.toUpperCase() || '';

        let prevLineText = '';
        let searchPos = lineStart - 1;
        while (searchPos > 0) {
          const ls = val.lastIndexOf('\n', searchPos - 1) + 1;
          prevLineText = val.slice(ls, searchPos).trim();
          if (prevLineText) break;
          searchPos = ls - 1;
        }
        const prevLine   = val.slice(val.lastIndexOf('\n', lineStart - 2) + 1, lineStart - 1);
        const prevIndent = prevLine.match(/^(\s*)/)[1];
        const prevCmd    = prevLine.trim().split(/\s+/)[0]?.toUpperCase() || '';

        let newIndent = prevIndent;
        if (_INDENT_OPENERS.has(prevCmd) || _INDENT_MIDPOINT.has(prevCmd)) {
          newIndent = prevIndent + _INDENT_UNIT;
        }
        if (_INDENT_CLOSERS.has(currentCmd)) {
          newIndent = prevIndent.slice(_INDENT_UNIT.length) || '';
        }

        const insertion = '\n' + newIndent;
        editor.value = val.slice(0, pos) + insertion + val.slice(editor.selectionEnd);
        editor.selectionStart = editor.selectionEnd = pos + insertion.length;
        updateLineCount();
        renderScriptLines();
        renderSyntaxHighlight();
        return;
      }

      if (!e.ctrlKey && !e.metaKey && (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete')) {
        _pushUndo();
      }
    });
    renderSyntaxHighlight();
  }
});

window.addEventListener('pywebviewready', () => {
  renderSyntaxHighlight();
});

// ── Toggle line panel ──────────────────────────────────────
function toggleLinePanel() {
  const panel   = document.getElementById('line-panel');
  const showBtn = document.getElementById('lp-show-btn');
  const editor  = document.getElementById('script-editor');
  const isHidden = panel.classList.contains('lp-panel-hidden');

  if (isHidden) {
    panel.classList.remove('lp-panel-hidden');
    if (showBtn) showBtn.classList.add('hidden');
    editor.style.borderRadius = '';
  } else {
    panel.classList.add('lp-panel-hidden');
    if (showBtn) showBtn.classList.remove('hidden');
    editor.style.borderRadius = '1.2rem';
  }
}

// ══════════════════════════════════════════════════════════
//  SCRIPT LINE PANEL — edit / delete / drag to reorder
// ══════════════════════════════════════════════════════════

let _dragSrcIdx = null;

function renderScriptLines() {
  const editor = document.getElementById('script-editor');
  const panel  = document.getElementById('lp-rows');
  if (!panel) return;

  const rawLines = editor.value.split('\n');
  panel.innerHTML = rawLines.map((line, i) => {
    const isEmpty        = line.trim() === '';
    const isComment      = line.trim().startsWith('#');
    const hasBp          = window._breakpoints && window._breakpoints.has(i);
    let cls              = isEmpty ? 'lp-row lp-empty' : isComment ? 'lp-row lp-comment' : 'lp-row';
    if (hasBp) cls      += ' lp-breakpoint';
    // Visible red dot rendered as an inline element — never clipped
    const dotHtml        = hasBp
      ? '<span class="lp-bp-dot" title="Breakpoint set — click number to remove"></span>'
      : '<span class="lp-bp-dot-ph"></span>'; // placeholder keeps layout stable
    return `<div class="${cls}" draggable="true"
      ondragstart="lpDragStart(event,${i})"
      ondragover="lpDragOver(event,${i})"
      ondrop="lpDrop(event,${i})"
      ondragend="lpDragEnd()"
      data-idx="${i}">
      ${dotHtml}
      <span class="lp-num" onclick="toggleBreakpoint(${i})" title="Click to set/remove breakpoint on line ${i+1}">${i+1}</span>
      <span class="lp-drag">⠿</span>
      <div class="lp-btns">
        ${isEmpty ? '' : `<button class="lp-btn lp-edit" onclick="lpEdit(${i})" title="Edit line">✏️</button>`}
        <button class="lp-btn lp-del" onclick="lpDelete(${i})" title="Delete line">🗑</button>
      </div>
    </div>`;
  }).join('');

  const scrollContainer = document.getElementById('line-panel');
  const firstRow = panel.querySelector('.lp-row');
  if (firstRow && scrollContainer) {
    const lh = firstRow.offsetHeight || 22;
    scrollContainer.scrollTop = editor.scrollTop * (lh / parseFloat(getComputedStyle(editor).lineHeight || 22));
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const editor = document.getElementById('script-editor');
  const panel  = document.getElementById('line-panel');
  if (editor && panel) {
    editor.addEventListener('scroll', () => {
      const ratio = editor.scrollTop / (editor.scrollHeight - editor.clientHeight || 1);
      panel.scrollTop = ratio * (panel.scrollHeight - panel.clientHeight);
    });
  }
  renderScriptLines();
});

let _editLineIdx = null;

function lpEdit(idx) {
  if (_guardRunning('edit a script line')) return;
  const editor = document.getElementById('script-editor');
  const lines  = editor.value.split('\n');
  const raw    = lines[idx] || '';
  _editLineIdx = idx;

  // Try to open the right builder modal pre-filled with this line's values.
  // _openBuilderModalForEdit is defined in builder.js and returns true if it
  // handled the line (so we skip the plain-text fallback).
  if (typeof _openBuilderModalForEdit === 'function' && _openBuilderModalForEdit(raw)) {
    return;
  }

  // Fallback: plain single-line text editor
  document.getElementById('line-edit-input').value = raw;
  document.getElementById('line-edit-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('line-edit-input').focus(), 50);
}

function lineEditSave() {
  if (_guardRunning('edit a script line')) return;
  if (_editLineIdx === null) return;
  _pushUndo();
  const newVal = document.getElementById('line-edit-input').value;
  const editor = document.getElementById('script-editor');
  const lines  = editor.value.split('\n');
  lines[_editLineIdx] = newVal;
  editor.value = lines.join('\n');
  updateLineCount();
  renderScriptLines();
  renderSyntaxHighlight();
  lineEditCancel();
  toast('Line updated', 'info');
}

function lineEditCancel() {
  document.getElementById('line-edit-overlay').classList.add('hidden');
  _editLineIdx = null;
}

function lpDelete(idx) {
  if (_guardRunning('delete a script line')) return;
  _pushUndo();
  const editor = document.getElementById('script-editor');
  const lines  = editor.value.split('\n');
  lines.splice(idx, 1);
  editor.value = lines.join('\n');
  updateLineCount();
  renderScriptLines();
  renderSyntaxHighlight();
}

function lpDragStart(e, idx) {
  _dragSrcIdx = idx;
  e.dataTransfer.effectAllowed = 'move';
  e.currentTarget.classList.add('lp-dragging');
}

function lpDragOver(e, idx) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.lp-row').forEach(r => r.classList.remove('lp-drag-over'));
  document.querySelectorAll('.lp-row')[idx]?.classList.add('lp-drag-over');
}

function lpDrop(e, idx) {
  e.preventDefault();
  if (_guardRunning('reorder script lines')) return;
  if (_dragSrcIdx === null || _dragSrcIdx === idx) return;
  _pushUndo();
  const editor = document.getElementById('script-editor');
  const lines  = editor.value.split('\n');
  const [moved] = lines.splice(_dragSrcIdx, 1);
  lines.splice(idx, 0, moved);
  editor.value = lines.join('\n');
  updateLineCount();
  renderScriptLines();
  renderSyntaxHighlight();
  toast('Line moved', 'info');
}

function lpDragEnd() {
  _dragSrcIdx = null;
  document.querySelectorAll('.lp-row').forEach(r => {
    r.classList.remove('lp-dragging', 'lp-drag-over');
  });
}

// ══════════════════════════════════════════════════════════
//  SAVE / LOAD SCRIPTS
// ══════════════════════════════════════════════════════════

let _currentFilePath = null;
let _scriptDirty = false;

function _setCurrentFile(name, path) {
    _currentFilePath = path || null;
    _scriptDirty = false;
    const el = document.getElementById('savload-filename');
    if (el) el.textContent = name || 'unsaved';
    const quickBtn = document.getElementById('btn-quick-save');
    if (quickBtn) quickBtn.disabled = !path;
    if (typeof _setUnsavedDot === 'function') _setUnsavedDot(false);
}

async function saveScriptDialog() {
  if (!checkApi()) return;
  const content = document.getElementById('script-editor').value;
  if (!content.trim()) { toast('Script is empty', 'warn'); return; }
  try {
    const r = await withLoading(window.pywebview.api.save_file_dialog(content), 'Saving script...');
    if (r.status === 'ok') {
      _setCurrentFile(r.name, r.path);
      const tpl = r.templates_bundled > 0
        ? ` + ${r.templates_bundled} template${r.templates_bundled > 1 ? 's' : ''}` : '';
      toast(`💾 Saved: ${r.name}${tpl}`, 'info');
    } else if (r.status !== 'cancelled') {
      toast(`Save failed: ${r.message}`, 'error');
    }
  } catch(e) { toast(`Error: ${e}`, 'error'); }
}

async function saveScriptQuick() {
  if (!checkApi() || !_currentFilePath) return;
  const content = document.getElementById('script-editor').value;
  if (!content.trim()) { toast('Script is empty', 'warn'); return; }
  try {
    const r = await withLoading(window.pywebview.api.save_file_dialog_path(_currentFilePath, content), 'Saving script...');
    if (r && r.status === 'ok') {
      const tpl = r.templates_bundled > 0
        ? ` + ${r.templates_bundled} template${r.templates_bundled > 1 ? 's' : ''}` : '';
      toast(`💾 Saved${tpl}`, 'info');
    } else {
      await saveScriptDialog();
    }
  } catch(e) { await saveScriptDialog(); }
}

async function loadScriptDialog() {
    if (_guardRunning('load a script')) return;
    if (!checkApi()) return;
    try {
        const r = await withLoading(window.pywebview.api.open_file_dialog(), 'Opening script...');
        if (r.status === 'ok') {
            document.getElementById('script-editor').value = r.content;
            formatScript();
            updateLineCount();
            renderScriptLines();
            renderSyntaxHighlight();
            _setCurrentFile(r.name, r.path);
            const tpl = r.templates_restored > 0
                ? ` (${r.templates_restored} template${r.templates_restored > 1 ? 's' : ''} restored)` : '';
            toast(`📂 Opened: ${r.name}${tpl}`, 'info');

            // Clear undo stack and push the new content as the first state
            _undoStack.length = 0;
            _pushUndo();   // push the current content
        } else if (r.status === 'error') {
            toast(`Open failed: ${r.message}`, 'error');
        }
    } catch(e) { toast(`Error: ${e}`, 'error'); }
}
// ══════════════════════════════════════════════════════════
//  SETTINGS — SHORTCUTS
// ══════════════════════════════════════════════════════════

let _shortcutCapturing = null;

async function loadSettings() {
  if (!checkApi()) return;
  try {
    const s = await withLoading(window.pywebview.api.get_settings());
    document.getElementById('auto-learning-checkbox').checked = s.auto_learning_enabled !== false;
    document.getElementById('shortcut-play').value  = s.shortcut_play  || 'ctrl+r';
    document.getElementById('shortcut-stop').value  = s.shortcut_stop  || 'ctrl+q';
    document.getElementById('shortcut-pause').value = s.shortcut_pause || 'ctrl+p';
    document.getElementById('log-cooldown').value   = s.log_cooldown   || 10.0;
    updateShortcutBar(s);
  } catch(e) { console.warn('loadSettings error:', e); }
}

function updateShortcutBar(s) {
  const play  = (s.shortcut_play  || 'ctrl+r').toUpperCase();
  const stop  = (s.shortcut_stop  || 'ctrl+q').toUpperCase();
  const pause = (s.shortcut_pause || 'ctrl+p').toUpperCase();

  document.getElementById('sb-play').textContent  = `▶ Play: ${play}`;
  document.getElementById('sb-stop').textContent  = `⬛ Stop: ${stop}`;
  document.getElementById('sb-pause').textContent = `⏸ Pause: ${pause}`;

  // ── Patch button title + data-tip attrs with live shortcut hint ─
  const runBtn   = document.querySelector('.ctrl-run-btn');
  const stopBtn  = document.querySelector('.btn-stop');
  const pauseBtn = document.getElementById('btn-pause-script');

  if (runBtn) {
    runBtn.title            = `Run the full script  [${play}]`;
    runBtn.dataset.tip      = `Run script  [${play}]`;
  }
  if (stopBtn) {
    stopBtn.title           = `Stop the running script immediately  [${stop}]`;
    stopBtn.dataset.tip     = `Stop script  [${stop}]`;
  }
  if (pauseBtn) {
    pauseBtn.title          = `Pause or resume a running script  [${pause}]`;
    pauseBtn.dataset.tip    = `Pause / resume  [${pause}]`;
  }
}

async function saveSettings() {
  if (!checkApi()) return;
  const settings = {
    shortcut_play:  document.getElementById('shortcut-play').value  || 'ctrl+r',
    shortcut_stop:  document.getElementById('shortcut-stop').value  || 'ctrl+q',
    shortcut_pause: document.getElementById('shortcut-pause').value || 'ctrl+p',
    auto_learning_enabled: document.getElementById('auto-learning-checkbox').checked,
    log_cooldown: parseFloat(document.getElementById('log-cooldown').value) || 10.0,
  };
  try {
    await withLoading(window.pywebview.api.save_settings(settings));
    updateShortcutBar(settings);
    const el = document.getElementById('settings-status');
    el.textContent = '✅ Settings saved!';
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 3000);
    toast('Settings saved!', 'info');
  } catch(e) { toast(`Error: ${e}`, 'error'); }
}

function captureShortcut(inputId) {
  _shortcutCapturing = inputId;
  const inp = document.getElementById(inputId);
  inp.value = '\u2328 Press shortcut...';
  inp.classList.add('capturing');

  // Keys WebView2 intercepts before JS can see them when pressed alone.
  // They work fine WITH a modifier (Ctrl+F5 etc.) because the browser
  // doesn't treat those as its own shortcuts.
  const WEBVIEW_RESERVED = new Set(['f5', 'f11', 'f12']);

  // Cancel capture on Escape
  const cleanup = () => {
    inp.classList.remove('capturing');
    _shortcutCapturing = null;
    document.removeEventListener('keydown', handler, { capture: true });
  };

  const handler = (e) => {
    e.preventDefault();
    e.stopPropagation();

    const key = e.key.toLowerCase();

    // Escape cancels — restore previous value
    if (key === 'escape') {
      inp.value = inp.dataset.prev || '';
      cleanup();
      return;
    }

    // Ignore bare modifier keypresses — keep listening
    if (['control', 'alt', 'shift', 'meta'].includes(key)) return;

    const parts = [];
    if (e.ctrlKey)  parts.push('ctrl');
    if (e.altKey)   parts.push('alt');
    if (e.shiftKey) parts.push('shift');
    parts.push(key === ' ' ? 'space' : key);

    // Single function keys reserved by WebView2 can't be captured alone.
    // Warn and keep listening so the user can try a modifier combo.
    if (WEBVIEW_RESERVED.has(key) && parts.length === 1) {
      inp.value = `\u26A0 ${key.toUpperCase()} is reserved — add Ctrl or Alt`;
      setTimeout(() => { inp.value = '\u2328 Press shortcut...'; }, 2000);
      return;
    }

    inp.value = parts.join('+');
    cleanup();
  };

  // Store previous value so Escape can restore it
  inp.dataset.prev = inp.value !== '\u2328 Press shortcut...' ? inp.value : '';
  document.addEventListener('keydown', handler, { capture: true });
}

function resetShortcut(inputId, defaultVal) {
  document.getElementById(inputId).value = defaultVal;
  document.getElementById(inputId).classList.remove('capturing');
}

function globalHotkeyPlay()  { if (!isRunning) runScript(); }
function globalHotkeyStop()  { stopMacro(); }
function globalHotkeyPause() {
  const btn = document.getElementById('btn-pause-script');
  if (btn && !btn.disabled) togglePauseScript();
}

// ── RUN FROM CURSOR ───────────────────────────────────────

function _getCursorLineNumber() {
  const editor = document.getElementById('script-editor');
  if (!editor) return 0;
  const pos  = editor.selectionStart;
  const text = editor.value.slice(0, pos);
  return text.split('\n').length - 1;  // 0-based
}

async function runFromCursor() {
  if (!checkApi()) return;
  if (isRunning) { toast('Stop the current script first', 'warn'); return; }
  const editor = document.getElementById('script-editor');
  if (!editor) return;
  const script = editor.value.trim();
  if (!script) { toast('Script is empty', 'warn'); return; }

  const line = _getCursorLineNumber();

  // Show which line we're starting from
  const lineNum = line + 1;
  toast(`Running from line ${lineNum}…`, 'info');

  document.querySelectorAll('.sh-line.error-line').forEach(el => el.classList.remove('error-line'));
  _clearValidationMarkers();

  const _repeatRaw = parseInt(document.getElementById('repeat-count').value);
  const repeatVal  = isNaN(_repeatRaw) || _repeatRaw < 0 ? 1 : _repeatRaw;

  isRunning = true;
  _setRunningLockUI(true);
  setStatus('running', `Running from line ${lineNum}…`);
  document.getElementById('script-status').textContent = `⟳ Running from line ${lineNum}…`;
  document.getElementById('btn-pause-script').disabled = false;

  try {
    const result = await withLoading(
      window.pywebview.api.run_script_from_line(script, line, repeatVal)
    );
    if (result && result.status === 'running') {
      window.pywebview.api.show_indicator().catch(() => {});
    }
  } catch(e) {
    toast(`Error: ${e}`, 'error');
    setStatus('idle', 'Idle');
    isRunning = false;
    _setRunningLockUI(false);
  }
}

// ── EDITOR CONTEXT MENU ───────────────────────────────────

function _buildEditorContextMenu(e) {
  // Remove any existing
  document.getElementById('editor-ctx-menu')?.remove();

  const menu = document.createElement('div');
  menu.id = 'editor-ctx-menu';
  menu.style.cssText = `
    position:fixed;left:${e.clientX}px;top:${e.clientY}px;
    background:var(--color-background-secondary);
    border:1px solid var(--color-border-secondary);
    border-radius:8px;padding:4px 0;min-width:200px;
    box-shadow:0 4px 16px rgba(0,0,0,0.18);z-index:2800;font-size:13px;
  `;

  const line = _getCursorLineNumber() + 1;
  const items = [
    { label: `▶  Run from line ${line}`,  fn: 'runFromCursor()',  bold: true  },
    { label: '─────────────────────',     fn: null,               sep: true   },
    { label: '✂  Cut',                    fn: 'document.execCommand("cut")'   },
    { label: '⎘  Copy',                   fn: 'document.execCommand("copy")'  },
    { label: '⎗  Paste',                  fn: 'document.execCommand("paste")' },
    { label: '─────────────────────',     fn: null,               sep: true   },
    { label: '🔍  Find / Replace',         fn: 'openFindReplace(false)'        },
  ];

  items.forEach(({ label, fn, bold, sep }) => {
    if (sep) {
      const d = document.createElement('div');
      d.style.cssText = 'height:1px;background:var(--color-border-tertiary);margin:3px 0;pointer-events:none';
      menu.appendChild(d);
      return;
    }
    const item = document.createElement('div');
    item.textContent = label;
    item.style.cssText = `
      padding:7px 16px;cursor:pointer;border-radius:4px;margin:0 4px;
      color:${bold ? 'var(--color-text-info)' : 'var(--color-text-primary)'};
      font-weight:${bold ? '600' : '400'};
    `;
    item.onmouseenter = () => item.style.background = 'var(--color-background-primary)';
    item.onmouseleave = () => item.style.background = '';
    item.onmousedown  = (ev) => {
      ev.preventDefault();
      menu.remove();
      // eslint-disable-next-line no-eval
      try { eval(fn); } catch(err) { console.warn('ctx menu error:', err); }
    };
    menu.appendChild(item);
  });

  document.body.appendChild(menu);

  // Close on click outside
  const close = (ev) => {
    if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', close); }
  };
  setTimeout(() => document.addEventListener('mousedown', close), 10);
}

window.addEventListener('pywebviewready', () => {
  loadSettings();
  _loadAcTemplates();

  // Hide splash screen
  const splash = document.getElementById('app-splash');
  if (splash) {
    splash.style.opacity = '0';
    splash.style.visibility = 'hidden';
    setTimeout(() => splash.remove(), 550);
  }

  // ── Autosave every 30 seconds ──────────────────────────
  // Saves to storage/scripts/_autosave.txt whenever the script
  // is dirty (changed since last save). Restores on next launch
  // if the previous session ended with unsaved changes.
  _restoreAutosave();
  setInterval(_autosave, 30_000);

  // Hide thumbnail + context menu whenever any modal overlay opens
  const _overlayObserver = new MutationObserver(() => {
    const anyOpen = document.querySelector(
      '.cfg-overlay:not(.hidden), .cs-overlay:not(.hidden), .key-overlay:not(.hidden)'
    );
    if (anyOpen) {
      _hideThumbnailPreview();
      document.getElementById('editor-ctx-menu')?.remove();
    }
  });
  _overlayObserver.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
});

// ── AUTOSAVE ──────────────────────────────────────────────────────────────
// Saves to storage/scripts/_autosave.txt every 30s when script is dirty.
// On launch, if an autosave exists it offers to restore it.

const _AUTOSAVE_NAME = '_autosave';

async function _autosave() {
  if (!window.pywebview?.api) return;
  const editor = document.getElementById('script-editor');
  if (!editor) return;
  const content = editor.value;
  if (!content.trim()) return;           // nothing to save
  if (!_scriptDirty) return;             // no changes since last save
  try {
    await window.pywebview.api.save_script(_AUTOSAVE_NAME, content);
  } catch(e) {
    console.warn('Autosave failed:', e);
  }
}

async function _restoreAutosave() {
  if (!window.pywebview?.api) return;
  try {
    const r = await window.pywebview.api.load_script(_AUTOSAVE_NAME);
    if (r.status !== 'ok' || !r.content?.trim()) return;

    // Only offer restore if editor is currently empty
    const editor = document.getElementById('script-editor');
    if (!editor || editor.value.trim()) return;

    // Remove any existing banner
    document.getElementById('autosave-banner')?.remove();

    const banner = document.createElement('div');
    banner.id = 'autosave-banner';
    banner.className = 'autosave-banner';
    banner.innerHTML = `
      <svg style="width:16px;height:16px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
      <span>Unsaved script recovered from your last session.</span>
      <button class="banner-restore" onclick="_applyAutosave()">&#8635; Restore</button>
      <button class="banner-dismiss" onclick="document.getElementById('autosave-banner')?.remove()">Dismiss</button>
    `;
    document.body.appendChild(banner);

    // Store content for restore
    banner._content = r.content;
  } catch(e) {}
}

async function _applyAutosave() {
  const banner = document.getElementById('autosave-banner');
  if (!banner) return;
  const content = banner._content;
  banner.remove();
  if (!content) return;
  const editor = document.getElementById('script-editor');
  if (!editor) return;
  _pushUndo();
  editor.value = content;
  _scriptDirty = true;
  updateLineCount();
  renderScriptLines();
  renderSyntaxHighlight();
  toast('Script restored from autosave', 'info');
}

// slide-up keyframe for banner
(function() {
  const s = document.createElement('style');
  s.textContent = '@keyframes slideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}';
  document.head.appendChild(s);
})();

// ── THUMBNAIL HOVER PREVIEW ───────────────────────────────

const _THUMB_COMMANDS = new Set([
  'CLICK_IMAGE','DOUBLE_CLICK_IMAGE','RIGHT_CLICK_IMAGE',
  'WAIT_IMAGE','WAIT_IMAGE_GONE',
  'FIND_CLICK','FIND_DOUBLE_CLICK','FIND_RIGHT_CLICK',
  'FIND_MOVE','FIND_HOLD','FIND_DRAG',
  'NAVIGATE_TO_IMAGE','IF_IMAGE','IF_NOT_IMAGE','WHILE_IMAGE',
]);

let _thumbCache = {};   // template name → base64 data URL
let _thumbVisible = false;

function _getThumbEl(editorWrap) {
  // Keep thumbnail in body but clamp its position to stay within editor bounds visually
  let el = document.getElementById('editor-thumb-preview');
  if (!el) {
    el = document.createElement('div');
    el.id = 'editor-thumb-preview';
    el.style.cssText = `
      position:fixed;z-index:2500;pointer-events:none;
      background:var(--color-background-secondary);
      border:1px solid var(--color-border-secondary);
      border-radius:10px;padding:8px;
      box-shadow:0 4px 20px rgba(0,0,0,0.22);
      display:none;flex-direction:column;align-items:center;gap:6px;
      max-width:210px;
    `;
    el.innerHTML = `
      <img id="editor-thumb-img" style="max-width:190px;max-height:140px;border-radius:6px;display:block;object-fit:contain"/>
      <div id="editor-thumb-label" style="font-size:11px;color:var(--color-text-secondary);text-align:center;word-break:break-all"></div>
      <div id="editor-thumb-size" style="font-size:10px;color:var(--color-text-secondary)"></div>
    `;
    document.body.appendChild(el);
  }
  return el;
}

function _hideThumbnailPreview() {
  _thumbVisible = false;
  const el = document.getElementById('editor-thumb-preview');
  if (el) el.style.display = 'none';
}

async function _checkThumbnailHover(mouseEvt, editor) {
  if (!window.pywebview?.api) return;

  // Get character position from mouse coordinates using a mirror div
  const rect = editor.getBoundingClientRect();
  const style = getComputedStyle(editor);
  const lineH = parseFloat(style.lineHeight) || 20;
  const paddingTop = parseFloat(style.paddingTop) || 0;
  const paddingLeft = parseFloat(style.paddingLeft) || 0;

  // Estimate which line + col the mouse is over
  const relY = mouseEvt.clientY - rect.top + editor.scrollTop - paddingTop;
  const relX = mouseEvt.clientX - rect.left - paddingLeft;
  const lineIndex = Math.floor(relY / lineH);
  const lines = editor.value.split('\n');
  if (lineIndex < 0 || lineIndex >= lines.length) { _hideThumbnailPreview(); return; }

  const lineText = lines[lineIndex];
  const charW = parseFloat(style.fontSize) * 0.6; // rough char width
  const colIndex = Math.floor(relX / charW);

  // Find word at that column
  let start = colIndex, end = colIndex;
  while (start > 0 && /\S/.test(lineText[start - 1])) start--;
  while (end < lineText.length && /\S/.test(lineText[end])) end++;
  const word = lineText.slice(start, end);
  if (!word) { _hideThumbnailPreview(); return; }

  // Check if this line starts with a template command
  const parts = lineText.trim().split(/\s+/);
  const cmd = parts[0]?.toUpperCase();
  if (!_THUMB_COMMANDS.has(cmd)) { _hideThumbnailPreview(); return; }

  // The template name should be the second token
  const tplToken = parts[1];
  if (!tplToken || word.toUpperCase() === cmd) { _hideThumbnailPreview(); return; }

  // Only show preview if mouse is over the template token
  if (word !== tplToken) { _hideThumbnailPreview(); return; }

  const tplName = tplToken.replace(/\.png$/i, '');

  // Check template exists in our list
  if (_acTemplates.length && !_acTemplates.includes(tplName)) {
    _hideThumbnailPreview(); return;
  }

  // Load thumbnail (cached)
  let dataUrl = _thumbCache[tplName];
  if (!dataUrl) {
    try {
      const r = await window.pywebview.api.get_template_preview(tplName);
      if (!r || r.status !== 'ok') { _hideThumbnailPreview(); return; }
      dataUrl = r.data;
      _thumbCache[tplName] = dataUrl;
    } catch(e) { _hideThumbnailPreview(); return; }
  }

  // Show the preview — positioned with fixed coords, clamped to editor bounds
  const editorWrap = editor.closest('.editor-wrap') || editor.parentElement;
  const el = _getThumbEl(editorWrap);
  const img = document.getElementById('editor-thumb-img');
  const lbl = document.getElementById('editor-thumb-label');
  const sz  = document.getElementById('editor-thumb-size');

  img.src = dataUrl;
  lbl.textContent = tplName + '.png';
  img.onload = () => { sz.textContent = `${img.naturalWidth} × ${img.naturalHeight}px`; };

  // Clamp position to stay within the editor bounding rect
  const wrapRect = editorWrap.getBoundingClientRect();
  const tipW = 214, tipH = 200;

  // Try right of cursor, flip left if overflows editor right edge
  let left = mouseEvt.clientX + 14;
  if (left + tipW > wrapRect.right - 6) left = mouseEvt.clientX - tipW - 10;
  left = Math.max(wrapRect.left + 4, Math.min(left, wrapRect.right - tipW - 4));

  // Try above cursor, flip below if overflows editor top edge
  let top = mouseEvt.clientY - tipH - 10;
  if (top < wrapRect.top + 4) top = mouseEvt.clientY + 20;
  top = Math.max(wrapRect.top + 4, Math.min(top, wrapRect.bottom - tipH - 4));

  el.style.left    = left + 'px';
  el.style.top     = top  + 'px';
  el.style.display = 'flex';
  _thumbVisible = true;
}


// ══════════════════════════════════════════════════════════
//  VALIDATION MARKERS — gutter dots + squiggly underlines
// ══════════════════════════════════════════════════════════

let _validationIssues = [];

function _clearValidationMarkers() {
  _validationIssues = [];
  // Remove gutter markers
  document.querySelectorAll('.lp-row .lp-validation-dot').forEach(el => el.remove());
  // Remove error/warning lines from syntax overlay
  document.querySelectorAll('.sh-line.validation-error, .sh-line.validation-warning')
    .forEach(el => {
      el.classList.remove('validation-error', 'validation-warning');
    });
}

function _showValidationMarkers(issues) {
  _validationIssues = issues;

  // Mark syntax overlay lines
  const bg = document.getElementById('syntax-bg');
  if (bg) {
    const shLines = bg.querySelectorAll('.sh-line');
    issues.forEach(issue => {
      const ln = shLines[issue.line];
      if (ln) ln.classList.add(issue.severity === 'error' ? 'validation-error' : 'validation-warning');
    });
  }

  // Add gutter dots to line panel rows
  const lpRows = document.querySelectorAll('.lp-row');
  issues.forEach(issue => {
    const row = lpRows[issue.line];
    if (!row) return;
    // Remove existing dot on this row
    row.querySelector('.lp-validation-dot')?.remove();
    const dot = document.createElement('span');
    dot.className = `lp-validation-dot lp-vdot-${issue.severity}`;
    dot.title = issue.message;
    // Insert after the bp-dot placeholder
    const ph = row.querySelector('.lp-bp-dot-ph, .lp-bp-dot');
    if (ph) ph.after(dot);
    else row.prepend(dot);
  });
}

// Re-validate on editor changes (debounced 1.5s)
let _validateTimer = null;
function scheduleValidation() {
  if (_validateTimer) clearTimeout(_validateTimer);
  _validateTimer = setTimeout(async () => {
    if (!window.pywebview?.api?.validate_script) return;
    const script = document.getElementById('script-editor')?.value?.trim();
    if (!script) { _clearValidationMarkers(); return; }
    try {
      const v = await window.pywebview.api.validate_script(script);
      _clearValidationMarkers();
      if (v?.issues?.length) _showValidationMarkers(v.issues);
    } catch(e) {}
  }, 1500);
}

// ══════════════════════════════════════════════════════════
//  AUTO-COMPLETE
// ══════════════════════════════════════════════════════════

const AC_COMMANDS = [
  // Mouse
  { cmd: 'CLICK',                   hint: 'x y',                       cat: 'mouse'    },
  { cmd: 'DOUBLE_CLICK',            hint: 'x y',                       cat: 'mouse'    },
  { cmd: 'RIGHT_CLICK',             hint: 'x y',                       cat: 'mouse'    },
  { cmd: 'MOVE',                    hint: 'x y',                       cat: 'mouse'    },
  { cmd: 'MOVE_HUMAN',              hint: 'x y',                       cat: 'mouse'    },
  { cmd: 'SCROLL',                  hint: 'amount',                    cat: 'mouse'    },
  { cmd: 'DRAG',                    hint: 'x1 y1 x2 y2',              cat: 'mouse'    },
  // Keyboard
  { cmd: 'TYPE',                    hint: 'text',                      cat: 'key'      },
  { cmd: 'PRESS',                   hint: 'key',                       cat: 'key'      },
  { cmd: 'HOLD',                    hint: 'key',                       cat: 'key'      },
  { cmd: 'RELEASE',                 hint: 'key',                       cat: 'key'      },
  { cmd: 'HOTKEY',                  hint: 'ctrl+c',                    cat: 'key'      },
  // Image
  { cmd: 'CLICK_IMAGE',             hint: 'template',                  cat: 'img'      },
  { cmd: 'DOUBLE_CLICK_IMAGE',      hint: 'template',                  cat: 'img'      },
  { cmd: 'RIGHT_CLICK_IMAGE',       hint: 'template',                  cat: 'img'      },
  { cmd: 'WAIT_IMAGE',              hint: 'template [timeout]',        cat: 'img'      },
  { cmd: 'WAIT_IMAGE_GONE',         hint: 'template [timeout]',        cat: 'img'      },
  { cmd: 'FIND_CLICK',              hint: 'template',                  cat: 'findimg'  },
  { cmd: 'FIND_DOUBLE_CLICK',       hint: 'template',                  cat: 'findimg'  },
  { cmd: 'FIND_RIGHT_CLICK',        hint: 'template',                  cat: 'findimg'  },
  { cmd: 'FIND_MOVE',               hint: 'template',                  cat: 'findimg'  },
  { cmd: 'NAVIGATE_TO_IMAGE',       hint: 'template',                  cat: 'img'      },
  { cmd: 'CLICK_RANDOM_OFFSET',     hint: 'template [dx] [dy]',        cat: 'img'      },
  // OCR
  { cmd: 'TEXT_CLICK',              hint: '"text"',                    cat: 'ocr'      },
  { cmd: 'TEXT_DOUBLE_CLICK',       hint: '"text"',                    cat: 'ocr'      },
  { cmd: 'TEXT_RIGHT_CLICK',        hint: '"text"',                    cat: 'ocr'      },
  { cmd: 'TEXT_MOVE',               hint: '"text"',                    cat: 'ocr'      },
  { cmd: 'READ_TEXT',               hint: 'region -> $var',            cat: 'ocr'      },
  // Color
  { cmd: 'COLOR_CLICK',             hint: '#RRGGBB [tolerance]',       cat: 'colordet' },
  { cmd: 'WAIT_COLOR',              hint: '#RRGGBB [timeout]',         cat: 'colordet' },
  { cmd: 'READ_COLOR',              hint: 'x y -> $var',               cat: 'colordet' },
  // Flow
  { cmd: 'WAIT',                    hint: 'seconds',                   cat: 'wait'     },
  { cmd: 'WAIT_RANDOM',             hint: 'min max',                   cat: 'waitrandom'},
  { cmd: 'REPEAT',                  hint: 'count',                     cat: 'flow'     },
  { cmd: 'LOOP',                    hint: '',                          cat: 'flow'     },
  { cmd: 'END',                     hint: '',                          cat: 'flow'     },
  { cmd: 'ELSE',                    hint: '',                          cat: 'flow'     },
  { cmd: 'SET',                     hint: '$var = value',              cat: 'flow'     },
  { cmd: 'REPEAT_UNTIL',            hint: '$var == value',             cat: 'flow'     },
  // Conditions
  { cmd: 'IF_IMAGE',                hint: 'template',                  cat: 'cond'     },
  { cmd: 'IF_NOT_IMAGE',            hint: 'template',                  cat: 'cond'     },
  { cmd: 'IF_VAR',                  hint: '$var == value',             cat: 'cond'     },
  { cmd: 'WHILE_IMAGE',             hint: 'template',                  cat: 'cond'     },
  { cmd: 'WHILE_VAR',               hint: '$var == value',             cat: 'cond'     },
  // Control
  { cmd: 'STOP',                    hint: '',                          cat: 'stop'     },
  { cmd: 'PAUSE_SCRIPT',            hint: '',                          cat: 'pause'    },
  { cmd: 'TOAST',                   hint: '"message" [info|warn|error]', cat: 'toast'    },
  { cmd: 'LABEL',                   hint: 'name',                        cat: 'label'    },
  { cmd: 'GOTO',                    hint: 'label_name',                  cat: 'goto'     },
  { cmd: 'ON_ERROR',                hint: '',                            cat: 'onerror'  },
  // Clipboard
  { cmd: 'CLIPBOARD_SET',           hint: '"text"',                      cat: 'clip'     },
  { cmd: 'CLIPBOARD_GET',           hint: '-> $var',                     cat: 'clip'     },
  { cmd: 'CLIPBOARD_COPY',          hint: '',                            cat: 'clip'     },
  { cmd: 'CLIPBOARD_PASTE',         hint: '',                            cat: 'clip'     },
];

// Commands that need a template name as their first argument
const AC_NEEDS_TEMPLATE = new Set([
  'CLICK_IMAGE','DOUBLE_CLICK_IMAGE','RIGHT_CLICK_IMAGE',
  'WAIT_IMAGE','WAIT_IMAGE_GONE',
  'FIND_CLICK','FIND_DOUBLE_CLICK','FIND_RIGHT_CLICK','FIND_MOVE','FIND_HOLD','FIND_DRAG',
  'NAVIGATE_TO_IMAGE','IF_IMAGE','IF_NOT_IMAGE','WHILE_IMAGE',
]);

// Template names loaded from backend
let _acTemplates = [];
async function _loadAcTemplates() {
  try {
    if (!window.pywebview?.api) return;
    const r = await window.pywebview.api.get_templates();
    _acTemplates = (r.templates || [])
      .map(t => t.name.replace(/\.png$/i, ''))
      .sort();
  } catch(e) {}
}


let _acVisible   = false;
let _acIndex     = -1;
let _acMatches   = [];
let _acWordStart = 0;

function _getAcDropdown() {
  let el = document.getElementById('ac-dropdown');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ac-dropdown';
    el.className = 'ac-dropdown';
    document.body.appendChild(el);
    el.addEventListener('mousedown', e => e.preventDefault()); // prevent blur
  }
  return el;
}

function _hideAc() {
  _acVisible = false;
  _acMatches = [];
  _acIndex   = -1;
  const el = document.getElementById('ac-dropdown');
  if (el) el.classList.remove('ac-visible');
}

function _showAc(matches, wordStart, editor, isTplMode) {
  if (!matches.length) { _hideAc(); return; }
  _acVisible   = true;
  _acMatches   = matches;
  _acIndex     = 0;
  _acWordStart = wordStart;

  const drop = _getAcDropdown();

  if (isTplMode) {
    // Template name suggestions — show with small thumbnail
    drop.innerHTML = matches.map((m, i) => {
      return `<div class="ac-item ac-item-tpl ${i === 0 ? 'ac-item-active' : ''}" data-idx="${i}"
        onmouseenter="acSetIndex(${i})"
        onmousedown="acAccept()">
        <span class="ac-tpl-icon">&#128247;</span>
        <span class="ac-cmd" style="color:var(--ac-cat-img,#e67e22)">${m.cmd}</span>
      </div>`;
    }).join('');
  } else {
    // Command suggestions
    drop.innerHTML = matches.map((m, i) => {
      const catColor = `var(--ac-cat-${m.cat}, #888)`;
      return `<div class="ac-item ${i === 0 ? 'ac-item-active' : ''}" data-idx="${i}"
        onmouseenter="acSetIndex(${i})"
        onmousedown="acAccept()">
        <span class="ac-cmd" style="color:${catColor}">${m.cmd}</span>
        ${m.hint ? `<span class="ac-hint">${m.hint}</span>` : ''}
      </div>`;
    }).join('');
  }

  const coords = _getCaretCoords(editor);
  const dropW  = isTplMode ? 260 : 380;
  let left = coords.left;
  let top  = coords.top + coords.lineH + 2;
  const vw = window.innerWidth, vh = window.innerHeight;
  if (left + dropW > vw - 8) left = vw - dropW - 8;
  if (top + 220 > vh) top = coords.top - Math.min(matches.length * 28, 220) - 4;
  drop.style.left  = left + 'px';
  drop.style.top   = top  + 'px';
  drop.style.width = dropW + 'px';
  drop.classList.add('ac-visible');
}

function acSetIndex(i) {
  _acIndex = i;
  document.querySelectorAll('.ac-item').forEach((el, idx) => {
    el.classList.toggle('ac-item-active', idx === i);
  });
}

function acAccept() {
  if (!_acVisible || _acIndex < 0 || _acIndex >= _acMatches.length) return;
  const editor = document.getElementById('script-editor');
  if (!editor) return;

  const chosen = _acMatches[_acIndex];
  const pos    = editor.selectionStart;
  const val    = editor.value;

  // Replace from word start to cursor with full command + space (if has hint)
  const before  = val.slice(0, _acWordStart);
  const after   = val.slice(pos);
  const insert  = chosen.cmd + (chosen.hint ? ' ' : '');
  editor.value  = before + insert + after;
  const newPos  = _acWordStart + insert.length;
  editor.selectionStart = editor.selectionEnd = newPos;
  editor.focus();

  _hideAc();
  updateLineCount();
  renderScriptLines();
  renderSyntaxHighlight();
}

function _getCaretCoords(editor) {
  // Use a mirror div to measure caret position
  const style   = getComputedStyle(editor);
  const mirror  = document.createElement('div');
  const props   = ['fontFamily','fontSize','fontWeight','lineHeight','letterSpacing',
                   'padding','paddingTop','paddingLeft','borderTop','borderLeft',
                   'boxSizing','whiteSpace','wordWrap','tabSize'];
  mirror.style.cssText = 'position:fixed;visibility:hidden;top:0;left:0;pointer-events:none;';
  props.forEach(p => { mirror.style[p] = style[p]; });
  mirror.style.width    = editor.offsetWidth + 'px';
  mirror.style.height   = 'auto';
  mirror.style.overflow = 'hidden';
  document.body.appendChild(mirror);

  const textBefore = editor.value.slice(0, editor.selectionStart);
  mirror.textContent = textBefore;

  const span = document.createElement('span');
  span.textContent = '|';
  mirror.appendChild(span);

  const rect     = editor.getBoundingClientRect();
  const spanRect = span.getBoundingClientRect();
  document.body.removeChild(mirror);

  const lineH = parseFloat(style.lineHeight) || 20;
  return {
    left:  rect.left + spanRect.left - mirror.getBoundingClientRect?.()?.left || rect.left + 12,
    top:   rect.top  + spanRect.top  - rect.top + editor.offsetTop - editor.scrollTop,
    lineH,
  };
}

// Hook into the editor keydown for autocomplete navigation
document.addEventListener('DOMContentLoaded', () => {
  const editor = document.getElementById('script-editor');
  if (!editor) return;

  // Context menu
  editor.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    _buildEditorContextMenu(e);
  });

  // Reload templates when editor gets focus (user may have added templates)
  editor.addEventListener('focus', () => _loadAcTemplates());

  // ── Thumbnail hover preview ───────────────────────────
  let _thumbTimer = null;
  let _thumbShown = false;

  editor.addEventListener('mousemove', (e) => {
    clearTimeout(_thumbTimer);
    _thumbTimer = setTimeout(() => _checkThumbnailHover(e, editor), 300);
  });

  editor.addEventListener('mouseleave', () => {
    clearTimeout(_thumbTimer);
    _hideThumbnailPreview();
  });

  editor.addEventListener('keydown', (e) => {
    if (!_acVisible) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      acSetIndex(Math.min(_acIndex + 1, _acMatches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      acSetIndex(Math.max(_acIndex - 1, 0));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (_acVisible) { e.preventDefault(); acAccept(); }
    } else if (e.key === 'Escape') {
      _hideAc();
    }
  }, { capture: true });

  editor.addEventListener('input', () => _triggerAc(editor));
  editor.addEventListener('keyup', (e) => {
    if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) return;
    _triggerAc(editor);
  });
  editor.addEventListener('blur', () => setTimeout(_hideAc, 150));
});

function _triggerAc(editor) {
  const pos       = editor.selectionStart;
  const val       = editor.value;
  const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
  const lineText  = val.slice(lineStart, pos);
  const trimmed   = lineText.trimStart();
  const indent    = lineText.length - trimmed.length;

  // ── First token (command) autocomplete ────────────────
  if (!trimmed.includes(' ')) {
    if (trimmed.startsWith('#') || !trimmed) { _hideAc(); return; }
    const wordStart = lineStart + indent;
    const typed     = trimmed.toUpperCase();
    const matches   = AC_COMMANDS.filter(c => c.cmd.startsWith(typed) && c.cmd !== typed);
    if (!matches.length) { _hideAc(); return; }
    _showAc(matches, wordStart, editor, false);
    return;
  }

  // ── Second token (template name) autocomplete ─────────
  const parts    = trimmed.split(/\s+/);
  const cmd      = parts[0].toUpperCase();
  const isSecond = parts.length === 2 && !lineText.endsWith(' ');

  if (AC_NEEDS_TEMPLATE.has(cmd) && isSecond && _acTemplates.length) {
    const typed2  = parts[1].toLowerCase();
    const matches = _acTemplates
      .filter(t => t.toLowerCase().startsWith(typed2) && t.toLowerCase() !== typed2)
      .slice(0, 12)
      .map(t => ({ cmd: t, hint: '', cat: 'img' }));
    if (!matches.length) { _hideAc(); return; }
    // wordStart = position of second token start
    const secondTokenStart = lineStart + lineText.lastIndexOf(parts[1]);
    _showAc(matches, secondTokenStart, editor, true);
    return;
  }

  _hideAc();
}


// ══════════════════════════════════════════════════════════
//  FIND & REPLACE
// ══════════════════════════════════════════════════════════

let _frOpen        = false;
let _frMatches     = [];
let _frCurrent     = -1;
let _frReplaceMode = false;

function openFindReplace(replaceMode) {
  _frReplaceMode = !!replaceMode;
  _frOpen = true;
  const panel = document.getElementById('fr-panel');
  if (panel) {
    panel.classList.remove('fr-hidden');
    panel.querySelector('.fr-replace-row').style.display = replaceMode ? '' : 'none';
    document.getElementById('fr-find-input').focus();
    document.getElementById('fr-find-input').select();
    _frSearch();
  }
}

function closeFindReplace() {
  _frOpen = false;
  document.getElementById('fr-panel')?.classList.add('fr-hidden');
  _frClearHighlights();
  _frMatches = [];
  _frCurrent = -1;
  document.getElementById('script-editor')?.focus();
}

function toggleFindReplaceMode() {
  const row = document.getElementById('fr-panel')?.querySelector('.fr-replace-row');
  if (!row) return;
  _frReplaceMode = !_frReplaceMode;
  row.style.display = _frReplaceMode ? '' : 'none';
  document.getElementById('fr-toggle-replace').textContent = _frReplaceMode ? '▲' : '▼';
}

function _frSearch() {
  _frClearHighlights();
  _frMatches = [];
  _frCurrent = -1;

  const query = document.getElementById('fr-find-input')?.value || '';
  if (!query) { _frUpdateStatus(); return; }

  const caseSens = document.getElementById('fr-case-btn')?.classList.contains('fr-opt-active');
  const editor   = document.getElementById('script-editor');
  if (!editor) return;

  const text     = editor.value;
  const search   = caseSens ? query : query.toLowerCase();
  const src      = caseSens ? text  : text.toLowerCase();
  let   idx      = 0;

  while ((idx = src.indexOf(search, idx)) !== -1) {
    _frMatches.push({ start: idx, end: idx + search.length });
    idx += search.length;
  }

  if (_frMatches.length) {
    _frCurrent = 0;
    _frScrollToMatch(0);
  }
  _frUpdateStatus();
  _frHighlightMatches();
}

function _frHighlightMatches() {
  // Use the syntax-bg overlay to show highlights — inject a wrapper element layer
  // We actually highlight via the textarea selection + a floating highlights div
  const editor    = document.getElementById('script-editor');
  const container = editor?.parentElement;
  if (!container) return;

  let hl = document.getElementById('fr-highlights');
  if (!hl) {
    hl = document.createElement('div');
    hl.id = 'fr-highlights';
    hl.className = 'fr-highlights';
    container.insertBefore(hl, editor);
  }

  if (!_frMatches.length) { hl.innerHTML = ''; return; }

  // Mirror approach — same as autocomplete caret, but for each match
  const style = getComputedStyle(editor);
  const text  = editor.value;

  hl.innerHTML = _frMatches.map((m, i) => {
    const isCur = i === _frCurrent;
    return `<span class="fr-hl ${isCur ? 'fr-hl-current' : ''}" data-idx="${i}" style="${_frGetSpanStyle(editor, style, m.start, m.end - m.start)}"></span>`;
  }).join('');
}

function _frGetSpanStyle(editor, style, start, len) {
  // Approximate pixel position using character grid
  const text     = editor.value;
  const before   = text.slice(0, start);
  const lines    = before.split('\n');
  const lineIdx  = lines.length - 1;
  const colIdx   = lines[lines.length - 1].length;
  const lineH    = parseFloat(style.lineHeight) || 20;
  const charW    = parseFloat(style.fontSize) * 0.6; // monospace approx
  const pt       = parseFloat(style.paddingTop)  || 0;
  const pl       = parseFloat(style.paddingLeft) || 0;

  const top  = pt + lineIdx * lineH - editor.scrollTop;
  const left = pl + colIdx  * charW;
  const w    = len * charW;
  return `top:${top}px;left:${left}px;width:${w}px;height:${lineH}px;`;
}

function _frClearHighlights() {
  const hl = document.getElementById('fr-highlights');
  if (hl) hl.innerHTML = '';
}

function _frScrollToMatch(idx) {
  if (idx < 0 || idx >= _frMatches.length) return;
  const editor = document.getElementById('script-editor');
  if (!editor) return;
  const m       = _frMatches[idx];
  const before  = editor.value.slice(0, m.start);
  const lineIdx = before.split('\n').length - 1;
  const lineH   = parseFloat(getComputedStyle(editor).lineHeight) || 20;
  const target  = lineIdx * lineH - editor.clientHeight / 2;
  editor.scrollTop = Math.max(0, target);
  // Select the match (but only steal focus when explicitly navigating)
  editor.selectionStart = m.start;
  editor.selectionEnd   = m.end;
}

function _frUpdateStatus() {
  const el = document.getElementById('fr-status');
  if (!el) return;
  if (!_frMatches.length) {
    const query = document.getElementById('fr-find-input')?.value || '';
    el.textContent = query ? 'No matches' : '';
    el.style.color = query ? '#e74c3c' : '';
  } else {
    el.textContent = `${_frCurrent + 1} / ${_frMatches.length}`;
    el.style.color = '';
  }
}

function frNext() {
  if (!_frMatches.length) return;
  _frCurrent = (_frCurrent + 1) % _frMatches.length;
  _frScrollToMatch(_frCurrent);
  document.getElementById('script-editor')?.focus();
  _frHighlightMatches();
  _frUpdateStatus();
}

function frPrev() {
  if (!_frMatches.length) return;
  _frCurrent = (_frCurrent - 1 + _frMatches.length) % _frMatches.length;
  _frScrollToMatch(_frCurrent);
  document.getElementById('script-editor')?.focus();
  _frHighlightMatches();
  _frUpdateStatus();
}

function frReplaceCurrent() {
  if (_frCurrent < 0 || _frCurrent >= _frMatches.length) return;
  const editor  = document.getElementById('script-editor');
  const replVal = document.getElementById('fr-replace-input')?.value || '';
  const query   = document.getElementById('fr-find-input')?.value   || '';
  if (!query || !editor) return;

  _pushUndo();
  const m      = _frMatches[_frCurrent];
  const val    = editor.value;
  editor.value = val.slice(0, m.start) + replVal + val.slice(m.end);
  editor.selectionStart = editor.selectionEnd = m.start + replVal.length;
  editor.focus();
  updateLineCount(); renderScriptLines(); renderSyntaxHighlight();
  _frSearch();
}

function frReplaceAll() {
  const editor  = document.getElementById('script-editor');
  const replVal = document.getElementById('fr-replace-input')?.value || '';
  const query   = document.getElementById('fr-find-input')?.value   || '';
  if (!query || !editor || !_frMatches.length) return;

  _pushUndo();
  const caseSens = document.getElementById('fr-case-btn')?.classList.contains('fr-opt-active');
  const flags    = caseSens ? 'g' : 'gi';
  const escaped  = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  editor.value   = editor.value.replace(new RegExp(escaped, flags), replVal);
  const count    = _frMatches.length;
  toast(`Replaced ${count} occurrence${count !== 1 ? 's' : ''}`, 'info');
  editor.focus();
  updateLineCount(); renderScriptLines(); renderSyntaxHighlight();
  _frSearch();
}

function frToggleCase() {
  const btn = document.getElementById('fr-case-btn');
  if (btn) btn.classList.toggle('fr-opt-active');
  _frSearch();
}

// Ctrl+F = Find, Ctrl+H = Find & Replace
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'f') {
    e.preventDefault();
    openFindReplace(false);
  } else if (e.ctrlKey && e.key === 'h') {
    e.preventDefault();
    openFindReplace(true);
  }
});

// Re-highlight on editor scroll
document.addEventListener('DOMContentLoaded', () => {
  const editor = document.getElementById('script-editor');
  if (editor) {
    editor.addEventListener('scroll', () => {
      if (_frOpen && _frMatches.length) _frHighlightMatches();
    });
  }
});

// Live search as user types
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    const fi = document.getElementById('fr-find-input');
    if (fi) {
      fi.addEventListener('input', _frSearch);
      fi.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.shiftKey ? frPrev() : frNext(); }
        else if (e.key === 'Escape') { closeFindReplace(); }
      });
    }
    const ri = document.getElementById('fr-replace-input');
    if (ri) {
      ri.addEventListener('keydown', e => {
        if (e.key === 'Enter') frReplaceCurrent();
        else if (e.key === 'Escape') closeFindReplace();
      });
    }
  }, 500);
});


// ══════════════════════════════════════════════════════════
//  VALIDATION SPEED IMPROVEMENT (override debounce to 600ms)
// ══════════════════════════════════════════════════════════
// Patch scheduleValidation to run faster
(function() {
  const orig = window.scheduleValidation;
  window.scheduleValidation = function() {
    if (_validateTimer) clearTimeout(_validateTimer);
    _validateTimer = setTimeout(async () => {
      if (!window.pywebview?.api?.validate_script) return;
      const script = document.getElementById('script-editor')?.value?.trim();
      if (!script) { _clearValidationMarkers(); return; }
      try {
        const v = await window.pywebview.api.validate_script(script);
        _clearValidationMarkers();
        if (v?.issues?.length) _showValidationMarkers(v.issues);
      } catch(e) {}
    }, 600);
  };
})();

// ══════════════════════════════════════════════════════════
//  .AMYT FILE FORMAT — Export / Import / Startup handler
// ══════════════════════════════════════════════════════════

let _amytImportPath = null;  // path chosen in pick dialog

// ── Export ────────────────────────────────────────────────

function openAmytExport() {
  if (!checkApi()) return;
  const name = document.getElementById('savload-filename')?.textContent?.replace('.txt','') || '';
  const nameEl = document.getElementById('amyt-name');
  if (nameEl && name && name !== 'unsaved') nameEl.value = name;
  document.getElementById('amyt-export-overlay')?.classList.remove('hidden');
  _amytPreviewContents();
}

function closeAmytExport() {
  document.getElementById('amyt-export-overlay')?.classList.add('hidden');
}

async function _amytPreviewContents() {
  const el = document.getElementById('amyt-export-contents');
  if (!el) return;
  try {
    const editor = document.getElementById('script-editor');
    const content = editor?.value || '';
    const tplPattern = /(?:CLICK_IMAGE|DOUBLE_CLICK_IMAGE|RIGHT_CLICK_IMAGE|WAIT_IMAGE(?:_GONE)?|IF_IMAGE|IF_NOT_IMAGE|WHILE_IMAGE|FIND_CLICK|FIND_DOUBLE_CLICK|FIND_RIGHT_CLICK|FIND_MOVE|FIND_HOLD|FIND_DRAG|NAVIGATE_TO_IMAGE)\s+(\S+)/gi;
    const templates = new Set();
    let m;
    while ((m = tplPattern.exec(content)) !== null) {
      let t = m[1].replace(/\.png$/i, '');
      templates.add(t);
    }
    const lines = content.split('\n').filter(l => l.trim() && !l.trim().startsWith('#')).length;
    el.innerHTML = `
      <div>📄 <strong>script.txt</strong> — ${lines} command line${lines !== 1 ? 's' : ''}</div>
      <div>🖼️ <strong>${templates.size} template image${templates.size !== 1 ? 's' : ''}</strong>${templates.size > 0 ? ': ' + [...templates].slice(0,5).join(', ') + (templates.size > 5 ? ` +${templates.size-5} more` : '') : ' (none used)'}</div>
      <div>📋 <strong>meta.json</strong> — name, author, description, tags, checksum</div>
    `;
  } catch(e) { if (el) el.textContent = 'Unable to calculate'; }
}

async function confirmAmytExport() {
  if (!checkApi()) return;
  const name = document.getElementById('amyt-name')?.value?.trim();
  if (!name) { toast('Enter a script name first', 'warn'); return; }

  // Make sure the script is saved first
  const content = document.getElementById('script-editor')?.value;
  if (!content?.trim()) { toast('Script is empty', 'warn'); return; }

  // Save to storage so backend can read it
  await window.pywebview.api.save_script(name, content);

  const desc   = document.getElementById('amyt-desc')?.value || '';
  const author = document.getElementById('amyt-author')?.value || '';
  const tags   = document.getElementById('amyt-tags')?.value || '';

  try {
    const r = await withLoading(
      window.pywebview.api.export_amyt(name, desc, author, tags),
      'Building .amyt package…'
    );
    if (r.status === 'ok') {
      closeAmytExport();
      const tpl = r.templates_bundled > 0
        ? ` + ${r.templates_bundled} template${r.templates_bundled > 1 ? 's' : ''}` : '';
      toast(`✅ Exported: ${r.meta?.name || name}.amyt${tpl}`, 'info');
    } else if (r.status !== 'cancelled') {
      toast(`Export failed: ${r.message}`, 'error');
    }
  } catch(e) { toast(`Error: ${e}`, 'error'); }
}

// ── Import ────────────────────────────────────────────────

function openAmytImport() {
  _amytImportPath = null;
  document.getElementById('amyt-import-pick').style.display = '';
  document.getElementById('amyt-import-preview').style.display = 'none';
  document.getElementById('amyt-import-confirm-btn').disabled = true;
  document.getElementById('amyt-import-overlay')?.classList.remove('hidden');
}

function closeAmytImport() {
  document.getElementById('amyt-import-overlay')?.classList.add('hidden');
  _amytImportPath = null;
}

async function pickAmytFile() {
  if (!checkApi()) return;
  try {
    // Use import_amyt with no path — it opens the file dialog itself
    // but we only want the meta first, so we get meta via get_amyt_meta
    // Workaround: import_amyt returns meta + script, we show meta then ask confirm
    const r = await withLoading(
      window.pywebview.api.import_amyt(null),
      'Reading .amyt package…'
    );
    if (r.status === 'cancelled') return;
    if (r.status !== 'ok') { toast(`Import failed: ${r.message}`, 'error'); return; }

    // Store result for confirm step
    _amytImportPath = r;  // store full result for confirm
    _showAmytPreview(r);
  } catch(e) { toast(`Error: ${e}`, 'error'); }
}

function _showAmytPreview(r) {
  const meta = r.meta || {};
  document.getElementById('amyt-import-pick').style.display = 'none';
  document.getElementById('amyt-import-preview').style.display = '';
  document.getElementById('amyt-import-confirm-btn').disabled = false;

  document.getElementById('amyt-prev-name').textContent   = meta.name || 'Unnamed Script';
  document.getElementById('amyt-prev-author').textContent = meta.author ? `by ${meta.author}` : '';
  document.getElementById('amyt-prev-desc').textContent   = meta.description || '';

  const tagsEl = document.getElementById('amyt-prev-tags');
  tagsEl.innerHTML = (meta.tags || []).map(t =>
    `<span style="background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:2px 8px;font-size:11px">${t}</span>`
  ).join('');

  document.getElementById('amyt-prev-templates').textContent =
    `🖼️ ${r.templates_restored} template${r.templates_restored !== 1 ? 's' : ''} included`;
  document.getElementById('amyt-prev-version').textContent =
    meta.app_version ? `App v${meta.app_version}` : '';
  document.getElementById('amyt-prev-date').textContent =
    meta.created ? `Created ${meta.created}` : '';
  document.getElementById('amyt-prev-checksum').innerHTML =
    r.checksum_ok
      ? '<span style="color:#27ae60">✓ Verified</span>'
      : '<span style="color:#e74c3c">⚠ Checksum mismatch</span>';
}

async function confirmAmytImport() {
  if (!_amytImportPath) return;
  const r = _amytImportPath;
  closeAmytImport();
  _loadAmytResult(r);
}

function _loadAmytResult(r) {
  // Load script into editor
  const editor = document.getElementById('script-editor');
  if (!editor) return;
  _pushUndo();
  editor.value = r.script;
  _scriptDirty = true;
  const name = r.meta?.name || 'imported';
  _setCurrentFile(name, null);
  updateLineCount();
  renderScriptLines?.();
  renderSyntaxHighlight?.();

  const tpl = r.templates_restored > 0
    ? ` + ${r.templates_restored} template${r.templates_restored > 1 ? 's' : ''}` : '';
  toast(`✅ Imported: ${name}${tpl}`, 'info');

  // Refresh template list so new templates appear
  if (typeof loadTemplates === 'function') loadTemplates();
}

// ── Option 2: startup handler (called from main.py via evaluate_js) ──────────
window._amytStartupImport = function(r) {
  if (!r || r.status !== 'ok') return;
  // Show a banner so user can confirm instead of silently replacing
  const banner = document.createElement('div');
  banner.style.cssText = `
    position:fixed;top:0;left:0;right:0;z-index:9500;
    background:var(--color-background-info);
    border-bottom:1px solid var(--color-border-info);
    padding:10px 18px;display:flex;align-items:center;gap:12px;
    font-size:13px;color:var(--color-text-info);
  `;
  const name = r.meta?.name || 'Script';
  banner.innerHTML = `
    <svg style="width:16px;height:16px;flex-shrink:0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
    <span>Opening <strong>${name}.amyt</strong>${r.templates_restored > 0 ? ` (${r.templates_restored} templates)` : ''}</span>
    <button onclick="document.body.removeChild(this.closest('div'));window._loadAmytNow()" style="
      padding:4px 14px;border-radius:6px;border:none;cursor:pointer;
      background:var(--color-text-info);color:#fff;font-size:12px;font-weight:600;
    ">Load into Editor</button>
    <button onclick="document.body.removeChild(this.closest('div'))" style="
      padding:4px 10px;border-radius:6px;border:1px solid var(--color-border-info);
      cursor:pointer;background:transparent;color:var(--color-text-info);font-size:12px;
    ">Dismiss</button>
  `;
  document.body.appendChild(banner);
  window._loadAmytNow = () => _loadAmytResult(r);
};

// ── Option 3: register file association ──────────────────
async function registerAmytFileAssociation() {
  if (!checkApi()) return;
  try {
    const r = await window.pywebview.api.register_amyt_file_association();
    if (r.status === 'ok') toast('✅ ' + r.message, 'info');
    else toast('⚠ ' + r.message, 'warn');
  } catch(e) { toast(`Error: ${e}`, 'error'); }
}

// ── APP CLOSE HANDLING ────────────────────────────────────────────────────
// Called by Python's window.events.closing handler via evaluate_js().
// Checks if the script is dirty and shows the confirm dialog or closes directly.

function handleAppClose() {
  const editor   = document.getElementById('script-editor');
  const hasScript = editor && editor.value.trim().length > 0;

  // No script content — close immediately, no dialog needed
  if (!hasScript || !_scriptDirty) {
    window.pywebview?.api?.force_close();
    return;
  }

  // Show the unsaved-changes dialog
  const nameEl = document.getElementById('savload-filename');
  const name   = nameEl ? nameEl.textContent.trim() : 'script';
  const label  = document.getElementById('close-confirm-filename');
  if (label) {
    label.textContent = name !== 'unsaved'
      ? `"${name}" has unsaved changes`
      : 'has unsaved changes';
  }
  document.getElementById('close-confirm-overlay')?.classList.remove('hidden');
}

async function closeConfirmSaveAndClose() {
  document.getElementById('close-confirm-overlay')?.classList.add('hidden');
  const editor  = document.getElementById('script-editor');
  const nameEl  = document.getElementById('savload-filename');
  const name    = nameEl ? nameEl.textContent.trim() : 'unsaved';
  const content = editor ? editor.value : '';

  if (!window.pywebview?.api) return;

  // If the file already has a name, quick-save then close
  if (name && name !== 'unsaved') {
    await window.pywebview.api.save_and_close(name, content);
  } else {
    // No filename yet — open Save As dialog, then close on success
    try {
      const r = await window.pywebview.api.save_script_dialog(content);
      if (r?.status === 'ok') {
        await window.pywebview.api.force_close();
      } else {
        // User cancelled the save dialog — keep app open
        document.getElementById('close-confirm-overlay')?.classList.remove('hidden');
      }
    } catch(e) {
      await window.pywebview.api.force_close();
    }
  }
}

function closeConfirmDiscard() {
  document.getElementById('close-confirm-overlay')?.classList.add('hidden');
  window.pywebview?.api?.confirm_close();
}

function closeConfirmCancel() {
  document.getElementById('close-confirm-overlay')?.classList.add('hidden');
  // Do nothing — user cancelled, app stays open
}
