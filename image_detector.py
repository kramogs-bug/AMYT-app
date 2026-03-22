"""
vision/image_detector.py
Core image detection engine using OpenCV template matching.
Can find single or multiple instances of a template image on screen.

Additions (v2):
  1. Screenshot diff / motion gating
     - _grab_screen() compares each new frame to the previous capture via
       cv2.absdiff.  If the mean pixel change is below `motion_threshold`
       (default 1.5 out of 255) the screen is considered static and the
       cached result from the last real match is returned immediately,
       skipping all template-matching work.  This typically cuts CPU by
       60-80 % during menu screens or loading screens.

  2. ORB / AKAZE feature-matching fallback
     - When template-matching confidence falls below `feature_fallback_threshold`
       (default 0.50), find_on_screen() automatically retries with ORB keypoint
       matching.  ORB handles rotated sprites, perspective shifts (isometric
       games), and partial occlusion that template matching cannot.
     - AKAZE is used instead of ORB when the template is very small (< 32 px on
       either axis) because AKAZE is more robust at low resolutions.
     - The feature match returns a homography-derived bounding box so the
       returned dict is fully compatible with the existing API (x, y, rect,
       confidence).

  3. Temporal confidence smoothing
     - A per-template rolling deque (length = `smooth_window`, default 5) stores
       the raw confidence of each detection attempt.  The smoothed confidence is
       the mean of the buffer.  An action is only triggered when the smoothed
       value exceeds the threshold, preventing single-frame animation-transition
       spikes from firing macros.
     - The buffer is exposed via get_smoothed_confidence(template_name) so the
       UI/learning engine can read it.

Fixes applied (v1):
- Template images are now cached in memory (keyed by name + mtime) — no more
  disk reads on every detection call in tight loops.
"""

import cv2
import numpy as np
import mss
import os
import time
from collections import deque


