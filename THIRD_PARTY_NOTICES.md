# Third-party notices

TBH Core (MIT) incorporates adaptations of the following third-party software.
The full license texts are available in the upstream repositories.

## mad-labs-org/tbh-meter (and its local 1.2.8 adaptation)

- Upstream project: TBH Meter — Task Bar Hero overlay meter
- Repository: https://github.com/mad-labs-org/tbh-meter
- Upstream commit used as reference: `5bc35e82b514b45814047de57551d08da62c9195`
  (plus the maintainer's uncommitted Task Bar Hero **1.2.8** adaptation of that tree,
  used read-only as the authoritative current-game reference)
- License: MIT — Copyright (c) 2026 Mad Labs
- Components adapted into `helper/memory-reader/src/tbh_core_reader/`:
  - `win32.py`, `memory.py` — read-only process attach (OpenProcess with
    PROCESS_QUERY_INFORMATION | PROCESS_VM_READ), ReadProcessMemory typed reader,
    region scanning (from `reader/shared/memory.py`);
  - `pe.py` — GameAssembly.dll build fingerprint (from `reader/il2cpp/typeinfo.py`);
  - `il2cpp.py` — index-based class resolution with name round-trip gates,
    nn<T> singleton resolution, targeted backref instance scan (from
    `reader/il2cpp/resolver.py`, `reader/il2cpp/finder.py`, the fast path of
    `reader/meter_windows.py`);
  - `game/obscured.py` — ACTk ObscuredInt/ObscuredDouble read-only decoding
    (from `reader/game/obscured.py`);
  - `game/models.py` — live monster iteration for HP-drop damage, stage catalog
    reads (from `reader/game/models.py` + catalog scan in `reader/meter_windows.py`);
  - `game/save.py` — PSD/CSD/StageManager picking and live-party reads
    (from `reader/game/save.py`, `reader/game/build.py`);
  - `metrics/gold.py` — combat gold via AggregateManager GoldEarn/SubKey1
    (from `reader/metrics/gold.py`);
  - `metrics/xp.py` — per-hero XP accumulator with curve-bridged level-ups
    (from `reader/metrics/xp.py`);
  - `metrics/dps.py` — HP-drop damage tracker (from `reader/metrics/dps.py`);
  - `lifecycle.py` — rotation-aware LogScanCursor, partial-capture
    classification (from `reader/meter_windows.py`, `reader/docs/invariants/run-lifecycle.md`);
  - the 1.2.8 compatibility data in `profiles/tbh-1.2.8.json` (offsets, calibration
    indices, level curve) — functional interoperability facts extracted from the
    reference's validated configuration.
- The Python helper is a minimal re-implementation for TBH Core's JSONL protocol,
  not a copy of the tbh-meter application; the upstream copyright and this notice
  are preserved per the MIT license.

No game assets, GameAssembly.dll, global-metadata.dat, dumps, or save files from
either repository are redistributed in TBH Core.
