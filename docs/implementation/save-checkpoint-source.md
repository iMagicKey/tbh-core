# SaveCheckpointSource — implementation notes (Phase B)

Production read-only source for `SaveFile_Live.es3`. Research basis: `docs/research/save-source.md`,
`docs/research/telemetry-contract.md`. Scope: discovery, password resolution, ES3 decode,
normalization, polling, health, narrow diagnostics IPC. **No** run detection, no reconciliation,
no analytics, no SQLite, no Player.log.

## Data flow

```
SaveFile_Live.es3 (LocalLow)            game install (Steam, read-only)
        │                                        │
        ▼                                        ▼
  discovery.ts                            discovery.ts (Steam roots →
  (default | custom override)              libraryfolders.vdf → appmanifest_3678970)
        │                                        │
        └──────────────► password.ts ◄───────────┘
                          resolution: manual(env) → game-asset extraction
                          (two structural patterns; value never logged/sent)
                                   │
                                   ▼
                          es3.ts (node:crypto/zlib only)
                          IV[16] + AES-128-CBC; PBKDF2-SHA1(100,16,salt=IV);
                          gzip magic → gunzip; outer JSON → PlayerSaveData.value → inner JSON
                          (json-safe.ts: bare 16+-digit literals parsed as exact strings)
                                   │
                                   ▼
                          normalize.ts → SaveCheckpoint (observedAt = lastSavedTime ticks,
                          fileMtime flagged fallback; unknown fields ignored; null ≠ 0)
                                   │
                                   ▼
                SaveCheckpointSource.ts (poll 5 s on mtime/size change;
                mid-write retry; last-good retention; health machine)
                                   │
                                   ▼
                main/save-source.ts → IPC (status/summary/refresh/select) → preload →
                renderer diagnostics card (Live page) + Save pill
```

## Save discovery

1. `customSavePath` from settings (user-picked via dialog; may be a `.bak` if explicitly chosen);
2. default: `%USERPROFILE%\AppData\LocalLow\TesseractStudio\TaskbarHero\SaveFile_Live.es3`
   (built from env/`os.homedir()`, not string concatenation of assumed drives).

No disk-wide scanning. Backup files are never auto-selected.

## Game install discovery (for password extraction only)

Order: `customGamePath` (settings) → common Steam roots (`ProgramFiles(x86)\Steam`,
`ProgramFiles\Steam`, `C:\Steam`, `C:\SteamLibrary`) → `libraryfolders.vdf` `"path"` entries →
`steamapps/appmanifest_3678970.acf` `"installdir"` → case-insensitive common-name probe
(`TaskbarHero`/`TaskBarHero`/`Task Bar Hero`). A candidate is accepted when it contains a
`TaskBarHero*_Data` directory. No registry, no shell execution, no drive crawling.
Failure is non-fatal when a manual password exists; otherwise surfaced as
`GAME_INSTALL_NOT_FOUND`.

## Password resolution (Phase A product decision, implemented)

1. `TBH_CORE_ES3_PASSWORD` env var — session-only manual override (never persisted, never
   crosses IPC, never logged);
2. automatic extraction from the user's own install (`<install>/*_Data/resources.assets`,
   `sharedassets0.assets`, `globalgamemanagers.assets`) — **asset content is read ASYNC**
   (`node:fs/promises`): these files can be large and extraction runs in Electron main;
   small directory existence/list probes stay synchronous:
   - pattern A (tbh-codown): `SaveFile_Live.es3` marker → NUL separators → `[A-Za-z0-9]{8,64}`;
   - pattern B (giba): `ES3Defaults` within 80 bytes before the marker → non-printable
     separator → printable `{8,40}` run (path-like captures rejected);
3. failure: typed diagnostics (`GAME_INSTALL_NOT_FOUND` / `PASSWORD_NOT_FOUND` /
   `GAME_ASSET_UNREADABLE`).

**No historical game password is compiled in.** Provenance (`manual` / `game_asset`) is the only
password-related data that ever reaches the renderer. After a `PASSWORD_INVALID` decrypt with the
`game_asset` provenance the source drops the cached password and re-extracts on the next poll
(survives in-game password rotation); with `manual` it is a hard error (user must fix the env).

## ES3 decoder

- crypto: `node:crypto` only — `pbkdf2Sync(password, IV, 100, 16, 'sha1')`,
  `createDecipheriv('aes-128-cbc', key, iv)`;
- bad decrypt/padding → `PASSWORD_INVALID` (the overwhelmingly common cause is a wrong key);
  block-misaligned payload after the IV → transient `MID_WRITE`;
- gzip magic `1F 8B` on the plaintext → `gunzipSync`, else plain;
- outer JSON → `PlayerSaveData.value` (nested JSON string) → inner JSON;
- malformed at any layer → `PARSE_FAILED`; **never** an empty/zero-filled checkpoint.

## 64-bit identity (non-negotiable)

`UniqueId`, `ItemUniqueId`, `equippedItemIds`, `BoxUniqueId`, `RegisterID` (numeric form) are
64-bit values beyond `Number.MAX_SAFE_INTEGER`. `json-safe.ts` quotes **bare 16+-digit integer
literals in the raw JSON text before `JSON.parse`** (string-literal-aware scanner, so digits
inside strings are untouched; floats/scientific untouched; 15-digit ints stay Numbers). Exact
string identity round-trips end-to-end (tested with `2^53+1` and `2^64-1`).

## Checkpoint contract (`src/sources/save/types.ts`)

