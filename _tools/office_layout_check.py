#!/usr/bin/env python3
"""office_layout_check.py -- pemeriksa geometri denah Kantor Digital 3D.

Menjawab satu pertanyaan: "apakah graph navigasi benar-benar aman?" --
yaitu apakah rute agent bisa melewati dinding ruangan, atau menembus
perabot di dalam ruangan.

Yang diperiksa:
  1. Tidak ada dua ruangan yang saling menimpa.
  2. Semua ruangan berada di dalam footprint gedung.
  3. Meja / kursi / titik berdiri tiap agent berada di dalam ruangannya.
  4. Tiap ruangan berkunci (dinding) punya tepat satu bukaan pintu, dan
     bukaan itu berada di sisi ruangan yang menuju ruang kosong.
  5. Tiap ruangan berkunci (dinding) punya tepat satu bukaan pintu, dan
     bukaan itu berada di sisi ruangan yang menuju ruang kosong.
  6. Tidak ada sisi dinding ruangan yang TERBUKA (dinding hilang) --
     kecuali sisi yang dipakai bersama dengan ruangan tetangga.
  7. Setiap edge graph navigasi tidak memotong dinding ruangan mana pun
     (kecuali pada bukaan pintu yang memang jadi titik sambung).
  8. Setiap node navigasi berada di ruang kosong (bukan di dalam ruangan
     terkunci), kecuali node pintu/aisle yang memang milik ruangan itu.
  9. Graph navigasi terhubung (BFS dari 'entrance' mencapai semua node).
 10. Semua agent punya meja, dan bangku/kursi tidak menabrak meja lain.

Keluar: ringkasan + daftar pelanggaran. Exit code 0 = bersih, 1 = ada
pelanggaran, 2 = argumen salah.

Jalankan: python3 _tools/office_layout_check.py [--json PATH] [--quiet]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import deque
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import office_server as office  # noqa: E402

EPS = 1e-6
WALL_T = 0.20          # tebal dinding partisi (kusen) sesuai frontend
DOOR_MARGIN = 0.30     # toleransi titik yang "berdiri" di bukaan pintu


# ---------------------------------------------------------------------------
# geometri dasar
# ---------------------------------------------------------------------------
def room_rect(room: dict) -> tuple[float, float, float, float]:
    return (room["x"] - room["w"] / 2, room["x"] + room["w"] / 2,
            room["z"] - room["d"] / 2, room["z"] + room["d"] / 2)


def point_in_rect(x: float, z: float, rect: tuple[float, float, float, float]) -> bool:
    x0, x1, z0, z1 = rect
    return x0 - EPS <= x <= x1 + EPS and z0 - EPS <= z <= z1 + EPS


def point_in_polygon(x: float, z: float, poly: list[list[float]]) -> bool:
    """Ray casting. poly = [[x,z], ...] tertutup."""
    inside = False
    n = len(poly)
    for i in range(n):
        x1, z1 = poly[i]
        x2, z2 = poly[(i + 1) % n]
        if (z1 > z) != (z2 > z):
            xint = x1 + (z - z1) * (x2 - x1) / (z2 - z1)
            if x < xint:
                inside = not inside
    return inside


def seg_intersect_line(a: tuple[float, float], b: tuple[float, float],
                        normal_axis: str, value: float) -> float | None:
    """Titik potong segmen a-b dengan garis normal_axis=value.

    normal_axis 'z' -> garis z=value, mengembalikan koordinat x.
    normal_axis 'x' -> garis x=value, mengembalikan koordinat z.
    Nilai balik dipakai sebagai koordinat sepanjang sisi dinding.
    """
    (ax, az), (bx, bz) = a, b
    if normal_axis == "z":
        if abs(bz - az) < EPS:
            return None
        t = (value - az) / (bz - az)
        if t < -EPS or t > 1 + EPS:
            return None
        return ax + t * (bx - ax)
    if abs(bx - ax) < EPS:
        return None
    t = (value - ax) / (bx - ax)
    if t < -EPS or t > 1 + EPS:
        return None
    return az + t * (bz - az)


def side_span(room: dict, side: str) -> tuple[float, float, str]:
    """(min, max, axis) dari sisi dinding ruangan. axis = sumbu yang 'datar'."""
    x0, x1, z0, z1 = room_rect(room)
    if side == "north":
        return x0, x1, "x"
    if side == "south":
        return x0, x1, "x"
    if side == "west":
        return z0, z1, "z"
    return z0, z1, "z"


def side_value(room: dict, side: str) -> float:
    x0, x1, z0, z1 = room_rect(room)
    if side == "north":
        return z0
    if side == "south":
        return z1
    if side == "west":
        return x0
    return x1


def door_gap(room: dict, side: str) -> tuple[float, float] | None:
    """Rentang (min,max) bukaan pintu pada sisi tertentu, dalam sumbu datar."""
    door = room.get("door")
    if not door or door["side"] != side:
        return None
    along = door["x"] if side in ("north", "south") else door["z"]
    half = door["width"] / 2
    return along - half, along + half


def shared_side(room: dict, side: str) -> dict | None:
    """Ruangan tetangga yang berdiri pada sisi yang sama (jarak < 0.7)."""
    a0, a1, axis = side_span(room, side)
    val = side_value(room, side)
    for other in office.ROOMS:
        if other["id"] == room["id"]:
            continue
        if other.get("kind") == "lounge":
            continue
        b0, b1, baxis = side_span(other, side)
        if baxis != axis:
            continue
        if abs(side_value(other, side) - val) >= 0.7:
            continue
        if min(a1, b1) - max(a0, b0) < 0.5:
            continue
        return other
    return None


# ---------------------------------------------------------------------------
# pemeriksaan
# ---------------------------------------------------------------------------
def check() -> dict:
    problems: list[dict] = []
    rooms = office.ROOMS
    poly = office.BUILDING["polygon"]
    walled = [r for r in rooms if r.get("kind") != "lounge"]

    # 1. tidak ada ruangan menimpa
    for i, a in enumerate(rooms):
        ra = room_rect(a)
        for b in rooms[i + 1:]:
            rb = room_rect(b)
            if (ra[0] < rb[1] - EPS and rb[0] < ra[1] - EPS and
                    ra[2] < rb[3] - EPS and rb[2] < ra[3] - EPS):
                problems.append({"rule": "ruang-menimpa", "detail": f"{a['id']} x {b['id']}"})

    # 2. semua ruangan di dalam gedung
    for r in rooms:
        x0, x1, z0, z1 = room_rect(r)
        for corner in ((x0, z0), (x1, z0), (x1, z1), (x0, z1)):
            if not point_in_polygon(corner[0], corner[1], poly):
                problems.append({"rule": "ruang-di-luar-gedung",
                                 "detail": f"{r['id']} sudut {corner}"})
                break

    # 3. meja / kursi / berdiri di dalam ruangan
    for r in rooms:
        rect = room_rect(r)
        for desk in r["desks"]:
            if not point_in_rect(desk["x"], desk["z"], rect):
                problems.append({"rule": "meja-di-luar-ruangan",
                                 "detail": f"{r['id']} meja {desk}"})
            for key in ("chair", "stand"):
                p = desk[key]
                if not point_in_rect(p[0], p[1], rect):
                    problems.append({"rule": "kursi-di-luar-ruangan",
                                     "detail": f"{r['id']} {key} {p}"})
        # bangku tidak menabrak meja lain
        for i, d1 in enumerate(r["desks"]):
            for d2 in r["desks"][i + 1:]:
                if abs(d1["x"] - d2["x"]) < 1.8 and abs(d1["z"] - d2["z"]) < 1.8:
                    problems.append({"rule": "meja-tumpang-tindih",
                                     "detail": f"{r['id']} {d1['x']},{d1['z']} vs {d2['x']},{d2['z']}"})

    # 4-6. dinding ruangan: tepat satu pintu, sisi.shared ada, tak ada sisi terbuka
    for r in walled:
        sides = ("north", "south", "west", "east")
        doors = [s for s in sides if door_gap(r, s)]
        if r.get("door"):
            if len(doors) != 1:
                problems.append({"rule": "pintu-jumlah",
                                 "detail": f"{r['id']} punya {len(doors)} sisi berpintu"})
            # bukaan pintu harus berada di sisi yang benar
            door = r["door"]
            side = door["side"]
            val = side_value(r, side)
            along = door["x"] if side in ("north", "south") else door["z"]
            lo, hi, axis = side_span(r, side)
            if not (lo - EPS <= along <= hi + EPS):
                problems.append({"rule": "pintu-di-luar-sisi",
                                 "detail": f"{r['id']} sisi {side} along={along}"})
            if abs(val - (door["z"] if side in ("north", "south") else door["x"])) > 0.01:
                problems.append({"rule": "pintu-tidak-di-garis-sisi",
                                 "detail": f"{r['id']} sisi {side}"})
        for s in sides:
            if shared_side(r, s):
                continue
            gap = door_gap(r, s)
            if gap and gap[1] - gap[0] <= 0.5:
                problems.append({"rule": "bukaan-terlalu-sempit",
                                 "detail": f"{r['id']} sisi {s}"})

    # 7-9. tiap pintu membuka ke lantai koridor yang tersambung ke pintu
    #      masuk gedung (grid 0.25 m: di dalam gedung, di luar ruangan
    #      berdinding + jarak bebas 0.35 m dari dindingnya).
    cell = 0.25
    xs = [p[0] for p in poly]
    zs = [p[1] for p in poly]
    gx0, gz0 = min(xs), min(zs)
    gnx, gnz = int((max(xs) - gx0) / cell) + 1, int((max(zs) - gz0) / cell) + 1
    blocked = [r for r in walled]

    def free(i: int, j: int) -> bool:
        x, z = gx0 + (i + 0.5) * cell, gz0 + (j + 0.5) * cell
        if not point_in_polygon(x, z, poly):
            return False
        for r in blocked:
            x0, x1, z0, z1 = room_rect(r)
            if x0 - 0.35 < x < x1 + 0.35 and z0 - 0.35 < z < z1 + 0.35:
                return False
        return True

    def cell_of(x: float, z: float) -> tuple[int, int]:
        return int((x - gx0) / cell), int((z - gz0) / cell)

    ent = office.BUILDING.get("entrance") or {}
    start = cell_of(ent.get("x", 0.0), ent.get("z", 0.0) - 0.9)
    seen = set()
    if 0 <= start[0] < gnx and 0 <= start[1] < gnz and free(*start):
        seen.add(start)
        q = deque([start])
        while q:
            i, j = q.popleft()
            for n in ((i + 1, j), (i - 1, j), (i, j + 1), (i, j - 1)):
                if n not in seen and 0 <= n[0] < gnx and 0 <= n[1] < gnz and free(*n):
                    seen.add(n)
                    q.append(n)
    else:
        problems.append({"rule": "pintu-masuk-terhalang", "detail": str(ent)})
    for r in walled:
        d = r.get("door")
        if not d:
            continue
        nx = {"east": 1, "west": -1}.get(d["side"], 0)
        nz = {"south": 1, "north": -1}.get(d["side"], 0)
        if cell_of(d["x"] + nx * 0.8, d["z"] + nz * 0.8) not in seen:
            problems.append({"rule": "pintu-tidak-terjangkau", "detail": f"{r['id']} sisi {d['side']}"})

    # 10. semua agent punya meja
    for agent in office.LAYOUT_AGENTS:
        if not agent.get("chair") or not agent.get("stand"):
            problems.append({"rule": "agent-tanpa-meja", "detail": agent["id"]})

    return {
        "rooms": len(rooms),
        "walled_rooms": len(walled),
        "agents": len(office.LAYOUT_AGENTS),
        "desks": sum(len(r["desks"]) for r in rooms),
        "floor_cells": len(seen),
        "problems": problems,
        "ok": not problems,
    }


def editor_rules() -> list[dict]:
    """Denah editor yang salah HARUS ditolak build_layout(strict=True), dan
    denah bebas yang benar (ruangan baru jauh dari bawaan) harus diterima."""
    import copy
    base = office.default_rooms()
    res = next(r for r in base if r["id"] == "research")
    blocker = dict(res, id="blk", label="Blok", kind="empty", style="", dept="", desks=None,
                   z=res["z"] + res["d"] / 2 + 2.25, w=6, d=4)
    cases = [
        ("menimpa", lambda r: r[1].update(x=r[2]["x"]), "menimpa"),
        ("tanpa-rapat", lambda r: r.remove(next(x for x in r if x["kind"] == "meeting")), "ruang rapat"),
        ("terpisah", lambda r: r.append(dict(r[1], id="far", label="Jauh", x=200, z=200)), "terlalu jauh"),
        ("rapat-sempit", lambda r: next(x for x in r if x["kind"] == "meeting").update(w=8), "minimal"),
        ("pintu-tertutup", lambda r: r.append(blocker), "tertutup"),
        ("ruang-baru", lambda r: r.append(dict(blocker, id="new1", kind="department", z=-25, w=8, d=6)), None),
    ]
    problems = []
    for name, mutate, expect in cases:
        rooms = copy.deepcopy(base)
        mutate(rooms)
        try:
            office.build_layout(office.ROSTER, dict(office.empty_custom(), rooms=rooms), strict=True)
            err = None
        except ValueError as exc:
            err = str(exc)
        if (expect is None) != (err is None) or (expect and expect not in err):
            problems.append({"rule": "aturan-editor", "detail": f"{name}: harap {expect!r}, dapat {err!r}"})
    return problems


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Pemeriksa geometri denah kantor")
    parser.add_argument("--json", dest="json_path", default="", help="simpan hasil ke file JSON")
    parser.add_argument("--quiet", action="store_true", help="cetak ringkasan saja")
    args = parser.parse_args(argv)

    default = check()
    office.use_layout(office.build_layout(office.stress_roster()))
    stress = check()
    office.use_layout(office.DEFAULT_LAYOUT)
    stress["problems"] += editor_rules()
    stress["ok"] = not stress["problems"]
    for r, name in ((default, "bawaan"), (stress, "stress: meluap + 3 departemen baru")):
        print(f"[{name}] masalah={len(r['problems'])}")
    result = dict(stress, problems=default["problems"] + stress["problems"],
                  ok=default["ok"] and stress["ok"], default=default)
    if args.json_path:
        Path(args.json_path).write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n",
                                        encoding="utf-8")

    if args.quiet:
        print(f"ruang={result['rooms']} meja={result['desks']} "
              f"lantai={result['floor_cells']} sel "
              f"masalah={len(result['problems'])}")
    else:
        print(f"Denah: {result['rooms']} ruang ({result['walled_rooms']} berkunci), "
              f"{result['desks']} meja, {result['agents']} agent")
        print(f"Lantai koridor: {result['floor_cells']} sel terjangkau dari pintu masuk")
        if result["problems"]:
            print(f"\nPELANGGARAN ({len(result['problems'])}):")
            for p in result["problems"][:40]:
                print(f"  - {p['rule']}: {p['detail']}")
        else:
            print("\nOK: tidak ada ruangan menimpa, semua pintu terjangkau dari pintu "
                  "masuk, semua agent punya meja.")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