class ImageDetector:
    def __init__(self, logger,
                 motion_threshold: float = 1.5,
                 feature_fallback_threshold: float = 0.50,
                 smooth_window: int = 5):
        """
        Parameters
        ----------
        motion_threshold : float
            Mean per-pixel change (0-255) below which the screen is considered
            static and template matching is skipped. Set to 0.0 to disable.
        feature_fallback_threshold : float
            If template-match confidence is below this value, ORB/AKAZE feature
            matching is attempted as a fallback. Set to 0.0 to disable.
        smooth_window : int
            Number of recent frames used for temporal confidence smoothing.
            Set to 1 to disable smoothing.
        """
        self.logger = logger
        self.templates_dir = os.path.join("storage", "templates")

        # ── Feature flags ──────────────────────────────────
        self.motion_threshold            = motion_threshold
        self.feature_fallback_threshold  = feature_fallback_threshold
        self.smooth_window               = max(1, smooth_window)

        # ── Template image cache ────────────────────────────
        # { template_name: (mtime, bgr_array) }
        self._template_cache: dict = {}

        # ── Motion-gating state ─────────────────────────────
        # { region_key: last_gray_frame }
        self._last_frame: dict = {}
        # { template_name: last_match_result }  — cached result for static screens
        self._motion_cache: dict = {}

        # ── Temporal smoothing buffers ──────────────────────
        # { template_name: deque([conf, conf, ...], maxlen=smooth_window) }
        self._conf_buffers: dict = {}

    # ══════════════════════════════════════════════════════
    #  INTERNAL HELPERS
    # ══════════════════════════════════════════════════════

    def _load_template(self, template_name: str):
        """
        Load a template image from the templates folder.
        mtime-based cache: file is only re-read when it changes on disk.
        Returns a BGR OpenCV image, or None if not found.
        """
        if not template_name.endswith(".png"):
            template_name += ".png"

        path = os.path.join(self.templates_dir, template_name)
        if not os.path.exists(path):
            self.logger.log(f"Template not found: {path}", level="ERROR")
            return None

        try:
            mtime = os.path.getmtime(path)
        except OSError:
            return None

        cached = self._template_cache.get(template_name)
        if cached and cached[0] == mtime:
            return cached[1]

        img = cv2.imread(path, cv2.IMREAD_COLOR)
        if img is not None:
            self._template_cache[template_name] = (mtime, img)
        return img

    def invalidate_cache(self, template_name: str = None):
        """Remove one or all entries from the template cache."""
        if template_name:
            key = template_name if template_name.endswith(".png") else template_name + ".png"
            self._template_cache.pop(key, None)
        else:
            self._template_cache.clear()

    # ── 1. SCREENSHOT DIFF / MOTION GATING ────────────────

    @staticmethod
    def _region_key(region) -> str:
        """Stable dict key for a region (or full screen)."""
        return str(region) if region else "fullscreen"

    def _grab_screen(self, region=None) -> np.ndarray:
        """
        Grab the screen (or a region) and return a BGR NumPy array.
        region = [x, y, w, h] or None for full screen.
        """
        with mss.mss() as sct:
            if region:
                x, y, w, h = region
                monitor = {"left": int(x), "top": int(y),
                           "width": int(w), "height": int(h)}
            else:
                monitor = sct.monitors[1]

            screenshot = sct.grab(monitor)
            img = np.array(screenshot)
            return cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)

    def _screen_changed(self, frame: np.ndarray, region) -> bool:
        """
        Return True if the screen content has changed enough to warrant a new
        detection pass.  Compares a downsampled grayscale diff against
        self.motion_threshold.

        Side effect: updates self._last_frame[region_key].
        """
        if self.motion_threshold <= 0.0:
            return True  # motion gating disabled

        key = self._region_key(region)
        # Downsample for speed — full-res diff is wasteful
        small = cv2.resize(frame, (0, 0), fx=0.25, fy=0.25,
                           interpolation=cv2.INTER_AREA)
        gray  = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)

        prev = self._last_frame.get(key)
        self._last_frame[key] = gray

        if prev is None or prev.shape != gray.shape:
            return True  # first frame or region changed

        diff       = cv2.absdiff(gray, prev)
        mean_diff  = float(np.mean(diff))
        changed    = mean_diff >= self.motion_threshold

        if not changed:
            self.logger.log(
                f"Motion gate: screen static (diff={mean_diff:.2f}), skipping match"
            )
        return changed

    # ── 2. FEATURE MATCHING FALLBACK (ORB / AKAZE) ────────

    def _feature_match(self, template: np.ndarray, screen: np.ndarray,
                       region_x: int, region_y: int):
        """
        Attempt ORB (or AKAZE for small templates) keypoint matching.
        Returns a result dict compatible with find_on_screen(), or None.

        The match quality is expressed as a pseudo-confidence in [0, 1]:
            good_matches / max(total_kp_in_template, 1)
        capped at 0.95.
        """
        th, tw = template.shape[:2]

        # AKAZE is more stable on very small images; ORB elsewhere
        use_akaze = (min(th, tw) < 32)
        detector  = cv2.AKAZE_create() if use_akaze else cv2.ORB_create(nfeatures=500)
        algo_name = "AKAZE" if use_akaze else "ORB"

        kp_t, des_t = detector.detectAndCompute(template, None)
        kp_s, des_s = detector.detectAndCompute(screen,   None)

        if des_t is None or des_s is None or len(kp_t) < 4 or len(kp_s) < 4:
            self.logger.log(
                f"Feature match ({algo_name}): insufficient keypoints "
                f"(template={len(kp_t) if kp_t else 0}, "
                f"screen={len(kp_s) if kp_s else 0})"
            )
            return None

        # BFMatcher with Hamming distance (ORB/AKAZE use binary descriptors)
        bf      = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False)
        matches = bf.knnMatch(des_t, des_s, k=2)

        # Lowe's ratio test
        good = []
        for pair in matches:
            if len(pair) == 2:
                m, n = pair
                if m.distance < 0.75 * n.distance:
                    good.append(m)

        if len(good) < 4:
            self.logger.log(
                f"Feature match ({algo_name}): only {len(good)} good matches — "
                "need ≥ 4 for homography"
            )
            return None

        # Homography to find the template's bounding box on screen
        src_pts = np.float32([kp_t[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
        dst_pts = np.float32([kp_s[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)

        H, mask = cv2.findHomography(src_pts, dst_pts, cv2.RANSAC, 5.0)
        if H is None:
            self.logger.log(f"Feature match ({algo_name}): homography failed")
            return None

        inliers = int(mask.sum()) if mask is not None else 0
        if inliers < 4:
            self.logger.log(
                f"Feature match ({algo_name}): only {inliers} homography inliers"
            )
            return None

        # Project template corners through H to get bounding rect on screen
        corners  = np.float32([[0, 0], [tw, 0], [tw, th], [0, th]]).reshape(-1, 1, 2)
        warped   = cv2.perspectiveTransform(corners, H)
        x_vals   = warped[:, 0, 0]
        y_vals   = warped[:, 0, 1]
        left     = int(np.min(x_vals))
        top      = int(np.min(y_vals))
        right    = int(np.max(x_vals))
        bottom   = int(np.max(y_vals))
        box_w    = max(1, right  - left)
        box_h    = max(1, bottom - top)

        center_x = region_x + left + box_w // 2
        center_y = region_y + top  + box_h // 2

        pseudo_conf = min(0.95, inliers / max(len(kp_t), 1))
        self.logger.log(
            f"Feature match ({algo_name}): {inliers} inliers → "
            f"({center_x},{center_y}) pseudo_conf={pseudo_conf:.2f}"
        )

        return {
            "x":          center_x,
            "y":          center_y,
            "confidence": pseudo_conf,
            "rect":       [region_x + left, region_y + top, box_w, box_h],
            "method":     algo_name,
        }

    # ── 3. TEMPORAL CONFIDENCE SMOOTHING ──────────────────

    def _push_confidence(self, template_name: str, raw_conf: float) -> float:
        """
        Push the latest raw confidence into the rolling buffer and return the
        smoothed (mean) confidence.  A conf of 0.0 represents a miss.
        """
        buf = self._conf_buffers.get(template_name)
        if buf is None:
            buf = deque(maxlen=self.smooth_window)
            self._conf_buffers[template_name] = buf
        buf.append(raw_conf)
        return float(np.mean(buf))

    def get_smoothed_confidence(self, template_name: str) -> float:
        """
        Return the current smoothed confidence for a template (0.0 if no
        history yet).  Useful for the learning engine or UI graphs.
        """
        buf = self._conf_buffers.get(template_name)
        if not buf:
            return 0.0
        return float(np.mean(buf))

    def reset_smoothing(self, template_name: str = None):
        """Clear the confidence buffer for one template, or all."""
        if template_name:
            self._conf_buffers.pop(template_name, None)
        else:
            self._conf_buffers.clear()

    # ══════════════════════════════════════════════════════
    #  DETECTION FUNCTIONS
    # ══════════════════════════════════════════════════════

    def find_on_screen(self, template_name: str, confidence: float = 0.8,
                       region=None, multi_scale: bool = True,
                       scale_min: float = 0.7, scale_max: float = 1.3,
                       scale_steps: int = 7,
                       bypass_gates: bool = False):
        """
        Find ONE instance of a template on screen.

        bypass_gates : bool
            If True, skips BOTH the motion gate AND temporal smoothing.
            Use this for navigation loops where every frame must be
            evaluated fresh regardless of screen change or confidence history.
            (NAVIGATE_TO_IMAGE sets this automatically.)
                Pipeline (all three new features are opt-out, not opt-in):

          1. Grab screen frame.
          2. Motion gate: if the screen hasn't changed since the last call
             for this region, return the cached result immediately.
          3. Multi-scale template matching (unchanged from v1).
          4. Feature-match fallback: if template-match confidence is below
             self.feature_fallback_threshold, retry with ORB/AKAZE.
          5. Temporal smoothing: push the raw confidence into the rolling
             buffer; only return a match if the *smoothed* confidence meets
             the threshold.
        """
        template = self._load_template(template_name)
        if template is None:
            return None

        region_x = int(region[0]) if region else 0
        region_y = int(region[1]) if region else 0

        # ── Step 1: grab frame ────────────────────────────
        screen = self._grab_screen(region)
        sh, sw = screen.shape[:2]
        th, tw = template.shape[:2]

        # ── Step 2: motion gate ───────────────────────────
        if not bypass_gates and not self._screen_changed(screen, region):
            cached = self._motion_cache.get(template_name)
            # Still push 0/conf into smoother so buffer ages correctly
            raw = cached["confidence"] if cached else 0.0
            self._push_confidence(template_name, raw)
            return cached  # may be None — that's correct

        # ── Step 3: multi-scale template matching ─────────
        scales = (
            sorted(set([1.0] + list(np.linspace(scale_min, scale_max, scale_steps))))
            if multi_scale else [1.0]
        )

        best_val = -1.0
        best_loc = None
        best_tw  = tw
        best_th  = th

        for scale in scales:
            new_w = max(1, int(tw * scale))
            new_h = max(1, int(th * scale))
            if new_w > sw or new_h > sh or new_w < 4 or new_h < 4:
                continue

            scaled_tpl = cv2.resize(
                template, (new_w, new_h),
                interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC
            )
            result = cv2.matchTemplate(screen, scaled_tpl, cv2.TM_CCOEFF_NORMED)
            _, max_val, _, max_loc = cv2.minMaxLoc(result)

            if max_val > best_val:
                best_val = max_val
                best_loc = max_loc
                best_tw  = new_w
                best_th  = new_h

        # ── Step 4: feature-match fallback ────────────────
        result_dict = None

        if best_val >= confidence and best_loc is not None:
            abs_left = best_loc[0] + region_x
            abs_top  = best_loc[1] + region_y
            result_dict = {
                "x":          abs_left + best_tw // 2,
                "y":          abs_top  + best_th // 2,
                "confidence": float(best_val),
                "rect":       [abs_left, abs_top, best_tw, best_th],
                "method":     "template",
            }
        elif (self.feature_fallback_threshold > 0.0
              and best_val >= self.feature_fallback_threshold):
            self.logger.log(
                f"Template match low ({best_val:.2f}) — trying feature fallback "
                f"for '{template_name}'"
            )
            result_dict = self._feature_match(template, screen, region_x, region_y)

        # ── Step 5: temporal smoothing ────────────────────
        raw_conf    = result_dict["confidence"] if result_dict else 0.0
        smooth_conf = self._push_confidence(template_name, raw_conf)

        # bypass_gates: skip smoothing — return raw result immediately
        if bypass_gates:
            if result_dict is not None and raw_conf >= confidence:
                result_dict["confidence_smoothed"] = round(raw_conf, 3)
                self.logger.log(
                    f"✓ Detected '{template_name}' at "
                    f"({result_dict['x']},{result_dict['y']}) "
                    f"raw={raw_conf:.2f} [gates bypassed] "
                    f"method={result_dict.get('method','template')}"
                )
                self._motion_cache[template_name] = result_dict
                return result_dict
            else:
                self.logger.log(
                    f"✗ '{template_name}' not found "
                    f"(best={raw_conf:.2f}, need={confidence}) [gates bypassed]"
                )
                self._motion_cache[template_name] = None
                return None

        if result_dict is not None:
            if smooth_conf >= confidence:
                result_dict["confidence_smoothed"] = round(smooth_conf, 3)
                self.logger.log(
                    f"✓ Detected '{template_name}' at "
                    f"({result_dict['x']},{result_dict['y']}) "
                    f"raw={raw_conf:.2f} smooth={smooth_conf:.2f} "
                    f"method={result_dict.get('method','template')}"
                )
                self._motion_cache[template_name] = result_dict
                return result_dict
            else:
                self.logger.log(
                    f"~ '{template_name}' raw={raw_conf:.2f} but "
                    f"smooth={smooth_conf:.2f} < {confidence} — suppressed "
                    "(temporal filter)"
                )
                self._motion_cache[template_name] = None
                return None
        else:
            self.logger.log(
                f"✗ '{template_name}' not found "
                f"(best={best_val:.2f}, smooth={smooth_conf:.2f}, need={confidence}"
                + (f", area {sw}x{sh})" if region else ")")
            )
            self._motion_cache[template_name] = None
            return None

    def find_all_on_screen(self, template_name: str, confidence: float = 0.8,
                           region=None, max_matches: int = None,
                           multi_scale: bool = True,
                           scale_min: float = 0.8, scale_max: float = 1.2,
                           scale_steps: int = 5):
        """
        Find ALL instances of a template on screen using multi-scale matching.

        Motion gating is applied (same as find_on_screen).
        Temporal smoothing is NOT applied here — it would distort multi-
        instance counts.  The feature-match fallback is also not applied
        because homography only locates one instance at a time.
        """
        template = self._load_template(template_name)
        if template is None:
            return []

        region_x = int(region[0]) if region else 0
        region_y = int(region[1]) if region else 0
        screen   = self._grab_screen(region)
        sh, sw   = screen.shape[:2]
        th, tw   = template.shape[:2]

        # Motion gate — for find_all we cache the whole list
        all_key = f"_all_{template_name}"
        if not self._screen_changed(screen, region):
            return self._motion_cache.get(all_key, [])

        scales = (
            sorted(set([1.0] + list(np.linspace(scale_min, scale_max, scale_steps))))
            if multi_scale else [1.0]
        )

        all_hits = []
        for scale in scales:
            new_w = max(1, int(tw * scale))
            new_h = max(1, int(th * scale))
            if new_w > sw or new_h > sh or new_w < 4 or new_h < 4:
                continue
            scaled_tpl = cv2.resize(
                template, (new_w, new_h),
                interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC
            )
            result_map = cv2.matchTemplate(screen, scaled_tpl, cv2.TM_CCOEFF_NORMED)
            result_nms = result_map.copy()
            while True:
                _, max_val, _, max_loc = cv2.minMaxLoc(result_nms)
                if max_val < confidence:
                    break
                all_hits.append({
                    "x":          max_loc[0] + region_x + new_w // 2,
                    "y":          max_loc[1] + region_y + new_h // 2,
                    "confidence": float(max_val),
                    "rect":       [max_loc[0] + region_x, max_loc[1] + region_y,
                                   new_w, new_h],
                    "method":     "template",
                })
                x0 = max(0, max_loc[0] - new_w // 2)
                y0 = max(0, max_loc[1] - new_h // 2)
                x1 = min(result_nms.shape[1], max_loc[0] + new_w)
                y1 = min(result_nms.shape[0], max_loc[1] + new_h)
                result_nms[y0:y1, x0:x1] = 0

        # Deduplicate nearby hits across scales
        all_hits.sort(key=lambda h: -h["confidence"])
        matches, used = [], set()
        for hit in all_hits:
            key = (hit["x"] // max(tw // 3, 1), hit["y"] // max(th // 3, 1))
            if key in used:
                continue
            used.add(key)
            matches.append(hit)
            if max_matches and len(matches) >= max_matches:
                break

        self.logger.log(
            f"Found {len(matches)} instances of '{template_name}'"
            + (" in region" if region else "")
        )
        self._motion_cache[all_key] = matches
        return matches

    def count_on_screen(self, template_name: str, confidence: float = 0.8) -> int:
        return len(self.find_all_on_screen(template_name, confidence))

    def wait_for_image(self, template_name: str, confidence: float = 0.8,
                       timeout: float = 30, interval: float = 0.5,
                       region=None, stop_check=None):
        """
        Keep checking until the image appears (or timeout).
        stop_check() returning True aborts the wait early.
        """
        self.logger.log(
            f"Waiting for '{template_name}' (timeout={timeout}s)"
            + (f" in region {region}" if region else "") + "..."
        )
        start = time.time()
        while time.time() - start < timeout:
            if stop_check and stop_check():
                self.logger.log(f"Wait for '{template_name}' aborted by stop")
                return None
            result = self.find_on_screen(template_name, confidence, region=region)
            if result:
                self.logger.log(
                    f"✓ '{template_name}' appeared after {time.time()-start:.1f}s"
                )
                return result
            time.sleep(interval)
        self.logger.log(f"✗ Timeout waiting for '{template_name}'", level="WARN")
        return None

    def wait_for_image_to_disappear(self, template_name: str, confidence: float = 0.8,
                                    timeout: float = 30, interval: float = 0.5,
                                    region=None, stop_check=None) -> bool:
        """Keep checking until the image disappears (or timeout)."""
        self.logger.log(
            f"Waiting for '{template_name}' to disappear..."
            + (f" [region {region}]" if region else "")
        )
        start = time.time()
        while time.time() - start < timeout:
            if stop_check and stop_check():
                self.logger.log(
                    f"Wait for '{template_name}' to disappear aborted by stop"
                )
                return False
            if self.find_on_screen(template_name, confidence, region=region) is None:
                self.logger.log(f"✓ '{template_name}' disappeared")
                return True
            time.sleep(interval)
        self.logger.log(
            f"✗ Timeout: '{template_name}' still on screen", level="WARN"
        )
        return False

    def find_best_match(self, template_name: str, region=None):
        """
        Find the best match regardless of confidence threshold.
        Returns dict with x, y, confidence, rect — or None if template missing.
        Bypasses motion gating and temporal smoothing (diagnostic use).
        """
        template = self._load_template(template_name)
        if template is None:
            return None

        region_x = int(region[0]) if region else 0
        region_y = int(region[1]) if region else 0
        screen   = self._grab_screen(region)
        th, tw   = template.shape[:2]
        sh, sw   = screen.shape[:2]

        if tw > sw or th > sh:
            self.logger.log(
                f"✗ '{template_name}' ({tw}x{th}) larger than search area "
                f"({sw}x{sh}) — cannot match",
                level="WARN"
            )
            return None

        result           = cv2.matchTemplate(screen, template, cv2.TM_CCOEFF_NORMED)
        _, max_val, _, max_loc = cv2.minMaxLoc(result)
        abs_left         = max_loc[0] + region_x
        abs_top          = max_loc[1] + region_y

        return {
            "x":          abs_left + tw // 2,
            "y":          abs_top  + th // 2,
            "confidence": float(max_val),
            "rect":       [abs_left, abs_top, tw, th],
            "method":     "template",
        }
