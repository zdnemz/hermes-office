#!/usr/bin/env node
/**
 * office_meeting_probe.mjs -- uji runtime fitur Meeting Mode.
 *
 * office_ui_probe.mjs membuktikan UI hidup; probe ini menjawab pertanyaan
 * yang lebih spesifik:
 *   1. Saat rapat dimulai, apakah agent peserta benar-benar BERGERAK lewat
 *      koridor ke Board Meeting Room dan DUDUK di kursi meja konferensi?
 *   2. Apakah selama berjalan/duduk mereka pernah menabrak meja, kursi,
 *      atau dinding (audit)?
 *   3. Saat rapat ditutup, apakah mereka kembali ke tempat asal (meja kerja
 *      untuk working/blocked, plaza untuk idle)?
 *
 * Probe ini menulis board/meeting.json lewat API (POST /api/meeting/start)
 * dan membersihkannya di akhir (POST /api/meeting/end).
 *
 * Contoh:
 *   node _tools/office_meeting_probe.mjs --url http://127.0.0.1:3997/ \
 *        --cdp 127.0.0.1:9224 --seconds 45 --outdir /tmp/bukti-meeting
 *
 * Exit code: 0 semua cek lolos, 1 ada cek gagal / error, 2 argumen salah.
 */

import { writeFileSync, mkdirSync } from 'node:fs';

const args = parse(process.argv.slice(2));
if (args.help) {
  console.log(`pemakaian: node office_meeting_probe.mjs --url URL [opsi]
  --url URL            halaman yang diuji (wajib)
  --cdp HOST:PORT      endpoint debug Chrome (default 127.0.0.1:9222)
  --api BASE           base URL API untuk start/end rapat (default: asal dari --url)
  --participants LIST  id agent peserta, pisahkan koma (default: 5 id berbeda)
  --seconds N          lama menunggu agent sampai ke kursi (default 45)
  --outdir DIR         folder output PNG + JSON
  --timeout MS         batas tunggu UI siap (default 25000)`);
  process.exit(0);
}
if (!args.url) {
  console.error('--url wajib diisi (--help untuk bantuan)');
  process.exit(2);
}

const cdpHost = args.cdp || '127.0.0.1:9222';
const seconds = Number(args.seconds || 45);
const timeoutMs = Number(args.timeout || 25000);
const outdir = args.outdir || 'outbox/office-meeting-probe';
const apiBase = args.api || args.url.replace(/\/$/, '');
const participants = (args.participants ||
  '.,eng,content,hrd,eng/workers/script-runner').split(',').filter(Boolean);

