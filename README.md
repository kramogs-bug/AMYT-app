# AMYT — Macro Automation App

<p align="center">
  <img src="logo.png" alt="AMYT Logo" width="120"/>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.1-brightgreen"/>
  <img src="https://img.shields.io/badge/platform-Windows-blue"/>
  <img src="https://img.shields.io/badge/python-3.10%2B-yellow"/>
  <img src="https://img.shields.io/badge/license-MIT-lightgrey"/>
</p>

A powerful desktop macro automation app built with Python and a modern HTML/CSS UI. Record, write, and run scripts that control your mouse, keyboard, and screen — with built-in image detection, OCR, navigation AI, and a full script editor.

---

## Features

**Script Editor**
- Syntax highlighting and command autocomplete
- Template name autocomplete as you type image commands
- Inline thumbnail preview — hover over any template name to see the image
- Run from Cursor — start execution from any line
- Right-click context menu with Find & Replace
- Autosave every 30 seconds with crash recovery on next launch
- Breakpoint debugger with variable watch panel

**Image Detection**
- OpenCV template matching with configurable confidence
- Multi-scale detection and rotation support
- Live Detect — real-time preview with colour-coded confidence boxes
- Async capture pipeline for high-performance detection

**Navigation AI**
- `NAVIGATE_TO_IMAGE` — moves your character toward any on-screen target using keyboard keys
- Configurable arrival region, arrival confidence, miss tolerance, and timeout
- Auto window focus (Jitbit-style) — keys always reach the game window automatically

**Command Builder**
- Drag-and-drop toolbar with all command categories
- Image Action modal — full builder for every image command with live preview
- Navigate builder with sliders for all AI parameters

**Script Sharing — `.amyt` Format**
- Export scripts as `.amyt` packages that bundle the script and all template images
- Import `.amyt` files shared by others — templates install automatically
- Metadata: name, author, description, tags, SHA-256 checksum
- Double-click `.amyt` files to open directly (register in Settings)

**Other**
- Global hotkeys (Ctrl+R to run, Ctrl+Q to stop, Ctrl+P to pause) — work in any app
- Log panel with level filter (All / Warn / Error) and search
- Auto-update checker — notifies you when a new version is available
- Keyboard recording with action replay
- OCR text detection, colour pixel detection, clipboard automation

---

## Screenshots

> Add screenshots here after your first build

---

## Requirements

- Windows 10 or 11
- Python 3.10+

---

## Installation (from source)

```bash
# 1. Clone the repo
git clone https://github.com/kramogs-bug/AMYT-app.git
cd AMYT-app

# 2. Create a virtual environment (recommended)
python -m venv venv
venv\Scripts\activate

# 3. Install dependencies
pip install -r requirements.txt

# 4. Run
python main.py
```

### Optional — OCR support (TEXT_ commands)

Install one of:
```bash
pip install easyocr
# or
pip install pytesseract
# pytesseract also needs Tesseract binary:
# https://github.com/UB-Mannheim/tesseract/wiki
```

---

## Download (pre-built)

