"""
learning/region_learning.py
Tracks where on screen each template is usually found.
Over time, narrows down the search region for faster detection.
"""


class RegionLearning:
    def __init__(self, logger):
        self.logger = logger
        # Stores a history of detection regions per template
        # Format: { "template_name": [(x, y, w, h), ...] }
        self.history = {}

    def record(self, template_name: str, x: int, y: int, w: int, h: int):
        """
        Record a detection region for a template.
        Call this whenever a template is successfully found.
        """
        if template_name not in self.history:
            self.history[template_name] = []
        self.history[template_name].append((x, y, w, h))
        self.logger.log(f"Region recorded for '{template_name}': ({x},{y},{w},{h})")

    def get_most_common_region(self, template_name: str):
        """
        Return the average region where the template is usually found.
        Returns [x, y, w, h] or None if no history.
        """
        if template_name not in self.history or not self.history[template_name]:
            return None

        records = self.history[template_name]
        # Average all recorded regions
        avg_x = sum(r[0] for r in records) // len(records)
        avg_y = sum(r[1] for r in records) // len(records)
        avg_w = sum(r[2] for r in records) // len(records)
        avg_h = sum(r[3] for r in records) // len(records)

        return [avg_x, avg_y, avg_w, avg_h]

    def clear(self, template_name: str = None):
        """Clear region history for one template, or all if name not given."""
        if template_name:
            self.history.pop(template_name, None)
        else:
            self.history = {}