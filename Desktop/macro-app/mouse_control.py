"""
automation/mouse_control.py
Handles all mouse movement and click actions.

Uses pydirectinput for clicks (DirectInput scan codes, works in games)
and pyautogui for movement with duration/bezier curves.

v2 — Upgraded move_human:
  - Cubic bezier (2 control points) for natural S-curves
  - Ease-in / ease-out speed profile (sine curve)
  - Distance-scaled step count (short = fewer, long = more)
  - Micro-tremor at destination before final stop
  - Occasional overshoot + correction (~15% of moves)
  - Pre-movement reaction jitter (20–80 ms human delay)
"""

import pyautogui
import random
import time
import math

try:
    import pydirectinput
    pydirectinput.PAUSE = 0.02
    DIRECTINPUT_AVAILABLE = True
except ImportError:
    DIRECTINPUT_AVAILABLE = False

pyautogui.FAILSAFE = True
pyautogui.PAUSE    = 0.05


class MouseControl:
    def __init__(self, logger):
        self.logger = logger
        if DIRECTINPUT_AVAILABLE:
            self.logger.log("MouseControl: pydirectinput active — DirectInput/game compatible")
        else:
            self.logger.log("MouseControl: using pyautogui fallback", level="WARN")

    # ── MOVEMENT ──────────────────────────────────────────

    def move(self, x: int, y: int, duration: float = 0.3):
        """Move mouse to x, y. Uses pyautogui for smooth duration support."""
        pyautogui.moveTo(x, y, duration=duration)
        self.logger.log(f"Mouse moved to ({x}, {y})")

    def move_human(self, x: int, y: int):
        """
        Move mouse in a human-like path with:
          - Pre-movement reaction jitter
          - Cubic bezier curve (2 control points = natural S-shape)
          - Ease-in / ease-out speed profile
          - Distance-scaled step count
          - Occasional overshoot + correction
          - Micro-tremor at destination
        """
        cur_x, cur_y = pyautogui.position()

        # Pre-movement reaction delay (20–80 ms)
        time.sleep(random.uniform(0.020, 0.080))

        # Distance-scaled steps: min 18, max 60
        dist = math.hypot(x - cur_x, y - cur_y)
        steps = int(max(18, min(60, dist / 12)))

        # Occasionally overshoot then correct (~15% chance)
        overshoot = random.random() < 0.15
        if overshoot:
            over_x = x + random.randint(-20, 20)
            over_y = y + random.randint(-20, 20)
            self._move_cubic(cur_x, cur_y, over_x, over_y, steps)
            time.sleep(random.uniform(0.03, 0.07))
            # Short correction back
            cur_x, cur_y = pyautogui.position()
            correct_steps = max(8, steps // 3)
            self._move_cubic(cur_x, cur_y, x, y, correct_steps)
        else:
            self._move_cubic(cur_x, cur_y, x, y, steps)

        # Micro-tremor at destination (2–4 tiny jitter moves)
        tremors = random.randint(2, 4)
        for _ in range(tremors):
            jx = x + random.randint(-2, 2)
            jy = y + random.randint(-2, 2)
            pyautogui.moveTo(jx, jy, duration=random.uniform(0.008, 0.018))

        # Final precise landing
        pyautogui.moveTo(x, y, duration=0.01)
        self.logger.log(f"Human-like move to ({x}, {y}), dist={dist:.0f}px, steps={steps}, overshoot={overshoot}")

    def _move_cubic(self, x1: int, y1: int, x2: int, y2: int, steps: int):
        """
        Move along a cubic bezier curve (2 control points) with
        ease-in / ease-out timing via a sine speed profile.
        """
        # Two control points — offset perpendicular to the path
        # cp1 near the start, cp2 near the end, both deviate randomly
        dx = x2 - x1
        dy = y2 - y1
        dist = math.hypot(dx, dy) or 1

        # Perpendicular direction
        perp_x = -dy / dist
        perp_y =  dx / dist

        # Control point deviation: 15–45% of distance, random sign
        dev1 = dist * random.uniform(0.15, 0.45) * random.choice([-1, 1])
        dev2 = dist * random.uniform(0.15, 0.45) * random.choice([-1, 1])

        cp1x = x1 + dx * 0.30 + perp_x * dev1
        cp1y = y1 + dy * 0.30 + perp_y * dev1
        cp2x = x1 + dx * 0.70 + perp_x * dev2
        cp2y = y1 + dy * 0.70 + perp_y * dev2

        # Base interval per step (total travel ~0.25–0.6 s scaled by dist)
        total_time = max(0.18, min(0.60, dist / 600))
        base_interval = total_time / steps

        prev_t = 0.0
        for i in range(1, steps + 1):
            # Ease-in/out: map linear t → sine curve so middle is fastest
            t_linear = i / steps
            t = (1 - math.cos(t_linear * math.pi)) / 2

            # Cubic bezier point
            mt = 1 - t
            px = mt**3 * x1 + 3*mt**2*t * cp1x + 3*mt*t**2 * cp2x + t**3 * x2
            py = mt**3 * y1 + 3*mt**2*t * cp1y + 3*mt*t**2 * cp2y + t**3 * y2

            # Speed from sine profile: slow at start/end, fast in middle
            speed = math.sin(t_linear * math.pi)  # 0 → 1 → 0
            speed = max(0.15, speed)               # never completely freeze

            # Interval inversely proportional to speed
            interval = base_interval / speed * 0.9
            interval += random.uniform(-0.002, 0.002)  # tiny noise
            interval = max(0.004, interval)

            pyautogui.moveTo(int(px), int(py), duration=0)
            time.sleep(interval)

    def _bezier_curve(self, x1, y1, x2, y2, steps: int = 25):
        """Legacy quadratic bezier — kept for compatibility."""
        cx = x1 + (x2 - x1) / 2 + random.randint(-60, 60)
        cy = y1 + (y2 - y1) / 2 + random.randint(-60, 60)
        points = []
        for i in range(steps + 1):
            t  = i / steps
            px = (1-t)**2 * x1 + 2*(1-t)*t * cx + t**2 * x2
            py = (1-t)**2 * y1 + 2*(1-t)*t * cy + t**2 * y2
            points.append((px, py))
        return points

    # ── CLICKS (DirectInput when available) ───────────────

    def click(self, x: int = None, y: int = None):
        """Left click. DirectInput when available for game compatibility."""
        try:
            if DIRECTINPUT_AVAILABLE:
                if x is not None and y is not None:
                    pydirectinput.click(x, y)
                else:
                    pydirectinput.click()
            else:
                if x is not None and y is not None:
                    pyautogui.click(x, y)
                else:
                    pyautogui.click()
            self.logger.log(f"Left click at ({x}, {y})")
        except Exception as e:
            self.logger.log(f"click error: {e}", level="ERROR")

    def double_click(self, x: int = None, y: int = None):
        """Double left click."""
        try:
            if DIRECTINPUT_AVAILABLE:
                if x is not None and y is not None:
                    pydirectinput.doubleClick(x, y)
                else:
                    pydirectinput.doubleClick()
            else:
                if x is not None and y is not None:
                    pyautogui.doubleClick(x, y)
                else:
                    pyautogui.doubleClick()
            self.logger.log(f"Double click at ({x}, {y})")
        except Exception as e:
            self.logger.log(f"double_click error: {e}", level="ERROR")

    def right_click(self, x: int = None, y: int = None):
        """Right click."""
        try:
            if DIRECTINPUT_AVAILABLE:
                if x is not None and y is not None:
                    pydirectinput.rightClick(x, y)
                else:
                    pydirectinput.rightClick()
            else:
                if x is not None and y is not None:
                    pyautogui.rightClick(x, y)
                else:
                    pyautogui.rightClick()
            self.logger.log(f"Right click at ({x}, {y})")
        except Exception as e:
            self.logger.log(f"right_click error: {e}", level="ERROR")

    # ── DRAG & SCROLL ─────────────────────────────────────

    def drag(self, x1: int, y1: int, x2: int, y2: int, duration: float = 0.5):
        """Click and drag from (x1,y1) to (x2,y2). Uses pyautogui (duration support)."""
        pyautogui.moveTo(x1, y1)
        pyautogui.dragTo(x2, y2, duration=duration, button='left')
        self.logger.log(f"Drag ({x1},{y1}) → ({x2},{y2})")

    def scroll(self, clicks: int, x: int = None, y: int = None):
        """Scroll mouse wheel. Positive = up, negative = down."""
        if x is not None and y is not None:
            pyautogui.scroll(clicks, x=x, y=y)
        else:
            pyautogui.scroll(clicks)
        self.logger.log(f"Scrolled {clicks} clicks")
