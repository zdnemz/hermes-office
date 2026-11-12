#!/usr/bin/env python3
"""office_server.py -- API + static server untuk Kantor Digital 3D.

Satu sumber kebenaran untuk denah kantor (ruangan + meja agent) ada di file
ini; frontend mengambilnya lewat /api/layout supaya tidak ada duplikasi yang
bisa melenceng.

Endpoint:
  GET  /                 -> office_ui/index.html
  GET  /api/health       -> liveness + jumlah agent/departemen
  GET  /api/layout       -> rooms, meja agent, ringkasan departemen, geometri rapat
  GET  /api/agents       -> snapshot status live seluruh agent
  GET  /api/agent/<id>   -> satu agent (detail penuh)
  GET  /api/meeting      -> rapat yang sedang aktif (baca board/meeting.json)
  GET  /api/stream       -> SSE, push snapshot saat vault berubah
  POST /api/task         -> buat tiket tugas via _tools/swarm.py task
  POST /api/meeting/start -> mulai rapat (tulis board/meeting.json)
  POST /api/meeting/end   -> tutup rapat (status done / hapus file)

Semua data dibaca dari vault markdown (bukan database). Server tidak menulis
apa pun kecuali lewat POST /api/task (meneruskan ke swarm.py) dan endpoint
meeting (board/meeting.json).

Jalankan:  python3 _tools/office_server.py [--port 3000] [--vault PATH]
Matikan:   Ctrl-C (tidak ada state yang tertinggal)
Uji:       python3 _tools/office_server.py --port 3999 --vault <vault-uji>
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import threading
import time
import urllib.parse
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
CHAIR_SIZE = {"executive": (0.62, 0.60), "default": (0.56, 0.56)}

# Nama node graph untuk tiap ruangan. Id ruangan tidak selalu sama dengan
# nama node (mis. ruangan "operations" -> node "door_ops"), jadi dipetakan
# eksplisit supaya tidak ada node yatim.
_NAV_SLUG = {
    "executive": "executive",
    "research": "research",
    "content": "content",
    "operations": "ops",
    "eng": "eng",
    "hrd": "hrd",
    "board": "board",
    "expansion1": "expansion1",
    "expansion2": "expansion2",
    "expansion3": "expansion3",
}

# kind: executive | department | meeting | lounge | expansion
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
        "id": "expansion1", "label": "Reserved / Future Dept", "dept": "-", "kind": "expansion",
        "x": -22.25, "z": -4.0, "w": 6.5, "d": 6.0, "accent": "#64748b",
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
        "id": "expansion2", "label": "Reserved / Future Dept", "dept": "-", "kind": "expansion",
        "x": -9.25, "z": 14.25, "w": 5.5, "d": 6.5, "accent": "#64748b",
        "door_side": "north", "door_x": -9.25, "door_z": 11.0, "hub": "south_hub",
        "desks": None,
    },
    {
        "id": "expansion3", "label": "Reserved / Future Dept", "dept": "-", "kind": "expansion",
        "x": 23.5, "z": -3.0, "w": 4.0, "d": 9.0, "accent": "#64748b",
        "door_side": "west", "door_x": 21.5, "door_z": -3.0, "hub": "east_n",
        "desks": None,
    },
]

# ---------------------------------------------------------------------------
# Graph navigasi: koridor utama + bukaan pintu tiap ruangan + waypoint meja.
# Node = [x, z]. Edge = dua node yang saling tersambung lewat ruang kosong.
# Frontend memakai graph ini untuk rute agent (BFS), supaya agent tidak
# pernah menembus dinding atau perabot.
#
# Node pintu (door_*) dan node lorong meja (aisle_*) TIDAK ditulis manual:
# keduanya dihitung dari _ROOM_SPECS lalu disalin ke NAV_NODES di bawah,
# sehingga koordinat frontend dan backend tidak mungkin melenceng.
# ---------------------------------------------------------------------------
_NAV_CORRIDOR = {
    # koridor
    "entrance":        [0.0, 9.4],
    "hub_south":       [0.0, 8.4],
    "south_hub":       [-9.25, 10.2],
    "sw_hub":          [-18.5, 10.4],
    "west_strip":      [-11.7, 5.2],
    "west_north":      [-11.7, -1.5],
    "exp1_hub":        [-17.0, -4.0],
    "north_hub":       [-2.0, -6.1],
    "nw_hub":          [-13.8, -6.1],
    "nwing_w":         [-20.75, -9.7],
    "nwing_c":         [-10.25, -9.7],
    "nwing_e":         [1.5, -9.2],
    "board_hub":       [7.6, -3.3],
    "eng_hub":         [10.0, 1.5],
    "east_hub":        [20.6, 1.5],
    "east_n":          [20.5, -3.0],
    # town square (area terbuka, tanpa dinding)
    "plaza_s":         [-2.0, 5.2],
    "plaza_c":         [-2.0, 1.25],
    "plaza_n":         [-2.0, -3.0],
    "plaza_w":         [-8.6, 1.0],
    "plaza_e":         [7.4, 1.0],
}

NAV_EDGES = [
    ("entrance", "hub_south"),
    ("hub_south", "plaza_s"),
    ("hub_south", "south_hub"),
    ("plaza_s", "plaza_c"),
    ("plaza_c", "plaza_n"),
    ("plaza_c", "plaza_w"),
    ("plaza_c", "plaza_e"),
    ("plaza_n", "north_hub"),
    ("plaza_w", "west_strip"),
    ("plaza_e", "board_hub"),
    ("plaza_e", "eng_hub"),
    ("north_hub", "nw_hub"),
    ("north_hub", "nwing_e"),
    ("nw_hub", "nwing_c"),
    ("nw_hub", "exp1_hub"),
    ("west_strip", "west_north"),
    ("west_strip", "south_hub"),
    ("west_north", "exp1_hub"),
    ("south_hub", "sw_hub"),
    ("south_hub", "door_expansion2"),
    ("sw_hub", "door_hrd"),
    ("door_hrd", "aisle_hrd"),
    ("nwing_c", "nwing_w"),
    ("nwing_c", "nwing_e"),
    ("nwing_c", "door_research"),
    ("nwing_w", "door_content"),
    ("nwing_e", "door_executive"),
    ("door_research", "aisle_research"),
    ("door_content", "aisle_content"),
    ("door_executive", "aisle_executive"),
    ("aisle_ops", "door_ops"),
    ("door_ops", "west_strip"),
    ("aisle_eng", "door_eng"),
    ("door_eng", "eng_hub"),
    ("board_hub", "door_board"),
    ("eng_hub", "east_hub"),
    ("east_hub", "east_n"),
    ("east_n", "door_expansion3"),
    ("exp1_hub", "door_expansion1"),
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


def _fit_desk_pattern(spec: dict) -> dict:
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
    count = ds["count"]
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


def _make_rooms() -> list[dict]:
    rooms = []
    for spec in _ROOM_SPECS:
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
            "nav": {"door": None, "aisle": None, "hub": spec["hub"]},
        }
        spec_door = _spec_door(spec)
        if spec_door:
            room["door"] = spec_door
            room["nav"]["door"] = "door_" + _NAV_SLUG[spec["id"]]
        if spec["desks"]:
            pattern = _fit_desk_pattern(spec)
            room["desks"] = _build_desks(pattern)
            aisle = _aisle_point(spec, pattern)
            if aisle:
                room["aisle"] = {"x": round(aisle[0], 3), "z": round(aisle[1], 3)}
                room["nav"]["aisle"] = "aisle_" + _NAV_SLUG[spec["id"]]
        rooms.append(room)
    return rooms


ROOMS = _make_rooms()

# Node pintu + node lorong meja diturunkan dari ruangan (bukan diketik
# manual), jadi /api/layout, frontend, dan pemeriksa selalu memakai
# angka yang sama.
NAV_NODES = dict(_NAV_CORRIDOR)
for _room in ROOMS:
    if _room["nav"]["door"]:
        _d = _room["door"]
        NAV_NODES[_room["nav"]["door"]] = [round(_d["x"], 3), round(_d["z"], 3)]
    if _room["nav"]["aisle"]:
        _a = _room["aisle"]
        NAV_NODES[_room["nav"]["aisle"]] = [round(_a["x"], 3), round(_a["z"], 3)]

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
AGENTS_BY_ID = {a["id"]: a for a in ROSTER}

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
MEETING_ROOM_ID = "board"
_MT_CX = ROOMS_BY_ID["board"]["x"] + 0.4      # 14.65 -- pusat meja
_MT_CZ = ROOMS_BY_ID["board"]["z"] + 0.2      # -3.05
_MT_HALF_LEN = 3.35                           # ujung stadio (5.2/2 + 0.75)
_MT_HALF_WID = 0.75                           # lebar meja
_SEAT_DX = (-2.1, -0.7, 0.7, 2.1)             # posisi kursi sisi
_SEAT_DZ = 1.15                               # jarak kursi sisi ke pusat meja
_SEAT_END = 3.62                              # kursi ujung, di luar ujung meja
_MEETING_ENTRY = (10.2, -3.25)                # titik masuk ruang board
_MEETING_LANE_S = -1.15                       # lorong berdiri sisi selatan
_MEETING_LANE_N = -5.15                       # lorong berdiri sisi utara
_MEETING_LANE_W = 10.2                        # lorong barat (dekat pintu)
_MEETING_LANE_E = 18.85                       # lorong timur


def meeting_layout() -> dict:
    """Kursi meja conferencing + jalur aman dari pintu ruang board.

    Dikirim ke frontend lewat /api/layout supaya tidak ada duplikasi
    angka yang bisa melenceng antara backend dan frontend.
    """
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
        x = _MT_CX + dx
        add(seats, x, _MT_CZ + _SEAT_DZ, 0.0, "south",
            (x, _MEETING_LANE_S),
            [(_MEETING_LANE_W, _MEETING_LANE_S), (x, _MEETING_LANE_S)], True)
    # Sisi utara: menghadap meja (arah hadap +z).
    for dx in _SEAT_DX:
        x = _MT_CX + dx
        add(seats, x, _MT_CZ - _SEAT_DZ, math.pi, "north",
            (x, _MEETING_LANE_N),
            [(_MEETING_LANE_W, _MEETING_LANE_N), (x, _MEETING_LANE_N)], True)
    # Ujung barat & timur: agent menghadap meja dari ujung meja.
    add(seats, _MT_CX - _SEAT_END, _MT_CZ, -math.pi / 2, "west",
        (_MEETING_LANE_W + 0.2, _MT_CZ), [(_MEETING_LANE_W + 0.2, _MT_CZ)], True)
    add(seats, _MT_CX + _SEAT_END, _MT_CZ, math.pi / 2, "east",
        (_MEETING_LANE_E, _MT_CZ),
        [(_MEETING_LANE_W, _MEETING_LANE_N),
         (_MEETING_LANE_E, _MEETING_LANE_N),
         (_MEETING_LANE_E, _MT_CZ)], True)
    # Cadangan: berdiri di belakang barisan kursi (kalau peserta > kursi).
    for x in (_MT_CX - 2.1, _MT_CX - 0.7, _MT_CX + 0.7, _MT_CX + 2.1):
        add(standing, x, _MT_CZ - 2.7, math.pi, "north-stand",
            (x, _MEETING_LANE_N),
            [(_MEETING_LANE_W, _MEETING_LANE_N), (x, _MEETING_LANE_N)], False)
    for x in (_MT_CX - 2.1, _MT_CX - 0.7, _MT_CX + 0.7, _MT_CX + 2.1):
        add(standing, x, _MT_CZ + 2.45, 0.0, "south-stand",
            (x, _MEETING_LANE_S),
            [(_MEETING_LANE_W, _MEETING_LANE_S), (x, _MEETING_LANE_S)], False)

    return {
        "room": MEETING_ROOM_ID,
        "entry": {"x": _MEETING_ENTRY[0], "z": _MEETING_ENTRY[1]},
        "table": {
            "x0": round(_MT_CX - _MT_HALF_LEN, 3),
            "x1": round(_MT_CX + _MT_HALF_LEN, 3),
            "z0": round(_MT_CZ - _MT_HALF_WID, 3),
            "z1": round(_MT_CZ + _MT_HALF_WID, 3),
        },
        "seats": seats,
        "standing": standing,
    }


def meeting_slots() -> list[dict]:
    """Semua slot peserta: kursi dulu, lalu titik berdiri cadangan."""
    layout = meeting_layout()
    return list(layout["seats"]) + list(layout["standing"])
MAX_GOAL = 400
MAX_ACCEPT = 300
MAX_ACCEPT_ITEMS = 12


def _assign_desks() -> dict:
    """Pasang tiap agent ke salah satu meja nyata di ruangannya.

    Meja diambil dari room['desks'] sesuai urutan slot di dalam ruangan, jadi
    posisi agent tidak pernah diketik manual dan selalu di dalam ruangan.
    """
    by_room: dict[str, list[dict]] = {}
    for agent in ROSTER:
        by_room.setdefault(agent["room"], []).append(agent)
    assigned: dict[str, dict | None] = {}
    for room in ROOMS:
        members = sorted(by_room.get(room["id"], []), key=lambda a: a["slot"])
        for i, agent in enumerate(members):
            assigned[agent["id"]] = room["desks"][i] if i < len(room["desks"]) else None
    return assigned


DESK_BY_AGENT = _assign_desks()


def _agent_meta(agent: dict) -> dict:
    """Gabungkan roster + geometri ruangan -> satu record siap dikirim ke UI."""
    room = ROOMS_BY_ID[agent["room"]]
    desk = DESK_BY_AGENT.get(agent["id"])
    pos = [desk["x"], 0, desk["z"]] if desk else [room["x"], 0, room["z"]]
    return {
        "id": agent["id"],
        "name": agent["name"],
        "role": agent["role"],
        "dept": agent["dept"],
        "dept_label": agent["dept_label"],
        "room": room["id"],
        "room_label": room["label"],
        "pos": pos,
        "chair": desk["chair"] if desk else None,
        "stand": desk["stand"] if desk else None,
        "desk_rot": desk["rot"] if desk else 0.0,
        "color": agent["color"],
        "accent": room["accent"],
        "slot": agent["slot"],
    }


LAYOUT_AGENTS = [_agent_meta(a) for a in ROSTER]
LAYOUT_AGENTS_BY_ID = {a["id"]: a for a in LAYOUT_AGENTS}


def _department_summary() -> list[dict]:
    order: list[str] = []
    for agent in LAYOUT_AGENTS:
        if agent["dept"] not in order:
            order.append(agent["dept"])
    out = []
    for dept in order:
        members = [a for a in LAYOUT_AGENTS if a["dept"] == dept]
        out.append({
            "id": dept,
            "label": members[0]["dept_label"],
            "room": members[0]["room"],
            "room_label": members[0]["room_label"],
            "agents": len(members),
            "accent": members[0]["accent"],
        })
    return out


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
            "started_by": str(data.get("started_by") or ""),
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

    def clear_meeting(self) -> bool:
        """Hapus board/meeting.json. True kalau file benar-benar hilang."""
        try:
            self._meeting_path.unlink()
            return True
        except FileNotFoundError:
            return False
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


def _headline(status_text: str) -> str:
    """Ambil satu baris paling informatif dari status.md untuk tooltip/roster."""
    if not status_text:
        return ""
    wanted = ("terakhir:", "sedang:", "blocker:")
    found = {}
    for line in status_text.splitlines():
        lowered = line.lower()
        for key in wanted:
            if lowered.startswith(key):
                value = line.split(":", 1)[1].strip().strip("-").strip()
                if value:
                    found[key] = value
    for key in ("sedang", "terakhir", "blocker"):
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


# ---------------------------------------------------------------------------
# Snapshot + cache + sidik jari perubahan (untuk SSE)
# ---------------------------------------------------------------------------
class Snapshot:
    def __init__(self, vault: Vault, ttl: float = 1.0):
        self.vault = vault
        self.ttl = ttl
        self._lock = threading.Lock()
        self._data: dict | None = None
        self._sig = ""
        self._ts = 0.0
        self._scans = 0

    def get(self, force: bool = False) -> tuple[dict, str]:
        with self._lock:
            now = time.time()
            if not force and self._data is not None and (now - self._ts) < self.ttl:
                return self._data, self._sig

            agents = []
            fp: list = []
            counts = {s: 0 for s in STATES}
            meeting = self.vault.meeting()
            slots = meeting_slots()
            meeting_ids: dict[str, int] = {}
            if meeting:
                for i, pid in enumerate(meeting.get("participants", [])):
                    if pid in AGENTS_BY_ID and i < len(slots):
                        meeting_ids[pid] = i
            fp.append(("meeting", meeting.get("topic", "") if meeting else "",
                       ",".join(meeting.get("participants", [])) if meeting else ""))
            for meta in LAYOUT_AGENTS:
                status = self.vault.status(meta["id"])
                if meta["id"] in meeting_ids:
                    status["state"] = "meeting"
                    status["meeting_room"] = MEETING_ROOM_ID
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

            self._scans += 1
            data = {
                "generated_at": _now_iso(),
                "vault": str(self.vault.root),
                "counts": {
                    "agents": len(agents),
                    "departments": len({a["dept"] for a in agents if a["dept"] != "executive"}),
                    "rooms": len(ROOMS),
                    "idle": counts.get("idle", 0),
                    "working": counts.get("working", 0),
                    "blocked": counts.get("blocked", 0),
                    "meeting": counts.get("meeting", 0),
                },
                "meeting": meeting,
                "agents": agents,
            }
            self._data = data
            self._sig = hashlib.sha1(json.dumps(fp, sort_keys=True).encode()).hexdigest()
            self._ts = now
            return data, self._sig

    @property
    def scans(self) -> int:
        with self._lock:
            return self._scans


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
class OfficeHandler(SimpleHTTPRequestHandler):
    server_version = "Office3D/2.0"
    sys_version = ""
    protocol_version = "HTTP/1.0"

    vault: Vault
    snapshot: Snapshot
    started: float
    verbose: bool

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(self.web_root), **kwargs)

    # -- header umum (CORS + cache) ----------------------------------------
    def end_headers(self):
        path = urllib.parse.urlparse(self.path).path
        if path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("X-Content-Type-Options", "nosniff")
        elif path.endswith(("/", ".html")):
            self.send_header("Cache-Control", "no-cache")
        else:
            self.send_header("Cache-Control", "public, max-age=300")
        super().end_headers()

    def log_message(self, fmt, *args):
        if self.verbose:
            super().log_message(fmt, *args)

    def log_error(self, fmt, *args):
        super().log_error(fmt, *args)

    # -- util --------------------------------------------------------------
    def _json(self, obj, status: int = 200):
        body = json.dumps(obj, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, message: str):
        self._json({"success": False, "error": message, "status": status}, status)

    # -- GET ---------------------------------------------------------------
    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            if path == "/api/health":
                self._api_health()
            elif path == "/api/layout":
                self._api_layout()
            elif path == "/api/agents":
                self._api_agents()
            elif path == "/api/meeting":
                self._api_meeting()
            elif path == "/api/stream":
                self._api_stream()
            elif path.startswith("/api/agent/"):
                agent_id = urllib.parse.unquote(path[len("/api/agent/"):]).strip("/")
                self._api_agent(agent_id)
            elif path.startswith("/api/"):
                self._error(404, f"endpoint API tidak dikenal: {path}")
            else:
                super().do_GET()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_HEAD(self):
        # Static saja; API tidak punya representasi HEAD yang berguna.
        if urllib.parse.urlparse(self.path).path.startswith("/api/"):
            self.send_response(405)
            self.send_header("Allow", "GET, POST, OPTIONS")
            self.end_headers()
        else:
            super().do_HEAD()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    # -- POST --------------------------------------------------------------
    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        handlers = {
            "/api/task": self._create_task,
            "/api/meeting/start": self._meeting_start,
            "/api/meeting/end": self._meeting_end,
        }
        handler = handlers.get(path)
        if handler is None:
            self._error(404, f"endpoint API tidak dikenal: {path}")
            return
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            self._error(400, "Content-Length tidak valid")
            return
        if length <= 0 or length > 64 * 1024:
            self._error(400, "body kosong atau terlalu besar (maks 64 KB)")
            return
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._error(400, f"JSON tidak valid: {exc}")
            return
        if not isinstance(payload, dict):
            self._error(400, "body harus objek JSON")
            return
        try:
            result = handler(payload)
        except ValueError as exc:
            self._error(400, str(exc))
            return
        except Exception as exc:  # noqa: BLE001 - jangan matikan server karena satu request
            self._error(500, f"{type(exc).__name__}: {exc}")
            return
        self._json(result, 200)

    # -- handlers ----------------------------------------------------------
    def _api_health(self):
        data, sig = self.snapshot.get()
        self._json({
            "status": "ok",
            "service": self.server_version,
            "vault": str(self.vault.root),
            "port": self.server.server_address[1],
            "uptime_seconds": round(time.time() - self.started, 1),
            "counts": data["counts"],
            "signature": sig[:12],
            "scans": self.snapshot.scans,
            "time": _now_iso(),
        })

    def _api_layout(self):
        self._json({
            "vault": str(self.vault.root),
            "building": BUILDING,
            "rooms": ROOMS,
            "playground": ROOMS_BY_ID.get("playground"),
            "nav": {"nodes": NAV_NODES, "edges": [list(e) for e in NAV_EDGES]},
            "agents": LAYOUT_AGENTS,
            "departments": _department_summary(),
            "meeting": meeting_layout(),
            "counts": {
                "agents": len(LAYOUT_AGENTS),
                "departments": len(_department_summary()) - 1,  # executive bukan departemen
                "rooms": len(ROOMS),
                "nav_nodes": len(NAV_NODES),
                "nav_edges": len(NAV_EDGES),
                "meeting_seats": len(meeting_slots()),
            },
        })

    def _api_meeting(self):
        meeting = self.vault.meeting()
        self._json({
            "success": True,
            "path": "board/meeting.json",
            "meeting": meeting,
            "slots": len(meeting_slots()),
            "time": _now_iso(),
        })

    def _api_agents(self):
        data, _ = self.snapshot.get()
        self._json(data)

    def _api_agent(self, agent_id: str):
        if agent_id not in AGENTS_BY_ID:
            self._error(404, f"agent '{agent_id}' tidak ada di roster")
            return
        status = self.vault.status(agent_id)
        meeting = self.vault.meeting()
        if meeting and agent_id in meeting.get("participants", []):
            idx = meeting["participants"].index(agent_id)
            status["state"] = "meeting"
            status["meeting_room"] = MEETING_ROOM_ID
            status["meeting_topic"] = meeting.get("topic", "")
            status["meeting_seat"] = idx if idx < len(meeting_slots()) else -1
        self._json({**LAYOUT_AGENTS_BY_ID[agent_id], **status})

    def _api_stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        last_sig = ""
        last_ping = time.time()
        try:
            self.wfile.write(b"retry: 3000\n\n")
            self.wfile.flush()
            while True:
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

    # -- POST /api/meeting/start -------------------------------------------
    def _meeting_start(self, req: dict) -> dict:
        """Mulai rapat: tulis board/meeting.json lalu segarkan snapshot."""
        participants = req.get("participants")
        if isinstance(participants, str):
            participants = [participants]
        if not isinstance(participants, list) or not participants:
            raise ValueError("'participants' wajib diisi: list id agent")
        ids: list[str] = []
        for raw in participants:
            pid = str(raw).strip()
            if not pid:
                continue
            if pid not in AGENTS_BY_ID:
                raise ValueError(f"participant '{pid}' bukan agent di roster")
            if pid not in ids:
                ids.append(pid)
        if not ids:
            raise ValueError("tidak ada participant yang valid")
        data = {
            "status": "active",
            "topic": " ".join(str(req.get("topic") or "").split())[:200],
            "participants": ids,
            "room": MEETING_ROOM_ID,
            "started_at": _now_iso(),
            "started_by": " ".join(str(req.get("from") or "api").split())[:40] or "api",
        }
        path = self.vault.write_meeting(data)
        # Snapshot berikutnya harus langsung mencerminkan rapat baru.
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
        if target not in AGENTS_BY_ID:
            raise ValueError(f"target '{target}' bukan agent di roster")
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
            "command": cmd,
        }
        if dry_run:
            result["output"] = "(dry_run: tidak ada file ditulis)"
            return result

        if not self.vault.swarm.is_file():
            raise RuntimeError(f"swarm.py tidak ditemukan di {self.vault.swarm}")
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
            raise RuntimeError(
                f"swarm.py selesai tapi file tugas tidak ditemukan. stdout={proc.stdout.strip()[:300]!r}"
            )
        result["path"] = created
        result["output"] = (proc.stdout or "").strip()
        # Snapshot berikutnya harus langsung mencerminkan tugas baru.
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
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Kantor Digital 3D server")
    parser.add_argument("--port", type=int, default=int(os.environ.get("OFFICE_PORT", "3000")),
                        help="port HTTP (default 3000, env OFFICE_PORT)")
    parser.add_argument("--host", default=os.environ.get("OFFICE_HOST", "0.0.0.0"),
                        help="alamat bind (default 0.0.0.0)")
    parser.add_argument("--vault", default=os.environ.get("OFFICE_VAULT", str(DEFAULT_VAULT)),
                        help="root vault (default /opt/data/company)")
    parser.add_argument("--webroot", default=os.environ.get("OFFICE_WEBROOT", ""),
                        help="folder web (default <vault>/office_ui)")
    parser.add_argument("--verbose", action="store_true", help="log setiap request")
    return parser


def make_server(args) -> ThreadingHTTPServer:
    vault_root = Path(args.vault).expanduser().resolve()
    if not vault_root.is_dir():
        raise SystemExit(f"vault tidak ditemukan: {vault_root}")
    web_root = Path(args.webroot).expanduser().resolve() if args.webroot else vault_root / "office_ui"
    if not (web_root / "index.html").is_file():
        raise SystemExit(f"index.html tidak ditemukan di {web_root}")

    handler = type("BoundOfficeHandler", (OfficeHandler,), {
        "web_root": web_root,
        "vault": Vault(vault_root),
        "snapshot": Snapshot(Vault(vault_root)),
        "started": time.time(),
        "verbose": args.verbose,
    })
    # Vault dipakai dua kali (handler + snapshot) -- satukan supaya konsisten.
    handler.snapshot = Snapshot(handler.vault)

    server = ThreadingHTTPServer((args.host, args.port), handler)
    server.daemon_threads = True
    return server


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        server = make_server(args)
    except OSError as exc:
        print(f"[-] gagal bind {args.host}:{args.port}: {exc}", file=sys.stderr)
        return 1

    layout = _department_summary()
    print(f"[*] Kantor Digital 3D v3 aktif di http://localhost:{server.server_address[1]}")
    print(f"    vault      : {args.vault}")
    print(f"    webroot    : {Path(args.webroot).resolve() if args.webroot else Path(args.vault) / 'office_ui'}")
    print(f"    {len(ROOMS)} zona / {len(layout) - 1} departemen / {len(ROSTER)} meja agent")
    print(f"    navigasi   : {len(NAV_NODES)} waypoint / {len(NAV_EDGES)} edge koridor")
    print(f"    health     : /api/health  |  layout: /api/layout  |  stream: /api/stream")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[*] dihentikan.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
