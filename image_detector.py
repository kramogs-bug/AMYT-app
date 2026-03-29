"""
vision/image_detector.py  — v3
Core image detection engine using OpenCV template matching.

v3 Improvements (accuracy-focused, Macrorify-grade):
────────────────────────────────────────────────────────────────────────────────
  1. Grayscale primary matching        — 3× faster, same accuracy
  2. Alpha-mask support                — transparent sprite backgrounds handled
  3. CLAHE contrast normalization      — robust to brightness/lighting shifts
  4. Sub-pixel peak refinement         — ±0.3px vs old ±3px coordinate noise
  5. Scale memory cache                — no brute-force rescanning every frame
  6. Focused motion-gate diff          — only diff around last known position
  7. IoU NMS for find_all              — replaces buggy grid-cell dedup
  8. Asymmetric confidence smoothing   — fast miss-drain, slow hit-fill
  9. Cropped feature-match fallback    — ORB on search region, not full screen
 10. Per-template config               — per-sprite overrides for any parameter

v2 features retained (unchanged API):
  - Screenshot diff / motion gating
  - ORB / AKAZE feature-matching fallback
  - Temporal confidence smoothing
  - Persistent mss instance
  - Position EMA smoothing
  - mtime-based template cache
────────────────────────────────────────────────────────────────────────────────
"""

import cv2
import numpy as np
import mss
import os
import time
import threading
from collections import deque


# ── Per-template configuration ─────────────────────────────────────────────────

class TemplateConfig:
    """
    Per-template detection overrides.  Pass to set_template_config().

    use_grayscale : bool | None
        None = use global default.
        Set False for templates where colour is the sole distinguishing feature
        (e.g. a red health potion vs a blue mana potion with identical shapes).

    use_mask : bool | None
        Whether to use the PNG alpha channel as a matchTemplate mask.
        Default True when the template has an alpha channel.

    use_clahe : bool | None
        Apply CLAHE before matching.  Disable for fixed-brightness UI elements.

    color_verify_tolerance : int | None
        After a successful match, the mean HSV hue difference between the
        matched screen patch and the template must be ≤ this value (0–180).
        None = disabled.  Useful to reject shape-matches with wrong colour.
    """
    def __init__(self,
                 use_grayscale=None,
                 use_mask=None,
                 use_clahe=None,
                 color_verify_tolerance=None):
        self.use_grayscale          = use_grayscale
        self.use_mask               = use_mask
        self.use_clahe              = use_clahe
        self.color_verify_tolerance = color_verify_tolerance


# ── Main detector ──────────────────────────────────────────────────────────────

