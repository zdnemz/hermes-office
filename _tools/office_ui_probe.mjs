#!/usr/bin/env node
/**
 * office_ui_probe.mjs -- smoke test antarmuka Kantor Digital 3D lewat CDP.
 *
 * Tidak butuh puppeteer: pakai WebSocket bawaan Node 22+ dan Chrome yang sudah
 * berjalan dengan --remote-debugging-port.
 *
 * Contoh:
 *   chrome --headless=new --remote-debugging-port=9222 --no-sandbox about:blank &
 *   node _tools/office_ui_probe.mjs --url http://127.0.0.1:3000/ \
 *        --screenshot outbox/2026-11-12-office3d/kantor.png \
 *        --json outbox/2026-11-12-office3d/probe.json --click research
 *
 * Exit code: 0 semua cek lolos, 1 ada cek gagal / error, 2 argumen salah.
 */

import { writeFileSync } from 'node:fs';

const args = parse(process.argv.slice(2));
if (args.help) {
  console.log(`pemakaian: node office_ui_probe.mjs --url URL [opsi]
  --url URL            halaman yang diuji (wajib)
  --cdp HOST:PORT      endpoint debug Chrome (default 127.0.0.1:9222)
  --screenshot PATH    simpan PNG
  --json PATH          simpan hasil probe sebagai JSON
  --click AGENT_ID     klik meja agent itu (lewat koordinat layar)
  --dispatch TARGET    kirim form dispatch ke agent TARGET (menulis file!)
  --goal TEXT          goal untuk --dispatch (default: teks uji)
  --expect N           jumlah meja yang diharapkan (default: sama dengan jumlah meja 3D)
  --audit SECONDS      audit navigasi selama N detik: cek agent tidak pernah
                       berada di dalam dinding / keluar playground
  --soak SECONDS       biarkan UI hidup N detik untuk menangkap error SSE/poll
  --timeout MS         batas tunggu UI siap (default 20000)`);
  process.exit(0);
}
if (!args.url) {
  console.error('--url wajib diisi (--help untuk bantuan)');
  process.exit(2);
}

const cdpHost = args.cdp || '127.0.0.1:9222';
// 0 = roster dinamis: cukup konsisten (meja 3D = baris roster = opsi dispatch).
let expectDesks = Number(args.expect || 0);
const timeoutMs = Number(args.timeout || 20000);

