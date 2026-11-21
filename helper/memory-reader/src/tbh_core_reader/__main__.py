"""__main__.py — the memory reader helper main loop.

Attach -> fingerprint gate (fail closed) -> profile resolution with runtime
gates -> 10 Hz poll (DPS, stage chain, log cursor, restart detector) ->
1 Hz party/XP/live snapshot -> run lifecycle closes -> JSONL on stdout.

Strictly READ-ONLY (OpenProcess QUERY|VM_READ; ReadProcessMemory only).
Adapted from tbh-meter meter_windows.py (MIT) — see THIRD_PARTY_NOTICES.md.
"""

import argparse
import os
import sys
import time

from . import READER_VERSION, protocol
from . import il2cpp, pe, win32
from .game import models, save
from .il2cpp import ResolutionFailure
from .lifecycle import LogScanCursor, detect_restart, is_partial, make_run_id, resolve_stage_key
from .memory import Reader
from .metrics import gold as gold_mod
from .metrics import xp as xp_mod
from .metrics.dps import DpsTracker
from .profile import ProfileError, load_profile

LOG_SCAN_CAP = 300
SUPPORTED_INSTANCE_CLASSES = ("PlayerSaveData", "CommonSaveData", "StageManager",
                              "StageInfoData", "HeroInfoData")


def detect_game_version(handle):
    """Version.txt next to the game exe (via the read-only handle)."""
    try:
        exe = win32.process_image_path(handle)
        if not exe:
            return None
        with open(os.path.join(os.path.dirname(exe), "Version.txt"), encoding="utf-8-sig") as f:
            return f.read().strip()[:40] or None
    except Exception:
        return None


