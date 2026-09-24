"""pe.py — GameAssembly.dll build fingerprint.

fp = "<Version.txt>-<TimeDateStamp:#x>-<SizeOfImage:#x>" (adapted from tbh-meter
typeinfo.py, MIT). The version string ALONE is never sufficient identity.
"""

from .memory import Reader

PE_LFANEW = 0x3C
PE_SIG = b"PE\x00\x00"
PE_TIMEDATESTAMP = 0x8
PE_SIZEOFIMAGE = 0x18 + 0x38


def build_fingerprint(reader: Reader, base, version=None):
    if not base:
        return None
    e_lfanew = reader.ri32(base + PE_LFANEW)
    if not e_lfanew:
        return None
    pe = base + e_lfanew
    if reader.read(pe, 4) != PE_SIG:
        return None
    tds = reader.ri32(pe + PE_TIMEDATESTAMP)
    soi = reader.ri32(pe + PE_SIZEOFIMAGE)
    if tds is None or soi is None:
        return None
    ver = version if version else "?"
    return "%s-%#x-%#x" % (ver, tds & 0xFFFFFFFF, soi & 0xFFFFFFFF)
