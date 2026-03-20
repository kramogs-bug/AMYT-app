============================================================
  MACRO AUTOMATION APP — Setup Guide
  For BSCpE / CS students using VS Code on Windows
============================================================

STEP 1 — PREREQUISITES
-----------------------
Install Python 3.10+ from: https://www.python.org/downloads/
✓ Make sure to check "Add Python to PATH" during install


STEP 2 — OPEN THE PROJECT IN VS CODE
--------------------------------------
1. Open VS Code
2. File → Open Folder → select the "macro_app" folder
3. Open a terminal: Terminal → New Terminal


STEP 3 — CREATE A VIRTUAL ENVIRONMENT (recommended)
-----------------------------------------------------
In the VS Code terminal, run:

  python -m venv venv

Activate it:

  Windows:  venv\Scripts\activate
  Mac/Linux: source venv/bin/activate

You should see (venv) appear in your terminal prompt.


STEP 4 — INSTALL DEPENDENCIES
-------------------------------
  pip install -r requirements.txt

This installs:
  - pyautogui     (mouse/keyboard automation)
  - opencv-python (image detection)
  - numpy         (image processing)
  - mss           (fast screen capture)
  - pynput        (recording mouse/keyboard)
  - pillow        (image handling)
  - pywebview     (desktop window for HTML UI)


OPTIONAL: Install pytesseract for OCR text detection
  pip install pytesseract
  Then download Tesseract from:
  https://github.com/UB-Mannheim/tesseract/wiki


STEP 5 — RUN THE APP
---------------------
  python main.py

A desktop window will open with the full UI.


============================================================
  PROJECT STRUCTURE EXPLAINED
============================================================

macro_app/
│
├── main.py                   ← START HERE — launches the app
│
├── requirements.txt          ← Python package list
│
├── core/
│   ├── macro_engine.py       ← Records actions + runs scripts
│   ├── action_engine.py      ← Executes individual commands
│   └── condition_engine.py   ← Evaluates IF conditions
│
├── automation/
│   ├── mouse_control.py      ← Mouse clicks, movement, drag
│   ├── keyboard_control.py   ← Key press, type, hotkeys
│   └── window_control.py     ← Optional window management
│
├── vision/
│   ├── image_detector.py     ← OpenCV template matching
│   ├── screen_capture.py     ← mss screen grabber
│   ├── pixel_detector.py     ← Pixel color detection
│   └── ocr_engine.py         ← Optional OCR text reading
│
├── learning/
│   ├── learning_engine.py    ← Tracks detection success rates
│   ├── template_manager.py   ← Add/delete/rename templates
│   └── region_learning.py    ← Learns best screen regions
│
├── storage/
│   ├── logger.py             ← Logging system
│   ├── learning_data.json    ← Auto-created by learning engine
│   ├── macro_db.json         ← Auto-created on first run
│   └── templates/            ← Your template PNG images go here
│
├── ui/
│   ├── index.html            ← Main UI layout
│   ├── style.css             ← Dark theme styling
│   └── script.js             ← Frontend logic / API calls
│
├── logs/                     ← Log files saved here
└── example_scripts/          ← Example macro scripts


============================================================
  HOW TO USE THE APP
============================================================

1. CAPTURE A TEMPLATE IMAGE
   - Go to the Macro tab
   - Set X, Y, W, H to the area of the screen you want
   - Type a name (e.g. "start_button")
   - Click "Save as Template"

2. WRITE A SCRIPT
   - Use the Script Editor on the right
   - Click "Example" to see all available commands
   - Use CLICK_IMAGE start_button to click that template

3. RUN YOUR SCRIPT
   - Click ▶ Run Script
   - Click ⬛ Stop to stop at any time

4. RECORD ACTIONS
   - Click ● Record
   - Perform your actions
   - Click ■ Stop Rec
   - The recorded script appears in the editor automatically

5. CHECK LEARNING DATA
   - Click the "Learning" tab
   - See success rates for each template you've used

============================================================
  SCRIPT COMMANDS REFERENCE
============================================================

Command               Description
--------              -----------
WAIT 2                Wait 2 seconds
CLICK x y             Left click at coordinates
DOUBLE_CLICK x y      Double click at coordinates
RIGHT_CLICK x y       Right click at coordinates
MOVE x y              Move mouse without clicking
MOVE_HUMAN x y        Move mouse with human-like curve
SCROLL n              Scroll n clicks (negative = down)
DRAG x1 y1 x2 y2      Click and drag between two points
TYPE Hello World      Type text (supports spaces)
PRESS enter           Press a single key
HOLD shift            Hold a key down
RELEASE shift         Release a held key
HOTKEY ctrl+c         Send a key combination
CLICK_IMAGE name      Find and click an image
DOUBLE_CLICK_IMAGE    Find and double-click an image
RIGHT_CLICK_IMAGE     Find and right-click an image
WAIT_IMAGE name 30    Wait until image appears (30s timeout)
WAIT_IMAGE_GONE n 30  Wait until image disappears
IF_IMAGE name         Conditional block
ELSE                  Alternative block
END                   End a block
LOOP                  Infinite loop
REPEAT 5              Loop exactly 5 times
WHILE_IMAGE name      Loop while image visible
# comment            Lines starting with # are ignored

============================================================
  TROUBLESHOOTING
============================================================

Problem: "pywebview" not found
Solution: pip install pywebview

Problem: App opens but UI is blank
Solution: Make sure ui/index.html exists

Problem: Image detection not working
Solution:
  1. Check that the template image is in storage/templates/
  2. Lower the confidence value (try 0.6)
  3. Make sure the template matches exactly what's on screen

Problem: Recording not working
Solution: pip install pynput

Problem: "cv2 not found" error
Solution: pip install opencv-python

============================================================
