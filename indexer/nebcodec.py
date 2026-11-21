"""Decoder for NEB blocks and transactions (spec/node.md sections 3-5).

Pure functions, no I/O. Every decoded block is checked against its own
commitments (block id == BLAKE3(header), body_root recomputed), so a decoder
bug cannot silently write wrong data into the index.
"""
from dataclasses import dataclass, field
from blake3 import blake3

COIN = 10**8
HALVING = 450_000
INITIAL_REWARD = 20 * COIN
COINBASE_PREV = b"\x00" * 32
COINBASE_INDEX = 0xFFFFFFFF
LOCK_SINGLE = 1
LOCK_MULTISIG = 2


def H(tag: bytes, *parts: bytes) -> bytes:
    h = blake3(tag)
    for p in parts:
        h.update(p)
    return h.digest()


def b3(data: bytes) -> bytes:
    return blake3(data).digest()


def reward(height: int) -> int:
    return INITIAL_REWARD >> (height // HALVING) if height // HALVING < 64 else 0


def cumulative_reward(height: int) -> int:
    """Sum of reward(h) for h = 0 .. height (the coins the schedule allows up to that height)."""
    total, h = 0, 0
    while h <= height:
        era = h // HALVING
        if era >= 64:
            break
        end = min(height, (era + 1) * HALVING - 1)
        total += (end - h + 1) * (INITIAL_REWARD >> era)
        h = end + 1
    return total


def project_share(height: int) -> int:
    return reward(height) * 5 // 100


def bits_to_target(bits: int) -> int:
    return (bits & 0xFFFFFF) << (bits >> 24)


def work_of(bits: int) -> int:
    return (1 << 256) // (bits_to_target(bits) + 1)


# ---------------------------------------------------------------- bech32m

_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
_GEN = (0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)
_BECH32M = 0x2BC830A3


def _polymod(values):
    chk = 1
    for v in values:
        top = chk >> 25
        chk = ((chk & 0x1FFFFFF) << 5) ^ v
        for i in range(5):
            if (top >> i) & 1:
                chk ^= _GEN[i]
    return chk


def _hrp_expand(hrp):
    return [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]


def _to5(data: bytes):
    acc = bits = 0
    out = []
    for b in data:
        acc = (acc << 8) | b
        bits += 8
        while bits >= 5:
            bits -= 5
            out.append((acc >> bits) & 31)
    if bits:
        out.append((acc << (5 - bits)) & 31)
    return out


def bech32m_address(lock_data: bytes, hrp: str = "neb") -> str:
    data = _to5(lock_data)
    pm = _polymod(_hrp_expand(hrp) + data + [0] * 6) ^ _BECH32M
    checksum = [(pm >> 5 * (5 - i)) & 31 for i in range(6)]
    return hrp + "1" + "".join(_CHARSET[d] for d in data + checksum)


def decode_address(addr: str, hrp: str = "neb") -> bytes | None:
    """Inverse of bech32m_address; None when the string is not a valid address."""
    addr = addr.strip()
    if addr.lower() != addr and addr.upper() != addr:
        return None
    addr = addr.lower()
    pos = addr.rfind("1")
    if pos < 1 or addr[:pos] != hrp:
        return None
    try:
        data = [_CHARSET.index(c) for c in addr[pos + 1:]]
    except ValueError:
        return None
    if len(data) < 6 or _polymod(_hrp_expand(hrp) + data) != _BECH32M:
        return None
    acc = bits = 0
    out = bytearray()
    for v in data[:-6]:
        acc = (acc << 5) | v
        bits += 5
        if bits >= 8:
            bits -= 8
            out.append((acc >> bits) & 0xFF)
    if bits >= 5 or (acc & ((1 << bits) - 1)) or len(out) != 32:
        return None
    return bytes(out)


def lock_display(lock_type: int, lock_data: bytes) -> str:
    if lock_type == LOCK_SINGLE:
        return bech32m_address(lock_data)
    return "multisig:" + lock_data.hex()


# ---------------------------------------------------------------- reader

class DecodeError(ValueError):
    pass


class Reader:
    __slots__ = ("buf", "pos")

    def __init__(self, buf: bytes, pos: int = 0):
        self.buf = buf
        self.pos = pos

    def take(self, n: int) -> bytes:
        if self.pos + n > len(self.buf):
            raise DecodeError("read past end")
        out = self.buf[self.pos:self.pos + n]
        self.pos += n
        return out

    def u8(self):
        return self.take(1)[0]

    def u16(self):
        return int.from_bytes(self.take(2), "little")

    def u32(self):
        return int.from_bytes(self.take(4), "little")

    def u64(self):
        return int.from_bytes(self.take(8), "little")

    def varint(self):
        b = self.u8()
        if b < 0xFD:
            return b
        # read only the width the marker announces (a dict of calls would run all three reads)
        if b == 0xFD:
            v, lo = self.u16(), 0xFD
        elif b == 0xFE:
            v, lo = self.u32(), 0x10000
        else:
            v, lo = self.u64(), 0x100000000
        if v < lo:
            raise DecodeError("non-canonical varint")
        return v


# ---------------------------------------------------------------- types

@dataclass
class TxIn:
    prev_txid: bytes
    prev_index: int
    witness: bytes

    @property
    def is_coinbase(self):
        return self.prev_txid == COINBASE_PREV and self.prev_index == COINBASE_INDEX

    def pubkey(self) -> bytes | None:
        """Public key revealed by a single-key witness (pubkey 32 || sig 64)."""
        return self.witness[:32] if len(self.witness) == 96 else None

    def multisig(self):
        """(m, n, keys, key indexes) of a multisig witness, or None."""
        w = self.witness
        if len(w) < 2:
            return None
        m, n = w[0], w[1]
        if not (1 <= m <= n <= 15) or len(w) != 2 + 32 * n + 65 * m:
            return None
        keys = [w[2 + 32 * i:34 + 32 * i] for i in range(n)]
        base = 2 + 32 * n
        idx = [w[base + 65 * j] for j in range(m)]
        return m, n, keys, idx


@dataclass
class TxOut:
    amount: int
    lock_type: int
    lock_data: bytes


@dataclass
class Tx:
    version: int
    inputs: list
    outputs: list
    raw: bytes
    txid: bytes = b""

    @property
    def is_coinbase(self):
        return len(self.inputs) == 1 and self.inputs[0].is_coinbase


@dataclass
class Block:
    raw: bytes
    version: int
    parent: bytes
    body_root: bytes
    time: int
    bits: int
    nonce: int
    txs: list
    shares: list = field(default_factory=list)  # (body_root, time, nonce)
    id: bytes = b""


def _read_tx(r: Reader) -> Tx:
    start = r.pos
    version = r.u8()
    stripped = bytearray([version])
    n_in = r.varint()
    stripped += r.buf[r.pos - _varint_len(n_in):r.pos]
    ins = []
    for _ in range(n_in):
        prev = r.take(32)
        idx = r.u32()
        wl = r.varint()
        wit = r.take(wl)
        ins.append(TxIn(prev, idx, wit))
        stripped += prev + idx.to_bytes(4, "little")
    out_start = r.pos
    n_out = r.varint()
    outs = []
    for _ in range(n_out):
        amount = r.u64()
        lt = r.u8()
        ld = r.take(32)
        outs.append(TxOut(amount, lt, ld))
    stripped += r.buf[out_start:r.pos]
    raw = r.buf[start:r.pos]
    tx = Tx(version, ins, outs, raw)
    tx.txid = H(b"txid", raw) if tx.is_coinbase else H(b"txid", bytes(stripped))
    return tx


def _varint_len(v):
    return 1 if v < 0xFD else 3 if v <= 0xFFFF else 5 if v <= 0xFFFFFFFF else 9


def _merkle(leaves):
    if not leaves:
        return b"\x00" * 32
    level = leaves
    while len(level) > 1:
        nxt = [H(b"node", level[i], level[i + 1]) for i in range(0, len(level) - 1, 2)]
        if len(level) % 2:
            nxt.append(level[-1])
        level = nxt
    return level[0]


def decode_block(raw: bytes, verify: bool = True) -> Block:
    if len(raw) < 80:
        raise DecodeError("short block")
    r = Reader(raw)
    version = r.u32()
    parent = r.take(32)
    body_root = r.take(32)
    time = r.u32()
    bits = r.u32()
    nonce = r.u32()
    count = r.varint()
    if count < 1:
        raise DecodeError("empty body")
    txs = [_read_tx(r) for _ in range(count)]
    k = r.varint()
    shares_raw = r.take(40 * k)
    if r.pos != len(raw):
        raise DecodeError("trailing bytes")
    shares = [(shares_raw[i:i + 32], int.from_bytes(shares_raw[i + 32:i + 36], "little"),
               int.from_bytes(shares_raw[i + 36:i + 40], "little")) for i in range(0, len(shares_raw), 40)]
    blk = Block(raw, version, parent, body_root, time, bits, nonce, txs, shares, b3(raw[:80]))
    if verify:
        leaves = [H(b"leaf", b3(t.raw)) for t in txs]
        root = H(b"body", count.to_bytes(4, "little"), _merkle(leaves), b3(shares_raw))
        if root != body_root:
            raise DecodeError("body_root mismatch")
        if not txs[0].is_coinbase or any(t.is_coinbase for t in txs[1:]):
            raise DecodeError("coinbase position")
    return blk
