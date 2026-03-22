"""
learning/learning_engine.py
Self-learning system that tracks image detection history.
Learns best click offsets, regions, and success rates over time.
Data is saved to storage/learning_data.json.

Fixes applied:
- save() is now debounced (dirty flag, saves at most every 5s) — not on every detection
- auto_region now clamps to screen boundaries to avoid out-of-bounds regions
- Added set_manual_region() proper API so external code doesn't touch internals directly
"""

import json
import os
import time
import threading
from typing import Optional


class LearningEngine:
    def __init__(self, logger):
        self.logger = logger
        self.data_path = os.path.join("storage", "learning_data.json")
        self.data = self._load()

        # Debounce save state
        self._dirty = False
        self._last_save = 0.0
        self._save_interval = 5.0  # seconds between auto-saves
        self._save_lock = threading.Lock()

    # ── FILE I/O ────────────────────────────────────────────

    def _load(self) -> dict:
        """Load existing learning data from JSON file.
        Migrates away any legacy auto_region / consecutive_high_conf fields."""
        if os.path.exists(self.data_path):
            try:
                with open(self.data_path, "r") as f:
                    data = json.load(f)
                # Migration: remove auto_region and related fields left from old version
                changed = False
                for entry in data.values():
                    for stale_key in ("auto_region", "consecutive_high_conf", "manual_lock"):
                        if stale_key in entry:
                            del entry[stale_key]
                            changed = True
                if changed:
                    self.logger.log(
                        "learning_data.json: removed stale auto_region fields", level="INFO"
                    )
                return data
            except (json.JSONDecodeError, IOError):
                self.logger.log("learning_data.json corrupted, starting fresh.", level="WARN")
        return {}

    def _save(self):
        """Save current learning data to JSON file (direct, immediate)."""
        with self._save_lock:
            try:
                with open(self.data_path, "w") as f:
                    json.dump(self.data, f, indent=2)
                self._dirty = False
                self._last_save = time.time()
            except IOError as e:
                self.logger.log(f"Failed to save learning data: {e}", level="ERROR")

    def _schedule_save(self):
        """
        Mark dirty and start (or restart) a background timer to save.
        Cancels any existing timer to ensure the last change is always saved.
        """
        self._dirty = True
        # Cancel any existing timer
        if hasattr(self, '_save_timer') and self._save_timer:
            self._save_timer.cancel()
        self._save_timer = threading.Timer(self._save_interval, self._timed_save)
        self._save_timer.daemon = True
        self._save_timer.start()

    def _timed_save(self):
        """Called by the background timer — saves if still dirty."""
        self._save_timer = None
        if self._dirty:
            self._save()

    def flush(self):
        """Force-save any pending dirty state. Call on app shutdown."""
        # Cancel any pending timer so it doesn't fire after shutdown
        timer = getattr(self, '_save_timer', None)
        if timer:
            timer.cancel()
            self._save_timer = None
        if self._dirty:
            self._save()

    # ── LEARNING FUNCTIONS ──────────────────────────────────

    def record_detection(self, template_name: str, location: dict, success: bool):
        """
        Called every time a detection is attempted.
        Updates the success rate and the AUTO-learned region only.

        IMPORTANT: 'region' (manual, user-set) is NEVER modified here.
        Only 'auto_region' is updated from detection history.
        """
        template_name = self._normalize(template_name)
        if template_name not in self.data:
            self.data[template_name] = {
                "templates": [template_name],
                "best_offset": [0, 0],
                "success_rate": 0.0,
                "detections": 0,
                "successes": 0,
                "region": None,   # manual region — set by user only
                "manual_lock": False,
            }

        entry = self.data[template_name]
        entry["detections"] += 1

        if success and location:
            entry["successes"] += 1

        if entry["detections"] > 0:
            entry["success_rate"] = round(
                entry["successes"] / entry["detections"], 2
            )

        # Debounced save — not on every detection call
        self._schedule_save()

        self.logger.log(
            f"Learning [{template_name}]: "
            f"rate={entry['success_rate']} "
            f"({entry['successes']}/{entry['detections']})"
        )

    # ── NAME NORMALISATION ──────────────────────────────────

    @staticmethod
    def _normalize(template_name: str) -> str:
        """
        Strip the .png extension (if present) so that 'test' and 'test.png'
        always resolve to the same key in self.data.

        This fixes a bug where:
          - The UI saves the region under 'test'   (strips .png before calling set_manual_region)
          - The macro engine passes  'test.png'    (taken verbatim from the script line)
          - get_best_region('test.png') found nothing → fell back to full-screen search
        """
        if template_name.lower().endswith(".png"):
            return template_name[:-4]
        return template_name

    def set_manual_region(self, template_name: str, region: Optional[list]):
        """
        Set or clear the manual search region for a template.
        region = [x, y, w, h] or None to clear (reverts to full screen).
        """
        template_name = self._normalize(template_name)
        if template_name not in self.data:
            self.data[template_name] = {
                "templates": [template_name],
                "best_offset": [0, 0],
                "success_rate": 0.0,
                "detections": 0,
                "successes": 0,
                "region": None,
                "manual_lock": False,
            }
        self.data[template_name]["region"] = region
        self._save()
        action = f"set to {region}" if region else "cleared (full screen)"
        self.logger.log(f"Manual region for '{template_name}' {action}")

    def get_best_region(self, template_name: str):
        """
        Return the manual search region set by the user, or None (full screen).
        Auto-region has been removed — detection always uses full screen unless
        the user explicitly draws a region in the UI.
        """
        template_name = self._normalize(template_name)
        entry = self.data.get(template_name)
        if not entry:
            return None
        return entry.get("region")  # None = full screen search

    def get_best_region_with_source(self, template_name: str):
        """
        Return (region, source) where source is one of:
          - "manual"   user-configured region
          - "full"     no region, search full screen
        """
        template_name = self._normalize(template_name)
        entry = self.data.get(template_name)
        if not entry:
            return None, "full"
        if entry.get("region"):
            return entry["region"], "manual"
        return None, "full"

    def get_manual_region(self, template_name: str):
        """Return the user-set manual search region, or None."""
        template_name = self._normalize(template_name)
        entry = self.data.get(template_name)
        if entry:
            return entry.get("region")
        return None

    def has_manual_region(self, template_name: str) -> bool:
        return self.get_manual_region(template_name) is not None

    def get_success_rate(self, template_name: str) -> float:
        template_name = self._normalize(template_name)
        entry = self.data.get(template_name)
        if entry:
            return entry.get("success_rate", 0.0)
        return 0.0

    def get_all_data(self) -> dict:
        return self.data

    def reset_template(self, template_name: str):
        template_name = self._normalize(template_name)
        if template_name in self.data:
            del self.data[template_name]
            self._save()
            self.logger.log(f"Reset learning data for: {template_name}")

    def rename_template(self, old_name: str, new_name: str):
        old_norm = self._normalize(old_name)
        new_norm = self._normalize(new_name)
        if old_norm in self.data:
            self.data[new_norm] = self.data.pop(old_norm)
            self._save()
            self.logger.log(f"Learning data renamed: {old_norm} -> {new_norm}")