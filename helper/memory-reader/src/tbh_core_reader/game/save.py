"""save.py — in-memory save-snapshot reads (PSD/CSD picking + fallbacks).

Adapted from tbh-meter game/save.py (MIT). These are READS of the game's own
in-memory save structures — used for the save-side gold fallback, hero-level
corroboration, and the CSD stage snapshot of the 1.2.8 stage chain.
"""

from ..game import obscured
from ..metrics.xp import xp_sane


def read_save_gold(reader, psd):
    """Wallet gold (CurrencySaveData Key==goldCurrencyKey)."""
    if not psd:
        return None
    off = reader.p.off
    key_gold = reader.p.enums["goldCurrencyKey"]
    for e in reader.list_iter(reader.rptr(psd + off["PlayerSaveData"]["currencies"]), cap=200):
        if reader.ri32(e + off["CurrencySaveData"]["key"]) == key_gold:
            return reader.ri64(e + off["CurrencySaveData"]["quantity"])
    return None


def read_save_heroes(reader, psd):
    """{heroKey: (level, exp)} from the in-memory save snapshot (stale by nature)."""
    if not psd:
        return {}
    off = reader.p.off
    res = {}
    for e in reader.list_iter(reader.rptr(psd + off["PlayerSaveData"]["heroes"]), cap=200):
        k = reader.ri32(e + off["HeroSaveData"]["heroKey"])
        lvl = reader.ri32(e + off["HeroSaveData"]["level"])
        exp = reader.rf64(e + off["HeroSaveData"]["exp"])
        if k is None or lvl is None or exp is None:
            continue
        if lvl > 1 or exp > 0:
            res[k] = (lvl, exp)
    return res


def pick_live_psd(reader, cands):
    """LIVE PlayerSaveData = the one with the MOST gold (older snapshots have less)."""
    best, bg = None, -1
    for a in (cands or [])[:200]:
        g = read_save_gold(reader, a)
        if g and g > bg:
            bg, best = g, a
    return best


def pick_live_csd(reader, cands, stage_info):
    """LIVE CommonSaveData: sane playtime + plausible stage key; in-catalog outranks."""
    off = reader.p.off
    best, best_rank = None, (False, -1.0)
    for a in (cands or []):
        key = reader.ri32(a + off["CommonSaveData"]["currentStageKey"])
        pt = reader.rf32(a + off["CommonSaveData"]["playtime"])
        if key is None or not (0 < key < 10_000_000):
            continue
        if pt is None or not (0.0 < pt < 1e9):
            continue
        rank = (bool(stage_info) and key in stage_info, pt)
        if rank > best_rank:
            best_rank, best = rank, a
    return best


def combat_gold_save(reader, psd):
    """Cumulative COMBAT gold from the save snapshot (GoldEarn/SubKey 1). Lagged fallback."""
    if not psd:
        return None
    off = reader.p.off
    t_gold = reader.p.enums["aggregateGoldEarn"]
    combat = reader.p.enums["combatSubKey"]
    for e in reader.list_iter(reader.rptr(psd + off["PlayerSaveData"]["aggregates"]), cap=2000):
        if (reader.ri32(e + off["AggregateSaveData"]["type"]) == t_gold
                and reader.ri32(e + off["AggregateSaveData"]["subKey"]) == combat):
            return reader.ri64(e + off["AggregateSaveData"]["value"])
    return None


def read_live_party(reader, sm, hero_cat, save_heroes=None):
    """{heroKey: (level, exp)} for the LIVE deployed party (StageManager.HeroList),
    ACTk-decoded, catalog-gated (ghost discriminator). Adapted from tbh-meter.

    Level falls back to the save snapshot on an implausible decode; EXP stays
    None on a bad/garbage read so the XP chain degrades honestly.
    """
    off = reader.p.off
    il = reader.p.il2cpp
    res = {}
    if not sm:
        return res
    hl = reader.rptr(sm + off["StageManager"]["heroList"])
    if not hl:
        return res
    n = reader.ri32(hl + il["arrayMaxLength"])
    if n is None or not (0 < n <= 12):
        return res
    for i in range(n):
        h = reader.rptr(hl + il["arrayData"] + i * 8)
        if not h:
            continue
        uf = reader.rptr(h + off["Unit"]["cache"])
        if not uf:
            continue
        hi = reader.rptr(uf + off["HeroRuntime"]["info"])
        hk = reader.ri32(hi + off["HeroInfoData"]["heroKey"]) if hi else None
        if hk is None or not (0 < hk < 10_000_000):
            continue
        if hero_cat is not None and hk not in hero_cat:
            continue  # ghost slot
        lvl = obscured.decode_obscured_int(reader.ru32(uf + off["HeroRuntime"]["levelHidden"]),
                                           reader.ru32(uf + off["HeroRuntime"]["levelKey"]))
        if lvl is None or not (0 < lvl <= 200):
            lvl = (save_heroes or {}).get(hk, (None, None))[0]
        exp = obscured.decode_obscured_double(reader.ru64(uf + off["HeroRuntime"]["expHidden"]),
                                              reader.ru64(uf + off["HeroRuntime"]["expKey"]))
        if exp is not None and not xp_sane(exp):
            exp = None  # garbage decode (observed live: 2e+90 alongside a sane level)
        res[hk] = (lvl, exp)
    return res


def read_party_slots(reader, sm, hero_cat):
    """{heroKey: slot} — formation position = HeroList index (0/1/2, gaps included)."""
    off = reader.p.off
    il = reader.p.il2cpp
    if not sm:
        return {}
    hl = reader.rptr(sm + off["StageManager"]["heroList"])
    if not hl:
        return {}
    n = reader.ri32(hl + il["arrayMaxLength"])
    if n is None or not (0 < n <= 12):
        return {}
    out = {}
    for i in range(n):
        h = reader.rptr(hl + il["arrayData"] + i * 8)
        if not h:
            continue
        uf = reader.rptr(h + off["Unit"]["cache"])
        hi = reader.rptr(uf + off["HeroRuntime"]["info"]) if uf else None
        hk = reader.ri32(hi + off["HeroInfoData"]["heroKey"]) if hi else None
        if hk is None or not (0 < hk < 10_000_000):
            continue
        if hero_cat is not None and hk not in hero_cat:
            continue
        out[hk] = i
    return out


def pick_live_sm(reader, cands, hero_cat):
    """The StageManager instance carrying a real deployed party."""
    for a in (cands or []):
        if read_live_party(reader, a, hero_cat):
            return a
    return None
