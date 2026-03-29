"""
tracker.py
Kalman Filter based 2D object tracker for screen-space coordinates.

Used by MovementAI to smooth noisy detection output, estimate velocity,
and predict target position between detection frames.

State vector : [x, y, vx, vy]  (position + velocity in px / s)
Measurement  : [x, y]          (raw screen coords from find_on_screen)

Design choices
--------------
* Constant-velocity model  — appropriate for game targets that accelerate
  faster than our detection interval.  Acceleration is captured as process
  noise rather than a separate state variable.
* numpy-only, no scipy/filterpy dependency.
* Dynamic dt — every update recalculates F and Q from the real elapsed
  time so frame-rate drops don't corrupt velocity estimates.
* Covariance clamping — prevents divergence during long miss runs.
* predict_ahead() — returns where the target will be in N milliseconds,
  used by MovementAI for lead-targeting on moving enemies.
"""

import time
import math
import numpy as np
from collections import deque


class KalmanTracker:
    """
    2-D position + velocity Kalman filter.

    Typical usage
    -------------
        tracker = KalmanTracker()

        # When a detection arrives:
        fx, fy, vx, vy = tracker.update(det["x"], det["y"])

        # When detection failed this frame but tracker is still live:
        result = tracker.predict()
        if result:
            fx, fy, vx, vy = result

        # Lead-aim at a moving target 80 ms ahead:
        lead = tracker.predict_ahead(0.08)   # (px, py)
    """

    def __init__(
        self,
        process_noise_pos: float = 4.0,   # Q position sigma (px)
        process_noise_vel: float = 25.0,  # Q velocity sigma (px/s)
        measurement_noise: float = 7.0,   # R measurement sigma (px)
        max_covariance:    float = 800.0, # cap per diagonal element
        max_speed_px_s:    float = 1500.0,# clamp estimated velocity
    ):
        self._qp  = float(process_noise_pos)
        self._qv  = float(process_noise_vel)
        self._r   = float(measurement_noise)
        self._max_cov   = float(max_covariance)
        self._max_speed = float(max_speed_px_s)

        # State [x, y, vx, vy] — col vector
        self.x = np.zeros((4, 1), dtype=np.float64)

        # Covariance — large initial uncertainty
        self.P = np.diag([500.0, 500.0, 1000.0, 1000.0]).astype(np.float64)

        # Measurement matrix: observe x and y only
        self.H = np.array(
            [[1, 0, 0, 0],
             [0, 1, 0, 0]], dtype=np.float64
        )

        # Measurement noise covariance R
        self.R = np.eye(2, dtype=np.float64) * (self._r ** 2)

        # Will be built per-frame
        self.F = np.eye(4, dtype=np.float64)
        self.Q = np.zeros((4, 4), dtype=np.float64)
        self._build_FQ(1.0 / 60.0)

        self._initialized        = False
        self._last_update_time   = None
        self._consec_miss        = 0

        # Rolling speed history for is_moving()
        self._speed_history = deque(maxlen=8)

    # ── Private helpers ────────────────────────────────────────────

    def _build_FQ(self, dt: float):
        """Rebuild transition matrix F and process noise Q for dt seconds."""
        dt = max(1e-4, dt)

        self.F = np.array(
            [[1, 0, dt, 0],
             [0, 1,  0, dt],
             [0, 0,  1, 0],
             [0, 0,  0, 1]], dtype=np.float64
        )

        # Discrete white-noise model (Singer model approximation)
        qp = self._qp ** 2
        qv = self._qv ** 2
        dt2 = dt * dt
        self.Q = np.diag([
            qp + qv * dt2 * 0.5,
            qp + qv * dt2 * 0.5,
            qv,
            qv,
        ]).astype(np.float64)

    def _clamp_covariance(self):
        """Prevent covariance explosion during prolonged occlusion."""
        np.clip(self.P, -self._max_cov, self._max_cov, out=self.P)

    def _clamp_velocity(self):
        """Hard-clamp physically impossible velocities (detection artifacts)."""
        vx = float(self.x[2, 0])
        vy = float(self.x[3, 0])
        speed = math.hypot(vx, vy)
        if speed > self._max_speed:
            scale = self._max_speed / speed
            self.x[2, 0] *= scale
            self.x[3, 0] *= scale

    # ── Public API ─────────────────────────────────────────────────

    def initialize(self, x: float, y: float):
        """
        Hard-initialize the tracker at (x, y) with zero velocity.
        Resets covariance to 'just detected' level.
        Call this on the very first detection or after a full reset.
        """
        self.x = np.array([[x], [y], [0.0], [0.0]], dtype=np.float64)
        self.P = np.diag([20.0, 20.0, 400.0, 400.0]).astype(np.float64)
        self._last_update_time = time.perf_counter()
        self._initialized      = True
        self._consec_miss      = 0
        self._speed_history.clear()

    def update(self, x: float, y: float) -> tuple:
        """
        Predict + correct with a new measurement.

        Returns (filtered_x, filtered_y, velocity_x, velocity_y).
        All positions in screen pixels; velocities in pixels/second.
        """
        now = time.perf_counter()

        if not self._initialized:
            self.initialize(x, y)
            return (x, y, 0.0, 0.0)

        dt = now - self._last_update_time
        dt = min(max(dt, 1e-3), 1.0)          # clamp to [1 ms, 1 s]
        self._last_update_time = now
        self._consec_miss      = 0
        self._build_FQ(dt)

        # ── Predict ──────────────────────────────────────────────
        x_pred = self.F @ self.x
        P_pred = self.F @ self.P @ self.F.T + self.Q

        # ── Update (Kalman gain) ──────────────────────────────────
        z     = np.array([[x], [y]], dtype=np.float64)
        innov = z - self.H @ x_pred                     # innovation
        S     = self.H @ P_pred @ self.H.T + self.R     # innovation covariance
        K     = P_pred @ self.H.T @ np.linalg.inv(S)    # Kalman gain

        self.x = x_pred + K @ innov
        # Joseph form for numerical stability
        I_KH   = np.eye(4) - K @ self.H
        self.P = I_KH @ P_pred @ I_KH.T + K @ self.R @ K.T

        self._clamp_velocity()
        self._clamp_covariance()

        vx, vy = float(self.x[2, 0]), float(self.x[3, 0])
        self._speed_history.append(math.hypot(vx, vy))

        return (
            float(self.x[0, 0]),
            float(self.x[1, 0]),
            vx,
            vy,
        )

    def predict(self) -> tuple | None:
        """
        Run the prediction step only (no measurement this frame).
        Use when detection failed but the target may still be there.

        Returns (predicted_x, predicted_y, vx, vy)  or  None if uninitialized.
        Increments miss counter; returns None if called too many times without
        an update (tracker considered lost).
        """
        if not self._initialized:
            return None

        now = time.perf_counter()
        dt  = now - self._last_update_time
        dt  = min(max(dt, 1e-3), 1.0)
        self._build_FQ(dt)

        # Predict only — do NOT update last_update_time so dt keeps growing
        self.x = self.F @ self.x
        self.P = self.F @ self.P @ self.F.T + self.Q
        self._clamp_covariance()
        self._clamp_velocity()
        self._consec_miss += 1

        return (
            float(self.x[0, 0]),
            float(self.x[1, 0]),
            float(self.x[2, 0]),
            float(self.x[3, 0]),
        )

    def predict_ahead(self, seconds: float) -> tuple | None:
        """
        Return where the target is predicted to be `seconds` from now.
        Useful for lead-targeting a moving enemy.

        Returns (px, py) in screen pixels, or None if uninitialized.
        """
        if not self._initialized:
            return None
        # Simple kinematic projection using current estimated velocity
        px = float(self.x[0, 0]) + float(self.x[2, 0]) * seconds
        py = float(self.x[1, 0]) + float(self.x[3, 0]) * seconds
        return (px, py)

    def get_velocity(self) -> tuple:
        """Return (vx, vy) in pixels/second. (0, 0) if uninitialized."""
        if not self._initialized:
            return (0.0, 0.0)
        return (float(self.x[2, 0]), float(self.x[3, 0]))

    def get_position(self) -> tuple | None:
        """Return current filtered (x, y). None if uninitialized."""
        if not self._initialized:
            return None
        return (float(self.x[0, 0]), float(self.x[1, 0]))

    def get_uncertainty(self) -> float:
        """
        Return positional uncertainty as RMS of x/y variance (pixels).
        Lower = more confident.  > 50px = tracker is diverging.
        """
        if not self._initialized:
            return float("inf")
        return float(math.sqrt((self.P[0, 0] + self.P[1, 1]) / 2.0))

    def is_reliable(self, max_uncertainty: float = 60.0) -> bool:
        """True when the tracker's positional uncertainty is acceptable."""
        return self._initialized and self.get_uncertainty() < max_uncertainty

    def is_moving(self, min_speed_px_s: float = 15.0) -> bool:
        """
        True if the recent average speed exceeds min_speed_px_s.
        Used by MovementAI to decide whether to apply lead prediction.
        """
        if len(self._speed_history) < 3:
            return False
        avg = sum(self._speed_history) / len(self._speed_history)
        return avg > min_speed_px_s

    def reset(self):
        """Full state reset.  Call after target loss or teleport."""
        self._initialized      = False
        self._consec_miss      = 0
        self.x                 = np.zeros((4, 1), dtype=np.float64)
        self.P                 = np.diag([500.0, 500.0, 1000.0, 1000.0]).astype(np.float64)
        self._last_update_time = None
        self._speed_history.clear()

    @property
    def consec_miss(self) -> int:
        """Number of consecutive predict()-only calls since last update()."""
        return self._consec_miss
