# MemorySource — implementation notes (Phase D)

Production read-only memory telemetry for Task Bar Hero **1.2.8**. Research basis:
`docs/research/memory-source.md`, `run-lifecycle.md`, `telemetry-contract.md`,
`local-tbh-meter-audit.md`.

## Architecture

```
TaskBarHero.exe
   → read-only Python helper (packaged onedir exe, no user Python)
      → JSON Lines on stdout (protocolVersion 1)
   → TypeScript MemorySource (protocol validation, supervision, health)
      → live snapshots → renderer (1 Hz)
      → health → diagnostics + source_health_events (kind=memory)
      → completed runs → RunRepository / SQLite (migration 002 provenance)
```

Files: `helper/memory-reader/` (Python: `src/tbh_core_reader/…`, profile
`profiles/tbh-1.2.8.json`, tests) and `src/sources/memory/` (TS: `protocol.ts`,
`HelperProcess.ts`, `MemorySource.ts`, `adapter.ts`, `types.ts`). Electron glue:
`src/main/memory-source.ts`. Adaptation provenance: `THIRD_PARTY_NOTICES.md`.

## Read-only guarantees

- `OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ)` — the ONLY attach;
- `ReadProcessMemory` — the ONLY memory API used;
- forbidden APIs statically scanned by `tests/test_readonly.py` (fails the build):
  WriteProcessMemory, PROCESS_VM_WRITE/VM_OPERATION/ALL_ACCESS, VirtualAllocEx,
  VirtualProtectEx, CreateRemoteThread, SetThreadContext, LoadLibrary*;
- no admin requirement; no injection; no game/save file writes.

## Helper protocol (v1)

Newline-delimited JSON on **stdout** (protocol-only; debug logs go to stderr).
Messages: `hello`, `health`, `live` (~1 Hz), `run_completed`, `run_rejected` —
each carries `type`, `protocolVersion`, `seq`, `observedAtMs`. Never sent: raw
pointers, memory, passwords, save JSON, asset content.

TS side (`protocol.ts`) validates every line: fragmented chunks, CRLF/LF,
malformed JSON (tolerated up to a sustained threshold → degraded), unknown types
(ignored), protocol mismatch (helper stopped, NO restart loop — update path),
oversized lines (1 MiB cap; the runaway line is drained to its newline, memory
cannot grow unboundedly).

## Fail-closed compatibility

Profile keyed by the FULL fingerprint `<Version.txt>-<TimeDateStamp>-<SizeOfImage>`
(PE fields read live). Unknown fingerprint → `unsupported_game_version` /
`UNSUPPORTED_FINGERPRINT`, no telemetry, no nearest-table guessing, no
slow-scan promotion. Version string alone is never sufficient.

Known profile: `tbh-1.2.8-a` for `1.2.8-0x6ab23e8a-0x6b47000` (validated live
13/13 by the reference reader; revalidated by TBH Core).

## Runtime validation gates (supported fingerprint)

Class index resolution with name round-trip; singleton instance-size gates;
gold aggregate round-trip (GOLD_VALIDATION_FAILED → calibration_failed);
stage catalog sanity; hero catalog presence; LogManager list readability;
ACTk level plausibility + XP garbage rejection (bounded by the level curve —
observed live: a 2e+90 decode alongside a sane level is rejected to null).

## Health model

`disconnected | detecting | healthy | degraded | unsupported_game_version |
calibration_failed`, reason codes incl. GAME_NOT_RUNNING, PROCESS_OPEN_FAILED,
UNSUPPORTED_FINGERPRINT, CLASS_RESOLUTION_FAILED, GOLD/XP_VALIDATION_FAILED,
STAGE_UNAVAILABLE, DEAD_READ_WATCHDOG, HELPER_MISSING/CRASHED/PROTOCOL_MISMATCH/
OUTPUT_INVALID. Source-health epoch: `memory:<fingerprint>:<attach-ms>`.

## Stage detection (1.2.8 behavior preserved)

`resolve_stage_key`: live monster candidate → must be in the RUNTIME stage
catalog → else live-picked CSD `currentStageKey` → must be in catalog → else
last known. Out-of-catalog values are never accepted (live 910401 garbage vs
snapshot 2205). Stage/hero catalogs are runtime-discovered, not bundled.
If a terminal attempt has no catalog-valid stage: `run_rejected` /
STAGE_UNAVAILABLE — never a sentinel stage.

## Run lifecycle

