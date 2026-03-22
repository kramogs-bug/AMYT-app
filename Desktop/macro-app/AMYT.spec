# AMYT.spec
import os, glob, sys

block_cipher = None

# ── Locate WebView2Loader.dll automatically ───────────────────────────────────
# It lives inside the pywebview package, not in your project root.
# We search the active venv/site-packages so the build never breaks regardless
# of where pywebview was installed.
def _find_webview2_dll():
    try:
        import webview
        pkg_dir = os.path.dirname(webview.__file__)
        # pywebview ships it at:  pywebview/lib/x64/WebView2Loader.dll  (older)
        #                    or:  pywebview/platforms/winforms/WebView2Loader.dll (newer)
        patterns = [
            os.path.join(pkg_dir, '**', 'WebView2Loader.dll'),
        ]
        for pattern in patterns:
            hits = glob.glob(pattern, recursive=True)
            if hits:
                return hits[0]
    except Exception:
        pass
    return None

_wv2_dll = _find_webview2_dll()
_binaries = []
if _wv2_dll:
    # Place the DLL directly next to AMYT.exe in the output folder
    _binaries = [(_wv2_dll, '.')]
else:
    print("WARNING: WebView2Loader.dll not found in pywebview package — "
          "the runtime probe in _check_webview2() will be skipped. "
          "The registry scan will still work for most machines.")

# ─────────────────────────────────────────────────────────────────────────────

a = Analysis(
    ['main.py'],
    pathex=['.'],
    binaries=_binaries,
    datas=[
        ('index.html',           '.'),
        ('style.css',            '.'),
        ('macro_indicator.html', '.'),
        ('toast_popup.html',     '.'),
        ('logo.png',             '.'),
        ('logo.ico',             '.'),
        ('_region_helper.py',    '.'),
        ('js',                   'js'),
        ('storage',              'storage'),
    ],
    hiddenimports=[
        'pywebview',
        'pywebview.platforms.winforms',
        'pywebview.platforms.edgechromium',
        'clr',
        'win32gui',
        'win32con',
        'win32process',
        'pynput.keyboard._win32',
        'pynput.mouse._win32',
        'cv2',
        'numpy',
        'PIL',
        'mss',
        'keyboard',
        'pyautogui',
        'pydirectinput',
        'tkinter',
        'tkinter.ttk',
        'queue',
        'winreg',
    ],
    hookspath=[],
    runtime_hooks=[],
    excludes=['matplotlib', 'scipy', 'tkinter.test'],
    cipher=block_cipher,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name='AMYT',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    icon='logo.ico',
)

coll = COLLECT(
    exe, a.binaries, a.zipfiles, a.datas,
    strip=False,
    upx=True,
    name='AMYT',
)