Go to [Releases](https://github.com/kramogs-bug/AMYT-app/releases) and download the latest `AMYT_vX.X.X_portable.zip`. Unzip and run `AMYT.exe` — no Python required.

---

## Quick Start

**1. Capture a template image**
- Go to the **Image Capture** section
- Type a name like `start_button`
- Click **Draw Region on Screen** and drag around the button

**2. Write a script**
```
WAIT 2
WAIT_IMAGE start_button 30
CLICK_IMAGE start_button
WAIT_IMAGE_GONE loading 60
CLICK_IMAGE play_button 0.7
```

**3. Run**
- Click **▶ Run Script** or press `Ctrl+R` while the app is in focus

---

## Script Commands Reference

| Command | Arguments | Description |
|---|---|---|
| `WAIT` | `seconds` | Pause for N seconds |
| `WAIT_RANDOM` | `min max` | Random wait between min and max |
| `CLICK` | `x y` | Left click at coordinates |
| `DOUBLE_CLICK` | `x y` | Double click |
| `RIGHT_CLICK` | `x y` | Right click |
| `MOVE` | `x y` | Move mouse |
| `MOVE_HUMAN` | `x y` | Move with natural curve |
| `DRAG` | `x1 y1 x2 y2` | Click and drag |
| `SCROLL` | `amount` | Scroll (negative = down) |
| `TYPE` | `text` | Type a string |
| `PRESS` | `key` | Press a key |
| `HOLD` | `key` | Hold a key down |
| `RELEASE` | `key` | Release a held key |
| `HOTKEY` | `ctrl+c` | Key combination |
| `CLICK_IMAGE` | `template [confidence]` | Find image and click |
| `WAIT_IMAGE` | `template [timeout]` | Wait until image appears |
| `WAIT_IMAGE_GONE` | `template [timeout]` | Wait until image disappears |
| `FIND_CLICK` | `template [confidence]` | Find image and click (with anchor/offset support) |
| `NAVIGATE_TO_IMAGE` | `template [options]` | Move toward image using keyboard |
| `IF_IMAGE` | `template` | Branch if image is visible |
| `IF_NOT_IMAGE` | `template` | Branch if image is not visible |
| `WHILE_IMAGE` | `template` | Loop while image visible |
| `IF_VAR` | `$var == value` | Branch on variable |
| `WHILE_VAR` | `$var == value` | Loop on variable |
| `SET` | `$var = value` | Set a variable |
| `REPEAT` | `count` | Repeat block N times |
| `LOOP` | | Loop forever |
| `GOTO` | `label` | Jump to label |
| `LABEL` | `name` | Define a label |
| `STOP` | | Stop the script |
| `TOAST` | `"message" [level]` | Show notification |
| `READ_TEXT` | `"label" -> $var` | Read text via OCR |
| `TEXT_CLICK` | `"text"` | Find and click text |
| `READ_COLOR` | `x y -> $var` | Read pixel color |
| `WAIT_COLOR` | `#RRGGBB [tolerance]` | Wait for color |
| `CLIPBOARD_COPY` | | Copy selection |
| `CLIPBOARD_PASTE` | | Paste clipboard |
| `CLIPBOARD_GET` | `-> $var` | Get clipboard contents |
| `ON_ERROR` | | Error handler block |

Full documentation is available inside the app — click **Guide** in the sidebar.

---

## NAVIGATE_TO_IMAGE Parameters

```
NAVIGATE_TO_IMAGE template [confidence=0.8] [arrival_region=200]
                           [arrival_confidence=0.85] [miss_tolerance=3]
                           [timeout=0] [offsetX=0] [offsetY=0]
```

| Parameter | Default | Description |
|---|---|---|
| `confidence` | 0.8 | Match threshold (0.0–1.0) |
| `arrival_region` | 200 | Pixel radius to scan around player |
| `arrival_confidence` | 0.85 | Confidence needed inside arrival region to stop |
| `miss_tolerance` | 3 | Consecutive missed frames before stopping |
| `timeout` | 0 | Max seconds (0 = no limit) |
| `offsetX / offsetY` | 0 | Target offset from template center |

---

## Project Structure

```
AMYT-app/
├── main.py                 ← Entry point, API, settings
├── macro_engine.py         ← Script parser and executor
├── action_engine.py        ← Individual command execution
├── image_detector.py       ← OpenCV template matching
├── keyboard_control.py     ← Key press automation
├── mouse_control.py        ← Mouse automation
├── window_control.py       ← Window focus management
├── async_capture.py        ← Background screen capture
├── learning_engine.py      ← Detection region learning
├── ocr_engine.py           ← Text detection
├── color_detector.py       ← Pixel color detection
├── index.html              ← Main UI
├── style.css               ← Styles
├── requirements.txt
├── logo.png
├── logo.ico
├── js/
│   ├── editor.js           ← Script editor, autocomplete, autosave
│   ├── builder.js          ← Command builder modals
│   ├── macro.js            ← Run/stop/debug, logs
│   ├── templates.js        ← Template manager, live detect
│   ├── ui.js               ← Settings, navigation, layout
│   └── state.js            ← Shared state
└── storage/
    ├── templates/          ← Your captured template images
    └── scripts/            ← Your saved scripts
```

---

## Building from Source

Install PyInstaller and build:

```bash
pip install pyinstaller
pyinstaller AMYT.spec --clean
```

The built app will be in `dist/AMYT/`. Run `dist/AMYT/AMYT.exe`.

---

## Troubleshooting

**App opens then immediately closes**
Run from terminal to see the error: `python main.py`

**Image detection not working**
- Make sure the template image is in `storage/templates/`
- Lower confidence: `CLICK_IMAGE my_template 0.6`
- Recapture the template — lighting or resolution may have changed

**Keys not reaching the game**
- Go to **Movement AI → Target Window** and set your game window
- Click **Use active window** while the game is focused → Save Settings

**pywebview blank screen**
```bash
pip install pywebview --upgrade
```

**cv2 not found**
```bash
pip install opencv-python
```

---

## License

MIT License — see [LICENSE](LICENSE) for details.

---

## Author

Made by [@kramogs-bug](https://github.com/kramogs-bug)