async function main() {
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
  const badResponses = [];

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
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      consoleErrors.push(msg.params.entry.text);
    }
    if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) {
      badResponses.push(`${msg.params.response.status} ${msg.params.response.url}`);
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

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
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
        const app = window.office3d;
        return !!(app && app.deskCount && app.deskCount() > 0 && document.querySelector('canvas'));
      })()`);
      if (ready) break;
    } catch { /* navigasi belum selesai */ }
  }
  if (!ready) throw new Error(`UI tidak siap dalam ${timeoutMs} ms`);

  // Beri waktu SSE/poll pertama masuk dan animasi berjalan.
  await sleep(1800);

  const probe = await evaluate(`(() => {
    const text = (id) => (document.getElementById(id) || {}).textContent || '';
    const canvas = document.querySelector('canvas');
    let gl = null, renderer = null, vendor = null;
    try {
      gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      }
    } catch (e) { renderer = 'ctx-error: ' + e.message; }
    return {
      title: document.title,
      canvas: canvas ? { w: canvas.width, h: canvas.height, cssW: canvas.clientWidth, cssH: canvas.clientHeight } : null,
      webgl: { ok: !!gl, renderer, vendor },
      fatalVisible: document.getElementById('fatal').classList.contains('show'),
      fatalText: text('fatal-body'),
      desks: window.office3d.deskCount(),
      agents: window.office3d.agents(),
      mode: window.office3d.mode(),
      rosterRows: document.querySelectorAll('#roster-list .agent-row').length,
      rosterCount: text('roster-count'),
      counters: { idle: text('cnt-idle'), working: text('cnt-working'), blocked: text('cnt-blocked') },
      conn: text('conn-text'),
      panelOpen: document.getElementById('side-panel').classList.contains('open'),
      hudSub: text('hud-sub'),
      targetOptions: document.querySelectorAll('#task-target option').length,
      staticFallback: text('task-submit'),
    };
  })()`);

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

  check('WebGL context aktif', probe.webgl.ok, probe.webgl.renderer || 'tidak ada context');
  check('tidak ada layar fatal', !probe.fatalVisible, probe.fatalText || '-');
  if (!expectDesks) expectDesks = probe.desks;
  check(`meja agent = ${expectDesks}`, probe.desks === expectDesks && probe.desks > 0, 'desks=' + probe.desks);
  check('roster menampilkan semua agent', probe.rosterRows === expectDesks, 'rows=' + probe.rosterRows);
  check('canvas punya ukuran', !!(probe.canvas && probe.canvas.w > 0 && probe.canvas.h > 0),
    probe.canvas ? `${probe.canvas.w}x${probe.canvas.h}` : 'tanpa canvas');
  check('data live dari server', probe.mode === 'live' || probe.mode === 'poll', 'mode=' + probe.mode);
  check('dropdown dispatch terisi', probe.targetOptions === expectDesks, 'options=' + probe.targetOptions);

  let clickResult = null;
  if (args.click) {
    clickResult = await clickDesk(send, evaluate, args.click);
    check('klik meja membuka command center', clickResult.panelOpen, JSON.stringify(clickResult));
  }

  let dispatch = null;
  if (args.dispatch) {
    dispatch = await dispatchTask(send, evaluate, args.dispatch, args.goal || 'Uji dispatch dari office_ui_probe');
    check('dispatch mengembalikan sukses', /Tiket masuk|berhasil/i.test(dispatch.resultText) || dispatch.ok,
      dispatch.resultText || dispatch.error || 'tanpa pesan');
  }

  let soak = null;
  if (args.soak) {
    await sleep(Math.min(Number(args.soak), 120) * 1000);
    soak = await evaluate(`(() => ({
      desks: window.office3d.deskCount(),
      rosterRows: document.querySelectorAll('#roster-list .agent-row').length,
      counters: {
        idle: document.getElementById('cnt-idle').textContent,
        working: document.getElementById('cnt-working').textContent,
        blocked: document.getElementById('cnt-blocked').textContent,
      },
      conn: document.getElementById('conn-text').textContent,
    }))()`);
    check('soak: meja tetap utuh setelah SSE/polling', soak.desks === expectDesks, 'desks=' + soak.desks);
    check('soak: tanpa exception JS', exceptions.length === 0, exceptions.join(' | ') || 'bersih');
  }

  let audit = null;
  if (args.audit) {
    const seconds = Math.min(Number(args.audit), 120);
    const samples = [];
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      await sleep(250);
      const snap = await evaluate(`(() => {
        const a = window.office3d.audit ? window.office3d.audit() : null;
        return a ? { violations: a.violations, agents: a.agents, walls: a.walls } : null;
      })()`);
      if (snap) samples.push(snap);
    }
    const seen = new Map();
    samples.forEach((s) => s.violations.forEach((v) => {
      const key = v.id + '|' + v.kind;
      if (!seen.has(key)) seen.set(key, { ...v, samples: 1 });
      else seen.get(key).samples += 1;
    }));
    audit = {
      seconds,
      samples: samples.length,
      agents: samples.length ? samples[samples.length - 1].agents : 0,
      walls: samples.length ? samples[samples.length - 1].walls : 0,
      violations: Array.from(seen.values()),
    };
    check(`audit navigasi: ${samples.length} sampel tanpa agent menabrak dinding`,
      audit.violations.length === 0,
      audit.violations.length ? JSON.stringify(audit.violations.slice(0, 5)) : `${audit.agents} agent / ${audit.walls} dinding`);
  }

  if (args.screenshot) {
    await sleep(400);
    if (dispatch) {
      // Geser panel ke bawah supaya kotak hasil dispatch ikut terfoto.
      await evaluate(`(() => { const b = document.querySelector('.panel-body'); if (b) b.scrollTop = b.scrollHeight; return true; })()`);
      await sleep(300);
    }
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(args.screenshot, Buffer.from(shot.data, 'base64'));
  }

  const result = {
    url: args.url,
    checked_at: new Date().toISOString(),
    probe,
    click: clickResult,
    dispatch,
    soak,
    audit,
    consoleErrors,
    exceptions,
    badResponses,
    checks,
    ok: checks.every((c) => c.ok) && exceptions.length === 0,
  };

  if (args.json) writeFileSync(args.json, JSON.stringify(result, null, 2) + '\n');

  console.log(JSON.stringify({
    ok: result.ok,
    checks: checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ' (' + c.detail + ')' : ''}`),
    exceptions,
    consoleErrors,
    badResponses,
    desks: probe.desks,
    mode: probe.mode,
    webgl: probe.webgl.renderer,
  }, null, 2));

  ws.close();
  process.exit(result.ok ? 0 : 1);
}

