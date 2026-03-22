import tkinter as tk
import sys
import ctypes


class Overlay:
    def __init__(self):
        self.root = tk.Tk()

         # Get virtual screen dimensions (all monitors combined)
        user32 = ctypes.windll.user32
        sw = user32.GetSystemMetrics(78)   # SM_CXVIRTUALSCREEN
        sh = user32.GetSystemMetrics(79)   # SM_CYVIRTUALSCREEN

        # Position window to cover entire virtual screen
        self.root.geometry(f"{sw}x{sh}+0+0")
        self.root.attributes('-alpha', 0.3)
        self.root.attributes('-topmost', True)
        self.root.overrideredirect(True)
        self.root.config(cursor='crosshair', bg='black')

        self.canvas = tk.Canvas(
            self.root,
            cursor='crosshair',
            bg='black',
            highlightthickness=0
        )
        self.canvas.pack(fill=tk.BOTH, expand=True)

        # Instruction text
        sw = self.root.winfo_screenwidth()
        self.canvas.create_text(
            sw // 2, 40,
            text='Drag to select region   •   ESC to cancel',
            fill='white',
            font=('Segoe UI', 16, 'bold')
        )

        # State
        self.start_x  = 0
        self.start_y  = 0
        self.rect_id  = None
        self.label_id = None
        self.result   = "cancelled"

        # Events
        self.canvas.bind('<ButtonPress-1>',   self.on_press)
        self.canvas.bind('<B1-Motion>',       self.on_drag)
        self.canvas.bind('<ButtonRelease-1>', self.on_release)
        self.root.bind('<Escape>',            self.on_cancel)

        self.root.mainloop()

    def on_press(self, event):
        self.start_x = event.x_root
        self.start_y = event.y_root
        if self.rect_id:
            self.canvas.delete(self.rect_id)
        if self.label_id:
            self.canvas.delete(self.label_id)

    def on_drag(self, event):
        if self.rect_id:
            self.canvas.delete(self.rect_id)
        if self.label_id:
            self.canvas.delete(self.label_id)

        # Canvas-relative coords
        x0 = self.start_x - self.root.winfo_rootx()
        y0 = self.start_y - self.root.winfo_rooty()
        x1 = event.x
        y1 = event.y

        # Green selection rectangle
        self.rect_id = self.canvas.create_rectangle(
            x0, y0, x1, y1,
            outline='#00ff88',
            width=2,
            fill=''
        )

        # Size label next to cursor
        w = abs(event.x_root - self.start_x)
        h = abs(event.y_root - self.start_y)
        self.label_id = self.canvas.create_text(
            event.x + 12,
            event.y - 12,
            text=f'{w} × {h}',
            fill='#00ff88',
            font=('Segoe UI', 11, 'bold'),
            anchor='nw'
        )

    def on_release(self, event):
        x1 = min(self.start_x, event.x_root)
        y1 = min(self.start_y, event.y_root)
        x2 = max(self.start_x, event.x_root)
        y2 = max(self.start_y, event.y_root)

        w = x2 - x1
        h = y2 - y1

        if w > 5 and h > 5:
            self.result = f"{x1},{y1},{w},{h}"
        else:
            self.result = "cancelled"

        self.root.destroy()

    def on_cancel(self, event):
        self.result = "cancelled"
        self.root.destroy()


if __name__ == "__main__":
    overlay = Overlay()
    print(overlay.result)   # stdout → read by parent process
    sys.stdout.flush()