/**
 * templates.js — Template manager, preview/crop tool, quick detect
 */

// ── MANUAL COORDINATE CAPTURE / SAVE ─────────────────────

async function captureRegion() {
  if (_guardRunning('capture a region')) return;
  if (!checkApi()) return;
  const x = parseInt(document.getElementById('cap-x')?.value) || 0;
  const y = parseInt(document.getElementById('cap-y')?.value) || 0;
  const w = parseInt(document.getElementById('cap-w')?.value) || 200;
  const h = parseInt(document.getElementById('cap-h')?.value) || 100;
  if (w <= 0 || h <= 0) { toast('Width and height must be > 0', 'warn'); return; }
  try {
    const r = await withLoading(window.pywebview.api.capture_region(x, y, w, h));
    if (r.status === 'ok') toast(`Region captured → ${r.path}`, 'info');
    else toast(`Capture failed: ${r.message}`, 'error');
  } catch(e) { toast(`Error: ${e}`, 'error'); }
}

async function saveAsTemplate() {
  if (_guardRunning('save a template')) return;
  if (!checkApi()) return;
  const nameInput = document.getElementById('capture-name');
  const name = nameInput ? nameInput.value.trim() : '';
  if (!name) { toast('Enter a template name first!', 'warn'); nameInput?.focus(); return; }
  const x = parseInt(document.getElementById('cap-x')?.value) || 0;
  const y = parseInt(document.getElementById('cap-y')?.value) || 0;
  const w = parseInt(document.getElementById('cap-w')?.value) || 200;
  const h = parseInt(document.getElementById('cap-h')?.value) || 100;
  if (w <= 0 || h <= 0) { toast('Width and height must be > 0', 'warn'); return; }
  try {
    const r = await withLoading(window.pywebview.api.save_as_template(x, y, w, h, name));
    if (r.status === 'ok') {
      toast(`Template "${name}" saved!`, 'info');
      await showTemplatePreview(name, w, h);
      loadTemplates();
    } else { toast(`Save failed: ${r.message}`, 'error'); }
  } catch(e) { toast(`Error: ${e}`, 'error'); }
}

async function selectAndCapture() {
  if (_guardRunning('capture a template')) return;
  if (!checkApi()) return;
  const nameInput = document.getElementById('capture-name');
  if (!nameInput) { toast('Capture name input not found', 'error'); return; }

  nameInput.value = nameInput.value.replace(/ /g, '_');
  const name = nameInput.value.trim();
  if (!name) { toast('Enter a template name first!', 'warn'); return; }

  const VALID_NAME = /^[a-zA-Z0-9_-]+$/;
  if (!VALID_NAME.test(name)) {
    const badChars = [...new Set(name.replace(/[a-zA-Z0-9_-]/g, ''))].join(' ');
    toast(`Invalid name — only letters, numbers, _ and - are allowed. Bad chars: ${badChars}`, 'error');
    nameInput.focus(); nameInput.select(); return;
  }

  try {
    const existing = await withLoading(window.pywebview.api.get_templates());
    const names = (existing.templates || []).map(t => t.name.replace('.png','').toLowerCase());
    if (names.includes(name.toLowerCase())) {
      toast(`Template "${name}" already exists! Rename it or delete the existing one first.`, 'error');
      nameInput.focus(); nameInput.select(); return;
    }
  } catch(e) { /* proceed anyway */ }

  toast('Overlay opening — draw your region!', 'info');
  try {
    const result = await withLoading(window.pywebview.api.select_and_capture(name));
    if (result.status === 'cancelled') { toast('Capture cancelled', 'warn'); return; }
    if (result.status === 'error')     { toast(result.message, 'error'); return; }

    const capX = document.getElementById('cap-x');
    const capY = document.getElementById('cap-y');
    const capW = document.getElementById('cap-w');
    const capH = document.getElementById('cap-h');
    if (capX) capX.value = result.x;
    if (capY) capY.value = result.y;
    if (capW) capW.value = result.w;
    if (capH) capH.value = result.h;

    const fb = document.getElementById('capture-feedback');
    if (fb) {
      fb.classList.remove('hidden');
      fb.textContent = `✓ Saved "${name}.png"  |  ${result.w}×${result.h}px  at (${result.x}, ${result.y})`;
    }

    await showTemplatePreview(name, result.w, result.h);
    toast(`Template "${name}" saved!`, 'info');
    loadTemplates();
  } catch(e) {
    console.error('Capture error:', e);
    toast(`Error: ${e.message}`, 'error');
  }
}

// ── PREVIEW ────────────────────────────────────────────────

async function showTemplatePreview(name, w, h) {
  try {
    const data = await withLoading(window.pywebview.api.get_template_preview(name));
    if (data.status !== 'ok') return;

    _previewTemplateName = name;

    const img          = document.getElementById('preview-img');
    const previewLabel = document.getElementById('preview-label');
    const previewInfo  = document.getElementById('preview-info');
    const previewBox   = document.getElementById('preview-box');
    const cropW = document.getElementById('crop-w');
    const cropH = document.getElementById('crop-h');

    if (!img || !previewLabel || !previewInfo || !previewBox) {
      toast('Preview UI not available – please stay in the Macro Editor tab', 'warn'); return;
    }

    previewLabel.textContent = `📄 ${name}.png`;
    img.src = data.data;
    previewInfo.textContent  = `${w} × ${h} px  •  storage/templates/${name}.png  •  Ready for detection`;
    previewBox.classList.remove('hidden');

    if (cropW) cropW.value = w;
    if (cropH) cropH.value = h;

    clearCropCanvas();
    try {
      const r = await withLoading(window.pywebview.api.check_template_has_backup(name));
      _macroShowRestoreBtn(name, r.has_backup);
    } catch(e) { _macroShowRestoreBtn(name, false); }
  } catch(e) {
    console.error('Preview error:', e);
    toast(`Preview error: ${e.message}`, 'error');
  }
}

function usePreviewTemplate() {
  if (!_previewTemplateName) { toast('No template loaded!', 'warn'); return; }
  const base = _previewTemplateName.replace('.png', '');
  showTab('macro');
  setTimeout(() => {
    openImgAction('FIND_CLICK');
    requestAnimationFrame(() => {
      const sel = document.getElementById('img-action-template');
      if (sel) {
        for (const opt of sel.options) {
          if (opt.value.replace(/\.png$/i,'') === base) { sel.value = opt.value; break; }
        }
        imgActionPreview();
      }
    });
  }, 80);
}

function toggleCropTool() {
  const cropTool = document.getElementById('crop-tool');
  if (!cropTool) return;
  cropTool.classList.toggle('hidden');
  if (!cropTool.classList.contains('hidden')) updateCropPreview();
  else clearCropCanvas();
}

function closePreview() {
  const previewBox = document.getElementById('preview-box');
  if (previewBox) previewBox.classList.add('hidden');
  const cropTool = document.getElementById('crop-tool');
  if (cropTool) cropTool.classList.add('hidden');
  clearCropCanvas();
  _previewTemplateName = '';
}

// ── CROP CANVAS ────────────────────────────────────────────
function onPreviewImageLoad() {
  const img = document.getElementById('preview-img');
  if (!img) return;
  _previewNaturalW = img.naturalWidth;
  _previewNaturalH = img.naturalHeight;
  updateCropPreview();
}

function updateCropPreview() {
  const cropTool = document.getElementById('crop-tool');
  if (cropTool.classList.contains('hidden')) return;
  const img = document.getElementById('preview-img');
  if (!img.src || !_previewNaturalW) return;

  const cropX = parseInt(document.getElementById('crop-x').value) || 0;
  const cropY = parseInt(document.getElementById('crop-y').value) || 0;
  const cropW = parseInt(document.getElementById('crop-w').value) || 0;
  const cropH = parseInt(document.getElementById('crop-h').value) || 0;

  const canvas  = document.getElementById('crop-canvas');
  const wrap    = document.getElementById('preview-img-wrap');
  canvas.width  = wrap.clientWidth;
  canvas.height = wrap.clientHeight;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const imgRect  = img.getBoundingClientRect();
  const wrapRect = wrap.getBoundingClientRect();
  const imgLeft  = imgRect.left - wrapRect.left;
  const imgTop   = imgRect.top  - wrapRect.top;
  const imgW     = imgRect.width;
  const imgH     = imgRect.height;
  const scaleX   = imgW / _previewNaturalW;
  const scaleY   = imgH / _previewNaturalH;

  const rx = imgLeft + cropX * scaleX;
  const ry = imgTop  + cropY * scaleY;
  const rw = cropW   * scaleX;
  const rh = cropH   * scaleY;

  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(imgLeft, imgTop, imgW, imgH);
  ctx.clearRect(rx, ry, rw, rh);

  ctx.strokeStyle = '#00ff88';
  ctx.lineWidth   = 2;
  ctx.strokeRect(rx, ry, rw, rh);

  const hs = 6;
  ctx.fillStyle = '#00ff88';
  [[rx,ry],[rx+rw-hs,ry],[rx,ry+rh-hs],[rx+rw-hs,ry+rh-hs]].forEach(([hx,hy]) => {
    ctx.fillRect(hx, hy, hs, hs);
  });
  ctx.fillStyle = '#00ff88';
  ctx.font = 'bold 11px Segoe UI, sans-serif';
  ctx.fillText(`${cropW} × ${cropH}`, rx + 4, ry - 5);

  drawLiveCrop(img, cropX, cropY, cropW, cropH);
}

function drawLiveCrop(img, cropX, cropY, cropW, cropH) {
  if (cropW <= 0 || cropH <= 0) return;
  const liveWrap   = document.getElementById('crop-live-wrap');
  const liveCanvas = document.getElementById('crop-live-canvas');

  const sx = Math.max(0, cropX);
  const sy = Math.max(0, cropY);
  const sw = Math.min(_previewNaturalW - sx, cropW);
  const sh = Math.min(_previewNaturalH - sy, cropH);

  if (sw <= 0 || sh <= 0) { liveWrap.classList.add('hidden'); return; }

  const maxW  = 280;
  const scale = Math.min(1, maxW / sw);
  const dw    = Math.round(sw * scale);
  const dh    = Math.round(sh * scale);

  liveCanvas.width  = dw;
  liveCanvas.height = dh;

  const ctx = liveCanvas.getContext('2d');
  ctx.clearRect(0, 0, dw, dh);
  ctx.imageSmoothingEnabled = false;

  const tmp    = document.createElement('canvas');
  tmp.width    = _previewNaturalW;
  tmp.height   = _previewNaturalH;
  tmp.getContext('2d').drawImage(img, 0, 0, _previewNaturalW, _previewNaturalH);
  const srcData = tmp.getContext('2d').getImageData(sx, sy, sw, sh);

  const tmpSmall = document.createElement('canvas');
  tmpSmall.width = sw; tmpSmall.height = sh;
  tmpSmall.getContext('2d').putImageData(srcData, 0, 0);
  ctx.drawImage(tmpSmall, 0, 0, sw, sh, 0, 0, dw, dh);

  liveWrap.classList.remove('hidden');
}

function clearCropCanvas() {
  const canvas = document.getElementById('crop-canvas');
  if (!canvas) return;
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  document.getElementById('crop-live-wrap')?.classList.add('hidden');
}

async function cropImage() {
  if (_guardRunning('crop a template')) return;
  if (!checkApi()) return;
  if (!_previewTemplateName) { toast('No image loaded to crop!', 'warn'); return; }

  const cropX = parseInt(document.getElementById('crop-x').value) || 0;
  const cropY = parseInt(document.getElementById('crop-y').value) || 0;
  const cropW = parseInt(document.getElementById('crop-w').value) || 0;
  const cropH = parseInt(document.getElementById('crop-h').value) || 0;
  if (cropW <= 0 || cropH <= 0) { toast('Width and height must be > 0', 'warn'); return; }

  const base = _previewTemplateName.replace('.png','');
  try {
    const result = await withLoading(window.pywebview.api.crop_template(base, cropX, cropY, cropW, cropH, base, true));
    if (result.status === 'error') { toast(result.message, 'error'); return; }

    document.getElementById('preview-label').textContent = `📄 ${base}.png  (cropped)`;
    document.getElementById('preview-img').src           = result.data;
    document.getElementById('preview-info').textContent  =
      `${result.w} × ${result.h} px  •  storage/templates/${base}.png  •  Ready for detection`;

    const fb = document.getElementById('crop-feedback');
    fb.classList.remove('hidden');
    fb.textContent = `✓ Cropped "${base}.png"  (${result.w}×${result.h}px)`;

    _macroShowRestoreBtn(base, result.has_backup);
    clearCropCanvas();
    document.getElementById('crop-tool').classList.add('hidden');
    toast(`Cropped & saved "${base}.png"!`, 'info');
    loadTemplates();
  } catch(e) { toast(`Crop error: ${e}`, 'error'); }
}

async function restoreMacroOriginal() {
  if (_guardRunning('restore a template')) return;
  if (!checkApi() || !_previewTemplateName) return;
  const base = _previewTemplateName.replace('.png','');
  const ok = await appConfirm({
    title: 'Restore Original', filename: `${base}.png`,
    warning: 'The current cropped version will be permanently replaced.',
    okLabel: 'Restore', icon: 'i-refresh', kind: 'warn',
  });
  if (!ok) return;
  try {
    const result = await withLoading(window.pywebview.api.restore_template_original(base));
    if (result.status === 'error') { toast(result.message, 'error'); return; }

    document.getElementById('preview-img').src           = result.data;
    document.getElementById('preview-label').textContent = `📄 ${base}.png`;
    document.getElementById('preview-info').textContent  =
      `${result.w} × ${result.h} px  •  storage/templates/${base}.png  •  Ready for detection`;

    const fb = document.getElementById('crop-feedback');
    fb.classList.remove('hidden');
    fb.textContent = `↩ Restored original "${base}.png"  (${result.w}×${result.h}px)`;

    _macroShowRestoreBtn(base, false);
    clearCropCanvas();
    toast(`Original restored for "${base}.png"`, 'info');
    loadTemplates();
  } catch(e) { toast(`Restore error: ${e}`, 'error'); }
}

function _macroShowRestoreBtn(base, show) {
  let btn = document.getElementById('macro-restore-btn');
  if (!btn) {
    const actions = document.querySelector('.preview-actions');
    if (actions) {
      btn = document.createElement('button');
      btn.id        = 'macro-restore-btn';
      btn.className = 'btn btn-xs btn-danger-xs';
      btn.title     = 'Restore original image';
      btn.innerHTML = '↩ Restore Original';
      btn.onclick   = restoreMacroOriginal;
      actions.insertBefore(btn, actions.lastElementChild);
    }
  }
  if (btn) btn.style.display = show ? '' : 'none';
}

