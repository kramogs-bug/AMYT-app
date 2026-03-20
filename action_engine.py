"""
core/action_engine.py
Executes individual macro actions.
Acts as the middle layer between the macro engine and the automation modules.
"""

import time
import random
import math
from typing import Optional
from ocr_engine import OCREngine
from color_detector import ColorDetector

try:
    import pydirectinput as _pydirectinput
    _PYDIRECTINPUT_AVAILABLE = True
except ImportError:
    _pydirectinput = None
    _PYDIRECTINPUT_AVAILABLE = False


class ActionEngine:
    def __init__(self, mouse, keyboard, detector, logger, learner=None):
        self.mouse          = mouse
        self.keyboard       = keyboard
        self.detector       = detector
        self.logger         = logger
        self.learner        = learner        # LearningEngine — used to look up search regions
        self._stop_flag_ref = None   # set by MacroEngine after construction         # add screen for later use
        self.ocr = OCREngine(logger)
        self.color = ColorDetector(logger)

    
    def find_text(self, text, region=None, confidence=80):
        """Return first text occurrence (for commands)."""
        return self.ocr.find_text_position(text, region, confidence)

    def find_all_text(self, text, region=None, confidence=80):
        """Return all text occurrences (for testing)."""
        return self.ocr.find_all_text_positions(text, region, confidence)

    def find_color(self, color_hex, region=None, tolerance=30):
        """Return first color match (for commands)."""
        return self.color.find_color_in_region(color_hex, region, tolerance)

    def find_all_colors(self, color_hex, region=None, tolerance=30):
        """Return all color matches (for testing)."""
        return self.color.find_all_colors(color_hex, region, tolerance)

    # ── TIME ──────────────────────────────────────────────

    def wait(self, seconds):
        """
        Pause execution for a number of seconds.
        Checks stop_flag every 0.1s so Stop works instantly even mid-wait.
        """
        seconds  = float(seconds)
        self.logger.log(f"Waiting {seconds}s...")
        elapsed  = 0.0
        interval = 0.1
        while elapsed < seconds:
            if self._stop_flag_ref is not None and self._stop_flag_ref():
                break
            chunk    = min(interval, seconds - elapsed)
            time.sleep(chunk)
            elapsed += chunk

    # ── MOUSE ACTIONS ─────────────────────────────────────

    def click(self, x, y):
        """Left click at coordinates."""
        self.mouse.click(int(x), int(y))

    def double_click(self, x, y):
        """Double click at coordinates."""
        self.mouse.double_click(int(x), int(y))

    def right_click(self, x, y):
        """Right click at coordinates."""
        self.mouse.right_click(int(x), int(y))

    def move(self, x, y):
        """Move mouse to coordinates without clicking."""
        self.mouse.move(int(x), int(y))

    def move_human(self, x, y):
        """Move mouse with human-like curve."""
        self.mouse.move_human(int(x), int(y))

    def scroll(self, amount):
        """Scroll mouse wheel. Positive = up, negative = down."""
        self.mouse.scroll(int(amount))

    def drag(self, x1, y1, x2, y2):
        """Click and drag from (x1,y1) to (x2,y2)."""
        self.mouse.drag(int(x1), int(y1), int(x2), int(y2))

    # ── IMAGE ACTIONS ─────────────────────────────────────

    # Position anchors for image-relative actions
    _ANCHORS = {
        "center":       (0.5,  0.5),
        "top_left":     (0.0,  0.0),
        "top_right":    (1.0,  0.0),
        "bottom_left":  (0.0,  1.0),
        "bottom_right": (1.0,  1.0),
        "top":          (0.5,  0.0),
        "bottom":       (0.5,  1.0),
        "left":         (0.0,  0.5),
        "right":        (1.0,  0.5),
    }

    def _resolve_position(self, result: dict, anchor: str = "center",
                          offset_x: int = 0, offset_y: int = 0) -> tuple:
        """
        Given a find_on_screen result dict, compute the final (x, y)
        target using an anchor and optional pixel offset.

        result["rect"] = [left, top, width, height]
        """
        rect   = result.get("rect")   # [left, top, w, h]
        cx, cy = result["x"], result["y"]   # center (fallback)

        if rect:
            left, top, w, h = rect
            ax, ay = self._ANCHORS.get(anchor.lower(), (0.5, 0.5))
            cx = int(left + w * ax)
            cy = int(top  + h * ay)

        return cx + int(offset_x), cy + int(offset_y)

    def _random_offset(self, x: int, y: int, radius: int) -> tuple:
        """
        Return (x, y) jittered by a uniformly random point inside a circle of
        `radius` pixels.  Uses rejection sampling for true circular distribution
        (no corner bias from naive square sampling).
        Clamps result to sane screen coordinates (>= 0).
        """
        if radius <= 0:
            return x, y
        while True:
            dx = random.randint(-radius, radius)
            dy = random.randint(-radius, radius)
            if dx * dx + dy * dy <= radius * radius:   # inside circle
                return max(0, x + dx), max(0, y + dy)

    def _find_with_log(self, template_name: str, confidence: float) -> Optional[dict]:
        """
        Find template on screen, automatically applying any saved search region.
        Manual region (user-set) is always used if present.
        Falls back to auto-learned region, then full screen.
        """
        region = None
        if self.learner:
            region = self.learner.get_best_region(template_name)
            if region:
                self.logger.log(
                    f"Using search region {region} for '{template_name}'"
                )

        result = self.detector.find_on_screen(template_name, confidence, region=region)
        if not result:
            self.logger.log(f"Image not found: '{template_name}'", level="WARN")
        return result

    # Legacy helpers (keep for backward compat with old script commands)
    def click_image(self, template_name: str, confidence: float = 0.8,
                    anchor: str = "center",
                    offset_x: int = 0, offset_y: int = 0) -> bool:
        """Find image and left-click at anchor+offset."""
        result = self._find_with_log(template_name, confidence)
        if result:
            x, y = self._resolve_position(result, anchor, offset_x, offset_y)
            self.mouse.click(x, y)
            self.logger.log(f"Clicked '{template_name}' at ({x},{y}) [{anchor} +{offset_x},{offset_y}]")
            return True
        return False

    def double_click_image(self, template_name: str, confidence: float = 0.8,
                           anchor: str = "center",
                           offset_x: int = 0, offset_y: int = 0) -> bool:
        """Find image and double-click at anchor+offset."""
        result = self._find_with_log(template_name, confidence)
        if result:
            x, y = self._resolve_position(result, anchor, offset_x, offset_y)
            self.mouse.double_click(x, y)
            self.logger.log(f"Double-clicked '{template_name}' at ({x},{y})")
            return True
        return False

    def right_click_image(self, template_name: str, confidence: float = 0.8,
                          anchor: str = "center",
                          offset_x: int = 0, offset_y: int = 0) -> bool:
        """Find image and right-click at anchor+offset."""
        result = self._find_with_log(template_name, confidence)
        if result:
            x, y = self._resolve_position(result, anchor, offset_x, offset_y)
            self.mouse.right_click(x, y)
            self.logger.log(f"Right-clicked '{template_name}' at ({x},{y})")
            return True
        return False

    def move_to_image(self, template_name: str, confidence: float = 0.8,
                      anchor: str = "center",
                      offset_x: int = 0, offset_y: int = 0) -> bool:
        """Find image and move mouse to anchor+offset without clicking."""
        result = self._find_with_log(template_name, confidence)
        if result:
            x, y = self._resolve_position(result, anchor, offset_x, offset_y)
            self.mouse.move(x, y)
            self.logger.log(f"Moved to '{template_name}' at ({x},{y})")
            return True
        return False

    def hold_image(self, template_name: str, confidence: float = 0.8,
                   anchor: str = "center",
                   offset_x: int = 0, offset_y: int = 0) -> bool:
        """Find image and hold left mouse button down at anchor+offset.
        Uses pydirectinput when available. The caller is responsible for
        eventually calling a release; this method itself does NOT auto-release.
        """
        result = self._find_with_log(template_name, confidence)
        if result:
            x, y = self._resolve_position(result, anchor, offset_x, offset_y)
            self.mouse.move(x, y)
            if _PYDIRECTINPUT_AVAILABLE:
                _pydirectinput.mouseDown(button='left')
            else:
                import pyautogui
                pyautogui.mouseDown(button='left')
            self.logger.log(f"Hold-down at '{template_name}' ({x},{y})")
            return True
        return False

    def release_mouse(self):
        """Explicitly release the left mouse button (use after hold_image)."""
        try:
            if _PYDIRECTINPUT_AVAILABLE:
                _pydirectinput.mouseUp(button='left')
            else:
                import pyautogui
                pyautogui.mouseUp(button='left')
            self.logger.log("Mouse button released")
        except Exception as e:
            self.logger.log(f"release_mouse error: {e}", level="ERROR")

    def drag_from_image(self, template_name: str,
                        dest_x: int, dest_y: int,
                        confidence: float = 0.8,
                        anchor: str = "center",
                        offset_x: int = 0, offset_y: int = 0) -> bool:
        """Find image, then drag from its anchor+offset to (dest_x, dest_y)."""
        result = self._find_with_log(template_name, confidence)
        if result:
            x, y = self._resolve_position(result, anchor, offset_x, offset_y)
            self.mouse.drag(x, y, int(dest_x), int(dest_y))
            self.logger.log(f"Dragged '{template_name}' from ({x},{y}) to ({dest_x},{dest_y})")
            return True
        return False

    # ── KEYBOARD ACTIONS ──────────────────────────────────

    def type_text(self, text: str):
        """Type a string of text."""
        self.keyboard.type_text(text)

    def press(self, key: str):
        """Press a single key (e.g., 'enter', 'space', 'a')."""
        self.keyboard.press(key.lower())

    def hold(self, key: str):
        """Hold a key down."""
        self.keyboard.hold(key.lower())

    def release(self, key: str):
        """Release a held key."""
        self.keyboard.release(key.lower())

    def hotkey(self, combo: str):
        """
        Send a key combination like 'CTRL+C' or 'ALT+TAB'.
        The combo string is split by '+' and each part is a key name.
        """
        self.keyboard.send_combo(combo)
    