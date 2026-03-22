import sys
import os

# Works both from source and PyInstaller frozen .exe
if getattr(sys, 'frozen', False):
    ROOT_DIR = sys._MEIPASS                        # _internal/ — data files
    WORK_DIR = os.path.dirname(sys.executable)     # folder containing AMYT.exe

    # ── UTF-8 stdout/stderr fix ───────────────────────────────────────────────
    # Windows defaults stdout/stderr to cp1252 in frozen exes.  Any log message
    # containing characters outside cp1252 (e.g. → U+2192, × U+00D7) will raise
    # "charmap codec can't encode character" and crash the app.
    # Reconfigure both streams to UTF-8 with 'replace' fallback so a single
    # unencodable character never takes down the whole process.
    import io
    for _stream_name in ("stdout", "stderr"):
        _stream = getattr(sys, _stream_name, None)
        if _stream is not None:
            try:
                setattr(
                    sys, _stream_name,
                    io.TextIOWrapper(
                        _stream.buffer,
                        encoding="utf-8",
                        errors="replace",
                        line_buffering=True,
                    )
                )
            except AttributeError:
                # Stream has no .buffer (e.g. already a NullWriter) — leave it alone
                pass
else:
    ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
    WORK_DIR = ROOT_DIR

if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

os.chdir(WORK_DIR)   # storage/, logs/ created next to AMYT.exe

import webview
import threading

APP_VERSION = "1.0.1"

from macro_engine     import MacroEngine
from action_engine    import ActionEngine
from condition_engine import ConditionEngine
from image_detector   import ImageDetector
from screen_capture   import ScreenCapture
from mouse_control    import MouseControl
from keyboard_control import KeyboardControl
from learning_engine  import LearningEngine
from template_manager import TemplateManager
from logger           import Logger
from window_control   import WindowControl


