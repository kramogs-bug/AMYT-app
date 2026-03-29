"""
core/macro_engine.py
The core macro engine. Handles:
  1. Recording - listens to mouse/keyboard events and converts to script
  2. Script parsing and execution - runs the macro scripting language
  3. Control flow - IF/ELSE, LOOP, REPEAT, WHILE_IMAGE
  4. Debug mode with breakpoints (pause BEFORE executing a line)
"""

import time
import random
import threading
import json
import re

try:
    from pynput import mouse as pynput_mouse
    from pynput import keyboard as pynput_keyboard
    PYNPUT_AVAILABLE = True
except ImportError:
    PYNPUT_AVAILABLE = False

class UnterminatedBlockError(Exception):
    pass

class StopScriptSignal(Exception):
    """Raised by the STOP command to unwind the entire call stack cleanly."""
    pass


class GotoSignal(Exception):
    """Raised by GOTO to unwind nested IF/LOOP/REPEAT/WHILE blocks and
    resume execution at the named label in the top-level loop."""
    def __init__(self, label: str):
        self.label = label.upper()


class MacroEngine:
    def __init__(self, action_engine, condition_engine, learner, logger):
        self.action    = action_engine
        self.condition = condition_engine
        self.learner   = learner
        self.logger    = logger

        self._stop_event  = threading.Event()
        self._pause_event = threading.Event()
        self._state_lock  = threading.Lock()

        # Debug mode
        self._debug_mode = False
        self._debug_continuous = False
        self._debug_step_event = threading.Event()
        self._current_line = -1
        self._breakpoints = set()          # original line numbers to stop at

        self._recording = False
        self._labels    = {}
        self._window    = None
        self._api       = None
        self._mouse_held = False

        self._recorded_actions = []
        self._last_event_time  = None
        self._char_buffer      = ""

        self._mouse_listener    = None
        self._keyboard_listener = None

        # Toast cooldown cache
        self._last_toast_time = {}
        self.TOAST_COOLDOWN = 2.0  # seconds

        # Throttle for live run-line broadcast (avoid flooding JS bridge)
        self._last_run_line_notify = 0.0

        # Variables
        self._vars = {}

    # ── Backward-compat property shims ────────────────────────────────────────
    @property
    def _stop_flag(self) -> bool:
        return self._stop_event.is_set()

    @_stop_flag.setter
    def _stop_flag(self, value: bool):
        if value:
            self._stop_event.set()
        else:
            self._stop_event.clear()

    @property
    def _paused(self) -> bool:
        return self._pause_event.is_set()

    @_paused.setter
    def _paused(self, value: bool):
        if value:
            self._pause_event.set()
        else:
            self._pause_event.clear()

    # ════════════════════════════════════════════════════════
    #  RECORDING
    # ════════════════════════════════════════════════════════

    def _flush_char_buffer(self):
        if self._char_buffer:
            self._recorded_actions.append(f"TYPE {self._char_buffer}")
            self._char_buffer = ""

    def start_recording(self, countdown: int = 3):
        """
        Start recording with an optional countdown (default 3 seconds).
        Captures mouse clicks, scroll, and keyboard, recording smart WAITs.
        """
        if not PYNPUT_AVAILABLE:
            self.logger.log("pynput not installed. Cannot record.", level="ERROR")
            return

        # Countdown — allows user to switch back to target window
        if countdown > 0:
            for i in range(countdown, 0, -1):
                self.logger.log(f"Recording starts in {i}...")
                time.sleep(1)

        self._recording        = True
        self._pause_event.clear()
        self._recorded_actions = []
        self._char_buffer      = ""
        self._last_event_time  = time.time()
        self._scroll_buffer    = 0   # accumulate scroll ticks
        self._scroll_time      = 0.0
        self.logger.log("Recording started")

        def _add_wait(delay):
            """Add a WAIT only if delay is meaningful (>150ms), capped at 5s."""
            if delay > 0.15:
                capped = min(delay, 5.0)
                self._recorded_actions.append(f"WAIT {capped:.2f}")

        def _flush_scroll():
            """Emit accumulated scroll as a single SCROLL command."""
            if self._scroll_buffer != 0:
                self._recorded_actions.append(f"SCROLL {self._scroll_buffer}")
                self._scroll_buffer = 0

        def on_click(x, y, button, pressed):
            if not self._recording or self._pause_event.is_set():
                return
            if not pressed:
                return

            _flush_scroll()
            self._flush_char_buffer()

            delay = time.time() - self._last_event_time
            self._last_event_time = time.time()
            _add_wait(delay)

            btn_str = str(button).lower()
            if "right" in btn_str:
                self._recorded_actions.append(f"RIGHT_CLICK {int(x)} {int(y)}")
            elif "middle" in btn_str:
                self._recorded_actions.append(f"# middle-click at {int(x)} {int(y)}")
            else:
                self._recorded_actions.append(f"CLICK {int(x)} {int(y)}")

        def on_scroll(x, y, dx, dy):
            """Accumulate scroll ticks — flush when direction changes or on next click."""
            if not self._recording or self._pause_event.is_set():
                return
            now = time.time()
            # If more than 0.5s since last scroll, flush old buffer first
            if now - self._scroll_time > 0.5 and self._scroll_buffer != 0:
                _flush_scroll()
            # Accumulate: dy > 0 = scroll up (positive), dy < 0 = scroll down (negative)
            self._scroll_buffer += int(dy)
            self._scroll_time    = now

        def on_key_press(key):
            if not self._recording or self._pause_event.is_set():
                return

            _flush_scroll()

            delay = time.time() - self._last_event_time
            self._last_event_time = time.time()

            # Stop recording hotkey: Ctrl+Shift+F9
            try:
                if hasattr(key, 'vk') and key.vk == 120:  # F9
                    pass  # handled separately
            except Exception:
                pass

            try:
                char = key.char
                if char and char.isprintable():
                    if delay >= 0.5:
                        self._flush_char_buffer()
                        _add_wait(delay)
                    self._char_buffer += char
                    return
            except AttributeError:
                pass

            self._flush_char_buffer()
            _add_wait(delay)

            try:
                key_name = str(key).replace("Key.", "").lower()
                # Skip modifier-only presses (they show up as hold+release combos)
                if key_name not in ("shift", "ctrl", "alt", "cmd", "meta"):
                    self._recorded_actions.append(f"PRESS {key_name}")
            except Exception:
                pass

        self._mouse_listener    = pynput_mouse.Listener(
            on_click=on_click, on_scroll=on_scroll
        )
        self._keyboard_listener = pynput_keyboard.Listener(on_press=on_key_press)
        self._mouse_listener.start()
        self._keyboard_listener.start()

    def stop_recording(self) -> str:
        self._recording = False
        self._flush_char_buffer()
        # Flush any pending scroll
        if getattr(self, "_scroll_buffer", 0) != 0:
            self._recorded_actions.append(f"SCROLL {self._scroll_buffer}")
            self._scroll_buffer = 0

        if self._mouse_listener:
            self._mouse_listener.stop()
            self._mouse_listener = None
        if self._keyboard_listener:
            self._keyboard_listener.stop()
            self._keyboard_listener = None

        # Clean up: remove trailing WAITs, merge consecutive WAITs
        actions = self._recorded_actions
        cleaned = []
        for line in actions:
            if line.startswith("WAIT ") and cleaned and cleaned[-1].startswith("WAIT "):
                # Merge consecutive WAITs into one
                prev = float(cleaned[-1].split()[1])
                curr = float(line.split()[1])
                cleaned[-1] = f"WAIT {min(prev + curr, 5.0):.2f}"
            else:
                cleaned.append(line)
        # Strip trailing WAITs — they serve no purpose at the end
        while cleaned and cleaned[-1].startswith("WAIT "):
            cleaned.pop()

        script = "\n".join(cleaned)
        self.logger.log(f"Recording stopped. {len(cleaned)} actions captured.")
        return script

    def pause_recording(self):
        if self._pause_event.is_set():
            self._pause_event.clear()
        else:
            self._pause_event.set()
        state = "paused" if self._pause_event.is_set() else "resumed"
        self.logger.log(f"Recording {state}")

    # ════════════════════════════════════════════════════════
    #  SCRIPT EXECUTION (normal and debug)
    # ════════════════════════════════════════════════════════

    def run_script(self, script: str, repeat: int = 1, on_finish=None, on_stop=None,
                   start_from_line: int = 0):
        """Run script normally. start_from_line = 0-based original line number to begin from."""
        self._debug_mode = False
        self._debug_continuous = False
        self._current_line = -1
        self._breakpoints.clear()
        self._stop_event.clear()
        self._pause_event.clear()
        self._goto_label = None
        self._labels = {}
        self._last_toast_time.clear()
        self._vars.clear()

        with self._state_lock:
            self._mouse_held = False

        # Reset motion-gate / confidence state so stale frames from the previous
        # run (possibly captured in a different thread) don't suppress detections
        # on the very first frame of this run.
        if hasattr(self.action, 'detector'):
            self.action.detector.reset_motion_state()

        lines, original_indices = self._prepare_lines(script)

        # Find the first processed-line index whose original index >= start_from_line
        start_idx = 0
        if start_from_line > 0:
            for i, orig in enumerate(original_indices):
                if orig >= start_from_line:
                    start_idx = i
                    break
            if start_idx > 0:
                self.logger.log(
                    f"Run from cursor: starting at original line {start_from_line} "
                    f"(processed index {start_idx})"
                )

        self._run_loop(lines, original_indices, repeat, on_finish, on_stop,
                       start_idx=start_idx)

    def start_debug(self, script: str, repeat: int = 1, on_finish=None):
        """Start script in step‑through debug mode (pauses before every line)."""
        self._debug_mode = True
        self._debug_continuous = False
        self._debug_step_event.clear()
        self._current_line = -1
        self._breakpoints.clear()          # step mode: no breakpoints, pause before every line
        self._stop_event.clear()
        self._pause_event.clear()
        self._goto_label = None
        self._labels = {}
        self._last_toast_time.clear()

        with self._state_lock:
            self._mouse_held = False

        if hasattr(self.action, 'detector'):
            self.action.detector.reset_motion_state()

        lines, original_indices = self._prepare_lines(script)
        if self._window:
            try:
                self._window.evaluate_js("onDebugStart()")
            except Exception:
                pass

        # Pass None for on_stop – debug mode does not have a separate stop callback
        self._run_loop(lines, original_indices, repeat, on_finish, None)

    def start_debug_with_breakpoints(self, script: str, breakpoints: list, repeat: int = 1, on_finish=None):
        """Start debug mode with breakpoints (list of original line numbers to stop at)."""
        self._debug_mode = True
        self._debug_continuous = False
        self._debug_step_event.clear()
        self._current_line = -1
        self._breakpoints = set(breakpoints)
        self._stop_event.clear()
        self._pause_event.clear()
        self._goto_label = None
        self._labels = {}
        self._last_toast_time.clear()
        self._vars.clear()

        with self._state_lock:
            self._mouse_held = False

        lines, original_indices = self._prepare_lines(script)
        if self._window:
            try:
                self._window.evaluate_js("onDebugStart()")
            except Exception:
                pass

        self._run_loop(lines, original_indices, repeat, on_finish, None)

    def _prepare_lines(self, script: str):
        """
        Returns:
            lines: list of stripped non‑empty, non‑comment lines.
            original_indices: list of same length, each element is the
                              original line number (0‑based) from the full script.
        """
        full_lines = script.split("\n")
        lines = []
        original_indices = []
        for idx, raw_line in enumerate(full_lines):
            stripped = raw_line.strip()
            if stripped and not stripped.startswith("#"):
                lines.append(stripped)
                original_indices.append(idx)

        # Build label map using stripped list indices
        for i, line in enumerate(lines):
            parts = line.split()
            if parts and parts[0].upper() == "LABEL" and len(parts) > 1:
                self._labels[parts[1].upper()] = i

        return lines, original_indices

    def _run_loop(self, lines: list, original_indices: list, repeat: int, on_finish, on_stop,
                  start_idx: int = 0):
        self.logger.log(f"Running script ({len(lines)} commands, repeat={repeat}"
                        + (f", from idx {start_idx}" if start_idx else "") + ")...")
        run_count = 0
        stopped = False
        while not self._stop_event.is_set():
            first_start = start_idx if run_count == 0 else 0
            start_line = first_start
            while not self._stop_event.is_set():
                try:
                    self._execute_block(lines, original_indices, start_line, _top_level=True)
                    break
                except StopScriptSignal:
                    self.logger.log("Script stopped by STOP command.")
                    self._stop_event.set()
                    stopped = True
                    break
                except GotoSignal as g:
                    target = g.label
                    if target in self._labels:
                        start_line = self._labels[target]
                        self.logger.log(f"GOTO {target} -> line {start_line}")
                    else:
                        self.logger.log(f"GOTO: unknown label '{target}'", level="WARN")
                        break
                except UnterminatedBlockError as e:
                    self.logger.log(f"Script error: {e}", level="ERROR")
                    self._stop_event.set()
                    stopped = True
                    break

            run_count += 1
            if repeat != 0 and run_count >= repeat:
                break

        self._safe_release_mouse()

        if stopped:
            self.logger.log("Script stopped.")
            if on_stop:
                try:
                    on_stop()
                except Exception as e:
                    self.logger.log(f"on_stop error: {e}", level="WARN")
        else:
            self.logger.log("Script finished.")
            if on_finish:
                try:
                    on_finish()
                except Exception as e:
                    self.logger.log(f"on_finish error: {e}", level="WARN")

        # Debug mode off – ALWAYS run, regardless of stop/finish
        self._debug_mode = False
        self._debug_continuous = False
        self._current_line = -1
        self._breakpoints.clear()
        if self._window:
            try:
                self._window.evaluate_js("onDebugEnd()")
                self._window.evaluate_js("onScriptRunLine(-1)")  # clear run highlight
            except Exception:
                pass
    def _execute_block(self, lines: list, original_indices: list, start: int, _top_level: bool = False) -> int:
        i = start
        while i < len(lines) and not self._stop_event.is_set():
            while self._pause_event.is_set() and not self._stop_event.is_set():
                time.sleep(0.1)
            if self._stop_event.is_set():
                break

            line = lines[i].strip()
            parts = line.split()
            if not parts:
                i += 1
                continue

            original_line = original_indices[i]
            self._current_line = original_line
            self._notify_run_line(original_line)

            # In debug mode, handle pausing BEFORE executing the line
            if self._debug_mode:
                # Highlight current line
                self._current_line = original_line
                if self._window:
                    try:
                        self._window.evaluate_js(f"highlightDebugLine({original_line})")
                    except Exception:
                        pass

                # Determine if we should pause before this line
                pause_before = False
                if not self._debug_continuous:
                    if not self._breakpoints:
                        # Step mode: pause before every line
                        pause_before = True
                    else:
                        # Breakpoint mode: pause only if this line is a breakpoint
                        if original_line in self._breakpoints:
                            pause_before = True

                if pause_before:
                    self.logger.log(f"Debug: pausing before line {original_line}")
                    self._debug_step_event.wait()
                    self._debug_step_event.clear()

            cmd = parts[0].upper()
            self.logger.log(f"Executing line {i} (original {original_line}): {line}")

            # For commands that need argument evaluation, compute evaled_args here
            args = parts[1:]
            evaled_args = [self._eval_arg(a) for a in args]

            # Handle commands (no pause after execution)
            if cmd == "TYPE":
                split_result = line.split(" ", 1)
                raw_text = split_result[1] if len(split_result) > 1 else ""
                self._execute_command(cmd, raw_text)
                i += 1
                continue

            if cmd == "GOTO":
                if not evaled_args:
                    self.logger.log("GOTO missing label", level="WARN")
                    i += 1
                    continue
                raw_label = evaled_args[0]
                target = str(raw_label).upper()
                if target in self._labels:
                    if _top_level:
                        i = self._labels[target]
                        self.logger.log(f"GOTO {target} -> line {i}")
                        continue
                    else:
                        self.logger.log(f"GOTO {target} (unwinding nested block)")
                        raise GotoSignal(target)
                else:
                    self.logger.log(f"GOTO: unknown label '{target}'", level="WARN")
                    i += 1

            elif cmd == "LABEL":
                i += 1

            elif cmd == "STOP":
                self.logger.log("STOP command hit — halting script")
                raise StopScriptSignal()

            elif cmd == "PAUSE_SCRIPT":
                self.logger.log("PAUSE_SCRIPT — waiting for resume")
                self._pause_event.set()
                while self._pause_event.is_set() and not self._stop_event.is_set():
                    time.sleep(0.1)
                i += 1

            elif cmd in ("IF_IMAGE", "IF_NOT_IMAGE"):
                i = self._handle_if(lines, original_indices, i, cmd, evaled_args)

            elif cmd == "LOOP":
                i = self._handle_loop(lines, original_indices, i)

            elif cmd == "REPEAT":
                i = self._handle_repeat(lines, original_indices, i, evaled_args)

            elif cmd == "WHILE_IMAGE":
                i = self._handle_while(lines, original_indices, i, evaled_args)

            elif cmd == "END":
                return i + 1

            elif cmd == "ELSE":
                return i

            else:
                self._execute_command(cmd, args)   # pass raw args; _execute_command will evaluate
                i += 1

        return i

    # ── Expression evaluator and variable helpers ─────────────────

    def _eval_arg(self, arg: str):
        """
        Evaluate a single argument string:
          - If it contains $var references, replace them.
          - If the whole string is a simple arithmetic expression (e.g., $x + 5), compute it.
          - Otherwise return the string as‑is.
        Returns int, float, or str.
        """
        if not isinstance(arg, str):
            return arg

        # First replace $var with their values (as strings)
        def replace_var(m):
            var_name = m.group(1)
            if var_name not in self._vars:
                self.logger.log(f"Undefined variable: {var_name}", level="WARN")
                return "0"
            val = self._vars[var_name]
            # If it's a number, convert to string without extra quotes
            if isinstance(val, (int, float)):
                return str(val)
            else:
                # For strings, we need to preserve quotes for later evaluation? 
                # We'll just return the string, but if it contains spaces it might break.
                # Better: if the original var was quoted string, we should not evaluate as arithmetic.
                return val

        # Replace $var with value (string representation)
        expr = re.sub(r'\$([a-zA-Z_][a-zA-Z0-9_]*)', replace_var, arg)

        # Try to evaluate as a simple arithmetic expression
        # Allowed tokens: numbers, +, -, *, /, whitespace
        # If expr contains anything else (letters, quotes), treat as string.
        if re.search(r'[^0-9\s\+\-\*/\.]', expr):
            # Contains non‑math characters – treat as string
            return expr.strip()

        try:
            # Use eval safely – only numbers and operators allowed
            # We restrict the environment to avoid dangerous functions
            result = eval(expr, {"__builtins__": None}, {})
            if isinstance(result, (int, float)):
                return result
            else:
                return str(result)
        except:
            # Evaluation failed – return the string as‑is
            return expr.strip()

    def _eval_type_arg(self, text: str) -> str:
        """
        Variant of _eval_arg for use with TYPE only.
        Expands $variable references but ALWAYS returns a str — never int or
        float.  This ensures "TYPE 12345" types the five digit characters and
        doesn't try to pass the integer 12345 to pyautogui.typewrite(), which
        only accepts strings and would silently drop or error on a non-string.
        """
        if not isinstance(text, str):
            return str(text)
        # Expand $var references (same as _eval_arg)
        def replace_var(m):
            var_name = m.group(1)
            if var_name not in self._vars:
                self.logger.log(f"TYPE: undefined variable ${var_name}", level="WARN")
                return ""
            val = self._vars[var_name]
            return str(val)          # always stringify — even numeric vars
        expanded = re.sub(r'\$([a-zA-Z_][a-zA-Z0-9_]*)', replace_var, text)
        return expanded              # return as str, never eval as arithmetic

    def _notify_var_update(self, name: str, value):
        """Push variable update to the debug watch panel in real time."""
        if not self._window:
            return
        try:
            import json
            safe_name  = json.dumps(str(name))
            safe_value = json.dumps(str(value))
            self._window.evaluate_js(
                f"onDebugVarUpdate({safe_name}, {safe_value})"
            )
        except Exception:
            pass

    def _notify_run_line(self, line_index: int):
        """
        Broadcast the currently-executing line index to the JS editor so it
        can be highlighted green in real time.
        Throttled to at most one call per 80 ms to avoid flooding the
        pywebview JS bridge during tight loops.
        """
        if not self._window or self._debug_mode:
            # Debug mode has its own highlighting (highlightDebugLine)
            return
        now = time.time()
        if now - self._last_run_line_notify < 0.08:
            return
        self._last_run_line_notify = now
        try:
            self._window.evaluate_js(f"onScriptRunLine({line_index})")
        except Exception:
            pass

    def _notify_error_line(self):
        """Highlight the erroring line in the script editor."""
        if not self._window or self._current_line < 0:
            return
        try:
            self._window.evaluate_js(
                f"onScriptErrorLine({self._current_line})"
            )
        except Exception:
            pass

    def get_last_error_line(self) -> int:
        """Return the 0-based original line index of the last error, or -1."""
        return self._current_line

    def get_vars_snapshot(self) -> dict:
        """Return a copy of all current variables (for debugger watch panel)."""
        return {k: str(v) for k, v in self._vars.items()}

    # ── Debug control methods (called from UI) ─────────────────
    def debug_step(self):
        """Execute next line and pause."""
        self.logger.log("debug_step() called from UI")
        if self._debug_mode and not self._debug_continuous:
            self._debug_step_event.set()

    def debug_continue(self):
        """Run continuously until breakpoint or end."""
        if self._debug_mode:
            self._debug_continuous = True
            self._debug_step_event.set()

    def debug_stop(self):
        """Stop debugging (same as stop_macro)."""
        self.stop()

    # ── Standard script control ────────────────────────────────
    def _safe_release_mouse(self):
        with self._state_lock:
            if not self._mouse_held:
                return
            self._mouse_held = False

        try:
            from action_engine import _PYDIRECTINPUT_AVAILABLE, _pydirectinput
            if _PYDIRECTINPUT_AVAILABLE:
                _pydirectinput.mouseUp(button='left')
            else:
                import pyautogui
                pyautogui.mouseUp(button='left')
            self.logger.log("Safety mouse release (was held by FIND_HOLD)")
        except Exception:
            pass

    def stop(self):
        self._stop_event.set()
        self._pause_event.clear()
        self._safe_release_mouse()
        # Unblock debug step wait
        if self._debug_mode:
            self._debug_step_event.set()
        self.logger.log("Stop signal sent to macro engine")

    def pause_script(self):
        self._pause_event.set()
        self.logger.log("Script paused")

    def resume_script(self):
        self._pause_event.clear()
        self.logger.log("Script resumed")

    # ── IF/ELSE handlers (updated to use evaluated args) ─────
    def _handle_if(self, lines: list, original_indices: list, start: int, cmd: str, evaled_args: list) -> int:
        if not evaled_args:
            self.logger.log("IF_IMAGE: missing template name", level="ERROR")
            # Skip to END
            depth = 1
            i = start + 1
            while i < len(lines):
                l = lines[i].strip()
                l_up = l.upper()
                l_cmd = l_up.split()[0] if l_up.split() else ""
                if l_cmd in ("IF_IMAGE", "IF_NOT_IMAGE", "LOOP", "REPEAT", "WHILE_IMAGE"):
                    depth += 1
                elif l_cmd == "END":
                    depth -= 1
                    if depth == 0:
                        return i + 1
                i += 1
            return i + 1

        template = str(evaled_args[0])
        confidence = 0.8

        # Parse confidence from remaining evaluated args
        for arg in evaled_args[1:]:
            if isinstance(arg, str) and arg.startswith('confidence='):
                try:
                    confidence = float(arg.split('=')[1])
                except:
                    pass
                break
            else:
                # If it's a number, treat as confidence (legacy)
                try:
                    confidence = float(arg)
                    break
                except (ValueError, TypeError):
                    pass

        if cmd == "IF_IMAGE":
            condition = self.condition.check_image_exists(template, confidence)
        else:  # IF_NOT_IMAGE
            condition = self.condition.check_image_not_exists(template, confidence)

        if_lines = []
        else_lines = []
        in_else = False
        depth = 1
        i = start + 1

        while i < len(lines):
            l = lines[i].strip()
            l_up = l.upper()
            l_cmd = l_up.split()[0] if l_up.split() else ""

            if l_cmd in ("IF_IMAGE", "IF_NOT_IMAGE", "LOOP", "REPEAT", "WHILE_IMAGE"):
                depth += 1
            elif l_cmd == "END":
                depth -= 1
                if depth == 0:
                    i += 1
                    break
            elif l_cmd == "ELSE" and depth == 1:
                in_else = True
                i += 1
                continue

            if depth >= 1:
                if in_else:
                    else_lines.append(l)
                else:
                    if_lines.append(l)

            i += 1

        if condition:
            self.logger.log("IF condition TRUE → running IF block")
            self._execute_block(if_lines, original_indices, 0)
        else:
            self.logger.log("IF condition FALSE → running ELSE block")
            self._execute_block(else_lines, original_indices, 0)

        return i

    def _handle_loop(self, lines: list, original_indices: list, start: int) -> int:
        loop_body, end_index = self._collect_block(lines, start + 1)

        while not self._stop_event.is_set():
            self._execute_block(loop_body, original_indices, 0)
            time.sleep(0.01)

        return end_index

    def _handle_repeat(self, lines: list, original_indices: list, start: int, evaled_args: list) -> int:
        count = 1
        if evaled_args:
            try:
                count = int(evaled_args[0])
            except (ValueError, TypeError):
                self.logger.log(f"REPEAT: invalid count '{evaled_args[0]}', using 1", level="WARN")

        repeat_body, end_index = self._collect_block(lines, start + 1)

        for iteration in range(count):
            if self._stop_event.is_set():
                break
            self.logger.log(f"REPEAT iteration {iteration + 1}/{count}")
            self._execute_block(repeat_body, original_indices, 0)

        return end_index

    def _handle_while(self, lines: list, original_indices: list, start: int, evaled_args: list) -> int:
        if not evaled_args:
            self.logger.log("WHILE_IMAGE: missing template name", level="ERROR")
            # Skip to END
            depth = 1
            i = start + 1
            while i < len(lines):
                l = lines[i].strip()
                l_up = l.upper()
                l_cmd = l_up.split()[0] if l_up.split() else ""
                if l_cmd in ("IF_IMAGE", "IF_NOT_IMAGE", "LOOP", "REPEAT", "WHILE_IMAGE"):
                    depth += 1
                elif l_cmd == "END":
                    depth -= 1
                    if depth == 0:
                        return i + 1
                i += 1
            return i + 1

        template = str(evaled_args[0])
        confidence = 0.8

        for arg in evaled_args[1:]:
            if isinstance(arg, str) and arg.startswith('confidence='):
                try:
                    confidence = float(arg.split('=')[1])
                except:
                    pass
                break
            else:
                try:
                    confidence = float(arg)
                    break
                except (ValueError, TypeError):
                    pass

        while_body, end_index = self._collect_block(lines, start + 1)

        while not self._stop_event.is_set():
            if not self.condition.check_image_exists(template, confidence):
                self.logger.log(f"WHILE_IMAGE: '{template}' gone, exiting loop")
                break
            self._execute_block(while_body, original_indices, 0)
            time.sleep(0.1)

        return end_index

    # ════════════════════════════════════════════════════════
    #  IF_VAR / WHILE_VAR / REPEAT_UNTIL / ON_ERROR handlers
    # ════════════════════════════════════════════════════════

    def _eval_condition(self, left_raw: str, op: str, right_raw: str) -> bool:
        """
        Evaluate a comparison: left_raw  op  right_raw
        Supported ops: == != < > <= >= contains startswith endswith
        Both sides are evaluated through _eval_arg first.
        """
        left  = self._eval_arg(left_raw)
        right = self._eval_arg(right_raw)

        # Try numeric comparison if both sides are numbers
        try:
            lf = float(left)
            rf = float(right)
            if op == "==": return lf == rf
            if op == "!=": return lf != rf
            if op == "<":  return lf <  rf
            if op == ">":  return lf >  rf
            if op == "<=": return lf <= rf
            if op == ">=": return lf >= rf
        except (ValueError, TypeError):
            pass

        # String comparison
        ls = str(left).lower()
        rs = str(right).lower()
        if op == "==":         return ls == rs
        if op == "!=":         return ls != rs
        if op == "contains":   return rs in ls
        if op == "startswith": return ls.startswith(rs)
        if op == "endswith":   return ls.endswith(rs)
        # Fallback for < > on strings
        if op == "<":  return ls < rs
        if op == ">":  return ls > rs
        if op == "<=": return ls <= rs
        if op == ">=": return ls >= rs
        return False

    def _parse_var_condition(self, args: list):
        """
        Parse: $var  op  value   (or bare: $var_found)
        Returns (left_str, op_str, right_str) or (left_str, '!=', '0') for bare var.
        """
        raw = ' '.join(str(a) for a in args).strip()
        # Supported operators (longest first to avoid partial match)
        for op in ('==', '!=', '<=', '>=', '<', '>', 'contains', 'startswith', 'endswith'):
            if op in raw:
                idx = raw.find(op)
                left  = raw[:idx].strip()
                right = raw[idx + len(op):].strip()
                return left, op, right
        # Bare variable: treat as truthy check (var != 0 and var != "")
        return raw, '!=', '0'

    def _handle_if_var(self, lines, original_indices, start, args):
        """IF_VAR $var op value … ELSE … END"""
        left, op, right = self._parse_var_condition(args)
        condition = self._eval_condition(left, op, right)
        self.logger.log(f"IF_VAR {left} {op} {right} → {condition}")

        if_lines, else_lines = [], []
        in_else = False
        depth = 1
        i = start + 1
        while i < len(lines):
            l = lines[i].strip()
            l_cmd = l.upper().split()[0] if l.split() else ''
            if l_cmd in self._BLOCK_OPENERS:
                depth += 1
            elif l_cmd == 'END':
                depth -= 1
                if depth == 0:
                    i += 1; break
            elif l_cmd == 'ELSE' and depth == 1:
                in_else = True; i += 1; continue
            if depth >= 1:
                (else_lines if in_else else if_lines).append(l)
            i += 1

        self._execute_block(if_lines if condition else else_lines, original_indices, 0)
        return i

    def _handle_while_var(self, lines, original_indices, start, args):
        """WHILE_VAR $var op value … END"""
        left, op, right = self._parse_var_condition(args)
        loop_body, end_index = self._collect_block(lines, start + 1)
        iteration = 0
        while not self._stop_event.is_set():
            if not self._eval_condition(left, op, right):
                break
            iteration += 1
            self.logger.log(f"WHILE_VAR iteration {iteration}: {left} {op} {right}")
            self._execute_block(loop_body, original_indices, 0)
            time.sleep(0.01)
        return end_index

    def _handle_repeat_until(self, lines, original_indices, start, evaled_args):
        """
        REPEAT_UNTIL IMAGE template_name   — keep repeating body until image found
        REPEAT_UNTIL COLOR #hex            — keep repeating body until color found
        REPEAT_UNTIL VAR $var op value     — keep repeating body until var condition true
        Always executes body at least once.
        """
        loop_body, end_index = self._collect_block(lines, start + 1)
        raw_args = evaled_args
        kind = str(raw_args[0]).upper() if raw_args else 'IMAGE'
        max_iter = 1000   # safety cap

        def _condition_met():
            if kind == 'IMAGE':
                template = str(raw_args[1]) if len(raw_args) > 1 else ''
                conf = 0.8
                return self.condition.check_image_exists(template, conf)
            elif kind == 'COLOR':
                color = str(raw_args[1]) if len(raw_args) > 1 else '#000000'
                tol   = 30
                return self.action.find_color(color, None, tol) is not None
            elif kind == 'VAR':
                sub_args = raw_args[1:]
                left, op, right = self._parse_var_condition([str(a) for a in sub_args])
                return self._eval_condition(left, op, right)
            return True

        for iteration in range(max_iter):
            if self._stop_event.is_set():
                break
            self.logger.log(f"REPEAT_UNTIL iteration {iteration + 1}")
            self._execute_block(loop_body, original_indices, 0)
            if _condition_met():
                self.logger.log(f"REPEAT_UNTIL condition met after {iteration + 1} iteration(s)")
                break
        return end_index

    def _handle_on_error(self, lines, original_indices, start):
        """
        ON_ERROR … END  — wraps next command; runs body if an exception occurs.
        Actually wraps the PREVIOUS executed command's error state.
        We implement it by executing the body only if _last_cmd_failed is True.
        """
        error_body, end_index = self._collect_block(lines, start + 1)
        if getattr(self, '_last_cmd_failed', False):
            self.logger.log("ON_ERROR block triggered")
            self._execute_block(error_body, original_indices, 0)
            self._last_cmd_failed = False
        else:
            self.logger.log("ON_ERROR block skipped (no error)")
        return end_index

    # All commands that open a new block depth
    _BLOCK_OPENERS = frozenset([
        "IF_IMAGE", "IF_NOT_IMAGE", "IF_VAR",
        "LOOP", "REPEAT", "REPEAT_UNTIL",
        "WHILE_IMAGE", "WHILE_VAR",
        "ON_ERROR",
    ])

    def _collect_block(self, lines: list, start: int):
        block = []
        depth = 1
        i = start

        while i < len(lines):
            l = lines[i].strip()
            l_cmd = l.upper().split()[0] if l.upper().split() else ""

            if l_cmd in self._BLOCK_OPENERS:
                depth += 1
            elif l_cmd == "END":
                depth -= 1
                if depth == 0:
                    return block, i + 1

            if depth > 0:
                block.append(l)

            i += 1

        raise UnterminatedBlockError("Unterminated block – missing END keyword.")

    # ════════════════════════════════════════════════════════
    #  COMMAND EXECUTOR
    # ════════════════════════════════════════════════════════
    def _execute_command(self, cmd: str, args):
        """
        Execute a single parsed command. args may be a list or a raw string for TYPE.
        """
        self._last_cmd_failed = False   # reset per-command error flag
        try:
            # For TYPE, args is raw string; expand $var references but always
            # keep the result as a str — never coerce to int/float.
            # "TYPE 12345" must type the characters '1','2','3','4','5', not
            # evaluate 12345 as a number (which pyautogui.typewrite rejects).
            if cmd == "TYPE":
                text = args if isinstance(args, str) else " ".join(args)
                text = self._eval_type_arg(text)
                self.action.type_text(text)
                return

            # For other commands, ensure args is a list and evaluate each argument
            if not isinstance(args, list):
                args = [args]
            evaled_args = [self._eval_arg(a) for a in args]

            # Special handling for SET: "SET var = expression"
            if cmd == "SET":
                if len(args) < 3 or args[1] != '=':
                    self.logger.log("SET: expected format 'SET var = expression'", level="ERROR")
                    return
                var_name = args[0]
                expr = ' '.join(args[2:])  # join the rest as expression
                value = self._eval_arg(expr)
                self._vars[var_name] = value
                self.logger.log(f"SET {var_name} = {value}")
                self._notify_var_update(var_name, value)
                return

            # --- TOAST handling (added here) ---
            if cmd == "TOAST":
                if not evaled_args:
                    msg = "Script message"
                    kind = "info"
                else:
                    # Convert all evaluated args to strings
                    str_args = [str(a) for a in evaled_args]
                    # Last argument may be a kind
                    last = str_args[-1].lower()
                    if last in ("error", "warn", "info", "success"):
                        kind = last
                        msg = " ".join(str_args[:-1]) if len(str_args) > 1 else "Script message"
                    else:
                        kind = "info"
                        msg = " ".join(str_args)

                # Cooldown and display
                now = time.time()
                key = (msg, kind)
                last = self._last_toast_time.get(key, 0)
                if now - last < self.TOAST_COOLDOWN:
                    self.logger.log(f"Toast suppressed (cooldown): {msg} [{kind}]")
                else:
                    self._last_toast_time[key] = now
                    try:
                        if self._api:
                            self._api.show_toast(msg, kind)
                        elif self._window:
                            safe_msg = json.dumps(msg)
                            safe_kind = json.dumps(kind)
                            self._window.evaluate_js(f"toast({safe_msg}, {safe_kind})")
                    except Exception:
                        pass
                    self.logger.log(f"TOAST: {msg} [{kind}]")
                return
            # --- end TOAST ---

            # Now dispatch based on command, using evaled_args
            if cmd == "WAIT":
                self.action.wait(float(evaled_args[0]))

            elif cmd == "WAIT_RANDOM":
                # WAIT_RANDOM min max
                # Waits a uniformly random duration between min and max seconds.
                # Anti-detect: breaks constant-interval timing that bots are
                # flagged for.  Both values are required; min must be < max.
                if len(evaled_args) < 2:
                    self.logger.log("WAIT_RANDOM requires two arguments: min max", level="WARN")
                    return
                lo = float(evaled_args[0])
                hi = float(evaled_args[1])
                if lo > hi:
                    lo, hi = hi, lo   # silently fix reversed args
                duration = random.uniform(lo, hi)
                self.logger.log(f"WAIT_RANDOM {lo}-{hi}s -> waiting {duration:.3f}s")
                self.action.wait(duration)

            elif cmd == "CLICK":
                self.action.click(int(evaled_args[0]), int(evaled_args[1]))
            elif cmd == "DOUBLE_CLICK":
                self.action.double_click(int(evaled_args[0]), int(evaled_args[1]))
            elif cmd == "RIGHT_CLICK":
                self.action.right_click(int(evaled_args[0]), int(evaled_args[1]))
            elif cmd == "MOVE":
                self.action.move(int(evaled_args[0]), int(evaled_args[1]))
            elif cmd == "MOVE_HUMAN":
                self.action.move_human(int(evaled_args[0]), int(evaled_args[1]))
            elif cmd == "SCROLL":
                self.action.scroll(int(evaled_args[0]))
            elif cmd == "DRAG":
                self.action.drag(int(evaled_args[0]), int(evaled_args[1]),
                                int(evaled_args[2]), int(evaled_args[3]))

            elif cmd == "PRESS":
                self.action.press(evaled_args[0])
            elif cmd == "HOLD":
                self.action.hold(evaled_args[0])
            elif cmd == "RELEASE":
                self.action.release(evaled_args[0])
            elif cmd == "HOTKEY":
                self.action.hotkey(evaled_args[0])

            elif cmd == "CLICK_IMAGE":
                p = self._parse_image_args(args, require_dest=False)
                template = p["template"]
                confidence = p["confidence"]
                anchor = p["anchor"]
                offset_x = p["offset_x"]
                offset_y = p["offset_y"]
                region, region_src = self.learner.get_best_region_with_source(template)
                t0 = time.time()
                location = self.action.detector.find_on_screen(template, confidence, region=region)
                dt_ms = int((time.time() - t0) * 1000) 
                if location:
                    x, y = self.action._resolve_position(location, anchor, offset_x, offset_y)
                    self.action.mouse.click(x, y)
                    self.action.logger.log(f"Clicked '{template}' at ({x},{y})")
                else:
                    self.action.logger.log(f"Image not found: '{template}'", level="WARN")
                self.logger.log(
                    f"RegionSelect '{template}': source={region_src} region={region} "
                    f"conf={(location or {}).get('confidence', 0):.2f} took={dt_ms}ms"
                )
                self.learner.record_detection(template, location, location is not None)

            elif cmd == "DOUBLE_CLICK_IMAGE":
                p = self._parse_image_args(args, require_dest=False)
                template = p["template"]
                confidence = p["confidence"]
                anchor = p["anchor"]
                offset_x = p["offset_x"]
                offset_y = p["offset_y"]
                region, region_src = self.learner.get_best_region_with_source(template)
                t0 = time.time()
                location = self.action.detector.find_on_screen(template, confidence, region=region)
                dt_ms = int((time.time() - t0) * 1000) 
                if location:
                    x, y = self.action._resolve_position(location, anchor, offset_x, offset_y)
                    self.action.mouse.double_click(x, y)
                    self.action.logger.log(f"Double-clicked '{template}' at ({x},{y})")
                else:
                    self.action.logger.log(f"Image not found: '{template}'", level="WARN")
                self.logger.log(
                    f"RegionSelect '{template}': source={region_src} region={region} "
                    f"conf={(location or {}).get('confidence', 0):.2f} took={dt_ms}ms"
                )
                self.learner.record_detection(template, location, location is not None)

            elif cmd == "RIGHT_CLICK_IMAGE":
                p = self._parse_image_args(args, require_dest=False)
                template = p["template"]
                confidence = p["confidence"]
                anchor = p["anchor"]
                offset_x = p["offset_x"]
                offset_y = p["offset_y"]
                region, region_src = self.learner.get_best_region_with_source(template)
                t0 = time.time()
                location = self.action.detector.find_on_screen(template, confidence, region=region)
                dt_ms = int((time.time() - t0) * 1000) 
                if location:
                    x, y = self.action._resolve_position(location, anchor, offset_x, offset_y)
                    self.action.mouse.right_click(x, y)
                    self.action.logger.log(f"Right-clicked '{template}' at ({x},{y})")
                else:
                    self.action.logger.log(f"Image not found: '{template}'", level="WARN")
                self.logger.log(
                    f"RegionSelect '{template}': source={region_src} region={region} "
                    f"conf={(location or {}).get('confidence', 0):.2f} took={dt_ms}ms"
                )
                self.learner.record_detection(template, location, location is not None)

            elif cmd in ("CLICK_RANDOM_OFFSET", "DOUBLE_CLICK_RANDOM_OFFSET", "RIGHT_CLICK_RANDOM_OFFSET"):
                # ── CLICK_RANDOM_OFFSET template [radius] [confidence] ─────
                # Finds the template then clicks a uniformly random pixel
                # within `radius` pixels of the resolved anchor point.
                # Syntax examples:
                #   CLICK_RANDOM_OFFSET start_button            (radius=8 default)
                #   CLICK_RANDOM_OFFSET start_button 12         (radius=12)
                #   CLICK_RANDOM_OFFSET start_button conf=0.7   (custom confidence)
                #   CLICK_RANDOM_OFFSET start_button 15 conf=0.75
                p          = self._parse_image_args(args, require_dest=False)
                template   = p["template"]
                confidence = p["confidence"]
                anchor     = p["anchor"]
                offset_x   = p["offset_x"]
                offset_y   = p["offset_y"]
                # radius is the first plain integer after the template name
                # (after _parse_image_args has consumed named keywords)
                radius = 8  # default
                raw_after_tpl = args[1:] if len(args) > 1 else []
                for tok in raw_after_tpl:
                    if isinstance(tok, (int, float)) and not (0.0 < float(tok) <= 1.0):
                        radius = max(0, int(tok))
                        break
                    elif isinstance(tok, str) and tok.isdigit():
                        radius = max(0, int(tok))
                        break

                region, region_src = self.learner.get_best_region_with_source(template)
                t0 = time.time()
                location = self.action.detector.find_on_screen(template, confidence, region=region)
                dt_ms = int((time.time() - t0) * 1000)

                if location:
                    bx, by = self.action._resolve_position(location, anchor, offset_x, offset_y)
                    cx, cy = self.action._random_offset(bx, by, radius)
                    if cmd == "CLICK_RANDOM_OFFSET":
                        self.action.mouse.click(cx, cy)
                        verb = "Clicked"
                    elif cmd == "DOUBLE_CLICK_RANDOM_OFFSET":
                        self.action.mouse.double_click(cx, cy)
                        verb = "Double-clicked"
                    else:
                        self.action.mouse.right_click(cx, cy)
                        verb = "Right-clicked"
                    self.action.logger.log(
                        f"{verb} '{template}' at ({cx},{cy}) "
                        f"[base=({bx},{by}) radius={radius}px]"
                    )
                else:
                    self.action.logger.log(
                        f"Image not found: '{template}' (CLICK_RANDOM_OFFSET)", level="WARN"
                    )
                self.logger.log(
                    f"RegionSelect '{template}': source={region_src} region={region} "
                    f"conf={(location or {}).get('confidence', 0):.2f} took={dt_ms}ms"
                )
                self.learner.record_detection(template, location, location is not None)

            elif cmd == "WAIT_IMAGE":
                template = evaled_args[0]
                timeout = float(evaled_args[1]) if len(evaled_args) > 1 else 30
                region, region_src = self.learner.get_best_region_with_source(template)
                t0 = time.time()
                # Pass stop_check lambda
                result = self.action.detector.wait_for_image(
                    template, timeout=timeout, region=region,
                    stop_check=lambda: self._stop_event.is_set()
                )
                dt_ms = int((time.time() - t0) * 1000)
                self.logger.log(
                    f"RegionSelect '{template}': source={region_src} region={region} "
                    f"conf={(result or {}).get('confidence', 0):.2f} took={dt_ms}ms"
                )
                self.learner.record_detection(template, result, result is not None)

            elif cmd == "WAIT_IMAGE_GONE":
                template = evaled_args[0]
                timeout = float(evaled_args[1]) if len(evaled_args) > 1 else 30
                region, region_src = self.learner.get_best_region_with_source(template)
                t0 = time.time()
                self.action.detector.wait_for_image_to_disappear(
                    template, timeout=timeout, region=region,
                    stop_check=lambda: self._stop_event.is_set()
                )
                dt_ms = int((time.time() - t0) * 1000)
                self.logger.log(
                    f"RegionSelect '{template}': source={region_src} region={region} took={dt_ms}ms"
                )
            elif cmd in ("FIND_CLICK", "FIND_DOUBLE_CLICK", "FIND_RIGHT_CLICK",
                        "FIND_MOVE", "FIND_HOLD", "FIND_DRAG"):
                self._execute_find_action(cmd, evaled_args)

            elif cmd == "NAVIGATE_TO_IMAGE":
                # ── Argument parsing (unchanged) ──────────────────────
                template           = evaled_args[0]
                confidence         = 0.8
                offset_x           = 0
                offset_y           = 0
                nav_timeout        = 0.0
                arrival_region     = None
                arrival_region_h   = None
                arrival_confidence = None
                miss_tolerance     = None

                remaining = list(evaled_args[1:])

                kw_consumed = set()
                for i, arg in enumerate(remaining):
                    if not isinstance(arg, str):
                        continue
                    low = arg.lower()
                    if low.startswith("confidence="):
                        try: confidence = float(arg.split("=")[1])
                        except: pass
                        kw_consumed.add(i)
                    elif low.startswith("offsetx="):
                        try: offset_x = int(arg.split("=")[1])
                        except: pass
                        kw_consumed.add(i)
                    elif low.startswith("offsety="):
                        try: offset_y = int(arg.split("=")[1])
                        except: pass
                        kw_consumed.add(i)
                    elif low.startswith("timeout="):
                        try: nav_timeout = float(arg.split("=")[1])
                        except: pass
                        kw_consumed.add(i)
                    elif low.startswith("arrival_region="):
                        try: arrival_region = int(arg.split("=")[1])
                        except: pass
                        kw_consumed.add(i)
                    elif low.startswith("arrival_region_h="):
                        try: arrival_region_h = int(arg.split("=")[1])
                        except: pass
                        kw_consumed.add(i)
                    elif low.startswith("arrival_confidence="):
                        try: arrival_confidence = float(arg.split("=")[1])
                        except: pass
                        kw_consumed.add(i)
                    elif low.startswith("miss_tolerance="):
                        try: miss_tolerance = int(arg.split("=")[1])
                        except: pass
                        kw_consumed.add(i)
                remaining = [a for i, a in enumerate(remaining) if i not in kw_consumed]

                pos = [a for a in remaining if isinstance(a, (int, float))]
                if len(pos) >= 1: confidence  = float(pos[0])
                if len(pos) >= 2: offset_x    = int(pos[1])
                if len(pos) >= 3: offset_y    = int(pos[2])
                if len(pos) >= 4: nav_timeout = float(pos[3])

                if not self._api:
                    self.logger.log("NAVIGATE_TO_IMAGE: No API reference", level="ERROR")
                    return

                settings           = self._api.get_movement_settings()
                player_x           = settings["player_x"]
                player_y           = settings["player_y"]

                if arrival_region is None:
                    arrival_region = int(settings.get("arrival_region", 200))
                if arrival_region_h is None:
                    arrival_region_h = int(settings.get("arrival_region_h", arrival_region))
                if arrival_confidence is None:
                    arrival_confidence = float(settings.get("arrival_confidence", 0.85))
                if miss_tolerance is None:
                    miss_tolerance = int(settings.get("miss_tolerance", 5))

                # ── Build nav settings dict (superset of movement settings) ──
                nav_settings = dict(settings)
                nav_settings.update({
                    "arrival_region":     arrival_region,
                    "arrival_region_h":   arrival_region_h,
                    "arrival_confidence": arrival_confidence,
                    "miss_tolerance":     miss_tolerance,
                })

                # ── Instantiate MovementAI (Kalman + state machine) ───────
                from movement_ai import MovementAI
                nav = MovementAI(
                    keyboard=self.action.keyboard,
                    detector=self.action.detector,
                    learner=self.learner,
                    logger=self.logger,
                    settings=nav_settings,
                )

                self.logger.log(
                    f"NAVIGATE_TO_IMAGE: heading for \'{template}\' "
                    f"(confidence={confidence}, timeout={nav_timeout}s, "
                    f"miss_tolerance={miss_tolerance}, "
                    f"arrival_region={arrival_region}x{arrival_region_h}px, "
                    f"arrival_confidence={arrival_confidence})"
                )

                start_time = time.time()
                try:
                    while not self._stop_event.is_set():
                        # Timeout guard
                        if nav_timeout > 0 and (time.time() - start_time) >= nav_timeout:
                            self.logger.log(
                                f"NAVIGATE_TO_IMAGE: timeout ({nav_timeout}s) reached "
                                f"without reaching \'{template}\'.", level="WARN"
                            )
                            break

                        result = nav.step(template, confidence, offset_x, offset_y)

                        if result == "arrived":
                            self.logger.log(
                                f"NAVIGATE_TO_IMAGE: arrived at \'{template}\' "
                                f"after {time.time() - start_time:.1f}s"
                            )
                            break
                        elif result == "lost":
                            self.logger.log(
                                f"NAVIGATE_TO_IMAGE: \'{template}\' lost — stopping.",
                                level="WARN"
                            )
                            break
                        # result == "continue" — keep looping
                finally:
                    # CRITICAL: always release keys even on stop/exception/timeout
                    nav.cleanup()

            elif cmd.startswith("TEXT_"):
                # Extract base action: CLICK, DOUBLE_CLICK, etc.
                action = cmd[5:]  # remove "TEXT_"
                p = self._parse_text_args(args, require_dest=(action == "DRAG"))
                text = p["text"]
                confidence = p["confidence"]
                region = p["region"]
                anchor = p["anchor"]
                ox = p["offset_x"]
                oy = p["offset_y"]

                self.logger.log(f"{cmd} '{text}' anchor={anchor} offset=({ox},{oy}) conf={confidence} region={region}")

                # Find text
                box = self.action.find_text(text, region, confidence)
                if box:
                    x, y, w, h = box
                    # Resolve position based on anchor and offset (similar to image)
                    final_x, final_y = self._resolve_position_from_rect([x, y, w, h], anchor, ox, oy)
                    if action == "CLICK":
                        self.action.mouse.click(final_x, final_y)
                    elif action == "DOUBLE_CLICK":
                        self.action.mouse.double_click(final_x, final_y)
                    elif action == "RIGHT_CLICK":
                        self.action.mouse.right_click(final_x, final_y)
                    elif action == "MOVE":
                        self.action.mouse.move(final_x, final_y)
                    elif action == "HOLD":
                        self.action.mouse.move(final_x, final_y)
                        from action_engine import _PYDIRECTINPUT_AVAILABLE, _pydirectinput
                        if _PYDIRECTINPUT_AVAILABLE:
                            _pydirectinput.mouseDown(button='left')
                        else:
                            pyautogui.mouseDown(button='left')
                        with self._state_lock:
                            self._mouse_held = True
                    elif action == "DRAG":
                        dest_x = p["dest_x"]
                        dest_y = p["dest_y"]
                        self.action.mouse.drag(final_x, final_y, dest_x, dest_y)
                    self.logger.log(f"{cmd} at ({final_x},{final_y})")
                else:
                    self.logger.log(f"Text '{text}' not found", level="WARN")

            elif cmd.startswith("COLOR_"):
                action = cmd[6:]  # remove "COLOR_"
                p = self._parse_color_args(args, require_dest=(action == "DRAG"))
                color = p["color"]
                tolerance = p["tolerance"]
                region = p["region"]
                anchor = p["anchor"]
                ox = p["offset_x"]
                oy = p["offset_y"]

                self.logger.log(f"{cmd} {color} tolerance={tolerance} anchor={anchor} offset=({ox},{oy}) region={region}")

                pos = self.action.find_color(color, region, tolerance)
                if pos:
                    x, y = pos
                    # For color, we have just a point, so anchor doesn't really apply except offset.
                    final_x = x + ox
                    final_y = y + oy
                    if action == "CLICK":
                        self.action.mouse.click(final_x, final_y)
                    elif action == "DOUBLE_CLICK":
                        self.action.mouse.double_click(final_x, final_y)
                    elif action == "RIGHT_CLICK":
                        self.action.mouse.right_click(final_x, final_y)
                    elif action == "MOVE":
                        self.action.mouse.move(final_x, final_y)
                    elif action == "HOLD":
                        self.action.mouse.move(final_x, final_y)
                        from action_engine import _PYDIRECTINPUT_AVAILABLE, _pydirectinput
                        if _PYDIRECTINPUT_AVAILABLE:
                            _pydirectinput.mouseDown(button='left')
                        else:
                            pyautogui.mouseDown(button='left')
                        with self._state_lock:
                            self._mouse_held = True
                    elif action == "DRAG":
                        dest_x = p["dest_x"]
                        dest_y = p["dest_y"]
                        self.action.mouse.drag(final_x, final_y, dest_x, dest_y)
                    self.logger.log(f"{cmd} at ({final_x},{final_y})")
                else:
                    self.logger.log(f"Color {color} not found", level="WARN")

            elif cmd == "READ_TEXT":
                # READ_TEXT "search text" -> $variable [confidence=80] [region=x y w h]
                # Reads text position from screen and stores the found text itself,
                # or stores coordinates as "$var_x", "$var_y" etc.
                # Syntax: READ_TEXT "label text" -> myvar [confidence=80] [region=...]
                # Also supports: READ_TEXT region=x y w h -> myvar  (reads ALL text)
                raw = " ".join(str(a) for a in args)
                # Parse -> variable name
                var_name = None
                if "->" in raw:
                    left_part, var_part = raw.rsplit("->", 1)
                    var_name = var_part.strip().lstrip("$")
                    raw = left_part.strip()
                else:
                    self.logger.log("READ_TEXT: missing -> variable name — use: READ_TEXT \"text\" -> $var", level="ERROR")
                    return  # exit _execute_command cleanly

                p = self._parse_text_args(raw.split() if raw else [], require_dest=False)
                search_text = p["text"]
                confidence  = p["confidence"]
                region      = p["region"]

                if search_text:
                    # Find the specific text and store its bounding box coords
                    box = self.action.find_text(search_text, region, confidence)
                    if box:
                        x, y, w, h = box
                        self._vars[var_name]            = search_text
                        self._vars[var_name + "_x"]     = x
                        self._vars[var_name + "_y"]     = y
                        self._vars[var_name + "_w"]     = w
                        self._vars[var_name + "_h"]     = h
                        self._vars[var_name + "_found"] = 1
                        self.logger.log(
                            f"READ_TEXT '{search_text}' -> ${var_name} "
                            f"found at ({x},{y})"
                        )
                    else:
                        self._vars[var_name]            = ""
                        self._vars[var_name + "_found"] = 0
                        self.logger.log(
                            f"READ_TEXT '{search_text}' -> not found, "
                            f"${var_name}=''", level="WARN"
                        )
                else:
                    # No search text: read ALL text from region/screen via OCR
                    try:
                        from PIL import Image
                        all_text = self.action.ocr.read_text_from_region(
                            self.action.ocr._grab_screen(region)[0]
                            if hasattr(self.action.ocr, '_grab_screen')
                            else None
                        )
                        self._vars[var_name] = all_text.strip()
                        self.logger.log(
                            f"READ_TEXT (all) -> ${var_name} = '{all_text[:40]}'"
                        )
                    except Exception as e:
                        self._vars[var_name] = ""
                        self.logger.log(f"READ_TEXT error: {e}", level="ERROR")

            elif cmd == "WAIT_COLOR":
                # WAIT_COLOR #hex [tolerance=30] [region=x y w h] [timeout=10]
                p       = self._parse_color_args(evaled_args, require_dest=False)
                color   = p["color"]
                tol     = p["tolerance"]
                region  = p["region"]
                timeout = 10.0
                for a in args:
                    if isinstance(a, str) and a.lower().startswith("timeout="):
                        try: timeout = float(a.split("=", 1)[1])
                        except: pass

                self.logger.log(
                    f"WAIT_COLOR {color} tol={tol} region={region} "
                    f"timeout={timeout}s"
                )
                import time as _time
                start = _time.time()
                found = False
                while _time.time() - start < timeout:
                    with self._state_lock:
                        if self._stop_flag:
                            raise StopScriptSignal()
                    pos = self.action.find_color(color, region, tol)
                    if pos:
                        found = True
                        self.logger.log(
                            f"WAIT_COLOR {color} found at {pos} "
                            f"after {_time.time()-start:.1f}s"
                        )
                        break
                    _time.sleep(0.1)
                if not found:
                    self.logger.log(
                        f"WAIT_COLOR {color} timeout after {timeout}s",
                        level="WARN"
                    )

            elif cmd == "READ_COLOR":
                # READ_COLOR x y -> $variable  — reads pixel color at (x,y) into variable
                raw = " ".join(str(a) for a in args)
                var_name = None
                if "->" in raw:
                    left_part, var_part = raw.rsplit("->", 1)
                    var_name = var_part.strip().lstrip("$")
                    coords   = left_part.strip().split()
                else:
                    self.logger.log("READ_COLOR: missing -> variable name — use: READ_COLOR x y -> $var", level="ERROR")
                    return  # exit _execute_command cleanly

                try:
                    px = int(self._eval_arg(coords[0]))
                    py = int(self._eval_arg(coords[1]))
                    color_tuple = self.action.color.get_pixel_color(px, py)
                    hex_color = "#{:02X}{:02X}{:02X}".format(*color_tuple)
                    self._vars[var_name]        = hex_color
                    self._vars[var_name + "_r"] = color_tuple[0]
                    self._vars[var_name + "_g"] = color_tuple[1]
                    self._vars[var_name + "_b"] = color_tuple[2]
                    self.logger.log(
                        f"READ_COLOR ({px},{py}) -> ${var_name} = {hex_color}"
                    )
                except Exception as e:
                    self.logger.log(f"READ_COLOR error: {e}", level="ERROR")

            elif cmd == "CLIPBOARD_SET":
                # CLIPBOARD_SET "text"
                try:
                    import pyperclip
                    text = self._eval_arg(" ".join(str(a) for a in args))
                    pyperclip.copy(str(text))
                    self.logger.log(f"CLIPBOARD_SET: copied '{str(text)[:40]}'")
                except ImportError:
                    self.logger.log("CLIPBOARD_SET: pyperclip not installed. Run: pip install pyperclip", level="ERROR")
                except Exception as e:
                    self.logger.log(f"CLIPBOARD_SET error: {e}", level="ERROR")

            elif cmd == "CLIPBOARD_GET":
                # CLIPBOARD_GET -> $variable
                raw = " ".join(str(a) for a in args)
                if "->" not in raw:
                    self.logger.log("CLIPBOARD_GET: missing -> variable — use: CLIPBOARD_GET -> $var", level="ERROR")
                    return
                var_name = raw.rsplit("->", 1)[1].strip().lstrip("$")
                try:
                    import pyperclip
                    text = pyperclip.paste()
                    self._vars[var_name] = text
                    self.logger.log(f"CLIPBOARD_GET -> ${var_name} = '{text[:40]}'")
                    # Notify debugger of variable change
                    self._notify_var_update(var_name, text)
                except ImportError:
                    self.logger.log("CLIPBOARD_GET: pyperclip not installed. Run: pip install pyperclip", level="ERROR")
                except Exception as e:
                    self.logger.log(f"CLIPBOARD_GET error: {e}", level="ERROR")

            elif cmd == "CLIPBOARD_COPY":
                # CLIPBOARD_COPY  — copies current selection (Ctrl+C)
                try:
                    import pyperclip, pyautogui, time as _t
                    pyautogui.hotkey("ctrl", "c")
                    _t.sleep(0.1)
                    text = pyperclip.paste()
                    self._vars["_clipboard"] = text
                    self.logger.log(f"CLIPBOARD_COPY: '{text[:40]}'")
                except Exception as e:
                    self.logger.log(f"CLIPBOARD_COPY error: {e}", level="ERROR")

            elif cmd == "CLIPBOARD_PASTE":
                # CLIPBOARD_PASTE  — pastes clipboard (Ctrl+V)
                try:
                    import pyautogui
                    pyautogui.hotkey("ctrl", "v")
                    self.logger.log("CLIPBOARD_PASTE executed")
                except Exception as e:
                    self.logger.log(f"CLIPBOARD_PASTE error: {e}", level="ERROR")

            else:
                self.logger.log(f"Unknown command: {cmd}", level="WARN")


        except StopScriptSignal:
            raise
        except GotoSignal:
            raise
        except IndexError:
            self._last_cmd_failed = True
            self.logger.log(f"Command '{cmd}' missing arguments: {args}", level="ERROR")
            self._notify_error_line()
        except ValueError as e:
            self._last_cmd_failed = True
            self.logger.log(f"Command '{cmd}' bad argument: {e}", level="ERROR")
            self._notify_error_line()
        except Exception as e:
            self._last_cmd_failed = True
            self.logger.log(f"Error executing '{cmd}': {e}", level="ERROR")
            self._notify_error_line()

    # ── FIND_* helpers ─────────────────────────────────────────
    _VALID_ANCHORS = {
        "center", "top_left", "top_right", "bottom_left", "bottom_right",
        "top", "bottom", "left", "right"
    }

    def _parse_image_args(self, args: list, require_dest: bool = False) -> dict:
        """
        Parse arguments for CLICK_IMAGE, DOUBLE_CLICK_IMAGE, etc.
        Supports both positional and keyword syntax.
        Returns dict with keys: template, confidence, anchor, offset_x, offset_y,
        and (if require_dest) dest_x, dest_y.
        """
        result = {
            "template": args[0] if args else "",
            "confidence": 0.8,
            "anchor": "center",
            "offset_x": 0,
            "offset_y": 0,
        }
        if require_dest:
            result["dest_x"] = int(args[1]) if len(args) > 1 else 0
            result["dest_y"] = int(args[2]) if len(args) > 2 else 0
            start_idx = 3
        else:
            start_idx = 1

        positional = []
        for tok in args[start_idx:]:
            if isinstance(tok, str) and "=" in tok:
                key, val = tok.split("=", 1)
                key = key.lower()
                if key in ("confidence", "conf"):
                    result["confidence"] = float(val)
                elif key in ("anchor",):
                    result["anchor"] = val.lower()
                elif key in ("offsetx", "offset_x"):
                    result["offset_x"] = int(val)
                elif key in ("offsety", "offset_y"):
                    result["offset_y"] = int(val)
                elif key in ("destx", "dest_x") and require_dest:
                    result["dest_x"] = int(val)
                elif key in ("desty", "dest_y") and require_dest:
                    result["dest_y"] = int(val)
            else:
                positional.append(tok)

        # Look for anchor string
        for tok in positional[:]:
            if isinstance(tok, str) and tok.lower() in self._VALID_ANCHORS:
                result["anchor"] = tok.lower()
                positional.remove(tok)
                break

        # Look for up to two offset numbers
        offsets = []
        for tok in positional[:]:
            if isinstance(tok, (int, float)):
                offsets.append(int(tok))
                positional.remove(tok)
            else:
                break
        if len(offsets) >= 1:
            result["offset_x"] = offsets[0]
        if len(offsets) >= 2:
            result["offset_y"] = offsets[1]

        # Whatever remains, try to parse as confidence (float)
        if positional:
            try:
                v = float(positional[0])
                if 0.0 <= v <= 1.0:
                    result["confidence"] = v
            except (ValueError, TypeError):
                pass

        if "confidence" in result:
            if result["confidence"] < 0.0 or result["confidence"] > 1.0:
                self.logger.log(f"Confidence {result['confidence']} out of range [0,1]; clamping to 0.8", level="WARN")
                result["confidence"] = max(0.0, min(1.0, result["confidence"]))

        return result

    def _parse_find_args(self, args: list) -> dict:
        result = {
            "template":   args[0] if args else "",
            "anchor":     "center",
            "offset_x":   0,
            "offset_y":   0,
            "confidence": 0.8,
        }

        positional = []
        for tok in args[1:]:
            if isinstance(tok, str) and "=" in tok:
                key, val = tok.split("=", 1)
                key = key.lower()
                if key in ("anchor",):
                    result["anchor"] = val.lower()
                elif key in ("offsetx", "offset_x"):
                    result["offset_x"] = int(val)
                elif key in ("offsety", "offset_y"):
                    result["offset_y"] = int(val)
                elif key in ("confidence", "conf"):
                    result["confidence"] = float(val)
            else:
                positional.append(tok)

        # First, look for anchor string
        for tok in positional[:]:
            if isinstance(tok, str) and tok.lower() in self._VALID_ANCHORS:
                result["anchor"] = tok.lower()
                positional.remove(tok)
                break

        # Then, look for up to two offset numbers
        offsets = []
        for tok in positional[:]:
            if isinstance(tok, (int, float)):
                offsets.append(int(tok))
                positional.remove(tok)
            else:
                break

        if len(offsets) >= 1:
            result["offset_x"] = offsets[0]
        if len(offsets) >= 2:
            result["offset_y"] = offsets[1]

        # Whatever remains, try to parse as confidence (float)
        if positional:
            try:
                v = float(positional[0])
                if 0.0 <= v <= 1.0:
                    result["confidence"] = v
            except (ValueError, TypeError):
                pass
        
        if "confidence" in result:
            if result["confidence"] < 0.0 or result["confidence"] > 1.0:
                self.logger.log(f"Confidence {result['confidence']} out of range [0,1]; clamping to 0.8", level="WARN")
                result["confidence"] = max(0.0, min(1.0, result["confidence"]))
                
        return result
    
    def _parse_text_args(self, args, require_dest=False):
        """
        Parse arguments for TEXT_* commands.
        Format: TEXT_CLICK "search text" [confidence=80] [region=x y w h] [anchor=center] [offsetX=10] [offsetY=20]
        For drag: TEXT_DRAG "text" dest_x dest_y ...
        """
        result = {
            "text": args[0] if args else "",
            "confidence": 80,  # OCR confidence 0-100
            "region": None,
            "anchor": "center",
            "offset_x": 0,
            "offset_y": 0,
        }
        if require_dest:
            result["dest_x"] = int(args[1]) if len(args) > 1 else 0
            result["dest_y"] = int(args[2]) if len(args) > 2 else 0
            start_idx = 3
        else:
            start_idx = 1

        positional = []
        for tok in args[start_idx:]:
            if isinstance(tok, str) and "=" in tok:
                key, val = tok.split("=", 1)
                key = key.lower()
                if key in ("confidence", "conf"):
                    result["confidence"] = int(val)
                elif key in ("anchor",):
                    result["anchor"] = val.lower()
                elif key in ("offsetx", "offset_x"):
                    result["offset_x"] = int(val)
                elif key in ("offsety", "offset_y"):
                    result["offset_y"] = int(val)
                elif key == "region":
                    parts = val.split()
                    if len(parts) == 4:
                        result["region"] = [int(p) for p in parts]
            else:
                positional.append(tok)

        # Look for anchor string in positional
        _VALID_ANCHORS = {"center", "top_left", "top_right", "bottom_left", "bottom_right", "top", "bottom", "left", "right"}
        for tok in positional[:]:
            if isinstance(tok, str) and tok.lower() in _VALID_ANCHORS:
                result["anchor"] = tok.lower()
                positional.remove(tok)
                break

        # Look for up to two offset numbers
        offsets = []
        for tok in positional[:]:
            if isinstance(tok, (int, float)):
                offsets.append(int(tok))
                positional.remove(tok)
            else:
                break
        if len(offsets) >= 1:
            result["offset_x"] = offsets[0]
        if len(offsets) >= 2:
            result["offset_y"] = offsets[1]

        # Remaining positional – ignore
        return result
    
    def _parse_color_args(self, args, require_dest=False):
        """
        Parse arguments for COLOR_* commands.
        Format: COLOR_CLICK #FF0000 [tolerance=30] [region=x y w h] [anchor=center] [offsetX=10] [offsetY=20]
        """
        result = {
            "color": args[0] if args else "",
            "tolerance": 30,
            "region": None,
            "anchor": "center",
            "offset_x": 0,
            "offset_y": 0,
        }
        if require_dest:
            result["dest_x"] = int(args[1]) if len(args) > 1 else 0
            result["dest_y"] = int(args[2]) if len(args) > 2 else 0
            start_idx = 3
        else:
            start_idx = 1

        positional = []
        for tok in args[start_idx:]:
            if isinstance(tok, str) and "=" in tok:
                key, val = tok.split("=", 1)
                key = key.lower()
                if key in ("tolerance", "tol"):
                    result["tolerance"] = int(val)
                elif key in ("anchor",):
                    result["anchor"] = val.lower()
                elif key in ("offsetx", "offset_x"):
                    result["offset_x"] = int(val)
                elif key in ("offsety", "offset_y"):
                    result["offset_y"] = int(val)
                elif key == "region":
                    parts = val.split()
                    if len(parts) == 4:
                        result["region"] = [int(p) for p in parts]
            else:
                positional.append(tok)

        # Similar anchor/offset parsing as above
        _VALID_ANCHORS = {"center", "top_left", "top_right", "bottom_left", "bottom_right", "top", "bottom", "left", "right"}
        for tok in positional[:]:
            if isinstance(tok, str) and tok.lower() in _VALID_ANCHORS:
                result["anchor"] = tok.lower()
                positional.remove(tok)
                break

        offsets = []
        for tok in positional[:]:
            if isinstance(tok, (int, float)):
                offsets.append(int(tok))
                positional.remove(tok)
            else:
                break
        if len(offsets) >= 1:
            result["offset_x"] = offsets[0]
        if len(offsets) >= 2:
            result["offset_y"] = offsets[1]

        return result

    def _execute_find_action(self, cmd: str, args: list):
        p = self._parse_find_args(args)
        tpl    = p["template"]
        anchor = p["anchor"]
        ox     = p["offset_x"]
        oy     = p["offset_y"]
        conf   = p["confidence"]

        self.logger.log(f"{cmd} '{tpl}' anchor={anchor} offset=({ox},{oy}) conf={conf}")

        find_result = self.action._find_with_log(tpl, conf)

        if cmd == "FIND_CLICK":
            if find_result:
                x, y = self.action._resolve_position(find_result, anchor, ox, oy)
                self.action.mouse.click(x, y)
                self.action.logger.log(f"FIND_CLICK '{tpl}' at ({x},{y})")
            self.learner.record_detection(tpl, find_result, find_result is not None)
        elif cmd == "FIND_DOUBLE_CLICK":
            if find_result:
                x, y = self.action._resolve_position(find_result, anchor, ox, oy)
                self.action.mouse.double_click(x, y)
                self.action.logger.log(f"FIND_DOUBLE_CLICK '{tpl}' at ({x},{y})")
            self.learner.record_detection(tpl, find_result, find_result is not None)
        elif cmd == "FIND_RIGHT_CLICK":
            if find_result:
                x, y = self.action._resolve_position(find_result, anchor, ox, oy)
                self.action.mouse.right_click(x, y)
                self.action.logger.log(f"FIND_RIGHT_CLICK '{tpl}' at ({x},{y})")
            self.learner.record_detection(tpl, find_result, find_result is not None)
        elif cmd == "FIND_MOVE":
            if find_result:
                x, y = self.action._resolve_position(find_result, anchor, ox, oy)
                self.action.mouse.move(x, y)
                self.action.logger.log(f"FIND_MOVE '{tpl}' at ({x},{y})")
            self.learner.record_detection(tpl, find_result, find_result is not None)
        elif cmd == "FIND_HOLD":
            if find_result:
                x, y = self.action._resolve_position(find_result, anchor, ox, oy)
                self.action.mouse.move(x, y)
                from action_engine import _PYDIRECTINPUT_AVAILABLE, _pydirectinput
                if _PYDIRECTINPUT_AVAILABLE:
                    _pydirectinput.mouseDown(button='left')
                else:
                    import pyautogui
                    pyautogui.mouseDown(button='left')
                with self._state_lock:
                    self._mouse_held = True
                self.action.logger.log(f"FIND_HOLD '{tpl}' at ({x},{y})")
            self.learner.record_detection(tpl, find_result, find_result is not None)
        elif cmd == "FIND_DRAG":
            drag_args = self._parse_drag_find_args(args)
            if find_result:
                sx, sy = self.action._resolve_position(
                    find_result, drag_args["anchor"],
                    drag_args["offset_x"], drag_args["offset_y"]
                )
                self.action.mouse.drag(sx, sy, drag_args["dest_x"], drag_args["dest_y"])
                self.action.logger.log(
                    f"FIND_DRAG '{tpl}' from ({sx},{sy}) "
                    f"to ({drag_args['dest_x']},{drag_args['dest_y']})"
                )
            self.learner.record_detection(tpl, find_result, find_result is not None)

    def _parse_drag_find_args(self, args: list) -> dict:
        result = {
            "template":   args[0] if args else "",
            "dest_x":     int(args[1]) if len(args) > 1 else 0,
            "dest_y":     int(args[2]) if len(args) > 2 else 0,
            "anchor":     "center",
            "offset_x":   0,
            "offset_y":   0,
            "confidence": 0.8,
        }
        for tok in args[3:]:
            if isinstance(tok, str) and "=" in tok:
                key, val = tok.split("=", 1)
                key = key.lower()
                if key == "anchor":
                    result["anchor"] = val.lower()
                elif key in ("offsetx", "offset_x"):
                    result["offset_x"] = int(val)
                elif key in ("offsety", "offset_y"):
                    result["offset_y"] = int(val)
                elif key in ("confidence", "conf"):
                    result["confidence"] = float(val)
            elif isinstance(tok, str) and tok.lower() in self._VALID_ANCHORS:
                result["anchor"] = tok.lower()
        return result

    def _resolve_position_from_rect(self, rect, anchor, offset_x, offset_y):
        """rect = [left, top, width, height]"""
        anchors = {
            "center":       (0.5, 0.5),
            "top_left":     (0.0, 0.0),
            "top_right":    (1.0, 0.0),
            "bottom_left":  (0.0, 1.0),
            "bottom_right": (1.0, 1.0),
            "top":          (0.5, 0.0),
            "bottom":       (0.5, 1.0),
            "left":         (0.0, 0.5),
            "right":        (1.0, 0.5),
        }
        ax, ay = anchors.get(anchor, (0.5, 0.5))
        x = rect[0] + rect[2] * ax + offset_x
        y = rect[1] + rect[3] * ay + offset_y
        return int(x), int(y)