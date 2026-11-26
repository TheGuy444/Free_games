"""Deterministic RNG helpers.

Everything random in the sim derives from (master_seed, stream, entity_id, tick)
so a save is reproducible and bulk simulation never depends on iteration order.

Python's builtin random.Random is used for stream draws (fast, well distributed)
and SplitMix64 for hash->seed derivation.
"""
from __future__ import annotations

import random

M64 = (1 << 64) - 1


def splitmix64(x: int) -> int:
    """Standard splitmix64 finaliser: good avalanche on small input changes."""
    x = (x + 0x9E3779B97F4A7C15) & M64
    z = x
    z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & M64
    z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & M64
    return (z ^ (z >> 31)) & M64


def derive(master: int, stream: str, *ids) -> int:
    """Derive a 64-bit seed. Stable across runs (uses hashing, not id())."""
    key = "|".join([str(master), stream] + [str(i) for i in ids])
    # FNV-1a 64 then splitmix for avalanche
    h = 0xCBF29CE484222325
    for b in key.encode("utf-8"):
        h = ((h ^ b) * 0x100000001B3) & M64
    return splitmix64(h)


def stream(master: int, name: str, *ids) -> random.Random:
    return random.Random(derive(master, name, *ids))


def unit(master: int, name: str, *ids) -> float:
    """Single deterministic float in [0,1) without keeping a Random around."""
    return derive(master, name, *ids) / float(1 << 64)


def randint(master: int, name: str, lo: int, hi: int, *ids) -> int:
    if hi <= lo:
        return lo
    return lo + int(unit(master, name, *ids) * (hi - lo + 1))


def choice(master: int, seq, name: str, *ids):
    if not seq:
        return None
    return seq[int(unit(master, name, *ids) * len(seq)) % len(seq)]


def gauss(master: int, mu: float, sigma: float, name: str, *ids) -> float:
    """Deterministic roughly-normal value via sum of uniforms (Irwin-Hall, n=6)."""
    s = 0.0
    for i in range(6):
        s += unit(master, name, *ids, i)
    return mu + sigma * ((s - 3.0) / 0.7071067811865476)


def clamp(v: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return lo if v < lo else hi if v > hi else v


# --- SQL-side deterministic noise -------------------------------------------
# To age/simulate thousands of actors with one UPDATE we keep a per-row LCG
# state column (`r`).  These SQL fragments mirror RNG_LCG in Python.
LCG_MUL = 1103515245
LCG_ADD = 12345
LCG_MOD = 1 << 31

SQL_R_ADVANCE = f"r = (r * {LCG_MUL} + {LCG_ADD}) % {LCG_MOD}"
SQL_R_NOISE = "(r % 1000) / 1000.0"  # [0,1)


def lcg_next(r: int) -> int:
    return (r * LCG_MUL + LCG_ADD) % LCG_MOD


def lcg_unit(r: int) -> float:
    return (r % 1000) / 1000.0
