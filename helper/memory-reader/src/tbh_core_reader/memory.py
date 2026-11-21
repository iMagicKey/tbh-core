"""memory.py — typed Reader over the read-only handle. Adapted from tbh-meter (MIT)."""

import struct

from . import win32
from .profile import Profile


class Reader:
    def __init__(self, handle, profile: Profile):
        self.handle = handle
        self.p = profile

    def read(self, addr, size):
        return win32.read(self.handle, addr, size)

    def rptr(self, a):
        b = self.read(a, 8)
        return struct.unpack("<Q", b)[0] if b and len(b) == 8 else None

    def ri32(self, a):
        b = self.read(a, 4)
        return struct.unpack("<i", b)[0] if b and len(b) == 4 else None

    def ru32(self, a):
        b = self.read(a, 4)
        return struct.unpack("<I", b)[0] if b and len(b) == 4 else None

    def ru64(self, a):
        b = self.read(a, 8)
        return struct.unpack("<Q", b)[0] if b and len(b) == 8 else None

    def ri64(self, a):
        b = self.read(a, 8)
        return struct.unpack("<q", b)[0] if b and len(b) == 8 else None

    def rf32(self, a):
        b = self.read(a, 4)
        return struct.unpack("<f", b)[0] if b and len(b) == 4 else None

    def rf64(self, a):
        b = self.read(a, 8)
        return struct.unpack("<d", b)[0] if b and len(b) == 8 else None

    def read_cstr(self, a, maxlen=64):
        if not a:
            return None
        b = self.read(a, maxlen)
        if not b:
            return None
        nul = b.find(b"\x00")
        s = b[:nul] if nul >= 0 else b
        return s.decode("ascii", "replace") if s and all(32 <= c < 127 for c in s) else ("" if not s else None)

    def read_string(self, a):
        if not a:
            return None
        il = self.p.il2cpp
        ln = self.ri32(a + il["stringLength"])
        if ln is None or ln < 0 or ln > 4096:
            return None
        if ln == 0:
            return ""
        raw = self.read(a + il["stringChars"], ln * 2)
        return raw.decode("utf-16-le", "replace") if raw else None

    def read_array_ptrs(self, arr, count):
        if not arr or count <= 0:
            return []
        b = self.read(arr + self.p.il2cpp["arrayData"], count * 8)
        return list(struct.unpack("<%dQ" % count, b)) if b and len(b) == count * 8 else []

    def list_ptrs(self, list_obj, cap=8000):
        if not list_obj:
            return []
        il = self.p.il2cpp
        size = self.ri32(list_obj + il["listSize"])
        items = self.rptr(list_obj + il["listItems"])
        if not size or not items or size < 0 or size > cap:
            return []
        return [p for p in self.read_array_ptrs(items, size) if p]

    def list_iter(self, list_obj, cap=8000):
        yield from self.list_ptrs(list_obj, cap)

    def dict8b_items(self, dict_obj, cap=100000):
        il = self.p.il2cpp
        if not dict_obj:
            return
        ent = self.rptr(dict_obj + il["dictEntries"])
        cnt = self.ri32(dict_obj + il["dictCount"])
        if not ent or cnt is None or cnt < 0 or cnt > cap:
            return
        used = j = 0
        limit = cnt + 64
        while used < cnt and j < limit:
            e = ent + il["dictData"] + j * il["dict8bStride"]
            j += 1
            h = self.ri32(e + il["dict8bHash"])
            if h is None:
                break
            if h < 0:
                continue
            used += 1
            yield self.ri32(e + il["dict8bKey"]), self.ri64(e + il["dict8bValue"])
