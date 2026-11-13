#!/usr/bin/env python3
"""office_api_check.py -- pemeriksa kontrak HTTP Kantor Digital 3D.

Menguji server yang SUDAH berjalan (tidak menyalakan/mematikan apa pun) dan
mencetak satu baris PASS/FAIL per cek. Exit 0 kalau semua lolos.

Aman dijalankan ke vault asli: satu-satunya POST tugas memakai dry_run=true,
jadi tidak ada file tugas yang dibuat.

Kalau server memakai password, berikan lewat --password atau env
HERMES_OFFICE_PASSWORD. Cek auth (redirect, 401, CSRF, Origin) hanya jalan
kalau auth aktif. Satu login salah sengaja dikirim (memakai 1 dari 5 jatah;
direset oleh login yang benar sesudahnya).

Contoh:
  python3 _tools/office_api_check.py --base http://127.0.0.1:3000
  HERMES_OFFICE_PASSWORD=... python3 _tools/office_api_check.py --base https://office.example.com
  python3 _tools/office_api_check.py --base http://127.0.0.1:3010 \
      --json /opt/data/cache/scratch/api-check.json --sse
"""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # noqa: D401 - kembalikan 3xx apa adanya
        return None


class Checker:
    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.results: list[tuple[bool, str, str]] = []
        self.data: dict = {}
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar), _NoRedirect())
        self.anon = urllib.request.build_opener(_NoRedirect())
        self.csrf = ""

    def _open(self, req, opener=None, timeout=15):
        try:
            with (opener or self.opener).open(req, timeout=timeout) as res:
                return res.status, dict(res.headers), res.read()
        except urllib.error.HTTPError as exc:
            return exc.code, dict(exc.headers), exc.read()

    def check(self, name: str, condition: bool, detail: str = "") -> bool:
        self.results.append((bool(condition), name, detail))
        mark = "PASS" if condition else "FAIL"
        print(f"[{mark}] {name}" + (f" -- {detail}" if detail else ""))
        return bool(condition)

    def get(self, path: str, anon: bool = False):
        req = urllib.request.Request(self.base + path, headers={"Accept": "*/*"})
        return self._open(req, self.anon if anon else None)

    def post(self, path: str, payload, csrf: str | None = None, origin: str | None = None,
             raw: bytes | None = None):
        body = raw if raw is not None else json.dumps(payload).encode()
        headers = {"Content-Type": "application/json", "Origin": origin or self.base}
        token = self.csrf if csrf is None else csrf
        if token:
            headers["X-CSRF-Token"] = token
        req = urllib.request.Request(self.base + path, data=body, headers=headers, method="POST")
        return self._open(req, timeout=30)

    def json_of(self, raw: bytes):
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return None

    @property
    def ok(self) -> bool:
        return all(r[0] for r in self.results)


