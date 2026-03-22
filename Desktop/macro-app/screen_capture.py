"""
vision/screen_capture.py
Handles screen capture using mss (fast screen grabber).
Can capture full screen, a region, or save as a named template.
"""

import mss
import mss.tools
import numpy as np
import os
import datetime


class ScreenCapture:
    def __init__(self, logger):
        self.logger = logger
        # All template images go here
        self.templates_dir = os.path.join("storage", "templates")
        os.makedirs(self.templates_dir, exist_ok=True)
        os.makedirs("logs", exist_ok=True)

    def _timestamp(self):
        """Generate a timestamp string for filenames."""
        return datetime.datetime.now().strftime("%Y%m%d_%H%M%S")

    def capture_fullscreen(self) -> str:
        """
        Capture the entire screen and save it as a PNG.
        Returns the saved file path.
        """
        with mss.mss() as sct:
            monitor = sct.monitors[1]  # Monitor 1 = primary screen
            screenshot = sct.grab(monitor)
            path = os.path.join("logs", f"screenshot_{self._timestamp()}.png")
            mss.tools.to_png(screenshot.rgb, screenshot.size, output=path)
            self.logger.log(f"Full screen captured → {path}")
            return path

    def capture_region(self, x: int, y: int, w: int, h: int) -> str:
        """
        Capture a specific rectangular region of the screen.
        x, y = top-left corner
        w, h = width and height
        Returns the saved file path.
        """
        with mss.mss() as sct:
            monitor = {"left": x, "top": y, "width": w, "height": h}
            screenshot = sct.grab(monitor)
            path = os.path.join("logs", f"region_{self._timestamp()}.png")
            mss.tools.to_png(screenshot.rgb, screenshot.size, output=path)
            self.logger.log(f"Region captured ({x},{y},{w},{h}) → {path}")
            return path

    def save_as_template(self, x: int, y: int, w: int, h: int, name: str) -> str:
        """
        Capture a region and save it as a reusable template image.
        Templates are used by the image detector to find things on screen.
        """
        with mss.mss() as sct:
            monitor = {"left": x, "top": y, "width": w, "height": h}
            screenshot = sct.grab(monitor)

            # Ensure .png extension
            if not name.endswith(".png"):
                name += ".png"

            path = os.path.join(self.templates_dir, name)
            mss.tools.to_png(screenshot.rgb, screenshot.size, output=path)
            self.logger.log(f"Template saved: {name} → {path}")
            return path

    def get_screen_as_numpy(self) -> np.ndarray:
        """
        Capture the full screen and return it as a NumPy array (BGRA format).
        Used internally by the image detector.
        """
        with mss.mss() as sct:
            monitor = sct.monitors[1]
            screenshot = sct.grab(monitor)
            return np.array(screenshot)