class API:
    def __init__(self):
        self.logger       = Logger()
        self.mouse        = MouseControl(self.logger)
        self.keyboard     = KeyboardControl(self.logger)
        self.screen       = ScreenCapture(self.logger)
        self.detector     = ImageDetector(self.logger)
        self.learner      = LearningEngine(self.logger)
        self.window_ctrl  = WindowControl(self.logger)
        self.template_mgr = TemplateManager(self.logger, learner=self.learner)

        self.action_engine = ActionEngine(
            self.mouse, self.keyboard, self.detector, self.logger,
            learner=self.learner
        )
        self.condition_eng = ConditionEngine(self.detector, self.logger, learner=self.learner)
        self.macro_engine  = MacroEngine(
            self.action_engine,
            self.condition_eng,
            self.learner,
            self.logger
        )
        self.action_engine._stop_flag_ref = lambda: self.macro_engine._stop_flag
        self._macro_thread  = None
        self._detect_region = None
        self._window        = None
        self._hk_play       = None
        self._hk_stop       = None
        self._hk_pause      = None
        self._last_game_hwnd = None   # last foreground window that isn't this app

        # Background thread — continuously tracks the last non-app active window
        # so clicking the UI play button targets the correct game window
        self._start_window_tracker()
        self._coord_mouse_listener   = None
        self._toast_window     = None
        self._indicator_window = None

        import queue as _queue
        self._tk_queue  = _queue.Queue()
        self._tk_thread = None
        self._tk_ready  = threading.Event()
        self._tk_worker_start()
        self._coord_listener_active  = False
        self._kb_f2_registered       = False
        self._captured_coords        = []
        self._coords_lock = threading.Lock()

        self._script_running = False
        self._hotkey_last_trigger = {}   # {hotkey_string: last_time}
        self._hotkey_debounce = 0.5      # seconds

    # ── MACRO CONTROLS ────────────────────────────────────────

    def start_recording(self, countdown: int = 3):
        """Start recording with a countdown delay (default 3 seconds)."""
        import threading
        def _run():
            self.macro_engine.start_recording(countdown=int(countdown))
        threading.Thread(target=_run, daemon=True).start()
        return {"status": "recording", "countdown": int(countdown)}

    def stop_recording(self):
        script = self.macro_engine.stop_recording()
        return {"status": "stopped", "script": script}

    def pause_recording(self):
        self.macro_engine.pause_recording()
        return {"status": "paused"}

    def _start_window_tracker(self):
        """
        Background thread that watches the foreground window every 200ms.
        Stores the last window that is NOT this app — so when the user clicks
        the UI play button, we know which game window to target.
        """
        def _track():
            import time as _t
            while True:
                try:
                    import win32gui as _w
                    hwnd = _w.GetForegroundWindow()
                    # Ignore our own app window (set after webview creates it)
                    app_hwnd = None
                    if self._window:
                        try:
                            import win32gui as _wg
                            # pywebview window title
                            def _find(h, extra):
                                if _wg.IsWindowVisible(h):
                                    extra.append(h)
                            handles = []
                            _wg.EnumWindows(_find, handles)
                            # Match by checking if hwnd belongs to our process
                            import win32process as _wp
                            import os
                            pid = os.getpid()
                            for h in handles:
                                try:
                                    _, wpid = _wp.GetWindowThreadProcessId(h)
                                    if wpid == pid:
                                        app_hwnd = h
                                        break
                                except Exception:
                                    pass
                        except Exception:
                            pass

                    if hwnd and hwnd != app_hwnd and hwnd != 0:
                        title = ''
                        try:
                            import win32gui as _wg2
                            title = _wg2.GetWindowText(hwnd)
                        except Exception:
                            pass
                        # Skip taskbar, desktop, system windows
                        if title and title not in ('', 'Program Manager', 'Windows Input Experience'):
                            self._last_game_hwnd = hwnd
                except Exception:
                    pass
                _t.sleep(0.2)

        t = threading.Thread(target=_track, daemon=True, name="window-tracker")
        t.start()

    def run_script(self, script: str, repeat: int = 1):
        if (self._macro_thread and self._macro_thread.is_alive()
                and not self.macro_engine._stop_event.is_set()):
            return {"status": "error", "message": "Macro is already running"}
        # Use the last known non-app window as the keyboard target.
        # This works for both hotkey (game is still foreground) and
        # UI play button (game was foreground before user clicked the app).
        try:
            import win32gui as _w
            fg = _w.GetForegroundWindow()
            import os, win32process as _wp
            _, fg_pid = _wp.GetWindowThreadProcessId(fg)
            if fg_pid != os.getpid():
                # Triggered by hotkey — game is still in front, use it directly
                self.keyboard.set_target_hwnd(fg)
                self.logger.log(
                    f"run_script: target = foreground '{_w.GetWindowText(fg)}'"
                )
            elif self._last_game_hwnd:
                # Triggered from UI — use the last tracked game window
                self.keyboard.set_target_hwnd(self._last_game_hwnd)
                self.logger.log(
                    f"run_script: target = last game window "
                    f"'{_w.GetWindowText(self._last_game_hwnd)}'"
                )
        except Exception:
            pass  # pywin32 not installed — keys work normally without focus
        self._script_running = True
        self._macro_thread = threading.Thread(
            target=self._run_script_thread,
            args=(script, int(repeat)),
            daemon=True
        )
        self._macro_thread.start()
        return {"status": "running"}

    def run_script_from_line(self, script: str, line: int, repeat: int = 1):
        """
        Run script starting from a specific 0-based original line number.
        Called by Run from Cursor in the editor.
        """
        if (self._macro_thread and self._macro_thread.is_alive()
                and not self.macro_engine._stop_event.is_set()):
            return {"status": "error", "message": "Macro is already running"}
        try:
            import win32gui as _w, win32process as _wp, os as _os
            fg = _w.GetForegroundWindow()
            _, fg_pid = _wp.GetWindowThreadProcessId(fg)
            if fg_pid != _os.getpid():
                self.keyboard.set_target_hwnd(fg)
            elif self._last_game_hwnd:
                self.keyboard.set_target_hwnd(self._last_game_hwnd)
        except Exception:
            pass
        self._script_running = True
        self._macro_thread = threading.Thread(
            target=self._run_script_from_line_thread,
            args=(script, int(line), int(repeat)),
            daemon=True
        )
        self._macro_thread.start()
        return {"status": "running", "from_line": line}

    def _run_script_from_line_thread(self, script: str, line: int, repeat: int):
        try:
            def on_finish():
                self._script_running = False
                self.keyboard.set_target_hwnd(None)
                try:
                    if self._window:
                        self._window.evaluate_js("onScriptFinished()")
                except Exception as e:
                    self.logger.log(f"Finish callback error: {e}", level="WARN")

            def on_stop():
                self._script_running = False
                self.keyboard.set_target_hwnd(None)
                try:
                    if self._window:
                        self._window.evaluate_js("onScriptStopped()")
                except Exception as e:
                    self.logger.log(f"Stop callback error: {e}", level="WARN")

            self.macro_engine.run_script(
                script, repeat=repeat,
                on_finish=on_finish, on_stop=on_stop,
                start_from_line=line
            )
        except Exception as e:
            self.logger.log(f"Run-from-line crashed: {e}", level="ERROR")
            self._script_running = False
            try:
                if self._window:
                    self._window.evaluate_js("onScriptError()")
            except Exception:
                pass
        """Focus the target game window if auto_focus is enabled and a window is configured."""
        try:
            settings = self.get_movement_settings()
            if not settings.get("auto_focus", True):
                return
            title = settings.get("target_window", "").strip()
            if not title:
                return
            ok = self.window_ctrl.focus_window(title)
            if ok:
                import time as _t
                _t.sleep(0.3)  # let the OS bring window to front before keys start
        except Exception as e:
            self.logger.log(f"auto_focus error: {e}", level="WARN")

    def _run_script_thread(self, script: str, repeat: int):
        try:
            def on_finish():
                self._script_running = False
                self.keyboard.set_target_hwnd(None)  # clear focus target
                try:
                    if self._window:
                        self._window.evaluate_js("onScriptFinished()")
                except Exception as e:
                    self.logger.log(f"Finish callback error: {e}", level="WARN")

            def on_stop():
                self._script_running = False
                self.keyboard.set_target_hwnd(None)  # clear focus target
                try:
                    if self._window:
                        self._window.evaluate_js("onScriptStopped()")
                except Exception as e:
                    self.logger.log(f"Stop callback error: {e}", level="WARN")

            self.macro_engine.run_script(script, repeat=repeat, on_finish=on_finish, on_stop=on_stop)
        except Exception as e:
            self.logger.log(f"Script crashed: {e}", level="ERROR")
            self._script_running = False
            try:
                if self._window:
                    self._window.evaluate_js("onScriptError()")
            except Exception:
                pass

    def start_debug(self, script: str, repeat: int = 1):
        """Start script in step‑through debug mode."""
        if (self._macro_thread and self._macro_thread.is_alive()
                and not self.macro_engine._stop_event.is_set()):
            return {"status": "error", "message": "Macro is already running"}
        self._macro_thread = threading.Thread(
            target=self._start_debug_thread,
            args=(script, int(repeat)),
            daemon=True
        )
        self._macro_thread.start()
        return {"status": "debugging"}

    def _start_debug_thread(self, script: str, repeat: int):
        try:
            def on_finish():
                try:
                    if self._window:
                        self._window.evaluate_js("onScriptFinished()")
                except Exception as e:
                    self.logger.log(f"Finish callback error: {e}", level="WARN")

            self.macro_engine.start_debug(script, repeat=repeat, on_finish=on_finish)
        except Exception as e:
            self.logger.log(f"Debug script crashed: {e}", level="ERROR")
            try:
                if self._window:
                    self._window.evaluate_js("onScriptError()")
            except Exception:
                pass

    def start_debug_with_breakpoints(self, script: str, breakpoints: list, repeat: int = 1):
        """Start debug mode with breakpoints (list of original line numbers)."""
        if (self._macro_thread and self._macro_thread.is_alive()
                and not self.macro_engine._stop_event.is_set()):
            return {"status": "error", "message": "Macro is already running"}
        self._macro_thread = threading.Thread(
            target=self._start_debug_with_breakpoints_thread,
            args=(script, breakpoints, int(repeat)),
            daemon=True
        )
        self._macro_thread.start()
        return {"status": "debugging"}

    def _start_debug_with_breakpoints_thread(self, script: str, breakpoints: list, repeat: int):
        try:
            def on_finish():
                try:
                    if self._window:
                        self._window.evaluate_js("onScriptFinished()")
                except Exception as e:
                    self.logger.log(f"Finish callback error: {e}", level="WARN")

            self.macro_engine.start_debug_with_breakpoints(script, breakpoints, repeat=repeat, on_finish=on_finish)
        except Exception as e:
            self.logger.log(f"Debug script crashed: {e}", level="ERROR")
            try:
                if self._window:
                    self._window.evaluate_js("onScriptError()")
            except Exception:
                pass

    def debug_step(self):
        """Execute one step in debug mode."""
        self.macro_engine.debug_step()
        return {"status": "ok"}

    def debug_continue(self):
        """Continue running in debug mode."""
        self.macro_engine.debug_continue()
        return {"status": "ok"}

    def get_vars_snapshot(self):
        """Return all current script variables for the debugger watch panel."""
        try:
            return {"status": "ok", "vars": self.macro_engine.get_vars_snapshot()}
        except Exception as e:
            return {"status": "error", "vars": {}, "message": str(e)}

    def get_last_error_line(self):
        """Return the 0-based line index of the last script error, or -1."""
        return {"line": self.macro_engine.get_last_error_line()}

    def validate_script(self, script: str):
        """
        Pre-flight validation of a script before running it.
        Returns a list of issues: [{line, col, severity, message}, ...]
        severity: 'error' | 'warning'
        """
        issues = []
        templates = {t["name"].replace(".png","") for t in self.template_mgr.list_templates()}
        lines = script.split("\n")

        # All commands the engine knows about
        KNOWN_CMDS = {
            "CLICK","DOUBLE_CLICK","RIGHT_CLICK","MOVE","MOVE_HUMAN","SCROLL","DRAG",
            "TYPE","PRESS","HOLD","RELEASE","HOTKEY",
            "CLICK_IMAGE","DOUBLE_CLICK_IMAGE","RIGHT_CLICK_IMAGE",
            "WAIT_IMAGE","WAIT_IMAGE_GONE","NAVIGATE_TO_IMAGE",
            "FIND_CLICK","FIND_DOUBLE_CLICK","FIND_RIGHT_CLICK",
            "FIND_MOVE","FIND_HOLD","FIND_DRAG",
            "TEXT_CLICK","TEXT_DOUBLE_CLICK","TEXT_RIGHT_CLICK",
            "TEXT_MOVE","TEXT_HOLD","TEXT_DRAG",
            "COLOR_CLICK","COLOR_DOUBLE_CLICK","COLOR_RIGHT_CLICK",
            "COLOR_MOVE","COLOR_HOLD","COLOR_DRAG","WAIT_COLOR","READ_COLOR",
            "SET","READ_TEXT","CLIPBOARD_SET","CLIPBOARD_GET",
            "CLIPBOARD_COPY","CLIPBOARD_PASTE",
            "WAIT","WAIT_RANDOM","REPEAT","LOOP","END","ELSE","LABEL","GOTO","STOP",
            "PAUSE_SCRIPT","TOAST","IF_IMAGE","IF_NOT_IMAGE","WHILE_IMAGE",
            "IF_VAR","WHILE_VAR","REPEAT_UNTIL","ON_ERROR",
        }
        IMAGE_CMDS = {
            "CLICK_IMAGE","DOUBLE_CLICK_IMAGE","RIGHT_CLICK_IMAGE",
            "WAIT_IMAGE","WAIT_IMAGE_GONE","NAVIGATE_TO_IMAGE",
            "FIND_CLICK","FIND_DOUBLE_CLICK","FIND_RIGHT_CLICK",
            "FIND_MOVE","FIND_HOLD","FIND_DRAG","IF_IMAGE","IF_NOT_IMAGE","WHILE_IMAGE",
        }
        BLOCK_OPENERS = {"IF_IMAGE","IF_NOT_IMAGE","IF_VAR","LOOP","REPEAT",
                         "REPEAT_UNTIL","WHILE_IMAGE","WHILE_VAR","ON_ERROR"}
        BLOCK_CLOSERS = {"END"}
        BLOCK_MID    = {"ELSE"}

        block_stack = []
        defined_labels = set()
        used_gotos     = []

        for idx, raw in enumerate(lines):
            stripped = raw.strip()
            if not stripped or stripped.startswith("#"):
                continue
            parts = stripped.split()
            cmd   = parts[0].upper()

            # Unknown command
            if cmd not in KNOWN_CMDS:
                issues.append({"line": idx, "severity": "error",
                                "message": f"Unknown command: {cmd}"})
                continue

            # Image commands referencing a missing template
            if cmd in IMAGE_CMDS and len(parts) > 1:
                tpl_name = parts[1].replace(".png","")
                if tpl_name and not tpl_name.startswith("$") and tpl_name not in templates:
                    issues.append({"line": idx, "severity": "warning",
                                   "message": f"Template not found: '{tpl_name}.png'"})

            # Block depth tracking
            if cmd in BLOCK_OPENERS:
                block_stack.append((cmd, idx))
            elif cmd in BLOCK_CLOSERS:
                if not block_stack:
                    issues.append({"line": idx, "severity": "error",
                                   "message": "END without a matching IF/LOOP/REPEAT/WHILE"})
                else:
                    block_stack.pop()

            # LABEL tracking
            if cmd == "LABEL" and len(parts) > 1:
                defined_labels.add(parts[1].upper())
            if cmd == "GOTO" and len(parts) > 1:
                used_gotos.append((parts[1].upper(), idx))

            # WAIT with obviously wrong values
            if cmd == "WAIT" and len(parts) > 1:
                try:
                    val = float(parts[1])
                    if val > 300:
                        issues.append({"line": idx, "severity": "warning",
                                       "message": f"WAIT {val}s is very long — did you mean {val/60:.0f} minutes?"})
                except ValueError:
                    pass

            # SET missing = sign
            if cmd == "SET" and ("=" not in stripped):
                issues.append({"line": idx, "severity": "error",
                                "message": "SET requires format: SET variable = value"})

        # Unclosed blocks
        for opener_cmd, opener_line in block_stack:
            issues.append({"line": opener_line, "severity": "error",
                           "message": f"{opener_cmd} block is never closed with END"})

        # GOTO to undefined label
        for label_name, goto_line in used_gotos:
            if label_name not in defined_labels:
                issues.append({"line": goto_line, "severity": "warning",
                               "message": f"GOTO '{label_name}' — no matching LABEL found"})

        return {"status": "ok", "issues": issues}

    def stop_macro(self):
        self.macro_engine.stop()
        return {"status": "stopped"}

    # ── NATIVE TOAST POPUP ────────────────────────────────

    def show_toast(self, message: str, kind: str = "info", duration: int = 3000):
        """
        Show a floating toast notification. Falls back to main window toast if popup fails.
        """
        if self._toast_window:
            try:
                import json as _json
                safe_message = _json.dumps(message)
                safe_kind    = _json.dumps(kind)
                js = f"showToast({safe_message}, {safe_kind}, {duration})"
                self._toast_window.show()
                self._toast_window.evaluate_js(js)
                return {"status": "ok"}
            except Exception as e:
                self.logger.log(f"Native toast failed, falling back to in‑page toast: {e}", level="WARN")
        
        # Fallback to main window toast
        if self._window:
            try:
                import json as _json
                safe_message = _json.dumps(message)
                safe_kind    = _json.dumps(kind)
                self._window.evaluate_js(f"toast({safe_message}, {safe_kind})")
                return {"status": "ok"}
            except Exception as e:
                self.logger.log(f"In‑page toast also failed: {e}", level="ERROR")
        
        return {"status": "error", "message": "No window available"}

    def hide_toast_window(self):
        try:
            if self._toast_window:
                self._toast_window.hide()
        except Exception:
            pass
        return {"status": "hidden"}

    def close_toast_window(self):
        return self.hide_toast_window()

    # ── MACRO INDICATOR WINDOW ────────────────────────────────

    def show_indicator(self):
        try:
            if self._indicator_window:
                self._indicator_window.show()
                try:
                    self._indicator_window.evaluate_js("setPaused(false)")
                except Exception:
                    pass
            # Only hide main window if script is still running
            if self._script_running and self._window:
                self._window.hide()
        except Exception as e:
            self.logger.log(f"show_indicator error: {e}", level="WARN")
        return {"status": "ok"}

    def hide_indicator(self):
        try:
            if self._indicator_window:
                self._indicator_window.hide()
            if self._window:
                self._window.show()
        except Exception as e:
            self.logger.log(f"hide_indicator error: {e}", level="WARN")
        return {"status": "ok"}

    def indicator_stop(self):
        self.macro_engine.stop()
        if self._indicator_window:
            try:
                self._indicator_window.evaluate_js("setPaused(false)")
            except Exception:
                pass
        self.hide_indicator()
        def _notify():
            try:
                if self._window:
                    self._window.evaluate_js("onScriptStopped()")
            except Exception:
                pass
        import threading as _t
        _t.Thread(target=_notify, daemon=True).start()
        return {"status": "ok"}

    def indicator_close(self):
        def _fire():
            try:
                if self._indicator_window:
                    self._indicator_window.hide()
                if self._window:
                    self._window.show()
            except Exception as e:
                self.logger.log(f"indicator_close error: {e}", level="WARN")
        import threading as _t
        _t.Thread(target=_fire, daemon=True).start()
        return {"status": "ok"}

    def pause_script(self):
        self.macro_engine.pause_script()
        self._notify_indicator_pause(True)
        return {"status": "paused"}

    def resume_script(self):
        self.macro_engine.resume_script()
        self._notify_indicator_pause(False)
        return {"status": "resumed"}

    def _notify_indicator_pause(self, paused: bool):
        if not self._indicator_window:
            return
        js = f"setPaused({'true' if paused else 'false'})"
        def _fire():
            try:
                self._indicator_window.evaluate_js(js)
            except Exception as e:
                self.logger.log(f"_notify_indicator_pause error: {e}", level="WARN")
        import threading as _t
        _t.Thread(target=_fire, daemon=True).start()

    def is_script_paused(self):
        return {"paused": self.macro_engine._paused}

    def save_file_dialog_path(self, path: str, content: str):
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
            bundled = self._bundle_templates(path, content)
            return {"status": "ok", "name": os.path.basename(path), "templates_bundled": bundled}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    # ── THREAD-SAFE TKINTER DISPATCHER ─────────────────────────

    def _tk_worker_start(self):
        def _worker():
            import tkinter as tk
            import queue

            root = tk.Tk()
            root.withdraw()
            root.attributes('-topmost', True)
            root.protocol("WM_DELETE_WINDOW", lambda: None)
            self._tk_root = root
            self._tk_ready.set()

            def _poll():
                try:
                    while True:
                        fn, result_holder, event = self._tk_queue.get_nowait()
                        try:
                            result_holder[0] = fn(root)
                        except Exception as e:
                            self.logger.log(f"TK dialog error: {e}", level="ERROR")
                            result_holder[0] = None
                        finally:
                            event.set()
                except queue.Empty:
                    pass
                root.after(50, _poll)

            root.after(0, _poll)
            root.mainloop()

        self._tk_thread = threading.Thread(target=_worker, daemon=True,
                                           name="tkinter-worker")
        self._tk_thread.start()
        self._tk_ready.wait(timeout=5)

    def _run_tkinter_dialog(self, dialog_fn):
        if not hasattr(self, '_tk_root') or not self._tk_root:
            self.logger.log("tkinter worker not ready", level="ERROR")
            return None

        result_holder = [None]
        event = threading.Event()
        self._tk_queue.put((dialog_fn, result_holder, event))
        event.wait(timeout=180)
        return result_holder[0]

    def open_file_dialog(self):
        from tkinter import filedialog
        import os

        path = self._run_tkinter_dialog(
            lambda root: filedialog.askopenfilename(
                title="Load Script",
                initialdir=os.path.join(os.getcwd(), "storage", "scripts"),
                filetypes=[("Text scripts", "*.txt"), ("All files", "*.*")]
            )
        )
        if not path:
            return {"status": "cancelled"}
        try:
            with open(path, "r", encoding="utf-8") as f:
                content = f.read()
            name = os.path.basename(path)
            restored = self._restore_templates(path, content)
            self.logger.log(f"Script loaded via dialog: {name} (templates restored: {restored})")
            return {"status": "ok", "name": name, "content": content,
                    "path": path, "templates_restored": restored}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    def save_file_dialog(self, content: str):
        from tkinter import filedialog
        import os

        path = self._run_tkinter_dialog(
            lambda root: filedialog.asksaveasfilename(
                title="Save Script",
                initialdir=os.path.join(os.getcwd(), "storage", "scripts"),
                defaultextension=".txt",
                filetypes=[("Text scripts", "*.txt"), ("All files", "*.*")]
            )
        )
        if not path:
            return {"status": "cancelled"}
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
            name = os.path.basename(path)
            bundled = self._bundle_templates(path, content)
            self.logger.log(f"Script saved via dialog: {name} (templates bundled: {bundled})")
            return {"status": "ok", "name": name, "path": path,
                    "templates_bundled": bundled}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    def save_script_dialog(self, content: str):
        """Alias for save_file_dialog — used by the close-confirmation flow."""
        return self.save_file_dialog(content)

    def save_and_close(self, name: str, script_content: str):
        """Called by JS: save the named script then shut down cleanly."""
        try:
            self.save_script(name, script_content)
            self.logger.log(f"Saved '{name}' before close")
        except Exception as e:
            self.logger.log(f"save_and_close error: {e}", level="ERROR")
        self._shutdown()

    def _extract_template_names(self, script_content: str):
        import re
        pattern = r'(?:CLICK_IMAGE|DOUBLE_CLICK_IMAGE|RIGHT_CLICK_IMAGE|WAIT_IMAGE(?:_GONE)?|IF_IMAGE|IF_NOT_IMAGE|WHILE_IMAGE|FIND_CLICK|FIND_DOUBLE_CLICK|FIND_RIGHT_CLICK|FIND_MOVE|FIND_HOLD|FIND_DRAG)\s+(\S+)'
        names = re.findall(pattern, script_content, re.IGNORECASE)
        result = []
        for n in names:
            if not n.lower().endswith(('.png', '.jpg', '.jpeg', '.bmp')):
                n = n + '.png'
            if n not in result:
                result.append(n)
        return result

    def _bundle_templates(self, script_path: str, content: str) -> int:
        import os, shutil
        names   = self._extract_template_names(content)
        src_dir = os.path.join(os.getcwd(), "storage", "templates")
        stem    = os.path.splitext(script_path)[0]
        dst_dir = stem + "_templates"
        if not names:
            return 0
        os.makedirs(dst_dir, exist_ok=True)
        count = 0
        for name in names:
            src = os.path.join(src_dir, name)
            if os.path.exists(src):
                shutil.copy2(src, os.path.join(dst_dir, name))
                count += 1
            else:
                self.logger.log(f"Template not found for bundling: {name}", level="WARN")
        return count

    def _restore_templates(self, script_path: str, content: str) -> int:
        import os, shutil
        stem    = os.path.splitext(script_path)[0]
        src_dir = stem + "_templates"
        dst_dir = os.path.join(os.getcwd(), "storage", "templates")
        if not os.path.isdir(src_dir):
            return 0
        os.makedirs(dst_dir, exist_ok=True)
        count = 0
        names = self._extract_template_names(content)
        for name in names:
            safe_name = os.path.basename(name)
            if not safe_name or ".." in safe_name:
                self.logger.log(f"Skipping unsafe template name: {name}", level="WARN")
                continue
            src = os.path.join(src_dir, safe_name)
            if os.path.exists(src):
                dst = os.path.join(dst_dir, safe_name)
                if not os.path.exists(dst) or os.path.getmtime(src) > os.path.getmtime(dst):
                    shutil.copy2(src, dst)
                    count += 1
        return count

    # ── FILE SAVE / LOAD ──────────────────────────────────────

    @staticmethod
    def _sanitize_script_name(name: str):
        import os as _os
        safe = _os.path.basename(name.strip())
        if not safe or safe.startswith(".") or "/" in safe or "\\" in safe:
            return None
        return safe

    def save_script(self, name: str, content: str):
        import os
        os.makedirs("storage/scripts", exist_ok=True)
        safe_name = self._sanitize_script_name(name)
        if not safe_name:
            return {"status": "error", "message": "Invalid script name"}
        if not safe_name.endswith(".txt"):
            safe_name += ".txt"
        path = os.path.join("storage", "scripts", safe_name)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        self.logger.log(f"Script saved: {safe_name}")
        return {"status": "ok", "name": safe_name}

    def load_script(self, name: str):
        import os
        safe_name = self._sanitize_script_name(name)
        if not safe_name:
            return {"status": "error", "message": "Invalid script name"}
        if not safe_name.endswith(".txt"):
            safe_name += ".txt"
        path = os.path.join("storage", "scripts", safe_name)
        if not os.path.exists(path):
            return {"status": "error", "message": f"\'{safe_name}\' not found"}
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
        self.logger.log(f"Script loaded: {safe_name}")
        return {"status": "ok", "name": safe_name, "content": content}

    def list_scripts(self):
        import os
        os.makedirs("storage/scripts", exist_ok=True)
        scripts = []
        for fname in sorted(os.listdir("storage/scripts")):
            if fname.endswith(".txt"):
                fpath = os.path.join("storage", "scripts", fname)
                scripts.append({
                    "name": fname,
                    "size": os.path.getsize(fpath)
                })
        return {"scripts": scripts}

    def delete_script(self, name: str):
        import os
        safe_name = self._sanitize_script_name(name)
        if not safe_name:
            return {"status": "error", "message": "Invalid script name"}
        if not safe_name.endswith(".txt"):
            safe_name += ".txt"
        path = os.path.join("storage", "scripts", safe_name)
        if os.path.exists(path):
            os.remove(path)
            self.logger.log(f"Script deleted: {safe_name}")
        return {"status": "ok"}

    # ── SETTINGS (shortcuts) ──────────────────────────────────

    def get_settings(self):
        import json, os
        path = os.path.join("storage", "settings.json")
        defaults = {
            "shortcut_play":   "ctrl+r",
            "shortcut_stop":   "ctrl+q",
            "shortcut_pause":  "ctrl+p",
            "log_cooldown":    10.0,
        }
        if os.path.exists(path):
            with open(path, "r") as f:
                saved = json.load(f)
            defaults.update(saved)
        return defaults

    def save_settings(self, settings: dict):
        import json, os
        path = os.path.join("storage", "settings.json")
        with open(path, "w") as f:
            json.dump(settings, f, indent=2)
        self.logger.log("Settings saved")
        self._register_hotkeys(settings)
        self.logger._log_cooldown = settings.get("log_cooldown", 10.0)
        return {"status": "ok"}

    def _register_hotkeys(self, settings=None):
        try:
            import keyboard as kb
            import time  # ensure time is imported (should already be at top)

            # Remove any previously registered hotkeys
            for attr in ('_hk_play', '_hk_stop', '_hk_pause'):
                hk = getattr(self, attr, None)
                if hk:
                    try: kb.remove_hotkey(hk)
                    except Exception: pass

            if settings is None:
                settings = self.get_settings()

            self._hk_play  = settings.get("shortcut_play",  "ctrl+r")
            self._hk_stop  = settings.get("shortcut_stop",  "ctrl+q")
            self._hk_pause = settings.get("shortcut_pause", "ctrl+p")

            # Debounced callback factory
            def make_callback(hotkey, js_func):
                def callback():
                    now = time.time()
                    last = self._hotkey_last_trigger.get(hotkey, 0)
                    if now - last < self._hotkey_debounce:
                        return
                    self._hotkey_last_trigger[hotkey] = now

                    # ── Capture active window HWND right now (Jitbit-style) ──
                    # The game is still in the foreground at this exact moment.
                    if js_func == "globalHotkeyPlay()":
                        try:
                            import win32gui as _w
                            hwnd = _w.GetForegroundWindow()
                            self._last_game_hwnd = hwnd  # also update tracker
                            self.keyboard.set_target_hwnd(hwnd)
                            self.logger.log(
                                f"Hotkey: captured game window "
                                f"'{_w.GetWindowText(hwnd)}' (hwnd={hwnd})"
                            )
                        except Exception:
                            pass

                    if self._window:
                        self._window.evaluate_js(js_func)
                return callback

            kb.add_hotkey(self._hk_play,  make_callback(self._hk_play, "globalHotkeyPlay()"),  suppress=False)
            kb.add_hotkey(self._hk_stop,  make_callback(self._hk_stop, "globalHotkeyStop()"),  suppress=False)
            kb.add_hotkey(self._hk_pause, make_callback(self._hk_pause, "globalHotkeyPause()"), suppress=False)

            self.logger.log(
                f"Hotkeys registered (debounced): play={self._hk_play} "
                f"stop={self._hk_stop} pause={self._hk_pause}"
            )
        except Exception as e:
            self.logger.log(f"Hotkey registration error: {e}", level="WARN")

    # ── SCREEN CAPTURE ────────────────────────────────────────

    def capture_screen(self):
        """Return a fullscreen screenshot as base64 JPEG."""
        import base64, io
        from PIL import Image
        import mss

        with mss.mss() as sct:
            monitor = sct.monitors[1]
            shot = sct.grab(monitor)
            img = Image.frombytes('RGB', shot.size, shot.rgb)
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=70)
            b64 = base64.b64encode(buf.getvalue()).decode()
            return {"status": "ok", "screen": f"data:image/jpeg;base64,{b64}"}

    def capture_fullscreen(self):
        path = self.screen.capture_fullscreen()
        return {"status": "ok", "path": path}

    def capture_region(self, x: int, y: int, w: int, h: int):
        path = self.screen.capture_region(int(x), int(y), int(w), int(h))
        return {"status": "ok", "path": path}

    def save_as_template(self, x: int, y: int, w: int, h: int, name: str):
        path = self.screen.save_as_template(int(x), int(y), int(w), int(h), name)
        return {"status": "ok", "path": path}

    def _run_region_selector(self):
        import threading
        from region_selector import RegionSelector

        result = [None]
        event = threading.Event()

        def _thread():
            selector = RegionSelector()
            result[0] = selector.select()
            event.set()

        t = threading.Thread(target=_thread, daemon=True)
        t.start()
        event.wait(timeout=180)
        return result[0]

    def select_and_capture(self, name: str):
        import time

        if not name or not name.strip():
            return {"status": "error", "message": "Enter a template name first"}

        name = name.strip().replace(" ", "_")

        region = self._run_region_selector()
        if region is None:
            return {"status": "cancelled"}

        x, y, w, h = region
        if w <= 0 or h <= 0:
            return {"status": "error", "message": f"Invalid region size: {w}×{h}"}

        time.sleep(0.4)

        try:
            path = self.screen.save_as_template(int(x), int(y), int(w), int(h), name)
        except Exception as e:
            self.logger.log(f"Capture failed: {e}", level="ERROR")
            return {"status": "error", "message": str(e)}

        self.logger.log(f"Drag-captured: '{name}' ({w}x{h}) at ({x},{y})")
        return {"status": "ok", "path": path, "x": x, "y": y, "w": w, "h": h}

    # ── TEMPLATE PREVIEW ──────────────────────────────────────

    def get_template_preview(self, name: str):
        import base64

        if not name.endswith(".png"):
            name += ".png"
        path = os.path.join("storage", "templates", name)
        if not os.path.exists(path):
            return {"status": "error", "message": f"{name} not found"}

        with open(path, "rb") as f:
            encoded = base64.b64encode(f.read()).decode("utf-8")
        return {"status": "ok", "name": name, "data": f"data:image/png;base64,{encoded}"}

    # ── ROTATE / FLIP ─────────────────────────────────────────

    def rotate_template(self, name: str, angle: int, overwrite: bool = True):
        """
        Rotate a template image by angle degrees (90, 180, 270 clockwise).
        If overwrite=True, replaces the file and keeps a backup.
        Returns base64 preview of the result.
        """
        import base64, io, shutil
        from PIL import Image
        if not name.endswith('.png'):
            name += '.png'
        path   = os.path.join('storage', 'templates', name)
        backup = path.replace('.png', '_pre_rotate_backup.png')
        if not os.path.exists(path):
            return {'status': 'error', 'message': f'{name} not found'}
        try:
            img = Image.open(path).convert('RGBA')
            # PIL rotates counter-clockwise; negate for clockwise
            rotated = img.rotate(-angle, expand=True)
            if overwrite:
                if not os.path.exists(backup):
                    shutil.copy2(path, backup)
                rotated.save(path)
                self.logger.log(f'Rotated {name} by {angle}°')
            buf = io.BytesIO()
            rotated.save(buf, format='PNG')
            b64 = base64.b64encode(buf.getvalue()).decode()
            return {'status': 'ok', 'name': name,
                    'data': f'data:image/png;base64,{b64}'}
        except Exception as e:
            return {'status': 'error', 'message': str(e)}

    def flip_template(self, name: str, direction: str, overwrite: bool = True):
        """
        Flip a template image. direction = 'horizontal' or 'vertical'.
        """
        import base64, io, shutil
        from PIL import Image
        if not name.endswith('.png'):
            name += '.png'
        path   = os.path.join('storage', 'templates', name)
        backup = path.replace('.png', '_pre_flip_backup.png')
        if not os.path.exists(path):
            return {'status': 'error', 'message': f'{name} not found'}
        try:
            img = Image.open(path).convert('RGBA')
            if direction == 'horizontal':
                flipped = img.transpose(Image.FLIP_LEFT_RIGHT)
            elif direction == 'vertical':
                flipped = img.transpose(Image.FLIP_TOP_BOTTOM)
            else:
                return {'status': 'error', 'message': f'Unknown direction: {direction}'}
            if overwrite:
                if not os.path.exists(backup):
                    shutil.copy2(path, backup)
                flipped.save(path)
                self.logger.log(f'Flipped {name} {direction}')
            buf = io.BytesIO()
            flipped.save(buf, format='PNG')
            b64 = base64.b64encode(buf.getvalue()).decode()
            return {'status': 'ok', 'name': name,
                    'data': f'data:image/png;base64,{b64}'}
        except Exception as e:
            return {'status': 'error', 'message': str(e)}

    def restore_template_backup(self, name: str):
        """Restore a template from its pre-rotate/flip backup if one exists."""
        import shutil
        if not name.endswith('.png'):
            name += '.png'
        path = os.path.join('storage', 'templates', name)
        for suffix in ['_pre_rotate_backup.png', '_pre_flip_backup.png']:
            backup = path.replace('.png', suffix.replace('.png', '')) + '.png'
            # build backup path correctly
            backup = os.path.join('storage', 'templates',
                                  name.replace('.png', suffix))
            if os.path.exists(backup):
                shutil.copy2(backup, path)
                os.remove(backup)
                self.logger.log(f'Restored {name} from backup')
                return {'status': 'ok', 'restored': True}
        return {'status': 'ok', 'restored': False, 'message': 'No backup found'}

    # ── CROP ──────────────────────────────────────────────────

    def crop_template(self, name: str, crop_x: int, crop_y: int,
                      crop_w: int, crop_h: int, save_name: str,
                      overwrite: bool = False):
        import base64
        import io
        import shutil
        from PIL import Image

        if not name.endswith(".png"):
            name += ".png"

        if overwrite:
            save_name = name
        else:
            if not save_name.endswith(".png"):
                save_name += ".png"

        src_path    = os.path.join("storage", "templates", name)
        dest_path   = os.path.join("storage", "templates", save_name)
        backup_path = os.path.join("storage", "templates",
                                   name.replace(".png", "_original_backup.png"))

        if not os.path.exists(src_path):
            return {"status": "error", "message": f"Source '{name}' not found"}

        try:
            if overwrite and not os.path.exists(backup_path):
                shutil.copy2(src_path, backup_path)
                self.logger.log(f"Backup created: '{backup_path}'")

            img = Image.open(src_path)
            img_w, img_h = img.size

            x1 = max(0, int(crop_x))
            y1 = max(0, int(crop_y))
            x2 = min(img_w, x1 + int(crop_w))
            y2 = min(img_h, y1 + int(crop_h))

            if x2 <= x1 or y2 <= y1:
                return {"status": "error", "message": "Crop area too small or out of bounds"}

            cropped = img.crop((x1, y1, x2, y2))
            cropped.save(dest_path)

            buf = io.BytesIO()
            cropped.save(buf, format="PNG")
            encoded = base64.b64encode(buf.getvalue()).decode("utf-8")

            self.logger.log(f"Cropped '{name}' → '{save_name}' ({x2-x1}×{y2-y1}px)"
                            + (" [overwrite]" if overwrite else ""))
            return {
                "status":     "ok",
                "name":       save_name,
                "overwrite":  overwrite,
                "has_backup": os.path.exists(backup_path),
                "w":          x2 - x1,
                "h":          y2 - y1,
                "data":       f"data:image/png;base64,{encoded}"
            }
        except Exception as e:
            self.logger.log(f"Crop error: {e}", level="ERROR")
            return {"status": "error", "message": str(e)}

    def restore_template_original(self, name: str):
        import base64
        import io
        import shutil
        from PIL import Image

        if not name.endswith(".png"):
            name += ".png"

        dest_path   = os.path.join("storage", "templates", name)
        backup_path = os.path.join("storage", "templates",
                                   name.replace(".png", "_original_backup.png"))

        if not os.path.exists(backup_path):
            return {"status": "error", "message": "No original backup found for this template"}

        try:
            shutil.copy2(backup_path, dest_path)
            os.remove(backup_path)

            img = Image.open(dest_path)
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            encoded = base64.b64encode(buf.getvalue()).decode("utf-8")

            self.logger.log(f"Restored original for '{name}'")
            return {
                "status": "ok",
                "w":      img.size[0],
                "h":      img.size[1],
                "data":   f"data:image/png;base64,{encoded}"
            }
        except Exception as e:
            self.logger.log(f"Restore error: {e}", level="ERROR")
            return {"status": "error", "message": str(e)}

    def check_template_has_backup(self, name: str):
        if not name.endswith(".png"):
            name += ".png"
        backup_path = os.path.join("storage", "templates",
                                   name.replace(".png", "_original_backup.png"))
        return {"has_backup": os.path.exists(backup_path)}

    def recapture_template(self, name: str):
        import time
        if not name or not name.strip():
            return {"status": "error", "message": "No template name given"}

        name = name.strip().replace(" ", "_")
        region = self._run_region_selector()
        if region is None:
            return {"status": "cancelled"}

        x, y, w, h = region
        if w <= 0 or h <= 0:
            return {"status": "error", "message": f"Invalid region size: {w}×{h}"}

        time.sleep(0.3)
        try:
            path = self.screen.save_as_template(int(x), int(y), int(w), int(h), name)
        except Exception as e:
            self.logger.log(f"Recapture failed: {e}", level="ERROR")
            return {"status": "error", "message": str(e)}

        self.logger.log(f"Recaptured '{name}' ({w}x{h}) at ({x},{y})")
        return {"status": "ok", "path": path, "x": x, "y": y, "w": w, "h": h}

    def set_template_search_region(self, name: str):
        import time
        region = self._run_region_selector()
        if region is None:
            return {"status": "cancelled"}

        x, y, w, h = region
        if w <= 0 or h <= 0:
            return {"status": "error", "message": f"Invalid region size: {w}×{h}"}

        time.sleep(0.2)
        try:
            self.learner.set_manual_region(name, [x, y, w, h])
        except Exception as e:
            self.logger.log(f"Set region failed: {e}", level="ERROR")
            return {"status": "error", "message": str(e)}

        self.logger.log(f"Search region set for '{name}': ({x},{y}) {w}x{h}")
        return {"status": "ok", "x": x, "y": y, "w": w, "h": h}

    def clear_template_search_region(self, name: str):
        self.learner.set_manual_region(name, None)
        self.logger.log(f"Search region cleared for '{name}'")
        return {"status": "ok"}

    def save_template_search_region_direct(self, name: str, x: int, y: int, w: int, h: int):
        if w <= 0 or h <= 0:
            return {"status": "error", "message": f"Invalid region size: {w}×{h}"}
        try:
            self.learner.set_manual_region(name, [x, y, w, h])
        except Exception as e:
            self.logger.log(f"Direct region save failed: {e}", level="ERROR")
            return {"status": "error", "message": str(e)}
        self.logger.log(f"Search region saved for '{name}' from Quick Detect: ({x},{y}) {w}x{h}")
        return {"status": "ok", "x": x, "y": y, "w": w, "h": h}

    def get_template_search_region(self, name: str):
        region = self.learner.get_manual_region(name)
        if region:
            return {"region": {"x": region[0], "y": region[1], "w": region[2], "h": region[3]}}
        return {"region": None}

    def capture_screen_with_region_highlight(self, name: str, confidence: float = 0.8,
                                               multi_scale: bool = True):
        """
        Single-pass Quick Detect backend.

        Grabs the screen once, runs multi-scale template matching, and returns
        the screenshot (base64 JPEG) together with ALL matches pre-scaled to
        the returned image dimensions.  The JS only needs to call this — the old
        separate detect_image_all round-trip is no longer needed.

        Region priority:
          1. Manual region saved for this template (learner)
          2. Active _detect_region set in the Quick Detect panel
          3. Full screen (None)
        """
        import base64, io
        from PIL import Image
        import mss

        # Grab full screen once
        with mss.mss() as sct:
            monitor  = sct.monitors[1]
            shot     = sct.grab(monitor)
            screen_img = Image.frombytes('RGB', shot.size, shot.rgb)

        # Determine search region (manual > active detect region > full screen)
        region = self.learner.get_manual_region(name)
        if region is None:
            region = self._detect_region  # may also be None → full screen

        # Downscale preview for fast transfer to the JS canvas
        sw, sh = screen_img.size
        scale  = min(1.0, 1280 / sw)
        if scale < 1.0:
            screen_img = screen_img.resize(
                (int(sw * scale), int(sh * scale)), Image.LANCZOS
            )
        buf = io.BytesIO()
        screen_img.save(buf, format="JPEG", quality=72)
        screen_b64 = base64.b64encode(buf.getvalue()).decode()

        result = {
            "status":   "ok",
            "screen":   f"data:image/jpeg;base64,{screen_b64}",
            "screen_w": screen_img.width,
            "screen_h": screen_img.height,
            "scale":    scale,
            "region":   region,
        }

        # Template matching — same screen grab, no second capture needed
        try:
            raw_matches = self.detector.find_all_on_screen(
                name,
                confidence=confidence,
                region=region,
                max_matches=10,
                multi_scale=bool(multi_scale),
            )
            # Pre-scale all coordinates so JS just draws directly on the canvas
            scaled = []
            for m in raw_matches:
                scaled.append({
                    "x":          round(m["x"]         * scale),
                    "y":          round(m["y"]         * scale),
                    "w":          round(m["rect"][2]   * scale),
                    "h":          round(m["rect"][3]   * scale),
                    "confidence": m["confidence"],
                })
            result["matches"] = scaled
        except Exception as e:
            self.logger.log(f"Quick Detect match error: {e}", level="WARN")
            result["matches"] = []

        return result

    # ── NEW: DETECT ALL IMAGES (for Quick Detect) ─────────────
    def detect_image_all(self, template_name: str, confidence: float = 0.0, max_matches: int = 10):
        """
        Detect all instances of an image on screen within the current detection region.
        Returns a list of matches with coordinates and confidence.
        """
        region = self._detect_region
        try:
            matches = self.detector.find_all_on_screen(
                template_name, 
                confidence=confidence, 
                region=region,
                max_matches=max_matches
            )
            result = []
            for m in matches:
                result.append({
                    "x": m["x"],
                    "y": m["y"],
                    "w": m["rect"][2],
                    "h": m["rect"][3],
                    "confidence": m["confidence"]
                })
            return {"status": "ok", "matches": result}
        except Exception as e:
            self.logger.log(f"detect_image_all error: {e}", level="ERROR")
            return {"status": "error", "message": str(e), "matches": []}
        
    # ── OCR DETECTION (for testing) ─────────────────────────────
    def detect_text_all(self, text: str, confidence: int = 80, region=None):
        """
        Detect all occurrences of text on screen.
        region can be [x, y, w, h] or None.
        """
        if region is None:
            region = self._detect_region
        matches = self.action_engine.find_all_text(text, region, confidence)
        # Convert to list of dicts — cast to plain int so JSON encoder handles numpy.int64
        result = []
        for m in matches:
            result.append({
                "x": int(m["x"]),
                "y": int(m["y"]),
                "w": int(m["w"]),
                "h": int(m["h"]),
                "confidence": int(m["confidence"])
            })
        return {"status": "ok", "matches": result}
    # ── COLOR DETECTION (for testing) ───────────────────────────
    def detect_color_all(self, color_hex: str, tolerance: int = 30, region=None):
        """
        Detect all pixels of a given color on screen.
        """
        if region is None:
            region = self._detect_region
        points = self.action_engine.find_all_colors(color_hex, region, tolerance)
        # Convert to list of dicts — cast to plain int so JSON encoder handles numpy.int64
        result = []
        for x, y in points:
            result.append({"x": int(x), "y": int(y), "w": 1, "h": 1, "confidence": 100})
        return {"status": "ok", "matches": result}

    # ── EYEDROPPER / PIXEL SAMPLER ───────────────────────────

    def start_eyedropper(self):
        """
        Begin eyedropper mode: hide the window, then poll mouse position
        and return live color under cursor. The frontend polls get_eyedropper_color()
        and calls stop_eyedropper() when user clicks.
        """
        import pyautogui, threading
        self._eyedropper_active = True
        self._eyedropper_color  = None
        self._eyedropper_pos    = {"x": 0, "y": 0}

        # Minimise the webview window so it doesn't block screen access
        try:
            self.window.minimize()
        except Exception:
            pass

        def _poll():
            import time
            while self._eyedropper_active:
                try:
                    x, y   = pyautogui.position()
                    r, g, b = pyautogui.pixel(x, y)
                    self._eyedropper_pos   = {"x": int(x), "y": int(y)}
                    self._eyedropper_color = {
                        "hex": "#{:02X}{:02X}{:02X}".format(r, g, b),
                        "r": r, "g": g, "b": b,
                        "x": int(x), "y": int(y)
                    }
                except Exception:
                    pass
                time.sleep(0.05)

        threading.Thread(target=_poll, daemon=True).start()
        return {"status": "ok"}

    def get_eyedropper_color(self):
        """Poll current color under the cursor during eyedropper mode."""
        if not getattr(self, "_eyedropper_active", False):
            return {"status": "idle", "color": None}
        return {"status": "active", "color": self._eyedropper_color}

    def stop_eyedropper(self, confirm: bool = True):
        """
        Stop eyedropper mode. If confirm=True, returns the last sampled color.
        Restores the window.
        """
        self._eyedropper_active = False
        color = getattr(self, "_eyedropper_color", None)
        try:
            self.window.restore()
        except Exception:
            pass
        return {"status": "ok", "color": color if confirm else None}

    def get_pixel_color_at(self, x: int, y: int):
        """Return hex color of a single pixel at (x,y). Used for canvas sampling."""
        try:
            import pyautogui
            r, g, b = pyautogui.pixel(int(x), int(y))
            return {
                "status": "ok",
                "hex": "#{:02X}{:02X}{:02X}".format(r, g, b),
                "r": r, "g": g, "b": b
            }
        except Exception as e:
            return {"status": "error", "message": str(e)}

    def capture_region_preview(self, x: int, y: int, w: int, h: int):
        """Capture a specific screen region and return as base64 JPEG thumbnail."""
        import base64, io
        from PIL import Image
        import mss
        try:
            with mss.mss() as sct:
                monitor = {"left": int(x), "top": int(y), "width": int(w), "height": int(h)}
                shot = sct.grab(monitor)
                img  = Image.frombytes("RGB", shot.size, shot.rgb)
                # Fit to max 400px wide for preview
                max_w = 400
                if img.width > max_w:
                    ratio = max_w / img.width
                    img = img.resize((max_w, int(img.height * ratio)), Image.LANCZOS)
                buf = io.BytesIO()
                img.save(buf, format="JPEG", quality=75)
                b64 = base64.b64encode(buf.getvalue()).decode()
                return {"status": "ok", "image": f"data:image/jpeg;base64,{b64}",
                        "w": img.width, "h": img.height}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    # ── TEMPLATE MANAGER ──────────────────────────────────────

    def get_templates(self):
        return {"templates": self.template_mgr.list_templates()}

    def save_ocr_template(self, name: str, text: str,
                          confidence: int = 80, region=None):
        """Save an OCR template (TEXT type) to templates_meta/."""
        if not name or not name.strip():
            return {"status": "error", "message": "Name is required"}
        if not text or not text.strip():
            return {"status": "error", "message": "Search text is required"}
        return self.template_mgr.save_ocr_template(name, text, confidence, region)

    def save_color_template(self, name: str, color: str,
                            tolerance: int = 30, region=None):
        """Save a Color Pixel template (COLOR type) to templates_meta/."""
        if not name or not name.strip():
            return {"status": "error", "message": "Name is required"}
        if not color or not color.strip():
            return {"status": "error", "message": "Color is required"}
        return self.template_mgr.save_color_template(name, color, tolerance, region)

    def get_meta_template(self, name: str):
        """Load a single OCR/Color meta template."""
        return self.template_mgr.get_meta_template(name)

    def delete_template(self, name: str):
        self.template_mgr.delete_template(name)
        return {"status": "ok"}

    def rename_template(self, old_name: str, new_name: str):
        self.template_mgr.rename_template(old_name, new_name)
        return {"status": "ok"}

    # ── IMAGE DETECTION ───────────────────────────────────────

    def detect_image(self, template_name: str, confidence: float = 0.8):
        region = self._detect_region
        result = self.detector.find_on_screen(
            template_name, float(confidence), region=region
        )
        if region:
            self.logger.log(
                f"Detection used region [{region[0]},{region[1]},"
                f"{region[2]},{region[3]}]"
            )
        return {"found": result is not None, "location": result}

    def set_detect_region(self):
        import time
        region = self._run_region_selector()

        if region is None:
            return {"status": "cancelled"}

        x, y, w, h = region
        if w <= 0 or h <= 0:
            return {"status": "error", "message": f"Invalid region size: {w}×{h}"}

        time.sleep(0.2)
        self._detect_region = [x, y, w, h]

        self.logger.log(f"Detection region set: ({x},{y}) {w}×{h}px")
        return {"status": "ok", "x": x, "y": y, "w": w, "h": h}

    def set_detect_region_direct(self, x: int, y: int, w: int, h: int):
        if w <= 0 or h <= 0:
            return {"status": "error", "message": f"Invalid region size: {w}x{h}"}
        self._detect_region = [int(x), int(y), int(w), int(h)]
        self.logger.log(f"Detection region set directly: ({x},{y}) {w}x{h}px")
        return {"status": "ok", "x": x, "y": y, "w": w, "h": h}

    def clear_detect_region(self):
        self._detect_region = None
        self.logger.log("Detection region cleared — using full screen")
        return {"status": "cleared"}

    def get_detect_region(self):
        return {"region": self._detect_region}

    # ── MOUSE POSITION ────────────────────────────────────────

    def get_mouse_pos(self):
        import pyautogui
        x, y = pyautogui.position()
        return {"x": int(x), "y": int(y)}

    def start_coord_capture(self):
        self.stop_coord_capture()

        self._captured_coords = []
        self._coord_listener_active = True

        try:
            from pynput import mouse as pynput_mouse

            def on_click(x, y, button, pressed):
                if not self._coord_listener_active:
                    return False
                if pressed and str(button) == 'Button.right':
                    with self._coords_lock:
                        self._captured_coords.append({"x": int(x), "y": int(y), "trigger": "right-click"})
                    self.logger.log(f"Coord captured (right-click): ({x},{y})")

            self._coord_mouse_listener = pynput_mouse.Listener(on_click=on_click)
            self._coord_mouse_listener.start()
        except Exception as e:
            self.logger.log(f"Mouse listener error: {e}", level="WARN")
            self._coord_mouse_listener = None

        try:
            import keyboard as kb
            import pyautogui

            def on_f2():
                if not self._coord_listener_active:
                    return
                x, y = pyautogui.position()
                with self._coords_lock:
                    self._captured_coords.append({"x": int(x), "y": int(y), "trigger": "f2"})
                self.logger.log(f"Coord captured (F2): ({x},{y})")

            kb.add_hotkey('f2', on_f2, suppress=False)
            self._kb_f2_registered = True
        except Exception as e:
            self.logger.log(f"F2 hotkey error: {e}", level="WARN")
            self._kb_f2_registered = False

        self.logger.log("Coord capture started — right-click or F2 to capture anywhere")
        return {"status": "ok"}

    def stop_coord_capture(self):
        self._coord_listener_active = False

        if hasattr(self, '_coord_mouse_listener') and self._coord_mouse_listener:
            try:
                self._coord_mouse_listener.stop()
            except Exception:
                pass
            self._coord_mouse_listener = None

        if getattr(self, '_kb_f2_registered', False):
            try:
                import keyboard as kb
                kb.remove_hotkey('f2')
            except Exception:
                pass
            self._kb_f2_registered = False

        self.logger.log("Coord capture stopped")
        return {"status": "ok"}

    def get_captured_coords(self):
        with self._coords_lock:
            coords = self._captured_coords[:]
            self._captured_coords.clear()
        return {"coords": coords}

    # ── VERSION ───────────────────────────────────────────────

    def get_version(self):
        return {"version": APP_VERSION}

    def check_for_update(self):
        """
        Check GitHub Releases for a newer version.
        Returns { status, current, latest, update_available, release_url, release_notes }
        TODO: Replace GITHUB_USER and GITHUB_REPO with your actual values.
        """
        import urllib.request, json

        GITHUB_USER = "kramogs-bug"   # TODO: replace
        GITHUB_REPO = "AMYT-app"          # TODO: replace

        try:
            url = (
                f"https://api.github.com/repos/"
                f"{GITHUB_USER}/{GITHUB_REPO}/releases/latest"
            )
            req = urllib.request.Request(
                url, headers={"User-Agent": f"AMYT/{APP_VERSION}"}
            )
            with urllib.request.urlopen(req, timeout=5) as r:
                data = json.loads(r.read())

            latest = data.get("tag_name", "").lstrip("v").strip()
            if not latest:
                return {"status": "no_release"}

            def _ver(v):
                try:
                    return tuple(int(x) for x in v.split("."))
                except Exception:
                    return (0,)

            update_available = _ver(latest) > _ver(APP_VERSION)

            # Trim release notes to a readable length
            notes = (data.get("body") or "").strip()
            if len(notes) > 400:
                notes = notes[:400].rsplit("\n", 1)[0] + "\n…"

            self.logger.log(
                f"Update check: current={APP_VERSION} latest={latest} "
                f"update_available={update_available}"
            )
            return {
                "status":           "ok",
                "current":          APP_VERSION,
                "latest":           latest,
                "update_available": update_available,
                "release_url":      data.get("html_url", ""),
                "release_notes":    notes,
            }

        except urllib.error.URLError as e:
            # Silently fail — no internet or GitHub unreachable
            self.logger.log(f"Update check skipped: {e}", level="WARN")
            return {"status": "offline"}
        except Exception as e:
            self.logger.log(f"Update check error: {e}", level="WARN")
            return {"status": "error", "message": str(e)}

    def fetch_control_config(self):
        """
        Fetch control.json from GitHub raw content.
        This lets you remotely:
          - Disable the app for everyone  (app_enabled: false)
          - Force a minimum version       (min_version: "1.x.x")
          - Force users to update         (force_update: true)
          - Broadcast a message           (message: "...")
        Returns the parsed config dict, or safe defaults if unreachable.
        """
        import urllib.request, json

        GITHUB_USER = "kramogs-bug"
        GITHUB_REPO = "AMYT-app"
        BRANCH      = "main"

        DEFAULTS = {
            "app_enabled":   True,
            "min_version":   "0.0.0",
            "latest_version": APP_VERSION,
            "force_update":  False,
            "message":       "",
            "download_url":  f"https://github.com/{GITHUB_USER}/{GITHUB_REPO}/releases/latest",
        }

        try:
            url = (
                f"https://raw.githubusercontent.com/"
                f"{GITHUB_USER}/{GITHUB_REPO}/{BRANCH}/control.json"
            )
            req = urllib.request.Request(
                url, headers={"User-Agent": f"AMYT/{APP_VERSION}"}
            )
            with urllib.request.urlopen(req, timeout=5) as r:
                config = json.loads(r.read())

            # Merge with defaults so missing keys don't cause KeyErrors
            DEFAULTS.update(config)
            self.logger.log(f"Control config fetched: {DEFAULTS}")
            return {"status": "ok", "config": DEFAULTS}

        except Exception as e:
            self.logger.log(f"Control config fetch failed (using defaults): {e}", level="WARN")
            return {"status": "offline", "config": DEFAULTS}

    def open_url(self, url: str):
        """Open a URL in the user's default browser."""
        import webbrowser
        try:
            webbrowser.open(url)
            return {"status": "ok"}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    # ── WINDOW CONTROL ────────────────────────────────────────

    def get_open_windows(self):
        """Return list of all open window titles for the UI dropdown."""
        return {"windows": self.window_ctrl.get_all_windows()}

    def focus_target_window(self):
        """Manually focus the configured target window."""
        settings = self.get_movement_settings()
        title = settings.get("target_window", "").strip()
        if not title:
            return {"status": "error", "message": "No target window configured"}
        ok = self.window_ctrl.focus_window(title)
        return {"status": "ok" if ok else "error",
                "message": f"Focused '{title}'" if ok else f"Window '{title}' not found"}

    def get_foreground_window(self):
        """Return the title of the currently active window."""
        return {"title": self.window_ctrl.get_foreground_title()}

    # ── LOGGING ───────────────────────────────────────────────

    def get_logs(self):
        return {"logs": self.logger.get_logs()}

    def clear_logs(self):
        self.logger.clear()
        return {"status": "cleared"}

    # ── LEARNING DATA ─────────────────────────────────────────

    def get_learning_data(self):
        return self.learner.get_all_data()

    def get_movement_settings(self):
        """Load movement settings from storage/settings.json"""
        import json, os
        path = os.path.join("storage", "settings.json")
        defaults = {
            "player_x": 960,
            "player_y": 540,
            "key_up": "up",
            "key_down": "down",
            "key_left": "left",
            "key_right": "right",
            "step_time": 0.1,
            "stop_radius": 20,
            "stuck_threshold": 3,
            "arrival_region": 200,
            "arrival_region_h": 200,
            "arrival_confidence": 0.85,
            "target_window": "",
            "auto_focus": True,
            "miss_tolerance": 3,        # consecutive misses before NAVIGATE stops
        }
        if os.path.exists(path):
            with open(path, "r") as f:
                saved = json.load(f)
            if "movement" in saved:
                defaults.update(saved["movement"])
        return defaults

    def save_movement_settings(self, settings: dict):
        """Save movement settings under 'movement' key in settings.json"""
        import json, os
        path = os.path.join("storage", "settings.json")
        if os.path.exists(path):
            with open(path, "r") as f:
                all_settings = json.load(f)
        else:
            all_settings = {}
        all_settings["movement"] = settings
        with open(path, "w") as f:
            json.dump(all_settings, f, indent=2)
        self.logger.log("Movement settings saved")
        return {"status": "ok"}

    def export_amyt(self, name: str, description: str = "",
                    author: str = "", tags: str = ""):
        """
        Bundle the current script + its templates into a .amyt file.
        Opens a Save dialog so the user chooses where to save it.
        Returns { status, path, templates_bundled } or { status:'cancelled' }.
        """
        import io, json, zipfile, hashlib, datetime
        from tkinter import filedialog

        script_content = ""
        try:
            scripts = self.list_scripts()["scripts"]
            safe_name = name.strip().replace(" ", "_")
            if not safe_name.endswith(".txt"):
                safe_name += ".txt"
            r = self.load_script(safe_name)
            if r["status"] == "ok":
                script_content = r["content"]
        except Exception:
            pass

        if not script_content:
            return {"status": "error", "message": "Script is empty or not found"}

        # Ask user where to save
        save_path = self._run_tkinter_dialog(
            lambda root: filedialog.asksaveasfilename(
                title="Export as .amyt",
                initialfile=(name or "script") + ".amyt",
                defaultextension=".amyt",
                filetypes=[("AMYT Script Package", "*.amyt"), ("All files", "*.*")]
            )
        )
        if not save_path:
            return {"status": "cancelled"}

        # Collect templates used by the script
        template_names = self._extract_template_names(script_content)
        templates_dir  = os.path.join("storage", "templates")
        templates_bundled = 0

        # Build checksum
        checksum = hashlib.sha256(script_content.encode()).hexdigest()[:16]

        # Build meta.json
        meta = {
            "name":        name or os.path.splitext(os.path.basename(save_path))[0],
            "author":      author.strip(),
            "description": description.strip(),
            "tags":        [t.strip() for t in tags.split(",") if t.strip()],
            "app_version": APP_VERSION,
            "created":     datetime.date.today().isoformat(),
            "checksum":    checksum,
            "commands_used": list({
                line.split()[0].upper()
                for line in script_content.splitlines()
                if line.strip() and not line.strip().startswith("#")
                   and line.split()[0].isalpha()
            }),
        }

        try:
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
                zf.writestr("script.txt",  script_content)
                zf.writestr("meta.json",   json.dumps(meta, indent=2))
                # ── IMAGE templates (.png) ────────────────────────────────
                for tpl_name in template_names:
                    safe = os.path.basename(tpl_name)
                    src  = os.path.join(templates_dir, safe)
                    if os.path.exists(src):
                        zf.write(src, f"templates/{safe}")
                        templates_bundled += 1
                    else:
                        self.logger.log(f"AMYT export: image template not found: {safe}", level="WARN")
                # ── META templates (.json — TEXT / COLOR) ─────────────────
                meta_dir = os.path.join("storage", "templates_meta")
                if os.path.isdir(meta_dir):
                    for json_file in os.listdir(meta_dir):
                        if not json_file.lower().endswith(".json"):
                            continue
                        # Only bundle meta templates actually referenced in the script
                        stem = json_file[:-5]  # strip .json
                        if stem in template_names or json_file in template_names:
                            src = os.path.join(meta_dir, json_file)
                            zf.write(src, f"templates_meta/{json_file}")
                            templates_bundled += 1

            with open(save_path, "wb") as f:
                f.write(buf.getvalue())

            self.logger.log(
                f"Exported .amyt: {save_path} "
                f"({templates_bundled} templates, checksum={checksum})"
            )
            return {
                "status": "ok",
                "path": save_path,
                "templates_bundled": templates_bundled,
                "meta": meta,
            }
        except Exception as e:
            self.logger.log(f"AMYT export error: {e}", level="ERROR")
            return {"status": "error", "message": str(e)}

    def import_amyt(self, path: str = None):
        """
        Import a .amyt file — extract script + templates, return script content.
        If path is None, opens a file-picker dialog.
        Returns { status, script, meta, templates_restored }.
        """
        import json, zipfile
        from tkinter import filedialog

        if not path:
            path = self._run_tkinter_dialog(
                lambda root: filedialog.askopenfilename(
                    title="Import .amyt Script Package",
                    filetypes=[("AMYT Script Package", "*.amyt"), ("All files", "*.*")]
                )
            )
        if not path:
            return {"status": "cancelled"}

        if not os.path.exists(path):
            return {"status": "error", "message": f"File not found: {path}"}

        templates_dir = os.path.join("storage", "templates")
        os.makedirs(templates_dir, exist_ok=True)

        try:
            with zipfile.ZipFile(path, "r") as zf:
                names = zf.namelist()

                # Extract script
                if "script.txt" not in names:
                    return {"status": "error", "message": "Invalid .amyt file — missing script.txt"}
                script_content = zf.read("script.txt").decode("utf-8")

                # Extract meta
                meta = {}
                if "meta.json" in names:
                    try:
                        meta = json.loads(zf.read("meta.json").decode("utf-8"))
                    except Exception:
                        pass

                # Extract templates
                templates_restored = 0
                meta_dir = os.path.join("storage", "templates_meta")
                os.makedirs(meta_dir, exist_ok=True)
                for name_in_zip in names:
                    # ── IMAGE templates ───────────────────────────────────
                    if name_in_zip.startswith("templates/") and name_in_zip != "templates/":
                        safe = os.path.basename(name_in_zip)
                        if not safe or ".." in safe:
                            continue
                        dest = os.path.join(templates_dir, safe)
                        with zf.open(name_in_zip) as src_f:
                            with open(dest, "wb") as dst_f:
                                dst_f.write(src_f.read())
                        templates_restored += 1
                    # ── META templates (TEXT / COLOR) ─────────────────────
                    elif name_in_zip.startswith("templates_meta/") and name_in_zip != "templates_meta/":
                        safe = os.path.basename(name_in_zip)
                        if not safe or ".." in safe or not safe.endswith(".json"):
                            continue
                        dest = os.path.join(meta_dir, safe)
                        with zf.open(name_in_zip) as src_f:
                            with open(dest, "wb") as dst_f:
                                dst_f.write(src_f.read())
                        templates_restored += 1

            # Verify checksum if present
            import hashlib
            stored_cs = meta.get("checksum", "")
            actual_cs = hashlib.sha256(script_content.encode()).hexdigest()[:16]
            checksum_ok = (not stored_cs) or (stored_cs == actual_cs)
            if not checksum_ok:
                self.logger.log("AMYT import: checksum mismatch — file may be modified", level="WARN")

            self.logger.log(
                f"Imported .amyt: {path} "
                f"({templates_restored} templates, checksum_ok={checksum_ok})"
            )
            return {
                "status":             "ok",
                "script":             script_content,
                "meta":               meta,
                "templates_restored": templates_restored,
                "checksum_ok":        checksum_ok,
                "path":               path,
            }
        except zipfile.BadZipFile:
            return {"status": "error", "message": "Not a valid .amyt file"}
        except Exception as e:
            self.logger.log(f"AMYT import error: {e}", level="ERROR")
            return {"status": "error", "message": str(e)}

    def get_amyt_meta(self, path: str):
        """Read only the meta.json from a .amyt file (for previewing before import)."""
        import json, zipfile
        try:
            with zipfile.ZipFile(path, "r") as zf:
                if "meta.json" in zf.namelist():
                    return {"status": "ok", "meta": json.loads(zf.read("meta.json").decode())}
            return {"status": "ok", "meta": {}}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    def register_amyt_file_association(self):
        """
        Register .amyt file association on Windows so double-clicking opens the app.
        Must be run once — writes to HKEY_CURRENT_USER (no admin needed).
        """
        try:
            import winreg, sys
            exe = sys.executable
            # When frozen as a PyInstaller .exe, sys.executable IS the .exe and
            # __file__ resolves into the temp _MEIPASS directory — unusable as a
            # registry launch command.  In source mode we still want the two-arg
            # form so the script can be found.
            if getattr(sys, 'frozen', False):
                cmd = f'"{exe}" "%1"'
                # Icon source: the frozen .exe itself contains logo.ico embedded
                icon_path = exe
            else:
                script = os.path.abspath(__file__)
                cmd = f'"{exe}" "{script}" "%1"'
                # Icon source: logo.ico sitting next to main.py
                icon_path = os.path.join(os.path.dirname(script), "logo.ico")
                # Fall back to .py file if ico missing
                if not os.path.exists(icon_path):
                    icon_path = exe

            # .amyt → AMYTFile
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER,
                                   r"Software\Classes\.amyt") as k:
                winreg.SetValueEx(k, "", 0, winreg.REG_SZ, "AMYTFile")

            # AMYTFile description
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER,
                                   r"Software\Classes\AMYTFile") as k:
                winreg.SetValueEx(k, "", 0, winreg.REG_SZ, "AMYT Script Package")

            # DefaultIcon — makes Windows Explorer show the app icon on .amyt files
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER,
                                   r"Software\Classes\AMYTFile\DefaultIcon") as k:
                # ",0" means "first icon resource in this file"
                winreg.SetValueEx(k, "", 0, winreg.REG_SZ, f'"{icon_path}",0')

            # Open command
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER,
                                   r"Software\Classes\AMYTFile\shell\open\command") as k:
                winreg.SetValueEx(k, "", 0, winreg.REG_SZ, cmd)

            # Notify Windows Shell to refresh icon cache immediately
            try:
                import ctypes
                SHCNE_ASSOCCHANGED = 0x08000000
                SHCNF_IDLIST       = 0x0000
                ctypes.windll.shell32.SHChangeNotify(
                    SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None
                )
            except Exception:
                pass  # non-critical — icons update on next Explorer refresh

            self.logger.log("AMYT file association registered (with icon)")
            return {"status": "ok", "message": ".amyt files will now open with this app"}
        except Exception as e:
            self.logger.log(f"File association error: {e}", level="ERROR")
            return {"status": "error", "message": str(e)}


    # ── CLEAN SHUTDOWN ────────────────────────────────────────
    def _shutdown(self):
        """
        Tear down all background threads and hard-exit.
        os._exit(0) is intentional — the keyboard hook thread and webview GUI
        thread are non-daemon and would keep the process alive in Task Manager
        if we used sys.exit() or just let Python unwind normally.
        """
        # Guard against being called twice (on_main_closing thread + finally block).
        # Without this, the second call races into _kb.unhook_all() while the first
        # is still unwinding, causing a hang before os._exit() is reached.
        if getattr(self, '_shutdown_called', False):
            return
        self._shutdown_called = True

        try:
            self.macro_engine.stop()
        except Exception:
            pass
        try:
            import keyboard as _kb
            _kb.unhook_all()       # kill the keyboard hook thread
        except Exception:
            pass
        try:
            if getattr(self, '_coord_mouse_listener', None):
                self._coord_mouse_listener.stop()
                self._coord_mouse_listener = None
        except Exception:
            pass
        try:
            self.learner.flush()   # persist learning data
        except Exception:
            pass
        try:
            # pywebview windows use .hide(), NOT .destroy() — calling .destroy()
            # on a live webview window blocks indefinitely and causes "not responding".
            if getattr(self, '_toast_window', None):
                self._toast_window.hide()
        except Exception:
            pass
        try:
            if getattr(self, '_indicator_window', None):
                self._indicator_window.hide()
        except Exception:
            pass
        self.logger.log("Shutdown complete")
        import os as _os
        _os._exit(0)

    def confirm_close(self):
        """JS calls this when user confirms 'close without saving'."""
        self._shutdown()

    def force_close(self):
        """JS calls this when script is clean — no dialog needed."""
        self._shutdown()



