/**
 * macro.js — Recording, script execution, logs, learning data tab
 */

// ── RECORDING ──────────────────────────────────────────────
async function startRecording() {
  if (_guardRunning('start recording')) return;
  if (!checkApi()) return;

  const countdown = parseInt(document.getElementById('rec-countdown')?.value ?? 3) || 3;

  // Show countdown in UI so user knows to switch to target window
  const btn = document.getElementById('btn-record');
  if (btn) btn.disabled = true;

  if (countdown > 0) {
    setStatus('recording', `Starting in ${countdown}s…`);
    for (let i = countdown; i > 0; i--) {
      setStatus('recording', `Recording in ${i}…`);
      nativeToast(`⏳ Recording starts in ${i}s`, 'info');
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  try {
    await window.pywebview.api.start_recording(countdown);
    isRecording = true;
    setStatus('recording', 'Recording...');
    nativeToast('⏺ Recording started — click Stop Rec when done', 'info');
    document.getElementById('btn-pause').disabled    = false;
    document.getElementById('btn-stop-rec').disabled = false;
  } catch(e) {
    toast(`Error: ${e}`, 'error');
    if (btn) btn.disabled = false;
  }
}

async function pauseRecording() {
  if (!checkApi()) return;
  try {
    await withLoading(window.pywebview.api.pause_recording());
    const btn = document.getElementById('btn-pause');
    if (btn.textContent.includes('Pause')) {
      btn.textContent = '▶ Resume'; setStatus('idle', 'Paused');
    } else {
      btn.textContent = '⏸ Pause'; setStatus('recording', 'Recording...');
    }
  } catch(e) { toast(`Error: ${e}`, 'error'); }
}

async function stopRecording() {
  if (!checkApi()) return;
  try {
    const result = await withLoading(window.pywebview.api.stop_recording());
    isRecording  = false;
    setStatus('idle', 'Idle');
    nativeToast('⏹ Recording stopped', 'info');
    if (result.script && result.script.trim()) {
      document.getElementById('script-editor').value = result.script;
      formatScript();
      updateLineCount();
      renderScriptLines();
      renderSyntaxHighlight();
      const card = document.getElementById('welcome-card');
      if (card) card.classList.add('hidden');
    }
    document.getElementById('btn-record').disabled   = false;
    document.getElementById('btn-pause').disabled    = true;
    document.getElementById('btn-stop-rec').disabled = true;
    document.getElementById('btn-pause').textContent = '⏸ Pause';
  } catch(e) { toast(`Error: ${e}`, 'error'); }
}

// ── SCRIPT EXECUTION ───────────────────────────────────────
async function runScript() {
  if (!checkApi()) return;
  const script = document.getElementById('script-editor').value.trim();
  if (!script) { toast('Script is empty!', 'warn'); return; }

  // Clear previous error highlights before running
  document.querySelectorAll('.sh-line.error-line').forEach(el => el.classList.remove('error-line'));
  document.querySelectorAll('.lp-row.lp-error-line').forEach(el => el.classList.remove('lp-error-line'));
  _clearValidationMarkers();

  // Pre-flight validation
  try {
    const v = await window.pywebview.api.validate_script(script);
    if (v && v.issues && v.issues.length > 0) {
      const errors   = v.issues.filter(i => i.severity === 'error');
      const warnings = v.issues.filter(i => i.severity === 'warning');
      _showValidationMarkers(v.issues);
      if (errors.length > 0) {
        const msg = errors[0].message;
        toast(`Script error on line ${errors[0].line + 1}: ${msg}`, 'error');
        // Highlight the first error line
        onScriptErrorLine(errors[0].line);
        return;   // block run on hard errors
      }
      if (warnings.length > 0) {
        toast(`${warnings.length} warning(s) — check the editor (script will still run)`, 'warn');
      }
    }
  } catch(e) { /* validation failure is non-blocking */ }
  const _repeatRaw = parseInt(document.getElementById('repeat-count').value);
  const repeatVal  = isNaN(_repeatRaw) || _repeatRaw < 0 ? 1 : _repeatRaw;
  isRunning = true;
  _setRunningLockUI(true);
  setStatus('running', 'Running...');
  document.getElementById('script-status').textContent = '⟳ Running...';
  document.getElementById('btn-pause-script').disabled = false;
  document.getElementById('btn-pause-script').textContent = '⏸ Pause';
  try {
    const result = await withLoading(window.pywebview.api.run_script(script, repeatVal));
    if (result && result.status === 'running') {
      // Show the floating indicator bar (hides main window)
      window.pywebview.api.show_indicator().catch(() => {});
    }
  } catch(e) { 
    toast(`Error: ${e}`, 'error'); 
    setStatus('idle','Idle'); 
  }
}


function onScriptFinished() {
  isRunning = false;
  _setRunningLockUI(false);
  setStatus('idle', 'Idle');
  const pauseBtn = document.getElementById('btn-pause-script');
  clearBreakpoints();
  if (pauseBtn) { pauseBtn.textContent = '⏸ Pause'; pauseBtn.disabled = true; }
  if (window.pywebview && window.pywebview.api) {
    window.pywebview.api.hide_indicator().catch(() => {});
  }
  document.getElementById('script-status').textContent = '✓ Done';
}

function onScriptError() {
  isRunning = false;
  _setRunningLockUI(false);
  setStatus('idle', 'Error');
  const pauseBtn = document.getElementById('btn-pause-script');
  clearBreakpoints();
  if (pauseBtn) { pauseBtn.textContent = '⏸ Pause'; pauseBtn.disabled = true; }
  if (window.pywebview && window.pywebview.api) {
    window.pywebview.api.hide_indicator().catch(() => {});
    // Fetch and highlight the error line
    window.pywebview.api.get_last_error_line().then(r => {
      if (r && r.line >= 0) onScriptErrorLine(r.line);
    }).catch(() => {});
  }
  document.getElementById('script-status').textContent = '✗ Error';
  toast('Script error — the failing line is highlighted in red', 'error');
}

// Called from Python via evaluate_js when a command throws an error
function onScriptErrorLine(lineIndex) {
  if (lineIndex < 0) return;
  // Clear any previous error highlight
  document.querySelectorAll('.sh-line.error-line').forEach(el => el.classList.remove('error-line'));
  // Highlight in syntax overlay
  const bg = document.getElementById('syntax-bg');
  if (bg) {
    const lines = bg.querySelectorAll('.sh-line');
    if (lines[lineIndex]) {
      lines[lineIndex].classList.add('error-line');
      lines[lineIndex].scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
  // Scroll editor to the error line
  const editor = document.getElementById('script-editor');
  if (editor) {
    const scriptLines = editor.value.split('\n');
    const lineH = editor.scrollHeight / Math.max(scriptLines.length, 1);
    editor.scrollTop = Math.max(0, lineIndex * lineH - editor.clientHeight / 2);
  }
  // Show error marker in line panel
  document.querySelectorAll('.lp-row').forEach((r, i) => {
    r.classList.toggle('lp-error-line', i === lineIndex);
  });
}

// Called from Python every step during normal script execution —
// highlights the currently-executing line green.
// Passing lineIndex = -1 clears the highlight (called on finish/stop).
function onScriptRunLine(lineIndex) {
  // Clear previous run-line highlight
  document.querySelectorAll('.sh-line.run-line').forEach(el => el.classList.remove('run-line'));
  document.querySelectorAll('.lp-row.lp-run-line').forEach(r => r.classList.remove('lp-run-line'));

  if (lineIndex < 0) return;

  const bg = document.getElementById('syntax-bg');
  if (bg) {
    const lines = bg.querySelectorAll('.sh-line');
    if (lines[lineIndex]) {
      lines[lineIndex].classList.add('run-line');
      lines[lineIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  const editor = document.getElementById('script-editor');
  if (editor) {
    const scriptLines = editor.value.split('\n');
    const lineH = editor.scrollHeight / Math.max(scriptLines.length, 1);
    editor.scrollTop = Math.max(0, lineIndex * lineH - editor.clientHeight / 2);
  }

  document.querySelectorAll('.lp-row').forEach((r, i) => {
    r.classList.toggle('lp-run-line', i === lineIndex);
  });
}

async function stopMacro() {
  if (!checkApi()) return;
  try {
    await withLoading(window.pywebview.api.stop_macro());
    isRunning = false;
    _setRunningLockUI(false);
    setStatus('idle', 'Stopped');
    onScriptRunLine(-1);  // clear live run highlight
    const pauseBtn = document.getElementById('btn-pause-script');
    if (pauseBtn) { pauseBtn.textContent = '⏸ Pause'; pauseBtn.disabled = true; }
    if (window.pywebview && window.pywebview.api) {
      window.pywebview.api.hide_indicator().catch(() => {});
    }
    document.getElementById('script-status').textContent = '⏹ Stopped';
  } catch(e) { toast(`Error: ${e}`, 'error'); }
}

async function togglePauseScript() {
  if (!checkApi()) return;
  try {
    const btn = document.getElementById('btn-pause-script');
    const isPaused = btn.textContent.includes('Resume');
    if (isPaused) {
      await withLoading(window.pywebview.api.resume_script());
      btn.textContent = '⏸ Pause'; setStatus('running', 'Running...');
    } else {
      await withLoading(window.pywebview.api.pause_script());
      btn.textContent = '▶ Resume'; setStatus('idle', 'Paused');
    }
  } catch(e) { toast(`Error: ${e}`, 'error'); }
}

// ── LOGS ───────────────────────────────────────────────────
let _lastLogCount = 0;
let _lastLogs = [];      // optional, for comparison
// ── LOG FILTER STATE ──────────────────────────────────────
let _logFilter = 'ALL';   // 'ALL' | 'WARN' | 'ERROR'
let _logSearch = '';
let _allLogs   = [];       // full log cache for re-filtering

function setLogFilter(level) {
  _logFilter = level;
  document.querySelectorAll('.log-filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.level === level);
  });
  _renderLogViewer();
}

function onLogSearchInput(val) {
  _logSearch = val.trim().toLowerCase();
  _renderLogViewer();
}

function _renderLogViewer() {
  const viewer = document.getElementById('log-viewer');
  if (!viewer) return;

  let entries = _allLogs;
  if (_logFilter === 'WARN')  entries = entries.filter(e => e.includes('[WARN]') || e.includes('[ERROR]'));
  if (_logFilter === 'ERROR') entries = entries.filter(e => e.includes('[ERROR]'));
  if (_logSearch) entries = entries.filter(e => e.toLowerCase().includes(_logSearch));

  const badge = document.getElementById('log-count-badge');
  if (badge) {
    badge.textContent = _allLogs.length;
    badge.style.display = _allLogs.length > 0 ? '' : 'none';
  }

  if (entries.length === 0) {
    viewer.innerHTML = _allLogs.length === 0
      ? '<p class="empty-msg">No logs yet.</p>'
      : '<p class="empty-msg">No entries match the current filter.</p>';
    return;
  }

  viewer.innerHTML = entries.map(entry => {
    let cls = 'INFO';
    if (entry.includes('[WARN]'))  cls = 'WARN';
    if (entry.includes('[ERROR]')) cls = 'ERROR';
    const escaped = escapeHtml(entry);
    const highlighted = _logSearch
      ? escaped.replace(
          new RegExp(escapeHtml(_logSearch).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
          m => `<mark style="background:rgba(255,220,0,0.35);border-radius:2px">${m}</mark>`
        )
      : escaped;
    return `<div class="log-entry ${cls}">${highlighted}</div>`;
  }).join('');

  viewer.scrollTop = viewer.scrollHeight;
}

async function refreshLogs() {
  if (!checkApi()) return;
  try {
    const result = await withLoading(window.pywebview.api.get_logs());
    _allLogs = result.logs || [];
    _lastLogCount = _allLogs.length;
    _renderLogViewer();
  } catch(e) { console.error(e); }
}

async function clearLogs() {
  if (!checkApi()) return;
  try {
    await withLoading(window.pywebview.api.clear_logs());
    _allLogs = [];
    _lastLogCount = 0;
    _renderLogViewer();
    const badge = document.getElementById('log-count-badge');
    if (badge) { badge.textContent = '0'; badge.style.display = 'none'; }
    toast('Logs cleared', 'info');
  } catch(e) { toast(`Error: ${e}`, 'error'); }
}

function startAutoRefreshLogs() {
  logInterval = setInterval(() => {
    if (document.getElementById('tab-logs')?.classList.contains('active')) refreshLogs();
  }, 2000);
}

// ── LEARNING DATA ──────────────────────────────────────────
async function loadLearningData() {
  if (!checkApi()) return;
  try {
    const data  = await withLoading(window.pywebview.api.get_learning_data());
    const tbody = document.getElementById('learning-body');
    const keys  = Object.keys(data);
    if (keys.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-msg">No data yet.</td></tr>';
      return;
    }
    tbody.innerHTML = keys.map(key => {
      const d     = data[key];
      const rate  = (d.success_rate * 100).toFixed(0);
      const color = rate >= 80 ? '#4ade80' : rate >= 50 ? '#fbbf24' : '#f87171';
      const region = d.region ? `[${d.region.join(', ')}]` : 'Learning...';
      return `<tr>
        <td>${key}</td><td>${d.detections||0}</td><td>${d.successes||0}</td>
        <td><span style="color:${color}">${rate}%</span></td>
        <td style="font-size:11px;color:#888">${region}</td>
      </tr>`;
    }).join('');
  } catch(e) { toast(`Error: ${e}`, 'error'); }
}

// ── INIT ───────────────────────────────────────────────────
window.addEventListener('pywebviewready', () => {
  updateLineCount();
  startAutoRefreshLogs();
  // Load version from backend and update badge
  window.pywebview.api.get_version().then(r => {
    const badge = document.getElementById('app-version-badge');
    if (badge && r?.version) badge.textContent = 'v' + r.version;
  }).catch(() => {});
});
setTimeout(() => updateLineCount(), 500);

// ── WELCOME CARD ───────────────────────────────────────────

function toggleWelcomeCard() {
  const card   = document.getElementById('welcome-card');
  const steps  = card?.querySelector('.welcome-steps');
  const footer = card?.querySelector('.welcome-footer');
  const btn    = document.getElementById('welcome-toggle-btn');
  if (!card) return;
  const isCollapsed = card.classList.contains('welcome-collapsed');
  if (isCollapsed) {
    card.classList.remove('welcome-collapsed');
    if (steps)  steps.classList.remove('hidden');
    if (footer) footer.classList.remove('hidden');
    if (btn) {
      btn.title = 'Collapse';
      btn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-chevron-up"/></svg>';
    }
  } else {
    card.classList.add('welcome-collapsed');
    if (steps)  steps.classList.add('hidden');
    if (footer) footer.classList.add('hidden');
    if (btn) {
      btn.title = 'Expand';
      btn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-chevron-down"/></svg>';
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const card   = document.getElementById('welcome-card');
  const editor = document.getElementById('script-editor');
  if (card && editor) {
    if (editor.value.trim()) {
      card.classList.add('hidden');
    } else {
      card.classList.remove('hidden');
      const steps  = card.querySelector('.welcome-steps');
      const footer = card.querySelector('.welcome-footer');
      const btn    = document.getElementById('welcome-toggle-btn');
      card.classList.add('welcome-collapsed');
      if (steps)  steps.classList.add('hidden');
      if (footer) footer.classList.add('hidden');
      if (btn) {
        btn.title = 'Expand';
        btn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-chevron-down"/></svg>';
      }
    }
  }
});
// ── DEBUG MODE ──────────────────────────────────────────────
let _debugActive = false;

async function debugScript() {
    if (!checkApi()) return;
    const script = document.getElementById('script-editor').value.trim();
    if (!script) { toast('Script is empty!', 'warn'); return; }
    const _repeatRaw = parseInt(document.getElementById('repeat-count').value);
    const repeatVal  = isNaN(_repeatRaw) || _repeatRaw < 0 ? 1 : _repeatRaw;
    _debugActive = true;
    isRunning = true;
    _setRunningLockUI(true);
    setStatus('running', 'Debugging...');
    document.getElementById('script-status').textContent = '🐞 Debugging...';
    document.getElementById('btn-pause-script').disabled = false;
    document.getElementById('btn-pause-script').textContent = '⏸ Pause';
    showDebugControls();
    try {
        await withLoading(window.pywebview.api.start_debug(script, repeatVal));
    } catch(e) { toast(`Error: ${e}`, 'error'); setStatus('idle','Idle'); }
}

// ══════════════════════════════════════════════════════════
//  DEBUGGER — WATCH PANEL + CONTROLS
// ══════════════════════════════════════════════════════════

let _debugVarPollInterval = null;

function showDebugControls() {
  // Remove existing
  const existing = document.getElementById('debug-panel');
  if (existing) existing.remove();

  // Build panel — injected just above the editor-footer
  const editorWrap = document.querySelector('.editor-wrap');
  if (!editorWrap) return;

  const panel = document.createElement('div');
  panel.id = 'debug-panel';
  panel.className = 'debug-panel';
  panel.innerHTML = `
    <div class="debug-toolbar">
      <span class="debug-label">🐞 Debugger</span>
      <button class="btn btn-xs debug-btn-step"     onclick="debugStep()"     title="Execute next line and pause">⏯ Step</button>
      <button class="btn btn-xs debug-btn-continue" onclick="debugContinue()" title="Run until next breakpoint or end">▶ Continue</button>
      <button class="btn btn-xs btn-danger-xs"      onclick="stopMacro()"     title="Stop debugging">⏹ Stop</button>
      <button class="btn btn-xs debug-btn-watch-toggle" onclick="toggleWatchPanel()" title="Toggle variable watch">📋 Variables</button>
    </div>
    <div class="debug-watch" id="debug-watch">
      <div class="debug-watch-header">
        <span>Variable Watch</span>
        <button class="btn btn-xs" onclick="refreshVarWatch()" title="Refresh">⟳</button>
      </div>
      <div id="debug-watch-body" class="debug-watch-body">
        <div class="debug-watch-empty">No variables yet — run a SET or READ_TEXT command</div>
      </div>
    </div>
  `;

  // Insert between editor-split and editor-footer (both siblings, outside editor-wrap)
  const editorFooter = document.querySelector('.editor-footer');
  if (editorFooter) {
    editorFooter.parentNode.insertBefore(panel, editorFooter);
  } else {
    const editorSplit = document.querySelector('.editor-split');
    if (editorSplit) {
      editorSplit.after(panel);
    } else if (editorWrap.parentNode) {
      editorWrap.parentNode.appendChild(panel);
    }
  }

  // Start polling variables every 500ms while debugging
  _debugVarPollInterval = setInterval(refreshVarWatch, 500);
}

function hideDebugControls() {
  const panel = document.getElementById('debug-panel');
  if (panel) panel.remove();
  if (_debugVarPollInterval) {
    clearInterval(_debugVarPollInterval);
    _debugVarPollInterval = null;
  }
}

function toggleWatchPanel() {
  const watch = document.getElementById('debug-watch');
  if (watch) watch.classList.toggle('hidden');
}

async function refreshVarWatch() {
  if (!checkApi() || !_debugActive) return;
  try {
    const r = await window.pywebview.api.get_vars_snapshot();
    _renderWatchPanel(r.vars || {});
  } catch(e) {}
}

function _renderWatchPanel(vars) {
  const body = document.getElementById('debug-watch-body');
  if (!body) return;
  const entries = Object.entries(vars);
  if (entries.length === 0) {
    body.innerHTML = '<div class="debug-watch-empty">No variables set yet</div>';
    return;
  }
  body.innerHTML = entries.map(([k, v]) => {
    const isNum  = !isNaN(v) && v !== '';
    const isBool = v === '0' || v === '1';
    const cls    = isNum ? 'debug-var-num' : 'debug-var-str';
    const display = v.length > 40 ? v.slice(0, 40) + '…' : v;
    return `<div class="debug-var-row">
      <span class="debug-var-name">$${k}</span>
      <span class="debug-var-eq">=</span>
      <span class="debug-var-val ${cls}" title="${v}">${display}</span>
    </div>`;
  }).join('');
}

// Called from Python via evaluate_js — real-time push on SET / READ_TEXT / etc.
function onDebugVarUpdate(name, value) {
  if (!_debugActive) return;
  // Update or add the row immediately without waiting for the poll
  const body = document.getElementById('debug-watch-body');
  if (!body) return;
  const existing = body.querySelector(`[data-varname="${name}"]`);
  const display  = value.length > 40 ? value.slice(0, 40) + '…' : value;
  const isNum    = !isNaN(value) && value !== '';
  const cls      = isNum ? 'debug-var-num' : 'debug-var-str';

  if (existing) {
    existing.querySelector('.debug-var-val').textContent = display;
    existing.querySelector('.debug-var-val').className   = `debug-var-val ${cls}`;
    existing.classList.add('debug-var-flash');
    setTimeout(() => existing.classList.remove('debug-var-flash'), 600);
  } else {
    // Remove empty state
    const empty = body.querySelector('.debug-watch-empty');
    if (empty) empty.remove();
    const row = document.createElement('div');
    row.className = 'debug-var-row debug-var-flash';
    row.dataset.varname = name;
    row.innerHTML = `
      <span class="debug-var-name">$${name}</span>
      <span class="debug-var-eq">=</span>
      <span class="debug-var-val ${cls}" title="${value}">${display}</span>`;
    body.appendChild(row);
    setTimeout(() => row.classList.remove('debug-var-flash'), 600);
  }
}

function debugStep() {
  if (!checkApi()) return;
  window.pywebview.api.debug_step().catch(() => {});
}

function debugContinue() {
  if (!checkApi()) return;
  window.pywebview.api.debug_continue().catch(() => {});
}

// Called from Python via evaluate_js
function onDebugStart() {
  _debugActive = true;
  showDebugControls();
}

function onDebugEnd() {
  _debugActive = false;
  hideDebugControls();
  clearBreakpoints();
  // Clear debug line highlight
  document.querySelectorAll('.sh-line.debug-line').forEach(el => el.classList.remove('debug-line'));
}

function highlightDebugLine(lineIndex) {
  // Remove previous highlight
  document.querySelectorAll('.sh-line.debug-line').forEach(el => el.classList.remove('debug-line'));
  // Highlight in syntax-bg overlay
  const bg = document.getElementById('syntax-bg');
  if (bg) {
    const bgLines = bg.querySelectorAll('.sh-line');
    if (bgLines[lineIndex]) {
      bgLines[lineIndex].classList.add('debug-line');
      // Scroll the highlighted line into view
      bgLines[lineIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
  // Also scroll the textarea to keep it in sync
  const editor = document.getElementById('script-editor');
  if (editor) {
    const lines   = editor.value.split('\n');
    const lineH   = editor.scrollHeight / Math.max(lines.length, 1);
    editor.scrollTop = Math.max(0, lineIndex * lineH - editor.clientHeight / 2);
  }
}

// Override stopMacro to also hide debug controls
const originalStopMacro = stopMacro;
stopMacro = async function() {
    await originalStopMacro();
    hideDebugControls();
    clearBreakpoints();
    _debugActive = false;
};
window._breakpoints = new Set();

function toggleBreakpoint(lineIndex) {
    if (window._breakpoints.has(lineIndex)) {
        window._breakpoints.delete(lineIndex);
    } else {
        window._breakpoints.add(lineIndex);
    }
    if (typeof renderScriptLines === 'function') renderScriptLines();
}
async function debugScriptWithBreakpoints() {
    if (!checkApi()) return;
    const script = document.getElementById('script-editor').value.trim();
    if (!script) { toast('Script is empty!', 'warn'); return; }
    const _repeatRaw = parseInt(document.getElementById('repeat-count').value);
    const repeatVal  = isNaN(_repeatRaw) || _repeatRaw < 0 ? 1 : _repeatRaw;
    const breakpoints = Array.from(window._breakpoints);
    _debugActive = true;
    isRunning = true;
    _setRunningLockUI(true);
    setStatus('running', 'Debugging (breakpoints)...');
    document.getElementById('script-status').textContent = '🐞 Debug (BP)';
    document.getElementById('btn-pause-script').disabled = false;
    document.getElementById('btn-pause-script').textContent = '⏸ Pause';
    showDebugControls();
    try {
        const result = await withLoading(window.pywebview.api.start_debug_with_breakpoints(script, breakpoints, repeatVal));
        // Do NOT show indicator – keep main window visible for debugging
        // if (result && result.status === 'debugging') {
        //     window.pywebview.api.show_indicator().catch(() => {});
        // }
    } catch(e) { 
        console.error('Debug start error:', e);
        toast(`Error: ${e}`, 'error'); 
        setStatus('idle','Idle'); 
    }
}
function clearBreakpoints() {
    window._breakpoints.clear();
    if (typeof renderScriptLines === 'function') renderScriptLines();
}

function onScriptStopped() {
    isRunning = false;
    _setRunningLockUI(false);
    setStatus('idle', 'Stopped');
    const pauseBtn = document.getElementById('btn-pause-script');
    clearBreakpoints();
    if (pauseBtn) { pauseBtn.textContent = '⏸ Pause'; pauseBtn.disabled = true; }
    if (window.pywebview && window.pywebview.api) {
        window.pywebview.api.hide_indicator().catch(() => {});
    }
    document.getElementById('script-status').textContent = '⏹ Stopped';
}