// ── TEMPLATE MANAGER ───────────────────────────────────────
async function loadTemplates() {
  if (!checkApi()) return;
  try {
    const result = await withLoading(window.pywebview.api.get_templates());
    const list      = document.getElementById('template-list');
    const templates = result.templates;
    if (!templates || templates.length === 0) {
      list.innerHTML = '<p class="empty-msg" style="padding:2rem;text-align:center;color:#888">No templates yet.<br><small>Use the Macro tab to capture your first template.</small></p>';
      return;
    }

    const TYPE_ICON  = { IMAGE: '🖼️', TEXT: '🔤', COLOR: '🎨' };
    const TYPE_LABEL = { IMAGE: 'IMAGE', TEXT: 'TEXT', COLOR: 'COLOR' };
    const TYPE_CLASS = { IMAGE: '', TEXT: 'tpl-badge-text', COLOR: 'tpl-badge-color' };

    list.innerHTML = templates.map(t => {
      const type     = t.type || 'IMAGE';
      const dispName = t.name.replace('.png', '');
      const badge    = type !== 'IMAGE'
        ? `<span class="tpl-type-badge ${TYPE_CLASS[type]}">${TYPE_LABEL[type]}</span>`
        : '';
      const metaLine = _metaLine(t);
      return `
      <div class="tpl-card-new" id="tpl-card-${t.name}" onclick="openTplEditor('${t.name}')" data-type="${type}">
        <div class="tpl-card-thumb">
          <img data-name="${t.name}" alt="" onerror="this.style.display='none'"/>
          <span class="tpl-card-placeholder-icon">${TYPE_ICON[type] || '🖼️'}</span>
        </div>
        <div class="tpl-card-info">
          <div class="tpl-card-name">${dispName} ${badge}</div>
          <div class="tpl-card-meta">${metaLine || formatBytes(t.size)}</div>
        </div>
        <div class="tpl-card-arrow">›</div>
      </div>`;
    }).join('');

    // Only load thumbnails for IMAGE type
    templates.filter(t => (t.type || 'IMAGE') === 'IMAGE').forEach(t => loadThumb(t.name));
  } catch(e) { toast(`Error: ${e}`, 'error'); }
}

function _metaLine(t) {
  if (!t.meta) return null;
  if (t.meta.type === 'TEXT')  return `"${t.meta.text}" · conf ${t.meta.confidence}`;
  if (t.meta.type === 'COLOR') return `${t.meta.color} · tol ${t.meta.tolerance}`;
  return null;
}
async function loadThumb(name) {
  if (!checkApi()) return;
  try {
    const base = name.replace('.png','');
    const data = await withLoading(window.pywebview.api.get_template_preview(base));
    if (data.status === 'ok') {
      document.querySelectorAll(`.tpl-card-thumb img[data-name="${name}"],#tpl-edit-img`).forEach(img => {
        if (img.id === 'tpl-edit-img' && _tplEditName !== name) return;
        img.src = data.data;
        img.style.display = 'block';
        const ph = img.closest('.tpl-card-thumb')?.querySelector('.tpl-card-placeholder-icon');
        if (ph) ph.style.display = 'none';
      });
      if (_tplEditName === name) {
        const edImg = document.getElementById('tpl-edit-img');
        edImg.src = data.data; edImg.style.display = 'block';
        document.getElementById('tpl-img-overlay').style.display = 'none';
      }
    }
  } catch(e) {}
}

// ── TEMPLATE EDITOR ────────────────────────────────────────
let _tplEditName  = '';
let _tplDirtyName = false;
let _tplDirty     = false;

function tplMarkDirty(field) {
  _tplDirty = true;
  if (field === 'name') _tplDirtyName = true;
  document.getElementById('tpl-unsaved-dot').classList.remove('hidden');
  // Save button stays always-enabled — never gate it behind dirty state
}

function tplClearDirty() {
  _tplDirty = false; _tplDirtyName = false;
  document.getElementById('tpl-unsaved-dot').classList.add('hidden');
  // Do NOT disable the button — it must always remain clickable
}

async function openTplEditor(name) {
  if (!checkApi()) return;
  if (_tplDirty && _tplEditName && _tplEditName !== name) {
    const ok = await appConfirm({
      title: 'Unsaved Changes', filename: _tplEditName,
      warning: 'Your unsaved changes will be discarded.',
      okLabel: 'Discard', icon: 'i-x-close', kind: 'warn',
    });
    if (!ok) return;
  }
  _tplEditName = name;
  const base = name.replace('.png','');

  document.querySelectorAll('.tpl-card-new').forEach(c => c.classList.remove('active'));
  const card = document.getElementById(`tpl-card-${name}`);
  if (card) card.classList.add('active');

  document.getElementById('tpl-empty-state').classList.add('hidden');
  document.getElementById('tpl-editor-inner').classList.remove('hidden');

  document.getElementById('tpl-edit-name').textContent  = name;
  document.getElementById('tpl-rename-input').value     = base;
  document.getElementById('tpl-scan-result').classList.add('hidden');
  document.getElementById('tpl-preview-placeholder').style.display = 'flex';
  tplHideCmdSuggestions();
  if (typeof _tplLiveRunning !== 'undefined' && _tplLiveRunning) _tplStopLive();

  const canvas = document.getElementById('tpl-preview-canvas');
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  tplClearDirty();

  const cropTool = document.getElementById('tpl-crop-tool');
  if (cropTool) cropTool.classList.add('hidden');
  document.getElementById('tpl-crop-live-wrap')?.classList.add('hidden');
  const cropFb = document.getElementById('tpl-crop-feedback');
  if (cropFb) cropFb.classList.add('hidden');

  try {
    const data  = await withLoading(window.pywebview.api.get_template_preview(base));
    const edImg = document.getElementById('tpl-edit-img');
    if (data.status === 'ok') {
      edImg.src = data.data; edImg.style.display = 'block';
      document.getElementById('tpl-img-overlay').style.display = 'none';
    } else {
      edImg.style.display = 'none';
      document.getElementById('tpl-img-overlay').style.display = 'flex';
    }
  } catch(e) {}

  await tplRefreshRegionDisplay();
  _tplShowRestoreBtn(base, undefined);
}

async function tplRefreshRegionDisplay() {
  if (!checkApi()) return;
  const base = _tplEditName.replace('.png','');
  try {
    const r       = await withLoading(window.pywebview.api.get_template_search_region(base));
    const box     = document.getElementById('tpl-region-status');
    const titl    = document.getElementById('tpl-region-title');
    const sub     = document.getElementById('tpl-region-sub');
    const clrBtn  = document.getElementById('tpl-region-clear-btn');
    const clrBtn2 = document.getElementById('tpl-clear-region-btn2');

    if (r.region) {
      box.classList.add('active');
      titl.textContent = `📐 Region: (${r.region.x}, ${r.region.y})  ${r.region.w} × ${r.region.h} px`;
      if (sub) sub.textContent = 'Macro will only search within this area.';
      if (clrBtn)  clrBtn.style.display  = '';
      if (clrBtn2) clrBtn2.style.display = 'none';
    } else {
      box.classList.remove('active');
      titl.textContent = 'No region set — searches full screen';
      if (sub) sub.textContent = '';
      if (clrBtn)  clrBtn.style.display  = 'none';
      if (clrBtn2) clrBtn2.style.display = 'none';
    }
  } catch(e) {}
}

async function tplSaveChanges() {
  if (_guardRunning('save template changes')) return;
  if (!checkApi()) return;
  if (!_tplEditName) { toast('No template selected', 'warn'); return; }

  const base    = _tplEditName.replace(/\.png$/i, '');
  const newBase = (document.getElementById('tpl-rename-input').value || '').trim();

  // Bug fix: validate name is not empty before doing anything
  if (!newBase) {
    toast('Template name cannot be empty', 'error');
    document.getElementById('tpl-rename-input').focus();
    return;
  }

  // No rename needed
  if (newBase === base) {
    tplClearDirty();
    nativeToast('\u2705 Template up to date', 'success');
    return;
  }

  // Rename needed — clear dirty ONLY after success (bug fix: was clearing before)
  try {
    await withLoading(window.pywebview.api.rename_template(_tplEditName, newBase));
    const newName = newBase.endsWith('.png') ? newBase : newBase + '.png';
    _tplEditName  = newName;
    document.getElementById('tpl-edit-name').textContent = newName;
    tplClearDirty();
    nativeToast('\u{1F4BE} Renamed to "' + newBase + '"', 'success');
    loadTemplates();
  } catch(e) {
    // Bug fix: do NOT clear dirty state on failure so user can retry
    toast('Rename failed: ' + e, 'error');
  }
}

async function tplRename() { await tplSaveChanges(); }

async function tplRecapture() {
  if (_guardRunning('recapture a template')) return;
  if (!checkApi()) return;
  toast('Overlay opening — draw the new image region!', 'info');
  try {
    const base = _tplEditName.replace('.png','');
    const r = await withLoading(window.pywebview.api.recapture_template(base));
    if (r.status === 'cancelled') { toast('Cancelled', 'warn'); return; }
    if (r.status === 'error')     { toast(r.message, 'error'); return; }
    nativeToast(`📷 Recaptured! ${r.w}×${r.h}px`, 'success');
    const data = await withLoading(window.pywebview.api.get_template_preview(base));
    if (data.status === 'ok') {
      const img = document.getElementById('tpl-edit-img');
      img.src = data.data; img.style.display = 'block';
      document.getElementById('tpl-img-overlay').style.display = 'none';
    }
    loadTemplates();
  } catch(e) { toast(`Error: ${e}`, 'error'); }
}

async function tplSetRegion() {
  if (_guardRunning('set a search region')) return;
  if (!checkApi()) return;
  toast('Draw the search region on your screen', 'info');
  try {
    const base = _tplEditName.replace('.png','');
    const r = await withLoading(window.pywebview.api.set_template_search_region(base));
    if (r.status === 'cancelled') { toast('Cancelled', 'warn'); return; }
    nativeToast(`📐 Search region set: ${r.w}×${r.h}px`, 'success');
    await tplRefreshRegionDisplay();

    const qdName = (document.getElementById('detect-name')?.value || '').trim();
    if (qdName && qdName.replace(/\.png$/i,'') === base) {
      _detectRegion = { x: r.x, y: r.y, w: r.w, h: r.h };
      updateDetectRegionDisplay();
    }
    const tplEntry = _detectDropdownTemplates.find(
      t => t.name.replace(/\.png$/i,'') === base
    );
    if (tplEntry) tplEntry.hasRegion = true;
  } catch(e) { toast(`Error: ${e}`, 'error'); }
}

async function tplClearRegion() {
  if (!checkApi()) return;
  const base = _tplEditName.replace('.png','');
  try {
    await withLoading(window.pywebview.api.clear_template_search_region(base));
    toast('Search region cleared — using full screen', 'info');
    await tplRefreshRegionDisplay();

    const qdName = (document.getElementById('detect-name')?.value || '').trim();
    if (qdName && qdName.replace(/\.png$/i,'') === base) {
      _detectRegion = null;
      updateDetectRegionDisplay();
    }
    const tplEntry = _detectDropdownTemplates.find(
      t => t.name.replace(/\.png$/i,'') === base
    );
    if (tplEntry) tplEntry.hasRegion = false;
  } catch(e) { toast(`Error: ${e}`, 'error'); }
}

async function tplScanScreen() {
  if (!checkApi()) return;
  const base   = _tplEditName.replace('.png','');
  const badge  = document.getElementById('tpl-match-badge-new');
  const holder = document.getElementById('tpl-preview-placeholder');
  const canvas = document.getElementById('tpl-preview-canvas');
  const result = document.getElementById('tpl-scan-result');

  // Read confidence and multi-scale option
  const confInput   = document.getElementById('tpl-scan-confidence');
  const msCheckbox  = document.getElementById('tpl-multiscale');
  const conf        = confInput ? (parseFloat(confInput.value) || 0.1) : 0.1;
  const multiScale  = msCheckbox ? msCheckbox.checked : true;

  result.classList.remove('hidden');
  badge.textContent = '⏳ Scanning…';
  badge.className   = 'tpl-match-badge-new scanning';
  holder.style.display = 'flex';

  try {
    const r = await withLoading(window.pywebview.api.capture_screen_with_region_highlight(base, conf, multiScale));
    if (r.status !== 'ok') { toast('Scan failed', 'error'); return; }
    holder.style.display = 'none';
    const img = new Image();
    img.onload = () => {
      canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      if (r.region) {
        const [rx,ry,rw,rh] = [r.region[0]*r.scale, r.region[1]*r.scale, r.region[2]*r.scale, r.region[3]*r.scale];
        ctx.strokeStyle = '#e67e22'; ctx.lineWidth = 3; ctx.setLineDash([8,4]);
        ctx.strokeRect(rx, ry, rw, rh); ctx.setLineDash([]);
        ctx.fillStyle = '#e67e22'; ctx.font = 'bold 13px Segoe UI';
        ctx.fillText('Search Region', rx+4, ry+16);
      }

      const matches = r.matches || [];
      if (matches.length > 0) {
        matches.sort((a, b) => b.confidence - a.confidence);
        matches.forEach((match, index) => {
          const mx = match.x - match.w / 2;
          const my = match.y - match.h / 2;
          const confPercent = Math.round(match.confidence * 100);
          
          const color = (index === 0) ? '#27ae60' : '#3498db';
          ctx.strokeStyle = color; 
          ctx.lineWidth = (index === 0) ? 3 : 2;
          ctx.strokeRect(mx, my, match.w, match.h);
          
          ctx.fillStyle = color.replace(')', ',0.1)').replace('rgb', 'rgba');
          ctx.fillRect(mx, my, match.w, match.h);
          
          ctx.fillStyle = color;
          ctx.font = (index === 0) ? 'bold 13px Segoe UI' : '12px Segoe UI';
          ctx.fillText(`${confPercent}%`, mx + 4, my - 6);
        });

        const topConf  = Math.round(matches[0].confidence * 100);
        const scaleNote = multiScale ? ' (multi-scale)' : '';
        badge.textContent = `✅ Found ${matches.length} match(es), best ${topConf}%${scaleNote}`;
        badge.className   = 'tpl-match-badge-new found';
        tplShowCmdSuggestions(base, conf);
      } else {
        const hint = multiScale
          ? `❌ No matches at ${Math.round(conf*100)}% — try lowering confidence`
          : `❌ No matches — try enabling multi-scale or lower confidence`;
        badge.textContent = hint;
        badge.className   = 'tpl-match-badge-new notfound';
        tplHideCmdSuggestions();
      }
    };
    img.src = r.screen;
  } catch(e) { toast(`Scan error: ${e}`, 'error'); result.classList.add('hidden'); }
}

// ── LIVE DETECT FPS + INDICATOR HELPERS ───────────────────────────────────

function _liveInterval(sliderId) {
  const fps = parseInt(document.getElementById(sliderId)?.value || '3') || 3;
  return Math.round(1000 / fps);
}

// Templates tab
function tplFpsChange() {
  const v = document.getElementById('tpl-fps-slider').value;
  const lbl = document.getElementById('tpl-fps-label');
  if (lbl) lbl.textContent = v + ' fps';
}
function tplIndicatorToggle() {
  const show = document.getElementById('tpl-indicator-toggle')?.checked;
  const status = document.getElementById('tpl-live-status');
  const legend = document.getElementById('tpl-live-legend');
  if (status && _tplLiveRunning) status.style.display = show ? 'flex' : 'none';
  if (legend && _tplLiveRunning) legend.style.display = show ? 'flex' : 'none';
}

