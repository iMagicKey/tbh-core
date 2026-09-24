"""lifecycle.py — run lifecycle primitives.

Adapted from tbh-meter meter_windows (MIT): the rotation-aware LogScanCursor
(LOG_LIST is capped ~2000 with head eviction — identity is the entry OBJECT
POINTER, never an index), pending-close-free MVP close semantics, partial
classification (NO duration floor — very fast runs are valid), and run ids
derived from the terminal/end timestamp in ms.
"""

import time


class LogScanCursor:
    """Rotation-aware detector of NEW LogManager.LOG_LIST entries by object pointer."""

    def __init__(self):
        self._seen = {}
        self._anchored = False

    def _cap_seen(self, cap):
        limit = max(1, cap) * 2
        while len(self._seen) > limit:
            self._seen.pop(next(iter(self._seen)))

    def _mark(self, ptr):
        if ptr in self._seen:
            del self._seen[ptr]
        self._seen[ptr] = True

    def seed(self, read_ptr_at, size, cap):
        """Baseline at attach/re-attach WITHOUT replaying the pre-existing backlog."""
        self._anchored = True
        n = size or 0
        for i in range(n - 1, max(-1, n - 1 - max(1, cap)), -1):
            e = read_ptr_at(i)
            if e:
                self._mark(e)
        self._cap_seen(cap)

    def new_entries(self, read_ptr_at, size, cap):
        if not self._anchored:
            self.seed(read_ptr_at, size, cap)
            return []
        if not size or size <= 0:
            return []
        out = []
        lo = max(-1, size - 1 - max(1, cap))
        for i in range(size - 1, lo, -1):
            e = read_ptr_at(i)
            if not e:
                continue
            if e in self._seen:
                break
            out.append(e)
        out.reverse()  # oldest -> newest
        for e in out:
            self._mark(e)
        self._cap_seen(cap)
        return out


def is_partial(status, clear_time, measured, total_damage, partial_min=0.95, gate_seconds=30):
    """PARTIAL capture = joined mid-run (< partial_min of the official clear) or a
    success with unusable damage. Duration alone NEVER invalidates a run."""
    return bool(status == "success" and (
        (clear_time >= gate_seconds and measured < clear_time * partial_min)
        or total_damage <= 0))


def make_run_id(ended_at_ms):
    """Run identity = the END timestamp in ms (string). No counters, no reuse."""
    return str(int(ended_at_ms))


def monotonic_ms():
    """Monotonic clock for durations (never derived from poll counts)."""
    return time.monotonic() * 1000.0


def resolve_stage_key(candidate, snapshot, catalog, last_known):
    """The 1.2.8 stage chain as a pure function:

    live monster candidate -> must be in the runtime catalog;
    else the live-picked CSD snapshot -> must be in the catalog;
    else keep the last known valid key. An out-of-catalog value is NEVER
    accepted (1.2.8 live monster reads are garbage, e.g. 910401 vs valid 2205).
    """
    if candidate is not None and candidate in catalog:
        return candidate
    if snapshot is not None and snapshot in catalog:
        return snapshot
    return last_known


def detect_restart(prev_dead, dead_now, slack=2):
    """Manual same-stage restart: the cumulative dead-unit count DROPS
    (a stage reload resets it; clears/auto-replay do not). None inputs -> no."""
    if prev_dead is None or dead_now is None:
        return False
    return dead_now < prev_dead - slack