class Session:
    """One attached, fingerprint-validated, resolved session."""

    def __init__(self, reader, profile, fingerprint, game_version):
        self.reader = reader
        self.profile = profile
        self.fingerprint = fingerprint
        self.game_version = game_version
        self.health_epoch = "memory:%s:%d" % (fingerprint, int(time.time() * 1000))
        # resolved at attach:
        self.msm = None
        self.lm = None
        self.gold_klass = None
        self.stage_info = {}
        self.hero_cat = {}
        self.psd_list = []
        self.csd_list = []
        self.sm_list = []
        self.csd = None
        self.sm = None
        # run state:
        self.R = None
        self.cursor = None
        self.prev_dead = None
        self.last_alive = 0
        self.dead_reads = 0
        self.last_snap = 0.0
        self.last_sm_refresh = 0.0
        self.run_num = 0
        self.attach_was_in_combat = False
        self.tbase = None

    # ---------------- resolution + runtime gates ----------------

    def resolve(self):
        r = self.reader
        p = self.profile
        ga_base, _ = win32.module_base(getattr(r, "_pid", 0), p.process["moduleName"])
        if not ga_base:
            raise ResolutionFailure("GameAssembly.dll module not found")
        self.ga_base = ga_base
        tbase = il2cpp.table_base(r, ga_base, p.calibration["anchorRva"])
        if not tbase:
            raise ResolutionFailure("TypeInfoTable anchor did not resolve")
        self.tbase = tbase
        indices = p.calibration["indices"]
        classes = {}
        for name in indices:
            classes[name] = il2cpp.resolve_class(r, tbase, indices[name], name)
        self.sc_class = classes["StageClearLog"]
        self.sf_class = classes["StageFailedLog"]
        singletons = il2cpp.resolve_singletons(r, tbase, indices)
        self.msm = singletons["MonsterSpawnManager"]
        self.lm = singletons["LogManager"]

        # combat gold klass by index + round-trip gate
        self.gold_klass = gold_mod.combat_gold_klass_by_index(r, tbase, p.calibration["idxUt"])
        if not self.gold_klass:
            raise ResolutionFailure("combat gold aggregate did not pass its round-trip gate")

        # non-singletons + catalogs via ONE targeted backref sweep
        regs = win32.regions(r.handle)
        insts = il2cpp.instances_of(r, regs, {n: classes[n] for n in SUPPORTED_INSTANCE_CLASSES})
        self.psd_list = insts["PlayerSaveData"]
        self.csd_list = insts["CommonSaveData"]
        self.sm_list = insts["StageManager"]
        self.stage_info = models.read_stage_catalog(r, insts["StageInfoData"])
        self.hero_cat = models.read_hero_catalog(r, insts["HeroInfoData"])
        if not models.stage_catalog_sane(self.stage_info):
            raise ResolutionFailure("stage catalog failed its sanity gate")
        if not self.hero_cat:
            raise ResolutionFailure("hero catalog is empty")

        # LogManager list readable (run boundary prerequisite)
        ll = r.rptr(self.lm + p.off["LogManager"]["logList"])
        size = r.ri32((ll or 0) + p.il2cpp["listSize"]) if ll else None
        if size is None or size < 0:
            raise ResolutionFailure("LogManager LOG_LIST unreadable")

        self.csd = save.pick_live_csd(r, self.csd_list, self.stage_info)
        self.sm = save.pick_live_sm(r, self.sm_list, self.hero_cat)
        return True

    def runtime_gates_report(self):
        """Cheap per-gate report -> list of (gate, ok, detail)."""
        r = self.reader
        gates = []
        glive = gold_mod.combat_gold_live(r, self.gold_klass)
        gates.append(("gold_readable", glive is not None and glive > 0, None))
        actk_ok = True
        actk_detail = None
        if self.sm:
            party = save.read_live_party(r, self.sm, self.hero_cat)
            for hk, (lvl, exp) in party.items():
                if lvl is None:
                    actk_ok = False
                    actk_detail = "hero %r level decode failed" % hk
                if exp is not None and not xp_mod.xp_sane(exp):
                    actk_ok = False
                    actk_detail = "hero %r xp decode garbage" % hk
        gates.append(("actk_plausible", actk_ok, actk_detail))
        return gates

    # ---------------- run state ----------------

    def new_run(self, attached_mid_run=False):
        r = self.reader
        p = self.profile
        psd = save.pick_live_psd(r, self.psd_list)
        save_heroes = save.read_save_heroes(r, psd)
        pl0 = save.read_live_party(r, self.sm, self.hero_cat, save_heroes)
        acc = xp_mod.PartyXpAccumulator(p)
        acc.update(pl0)
        return {
            "dps": DpsTracker(p.lifecycle["dpsWindowSeconds"]),
            "mobs": 0,
            "start_mono": time.monotonic(),
            "start_ms": int(time.time() * 1000),
            "gold_live_start": gold_mod.combat_gold_live(r, self.gold_klass),
            "gold_save_start": save.combat_gold_save(r, psd),
            "save_heroes_start": save_heroes,
            "xp_acc": acc,
            "party_seen": {},
            "party_slots": save.read_party_slots(r, self.sm, self.hero_cat),
            "stage_key": None,
            "adopt_until": time.monotonic() + p.lifecycle["adoptGraceSeconds"],
            "attached_mid_run": attached_mid_run,
        }

    def close_run(self, status, log_event=None):
        r = self.reader
        p = self.profile
        R = self.R
        self.R = None
        self.run_num += 1
        off = p.off

        stage_key = R["stage_key"]
        if stage_key is None or stage_key not in self.stage_info:
            protocol.run_rejected("STAGE_UNAVAILABLE",
                                  "terminal %s without a catalog-valid stage identity" % status)
            self.R = self.new_run()
            return

        clear_time = 0
        if log_event is not None:
            if status == "success":
                clear_time = r.ri32(log_event + off["StageClearLog"]["clearTime"]) or 0
        measured = time.monotonic() - R["start_mono"]

        # --- combat gold: LIVE cumulative delta (SubKey 1 only); save fallback tagged
        live_gain = gold_mod.run_gain(R["gold_live_start"], gold_mod.combat_gold_live(r, self.gold_klass))
        if live_gain is not None:
            gold_value, gold_source, gold_conf = int(live_gain), "live", "measured"
        else:
            psd = save.pick_live_psd(r, self.psd_list)
            save_gain = gold_mod.run_gain(R["gold_save_start"], save.combat_gold_save(r, psd))
            if save_gain is not None:
                gold_value, gold_source, gold_conf = int(save_gain), "save", "checkpoint"
            else:
                gold_value, gold_source, gold_conf = None, None, None

        # --- party + XP: live accumulator final sample
        psd = save.pick_live_psd(r, self.psd_list)
        heroes_end = save.read_save_heroes(r, psd)
        pl_end = save.read_live_party(r, self.sm, self.hero_cat, heroes_end)
        acc = R["xp_acc"]
        acc.update(pl_end)
        R["party_seen"].update(dict.fromkeys(pl_end))
        slots_now = save.read_party_slots(r, self.sm, self.hero_cat)
        R["party_slots"].update(slots_now)

        xp_total_live = acc.total()
        xp_live_ok = xp_total_live is not None
        xp_by_hero_save = {}
        for k, v in heroes_end.items():
            start_exp = (R["save_heroes_start"].get(k) or (None, 0.0))[1]
            xp_by_hero_save[k] = (0.0 if xp_mod.level_capped(p, v[0])
                                  else max(0.0, v[1] - start_exp))
        if xp_live_ok:
            xp_value, xp_source, xp_conf = round(xp_total_live, 2), "live", "measured"
        elif heroes_end:
            xp_value, xp_source, xp_conf = round(sum(xp_by_hero_save.values()), 2), "save", "checkpoint"
        else:
            xp_value, xp_source, xp_conf = None, None, None

        # --- per-hero rows (live party only; heroKey required)
        live_keys = set(R.get("party_live_start") or ()) | set(R["party_seen"])
        heroes_rows = []
        for hk in live_keys:
            slot = R["party_slots"].get(hk)
            rec = acc.record(hk)
            level_start = (R["save_heroes_start"].get(hk) or (None, None))[0]
            level_end = (pl_end.get(hk) or (None, None))[0] or (heroes_end.get(hk) or (None, None))[0]
            if rec is not None:
                heroes_rows.append({
                    "heroKey": hk, "slot": slot,
                    "levelStart": level_start, "levelEnd": level_end,
                    "xpGained": rec["gain"],
                })
            else:
                heroes_rows.append({
                    "heroKey": hk, "slot": slot,
                    "levelStart": level_start, "levelEnd": level_end,
                    "xpGained": round(xp_by_hero_save.get(hk, 0.0), 2),
                })

        total_damage = R["dps"].total_damage
        si = self.stage_info.get(stage_key)
        ended_ms = int(time.time() * 1000)
        capture = "partial" if (is_partial(status, clear_time, measured, total_damage,
                                           p.lifecycle["partialCaptureMin"],
                                           p.lifecycle["partialGateSeconds"])
                                or R.get("attached_mid_run")) else "complete"
        run = {
            "id": make_run_id(ended_ms),
            "stageKey": stage_key,
            "difficulty": si[3] if si else None,
            "startedAtMs": R["start_ms"],
            "endedAtMs": ended_ms,
            "durationMs": round(measured * 1000, 1),
            "officialClearTimeMs": (clear_time * 1000) if clear_time else None,
            "outcome": status,
            "captureQuality": capture,
            "xpValue": xp_value, "xpSource": xp_source, "xpConfidence": xp_conf,
            "goldValue": gold_value, "goldSource": gold_source, "goldConfidence": gold_conf,
            "damage": round(total_damage, 2),
            "averageDps": round(total_damage / max(measured, 0.001), 2),
            "mobsKilled": R["mobs"],
            "mobsTotal": (si[2] + 1) if si else None,
            "gameVersion": self.game_version,
            "gameFingerprint": self.fingerprint,
            "readerVersion": READER_VERSION,
            "profileId": p.profile_id,
            "sourceHealthEpoch": self.health_epoch,
            "reconciliationStatus": None,
            "sessionId": None,
            "buildId": None,
            "heroes": heroes_rows,
        }
        protocol.run_completed(run)
        self.R = self.new_run()

    # ---------------- poll ----------------

    def poll_once(self):
        r = self.reader
        p = self.profile
        off = p.off
        now_mono = time.monotonic()

        # dead-read watchdog
        if r.rptr(self.lm + off["LogManager"]["logList"]) is None:
            self.dead_reads += 1
        else:
            self.dead_reads = 0
        if self.dead_reads >= int(p.lifecycle["pollHz"] * p.lifecycle["deadReadSeconds"]):
            if self.R is not None:
                # unclosed run: discard (do NOT persist)
                protocol.run_rejected("DEAD_READ_WATCHDOG", "game exited mid-run; run discarded")
                self.R = None
            return False  # -> reattach

        # DPS + mobs
        if self.R is not None:
            self.R["dps"].update(models.live_monsters(r, self.msm), now_mono)
            alive = self.R["dps"].alive
            if alive < self.last_alive:
                self.R["mobs"] += (self.last_alive - alive)
            self.last_alive = alive

        # stage chain (1.2.8): live candidate -> catalog gate -> CSD snapshot -> gate -> last known
        candidate = models.live_stage_candidate(r, self.msm)
        snapshot = None
        if not (candidate is not None and candidate in self.stage_info):
            if self.csd is None:
                self.csd = save.pick_live_csd(r, self.csd_list, self.stage_info)
            if self.csd:
                snapshot = r.ri32(self.csd + off["CommonSaveData"]["currentStageKey"])
        self.cur_key = resolve_stage_key(candidate, snapshot, self.stage_info,
                                         getattr(self, "cur_key", None))
        cur_key = self.cur_key

        # dead-count restart detector (1.2.8: StageManager.DEAD_UNIT_DICT)
        if self.sm:
            dud = r.rptr(self.sm + off["StageManager"]["deadUnitDict"])
            dead_now = r.ri32(dud + p.il2cpp["dictCount"]) if dud else None
            reloaded = detect_restart(self.prev_dead, dead_now)
            if dead_now is not None:
                self.prev_dead = dead_now
        else:
            reloaded = False

        # log cursor -> terminal events
        closed = False
        il = p.il2cpp
        ll = r.rptr(self.lm + off["LogManager"]["logList"])
        size = r.ri32(ll + il["listSize"]) if ll else None
        items = r.rptr(ll + il["listItems"]) if ll else None

        def read_ptr_at(i):
            return r.rptr(items + il["arrayData"] + i * 8) if items else None

        for e in self.cursor.new_entries(read_ptr_at, size, LOG_SCAN_CAP):
            kl = r.rptr(e)
            if kl == self.sc_class:
                self.close_run("success", e)
                closed = True
            elif kl == self.sf_class:
                self.close_run("fail", e)
                closed = True

        # stage adoption + abandon
        if self.R is not None:
            if cur_key is not None and cur_key in self.stage_info and (
                    self.R["stage_key"] is None or now_mono < self.R["adopt_until"]):
                self.R["stage_key"] = cur_key
            if not closed and now_mono >= self.R["adopt_until"] and self.R["stage_key"] is not None:
                switched = (cur_key is not None and cur_key in self.stage_info
                            and cur_key != self.R["stage_key"])
                if reloaded or switched:
                    self.close_run("abandoned")
        if self.R is None:
            self.R = self.new_run()

        # 1 Hz: party/xp sample + live snapshot
        if now_mono - self.last_snap >= 1.0:
            self.last_snap = now_mono
            if not self.sm:
                self.sm = save.pick_live_sm(r, self.sm_list, self.hero_cat)
            psd = save.pick_live_psd(r, self.psd_list)
            save_heroes = save.read_save_heroes(r, psd)
            party = save.read_live_party(r, self.sm, self.hero_cat, save_heroes)
            if not party:
                # the cached sm stopped carrying a party (stage transition / ghost) —
                # re-pick across the candidate list instead of trusting it forever
                sm2 = save.pick_live_sm(r, self.sm_list, self.hero_cat)
                if sm2 and sm2 != self.sm:
                    self.sm = sm2
                    party = save.read_live_party(r, self.sm, self.hero_cat, save_heroes)
            if not party and now_mono - self.last_sm_refresh > 10.0:
                # the live StageManager may have been created AFTER attach —
                # refresh the candidate list with a fresh backref sweep (bounded cadence)
                self.last_sm_refresh = now_mono
                sm_k = il2cpp.class_by_index(r, self.tbase,
                                             self.profile.calibration["indices"]["StageManager"])
                if sm_k:
                    fresh = il2cpp.instances_of(r, win32.regions(r.handle),
                                                {"StageManager": sm_k})
                    if fresh["StageManager"]:
                        self.sm_list = fresh["StageManager"]
                        sm2 = save.pick_live_sm(r, self.sm_list, self.hero_cat)
                        if sm2:
                            self.sm = sm2
                            party = save.read_live_party(r, self.sm, self.hero_cat, save_heroes)
            slots = save.read_party_slots(r, self.sm, self.hero_cat)
            if self.R is not None:
                self.R["party_seen"].update(dict.fromkeys(party))
                self.R["party_live_start"] = party
                self.R["xp_acc"].update(party)
            g_gain = gold_mod.run_gain(self.R["gold_live_start"] if self.R else None,
                                       gold_mod.combat_gold_live(r, self.gold_klass))
            x_gain = self.R["xp_acc"].total() if self.R else None
            si = self.stage_info.get(cur_key) if cur_key else None
            protocol.live({
                "observedAtMs": int(time.time() * 1000),
                "gameVersion": self.game_version,
                "gameFingerprint": self.fingerprint,
                "stageKey": cur_key,
                "difficulty": si[3] if si else None,
                "run": {
                    "startedAtMs": self.R["start_ms"] if self.R else None,
                    "elapsedMs": int((now_mono - self.R["start_mono"]) * 1000) if self.R else None,
                    "xpSoFar": round(x_gain, 2) if x_gain is not None else None,
                    "goldSoFar": int(g_gain) if g_gain is not None else None,
                    "damage": round(self.R["dps"].total_damage, 2) if self.R else None,
                    "dps": round(self.R["dps"].dps(now_mono), 2) if self.R else None,
                    "mobsKilled": self.R["mobs"] if self.R else None,
                    "mobsTotal": (si[2] + 1) if si else None,
                },
                "heroes": [
                    {"heroKey": hk, "slot": slots.get(hk), "level": lv,
                     "xpSoFar": round(self.R["xp_acc"].gain(hk), 2)
                     if self.R and self.R["xp_acc"].gain(hk) is not None else None}
                    for hk, (lv, _exp) in (party or {}).items()
                ],
            })
        return True