// Quick Detect tab
function qdFpsChange() {
  const v = document.getElementById('qd-fps-slider').value;
  const lbl = document.getElementById('qd-fps-label');
  if (lbl) lbl.textContent = v + ' fps';
}
function qdIndicatorToggle() {
  const show = document.getElementById('qd-indicator-toggle')?.checked;
  const status = document.getElementById('qd-live-status');
  const legend = document.getElementById('qd-live-legend');
  if (status && _liveDetectRunning) status.style.display = show ? 'flex' : 'none';
  if (legend && _liveDetectRunning) legend.style.display = show ? 'flex' : 'none';
}

// ── LIVE DETECT (Templates tab) ────────────────────────────────────────────
let _tplLiveRunning = false;
let _tplLiveStop    = false;
let _tplLiveFrames  = [];

async function tplToggleLiveDetect() {
  if (_tplLiveRunning) { _tplStopLive(); return; }
  if (!checkApi()) return;
  if (!_tplEditName) { toast('Select a template first', 'warn'); return; }

  const base       = _tplEditName.replace('.png','');
  const conf       = parseFloat(document.getElementById('tpl-scan-confidence')?.value || '0.5') || 0.5;
  const multiScale = document.getElementById('tpl-multiscale')?.checked ?? true;

  _tplLiveRunning = true;
  _tplLiveStop    = false;
  _tplLiveFrames  = [];

  const btn = document.getElementById('tpl-live-btn');
  if (btn) { btn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-square-stop"/></svg> Stop Live'; btn.classList.replace('btn-primary','btn-danger'); }

  document.getElementById('tpl-live-status').style.display = 'flex';
  document.getElementById('tpl-live-legend').style.display = 'flex';
  document.getElementById('tpl-static-legend').style.display = 'none';
  tplHideCmdSuggestions();
  // Respect indicator toggle
  tplIndicatorToggle();

  const result      = document.getElementById('tpl-scan-result');
  const placeholder = document.getElementById('tpl-preview-placeholder');
  const canvas      = document.getElementById('tpl-preview-canvas');
  const badge       = document.getElementById('tpl-match-badge-new');
  result.classList.remove('hidden');
  placeholder.style.display = 'flex';
  canvas.style.display = 'none';

  while (!_tplLiveStop) {
    const t0 = performance.now();
    try {
      const r = await window.pywebview.api.capture_screen_with_region_highlight(base, conf, multiScale);
      if (_tplLiveStop) break;
      if (!r || r.status !== 'ok') { await _tplSleep(500); continue; }
      await _tplDrawLiveFrame(r, canvas, placeholder, badge, conf);

      const now = performance.now();
      _tplLiveFrames.push(now);
      _tplLiveFrames = _tplLiveFrames.filter(t => now - t < 1000);
      const fpsEl = document.getElementById('tpl-live-fps');
      if (fpsEl) fpsEl.textContent = `${_tplLiveFrames.length} fps`;

      const matches = r.matches || [];
      const labelEl = document.getElementById('tpl-live-label');
      if (labelEl) {
        labelEl.textContent = matches.length > 0
          ? `Live — ${matches.length} match${matches.length > 1 ? 'es' : ''}, best ${Math.round(matches[0].confidence * 100)}%`
          : `Live — no match at ${Math.round(conf * 100)}%`;
      }
    } catch(e) {
      if (_tplLiveStop) break;
      await _tplSleep(500);
    }
    const wait = Math.max(0, _liveInterval('tpl-fps-slider') - (performance.now() - t0));
    if (wait > 0) await _tplSleep(wait);
  }
  _tplLiveRunning = false;
}

function _tplStopLive() {
  _tplLiveStop    = true;
  _tplLiveRunning = false;
  const btn = document.getElementById('tpl-live-btn');
  if (btn) { btn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-target"/></svg> Live Detect'; btn.classList.replace('btn-danger','btn-primary'); }
  document.getElementById('tpl-live-status').style.display = 'none';
  document.getElementById('tpl-live-legend').style.display = 'none';
  document.getElementById('tpl-static-legend').style.display = '';
  const badge = document.getElementById('tpl-match-badge-new');
  if (badge) { badge.textContent = 'Live detect stopped'; badge.className = 'tpl-match-badge-new scanning'; }
}

function _tplSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function _tplColorForConf(c) {
  if (c >= 0.85) return { stroke:'#27ae60', fill:'rgba(39,174,96,0.12)' };
  if (c >= 0.70) return { stroke:'#f1c40f', fill:'rgba(241,196,15,0.12)' };
  return               { stroke:'#e74c3c', fill:'rgba(231,76,60,0.12)' };
}

function _tplDrawLiveFrame(r, canvas, placeholder, badge, conf) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      if (r.region) {
        const [rx,ry,rw,rh] = r.region.map(v => v * r.scale);
        ctx.strokeStyle='#e67e22'; ctx.lineWidth=2; ctx.setLineDash([8,4]);
        ctx.strokeRect(rx,ry,rw,rh); ctx.setLineDash([]);
        ctx.fillStyle='rgba(230,126,34,0.08)'; ctx.fillRect(rx,ry,rw,rh);
        ctx.fillStyle='#e67e22'; ctx.font='bold 12px Segoe UI,sans-serif';
        ctx.fillText('Search Region', rx+4, ry+14);
      }

      const matches = (r.matches||[]).slice().sort((a,b)=>b.confidence-a.confidence);
      matches.forEach((m,i) => {
        const sx = m.x - m.w/2, sy = m.y - m.h/2;
        const {stroke,fill} = _tplColorForConf(m.confidence);
        ctx.strokeStyle=stroke; ctx.lineWidth=i===0?3:2;
        ctx.strokeRect(sx,sy,m.w,m.h);
        ctx.fillStyle=fill; ctx.fillRect(sx,sy,m.w,m.h);
        if (i===0) {
          const cs=10; ctx.lineWidth=3;
          [[sx,sy,1,1],[sx+m.w,sy,-1,1],[sx,sy+m.h,1,-1],[sx+m.w,sy+m.h,-1,-1]].forEach(([cx,cy,dx,dy])=>{
            ctx.beginPath(); ctx.moveTo(cx+dx*cs,cy); ctx.lineTo(cx,cy); ctx.lineTo(cx,cy+dy*cs); ctx.stroke();
          });
        }
        const pct = Math.round(m.confidence*100);
        const label = `#${i+1} — ${pct}%`;
        ctx.font=`${i===0?'bold ':' '}12px Segoe UI,sans-serif`;
        const tw = ctx.measureText(label).width;
        const lx = Math.min(sx, canvas.width - tw - 6);
        const ly = sy > 18 ? sy - 4 : sy + m.h + 14;
        ctx.fillStyle=stroke; ctx.fillRect(lx-2,ly-12,tw+6,16);
        ctx.fillStyle='#fff'; ctx.fillText(label,lx,ly);
      });

      if (matches.length > 0) {
        badge.textContent = `✅ ${matches.length} match${matches.length>1?'es':''} — best ${Math.round(matches[0].confidence*100)}%`;
        badge.className = 'tpl-match-badge-new found';
      } else {
        badge.textContent = `❌ No match at ${Math.round(conf*100)}% — try lowering confidence`;
        badge.className = 'tpl-match-badge-new notfound';
      }
      placeholder.style.display='none'; canvas.style.display='block';
      resolve();
    };
    img.onerror = resolve;
    img.src = r.screen;
  });
}

// ── SCRIPT COMMAND SUGGESTIONS ─────────────────────────────────────────────
// Shown after a successful scan so the user can copy the tuned confidence
// straight into a script command.

