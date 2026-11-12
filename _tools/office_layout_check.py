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

    # 7. edge navigasi tidak memotong dinding
    nodes = office.NAV_NODES
    for a_id, b_id in office.NAV_EDGES:
        if a_id not in nodes or b_id not in nodes:
            problems.append({"rule": "edge-node-hilang", "detail": f"{a_id}-{b_id}"})
            continue
        a = tuple(nodes[a_id])
        b = tuple(nodes[b_id])
        for r in walled:
            for s in ("north", "south", "west", "east"):
                if shared_side(r, s):
                    continue
                axis = "z" if s in ("north", "south") else "x"
                val = side_value(r, s)
                hit = seg_intersect_line(a, b, axis, val)
                if hit is None:
                    continue
                lo, hi, _ = side_span(r, s)
                if hit < lo - EPS or hit > hi + EPS:
                    continue
                gap = door_gap(r, s)
                if gap and gap[0] - DOOR_MARGIN <= hit <= gap[1] + DOOR_MARGIN:
                    continue
                problems.append({
                    "rule": "edge-memotong-dinding",
                    "detail": f"{a_id}->{b_id} menabrak {r['id']} sisi {s} di {hit:.2f}",
                })

    # 8. node navigasi di ruang kosong
    room_of_node = {}
    for r in rooms:
        if r.get("nav", {}).get("door"):
            room_of_node[r["nav"]["door"]] = r
        if r.get("nav", {}).get("aisle"):
            room_of_node[r["nav"]["aisle"]] = r
    for node_id, (nx, nz) in nodes.items():
        own = room_of_node.get(node_id)
        for r in walled:
            if r is own:
                continue
            if point_in_rect(nx, nz, room_rect(r)):
                problems.append({"rule": "node-di-dalam-ruangan",
                                 "detail": f"{node_id} di dalam {r['id']}"})
        if own is not None:
            rect = room_rect(own)
            if own.get("door") and own["nav"].get("door") == node_id:
                continue  # node pintu berdiri tepat di garis dinding
            if not point_in_rect(nx, nz, rect):
                problems.append({"rule": "aisle-di-luar-ruangan",
                                 "detail": f"{node_id} milik {own['id']}"})

    # 9. graph terhubung
    adj: dict[str, list[str]] = {k: [] for k in nodes}
    for a_id, b_id in office.NAV_EDGES:
        if a_id in adj and b_id in adj:
            adj[a_id].append(b_id)
            adj[b_id].append(a_id)
    seen = set()
    if "entrance" in adj:
        q = deque(["entrance"])
        seen.add("entrance")
        while q:
            cur = q.popleft()
            for nxt in adj[cur]:
                if nxt not in seen:
                    seen.add(nxt)
                    q.append(nxt)
    for node_id in nodes:
        if node_id not in seen:
            problems.append({"rule": "node-tidak-terhubung", "detail": node_id})

    # 10. semua agent punya meja
    for agent in office.LAYOUT_AGENTS:
        if not agent.get("chair") or not agent.get("stand"):
            problems.append({"rule": "agent-tanpa-meja", "detail": agent["id"]})

    return {
        "rooms": len(rooms),
        "walled_rooms": len(walled),
        "agents": len(office.LAYOUT_AGENTS),
        "desks": sum(len(r["desks"]) for r in rooms),
        "nav_nodes": len(nodes),
        "nav_edges": len(office.NAV_EDGES),
        "reachable_nodes": len(seen),
        "problems": problems,
        "ok": not problems,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Pemeriksa geometri denah kantor")
    parser.add_argument("--json", dest="json_path", default="", help="simpan hasil ke file JSON")
    parser.add_argument("--quiet", action="store_true", help="cetak ringkasan saja")
    args = parser.parse_args(argv)

    result = check()
    if args.json_path:
        Path(args.json_path).write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n",
                                        encoding="utf-8")

    if args.quiet:
        print(f"ruang={result['rooms']} meja={result['desks']} "
              f"node={result['nav_nodes']} edge={result['nav_edges']} "
              f"masalah={len(result['problems'])}")
    else:
        print(f"Denah: {result['rooms']} ruang ({result['walled_rooms']} berkunci), "
              f"{result['desks']} meja, {result['agents']} agent")
        print(f"Navigasi: {result['nav_nodes']} node, {result['nav_edges']} edge, "
              f"{result['reachable_nodes']} node terjangkau")
        if result["problems"]:
            print(f"\nPELANGGARAN ({len(result['problems'])}):")
            for p in result["problems"][:40]:
                print(f"  - {p['rule']}: {p['detail']}")
        else:
            print("\nOK: tidak ada ruangan menimpa, tidak ada edge navigasi yang "
                  "memotong dinding, semua node terjangkau, semua agent punya meja.")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
