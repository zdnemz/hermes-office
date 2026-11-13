#!/usr/bin/env python3
"""office_demo.py -- vault demo + simulator untuk development Hermes Office 3D.

Dipakai lewat `office_server.py --demo`. Membuat vault sementara berisi
roster bawaan + satu departemen baru (finance -> ruangan annex),
lalu satu thread menulis file sungguhan ke vault itu: tugas masuk/selesai/
terhambat, status.md, jurnal, rapat, dan agent baru yang "direkrut". Server
membaca vault ini persis seperti vault produksi -- tidak ada jalur mock.
"""

from __future__ import annotations

import json
import random
import re
import shutil
import tempfile
import threading
import time
from datetime import date, datetime
from pathlib import Path

import office_server as office

# Departemen baru tanpa ruangan bawaan -> server membangkitkan ruangan annex.
EXTRA = [
    ("finance", {"name": "Finance Manager", "role": "Manajer Keuangan & Anggaran",
                 "dept_label": "Keuangan", "color": "#eab308"}),
    ("finance/workers/bookkeeper", {"name": "Bookkeeper", "role": "Pencatatan & Rekonsiliasi",
                                    "dept_label": "Keuangan", "color": "#facc15"}),
]
# Direkrut saat simulasi berjalan: (detik sejak start, id, office.json)
# Urutannya sengaja menguji denah dinamis: eng terisi penuh (4 meja), lalu
# departemen baru (legal) menambah ruangan annex, lalu eng meluap ke
# "Eng Bay · Annex".
HIRES = [
    (45, "eng/workers/qa-tester", {"name": "QA Tester", "role": "Uji Regresi & Rilis"}),
    (75, "legal", {"name": "Legal Manager", "role": "Kontrak & Kepatuhan",
                   "dept_label": "Legal", "color": "#6366f1"}),
    (85, "legal/workers/contract-reviewer", {"name": "Contract Reviewer", "role": "Review Kontrak Vendor",
                                             "dept_label": "Legal", "color": "#818cf8"}),
    (110, "finance/workers/auditor", {"name": "Auditor", "role": "Audit Biaya Vendor",
                                      "dept_label": "Keuangan", "color": "#facc15"}),
    (150, "eng/workers/sre", {"name": "SRE", "role": "Uptime & Insiden"}),
]
GOALS = [
    "Susun tabel 5 CRM SaaS untuk UMKM", "Ringkas tren harga cloud Q4",
    "Draft artikel onboarding klien baru", "Periksa fakta newsletter mingguan",
    "Rapikan workflow n8n intake email", "Audit skrip backup harian",
    "Rekap tiket klien minggu ini", "Cari 3 tools transkripsi murah",
    "Rancang persona agent riset pasar", "Bandingkan paket hosting VPS",
    "Siapkan laporan status untuk CEO", "Bersihkan folder karantina outbox",
    "Pantau rilis fitur kompetitor", "Tulis SOP review konten",
    "Uji integrasi webhook pembayaran", "Hitung burn rate bulan ini",
]
TOPICS = ["Sprint planning", "Review konten mingguan", "Insiden webhook",
          "Rencana rekrutmen agent", "Anggaran Q1", "Retro rilis"]
BLOCKERS = ["menunggu akses API", "butuh keputusan CEO", "data sumber belum lengkap",
            "rate limit vendor"]


def _slug(goal: str) -> str:
    # Sama dengan office_server._expected_path / swarm.py cmd_task.
    return re.sub(r"[^a-z0-9]+", "-", goal.lower())[:40].strip("-")


SWARM_STUB = '''#!/usr/bin/env python3
"""swarm.py (stub demo): hanya perintah `task`, format sama dengan swarm asli."""
import argparse, re, sys
from datetime import date
from pathlib import Path

p = argparse.ArgumentParser()
sub = p.add_subparsers(dest="cmd", required=True)
t = sub.add_parser("task")
t.add_argument("target"); t.add_argument("--goal", required=True)
t.add_argument("--priority", default="normal"); t.add_argument("--from", dest="src", default="cli")
t.add_argument("--accept", action="append", default=[])
a = p.parse_args()
root = Path(__file__).resolve().parent.parent
slug = re.sub(r"[^a-z0-9]+", "-", a.goal.lower())[:40].strip("-")
folder = root if a.target == "." else root / a.target
path = folder / "tasks" / "open" / f"T-{date.today().isoformat()}-{slug}.md"
path.parent.mkdir(parents=True, exist_ok=True)
lines = [f"# {a.goal}", "", f"- prioritas: {a.priority}", f"- dari: {a.src}", "", "## Kriteria diterima"]
lines += [f"- [ ] {x}" for x in a.accept] or ["- (tidak ada)"]
path.write_text("\\n".join(lines) + "\\n", encoding="utf-8")
print("+ " + str(path.relative_to(root)))
'''