function tplShowCmdSuggestions(templateBase, conf) {
  const box  = document.getElementById('tpl-cmd-suggestions');
  const list = document.getElementById('tpl-cmd-list');
  if (!box || !list) return;

  const c    = conf.toFixed(2);
  const name = templateBase;

  // Commands to suggest — ordered by most common game-automation use
  const cmds = [
    { label: 'Navigate to image',  cmd: `NAVIGATE_TO_IMAGE ${name} confidence=${c}`,  desc: 'Move player toward this object using keyboard keys' },
    { label: 'Click image',        cmd: `CLICK_IMAGE ${name} ${c}`,                   desc: 'Find and left-click this object' },
    { label: 'Wait then click',    cmd: `WAIT_IMAGE ${name} ${c} timeout=10\nCLICK_IMAGE ${name} ${c}`, desc: 'Wait until visible, then click' },
    { label: 'If image — act',     cmd: `IF_IMAGE ${name} ${c}\n  CLICK_IMAGE ${name} ${c}\nEND`, desc: 'Only act if this object is on screen' },
    { label: 'While image — loop', cmd: `WHILE_IMAGE ${name} ${c}\n  WAIT 0.5\nEND`,  desc: 'Keep looping while object is visible' },
  ];

  list.innerHTML = cmds.map(({ label, cmd, desc }) => {
    const escaped = cmd.replace(/`/g, '\\`').replace(/\$/g, '\\$');
    return `
      <div style="display:flex;flex-direction:column;gap:4px;padding:8px 0;border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:12px;font-weight:600;color:var(--text1);flex:1">${label}</span>
          <button class="btn btn-xs" title="Copy to clipboard"
            onclick="tplCopyCmd(\`${escaped}\`)"
            style="flex-shrink:0">
            <svg class="icon" aria-hidden="true"><use href="#i-clipboard"/></svg> Copy
          </button>
          <button class="btn btn-xs btn-play" title="Insert into script editor"
            onclick="insertToEditor(\`${escaped}\`)"
            style="flex-shrink:0">
            <svg class="icon" aria-hidden="true"><use href="#i-plus"/></svg> Insert
          </button>
        </div>
        <code style="font-size:11px;background:var(--bg3,var(--bg2));padding:4px 8px;border-radius:4px;color:var(--text2);white-space:pre;display:block;overflow-x:auto">${cmd}</code>
        <span style="font-size:11px;color:var(--text3,#888)">${desc}</span>
      </div>`;
  }).join('');

  // Remove last border
  const rows = list.querySelectorAll('div[style*="border-bottom"]');
  if (rows.length) rows[rows.length - 1].style.borderBottom = 'none';

  box.style.display = 'block';
}

function tplHideCmdSuggestions() {
  const box = document.getElementById('tpl-cmd-suggestions');
  if (box) box.style.display = 'none';
}

function tplCopyCmd(cmd) {
  navigator.clipboard.writeText(cmd).then(() => {
    toast('Command copied to clipboard', 'success');
  }).catch(() => {
    // fallback for older webview
    const ta = document.createElement('textarea');
    ta.value = cmd;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    toast('Command copied', 'success');
  });
}

async function tplDelete() {
  if (_guardRunning('delete a template')) return;
  const ok = await appConfirm({
    title: 'Delete Template', filename: _tplEditName,
    warning: 'This action cannot be undone.',
    okLabel: 'Delete', icon: 'i-trash', kind: 'danger',
  });
  if (!ok) return;
  try {
    await withLoading(window.pywebview.api.delete_template(_tplEditName));
    nativeToast(`🗑️ Deleted: ${_tplEditName}`, 'warn');
    _tplEditName = '';
    tplClearDirty();
    document.getElementById('tpl-empty-state').classList.remove('hidden');
    document.getElementById('tpl-editor-inner').classList.add('hidden');
    loadTemplates();
  } catch(e) { toast(`Error: ${e}`, 'error'); }
}

function tplUse() {
  if (!_tplEditName) { toast('No template selected', 'warn'); return; }
  const base = _tplEditName.replace('.png', '');
  showTab('macro');
  setTimeout(() => {
    openImgAction('FIND_CLICK');
    requestAnimationFrame(() => {
      const sel = document.getElementById('img-action-template');
      if (sel) {
        for (const opt of sel.options) {
          if (opt.value === _tplEditName || opt.value.replace(/\.png$/i,'') === base) {
            sel.value = opt.value;
            break;
          }
        }
        imgActionPreview();
      }
    });
  }, 80);
}

// ── TEMPLATE EDITOR CROP TOOL ──────────────────────────────

let _tplCropNaturalW = 0;
let _tplCropNaturalH = 0;

function tplToggleCrop() {
  const cropTool = document.getElementById('tpl-crop-tool');
  if (!cropTool) return;
  cropTool.classList.toggle('hidden');
  if (!cropTool.classList.contains('hidden')) {
    const img = document.getElementById('tpl-edit-img');
    if (img && img.naturalWidth) {
      _tplCropNaturalW = img.naturalWidth;
      _tplCropNaturalH = img.naturalHeight;
      document.getElementById('tpl-crop-w').value = img.naturalWidth;
      document.getElementById('tpl-crop-h').value = img.naturalHeight;
      document.getElementById('tpl-crop-x').value = 0;
      document.getElementById('tpl-crop-y').value = 0;
    }
    tplUpdateCropPreview();
  } else {
    _tplClearCropLive();
  }
}

function tplUpdateCropPreview() {
  const img = document.getElementById('tpl-edit-img');
  if (!img || !img.naturalWidth) return;
  _tplCropNaturalW = img.naturalWidth;
  _tplCropNaturalH = img.naturalHeight;

  const cropX = parseInt(document.getElementById('tpl-crop-x').value) || 0;
  const cropY = parseInt(document.getElementById('tpl-crop-y').value) || 0;
  const cropW = parseInt(document.getElementById('tpl-crop-w').value) || 0;
  const cropH = parseInt(document.getElementById('tpl-crop-h').value) || 0;

  _tplDrawLiveCrop(img, cropX, cropY, cropW, cropH);
}

function _tplDrawLiveCrop(img, cropX, cropY, cropW, cropH) {
  const liveWrap   = document.getElementById('tpl-crop-live-wrap');
  const liveCanvas = document.getElementById('tpl-crop-live-canvas');
  if (cropW <= 0 || cropH <= 0) { liveWrap.classList.add('hidden'); return; }

  const sx = Math.max(0, cropX);
  const sy = Math.max(0, cropY);
  const sw = Math.min(_tplCropNaturalW - sx, cropW);
  const sh = Math.min(_tplCropNaturalH - sy, cropH);
  if (sw <= 0 || sh <= 0) { liveWrap.classList.add('hidden'); return; }

  const maxW  = 260;
  const scale = Math.min(1, maxW / sw);
  const dw = Math.round(sw * scale);
  const dh = Math.round(sh * scale);

  liveCanvas.width  = dw;
  liveCanvas.height = dh;
  const ctx = liveCanvas.getContext('2d');
  ctx.clearRect(0, 0, dw, dh);
  ctx.imageSmoothingEnabled = false;

  const tmp = document.createElement('canvas');
  tmp.width = _tplCropNaturalW; tmp.height = _tplCropNaturalH;
  tmp.getContext('2d').drawImage(img, 0, 0, _tplCropNaturalW, _tplCropNaturalH);
  const srcData = tmp.getContext('2d').getImageData(sx, sy, sw, sh);

  const tmpSmall = document.createElement('canvas');
  tmpSmall.width = sw; tmpSmall.height = sh;
  tmpSmall.getContext('2d').putImageData(srcData, 0, 0);
  ctx.drawImage(tmpSmall, 0, 0, sw, sh, 0, 0, dw, dh);

  liveWrap.classList.remove('hidden');
}

function _tplClearCropLive() {
  document.getElementById('tpl-crop-live-wrap')?.classList.add('hidden');
}

async function tplCropImage() {
  if (_guardRunning('crop a template')) return;
  if (!checkApi()) return;
  if (!_tplEditName) { toast('No template loaded!', 'warn'); return; }

  const cropX = parseInt(document.getElementById('tpl-crop-x').value) || 0;
  const cropY = parseInt(document.getElementById('tpl-crop-y').value) || 0;
  const cropW = parseInt(document.getElementById('tpl-crop-w').value) || 0;
  const cropH = parseInt(document.getElementById('tpl-crop-h').value) || 0;
  if (cropW <= 0 || cropH <= 0) { toast('Width and height must be > 0', 'warn'); return; }

  const base = _tplEditName.replace('.png','');
  try {
    const result = await withLoading(window.pywebview.api.crop_template(base, cropX, cropY, cropW, cropH, base, true));
    if (result.status === 'error') { toast(result.message, 'error'); return; }

    const edImg = document.getElementById('tpl-edit-img');
    if (edImg) { edImg.src = result.data; edImg.style.display = 'block'; }
    _tplCropNaturalW = result.w;
    _tplCropNaturalH = result.h;

    const fb = document.getElementById('tpl-crop-feedback');
    fb.classList.remove('hidden');
    fb.textContent = `✓ Cropped "${base}.png"  (${result.w}×${result.h}px)`;

    _tplShowRestoreBtn(base, result.has_backup);

    document.getElementById('tpl-crop-tool').classList.add('hidden');
    _tplClearCropLive();
    nativeToast(`✂️ Cropped & saved "${base}.png"`, 'success');
    loadTemplates();
  } catch(e) { toast(`Crop error: ${e}`, 'error'); }
}

async function tplRestoreOriginal() {
  if (_guardRunning('restore a template')) return;
  if (!checkApi() || !_tplEditName) return;
  const base = _tplEditName.replace('.png','');
  const ok = await appConfirm({
    title: 'Restore Original', filename: `${base}.png`,
    warning: 'The current cropped version will be permanently replaced.',
    okLabel: 'Restore', icon: 'i-refresh', kind: 'warn',
  });
  if (!ok) return;
  try {
    const result = await withLoading(window.pywebview.api.restore_template_original(base));
    if (result.status === 'error') { toast(result.message, 'error'); return; }

    const edImg = document.getElementById('tpl-edit-img');
    if (edImg) { edImg.src = result.data; edImg.style.display = 'block'; }
    _tplCropNaturalW = result.w;
    _tplCropNaturalH = result.h;

    const fb = document.getElementById('tpl-crop-feedback');
    fb.classList.remove('hidden');
    fb.textContent = `↩ Restored original "${base}.png"  (${result.w}×${result.h}px)`;

    _tplShowRestoreBtn(base, false);
    _tplClearCropLive();
    toast(`Original restored for "${base}.png"`, 'info');
    loadTemplates();
  } catch(e) { toast(`Restore error: ${e}`, 'error'); }
}

async function _tplShowRestoreBtn(base, show) {
  if (show === undefined) {
    try {
      const r = await withLoading(window.pywebview.api.check_template_has_backup(base));
      show = r.has_backup;
    } catch(e) { show = false; }
  }
  let btn = document.getElementById('tpl-restore-btn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id        = 'tpl-restore-btn';
    btn.className = 'btn btn-secondary full-width';
    btn.style.marginTop = '0.6rem';
    btn.innerHTML = '↩ Restore Original Image';
    btn.onclick   = tplRestoreOriginal;
    const cropBtn = document.querySelector('[onclick="tplToggleCrop()"]');
    if (cropBtn && cropBtn.parentNode) {
      cropBtn.parentNode.insertBefore(btn, cropBtn.nextSibling);
    }
  }
  btn.style.display = show ? '' : 'none';
}

async function previewTemplateByName(name) { openTplEditor(name); }

async function deleteTemplate(name) {
  if (!checkApi()) return;
  const ok = await appConfirm({
    title: 'Delete Template', filename: name,
    warning: 'This action cannot be undone.',
    okLabel: 'Delete', icon: 'i-trash', kind: 'danger',
  });
  if (!ok) return;
  try {
    await withLoading(window.pywebview.api.delete_template(name));
    toast(`Deleted: ${name}`, 'warn');
    loadTemplates();
  } catch(e) { toast(`Error: ${e}`, 'error'); }
}

async function renameTemplate() {
  if (!checkApi()) return;
  const oldName = document.getElementById('rename-old')?.value?.trim();
  const newName = document.getElementById('rename-new')?.value?.trim();
  if (!oldName || !newName) { toast('Enter both names!', 'warn'); return; }
  try {
    await withLoading(window.pywebview.api.rename_template(oldName, newName));
    toast(`Renamed: ${oldName} → ${newName}`, 'info');
    loadTemplates();
  } catch(e) { toast(`Error: ${e}`, 'error'); }
}

function useTemplate(name) {
  const tplName = typeof name === 'string' ? name : (name.name || name);
  showTab('macro');
  setTimeout(() => {
    openImgAction('FIND_CLICK');
    requestAnimationFrame(() => {
      const sel = document.getElementById('img-action-template');
      if (sel) {
        for (const opt of sel.options) {
          if (opt.value === tplName || opt.value.replace(/\.png$/i,'') === tplName.replace(/\.png$/i,'')) {
            sel.value = opt.value; break;
          }
        }
        imgActionPreview();
      }
    });
  }, 80);
}

// ── QUICK DETECT ───────────────────────────────────────────

let _detectDropdownTemplates = [];
let _detectDropdownOpen      = false;
let _detectCloseTimer        = null;
let _qdLastScreenDataUrl     = null;
let _detectKeyboardIdx       = -1;

async function loadDetectDropdownTemplates() {
  if (!checkApi()) return;
  try {
    const result = await withLoading(window.pywebview.api.get_templates());
    _detectDropdownTemplates = (result.templates || []).map(t => ({
      name: typeof t === 'string' ? t : t.name,
      hasRegion: false,
    }));
    await Promise.all(_detectDropdownTemplates.map(async (t) => {
      try {
        const bareName = t.name.replace(/\.png$/i, '');
        const r = await withLoading(window.pywebview.api.get_template_search_region(bareName));
        t.hasRegion = !!(r && r.region);
      } catch(e) {}
    }));
  } catch(e) { _detectDropdownTemplates = []; }
}

function renderDetectDropdown() {
  const list  = document.getElementById('detect-name-dropdown');
  if (!list) return;
  const query = (document.getElementById('detect-name')?.value || '').toLowerCase().trim();
  const matches = query
    ? _detectDropdownTemplates.filter(t => t.name.toLowerCase().includes(query))
    : _detectDropdownTemplates;
  _detectKeyboardIdx = -1;

  list.innerHTML = '';
  if (matches.length === 0) {
    const li = document.createElement('li');
    li.className = 'dnd-empty';
    li.textContent = query ? 'No matching templates' : 'No templates yet';
    list.appendChild(li);
  } else {
    matches.forEach((t, idx) => {
      const li = document.createElement('li');
      li.dataset.name = t.name;
      li.dataset.idx  = idx;
      const nameSpan = document.createElement('span');
      nameSpan.textContent = t.name.replace(/\.png$/i, '');
      li.appendChild(nameSpan);
      if (t.hasRegion) {
        const badge = document.createElement('span');
        badge.className   = 'dnd-region-badge';
        badge.textContent = '\u{1F4D0} has region';
        li.appendChild(badge);
      }
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        selectDetectTemplate(t.name);
      });
      list.appendChild(li);
    });
  }
  list.classList.remove('hidden');
  _detectDropdownOpen = true;
}

function onDetectNameInput() {
  clearTimeout(_detectCloseTimer);
  if (_detectDropdownTemplates.length > 0) {
    renderDetectDropdown();
  } else {
    loadDetectDropdownTemplates().then(() => renderDetectDropdown());
  }
}

function openDetectDropdown() {
  clearTimeout(_detectCloseTimer);
  loadDetectDropdownTemplates().then(() => renderDetectDropdown());
}

function filterDetectDropdown() {
  if (_detectDropdownTemplates.length > 0) renderDetectDropdown();
}

function scheduleCloseDetectDropdown() {
  _detectCloseTimer = setTimeout(() => {
    const list = document.getElementById('detect-name-dropdown');
    if (list) list.classList.add('hidden');
    _detectDropdownOpen = false;
    _detectKeyboardIdx  = -1;
  }, 160);
}

function closeDetectDropdown() {
  clearTimeout(_detectCloseTimer);
  const list = document.getElementById('detect-name-dropdown');
  if (list) list.classList.add('hidden');
  _detectDropdownOpen = false;
  _detectKeyboardIdx  = -1;
}

function toggleDetectDropdown() {
  clearTimeout(_detectCloseTimer);
  if (_detectDropdownOpen) {
    closeDetectDropdown();
  } else {
    loadDetectDropdownTemplates().then(() => renderDetectDropdown());
  }
}

document.addEventListener('keydown', (e) => {
  if (!_detectDropdownOpen) return;
  const list = document.getElementById('detect-name-dropdown');
  if (!list || list.classList.contains('hidden')) return;
  const items = Array.from(list.querySelectorAll('li[data-name]'));
  if (!items.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _detectKeyboardIdx = Math.min(_detectKeyboardIdx + 1, items.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _detectKeyboardIdx = Math.max(_detectKeyboardIdx - 1, 0);
  } else if (e.key === 'Enter' && _detectKeyboardIdx >= 0) {
    e.preventDefault();
    const name = items[_detectKeyboardIdx]?.dataset.name;
    if (name) selectDetectTemplate(name);
    return;
  } else if (e.key === 'Escape') {
    closeDetectDropdown(); return;
  } else { return; }
  items.forEach((li, i) => li.classList.toggle('active', i === _detectKeyboardIdx));
  items[_detectKeyboardIdx]?.scrollIntoView({ block: 'nearest' });
});

async function selectDetectTemplate(name) {
  const input = document.getElementById('detect-name');
  if (input) input.value = name.replace(/\.png$/i, '');
  closeDetectDropdown();

  try {
    const bareName = name.replace(/\.png$/i, '');
    const r = await withLoading(window.pywebview.api.get_template_search_region(bareName));
    if (r && r.region) {
      _detectRegion = { x: r.region.x, y: r.region.y, w: r.region.w, h: r.region.h };
      // Sync backend region
      await window.pywebview.api.set_detect_region_direct(r.region.x, r.region.y, r.region.w, r.region.h);
      updateDetectRegionDisplay();
      toast(`Region loaded for "${bareName}"`, 'info');
    } else {
      _detectRegion = null;
      // Clear backend region
      await window.pywebview.api.clear_detect_region();
      updateDetectRegionDisplay();
    }
  } catch(e) {}
}

function clearDetectRegion() {
    _detectRegion = null;
    updateDetectRegionDisplay();
    if (checkApi()) {
        // Clear global detection region
        window.pywebview.api.clear_detect_region().catch(() => {});
    }
    const nameRaw = (document.getElementById('detect-name')?.value || '').trim();
    if (nameRaw && checkApi()) {
        const name = nameRaw.replace(/\.png$/i, '');
        window.pywebview.api.clear_template_search_region(name).catch(() => {});
        const tpl = _detectDropdownTemplates.find(t => t.name.replace(/\.png$/i, '') === name);
        if (tpl) tpl.hasRegion = false;
    }
    toast('Region cleared — full screen search restored', 'info');
}

function updateDetectRegionDisplay() {
  const el = document.getElementById('detect-region-display');
  if (!el) return;
  if (_detectRegion) {
    el.textContent    = `\u{1F4D0} (${_detectRegion.x}, ${_detectRegion.y})  ${_detectRegion.w} \u00d7 ${_detectRegion.h} px`;
    el.style.color      = '#281C59';
    el.style.fontWeight = '800';
  } else {
    el.textContent    = '\u{1F310} Full screen \u2014 no region set';
    el.style.color      = '';
    el.style.fontWeight = '';
  }
}

const setDetectRegion = () => drawDetectRegion();

async function drawDetectRegion() {
  if (_guardRunning('draw a search region')) return;
  if (!checkApi()) return;
  toast('Draw the search region on your screen', 'info');
  try {
    const r = await withLoading(window.pywebview.api.set_detect_region());
    if (r.status === 'cancelled') { toast('Cancelled', 'warn'); return; }
    _detectRegion = { x: r.x, y: r.y, w: r.w, h: r.h };
    updateDetectRegionDisplay();

    const nameRaw = (document.getElementById('detect-name')?.value || '').trim();
    if (nameRaw) {
      const name = nameRaw.replace(/\.png$/i, '');
      try {
        await withLoading(window.pywebview.api.save_template_search_region_direct(
          name, r.x, r.y, r.w, r.h
        ));
        const tpl = _detectDropdownTemplates.find(
          t => t.name.replace(/\.png$/i,'') === name
        );
        if (tpl) tpl.hasRegion = true;
        nativeToast(`\u{1F4D0} Region saved for "${name}" — IF_IMAGE will use it`, 'success');
      } catch(e) {
        toast(`Region drawn but not saved to template: ${e}`, 'warn');
      }
    } else {
      toast(`Region set: ${r.w}\u00d7${r.h}px — type a template name to save`, 'info');
    }
  } catch(e) { toast(`Error: ${e}`, 'error'); }
}

async function detectImage() {
  if (_guardRunning('run Quick Detect')) return;
  if (!checkApi()) return;
  const nameRaw = (document.getElementById('detect-name')?.value || '').trim();
  if (!nameRaw) { toast('Enter or select a template name', 'warn'); return; }
  const name = nameRaw.replace(/\.png$/i, '');

  const confInput = document.getElementById('detect-conf');
  const conf      = confInput ? (parseFloat(confInput.value) || 0.8) : 0.8;

  // Persist region before scanning so the backend uses it
  if (_detectRegion) {
    try {
      await window.pywebview.api.save_template_search_region_direct(
        name, _detectRegion.x, _detectRegion.y, _detectRegion.w, _detectRegion.h
      );
    } catch(e) {}
  }

  const resultWrap  = document.getElementById('qd-scan-result');
  const badge       = document.getElementById('qd-match-badge');
  const canvas      = document.getElementById('qd-preview-canvas');
  const placeholder = document.getElementById('qd-preview-placeholder');

  resultWrap.classList.remove('hidden');
  badge.textContent = '\u23f3 Scanning\u2026';
  badge.className   = 'tpl-match-badge-new scanning';
  placeholder.style.display = 'flex';
  canvas.style.display      = 'none';

  try {
    // Single API call: grabs screen + runs multi-scale template match + returns both
    const screenData = await window.pywebview.api.capture_screen_with_region_highlight(name, conf, true);
    if (!screenData || screenData.status !== 'ok') {
      toast('Scan failed: ' + (screenData?.message || 'unknown error'), 'error');
      badge.textContent = '\u26a0\ufe0f Scan failed';
      badge.className   = 'tpl-match-badge-new notfound';
      return;
    }

    const img = new Image();
    img.onload = () => {
      canvas.width  = img.width;
      canvas.height = img.height;
      const ctx   = canvas.getContext('2d');
      const scale = screenData.scale || 1;
      ctx.drawImage(img, 0, 0);

      // Draw search region overlay
      if (screenData.region) {
        const [rx, ry, rw, rh] = screenData.region.map(v => v * scale);
        ctx.strokeStyle = '#e67e22'; ctx.lineWidth = 3; ctx.setLineDash([8, 4]);
        ctx.strokeRect(rx, ry, rw, rh); ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(230,126,34,0.12)';
        ctx.fillRect(rx, ry, rw, rh);
        ctx.fillStyle = '#e67e22'; ctx.font = 'bold 13px Segoe UI';
        ctx.fillText('Search Region', rx + 4, ry + 16);
      }

      // Draw match boxes (matches are already pre-scaled by the backend)
      const matches = screenData.matches || [];
      if (matches.length > 0) {
        matches.sort((a, b) => b.confidence - a.confidence);
        matches.forEach((match, index) => {
          const sx = match.x - match.w / 2;
          const sy = match.y - match.h / 2;
          const sw = match.w;
          const sh = match.h;
          const confPercent = Math.round(match.confidence * 100);

          const color = index === 0 ? '#27ae60' : '#3498db';
          ctx.strokeStyle = color;
          ctx.lineWidth   = index === 0 ? 3 : 2;
          ctx.strokeRect(sx, sy, sw, sh);
          ctx.fillStyle   = index === 0 ? 'rgba(39,174,96,0.10)' : 'rgba(52,152,219,0.10)';
          ctx.fillRect(sx, sy, sw, sh);
          ctx.fillStyle   = color;
          ctx.font        = index === 0 ? 'bold 13px Segoe UI' : '12px Segoe UI';
          ctx.fillText(`${confPercent}%`, sx + 4, sy - 6);
        });

        const topConf = Math.round(matches[0].confidence * 100);
        badge.textContent = `\u2705 Found ${matches.length} match(es), best ${topConf}% (multi-scale)`;
        badge.className   = 'tpl-match-badge-new found';
      } else {
        badge.textContent = `\u274c No matches at ${Math.round(conf * 100)}% \u2014 try lowering confidence`;
        badge.className   = 'tpl-match-badge-new notfound';
      }

      placeholder.style.display = 'none';
      canvas.style.display      = 'block';
      _qdLastScreenDataUrl = canvas.toDataURL('image/jpeg', 0.92);
    };
    img.src = screenData.screen;
  } catch(e) {
    toast(`Scan error: ${e}`, 'error');
    badge.textContent = '\u26a0\ufe0f Scan error';
    badge.className   = 'tpl-match-badge-new notfound';
  }
}


function tplOpenFullscreen() {
  const srcCanvas = document.getElementById('tpl-preview-canvas');
  if (!srcCanvas || srcCanvas.style.display === 'none') return;
  if (srcCanvas.width === 0 || srcCanvas.height === 0) return;

  const lightbox = document.getElementById('tpl-lightbox');
  const lbCanvas = document.getElementById('tpl-lightbox-canvas');
  lbCanvas.width  = srcCanvas.width;
  lbCanvas.height = srcCanvas.height;
  lbCanvas.getContext('2d').drawImage(srcCanvas, 0, 0);
  lightbox.classList.remove('hidden');
  document.addEventListener('keydown', _tplLightboxKey, { capture: true });
}

function tplCloseLightbox() {
  document.getElementById('tpl-lightbox').classList.add('hidden');
  document.removeEventListener('keydown', _tplLightboxKey, { capture: true });
}

function _tplLightboxKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); tplCloseLightbox(); }
}

