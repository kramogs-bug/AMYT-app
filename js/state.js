/**
 * state.js — Shared application state and constants
 * All modules read/write these globals.
 */

// ── APP STATE ──────────────────────────────────────────────
let isRecording          = false;
let isRunning            = false;
let logInterval          = null;
let _previewTemplateName = '';
let _previewNaturalW     = 0;
let _previewNaturalH     = 0;
let _detectRegion        = null; // {x,y,w,h} or null

// ── BREAKPOINTS ────────────────────────────────────────────
// Make globally available so other scripts can access it
window._breakpoints = new Set();

// ── GLOBAL LOADING INDICATOR ───────────────────────────────
let _loadingCount = 0;
let _loadingStartTime = 0;
const MIN_LOADING_DURATION = 400; // milliseconds
const MAX_LOADING_TIME = 10000;   // 10 seconds – safety timeout
let _hideTimer = null;
let _forceHideTimer = null;

function setLoadingMessage(msg) {
    const el = document.getElementById('loading-message');
    if (el) el.textContent = msg;
}

function showGlobalLoading(message) {
    if (message) setLoadingMessage(message);
    if (_loadingCount === 0) {
        const el = document.getElementById('global-loading');
        if (el) {
            el.classList.remove('hidden');
            _loadingStartTime = Date.now();
            // Safety: force hide after MAX_LOADING_TIME
            if (_forceHideTimer) clearTimeout(_forceHideTimer);
            _forceHideTimer = setTimeout(() => {
                if (_loadingCount > 0) {
                    console.warn("Loading spinner forced hide after timeout");
                    _loadingCount = 0;
                    _hideLoadingNow();
                }
            }, MAX_LOADING_TIME);
        }
    }
    _loadingCount++;
}

function hideGlobalLoading() {
    if (_loadingCount > 0) {
        _loadingCount--;
        if (_loadingCount === 0) {
            // Clear safety timer
            if (_forceHideTimer) {
                clearTimeout(_forceHideTimer);
                _forceHideTimer = null;
            }
            const elapsed = Date.now() - _loadingStartTime;
            if (elapsed >= MIN_LOADING_DURATION) {
                _hideLoadingNow();
            } else {
                if (_hideTimer) clearTimeout(_hideTimer);
                _hideTimer = setTimeout(() => {
                    if (_loadingCount === 0) {
                        _hideLoadingNow();
                    }
                    _hideTimer = null;
                }, MIN_LOADING_DURATION - elapsed);
            }
        }
    }
}

function _hideLoadingNow() {
    const el = document.getElementById('global-loading');
    if (el) {
        el.classList.add('hidden');
        // Reset message to default for next time
        setLoadingMessage('Loading...');
    }
    if (_forceHideTimer) {
        clearTimeout(_forceHideTimer);
        _forceHideTimer = null;
    }
}

/**
 * Wraps an async function with loading indicator and a custom message.
 * Usage: const result = await withLoading(someAsyncFunction(), 'Custom message');
 */
async function withLoading(promiseOrFn, message = 'Loading...') {
    setLoadingMessage(message);
    showGlobalLoading();
    try {
        if (typeof promiseOrFn === 'function') {
            return await promiseOrFn();
        } else {
            return await promiseOrFn;
        }
    } finally {
        hideGlobalLoading();
    }
}

// ── UTILITIES ──────────────────────────────────────────────
function checkApi() {
  return typeof window.pywebview !== 'undefined' && !!window.pywebview.api;
}

async function nativeToast(message, type = 'info', duration = 3000) {
  try {
    if (window.pywebview && window.pywebview.api) {
      await window.pywebview.api.show_toast(message, type, duration);
      return;
    }
  } catch(e) {}
  toast(message, type);
}

function toast(message, type = 'info') {
  const el = document.getElementById('toast');
  if (!el) {
    console.error('Toast element not found');
    return;
  }
  el.textContent = message;
  el.className = `toast ${type}`;
  el.style.opacity = '1';
  clearTimeout(el._timeout);
  el._timeout = setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.className = 'toast hidden', 300);
  }, 3000);
}

