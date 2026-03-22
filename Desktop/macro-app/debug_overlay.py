"""
debug/debug_overlay.py
Real-time detection debug overlay.

Creates a transparent, always-on-top, click-through window that draws
bounding boxes, confidence scores, method tags, and a FPS counter
directly over the game screen — without interfering with mouse/keyboard.

Requirements
------------
    pip install pywin32      # Windows only (for click-through + transparency)

Quick start
-----------
    overlay = DebugOverlay(logger)
    overlay.start()

    # Inside your detection loop:
    overlay.push(results)    # results = list of find_on_screen() dicts

    overlay.stop()           # call on shutdown

Overlay dict format (compatible with find_on_screen / find_all_on_screen)
--------------------------------------------------------------------------
    {
        "x": int,           # center x
        "y": int,           # center y
        "rect": [x, y, w, h],
        "confidence": float,
        "confidence_smoothed": float,   # optional
        "method": str,      # "template" | "ORB" | "AKAZE"
        "template_name": str,           # optional label
    }

You can also call push_single() with a single result dict.

Colour coding
-------------
    Green   — template match, high confidence (≥ 0.85)
    Yellow  — template match, medium confidence (0.70–0.84)
    Orange  — feature match (ORB / AKAZE)
    Red     — low confidence (< 0.70)
    Cyan    — custom / labelled results

Controls (keyboard, when overlay window is focused)
-----  -----------------------------------------------
    O   — toggle overlay visibility
    C   — clear all boxes
    Q   — quit overlay
"""

import threading
import time
import queue
import sys
import os


# ── Platform check ────────────────────────────────────────────
_IS_WINDOWS = sys.platform == "win32"


def _try_import_win32():
    try:
        import win32api, win32con, win32gui
        return True
    except ImportError:
        return False


_WIN32_AVAILABLE = _IS_WINDOWS and _try_import_win32()