// ── LIVE DETECT (Quick Detect tab) ────────────────────────────────────────
let _liveDetectRunning = false;
let _liveDetectStop    = false;
let _liveDetectFrames  = [];

async function toggleLiveDetect() {
  if (_liveDetectRunning) { _stopLiveDetect(); return; }
  await _startLiveDetect();
}

async function _startLiveDetect() {
  if (!checkApi()) return;
  const nameRaw = (document.getElementById('detect-name')?.value || '').trim();
  if (!nameRaw) { toast('Enter or select a template name first', 'warn'); return; }
  const name = nameRaw.replace(/\.png$/i, '');
  const conf = parseFloat(document.getElementById('detect-conf')?.value || '0.8') || 0.8;

  if (_detectRegion) {
    try {
      await window.pywebview.api.save_template_search_region_direct(
        name, _detectRegion.x, _detectRegion.y, _detectRegion.w, _detectRegion.h
      );
    } catch(e) {}
  }

  _liveDetectRunning = true;
  _liveDetectStop    = false;
  _liveDetectFrames  = [];

  const btn = document.getElementById('qd-live-btn');
  if (btn) { btn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-square-stop"/></svg> Stop Live'; btn.classList.replace('btn-primary','btn-danger'); }

  const status    = document.getElementById('qd-live-status');
  const legend    = document.getElementById('qd-live-legend');
  const staticLeg = document.getElementById('qd-static-legend');
  if (legend) legend.style.display = 'flex';
  if (staticLeg) staticLeg.style.display = 'none';
  qdIndicatorToggle(); // respect checkbox

  const resultWrap  = document.getElementById('qd-scan-result');
  const placeholder = document.getElementById('qd-preview-placeholder');
  const canvas      = document.getElementById('qd-preview-canvas');
  const badge       = document.getElementById('qd-match-badge');
  resultWrap.classList.remove('hidden');
  placeholder.style.display = 'flex';
  canvas.style.display      = 'none';

  while (!_liveDetectStop) {
    const t0 = performance.now();
    try {
      const sd = await window.pywebview.api.capture_screen_with_region_highlight(name, conf, true);
      if (_liveDetectStop) break;
      if (!sd || sd.status !== 'ok') { await _qdSleep(500); continue; }

      await _qdDrawLiveFrame(sd, canvas, placeholder, badge, conf);

      const now = performance.now();
      _liveDetectFrames.push(now);
      _liveDetectFrames = _liveDetectFrames.filter(t => now - t < 1000);
      const fpsEl = document.getElementById('qd-live-fps');
      if (fpsEl) fpsEl.textContent = `${_liveDetectFrames.length} fps`;

      const matches = sd.matches || [];
      const labelEl = document.getElementById('qd-live-label');
      if (labelEl) {
        labelEl.textContent = matches.length > 0
          ? `Live — ${matches.length} match${matches.length > 1 ? 'es' : ''}, best ${Math.round(matches[0].confidence * 100)}%`
          : `Live — no match at ${Math.round(conf * 100)}%`;
      }
    } catch(e) {
      if (_liveDetectStop) break;
      await _qdSleep(500);
    }
    const wait = Math.max(0, _liveInterval('qd-fps-slider') - (performance.now() - t0));
    if (wait > 0) await _qdSleep(wait);
  }
  _liveDetectRunning = false;
}

function _stopLiveDetect() {
  _liveDetectStop    = true;
  _liveDetectRunning = false;
  const btn = document.getElementById('qd-live-btn');
  if (btn) { btn.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-target"/></svg> Live Detect'; btn.classList.replace('btn-danger','btn-primary'); }
  const status    = document.getElementById('qd-live-status');
  const legend    = document.getElementById('qd-live-legend');
  const staticLeg = document.getElementById('qd-static-legend');
  if (status)    status.style.display = 'none';
  if (legend)    legend.style.display = 'none';
  if (staticLeg) staticLeg.style.display = '';
  const badge = document.getElementById('qd-match-badge');
  if (badge) { badge.textContent = 'Live detect stopped'; badge.className = 'tpl-match-badge-new scanning'; }
}

function _qdSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function _qdColorForConf(c) {
  if (c >= 0.85) return { stroke:'#27ae60', fill:'rgba(39,174,96,0.12)' };
  if (c >= 0.70) return { stroke:'#f1c40f', fill:'rgba(241,196,15,0.12)' };
  return               { stroke:'#e74c3c', fill:'rgba(231,76,60,0.12)' };
}

function _qdDrawLiveFrame(sd, canvas, placeholder, badge, conf) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      const scale = sd.scale || 1;
      ctx.drawImage(img, 0, 0);

      if (sd.region) {
        const [rx,ry,rw,rh] = sd.region.map(v => v * scale);
        ctx.strokeStyle='#e67e22'; ctx.lineWidth=2; ctx.setLineDash([8,4]);
        ctx.strokeRect(rx,ry,rw,rh); ctx.setLineDash([]);
        ctx.fillStyle='rgba(230,126,34,0.08)'; ctx.fillRect(rx,ry,rw,rh);
        ctx.fillStyle='#e67e22'; ctx.font='bold 12px Segoe UI,sans-serif';
        ctx.fillText('Search Region', rx+4, ry+14);
      }

      const matches = (sd.matches||[]).slice().sort((a,b)=>b.confidence-a.confidence);
      matches.forEach((m,i) => {
        const sx = m.x - m.w/2, sy = m.y - m.h/2;
        const {stroke,fill} = _qdColorForConf(m.confidence);
        ctx.strokeStyle=stroke; ctx.lineWidth=i===0?3:2;
        ctx.strokeRect(sx,sy,m.w,m.h);
        ctx.fillStyle=fill; ctx.fillRect(sx,sy,m.w,m.h);
        if (i===0) {
          const cs=10; ctx.lineWidth=3;
          [[sx,sy,1,1],[sx+m.w,sy,-1,1],[sx,sy+m.h,1,-1],[sx+m.w,sy+m.h,-1,-1]].forEach(([cx,cy,dx,dy])=>{
            ctx.beginPath(); ctx.moveTo(cx+dx*cs,cy); ctx.lineTo(cx,cy); ctx.lineTo(cx,cy+dy*cs); ctx.stroke();
          });
        }
        const pct = Math.round(m.confidence*100);
        const label = `#${i+1} — ${pct}%`;
        ctx.font=`${i===0?'bold ':' '}12px Segoe UI,sans-serif`;
        const tw=ctx.measureText(label).width;
        const lx=Math.min(sx, canvas.width-tw-6);
        const ly=sy>18?sy-4:sy+m.h+14;
        ctx.fillStyle=stroke; ctx.fillRect(lx-2,ly-12,tw+6,16);
        ctx.fillStyle='#fff'; ctx.fillText(label,lx,ly);
      });

      if (matches.length > 0) {
        badge.textContent=`✅ ${matches.length} match${matches.length>1?'es':''} — best ${Math.round(matches[0].confidence*100)}%`;
        badge.className='tpl-match-badge-new found';
      } else {
        badge.textContent=`❌ No match at ${Math.round(conf*100)}%`;
        badge.className='tpl-match-badge-new notfound';
      }
      placeholder.style.display='none'; canvas.style.display='block';
      resolve();
    };
    img.onerror=resolve; img.src=sd.screen;
  });
}

function qdOpenFullscreen() {
  const srcCanvas = document.getElementById('qd-preview-canvas');
  if (!srcCanvas || srcCanvas.style.display === 'none') return;
  const lightbox = document.getElementById('qd-lightbox');
  const lbCanvas = document.getElementById('qd-lightbox-canvas');
  lbCanvas.width  = srcCanvas.width;
  lbCanvas.height = srcCanvas.height;
  lbCanvas.getContext('2d').drawImage(srcCanvas, 0, 0);
  lightbox.classList.remove('hidden');
  document.addEventListener('keydown', _qdLightboxKey, { capture: true });
}

function qdCloseLightbox() {
  document.getElementById('qd-lightbox').classList.add('hidden');
  document.removeEventListener('keydown', _qdLightboxKey, { capture: true });
}

function _qdLightboxKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); qdCloseLightbox(); }
}

// ── Shared scan lightbox (OCR + Color fullscreen) ──────────
function ocrOpenFullscreen() {
  _openScanLightbox('ocr-preview-canvas');
}
function colorOpenFullscreen() {
  _openScanLightbox('color-preview-canvas');
}
function _openScanLightbox(srcId) {
  const srcCanvas = document.getElementById(srcId);
  if (!srcCanvas || srcCanvas.width === 0) return;
  const lb = document.getElementById('scan-lightbox');
  const lc = document.getElementById('scan-lightbox-canvas');
  if (!lb || !lc) return;
  lc.width  = srcCanvas.width;
  lc.height = srcCanvas.height;
  lc.getContext('2d').drawImage(srcCanvas, 0, 0);
  lb.classList.remove('hidden');
  document.addEventListener('keydown', _scanLightboxKey, { capture: true });
}
function scanCloseLightbox() {
  const lb = document.getElementById('scan-lightbox');
  if (lb) lb.classList.add('hidden');
  document.removeEventListener('keydown', _scanLightboxKey, { capture: true });
}
function _scanLightboxKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); scanCloseLightbox(); }
}

// OCR test region
let _ocrTestRegion = null;

async function setOcrTestRegion() {
    if (!checkApi()) return;
    const region = await withLoading(window.pywebview.api.set_detect_region());
    if (region && region.status === 'ok') {
        _ocrTestRegion = { x: region.x, y: region.y, w: region.w, h: region.h };
        _updateOcrRegionUI();
    }
}

function clearOcrTestRegion() {
    _ocrTestRegion = null;
    _updateOcrRegionUI();
    // Also hide the thumbnail
    const wrap = document.getElementById('ocr-region-thumb-wrap');
    const btn  = document.getElementById('ocr-preview-region-btn');
    if (wrap) wrap.classList.add('hidden');
    if (btn)  btn.style.display = 'none';
}

function _updateOcrRegionUI() {
    const r = _ocrTestRegion;
    const labelText  = document.getElementById('ocr-region-label-text');
    const statusText = document.getElementById('ocr-region-status-text');
    const clearBtn   = document.getElementById('ocr-clear-region-btn');
    if (r) {
        const str = `(${r.x}, ${r.y}) ${r.w}×${r.h}`;
        if (labelText)  labelText.textContent  = str;
        if (statusText) statusText.textContent = `Region set: ${str}`;
        if (clearBtn)   clearBtn.style.display = '';
    } else {
        if (labelText)  labelText.textContent  = 'Full screen';
        if (statusText) statusText.textContent = 'No region set — searching full screen';
        if (clearBtn)   clearBtn.style.display = 'none';
    }
}

