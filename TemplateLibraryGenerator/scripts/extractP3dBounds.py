#!/usr/bin/env python3
"""
Best-effort P3D bounds extractor bridge used by getp3dsForImport.js.

Current behavior:
- Reads PBO headers and entry payloads (stored + Cprs compressed entries).
- Matches requested virtual P3D paths against PBO entries.
- Returns per-entry diagnostics (format/version) and optional bounds.

Bounds extraction is intentionally conservative in this first implementation pass.
If authoritative bounding data cannot be safely determined, the script emits
bounds: null with a reason so downstream steps can keep placeholders.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import struct
import sys
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

PBO_VERSION_MAGIC = 0x56657273  # "Vers" little-endian
PBO_STORED_METHOD = 0
PBO_COMPRESSED_METHOD = 0x43707273  # "Cprs" little-endian
PBO_ENCRYPTED_METHOD = 0x456E6372  # "Encr" little-endian


class PboError(Exception):
    pass


@dataclass
class PboEntry:
    name: str
    packing_method: int
    original_size: int
    reserved: int
    timestamp: int
    data_size: int
    offset: int = 0


def read_cstring(buf: bytes, offset: int, max_len: int = 8192) -> Tuple[str, int]:
    end = buf.find(b"\x00", offset)
    if end == -1:
        raise PboError(f"unterminated string @ {offset}")
    if end - offset > max_len:
        raise PboError(f"string too long @ {offset}")
    value = buf[offset:end].decode("latin1", errors="replace")
    return value, end + 1


def read_header_fields(buf: bytes, offset: int) -> Tuple[Tuple[int, int, int, int, int], int]:
    if offset + 20 > len(buf):
        raise PboError("unexpected EOF while reading header fields")
    return struct.unpack_from("<IIIII", buf, offset), offset + 20


def read_properties(buf: bytes, offset: int) -> Tuple[Dict[str, str], int]:
    props: Dict[str, str] = {}
    while True:
        key, offset = read_cstring(buf, offset, 1024)
        if key == "":
            break
        value, offset = read_cstring(buf, offset, 8192)
        props[key] = value
    return props, offset


def decompress_pbo_lzss(data: bytes, expected_size: int) -> bytes:
    if expected_size < 0:
        raise PboError("invalid original size for compressed entry")
    if len(data) < 4:
        raise PboError("compressed entry too small")

    packed_end = len(data) - 4
    read_checksum = struct.unpack_from("<I", data, packed_end)[0]
    output = bytearray()
    off = 0

    while off < packed_end and len(output) < expected_size:
        flag_byte = data[off]
        off += 1
        bit = 1

        while bit < 256 and off < packed_end and len(output) < expected_size:
            if flag_byte & bit:
                output.append(data[off])
                off += 1
            else:
                if off + 1 >= packed_end:
                    raise PboError("compressed entry ended inside pointer")

                b1 = data[off]
                b2 = data[off + 1]
                off += 2

                rpos = len(output) - b1 - 256 * (b2 >> 4)
                rlen = (b2 & 0x0F) + 3

                while rlen > 0 and len(output) < expected_size:
                    if rpos < 0:
                        value = 0x20
                    elif rpos < len(output):
                        value = output[rpos]
                    else:
                        raise PboError("invalid LZSS back-reference")
                    output.append(value)
                    rpos += 1
                    rlen -= 1

            bit <<= 1

    if len(output) != expected_size:
        raise PboError(f"expanded size {len(output)} != expected {expected_size}")

    calculated_checksum = sum(output) & 0xFFFFFFFF
    if calculated_checksum != read_checksum:
        raise PboError("checksum mismatch after LZSS decompression")

    return bytes(output)


def read_pbo_archive(pbo_path: str) -> Dict[str, object]:
    if not os.path.isfile(pbo_path):
        raise PboError(f"PBO file does not exist: {pbo_path}")

    buf = open(pbo_path, "rb").read()
    file_size = len(buf)

    off = 0
    first_name, off = read_cstring(buf, off)
    pending_name: Optional[str] = None
    props: Dict[str, str] = {}
    entries: List[PboEntry] = []

    if first_name:
        pending_name = first_name
    else:
        fields, off = read_header_fields(buf, off)
        if fields[0] == PBO_VERSION_MAGIC:
            props, off = read_properties(buf, off)
        elif all(value == 0 for value in fields):
            return {
                "path": pbo_path,
                "prefix": "",
                "entries": [],
                "buffer": buf,
            }
        else:
            raise PboError(f"unsupported or corrupt PBO header marker: 0x{fields[0]:08X}")

    while True:
        if pending_name is not None:
            name = pending_name
            pending_name = None
        else:
            name, off = read_cstring(buf, off)

        fields, off = read_header_fields(buf, off)
        packing, orig_size, reserved, timestamp, data_size = fields

        if not name:
            if all(value == 0 for value in fields):
                data_off = off
                break

            if packing == PBO_VERSION_MAGIC:
                more_props, off = read_properties(buf, off)
                props.update(more_props)
                continue

            if packing in {PBO_COMPRESSED_METHOD, PBO_ENCRYPTED_METHOD}:
                data_off = off
                break

            raise PboError(f"unsupported or corrupt PBO header entry: 0x{packing:08X}")

        entries.append(PboEntry(name, packing, orig_size, reserved, timestamp, data_size))

    for entry in entries:
        entry.offset = data_off
        data_off += entry.data_size

    if data_off > file_size:
        raise PboError("entry sizes exceed archive length")

    return {
        "path": pbo_path,
        "prefix": (props.get("prefix") or "").lower().replace("/", "\\").rstrip("\\"),
        "entries": entries,
        "buffer": buf,
    }


def read_entry_payload(archive: Dict[str, object], entry: PboEntry) -> bytes:
    buf = archive["buffer"]
    raw = buf[entry.offset: entry.offset + entry.data_size]
    if len(raw) != entry.data_size:
        raise PboError(f"truncated data for entry: {entry.name}")

    if entry.packing_method == PBO_STORED_METHOD:
        return raw
    if entry.packing_method == PBO_COMPRESSED_METHOD:
        if entry.original_size <= 0:
            raise PboError(f"invalid compressed original size: {entry.name}")
        return decompress_pbo_lzss(raw, entry.original_size)
    raise PboError(f"unsupported packing method 0x{entry.packing_method:08X} for {entry.name}")


def p3d_format_info(data: bytes) -> Tuple[str, Optional[int]]:
    if len(data) < 4:
        return "unknown", None
    magic = data[:4].decode("ascii", errors="replace")
    version = struct.unpack_from("<I", data, 4)[0] if len(data) >= 8 else None
    if magic == "ODOL":
        return "ODOL", version
    if magic == "MLOD":
        return "MLOD", version
    return magic or "unknown", version


def _is_valid_minmax(min_vals: Tuple[float, float, float], max_vals: Tuple[float, float, float]) -> bool:
    for i in range(3):
        if not (math.isfinite(min_vals[i]) and math.isfinite(max_vals[i])):
            return False
        if min_vals[i] >= max_vals[i]:
            return False
        extent = max_vals[i] - min_vals[i]
        if extent < 1e-5 or extent > 20000:
            return False
        if abs(min_vals[i]) > 50000 or abs(max_vals[i]) > 50000:
            return False
    return True


def _extract_odol_bounds(data: bytes) -> Tuple[Optional[Dict[str, List[float]]], Optional[str]]:
    if len(data) < 48:
        return None, "odol-too-small"

    try:
        lod_count = struct.unpack_from("<I", data, 8)[0]
    except struct.error:
        return None, "odol-missing-lod-count"

    if lod_count <= 0 or lod_count > 2048:
        return None, "odol-invalid-lod-count"

    start = 12 + (lod_count * 4)
    if start + 24 > len(data):
        return None, "odol-header-truncated"

    # ODOL models commonly store repeated min/max vectors near the header.
    # Prefer repeated pairs for confidence; fallback to a single plausible pair.
    best: Optional[Tuple[int, Tuple[float, float, float], Tuple[float, float, float], bool]] = None
    scan_end = min(len(data) - 24, start + 2048)

    for off in range(start, scan_end, 4):
        try:
            vals = struct.unpack_from("<6f", data, off)
        except struct.error:
            break

        min_vals = (vals[0], vals[1], vals[2])
        max_vals = (vals[3], vals[4], vals[5])
        if not _is_valid_minmax(min_vals, max_vals):
            continue

        repeated = False
        if off + 48 <= len(data):
            vals2 = struct.unpack_from("<6f", data, off + 24)
            repeated = all(abs(vals[i] - vals2[i]) <= 1e-5 for i in range(6))

        if repeated:
            best = (off, min_vals, max_vals, True)
            break

        if best is None:
            best = (off, min_vals, max_vals, False)

    if not best:
        return None, "odol-bounds-not-found"

    _off, min_vals, max_vals, repeated = best
    center = [
        (min_vals[0] + max_vals[0]) / 2.0,
        (min_vals[1] + max_vals[1]) / 2.0,
        (min_vals[2] + max_vals[2]) / 2.0,
    ]
    reason = "odol-minmax-repeated" if repeated else "odol-minmax-single"
    return {
        "min": [float(min_vals[0]), float(min_vals[1]), float(min_vals[2])],
        "max": [float(max_vals[0]), float(max_vals[1]), float(max_vals[2])],
        "center": center,
    }, reason


def _extract_mlod_bounds(data: bytes) -> Tuple[Optional[Dict[str, List[float]]], Optional[str]]:
    # MLOD layout varies; start with the same robust min/max scan strategy.
    best: Optional[Tuple[int, Tuple[float, float, float], Tuple[float, float, float]]] = None
    scan_end = min(len(data) - 24, 64 * 1024)

    for off in range(0, scan_end, 4):
        try:
            vals = struct.unpack_from("<6f", data, off)
        except struct.error:
            break
        min_vals = (vals[0], vals[1], vals[2])
        max_vals = (vals[3], vals[4], vals[5])
        if not _is_valid_minmax(min_vals, max_vals):
            continue
        best = (off, min_vals, max_vals)
        break

    if not best:
        return None, "mlod-bounds-not-found"

    _off, min_vals, max_vals = best
    center = [
        (min_vals[0] + max_vals[0]) / 2.0,
        (min_vals[1] + max_vals[1]) / 2.0,
        (min_vals[2] + max_vals[2]) / 2.0,
    ]
    return {
        "min": [float(min_vals[0]), float(min_vals[1]), float(min_vals[2])],
        "max": [float(max_vals[0]), float(max_vals[1]), float(max_vals[2])],
        "center": center,
    }, "mlod-minmax-scan"


def try_extract_bounds(data: bytes) -> Tuple[Optional[Dict[str, List[float]]], Optional[str]]:
    fmt, _version = p3d_format_info(data)
    if fmt == "ODOL":
        return _extract_odol_bounds(data)
    if fmt == "MLOD":
        return _extract_mlod_bounds(data)
    return None, "unsupported-p3d-format"


def normalize_virtual_path(path_value: str) -> str:
    return path_value.strip().lower().replace("/", "\\")


def build_full_virtual(prefix: str, entry_name: str) -> str:
    name = normalize_virtual_path(entry_name)
    if prefix:
        return f"{prefix}\\{name}"
    return name


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract P3D bounds from a PBO for selected entries.")
    parser.add_argument("--pbo", required=True, help="Absolute path to .pbo")
    parser.add_argument(
        "--targets-json",
        default="",
        help="Optional JSON array of virtual p3d paths. If omitted, script reads stdin JSON array.",
    )
    args = parser.parse_args()

    try:
        if args.targets_json:
            targets_input = args.targets_json
        else:
            targets_input = sys.stdin.read().strip() or "[]"
        targets_list = json.loads(targets_input)
        if not isinstance(targets_list, list):
            raise ValueError("targets JSON must be an array")
        requested = {normalize_virtual_path(str(item)) for item in targets_list}

        archive = read_pbo_archive(args.pbo)
        prefix = archive["prefix"]
        entries: List[PboEntry] = archive["entries"]

        by_path: Dict[str, Dict[str, object]] = {}
        matched = 0

        for entry in entries:
            lower_name = normalize_virtual_path(entry.name)
            if not lower_name.endswith(".p3d"):
                continue

            full_virtual = build_full_virtual(prefix, entry.name)
            if requested and full_virtual not in requested:
                continue

            matched += 1
            try:
                data = read_entry_payload(archive, entry)
                fmt, version = p3d_format_info(data)
                bounds, reason = try_extract_bounds(data)
                by_path[full_virtual] = {
                    "bounds": bounds,
                    "format": fmt,
                    "version": version,
                    "reason": reason,
                }
            except Exception as exc:
                by_path[full_virtual] = {
                    "bounds": None,
                    "format": "unknown",
                    "version": None,
                    "reason": f"entry-read-error: {exc}",
                }

        # Ensure every requested target has an explicit result object.
        for target in requested:
            if target not in by_path:
                by_path[target] = {
                    "bounds": None,
                    "format": "missing",
                    "version": None,
                    "reason": "entry-not-found-in-pbo",
                }

        payload = {
            "ok": True,
            "pbo": args.pbo,
            "prefix": prefix,
            "requested": len(requested),
            "matched": matched,
            "results": by_path,
        }
        sys.stdout.write(json.dumps(payload))
        return 0

    except Exception as exc:
        sys.stdout.write(json.dumps({"ok": False, "error": str(exc)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
