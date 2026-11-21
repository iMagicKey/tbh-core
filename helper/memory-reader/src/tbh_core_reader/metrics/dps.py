"""dps.py — measured-derived damage tracking from monster HP drops.

Adapted from tbh-meter metrics/dps.py (MIT). The game exposes no damage
counter: damage = sum of monster HP decreases + killing blows; heals/address
reuse (HP increases) are ignored; DPS is a rolling ~5 s window.
"""

import time


class RollingWindow:
    def __init__(self, seconds):
        self.seconds = seconds
        self._events = []  # (ts, amount)

    def add(self, amount, ts):
        self._events.append((ts, amount))
        self.trim(ts)

    def trim(self, now):
        cutoff = now - self.seconds
        self._events = [e for e in self._events if e[0] >= cutoff]

    def rate_per_second(self, now):
        self.trim(now)
        if not self._events:
            return 0.0
        total = sum(a for _, a in self._events)
        span = max(0.001, min(self.seconds, now - self._events[0][0]))
        return total / span


class DpsTracker:
    def __init__(self, window_seconds=5.0):
        self._window = RollingWindow(window_seconds)
        self._last_hp = {}
        self.total_damage = 0.0
        self.peak_dps = 0.0
        self.alive = 0

    def update(self, monsters, timestamp=None):
        """monsters = iterable of (addr, hp_cur, hp_max)."""
        ts = timestamp if timestamp is not None else time.time()
        current = {}
        damage = 0.0
        for addr, hp, *_ in monsters:
            if hp is None or hp <= 0:
                continue
            current[addr] = hp
            prev = self._last_hp.get(addr)
            if prev is not None and hp < prev:
                damage += (prev - hp)
        for addr, prev_hp in self._last_hp.items():
            if addr not in current and prev_hp > 0:
                damage += prev_hp  # died: killing blow
        self._last_hp = current
        self.alive = len(current)
        if damage > 0:
            self._window.add(damage, ts)
            self.total_damage += damage
        dps = self.dps(ts)
        if dps > self.peak_dps:
            self.peak_dps = dps

    def dps(self, timestamp=None):
        return self._window.rate_per_second(timestamp if timestamp is not None else time.time())