async function testOcr() {
    const text = document.getElementById('ocr-test-text').value.trim();
    if (!text) { toast('Enter text to find', 'warn'); return; }
    const conf = parseInt(document.getElementById('ocr-test-conf').value) || 80;
    const regionArray = _ocrTestRegion ? [_ocrTestRegion.x, _ocrTestRegion.y, _ocrTestRegion.w, _ocrTestRegion.h] : null;

    const resultWrap = document.getElementById('ocr-scan-result');
    const badge = document.getElementById('ocr-match-badge');
    const canvas = document.getElementById('ocr-preview-canvas');
    const placeholder = document.getElementById('ocr-preview-placeholder');

    resultWrap.classList.remove('hidden');
    badge.textContent = '⏳ Scanning…';
    badge.className = 'tpl-match-badge-new scanning';
    placeholder.style.display = 'flex';
    canvas.style.display = 'none';

    try {
        const screenData = await withLoading(window.pywebview.api.capture_screen());
        const screenImg = screenData.screen;

        const result = await withLoading(window.pywebview.api.detect_text_all(text, conf, regionArray));
        const matches = result.matches || [];

        const img = new Image();
        img.onload = () => {
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);

            if (matches.length > 0) {
                matches.forEach((m, idx) => {
                    ctx.strokeStyle = '#27ae60';
                    ctx.lineWidth = 3;
                    ctx.strokeRect(m.x, m.y, m.w, m.h);
                    ctx.fillStyle = 'rgba(39,174,96,0.1)';
                    ctx.fillRect(m.x, m.y, m.w, m.h);
                });
                badge.textContent = `✅ Found ${matches.length} match(es)`;
                badge.className = 'tpl-match-badge-new found';
            } else {
                badge.textContent = `❌ No matches found`;
                badge.className = 'tpl-match-badge-new notfound';
            }
            placeholder.style.display = 'none';
            canvas.style.display = 'block';
        };
        img.src = screenImg;
    } catch (e) {
        toast(`Error: ${e}`, 'error');
        badge.textContent = '⚠️ Scan error';
        badge.className = 'tpl-match-badge-new notfound';
    }
}

let _colorTestRegion = null;

async function setColorTestRegion() {
    if (!checkApi()) return;
    const region = await withLoading(window.pywebview.api.set_detect_region());
    if (region && region.status === 'ok') {
        _colorTestRegion = { x: region.x, y: region.y, w: region.w, h: region.h };
        _updateColorRegionUI();
    }
}

function clearColorTestRegion() {
    _colorTestRegion = null;
    _updateColorRegionUI();
}

function _updateColorRegionUI() {
    const r = _colorTestRegion;
    const labelText  = document.getElementById('color-region-label-text');
    const statusText = document.getElementById('color-region-status-text');
    const clearBtn   = document.getElementById('color-clear-region-btn');
    if (r) {
        const str = `(${r.x}, ${r.y}) ${r.w}×${r.h}`;
        if (labelText)  labelText.textContent  = str;
        if (statusText) statusText.textContent = `Region set: ${str}`;
        if (clearBtn)   clearBtn.style.display = '';
    } else {
        if (labelText)  labelText.textContent  = 'Full screen';
        if (statusText) statusText.textContent = 'No region set — searching full screen';
        if (clearBtn)   clearBtn.style.display = 'none';
    }
}

async function testColor() {
    const hex = document.getElementById('color-test-hex').value.trim();
    if (!hex) { toast('Enter color hex', 'warn'); return; }
    const tol = parseInt(document.getElementById('color-test-tol').value) || 30;
    const regionArray = _colorTestRegion ? [_colorTestRegion.x, _colorTestRegion.y, _colorTestRegion.w, _colorTestRegion.h] : null;

    const resultWrap = document.getElementById('color-scan-result');
    const badge = document.getElementById('color-match-badge');
    const canvas = document.getElementById('color-preview-canvas');
    const placeholder = document.getElementById('color-preview-placeholder');

    resultWrap.classList.remove('hidden');
    badge.textContent = '⏳ Scanning…';
    badge.className = 'tpl-match-badge-new scanning';
    placeholder.style.display = 'flex';
    canvas.style.display = 'none';

    try {
        const screenData = await withLoading(window.pywebview.api.capture_screen());
        const screenImg = screenData.screen;

        const result = await withLoading(window.pywebview.api.detect_color_all(hex, tol, regionArray));
        const matches = result.matches || [];

        const img = new Image();
        img.onload = () => {
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);

            if (matches.length > 0) {
                // Cap rendering at 2000 dots to avoid freezing on large result sets
                const MAX_RENDER = 2000;
                const renderMatches = matches.length > MAX_RENDER
                    ? matches.filter((_, i) => i % Math.ceil(matches.length / MAX_RENDER) === 0)
                    : matches;
                ctx.fillStyle = '#27ae60';
                renderMatches.forEach((m) => {
                    ctx.fillRect(m.x - 2, m.y - 2, 5, 5);
                });
                const overflowNote = matches.length > MAX_RENDER ? ` (showing ${renderMatches.length} of ${matches.length})` : '';
                badge.textContent = `✅ Found ${matches.length} pixel(s)${overflowNote}`;
                badge.className = 'tpl-match-badge-new found';
            } else {
                badge.textContent = `❌ No matching pixels`;
                badge.className = 'tpl-match-badge-new notfound';
            }
            placeholder.style.display = 'none';
            canvas.style.display = 'block';
        };
        img.src = screenImg;
    } catch (e) {
        toast(`Error: ${e}`, 'error');
        badge.textContent = '⚠️ Scan error';
        badge.className = 'tpl-match-badge-new notfound';
    }
}
// ══════════════════════════════════════════════════════════
//  DETECT SUB-TABS (Text / Color)
// ══════════════════════════════════════════════════════════

function showDetectSubtab(which) {
  ['text', 'color'].forEach(id => {
    const tab   = document.getElementById('detect-subtab-' + id);
    const panel = document.getElementById('detect-panel-' + id);
    if (!tab || !panel) return;
    const active = (id === which);
    tab.classList.toggle('active', active);
    panel.classList.toggle('hidden', !active);
  });
}

// Sync hex input → color picker
function syncColorPicker() {
  const hex = document.getElementById('color-test-hex').value.trim();
  const picker = document.getElementById('color-test-picker');
  if (picker && /^#[0-9a-fA-F]{6}$/.test(hex)) picker.value = hex;
}

// Show the "Insert into script" bar after a successful scan
function _showOcrInsertRow(found) {
  const row = document.getElementById('ocr-insert-row');
  if (row) row.style.display = found ? 'flex' : 'none';
}

function _showColorInsertRow(found) {
  const row = document.getElementById('color-insert-row');
  if (row) row.style.display = found ? 'flex' : 'none';
}

// Insert OCR command into the macro script editor
function insertOcrCommand(action) {
  const text = (document.getElementById('ocr-test-text').value || '').trim();
  const conf = document.getElementById('ocr-test-conf').value || 80;
  const region = _ocrTestRegion
    ? ` region=${_ocrTestRegion.x} ${_ocrTestRegion.y} ${_ocrTestRegion.w} ${_ocrTestRegion.h}`
    : '';

  let cmd;
  if (action === 'WAIT') {
    cmd = `WAIT_IMAGE_TEXT "${text}" confidence=${conf}${region}`;
  } else {
    const confPart = parseInt(conf) !== 80 ? ` confidence=${conf}` : '';
    cmd = `TEXT_${action} "${text}"${confPart}${region}`;
  }

  // Switch to Macro Editor tab and insert
  if (typeof showTab === 'function') showTab('macro');
  if (typeof insertToEditor === 'function') {
    insertToEditor(cmd);
    if (typeof toast === 'function') toast(`Inserted: ${cmd.split(' ').slice(0,2).join(' ')} …`, 'info');
  }
}

// Insert Color command into the macro script editor
function insertColorCommand(action) {
  const color = (document.getElementById('color-test-hex').value || '#FF0000').trim();
  const tol   = document.getElementById('color-test-tol').value || 30;
  const region = _colorTestRegion
    ? ` region=${_colorTestRegion.x} ${_colorTestRegion.y} ${_colorTestRegion.w} ${_colorTestRegion.h}`
    : '';

  let cmd;
  if (action === 'WAIT') {
    cmd = `WAIT_COLOR ${color} tolerance=${tol}${region}`;
  } else {
    const tolPart = parseInt(tol) !== 30 ? ` tolerance=${tol}` : '';
    cmd = `COLOR_${action} ${color}${tolPart}${region}`;
  }

  if (typeof showTab === 'function') showTab('macro');
  if (typeof insertToEditor === 'function') {
    insertToEditor(cmd);
    if (typeof toast === 'function') toast(`Inserted: ${cmd.split(' ').slice(0,2).join(' ')} …`, 'info');
  }
}

// Patch testOcr and testColor to show/hide the insert row
const _origTestOcr = testOcr;
testOcr = async function() {
  _showOcrInsertRow(false);
  await _origTestOcr();
  // After scan check if matches were found via badge class
  const badge = document.getElementById('ocr-match-badge');
  const found = badge && badge.classList.contains('found');
  _showOcrInsertRow(found);
};

const _origTestColor = testColor;
testColor = async function() {
  _showColorInsertRow(false);
  await _origTestColor();
  const badge = document.getElementById('color-match-badge');
  const found = badge && badge.classList.contains('found');
  _showColorInsertRow(found);
};

// ══════════════════════════════════════════════════════════
//  COLOR — LIVE SWATCH SYNC
// ══════════════════════════════════════════════════════════

function onColorPickerChange(hex) {
  document.getElementById('color-test-hex').value = hex;
  _updateColorSwatch(hex);
}

function onColorHexInput(val) {
  const hex = val.trim();
  _updateColorSwatch(hex);
  const picker = document.getElementById('color-test-picker');
  if (picker && /^#[0-9a-fA-F]{6}$/.test(hex)) picker.value = hex;
}

function _updateColorSwatch(hex) {
  if (!/^#[0-9a-fA-F]{3,6}$/.test(hex)) return;
  // Update both the large palette swatch and any legacy small swatch
  const large = document.getElementById('color-swatch');
  if (large) large.style.background = hex;
}

// ══════════════════════════════════════════════════════════
//  COLOR — SCREEN EYEDROPPER
// ══════════════════════════════════════════════════════════

let _eyedropperPoll  = null;
let _eyedropperActive = false;

async function startEyedropper() {
  if (!checkApi()) return;
  _eyedropperActive = true;

  const btn = document.getElementById('btn-eyedropper');
  const bar = document.getElementById('eyedropper-bar');
  if (btn) { btn.classList.add('active'); btn.textContent = ''; btn.innerHTML = '<svg class="icon"><use href="#i-target"/></svg> Hover over screen…'; }
  if (bar) bar.classList.remove('hidden');

  try {
    await window.pywebview.api.start_eyedropper();
  } catch(e) {
    cancelEyedropper(); return;
  }

  // Poll live color
  _eyedropperPoll = setInterval(async () => {
    if (!_eyedropperActive) return;
    try {
      const r = await window.pywebview.api.get_eyedropper_color();
      if (!r || r.status === 'idle') { cancelEyedropper(); return; }
      const c = r.color;
      if (!c) return;

      const swatchEl = document.getElementById('eyedropper-preview-swatch');
      const hexEl    = document.getElementById('eyedropper-hex-live');
      const posEl    = document.getElementById('eyedropper-pos-live');
      if (swatchEl) swatchEl.style.background = c.hex;
      if (hexEl)    hexEl.textContent = c.hex;
      if (posEl)    posEl.textContent = `(${c.x}, ${c.y})`;
    } catch(e) {}
  }, 60);

  // Keyboard: Enter = confirm, Escape = cancel
  document.addEventListener('keydown', _eyedropKeyHandler, { capture: true });
}

function _eyedropKeyHandler(e) {
  if (e.key === 'Enter')  { e.preventDefault(); confirmEyedropper(); }
  if (e.key === 'Escape') { e.preventDefault(); cancelEyedropper();  }
}

async function confirmEyedropper() {
  _stopEyedropperPoll();
  try {
    const r = await window.pywebview.api.stop_eyedropper(true);
    if (r && r.color) {
      _applyPickedColor(r.color.hex);
      toast(`Color picked: ${r.color.hex}`, 'info');
    }
  } catch(e) {}
  _resetEyedropperUI();
}

async function cancelEyedropper() {
  _stopEyedropperPoll();
  try { await window.pywebview.api.stop_eyedropper(false); } catch(e) {}
  _resetEyedropperUI();
}

function _stopEyedropperPoll() {
  _eyedropperActive = false;
  if (_eyedropperPoll) { clearInterval(_eyedropperPoll); _eyedropperPoll = null; }
  document.removeEventListener('keydown', _eyedropKeyHandler, { capture: true });
}

function _resetEyedropperUI() {
  const btn = document.getElementById('btn-eyedropper');
  const bar = document.getElementById('eyedropper-bar');
  if (btn) {
    btn.classList.remove('active');
    btn.innerHTML = '<svg class="icon"><use href="#i-target"/></svg> Pick from Screen';
  }
  if (bar) bar.classList.add('hidden');
}

function _applyPickedColor(hex) {
  const hexInput = document.getElementById('color-test-hex');
  const picker   = document.getElementById('color-test-picker');
  if (hexInput) hexInput.value = hex;
  if (picker)   picker.value   = hex;
  _updateColorSwatch(hex);
}

// ══════════════════════════════════════════════════════════
//  COLOR — CANVAS PIXEL SAMPLER (click canvas → sample color)
// ══════════════════════════════════════════════════════════

// Store the last screen image data for canvas sampling
let _colorCanvasScreenData = null;   // ImageData from the full screen capture
let _colorCanvasOffsetX    = 0;      // canvas left offset in screen coords
let _colorCanvasOffsetY    = 0;      // canvas top offset in screen coords
let _colorCanvasScaleX     = 1;
let _colorCanvasScaleY     = 1;

function colorCanvasClick(e) {
  const canvas = document.getElementById('color-preview-canvas');
  if (!canvas || !_colorCanvasScreenData) return;

  // Get click position on canvas
  const rect   = canvas.getBoundingClientRect();
  const cx     = e.clientX - rect.left;
  const cy     = e.clientY - rect.top;

  // Map to image coordinates
  const ix = Math.round(cx * _colorCanvasScaleX);
  const iy = Math.round(cy * _colorCanvasScaleY);

  // Read pixel from stored image data
  const idx = (iy * _colorCanvasScreenData.width + ix) * 4;
  const d   = _colorCanvasScreenData.data;
  if (idx < 0 || idx + 2 >= d.length) return;

  const r = d[idx], g = d[idx+1], b = d[idx+2];
  const hex = '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0').toUpperCase()).join('');

  _applyPickedColor(hex);
  toast(`Sampled: ${hex} at canvas (${ix},${iy})`, 'info');
}

// Patch testColor to store image data after scan for canvas sampling
const _origTestColorBase = testColor;
testColor = async function() {
  _colorCanvasScreenData = null;
  await _origTestColorBase();
  // Store canvas image data for pixel sampling
  const canvas = document.getElementById('color-preview-canvas');
  if (canvas && canvas.width > 0) {
    try {
      const ctx = canvas.getContext('2d');
      _colorCanvasScreenData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      _colorCanvasScaleX = canvas.width  / canvas.offsetWidth;
      _colorCanvasScaleY = canvas.height / canvas.offsetHeight;
    } catch(e) {}
  }
};

// ══════════════════════════════════════════════════════════
//  OCR — REGION THUMBNAIL PREVIEW
// ══════════════════════════════════════════════════════════

async function refreshOcrRegionPreview() {
  if (!_ocrTestRegion || !checkApi()) return;
  const { x, y, w, h } = _ocrTestRegion;
  try {
    const r = await window.pywebview.api.capture_region_preview(x, y, w, h);
    if (r && r.status === 'ok') {
      const img  = document.getElementById('ocr-region-thumb');
      const wrap = document.getElementById('ocr-region-thumb-wrap');
      if (img)  img.src = r.image;
      if (wrap) wrap.classList.remove('hidden');
    }
  } catch(e) {}
}

// Patch setOcrTestRegion to also refresh the thumbnail after drawing
const _origSetOcrTestRegion = setOcrTestRegion;
setOcrTestRegion = async function() {
  await _origSetOcrTestRegion();
  // Show the refresh button and load thumbnail
  const btn = document.getElementById('ocr-preview-region-btn');
  if (btn) btn.style.display = '';
  await refreshOcrRegionPreview();
  // _updateOcrRegionUI is already called inside _origSetOcrTestRegion
};

// clearOcrTestRegion already calls _updateOcrRegionUI and hides thumbnail — no extra patch needed

function ocrTextChanged() {
  // Hide stale results when user changes the search text
  const result = document.getElementById('ocr-scan-result');
  if (result && !result.classList.contains('hidden')) {
    result.classList.add('hidden');
  }
}

// ══════════════════════════════════════════════════════════
//  OCR — REGION-ONLY CROPPED CANVAS VIEW
// ══════════════════════════════════════════════════════════

let _ocrLastScreenImg    = null;   // base64 full screen
let _ocrLastMatches      = [];     // [{x,y,w,h}]
let _ocrCurrentView      = 'full'; // 'full' | 'region'

function setOcrView(which) {
  _ocrCurrentView = which;
  document.getElementById('ocr-view-full-btn')  .classList.toggle('active', which === 'full');
  document.getElementById('ocr-view-region-btn').classList.toggle('active', which === 'region');
  _renderOcrCanvas();
}

function _renderOcrCanvas() {
  if (!_ocrLastScreenImg) return;
  const canvas = document.getElementById('ocr-preview-canvas');
  const placeholder = document.getElementById('ocr-preview-placeholder');
  if (!canvas) return;

  const img = new Image();
  img.onload = () => {
    let drawX = 0, drawY = 0, drawW = img.width, drawH = img.height;

    if (_ocrCurrentView === 'region' && _ocrTestRegion) {
      drawX = _ocrTestRegion.x;
      drawY = _ocrTestRegion.y;
      drawW = _ocrTestRegion.w;
      drawH = _ocrTestRegion.h;
    }

    canvas.width  = drawW;
    canvas.height = drawH;
    const ctx = canvas.getContext('2d');

    // Crop: draw only the relevant portion
    ctx.drawImage(img, drawX, drawY, drawW, drawH, 0, 0, drawW, drawH);

    // Draw search region border (only in full view)
    if (_ocrCurrentView === 'full' && _ocrTestRegion) {
      ctx.strokeStyle = '#e67e22';
      ctx.lineWidth   = 3;
      ctx.setLineDash([6, 3]);
      ctx.strokeRect(_ocrTestRegion.x, _ocrTestRegion.y, _ocrTestRegion.w, _ocrTestRegion.h);
      ctx.setLineDash([]);
    }

    // Draw match boxes (adjusted for crop offset)
    const offsetX = _ocrCurrentView === 'region' && _ocrTestRegion ? _ocrTestRegion.x : 0;
    const offsetY = _ocrCurrentView === 'region' && _ocrTestRegion ? _ocrTestRegion.y : 0;

    _ocrLastMatches.forEach(m => {
      const rx = m.x - offsetX;
      const ry = m.y - offsetY;
      ctx.strokeStyle = '#27ae60';
      ctx.lineWidth   = 3;
      ctx.strokeRect(rx, ry, m.w, m.h);
      ctx.fillStyle   = 'rgba(39,174,96,0.15)';
      ctx.fillRect(rx, ry, m.w, m.h);
    });

    if (placeholder) placeholder.style.display = 'none';
    canvas.style.display = 'block';
  };
  img.src = _ocrLastScreenImg;
}

// Patch testOcr to store data and drive the new rendering pipeline
const _origTestOcrBase = testOcr;
testOcr = async function() {
  _showOcrInsertRow(false);
  _ocrLastScreenImg = null;
  _ocrLastMatches   = [];

  const resultWrap = document.getElementById('ocr-scan-result');
  const badge      = document.getElementById('ocr-match-badge');
  const canvas     = document.getElementById('ocr-preview-canvas');
  const placeholder= document.getElementById('ocr-preview-placeholder');
  const toggleRow  = document.getElementById('ocr-view-toggle');
  const redrawRow  = document.getElementById('ocr-redraw-row');

  const text = document.getElementById('ocr-test-text').value.trim();
  if (!text) { toast('Enter text to find', 'warn'); return; }
  const conf        = parseInt(document.getElementById('ocr-test-conf').value) || 80;
  const regionArray = _ocrTestRegion
    ? [_ocrTestRegion.x, _ocrTestRegion.y, _ocrTestRegion.w, _ocrTestRegion.h]
    : null;

  resultWrap.classList.remove('hidden');
  badge.textContent = '⏳ Scanning…';
  badge.className   = 'tpl-match-badge-new scanning';
  if (placeholder) { placeholder.style.display = 'flex'; }
  if (canvas)      { canvas.style.display = 'none'; }
  if (toggleRow)   { toggleRow.classList.add('hidden'); }
  if (redrawRow)   { redrawRow.classList.add('hidden'); }

  try {
    const [screenData, result] = await Promise.all([
      withLoading(window.pywebview.api.capture_screen()),
      withLoading(window.pywebview.api.detect_text_all(text, conf, regionArray))
    ]);

    _ocrLastScreenImg = screenData.screen;
    _ocrLastMatches   = result.matches || [];
    _ocrCurrentView   = 'full';
    if (toggleRow) {
      document.getElementById('ocr-view-full-btn')  .classList.add('active');
      document.getElementById('ocr-view-region-btn').classList.remove('active');
    }

    if (_ocrLastMatches.length > 0) {
      badge.textContent = `✅ Found ${_ocrLastMatches.length} match(es)`;
      badge.className   = 'tpl-match-badge-new found';
      // Show view toggle only if a region is set
      if (toggleRow && _ocrTestRegion) toggleRow.classList.remove('hidden');
      if (redrawRow) redrawRow.classList.add('hidden');
    } else {
      badge.textContent = '❌ No matches found';
      badge.className   = 'tpl-match-badge-new notfound';
      if (redrawRow) redrawRow.classList.remove('hidden');
    }

    _renderOcrCanvas();
  } catch(e) {
    toast(`Error: ${e}`, 'error');
    badge.textContent = '⚠️ Scan error';
    badge.className   = 'tpl-match-badge-new notfound';
  }

  const found = badge.classList.contains('found');
  _showOcrInsertRow(found);
};

// ══════════════════════════════════════════════════════════
//  SAVE OCR / COLOR TEMPLATES FROM ACCORDION
// ══════════════════════════════════════════════════════════

async function saveOcrTemplate() {
  if (!checkApi()) return;
  const name = (document.getElementById('ocr-tpl-name').value || '').trim();
  const text = (document.getElementById('ocr-test-text').value || '').trim();
  const conf = parseInt(document.getElementById('ocr-test-conf').value) || 80;
  const region = _ocrTestRegion
    ? [_ocrTestRegion.x, _ocrTestRegion.y, _ocrTestRegion.w, _ocrTestRegion.h]
    : null;

  if (!name) { toast('Enter a template name first', 'warn'); document.getElementById('ocr-tpl-name').focus(); return; }
  if (!text) { toast('Enter the text to search for', 'warn'); document.getElementById('ocr-test-text').focus(); return; }

  try {
    const r = await withLoading(window.pywebview.api.save_ocr_template(name, text, conf, region));
    if (r.status === 'ok') {
      toast(`✅ Saved OCR template: ${r.name}`, 'info');
      document.getElementById('ocr-tpl-name').value = '';
      loadTemplates();
    } else {
      toast(`Error: ${r.message}`, 'error');
    }
  } catch(e) { toast(`Save error: ${e}`, 'error'); }
}

async function saveColorTemplate() {
  if (!checkApi()) return;
  const name  = (document.getElementById('color-tpl-name').value || '').trim();
  const color = (document.getElementById('color-test-hex').value || '').trim();
  const tol   = parseInt(document.getElementById('color-test-tol').value) || 30;
  const region = _colorTestRegion
    ? [_colorTestRegion.x, _colorTestRegion.y, _colorTestRegion.w, _colorTestRegion.h]
    : null;

  if (!name)  { toast('Enter a template name first', 'warn'); document.getElementById('color-tpl-name').focus(); return; }
  if (!color) { toast('Enter a color hex value', 'warn'); document.getElementById('color-test-hex').focus(); return; }
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) { toast('Color must be a valid hex like #FF0000', 'warn'); return; }

  try {
    const r = await withLoading(window.pywebview.api.save_color_template(name, color, tol, region));
    if (r.status === 'ok') {
      toast(`✅ Saved Color template: ${r.name}`, 'info');
      document.getElementById('color-tpl-name').value = '';
      loadTemplates();
    } else {
      toast(`Error: ${r.message}`, 'error');
    }
  } catch(e) { toast(`Save error: ${e}`, 'error'); }
}

