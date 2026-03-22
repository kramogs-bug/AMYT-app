"""
vision/color_detector.py
Color detection: single pixel and region search.
"""

import pyautogui
import mss
import numpy as np
import cv2
import time


class ColorDetector:
    def __init__(self, logger):
        self.logger = logger

    def get_pixel_color(self, x: int, y: int) -> tuple:
        """Get RGB color at (x,y). Returns (0,0,0) on error."""
        try:
            color = pyautogui.pixel(x, y)
            self.logger.log(f"Pixel at ({x},{y}) = RGB{color}")
            return color
        except Exception as e:
            self.logger.log(f"get_pixel_color({x},{y}) error: {e}", level="ERROR")
            return (0, 0, 0)

    def color_matches(self, x: int, y: int, expected_color: tuple, tolerance: int = 10) -> bool:
        """Check if pixel at (x,y) is within tolerance of expected color."""
        try:
            current = pyautogui.pixel(x, y)
        except Exception as e:
            self.logger.log(f"color_matches({x},{y}) error: {e}", level="ERROR")
            return False
        return all(abs(current[i] - expected_color[i]) <= tolerance for i in range(3))

    def wait_for_color(self, x: int, y: int, expected_color: tuple,
                       tolerance: int = 10, timeout: float = 10) -> bool:
        """Wait for a specific color at a point."""
        self.logger.log(f"Waiting for color {expected_color} at ({x},{y})...")
        start = time.time()
        while time.time() - start < timeout:
            if self.color_matches(x, y, expected_color, tolerance):
                self.logger.log(f"Color matched at ({x},{y})")
                return True
            time.sleep(0.1)
        self.logger.log(f"Timeout waiting for color at ({x},{y})", level="WARN")
        return False

    def find_color_in_region(self, color_hex: str, region=None, tolerance=30):
        """
        Find the first pixel matching a hex color (e.g., '#FF0000') within a region.
        region = [x, y, w, h] or None for full screen.
        Returns (x, y) or None.
        """
        # Convert hex to BGR (OpenCV uses BGR)
        color_hex = color_hex.lstrip('#')
        r, g, b = tuple(int(color_hex[i:i+2], 16) for i in (0, 2, 4))
        # Clamp to [0, 255] to prevent uint8 wrap-around on near-black or near-white colors
        lower = np.clip([b - tolerance, g - tolerance, r - tolerance], 0, 255).astype(np.uint8)
        upper = np.clip([b + tolerance, g + tolerance, r + tolerance], 0, 255).astype(np.uint8)

        with mss.mss() as sct:
            if region:
                left, top, w, h = region
                monitor = {"left": left, "top": top, "width": w, "height": h}
            else:
                monitor = sct.monitors[1]
                left, top = 0, 0
            img = np.array(sct.grab(monitor))
            img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)

        mask = cv2.inRange(img, lower, upper)
        coords = np.column_stack(np.where(mask > 0))
        if coords.size == 0:
            return None
        # First match (y, x) because np.where returns (rows, cols)
        y, x = coords[0]
        abs_x = int(x) + left  # Cast to plain int — numpy.int64 is not JSON serializable
        abs_y = int(y) + top
        self.logger.log(f"Found color {color_hex} at ({abs_x},{abs_y})")
        return (abs_x, abs_y)

    def find_all_colors(self, color_hex: str, region=None, tolerance=30):
        """
        Find all pixels matching a hex color within a region.
        Returns a list of (x, y) coordinates.
        """
        color_hex = color_hex.lstrip('#')
        r, g, b = tuple(int(color_hex[i:i+2], 16) for i in (0, 2, 4))
        # Clamp to [0, 255] to prevent uint8 wrap-around on near-black or near-white colors
        lower = np.clip([b - tolerance, g - tolerance, r - tolerance], 0, 255).astype(np.uint8)
        upper = np.clip([b + tolerance, g + tolerance, r + tolerance], 0, 255).astype(np.uint8)

        with mss.mss() as sct:
            if region:
                left, top, w, h = region
                monitor = {"left": left, "top": top, "width": w, "height": h}
            else:
                monitor = sct.monitors[1]
                left, top = 0, 0
            img = np.array(sct.grab(monitor))
            img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)

        mask = cv2.inRange(img, lower, upper)
        coords = np.column_stack(np.where(mask > 0))
        results = []
        for y, x in coords:
            # Cast to plain int — numpy.int64 is not JSON serializable
            results.append((int(x) + left, int(y) + top))
        return results