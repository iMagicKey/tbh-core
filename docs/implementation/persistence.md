# Persistence foundation — implementation notes (Phase C)

SQLite persistence layer for TBH Core. Scope: database lifecycle, deterministic migrations,
save-checkpoint persistence, source-health transition history, schema/repositories for future
sessions/builds/runs, restart-safe deduplication, diagnostics. **No** memory reader, no run
detection, no farm logic, no analytics.

## Technology

Electron/Node built-in **`node:sqlite`** (`DatabaseSync`) — no third-party SQLite package, no
ORM, no migration framework. Runtime verified before implementation:

- Host Node 24.2.0: import + CRUD + pragma OK;
- Electron 44.4.5 (embedded Node 24.21.0, `ELECTRON_RUN_AS_NODE` probe of the actual app
  binary): OK;
- packaged Electron: verified live (see validation below).

Note: `node:sqlite` emits an `ExperimentalWarning` on import (Node marks it experimental);
API surface used here (`DatabaseSync`, `prepare/run/get/all`, `exec`) is stable across the
versions above.

## Location

Production: `<userData>/tbh-core.sqlite3` (Electron `app.getPath('userData')`). Never next to
the game, in the save directory, in the repo, or in temp. Tests use `:memory:` or temp
directories only.

## Architecture

```
SaveCheckpointSource (unchanged, persistence-free)
│  ├── checkpoint events  ──┐
│  └── health events ───────┤   listeners attached BEFORE source.start()
                           ▼
                  PersistenceWiring (guarded writes; DB failure never breaks the source)
                           ▼
                  DatabaseManager (open / pragmas / migrate / status / close)
                           ▼
       repositories: Checkpoint / SourceHealth / Session / Build / Run
                           ▼
                  SQLite (node:sqlite DatabaseSync, WAL)
```

Startup ordering (`src/main/index.ts`): `initPersistence()` (DB opens; failure = degraded,
never a crash) → `createSaveSource()` (created, NOT started) → `wiring.attachTo(source)` →
`source.start()`. The first checkpoint/health event can never be missed. Shutdown
(`will-quit`): `detach → source.stop() → db.close()`.

## Pragmas (configured and verified)

```
PRAGMA foreign_keys = ON    → 1
PRAGMA journal_mode = WAL   → wal  (file db; ':memory:' reports 'memory')
PRAGMA synchronous = NORMAL → 1
PRAGMA busy_timeout = 5000  → 5000
```

Effective values are recorded at open time and exposed in manager status (not renderer DTO).

## Migration system

Ledger: `schema_migrations (version INTEGER PK, name TEXT, applied_at_ms INTEGER)`.
Each unapplied migration runs in its own transaction: `BEGIN → body → INSERT ledger → COMMIT`;
failure rolls back completely and records nothing. Recorded versions never re-run; reopening a
migrated database is a no-op (tested: ledger row count and `applied_at_ms` unchanged).
Migrations are TypeScript modules (`src/persistence/migrations/`), bundled into the app — no
loose `.sql` files. New migrations are appended with the next version number; history is never
rewritten. Current schema version: **1** (`001-initial.ts`).

## Schema (v1)

| Table | Purpose | Primary key | Important indexes | Foreign keys |
| --- | --- | --- | --- | --- |
| `schema_migrations` | migration ledger | version | — | — |
| `save_checkpoints` | normalized SaveCheckpoints (never raw save JSON) | id (autoincrement); `checkpoint_key` UNIQUE | observed_at DESC | — |
| `source_health_events` | meaningful health transitions (suppressed duplicates) | id | (source_kind, recorded_at DESC) | — |
| `sessions` | future farming sessions (no lifecycle logic yet) | id (TEXT) | started_at DESC | — |
| `builds` | future canonical build identity (fingerprint NOT computed yet) | id (TEXT) | — | — |
| `runs` | future completed runs (queryable columns, not opaque JSON) | id (TEXT) | (stage_key, build_id), ended_at DESC, session_id, outcome | session_id → sessions ON DELETE SET NULL; build_id → builds ON DELETE SET NULL |
| `run_heroes` | per-hero run rows | id; UNIQUE(run_id, hero_key, slot) | run_id | run_id → runs ON DELETE CASCADE |

`save_checkpoints` columns: the normalized common/currency/aggregate fields plus four
**versioned JSON snapshots** (`arranged_party_json`, `hero_checkpoint_json`,
`build_context_json`, `box_summary_json`) — each `{version: 1, ...}` so future migrations can
evolve them. NOT stored: raw decrypted save, password, asset bytes, full inventory.

## Checkpoint deduplication

`checkpoint_key = SHA-256(canonical stable source state)`:

```
observedAtMs | observedTimeSource | saveVersion | playTimeSeconds | currentStageKey |
currentStageWave | maxCompletedStage | walletGold | combatGoldEarned | stageClears |
stageFails | arranged-party JSON (canonical)
```

Deliberately excluded: `polledAtMs`, `fileMtimeMs` (machine-local timing — the same save
observed later must dedupe). Enforced by `UNIQUE(checkpoint_key)` +
`INSERT ... ON CONFLICT DO NOTHING`; `insertCheckpoint` returns `{inserted}`. Simulated-restart
test proves one row across connections to the same file.