// ══════════════════════════════════════════════════════════
//  OPEN META TEMPLATE EDITOR (TEXT / COLOR types)
// ══════════════════════════════════════════════════════════

// ── Helper: close ALL editor panels before opening any new one ──
function _closeAllTplEditors() {
  // Hide image editor
  const inner = document.getElementById('tpl-editor-inner');
  if (inner) inner.classList.add('hidden');
  // Hide meta editor
  const meta = document.getElementById('tpl-meta-editor');
  if (meta) meta.style.display = 'none';
  // Hide empty state (caller will decide whether to show it)
  const empty = document.getElementById('tpl-empty-state');
  if (empty) empty.classList.add('hidden');
  // Clear all active card highlights
  document.querySelectorAll('.tpl-card-new').forEach(c => c.classList.remove('active'));
}

// Patch openTplEditor to handle TEXT/COLOR meta templates
const _origOpenTplEditor = openTplEditor;
openTplEditor = async function(name) {
  // Close every panel first — prevents stale editors staying visible
  _closeAllTplEditors();

  const card = document.getElementById(`tpl-card-${name}`);
  const type = card ? card.dataset.type : 'IMAGE';

  if (type === 'TEXT' || type === 'COLOR') {
    await openMetaTplEditor(name, type);
    return;
  }
  // Normal image template
  await _origOpenTplEditor(name);
};

async function openMetaTplEditor(name, type) {
  if (!checkApi()) return;
  // Highlight active card (clear was already done in _closeAllTplEditors)
  const card = document.getElementById(`tpl-card-${name}`);
  if (card) card.classList.add('active');

  let metaPanel = document.getElementById('tpl-meta-editor');
  if (!metaPanel) {
    metaPanel = document.createElement('div');
    metaPanel.id        = 'tpl-meta-editor';
    metaPanel.className = 'tpl-meta-editor-panel';
    document.getElementById('tpl-editor-col').appendChild(metaPanel);
  }
  metaPanel.style.display = 'block';

  try {
    const r = await withLoading(window.pywebview.api.get_meta_template(name));
    if (r.status !== 'ok') { toast('Could not load template', 'error'); return; }
    const meta = r.meta;
    _renderMetaEditor(metaPanel, name, type, meta);
  } catch(e) { toast(`Error: ${e}`, 'error'); }
}

// ── Store meta editor state ────────────────────────────────
let _metaEditName   = '';
let _metaEditRegion = null;  // { x, y, w, h } or null

