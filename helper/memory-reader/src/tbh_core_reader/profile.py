"""profile.py — memory compatibility profile (TBH Core's own representation).

A profile is keyed by the FULL game fingerprint
(<Version.txt>-<TimeAssembly TimeDateStamp>-<SizeOfImage>) and gates ALL
layout-dependent reads. Unknown fingerprint => unsupported_game_version
(fail closed; no nearest-table guessing, no slow-scan promotion).
"""

import json
import os

PROFILE_SCHEMA_VERSION = 1


class ProfileError(Exception):
    pass


class Profile:
    def __init__(self, data):
        if not isinstance(data, dict):
            raise ProfileError("profile is not an object")
        if data.get("schemaVersion") != PROFILE_SCHEMA_VERSION:
            raise ProfileError("unsupported profile schemaVersion: %r" % (data.get("schemaVersion"),))
        for key in ("gameVersion", "gameFingerprint", "profileId", "calibration", "il2cpp",
                    "actk", "enums", "offsets", "levelCurve", "lifecycle", "process"):
            if key not in data:
                raise ProfileError("profile missing key: %s" % key)
        if not isinstance(data["levelCurve"], dict) or not data["levelCurve"]:
            raise ProfileError("profile levelCurve is empty")
        self.data = data
        self.game_version = data["gameVersion"]
        self.fingerprint = data["gameFingerprint"]
        self.profile_id = data["profileId"]
        self.calibration = data["calibration"]
        self.il2cpp = data["il2cpp"]
        self.actk = data["actk"]
        self.enums = data["enums"]
        self.offsets = data["offsets"]
        self.lifecycle = data["lifecycle"]
        self.process = data["process"]
        self.level_curve = {int(k): int(v) for k, v in data["levelCurve"].items()}

    @property
    def off(self):
        return self.offsets

    def matches_fingerprint(self, fingerprint):
        return fingerprint == self.fingerprint


def default_profile_path():
    """Bundled profile next to the package (PyInstaller --add-data friendly)."""
    base = getattr(__import__("sys"), "frozen", False) and getattr(
        __import__("sys"), "_MEIPASS", os.path.dirname(os.path.abspath(__file__))
    ) or os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, "..", "..", "profiles", "tbh-1.2.8.json")


def load_profile(path):
    try:
        with open(path, encoding="utf-8") as f:
            return Profile(json.load(f))
    except ProfileError:
        raise
    except Exception as e:  # unreadable/corrupt profile is a typed failure
        raise ProfileError("cannot load profile %s: %s" % (os.path.basename(path), e)) from e
