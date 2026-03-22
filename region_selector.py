"""
region_selector.py
Launches the tkinter overlay for drawing a screen region.

When running from source: spawns _region_helper.py with Python interpreter.
When running as PyInstaller .exe: runs the helper code directly in a
thread (no subprocess needed — tkinter works fine in a thread here).
"""

import sys
import os


class RegionSelector:
    def select(self):
        """
        Returns (x, y, w, h) or None if cancelled.
        """
        # ── Frozen .exe path ──────────────────────────────────
        # sys.executable IS the .exe — we can't subprocess it.
        # Instead run the overlay code directly in this process.
        if getattr(sys, 'frozen', False):
            return self._run_inline()

        # ── Source path ───────────────────────────────────────
        # Spawn _region_helper.py with the real Python interpreter.
        import subprocess
        helper = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "_region_helper.py"
        )
        try:
            result = subprocess.run(
                [sys.executable, helper],
                capture_output=True,
                text=True,
                timeout=120
            )
            return self._parse(result.stdout.strip())
        except subprocess.TimeoutExpired:
            return None
        except Exception as e:
            print(f"RegionSelector error: {e}")
            return None

    def _parse(self, output):
        if not output or output == "cancelled":
            return None
        parts = output.split(",")
        if len(parts) == 4:
            try:
                x, y, w, h = int(parts[0]), int(parts[1]), \
                              int(parts[2]), int(parts[3])
                return (x, y, w, h)
            except ValueError:
                return None
        return None

    def _run_inline(self):
        """
        Run the tkinter overlay directly (used when frozen as .exe).
        tkinter is bundled by PyInstaller and works in the main thread.
        We use a queue to get the result back.
        """
        import queue
        import threading
        import tkinter as tk
        import ctypes

        result_q = queue.Queue()

        def _overlay():
            try:
                root = tk.Tk()

                user32 = ctypes.windll.user32
                sw = user32.GetSystemMetrics(78)   # SM_CXVIRTUALSCREEN
                sh = user32.GetSystemMetrics(79)   # SM_CYVIRTUALSCREEN

                root.geometry(f"{sw}x{sh}+0+0")
                root.attributes('-alpha', 0.3)
                root.attributes('-topmost', True)
                root.overrideredirect(True)
                root.config(cursor='crosshair', bg='black')

                canvas = tk.Canvas(
                    root, cursor='crosshair',
                    bg='black', highlightthickness=0
                )
                canvas.pack(fill=tk.BOTH, expand=True)

                canvas.create_text(
                    sw // 2, 40,
                    text='Drag to select region   •   ESC to cancel',
                    fill='white',
                    font=('Segoe UI', 16, 'bold')
                )

                state = {'start_x': 0, 'start_y': 0,
                         'rect_id': None, 'label_id': None,
                         'result': 'cancelled'}

                def on_press(event):
                    state['start_x'] = event.x_root
                    state['start_y'] = event.y_root
                    if state['rect_id']:
                        canvas.delete(state['rect_id'])
                    if state['label_id']:
                        canvas.delete(state['label_id'])

                def on_drag(event):
                    if state['rect_id']:  canvas.delete(state['rect_id'])
                    if state['label_id']: canvas.delete(state['label_id'])
                    x0 = state['start_x'] - root.winfo_rootx()
                    y0 = state['start_y'] - root.winfo_rooty()
                    state['rect_id'] = canvas.create_rectangle(
                        x0, y0, event.x, event.y,
                        outline='#00ff88', width=2, fill=''
                    )
                    w = abs(event.x_root - state['start_x'])
                    h = abs(event.y_root - state['start_y'])
                    state['label_id'] = canvas.create_text(
                        event.x + 12, event.y - 12,
                        text=f'{w} × {h}', fill='#00ff88',
                        font=('Segoe UI', 11, 'bold'), anchor='nw'
                    )

                def on_release(event):
                    x1 = min(state['start_x'], event.x_root)
                    y1 = min(state['start_y'], event.y_root)
                    x2 = max(state['start_x'], event.x_root)
                    y2 = max(state['start_y'], event.y_root)
                    w, h = x2 - x1, y2 - y1
                    state['result'] = f"{x1},{y1},{w},{h}" if w > 5 and h > 5 else "cancelled"
                    root.destroy()

                def on_cancel(event):
                    state['result'] = 'cancelled'
                    root.destroy()

                canvas.bind('<ButtonPress-1>',   on_press)
                canvas.bind('<B1-Motion>',       on_drag)
                canvas.bind('<ButtonRelease-1>', on_release)
                root.bind('<Escape>',            on_cancel)

                root.mainloop()
                result_q.put(state['result'])

            except Exception as e:
                result_q.put('cancelled')

        # Run in a thread so it doesn't block the main thread
        t = threading.Thread(target=_overlay, daemon=True)
        t.start()
        t.join(timeout=120)

        try:
            output = result_q.get_nowait()
        except Exception:
            output = 'cancelled'

        return self._parse(output)
