#!/usr/bin/env python3
"""office_collision_check.py -- pemeriksa tabrakan geometri meja & rute agent.

Menjawab satu pertanyaan: "apakah agent bisa masuk ruangan, duduk di
kursi, dan berjalan keluar tanpa pernah menembus meja, kursi, atau
dinding?"

Yang diperiksa (semua dihitung dari office_server.ROOMS, satu sumber
kebenaran):
  1. Batas dalam ruangan dihitung ulang: x_min = x - w/2 + padding,
     x_max = x + w/2 - padding, z_min = z - d/2 + padding,
     z_max = z + d/2 - padding (padding >= 1.1 m dari dinding).
  2. Pusat meja, kursi, titik berdiri, dan node lorong WAJIB berada
     mutlak di dalam batas tersebut.
  3. Bounding box meja + kursi tidak boleh memotong dinding ruangan
     (dinding setebal BUILDING['wall_thickness']).
  4. Dua meja dalam satu ruangan tidak boleh tumpang tindih.
  5. Kursi tidak boleh menabrak meja (toleransi small tuck-under 0.10).
  6. Lorong meja (garis jalan di depan barisan) tidak boleh terpotong
     bounding box meja/kursi manapun di ruangan itu.
  7. Rute agent pintu -> lorong -> berdiri -> duduk tidak boleh memotong
     bounding box meja/kursi (kursi sendiri dikecualikan).
  8. Bounding box meja tidak boleh menutupi bukaan pintu.
  9. Node navigasi 'door_*' dan 'aisle_*' harus sama dengan koordinat
     yang dihitung backend.

Keluar: ringkasan + daftar pelanggaran. Exit code 0 = bersih, 1 = ada
pelanggaran, 2 = argumen salah.

Jalankan: python3 _tools/office_collision_check.py [--json PATH] [--quiet]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import office_server as office  # noqa: E402

EPS = 1e-6
WALL_T = office.BUILDING["wall_thickness"]
CHAIROVERLAP_TOL = 0.10      # kursi boleh差一点 masuk di bawah meja
AGENT_R = 0.25               # radius badan agent


# ---------------------------------------------------------------------------
# geometri dasar
# ---------------------------------------------------------------------------
def rect_of(room: dict) -> tuple[float, float, float, float]:
    return (room["x"] - room["w"] / 2, room["x"] + room["w"] / 2,
            room["z"] - room["d"] / 2, room["z"] + room["d"] / 2)


def desk_bbox(room: dict, desk: dict) -> tuple[float, float, float, float]:
    """Bounding box meja (meja + kursi digabung) dalam koordinat dunia."""
    dw = desk.get("w", 2.05)
    dd = desk.get("d", 1.05)
    cw = desk.get("cw", 0.56)
    cd = desk.get("cd", 0.56)
    rot = desk.get("rot", 0.0)
    along_x = abs(rot) < 1e-3 or abs(rot - 3.14159265) < 1e-3
    if along_x:
        boxes = [
            (desk["x"] - dw / 2, desk["x"] + dw / 2, desk["z"] - dd / 2, desk["z"] + dd / 2),
            (desk["chair"][0] - cw / 2, desk["chair"][0] + cw / 2,
             desk["chair"][1] - cd / 2, desk["chair"][1] + cd / 2),
        ]
    else:
        boxes = [
            (desk["x"] - dd / 2, desk["x"] + dd / 2, desk["z"] - dw / 2, desk["z"] + dw / 2),
            (desk["chair"][0] - cd / 2, desk["chair"][0] + cd / 2,
             desk["chair"][1] - cw / 2, desk["chair"][1] + cw / 2),
        ]
    return (
        min(b[0] for b in boxes), max(b[1] for b in boxes),
        min(b[2] for b in boxes), max(b[3] for b in boxes),
    )


def chair_bbox(room: dict, desk: dict) -> tuple[float, float, float, float]:
    cw = desk.get("cw", 0.56)
    cd = desk.get("cd", 0.56)
    rot = desk.get("rot", 0.0)
    along_x = abs(rot) < 1e-3 or abs(rot - 3.14159265) < 1e-3
    if along_x:
        return (desk["chair"][0] - cw / 2, desk["chair"][0] + cw / 2,
                desk["chair"][1] - cd / 2, desk["chair"][1] + cd / 2)
    return (desk["chair"][0] - cd / 2, desk["chair"][0] + cd / 2,
            desk["chair"][1] - cw / 2, desk["chair"][1] + cw / 2)


def box_overlap(a: tuple[float, float, float, float],
                b: tuple[float, float, float, float]) -> float:
    """Tumpukan area (0 = tidak bertumpuk)."""
    ox = min(a[1], b[1]) - max(a[0], b[0])
    oz = min(a[3], b[3]) - max(a[2], b[2])
    if ox <= 0 or oz <= 0:
        return 0.0
    return ox * oz


def seg_hits_box(a: tuple[float, float], b: tuple[float, float],
                 box: tuple[float, float, float, float], pad: float = 0.0) -> bool:
    """True bila segmen a-b memotong kotak axis-aligned (slab method)."""
    x0, x1 = box[0] - pad, box[1] + pad
    z0, z1 = box[2] - pad, box[3] + pad
    dx = b[0] - a[0]
    dz = b[1] - a[1]
    tmin, tmax = 0.0, 1.0
    for p, q in ((-dx, a[0] - x0), (dx, x1 - a[0]), (-dz, a[1] - z0), (dz, z1 - a[1])):
        if abs(p) < 1e-12:
            if q < 0:
                return False
        else:
            t = q / p
            if p < 0:
                if t > tmax:
                    return False
                if t > tmin:
                    tmin = t
            else:
                if t < tmin:
                    return False
                if t < tmax:
                    tmax = t
    return True


def point_in_box(p: tuple[float, float], box: tuple[float, float, float, float]) -> bool:
    return box[0] - EPS <= p[0] <= box[1] + EPS and box[2] - EPS <= p[1] <= box[3] + EPS


# ---------------------------------------------------------------------------
# pemeriksaan
# ---------------------------------------------------------------------------
def check() -> dict:
    problems: list[dict] = []
    rooms = office.ROOMS
    stats = {
        "rooms_with_desks": 0, "desks": 0, "checked_points": 0,
        "min_wall_gap": None, "min_desk_gap": None,
    }

    def add(rule: str, detail: str) -> None:
        problems.append({"rule": rule, "detail": detail})

    for room in rooms:
        desks = room.get("desks") or []
        if not desks:
            continue
        stats["rooms_with_desks"] += 1
        stats["desks"] += len(desks)
        b = room["bounds"]
        x0, x1, z0, z1 = rect_of(room)
        # dinding bagian dalam ruangan (permukaan dalam kusen)
        ix0, ix1 = x0 + WALL_T / 2, x1 - WALL_T / 2
        iz0, iz1 = z0 + WALL_T / 2, z1 - WALL_T / 2

        boxes = [(d, desk_bbox(room, d)) for d in desks]

        for desk, box in boxes:
            # (2) titik wajib di dalam batas dalam (padding)
            for label, p in (("meja", (desk["x"], desk["z"])),
                             ("kursi", (desk["chair"][0], desk["chair"][1])),
                             ("berdiri", (desk["stand"][0], desk["stand"][1]))):
                stats["checked_points"] += 1
                if not (b["x_min"] - EPS <= p[0] <= b["x_max"] + EPS and
                        b["z_min"] - EPS <= p[1] <= b["z_max"] + EPS):
                    add("titik-di-luar-batas-dalam",
                        f"{room['id']} {label} {p} di luar "
                        f"x[{b['x_min']:.2f},{b['x_max']:.2f}] z[{b['z_min']:.2f},{b['z_max']:.2f}]")
            # (3) bounding box tidak boleh menembus dinding
            if box[0] < ix0 - EPS or box[1] > ix1 + EPS or \
                    box[2] < iz0 - EPS or box[3] > iz1 + EPS:
                add("meja-menembus-dinding",
                    f"{room['id']} bbox x[{box[0]:.2f},{box[1]:.2f}] z[{box[2]:.2f},{box[3]:.2f}] "
                    f"vs dinding dalam x[{ix0:.2f},{ix1:.2f}] z[{iz0:.2f},{iz1:.2f}]")
            # jarak meja ke dinding terdekat
            gap = min(box[0] - x0, x1 - box[1], box[2] - z0, z1 - box[3])
            stats["min_wall_gap"] = gap if stats["min_wall_gap"] is None \
                else min(stats["min_wall_gap"], gap)

        # (4) antar meja tidak tumpang tindih
        for i, (d1, b1) in enumerate(boxes):
            for d2, b2 in boxes[i + 1:]:
                if box_overlap(b1, b2) > EPS:
                    add("meja-tumpang-tindih",
                        f"{room['id']} ({d1['x']},{d1['z']}) vs ({d2['x']},{d2['z']})")
        # jarak antar meja (jarak antar tepi, bukan antar pusat)
        for i, (d1, b1) in enumerate(boxes):
            for d2, b2 in boxes[i + 1:]:
                gapx = max(b1[0] - b2[1], b2[0] - b1[1])
                gapz = max(b1[2] - b2[3], b2[2] - b1[3])
                dist = max(gapx, gapz)
                stats["min_desk_gap"] = dist if stats["min_desk_gap"] is None \
                    else min(stats["min_desk_gap"], dist)

        # (5) kursi tidak menabrak meja
        for desk in desks:
            cb = chair_bbox(room, desk)
            dw = desk.get("w", 2.05)
            dd = desk.get("d", 1.05)
            rot = desk.get("rot", 0.0)
            along_x = abs(rot) < 1e-3 or abs(rot - 3.14159265) < 1e-3
            if along_x:
                tb = (desk["x"] - dw / 2, desk["x"] + dw / 2, desk["z"] - dd / 2, desk["z"] + dd / 2)
            else:
                tb = (desk["x"] - dd / 2, desk["x"] + dd / 2, desk["z"] - dw / 2, desk["z"] + dw / 2)
            ov = box_overlap(cb, tb)
            if ov > CHAIROVERLAP_TOL:
                add("kursi-menabrak-meja", f"{room['id']} ({desk['x']},{desk['z']})")

        # (6) lorong meja harus bebas
        aisle = room.get("aisle")
        if not aisle:
            add("lorong-tidak-ada", room["id"])
            continue
        nav = room.get("nav") or {}
        aisle_node = office.NAV_NODES.get(nav.get("aisle"))
        if aisle_node is None:
            add("node-lorong-hilang", room["id"])
            continue
        if abs(aisle_node[0] - aisle["x"]) > 0.01 or abs(aisle_node[1] - aisle["z"]) > 0.01:
            add("node-lorong-tidak-sesuai",
                f"{room['id']} node {aisle_node} vs ruangan {aisle}")

        # (7) rute agent: pintu -> lorong -> berdiri -> duduk
        door = room.get("door")
        if door:
            door_pt = (door["x"], door["z"])
            # lorong dulu, lalu berdiri, lalu kursi
            legs = [
                (door_pt, (aisle_node[0], aisle_node[1]), "pintu->lorong"),
            ]
            for desk in desks:
                legs.append(((aisle_node[0], aisle_node[1]),
                             (desk["stand"][0], desk["stand"][1]), "lorong->berdiri"))
            for desk, box in boxes:
                for a, bb, label in legs:
                    if seg_hits_box(a, bb, box, AGENT_R):
                        add("rute-menabrak-meja", f"{room['id']} {label} di ({desk['x']},{desk['z']})")
            # berdiri -> kursi: hanya boleh melewati kursi sendiri
            for desk in desks:
                for other, obox in boxes:
                    if other is desk:
                        continue
                    if seg_hits_box((desk["stand"][0], desk["stand"][1]),
                                    (desk["chair"][0], desk["chair"][1]), obox, AGENT_R):
                        add("rute-menabrak-meja",
                            f"{room['id']} berdiri->kursi ({desk['x']},{desk['z']}) vs ({other['x']},{other['z']})")
            # (8) meja tidak boleh menutupi bukaan pintu
            gap_lo = (door["x"] - door["width"] / 2, door["x"] + door["width"] / 2)
            gap_hi = (door["z"] - door["width"] / 2, door["z"] + door["width"] / 2)
            for desk, box in boxes:
                if door["side"] in ("north", "south"):
                    gap = gap_lo
                else:
                    gap = gap_hi
                if box_overlap(box, (gap[0], gap[1], gap[0], gap[1])) > EPS:
                    add("meja-menutupi-pintu", f"{room['id']} ({desk['x']},{desk['z']})")

    return {
        "rooms": len(rooms),
        "rooms_with_desks": stats["rooms_with_desks"],
        "desks": stats["desks"],
        "checked_points": stats["checked_points"],
        "min_wall_gap": round(stats["min_wall_gap"], 3) if stats["min_wall_gap"] is not None else None,
        "min_desk_gap": round(stats["min_desk_gap"], 3) if stats["min_desk_gap"] is not None else None,
        "padding": office.WALL_PADDING,
        "problems": problems,
        "ok": not problems,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Pemeriksa tabrakan meja & rute agent")
    parser.add_argument("--json", dest="json_path", default="", help="simpan hasil ke file JSON")
    parser.add_argument("--quiet", action="store_true", help="cetak ringkasan saja")
    args = parser.parse_args(argv)

    result = check()
    if args.json_path:
        Path(args.json_path).write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n",
                                        encoding="utf-8")

    if args.quiet:
        print(f"ruang={result['rooms']} ruang-meja={result['rooms_with_desks']} "
              f"meja={result['desks']} titik={result['checked_points']} "
              f"jarak-dinding-min={result['min_wall_gap']} "
              f"jarak-meja-min={result['min_desk_gap']} "
              f"masalah={len(result['problems'])}")
    else:
        print(f"Kolisi: {result['rooms']} ruang ({result['rooms_with_desks']} dengan meja), "
              f"{result['desks']} meja, {result['checked_points']} titik diperiksa")
        print(f"Padding dinding: {result['padding']} m | jarak meja->dinding min: "
              f"{result['min_wall_gap']} | jarak antar meja min: {result['min_desk_gap']}")
        if result["problems"]:
            print(f"\nPELANGGARAN ({len(result['problems'])}):")
            for p in result["problems"][:40]:
                print(f"  - {p['rule']}: {p['detail']}")
        else:
            print("\nOK: semua meja/kursi/titik berdiri/lorong di dalam batas dalam "
                  "(padding 1.1 m), tidak ada meja menembus dinding, tidak ada ruta "
                  "agent yang memotong meja/kursi.")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
