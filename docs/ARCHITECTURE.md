# Architecture

## Target data flow

```text
Task Bar Hero
    |
    +-- SaveFile_Live.es3 --> SaveCheckpointSource --+
    |                                                |
    +-- process memory ----> MemoryRunSource --------+--> Reconciler --> Persistence --> Analytics --> UI
    |                                                |
    +-- Player.log ---------> PlayerLogSource -------+
```

## Data-source roles

### MemoryRunSource

Intended authority for exact, per-run live telemetry while the reader is healthy:

- run start/end;
- stage and difficulty;
- elapsed time;
- run outcome;
- XP and combat-gold deltas;
- DPS/damage/mobs;
- relevant live party state.

Memory access must remain strictly read-only.

### SaveCheckpointSource

Stable checkpoint source for persistent state:

- heroes/levels/XP;
- currencies;
- party/equipment;
- progression;
- inventory and other persisted state when needed.

The save is a checkpoint, not a high-frequency telemetry stream.

### PlayerLogSource

Supplementary event source for events that are reliable in Unity logs, such as chest-related events and cross-checks.

## Provenance

Every important metric should eventually carry:

- `source`;
- `timestamp`;
- `confidence`;
- game/app/reader compatibility metadata where relevant.

Valid confidence concepts include `exact`, `verified`, `checkpoint`, `derived`, `estimated`, `conflict`, and `unavailable`.

## UI

One `BrowserWindow` is the default architecture.

Primary sections:

- Live
- Farm
- Runs
- Compare

Later:

- Player
- Chests
- Settings / Diagnostics

Compact overlay behavior should be implemented as a mode of the same application window unless a proven platform limitation requires otherwise.