# ══════════════════════════════════════════════════════════════
#  STARTUP
# ══════════════════════════════════════════════════════════════

def _check_webview2():
    """
    Check WebView2 Runtime is installed.
    Strategy:
      1. Registry scan (fast, covers most installs).
      2. Runtime probe — try loading WebView2Loader.dll directly.
         Catches installs that use non-standard registry paths (Win11 built-in
         Edge, corporate managed environments, per-user installs, etc.).
    Only shows the 'missing' dialog when BOTH checks fail.
    """
    import platform
    if platform.system() != "Windows":
        return True

    # ── 1. Registry scan ─────────────────────────────────────────────────────
    import winreg
    keys_to_check = [
        # Machine-wide Evergreen
        r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        # Per-user Evergreen
        r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{2CD8A007-E189-409D-A2C8-9AF4EF3C72AA}",
        # Edge stable (ships WebView2 on Win11)
        r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{56EB18F8-B008-4CBD-B6D2-8C97FE7E9062}",
        r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{56EB18F8-B008-4CBD-B6D2-8C97FE7E9062}",
    ]
    for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        for key_path in keys_to_check:
            try:
                with winreg.OpenKey(hive, key_path) as k:
                    val, _ = winreg.QueryValueEx(k, "pv")
                    if val and val != "0.0.0.0":
                        return True
            except (FileNotFoundError, OSError):
                continue

    # ── 2. Runtime probe ─────────────────────────────────────────────────────
    # Win11 often ships WebView2 as part of Edge without writing the Evergreen
    # registry key above.  Trying to load the DLL is the definitive test.
    try:
        import ctypes as _ct2
        _dll = _ct2.windll.LoadLibrary("WebView2Loader.dll")
        if _dll:
            return True
    except (OSError, AttributeError):
        pass

    # ── 3. Both failed → friendly install dialog ─────────────────────────────
    try:
        import ctypes
        DOWNLOAD_URL = "https://developer.microsoft.com/en-us/microsoft-edge/webview2/#download-section"
        msg = (
            "AMYT requires Microsoft WebView2 Runtime to display its interface.\n\n"
            "WebView2 is free and takes less than a minute to install.\n\n"
            "Click OK to open the download page in your browser,\n"
            "then install 'Evergreen Standalone Installer (x64)' and restart AMYT."
        )
        result = ctypes.windll.user32.MessageBoxW(
            0, msg, "WebView2 Runtime Required — AMYT",
            0x00000001 | 0x00000030
        )
        if result == 1:
            import webbrowser
            webbrowser.open(DOWNLOAD_URL)
    except Exception:
        pass
    return False


