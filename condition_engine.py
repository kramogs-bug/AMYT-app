"""
core/condition_engine.py
Evaluates conditional statements used in macro scripts.
Used by the macro engine when processing IF_IMAGE, WHILE_IMAGE, etc.
"""

import mss
import numpy as np


class ConditionEngine:
    def __init__(self, detector, logger, learner=None):
        self.detector = detector
        self.logger   = logger
        self.learner  = learner  # LearningEngine — for search region lookup

    def check_image_exists(self, template_name: str, confidence: float = 0.8) -> bool:
        """
        Check if a template image is currently visible on screen.
        Automatically applies any saved search region.
        Returns True if found, False otherwise.
        Used for: IF_IMAGE, WHILE_IMAGE
        """
        region = None
        if self.learner:
            region = self.learner.get_best_region(template_name)
            if region:
                self.logger.log(f"Condition using region {region} for '{template_name}'")

        result = self.detector.find_on_screen(template_name, confidence, region=region)
        exists = result is not None
        self.logger.log(
            f"Condition [IMAGE EXISTS '{template_name}']: {exists}"
        )
        return exists

    def check_image_not_exists(self, template_name: str, confidence: float = 0.8) -> bool:
        """
        Check if a template image is NOT on screen.
        Used for: IF_NOT_IMAGE
        """
        return not self.check_image_exists(template_name, confidence)

    def check_pixel_color(self, x: int, y: int,
                          expected_color: tuple, tolerance: int = 10) -> bool:
        """
        Check if the pixel at screen position (x, y) matches an expected RGB color
        within the given per-channel tolerance.
        Used for: IF_COLOR
        expected_color: (R, G, B) tuple
        """
        try:
            with mss.mss() as sct:
                # Grab a 1×1 pixel region
                monitor = {"left": int(x), "top": int(y), "width": 1, "height": 1}
                shot    = sct.grab(monitor)
                pixel   = np.array(shot)[0, 0]   # BGRA order from mss
                # mss gives BGRA; convert to RGB for comparison
                r, g, b = int(pixel[2]), int(pixel[1]), int(pixel[0])

            er, eg, eb = int(expected_color[0]), int(expected_color[1]), int(expected_color[2])
            matched = (
                abs(r - er) <= tolerance and
                abs(g - eg) <= tolerance and
                abs(b - eb) <= tolerance
            )
            self.logger.log(
                f"Condition [PIXEL COLOR at ({x},{y})]: "
                f"actual=({r},{g},{b}) expected=({er},{eg},{eb}) "
                f"tol={tolerance} → {matched}"
            )
            return matched
        except Exception as e:
            self.logger.log(f"check_pixel_color error: {e}", level="ERROR")
            return False