class Demo:
    def __init__(self, seed: int | None = None):
        self.root = Path(tempfile.mkdtemp(prefix="hermes-office-demo-"))
        self.rng = random.Random(seed)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._n = 0
        self.ids: list[str] = []
        self._seed_vault()

    # -- seed ----------------------------------------------------------------
    def folder(self, agent_id: str) -> Path:
        return self.root if agent_id == "." else self.root / agent_id

    def _make_agent(self, agent_id: str, override: dict | None = None) -> None:
        f = self.folder(agent_id)
        for sub in ("tasks/open", "tasks/blocked", "tasks/done", "memory/journal"):
            (f / sub).mkdir(parents=True, exist_ok=True)
        name = (override or {}).get("name") or office.KNOWN_AGENTS.get(agent_id, {}).get("name", agent_id)
        (f / "AGENTS.md").write_text(f"# {name}\n\nAgent demo Hermes Office.\n", encoding="utf-8")
        (f / "memory" / "identity.md").write_text(
            f"# Identitas\n\nSaya **{name}**, agent demo yang disimulasikan.\n", encoding="utf-8")
        if override:
            (f / "office.json").write_text(json.dumps(override, ensure_ascii=False), encoding="utf-8")
        self._status(agent_id, terakhir="baru bergabung, menunggu tugas pertama")
        self.ids.append(agent_id)

    def _seed_vault(self) -> None:
        (self.root / "_tools").mkdir()
        (self.root / "_tools" / "swarm.py").write_text(SWARM_STUB, encoding="utf-8")
        (self.root / "board").mkdir()
        for agent in office.ROSTER:
            self._make_agent(agent["id"])
        for agent_id, override in EXTRA:
            self._make_agent(agent_id, override)
        for agent_id in self.rng.sample(self.ids, 7):
            self.new_task(agent_id)
        self.block(self.rng.choice([a for a in self.ids if self.tasks(a, "open")]))
        for agent_id in self.rng.sample(self.ids, 5):      # sedikit riwayat
            self.new_task(agent_id)
            self.complete(agent_id)

    # -- file ops (persis seperti agent Hermes menulis vault) ----------------
    def tasks(self, agent_id: str, folder: str) -> list[Path]:
        return sorted((self.folder(agent_id) / "tasks" / folder).glob("*.md"))

    def _status(self, agent_id: str, sedang: str = "", terakhir: str = "", blocker: str = "") -> None:
        now = datetime.now().strftime("%H:%M")
        lines = ["# Status", "", f"_diperbarui {now}_", ""]
        if sedang:
            lines.append(f"Sedang: {sedang}")
        if terakhir:
            lines.append(f"Terakhir: {terakhir}")
        if blocker:
            lines.append(f"Blocker: {blocker}")
        lines += ["", "## Catatan", "- Data ini dibuat oleh simulator `--demo`."]
        (self.folder(agent_id) / "memory" / "status.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

    def _journal(self, agent_id: str, text: str) -> None:
        path = self.folder(agent_id) / "memory" / "journal" / f"{date.today().isoformat()}.md"
        if not path.exists():
            path.write_text(f"# Jurnal {date.today().isoformat()}\n\n", encoding="utf-8")
        with path.open("a", encoding="utf-8") as fh:
            fh.write(f"- **{datetime.now().strftime('%H:%M:%S')}** {text}\n")

    def new_task(self, agent_id: str) -> None:
        self._n += 1
        goal = f"{self.rng.choice(GOALS)} {self._n}"
        path = self.folder(agent_id) / "tasks" / "open" / f"T-{date.today().isoformat()}-{_slug(goal)}.md"
        path.write_text(
            f"# {goal}\n\n- prioritas: {self.rng.choice(['low', 'normal', 'normal', 'high'])}\n"
            f"- dari: CEO\n\n## Kriteria diterima\n- [ ] Hasil ditulis ke `outbox/`\n"
            f"- [ ] Sertakan **sumber** untuk tiap klaim\n", encoding="utf-8")
        self._status(agent_id, sedang=goal)
        self._journal(agent_id, f"Menerima tugas: {goal}")

    def complete(self, agent_id: str) -> None:
        open_ = self.tasks(agent_id, "open")
        if not open_:
            return
        task = open_[0]
        title = task.read_text(encoding="utf-8").splitlines()[0].lstrip("# ")
        task.rename(self.folder(agent_id) / "tasks" / "done" / task.name)
        rest = self.tasks(agent_id, "open")
        self._status(agent_id, sedang=rest[0].read_text(encoding="utf-8").splitlines()[0].lstrip("# ")
                     if rest else "", terakhir=f"selesai: {title}")
        self._journal(agent_id, f"Selesai: {title}")

    def block(self, agent_id: str) -> None:
        open_ = self.tasks(agent_id, "open")
        if not open_:
            return
        task = open_[-1]
        task.rename(self.folder(agent_id) / "tasks" / "blocked" / task.name)
        reason = self.rng.choice(BLOCKERS)
        self._status(agent_id, blocker=reason)
        self._journal(agent_id, f"Terhambat ({reason})")

    def unblock(self, agent_id: str) -> None:
        for task in self.tasks(agent_id, "blocked"):
            title = task.read_text(encoding="utf-8").splitlines()[0].lstrip("# ")
            task.rename(self.folder(agent_id) / "tasks" / "open" / task.name)
            self._status(agent_id, sedang=title)
            self._journal(agent_id, "Hambatan selesai, lanjut bekerja")

    # -- simulator -----------------------------------------------------------
    def tick(self, elapsed: float, meeting_state: dict) -> None:
        r = self.rng
        for at, agent_id, override in HIRES:
            if elapsed >= at and agent_id not in self.ids:
                self._make_agent(agent_id, override)
        vault = office.Vault(self.root)
        meeting = vault.meeting()
        busy = set(meeting["participants"]) if meeting else set()
        free = [a for a in self.ids if a not in busy]
        roll = r.random()
        if roll < 0.32:
            self.new_task(r.choice(free))
        elif roll < 0.62:
            working = [a for a in free if self.tasks(a, "open")]
            if working:
                self.complete(r.choice(working))
        elif roll < 0.68:
            working = [a for a in free if self.tasks(a, "open")]
            if working:
                self.block(r.choice(working))
        elif roll < 0.80:
            blocked = [a for a in self.ids if self.tasks(a, "blocked")]
            if blocked:
                self.unblock(r.choice(blocked))
        # Rapat: mulai tiap ~80-120 detik, berlangsung ~30-45 detik.
        now = time.time()
        if meeting and now >= meeting_state.get("ends", 0):
            vault.write_meeting({**meeting, "status": "done", "ended_at": office._now_iso()})
            meeting_state["next"] = now + r.uniform(80, 120)
        elif not meeting and now >= meeting_state.setdefault("next", now + 25):
            parts = r.sample(self.ids, r.randint(3, 5))
            vault.write_meeting({
                "status": "active", "topic": r.choice(TOPICS), "participants": parts,
                "room": office.MEETING_ROOM_ID, "started_at": office._now_iso(),
                "started_by": "demo",
            })
            meeting_state["ends"] = now + r.uniform(30, 45)

    def _run(self) -> None:
        start = time.time()
        meeting_state: dict = {}
        while not self._stop.wait(self.rng.uniform(2.5, 5.0)):
            try:
                self.tick(time.time() - start, meeting_state)
            except OSError as exc:              # vault dihapus dari luar, dll.
                print(f"[demo] tick gagal: {exc}")

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="office-demo", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
        shutil.rmtree(self.root, ignore_errors=True)


if __name__ == "__main__":
    # Self-check: vault demo -> roster terdeteksi, finance di annex,
    # tugas bergerak, agent baru muncul, rapat dimulai.
    d = Demo(seed=7)
    try:
        roster = office.discover_roster(d.root)
        layout = office.build_layout(roster)
        ids = {a["id"] for a in roster}
        assert set(office.KNOWN_AGENTS) <= ids, "roster bawaan harus ditemukan"
        fin = layout["by_id"]["finance/workers/bookkeeper"]
        assert fin["room"] == "annex-finance", fin
        assert fin["name"] == "Bookkeeper" and fin["color"] == "#facc15"
        assert layout["by_id"]["eng"]["room"] == "eng"
        snap = office.Snapshot(office.Vault(d.root))
        snap.get(force=True)
        state: dict = {"next": 0}
        for i in range(12):
            d.tick(160, state)
        data, _ = snap.get(force=True)
        assert "eng/workers/qa-tester" in {a["id"] for a in data["agents"]}
        grown = office.build_layout(office.discover_roster(d.root))
        rooms = {r["id"]: r for r in grown["rooms"]}
        assert len(rooms["eng"]["desks"]) == 4, rooms["eng"]
        assert {"annex-finance", "annex-legal", "annex-eng"} <= set(rooms), sorted(rooms)
        assert grown["by_id"]["eng/workers/sre"]["room"] == "annex-eng"
        seats = [tuple(a["pos"]) for a in grown["agents"]]
        assert len(seats) == len(set(seats)), "dua agent di satu meja"
        kinds = {e["kind"] for e in data["events"]}
        assert "join" in kinds and kinds & {"task_new", "task_done"}, kinds
        assert data["meeting"], "rapat demo harus dimulai"
        print("office_demo self-check OK:", len(data["agents"]), "agent,", len(data["events"]), "event")
    finally:
        d.stop()