def _pid_of(reader):
    return getattr(reader, "_pid", 0)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="tbh-core-reader")
    ap.add_argument("--profile", default=None)
    args = ap.parse_args(argv)

    try:
        profile = load_profile(args.profile or os.environ.get("TBH_CORE_PROFILE")
                               or _bundled_profile_path())
        protocol.hello(READER_VERSION, profile.profile_id)
    except ProfileError as e:
        protocol.hello(READER_VERSION, None)
        protocol.health("error", "PROFILE_LOAD_FAILED", str(e))
        return 3

    while True:
        _attach_loop(profile)
        time.sleep(2.0)


def _bundled_profile_path():
    import sys
    base = getattr(sys, "_MEIPASS", None) or os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", ".."))
    return os.path.join(base, "profiles", "tbh-1.2.8.json")


def _attach_loop(profile):
    """Find -> gate -> resolve -> poll until the game goes away. Returns to re-find."""
    pid = None
    while pid is None:
        protocol.health("disconnected", "GAME_NOT_RUNNING")
        time.sleep(2.0)
        pid = win32.find_pid(profile.process["processName"])
    handle = win32.open_process(pid)
    if not handle:
        protocol.health("disconnected", "PROCESS_OPEN_FAILED")
        time.sleep(2.0)
        return
    reader = Reader(handle, profile)
    reader._pid = pid

    game_version = detect_game_version(handle)
    if not game_version:
        protocol.health("detecting", "GAME_VERSION_UNREADABLE")
    ga_base, _ = win32.module_base(pid, profile.process["moduleName"])
    if not ga_base:
        protocol.health("error", "GAME_ASSEMBLY_NOT_FOUND")
        win32.close(handle)
        time.sleep(3.0)
        return
    fingerprint = pe.build_fingerprint(reader, ga_base, game_version)
    if not fingerprint or not profile.matches_fingerprint(fingerprint):
        protocol.health("unsupported_game_version", "UNSUPPORTED_FINGERPRINT",
                        "observed %r; supported %r" % (fingerprint, profile.fingerprint),
                        game_version=game_version, game_fingerprint=fingerprint,
                        profile_id=profile.profile_id)
        win32.close(handle)
        time.sleep(5.0)
        return

    protocol.health("detecting", "RESOLVING", game_version=game_version,
                    game_fingerprint=fingerprint, profile_id=profile.profile_id)
    session = Session(reader, profile, fingerprint, game_version)
    try:
        session.resolve()
    except ResolutionFailure as e:
        protocol.health("calibration_failed", "CLASS_RESOLUTION_FAILED", str(e),
                        game_version=game_version, game_fingerprint=fingerprint,
                        profile_id=profile.profile_id)
        protocol.log("resolution failed: %s" % e)
        win32.close(handle)
        time.sleep(10.0)
        return

    gates = session.runtime_gates_report()
    failed = [(g, d) for (g, ok, d) in gates if not ok]
    if failed:
        protocol.health("degraded", "GOLD_VALIDATION_FAILED" if failed[0][0] == "gold_readable"
                        else "XP_VALIDATION_FAILED", str(failed[0][1]),
                        game_version=game_version, game_fingerprint=fingerprint,
                        profile_id=profile.profile_id)
    else:
        protocol.health("healthy", "OK", None, game_version=game_version,
                        game_fingerprint=fingerprint, profile_id=profile.profile_id,
                        health_epoch=session.health_epoch)

    session.cursor = LogScanCursor()
    session.R = session.new_run()
    session.attach_was_in_combat = session.msm is not None and session.last_alive > 0

    interval = 1.0 / profile.lifecycle["pollHz"]
    try:
        while True:
            started = time.monotonic()
            if not session.poll_once():
                protocol.health("disconnected", "DEAD_READ_WATCHDOG",
                                "sustained unreadable memory; reattaching")
                break
            elapsed = time.monotonic() - started
            time.sleep(max(0.001, interval - elapsed))
    finally:
        win32.close(handle)


if __name__ == "__main__":
    sys.exit(main())