tbh-meter's proven model: start = baselines after previous close (cursor SEEDED
at attach — backlog never replayed; late attach → first run `partial`); success
= new StageClearLog (official CLEAR_TIME read); fail = new StageFailedLog;
abandon = catalog-valid stage switch after the 3 s adoption grace OR a drop of
the cumulative dead-unit count (`StageManager.DEAD_UNIT_DICT`, 1.2.8 layout);
game exit / sustained dead reads → in-flight unclosed run DISCARDED
(`run_rejected` DEAD_READ_WATCHDOG), a closed terminal run is still persisted.
Run id = end-timestamp ms string. NO duration floor (fast valid runs stay valid);
partial = capture < 95 % of official clear (≥30 s gate) or success with ≤0 damage.

## XP / Gold / DPS / Mobs / Party

- **XP**: live ACTk-decoded per-hero accumulator (1.2.8 layout), level-ups
  bridged by the profile's level curve; cap heroes gain 0 (phantom suppressed);
  dips/level-drops never advance the baseline; late deploys seed at first
  sighting; garbage decodes rejected (None). Fallback: per-hero save delta →
  `xp_source=save, xp_confidence=checkpoint`. Live: `live/measured` — `verified`
  only after Phase E reconciliation.
- **Gold**: cumulative `AggregateManager.AGGREGATES[GoldEarn=2][SubKey=1]`
  baseline→close delta; monotonic only (non-monotonic → unavailable, never a
  clamped zero); fallback save-side cumulative (tagged `save/checkpoint`).
  Wallet/Total NEVER used for run gold.
- **Damage/DPS**: measured-derived HP-drop accumulation + killing blows at 10 Hz
  (heals ignored); live DPS = rolling ~5 s window; averageDps derived from the
  completed run. The game has no authoritative DPS counter.
- **Mobs**: killed = measured alive-count decrements; total = runtime stage
  catalog (waves×mobs+1); unavailable → null, not 0.
- **Party**: live `StageManager.HERO_LIST`, catalog-gated (ghost discriminator);
  slots = HeroList index; save roster NEVER substituted as the live party.

## Persistence

Migration `002-memory-run-provenance` (runs.reader_version, runs.memory_profile_id)
— transactional, idempotent reopen, v1→v2 upgrade tested. Wiring
(`persistence.attachMemorySource`): runs → RunRepository (identical duplicate =
no-op; conflicting id = typed RunConflictError surfaced as a degraded DB
diagnostic), health transitions → source_health_events with consecutive-dup
suppression. Persistence failures never stop the source. Startup order:
persistence → save source created+attached → memory source created+attached →
save starts → memory starts → window. Shutdown: memory stop → save stop → DB close.

## Helper supervision & packaging

`HelperProcess`: spawn `shell:false`, `windowsHide:true`; packaged path
`<resources>/reader/tbh-core-reader.exe` (electron-builder extraResources);
dev path `helper/memory-reader/dist/…` or `TBH_CORE_READER_PATH` (developer-only
override). Crash → bounded backoff restart (2/4/8/15/30 s, capped; immediate
restart after a previously-healthy session); protocol mismatch → NO restart.
`pnpm helper:test` / `pnpm helper:build` (PyInstaller onedir, console stdout,
profile bundled via --add-data; pinned pyinstaller==6.10.0 in
`requirements-build.txt`, build venv per `build.py`). `pnpm dist:win` builds the
helper first and FAILS if the artifact is missing (`scripts/verify-helper-artifact.js`).

## Live validation summary (2026-09-25, sanitized)

Game 1.2.8, fingerprint matched the profile; attach→healthy ≈ 6.5 s; healthy
gate passed; live snapshots at 1 Hz with stage 2301 (Nightmare), 3-hero party
(401/301/201, slots 0/1/2, levels 39), per-hero XP accruing (731K total / 38 s),
combat gold +12–20K/run-window, HP-drop damage accruing, mobs 51/323. Completed
runs captured — see the PR/handoff for counts and tbh-meter parity.

## Known limitations

- single supported fingerprint (by design; game updates fail closed);
- XP garbage rejection uses the curve ceiling heuristic (bounded 2× curve max);
- party reads can be empty during stage transitions (honest `heroes: []`, XP
  falls back or degrades);
- no drops/chest events in Phase D runs (Phase A documented GetBoxLog routing
  for a later phase);
- damage is derived from HP drops — hero-vs-hero attribution is not modeled;
- `node:sqlite`/Electron `node:sqlite` caveat from Phase C still applies.
