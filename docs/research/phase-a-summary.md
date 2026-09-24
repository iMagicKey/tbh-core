# Phase A — telemetry sources research summary

Phase A goal (per `docs/IMPLEMENTATION_PLAN.md` Milestone A): establish, with source-level
evidence, what each data source can reliably provide and how TBH Core should combine them —
before any production integration is written. This document is the index; details live in the
sibling documents. No production code was added in this phase.

Companion documents:

- `local-tbh-meter-audit.md` — the local updated tbh-meter (game 1.2.8 adaptation), exact git
  state and per-change classification.
- `reference-matrix.md` — one-row-per-repo matrix of all 7 reference projects.
- `memory-source.md` — full memory data flow, per-metric inventory, version/compatibility model,
  proposed health states.
- `save-source.md` — SaveFile_Live.es3: discovery, decryption (5-way verified), field matrix,
  watching/robustness patterns.
- `player-log-source.md` — Player.log: the one proven event family (chest counts) and its
  classification.
- `run-lifecycle.md` — run detection across projects, edge cases, the canonical TBH Core
  lifecycle.
- `telemetry-contract.md` — XP/Gold audits, source-priority matrix, reconciliation rules,
  proposed TypeScript contracts.
- `farm-analytics.md` — build fingerprint scope, metric formulas, run classification,
  recommendation contract.
- `license-audit.md` — per-repo licensing and reuse decisions.

## The five findings that most shape TBH Core's architecture

1. **Exact per-run memory telemetry is proven and characterized.** tbh-meter's local 1.2.8
   adaptation (live-validated 13/13 on this machine) reads run boundaries (LogManager events by
   klass pointer, rotation-safe cursor), official clear time, exact per-run combat gold
   (cumulative `GoldEarn[SubKey1]` delta), exact per-hero XP (ACTk-decoded live accumulator with
   curve-bridged level-ups), damage/DPS/mobs (HP-drop polling), party/equipment/stats — all
   strictly read-only (`PROCESS_VM_READ` only). Every metric's failure modes are documented.
2. **The version-fragility problem is the real cost of memory reading.** Offsets shift on many
   updates (documented: PlayerSaveData 5×, Unit base growth), the ACTk encoding changed twice
   with zero offset movement, obfuscated names drift every build, and obfuscated fields create
   FALSE-OK blind spots. tbh-meter's answer — fingerprint (version + PE header) keying
   everything, name-free resolution, static dump diff + a 13-check live gate — works, but its
   offset table is NOT fingerprint-keyed. tbh-companion built a memory reader and reverted it
   within 7 weeks. TBH Core must: fingerprint-key the entire layout, fail safe on unknown
   fingerprints, and treat a green static diff as insufficient.
3. **The save file is a checkpoint oracle, not a telemetry stream.** Autosave ~1–3 min makes
   save deltas window-grade (gold: 0 or ~2× per run — live-measured). But cumulative aggregates
   (`GoldEarn[SubKey1]`, total clears, per-hero exp+level, BoxData) are ideal *validation*
   sources for memory-derived runs, and the whole ES3 container is decoded identically by five
   independent projects (AES-128-CBC + PBKDF2-SHA1/100/16, salt=IV=first 16 bytes, optional
   gzip, inner JSON-in-JSON; password extractable from the local game assets by two proven
   regexes).
4. **Player.log is a one-trick source — chest counts — and even that needs care.**
   `GetBoxCount Success Count : N // ItemKey : K` is a Steam inventory count query; only count
   increases (with burst/flat-count filters) are drops, and the save's BoxData is the authority.
   No run/XP/gold/version events exist in anyone's evidence. Classification: supplementary/
   confirmation-only.
5. **Analytics discipline is settled by prior art.** Rates are SUM(value)/SUM(time) — never mean
   of per-run rates; wallet gold is never per-run gold; run identity is the end timestamp; skip ≠
   vanish; didn't-read ≠ read-zero (ok/err envelopes); measured and estimated never mix without
   a visible label; recommendations gate at 3/10/20 successful valid runs.

## Decisions proposed for TBH Core (detail in the companion docs)

- Source roles: memory = per-run authority while healthy; save = checkpoint + validation oracle;
  Player.log = supplementary chest signal. Proposed states: DISCONNECTED / DETECTING / HEALTHY /
  DEGRADED / UNSUPPORTED_GAME_VERSION / CALIBRATION_FAILED with entry/exit conditions
  (`memory-source.md` §4).
- Run lifecycle: tbh-meter's model (close-on-log-event, abandon-on-switch/reload, pending-close
  grace for the trailing boss chest, discard-on-game-exit, partial-capture flag) adopted as the
  canonical TBH Core lifecycle (`run-lifecycle.md` §3).
- Metric hierarchies: RUN XP = live accumulator → tagged in-memory save fallback → file save for
  validation only; RUN GOLD = live cumulative combat → tagged save cumulative; wallet never
  (`telemetry-contract.md` §1–2).
- Reconciliation: deltas over save-timestamp-anchored windows; tolerance families (flush-lag vs
  oracle) to be **empirically calibrated in Phase B+** — no invented percentage thresholds;
  conflict handling demotes memory health rather than silently preferring either side.
- MVP implementation order confirmed sensible: save source first (Milestone C) needs no offsets
  and immediately provides the validation oracle the memory source (Milestone E) will be gated
  against.

## What Phase A explicitly did NOT do

No parsers, no memory code, no migrations, no UI changes, no new dependencies, no assets copied,
no game files touched; `D:\VSC\tbh-meter` untouched (read-only commands only; upstream verified
via the GitHub API rather than fetching inside it).

## Open questions for the maintainer

1. Ship a fallback ES3 password constant, or extract-at-runtime only? (license-audit §1).
2. Hero levels in the build fingerprint: include (accuracy) vs exclude (TBH-DPS's
   calibration-stability trade-off)? Default proposed: include.
3. Success-rate/variance confidence demotion thresholds (farm-analytics §4) need real-data
   calibration — ship as named constants.