def login(c: Checker, password: str) -> bool:
    """Login kalau server memakai auth; True kalau siap dipakai."""
    status, _, _ = Checker.get(c, "/api/session")
    if status != 401:
        return True
    status, _, raw = Checker.post(c, "/api/login", {"password": password})
    c.csrf = (c.json_of(raw) or {}).get("csrf", "")
    return status == 200


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", default="http://127.0.0.1:3000")
    parser.add_argument("--password", default=os.environ.get("HERMES_OFFICE_PASSWORD", ""),
                        help="password admin (default: env HERMES_OFFICE_PASSWORD)")
    parser.add_argument("--expect-agents", type=int, default=0, help="0 = cukup konsisten antar endpoint")
    parser.add_argument("--expect-rooms", type=int, default=11)
    parser.add_argument("--sse", action="store_true", help="uji /api/stream menerima minimal satu event")
    parser.add_argument("--json", default="", help="tulis hasil ke file JSON")
    args = parser.parse_args(argv)

    c = Checker(args.base)
    started = time.time()

    # --- auth -------------------------------------------------------------
    status, _, raw = c.get("/api/session", anon=True)
    auth_on = status == 401
    c.data["auth"] = auth_on
    print(f"(auth {'aktif' if auth_on else 'mati: demo di loopback'})")
    if auth_on:
        status, headers, _ = c.get("/", anon=True)
        c.check("tanpa sesi: GET / -> 302 /login", status == 302 and headers.get("Location", "").endswith("/login"),
                f"HTTP {status} {headers.get('Location')}")
        for path in ("/api/agents", "/api/layout", "/api/stream", "/app.js"):
            status, _, _ = c.get(path, anon=True)
            c.check(f"tanpa sesi: {path} ditolak", status in (401, 302), f"HTTP {status}")
        status, _, raw = c.get("/api/health", anon=True)
        c.check("tanpa sesi: health tidak membocorkan detail", c.json_of(raw) == {"status": "ok"},
                raw[:80].decode("utf-8", "replace"))
        status, _, _ = c.get("/login", anon=True)
        c.check("halaman /login publik", status == 200, f"HTTP {status}")
        status, _, raw = c.post("/api/login", {"password": "pasti-salah-" + str(time.time())})
        c.check("password salah -> 401", status == 401, f"HTTP {status}")
        if not args.password:
            c.check("password tersedia (--password / HERMES_OFFICE_PASSWORD)", False,
                    "cek berikutnya butuh login")
            return finish(c, args, started)
        status, headers, raw = c.post("/api/login", {"password": args.password},
                                      origin="https://evil.example")
        c.check("login dari origin asing -> 403", status == 403, f"HTTP {status}")
        status, headers, raw = c.post("/api/login", {"password": args.password})
        body = c.json_of(raw) or {}
        cookie = headers.get("Set-Cookie", "")
        c.check("login benar -> 200 + csrf", status == 200 and bool(body.get("csrf")), f"HTTP {status}")
        c.check("cookie sesi HttpOnly + SameSite=Strict",
                "HttpOnly" in cookie and "SameSite=Strict" in cookie, cookie.split(";", 1)[-1].strip())
        c.csrf = body.get("csrf", "")
        status, _, _ = c.post("/api/task", {"to": "x", "goal": "tanpa csrf"}, csrf="")
        c.check("POST tanpa CSRF -> 403", status == 403, f"HTTP {status}")
        status, _, _ = c.post("/api/task", {"to": "x", "goal": "csrf salah"}, csrf="salah")
        c.check("POST dengan CSRF salah -> 403", status == 403, f"HTTP {status}")
    status, _, raw = c.get("/api/session")
    sess = c.json_of(raw) or {}
    c.check("GET /api/session -> 200", status == 200 and sess.get("authenticated") is True, f"HTTP {status}")

    # --- health -----------------------------------------------------------
    status, headers, raw = c.get("/api/health")
    health = c.json_of(raw) or {}
    c.data["health"] = health
    c.check("GET /api/health -> 200", status == 200, f"HTTP {status}")
    c.check("health.status == ok", health.get("status") == "ok", str(health.get("status")))
    counts = health.get("counts") or {}
    c.check("content-type health JSON", "application/json" in headers.get("Content-Type", ""),
            headers.get("Content-Type", ""))
    c.check("cache-control: no-store pada API", "no-store" in headers.get("Cache-Control", ""),
            headers.get("Cache-Control", ""))
    c.check("tanpa header CORS (same-origin saja)", "Access-Control-Allow-Origin" not in headers,
            str(headers.get("Access-Control-Allow-Origin")))
    for name, needle in [("Content-Security-Policy", "default-src 'self'"),
                         ("X-Content-Type-Options", "nosniff"), ("X-Frame-Options", "DENY")]:
        c.check(f"header {name}", needle in headers.get(name, ""), headers.get(name, "")[:60])

    # --- layout -----------------------------------------------------------
    status, _, raw = c.get("/api/layout")
    layout = c.json_of(raw) or {}
    c.data["layout"] = layout
    rooms = layout.get("rooms") or []
    agents = layout.get("agents") or []
    depts = layout.get("departments") or []
    c.check("GET /api/layout -> 200", status == 200, f"HTTP {status}")
    annex = [r for r in rooms if r.get("annex")]
    c.check(f"{args.expect_rooms} ruangan bawaan + annex", len(rooms) - len(annex) == args.expect_rooms,
            f"rooms={len(rooms)} annex={len(annex)}")
    n_agents = args.expect_agents or counts.get("agents")
    c.check(f"layout berisi {n_agents} agent (sama dengan health)", len(agents) == n_agents,
            f"agents={len(agents)}")
    c.check("jumlah departemen konsisten dengan health",
            len([d for d in depts if d.get("id") != "executive"]) == counts.get("departments"),
            "depts=" + ",".join(d.get("id", "?") for d in depts))
    c.check("layout punya version", bool(layout.get("version")), str(layout.get("version")))
    c.check("id agent unik", len({a.get("id") for a in agents}) == len(agents))
    hot = [a for a in agents if a.get("hot_desk")]
    c.check("hot desk hanya di library", all(a.get("room") == "library" for a in hot),
            f"{len(hot)} agent hot desk")

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
    c.check("semua meja berada di dalam ruangannya", not outside,
            "; ".join(outside) or f"{len(agents)}/{len(agents)} ok")

    # --- snapshot ---------------------------------------------------------
    status, _, raw = c.get("/api/agents")
    snap = c.json_of(raw) or {}
    c.data["agents"] = snap
    live = snap.get("agents") or []
    c.check("GET /api/agents -> 200", status == 200, f"HTTP {status}")
    c.check(f"snapshot berisi {n_agents} agent", len(live) == n_agents, f"n={len(live)}")
    c.check("snapshot punya events & layout_version",
            isinstance(snap.get("events"), list) and bool(snap.get("layout_version")))
    c.check("snapshot tidak membocorkan path vault", "vault" not in snap, ",".join(sorted(snap)[:12]))
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

    # --- file tugas -------------------------------------------------------
    with_task = next((a for a in live if a.get("open_tasks") or a.get("done_tasks")), None)
    if with_task:
        name = (with_task.get("open_tasks") or with_task.get("done_tasks"))[0]
        q = urllib.parse.urlencode({"agent": with_task["id"], "name": name})
        status, _, raw = c.get("/api/task-file?" + q)
        c.check("GET /api/task-file -> isi markdown", status == 200 and bool((c.json_of(raw) or {}).get("content")),
                f"{with_task['id']}/{name} HTTP {status}")
        q = urllib.parse.urlencode({"agent": with_task["id"], "name": "../../AGENTS.md"})
        status, _, _ = c.get("/api/task-file?" + q)
        c.check("task-file menolak path traversal", status in (400, 404), f"HTTP {status}")
    status, _, _ = c.get("/..%2f..%2fetc/passwd")
    c.check("static menolak traversal", status in (400, 403, 404), f"HTTP {status}")

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

    bad_status, _, _ = c.post("/api/task", None, raw=b"{bukan json")
    c.check("JSON rusak ditolak dengan 400", bad_status == 400, f"HTTP {bad_status}")

    # --- editor denah (dry_run: tidak menulis) ---------------------------
    status, _, raw = c.get("/api/office-layout")
    ol = c.json_of(raw) or {}
    c.check("GET /api/office-layout -> doc + katalog", status == 200 and "doc" in ol and len(ol.get("catalog", {})) >= 10,
            f"HTTP {status} jenis={len(ol.get('catalog', {}))}")
    desk = next((d for r in rooms for d in r.get("desks", []) if r.get("kind") == "department"), None)
    if desk:
        bad_doc = {"props": [{"id": "p-check1", "type": "planter", "x": desk["x"], "z": desk["z"], "rot": 0}]}
        status, _, raw = c.post("/api/office-layout", {"doc": bad_doc, "dry_run": True})
        c.check("perabot di atas meja ditolak 400", status == 400, f"HTTP {status} {(c.json_of(raw) or {}).get('error', '')[:60]}")
    status, _, raw = c.post("/api/office-layout", {"doc": {"rooms": [
        {"id": "x1", "kind": "ruang-aneh", "x": 0, "z": 0, "w": 6, "d": 6}]}, "dry_run": True})
    c.check("jenis ruangan tidak dikenal ditolak 400", status == 400, f"HTTP {status}")
    doc_rooms = (ol.get("doc") or {}).get("rooms") or []
    if len(doc_rooms) > 1:
        clash = [dict(doc_rooms[0])] + [dict(doc_rooms[1], x=doc_rooms[0]["x"], z=doc_rooms[0]["z"])] + doc_rooms[2:]
        status, _, raw = c.post("/api/office-layout", {"doc": {"rooms": clash}, "dry_run": True})
        c.check("ruangan saling menimpa ditolak 400", status == 400 and "menimpa" in (c.json_of(raw) or {}).get("error", ""),
                f"HTTP {status}")
    status, _, raw = c.post("/api/office-layout", {"doc": ol.get("doc", {}), "preview": True})
    c.check("preview mengembalikan denah jadi", status == 200 and bool(((c.json_of(raw) or {}).get("layout") or {}).get("rooms")),
            f"HTTP {status}")
    status, _, raw = c.post("/api/office-layout", {"doc": ol.get("doc", {}), "dry_run": True})
    c.check("dokumen denah saat ini valid (dry_run)", status == 200 and (c.json_of(raw) or {}).get("dry_run") is True,
            f"HTTP {status}")

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
    c.check("index memuat app.js & vendor lokal",
            "/app.js" in html and "/vendor/three.min.js" in html)
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
            with c.opener.open(req, timeout=10) as res:
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

    if auth_on:
        status, _, _ = c.post("/api/logout", {})
        status2, _, _ = c.get("/api/agents")
        c.check("logout mencabut sesi", status == 200 and status2 == 401, f"logout {status}, lalu {status2}")
    return finish(c, args, started)


def finish(c: Checker, args, started: float) -> int:
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