## Source-health transitions

`recordTransition` writes only when `state` OR `reason_code` differs from the last stored event
for that `source_kind` — consecutive identical snapshots are suppressed (no 5-second poll spam).
`source_kind` is `save` today; `memory`/`player_log` arrive with their phases. Details are
sanitized (`<profile>` masks the user profile path) and never contain secrets.

## Repository APIs

- **CheckpointRepository**: `insertCheckpoint(checkpoint, persistedAtMs) → {inserted}`,
  `count()`, `getLastPersistedAt()`, `hasCheckpoint()`.
- **SourceHealthRepository**: `recordTransition(kind, input, at) → boolean`,
  `recordSaveSourceTransition(status, at)`, `count()`.
- **SessionRepository**: `createSession`, `getSession`, `closeSession`, `getOpenSession`,
  `listSessions(limit)`, `count()`.
- **BuildRepository**: `insertBuild` (idempotent by id), `getBuild` (canonical_json
  byte-exact), `count()`.
- **RunRepository**: `insertRun` (transactional with `run_heroes`; identical duplicate id →
  no-op, conflicting duplicate id → typed `RunConflictError` — never a silent overwrite),
  `getRun`, `listRecentRuns(limit)`, `listRunsByStage`, `listRunsBySession`, `count()`.
  List methods return COMPLETE `RunRecord`s with hydrated hero rows (single batched
  `WHERE run_id IN (...)` query — no N+1); they never claim `RunRecord` while silently
  dropping child data. Canonicalization: `canonicalSlot(slot) = slot ?? -1` is THE one slot
  representation across hashing, insertion, stored rows and record rebuilds (a null-slot
  duplicate can never false-conflict); `heroKey` is REQUIRED (`INTEGER NOT NULL` — a hero
  row without identity is not persisted; capture-quality diagnostics represent the miss).

## Failure behavior

- DB open/migration failure: `DatabaseManager` enters `error`, `getDatabase() === null`,
  `initPersistence()` returns NON-NULL wiring (diagnostics keep exposing the manager error)
  with no repositories — the save source still starts and runs; diagnostics report `error`;
  nothing is falsely reported persisted. A failure AFTER the connection was constructed
  closes that connection (secondary close failures ignored; the ORIGINAL error stays
  authoritative — no lingering handle). Calling `open()` again on the same manager closes
  the previous connection first (documented reopen semantics).
- Write failure mid-run (e.g. schema lost): the guarded listener marks the DB `degraded` and
  leaves the source untouched; subsequent checkpoints attempt writes again (no retry queue,
  per spec). Success after a degraded period restores `healthy`.
- `lastWriteAt` ("last persisted") advances ONLY on actual successful mutations: a checkpoint
  dedupe no-op or a suppressed duplicate health transition is NOT reported as a write.
- Save-source errors (SAVE_NOT_FOUND etc.) are NOT database errors — domains stay independent.

## IPC (narrow)

`db:get-status` → `DatabaseStatusDto` (state, schemaVersion, database **basename**,
lastWriteAt, lastErrorCode/Detail — sanitized/truncated). `db:get-stats` → counts, or **NULL
when they cannot be queried** (DB unavailable/broken) — "unavailable" is rendered distinctly
from real zeros and never looks like "healthy but empty"; the DB STATUS stays the
authoritative error surface (stats expose no exception details). No SQL, no raw rows, no file
paths beyond the basename cross the bridge. Renderer diagnostics card shows Database state /
Schema / Checkpoints / Runs / Sessions / Last persisted (or "Unavailable").

## SQL safety

All statements are prepared with bound parameters; no interpolated user/game strings; no
dynamic ORDER BY exists (fixed clauses); SQL never crosses IPC.

## Type safety (SQLite ↔ JS)

- ms timestamps and gameplay counters (gold/xp/clears): JS numbers ≪ 2^53 — INTEGER/REAL
  columns are exact;
- 64-bit TBH identity (UniqueId, equippedItemIds, box ids): **TEXT** (JSON snapshots) — never
  coerced through Number;
- no 32-bit truncation: node:sqlite returns JS numbers for INTEGER within safe range.

## Performance

Write volume is low (checkpoints every ~1–3 min; health transitions rare; future runs
tens/hour). `DatabaseSync` is synchronous: transactions are short, statements are re-prepared
per call at this volume (acceptable), and no large queries run on main. Documented future
threshold for moving DB work off the Electron main thread: sustained write rates approaching
~1/s or query latencies visibly impacting UI responsiveness (e.g. >50 ms main-thread stalls) —
until then a worker thread would be premature.

## Retention / destructive operations

MVP retains history indefinitely. No automatic deletion, no VACUUM scheduling, no automatic
reset or silent schema recreation: corruption/migration failures surface as errors. Manual
backup/reset tooling may come later.

## Known limitations

- `node:sqlite` is flagged experimental upstream (verified stable for our usage across host
  Node 24.2 / Electron 44's 24.21);
- run/build/session tables are foundations — their writers arrive with MemorySource phases;
- no retention/compaction controls yet (deliberate);
- single-process access assumed (Electron main only; no cross-process DB sharing);
- health-event suppression is per-(state, reason) — a flapping source still writes one row per
  flap (bounded by real transitions).
