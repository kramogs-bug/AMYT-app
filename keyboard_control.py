"""
automation/keyboard_control.py
Handles all keyboard input automation.

Uses pydirectinput for key presses (works in DirectX/DirectInput games)
and pyautogui for typing text.

Auto-focus behaviour (Jitbit-style)
------------------------------------
When a script starts via hotkey, the app records the foreground window HWND
at that exact moment via set_target_hwnd(). Every subsequent key send then
calls _ensure_target_focused() which brings that window back to the front
before sending input -- so keys always reach the game even though the macro
app is now in the foreground.

Call set_target_hwnd(None) on script stop to clear the target.
"""

import time
import pyautogui

try:
    import keyboard as _keyboard
    _KEYBOARD_AVAILABLE = True
except ImportError:
    _KEYBOARD_AVAILABLE = False

try:
    import pydirectinput
    pydirectinput.PAUSE = 0.02
    DIRECTINPUT_AVAILABLE = True
except ImportError:
    DIRECTINPUT_AVAILABLE = False

try:
    import win32gui, win32con
    import ctypes
    _WIN32_AVAILABLE = True
except ImportError:
    _WIN32_AVAILABLE = False

pyautogui.FAILSAFE = True
pyautogui.PAUSE    = 0.05

# Keys that pydirectinput supports via scan codes
DIRECTINPUT_KEYS = {
    'a','b','c','d','e','f','g','h','i','j','k','l','m',
    'n','o','p','q','r','s','t','u','v','w','x','y','z',
    '0','1','2','3','4','5','6','7','8','9',
    'f1','f2','f3','f4','f5','f6','f7','f8','f9','f10','f11','f12',
    'enter','return','space','tab','backspace','delete','escape','esc',
    'up','down','left','right',
    'home','end','pageup','pagedown','insert',
    'shift','ctrl','control','alt','win',
    'lshift','rshift','lctrl','rctrl','lalt','ralt',
    'capslock','numlock','scrolllock',
    'minus','equals','leftbracket','rightbracket','semicolon',
    'apostrophe','grave','backslash','comma','period','slash',
    'numpad0','numpad1','numpad2','numpad3','numpad4',
    'numpad5','numpad6','numpad7','numpad8','numpad9',
    'multiply','add','subtract','decimal','divide',
}


