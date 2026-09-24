# Phase A research — reference-project matrix

One row per studied repository (source-level audits, 2026-09-24). "Local" = the user-maintained
updated clone. Deeper per-topic detail lives in the sibling documents.

| | mad-labs-org/tbh-meter (**local updated clone**) | lucasfevi/tbh-companion | Rupelio/TBH-Optimizer | WarmBed/TBH-DPS-dashboard | shigake/tbh-copilot | feroddev/tbh-codown | lezards/giba-steam-market |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **What it is** | Per-run memory meter (Python reader + Electron app) | Save+log session tracker (Electron/TS monorepo) | Save-watch farm optimizer (Go + embedded Vue web) | In-process DPS meter & farm planner (**BepInEx mod**) | Browser save-decrypt farm/rune optimizer (static page) | Chest-drop & cooldown monitor (Python customtkinter + web) | Save-based stash Steam-market valuation (zero-dep Node) |
| **Stack** | Python (0 deps, ctypes) + Electron | TS, Electron 42 + React 19, Vitest | Go 1.26, fsnotify, embedded web | C# / BepInEx 6 + Harmony + Il2CppInterop | Vanilla JS + Web Crypto, GitHub Pages | Python, es3-modifier (PyPI), customtkinter | Node ≥20, zero npm deps |
| **Memory** | ✅ read-only RPM; IL2CPP index/structure resolution; offsets bible; calib seeds per fingerprint | ⚠️ built (koffi FFI in utilityProcess, version-keyed offsets 1.00.21) then **reverted** within 7 weeks | ❌ none | ⚠️ **in-process hooks/reflection** (forbidden architecture for TBH Core) | ❌ none | ❌ none | ❌ none |
| **Save .es3** | in-memory save structures (PSD/CSD) | ✅ file: poll mtime 5 s, ES3 decrypt, mid-write detection | ✅ file: fsnotify dir-watch + debounce + retry | ✅ file (in-process persistentDataPath) | ✅ file (user-picked, Web Crypto) | ✅ file (es3-modifier lib; stage + BoxData only) | ✅ file (full decrypt + stash parse) |
| **Player.log** | ❌ | ✅ one regex (GetBoxCount) | ❌ (filtered as watcher noise) | ❌ (uses in-process LogManager instead) | ❌ | ✅✅ the deepest (count-increase inference, burst filters, dedup) | ❌ |
| **Run concept** | ✅ full lifecycle, explicit success/fail/abandon, official clear time | ❌ continuous session (XP deltas) | ⚠️ save-window "rounds" with heavy rejection heuristics | ⚠️ stage attempts via EStageState, no outcome distinction | ⚠️ clear-rate from cumulative counter | ❌ chest drops only | ❌ none |
| **XP** | ✅ live ACTk-decoded accumulator (exact, level-up bridged) + save fallback | save HeroExp deltas (positive-only, level-up approximated) | save HeroExp deltas; level-up windows discarded; retention model | live cumulative accessor (value-matched) | save cumulative party XP + rate sampling | ❌ | ❌ |
| **Gold** | ✅ live cumulative combat GoldEarn[SubKey1] (exact) + save fallback; wallet never | wallet only (positive deltas) | wallet only + spend-recovery & spike filters | wallet from save (quantized; Σ(w)/Σ(t) averaging fix) | wallet + modeled stage gold | ❌ | Steam market value (not game gold) |
| **Version/compat** | ✅✅ fingerprint (ver+PE), fp-keyed calib, static diff + live 13-check gate, name-free resolution | ❌ none shipped (reverted reader had version-keyed offsets → degraded mode) | ❌ none (fail-silent stall) | structural resolution, self-check logs, graceful degradation | save version badge + CI drift asserts | ❌ none (password-provenance warning only) | ❌ none (re-extract on demand) |
| **Best-farm logic** | raw records + app analytics | rolling/session rates | measured×modeled multipliers, least-squares time model, advisor | FarmPlanner: calibration multipliers, 2-part clear-time fit, retention curve, Real/Est. split | calibration ladder (measured replaces model, calSource label) | wiki drop% presets | n/a |
| **License** | MIT (file) | **MIT in package.json only, no LICENSE file** | MIT + game-data carve-out | MIT (injection ToS disclaimer) | MIT + game-data carve-out | **none** | MIT + PT disclaimer |
| **Activity** | active upstream (#109 = 1.00.28) + local 1.2.8 WIP | dormant ~5 wk (28 releases to v1.18.1) | dormant ~3 mo | dormant ~2 mo | dormant ~3 mo | abandoned ~3 mo (1-author, 1-wk burst) | dormant ~3 mo |
| **Key lesson for TBH Core** | the whole read-only memory methodology; per-run exactness; honest degradation | mtime-keyed rates; **memory-reader maintenance cost is real** (they reverted it); mid-write handling; uid 2^53 trap | save-only telemetry quantization and every heuristic it forces | EStageState enum; FarmPlanner measured/estimated provenance split; ACTk in-process handling | ES3 in-browser recipe; calibration ladder; sanity windows | GetBoxCount semantics + chest dedup machinery; password extraction from resources.assets | complete ES3 file recipe + Steam market patterns |

Cross-repository consensus points (each independently implemented ≥3 times — high confidence):

- ES3 container: IV[16]‖AES-128-CBC, PBKDF2-SHA1(100,16) key, salt=IV; optional gzip;
  `PlayerSaveData.value` inner-JSON; gold key 100001.
- Save path: LocalLow\TesseractStudio\TaskbarHero (no Steam-library involvement).
- Player.log chest pattern: `GetBoxCount Success Count : N // ItemKey : K` = inventory count
  query, not a drop.
- Save autosave cadence ~1–3 min → wallet/save deltas are window-grade, never per-run grade.
- ACTk ObscuredTypes protect sensitive values; the read-only decode (int: `(h−k)^k`;
  float/double: key XOR byte-shuffled hidden) is reimplementable without the game's code.
- Game re-obfuscates private names per update; stable anchors are: save JSON keys, enums, type
  shapes, PE fingerprint, IL2CPP metadata indices (per-build).
