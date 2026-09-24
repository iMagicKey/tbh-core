"""xp.py — per-hero LIVE XP accumulator.

Adapted from tbh-meter metrics/xp.py (MIT). Integrates ACTk-decoded
within-level exp snapshots tick-by-tick, bridging level-ups with the level
curve from the profile. Cap-level heroes gain 0 (phantom XP suppressed);
dirty/dipping reads never advance the baseline (the recovery telescopes).
"""

from ..profile import Profile


def curve(profile: Profile):
    return profile.level_curve


def level_capped(profile: Profile, lv):
    """A level with no curve entry = cap (and neutralizes garbage levels)."""
    if lv is None:
        return False
    return lv not in curve(profile)


def xp_through_levelup(profile: Profile, lv0, exp0, lv1, exp1):
    c = curve(profile)
    try:
        total = (c[lv0] - exp0) + (exp1 if lv1 in c else 0.0)
        for L in range(lv0 + 1, lv1):
            total += c[L]
        return total if total >= 0 else None
    except (KeyError, TypeError):
        return None


def per_hero_gain(profile: Profile, lv0, exp0, lv1, exp1):
    """(gain|None, leveled). 0.0 is a VALID zero gain; None = not-read."""
    leveled = (lv1 is not None and lv0 is not None and lv1 > lv0)
    if leveled:
        return xp_through_levelup(profile, lv0, exp0, lv1, exp1), True
    if exp0 is None or exp1 is None:
        return None, False
    if level_capped(profile, lv1):
        return 0.0, False
    return (exp1 - exp0), False


class PartyXpAccumulator:
    """LIVE per-hero XP accumulator for the WHOLE run.

    Update rules (1 snapshot {heroKey: (lv, exp)} per call):
      - first sighting seeds the baseline (late deploy credited from first sight);
      - only positive increments accumulate; level-up bridges via the curve;
      - cap-level heroes gain 0 (phantom suppressed);
      - same-level dips / level drops (dirty reads) do not advance the baseline;
      - absent heroes (dead/dropout) keep their banked total.
    total() returns None when nobody was ever seen (live source off).
    """

    def __init__(self, profile: Profile):
        self.profile = profile
        self._heroes = {}

    def update(self, party):
        try:
            items = party.items() if party else ()
            for hk, cur in items:
                try:
                    lv, exp = cur
                except (TypeError, ValueError):
                    continue
                if lv is None or exp is None:
                    continue
                st = self._heroes.get(hk)
                if st is None:
                    self._heroes[hk] = {"acc": 0.0, "lv": lv, "exp": exp,
                                        "exp_start": exp, "levelup": False}
                    continue
                if lv < st["lv"]:
                    continue  # level never drops mid-run: dirty read
                g, leveled = per_hero_gain(self.profile, st["lv"], st["exp"], lv, exp)
                if leveled:
                    st["levelup"] = True
                if g is not None and g > 0:
                    st["acc"] += g
                if g is None or g >= 0:
                    st["lv"], st["exp"] = lv, exp
        except Exception:
            return

    def gain(self, hk):
        st = self._heroes.get(hk)
        return st["acc"] if st is not None else None

    def record(self, hk):
        st = self._heroes.get(hk)
        if st is None:
            return None
        return {"gain": round(st["acc"], 2), "levelup": st["levelup"],
                "exp_start": round(st["exp_start"], 2), "exp_end": round(st["exp"], 2)}

    def total(self):
        if not self._heroes:
            return None
        return sum(st["acc"] for st in self._heroes.values())


def xp_sane(value, curve_max=None):
    """Garbage rejection for decoded within-level XP:
    - real values are exactly 0 (just leveled) or >= 1 (cheapest curve step is 30);
    - wrong decodes land near ~1e-300 (denormals) OR at absurd magnitudes
      (observed live: 2e+90 with a plausible level decode);
    - a real within-level xp is bounded by the level curve maximum.
    curve_max defaults to the observed 1.2.8 curve cap (~2e9)."""
    import math

    if value is None or not math.isfinite(value):
        return False
    if value == 0.0:
        return True
    if value < 1.0:
        return False
    ceiling = curve_max if curve_max is not None else 2_000_000_000.0
    return value <= ceiling * 2.0
