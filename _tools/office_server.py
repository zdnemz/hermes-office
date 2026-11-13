#!/usr/bin/env python3
"""office_server.py -- API + static server untuk Kantor Digital 3D.

Satu sumber kebenaran untuk denah kantor (ruangan + meja agent) ada di file
ini; frontend mengambilnya lewat /api/layout supaya tidak ada duplikasi yang
bisa melenceng.

Endpoint (semua kecuali health/login butuh sesi jika password diset):
  GET  /login               -> halaman login (publik)
  GET  /                    -> office_ui/index.html
  GET  /api/health          -> liveness + jumlah agent/departemen (publik)
  GET  /api/session         -> status sesi + token CSRF
  GET  /api/layout          -> rooms (+ annex dinamis), meja, props, bangunan, rapat
  GET  /api/agents          -> snapshot status live seluruh agent
  GET  /api/agent/<id>      -> satu agent (detail penuh)
  GET  /api/task-file?agent=..&name=.. -> isi file tugas agent (hanya di vault)
  GET  /api/meeting         -> rapat aktif (board/meeting.json)
  GET  /api/office-layout   -> dokumen kustomisasi denah + katalog perabot
  GET  /api/stream          -> SSE, push snapshot saat vault berubah
  POST /api/login | /api/logout
  POST /api/task            -> buat tiket tugas via _tools/swarm.py task
  POST /api/meeting/start | /api/meeting/end
  POST /api/office-layout   -> validasi ketat lalu simpan board/office_layout.json
                               (dry_run / preview -> hanya validasi / + denah jadi)

POST wajib header X-CSRF-Token + Origin yang cocok. Data dibaca dari vault
markdown; server hanya menulis lewat swarm.py, board/meeting.json dan
board/office_layout.json.

Jalankan:  HERMES_OFFICE_PASSWORD=... python3 _tools/office_server.py [--port 3000] [--vault PATH]
Demo:      python3 _tools/office_server.py --demo   (vault sementara + simulator, loopback)
Matikan:   Ctrl-C (tidak ada state yang tertinggal)
Uji:       python3 _tools/office_server.py --port 3999 --vault <vault-uji>
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import http.cookies
import json
import math
import os
import re
import secrets
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
from collections import deque
from datetime import date, datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DEFAULT_VAULT = Path("/opt/data/company")

# ---------------------------------------------------------------------------
# Denah Kantor Digital 3D v3 (Hermes3D v3) -- sumber kebenaran tunggal.
#
# Bangunan berbentuk huruf Z: 8 sudut siku, sengaja tidak simetris dan tidak
# berupa grid kotak.
#   north-wing  x[-26,  8] z[-18, -8]  -> research | CEO Suite | content
#   mid band    x[-26, 26] z[ -8, 10]  -> town square + board + ops + eng
#   south wing  x[-26, -6] z[ 10, 18]  -> talent lounge (HRD) + ekspansi
#
# x = timur, z = selatan, satuan = unit Three.js.
# Dinding dalam ruangan: kusen bawah solid + panel kaca semi-transparan.
# Tiap ruangan punya satu bukaan pintu (door) yang terhubung ke koridor.
# Meja agent tidak diketik manual: dihitung dari "pola meja" per ruangan,
# jadi mustahil jatuh di luar ruangan.
# ---------------------------------------------------------------------------
BUILDING = {
    "polygon": [
        [-26.0, -18.0], [8.0, -18.0], [8.0, -8.0], [26.0, -8.0],
        [26.0, 10.0], [-6.0, 10.0], [-6.0, 18.0], [-26.0, 18.0],
    ],
    "entrance": {"x": 0.0, "z": 10.0, "width": 3.6},
    "wall_height": 3.35,
    "wall_thickness": 0.45,
}

DOOR_WIDTH = 1.9
DESK_CHAIR_OFFSET = 0.95     # jarak pusat meja -> pusat kursi kerja
DESK_AISLE_OFFSET = 1.8      # jarak pusat meja -> titik berdiri (lorong meja)
WALL_PADDING = 1.1           # jarak minimum perabot dari dinding ruangan
DESK_GAP = 0.45              # jarak minimum antar meja dalam satu barisan
# Ukuran meja (lebar x dalam) dan kursi (lebar x dalam) sesuai geometri
# frontend (createDesk / createRoundTable di office_ui/index.html).
DESK_SIZE = {"executive": (3.0, 1.4), "default": (2.05, 1.05)}
# Sayap annex (dibangkitkan dari roster): koridor di z=10..12 tepat di
# selatan mid band, lalu satu baris ruangan departemen z=12..17.5 yang
# lebarnya mengikuti jumlah meja. Lobby x[-6, 2.3] dibiarkan lapang dan
# pintu masuk gedung pindah ke dinding selatan (z=18).
ANNEX = {"x0": 2.3, "z": 14.75, "d": 5.5, "gap": 0.5, "hall_z": 10.9,
         "max_desks": 6, "min_w": 5.5, "south": 18.0}
CHAIR_SIZE = {"executive": (0.62, 0.60), "default": (0.56, 0.56)}

# kind: executive | department | meeting | lounge | hangout
#
# PENTING: tidak ada "span" yang diketik manual. Rentang barisan meja di
#hitung ulang dari _fit_desk_pattern() berdasarkan batas dalam ruangan
# (padding >= WALL_PADDING dari dinding), sehingga ujung barisan meja
# secara matematis tidak mungkin menembus dinding.
_ROOM_SPECS = [
    {
        "id": "executive", "label": "CEO Suite", "dept": "executive", "kind": "executive",
        "x": 1.5, "z": -13.75, "w": 12.0, "d": 7.5, "accent": "#f59e0b",
        "door_side": "south", "door_x": 1.5, "door_z": -10.0, "hub": "nwing_e",
        "desks": {"axis": "x", "pos": -15.3, "direction": 1, "count": 1},
    },
    {
        "id": "research", "label": "Research Lab", "dept": "research", "kind": "department",
        "x": -10.25, "z": -14.5, "w": 10.5, "d": 6.0, "accent": "#3b82f6",
        "door_side": "south", "door_x": -10.25, "door_z": -11.5, "hub": "nwing_c",
        "desks": {"axis": "x", "pos": -14.8, "direction": 1, "count": 3},
    },
    {
        "id": "content", "label": "Content & Editorial Studio", "dept": "content", "kind": "department",
        "x": -20.75, "z": -14.5, "w": 9.5, "d": 6.0, "accent": "#ec4899",
        "door_side": "south", "door_x": -20.75, "door_z": -11.5, "hub": "nwing_w",
        "desks": {"axis": "x", "pos": -14.8, "direction": 1, "count": 3},
    },
    {
        "id": "board", "label": "Board Meeting Room", "dept": "-", "kind": "meeting",
        "x": 14.25, "z": -3.25, "w": 10.5, "d": 7.5, "accent": "#0ea5e9",
        "door_side": "west", "door_x": 9.0, "door_z": -3.25, "hub": "board_hub",
        "desks": None,
    },
    {
        "id": "pantry", "label": "Pantry & Coffee Bar", "dept": "-", "kind": "hangout",
        "x": -22.25, "z": -4.0, "w": 6.5, "d": 6.0, "accent": "#f97316",
        "door_side": "east", "door_x": -19.0, "door_z": -4.0, "hub": "exp1_hub",
        "desks": None,
    },
    {
        "id": "playground", "label": "Central Playground / Town Square", "dept": "lounge",
        "kind": "lounge", "x": -2.0, "z": 1.25, "w": 16.0, "d": 11.5, "accent": "#22d3ee",
        "door_side": None, "door_x": None, "door_z": None, "hub": "plaza_c",
        "desks": None,
    },
    {
        "id": "operations", "label": "Ops Center", "dept": "ops", "kind": "department",
        "x": -19.5, "z": 5.3, "w": 12.0, "d": 7.4, "accent": "#8b5cf6",
        "door_side": "east", "door_x": -13.5, "door_z": 5.3, "hub": "west_strip",
        "desks": {"axis": "x", "pos": 3.5, "direction": 1, "count": 4},
    },
    {
        "id": "eng", "label": "Eng Bay & Server Room", "dept": "eng", "kind": "department",
        "x": 14.0, "z": 6.0, "w": 12.0, "d": 7.0, "accent": "#10b981",
        "door_side": "north", "door_x": 14.0, "door_z": 2.5, "hub": "eng_hub",
        "desks": {"axis": "x", "pos": 6.2, "direction": -1, "count": 3},
    },
    {
        "id": "hrd", "label": "Talent Lounge (HRD)", "dept": "hrd", "kind": "department",
        "x": -19.25, "z": 14.5, "w": 12.5, "d": 6.0, "accent": "#06b6d4",
        "door_side": "north", "door_x": -19.25, "door_z": 11.5, "hub": "sw_hub",
        "desks": {"axis": "x", "pos": 14.8, "direction": -1, "count": 3},
    },
    {
        "id": "library", "label": "Library & Hot Desks", "dept": "-", "kind": "hangout",
        "x": -9.25, "z": 14.25, "w": 5.5, "d": 6.5, "accent": "#84cc16",
        "door_side": "north", "door_x": -9.25, "door_z": 11.0, "hub": "south_hub",
        "desks": None,
    },
    {
        "id": "gameroom", "label": "Game Room", "dept": "-", "kind": "hangout",
        "x": 23.5, "z": -3.0, "w": 4.0, "d": 9.0, "accent": "#e879f9",
        "door_side": "west", "door_x": 21.5, "door_z": -3.0, "hub": "east_n",
        "desks": None,
    },
]

def _spec_door(spec: dict) -> dict | None:
    """Pintu ruangan dari _ROOM_SPECS (satu sumber kebenaran)."""
    if not spec.get("door_side"):
        return None
    return {
        "side": spec["door_side"],
        "x": spec["door_x"], "z": spec["door_z"],
        "width": DOOR_WIDTH,
    }


def _room_bounds(spec: dict, padding: float = WALL_PADDING) -> dict:
    """Batas dalam ruangan: dikurangi padding dari dinding.

        x_min = x - w/2 + padding     x_max = x + w/2 - padding
        z_min = z - d/2 + padding     z_max = z + d/2 - padding

    Semua perabot (meja, kursi, lorong berdiri) wajib berada DI DALAM
    batas ini; tidak ada satu pun koordinat yang boleh menyentuhnya.
    """
    return {
        "x_min": spec["x"] - spec["w"] / 2 + padding,
        "x_max": spec["x"] + spec["w"] / 2 - padding,
        "z_min": spec["z"] - spec["d"] / 2 + padding,
        "z_max": spec["z"] + spec["d"] / 2 - padding,
    }


def _desk_sizes(kind: str) -> tuple[float, float, float, float]:
    """(lebar meja, dalam meja, lebar kursi, dalam kursi) untuk satu ruangan."""
    key = "executive" if kind == "executive" else "default"
    dw, dd = DESK_SIZE[key]
    cw, cd = CHAIR_SIZE[key]
    return dw, dd, cw, cd


def desk_capacity(spec: dict) -> int:
    """Jumlah meja maksimum yang muat dalam satu barisan di ruangan ini."""
    b = _room_bounds(spec)
    dw = _desk_sizes(spec["kind"])[0]
    span = (b["x_max"] - b["x_min"]) if spec["desks"]["axis"] == "x" else (b["z_max"] - b["z_min"])
    return int((span - dw) / (dw + DESK_GAP) + 1e-9) + 1


def _fit_desk_pattern(spec: dict, count: int | None = None) -> dict:
    """Hitung pola meja yang dijamin muat di dalam ruangan.

    Tidak ada "span" yang diketik manual lagi. Rentang barisan dihitung
    dari batas dalam ruangan (padding >= WALL_PADDING dari dinding),
    sehingga ujung barisan meja tidak mungkin menembus dinding.

    axis 'x' -> barisan meja sejajar sumbu x; arah +1 berarti kursi ada
    di sisi +z (agent menghadap monitor di sisi -z). axis 'z' -> kebalikan.
    """
    ds = spec["desks"]
    b = _room_bounds(spec)
    axis = ds["axis"]
    s = ds["direction"]
    count = ds["count"] if count is None else count
    dw, dd, cw, cd = _desk_sizes(spec["kind"])

    if axis == "x":
        a_min, a_max = b["x_min"], b["x_max"]      # sumbu barisan
        p_min, p_max = b["z_min"], b["z_max"]      # sumbu tegak lurus
    else:
        a_min, a_max = b["z_min"], b["z_max"]
        p_min, p_max = b["x_min"], b["x_max"]

    # -- 1. posisi barisan (sumbu tegak lurus) -----------------------------
    # meja + kursi + lorong berdiri harus semuanya di dalam [p_min, p_max]
    if s > 0:
        pos_lo = p_min + dd / 2
        pos_hi = p_max - DESK_AISLE_OFFSET
    else:
        pos_lo = p_min + DESK_AISLE_OFFSET
        pos_hi = p_max - dd / 2
    pos = min(max(float(ds.get("pos", (pos_lo + pos_hi) / 2)), pos_lo), pos_hi)

    # Pintu pada sisi tegak lurus memaksa lorong berdiri tepat segaris
    # dengan pintu -> alur masuk ruangan lurus, tidak menyenggol meja.
    door = _spec_door(spec)
    if door:
        door_on_perp = ((axis == "x" and door["side"] in ("east", "west")) or
                        (axis == "z" and door["side"] in ("north", "south")))
        if door_on_perp:
            forced = (door["z"] if axis == "x" else door["x"]) - s * DESK_AISLE_OFFSET
            if pos_lo - 1e-9 <= forced <= pos_hi + 1e-9:
                pos = forced

    # -- 2. rentang barisan (sumbu barisan) -------------------------------
    # pusat meja pertama/last harus >=/lewat batas dalam + setengah lebar meja
    first = a_min + dw / 2
    last = a_max - dw / 2
    step = dw + DESK_GAP
    need = (count - 1) * step
    if need > (last - first) + 1e-9:
        raise ValueError(
            f"ruangan {spec['id']} terlalu kecil: {count} meja butuh "
            f"{need + dw:.2f} unit, tersedia {last - first + dw:.2f}")
    slack = (last - first - need) / 2.0
    lo = first + slack
    hi = lo + need
    return {
        "axis": axis, "pos": pos, "direction": s, "count": count,
        "span": (lo, hi), "step": step,
        "w": dw, "d": dd, "cw": cw, "cd": cd,
    }


def _build_desks(pattern: dict) -> list[dict]:
    """Bangun daftar meja dari pola yang sudah dinormalisasi _fit_desk_pattern."""
    axis = pattern["axis"]
    pos = pattern["pos"]
    s = pattern["direction"]
    lo, hi = pattern["span"]
    count = pattern["count"]
    out = []
    for i in range(count):
        t = 0.5 if count == 1 else i / (count - 1)
        along = lo + (hi - lo) * t
        if axis == "x":
            dx, dz = along, pos
            rot = 0.0 if s > 0 else math.pi
            chair = (dx, dz + s * DESK_CHAIR_OFFSET)
            stand = (dx, dz + s * DESK_AISLE_OFFSET)
        else:
            dx, dz = pos, along
            rot = math.pi / 2 if s > 0 else -math.pi / 2
            chair = (dx + s * DESK_CHAIR_OFFSET, dz)
            stand = (dx + s * DESK_AISLE_OFFSET, dz)
        out.append({
            "x": round(dx, 3), "z": round(dz, 3), "rot": round(rot, 4),
            "chair": [round(chair[0], 3), round(chair[1], 3)],
            "stand": [round(stand[0], 3), round(stand[1], 3)],
            "w": pattern["w"], "d": pattern["d"],
            "cw": pattern["cw"], "cd": pattern["cd"],
        })
    return out


def _aisle_point(spec: dict, pattern: dict) -> tuple[float, float] | None:
    """Titik lorong meja: garis jalan di depan barisan meja.

    Untuk pintu di sisi sejajar barisan (utara/selatan untuk barisan x),
    node lorong segaris dengan pintu -> masuk ruangan lurus.
    """
    door = _spec_door(spec)
    if not door:
        return None
    axis = pattern["axis"]
    s = pattern["direction"]
    perp = pattern["pos"] + s * DESK_AISLE_OFFSET
    dx, dz = door["x"], door["z"]
    if axis == "x":
        if door["side"] in ("north", "south"):
            return (dx, perp)
        inward = 1.4 if door["side"] == "west" else -1.4
        return (dx + inward, perp)
    if door["side"] in ("east", "west"):
        return (perp, dz)
    inward = 1.4 if door["side"] == "north" else -1.4
    return (perp, dz + inward)


def _make_rooms(desk_counts: dict[str, int] | None = None, specs: list[dict] | None = None) -> list[dict]:
    """Ruangan + meja. desk_counts (room_id -> jumlah agent) membuat jumlah
    meja mengikuti roster vault; None = jumlah default di spec."""
    rooms = []
    for spec in specs or _ROOM_SPECS:
        room = {
            "id": spec["id"],
            "label": spec["label"],
            "dept": spec["dept"],
            "kind": spec["kind"],
            "x": spec["x"], "z": spec["z"],
            "w": spec["w"], "d": spec["d"],
            "accent": spec["accent"],
            "bounds": _room_bounds(spec),
            "door": None,
            "aisle": None,
            "desks": [],
            "capacity": desk_capacity(spec) if spec["desks"] else 0,
            "annex": bool(spec.get("annex")),
            "decor": spec.get("decor", "default"),
            "style": spec.get("style", ""),
        }
        spec_door = _spec_door(spec)
        if spec_door:
            room["door"] = spec_door
        if spec["desks"]:
            count = None
            if desk_counts is not None:
                # Ruangan kosong tetap punya satu meja: node lorong (aisle)
                # graph navigasi bergantung pada barisan meja.
                count = max(1, min(desk_counts.get(spec["id"], 0), room["capacity"]))
            pattern = _fit_desk_pattern(spec, count)
            room["desks"] = _build_desks(pattern)
            aisle = _aisle_point(spec, pattern)
            if aisle:
                room["aisle"] = {"x": round(aisle[0], 3), "z": round(aisle[1], 3)}
        rooms.append(room)
    return rooms


ROOMS = _make_rooms()

# ---------------------------------------------------------------------------
# Model ruangan v2 (editor denah bebas)
#
# Denah = daftar ruangan bebas: {id, label, kind, style, dept, x, z, w, d,
# accent, decor, door: {side, at} | None, desks: {axis, direction, pos} | None}
#   style  = id ruangan bawaan asal dekornya (research, pantry, ...); dekor
#            bawaan hanya dipasang kalau ruangan tidak lebih kecil dari aslinya
#   door.at = geseran pintu dari tengah sisi; desks.pos relatif ke pusat
# Tanpa denah tersimpan -> default_rooms() (= _ROOM_SPECS). Gedung, annex,
# ruang rapat, dan hot desk diturunkan dari ruangan, bukan koordinat tetap.
# ---------------------------------------------------------------------------
ROOM_KINDS = {
    "department": "Departemen", "executive": "Eksekutif", "meeting": "Ruang rapat",
    "hangout": "Santai", "lounge": "Plaza terbuka", "empty": "Kosong",
}
DESK_KINDS = ("department", "executive")
SIDES = ("north", "south", "east", "west")
ROOM_MIN, ROOM_MAX, ROOM_LIMIT = 4.0, 40.0, 500.0
MAX_ROOMS = 64
MEETING_MIN = (10.5, 7.5)          # meja conferencing + kursi + lorongnya
ANNEX = {"d": 5.5, "gap": 0.5, "hall": 2.5, "max_desks": 6, "min_w": 5.5}
BUILD_CELL, BUILD_MARGIN, BUILD_CLOSE = 0.5, 2.0, 3.0


def default_rooms() -> list[dict]:
    out = []
    for sp in _ROOM_SPECS:
        door = None
        if sp["door_side"]:
            along = sp["door_x"] - sp["x"] if sp["door_side"] in ("north", "south") else sp["door_z"] - sp["z"]
            door = {"side": sp["door_side"], "at": round(along, 3)}
        desks = None
        if sp["desks"]:
            ds = sp["desks"]
            center = sp["z"] if ds["axis"] == "x" else sp["x"]
            desks = {"axis": ds["axis"], "direction": ds["direction"], "pos": round(ds["pos"] - center, 3)}
        out.append({
            "id": sp["id"], "label": sp["label"], "kind": sp["kind"], "style": sp["id"],
            "dept": sp["dept"] if sp["kind"] in DESK_KINDS else "",
            "x": sp["x"], "z": sp["z"], "w": sp["w"], "d": sp["d"], "accent": sp["accent"],
            "decor": "default", "door": door, "desks": desks,
        })
    return out


def _style_fits(room: dict) -> bool:
    sp = ROOM_SPEC_BY_ID.get(room.get("style") or "")
    return bool(sp) and sp["kind"] == room["kind"] and room["w"] >= sp["w"] - 1e-6 and room["d"] >= sp["d"] - 1e-6


def _auto_desks(door_side: str | None) -> dict:
    """Barisan meja menempel di dinding seberang pintu (pos +-99 dijepit)."""
    if door_side in ("east", "west"):
        s = 1 if door_side == "east" else -1
        return {"axis": "z", "direction": s, "pos": -99.0 * s}
    s = -1 if door_side == "north" else 1
    return {"axis": "x", "direction": s, "pos": -99.0 * s}


def _room_spec(room: dict) -> dict:
    """Ruangan v2 -> spec internal (_make_rooms / _fit_desk_pattern)."""
    x, z, w, d, kind = room["x"], room["z"], room["w"], room["d"], room["kind"]
    fits = _style_fits(room)
    sp = {
        "id": room["id"], "label": room["label"], "kind": kind, "dept": room.get("dept") or "-",
        "x": x, "z": z, "w": w, "d": d, "accent": room["accent"], "annex": bool(room.get("annex")),
        "style": room.get("style", "") if fits else "",
        "decor": "none" if (room.get("decor") == "none" and kind != "meeting")
        or not (fits or kind in ("department", "meeting")) else "default",
        "door_side": None, "door_x": None, "door_z": None, "hub": None, "desks": None,
    }
    door = room.get("door")
    if door and kind != "lounge":
        side, at = door["side"], door["at"]
        if side in ("north", "south"):
            sp.update(door_side=side, door_x=x + at, door_z=z + (d / 2 if side == "south" else -d / 2))
        else:
            sp.update(door_side=side, door_x=x + (w / 2 if side == "east" else -w / 2), door_z=z + at)
    if kind in DESK_KINDS:
        ds = room.get("desks") or _auto_desks(sp["door_side"])
        center = z if ds["axis"] == "x" else x
        sp["desks"] = {"axis": ds["axis"], "direction": ds["direction"], "pos": center + ds["pos"], "count": 1}
    return sp


def _rrect(r: dict, pad: float = 0.0) -> tuple:
    return (r["x"] - r["w"] / 2 - pad, r["x"] + r["w"] / 2 + pad, r["z"] - r["d"] / 2 - pad, r["z"] + r["d"] / 2 + pad)


def room_issue(rooms: list[dict]) -> str | None:
    """Alasan denah ditolak, atau None. Tidak bergantung pada roster."""
    if not rooms:
        return "denah butuh minimal satu ruangan"
    if not any(r["kind"] == "meeting" for r in rooms):
        return "harus ada minimal satu ruang rapat"
    for r in rooms:
        name = f"'{r['label']}'"
        if r["kind"] == "meeting" and (r["w"] < MEETING_MIN[0] - 1e-6 or r["d"] < MEETING_MIN[1] - 1e-6):
            return f"ruang rapat {name} minimal {MEETING_MIN[0]} x {MEETING_MIN[1]} m"
        if r["kind"] in DESK_KINDS and desk_capacity(_room_spec(r)) < 1:
            return f"ruangan {name} terlalu sempit untuk satu meja"
    for i, a in enumerate(rooms):
        ra = _rrect(a)
        for b in rooms[i + 1:]:
            if _rect_hit(ra, _rrect(b), -0.01):
                return f"ruangan '{a['label']}' menimpa '{b['label']}'"
        sp = _room_spec(a)
        if sp["door_side"]:
            nx = {"east": 1, "west": -1}.get(sp["door_side"], 0)
            nz = {"south": 1, "north": -1}.get(sp["door_side"], 0)
            ox, oz = sp["door_x"] + nx * 0.8, sp["door_z"] + nz * 0.8
            for b in rooms:
                if b is not a and _rect_hit((ox - DOOR_WIDTH / 2, ox + DOOR_WIDTH / 2, oz - 0.3, oz + 0.3)
                                            if nz else (ox - 0.3, ox + 0.3, oz - DOOR_WIDTH / 2, oz + DOOR_WIDTH / 2),
                                            _rrect(b)):
                    return f"pintu '{a['label']}' tertutup ruangan '{b['label']}'"
    return None


def _annex_rooms(groups: list[dict], rooms: list[dict]) -> list[dict]:
    """Ruangan annex berderet di selatan semua ruangan; lebar = muat n meja."""
    dw = DESK_SIZE["default"][0]
    taken = {r["id"] for r in rooms}
    south = max(r["z"] + r["d"] / 2 for r in rooms)
    x = math.floor(min(r["x"] - r["w"] / 2 for r in rooms))
    out = []
    for g in groups:
        n = g["count"]
        w = math.ceil(max(ANNEX["min_w"], n * dw + (n - 1) * DESK_GAP + 2 * WALL_PADDING + 0.4) * 2) / 2
        rid, k = g["id"], 2
        while rid in taken:
            rid, k = f"{g['id']}-{k}", k + 1
        taken.add(rid)
        out.append({
            "id": rid, "label": g["label"], "kind": "department", "style": "", "dept": g["dept"],
            "x": x + w / 2, "z": south + ANNEX["hall"] + ANNEX["d"] / 2, "w": w, "d": ANNEX["d"],
            "accent": g["accent"], "decor": "default", "door": {"side": "north", "at": 0.0},
            "desks": {"axis": "x", "direction": -1, "pos": 99.0}, "annex": True,
        })
        x += w + ANNEX["gap"]
    return out


def _auto_building(rooms: list[dict]) -> dict:
    """Gedung membungkus semua ruangan: tapak ruangan + BUILD_MARGIN koridor,
    celah < 2*BUILD_CLOSE ditutup (closing), lubang diisi, lalu tepinya
    dilacak jadi poligon siku. ValueError kalau ruangan terpisah jauh."""
    c, k = BUILD_CELL, round(BUILD_CLOSE / BUILD_CELL)
    pad = BUILD_MARGIN + BUILD_CLOSE + 2 * c
    x0 = math.floor((min(r["x"] - r["w"] / 2 for r in rooms) - pad) / c) * c
    z0 = math.floor((min(r["z"] - r["d"] / 2 for r in rooms) - pad) / c) * c
    nx = math.ceil((max(r["x"] + r["w"] / 2 for r in rooms) + pad - x0) / c)
    nz = math.ceil((max(r["z"] + r["d"] / 2 for r in rooms) + pad - z0) / c)
    g = [[False] * nx for _ in range(nz)]
    for r in rooms:
        a = _rrect(r, BUILD_MARGIN)
        for j in range(math.floor((a[2] - z0) / c + 1e-9), math.ceil((a[3] - z0) / c - 1e-9)):
            for i in range(math.floor((a[0] - x0) / c + 1e-9), math.ceil((a[1] - x0) / c - 1e-9)):
                g[j][i] = True

    def sweep(grid, want):  # dilate (want=True) / erode (want=False), kotak 2k+1
        rows = [[any(row[max(0, i - k):i + k + 1]) if want else all(row[max(0, i - k):i + k + 1])
                 for i in range(nx)] for row in grid]
        return [[any(rows[jj][i] for jj in range(max(0, j - k), min(nz, j + k + 1))) if want
                 else all(rows[jj][i] for jj in range(max(0, j - k), min(nz, j + k + 1)))
                 for i in range(nx)] for j in range(nz)]
    g = sweep(sweep(g, True), False)

    def flood(seed_cells, value):
        seen = set(seed_cells)
        todo = list(seed_cells)
        while todo:
            j, i = todo.pop()
            for jj, ii in ((j + 1, i), (j - 1, i), (j, i + 1), (j, i - 1)):
                if 0 <= jj < nz and 0 <= ii < nx and (jj, ii) not in seen and g[jj][ii] == value:
                    seen.add((jj, ii))
                    todo.append((jj, ii))
        return seen
    outside = flood([(j, i) for j in range(nz) for i in (0, nx - 1) if not g[j][i]] +
                    [(j, i) for i in range(nx) for j in (0, nz - 1) if not g[j][i]], False)
    g = [[g[j][i] or (j, i) not in outside for i in range(nx)] for j in range(nz)]
    changed = True
    while changed:                       # buang sudut "jepit" diagonal
        changed = False
        for j in range(nz - 1):
            for i in range(nx - 1):
                a, b, cc, d = g[j][i], g[j][i + 1], g[j + 1][i], g[j + 1][i + 1]
                if (a and d and not b and not cc) or (b and cc and not a and not d):
                    g[j][i] = g[j][i + 1] = g[j + 1][i] = g[j + 1][i + 1] = True
                    changed = True
    start = next((j, i) for j in range(nz) for i in range(nx) if g[j][i])
    part = flood([start], True)
    for r in rooms:
        j, i = int((r["z"] - z0) / c), int((r["x"] - x0) / c)
        if (j, i) not in part:
            raise ValueError(f"ruangan '{r['label']}' terlalu jauh dari ruangan lain (gedung terpisah)")
    # tepi berarah, interior di kanan (x ke timur, z ke selatan)
    nxt = {}
    for j in range(nz):
        for i in range(nx):
            if not g[j][i]:
                continue
            if j == 0 or not g[j - 1][i]:
                nxt[(i, j)] = (i + 1, j)
            if i == nx - 1 or not g[j][i + 1]:
                nxt[(i + 1, j)] = (i + 1, j + 1)
            if j == nz - 1 or not g[j + 1][i]:
                nxt[(i + 1, j + 1)] = (i, j + 1)
            if i == 0 or not g[j][i - 1]:
                nxt[(i, j + 1)] = (i, j)
    first = min(nxt, key=lambda p: (p[1], p[0]))
    loop, p = [first], nxt[first]
    while p != first:
        loop.append(p)
        p = nxt[p]
    poly = [loop[n] for n in range(len(loop))
            if (loop[n][0] - loop[n - 1][0], loop[n][1] - loop[n - 1][1]) !=
            (loop[(n + 1) % len(loop)][0] - loop[n][0], loop[(n + 1) % len(loop)][1] - loop[n][1])]
    pts = [[round(x0 + i * c, 3), round(z0 + j * c, 3)] for i, j in poly]
    # pintu masuk: tengah tepi selatan terpanjang
    best = max(((pts[n], pts[(n + 1) % len(pts)]) for n in range(len(pts))
                if pts[n][1] == pts[(n + 1) % len(pts)][1] and pts[n][0] > pts[(n + 1) % len(pts)][0]),
               key=lambda e: (e[0][0] - e[1][0], e[0][1]))
    entrance = {"x": round((best[0][0] + best[1][0]) / 2, 3), "z": best[0][1], "width": 3.6}
    return dict(BUILDING, polygon=pts, entrance=entrance)


# Roster bawaan: nama, peran, dan warna agent yang sudah dikenal. Roster
# sebenarnya ditemukan dari folder vault (discover_roster); tabel ini hanya
# memberi nama/warna yang konsisten untuk id yang sudah dikenal.
ROSTER = [
    # CEO / orchestrator
    {"id": ".", "name": "CEO", "role": "Orchestrator Global", "dept": "executive",
     "dept_label": "Executive", "room": "executive", "slot": 0, "color": "#f59e0b"},
    # Research
    {"id": "research", "name": "Research Manager", "role": "Manajer Riset & Intelijen",
     "dept": "research", "dept_label": "Riset & Intelijen", "room": "research", "slot": 0, "color": "#3b82f6"},
    {"id": "research/workers/market-scout", "name": "Market Scout", "role": "Analisis Pasar & Harga",
     "dept": "research", "dept_label": "Riset & Intelijen", "room": "research", "slot": 1, "color": "#60a5fa"},
    {"id": "research/workers/competitor-watch", "name": "Competitor Watch", "role": "Pantauan Gerak Kompetitor",
     "dept": "research", "dept_label": "Riset & Intelijen", "room": "research", "slot": 2, "color": "#60a5fa"},
    # Content
    {"id": "content", "name": "Content Manager", "role": "Manajer Konten & Distribusi",
     "dept": "content", "dept_label": "Konten & Distribusi", "room": "content", "slot": 0, "color": "#ec4899"},
    {"id": "content/workers/writer", "name": "Content Writer", "role": "Penulis Draft Bersumber",
     "dept": "content", "dept_label": "Konten & Distribusi", "room": "content", "slot": 1, "color": "#f472b6"},
    {"id": "content/workers/editor", "name": "Content Editor", "role": "Editor & Pemeriksa Fakta",
     "dept": "content", "dept_label": "Konten & Distribusi", "room": "content", "slot": 2, "color": "#f472b6"},
    # Ops
    {"id": "ops", "name": "Ops Manager", "role": "Manajer Operasi & Klien",
     "dept": "ops", "dept_label": "Operasi & Klien", "room": "operations", "slot": 0, "color": "#8b5cf6"},
    {"id": "ops/workers/intake", "name": "Ops Intake", "role": "Intake & Triase",
     "dept": "ops", "dept_label": "Operasi & Klien", "room": "operations", "slot": 1, "color": "#a78bfa"},
    {"id": "ops/workers/reporter", "name": "Ops Reporter", "role": "Status Reporter",
     "dept": "ops", "dept_label": "Operasi & Klien", "room": "operations", "slot": 2, "color": "#a78bfa"},
    {"id": "ops/workers/janitor", "name": "Ops Janitor", "role": "Cleaning Service & Karantina",
     "dept": "ops", "dept_label": "Operasi & Klien", "room": "operations", "slot": 3, "color": "#a78bfa"},
    # Eng
    {"id": "eng", "name": "Eng Manager", "role": "Manajer Teknis & Automasi",
     "dept": "eng", "dept_label": "Teknis & Automasi", "room": "eng", "slot": 0, "color": "#10b981"},
    {"id": "eng/workers/script-runner", "name": "Script Runner", "role": "Script & Automation",
     "dept": "eng", "dept_label": "Teknis & Automasi", "room": "eng", "slot": 1, "color": "#34d399"},
    {"id": "eng/workers/workflow-builder", "name": "Workflow Builder", "role": "Integrator n8n",
     "dept": "eng", "dept_label": "Teknis & Automasi", "room": "eng", "slot": 2, "color": "#34d399"},
    # HRD
    {"id": "hrd", "name": "HRD Manager", "role": "Manajer SDM & Talenta",
     "dept": "hrd", "dept_label": "SDM & Talenta", "room": "hrd", "slot": 0, "color": "#06b6d4"},
    {"id": "hrd/workers/talent-scout", "name": "Talent Scout", "role": "Pencari Skill & Tools",
     "dept": "hrd", "dept_label": "SDM & Talenta", "room": "hrd", "slot": 1, "color": "#22d3ee"},
    {"id": "hrd/workers/agent-architect", "name": "Agent Architect", "role": "Perancang Persona SOUL",
     "dept": "hrd", "dept_label": "SDM & Talenta", "room": "hrd", "slot": 2, "color": "#22d3ee"},
]

ROOMS_BY_ID = {r["id"]: r for r in ROOMS}
ROOM_SPEC_BY_ID = {sp["id"]: sp for sp in _ROOM_SPECS}
KNOWN_AGENTS = {a["id"]: a for a in ROSTER}
# Departemen yang sudah punya ruangan sendiri, urut sesuai tampilan UI.
KNOWN_DEPTS: dict[str, dict] = {}
for _a in ROSTER:
    _info = KNOWN_DEPTS.setdefault(_a["dept"], {
        "room": _a["room"], "dept_label": _a["dept_label"], "color": _a["color"]})
    if _a["slot"] > 0:
        _info["color"] = _a["color"]          # warna worker, bukan manager
DEPT_ORDER = list(KNOWN_DEPTS)
AGENTS_BY_ID = KNOWN_AGENTS                   # alias lama (roster bawaan)

STATES = ("idle", "working", "blocked", "meeting")
PRIORITIES = ("low", "normal", "high")

# ---------------------------------------------------------------------------
# Meeting mode -- geometri Board Meeting Room
#
# Meja conferencing + kursinya dibuat di frontend (createConferenceTable), jadi
# angka di bawah WAJIB sama dengan frontend. Ini satu-satunya cara supaya
# agent bisa duduk di kursi yang benar tanpa menembus meja.
#
# Meja (bentuk stadio): kotak 5.2 x 1.5 + dua ujung bulat r 0.75, pusatnya
# di offset lokal (0.4, 0.2) dari pusat ruangan "board".
# Kursi sisi : 4 di z+1.15 dan 4 di z-1.15 (jarak ke sisi meja 0.40).
# Kursi ujung: di x +/- 3.62 (0.27 di luar ujung meja).
#
# Konvensi rot: face_rot = rot + PI (sama seperti meja kerja), arah hadap
# agent = (sin(face_rot), cos(face_rot)).
# ---------------------------------------------------------------------------
MEETING_ROOM_ID = "board"                     # ruang rapat bawaan
_MT_DX, _MT_DZ = 0.4, 0.2                     # pusat meja relatif ke pusat ruangan
_MT_HALF_LEN = 3.35                           # ujung stadio (5.2/2 + 0.75)
_MT_HALF_WID = 0.75                           # lebar meja
_SEAT_DX = (-2.1, -0.7, 0.7, 2.1)             # posisi kursi sisi
_SEAT_DZ = 1.15                               # jarak kursi sisi ke pusat meja
_SEAT_END = 3.62                              # kursi ujung, di luar ujung meja
# Lorong relatif ke pusat ruangan (ruang rapat minimal MEETING_MIN).
_LANE_S, _LANE_N, _LANE_W, _LANE_E = 2.1, -1.9, -4.05, 4.6


def meeting_layout(room: dict | None = None) -> dict:
    """Kursi meja conferencing + jalur aman di dalam ruang rapat.

    Semua koordinat relatif ke ruangan rapat (default: Board Meeting Room),
    dikirim ke frontend lewat /api/layout supaya tidak ada duplikasi
    angka yang bisa melenceng antara backend dan frontend.
    """
    room = room or ROOM_SPEC_BY_ID[MEETING_ROOM_ID]
    rx, rz = room["x"], room["z"]
    cx, cz = rx + _MT_DX, rz + _MT_DZ
    lane_s, lane_n, lane_w, lane_e = rz + _LANE_S, rz + _LANE_N, rx + _LANE_W, rx + _LANE_E
    seats: list[dict] = []
    standing: list[dict] = []

    def add(dst: list[dict], x: float, z: float, rot: float, side: str,
            approach: tuple[float, float], path: list[tuple[float, float]], sit: bool):
        dst.append({
            "index": len(dst),
            "x": round(x, 3), "z": round(z, 3),
            "rot": round(rot, 4),
            "face_rot": round(rot + math.pi, 4),
            "side": side,
            "sit": sit,
            "approach": {"x": round(approach[0], 3), "z": round(approach[1], 3)},
            "path": [{"x": round(p[0], 3), "z": round(p[1], 3)} for p in path],
        })

    # Sisi selatan: agent duduk menghadap meja (arah hadap -z).
    for dx in _SEAT_DX:
        x = cx + dx
        add(seats, x, cz + _SEAT_DZ, 0.0, "south", (x, lane_s), [(lane_w, lane_s), (x, lane_s)], True)
    # Sisi utara: menghadap meja (arah hadap +z).
    for dx in _SEAT_DX:
        x = cx + dx
        add(seats, x, cz - _SEAT_DZ, math.pi, "north", (x, lane_n), [(lane_w, lane_n), (x, lane_n)], True)
    # Ujung barat & timur: agent menghadap meja dari ujung meja.
    add(seats, cx - _SEAT_END, cz, -math.pi / 2, "west", (lane_w + 0.2, cz), [(lane_w + 0.2, cz)], True)
    add(seats, cx + _SEAT_END, cz, math.pi / 2, "east", (lane_e, cz),
        [(lane_w, lane_n), (lane_e, lane_n), (lane_e, cz)], True)
    # Cadangan: berdiri di belakang barisan kursi (kalau peserta > kursi).
    for x in (cx - 2.1, cx - 0.7, cx + 0.7, cx + 2.1):
        add(standing, x, cz - 2.7, math.pi, "north-stand", (x, lane_n), [(lane_w, lane_n), (x, lane_n)], False)
    for x in (cx - 2.1, cx - 0.7, cx + 0.7, cx + 2.1):
        add(standing, x, cz + 2.45, 0.0, "south-stand", (x, lane_s), [(lane_w, lane_s), (x, lane_s)], False)

    return {
        "room": room["id"],
        "entry": {"x": round(lane_w, 3), "z": round(rz, 3)},
        "table": {
            "x0": round(cx - _MT_HALF_LEN, 3), "x1": round(cx + _MT_HALF_LEN, 3),
            "z0": round(cz - _MT_HALF_WID, 3), "z1": round(cz + _MT_HALF_WID, 3),
        },
        "seats": seats,
        "standing": standing,
    }


def meeting_slots() -> list[dict]:
    """Semua slot peserta: kursi dulu, lalu titik berdiri cadangan.
    Jumlahnya sama untuk ruang rapat mana pun."""
    layout = meeting_layout()
    return list(layout["seats"]) + list(layout["standing"])


MAX_GOAL = 400
MAX_ACCEPT = 300
MAX_ACCEPT_ITEMS = 12

# ---------------------------------------------------------------------------
# Meja baca panjang di Library (perabot zona santai, bukan meja agent).
# Sejajar sumbu z; bangku di sisi barat & timur menghadap meja. Ikut ruangan
# ber-style "library" (selama dekornya terpasang).
# ---------------------------------------------------------------------------
HOT_DESK_STYLE = "library"


def hot_desk(room: dict) -> dict:
    """Meja hot desk + bangku: (x, z) duduk + titik berdiri di lorong utara meja."""
    rx, rz = room["x"], room["z"]
    table = {"x0": round(rx - 0.5, 3), "x1": round(rx + 0.5, 3),
             "z0": round(rz - 0.95, 3), "z1": round(rz + 2.05, 3)}
    cz = (table["z0"] + table["z1"]) / 2
    spots = []
    for x, rot in ((rx - 1.1, -math.pi / 2), (rx + 1.1, math.pi / 2)):
        for row, dz in enumerate((-1.0, 0.0, 1.0)):
            spots.append({
                "x": round(x, 3), "z": round(cz + dz, 3), "rot": round(rot, 4),
                "chair": [round(x, 3), round(cz + dz, 3)],
                "stand": [round(x, 3), round(rz - 2.05 + 0.3 * row, 3)],
            })
    return {"room": room["id"], "table": table, "spots": spots}



# ---------------------------------------------------------------------------
# Penemuan roster dari vault
#
#   <vault>/AGENTS.md                         -> CEO (id ".")
#   <vault>/<dept>/AGENTS.md                  -> manager departemen
#   <vault>/<dept>/workers/<nama>/AGENTS.md   -> worker
#
# Folder dianggap agent kalau punya AGENTS.md, tasks/, atau memory/.
# <folder>/office.json opsional: {"name", "role", "color", "dept_label"}.
# ---------------------------------------------------------------------------
_SEGMENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
_NEW_DEPT_COLORS = ("#f43f5e", "#14b8a6", "#eab308", "#6366f1", "#fb7185", "#2dd4bf")


def _is_agent_dir(folder: Path) -> bool:
    return any((folder / n).exists() for n in ("AGENTS.md", "tasks", "memory"))


def _office_override(folder: Path) -> dict:
    path = folder / "office.json"
    try:
        if not path.is_file() or path.stat().st_size > 4096:
            return {}
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    out = {}
    for key, limit in (("name", 48), ("role", 80), ("dept_label", 48)):
        val = " ".join(str(data.get(key) or "").split())[:limit]
        if val:
            out[key] = val
    if isinstance(data.get("color"), str) and _HEX.match(data["color"]):
        out["color"] = data["color"].lower()
    return out


def _title(slug: str) -> str:
    return " ".join(w.capitalize() for w in re.split(r"[-_.]+", slug) if w) or slug


def _roster_entry(agent_id: str, folder: Path, dept: str, order: int) -> dict:
    known = KNOWN_AGENTS.get(agent_id)
    if known:
        entry = dict(known)
    else:
        info = KNOWN_DEPTS.get(dept)
        is_manager = "/" not in agent_id
        leaf = agent_id.rsplit("/", 1)[-1]
        color = info["color"] if info else _NEW_DEPT_COLORS[
            int(hashlib.sha1(dept.encode()).hexdigest(), 16) % len(_NEW_DEPT_COLORS)]
        entry = {
            "id": agent_id,
            "name": _title(leaf) + (" Manager" if is_manager and not info else ""),
            "role": "Manajer departemen" if is_manager else "Worker",
            "dept": dept,
            "dept_label": info["dept_label"] if info else _title(dept),
            "room": info["room"] if info else None,
            "slot": 0 if is_manager else 100 + order,
            "color": color,
        }
    entry.update(_office_override(folder))
    return entry


def discover_roster(root: Path) -> list[dict]:
    """Roster nyata dari struktur folder vault. Tidak menulis apa pun."""
    found: list[dict] = []
    if _is_agent_dir(root):
        found.append(_roster_entry(".", root, "executive", 0))
    try:
        depts = sorted(p for p in root.iterdir()
                       if p.is_dir() and _SEGMENT.match(p.name) and not p.name.startswith((".", "_")))
    except OSError:
        depts = []
    for dept_dir in depts:
        if dept_dir.name in ("board", "office_ui", "workers") or not _is_agent_dir(dept_dir):
            continue
        dept = dept_dir.name
        found.append(_roster_entry(dept, dept_dir, dept, 0))
        workers_dir = dept_dir / "workers"
        try:
            workers = sorted(p for p in workers_dir.iterdir() if p.is_dir() and _SEGMENT.match(p.name))
        except OSError:
            workers = []
        for i, w in enumerate(w for w in workers if _is_agent_dir(w)):
            found.append(_roster_entry(f"{dept}/workers/{w.name}", w, dept, i))

    def sort_key(a: dict):
        known = DEPT_ORDER.index(a["dept"]) if a["dept"] in DEPT_ORDER else len(DEPT_ORDER)
        return (known, a["dept"], a["slot"], a["id"])
    return sorted(found, key=sort_key)


# ---------------------------------------------------------------------------
# Kustomisasi denah (editor di UI) -> <vault>/board/office_layout.json
#   rooms:       {room_id: {label, accent, decor: default|none}}
#   departments: {dept: room_id}      -> departemen pindah ke ruangan lain
#   props:       [{id, type, x, z, deg}] deg = sudut bebas 0..360 (dulu rot = 0..3 x 90 derajat)
# Perabot divalidasi terhadap denah jadi: tidak boleh menutupi meja/kursi,
# jalur agent (edge navigasi, lorong -> titik berdiri -> kursi), pintu, atau
# perabot lain. Saat roster berubah, perabot yang jadi tidak valid
# disembunyikan (bukan dibiarkan menghalangi agent).
# ---------------------------------------------------------------------------
PROP_TYPES = {  # type: (label, w, d, solid) -- ukuran = tapak mesh frontend
    "plant": ("Tanaman", 0.9, 0.7, True),
    "planter": ("Pot besar", 1.5, 1.5, True),
    "sofa": ("Sofa", 3.0, 1.15, True),
    "bookshelf": ("Rak buku", 1.4, 0.45, True),
    "beanbag": ("Beanbag", 1.25, 1.25, True),
    "floorlamp": ("Lampu lantai", 0.7, 0.72, True),
    "roundtable": ("Meja bundar", 1.2, 1.2, True),
    "crate": ("Peti", 0.85, 0.85, True),
    "printer": ("Printer", 0.9, 0.7, True),
    "serverrack": ("Rak server", 1.0, 0.76, True),
    "credenza": ("Credenza", 2.7, 0.62, True),
    "labbench": ("Meja lab", 2.2, 0.8, True),
    "rug": ("Karpet", 3.0, 2.0, False),
}
MAX_PROPS = 120
PROP_MARGIN = 0.3            # ruang bebas di sekitar meja, kursi, dan jalur agent
PROP_WALL_PAD = 0.3          # jarak minimum perabot ke dinding ruangan
DECOR_KINDS = ("department", "executive")
_ROOM_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$")
_PROP_ID = re.compile(r"^p-[a-z0-9]{4,16}$")


def empty_custom() -> dict:
    return {"version": 2, "rooms": None, "departments": {}, "props": []}


def _num(o: dict, key: str, lo: float, hi: float) -> float:
    v = float(o.get(key))
    if not (math.isfinite(v) and lo <= v <= hi):
        raise ValueError(key)
    return round(v, 3)


def _norm_room(o) -> dict:
    """Satu ruangan v2 (ValueError berisi alasan singkat)."""
    if not isinstance(o, dict):
        raise ValueError("data ruangan harus objek")
    rid = str(o.get("id") or "")
    if not _ROOM_ID.match(rid):
        raise ValueError("id tidak valid")
    kind = o.get("kind")
    if kind not in ROOM_KINDS:
        raise ValueError("jenis tidak dikenal")
    try:
        x, z = _num(o, "x", -ROOM_LIMIT, ROOM_LIMIT), _num(o, "z", -ROOM_LIMIT, ROOM_LIMIT)
        w, d = _num(o, "w", ROOM_MIN, ROOM_MAX), _num(o, "d", ROOM_MIN, ROOM_MAX)
    except (TypeError, ValueError):
        raise ValueError(f"posisi/ukuran harus angka, sisi {ROOM_MIN:g}-{ROOM_MAX:g} m") from None
    accent = o.get("accent") if isinstance(o.get("accent"), str) and _HEX.match(o["accent"]) else "#64748b"
    style = o.get("style") if o.get("style") in ROOM_SPEC_BY_ID else ""
    dept = o.get("dept") if isinstance(o.get("dept"), str) and _SEGMENT.match(o["dept"]) else ""
    door = None
    if kind != "lounge":
        raw = o.get("door") if isinstance(o.get("door"), dict) else {}
        side = raw.get("side") if raw.get("side") in SIDES else "south"
        span = (w if side in ("north", "south") else d) / 2 - DOOR_WIDTH / 2 - 0.15
        try:
            at = float(raw.get("at") or 0)
        except (TypeError, ValueError):
            at = 0.0
        door = {"side": side, "at": round(min(max(at if math.isfinite(at) else 0.0, -span), span), 3)}
    desks = None
    raw = o.get("desks")
    if kind in DESK_KINDS and isinstance(raw, dict) and raw.get("axis") in ("x", "z") \
            and raw.get("direction") in (1, -1):
        try:
            desks = {"axis": raw["axis"], "direction": raw["direction"], "pos": _num(raw, "pos", -99.0, 99.0)}
        except (TypeError, ValueError):
            desks = None
    return {
        "id": rid, "label": " ".join(str(o.get("label") or "").split())[:48] or ROOM_KINDS[kind],
        "kind": kind, "style": style, "dept": dept if kind in DESK_KINDS else "",
        "x": x, "z": z, "w": w, "d": d, "accent": accent.lower(),
        "decor": "none" if o.get("decor") == "none" else "default", "door": door, "desks": desks,
    }


def normalize_custom(doc, strict: bool = False) -> dict:
    """Bersihkan dokumen denah. strict=True (POST dari UI) -> ValueError
    untuk input salah; strict=False (file di disk) -> bagian salah dibuang.
    Dokumen v1 (rooms = {id: {label, accent, decor}}) dimigrasi ke v2."""
    out = empty_custom()

    def bad(msg: str) -> None:
        if strict:
            raise ValueError(msg)

    if not isinstance(doc, dict):
        bad("dokumen denah harus objek JSON")
        return out
    rooms = doc.get("rooms")
    if isinstance(rooms, dict):                # v1: hanya label/warna/dekor ruangan bawaan
        legacy = default_rooms()
        for r in legacy:
            o = rooms.get(r["id"])
            if not isinstance(o, dict):
                continue
            label = " ".join(str(o.get("label") or "").split())[:48]
            if label:
                r["label"] = label
            if isinstance(o.get("accent"), str) and _HEX.match(o["accent"]):
                r["accent"] = o["accent"].lower()
            if o.get("decor") == "none":
                r["decor"] = "none"
        out["rooms"] = legacy if rooms else None
    elif isinstance(rooms, list):
        if len(rooms) > MAX_ROOMS:
            bad(f"maksimal {MAX_ROOMS} ruangan")
        seen = set()
        out["rooms"] = []
        for i, o in enumerate(rooms[:MAX_ROOMS]):
            try:
                r = _norm_room(o)
                if r["id"] in seen:
                    raise ValueError("id kembar")
            except ValueError as exc:
                bad(f"ruangan #{i + 1}: {exc}")
                continue
            seen.add(r["id"])
            out["rooms"].append(r)
        if not out["rooms"]:
            out["rooms"] = None
    elif rooms is not None:
        bad("'rooms' harus list")
    room_ids = {r["id"] for r in (out["rooms"] or default_rooms()) if r["kind"] in DESK_KINDS}
    depts = doc.get("departments") or {}
    if not isinstance(depts, dict):
        bad("'departments' harus objek")
        depts = {}
    for dept, rid in list(depts.items())[:64]:
        if not (isinstance(dept, str) and _SEGMENT.match(dept) and isinstance(rid, str)):
            bad(f"pemetaan departemen '{str(dept)[:40]}' tidak valid")
            continue
        if rid not in room_ids:
            bad(f"ruangan '{rid[:40]}' tidak punya meja; pilih ruangan departemen")
            continue
        out["departments"][dept] = rid
    props = doc.get("props") or []
    if not isinstance(props, list):
        bad("'props' harus list")
        props = []
    if len(props) > MAX_PROPS:
        bad(f"maksimal {MAX_PROPS} perabot")
    seen = set()
    for i, o in enumerate(props[:MAX_PROPS]):
        try:
            if not isinstance(o, dict) or o.get("type") not in PROP_TYPES:
                raise ValueError(f"perabot #{i + 1}: jenis tidak dikenal")
            pid = str(o.get("id") or "")
            if not _PROP_ID.match(pid) or pid in seen:
                raise ValueError(f"perabot #{i + 1}: id tidak valid")
            x, z = float(o.get("x")), float(o.get("z"))
            if not (math.isfinite(x) and math.isfinite(z) and abs(x) < 500 and abs(z) < 500):
                raise ValueError(f"perabot #{i + 1}: posisi tidak valid")
            deg = float(o["deg"]) if o.get("deg") is not None else (int(o.get("rot") or 0) % 4) * 90.0
            if not math.isfinite(deg):
                raise ValueError(f"perabot #{i + 1}: sudut tidak valid")
        except (TypeError, ValueError) as exc:
            bad(str(exc) if isinstance(exc, ValueError) and "perabot" in str(exc)
                else f"perabot #{i + 1}: data tidak valid")
            continue
        seen.add(pid)
        out["props"].append({"id": pid, "type": o["type"], "x": round(x, 3), "z": round(z, 3), "deg": round(deg, 1) % 360})
    return out


def _rect_hit(a: tuple, b: tuple, pad: float = 0.0) -> bool:
    return (a[0] < b[1] + pad and a[1] > b[0] - pad and a[2] < b[3] + pad and a[3] > b[2] - pad)


def _seg_hits_rect(ax: float, az: float, bx: float, bz: float, r: tuple) -> bool:
    t0, t1 = 0.0, 1.0
    for p, d, lo, hi in ((ax, bx - ax, r[0], r[1]), (az, bz - az, r[2], r[3])):
        if abs(d) < 1e-12:
            if p <= lo or p >= hi:
                return False
            continue
        u, v = (lo - p) / d, (hi - p) / d
        if u > v:
            u, v = v, u
        t0, t1 = max(t0, u), min(t1, v)
        if t0 >= t1:
            return False
    return True


def prop_rect(p: dict) -> tuple:
    _, w0, d0, _ = PROP_TYPES[p["type"]]
    # ponytail: tapak = AABB dari persegi yang diputar (sedikit boros untuk
    # sudut miring); pakai SAT/poligon kalau perabot miring perlu lebih rapat.
    a = math.radians(p.get("deg", 0))
    c, s = abs(math.cos(a)), abs(math.sin(a))
    w, d = w0 * c + d0 * s, w0 * s + d0 * c
    return (p["x"] - w / 2, p["x"] + w / 2, p["z"] - d / 2, p["z"] + d / 2)


def _desk_rect(desk: dict) -> tuple:
    w, d = desk["w"], desk["d"]
    if abs(math.sin(desk["rot"])) > 0.5:
        w, d = d, w
    return (desk["x"] - w / 2, desk["x"] + w / 2, desk["z"] - d / 2, desk["z"] + d / 2)


def prop_issue(p: dict, rooms: list[dict], hot: dict | None, placed: list[dict]) -> tuple[str | None, dict | None]:
    """(alasan ditolak | None, ruangan). Dipakai server; frontend meniru."""
    r = prop_rect(p)
    room = None
    for cand in rooms:
        inner = (cand["x"] - cand["w"] / 2 + PROP_WALL_PAD, cand["x"] + cand["w"] / 2 - PROP_WALL_PAD,
                 cand["z"] - cand["d"] / 2 + PROP_WALL_PAD, cand["z"] + cand["d"] / 2 - PROP_WALL_PAD)
        if r[0] >= inner[0] and r[1] <= inner[1] and r[2] >= inner[2] and r[3] <= inner[3]:
            room = cand
            break
    if room is None:
        return "harus utuh di dalam satu ruangan (jauhi dinding)", None
    if room["kind"] == "meeting":
        return "ruang rapat dikunci: kursinya dipakai agent saat rapat", room
    if not PROP_TYPES[p["type"]][3]:
        return None, room                      # karpet: boleh diinjak
    g = (r[0] - PROP_MARGIN, r[1] + PROP_MARGIN, r[2] - PROP_MARGIN, r[3] + PROP_MARGIN)
    for desk in room["desks"]:
        cx, cz = desk["chair"]
        cr = max(desk["cw"], desk["cd"]) / 2
        if _rect_hit(g, _desk_rect(desk)) or _rect_hit(g, (cx - cr, cx + cr, cz - cr, cz + cr)):
            return "menutupi meja atau kursi agent", room
        sx, sz = desk["stand"]
        if _seg_hits_rect(sx, sz, cx, cz, g):
            return "menghalangi jalur agent ke kursinya", room
        if room.get("aisle") and _seg_hits_rect(room["aisle"]["x"], room["aisle"]["z"], sx, sz, g):
            return "menghalangi lorong meja", room
    if room.get("door"):
        d = room["door"]
        if _rect_hit(g, (d["x"] - 1.2, d["x"] + 1.2, d["z"] - 1.2, d["z"] + 1.2)):
            return "menghalangi pintu", room
    if hot and room["id"] == hot["room"]:
        t = hot["table"]
        if _rect_hit(g, (t["x0"] - 1.5, t["x1"] + 1.5, t["z0"], t["z1"])):
            return "menimpa meja baca hot desk", room
    for q in placed:
        if PROP_TYPES[q["type"]][3] and _rect_hit(r, prop_rect(q), 0.05):
            return "menimpa perabot lain", room
    return None, room


def build_layout(roster: list[dict], custom: dict | None = None, strict: bool = False) -> dict:
    """Roster + denah (custom) -> denah lengkap: ruangan, meja, gedung.

    Tiap agent selalu dapat meja sendiri. Departemen mengisi ruangan
    mejanya (pemetaan editor, ruangan bawaan, lalu ruangan ber-dept sama)
    sampai penuh; kelebihannya, dan departemen tanpa ruangan, mendapat
    ruangan annex di selatan gedung (maks ANNEX["max_desks"] meja per
    ruangan, dibagi rata). strict=True (simpan dari editor) -> ValueError
    untuk denah salah; selain itu denah salah diganti denah bawaan.
    """
    custom = custom or empty_custom()
    base = custom.get("rooms") or default_rooms()
    why = room_issue(base)
    if why:
        if strict:
            raise ValueError(why)
        base = default_rooms()
    specs = {r["id"]: _room_spec(r) for r in base}
    remap = custom.get("departments", {})
    by_dept: dict[str, list[dict]] = {}
    for a in roster:
        by_dept.setdefault(a["dept"], []).append(a)

    placement: dict[str, str] = {}
    counts: dict[str, int] = {}
    cap_left = {rid: desk_capacity(sp) for rid, sp in specs.items() if sp["desks"]}
    groups: list[dict] = []
    for dept, members in by_dept.items():
        members = sorted(members, key=lambda m: (m["slot"], m["id"]))
        cands = [remap.get(dept), members[0].get("room")] + [r["id"] for r in base if r.get("dept") == dept]
        cands = [rid for i, rid in enumerate(cands) if rid in cap_left and rid not in cands[:i]]
        rest = members
        for rid in cands:
            # Ruangan bisa dipakai bersama beberapa departemen (lewat editor);
            # sisa kapasitas dihitung per ruangan, kelebihan -> annex.
            take = min(cap_left[rid], len(rest))
            cap_left[rid] -= take
            for a in rest[:take]:
                placement[a["id"]] = rid
            counts[rid] = counts.get(rid, 0) + take
            rest = rest[take:]
        if not rest:
            continue
        if cands:
            label, accent = members[0]["dept_label"] + " · Annex", specs[cands[0]]["accent"]
        else:
            label, accent = members[0]["dept_label"], members[0]["color"]
        k = math.ceil(len(rest) / ANNEX["max_desks"])
        size, extra = divmod(len(rest), k)
        start = 0
        for i in range(k):
            n = size + (1 if i < extra else 0)
            rid = "annex-" + dept.replace(".", "-") + (f"-{i + 1}" if k > 1 else "")
            groups.append({"id": rid, "label": label + (f" {i + 1}" if k > 1 else ""),
                           "dept": dept, "accent": accent, "count": n, "members": rest[start:start + n]})
            start += n
    annex = _annex_rooms(groups, base)
    for g, room in zip(groups, annex):
        specs[room["id"]] = _room_spec(room)
        counts[room["id"]] = g["count"]
        for a in g["members"]:
            placement[a["id"]] = room["id"]
    all_rooms = base + annex
    rooms = _make_rooms(counts, [specs[r["id"]] for r in all_rooms])
    rooms_by_id = {r["id"]: r for r in rooms}

    desk_of: dict[str, dict] = {}
    by_room: dict[str, list[dict]] = {}
    for a in roster:
        by_room.setdefault(placement[a["id"]], []).append(a)
    for rid, members in by_room.items():
        for i, a in enumerate(sorted(members, key=lambda m: (m["slot"], m["id"]))):
            desk_of[a["id"]] = rooms_by_id[rid]["desks"][i]

    agents = []
    for a in roster:
        desk = desk_of[a["id"]]
        room = rooms_by_id[placement[a["id"]]]
        agents.append({
            "id": a["id"],
            "name": a["name"],
            "role": a["role"],
            "dept": a["dept"],
            "dept_label": a["dept_label"],
            "room": room["id"],
            "room_label": room["label"],
            "pos": [desk["x"], 0, desk["z"]],
            "chair": desk["chair"],
            "stand": desk["stand"],
            "desk_rot": desk["rot"],
            "color": a["color"],
            "accent": room["accent"],
            "slot": a["slot"],
        })
    building = _auto_building(all_rooms)
    meeting = meeting_layout(next(r for r in all_rooms if r["kind"] == "meeting"))
    lib = next((r for r in rooms if r["style"] == HOT_DESK_STYLE and r["decor"] != "none"), None)
    hot = hot_desk(lib) if lib else None
    props: list[dict] = []
    hidden = 0
    for i, p in enumerate(custom.get("props", [])):
        why, room = prop_issue(p, rooms, hot, props)
        if why:
            if strict:
                raise ValueError(f"{PROP_TYPES[p['type']][0]} (perabot #{i + 1}): {why}")
            hidden += 1
            continue
        props.append(dict(p, room=room["id"]))
    sig = json.dumps([[(a["id"], a["name"], a["color"], a["pos"]) for a in agents],
                      [(r["id"], r["kind"], r["style"], r["x"], r["z"], r["w"], r["d"], r["label"],
                        r["accent"], r["decor"], r["door"]) for r in rooms],
                      building["polygon"], props])
    return {
        "rooms": rooms,
        "doc_rooms": [{k: v for k, v in r.items() if k != "annex"} for r in all_rooms],
        "agents": agents,
        "by_id": {a["id"]: a for a in agents},
        "departments": _department_summary(agents, rooms_by_id),
        "building": building,
        "meeting": meeting,
        "hot_desk": hot,
        "props": props,
        "props_hidden": hidden,
        "version": hashlib.sha1(sig.encode()).hexdigest()[:12],
    }


def layout_payload(layout: dict) -> dict:
    """Isi /api/layout (dan pratinjau editor) dari hasil build_layout."""
    return {
        "version": layout["version"],
        "building": layout["building"],
        "rooms": layout["rooms"],
        "doc_rooms": layout["doc_rooms"],
        "playground": next((r for r in layout["rooms"] if r["style"] == "playground"), None),
        "agents": layout["agents"],
        "departments": layout["departments"],
        "meeting": layout["meeting"],
        "hot_desk": layout["hot_desk"],
        "props": layout["props"],
        "props_hidden": layout["props_hidden"],
        "prop_types": {t: [v[1], v[2], v[3]] for t, v in PROP_TYPES.items()},
        "counts": {
            "agents": len(layout["agents"]),
            "departments": len([d for d in layout["departments"] if d["id"] != "executive"]),
            "rooms": len(layout["rooms"]),
            "meeting_seats": len(meeting_slots()),
        },
    }


def _department_summary(agents: list[dict], rooms_by_id: dict[str, dict]) -> list[dict]:
    order: list[str] = []
    for agent in agents:
        if agent["dept"] not in order:
            order.append(agent["dept"])
    out = []
    for dept in order:
        members = [a for a in agents if a["dept"] == dept]
        home = rooms_by_id[members[0]["room"]]
        out.append({
            "id": dept,
            "label": members[0]["dept_label"],
            "room": home["id"],
            "room_label": home["label"],
            "agents": len(members),
            "accent": home["accent"],
        })
    return out


def stress_roster() -> list[dict]:
    """Roster uji: departemen lama yang meluap + tiga departemen baru (satu
    di antaranya butuh 3 ruangan annex). Dipakai pemeriksa _tools/."""
    out = list(ROSTER)
    out += [{"id": f"eng/workers/extra-{i}", "name": f"Extra {i}", "role": "Worker", "dept": "eng",
             "dept_label": "Teknis & Automasi", "room": "eng", "slot": 50 + i, "color": "#34d399"}
            for i in range(5)]
    for dept, n in (("finance", 3), ("legal", 0), ("marketing", 13)):
        out.append({"id": dept, "name": _title(dept) + " Manager", "role": "Manajer departemen",
                    "dept": dept, "dept_label": _title(dept), "room": None, "slot": 0, "color": "#eab308"})
        out += [{"id": f"{dept}/workers/w{i}", "name": f"Worker {i}", "role": "Worker", "dept": dept,
                 "dept_label": _title(dept), "room": None, "slot": 100 + i, "color": "#14b8a6"}
                for i in range(n)]
    return out


def use_layout(layout: dict) -> None:
    """Arahkan global modul (ROOMS, BUILDING) ke denah lain, supaya
    pemeriksa geometri bisa memvalidasi denah dinamis dengan kode yang sama."""
    global ROOMS, BUILDING, LAYOUT_AGENTS, LAYOUT_AGENTS_BY_ID
    ROOMS = layout["rooms"]
    BUILDING = layout["building"]
    LAYOUT_AGENTS = layout["agents"]
    LAYOUT_AGENTS_BY_ID = layout["by_id"]


# Layout bawaan (roster bawaan) -- dipakai pemeriksa offline di _tools/.
DEFAULT_LAYOUT = build_layout(ROSTER)
LAYOUT_AGENTS = DEFAULT_LAYOUT["agents"]
LAYOUT_AGENTS_BY_ID = DEFAULT_LAYOUT["by_id"]


# ---------------------------------------------------------------------------
# Pembacaan vault
# ---------------------------------------------------------------------------
class Vault:
    def __init__(self, root: Path):
        self.root = root
        self.swarm = Path(os.environ.get("OFFICE_SWARM", str(root / "_tools" / "swarm.py")))
        self._meeting_path = root / "board" / "meeting.json"

    # -- Meeting ---------------------------------------------------------
    def meeting(self) -> dict | None:
        """Baca board/meeting.json. Kembalikan dict kalau rapat aktif, None kalau tidak."""
        data = self.raw_meeting()
        if not data:
            return None
        if str(data.get("status") or "").strip().lower() in ("done", "ended", "finished", "selesai"):
            return None
        participants = data.get("participants")
        if isinstance(participants, str):
            participants = [participants]
        if not isinstance(participants, list):
            return None
        ids: list[str] = []
        for raw in participants:
            pid = str(raw).strip()
            if pid and pid not in ids:
                ids.append(pid)
        if not ids:
            return None
        return {
            "status": "active",
            "topic": " ".join(str(data.get("topic") or "").split())[:200],
            "participants": ids,
            "room": MEETING_ROOM_ID,
            "started_at": str(data.get("started_at") or ""),
            "started_by": " ".join(str(data.get("started_by") or "").split())[:40],
        }

    def raw_meeting(self) -> dict | None:
        """Isi mentah board/meeting.json (tanpa menafsirkan status)."""
        try:
            if not self._meeting_path.is_file():
                return None
            data = json.loads(self._meeting_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        return data if isinstance(data, dict) else None

    def write_meeting(self, data: dict) -> Path:
        """Tulis board/meeting.json secara atomik (tulis tmp -> rename)."""
        path = self._meeting_path
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, path)
        return path

    def custom_layout(self) -> dict:
        """board/office_layout.json (editor denah); rusak/tidak ada -> kosong."""
        try:
            path = self.root / "board" / "office_layout.json"
            if not path.is_file() or path.stat().st_size > 256 * 1024:
                return empty_custom()
            return normalize_custom(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            return empty_custom()

    def write_custom_layout(self, doc: dict) -> Path:
        path = self.root / "board" / "office_layout.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, path)
        return path

    def clear_meeting(self) -> bool:
        """Hapus board/meeting.json. True kalau file benar-benar hilang."""
        try:
            self._meeting_path.unlink()
            return True
        except OSError:
            return False

    def agent_dir(self, agent_id: str) -> Path:
        return self.root if agent_id == "." else self.root / agent_id

    def read(self, path: Path, limit: int = 0) -> str:
        try:
            if not path.is_file():
                return ""
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return ""
        if limit and len(text) > limit:
            return text[:limit].rstrip() + "\n...[dipotong]"
        return text

    def _names(self, folder: Path) -> list[str]:
        if not folder.is_dir():
            return []
        return sorted(p.name for p in folder.glob("*.md"))

    def status(self, agent_id: str) -> dict:
        """Scan satu folder agent. Tidak menulis apa pun."""
        folder = self.agent_dir(agent_id)
        open_tasks = self._names(folder / "tasks" / "open")
        blocked_tasks = self._names(folder / "tasks" / "blocked")
        done_tasks = self._names(folder / "tasks" / "done")

        state = "idle"
        if blocked_tasks:
            state = "blocked"
        elif open_tasks:
            state = "working"

        journal_dir = folder / "memory" / "journal"
        journals = self._names(journal_dir)
        last_journal = journals[-1] if journals else ""
        status_path = folder / "memory" / "status.md"
        journal_path = journal_dir / last_journal if last_journal else None

        return {
            "state": state,
            "open_count": len(open_tasks),
            "blocked_count": len(blocked_tasks),
            "done_count": len(done_tasks),
            "open_tasks": open_tasks,
            "blocked_tasks": blocked_tasks,
            "done_tasks": done_tasks,
            "status_text": self.read(status_path, 6000),
            "headline": _headline(self.read(status_path)),
            "identity_text": self.read(folder / "memory" / "identity.md", 4000),
            "last_journal_file": last_journal,
            "last_journal_content": self.read(journal_path, 6000) if journal_path else "",
            "exists": (folder / "AGENTS.md").is_file(),
            "status_updated": _iso_mtime(status_path),
            "journal_updated": _iso_mtime(journal_path) if journal_path else "",
        }

    def task_text(self, agent_id: str, name: str) -> tuple[str, str] | None:
        """(folder, isi) satu file tugas. Nama harus persis salah satu file
        yang ada di tasks/{open,blocked,done} -- tidak ada path dari user
        yang pernah disambung ke filesystem tanpa dicocokkan dulu."""
        base = self.agent_dir(agent_id) / "tasks"
        for folder in ("open", "blocked", "done"):
            if name in self._names(base / folder):
                return folder, self.read(base / folder / name, 20000)
        return None


_HEADLINE_KEYS = ("sedang:", "now:", "doing:", "terakhir:", "last:", "blocker:")


def _headline(status_text: str) -> str:
    """Ambil satu baris paling informatif dari status.md untuk tooltip/roster."""
    if not status_text:
        return ""
    found = {}
    for line in status_text.splitlines():
        lowered = line.strip().lstrip("-*# ").lower()
        for key in _HEADLINE_KEYS:
            if lowered.startswith(key):
                value = line.split(":", 1)[1].strip().strip("-*").strip()
                if value:
                    found.setdefault(key, value)
    for key in _HEADLINE_KEYS:
        if found.get(key):
            return found[key][:160]
    return ""


def _iso_mtime(path: Path | None) -> str:
    if path is None:
        return ""
    try:
        ts = path.stat().st_mtime
    except OSError:
        return ""
    return datetime.fromtimestamp(ts, timezone.utc).astimezone().isoformat(timespec="seconds")


def _task_title(name: str) -> str:
    """'T-2026-11-13-susun-tabel-crm.md' -> 'susun tabel crm'."""
    stem = name[:-3] if name.endswith(".md") else name
    stem = re.sub(r"^T-\d{4}-\d{2}-\d{2}-", "", stem)
    return stem.replace("-", " ").strip() or name


# ---------------------------------------------------------------------------
# Snapshot + cache + sidik jari perubahan (untuk SSE) + feed aktivitas
# ---------------------------------------------------------------------------
DONE_IN_PAYLOAD = 25     # daftar tugas selesai di snapshot dipotong ke N terbaru


class Snapshot:
    def __init__(self, vault: Vault, ttl: float = 1.0):
        self.vault = vault
        self.ttl = ttl
        self._lock = threading.Lock()
        self._data: dict | None = None
        self._sig = ""
        self._ts = 0.0
        self._scans = 0
        self._roster_key = ""
        self._layout: dict = DEFAULT_LAYOUT
        self._prev: dict | None = None
        self._prev_meeting: tuple = ()
        self.events: deque = deque(maxlen=80)
        self._seq = 0

    def _refresh_layout(self) -> dict:
        roster = discover_roster(self.vault.root)
        custom = self.vault.custom_layout()
        key = json.dumps([roster, custom], sort_keys=True)
        if key != self._roster_key:
            self._roster_key = key
            self._layout = build_layout(roster, custom)
        return self._layout

    def layout(self) -> dict:
        with self._lock:
            return self._refresh_layout()

    def _event(self, kind: str, text: str, agent: dict | None = None) -> None:
        self._seq += 1
        self.events.append({
            "seq": self._seq, "ts": _now_iso(), "kind": kind, "text": text,
            "agent": agent["id"] if agent else None,
            "name": agent["name"] if agent else None,
        })

    def _diff(self, layout: dict, cur: dict, meeting: dict | None) -> None:
        prev = self._prev
        parts = tuple(meeting["participants"]) if meeting else ()
        if prev is not None:
            by_id = layout["by_id"]
            for aid, (o, b, d) in cur.items():
                agent = by_id[aid]
                if aid not in prev:
                    self._event("join", f"{agent['name']} bergabung ke kantor", agent)
                    continue
                po, pb, pd = prev[aid]
                for t in sorted(o - po - pb - pd):
                    self._event("task_new", f"tugas baru: {_task_title(t)}", agent)
                for t in sorted(b - pb):
                    self._event("task_blocked", f"terhambat: {_task_title(t)}", agent)
                for t in sorted((po | pb) - o - b):
                    if t in d:
                        self._event("task_done", f"selesai: {_task_title(t)}", agent)
                for t in sorted(o & pb):
                    self._event("task_unblocked", f"lanjut lagi: {_task_title(t)}", agent)
            for aid in prev.keys() - cur.keys():
                self._event("leave", f"{aid} keluar dari roster")
            if parts != self._prev_meeting:
                if parts:
                    topic = meeting.get("topic") or "tanpa topik"
                    self._event("meeting_start", f"rapat dimulai: {topic} ({len(parts)} peserta)")
                elif self._prev_meeting:
                    self._event("meeting_end", "rapat selesai")
        self._prev = cur
        self._prev_meeting = parts

    def get(self, force: bool = False) -> tuple[dict, str]:
        with self._lock:
            now = time.time()
            if not force and self._data is not None and (now - self._ts) < self.ttl:
                return self._data, self._sig

            layout = self._refresh_layout()
            agents = []
            fp: list = [layout["version"]]
            counts = {s: 0 for s in STATES}
            meeting = self.vault.meeting()
            if meeting:
                meeting["participants"] = [p for p in meeting["participants"] if p in layout["by_id"]]
                if not meeting["participants"]:
                    meeting = None
            slots = meeting_slots()
            meeting_ids: dict[str, int] = {}
            if meeting:
                for i, pid in enumerate(meeting["participants"]):
                    if i < len(slots):
                        meeting_ids[pid] = i
            fp.append(("meeting", meeting.get("topic", "") if meeting else "",
                       ",".join(meeting.get("participants", [])) if meeting else ""))
            cur: dict[str, tuple] = {}
            for meta in layout["agents"]:
                status = self.vault.status(meta["id"])
                cur[meta["id"]] = (set(status["open_tasks"]), set(status["blocked_tasks"]),
                                   set(status["done_tasks"]))
                status["done_tasks"] = status["done_tasks"][-DONE_IN_PAYLOAD:]
                if meta["id"] in meeting_ids:
                    status["state"] = "meeting"
                    status["meeting_room"] = layout["meeting"]["room"]
                    status["meeting_topic"] = meeting.get("topic", "")
                    status["meeting_seat"] = meeting_ids[meta["id"]]
                counts[status["state"]] = counts.get(status["state"], 0) + 1
                agents.append({**meta, **status})
                fp.append((
                    meta["id"], status["state"], status["open_count"],
                    status["blocked_count"], status["done_count"],
                    status["status_updated"], status["journal_updated"],
                    status.get("meeting_seat", -1),
                ))
            self._diff(layout, cur, meeting)
            fp.append(self._seq)

            self._scans += 1
            data = {
                "generated_at": _now_iso(),
                "layout_version": layout["version"],
                "counts": {
                    "agents": len(agents),
                    "departments": len({a["dept"] for a in agents if a["dept"] != "executive"}),
                    "rooms": len(layout["rooms"]),
                    "idle": counts.get("idle", 0),
                    "working": counts.get("working", 0),
                    "blocked": counts.get("blocked", 0),
                    "meeting": counts.get("meeting", 0),
                },
                "meeting": meeting,
                "agents": agents,
                "events": list(self.events)[-40:],
            }
            self._data = data
            self._sig = hashlib.sha1(json.dumps(fp, sort_keys=True, default=str).encode()).hexdigest()
            self._ts = now
            return data, self._sig

    @property
    def scans(self) -> int:
        with self._lock:
            return self._scans


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Autentikasi: satu password admin, sesi di memori, rate limit per IP.
# ---------------------------------------------------------------------------
SESSION_TTL = 12 * 3600
SESSION_COOKIE = "hoffice_sid"
MAX_SESSIONS = 200
LOGIN_WINDOW = 15 * 60
LOGIN_MAX_FAILS = 5
MIN_PASSWORD_LEN = 12
_SCRYPT = {"n": 2 ** 14, "r": 8, "p": 1}


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, dklen=32, **_SCRYPT)
    return "scrypt${n}${r}${p}${s}${h}".format(
        s=base64.b64encode(salt).decode(), h=base64.b64encode(digest).decode(), **_SCRYPT)


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt, digest = stored.split("$")
        if algo != "scrypt":
            return False
        want = base64.b64decode(digest)
        got = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt),
                             n=int(n), r=int(r), p=int(p), dklen=len(want))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(got, want)


class Auth:
    """Sesi disimpan sebagai sha256(token) -> (kedaluwarsa, csrf).
    Restart server = semua sesi hilang (cukup untuk satu admin)."""

    def __init__(self, password_hash: str | None):
        self.password_hash = password_hash
        self._sessions: dict[str, tuple[float, str]] = {}
        self._fails: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    @property
    def enabled(self) -> bool:
        return self.password_hash is not None

    @staticmethod
    def _key(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()

    def verify(self, password: str) -> bool:
        return bool(self.password_hash) and verify_password(password, self.password_hash)

    def create(self) -> tuple[str, str]:
        token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(24)
        with self._lock:
            now = time.time()
            self._sessions = {k: v for k, v in self._sessions.items() if v[0] > now}
            while len(self._sessions) >= MAX_SESSIONS:
                self._sessions.pop(min(self._sessions, key=lambda k: self._sessions[k][0]))
            self._sessions[self._key(token)] = (now + SESSION_TTL, csrf)
        return token, csrf

    def csrf_for(self, token: str | None) -> str | None:
        """csrf token kalau sesi valid, None kalau tidak ada / kedaluwarsa."""
        if not token:
            return None
        with self._lock:
            entry = self._sessions.get(self._key(token))
            if not entry:
                return None
            if entry[0] < time.time():
                self._sessions.pop(self._key(token), None)
                return None
            return entry[1]

    def revoke(self, token: str | None) -> None:
        if token:
            with self._lock:
                self._sessions.pop(self._key(token), None)

    def retry_after(self, ip: str) -> int:
        """Detik sampai IP boleh mencoba login lagi (0 = boleh sekarang)."""
        with self._lock:
            now = time.time()
            fails = [t for t in self._fails.get(ip, []) if t > now - LOGIN_WINDOW]
            if fails:
                self._fails[ip] = fails
            else:
                self._fails.pop(ip, None)
            if len(fails) < LOGIN_MAX_FAILS:
                return 0
            return int(fails[0] + LOGIN_WINDOW - now) + 1

    def record_fail(self, ip: str) -> int:
        with self._lock:
            if len(self._fails) > 10000:          # batas memori saat diserang
                self._fails.clear()
            self._fails.setdefault(ip, []).append(time.time())
            return max(0, LOGIN_MAX_FAILS - len(self._fails[ip]))

    def clear_fails(self, ip: str) -> None:
        with self._lock:
            self._fails.pop(ip, None)


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
PUBLIC_FILES = {"/login": "/login.html", "/login.html": "/login.html",
                "/login.css": "/login.css", "/login.js": "/login.js",
                "/tokens.css": "/tokens.css", "/favicon.svg": "/favicon.svg"}
CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; "
       "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; "
       "frame-ancestors 'none'; form-action 'self'")
MAX_STREAMS = 24


class OfficeHandler(SimpleHTTPRequestHandler):
    server_version = "Office3D"
    sys_version = ""
    protocol_version = "HTTP/1.0"
    timeout = 30                      # socket timeout: tutup koneksi lambat

    vault: Vault
    snapshot: Snapshot
    auth: Auth
    started: float
    verbose: bool
    trust_proxy: bool
    demo: bool
    web_root: Path
    _streams = 0
    _streams_lock = threading.Lock()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(self.web_root), **kwargs)

    # -- header umum -------------------------------------------------------
    def end_headers(self):
        path = urllib.parse.urlparse(self.path).path
        if path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        elif path.endswith(("/", ".html")) or path == "/login":
            self.send_header("Cache-Control", "no-cache")
        else:
            self.send_header("Cache-Control", "private, no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        self.send_header("Content-Security-Policy", CSP)
        if self._https():
            self.send_header("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        super().end_headers()

    def log_message(self, fmt, *args):
        if self.verbose:
            super().log_message(fmt, *args)

    def list_directory(self, path):          # jangan pernah tampilkan isi folder
        self.send_error(404)
        return None

    # -- util --------------------------------------------------------------
    def _https(self) -> bool:
        # Secure cookie hanya merugikan penyerang sendiri kalau header ini
        # dipalsukan, jadi tidak perlu --trust-proxy untuk memutuskan ini.
        return self.headers.get("X-Forwarded-Proto", "").split(",")[0].strip().lower() == "https"

    def _client_ip(self) -> str:
        if self.trust_proxy:
            fwd = self.headers.get("X-Forwarded-For", "")
            if fwd:
                return fwd.split(",")[-1].strip()[:64]
        return self.client_address[0]

    def _token(self) -> str | None:
        raw = self.headers.get("Cookie", "")
        if not raw:
            return None
        try:
            jar = http.cookies.SimpleCookie(raw)
        except http.cookies.CookieError:
            return None
        morsel = jar.get(SESSION_COOKIE)
        return morsel.value if morsel else None

    def _authed(self) -> bool:
        return not self.auth.enabled or self.auth.csrf_for(self._token()) is not None

    def _same_origin(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True               # non-browser client; CSRF token tetap wajib
        host = self.headers.get("X-Forwarded-Host") if self.trust_proxy else None
        host = (host or self.headers.get("Host", "")).split(",")[0].strip()
        parsed = urllib.parse.urlparse(origin)
        return bool(host) and parsed.netloc == host

    def _cookie(self, value: str, max_age: int) -> str:
        cookie = f"{SESSION_COOKIE}={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}"
        return cookie + ("; Secure" if self._https() else "")

    def _json(self, obj, status: int = 200, headers: dict | None = None):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, message: str, headers: dict | None = None):
        self._json({"success": False, "error": message, "status": status}, status, headers)

    def _redirect(self, location: str):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _scrub(self, text: str) -> str:
        """Jangan bocorkan path absolut vault ke klien."""
        return text.replace(str(self.vault.root), "<vault>")

    # -- GET ---------------------------------------------------------------
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/health":
                return self._api_health()
            if path in PUBLIC_FILES:
                if path in ("/login", "/login.html") and self._authed():
                    return self._redirect("/")
                self.path = PUBLIC_FILES[path]
                return super().do_GET()
            if not self._authed():
                if path.startswith("/api/"):
                    return self._error(401, "perlu login")
                return self._redirect("/login")
            if path == "/api/session":
                return self._api_session()
            if path == "/api/layout":
                return self._api_layout()
            if path == "/api/agents":
                return self._api_agents()
            if path == "/api/meeting":
                return self._api_meeting()
            if path == "/api/office-layout":
                return self._api_office_layout()
            if path == "/api/stream":
                return self._api_stream()
            if path == "/api/task-file":
                return self._api_task_file(urllib.parse.parse_qs(parsed.query))
            if path.startswith("/api/agent/"):
                agent_id = urllib.parse.unquote(path[len("/api/agent/"):]).strip("/")
                return self._api_agent(agent_id)
            if path.startswith("/api/"):
                return self._error(404, "endpoint API tidak dikenal")
            if any(seg.startswith(".") for seg in path.split("/")):
                return self.send_error(404)
            super().do_GET()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_HEAD(self):
        self.send_response(405)
        self.send_header("Allow", "GET, POST")
        self.send_header("Content-Length", "0")
        self.end_headers()

    # -- POST --------------------------------------------------------------
    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        handlers = {
            "/api/login": self._login,
            "/api/logout": self._logout,
            "/api/task": self._create_task,
            "/api/meeting/start": self._meeting_start,
            "/api/meeting/end": self._meeting_end,
            "/api/office-layout": self._save_office_layout,
        }
        handler = handlers.get(path)
        if handler is None:
            self._error(404, "endpoint API tidak dikenal")
            return
        if not self._same_origin():
            self._error(403, "origin tidak diizinkan")
            return
        if path != "/api/login" and self.auth.enabled:
            csrf = self.auth.csrf_for(self._token())
            if csrf is None:
                self._error(401, "perlu login")
                return
            if not hmac.compare_digest(self.headers.get("X-CSRF-Token", ""), csrf):
                self._error(403, "token CSRF tidak valid")
                return
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            self._error(400, "Content-Length tidak valid")
            return
        if length < 0 or length > 64 * 1024:
            self._error(400, "body terlalu besar (maks 64 KB)")
            return
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._error(400, "JSON tidak valid")
            return
        if not isinstance(payload, dict):
            self._error(400, "body harus objek JSON")
            return
        try:
            result = handler(payload)
        except ValueError as exc:
            self._error(400, self._scrub(str(exc)))
            return
        except RuntimeError as exc:
            self._error(502, self._scrub(str(exc)))
            return
        except Exception:  # noqa: BLE001 - jangan matikan server karena satu request
            traceback.print_exc()
            self._error(500, "kesalahan internal server")
            return
        if result is not None:
            self._json(result, 200)

    # -- auth handlers -----------------------------------------------------
    def _login(self, req: dict):
        if not self.auth.enabled:
            return {"success": True, "auth": False}
        ip = self._client_ip()
        wait = self.auth.retry_after(ip)
        if wait:
            self._error(429, f"terlalu banyak percobaan; coba lagi dalam {wait // 60 + 1} menit",
                        {"Retry-After": str(wait)})
            return None
        password = req.get("password")
        if not isinstance(password, str) or not password or len(password) > 1024 \
                or not self.auth.verify(password):
            left = self.auth.record_fail(ip)
            self._error(401, "password salah" + (f" ({left} percobaan tersisa)" if left else ""))
            return None
        self.auth.clear_fails(ip)
        token, csrf = self.auth.create()
        self._json({"success": True, "csrf": csrf}, 200,
                   {"Set-Cookie": self._cookie(token, SESSION_TTL)})
        return None

    def _logout(self, req: dict):
        self.auth.revoke(self._token())
        self._json({"success": True}, 200, {"Set-Cookie": self._cookie("", 0)})
        return None

    def _api_session(self):
        self._json({
            "authenticated": True,
            "auth": self.auth.enabled,
            "csrf": self.auth.csrf_for(self._token()) or "",
            "demo": self.demo,
        })

    # -- handlers ----------------------------------------------------------
    def _api_health(self):
        if not self._authed():
            return self._json({"status": "ok"})
        data, sig = self.snapshot.get()
        self._json({
            "status": "ok",
            "service": self.server_version,
            "uptime_seconds": round(time.time() - self.started, 1),
            "counts": data["counts"],
            "signature": sig[:12],
            "scans": self.snapshot.scans,
            "demo": self.demo,
            "time": _now_iso(),
        })

    def _api_layout(self):
        self._json(layout_payload(self.snapshot.layout()))

    def _api_office_layout(self):
        layout = self.snapshot.layout()
        doc = self.vault.custom_layout()
        doc["rooms"] = layout["doc_rooms"]          # denah bawaan/annex ikut bisa diedit
        self._json({
            "success": True,
            "doc": doc,
            "catalog": {t: {"label": v[0], "w": v[1], "d": v[2], "solid": v[3]} for t, v in PROP_TYPES.items()},
            "kinds": ROOM_KINDS,
            "max_props": MAX_PROPS,
            "max_rooms": MAX_ROOMS,
            "props_hidden": layout["props_hidden"],
            "rules": {"margin": PROP_MARGIN, "wall_pad": PROP_WALL_PAD, "room_min": ROOM_MIN,
                      "room_max": ROOM_MAX, "meeting_min": MEETING_MIN, "door_width": DOOR_WIDTH},
        })

    def _save_office_layout(self, req: dict) -> dict:
        """Simpan denah. Divalidasi penuh terhadap roster saat ini;
        dry_run=true hanya memvalidasi, preview=true ikut mengembalikan
        denah jadi (untuk pratinjau 3D di editor)."""
        doc = normalize_custom(req.get("doc"), strict=True)
        layout = build_layout(discover_roster(self.vault.root), doc, strict=True)
        if req.get("dry_run") or req.get("preview"):
            out = {"success": True, "dry_run": True, "version": layout["version"], "props": len(layout["props"])}
            if req.get("preview"):
                out["layout"] = layout_payload(layout)
            return out
        self.vault.write_custom_layout(doc)
        self.snapshot.get(force=True)
        return {"success": True, "version": layout["version"], "props": len(layout["props"])}

    def _api_meeting(self):
        data, _ = self.snapshot.get()
        self._json({
            "success": True,
            "path": "board/meeting.json",
            "meeting": data["meeting"],
            "slots": len(meeting_slots()),
            "time": _now_iso(),
        })

    def _api_agents(self):
        data, _ = self.snapshot.get()
        self._json(data)

    def _api_agent(self, agent_id: str):
        data, _ = self.snapshot.get()
        for agent in data["agents"]:
            if agent["id"] == agent_id:
                return self._json(agent)
        self._error(404, "agent tidak ada di roster")

    def _api_task_file(self, query: dict):
        agent_id = (query.get("agent") or [""])[0]
        name = (query.get("name") or [""])[0]
        if agent_id not in self.snapshot.layout()["by_id"]:
            return self._error(404, "agent tidak ada di roster")
        found = self.vault.task_text(agent_id, name)
        if not found:
            return self._error(404, "file tugas tidak ditemukan")
        folder, text = found
        self._json({"success": True, "agent": agent_id, "name": name,
                    "folder": folder, "content": text})

    def _api_stream(self):
        cls = type(self)
        with cls._streams_lock:
            if cls._streams >= MAX_STREAMS:
                return self._error(503, "terlalu banyak koneksi live")
            cls._streams += 1
        token = self._token()
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Connection", "close")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            last_sig = ""
            last_ping = time.time()
            self.wfile.write(b"retry: 3000\n\n")
            self.wfile.flush()
            while True:
                if self.auth.enabled and self.auth.csrf_for(token) is None:
                    self.wfile.write(b"event: logout\ndata: {}\n\n")
                    self.wfile.flush()
                    return
                data, sig = self.snapshot.get()
                now = time.time()
                if sig != last_sig:
                    payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
                    self.wfile.write(b"data: " + payload + b"\n\n")
                    self.wfile.flush()
                    last_sig = sig
                    last_ping = now
                elif now - last_ping >= 15:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    last_ping = now
                time.sleep(1.0)
        except (BrokenPipeError, ConnectionResetError, OSError):
            return
        finally:
            with cls._streams_lock:
                cls._streams -= 1

    # -- POST /api/meeting/start -------------------------------------------
    def _meeting_start(self, req: dict) -> dict:
        """Mulai rapat: tulis board/meeting.json lalu segarkan snapshot."""
        roster = self.snapshot.layout()["by_id"]
        participants = req.get("participants")
        if isinstance(participants, str):
            participants = [participants]
        if not isinstance(participants, list) or not participants:
            raise ValueError("'participants' wajib diisi: list id agent")
        ids: list[str] = []
        for raw in participants[:64]:
            pid = str(raw).strip()
            if not pid:
                continue
            if pid not in roster:
                raise ValueError(f"participant '{pid[:64]}' bukan agent di roster")
            if pid not in ids:
                ids.append(pid)
        if not ids:
            raise ValueError("tidak ada participant yang valid")
        if len(ids) > len(meeting_slots()):
            raise ValueError(f"Board Meeting Room hanya muat {len(meeting_slots())} orang "
                             f"({len(ids)} dipilih)")
        data = {
            "status": "active",
            "topic": " ".join(str(req.get("topic") or "").split())[:200],
            "participants": ids,
            "room": MEETING_ROOM_ID,
            "started_at": _now_iso(),
            "started_by": " ".join(str(req.get("from") or "web").split())[:40] or "web",
        }
        path = self.vault.write_meeting(data)
        self.snapshot.get(force=True)
        slots = meeting_slots()
        return {
            "success": True,
            "path": str(path.relative_to(self.vault.root)),
            "meeting": data,
            "participants": len(ids),
            "seats": min(len(ids), len(slots)),
            "slots": len(slots),
        }

    # -- POST /api/meeting/end ---------------------------------------------
    def _meeting_end(self, req: dict) -> dict:
        """Tutup rapat: status jadi done (atau file dihapus)."""
        current = self.vault.raw_meeting() or {}
        removed = False
        if req.get("remove"):
            removed = self.vault.clear_meeting()
            ended = {"status": "removed"}
        elif current:
            ended = {
                "status": "done",
                "topic": " ".join(str(current.get("topic") or "").split())[:200],
                "participants": current.get("participants")
                if isinstance(current.get("participants"), list) else [],
                "room": MEETING_ROOM_ID,
                "ended_at": _now_iso(),
            }
            self.vault.write_meeting(ended)
        else:
            ended = {"status": "done", "participants": [], "ended_at": _now_iso()}
        self.snapshot.get(force=True)
        return {
            "success": True,
            "path": "board/meeting.json",
            "meeting": None,
            "removed": removed,
            "ended": ended,
        }

    # -- POST /api/task ----------------------------------------------------
    def _create_task(self, req: dict) -> dict:
        target = str(req.get("to") or "").strip()
        if target not in self.snapshot.layout()["by_id"]:
            raise ValueError(f"target '{target[:64]}' bukan agent di roster")
        goal = " ".join(str(req.get("goal") or "").split())
        if len(goal) < 5:
            raise ValueError("field 'goal' wajib, minimal 5 karakter")
        if len(goal) > MAX_GOAL:
            raise ValueError(f"'goal' terlalu panjang (maks {MAX_GOAL} karakter)")

        priority = str(req.get("priority") or "normal").strip().lower()
        if priority not in PRIORITIES:
            raise ValueError(f"priority harus salah satu dari {', '.join(PRIORITIES)}")

        raw_accept = req.get("accept") or []
        if isinstance(raw_accept, str):
            raw_accept = raw_accept.splitlines()
        if not isinstance(raw_accept, list):
            raise ValueError("'accept' harus list string atau string multi-baris")
        accepts = [" ".join(str(a).split()) for a in raw_accept]
        accepts = [a for a in accepts if a]
        if len(accepts) > MAX_ACCEPT_ITEMS:
            raise ValueError(f"maks {MAX_ACCEPT_ITEMS} butir kriteria diterima")
        for item in accepts:
            if len(item) > MAX_ACCEPT:
                raise ValueError(f"butir kriteria terlalu panjang (maks {MAX_ACCEPT}): {item[:40]}...")

        source = " ".join(str(req.get("from") or "web-ceo").split())[:40] or "web-ceo"
        dry_run = bool(req.get("dry_run"))

        # Cegah menimpa tugas lain: swarm.py memakai nama file deterministik
        # dari slug goal, jadi goal yang sama di hari yang sama = timpa diam-diam.
        expected = self._expected_path(target, goal)

        # Argumen dikirim sebagai list (tanpa shell), dan "--" tidak perlu:
        # goal/accept selalu jadi nilai sebuah flag.
        cmd = [
            sys.executable or "python3", str(self.vault.swarm), "task", target,
            "--goal", goal,
            "--priority", priority,
            "--from", source,
        ]
        for item in accepts:
            cmd.extend(["--accept", item])

        result = {
            "success": True,
            "dry_run": dry_run,
            "target": target,
            "path": str(expected.relative_to(self.vault.root)),
        }
        if dry_run:
            result["output"] = "(dry_run: tidak ada file ditulis)"
            return result

        if not self.vault.swarm.is_file():
            raise RuntimeError("swarm.py tidak ditemukan di vault (_tools/swarm.py)")
        if expected.exists():
            raise ValueError(
                f"tugas dengan nama sama sudah ada: {expected.relative_to(self.vault.root)} "
                "-- ubah goal sedikit atau selesaikan tugas lama dulu"
            )

        proc = subprocess.run(
            cmd, cwd=self.vault.root, capture_output=True, text=True, timeout=60
        )
        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout or "").strip()
            raise RuntimeError(f"swarm.py gagal (rc={proc.returncode}): {detail[:500]}")

        created = ""
        for line in (proc.stdout or "").splitlines():
            if line.startswith("+ "):
                created = line[2:].strip()
                break
        if not created or not (self.vault.root / created).is_file():
            raise RuntimeError("swarm.py selesai tapi file tugas tidak ditemukan")
        result["path"] = created
        result["output"] = (proc.stdout or "").strip()[:2000]
        self.snapshot.get(force=True)
        return result

    def _expected_path(self, target: str, goal: str) -> Path:
        """Samakan dengan penamaan di swarm.py cmd_task."""
        slug = re.sub(r"[^a-z0-9]+", "-", goal.lower())[:40].strip("-")
        folder = self.vault.root if target == "." else self.vault.root / target
        return folder / "tasks" / "open" / f"T-{date.today().isoformat()}-{slug}.md"


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
REPO_WEBROOT = Path(__file__).resolve().parent.parent / "office_ui"
LOOPBACK = ("127.0.0.1", "localhost", "::1")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Hermes Office 3D server")
    parser.add_argument("--port", type=int, default=int(os.environ.get("OFFICE_PORT", "3000")),
                        help="port HTTP (default 3000, env OFFICE_PORT)")
    parser.add_argument("--host", default=os.environ.get("OFFICE_HOST", "127.0.0.1"),
                        help="alamat bind (default 127.0.0.1; 0.0.0.0 wajib pakai password)")
    parser.add_argument("--vault", default=os.environ.get("OFFICE_VAULT", str(DEFAULT_VAULT)),
                        help="root vault (default /opt/data/company)")
    parser.add_argument("--webroot", default=os.environ.get("OFFICE_WEBROOT", ""),
                        help="folder web (default <vault>/office_ui, lalu office_ui di repo)")
    parser.add_argument("--password-file", default="",
                        help="file berisi password admin (alternatif env HERMES_OFFICE_PASSWORD)")
    parser.add_argument("--trust-proxy", action="store_true",
                        default=os.environ.get("OFFICE_TRUST_PROXY", "") == "1",
                        help="percayai X-Forwarded-For/Host dari reverse proxy (TLS di proxy)")
    parser.add_argument("--demo", action="store_true",
                        help="vault sementara berisi agent demo + simulator aktivitas")
    parser.add_argument("--hash-password", action="store_true",
                        help="cetak hash scrypt untuk HERMES_OFFICE_PASSWORD_HASH lalu keluar")
    parser.add_argument("--verbose", action="store_true", help="log setiap request")
    return parser


def resolve_password_hash(args) -> str | None:
    """Hash password admin dari env/file. None = tidak ada password."""
    stored = os.environ.get("HERMES_OFFICE_PASSWORD_HASH", "").strip()
    if stored:
        if not stored.startswith("scrypt$") or len(stored.split("$")) != 6:
            raise SystemExit("HERMES_OFFICE_PASSWORD_HASH tidak valid (buat dengan --hash-password)")
        return stored
    plain = os.environ.get("HERMES_OFFICE_PASSWORD", "")
    if args.password_file:
        try:
            plain = Path(args.password_file).read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise SystemExit(f"gagal membaca --password-file: {exc}")
    if not plain:
        return None
    if len(plain) < MIN_PASSWORD_LEN:
        raise SystemExit(f"password admin minimal {MIN_PASSWORD_LEN} karakter")
    return hash_password(plain)


def make_server(args, password_hash: str | None) -> ThreadingHTTPServer:
    vault_root = Path(args.vault).expanduser().resolve()
    if not vault_root.is_dir():
        raise SystemExit(f"vault tidak ditemukan: {vault_root}")
    if args.webroot:
        web_root = Path(args.webroot).expanduser().resolve()
    elif (vault_root / "office_ui" / "index.html").is_file():
        web_root = vault_root / "office_ui"
    else:
        web_root = REPO_WEBROOT
    if not (web_root / "index.html").is_file():
        raise SystemExit(f"index.html tidak ditemukan di {web_root}")

    vault = Vault(vault_root)
    handler = type("BoundOfficeHandler", (OfficeHandler,), {
        "web_root": web_root,
        "vault": vault,
        "snapshot": Snapshot(vault),
        "auth": Auth(password_hash),
        "started": time.time(),
        "verbose": args.verbose,
        "trust_proxy": args.trust_proxy,
        "demo": bool(args.demo),
    })
    server = ThreadingHTTPServer((args.host, args.port), handler)
    server.daemon_threads = True
    server.web_root = web_root
    return server


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if args.hash_password:
        import getpass
        pw = getpass.getpass("password admin: ") if sys.stdin.isatty() else sys.stdin.readline().strip()
        if len(pw) < MIN_PASSWORD_LEN:
            print(f"[-] password minimal {MIN_PASSWORD_LEN} karakter", file=sys.stderr)
            return 2
        print(hash_password(pw))
        return 0

    password_hash = resolve_password_hash(args)
    if password_hash is None and not (args.demo and args.host in LOOPBACK):
        print("[-] menolak start tanpa password admin. Set HERMES_OFFICE_PASSWORD "
              "(atau HERMES_OFFICE_PASSWORD_HASH / --password-file).\n"
              "    Hanya --demo di 127.0.0.1 yang boleh tanpa password.", file=sys.stderr)
        return 2

    demo = None
    if args.demo:
        import office_demo
        demo = office_demo.Demo()
        args.vault = str(demo.root)

    try:
        server = make_server(args, password_hash)
    except OSError as exc:
        print(f"[-] gagal bind {args.host}:{args.port}: {exc}", file=sys.stderr)
        if demo:
            demo.stop()
        return 1

    layout = server.RequestHandlerClass.snapshot.layout()
    host = "localhost" if args.host in LOOPBACK or args.host == "0.0.0.0" else args.host
    print(f"[*] Hermes Office 3D aktif di http://{host}:{server.server_address[1]}")
    print(f"    vault      : {'(demo, sementara)' if demo else args.vault}")
    print(f"    webroot    : {server.web_root}")
    print(f"    roster     : {len(layout['agents'])} agent / "
          f"{len([d for d in layout['departments'] if d['id'] != 'executive'])} departemen")
    print(f"    login      : {'password admin' if password_hash else 'MATI (demo lokal)'}")
    if demo:
        demo.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[*] dihentikan.")
    finally:
        server.server_close()
        if demo:
            demo.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
