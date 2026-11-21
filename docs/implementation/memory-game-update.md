# Memory source — game update workflow

What happens when Task Bar Hero updates, and how a new build becomes supported.

## 1. Detection (automatic)

The helper reads `Version.txt` + the GameAssembly.dll PE header
(TimeDateStamp + SizeOfImage) at every attach and computes the FULL fingerprint
`<version>-<tds>-<sizeofimage>`. A changed build → new fingerprint → the profile
lookup misses → the source emits `unsupported_game_version` /
`UNSUPPORTED_FINGERPRINT` with both observed and supported values, and NO
layout-dependent reads run. The UI surfaces the unsupported state.

This is deliberate: field offsets, obfuscated-name drift and the ACTk encoding
can change while values still LOOK plausible — "version is still 1.2.8 so
offsets probably work" is exactly the failure mode this prevents.

## 2. Evidence gathering (manual, read-only)

1. Il2CppDumper over the new `GameAssembly.dll` + `global-metadata.dat`
   (unencrypted, magic `af1bb1fa`) → `dump.cs` with field offsets.
2. Diff the tracked classes against the current profile
   (`helper/memory-reader/profiles/*.json`): Unit base growth (Hero.cache tail),
   StageManager/MonsterSpawnManager layout (dead-unit dict vs list),
   CommonSaveData stage fields, PlayerSaveData list shifts, HeroRuntime level/XP
   record offsets, AggregateManager, log classes.
3. Re-derive the calibration: anchor_rva (TypeInfoTable pointer), TypeDef
   indices, idx_ut — via the reference reader's discovery procedure.
4. Diff the ACTk encoding: re-disassemble the op_Implicit accessors; the
   int/float/double algorithms and the byte permutation can change with zero
   offset movement (the 1.00.20 lesson).

Offset equality alone NEVER proves compatibility — encoding, semantics and
structure must be re-verified.

## 3. Profile update

Add the new fingerprint as a NEW profile file (schema version bump when the
shape changes); never edit a shipped profile's identity in place.

## 4. Static tests

Update/extend `helper/memory-reader/tests/` (fingerprint vectors, ACTk vectors,
stage chain, offsets plausibility) and the read-only scan. `pnpm helper:test`.

## 5. Live validation battery

With the updated game running: attach → healthy; runtime gates (gold round-trip,
stage catalog sanity, hero catalog, ACTk level/xp oracle — decoded levels must
corroborate in-memory save levels); observe ≥3 successful completed runs
(stage, official clear time, per-hero XP incl. a level-up if practical, combat
gold exactness, damage/mobs plausibility); side-by-side against the reference
tbh-meter adaptation for the same live runs; save cross-checks (cumulative
combat gold delta, hero levels).

## 6. Only then: mark supported

Ship the new profile in a beta TBH Core update (electron-updater beta channel);
stable promotion after field feedback.

## Out of scope of this workflow

- no auto-discovery/slow-scan promotion of unknown builds (deliberate);
- no offset shipping without the live battery passing;
- Player.log/reconciliation behavior is unaffected by game updates.
