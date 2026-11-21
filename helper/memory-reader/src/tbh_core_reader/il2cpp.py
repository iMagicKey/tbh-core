"""il2cpp.py — class/instance resolution over the profile calibration.

Adapted from tbh-meter il2cpp fast path (MIT): the profile carries the
build-stable anchor_rva (TypeInfoTable pointer inside GameAssembly.dll) and
TypeDefIndices. Resolution is by INDEX with a name round-trip anti-poison gate;
singletons come from the nn<T> static (bbwf) with instance-size validation;
non-singletons (PSD/CSD/StageManager) via ONE targeted backref sweep.
"""

import struct

from . import win32
from .memory import Reader
from .profile import Profile

_K_MIN = 0x10000
_K_MAX = 0x7FFFFFFFFFFF


class ResolutionFailure(Exception):
    """A required runtime gate failed -> calibration_failed (fail closed)."""


def table_base(reader: Reader, ga_base, anchor_rva):
    if not ga_base or anchor_rva is None:
        return None
    return reader.rptr(ga_base + anchor_rva)


def class_by_index(reader: Reader, tbase, idx):
    if not tbase or idx is None or idx < 0:
        return None
    return reader.rptr(tbase + idx * 8)


def class_name(reader: Reader, klass):
    """VALIDATES that klass is an Il2CppClass and returns its name, else None."""
    if not klass or klass < _K_MIN or klass > _K_MAX or (klass & 0x7):
        return None
    il = reader.p.il2cpp
    nm = reader.read_cstr(reader.rptr(klass + il["className"]))
    if not nm:
        return None
    if (reader.rptr(klass + il["classElementClass"]) == klass
            or reader.rptr(klass + il["classCastClass"]) == klass):
        return nm
    return None


def resolve_class(reader: Reader, tbase, idx, expected_name):
    """Index resolution + name round-trip gate. Raises ResolutionFailure on mismatch."""
    klass = class_by_index(reader, tbase, idx)
    name = class_name(reader, klass) if klass else None
    if name != expected_name:
        raise ResolutionFailure(
            "class %s did not round-trip (idx=%r, name=%r)" % (expected_name, idx, name))
    return klass


def bbwf_from_klass(reader: Reader, klass):
    """nn<T> singleton instance via parent static fields."""
    if not klass:
        return None
    il = reader.p.il2cpp
    par = reader.rptr(klass + il["classParent"])
    sf = reader.rptr(par + il["classStaticFields"]) if par else None
    return reader.rptr(sf + il["singletonInstance"]) if sf else None


def manager_instance_ok(reader: Reader, name, inst):
    """Singleton instance-size validation (dead-list rejection)."""
    from .profile import Profile  # noqa: F401  (typing only)
    il = reader.p.il2cpp
    off = reader.p.off
    if not inst:
        return False
    if name == "MonsterSpawnManager":
        s = reader.ri32((reader.rptr(inst + off["MonsterSpawnManager"]["monsterList"]) or 0)
                        + il["listSize"])
        return s is not None and 0 <= s < 2000
    if name == "LogManager":
        s = reader.ri32((reader.rptr(inst + off["LogManager"]["logList"]) or 0) + il["listSize"])
        return s is not None and 0 <= s < 100000
    return True


def resolve_singletons(reader: Reader, tbase, indices):
    """{'MonsterSpawnManager': inst, 'LogManager': inst} via bbwf + size gates."""
    out = {}
    for name in ("MonsterSpawnManager", "LogManager"):
        klass = resolve_class(reader, tbase, indices[name], name)
        inst = bbwf_from_klass(reader, klass)
        if not manager_instance_ok(reader, name, inst):
            raise ResolutionFailure("singleton %s failed its instance gate" % name)
        out[name] = inst
    return out


def instances_of(reader: Reader, regions, k_by_name, cap=4000):
    """Instances of already-resolved classes via ONE targeted pointer sweep."""
    targets = {name: k for name, k in (k_by_name or {}).items() if k}
    needles = {struct.pack("<Q", k): k for k in set(targets.values())}
    res = win32.scan(reader.handle, regions, list(needles.keys()), aligned=True) if needles else {}
    out = {name: [] for name in targets}
    for name, klass in targets.items():
        nd = struct.pack("<Q", klass)
        for a in res.get(nd, []):
            if not (klass <= a < klass + 0x400):  # exclude class self-refs
                out[name].append(a)
                if len(out[name]) >= cap:
                    break
    return out
