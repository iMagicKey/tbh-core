# Phase A research — license audit of reference repositories

TBH Core is MIT. A repo's software license does NOT grant permission to redistribute Task Bar
Hero's copyrighted assets or data; where a reference repo bundles game-derived material, that
material is off-limits regardless of the repo's license. Audit date 2026-09-24; findings verified
from each repo's LICENSE/manifests by this phase's source audits.

| Repository | License | Copy code? | Attribution requirement | Copy data? | Copy game assets? | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| mad-labs-org/tbh-meter (incl. local updated clone) | MIT (Copyright (c) 2026 Mad Labs), LICENSE file present | **YES, permitted** (MIT↔MIT compatible) — but Phase A forbids copying; reimplement + attribute when Phase B borrows algorithms (offset methodology, LogScanCursor idea, fallback chains) | standard MIT notice | offset values / calibration indices are **facts discovered from the game binary**, not tbh-meter's copyrighted expression — reuse of factual values is defensible; the *code expressing them* is MIT | `.github/assets/meter-hero.png` is the project's own art; no game assets bundled | cleanest reuse candidate; the local 1.2.8 adaptation is uncommitted work of iMagicKey |
| lucasfevi/tbh-companion | **MIT declared only in `app/package.json`; NO LICENSE file exists** | NO — legally all-rights-reserved until the author adds one; study behavior only (the reverted memory-reader commit d95c8b6 is readable in history) | none formally stated | NO — 12 JSON catalogs are game-extracted via tbh-data; 337 item-icon PNGs are game art | NO | documented RE (docs/SAVE_FORMAT.md) is knowledge, not code — facts are fine to use; do not lift their TS |
| Rupelio/TBH-Optimizer | MIT (LICENSE file), **with an explicit note that game data/assets are NOT covered and remain property of Nugem/Tesseract Studio** | YES, permitted (Go; MIT↔MIT) | standard MIT notice | NO — redistributes 766 sprites + large extracted JSONs (items/chest_drops/runes/…) — explicitly out of license scope | NO | the ES3 password is deliberately absent (CI secret) — a posture TBH Core should consider |
| WarmBed/TBH-DPS-dashboard | MIT (LICENSE file) | YES for the pure logic (DpsTracker, FarmPlanner, RunRetention…) if we ever port it — **but its architecture (BepInEx injection) is forbidden for TBH Core and must not be reproduced** | standard MIT notice | embedded wiki datasets (item names/meta, farm_stages…) are game-derived — treat as NOT redistributable | NO — screenshots of game UI in `image/`; icons fetched from the wiki at runtime, not bundled | the ES3 password is hardcoded in source (see below) |
| shigake/tbh-copilot | MIT (LICENSE) covering **code only**; addendum states bundled assets/data remain their owners' property (interoperability claim + takedown offer) | YES, permitted (JS engine is clean & tested) | standard MIT notice + their game-data carve-out confirms it's NOT licensed for reuse | NO — 659 wiki-scraped PNGs + 1.97 MB gamedata bundle; **`engine/fixtures/save_fixture.json` is a full decrypted real save committed for CI** — never copy that practice or file | NO | calibration-ladder and sanity-window ideas are knowledge, freely reusable |
| feroddev/tbh-codown | **NO LICENSE AT ALL** | NO — all rights reserved; behavior study only | n/a | NO — wiki-scraped catalogs (stages/chests with drop %); `stardew_valley.mp3` is third-party audio; a 22 MB self-build zip | NO | hardcodes the ES3 password in source + README |
| lezards/giba-steam-market | MIT (LICENSE, "EuSouOGiba"), with a PT disclaimer (independent project; reads local data + public endpoints only) | YES, permitted (zero-dep Node) | standard MIT notice | NO — `tbh-itemtable.seed.json` (5,944 rows extracted from `sharedassets0.assets`) + localized names bundle are game-derived data redistributed under an MIT the author arguably can't grant for that content | NO — no binary assets; IconPath strings only | hardcodes the ES3 password as fallback |

## Cross-cutting decisions TBH Core needs (RECOMMENDATION)

1. **The ES3 password (`emuMqG3bLYJ938ZDCfieWJ`)** — community-published (taskbarhero.wiki Save
   Inspector), present in 5 of 7 repos, extractable at runtime from the local game install by two
   proven methods (see save-source.md §2).
   **DECIDED (maintainers, 2026-09-24):** TBH Core MVP does not ship the constant. Resolution
   order: user override → automatic extraction from the user's own install → clear diagnostic +
   manual override on failure. No silent compiled-historical fallback. See `save-source.md` §6.
2. **Game-derived data** (item tables, stage catalogs, drop rates, level curve, icons): the
   extraction *techniques* (UnityPy/latin1-slicing/regex from sharedassets; wiki endpoints) are
   knowledge. Redistributing extracted tables/icons in TBH Core: avoid for MVP (not needed — the
   save + memory give the needed data); if a catalog becomes necessary (names/icons), generate it
   locally at runtime from the user's own install, or document per-item licensing first.
   The **level curve** and **offset values** are functional facts needed for interoperability —
   defensible to embed with provenance notes.
3. **Code reuse**: only from MIT-with-LICENSE repos (tbh-meter, TBH-Optimizer, TBH-DPS pure
   logic, tbh-copilot, giba) and only with attribution + a recorded decision; Phase A copies
   nothing regardless. tbh-companion (no LICENSE file) and tbh-codown (no license) are
   study-only.
4. **Never redistribute**: decrypted save fixtures (tbh-copilot's committed real save is exactly
   what TBH Core must not do — use synthetic fixtures), game sprites/icons, wiki-scraped bulk
   data, third-party audio.
