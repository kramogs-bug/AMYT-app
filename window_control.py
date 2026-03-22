"""
automation/window_control.py
Window management — focus, minimize, maximize, close.

Uses pygetwindow for window enumeration and pywin32 (win32gui) for
reliable foreground activation, which works with DirectX/game windows
that pygetwindow.activate() sometimes fails to bring to front.

Install: pip install pygetwindow pywin32
"""

try:
    import pygetwindow as gw
    _GW_AVAILABLE = True
except ImportError:
    _GW_AVAILABLE = False

try:
    import win32gui, win32con, win32process
    import ctypes
    _WIN32_AVAILABLE = True
except ImportError:
    _WIN32_AVAILABLE = False

import time


class WindowControl:
    def __init__(self, logger):
        self.logger = logger

    # ── internal ──────────────────────────────────────────

    def _check(self):
        if not _GW_AVAILABLE:
            self.logger.log(
                "pygetwindow not installed. Run: pip install pygetwindow",
                level="WARN"
            )
            return False
        return True

    def _find_windows(self, title: str):
        """
        Return matching windows — exact first, then partial (case-insensitive).
        """
        if not _GW_AVAILABLE:
            return []
        exact = gw.getWindowsWithTitle(title)
        if exact:
            return exact
        tl = title.lower()
        return [w for w in gw.getAllWindows() if tl in w.title.lower() and w.title.strip()]

    def _force_foreground(self, hwnd):
        """
        Bring hwnd to the foreground using win32 API.
        Works reliably with DirectX games that ignore normal activate().
        Falls back gracefully if win32 is unavailable.
        """
        if not _WIN32_AVAILABLE:
            return
        try:
            # Allow SetForegroundWindow from this thread
            ctypes.windll.user32.AllowSetForegroundWindow(-1)
            # Restore if minimised
            placement = win32gui.GetWindowPlacement(hwnd)
            if placement[1] == win32con.SW_SHOWMINIMIZED:
                win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
                time.sleep(0.05)
            win32gui.SetForegroundWindow(hwnd)
            time.sleep(0.05)
        except Exception as e:
            self.logger.log(f"_force_foreground error: {e}", level="WARN")

    # ── public API ────────────────────────────────────────

    def get_all_windows(self):
        """Return sorted list of all visible window titles."""
        if not _GW_AVAILABLE:
            return []
        return sorted(
            {w.title for w in gw.getAllWindows() if w.title.strip()},
            key=str.lower
        )

    def focus_window(self, title: str) -> bool:
        """
        Bring a window to the foreground by title (exact or partial match).
        Returns True if the window was found and focused.
        """
        if not self._check():
            return False
        windows = self._find_windows(title)
        if not windows:
            self.logger.log(f"focus_window: no window matching '{title}'", level="WARN")
            return False
        w = windows[0]
        try:
            if _WIN32_AVAILABLE:
                hwnd = w._hWnd
                self._force_foreground(hwnd)
            else:
                w.activate()
                time.sleep(0.05)
            self.logger.log(f"Focused window: '{w.title}'")
            return True
        except Exception as e:
            self.logger.log(f"focus_window error: {e}", level="WARN")
            return False

    def get_foreground_title(self) -> str:
        """Return the title of the currently active/foreground window."""
        if _WIN32_AVAILABLE:
            try:
                hwnd = win32gui.GetForegroundWindow()
                return win32gui.GetWindowText(hwnd)
            except Exception:
                pass
        if _GW_AVAILABLE:
            try:
                active = gw.getActiveWindow()
                return active.title if active else ""
            except Exception:
                pass
        return ""

    def is_window_focused(self, title: str) -> bool:
        """Return True if a window matching title is currently in the foreground."""
        fg = self.get_foreground_title().lower()
        return title.lower() in fg

    def minimize_window(self, title: str):
        if not self._check(): return
        for w in self._find_windows(title):
            w.minimize()
            self.logger.log(f"Minimized: '{w.title}'")

    def maximize_window(self, title: str):
        if not self._check(): return
        for w in self._find_windows(title):
            w.maximize()
            self.logger.log(f"Maximized: '{w.title}'")

    def close_window(self, title: str):
        if not self._check(): return
        for w in self._find_windows(title):
            w.close()
            self.logger.log(f"Closed: '{w.title}'")