`observedAtMs` (+`observedTimeSource: 'lastSavedTime' | 'fileMtime'`), `fileMtimeMs`,
`polledAtMs`, `sourcePath`, `saveVersion`; common (`lastSavedTimeMs`, `playTimeSeconds`,
`currentStageKey`, `currentStageWave`, `maxCompletedStage`); party (`arrangedHeroKeys`,
`arrangedPetKey`); currencies (`walletGold` = Key 100001, full list); heroes (key/level/xp/
unlocked/equipped ids as strings/skill keys); items (exact `uniqueId`, `itemKey`, `registerId`,
enchant identity); `skillTree`; `runes`; aggregates (`combatGoldEarned` = Type 2/SubKey 1,
`stageClears`/`stageFails`, raw list); **boxes as INDEX-ALIGNED entries**
(`boxes.entries[i] = { type, uniqueId, quantity }` by original parallel-array position,
malformed slots `null` — never compacted, so quantity/identity cannot shift; critical for
future Player.log reconciliation).

Parse rules: unknown fields ignored; number-or-numeric-string tolerated (incl. comma-decimal,
observed on `HeroExp`); malformed required values → `null`, never silent 0.

## Source health

States: `discovering`, `healthy`, `stale`, `degraded`, `error`, `disconnected`.
Reason codes: `SAVE_NOT_FOUND`, `SAVE_FOUND`, `SAVE_UNREADABLE`, `GAME_INSTALL_NOT_FOUND`,
`PASSWORD_NOT_FOUND`, `PASSWORD_INVALID`, `GAME_ASSET_UNREADABLE`, `DECRYPT_FAILED`,
`MID_WRITE`, `PARSE_FAILED`, `STALE_CHECKPOINT`, `STOPPED`.

Codes are machine-readable; localization lives in the renderer. The source retains
`lastGoodCheckpoint`, `lastSuccessfulReadAt`, `lastAttemptAt`, `lastError` — transient failures
never erase known-good state.

## Polling / recovery

- poll every `SAVE_POLL_INTERVAL_MS = 5000` (config constant); decode only when
  `mtimeMs:size` signature changed (never re-decode the same content);
- **stable read** (`readStableSave`): stat → read → re-stat, verifying size/mtime did not move
  AND the encrypted payload is block-aligned (IV + ≥1 full block, `payload % 16 === 0`);
- **MID_WRITE retries re-read, never re-decode**: on a torn/unstable read the source sleeps
  (`MID_WRITE_RETRY_DELAY_MS = 150`), then RE-STATS and RE-READS the file (up to
  `MID_WRITE_RETRIES = 3` fresh attempts) — a save write completing mid-poll recovers in the
  SAME poll cycle without waiting for the next interval; stale torn bytes are never re-decoded;
- budget exhausted → `degraded` + `MID_WRITE`, last-good checkpoint retained, signature NOT
  advanced (the next normal poll retries; no busy loop);
- unexpected (non-typed) failures hit a final `SOURCE_INTERNAL_ERROR` net: last good kept,
  source stays alive, next poll scheduled — Electron main never receives an unhandled rejection.

## Freshness (staleness) semantics

Checkpoint freshness is judged by the checkpoint's **SOURCE timestamp**
(`observedAtMs` = `commonSaveData.lastSavedTime` ticks, with the documented `fileMtime`
fallback) — never by poll time or `lastSuccessfulReadAt` (the latter is diagnostics only).
Staleness is evaluated immediately after every successful decode and on every unchanged-file
poll: a successfully decoded but old checkpoint yields `state = stale` with a valid
`lastGoodCheckpoint` (not an error). `STALE_AFTER_MS = 10 min` default (autosave cadence
~1–3 min per Phase A).

## IPC (narrow, typed)

`save:get-status` (SaveSourceStatus), `save:get-summary` (SaveSummaryDto),
`save:refresh`, `save:select-file`, `save:select-game-dir` (dialogs; persist path overrides).
No generic fs access, no raw save JSON, no password across the bridge. `contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true` unchanged.

## Settings / overrides

`userData/settings.json` (atomic tmp+rename) stores `customSavePath`, `customGamePath`.
The file is user-editable local JSON and is **never trusted by type**: runtime normalization
accepts only non-empty trimmed strings for the two known keys; arrays, numbers, objects,
booleans, null, whitespace-only paths and unknown keys are ignored; malformed JSON safely
yields empty settings (never an unhandled rejection in the polling source).
The ES3 password is deliberately NOT persisted: plaintext secrets in local JSON are
undesirable — the manual override is session-only via env var (documented limitation; a secure
OS credential store could be added later without touching the parser — password resolution is a
provider chain).

## Live validation status

Reliability pass (2026-09-24): live read-only regression re-run after the refactor — discovery,
async password extraction, decrypt and checkpoint fields all confirmed on the installed
TBH 1.2.8 (sanitized results in the PR). Initial Phase B live validation: TESTED (see the
Phase B PR/handoff). No real save data, paths, or passwords are committed.

## Lifecycle

`app.on('will-quit')` stops the source (clean timer teardown). `getSaveSource()` returns
`SaveCheckpointSource | null` — no unsafe type assertion.

## Known limitations

- manual password override is env-var-only and session-scoped (no secure store yet);
- game discovery probes fixed Steam roots (no registry read) — exotic Steam locations need the
  manual override;
- `PASSWORD_INVALID` technically also covers rare non-password corruption;
- `stale` uses a fixed 10-minute threshold (not yet calibrated per-install);
- no fs.watch (deliberate: Phase A found mtime polling more robust against the game's atomic
  rewrites); a fast save right at poll time is covered by the same-cycle re-read retry path;
- password-related `error` states only re-resolve when the file changes or on manual refresh
  (the game will eventually save; the Refresh button forces it).
