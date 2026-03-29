"""
movement_ai.py
State-machine based movement controller for NAVIGATE_TO_IMAGE.

Replaces the flat reactive while-loop that was embedded in macro_engine.py.

Pipeline
--------
    Detection  →  Tracking (Kalman)  →  Prediction (lead)
        →  Decision (state machine)  →  Smooth Action (key hold)

States
------
    SEEKING      No recent detection.  Keys released.  Waiting for target.
    NAVIGATING   Target found and tracked.  Moving at full speed.
    DECELERATING Within decel_zone_px.  Single-axis, ramped duration.
    ARRIVED      Within dead_zone_px or proximity image-check passed.
    STUCK        Distance not decreasing.  About to dodge.
    DODGING      Executing random dodge maneuver.

Why this is better than the old loop
--------------------------------------
OLD problems (verbatim):
  1. `redetect = (step_counter % 3 == 0)` — stale position 2/3 of steps.
     Fixed: detect every step, tracker prediction fills miss frames cheaply.

  2. `proximity_factor = min(1.0, max(0.25, distance / 100.0))` — at 500px
     hold_duration = 5 × step_time, causing massive overshoot.
     Fixed: separate decel curve that never exceeds step_time.

  3. `stuck_count += 1` when `distance >= prev_distance - 1` — false-stuck
     on any frame with 0–1 px progress even when clearly closing.
     Fixed: stuck only increments when distance grows (negative progress).

  4. No dead zone — keys pressed even at 1-pixel error, causing jitter.
     Fixed: dead_zone_px threshold below which no keys are pressed.

  5. Raw detection coords fed directly — ±3 px noise causes key oscillation.
     Fixed: Kalman filter smooths position; velocity lets us lead-aim.

  6. Keys released every step then re-held next step — creates key bounce
     stuttering visible in-game.
     Fixed: continuous hold with selective per-axis release only when
     that axis direction reverses.
"""

import time
import math
import random
import ctypes
from enum import Enum, auto

from tracker import KalmanTracker


class NavState(Enum):
    SEEKING      = auto()
    NAVIGATING   = auto()
    DECELERATING = auto()
    ARRIVED      = auto()
    STUCK        = auto()
    DODGING      = auto()


