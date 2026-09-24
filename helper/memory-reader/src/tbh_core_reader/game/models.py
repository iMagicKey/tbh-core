"""models.py — live world reads: monsters (DPS), stage candidate, catalogs.

Adapted from tbh-meter game/models.py + meter_windows catalog scan (MIT), with
the 1.2.8 stage chain: the Monster stageKey field is NOT trustworthy on 1.2.8 —
every candidate is validated against the runtime stage catalog before use.
"""

import struct

from ..memory import Reader


def live_monsters(reader: Reader, msm):
    """Yields (unit_addr, hp_cur, hp_max) over alive + summoned monsters.
    HP lives at HealthController+0x40 (cur) / +0x4C (max) as PURE floats; one
    16-byte read covers both (same syscall discipline as tbh-meter)."""
    off = reader.p.off
    hc_off = off["Unit"]["healthController"]
    base = off["HealthController"]["hpCurrent"]
    mx_off = off["HealthController"]["hpMax"]
    for field in (off["MonsterSpawnManager"]["monsterList"],
                  off["MonsterSpawnManager"]["summonedList"]):
        for u in reader.list_ptrs(reader.rptr(msm + field), cap=600):
            hc = reader.rptr(u + hc_off)
            if not hc:
                continue
            vals = reader.read(hc + base, 16)
            if vals is None or len(vals) != 16:
                continue
            cur, _f1, _f2, mx = struct.unpack("<4f", vals)
            yield u, cur, mx


def live_stage_candidate(reader: Reader, msm):
    """Raw stage-key candidate from live monsters. GARBAGE on 1.2.8 (the field
    left the class) — every caller must catalog-gate it before use."""
    off = reader.p.off
    keys = []
    for u in reader.list_iter(reader.rptr(msm + off["MonsterSpawnManager"]["monsterList"]), cap=600):
        k = reader.ri32(u + off["Monster"]["stageKey"])
        if k is not None and 0 < k < 10_000_000:
            keys.append(k)
        if len(keys) >= 10:
            break
    return max(set(keys), key=keys.count) if keys else None


def read_stage_catalog(reader: Reader, stage_info_instances):
    """Runtime stage catalog {stageKey: (act, stageNo, hordeMobs, difficulty)}.
    Rows validated (diff in range, act/stageNo plausible); x-10 boss rows horde=0."""
    off = reader.p.off
    si = off["StageInfoData"]
    difficulties = reader.p.enums["difficulties"]
    actboss = reader.p.enums["stageClearTypeActboss"]
    catalog = {}
    for a in stage_info_instances:
        sk = reader.ri32(a + si["stageKey"])
        st = reader.ri32(a + si["stageType"])
        wa = reader.ri32(a + si["waveAmount"])
        wm = reader.ri32(a + si["waveMobAmount"])
        act = reader.ri32(a + si["act"])
        sno = reader.ri32(a + si["stageNo"])
        diff = reader.ri32(a + si["difficulty"])
        if sk is None:
            continue
        diff_ok = diff is not None and 0 <= diff < len(difficulties)
        actsno_ok = act is not None and sno is not None and 1 <= act <= 200 and 1 <= sno <= 200
        waves_ok = bool(wa and wm and 1 <= wa <= 200 and 1 <= wm <= 200) and diff_ok and actsno_ok
        boss_ok = st == actboss and diff_ok and actsno_ok
        if waves_ok or boss_ok:
            catalog[sk] = (act, sno, (wa * wm) if waves_ok else 0, diff)
    return catalog


def read_hero_catalog(reader: Reader, hero_info_instances):
    """Runtime hero catalog {heroKey: classType} (ghost discriminator)."""
    off = reader.p.off
    catalog = {}
    for a in hero_info_instances:
        hk = reader.ri32(a + off["HeroInfoData"]["heroKey"])
        if hk is not None and 0 < hk < 10_000_000 and hk not in catalog:
            catalog[hk] = reader.ri32(a + off["HeroInfoData"].get("classType", 72))
    return catalog


def stage_catalog_sane(catalog):
    """Cheap sanity gate: non-empty with plausible rows."""
    if not catalog or len(catalog) < 5:
        return False
    good = sum(1 for (act, sno, horde, _diff) in catalog.values()
               if 1 <= act <= 200 and 1 <= sno <= 200 and horde >= 0)
    return good >= len(catalog) * 0.9