class KeyboardControl:
    def __init__(self, logger):
        self.logger = logger
        self._target_hwnd = None   # HWND captured at hotkey-press time

        if DIRECTINPUT_AVAILABLE:
            self.logger.log("KeyboardControl: pydirectinput active — DirectInput/game compatible")
        else:
            self.logger.log("KeyboardControl: pydirectinput missing, using pyautogui fallback", level="WARN")
        if not _WIN32_AVAILABLE:
            self.logger.log("KeyboardControl: pywin32 not found — auto-focus disabled", level="WARN")

    # ── Target window tracking ────────────────────────────

    def set_target_hwnd(self, hwnd):
        """
        Store the HWND to target for all key sends.
        Call with the foreground HWND at hotkey-press time.
        Call with None on script stop.
        """
        self._target_hwnd = hwnd
        if hwnd and _WIN32_AVAILABLE:
            try:
                title = win32gui.GetWindowText(hwnd)
                self.logger.log(
                    f"KeyboardControl: target window → '{title}' (hwnd={hwnd})"
                )
            except Exception:
                pass
        elif hwnd is None:
            self.logger.log("KeyboardControl: target window cleared")

    def _ensure_target_focused(self):
        """
        Bring the target window to the foreground before sending input.
        No-op if win32 unavailable or no target set.
        """
        if not self._target_hwnd or not _WIN32_AVAILABLE:
            return
        try:
            if win32gui.GetForegroundWindow() == self._target_hwnd:
                return   # already focused — nothing to do
            if win32gui.IsIconic(self._target_hwnd):
                win32gui.ShowWindow(self._target_hwnd, win32con.SW_RESTORE)
                time.sleep(0.05)
            ctypes.windll.user32.AllowSetForegroundWindow(-1)
            win32gui.SetForegroundWindow(self._target_hwnd)
            time.sleep(0.03)
        except Exception as e:
            self.logger.log(f"_ensure_target_focused: {e}", level="WARN")

    def _use_direct(self, key: str) -> bool:
        return DIRECTINPUT_AVAILABLE and key.lower() in DIRECTINPUT_KEYS

    # ── PRESS / HOLD / RELEASE ────────────────────────────

    def press(self, key: str):
        key = key.lower()
        self._ensure_target_focused()
        try:
            if self._use_direct(key):
                pydirectinput.press(key)
                self.logger.log(f"Key pressed (DirectInput): {key}")
            else:
                pyautogui.press(key)
                self.logger.log(f"Key pressed (pyautogui): {key}")
        except Exception as e:
            self.logger.log(f"press({key}) error: {e}", level="ERROR")

    def hold(self, key: str):
        key = key.lower()
        self._ensure_target_focused()
        try:
            if self._use_direct(key):
                pydirectinput.keyDown(key)
                self.logger.log(f"Key held (DirectInput): {key}")
            else:
                pyautogui.keyDown(key)
                self.logger.log(f"Key held (pyautogui): {key}")
        except Exception as e:
            self.logger.log(f"hold({key}) error: {e}", level="ERROR")

    def release(self, key: str):
        key = key.lower()
        try:
            if self._use_direct(key):
                pydirectinput.keyUp(key)
                self.logger.log(f"Key released (DirectInput): {key}")
            else:
                pyautogui.keyUp(key)
                self.logger.log(f"Key released (pyautogui): {key}")
        except Exception as e:
            self.logger.log(f"release({key}) error: {e}", level="ERROR")

    # ── TYPING ────────────────────────────────────────────

    def type_text(self, text: str, interval: float = 0.05):
        self._ensure_target_focused()
        # Always coerce to str — passing int/float to typewrite raises or silently
        # drops characters (e.g. "TYPE 12345" evaluates to int 12345 without this).
        text = str(text)
        if _KEYBOARD_AVAILABLE:
            # keyboard.write() handles digits, punctuation, unicode, and all
            # printable chars that pyautogui.typewrite() silently drops.
            _keyboard.write(text, delay=interval)
        else:
            # Fallback: pyautogui handles basic ASCII only; non-ASCII and some
            # special chars will be skipped.
            for char in text:
                try:
                    pyautogui.typewrite(char, interval=interval)
                except Exception:
                    pass   # skip unencodable char rather than crash
        self.logger.log(f"Typed: {text}")

    def type_with_delay(self, text: str, delay: float = 0.1):
        self._ensure_target_focused()
        text = str(text)
        if _KEYBOARD_AVAILABLE:
            _keyboard.write(text, delay=delay)
        else:
            for char in text:
                try:
                    pyautogui.typewrite(char, interval=delay)
                except Exception:
                    pass
        self.logger.log(f"Typed with delay: {text}")

    # ── HOTKEYS / COMBOS ──────────────────────────────────

    def hotkey(self, *keys):
        keys = [k.lower() for k in keys]
        self._ensure_target_focused()
        try:
            if DIRECTINPUT_AVAILABLE and all(k in DIRECTINPUT_KEYS for k in keys):
                for k in keys:
                    pydirectinput.keyDown(k)
                time.sleep(0.05)
                for k in reversed(keys):
                    pydirectinput.keyUp(k)
                self.logger.log(f"Hotkey (DirectInput): {'+'.join(keys)}")
            else:
                pyautogui.hotkey(*keys)
                self.logger.log(f"Hotkey (pyautogui): {'+'.join(keys)}")
        except Exception as e:
            self.logger.log(f"hotkey error: {e}", level="ERROR")

    def send_combo(self, combo_string: str):
        """Parse and send key combo like 'CTRL+C' or 'ALT+TAB'."""
        keys = [k.strip().lower() for k in combo_string.split('+')]
        self.hotkey(*keys)
