#!/usr/bin/env node
/**
 * office_collision_probe.mjs -- uji runtime "agent tidak pernah menembus
 * meja/kursi" untuk Kantor Digital 3D.
 *
 * office_ui_probe.mjs provednah UI hidup. Probe ini menjawab pertanyaan
 * lain: saat agent BERJALAN dari playground ke mejanya (dan lalu duduk),
 * apakah dia pernah menabrak bounding box meja/kursi, menembus dinding,
 * atau berhenti bukan di kursinya?
 *
 * Cara kerja:
 *   1. buka halaman, tunggu UI siap
 *   2. paksa SEMUA agent berstatus 'working' (memaksa rute
 *      playground -> lorong -> berdiri -> kursi)
 *   3. audit tiap 250 ms selama N detik, kumpulkan pelanggaran unik
 *   4. potret layar (overview +_close-up per ruangan_)
 *
 * Contoh:
 *   node _tools/office_collision_probe.mjs --url http://127.0.0.1:3000/ \
 *        --seconds 18 --outdir outbox/2026-11-12-fix-collision-desks
 *
 * Exit code: 0 semua cek lolos, 1 ada cek gagal / error, 2 argumen salah.
 */

import { writeFileSync, mkdirSync } from 'node:fs';

const args = parse(process.argv.slice(2));
if (args.help) {
  console.log(`pemakaian: node office_collision_probe.mjs --url URL [opsi]
  --url URL            halaman yang diuji (wajib)
  --cdp HOST:PORT      endpoint debug Chrome (default 127.0.0.1:9222)
  --seconds N          lama audit (default 60)
  --outdir DIR         folder output PNG + JSON
  --rooms a,b,c        ruangan yang difoto close-up (default research,content,operations,hrd,eng)
  --timeout MS         batas tunggu UI siap (default 25000)`);
  process.exit(0);
}
if (!args.url) {
  console.error('--url wajib diisi (--help untuk bantuan)');
  process.exit(2);
}

const cdpHost = args.cdp || '127.0.0.1:9222';
const seconds = Number(args.seconds || 60);
const timeoutMs = Number(args.timeout || 25000);
const outdir = args.outdir || 'outbox/office-collision-probe';
const rooms = (args.rooms || 'research,content,operations,hrd,eng').split(',').filter(Boolean);

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

  const evaluate = async (expression) => {
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
    checks.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' (' + detail + ')' : ''}`);
  };

  // Paksa semua agent bekerja -> memicu rute jalan ke meja.
  const forced = await evaluate(`(() => {
    const ids = window.office3d.agents().map(a => a.id);
    let n = 0;
    ids.forEach(id => { const r = window.office3d.setState(id, 'working'); if (r) n += 1; });
    return { total: ids.length, forced: n };
  })()`);
  check('semua agent dipaksa status working', forced.forced === forced.total,
    `${forced.forced}/${forced.total}`);

  const obstacles = await evaluate(`(() => {
    const a = window.office3d.audit ? window.office3d.audit() : null;
    return a ? { desks: a.desks, walls: a.walls, agents: a.agents } : null;
  })()`);
  check('daftar obstacle meja terdaftar', obstacles && obstacles.desks > 0,
    obstacles ? `${obstacles.desks} meja / ${obstacles.walls} dinding` : 'null');

  // Audit berulang selama agent berjalan ke mejanya.
  const seen = new Map();
  let samples = 0;
  let arrived = 0;
  let maxSeatD = 0;
  const auditDeadline = Date.now() + seconds * 1000;
  while (Date.now() < auditDeadline) {
    await sleep(250);
    const snap = await evaluate(`(() => {
      const a = window.office3d.audit ? window.office3d.audit() : null;
      if (!a) return null;
      const st = window.office3d.states ? window.office3d.states() : [];
      const seated = st.filter(x => x.status === 'working' && !x.moving).length;
      // jarak ke kursi hanya untuk agent yang sudah mendarat (agent yang
      // masih berjalan jelas jauh dari kursinya).
      const maxD = st.reduce((m, x) => (x.status === 'working' && !x.moving ? Math.max(m, x.seatD) : m), 0);
      return { violations: a.violations, desks: a.desks, seated: seated, maxD: maxD };
    })()`);
    if (!snap) continue;
    samples += 1;
    if (snap.seated) arrived = Math.max(arrived, snap.seated);
    maxSeatD = Math.max(maxSeatD, snap.maxD);
    snap.violations.forEach((v) => {
      const key = v.id + '|' + v.kind;
      if (!seen.has(key)) seen.set(key, { ...v, samples: 1 });
      else seen.get(key).samples += 1;
    });
  }
  const violations = Array.from(seen.values());
  check(`audit ${samples} sampel: agent tidak pernah menabrak meja/kursi`,
    violations.filter((v) => v.kind === 'di-meja').length === 0,
    violations.filter((v) => v.kind === 'di-meja').length === 0
      ? 'bersih' : JSON.stringify(violations.filter((v) => v.kind === 'di-meja').slice(0, 5)));
  check(`audit ${samples} sampel: agent tidak pernah menembus dinding`,
    violations.filter((v) => v.kind === 'di-dinding').length === 0,
    violations.filter((v) => v.kind === 'di-dinding').length === 0
      ? 'bersih' : JSON.stringify(violations.filter((v) => v.kind === 'di-dinding').slice(0, 5)));
  const decor = violations.filter((v) => v.kind === 'di-dekor' || v.kind === 'di-perabot-rapat');
  check(`audit ${samples} sampel: agent tidak pernah menembus dekor/perabot`,
    decor.length === 0, decor.length === 0 ? 'bersih' : JSON.stringify(decor.slice(0, 5)));
  check('semua agent working mendarat di kursi (bukan di lorong)',
    violations.filter((v) => v.kind === 'bukan-di-kursi').length === 0 && arrived === forced.total,
    violations.filter((v) => v.kind === 'bukan-di-kursi').length === 0
      ? `${arrived}/${forced.total} agent duduk` : JSON.stringify(violations.filter((v) => v.kind === 'bukan-di-kursi').slice(0, 5)));
  check('jarak agent ke kursi <= 0.30 unit', maxSeatD <= 0.3, `maks ${maxSeatD}`);
  check('tanpa exception JS', exceptions.length === 0, exceptions.join(' | ') || 'bersih');

  // Foto: overview + close-up tiap ruangan.
  const shots = [];
  await evaluate(`(() => { window.office3d.resetCamera(); return true; })()`);
  await sleep(600);
  shots.push(await shoot(`${outdir}/00-overview.png`));
  for (const room of rooms) {
    await evaluate(`(() => { window.office3d.look(${JSON.stringify(room)}, { dist: 15, angle: Math.PI * 0.72, height: 13 }); return true; })()`);
    await sleep(700);
    shots.push(await shoot(`${outdir}/ruang-${room}.png`));
  }

  const result = {
    url: args.url,
    checked_at: new Date().toISOString(),
    seconds,
    samples,
    forced,
    obstacles,
    violations,
    shots,
    checks,
    consoleErrors,
    exceptions,
    ok: checks.every((c) => c.ok) && consoleErrors.length === 0,
  };
  writeFileSync(`${outdir}/probe.json`, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({
    ok: result.ok,
    checks: checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ' (' + c.detail + ')' : ''}`),
    shots: shots.length,
    violations: violations.length,
  }, null, 2));
  ws.close();
  return result.ok ? 0 : 1;
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