class DebugOverlay:
    """
    Transparent overlay window for real-time detection debugging.

    Thread-safe: push() can be called from any thread.
    The Tkinter UI runs in its own dedicated thread.
    """

    # Box colours  (R, G, B)
    _COLORS = {
        "high":    "#00FF66",   # bright green  — template, conf ≥ 0.85
        "medium":  "#FFE000",   # yellow        — template, conf 0.70–0.84
        "feature": "#FF9500",   # orange        — ORB / AKAZE
        "low":     "#FF3A3A",   # red           — conf < 0.70
        "custom":  "#00CFFF",   # cyan          — named / labelled
    }
    _FONT_COLOR  = "#FFFFFF"
    _BG_COLOR    = "#010101"   # near-black used as transparency key on Windows
    _FPS_COLOR   = "#AAFFAA"

    def __init__(self, logger, show_fps: bool = True,
                 box_alpha: float = 0.85,
                 max_results: int = 64):
        """
        Parameters
        ----------
        logger      : Logger (must have .log(msg, level=))
        show_fps    : Draw a live FPS counter in the top-left corner
        box_alpha   : Not used directly (Tkinter doesn't support per-widget
                      alpha); kept as API hook for future Cairo/pyglet port
        max_results : Maximum simultaneous boxes drawn
        """
        self.logger      = logger
        self.show_fps    = show_fps
        self.max_results = max_results

        self._result_queue: queue.Queue = queue.Queue(maxsize=128)
        self._stop_evt   = threading.Event()
        self._thread     = None
        self._visible    = True

        # Diagnostics
        self._frame_times: list = []
        self._fps         = 0.0

    # ── Public API ─────────────────────────────────────────────

    def start(self):
        """Spawn the overlay thread and return immediately."""
        if self._thread and self._thread.is_alive():
            return
        self._stop_evt.clear()
        self._thread = threading.Thread(
            target=self._run_overlay, daemon=True, name="debug-overlay"
        )
        self._thread.start()
        self.logger.log("DebugOverlay started")

    def stop(self):
        """Signal the overlay thread to shut down."""
        self._stop_evt.set()
        self.logger.log("DebugOverlay stopped")

    def push(self, results: list):
        """
        Feed a list of detection result dicts to the overlay.
        Non-blocking — drops oldest batch if the queue is full.
        """
        if not results:
            return
        capped = results[:self.max_results]
        try:
            self._result_queue.put_nowait(capped)
        except queue.Full:
            try:
                self._result_queue.get_nowait()
            except queue.Empty:
                pass
            try:
                self._result_queue.put_nowait(capped)
            except queue.Full:
                pass

    def push_single(self, result: dict):
        """Convenience wrapper — push a single result dict."""
        if result:
            self.push([result])

    def clear(self):
        """Remove all boxes from the overlay."""
        self.push([])

    def toggle_visible(self):
        self._visible = not self._visible

    # ── Overlay thread ─────────────────────────────────────────

    def _run_overlay(self):
        try:
            import tkinter as tk
        except ImportError:
            self.logger.log(
                "DebugOverlay: tkinter not available — overlay disabled",
                level="WARN"
            )
            return

        root = tk.Tk()
        root.title("Debug Overlay")
        root.attributes("-fullscreen", True)
        root.attributes("-topmost", True)
        root.configure(bg=self._BG_COLOR)
        root.overrideredirect(True)

        # Windows: make the background colour transparent + click-through
        if _WIN32_AVAILABLE:
            try:
                import ctypes, win32con, win32gui, win32api
                hwnd   = int(root.frame(), 16)
                style  = win32gui.GetWindowLong(hwnd, win32con.GWL_EXSTYLE)
                style |= win32con.WS_EX_LAYERED | win32con.WS_EX_TRANSPARENT
                win32gui.SetWindowLong(hwnd, win32con.GWL_EXSTYLE, style)
                # Colour key: #010101 becomes transparent
                r, g, b = 1, 1, 1
                color_key = win32api.RGB(r, g, b)
                ctypes.windll.user32.SetLayeredWindowAttributes(
                    hwnd, color_key, 255, win32con.LWA_COLORKEY
                )
            except Exception as e:
                self.logger.log(
                    f"DebugOverlay: win32 transparency failed: {e}",
                    level="WARN"
                )
        else:
            # macOS / Linux — best-effort transparency
            try:
                root.attributes("-alpha", 0.80)
            except Exception:
                pass

        canvas = tk.Canvas(
            root, bg=self._BG_COLOR,
            highlightthickness=0,
            cursor="none"
        )
        canvas.pack(fill="both", expand=True)

        # State
        current_results: list = []
        last_draw = time.perf_counter()

        def _color_for(result: dict) -> str:
            method = result.get("method", "template").lower()
            conf   = result.get("confidence", 0.0)
            name   = result.get("template_name", "")
            if name:
                return self._COLORS["custom"]
            if method in ("orb", "akaze"):
                return self._COLORS["feature"]
            if conf >= 0.85:
                return self._COLORS["high"]
            if conf >= 0.70:
                return self._COLORS["medium"]
            return self._COLORS["low"]

        def _draw():
            nonlocal current_results, last_draw

            if self._stop_evt.is_set():
                root.destroy()
                return

            # Drain queue — take latest batch
            try:
                while True:
                    current_results = self._result_queue.get_nowait()
            except queue.Empty:
                pass

            canvas.delete("all")

            if self._visible and current_results:
                for r in current_results:
                    rect = r.get("rect")
                    if not rect or len(rect) < 4:
                        continue
                    rx, ry, rw, rh = int(rect[0]), int(rect[1]), int(rect[2]), int(rect[3])
                    color = _color_for(r)

                    # Bounding box
                    canvas.create_rectangle(
                        rx, ry, rx + rw, ry + rh,
                        outline=color, width=2
                    )

                    # Label
                    conf_raw    = r.get("confidence", 0.0)
                    conf_smooth = r.get("confidence_smoothed")
                    method      = r.get("method", "tmpl")
                    name        = r.get("template_name", "")

                    if conf_smooth is not None:
                        label = f"{name+' ' if name else ''}{conf_raw:.2f}~{conf_smooth:.2f} [{method}]"
                    else:
                        label = f"{name+' ' if name else ''}{conf_raw:.2f} [{method}]"

                    # Shadow + text
                    canvas.create_text(
                        rx + 4, ry - 2,
                        text=label, anchor="sw",
                        fill="#000000", font=("Consolas", 9, "bold")
                    )
                    canvas.create_text(
                        rx + 3, ry - 3,
                        text=label, anchor="sw",
                        fill=color, font=("Consolas", 9, "bold")
                    )

                    # Centre dot
                    cx, cy = int(r.get("x", rx + rw // 2)), int(r.get("y", ry + rh // 2))
                    canvas.create_oval(cx-3, cy-3, cx+3, cy+3, fill=color, outline="")

            # FPS counter
            if self.show_fps:
                now = time.perf_counter()
                self._frame_times.append(now)
                # Keep only last second
                cutoff = now - 1.0
                self._frame_times = [t for t in self._frame_times if t > cutoff]
                fps = len(self._frame_times)
                count = len(current_results) if self._visible else 0
                fps_text = f"Overlay  {fps} fps  |  {count} box{'es' if count != 1 else ''}"
                canvas.create_text(
                    8, 8, text=fps_text, anchor="nw",
                    fill="#000000", font=("Consolas", 10, "bold")
                )
                canvas.create_text(
                    7, 7, text=fps_text, anchor="nw",
                    fill=self._FPS_COLOR, font=("Consolas", 10, "bold")
                )

            # Schedule next frame (~30 fps)
            root.after(33, _draw)

        # Keyboard shortcuts
        def _on_key(event):
            key = event.keysym.lower()
            if key == "o":
                self.toggle_visible()
            elif key == "c":
                self.clear()
            elif key == "q":
                self._stop_evt.set()

        root.bind("<Key>", _on_key)
        root.after(50, _draw)

        try:
            root.mainloop()
        except Exception as e:
            self.logger.log(f"DebugOverlay mainloop error: {e}", level="WARN")


# ── Convenience patcher ────────────────────────────────────────

def patch_image_detector(detector, overlay: DebugOverlay):
    """
    Monkey-patch an ImageDetector instance so every find_on_screen()
    and find_all_on_screen() call automatically feeds results to the
    overlay — zero changes to ImageDetector source required.

    Call after both objects are constructed:

        overlay  = DebugOverlay(logger)
        overlay.start()
        patch_image_detector(detector, overlay)
    """
    _orig_find    = detector.find_on_screen
    _orig_find_all = detector.find_all_on_screen

    def _patched_find(template_name, confidence=0.8, region=None, **kw):
        result = _orig_find(template_name, confidence, region=region, **kw)
        if result:
            result_with_name = dict(result, template_name=template_name)
            overlay.push_single(result_with_name)
        return result

    def _patched_find_all(template_name, confidence=0.8, region=None, **kw):
        results = _orig_find_all(template_name, confidence, region=region, **kw)
        if results:
            overlay.push([dict(r, template_name=template_name) for r in results])
        return results

    detector.find_on_screen    = _patched_find
    detector.find_all_on_screen = _patched_find_all

    detector.logger.log(
        "DebugOverlay: patched find_on_screen + find_all_on_screen"
    )
