"""
vision/ocr_engine.py
OCR (Optical Character Recognition) using pytesseract.
Includes image preprocessing for consistent results and multi-word phrase matching.
"""

try:
    import pytesseract
    from PIL import Image
    pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'
    OCR_AVAILABLE = True
except ImportError:
    OCR_AVAILABLE = False

import mss
import numpy as np
import cv2


def _preprocess_for_ocr(img_bgr: np.ndarray) -> np.ndarray:
    """
    Preprocess a BGR image to improve Tesseract accuracy:
    1. Scale up small images (Tesseract works best at ~300 DPI)
    2. Convert to grayscale
    3. Apply adaptive threshold to handle varied backgrounds
    4. Invert if background is dark (Tesseract expects black text on white)
    Returns a grayscale preprocessed image.
    """
    # 1. Scale up if image is small — Tesseract needs ~32px+ font height
    h, w = img_bgr.shape[:2]
    scale = 1.0
    if h < 600 or w < 800:
        scale = max(2.0, 1200 / max(w, 1))
    if scale > 1.0:
        img_bgr = cv2.resize(img_bgr, None, fx=scale, fy=scale,
                             interpolation=cv2.INTER_CUBIC)

    # 2. Grayscale
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)

    # 3. Adaptive threshold — handles varying light/dark backgrounds
    thresh = cv2.adaptiveThreshold(
        gray, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        blockSize=31,
        C=10
    )

    # 4. Auto-invert: if majority of pixels are dark, the background is dark
    #    (dark theme UI) — invert so text becomes black on white
    white_ratio = np.sum(thresh == 255) / thresh.size
    if white_ratio < 0.5:
        thresh = cv2.bitwise_not(thresh)

    # 5. Light denoise
    thresh = cv2.medianBlur(thresh, 3)

    return thresh, scale


def _phrase_search(data: dict, search_lower: str, confidence: int, offset_x: int, offset_y: int,
                   scale: float, find_all: bool):
    """
    Slide a window over pytesseract word tokens to find single or multi-word phrases.
    Returns list of dicts or empty list.
    """
    words     = [str(w).strip() for w in data['text']]
    n         = len(words)
    sw        = search_lower.split()
    num_sw    = len(sw)
    matches   = []

    for i in range(n - num_sw + 1):
        phrase = [words[j] for j in range(i, i + num_sw)]
        if ' '.join(w.lower() for w in phrase) == search_lower:
            confs = [int(data['conf'][j]) for j in range(i, i + num_sw)]
            if all(c >= confidence for c in confs):
                xs  = [int(data['left'][j])                          for j in range(i, i + num_sw)]
                ys  = [int(data['top'][j])                           for j in range(i, i + num_sw)]
                x2s = [int(data['left'][j]) + int(data['width'][j])  for j in range(i, i + num_sw)]
                y2s = [int(data['top'][j])  + int(data['height'][j]) for j in range(i, i + num_sw)]
                # Map back from scaled image coords to screen coords
                bx = int(min(xs)  / scale) + offset_x
                by = int(min(ys)  / scale) + offset_y
                bw = int((max(x2s) - min(xs)) / scale)
                bh = int((max(y2s) - min(ys)) / scale)
                matches.append({
                    "x": bx, "y": by, "w": bw, "h": bh,
                    "confidence": min(confs)
                })
                if not find_all:
                    return matches
    return matches


class OCREngine:
    def __init__(self, logger):
        self.logger = logger
        if not OCR_AVAILABLE:
            self.logger.log("pytesseract not installed. OCR disabled.", level="WARN")

    def read_text_from_image(self, image_path: str) -> str:
        """Extract text from an image file."""
        if not OCR_AVAILABLE:
            return ""
        try:
            img = Image.open(image_path)
            text = pytesseract.image_to_string(img).strip()
            self.logger.log(f"OCR result from {image_path}: '{text[:50]}'")
            return text
        except Exception as e:
            self.logger.log(f"OCR error: {e}", level="ERROR")
            return ""

    def read_text_from_region(self, region_img) -> str:
        """Extract text from a PIL Image or NumPy array region."""
        if not OCR_AVAILABLE:
            return ""
        try:
            text = pytesseract.image_to_string(region_img).strip()
            return text
        except Exception as e:
            self.logger.log(f"OCR region error: {e}", level="ERROR")
            return ""

    def find_text_on_screen(self, search_text: str, screen_image_path: str) -> bool:
        """Check if text appears in a screenshot (no position)."""
        full_text = self.read_text_from_image(screen_image_path)
        found = search_text.lower() in full_text.lower()
        self.logger.log(f"Text search '{search_text}': {'FOUND' if found else 'NOT FOUND'}")
        return found

    def _grab_screen(self, region=None):
        """Grab screen and return (bgr_image, offset_x, offset_y)."""
        with mss.mss() as sct:
            if region:
                left, top, w, h = region
                monitor = {"left": left, "top": top, "width": w, "height": h}
            else:
                monitor = sct.monitors[1]
                left, top = monitor["left"], monitor["top"]
            img = np.array(sct.grab(monitor))
            img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
        return img, left, top

    def find_text_position(self, search_text: str, region=None, confidence=60):
        """
        Find the first occurrence of text on screen.
        Returns (left, top, width, height) or None.
        Supports multi-word phrases. Uses preprocessing for consistent results.
        """
        if not OCR_AVAILABLE:
            return None
        try:
            img, ox, oy = self._grab_screen(region)
            proc, scale = _preprocess_for_ocr(img)

            # Try both default and LSTM engine configs for best results
            for cfg in ['--oem 3 --psm 11', '--oem 1 --psm 11']:
                data = pytesseract.image_to_data(
                    proc, output_type=pytesseract.Output.DICT, config=cfg
                )
                results = _phrase_search(data, search_text.strip().lower(),
                                         confidence, ox, oy, scale, find_all=False)
                if results:
                    m = results[0]
                    self.logger.log(
                        f"Found text '{search_text}' at ({m['x']},{m['y']}) "
                        f"{m['w']}x{m['h']} conf={m['confidence']}"
                    )
                    return (m['x'], m['y'], m['w'], m['h'])
        except Exception as e:
            self.logger.log(f"find_text_position error: {e}", level="ERROR")
        return None

    def find_all_text_positions(self, search_text: str, region=None, confidence=60):
        """
        Find all occurrences of text on screen.
        Returns list of dicts: [{'x','y','w','h','confidence'}, ...]
        Supports multi-word phrases. Uses preprocessing for consistent results.
        """
        if not OCR_AVAILABLE:
            return []
        try:
            img, ox, oy = self._grab_screen(region)
            proc, scale = _preprocess_for_ocr(img)

            all_matches = []
            seen = set()
            for cfg in ['--oem 3 --psm 11', '--oem 1 --psm 11']:
                data = pytesseract.image_to_data(
                    proc, output_type=pytesseract.Output.DICT, config=cfg
                )
                results = _phrase_search(data, search_text.strip().lower(),
                                         confidence, ox, oy, scale, find_all=True)
                for m in results:
                    key = (m['x'], m['y'])
                    if key not in seen:
                        seen.add(key)
                        all_matches.append(m)

            if all_matches:
                self.logger.log(
                    f"Found {len(all_matches)} match(es) for '{search_text}'"
                )
            return all_matches
        except Exception as e:
            self.logger.log(f"find_all_text_positions error: {e}", level="ERROR")
            return []
