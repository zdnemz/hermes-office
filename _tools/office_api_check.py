#!/usr/bin/env python3
"""office_api_check.py -- pemeriksa kontrak HTTP Kantor Digital 3D.

Menguji server yang SUDAH berjalan (tidak menyalakan/mematikan apa pun) dan
mencetak satu baris PASS/FAIL per cek. Exit 0 kalau semua lolos.

Aman dijalankan ke vault asli: satu-satunya POST yang dikirim memakai
dry_run=true, jadi tidak ada file tugas yang dibuat.

Contoh:
  python3 _tools/office_api_check.py --base http://127.0.0.1:3000
  python3 _tools/office_api_check.py --base http://127.0.0.1:3010 \
      --json /opt/data/cache/scratch/api-check.json --sse
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


class Checker:
    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.results: list[tuple[bool, str, str]] = []
        self.data: dict = {}

    def check(self, name: str, condition: bool, detail: str = "") -> bool:
        self.results.append((bool(condition), name, detail))
        mark = "PASS" if condition else "FAIL"
        print(f"[{mark}] {name}" + (f" -- {detail}" if detail else ""))
        return bool(condition)

    def get(self, path: str):
        req = urllib.request.Request(self.base + path, headers={"Accept": "*/*"})
        try:
            with urllib.request.urlopen(req, timeout=15) as res:
                return res.status, dict(res.headers), res.read()
        except urllib.error.HTTPError as exc:
            return exc.code, dict(exc.headers), exc.read()

    def post(self, path: str, payload: dict):
        body = json.dumps(payload).encode()
        req = urllib.request.Request(
            self.base + path, data=body,
            headers={"Content-Type": "application/json"}, method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                return res.status, dict(res.headers), res.read()
        except urllib.error.HTTPError as exc:
            return exc.code, dict(exc.headers), exc.read()

    def json_of(self, raw: bytes):
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return None

    @property
    def ok(self) -> bool:
        return all(r[0] for r in self.results)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", default="http://127.0.0.1:3000")
    parser.add_argument("--expect-agents", type=int, default=16)
    parser.add_argument("--expect-departments", type=int, default=5)
    parser.add_argument("--expect-rooms", type=int, default=7)
    parser.add_argument("--sse", action="store_true", help="uji /api/stream menerima minimal satu event")
    parser.add_argument("--json", default="", help="tulis hasil ke file JSON")
    args = parser.parse_args(argv)

    c = Checker(args.base)
    started = time.time()

    # --- health -----------------------------------------------------------
    status, headers, raw = c.get("/api/health")
    health = c.json_of(raw) or {}
    c.data["health"] = health
    c.check("GET /api/health -> 200", status == 200, f"HTTP {status}")
    c.check("health.status == ok", health.get("status") == "ok", str(health.get("status")))
    counts = health.get("counts") or {}
    c.check(f"health melaporkan {args.expect_agents} agent", counts.get("agents") == args.expect_agents,
            f"agents={counts.get('agents')}")
    c.check(f"health melaporkan {args.expect_departments} departemen",
            counts.get("departments") == args.expect_departments, f"departments={counts.get('departments')}")
    c.check("content-type health JSON", "application/json" in headers.get("Content-Type", ""),
            headers.get("Content-Type", ""))
    c.check("cache-control: no-store pada API", "no-store" in headers.get("Cache-Control", ""),
            headers.get("Cache-Control", ""))
    c.check("CORS header ada", headers.get("Access-Control-Allow-Origin") == "*",
            str(headers.get("Access-Control-Allow-Origin")))

    # --- layout -----------------------------------------------------------
    status, _, raw = c.get("/api/layout")
    layout = c.json_of(raw) or {}
    c.data["layout"] = layout
    rooms = layout.get("rooms") or []
    agents = layout.get("agents") or []
    depts = layout.get("departments") or []
    c.check("GET /api/layout -> 200", status == 200, f"HTTP {status}")
    c.check(f"{args.expect_rooms} zona ruangan", len(rooms) == args.expect_rooms, f"rooms={len(rooms)}")
    c.check(f"{args.expect_agents} meja agent", len(agents) == args.expect_agents, f"agents={len(agents)}")
    c.check(f"{args.expect_departments} departemen non-executive",
            len([d for d in depts if d.get("id") != "executive"]) == args.expect_departments,
            "depts=" + ",".join(d.get("id", "?") for d in depts))
    c.check("id agent unik", len({a.get("id") for a in agents}) == len(agents))

    room_by_id = {r["id"]: r for r in rooms}
    outside = []
    for a in agents:
        r = room_by_id.get(a.get("room"))
        if not r:
            outside.append(f"{a.get('id')}: ruangan tidak ada")
            continue
        x, _, z = a.get("pos") or (0, 0, 0)
        if abs(x - r["x"]) > r["w"] / 2 - 0.8 or abs(z - r["z"]) > r["d"] / 2 - 0.5:
            outside.append(f"{a.get('id')} di ({x},{z}) keluar dari {r['id']}")
    c.check("semua meja berada di dalam ruangannya", not outside, "; ".join(outside) or "16/16 ok")

    # --- snapshot ---------------------------------------------------------
    status, _, raw = c.get("/api/agents")
    snap = c.json_of(raw) or {}
    c.data["agents"] = snap
    live = snap.get("agents") or []
    c.check("GET /api/agents -> 200", status == 200, f"HTTP {status}")
    c.check(f"snapshot berisi {args.expect_agents} agent", len(live) == args.expect_agents, f"n={len(live)}")
    bad_state = [a["id"] for a in live if a.get("state") not in ("idle", "working", "blocked", "meeting")]
    c.check("state hanya idle/working/blocked/meeting", not bad_state, ",".join(bad_state) or "ok")
    meeting_ids = set((snap.get("meeting") or {}).get("participants") or [])
    derived = []
    for a in live:
        if a["id"] in meeting_ids:
            if a.get("state") != "meeting":
                derived.append(f"{a['id']}: {a.get('state')} != meeting")
            continue
        expect = "blocked" if a.get("blocked_count") else ("working" if a.get("open_count") else "idle")
        if expect != a.get("state"):
            derived.append(f"{a['id']}: {a.get('state')} != {expect}")
    c.check("state konsisten dengan antrean tugas", not derived, "; ".join(derived) or "ok")
    keys = {"id", "name", "role", "dept", "dept_label", "room", "pos", "color",
            "state", "open_count", "blocked_count", "done_count", "status_text",
            "last_journal_content", "headline"}
    missing = sorted(keys - set(live[0].keys())) if live else ["(kosong)"]
    c.check("field wajib frontend lengkap", not missing, ",".join(missing) or "ok")

    # --- detail -----------------------------------------------------------
    sample = agents[0]["id"] if agents else "."
    encoded = urllib.parse.quote(sample, safe="")
    status, _, raw = c.get(f"/api/agent/{encoded}")
    detail = c.json_of(raw) or {}
    c.check("GET /api/agent/<id> -> 200", status == 200, f"id={sample} HTTP {status}")
    c.check("detail memuat status_text & open_tasks",
            "status_text" in detail and "open_tasks" in detail,
            ",".join(k for k in ("status_text", "open_tasks") if k in detail))

    deep = "eng/workers/script-runner"
    status, _, raw = c.get("/api/agent/" + urllib.parse.quote(deep, safe=""))
    c.check("id bersarang (slash ter-encode) terbaca", status == 200, f"{deep} HTTP {status}")

    status, _, raw = c.get("/api/agent/tidak-ada")
    c.check("agent tidak dikenal -> 404 JSON", status == 404 and (c.json_of(raw) or {}).get("success") is False,
            f"HTTP {status}")

    status, _, raw = c.get("/api/tidak-ada")
    body = c.json_of(raw)
    c.check("endpoint API tak dikenal -> 404 JSON", status == 404 and isinstance(body, dict),
            f"HTTP {status}")

    # --- task validation (dry_run, tidak menulis) -------------------------
    status, _, raw = c.post("/api/task", {"to": "eng/workers/script-runner", "goal": "uji kontrak api dry run", "dry_run": True})
    dry = c.json_of(raw) or {}
    c.check("POST /api/task dry_run -> 200", status == 200, f"HTTP {status}")
    c.check("dry_run sukses dan mengembalikan path",
            dry.get("success") is True and str(dry.get("path", "")).endswith(".md"),
            str(dry.get("path", "")))
    c.check("dry_run tidak menulis file", "tidak ada file ditulis" in str(dry.get("output", "")),
            str(dry.get("output", "")))
    c.data["dry_run"] = dry

    for payload, label in [
        ({"to": "bukan/agent", "goal": "tes target salah"}, "target tidak ada"),
        ({"to": "eng/workers/script-runner", "goal": "abc"}, "goal terlalu pendek"),
        ({"to": "eng/workers/script-runner", "goal": "tes prioritas salah", "priority": "urgent"}, "priority tidak valid"),
    ]:
        status, _, raw = c.post("/api/task", payload)
        body = c.json_of(raw) or {}
        c.check(f"validasi: {label} -> 400", status == 400 and body.get("success") is False,
                f"HTTP {status} {str(body.get('error'))[:60]}")

    status, headers, raw = c.post("/api/task", {"to": "x"})
    c.check("body tanpa field wajib ditolak", status == 400, f"HTTP {status}")

    # JSON rusak (bukan sekadar field kosong)
    try:
        req = urllib.request.Request(
            c.base + "/api/task", data=b"{bukan json",
            headers={"Content-Type": "application/json"}, method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as res:
            bad_status = res.status
    except urllib.error.HTTPError as exc:
        bad_status = exc.code
    c.check("JSON rusak ditolak dengan 400", bad_status == 400, f"HTTP {bad_status}")

    # --- meeting -----------------------------------------------------------
    status, _, raw = c.get("/api/meeting")
    meeting_body = c.json_of(raw) or {}
    c.data["meeting"] = meeting_body
    c.check("GET /api/meeting -> 200", status == 200, f"HTTP {status}")
    c.check("payload meeting punya slot",
            isinstance(meeting_body.get("slots"), int) and meeting_body.get("slots", 0) >= 17,
            f"slots={meeting_body.get('slots')}")

    # --- static -----------------------------------------------------------
    status, headers, raw = c.get("/")
    html = raw.decode("utf-8", "replace")
    c.data["index_bytes"] = len(raw)
    c.check("GET / -> 200", status == 200, f"HTTP {status} {len(raw)} B")
    c.check("index memuat stream & vendor lokal",
            "/api/stream" in html and "/vendor/three.min.js" in html)
    c.check("index tidak di-cache", "no-cache" in headers.get("Cache-Control", ""),
            headers.get("Cache-Control", ""))

    for path, min_size, needle in [
        ("/vendor/three.min.js", 500_000, b"THREE"),
        ("/vendor/OrbitControls.js", 15_000, b"OrbitControls"),
    ]:
        status, headers, raw = c.get(path)
        c.check(f"aset {path} tersaji", status == 200 and len(raw) > min_size,
                f"HTTP {status} {len(raw)} B")
        if needle not in raw:
            c.check(f"aset {path} berisi penanda {needle!r}", False)

    # --- SSE --------------------------------------------------------------
    if args.sse:
        got = []
        try:
            req = urllib.request.Request(c.base + "/api/stream")
            with urllib.request.urlopen(req, timeout=10) as res:
                c.check("GET /api/stream -> 200 event-stream", res.status == 200,
                        f"HTTP {res.status} {res.headers.get('Content-Type')}")
                deadline = time.time() + 6
                while time.time() < deadline and not got:
                    line = res.readline()
                    if not line:
                        break
                    if line.startswith(b"data:"):
                        got.append(json.loads(line[5:].decode("utf-8")))
        except Exception as exc:  # noqa: BLE001
            c.check("SSE mengirim snapshot", False, f"{type(exc).__name__}: {exc}")
        if got:
            c.check("SSE mengirim snapshot", True, f"{len(got[0].get('agents', []))} agent dalam 1 event")
            c.check("snapshot SSE punya counts & agents",
                    "counts" in got[0] and "agents" in got[0])
            c.data["sse_first"] = {"counts": got[0].get("counts"), "sig_len": len(got[0].get("generated_at", ""))}

    # --- ringkasan --------------------------------------------------------
    passed = sum(1 for r in c.results if r[0])
    total = len(c.results)
    elapsed = round(time.time() - started, 2)
    print(f"\n{passed}/{total} cek lolos dalam {elapsed}s -> {c.base}")
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump({
                "base": c.base,
                "checked_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "passed": passed,
                "total": total,
                "elapsed_s": elapsed,
                "ok": c.ok,
                "results": [{"ok": ok, "check": name, "detail": detail} for ok, name, detail in c.results],
                "data": {k: v for k, v in c.data.items() if k != "layout"},
            }, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
    return 0 if c.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