def ensure_directories():
    folders = ["storage", "storage/templates", "logs"]
    for folder in folders:
        os.makedirs(folder, exist_ok=True)
    if not os.path.exists("storage/learning_data.json"):
        with open("storage/learning_data.json", "w") as f:
            f.write("{}")
    if not os.path.exists("storage/macro_db.json"):
        with open("storage/macro_db.json", "w") as f:
            f.write("{}")


def main(startup_amyt: str = None):
    # Check WebView2 is installed — show friendly dialog if missing
    if not _check_webview2():
        return

    # Force WebView2 renderer — prevents silent fallback to system browser
    try:
        webview.guilib = 'edgechromium'
    except Exception:
        pass

    ensure_directories()
    os.makedirs("storage/scripts", exist_ok=True)
    api     = API()
    ui_path = os.path.join(ROOT_DIR, "index.html")
    ui_url  = "file:///" + ui_path.replace(os.sep, "/")
    window  = webview.create_window(
        title="Macro Automation App",
        url=ui_url,
        js_api=api,
        width=1280,
        height=800,
        resizable=True,
        min_size=(640, 400)
    )
    api._window = window
    api.macro_engine._window = window
    api.macro_engine._api    = api

    # ── Pre-create the toast popup window BEFORE webview.start() ──
    try:
        import ctypes
        user32 = ctypes.windll.user32
        sw = user32.GetSystemMetrics(0)
        sh = user32.GetSystemMetrics(1)
    except Exception:
        sw, sh = 1920, 1080

    W, H   = 360, 92
    MARGIN = 20
    tx = sw - W - MARGIN
    ty = sh - H - MARGIN - 48

    toast_path = os.path.join(ROOT_DIR, "toast_popup.html")
    toast_url  = f"file:///{toast_path.replace(os.sep, '/')}"

    toast_win = webview.create_window(
        title     = "",
        url       = toast_url,
        js_api    = api,
        x         = tx,
        y         = ty,
        width     = W,
        height    = H,
        resizable = False,
        frameless = True,
        on_top    = True,
        shadow    = True,
        focus     = False,
        hidden    = True,
    )
    api._toast_window = toast_win

    def on_toast_closing():
        toast_win.hide()
        return False
    toast_win.events.closing += on_toast_closing

    # ── Pre-create the indicator window BEFORE webview.start() ──
    IND_W, IND_H = 310, 52
    IND_MARGIN   = 16

    indicator_path = os.path.join(ROOT_DIR, "macro_indicator.html")
    indicator_url  = f"file:///{indicator_path.replace(os.sep, '/')}"

    indicator_win = webview.create_window(
        title     = "",
        url       = indicator_url,
        js_api    = api,
        x         = IND_MARGIN,
        y         = IND_MARGIN,
        width     = IND_W,
        height    = IND_H,
        resizable = False,
        frameless = True,
        on_top    = True,
        shadow    = True,
        focus     = False,
        hidden    = True,
    )
    api._indicator_window = indicator_win

    def on_indicator_closing():
        indicator_win.hide()
        return False
    indicator_win.events.closing += on_indicator_closing

    api.logger.log("Application started")

    def on_loaded():
        api._register_hotkeys()

        # ── Remote control check on every launch ──────────────
        def _control_check():
            import time as _t, json as _json
            _t.sleep(1)   # let the UI fully render first
            try:
                result = api.fetch_control_config()
                cfg    = result.get("config", {})

                # 1. App killed remotely
                if not cfg.get("app_enabled", True):
                    msg = cfg.get("message") or "This app has been disabled by the developer."
                    api._window.evaluate_js(
                        f"window._amytRemoteDisabled && window._amytRemoteDisabled({_json.dumps(msg)})"
                    )
                    return

                # 2. Broadcast message (maintenance notice, news, etc.)
                msg = cfg.get("message", "").strip()
                if msg:
                    api._window.evaluate_js(
                        f"window._amytRemoteMessage && window._amytRemoteMessage({_json.dumps(msg)})"
                    )

                # 3. Force update — block app until user updates
                def _ver(v):
                    try: return tuple(int(x) for x in str(v).split("."))
                    except: return (0,)

                min_ver     = cfg.get("min_version", "0.0.0")
                force_upd   = cfg.get("force_update", False)
                dl_url      = cfg.get("download_url", "")

                latest_ver     = cfg.get("latest_version", min_ver)
                already_latest = _ver(APP_VERSION) >= _ver(latest_ver)

                if (force_upd and not already_latest) or _ver(APP_VERSION) < _ver(min_ver):
                    payload = _json.dumps({
                        "current":      APP_VERSION,
                        "min_version":  min_ver,
                        "download_url": dl_url,
                        "forced":       True,
                    })
                    api._window.evaluate_js(
                        f"window._amytForceUpdate && window._amytForceUpdate({payload})"
                    )

            except Exception as e:
                api.logger.log(f"Control check error: {e}", level="WARN")

        import threading as _th
        _th.Thread(target=_control_check, daemon=True).start()

        # ── Auto-import .amyt if launched by double-click ──────
        if startup_amyt:
            def _do_import():
                import time as _t
                _t.sleep(0.5)  # wait for JS to be ready
                try:
                    r = api.import_amyt(startup_amyt)
                    if r["status"] == "ok":
                        import json as _json
                        payload = _json.dumps(r)
                        api._window.evaluate_js(
                            f"window._amytStartupImport && window._amytStartupImport({payload})"
                        )
                except Exception as e:
                    api.logger.log(f"Startup .amyt import error: {e}", level="ERROR")
            _th.Thread(target=_do_import, daemon=True).start()
    # ── Main window close: intercept X button ─────────────────
    def on_main_closing():
        """
        Returning False cancels the native close.
        We ask JS to check dirty state and show confirm dialog if needed.
        JS will call api.confirm_close() or api.force_close() to finish.

        CRITICAL: evaluate_js() must NEVER be called directly inside the
        closing event handler. The closing event fires on the webview GUI
        thread — calling evaluate_js() on that same thread deadlocks the
        app (it waits for JS to run, but JS can't run because the GUI thread
        is blocked here). Fix: dispatch to a daemon thread so this handler
        returns immediately, then JS fires 50 ms later on the free GUI thread.
        """
        import threading as _th
        def _fire():
            import time as _t
            _t.sleep(0.05)   # yield so the closing handler returns first
            try:
                window.evaluate_js("handleAppClose()")
            except Exception:
                # JS not ready or window already gone — shut down directly
                api._shutdown()
        _th.Thread(target=_fire, daemon=True).start()
        return False   # always cancel the native close; JS drives it

    window.events.closing += on_main_closing
    window.events.loaded  += on_loaded

    try:
        webview.start(debug=False)
    except KeyboardInterrupt:
        pass
    finally:
        # Safety net: if webview exits without going through on_main_closing
        # (e.g. killed externally) still clean up properly.
        api._shutdown()


if __name__ == "__main__":
    # Required by PyInstaller: must be the very first call in __main__ when the
    # app is frozen as a .exe.  Without this, any library that uses
    # multiprocessing internally (e.g. certain cv2/numpy builds) will cause the
    # frozen exe to spawn infinite child processes and immediately crash.
    import multiprocessing
    multiprocessing.freeze_support()

    # Option 2: if launched with a .amyt file argument (double-click), auto-import it
    import sys as _sys
    _startup_amyt = None
    if len(_sys.argv) > 1 and _sys.argv[1].lower().endswith(".amyt"):
        _startup_amyt = _sys.argv[1]
    main(_startup_amyt)