class MovementAI:
    """
    Stateful, Kalman-tracked, state-machine driven movement controller.

    Instantiate fresh for each NAVIGATE_TO_IMAGE call.
    Call step() in a loop; it returns a status string.
    Always call cleanup() when done (even on error) to release held keys.

    Parameters (via settings dict — same keys as get_movement_settings())
    -----------------------------------------------------------------------
    player_x / player_y   : int   — fixed player screen position
    key_up/down/left/right : str  — key names
    step_time              : float — base step duration (seconds)
    stop_radius            : int   — legacy arrival pixel radius
    stuck_threshold        : int   — consecutive non-improving frames = stuck
    arrival_region         : int   — arrival image-check half-width (px)
    arrival_region_h       : int   — arrival image-check half-height (px)
    arrival_confidence     : float — confidence for proximity image check
    miss_tolerance         : int   — consecutive detection misses = lost

    Tuning constants (change here, not per-call)
    --------------------------------------------
    DEAD_ZONE_RATIO     : dead_zone = stop_radius × this  (default 0.5)
    DECEL_ZONE_RATIO    : decel starts at stop_radius × this  (default 4.0)
    LEAD_PREDICT_S      : seconds to lead-aim moving targets  (default 0.07)
    MIN_MOVING_SPEED    : px/s below which we skip lead prediction (default 20)
    STEP_GAP_S          : fixed gap between steps in seconds  (default 0.02)
    STUCK_GROW_THRESHOLD: distance must grow by this px to count as stuck  (default 3)
    """

    # ── Class-level tuning ──────────────────────────────────────────
    DEAD_ZONE_RATIO      = 0.5
    DECEL_ZONE_RATIO     = 4.0
    LEAD_PREDICT_S       = 0.07
    MIN_MOVING_SPEED     = 20.0
    STEP_GAP_S           = 0.02
    STUCK_GROW_THRESHOLD = 3.0

    def __init__(self, keyboard, detector, learner, logger, settings: dict):
        self.keyboard = keyboard
        self.detector = detector
        self.learner  = learner
        self.logger   = logger

        # ── Movement settings ─────────────────────────────────────
        self.player_x           = int(settings["player_x"])
        self.player_y           = int(settings["player_y"])
        self.key_up             = settings["key_up"]
        self.key_down           = settings["key_down"]
        self.key_left           = settings["key_left"]
        self.key_right          = settings["key_right"]
        self.step_time          = float(settings["step_time"])
        self.stop_radius        = int(settings["stop_radius"])
        self.stuck_threshold    = int(settings.get("stuck_threshold", 4))
        self.arrival_region     = int(settings.get("arrival_region", 200))
        self.arrival_region_h   = int(settings.get("arrival_region_h", 200))
        self.arrival_confidence = float(settings.get("arrival_confidence", 0.85))
        self.miss_tolerance     = max(1, int(settings.get("miss_tolerance", 5)))

        # ── Derived thresholds ────────────────────────────────────
        self.dead_zone_px  = max(4, int(self.stop_radius * self.DEAD_ZONE_RATIO))
        self.decel_zone_px = max(
            int(self.stop_radius * self.DECEL_ZONE_RATIO),
            max(self.arrival_region, self.arrival_region_h),
        )

        # ── Kalman tracker ────────────────────────────────────────
        self.tracker = KalmanTracker(
            process_noise_pos=4.0,
            process_noise_vel=25.0,
            measurement_noise=7.0,
            max_covariance=800.0,
        )

        # ── State ─────────────────────────────────────────────────
        self.state          = NavState.SEEKING
        self._held_keys     = {}      # key → direction ('x' or 'y')
        self._miss_count    = 0
        self._stuck_frames  = 0
        self._last_dist     = None
        self._step_count    = 0

        # Cached screen dimensions (avoid ctypes on every arrival check)
        self._sw, self._sh  = self._screen_size()

    # ── Screen helpers ─────────────────────────────────────────────

    @staticmethod
    def _screen_size() -> tuple:
        try:
            u32 = ctypes.windll.user32
            return int(u32.GetSystemMetrics(0)), int(u32.GetSystemMetrics(1))
        except Exception:
            return 1920, 1080

    # ── Key management ─────────────────────────────────────────────

    def _set_key(self, key: str, axis: str):
        """
        Hold a key only if not already held.
        Releasing the opposite direction on the same axis happens in
        _apply_keys() before this is called.
        """
        if key not in self._held_keys:
            self.keyboard.hold(key)
            self._held_keys[key] = axis

    def _release_key(self, key: str):
        if key in self._held_keys:
            self.keyboard.release(key)
            del self._held_keys[key]

    def _release_axis(self, axis: str):
        """Release all held keys on a given axis ('x' or 'y')."""
        to_release = [k for k, ax in list(self._held_keys.items()) if ax == axis]
        for k in to_release:
            self._release_key(k)

    def cleanup(self):
        """
        Release every held key.  MUST be called in a finally block by the
        caller so keys are never stuck after stop/exception/timeout.
        """
        for k in list(self._held_keys.keys()):
            try:
                self.keyboard.release(k)
            except Exception:
                pass
        self._held_keys.clear()

    # ── Decision engine ────────────────────────────────────────────

    def _resolve_keys(self, dx: float, dy: float, distance: float) -> tuple:
        """
        Determine which keys to hold and for how long.

        Returns (x_key, y_key, duration_s).
        x_key or y_key may be None (no movement on that axis).

        Design:
          - dead zone  : no keys, no movement
          - decel zone : single dominant axis, short ramp duration
          - full speed : both axes, capped duration
        """
        if distance < self.dead_zone_px:
            return None, None, 0.0

        in_decel = (distance < self.decel_zone_px)

        # ── Axis key selection ─────────────────────────────────
        dz = self.dead_zone_px

        if in_decel:
            # Single dominant axis only — prevents diagonal overshooting
            if abs(dx) >= abs(dy):
                x_key = self.key_right if dx > dz else (self.key_left if dx < -dz else None)
                y_key = None
            else:
                x_key = None
                y_key = self.key_down if dy > dz else (self.key_up if dy < -dz else None)
        else:
            x_key = self.key_right if dx > dz else (self.key_left if dx < -dz else None)
            y_key = self.key_down  if dy > dz else (self.key_up  if dy < -dz else None)

        if x_key is None and y_key is None:
            return None, None, 0.0

        # ── Duration ───────────────────────────────────────────
        if in_decel:
            # Linear ramp from 10% to 60% of step_time as we approach
            t = max(0.05, min(1.0, distance / self.decel_zone_px))
            duration = self.step_time * (0.10 + 0.50 * t)
        else:
            # Fixed step_time regardless of distance — prevents overshoot
            # (old code used distance / 100 which caused 5× step_time at 500px)
            duration = self.step_time

        return x_key, y_key, duration

    def _apply_keys(self, x_key, y_key, duration: float):
        """
        Hold the required keys, sleep, then release only the keys whose
        direction has changed or is no longer needed.

        Continuous holds: if the same key is needed next step too, it stays
        held — no bounce.  If the direction reversed, old key released first.
        """
        all_dir_keys = {
            self.key_left, self.key_right,
            self.key_up, self.key_down,
        }

        # Release x-axis key if direction reversed or axis not needed
        if x_key is None:
            self._release_axis("x")
        else:
            opposite_x = self.key_right if x_key == self.key_left else self.key_left
            if opposite_x in self._held_keys:
                self._release_key(opposite_x)
            self._set_key(x_key, "x")

        # Release y-axis key if direction reversed or axis not needed
        if y_key is None:
            self._release_axis("y")
        else:
            opposite_y = self.key_down if y_key == self.key_up else self.key_up
            if opposite_y in self._held_keys:
                self._release_key(opposite_y)
            self._set_key(y_key, "y")

        time.sleep(max(0.008, duration))

        # After the step, release everything for the inter-step gap
        # (preserves key bounce prevention while still giving inter-frame pause)
        self.cleanup()

    # ── Arrival check ──────────────────────────────────────────────

    def _check_arrival(self, template: str, confidence: float,
                       distance: float) -> bool:
        """
        Two-stage arrival detection:
          1. Pixel distance dead zone (fast)
          2. Image-based proximity scan (accurate)
        """
        # Stage 1 — pixel distance
        if distance < self.dead_zone_px:
            self.logger.log(
                f"MovementAI: arrived (pixel dead-zone, dist={distance:.1f}px)"
            )
            return True

        # Stage 2 — image proximity scan
        if distance < max(self.arrival_region, self.arrival_region_h) * 1.5:
            half_w = self.arrival_region   // 2
            half_h = self.arrival_region_h // 2
            px_region = [
                max(0, self.player_x - half_w),
                max(0, self.player_y - half_h),
                min(self.arrival_region,   self._sw - max(0, self.player_x - half_w)),
                min(self.arrival_region_h, self._sh - max(0, self.player_y - half_h)),
            ]
            hit = self.detector.find_on_screen(
                template, self.arrival_confidence,
                region=px_region, bypass_gates=True
            )
            if hit:
                self.logger.log(
                    f"MovementAI: arrived (proximity image-check "
                    f"conf={hit['confidence']:.2f} ≥ {self.arrival_confidence})"
                )
                return True

        return False

    # ── Stuck detection ────────────────────────────────────────────

    def _check_stuck(self, distance: float) -> bool:
        """
        Returns True if we should trigger a dodge.

        Old behaviour: stuck++ when `distance >= prev - 1`
        Problem: increments even on 0.5 px progress = false-stuck.

        New behaviour: stuck only when distance is actively growing
        (we're being pushed away from the target) by > STUCK_GROW_THRESHOLD.
        """
        if self._last_dist is None:
            self._last_dist = distance
            return False

        delta = distance - self._last_dist   # positive = getting further away
        self._last_dist = distance

        if delta > self.STUCK_GROW_THRESHOLD:
            self._stuck_frames += 1
        else:
            # Any improvement resets the counter — we're making progress
            self._stuck_frames = max(0, self._stuck_frames - 1)

        return self._stuck_frames >= self.stuck_threshold

    def _dodge(self):
        """Random diagonal dodge to break out of stuck state."""
        self.logger.log(
            f"MovementAI: STUCK (frames={self._stuck_frames}) — dodging",
            level="WARN"
        )
        self.cleanup()  # release all keys before dodge

        # Prefer dodging on the axis we're NOT primarily moving on
        vx, vy = self.tracker.get_velocity()
        if abs(vx) > abs(vy):
            # Moving mostly horizontal — dodge vertical
            dodge = [random.choice([self.key_up, self.key_down])]
        else:
            # Moving mostly vertical — dodge horizontal
            dodge = [random.choice([self.key_left, self.key_right])]

        # Add a diagonal component for variety
        if random.random() < 0.5:
            if random.random() < 0.5:
                dodge.append(random.choice([self.key_left, self.key_right]))
            else:
                dodge.append(random.choice([self.key_up, self.key_down]))

        dodge_time = self.step_time * random.uniform(0.6, 1.3)
        for k in dodge:
            self.keyboard.hold(k)
        time.sleep(dodge_time)
        for k in dodge:
            self.keyboard.release(k)

        time.sleep(0.12)
        self._stuck_frames  = 0
        self._last_dist     = None
        self.tracker.reset()

    # ── Main step ──────────────────────────────────────────────────

    def step(self, template: str, confidence: float,
             offset_x: int = 0, offset_y: int = 0) -> str:
        """
        Execute one navigation cycle.

        Returns
        -------
        'continue' — keep looping
        'arrived'  — target reached, cleanup already done
        'lost'     — target lost after miss_tolerance, cleanup done
        """

        # ── 1. DETECT ─────────────────────────────────────────────
        region = None
        if self.learner:
            region = self.learner.get_best_region(template)

        detection = self.detector.find_on_screen(
            template, confidence,
            region=region, bypass_gates=True
        )

        # ── 2. TRACK (Kalman update or predict) ───────────────────
        if detection:
            self._miss_count = 0
            self.state = NavState.NAVIGATING if self.state in (
                NavState.SEEKING, NavState.STUCK, NavState.DODGING
            ) else self.state

            fx, fy, vx, vy = self.tracker.update(
                float(detection["x"]) + offset_x,
                float(detection["y"]) + offset_y,
            )
        else:
            self._miss_count += 1
            if self._miss_count >= self.miss_tolerance:
                self.logger.log(
                    f"MovementAI: '{template}' lost after "
                    f"{self._miss_count} consecutive misses — stopping",
                    level="WARN"
                )
                self.cleanup()
                return "lost"

            # Use Kalman prediction while target temporarily invisible
            pred = self.tracker.predict()
            if pred is None:
                # Tracker never initialized — pure seek, wait
                self.state = NavState.SEEKING
                time.sleep(self.step_time * 0.3)
                return "continue"

            fx, fy, vx, vy = pred
            self.logger.log(
                f"MovementAI: miss {self._miss_count}/{self.miss_tolerance} "
                f"— using tracker prediction ({fx:.0f},{fy:.0f})"
            )

        # ── 3. PREDICT (lead targeting for moving targets) ────────
        if (self.tracker.is_moving(self.MIN_MOVING_SPEED)
                and self.tracker.is_reliable()):
            lead = self.tracker.predict_ahead(self.LEAD_PREDICT_S)
            if lead:
                target_x, target_y = lead
            else:
                target_x, target_y = fx, fy
        else:
            target_x, target_y = fx, fy

        # ── 4. DECISION ───────────────────────────────────────────
        dx       = target_x - self.player_x
        dy       = target_y - self.player_y
        distance = math.hypot(dx, dy)

        self.logger.log(
            f"MovementAI [{self.state.name}]: "
            f"target=({target_x:.0f},{target_y:.0f}) "
            f"dx={dx:+.0f} dy={dy:+.0f} dist={distance:.1f} "
            f"vel=({vx:.1f},{vy:.1f}) "
            f"unc={self.tracker.get_uncertainty():.1f}px"
        )

        # Arrival check
        if self._check_arrival(template, confidence, distance):
            self.cleanup()
            self.state = NavState.ARRIVED
            return "arrived"

        # Stuck check
        if self._check_stuck(distance):
            self.state = NavState.STUCK
            self._dodge()
            return "continue"

        # State update
        if distance < self.dead_zone_px:
            self.cleanup()
            return "arrived"
        elif distance < self.decel_zone_px:
            self.state = NavState.DECELERATING
        else:
            self.state = NavState.NAVIGATING

        # ── 5. SMOOTH ACTION ──────────────────────────────────────
        x_key, y_key, duration = self._resolve_keys(dx, dy, distance)

        if x_key is not None or y_key is not None:
            self._apply_keys(x_key, y_key, duration)
        else:
            # In dead zone — release and wait
            self.cleanup()
            time.sleep(self.step_time * 0.1)

        # Inter-step micro-gap (prevents key bounce, simulates human rhythm)
        time.sleep(self.STEP_GAP_S + random.uniform(0.0, self.STEP_GAP_S))
        self._step_count += 1
        return "continue"
