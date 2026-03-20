# AMYT.spec
block_cipher = None

a = Analysis(
    ['main.py'],
    pathex=['.'],
    binaries=[],
    datas=[
        ('index.html',          '.'),
        ('style.css',           '.'),
        ('macro_indicator.html','.' ),
        ('toast_popup.html',    '.'),
        ('logo.png',            '.'),
        ('logo.ico',            '.'),
        ('js',                  'js'),
        ('storage',             'storage'),
    ],
    hiddenimports=[
        'pywebview',
        'pywebview.platforms.winforms',
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
    console=False,          # no black terminal window
    icon='logo.ico',        # taskbar icon
)

coll = COLLECT(
    exe, a.binaries, a.zipfiles, a.datas,
    strip=False,
    upx=True,
    name='AMYT',
)