"""
region_selector.py
Launches the overlay as a subprocess to avoid tkinter threading conflict
with pywebview. Communicates result via stdout.
"""

import subprocess
import sys
import os


class RegionSelector:
    def select(self):
        """
        Spawns a separate Python process that runs the tkinter overlay.
        Returns (x, y, w, h) or None if cancelled.
        """
        # Path to the helper script (same folder as this file)
        helper = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              "_region_helper.py")

        try:
            result = subprocess.run(
                [sys.executable, helper],
                capture_output=True,
                text=True,
                timeout=120   # 2 minute max wait
            )

            output = result.stdout.strip()

            if not output or output == "cancelled":
                return None

            # Output format: "x,y,w,h"
            parts = output.split(",")
            if len(parts) == 4:
                x, y, w, h = int(parts[0]), int(parts[1]), \
                             int(parts[2]), int(parts[3])
                return (x, y, w, h)

        except subprocess.TimeoutExpired:
            return None
        except Exception as e:
            print(f"RegionSelector error: {e}")
            return None

        return None