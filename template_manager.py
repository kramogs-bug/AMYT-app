"""
learning/template_manager.py
Manages template images stored in storage/templates/.
Also stores OCR (TEXT) and Color (COLOR) templates as JSON metadata files
in storage/templates_meta/ so they are completely separate from .png image files.
"""

import os
import json
import shutil


class TemplateManager:
    def __init__(self, logger, learner=None):
        self.logger = logger
        self.learner = learner
        self.templates_dir = os.path.join("storage", "templates")
        self.meta_dir      = os.path.join("storage", "templates_meta")
        os.makedirs(self.templates_dir, exist_ok=True)
        os.makedirs(self.meta_dir,      exist_ok=True)

    # ── IMAGE TEMPLATES (.png) ────────────────────────────────

    def list_templates(self) -> list:
        """
        Return ALL templates: image (.png) + OCR/Color metadata.
        Each entry: { name, path, size, type }
          type = 'IMAGE' | 'TEXT' | 'COLOR'
        """
        result = []

        # Image templates
        for filename in sorted(os.listdir(self.templates_dir)):
            if filename.lower().endswith(".png"):
                full_path = os.path.join(self.templates_dir, filename)
                result.append({
                    "name":  filename,
                    "path":  full_path,
                    "size":  os.path.getsize(full_path),
                    "type":  "IMAGE",
                })

        # OCR / Color metadata templates
        for filename in sorted(os.listdir(self.meta_dir)):
            if filename.lower().endswith(".json"):
                full_path = os.path.join(self.meta_dir, filename)
                try:
                    with open(full_path, "r", encoding="utf-8") as f:
                        meta = json.load(f)
                    result.append({
                        "name":  filename.replace(".json", ""),
                        "path":  full_path,
                        "size":  os.path.getsize(full_path),
                        "type":  meta.get("type", "TEXT"),
                        "meta":  meta,
                    })
                except Exception as e:
                    self.logger.log(f"Bad meta template {filename}: {e}", level="WARN")

        return result

    def delete_template(self, name: str):
        # Try image first
        png_path = os.path.join(self.templates_dir, name if name.endswith(".png") else name + ".png")
        if os.path.exists(png_path):
            os.remove(png_path)
            if self.learner:
                self.learner.reset_template(name)
            self.logger.log(f"Deleted image template: {name}")
            return

        # Try meta template
        base = name.replace(".json", "")
        json_path = os.path.join(self.meta_dir, base + ".json")
        if os.path.exists(json_path):
            os.remove(json_path)
            self.logger.log(f"Deleted meta template: {base}")
            return

        self.logger.log(f"Delete failed — not found: {name}", level="WARN")

    def rename_template(self, old_name: str, new_name: str):
        # Image rename
        if not new_name.endswith(".png"):
            new_name_png = new_name + ".png"
        else:
            new_name_png = new_name
        old_path = os.path.join(self.templates_dir, old_name)
        new_path = os.path.join(self.templates_dir, new_name_png)
        if os.path.exists(old_path):
            os.rename(old_path, new_path)
            if self.learner:
                self.learner.rename_template(old_name, new_name_png)
            self.logger.log(f"Renamed image template: {old_name} → {new_name_png}")
            return

        # Meta rename
        old_json = os.path.join(self.meta_dir, old_name.replace(".json", "") + ".json")
        new_json = os.path.join(self.meta_dir, new_name.replace(".json", "") + ".json")
        if os.path.exists(old_json):
            os.rename(old_json, new_json)
            self.logger.log(f"Renamed meta template: {old_name} → {new_name}")
            return

        self.logger.log(f"Rename failed — not found: {old_name}", level="WARN")

    def add_template(self, source_path: str, name: str) -> str:
        """Copy an image file into the templates folder."""
        if not name.endswith(".png"):
            name += ".png"
        dest = os.path.join(self.templates_dir, name)
        shutil.copy2(source_path, dest)
        self.logger.log(f"Added image template: {name}")
        return dest

    def template_exists(self, name: str) -> bool:
        if not name.endswith(".png"):
            name += ".png"
        return os.path.exists(os.path.join(self.templates_dir, name))

    # ── OCR / COLOR METADATA TEMPLATES (.json) ───────────────

    def save_ocr_template(self, name: str, text: str, confidence: int = 80,
                          region=None) -> dict:
        """Save an OCR (TEXT) template as a JSON metadata file."""
        name = self._sanitize_name(name)
        meta = {
            "type":       "TEXT",
            "name":       name,
            "text":       text,
            "confidence": confidence,
            "region":     region,
        }
        path = os.path.join(self.meta_dir, name + ".json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)
        self.logger.log(f"Saved OCR template: {name} (text='{text}')")
        return {"status": "ok", "name": name, "meta": meta}

    def save_color_template(self, name: str, color: str, tolerance: int = 30,
                            region=None) -> dict:
        """Save a Color Pixel (COLOR) template as a JSON metadata file."""
        name = self._sanitize_name(name)
        meta = {
            "type":      "COLOR",
            "name":      name,
            "color":     color,
            "tolerance": tolerance,
            "region":    region,
        }
        path = os.path.join(self.meta_dir, name + ".json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)
        self.logger.log(f"Saved Color template: {name} (color={color})")
        return {"status": "ok", "name": name, "meta": meta}

    def get_meta_template(self, name: str) -> dict:
        """Load a single OCR/Color metadata template by name."""
        path = os.path.join(self.meta_dir, name.replace(".json", "") + ".json")
        if not os.path.exists(path):
            return {"status": "error", "message": "Not found"}
        with open(path, "r", encoding="utf-8") as f:
            return {"status": "ok", "meta": json.load(f)}

    def _sanitize_name(self, name: str) -> str:
        import re
        name = name.strip().replace(" ", "_")
        name = re.sub(r"[^\w\-]", "", name)
        return name or "unnamed"