async function main() {
  mkdirSync(outdir, { recursive: true });
  const targets = await getJson(`http://${cdpHost}/json/list`);
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('tidak ada target page di Chrome; buka about:blank dulu');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('websocket CDP gagal')), { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  const consoleErrors = [];
  const exceptions = [];

  ws.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      exceptions.push(d.exception?.description || d.text || 'exception');
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const evaluate = pageEval = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    }
    return res.result.value;
  };

  const shoot = async (file) => {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    return file;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1600, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await send('Page.navigate', { url: args.url });

  const deadline = Date.now() + timeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    await sleep(250);
    try {
      ready = await evaluate(`(() => {
        const a = window.office3d;
        return !!(a && a.deskCount && a.deskCount() > 0 && document.querySelector('canvas'));
      })()`);
      if (ready) break;
    } catch { /* navigasi belum selesai */ }
  }
  if (!ready) throw new Error(`UI tidak siap dalam ${timeoutMs} ms`);
  await sleep(1500);

  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok: !!ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`);
  };

  // --- 0. kondisi awal ---------------------------------------------------
  const before = await apiSnapshot(apiBase);
  const baseline = {};
  before.agents.forEach((a) => { baseline[a.id] = a.state; });
  check('snapshot awal terbaca dari API', before.agents.length > 0,
    `${before.agents.length} agent`);

  const info = await evaluate(`(() => {
    const a = window.office3d;
    return { furniture: a.meeting ? a.meeting().furniture : -1, seats: a.meeting ? a.meeting().seats : -1 };
  })()`);
  check('frontend memuat perabot ruang rapat', info.furniture > 0,
    `furniture=${info.furniture} kursi=${info.seats}`);

  // --- 1. mulai rapat ----------------------------------------------------
  const started = await apiPost(`${apiBase}/api/meeting/start`, {
    participants, topic: 'Rapat uji otomatis (probe)',
  });
  check('POST /api/meeting/start berhasil', started.status === 200 && started.body?.success === true,
    `HTTP ${started.status}`);

  // --- 2. tunggu agent sampai di kursi ------------------------------------
  const seen = new Map();
  let samples = 0;
  let arrivedMax = 0;
  let maxSeatD = 0;
  const auditDeadline = Date.now() + seconds * 1000;
  while (Date.now() < auditDeadline) {
    await sleep(250);
    const snap = await evaluate(`(() => {
      const a = window.office3d.audit ? window.office3d.audit() : null;
      const m = window.office3d.meeting ? window.office3d.meeting() : null;
      if (!a || !m) return null;
      const st = window.office3d.states ? window.office3d.states() : [];
      const seated = m.agents.filter(x => !x.moving && x.d >= 0 && x.d <= 0.3).length;
      const maxD = m.agents.reduce((mx, x) => (x.moving ? mx : Math.max(mx, x.d)), 0);
      const inMeeting = st.filter(x => x.status === 'meeting').length;
      return { violations: a.violations, seated: seated, total: m.agents.length,
               maxD: maxD, inMeeting: inMeeting, meetingCount: (m.live && m.live.participants || []).length };
    })()`);
    if (!snap) continue;
    samples += 1;
    arrivedMax = Math.max(arrivedMax, snap.seated);
    maxSeatD = Math.max(maxSeatD, snap.maxD);
    snap.violations.forEach((v) => {
      const key = v.id + '|' + v.kind;
      if (!seen.has(key)) seen.set(key, { ...v, samples: 1 });
      else seen.get(key).samples += 1;
    });
    if (arrivedMax >= participants.length && samples > 8) break;
  }
  const violations = Array.from(seen.values());
  const during = await apiSnapshot(apiBase);
  const duringStates = participants.map((p) =>
    `${p}:${(during.agents.find((a) => a.id === p) || {}).state}`);
  check('server melaporkan peserta berstatus meeting',
    participants.every((p) => (during.agents.find((a) => a.id === p) || {}).state === 'meeting'),
    duringStates.join(' '));
  check(`semua peserta (${participants.length}) duduk di kursi rapat`,
    arrivedMax >= participants.length, `${arrivedMax}/${participants.length} sampai, maks jarak ${maxSeatD}`);
  check('tidak ada agent menabrak perabot rapat',
    violations.filter((v) => v.kind === 'di-perabot-rapat').length === 0,
    violations.filter((v) => v.kind === 'di-perabot-rapat').length === 0
      ? 'bersih' : JSON.stringify(violations.filter((v) => v.kind === 'di-perabot-rapat').slice(0, 4)));
  check('tidak ada agent menembus dinding',
    violations.filter((v) => v.kind === 'di-dinding').length === 0,
    violations.filter((v) => v.kind === 'di-dinding').length === 0
      ? 'bersih' : JSON.stringify(violations.filter((v) => v.kind === 'di-dinding').slice(0, 4)));
  check('tidak ada agent berhenti bukan di kursi rapat',
    violations.filter((v) => v.kind === 'bukan-di-kursi-rapat').length === 0,
    violations.filter((v) => v.kind === 'bukan-di-kursi-rapat').length === 0
      ? 'bersih' : JSON.stringify(violations.filter((v) => v.kind === 'bukan-di-kursi-rapat').slice(0, 4)));

  const shots = [];
  await evaluate(`(() => { window.office3d.look('board', { dist: 13, angle: Math.PI * 0.82, height: 9 }); return true; })()`);
  await sleep(900);
  shots.push(await shoot(`${outdir}/00-rapat-board-room.png`));
  await evaluate(`(() => { window.office3d.resetCamera(); return true; })()`);
  await sleep(700);
  shots.push(await shoot(`${outdir}/01-overview.png`));

  // --- 3. tutup rapat: agent kembali ke tempat asal -----------------------
  const ended = await apiPost(`${apiBase}/api/meeting/end`, {});
  check('POST /api/meeting/end berhasil', ended.status === 200 && ended.body?.success === true,
    `HTTP ${ended.status}`);

  const seen2 = new Map();
  let samples2 = 0;
  let backMax = 0;
  const backDeadline = Date.now() + seconds * 1000;
  while (Date.now() < backDeadline) {
    await sleep(250);
    const snap = await evaluate(`(() => {
      const a = window.office3d.audit ? window.office3d.audit() : null;
      const st = window.office3d.states ? window.office3d.states() : [];
      if (!a) return null;
      const want = ${JSON.stringify(participants)};
      const b = (window.office3d.nav() || {}).walkBounds || null;
      const home = (x) => {
        if (!b) return true;
        return x.x >= b.x0 && x.x <= b.x1 && x.z >= b.z0 && x.z <= b.z1;
      };
      const back = st.filter(x => {
        if (want.indexOf(x.id) < 0) return false;
        if (x.status === 'meeting') return false;
        // Agent idle boleh jalan-jalan, tapi harus berada di dalam plaza.
        if (x.status === 'idle') return home(x);
        return !x.moving && (x.status === 'working' ? x.seatD <= 0.35 : x.standD <= 0.35);
      }).length;
      const stillMeeting = st.filter(x => x.status === 'meeting').length;
      return { violations: a.violations, back: back, stillMeeting: stillMeeting };
    })()`);
    if (!snap) continue;
    samples2 += 1;
    backMax = Math.max(backMax, snap.back);
    snap.violations.forEach((v) => {
      const key = v.id + '|' + v.kind;
      if (!seen2.has(key)) seen2.set(key, { ...v, samples: 1 });
      else seen2.get(key).samples += 1;
    });
    if (backMax >= participants.length) break;
  }
  const violations2 = Array.from(seen2.values());
  check(`semua peserta (${participants.length}) kembali ke tempat asal`,
    backMax >= participants.length, `${backMax}/${participants.length} kembali`);
  check('tidak ada pelanggaran saat agent pulang',
    violations2.length === 0,
    violations2.length === 0 ? 'bersih' : JSON.stringify(violations2.slice(0, 6)));

  const after = await apiSnapshot(apiBase);
  const reverted = participants.filter((p) => (after.agents.find((a) => a.id === p) || {}).state === baseline[p]);
  check('status server kembali seperti semula',
    reverted.length === participants.length,
    JSON.stringify(participants.map((p) => `${p}:${baseline[p]}->${(after.agents.find((a) => a.id === p) || {}).state}`)));

  check('tanpa exception JS', exceptions.length === 0, exceptions.join(' | ') || 'bersih');

  const result = {
    url: args.url,
    api: apiBase,
    checked_at: new Date().toISOString(),
    participants,
    baseline,
    samples, samples2,
    arrivedMax, maxSeatD, backMax,
    violations, violations2,
    shots,
    checks,
    consoleErrors,
    exceptions,
    ok: checks.every((c) => c.ok) && exceptions.length === 0,
  };
  writeFileSync(`${outdir}/probe.json`, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({
    ok: result.ok,
    checks: checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ' (' + c.detail + ')' : ''}`),
    shots: shots.length,
  }, null, 2));
  ws.close();
  return result.ok ? 0 : 1;
}

/* API dipanggil DARI halaman (cookie sesi + token CSRF milik halaman),
   supaya probe tetap jalan di server yang memakai login. */
let pageEval = null;

async function apiSnapshot() {
  return pageEval(`fetch('/api/agents', { cache: 'no-store', credentials: 'same-origin' }).then(r => r.json())`);
}

async function apiPost(path, payload) {
  const rel = new URL(path).pathname;
  return pageEval(`(async () => {
    const s = await fetch('/api/session', { credentials: 'same-origin' }).then(r => r.json());
    const res = await fetch(${JSON.stringify(rel)}, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrf || '' },
      body: ${JSON.stringify(JSON.stringify(payload))},
    });
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    return { status: res.status, body };
  })()`);
}

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'help') { out.help = true; continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[key] = true; continue; }
    out[key] = next;
    i += 1;
  }
  return out;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('GAGAL:', err.message);
  process.exit(1);
});