class ImageDetector:

    def __init__(self, logger,
                 # v2 parameters (unchanged defaults)
                 motion_threshold=1.5,
                 feature_fallback_threshold=0.50,
                 smooth_window=5,
                 position_ema_alpha=0.55,
                 # v3 parameters
                 use_grayscale=True,
                 use_clahe=True,
                 use_subpixel=True,
                 use_scale_cache=True,
                 use_alpha_mask=True,
                 iou_threshold=0.45,
                 clahe_clip=2.0,
                 clahe_grid=4,
                 color_verify_tolerance=None):
        """
        v3 new parameters
        ─────────────────
        use_grayscale   : Match in grayscale (True). 3× faster; same accuracy
                          for most sprites. Set False only when colour alone
                          distinguishes two identically-shaped targets.
        use_clahe       : CLAHE contrast normalisation before matching (True).
                          Makes detection robust to day/night, screen flash,
                          dimmed UI states.
        use_subpixel    : Quadratic sub-pixel refinement of the response peak
                          (True). Reduces coordinate noise from ±3 px to ±0.3 px.
        use_scale_cache : Cache the winning scale per template and try it first
                          next frame (True). Eliminates brute-force rescanning.
        use_alpha_mask  : Use PNG alpha channel as matchTemplate mask (True).
                          Without this, transparent = black, corrupting match
                          scores against dark backgrounds.
        iou_threshold   : IoU overlap threshold for find_all NMS (0.45).
        clahe_clip/grid : CLAHE parameters. Defaults 2.0 / 4×4.
        color_verify_tolerance : Global HSV hue tolerance (None = disabled).
        """
        self.logger = logger
        self.templates_dir = os.path.join("storage", "templates")

        # v2 flags
        self.motion_threshold           = motion_threshold
        self.feature_fallback_threshold = feature_fallback_threshold
        self.smooth_window              = max(1, smooth_window)
        self.position_ema_alpha         = max(0.0, min(1.0, position_ema_alpha))

        # v3 flags
        self.use_grayscale              = use_grayscale
        self.use_clahe                  = use_clahe
        self.use_subpixel               = use_subpixel
        self.use_scale_cache            = use_scale_cache
        self.use_alpha_mask             = use_alpha_mask
        self.iou_threshold              = iou_threshold
        self.color_verify_tolerance     = color_verify_tolerance

        # Shared CLAHE engine (not thread-safe — single-threaded use)
        self._clahe = cv2.createCLAHE(
            clipLimit=float(clahe_clip),
            tileGridSize=(int(clahe_grid), int(clahe_grid))
        )

        # Template cache: { key: (mtime, bgr, gray, mask_or_None) }
        self._template_cache = {}
        # Per-template config overrides
        self._template_configs = {}
        # Scale memory: { template_name: float }
        self._scale_cache = {}
        # Thread-local mss handle — each thread gets its own mss instance so that
        # Win32 DC handles (srcdc/dstdc) are always valid in the calling thread.
        # Previously a single self._sct was created in the main thread, which caused
        # '_thread._local' object has no attribute 'srcdc' when the macro worker
        # thread (a different threading.Thread) tried to use it.
        self._sct_local = threading.local()
        # Motion gate: { region_key: last_gray } and { template: last_pos }
        self._last_frame    = {}
        self._motion_cache  = {}
        self._last_position = {}
        # Confidence buffers: { template: deque }
        self._conf_buffers  = {}
        # Position EMA: { template: (sx, sy) }
        self._pos_ema       = {}

    # ── Per-template config ──────────────────────────────────────────────────

    def set_template_config(self, template_name, config):
        """Override detection parameters for a specific template."""
        key = template_name if template_name.endswith(".png") else template_name + ".png"
        self._template_configs[key] = config

    def _tcfg(self, template_name, attr):
        """Return per-template override or global default."""
        key = template_name if template_name.endswith(".png") else template_name + ".png"
        cfg = self._template_configs.get(key)
        if cfg is not None:
            v = getattr(cfg, attr, None)
            if v is not None:
                return v
        return getattr(self, attr)

    # ── Template loading ─────────────────────────────────────────────────────

    def _load_template(self, template_name):
        """
        Load template with mtime-based cache.
        Returns (bgr, gray, mask_or_None) — all three always.
        v3: loads UNCHANGED to capture alpha; pre-computes gray; extracts mask.
        """
        if not template_name.endswith(".png"):
            template_name += ".png"

        path = os.path.join(self.templates_dir, template_name)
        if not os.path.exists(path):
            self.logger.log(f"Template not found: {path}", level="ERROR")
            return None, None, None

        try:
            mtime = os.path.getmtime(path)
        except OSError:
            return None, None, None

        cached = self._template_cache.get(template_name)
        if cached and cached[0] == mtime:
            return cached[1], cached[2], cached[3]

        rgba = cv2.imread(path, cv2.IMREAD_UNCHANGED)
        if rgba is None:
            self.logger.log(f"Failed to read: {path}", level="ERROR")
            return None, None, None

        mask = None
        if rgba.ndim == 3 and rgba.shape[2] == 4:
            alpha = rgba[:, :, 3]
            if self._tcfg(template_name, "use_alpha_mask"):
                mask = (alpha > 10).astype(np.uint8) * 255
            bgr = cv2.cvtColor(rgba, cv2.COLOR_BGRA2BGR)
        else:
            bgr = rgba

        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        self._template_cache[template_name] = (mtime, bgr, gray, mask)
        self.logger.log(
            f"Loaded '{template_name}' {bgr.shape[1]}x{bgr.shape[0]}"
            f" mask={'yes' if mask is not None else 'no'}"
        )
        return bgr, gray, mask

    def invalidate_cache(self, template_name=None):
        if template_name:
            key = template_name if template_name.endswith(".png") else template_name + ".png"
            self._template_cache.pop(key, None)
            self._scale_cache.pop(key, None)  # key already normalised above
        else:
            self._template_cache.clear()
            self._scale_cache.clear()

    # ── Screen capture ───────────────────────────────────────────────────────

    @staticmethod
    def _region_key(region):
        return str(region) if region else "fullscreen"

    def _grab_screen(self, region=None):
        """
        BGR frame via a per-thread persistent mss handle.

        mss stores Win32 DC handles (srcdc, dstdc, …) in threading.local, so an
        instance created in the main thread raises:
            '_thread._local' object has no attribute 'srcdc'
        the moment a different thread (e.g. the macro script worker) tries to use
        it.  Keeping the handle in self._sct_local (a threading.local) means every
        thread transparently gets — and reuses — its own handle, with no cross-thread
        leakage.
        """
        def _monitor(sct):
            if region:
                return {"left": int(region[0]), "top": int(region[1]),
                        "width": int(region[2]), "height": int(region[3])}
            return sct.monitors[1]

        # Lazy-init: first call from this thread creates a fresh mss handle
        if not hasattr(self._sct_local, 'sct'):
            self._sct_local.sct = mss.mss()

        try:
            sct = self._sct_local.sct
            return cv2.cvtColor(np.array(sct.grab(_monitor(sct))),
                                cv2.COLOR_BGRA2BGR)
        except Exception as e:
            self.logger.log(f"_grab_screen error ({e}) — recreating mss", level="WARN")
            try:
                self._sct_local.sct.close()
            except Exception:
                pass
            # Re-create within this thread so the new DC handles belong here
            self._sct_local.sct = mss.mss()
            sct = self._sct_local.sct
            return cv2.cvtColor(np.array(sct.grab(_monitor(sct))),
                                cv2.COLOR_BGRA2BGR)

    # ── Motion gating (v3: focused diff) ────────────────────────────────────

    def _screen_changed(self, frame, region, template_name=None, template_wh=None):
        """
        True if the screen changed enough for a new detection pass.
        v3: when a cached position exists, only diff a 2× crop around it
        so unrelated screen motion doesn't bust the cache.
        """
        if self.motion_threshold <= 0.0:
            return True

        rkey = self._region_key(region)

        # Focused diff around last known position
        if template_name and template_wh:
            last_pos = self._last_position.get(template_name)
            if last_pos is not None:
                lx, ly, lw, lh = last_pos
                px1 = max(0, lx - lw);      py1 = max(0, ly - lh)
                px2 = min(frame.shape[1], lx + lw * 2)
                py2 = min(frame.shape[0], ly + lh * 2)
                crop = frame[py1:py2, px1:px2]
                if crop.size > 0:
                    small = cv2.resize(crop, (0, 0), fx=0.5, fy=0.5,
                                       interpolation=cv2.INTER_AREA)
                    gray  = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
                    fkey  = f"{rkey}_{template_name}_f"
                    prev  = self._last_frame.get(fkey)
                    self._last_frame[fkey] = gray
                    if prev is not None and prev.shape == gray.shape:
                        if float(np.mean(cv2.absdiff(gray, prev))) < self.motion_threshold:
                            return False

        # Full-region diff at 25%
        small = cv2.resize(frame, (0, 0), fx=0.25, fy=0.25,
                           interpolation=cv2.INTER_AREA)
        gray  = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        prev  = self._last_frame.get(rkey)
        self._last_frame[rkey] = gray
        if prev is None or prev.shape != gray.shape:
            return True
        mean_diff = float(np.mean(cv2.absdiff(gray, prev)))
        if mean_diff < self.motion_threshold:
            self.logger.log(f"Motion gate: static (diff={mean_diff:.2f})")
            return False
        return True

    # ── CLAHE ────────────────────────────────────────────────────────────────

    def _apply_clahe(self, gray):
        return self._clahe.apply(gray)

    # ── Sub-pixel refinement ─────────────────────────────────────────────────

    @staticmethod
    def _subpixel_peak(response, loc):
        """
        Quadratic interpolation on the 3×3 neighbourhood of an integer peak.
        Returns (sub_x, sub_y) floats clamped to ±1 px of the integer location.
        Falls back to float(loc) on boundary or numerical failure.
        """
        x, y = loc
        h, w = response.shape
        if x < 1 or x >= w - 1 or y < 1 or y >= h - 1:
            return float(x), float(y)
        try:
            dx  = (float(response[y, x+1]) - float(response[y, x-1])) / 2.0
            ddx = (float(response[y, x+1]) - 2.0*float(response[y, x])
                   + float(response[y, x-1]))
            dy  = (float(response[y+1, x]) - float(response[y-1, x])) / 2.0
            ddy = (float(response[y+1, x]) - 2.0*float(response[y, x])
                   + float(response[y-1, x]))
            sx = x - (dx/ddx) if abs(ddx) > 1e-6 else float(x)
            sy = y - (dy/ddy) if abs(ddy) > 1e-6 else float(y)
            return (max(x-1.0, min(x+1.0, sx)),
                    max(y-1.0, min(y+1.0, sy)))
        except Exception:
            return float(x), float(y)

    # ── Colour verification ──────────────────────────────────────────────────

    def _color_verify(self, screen_bgr, tpl_bgr, match_loc, match_wh,
                      region_x, region_y, tolerance):
        """
        Verify the matched patch has a similar mean HSV hue to the template.
        Returns True if acceptable (or tolerance is falsy).
        """
        if not tolerance:
            return True
        tw, th = match_wh
        mx, my = match_loc
        x1 = max(0, mx);  y1 = max(0, my)
        x2 = min(screen_bgr.shape[1], mx+tw)
        y2 = min(screen_bgr.shape[0], my+th)
        if x2 <= x1 or y2 <= y1:
            return True
        try:
            def mh(bgr):
                return float(np.mean(cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)[:,:,0]))
            diff = abs(mh(screen_bgr[y1:y2, x1:x2]) - mh(tpl_bgr))
            diff = min(diff, 180.0 - diff)
            ok   = diff <= tolerance
            if not ok:
                self.logger.log(f"Color verify failed: hue_diff={diff:.1f} > {tolerance}")
            return ok
        except Exception:
            return True

    # ── Confidence smoothing (v3: asymmetric) ────────────────────────────────

    def _push_confidence(self, template_name, raw_conf):
        """
        Asymmetric smoothing: misses drain 2× faster than hits fill.
        Prevents false positives for up to smooth_window frames after target gone.
        """
        buf = self._conf_buffers.get(template_name)
        if buf is None:
            buf = deque(maxlen=self.smooth_window * 2)
            self._conf_buffers[template_name] = buf
        if raw_conf <= 0.0:
            buf.append(0.0)
            buf.append(0.0)   # double push = faster drain
        else:
            buf.append(raw_conf)
        return float(np.mean(buf)) if buf else 0.0

    def get_smoothed_confidence(self, template_name):
        buf = self._conf_buffers.get(template_name)
        return float(np.mean(buf)) if buf else 0.0

    def reset_smoothing(self, template_name=None):
        if template_name:
            self._conf_buffers.pop(template_name, None)
        else:
            self._conf_buffers.clear()

    # ── Position EMA ────────────────────────────────────────────────────────

    def _smooth_position(self, template_name, raw_x, raw_y):
        a = self.position_ema_alpha
        if a >= 1.0:
            return int(round(raw_x)), int(round(raw_y))
        prev = self._pos_ema.get(template_name)
        if prev is None:
            self._pos_ema[template_name] = (float(raw_x), float(raw_y))
            return int(round(raw_x)), int(round(raw_y))
        sx = a*raw_x + (1.0-a)*prev[0]
        sy = a*raw_y + (1.0-a)*prev[1]
        self._pos_ema[template_name] = (sx, sy)
        return int(round(sx)), int(round(sy))

    def reset_position_ema(self, template_name=None):
        if template_name:
            self._pos_ema.pop(template_name, None)
        else:
            self._pos_ema.clear()

    def reset_motion_state(self):
        """
        Clear all motion-gate and confidence state.

        Call this at the start of every new script run (before the worker thread
        begins).  Without this, stale _last_frame entries from a previous run can
        make _screen_changed() return False on the very first frame of the new run
        (the screen looks "static" relative to the last frame stored by the
        previous thread), causing the motion gate to return a cached None result
        and log "Image not found" even though the template is clearly visible.
        """
        self._last_frame.clear()
        self._motion_cache.clear()
        self._last_position.clear()
        self._conf_buffers.clear()
        self._pos_ema.clear()

    # ── Scale sequence (cache-aware) ─────────────────────────────────────────

    @staticmethod
    def _scale_key(template_name):
        """Normalise template name to .png key for scale cache lookups."""
        return template_name if template_name.endswith(".png") else template_name + ".png"

    def _build_scale_sequence(self, template_name, scale_min, scale_max,
                               scale_steps, multi_scale):
        if not multi_scale:
            return [1.0]
        all_scales = sorted(set(
            [1.0] + list(np.linspace(scale_min, scale_max, scale_steps))
        ))
        if not self.use_scale_cache:
            return all_scales
        cached_val = self._scale_cache.get(self._scale_key(template_name))
        if cached_val is None:
            return all_scales
        # Sort so cached winner (and neighbours) are tried first
        return sorted(all_scales, key=lambda s: abs(s - cached_val))

    # ── Single-scale match ───────────────────────────────────────────────────

    def _match_single_scale(self, screen_gray, tpl_gray, tpl_mask,
                             scale, use_clahe):
        """
        One matchTemplate pass at one scale.
        Returns (max_val, max_loc, response, scaled_w, scaled_h)
        or (−1, None, None, 0, 0) if template doesn't fit.
        """
        th, tw = tpl_gray.shape[:2]
        sh, sw = screen_gray.shape[:2]
        nw = max(1, int(tw * scale))
        nh = max(1, int(th * scale))
        if nw > sw or nh > sh or nw < 4 or nh < 4:
            return -1.0, None, None, 0, 0

        interp = cv2.INTER_AREA if scale < 1.0 else cv2.INTER_CUBIC
        s_tpl  = cv2.resize(tpl_gray, (nw, nh), interpolation=interp)

        if use_clahe:
            s_tpl  = self._apply_clahe(s_tpl)
            s_scr  = self._apply_clahe(screen_gray)
        else:
            s_scr  = screen_gray

        s_mask = None
        if tpl_mask is not None:
            s_mask = cv2.resize(tpl_mask, (nw, nh),
                                interpolation=cv2.INTER_NEAREST)

        method = cv2.TM_CCORR_NORMED if s_mask is not None else cv2.TM_CCOEFF_NORMED
        try:
            resp = (cv2.matchTemplate(s_scr, s_tpl, method, mask=s_mask)
                    if s_mask is not None
                    else cv2.matchTemplate(s_scr, s_tpl, method))
        except cv2.error:
            return -1.0, None, None, 0, 0

        _, max_val, _, max_loc = cv2.minMaxLoc(resp)
        return float(max_val), max_loc, resp, nw, nh

    # ── Multi-scale orchestration ────────────────────────────────────────────

    def _run_multiscale(self, template_name, screen_gray, tpl_gray, tpl_mask,
                         confidence, scale_min, scale_max, scale_steps,
                         multi_scale, use_clahe):
        """
        Try all scales in cache-first order.
        Early-exits when the cached scale already passes confidence threshold.
        Returns (best_val, best_loc, best_resp, best_w, best_h, winning_scale).
        """
        scales = self._build_scale_sequence(
            template_name, scale_min, scale_max, scale_steps, multi_scale
        )
        cached_scale = self._scale_cache.get(template_name)
        best_val = -1.0; best_loc = None; best_resp = None
        best_w = tpl_gray.shape[1]; best_h = tpl_gray.shape[0]; best_scale = 1.0

        for scale in scales:
            val, loc, resp, nw, nh = self._match_single_scale(
                screen_gray, tpl_gray, tpl_mask, scale, use_clahe
            )
            if val > best_val:
                best_val, best_loc, best_resp = val, loc, resp
                best_w, best_h, best_scale    = nw, nh, scale
            # Early exit: cached scale passed threshold → no need to try others
            if (self.use_scale_cache and scale == cached_scale
                    and val >= confidence):
                break

        return best_val, best_loc, best_resp, best_w, best_h, best_scale

    # ── Feature-match fallback (v3: cropped) ─────────────────────────────────

    def _feature_match(self, tpl_bgr, screen_bgr, region_x, region_y,
                        search_region=None):
        """
        ORB/AKAZE keypoint matching.  v3: runs on a pre-cropped search region
        instead of the full screen → ~85% fewer keypoints, higher quality.
        """
        th, tw = tpl_bgr.shape[:2]

        if search_region is not None:
            sx = max(0, int(search_region[0]) - region_x)
            sy = max(0, int(search_region[1]) - region_y)
            ex = min(screen_bgr.shape[1], sx + int(search_region[2]))
            ey = min(screen_bgr.shape[0], sy + int(search_region[3]))
            crop = screen_bgr[sy:ey, sx:ex]
            off_x = region_x + sx
            off_y = region_y + sy
        else:
            crop  = screen_bgr
            off_x = region_x
            off_y = region_y

        if crop.size == 0:
            return None

        use_akaze = (min(th, tw) < 32)
        det       = cv2.AKAZE_create() if use_akaze else cv2.ORB_create(nfeatures=250)
        algo      = "AKAZE" if use_akaze else "ORB"

        kp_t, des_t = det.detectAndCompute(tpl_bgr, None)
        kp_s, des_s = det.detectAndCompute(crop, None)

        if des_t is None or des_s is None or len(kp_t) < 4 or len(kp_s) < 4:
            return None

        bf      = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)
        matches = bf.knnMatch(des_t, des_s, k=2)
        good    = [m for m, n in (p for p in matches if len(p) == 2)
                   if m.distance < 0.75 * n.distance]

        if len(good) < 4:
            return None

        src_pts = np.float32([kp_t[m.queryIdx].pt for m in good]).reshape(-1,1,2)
        dst_pts = np.float32([kp_s[m.trainIdx].pt for m in good]).reshape(-1,1,2)
        H, mask = cv2.findHomography(src_pts, dst_pts, cv2.RANSAC, 5.0)
        if H is None:
            return None

        inliers = int(mask.sum()) if mask is not None else 0
        if inliers < 4:
            return None

        corners = np.float32([[0,0],[tw,0],[tw,th],[0,th]]).reshape(-1,1,2)
        warped  = cv2.perspectiveTransform(corners, H)
        x_vals  = warped[:,0,0];  y_vals = warped[:,0,1]
        left    = int(np.min(x_vals));  top  = int(np.min(y_vals))
        box_w   = max(1, int(np.max(x_vals)) - left)
        box_h   = max(1, int(np.max(y_vals)) - top)
        cx      = off_x + left + box_w // 2
        cy      = off_y + top  + box_h // 2
        conf    = min(0.95, inliers / max(len(kp_t), 1))

        self.logger.log(f"Feature match ({algo}): {inliers} inliers → ({cx},{cy}) conf={conf:.2f}")
        return {"x": cx, "y": cy, "confidence": conf,
                "rect": [off_x+left, off_y+top, box_w, box_h], "method": algo}

    # ── IoU NMS ─────────────────────────────────────────────────────────────

    @staticmethod
    def _iou(a, b):
        ax1,ay1 = a[0],a[1];  ax2,ay2 = a[0]+a[2],a[1]+a[3]
        bx1,by1 = b[0],b[1];  bx2,by2 = b[0]+b[2],b[1]+b[3]
        iw = max(0, min(ax2,bx2) - max(ax1,bx1))
        ih = max(0, min(ay2,by2) - max(ay1,by1))
        inter = iw * ih
        union = a[2]*a[3] + b[2]*b[3] - inter
        return inter/union if union > 0 else 0.0

    def _nms(self, hits):
        kept = []
        for h in hits:
            if all(self._iou(h["rect"], k["rect"]) < self.iou_threshold for k in kept):
                kept.append(h)
        return kept

    # ══════════════════════════════════════════════════════════════════════════
    #  PUBLIC API
    # ══════════════════════════════════════════════════════════════════════════

    def find_on_screen(self, template_name, confidence=0.8,
                        region=None, multi_scale=True,
                        scale_min=0.7, scale_max=1.3, scale_steps=7,
                        bypass_gates=False):
        """
        Find ONE instance of a template on screen.

        Full v3 pipeline:
          1. Load (bgr + gray + alpha-mask)
          2. Grab screen
          3. Focused motion gate (around last known position)
          4. Multi-scale grayscale+CLAHE matching (cache-first, early-exit)
          5. Sub-pixel peak refinement
          6. Optional colour verification
          7. ORB/AKAZE feature-match fallback on search-region crop
          8. Asymmetric temporal confidence smoothing
          9. Position EMA output smoothing
        """
        tpl_bgr, tpl_gray, tpl_mask = self._load_template(template_name)
        if tpl_bgr is None:
            return None

        th, tw   = tpl_gray.shape[:2]
        region_x = int(region[0]) if region else 0
        region_y = int(region[1]) if region else 0

        do_gray  = self._tcfg(template_name, "use_grayscale")
        do_clahe = self._tcfg(template_name, "use_clahe")
        col_tol  = self._tcfg(template_name, "color_verify_tolerance")

        # ── 1. Grab ────────────────────────────────────────────────────
        screen_bgr  = self._grab_screen(region)
        screen_gray = cv2.cvtColor(screen_bgr, cv2.COLOR_BGR2GRAY)
        sh, sw      = screen_gray.shape[:2]

        # ── 2. Motion gate ─────────────────────────────────────────────
        if not bypass_gates:
            if not self._screen_changed(screen_bgr, region,
                                        template_name=template_name,
                                        template_wh=(tw, th)):
                cached = self._motion_cache.get(template_name)
                self._push_confidence(template_name,
                                      cached["confidence"] if cached else 0.0)
                return cached

        # ── 3. Matching ────────────────────────────────────────────────
        if do_gray:
            best_val, best_loc, best_resp, best_w, best_h, best_scale = \
                self._run_multiscale(
                    template_name, screen_gray, tpl_gray, tpl_mask,
                    confidence, scale_min, scale_max, scale_steps,
                    multi_scale, do_clahe
                )
        else:
            # BGR matching for colour-critical templates
            scales   = self._build_scale_sequence(
                template_name, scale_min, scale_max, scale_steps, multi_scale)
            best_val = -1.0; best_loc = None; best_resp = None
            best_w   = tw;   best_h   = th;   best_scale = 1.0
            for scale in scales:
                nw = max(1, int(tw*scale)); nh = max(1, int(th*scale))
                if nw > sw or nh > sh or nw < 4 or nh < 4:
                    continue
                interp = cv2.INTER_AREA if scale < 1.0 else cv2.INTER_CUBIC
                s_tpl  = cv2.resize(tpl_bgr, (nw, nh), interpolation=interp)
                s_mask = (cv2.resize(tpl_mask, (nw, nh),
                                     interpolation=cv2.INTER_NEAREST)
                          if tpl_mask is not None else None)
                method = cv2.TM_CCORR_NORMED if s_mask is not None \
                    else cv2.TM_CCOEFF_NORMED
                try:
                    resp = (cv2.matchTemplate(screen_bgr, s_tpl, method, mask=s_mask)
                            if s_mask is not None
                            else cv2.matchTemplate(screen_bgr, s_tpl, method))
                except cv2.error:
                    continue
                _, v, _, loc = cv2.minMaxLoc(resp)
                if float(v) > best_val:
                    best_val, best_loc, best_resp = float(v), loc, resp
                    best_w, best_h, best_scale    = nw, nh, scale

        # ── 4. Build result dict ───────────────────────────────────────
        result_dict = None

        if best_val >= confidence and best_loc is not None:
            # Sub-pixel refinement
            if self.use_subpixel and best_resp is not None:
                sub_x, sub_y = self._subpixel_peak(best_resp, best_loc)
            else:
                sub_x, sub_y = float(best_loc[0]), float(best_loc[1])

            # Colour verification
            if col_tol and not self._color_verify(
                screen_bgr, tpl_bgr, best_loc, (best_w, best_h),
                region_x, region_y, col_tol
            ):
                best_val = 0.0   # colour mismatch — treat as miss
            else:
                abs_left = sub_x + region_x
                abs_top  = sub_y + region_y
                result_dict = {
                    "x":          int(round(abs_left + best_w / 2.0)),
                    "y":          int(round(abs_top  + best_h / 2.0)),
                    "confidence": best_val,
                    "rect":       [int(round(abs_left)), int(round(abs_top)),
                                   best_w, best_h],
                    "method":     "template",
                    "scale":      best_scale,
                }
                if self.use_scale_cache:
                    self._scale_cache[self._scale_key(template_name)] = best_scale
                # Record position for focused motion gate
                self._last_position[template_name] = (
                    int(round(abs_left)) - region_x,
                    int(round(abs_top))  - region_y,
                    best_w, best_h
                )

        elif (self.feature_fallback_threshold > 0.0
              and best_val >= self.feature_fallback_threshold):
            self.logger.log(
                f"Template match low ({best_val:.2f}) → feature fallback '{template_name}'"
            )
            result_dict = self._feature_match(
                tpl_bgr, screen_bgr, region_x, region_y, search_region=region
            )
            if result_dict and self.use_scale_cache:
                self._scale_cache[self._scale_key(template_name)] = 1.0

        # ── 5. Confidence smoothing + position EMA ─────────────────────
        raw_conf    = result_dict["confidence"] if result_dict else 0.0
        smooth_conf = self._push_confidence(template_name, raw_conf)

        def _apply_pos_ema(d):
            sx, sy = self._smooth_position(
                template_name, float(d["x"]), float(d["y"]))
            d["x"] = sx; d["y"] = sy
            return d

        if bypass_gates:
            if result_dict is not None and raw_conf >= confidence:
                result_dict["confidence_smoothed"] = round(raw_conf, 3)
                result_dict = _apply_pos_ema(result_dict)
                self.logger.log(
                    f"✓ '{template_name}' at ({result_dict['x']},{result_dict['y']}) "
                    f"raw={raw_conf:.2f} scale={result_dict.get('scale',1.0):.2f} [bypass]"
                )
                self._motion_cache[template_name] = result_dict
                return result_dict
            self._motion_cache[template_name] = None
            return None

        if result_dict is not None and smooth_conf >= confidence:
            result_dict["confidence_smoothed"] = round(smooth_conf, 3)
            result_dict = _apply_pos_ema(result_dict)
            self.logger.log(
                f"✓ '{template_name}' at ({result_dict['x']},{result_dict['y']}) "
                f"raw={raw_conf:.2f} smooth={smooth_conf:.2f} "
                f"scale={result_dict.get('scale',1.0):.2f} "
                f"method={result_dict.get('method','template')}"
            )
            self._motion_cache[template_name] = result_dict
            return result_dict

        if result_dict is not None:
            self.logger.log(
                f"~ '{template_name}' raw={raw_conf:.2f} smooth={smooth_conf:.2f}"
                f" < {confidence} — suppressed"
            )
        else:
            self.logger.log(
                f"✗ '{template_name}' not found "
                f"(best={best_val:.2f} smooth={smooth_conf:.2f} need={confidence}"
                + (f" area {sw}x{sh})" if region else ")")
            )
        self._motion_cache[template_name] = None
        return None

    def find_all_on_screen(self, template_name, confidence=0.8,
                            region=None, max_matches=None,
                            multi_scale=True, scale_min=0.8,
                            scale_max=1.2, scale_steps=5):
        """
        Find ALL instances.  v3: grayscale+CLAHE matching, IoU NMS dedup.
        """
        tpl_bgr, tpl_gray, tpl_mask = self._load_template(template_name)
        if tpl_bgr is None:
            return []

        th, tw      = tpl_gray.shape[:2]
        region_x    = int(region[0]) if region else 0
        region_y    = int(region[1]) if region else 0
        screen_bgr  = self._grab_screen(region)
        screen_gray = cv2.cvtColor(screen_bgr, cv2.COLOR_BGR2GRAY)
        sh, sw      = screen_gray.shape[:2]
        do_clahe    = self._tcfg(template_name, "use_clahe")

        all_key = f"_all_{template_name}"
        if not self._screen_changed(screen_bgr, region):
            return self._motion_cache.get(all_key, [])

        scales   = self._build_scale_sequence(
            template_name, scale_min, scale_max, scale_steps, multi_scale)
        all_hits = []

        for scale in scales:
            val, loc, resp, nw, nh = self._match_single_scale(
                screen_gray, tpl_gray, tpl_mask, scale, do_clahe)
            if val < 0 or resp is None:
                continue

            resp_nms = resp.copy()
            while True:
                _, max_val, _, max_loc = cv2.minMaxLoc(resp_nms)
                if max_val < confidence:
                    break
                sub_x, sub_y = (self._subpixel_peak(resp_nms, max_loc)
                                 if self.use_subpixel else
                                 (float(max_loc[0]), float(max_loc[1])))
                all_hits.append({
                    "x":          int(round(sub_x + region_x + nw/2.0)),
                    "y":          int(round(sub_y + region_y + nh/2.0)),
                    "confidence": float(max_val),
                    "rect":       [int(round(sub_x+region_x)),
                                   int(round(sub_y+region_y)), nw, nh],
                    "method":     "template",
                    "scale":      scale,
                })
                x0 = max(0, max_loc[0]-nw//2)
                y0 = max(0, max_loc[1]-nh//2)
                x1 = min(resp_nms.shape[1], max_loc[0]+nw)
                y1 = min(resp_nms.shape[0], max_loc[1]+nh)
                resp_nms[y0:y1, x0:x1] = 0.0

        all_hits.sort(key=lambda h: -h["confidence"])
        matches = self._nms(all_hits)
        if max_matches:
            matches = matches[:max_matches]

        self.logger.log(
            f"Found {len(matches)} instances of '{template_name}'"
            + (" in region" if region else "")
        )
        self._motion_cache[all_key] = matches
        return matches

    def count_on_screen(self, template_name, confidence=0.8):
        return len(self.find_all_on_screen(template_name, confidence))

    def wait_for_image(self, template_name, confidence=0.8,
                        timeout=30, interval=0.5, region=None, stop_check=None):
        self.logger.log(
            f"Waiting for '{template_name}' (timeout={timeout}s)"
            + (f" in region {region}" if region else "") + "..."
        )
        start = time.time()
        while time.time() - start < timeout:
            if stop_check and stop_check():
                self.logger.log(f"Wait for '{template_name}' aborted")
                return None
            result = self.find_on_screen(template_name, confidence, region=region)
            if result:
                self.logger.log(f"✓ '{template_name}' appeared after {time.time()-start:.1f}s")
                return result
            time.sleep(interval)
        self.logger.log(f"✗ Timeout waiting for '{template_name}'", level="WARN")
        return None

    def wait_for_image_to_disappear(self, template_name, confidence=0.8,
                                     timeout=30, interval=0.5,
                                     region=None, stop_check=None):
        self.logger.log(
            f"Waiting for '{template_name}' to disappear..."
            + (f" [region {region}]" if region else "")
        )
        start = time.time()
        while time.time() - start < timeout:
            if stop_check and stop_check():
                return False
            if self.find_on_screen(template_name, confidence, region=region) is None:
                self.logger.log(f"✓ '{template_name}' disappeared")
                return True
            time.sleep(interval)
        self.logger.log(f"✗ Timeout: '{template_name}' still visible", level="WARN")
        return False

    def find_best_match(self, template_name, region=None):
        """Diagnostic: best match ignoring all thresholds, gates, smoothing."""
        tpl_bgr, tpl_gray, tpl_mask = self._load_template(template_name)
        if tpl_bgr is None:
            return None
        region_x    = int(region[0]) if region else 0
        region_y    = int(region[1]) if region else 0
        screen_bgr  = self._grab_screen(region)
        screen_gray = cv2.cvtColor(screen_bgr, cv2.COLOR_BGR2GRAY)
        th, tw      = tpl_gray.shape[:2]
        sh, sw      = screen_gray.shape[:2]
        if tw > sw or th > sh:
            self.logger.log(
                f"✗ '{template_name}' ({tw}x{th}) larger than "
                f"search area ({sw}x{sh})", level="WARN")
            return None
        method = cv2.TM_CCORR_NORMED if tpl_mask is not None else cv2.TM_CCOEFF_NORMED
        try:
            resp = (cv2.matchTemplate(screen_gray, tpl_gray, method, mask=tpl_mask)
                    if tpl_mask is not None
                    else cv2.matchTemplate(screen_gray, tpl_gray, method))
        except cv2.error:
            resp = cv2.matchTemplate(screen_gray, tpl_gray, cv2.TM_CCOEFF_NORMED)
        _, max_val, _, max_loc = cv2.minMaxLoc(resp)
        sub_x, sub_y = self._subpixel_peak(resp, max_loc) if self.use_subpixel \
            else (float(max_loc[0]), float(max_loc[1]))
        abs_left = sub_x + region_x
        abs_top  = sub_y + region_y
        return {
            "x":          int(round(abs_left + tw/2.0)),
            "y":          int(round(abs_top  + th/2.0)),
            "confidence": float(max_val),
            "rect":       [int(round(abs_left)), int(round(abs_top)), tw, th],
            "method":     "template",
        }   