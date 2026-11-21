"""protocol.py — JSON Lines protocol on stdout.

STDOUT IS PROTOCOL ONLY (one JSON object per line, flushed immediately).
All human/debug logging goes to STDERR. Never emitted: raw pointers, raw
memory, passwords, save JSON, game asset content.
"""

import json
import sys
import time

PROTOCOL_VERSION = 1

_seq = 0


def _emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _next_seq():
    global _seq
    _seq += 1
    return _seq


def log(message):
    """Debug logging -> STDERR only (never pollutes the protocol stream)."""
    sys.stderr.write("[reader] %s\n" % message)
    sys.stderr.flush()


def hello(reader_version, profile_id):
    _emit({"type": "hello", "protocolVersion": PROTOCOL_VERSION, "readerVersion": reader_version,
           "profileId": profile_id})


def health(state, reason_code, detail=None, game_version=None, game_fingerprint=None,
           profile_id=None, health_epoch=None):
    _emit({
        "type": "health",
        "protocolVersion": PROTOCOL_VERSION,
        "seq": _next_seq(),
        "observedAtMs": int(time.time() * 1000),
        "state": state,
        "reasonCode": reason_code,
        "detail": detail,
        "gameVersion": game_version,
        "gameFingerprint": game_fingerprint,
        "profileId": profile_id,
        "healthEpoch": health_epoch,
    })


def live(snapshot):
    snapshot = dict(snapshot)
    snapshot.update({"type": "live", "protocolVersion": PROTOCOL_VERSION, "seq": _next_seq()})
    _emit(snapshot)


def run_completed(run):
    _emit({
        "type": "run_completed",
        "protocolVersion": PROTOCOL_VERSION,
        "seq": _next_seq(),
        "observedAtMs": run["endedAtMs"],
        "run": run,
    })


def run_rejected(reason_code, detail=None):
    _emit({
        "type": "run_rejected",
        "protocolVersion": PROTOCOL_VERSION,
        "seq": _next_seq(),
        "observedAtMs": int(time.time() * 1000),
        "reasonCode": reason_code,
        "detail": detail,
    })
