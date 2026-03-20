"""
vision/async_capture.py
Async screen-capture pipeline for ImageDetector.

Runs a background daemon thread that continuously grabs the screen
(or a region) and pushes frames into a bounded queue.  The detector
calls get_latest_frame() instead of calling mss directly — the grab
cost is paid by the background thread, so the macro engine never blocks.

Usage
-----
    pipe = AsyncCapturePipeline(logger, max_queue=2, fps_cap=30)
    pipe.start()

    # In ImageDetector._grab_screen():
    frame = pipe.get_latest_frame(region)   # returns BGR ndarray instantly

    pipe.stop()   # call on shutdown

Drop-in replacement for the synchronous mss grab inside ImageDetector.
Set ImageDetector.async_pipeline = pipe after construction and the
patched _grab_screen() below will use it automatically.

Design notes
------------
* max_queue=2  — keeps memory low; old frames are discarded when the
  consumer is slower than the producer (e.g. feature-match fallback).
* fps_cap      — limits CPU when the macro loop is idle (e.g. waiting
  for an image).  Default 30 fps is more than enough for game UIs.
* Per-region caching — a separate capture thread is spawned for each
  unique region so full-screen AND region captures can run in parallel.
* Thread-safe: all shared state uses threading.Lock / queue.Queue.
"""

import threading
import queue
import time
import cv2
import numpy as np
import mss


class _RegionWorker:
    """Single background thread capturing one region continuously."""

    def __init__(self, region, fps_cap: float, logger):
        self.region    = region          # None = full screen; [x,y,w,h] = crop
        self.fps_cap   = max(1.0, fps_cap)
        self.logger    = logger
        self._q: queue.Queue = queue.Queue(maxsize=2)
        self._stop_evt = threading.Event()
        self._thread   = threading.Thread(
            target=self._run, daemon=True,
            name=f"async-capture-{id(self)}"
        )

    def start(self):
        self._thread.start()

    def stop(self):
        self._stop_evt.set()

    def get_latest(self, timeout: float = 0.05) -> np.ndarray:
        """
        Return the most recent BGR frame, or None on timeout.
        Drains the queue so we always get the *newest* frame.
        """
        frame = None
        try:
            while True:
                frame = self._q.get_nowait()
        except queue.Empty:
            pass
        if frame is not None:
            return frame
        # Nothing in queue yet — block briefly for first frame
        try:
            return self._q.get(timeout=timeout)
        except queue.Empty:
            return None

    def _run(self):
        interval = 1.0 / self.fps_cap
        with mss.mss() as sct:
            while not self._stop_evt.is_set():
                t0 = time.perf_counter()
                try:
                    if self.region:
                        x, y, w, h = self.region
                        monitor = {"left": int(x), "top": int(y),
                                   "width": int(w), "height": int(h)}
                    else:
                        monitor = sct.monitors[1]

                    shot = sct.grab(monitor)
                    bgr  = cv2.cvtColor(np.array(shot), cv2.COLOR_BGRA2BGR)

                    # Discard oldest frame if queue is full (keep fresh)
                    if self._q.full():
                        try:
                            self._q.get_nowait()
                        except queue.Empty:
                            pass
                    self._q.put_nowait(bgr)

                except Exception as exc:
                    self.logger.log(
                        f"AsyncCapture worker error: {exc}", level="WARN"
                    )

                elapsed = time.perf_counter() - t0
                sleep_t = interval - elapsed
                if sleep_t > 0:
                    time.sleep(sleep_t)


class AsyncCapturePipeline:
    """
    Manager for per-region capture workers.

    One worker is spawned per unique region string; they are lazily
    created on the first get_latest_frame() call for that region.

    Parameters
    ----------
    logger   : Logger instance (must expose .log(msg, level=))
    fps_cap  : Maximum capture rate per region (default 30 fps)
    """

    def __init__(self, logger, fps_cap: float = 30.0):
        self.logger   = logger
        self.fps_cap  = fps_cap
        self._workers: dict[str, _RegionWorker] = {}
        self._lock    = threading.Lock()
        self._active  = False

    # ── lifecycle ──────────────────────────────────────────

    def start(self):
        """Enable the pipeline.  Workers are started lazily per region."""
        self._active = True
        self.logger.log(
            f"AsyncCapturePipeline started (fps_cap={self.fps_cap})"
        )

    def stop(self):
        """Stop all capture workers and release resources."""
        self._active = False
        with self._lock:
            for worker in self._workers.values():
                worker.stop()
            self._workers.clear()
        self.logger.log("AsyncCapturePipeline stopped")

    # ── public API ─────────────────────────────────────────

    def get_latest_frame(self, region=None) -> np.ndarray:
        """
        Return the latest BGR frame for the given region (or full screen).

        Falls back to a synchronous grab if the pipeline is not active or
        the worker hasn't produced a frame yet.
        """
        if not self._active:
            return self._sync_grab(region)

        key    = self._region_key(region)
        worker = self._get_or_create_worker(key, region)
        frame  = worker.get_latest(timeout=0.08)

        if frame is None:
            # Worker not warmed up yet — sync fallback, no log spam
            return self._sync_grab(region)

        return frame

    def set_fps_cap(self, fps: float):
        """Update the FPS cap.  Existing workers keep their original rate."""
        self.fps_cap = max(1.0, fps)

    def worker_count(self) -> int:
        with self._lock:
            return len(self._workers)

    def stats(self) -> dict:
        """Return a dict of {region_key: queue_size} for diagnostics."""
        with self._lock:
            return {k: w._q.qsize() for k, w in self._workers.items()}

    # ── internals ──────────────────────────────────────────

    @staticmethod
    def _region_key(region) -> str:
        return str(region) if region else "fullscreen"

    def _get_or_create_worker(self, key: str, region) -> _RegionWorker:
        with self._lock:
            if key not in self._workers:
                w = _RegionWorker(region, self.fps_cap, self.logger)
                w.start()
                self._workers[key] = w
                self.logger.log(
                    f"AsyncCapture: new worker for region={key}"
                )
            return self._workers[key]

    @staticmethod
    def _sync_grab(region) -> np.ndarray:
        """Synchronous fallback — same logic as the original _grab_screen."""
        with mss.mss() as sct:
            if region:
                x, y, w, h = region
                monitor = {"left": int(x), "top": int(y),
                           "width": int(w), "height": int(h)}
            else:
                monitor = sct.monitors[1]
            shot = sct.grab(monitor)
            return cv2.cvtColor(np.array(shot), cv2.COLOR_BGRA2BGR)
