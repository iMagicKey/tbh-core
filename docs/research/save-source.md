# Phase A research — SaveFile_Live.es3 source audit

Cross-repository audit of save handling. Contributors with code-level evidence:
local **tbh-meter** (in-memory save structures — not the file), **tbh-companion** (Electron/TS,
primary file-based source), **TBH-Optimizer** (Go, save-watch telemetry), **tbh-copilot**
(browser Web Crypto), **giba-steam-market** (Node, stash valuation), **tbh-codown** (Python,
stage + box aggregates), **TBH-DPS-dashboard** (in-process C#). All decrypt parameters below
agree across five independent implementations — treat as established FACT.

## 1. File discovery

| Aspect | Evidence |
| --- | --- |
| Default path | `%USERPROFILE%\AppData\LocalLow\TesseractStudio\TaskbarHero\SaveFile_Live.es3` — hardcoded by tbh-companion (`app/src/main/config.ts DEFAULT_SAVE`), TBH-Optimizer (`internal/decrypt.go SavePath`), giba-steam-market (`tbh-save.mjs`), tbh-codown (also scans every LocalLow company dir for a `TaskbarHero` child; adds macOS `~/Library/Application Support/...` and Linux `~/.config/unity3d/...` paths). Unity `Application.persistentDataPath` semantics — the save is NOT inside the Steam library. |
| Steam-library discovery | Not needed for the save itself. The **game install** (for password extraction) is discovered by: giba (brute probe C–H × common Steam roots), tbh-codown (registry-free: `ProgramFiles(x86)`/`ProgramFiles` → Steam → parse `libraryfolders.vdf` with a `"path"` regex), TBH-Optimizer (registry `HKCU\Software\Valve\Steam\SteamPath`, fallback `HKLM\SOFTWARE\WOW6432Node\Valve\Steam\InstallPath`). Steam AppID: **3678970**. |
| Manual override | tbh-companion config `savePath` (with `%VAR%`/`~` expansion); tbh-copilot: user picks the file (File System Access API). |
| Adjacent files | `Player.log` in the same dir; backups `SaveFile_Live_<n>.es3.bak`, `SaveFile_Live.es3.test_backup`, `SaveFile_Live.es3.tmp` (tbh-codown enumerates and mtime-ranks candidates); `Player.prev.log`; `steam_autocloud.vdf`. |

## 2. Encryption / container format (five implementations agree)

```
file := IV[16] || AES-128-CBC-PKCS7(ciphertext)
key  := PBKDF2-HMAC-SHA1(password, salt = IV, iterations = 100, dkLen = 16)
plaintext := JSON  (if starts with gzip magic 1f 8b → gunzip first — giba handles the
                   compression layer; others note no compression observed on current saves)
outer := { "PlayerSaveData": { "__type": ..., "value": "<inner JSON string>" }, ... }
inner := JSON string — the actual save; re-parse (note: ES3 entries are {__type, value}
         with value often a doubly-encoded JSON string; unwrap recursively)
```

- Password (current game builds, community-published on taskbarhero.wiki's Save Inspector):
  `emuMqG3bLYJ938ZDCfieWJ` — hardcoded in tbh-companion, tbh-copilot, giba-steam-market,
  tbh-codown, TBH-DPS-dashboard; TBH-Optimizer deliberately injects it as a CI secret
  (`-X optimizer/internal.es3Password=${{ secrets.TBH_ES3_KEY }}`).
- **Password auto-extraction** (the update-proof method, two implementations):
  the ES3 password sits in **plaintext in the game's Unity assets** adjacent to the
  `SaveFile_Live.es3` filename constant:
  - tbh-codown (`game_paths.py`): reads `TaskBarHero_Data/resources.assets`, finds the byte
    marker `SaveFile_Live.es3`, regex over the next ~120 bytes:
    `SaveFile_Live\.es3\x00([A-Za-z0-9]{8,64})`;
  - giba (`tbh-save.mjs`): reads `resources.assets`/`sharedassets0.assets`/
    `globalgamemanagers.assets` as latin1, regex
    `/ES3Defaults[\s\S]{0,80}?SaveFile_Live\.es3[^\x21-\x7e]+([\x21-\x7e]{8,40})/`.
  Both keep a hardcoded fallback + config override, and flag provenance
  (tbh-codown's `es3_password_is_default` warning).
- Password rotation: the developer can change it in a game update (tbh-companion README +
  error message; giba comment "à prova de updates" via auto-extraction). A wrong password yields
  a padding/decrypt error → surface as a clean "wrong password / rotated key" diagnostic, not as
  empty data.
- Precision trap (FACT, tbh-companion + tbh-copilot): ids such as `equippedItemIds` /
  `UniqueId` are 64-bit and exceed 2^53 — JSON.parse into JS numbers MANGLES them (tbh-companion
  measured ~6 id collisions in 185 items). tbh-copilot regex-quotes bare 16+-digit integers
  before parsing; tbh-companion refuses to join slot→instance by parsed id and reads
  `itemSaveDatas` directly. TBH Core must do the same (parse ids as strings or BigInt).

## 3. Reading / watching / robustness patterns

| Concern | Best-evidence practice |
| --- | --- |
| Watch mechanism | **Poll mtime, don't fs.watch** — the game rewrites the save atomically (replace), which breaks naive watchers; tbh-companion polls `statSync().mtimeMs` every 5 s deliberately. TBH-Optimizer instead uses fsnotify on the save **directory** with an event filter (only Write/Create with basename exactly `SaveFile_Live.es3`) + 250 ms debounce — directory-watch + atomic-rename-aware works too. |
| Mid-write / partial file | tbh-companion: ciphertext length % 16 != 0 → "save may be mid-write" transient error; **do not advance lastMtime** so the next poll retries; 4×50 ms read retries. TBH-Optimizer: 10×10 ms retry. |
| Locked file (Windows) | tbh-codown: `PermissionError` → copy to `%TEMP%`, read the copy, delete. |
| Corruption | Decrypt/parse errors surface as typed errors (tbh-companion `Es3Error`/`SaveReadError` shown in a status bar, tracking continues on last-good snapshot); never silently emit zeros. |
| Duplicate slot refs | giba: multiple inventory/stash positions can reference the SAME UniqueId (real game quirk — dedupe by UniqueId or items multiply-count). |
| Rate math keying | All rate math keyed to **save mtime / playTime**, not wall clock of the poll (tbh-companion design; rates recomputed only when the value changed so they don't decay between writes). |
| Save cadence | Autosave roughly every ~1–3 min and on events (TBH-Optimizer comment: "a cada ~3 min ou em eventos"; tbh-companion ~1–2 min). This quantization is THE fundamental limit of save-only telemetry. |
| Version field | `commonSaveData.version` is present in the save (tbh-copilot displays it and drift-checks against bundled data). |

## 4. Field matrix (data useful to TBH Core)

`inner` refers to the decoded inner save JSON. Field names are the game's own (misspellings
included: `currenySaveDatas`, `equippedSKillKey`).

| Field | Save location (inner) | Type | Reliability | Update behavior | MVP use |
| --- | --- | --- | --- | --- | --- |
| Save format version | `commonSaveData.version` | string | high | per save | compatibility gating + drift badge |
| Last-saved timestamp | `commonSaveData.lastSavedTime` | .NET ticks (÷1e7 − 62135596800 → unix s) | high | per save | staleness checks, reconciliation windows |
| Play time | `commonSaveData.playTime` (float seconds; tbh-meter reads it live at `CommonSaveData.PLAYTIME` @0x20) | float | high | per save | session anchoring; dedup no-op saves (TBH-Optimizer discards saves with unchanged playTime) |
| Current stage | `commonSaveData.currentStageKey` (+`currentStageWave`) | int | medium | per save; lags the live switch (in-memory snapshot can lag ≤1 autosave cycle — tbh-meter 1.2.8 note) | stage seed/fallback; key encodes `difficulty*1000 + act*100 + stage` (tbh-codown codec; maxCompletedStage also present) |
| Max completed stage | `commonSaveData.maxCompletedStage` | int | high | per save | progression display |
| Arranged party | `commonSaveData.arrangedHeroKey[]`, `ArrangedPetKey` | int[] | high | per save | party context (NOT proof of deployment — the live HeroList is; tbh-meter "save lists all 6 when playing solo") |
| Gold wallet | `currenySaveDatas[]` entry `Key == 100001` → `Quantity` (long) | long | high (value) / low (as per-run delta) | per save | wallet display; reconciliation vs combat-gold aggregate; **never per-run gold** (includes sales/idle; flush quantization) |
| Heroes | `heroSaveDatas[]`: `heroKey`, `HeroLevel`, `HeroExp` (double), `IsUnLock`, `AbilityPoint`, `equippedItemIds[10]` (ulong[]), `equippedSKillKey` (int[]) | arrays | high | per save | hero levels/party sheet; XP **checkpoint** (per-hero HeroExp resets on level-up — reconstruction needs the curve, and at cap never resets = phantom) |
| Items | `itemSaveDatas[]`: `UniqueId`, `ItemKey`, `EnchantData[{StatModKey,StatType,Tier,Value,RecipeType,ModType}]`, `EnchantCount`, `IsChaotic`, `IsBlocked`, (1.2.8+: `RegisterID`) | arrays | high | per save | equipment identity/mods for build fingerprint; market valuation |
| Inventory/stash/trading stash | `inventorySaveDatas`/`stashSaveDatas`/`tradingStashSaveDatas`: `{Index, ItemUniqueId}` slot grids (49 slots/tab, 7 tabs stash; `ItemUniqueId==0` = empty; duplicates possible) | arrays | high | per save | inventory views (post-MVP), drop detection via new UniqueIds (TBH-Optimizer `internal/drops.go`) |
| Skill tree | `attributeSaveDatas[]`: `{Key, Level}` — key `heroKey*1000 + node`; `key%10 ∈ {3,4}` = active-skill columns carrying real skill level (TBH-DPS finding) | arrays | high | per save | skills for build fingerprint |
| Runes | `RuneSaveData[]` / `runeSaveDatas[]`: `{RuneKey/Key, Level}` | arrays | high | per save | build fingerprint (account-wide) |
| Pets | `PetSaveData[]`: `{PetKey, IsUnlock}` (1.2.8 inserted into the in-memory layout as `PetSaveData@0x80`) | array | high | per save | post-MVP |
| Cumulative aggregates | `aggregateSaveDatas[]`: `{Type, SubKey, Value}` — **Type=2 GoldEarn** (SubKey 0=TOTAL rollup, 1=COMBAT, 2/3=sale/idle/quest — tbh-meter live-cracked semantics), **Type=15 PlayTime**, Type=13/14 StageClear/StageFail counters, per-monster kill counts (tbh-companion pet progress) | arrays | **medium-high** (stale, flush-lagged) | per save (~1–3 min) | the reconciliation ORACLE: cumulative combat gold validates memory-derived run gold over a window; total clears cross-check run counting |
| Chest boxes owned | `BoxData`: parallel arrays `BoxTypes[]` (1=boss, 0=normal), `BoxUniqueId[]`, `BoxQuantity[]`; plus `BoxBucketGetBoxList`/`UseBoxList` ledgers | arrays | high | per save | chest-drop confirmation vs Player.log events (tbh-codown pattern: log = fast signal, save = authoritative count) |
| Enchant/alchemy pending | `pendingEnchantList`, `backendPostList`, `pendingItemRestorationList`, `mailSaveDatas`, cube fields (1.2.8) | arrays | high | per save | none (MVP); listed because their INSERTIONS are what shift the other offsets in memory — the file-side keys are stable |

Schema-drift note (FACT): the save's JSON **keys are not obfuscated** and change far more slowly
than the in-memory layout (TBH-DPS: "type names, enum names, and save JSON keys are NOT
obfuscated — those are the anchors"); still, features insert lists (documented memory-side
inserts 1.00.12/1.00.19/1.00.23/1.00.27/1.2.8 have file-side counterparts like
`pendingItemRestorationList`, `mailSaveDatas`, cube fields). TBH Core's parser must ignore
unknown keys (all reference parsers do) and must NOT fail on type drift (`FlexFloat` pattern:
`HeroExp` sometimes serializes as a string, even comma-decimal — TBH-Optimizer).

## 5. Which save fields can validate memory-derived completed runs

(RECOMMENDATION, grounded in the above)

1. **Cumulative combat gold** (`GoldEarn[SubKey 1]`): over any window, the save's cumulative
   minus the sum of memory-derived run golds must be ≈ 0 modulo the flush lag. This is
   tbh-meter's own gold resolution oracle (`combat_gold_klass_ok` analog) and the strongest
   cross-check available.
2. **Per-hero HeroExp + HeroLevel** (with curve reconstruction): the level/exp oracle for the
   ACTk cipher decode (validate_live's `xp-live`: decoded level == save level ±1, xp ≥ 1 or == 0).
3. **Total clears aggregate** (Type=13/15 family): run-count reconciliation over a session.
4. **currentStageKey / playTime / lastSavedTime**: window anchoring for staleness and
   "which stage was really played" cross-checks.
5. **BoxData quantities**: chest-drop reconciliation against run `drops`.

## 6. Safest implementation strategy for TBH Core (RECOMMENDATION — not implemented here)

- Read-only open; never write/rename the save or its backups; copy-on-read for locked files.
- Poll mtime (default ~5 s) + read only on change; directory-watch optional later; treat
  `%16 != 0` ciphertext and decrypt/parse failures as transient mid-write (retry, keep
  last-good).
- ES3 decode exactly as §2; password resolution order: user config → auto-extract from local
  game assets (both proven regexes above) → known-value fallback, with provenance surfaced.
  Decision needed from maintainers on shipping the fallback constant (see license-audit).
- Parse ids as strings (2^53 trap); ignore unknown keys; tolerate number-or-string floats.
- Emit `SaveCheckpoint` observations with `observedAt = lastSavedTime` (NOT wall clock),
  provenance `SAVE`, confidence `checkpoint`; never present a checkpoint delta as a measured run.
- Validate against fixtures (synthetic saves shaped like §4; tbh-companion's synthetic-fixture
  approach — do NOT commit a real decrypted save).
