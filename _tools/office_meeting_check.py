#!/usr/bin/env python3
"""office_meeting_check.py -- pemeriksa kontrak Meeting Mode.

Server yang diuji harus sudah berjalan (tidak menyalakan/mematikan apa pun).
Semua cek dicetak satu baris PASS/FAIL; exit 0 kalau semua lolos.

Yang diperiksa:
  1. GET  /api/meeting  -> rapat aktif + jumlah slot (kursi + berdiri)
  2. POST /api/meeting/start -> board/meeting.json ditulis, status agent
     peserta jadi 'meeting', agent lain tidak berubah
  3. GET  /api/layout   -> geometri rapat (kursi meja, jalur, kotak meja)
  4. POST /api/meeting/end   -> status peserta kembali ke status sebelumnya
  5. Alur file: board/meeting.json dibuat manual -> 'meeting'; status=done
     -> kembali ke status lama
  6. Validasi: peserta tidak dikenal / daftar kosong -> 400

Berkas uji cleans up board/meeting.json di akhir (kecuali --keep).

Contoh:
  python3 _tools/office_meeting_check.py --base http://127.0.0.1:3997 \
      --vault /opt/data/cache/scratch/opencode/meeting-vault
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


class Checker:
    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.results: list[tuple[bool, str, str]] = []
        self.data: dict = {}

    def check(self, name: str, condition: bool, detail: str = "") -> bool:
        self.results.append((bool(condition), name, detail))
        print(f"[{'PASS' if condition else 'FAIL'}] {name}" + (f" -- {detail}" if detail else ""))
        return bool(condition)

    def get(self, path: str):
        req = urllib.request.Request(self.base + path, headers={"Accept": "*/*"})
        try:
            with urllib.request.urlopen(req, timeout=15) as res:
                return res.status, res.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()

    def post(self, path: str, payload: dict):
        body = json.dumps(payload).encode()
        req = urllib.request.Request(
            self.base + path, data=body,
            headers={"Content-Type": "application/json"}, method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                return res.status, res.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()

    @staticmethod
    def json_of(raw: bytes):
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return None

    @property
    def ok(self) -> bool:
        return all(r[0] for r in self.results)


def states_of(base: str) -> dict:
    """status -> {agent_id: state} dari /api/agents."""
    req = urllib.request.Request(base + "/api/agents", headers={"Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=15) as res:
        data = json.loads(res.read().decode("utf-8"))
    return {a["id"]: a.get("state") for a in data.get("agents", [])}


def seats_of(base: str) -> dict:
    """{agent_id: seat index} untuk agent berstatus meeting."""
    req = urllib.request.Request(base + "/api/agents", headers={"Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=15) as res:
        data = json.loads(res.read().decode("utf-8"))
    return {a["id"]: a.get("meeting_seat") for a in data.get("agents", [])
            if a.get("state") == "meeting"}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", default="http://127.0.0.1:3000")
    parser.add_argument("--vault", default="", help="root vault yang dipakai server (untuk cek file)")
    parser.add_argument("--participants", default="eng,hrd,eng/workers/script-runner",
                        help="daftar id agent peserta rapat (pisahkan dengan koma)")
    parser.add_argument("--keep", action="store_true", help="jangan hapus board/meeting.json di akhir")
    parser.add_argument("--json", default="", help="tulis hasil ke file JSON")
    args = parser.parse_args(argv)

    c = Checker(args.base)
    started = time.time()
    meeting_file = Path(args.vault) / "board" / "meeting.json" if args.vault else None
    participants = [p.strip() for p in args.participants.split(",") if p.strip()]

    # --- GET /api/meeting --------------------------------------------------
    status, raw = c.get("/api/meeting")
    body = c.json_of(raw) or {}
    c.check("GET /api/meeting -> 200", status == 200, f"HTTP {status}")
    c.check("payload /api/meeting punya kunci meeting",
            "meeting" in body and "slots" in body,
            f"slots={body.get('slots')}")
    c.check("ada slot untuk semua agent", (body.get("slots") or 0) >= 17,
            f"slots={body.get('slots')}")

    # --- layout: geometri rapat -------------------------------------------
    status, raw = c.get("/api/layout")
    layout = c.json_of(raw) or {}
    meeting = layout.get("meeting") or {}
    seats = meeting.get("seats") or []
    standing = meeting.get("standing") or []
    table = meeting.get("table") or {}
    c.check("GET /api/layout -> 200", status == 200, f"HTTP {status}")
    c.check("layout memuat geometri rapat", bool(meeting), f"kunci={sorted(meeting.keys())}")
    c.check("10 kursi meja conferencing", len(seats) == 10, f"seats={len(seats)}")
    c.check("8 slot berdiri cadangan", len(standing) == 8, f"standing={len(standing)}")
    c.check("kotak meja mengacu ke meja conferences",
            table.get("x0") is not None and table.get("z0") is not None,
            json.dumps(table))

    board = None
    for room in layout.get("rooms") or []:
        if room.get("id") == "board":
            board = room
    c.check("ruangan board ada di layout", board is not None,
            f"board={board.get('label') if board else '-'}")

    # Semua kursi harus di dalam ruangan board dan di luar kotak meja.
    outside = []
    on_table = []
    for s in seats + standing:
        if board:
            if not (board["x"] - board["w"] / 2 <= s["x"] <= board["x"] + board["w"] / 2 and
                    board["z"] - board["d"] / 2 <= s["z"] <= board["z"] + board["d"] / 2):
                outside.append(f"{s['x']},{s['z']}")
        if (table.get("x0", 0) <= s["x"] <= table.get("x1", 0) and
                table.get("z0", 0) <= s["z"] <= table.get("z1", 0)):
            on_table.append(f"{s['x']},{s['z']}")
    c.check("semua slot di dalam ruangan board", not outside, ",".join(outside) or "ok")
    c.check("tidak ada slot yang berdiri di atas meja", not on_table, ",".join(on_table) or "ok")

    # Kursi harus menghadap ke arah meja (arah hadap = (sin, cos) face_rot).
    # Sisi meja: agent menghadap tegak lurus ke sisi meja, jadi sudutnya
    # miring terhadap pusat meja -- yang dicek arahnya tidak terbalik.
    bad_face = []
    table_cx = (table.get("x0", 0) + table.get("x1", 0)) / 2
    table_cz = (table.get("z0", 0) + table.get("z1", 0)) / 2
    for s in seats:
        fx, fz = math.sin(s["face_rot"]), math.cos(s["face_rot"])
        to_x, to_z = table_cx - s["x"], table_cz - s["z"]
        norm = math.hypot(to_x, to_z) or 1.0
        if fx * to_x / norm + fz * to_z / norm < 0.3:
            bad_face.append(f"{s['x']},{s['z']}")
    c.check("semua kursi menghadap ke arah meja", not bad_face, ",".join(bad_face) or "ok")

    # Jalur masuk harus di dalam ruangan dan tidak memotong meja.
    bad_path = []
    entry = meeting.get("entry") or {}
    for s in seats:
        pts = [entry] + (s.get("path") or []) + [{"x": s["x"], "z": s["z"]}]
        for a, b in zip(pts, pts[1:]):
            ax, az, bx, bz = a["x"], a["z"], b["x"], b["z"]
            # uji titik tengah tiap segmen (pendekatan cukup untuk kotak axis-aligned)
            for t in [i / 20 for i in range(21)]:
                px, pz = ax + (bx - ax) * t, az + (bz - az) * t
                if (table.get("x0", 0) <= px <= table.get("x1", 0) and
                        table.get("z0", 0) <= pz <= table.get("z1", 0)):
                    bad_path.append(f"{s.get('side')}@{px:.2f},{pz:.2f}")
                    break
    c.check("jalur ke kursi tidak memotong meja", not bad_path, ",".join(bad_path[:4]) or "ok")

    # --- baseline ----------------------------------------------------------
    baseline = states_of(args.base)
    c.check("snapshot awal punya 17 agent", len(baseline) == 17, f"n={len(baseline)}")
    c.data["baseline"] = baseline

    # --- POST /api/meeting/start ------------------------------------------
    status, raw = c.post("/api/meeting/start", {
        "participants": participants, "topic": "Rapat uji meeting mode",
    })
    body = c.json_of(raw) or {}
    c.check("POST /api/meeting/start -> 200", status == 200, f"HTTP {status} {str(body)[:120]}")
    c.check("start menulis board/meeting.json",
            body.get("success") is True and body.get("path") == "board/meeting.json",
            str(body.get("path")))
    c.check("topic tersimpan", body.get("meeting", {}).get("topic") == "Rapat uji meeting mode",
            str(body.get("meeting", {}).get("topic")))
    if meeting_file:
        c.check("file board/meeting.json ada di disk", meeting_file.is_file(), str(meeting_file))
        if meeting_file.is_file():
            raw_file = json.loads(meeting_file.read_text(encoding="utf-8"))
            c.check("file berisi participants + status active",
                    raw_file.get("status") == "active" and
                    raw_file.get("participants") == participants,
                    json.dumps(raw_file)[:160])

    after = states_of(args.base)
    c.data["after_start"] = after
    meeting_states = {k: v for k, v in after.items() if v == "meeting"}
    c.check("semua peserta berstatus meeting",
            all(after.get(p) == "meeting" for p in participants),
            json.dumps({p: after.get(p) for p in participants}))
    c.check("tidak ada agent lain ikut berubah",
            len(meeting_states) == len(participants),
            f"meeting={len(meeting_states)} peserta={len(participants)}")
    unchanged = [k for k, v in baseline.items()
                 if k not in participants and after.get(k) == v]
    c.check("status non-peserta tetap sama",
            len(unchanged) == len(baseline) - len(participants),
            f"{len(unchanged)}/{len(baseline) - len(participants)} tetap")

    seat_map = seats_of(args.base)
    c.check("setiap peserta dapat index kursi",
            all(seat_map.get(p) is not None for p in participants),
            json.dumps(seat_map))
    c.check("index kursi sesuai urutan peserta",
            [seat_map.get(p) for p in participants] == list(range(len(participants))),
            json.dumps([seat_map.get(p) for p in participants]))

    # GET /api/agent/<id> harus ikut tahu status meeting
    from urllib.parse import quote
    status, raw = c.get("/api/agent/" + quote(participants[0], safe=""))
    detail = c.json_of(raw) or {}
    c.check("detail agent peserta ikut berstatus meeting",
            detail.get("state") == "meeting" and "meeting_seat" in detail,
            f"state={detail.get('state')} seat={detail.get('meeting_seat')}")

    # --- validasi ----------------------------------------------------------
    status, raw = c.post("/api/meeting/start", {"participants": ["bukan/agent"]})
    c.check("peserta tidak dikenal -> 400", status == 400, f"HTTP {status}")
    status, raw = c.post("/api/meeting/start", {"participants": []})
    c.check("daftar peserta kosong -> 400", status == 400, f"HTTP {status}")
    status, raw = c.post("/api/meeting/start", {"topic": "tanpa peserta"})
    c.check("body tanpa participants -> 400", status == 400, f"HTTP {status}")

    # --- POST /api/meeting/end (revert ke status sebelumnya) ---------------
    status, raw = c.post("/api/meeting/end", {})
    body = c.json_of(raw) or {}
    c.check("POST /api/meeting/end -> 200", status == 200, f"HTTP {status}")
    c.check("end menutup rapat", body.get("meeting") is None, json.dumps(body.get("ended"))[:120])
    reverted = states_of(args.base)
    c.data["after_end"] = reverted
    same = [p for p in participants if reverted.get(p) == baseline.get(p)]
    c.check("status peserta kembali ke status sebelumnya",
            len(same) == len(participants),
            json.dumps({p: f"{baseline.get(p)}->{reverted.get(p)}" for p in participants}))

    # --- alur file: file dibuat manual -------------------------------------
    if meeting_file:
        meeting_file.parent.mkdir(parents=True, exist_ok=True)
        meeting_file.write_text(json.dumps({
            "status": "active", "topic": "manual", "participants": participants[:1],
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        time.sleep(1.3)
        manual = states_of(args.base)
        c.check("file manual mengaktifkan status meeting",
                manual.get(participants[0]) == "meeting",
                f"{participants[0]}={manual.get(participants[0])}")

        meeting_file.write_text(json.dumps({
            "status": "done", "topic": "manual", "participants": participants[:1],
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        time.sleep(1.3)
        done = states_of(args.base)
        c.check("status=done mengembalikan status lama",
                done.get(participants[0]) == baseline.get(participants[0]),
                f"{participants[0]}={done.get(participants[0])} (sebelumnya {baseline.get(participants[0])})")

        # --- end + remove ---------------------------------------------------
        c.post("/api/meeting/start", {"participants": participants, "topic": "uji remove"})
        status, raw = c.post("/api/meeting/end", {"remove": True})
        body = c.json_of(raw) or {}
        c.check("POST /api/meeting/end {remove:true} -> 200", status == 200, f"HTTP {status}")
        c.check("file board/meeting.json dihapus", not meeting_file.exists(), str(meeting_file))
        time.sleep(1.3)
        gone = states_of(args.base)
        c.check("semua peserta kembali ke status awal setelah remove",
                all(gone.get(p) == baseline.get(p) for p in participants),
                json.dumps({p: gone.get(p) for p in participants}))

    # --- ringkasan ---------------------------------------------------------
    passed = sum(1 for r in c.results if r[0])
    total = len(c.results)
    elapsed = round(time.time() - started, 2)
    print(f"\n{passed}/{total} cek lolos dalam {elapsed}s -> {c.base}")
    if args.json:
        Path(args.json).parent.mkdir(parents=True, exist_ok=True)
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump({
                "base": c.base,
                "checked_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "passed": passed, "total": total, "elapsed_s": elapsed, "ok": c.ok,
                "results": [{"ok": ok, "check": name, "detail": detail} for ok, name, detail in c.results],
                "data": c.data,
            }, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
    return 0 if c.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
