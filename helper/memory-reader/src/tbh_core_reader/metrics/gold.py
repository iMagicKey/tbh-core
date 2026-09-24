"""gold.py — per-run COMBAT gold from the live cumulative aggregate.

Adapted from tbh-meter metrics/gold.py (MIT). Source:
AggregateManager.AGGREGATES[GoldEarn=2][SubKey=1] — the LIVE cumulative combat
counter. NEVER the wallet and NEVER the SubKey-0 TOTAL. run_gain is monotonic:
a non-monotonic read yields None (unavailable), never a clamped zero.
"""

from ..memory import Reader


def combat_gold_live(reader: Reader, gold_klass):
    """Cumulative live combat gold, or None when the structure is unreadable."""
    from ..il2cpp import bbwf_from_klass

    if not gold_klass:
        return None
    inst = bbwf_from_klass(reader, gold_klass)
    if not inst:
        return None
    outer = reader.rptr(inst + reader.p.off["AggregateManager"]["aggregates"])
    if not outer:
        return None
    t_gold = reader.p.enums["aggregateGoldEarn"]
    combat = reader.p.enums["combatSubKey"]
    for k, v in reader.dict8b_items(outer):
        if k == t_gold:
            for sk, sv in reader.dict8b_items(v):
                if sk == combat:
                    return sv if (sv is not None and 0 < sv < 1_000_000_000_000_000) else None
            return None
    return None


def combat_gold_klass_ok(reader: Reader, klass):
    return combat_gold_live(reader, klass) is not None


def combat_gold_klass_by_index(reader: Reader, tbase, idx_ut):
    """Gold klass by TypeDefIndex + round-trip gate (never serves an unvalidated klass)."""
    from ..il2cpp import bbwf_from_klass, class_by_index

    if not tbase or idx_ut is None:
        return None
    klass = class_by_index(reader, tbase, idx_ut)
    return klass if (klass and combat_gold_klass_ok(reader, klass)) else None


def run_gain(start_value, end_value):
    """Monotonic delta = combat gold earned in the run. None on missing/non-monotonic
    reads (never a negative, never a clamped zero pretending to be measured)."""
    if start_value is None or end_value is None or end_value < start_value:
        return None
    return end_value - start_value