async function clickDesk(send, evaluate, agentId) {
  // Bawa kamera ke agent dulu supaya koordinat layar tidak tertimpa panel.
  await evaluate(`(() => { try { window.office3d.focus(${JSON.stringify(agentId)}, 12); } catch (e) {} return true; })()`);
  await sleep(500);

  // Agent idle terus berjalan, jadi koordinat layar bisa basi. Coba beberapa
  // kali dengan posisi freshly computed sebelum menyerah.
  let last = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const pos = await evaluate(`window.office3d.screenOf(${JSON.stringify(agentId)})`);
    if (!pos) return { panelOpen: false, error: 'agent tidak ditemukan di scene' };
    const base = { x: pos.x, y: pos.y, button: 'left', clickCount: 1 };
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: base.x, y: base.y });
    await send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
    await send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
    await sleep(600);
    last = await evaluate(`(() => {
      const panel = document.getElementById('side-panel');
      return {
        screen: { x: ${Math.round(pos.x)}, y: ${Math.round(pos.y)} },
        panelOpen: panel.classList.contains('open'),
        name: document.getElementById('panel-name').textContent,
        role: document.getElementById('panel-role').textContent,
        dept: document.getElementById('panel-dept').textContent,
        state: document.getElementById('panel-state').textContent,
        openCount: document.getElementById('panel-open-count').textContent,
        doneCount: document.getElementById('panel-done-count').textContent,
        target: document.getElementById('task-target').value,
      };
    })()`);
    if (last.panelOpen) return last;
  }
  return { ...(last || { panelOpen: false }), attempts: 4 };
}

async function dispatchTask(send, evaluate, target, goal) {
  const filled = await evaluate(`(() => {
    const target = document.getElementById('task-target');
    const goal = document.getElementById('task-goal');
    if (!target || !goal) return 'form tidak ada';
    target.value = ${JSON.stringify(target)};
    goal.value = ${JSON.stringify(goal)};
    document.getElementById('task-accept').value = 'File tugas pindah ke tasks/open/\\nAda bukti keluaran di outbox/';
    document.getElementById('task-priority').value = 'normal';
    document.getElementById('task-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    return 'submitted';
  })()`);

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await sleep(300);
    const text = await evaluate(`(document.getElementById('dispatch-result') || {}).textContent || ''`);
    if (text.trim()) {
      return { filled, ok: /Tiket masuk/i.test(text), resultText: text.trim().replace(/\\s+/g, ' ') };
    }
  }
  return { filled, ok: false, error: 'tidak ada respons dalam 15 detik' };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

function parse(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

main().catch((err) => {
  console.error('probe gagal:', err.message);
  process.exit(1);
});