// Make toast globally available (it already is, but ensure)
window.toast = toast;


function formatBytes(bytes) {
  if (bytes < 1024)    return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/1048576).toFixed(1)} MB`;
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── RUNNING GUARD ──────────────────────────────────────────
function _guardRunning(actionLabel) {
  if (!isRunning) return false;
  const label = actionLabel || 'this action';
  nativeToast(`⛔ Stop the macro first before you ${label}.`, 'warn', 4000);
  return true;
}

function _setRunningLockUI(running) {
  const lockIds = [
    'btn-record',
    'btn-pause',
    'btn-stop-rec',
    'btn-quick-save',
    'btn-run-cursor',
  ];
  lockIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = running;
  });

  document.querySelectorAll('.bld-btn').forEach(btn => {
    btn.disabled = running;
    btn.style.opacity  = running ? '0.4' : '';
    btn.style.pointerEvents = running ? 'none' : '';
  });

  const editor = document.getElementById('script-editor');
  if (editor) {
    editor.readOnly = running;
    editor.style.opacity = running ? '0.6' : '';
    editor.title = running ? '⛔ Stop the macro to edit the script' : '';
  }

  const linePanel = document.getElementById('line-panel');
  if (linePanel) linePanel.style.pointerEvents = running ? 'none' : '';
}

// ── CUSTOM CONFIRM DIALOG ──────────────────────────────────
let _confirmResolve = null;

function appConfirm({
  title    = 'Are you sure?',
  filename = '',
  warning  = 'This action cannot be undone.',
  okLabel  = 'Confirm',
  icon     = 'i-trash',
  kind     = 'danger',
} = {}) {
  return new Promise(resolve => {
    _confirmResolve = resolve;

    document.getElementById('confirm-title').textContent    = title;
    document.getElementById('confirm-filename').textContent = filename;
    document.getElementById('confirm-ok-label').textContent = okLabel;

    const warnEl = document.getElementById('confirm-warning');
    const warnTxt = document.getElementById('confirm-warning-text');
    if (warning) {
      warnEl.classList.remove('hidden');
      warnTxt.textContent = warning;
    } else {
      warnEl.classList.add('hidden');
    }

    document.getElementById('confirm-icon').querySelector('use')
      ?.setAttribute('href', `#${icon}`);
    document.getElementById('confirm-ok-icon').querySelector('use')
      ?.setAttribute('href', `#${icon}`);

    const iconWrap = document.getElementById('confirm-icon-wrap');
    const okBtn    = document.getElementById('confirm-ok-btn');
    iconWrap.className = `confirm-icon-wrap ${kind === 'danger' ? '' : kind}`.trim();
    okBtn.className    = `btn confirm-ok-btn${
      kind === 'warn' ? ' warn-ok' : kind === 'info' ? ' info-ok' : ''
    }`;

    const overlay = document.getElementById('confirm-overlay');
    overlay.classList.remove('hidden');

    requestAnimationFrame(() => {
      document.getElementById('confirm-cancel-btn')?.focus();
    });
  });
}

function _confirmOk() {
  document.getElementById('confirm-overlay').classList.add('hidden');
  if (_confirmResolve) { _confirmResolve(true); _confirmResolve = null; }
}

function _confirmCancel() {
  document.getElementById('confirm-overlay').classList.add('hidden');
  if (_confirmResolve) { _confirmResolve(false); _confirmResolve = null; }
}

function _confirmOverlayClick(e) {
  if (e.target.id === 'confirm-overlay') _confirmCancel();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const overlay = document.getElementById('confirm-overlay');
    if (overlay && !overlay.classList.contains('hidden')) {
      e.preventDefault(); e.stopPropagation();
      _confirmCancel();
    }
  }
  if (e.key === 'Enter') {
    const overlay = document.getElementById('confirm-overlay');
    if (overlay && !overlay.classList.contains('hidden')) {
      if (document.activeElement?.id === 'confirm-ok-btn') {
        e.preventDefault(); _confirmOk();
      }
    }
  }
}, { capture: true });