function _renderMetaEditor(panel, name, type, meta) {
  _metaEditName   = name;
  _metaEditRegion = meta.region
    ? { x: meta.region[0], y: meta.region[1], w: meta.region[2], h: meta.region[3] }
    : null;

  const icon       = type === 'TEXT' ? '🔤' : '🎨';
  const badgeClass = type === 'TEXT' ? 'tpl-badge-text' : 'tpl-badge-color';
  const regionStr  = _metaEditRegion
    ? `(${_metaEditRegion.x}, ${_metaEditRegion.y}) ${_metaEditRegion.w}×${_metaEditRegion.h}`
    : 'No region set — full screen';

  // Step 1: details (editable)
  let step1 = '';
  if (type === 'TEXT') {
    step1 = `
      <div class="tpl-step-card">
        <div class="tpl-step-num">1</div>
        <div class="tpl-step-body">
          <div class="tpl-step-title">OCR Text Template</div>
          <div class="tpl-step-desc">Edit the search text and confidence used when this template is referenced in a script.</div>
          <div class="form-group">
            <label>Template Name</label>
            <div class="tpl-rename-row">
              <input type="text" id="meta-edit-name" class="cfg-input" value="${name}" style="flex:1"/>
            </div>
          </div>
          <div class="form-group">
            <label>Text to find</label>
            <input type="text" id="meta-edit-text" class="cfg-input" value="${meta.text || ''}"/>
          </div>
          <div class="form-group">
            <label>Confidence (0–100)</label>
            <input type="number" id="meta-edit-conf" class="cfg-input" min="0" max="100" value="${meta.confidence || 80}" style="width:100px"/>
          </div>
          <button class="btn btn-play full-width" style="margin-top:0.5rem" onclick="saveMetaEdits('TEXT')">
            <svg class="icon" aria-hidden="true"><use href="#i-save"/></svg> Save Changes
          </button>
        </div>
      </div>`;
  } else {
    step1 = `
      <div class="tpl-step-card">
        <div class="tpl-step-num">1</div>
        <div class="tpl-step-body">
          <div class="tpl-step-title">Color Pixel Template</div>
          <div class="tpl-step-desc">Edit the color and tolerance used when this template is referenced in a script.</div>
          <div class="form-group">
            <label>Template Name</label>
            <div class="tpl-rename-row">
              <input type="text" id="meta-edit-name" class="cfg-input" value="${name}" style="flex:1"/>
            </div>
          </div>
          <div class="form-group">
            <label>Color</label>
            <div class="color-picker-row-a">
              <button class="color-palette-btn" title="Open color palette">
                <div id="meta-color-swatch" class="color-swatch-large" style="background:${meta.color || '#FF0000'}"></div>
                <span class="color-palette-label">Pick</span>
                <input type="color" id="meta-edit-color-picker" value="${meta.color || '#FF0000'}"
                  oninput="document.getElementById('meta-edit-color').value=this.value;document.getElementById('meta-color-swatch').style.background=this.value">
              </button>
              <input type="text" id="meta-edit-color" class="cfg-input color-hex-input"
                value="${meta.color || '#FF0000'}"
                oninput="document.getElementById('meta-edit-color-picker').value=this.value;document.getElementById('meta-color-swatch').style.background=this.value">
            </div>
          </div>
          <div class="form-group">
            <label>Tolerance (0–255)</label>
            <input type="number" id="meta-edit-tol" class="cfg-input" min="0" max="255" value="${meta.tolerance || 30}" style="width:100px"/>
          </div>
          <button class="btn btn-play full-width" style="margin-top:0.5rem" onclick="saveMetaEdits('COLOR')">
            <svg class="icon" aria-hidden="true"><use href="#i-save"/></svg> Save Changes
          </button>
        </div>
      </div>`;
  }

  // Step 2: Search region
  const step2 = `
    <div class="tpl-step-card">
      <div class="tpl-step-num">2</div>
      <div class="tpl-step-body">
        <div class="tpl-step-title">Search Region <span class="optional-tag">optional but recommended</span></div>
        <div class="tpl-step-desc">Limit where on screen to look — makes detection faster and more accurate.</div>
        <div class="detect-region-box">
          <div class="detect-region-header">
            <span class="detect-region-title">
              <svg class="icon" aria-hidden="true"><use href="#i-ruler"/></svg>
              <span id="meta-region-label">Search Region</span>
            </span>
            <div style="display:flex;gap:5px;flex-wrap:nowrap">
              <button class="btn btn-xs" onclick="metaSetRegion()">
                <svg class="icon" aria-hidden="true"><use href="#i-box-dashed"/></svg> Draw Region
              </button>
              <button class="btn btn-xs btn-danger-xs" id="meta-region-clear-btn"
                onclick="metaClearRegion()" ${_metaEditRegion ? '' : 'style="display:none"'}>
                <svg class="icon" aria-hidden="true"><use href="#i-x-close"/></svg> Clear
              </button>
            </div>
          </div>
          <div class="detect-region-display">
            <span id="meta-region-status">${regionStr}</span>
          </div>
        </div>
      </div>
    </div>`;

  // Step 3: Test detection
  const scanLabel = type === 'TEXT' ? 'Scan for Text' : 'Scan for Color';
  const scanFn    = type === 'TEXT' ? 'metaScanText()' : 'metaScanColor()';
  const step3 = `
    <div class="tpl-step-card">
      <div class="tpl-step-num">3</div>
      <div class="tpl-step-body">
        <div class="tpl-step-title">Test Detection</div>
        <div class="tpl-step-desc">Take a screenshot and verify this template can be found on your screen.</div>
        <button class="btn btn-secondary full-width" onclick="${scanFn}" style="margin-bottom:0.8rem">
          <svg class="icon" aria-hidden="true"><use href="#i-search"/></svg> ${scanLabel}
        </button>
        <div class="tpl-scan-result hidden" id="meta-scan-result">
          <div class="tpl-match-badge-new" id="meta-scan-badge"></div>
          <div class="tpl-preview-wrap" style="margin-top:0.6rem">
            <canvas id="meta-scan-canvas" class="tpl-preview-canvas"
              onclick="_openScanLightbox('meta-scan-canvas')"
              style="cursor:zoom-in" title="Click to fullscreen"></canvas>
            <div id="meta-scan-placeholder" class="tpl-preview-placeholder">Click "${scanLabel}" to test</div>
          </div>
          <div class="tpl-legend">
            <span class="tpl-leg-item"><span class="tpl-leg-box" style="border-color:#27ae60"></span> Match found</span>
            <span class="tpl-leg-item"><span class="tpl-leg-box" style="border-color:#e67e22"></span> Search region</span>
          </div>
        </div>
      </div>
    </div>`;

  panel.innerHTML = `
    <div class="tpl-editor-header">
      <div class="tpl-editor-title-row">
        <span class="tpl-editor-icon">${icon}</span>
        <span class="tpl-editor-name" id="meta-editor-title">${name}</span>
        <span class="tpl-type-badge ${badgeClass}">${type}</span>
      </div>
      <div class="tpl-editor-actions-top">
        <button class="btn btn-secondary" onclick="insertMetaTemplate('${name}')">
          <svg class="icon" aria-hidden="true"><use href="#i-plus"/></svg> Use in Script
        </button>
        <button class="btn btn-danger tpl-del-btn" onclick="deleteMetaTemplate('${name}')">
          <svg class="icon" aria-hidden="true"><use href="#i-trash"/></svg>
        </button>
      </div>
    </div>
    ${step1}${step2}${step3}
  `;
}

// ── Save edits from the meta editor ───────────────────────
async function saveMetaEdits(type) {
  if (!checkApi()) return;
  const newName = (document.getElementById('meta-edit-name')?.value || '').trim();
  if (!newName) { toast('Name cannot be empty', 'warn'); return; }

  const region = _metaEditRegion
    ? [_metaEditRegion.x, _metaEditRegion.y, _metaEditRegion.w, _metaEditRegion.h]
    : null;

  let result;
  if (type === 'TEXT') {
    const text = (document.getElementById('meta-edit-text')?.value || '').trim();
    const conf = parseInt(document.getElementById('meta-edit-conf')?.value) || 80;
    if (!text) { toast('Text cannot be empty', 'warn'); return; }
    result = await withLoading(window.pywebview.api.save_ocr_template(newName, text, conf, region));
  } else {
    const color = (document.getElementById('meta-edit-color')?.value || '').trim();
    const tol   = parseInt(document.getElementById('meta-edit-tol')?.value) || 30;
    if (!color) { toast('Color cannot be empty', 'warn'); return; }
    result = await withLoading(window.pywebview.api.save_color_template(newName, color, tol, region));
  }

  if (result?.status === 'ok') {
    // If name changed, delete old entry
    if (newName !== _metaEditName) {
      await window.pywebview.api.delete_template(_metaEditName);
    }
    toast(`✅ Saved: ${newName}`, 'info');
    _metaEditName = newName;
    loadTemplates();
  } else {
    toast(`Error: ${result?.message || 'Unknown error'}`, 'error');
  }
}

// ── Meta editor region ─────────────────────────────────────
async function metaSetRegion() {
  if (!checkApi()) return;
  const region = await withLoading(window.pywebview.api.set_detect_region());
  if (region && region.status === 'ok') {
    _metaEditRegion = { x: region.x, y: region.y, w: region.w, h: region.h };
    _updateMetaRegionUI();
  }
}

function metaClearRegion() {
  _metaEditRegion = null;
  _updateMetaRegionUI();
}

function _updateMetaRegionUI() {
  const r = _metaEditRegion;
  const statusEl   = document.getElementById('meta-region-status');
  const clearBtn   = document.getElementById('meta-region-clear-btn');
  if (statusEl) statusEl.textContent = r
    ? `(${r.x}, ${r.y}) ${r.w}×${r.h}`
    : 'No region set — full screen';
  if (clearBtn) clearBtn.style.display = r ? '' : 'none';
}

// ── Meta editor scan (TEXT) ────────────────────────────────
async function metaScanText() {
  if (!checkApi()) return;
  const text = (document.getElementById('meta-edit-text')?.value || '').trim();
  if (!text) { toast('Enter the text to search for first', 'warn'); return; }
  const conf   = parseInt(document.getElementById('meta-edit-conf')?.value) || 80;
  const region = _metaEditRegion
    ? [_metaEditRegion.x, _metaEditRegion.y, _metaEditRegion.w, _metaEditRegion.h]
    : null;
  await _runMetaScan('TEXT', { text, conf, region });
}

// ── Meta editor scan (COLOR) ───────────────────────────────
async function metaScanColor() {
  if (!checkApi()) return;
  const color = (document.getElementById('meta-edit-color')?.value || '').trim();
  if (!color) { toast('Enter a color first', 'warn'); return; }
  const tol    = parseInt(document.getElementById('meta-edit-tol')?.value) || 30;
  const region = _metaEditRegion
    ? [_metaEditRegion.x, _metaEditRegion.y, _metaEditRegion.w, _metaEditRegion.h]
    : null;
  await _runMetaScan('COLOR', { color, tol, region });
}

async function _runMetaScan(type, params) {
  const resultWrap  = document.getElementById('meta-scan-result');
  const badge       = document.getElementById('meta-scan-badge');
  const canvas      = document.getElementById('meta-scan-canvas');
  const placeholder = document.getElementById('meta-scan-placeholder');

  if (!resultWrap) return;
  resultWrap.classList.remove('hidden');
  badge.textContent = '⏳ Scanning…';
  badge.className   = 'tpl-match-badge-new scanning';
  if (placeholder) { placeholder.style.display = 'flex'; }
  if (canvas)      { canvas.style.display = 'none'; }

  try {
    const screenData = await withLoading(window.pywebview.api.capture_screen());
    const screenImg  = screenData.screen;

    let matches = [];
    if (type === 'TEXT') {
      const r = await withLoading(window.pywebview.api.detect_text_all(params.text, params.conf, params.region));
      matches = r.matches || [];
    } else {
      const r = await withLoading(window.pywebview.api.detect_color_all(params.color, params.tol, params.region));
      matches = r.matches || [];
    }

    const img = new Image();
    img.onload = () => {
      canvas.width  = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      // Draw region border
      if (params.region) {
        const [rx, ry, rw, rh] = params.region;
        ctx.strokeStyle = '#e67e22';
        ctx.lineWidth   = 3;
        ctx.setLineDash([6, 3]);
        ctx.strokeRect(rx, ry, rw, rh);
        ctx.setLineDash([]);
      }

      if (matches.length > 0) {
        if (type === 'TEXT') {
          matches.forEach(m => {
            ctx.strokeStyle = '#27ae60';
            ctx.lineWidth   = 3;
            ctx.strokeRect(m.x, m.y, m.w, m.h);
            ctx.fillStyle   = 'rgba(39,174,96,0.15)';
            ctx.fillRect(m.x, m.y, m.w, m.h);
          });
          badge.textContent = `✅ Found ${matches.length} match(es)`;
        } else {
          const MAX = 2000;
          const render = matches.length > MAX
            ? matches.filter((_, i) => i % Math.ceil(matches.length / MAX) === 0)
            : matches;
          ctx.fillStyle = '#27ae60';
          render.forEach(m => ctx.fillRect(m.x - 2, m.y - 2, 5, 5));
          const note = matches.length > MAX ? ` (showing ${render.length} of ${matches.length})` : '';
          badge.textContent = `✅ Found ${matches.length} pixel(s)${note}`;
        }
        badge.className = 'tpl-match-badge-new found';
      } else {
        badge.textContent = `❌ No matches found`;
        badge.className   = 'tpl-match-badge-new notfound';
      }

      if (placeholder) placeholder.style.display = 'none';
      canvas.style.display = 'block';
    };
    img.src = screenImg;
  } catch(e) {
    toast(`Scan error: ${e}`, 'error');
    badge.textContent = '⚠️ Scan error';
    badge.className   = 'tpl-match-badge-new notfound';
  }
}


function insertMetaTemplate(name) {
  const card = document.getElementById(`tpl-card-${name}`);
  const type = card ? card.dataset.type : null;
  if (!type) return;

  window.pywebview.api.get_meta_template(name).then(r => {
    if (r.status !== 'ok') return;
    const meta = r.meta;
    let cmd = '';
    if (meta.type === 'TEXT') {
      cmd = `TEXT_CLICK "${meta.text}"`;
      if (meta.confidence !== 80) cmd += ` confidence=${meta.confidence}`;
      if (meta.region) cmd += ` region=${meta.region.join(' ')}`;
    } else if (meta.type === 'COLOR') {
      cmd = `COLOR_CLICK ${meta.color}`;
      if (meta.tolerance !== 30) cmd += ` tolerance=${meta.tolerance}`;
      if (meta.region) cmd += ` region=${meta.region.join(' ')}`;
    }
    if (cmd && typeof insertToEditor === 'function') {
      if (typeof showTab === 'function') showTab('macro');
      insertToEditor(cmd);
      toast(`Inserted: ${cmd}`, 'info');
    }
  });
}

async function deleteMetaTemplate(name) {
  const ok = typeof appConfirm === 'function'
    ? await appConfirm({ title: 'Delete Template', filename: name, warning: 'This cannot be undone.', okLabel: 'Delete', icon: 'i-trash', kind: 'danger' })
    : confirm(`Delete template "${name}"?`);
  if (!ok) return;
  try {
    await withLoading(window.pywebview.api.delete_template(name));
    toast(`Deleted: ${name}`, 'info');
    // Hide meta editor
    const metaPanel = document.getElementById('tpl-meta-editor');
    if (metaPanel) metaPanel.style.display = 'none';
    document.getElementById('tpl-empty-state').classList.remove('hidden');
    loadTemplates();
  } catch(e) { toast(`Error: ${e}`, 'error'); }
}

// ══════════════════════════════════════════════════════════
//  FEATURE 1 — IMAGE ROTATE & FLIP
// ══════════════════════════════════════════════════════════

async function tplRotate(degrees) {
  if (!checkApi()) return;
  if (!_tplEditName) return;
  const base = _tplEditName.replace('.png', '');
  try {
    const r = await withLoading(window.pywebview.api.rotate_template(base, degrees, true));
    if (r.status === 'ok') {
      // Update the editor preview image
      const edImg = document.getElementById('tpl-edit-img');
      if (edImg) { edImg.src = r.data; edImg.style.display = 'block'; }
      // Show the undo button
      const undoBtn = document.getElementById('tpl-restore-transform-btn');
      if (undoBtn) undoBtn.style.display = '';
      // Refresh the thumbnail in the list
      loadThumb(_tplEditName);
      toast(`Rotated ${degrees}°`, 'info');
    } else {
      toast(`Rotate error: ${r.message}`, 'error');
    }
  } catch(e) { toast(`Error: ${e}`, 'error'); }
}

async function tplFlip(direction) {
  if (!checkApi()) return;
  if (!_tplEditName) return;
  const base = _tplEditName.replace('.png', '');
  try {
    const r = await withLoading(window.pywebview.api.flip_template(base, direction, true));
    if (r.status === 'ok') {
      const edImg = document.getElementById('tpl-edit-img');
      if (edImg) { edImg.src = r.data; edImg.style.display = 'block'; }
      const undoBtn = document.getElementById('tpl-restore-transform-btn');
      if (undoBtn) undoBtn.style.display = '';
      loadThumb(_tplEditName);
      const label = direction === 'horizontal' ? 'Flipped H' : 'Flipped V';
      toast(label, 'info');
    } else {
      toast(`Flip error: ${r.message}`, 'error');
    }
  } catch(e) { toast(`Error: ${e}`, 'error'); }
}

async function tplRestoreTransform() {
  if (!checkApi()) return;
  if (!_tplEditName) return;
  const base = _tplEditName.replace('.png', '');
  try {
    const r = await withLoading(window.pywebview.api.restore_template_backup(base));
    if (r.status === 'ok') {
      if (r.restored) {
        // Reload preview
        const data = await window.pywebview.api.get_template_preview(base);
        const edImg = document.getElementById('tpl-edit-img');
        if (edImg && data.status === 'ok') {
          edImg.src = data.data;
          edImg.style.display = 'block';
        }
        const undoBtn = document.getElementById('tpl-restore-transform-btn');
        if (undoBtn) undoBtn.style.display = 'none';
        loadThumb(_tplEditName);
        toast('Restored original image', 'info');
      } else {
        toast('No backup to restore', 'warn');
      }
    }
  } catch(e) { toast(`Error: ${e}`, 'error'); }
}
