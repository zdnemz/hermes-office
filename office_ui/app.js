/* Hermes Office 3D -- frontend (Three.js r128 + vanilla JS). */
(function () {
  'use strict';

  const STATE_COLORS = { idle: 0x10b981, working: 0xf59e0b, blocked: 0xef4444, meeting: 0x0ea5e9 };
  const STATE_HEX = { idle: '#10b981', working: '#f59e0b', blocked: '#ef4444', meeting: '#0ea5e9' };
  const STATE_LABEL = { idle: 'idle', working: 'working', blocked: 'blocked', meeting: 'meeting' };
  const $ = function (id) { return document.getElementById(id); };

  const app = {
    scene: null, camera: null, renderer: null, controls: null, lights: null,
    rooms: [], roomById: new Map(), roomGroups: new Map(),
    building: null, grid: null, solids: [],
    playground: null, walkBounds: null, zones: [], zoneById: new Map(),
    wallBoxes: [], perimeterWalls: [],
    deskObstacles: [],
    meeting: null, meetingLive: null, furniture: [], hotDesk: null,
    agentById: new Map(), agents: [],
    deskById: new Map(),
    forcedState: {},
    selectedId: null, hoveredId: null,
    stream: null, online: false, mode: 'init',
    clock: 0, lastFrame: 0, cutawayTick: 0, bubbleTick: 0, lightTick: 0,
    rosterSig: '', lastEventAt: 0, targetSig: '', layoutVersion: '',
    pollTimer: null, toastTimer: null, pendingDispatch: false,
    csrf: '', demo: false, auth: true,
    follow: false, tween: null,
    prefs: { bubbles: true, daynight: true, feed: true },
    reducedMotion: window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    feedSeq: 0, panelTab: 'overview', openTask: null, layoutLoading: false
  };

  /* ================================================================
   * Util
   * ================================================================ */
  function fail(title, body) {
    $('fatal-title').textContent = title;
    $('fatal-body').textContent = body;
    $('fatal').classList.add('show');
  }

  function toast(message, isError) {
    const el = $('toast');
    el.textContent = message;
    el.classList.toggle('err', !!isError);
    el.classList.add('show');
    clearTimeout(app.toastTimer);
    app.toastTimer = setTimeout(function () { el.classList.remove('show'); }, 4200);
  }

  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function deptOrder(agents) {
    const order = [];
    agents.forEach(function (a) { if (!order.includes(a.dept)) order.push(a.dept); });
    return order;
  }

  function countByState(agents) {
    const c = { idle: 0, working: 0, blocked: 0 };
    agents.forEach(function (a) { c[a.state] = (c[a.state] || 0) + 1; });
    return c;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ================================================================
   * Label sprite (canvas)
   * ================================================================ */
  function makeLabel(text, opts) {
    opts = opts || {};
    const fontSize = opts.fontSize || 46;
    const family = '"Segoe UI", Roboto, Helvetica, Arial, sans-serif';
    const weight = opts.weight || 700;
    const color = opts.color || '#e6edf7';
    const bg = opts.bg === null ? null : (opts.bg || 'rgba(8,13,24,0.78)');
    const border = opts.border || null;
    const padX = Math.round(fontSize * 0.45);
    const padY = Math.round(fontSize * 0.32);

    const measure = document.createElement('canvas').getContext('2d');
    measure.font = weight + ' ' + fontSize + 'px ' + family;
    const textW = Math.ceil(measure.measureText(text).width);

    const canvas = document.createElement('canvas');
    canvas.width = textW + padX * 2;
    canvas.height = fontSize + padY * 2;
    const ctx = canvas.getContext('2d');
    ctx.font = weight + ' ' + fontSize + 'px ' + family;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (bg) {
      ctx.fillStyle = bg;
      roundRect(ctx, 1, 1, canvas.width - 2, canvas.height - 2, Math.min(18, canvas.height / 3));
      ctx.fill();
    }
    if (border) {
      ctx.strokeStyle = border;
      ctx.lineWidth = 3;
      roundRect(ctx, 2, 2, canvas.width - 4, canvas.height - 4, Math.min(18, canvas.height / 3));
      ctx.stroke();
    }
    ctx.fillStyle = color;
    ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 1);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    if (THREE.sRGBEncoding !== undefined) texture.encoding = THREE.sRGBEncoding;
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(material);
    const targetHeight = opts.height || 0.5;
    const k = targetHeight / canvas.height;
    sprite.scale.set(canvas.width * k, canvas.height * k, 1);
    sprite.userData.texture = texture;
    sprite.userData.material = material;
    return sprite;
  }

  function makeExclaimTexture() {
    if (makeExclaimTexture.tex) return makeExclaimTexture.tex;
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, 128, 128);
    ctx.beginPath();
    ctx.arc(64, 64, 52, 0, Math.PI * 2);
    ctx.fillStyle = '#ef4444';
    ctx.fill();
    ctx.lineWidth = 7;
    ctx.strokeStyle = '#7f1d1d';
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 84px "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('!', 64, 70);
    const tex = new THREE.CanvasTexture(c);
    if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
    makeExclaimTexture.tex = tex;
    return tex;
  }

  /* Teks besar yang menempel di lantai (decal). */
  function makeFloorText(text, opts) {
    opts = opts || {};
    const fontSize = opts.fontSize || 72;
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = '800 ' + fontSize + 'px "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = opts.color || 'rgba(255,255,255,0.34)';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    const tex = new THREE.CanvasTexture(canvas);
    if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(opts.width || 8, (opts.width || 8) / 4),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
    );
    mesh.rotation.x = -Math.PI / 2;
    return mesh;
  }

  /* ================================================================
   * Tekstur prosedural (karpet, beton, kayu, permadani)
   * ================================================================ */
  function makeCarpetTexture(base, line, rx, ry) {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 5200; i += 1) {
      const a = 0.02 + Math.random() * 0.05;
      ctx.fillStyle = Math.random() > 0.5 ? 'rgba(255,255,255,' + a + ')' : 'rgba(0,0,0,' + a + ')';
      const s = 1 + Math.random() * 2;
      ctx.fillRect(Math.random() * 256, Math.random() * 256, s, s);
    }
    ctx.strokeStyle = line;
    ctx.lineWidth = 1.5;
    for (let i = 0; i <= 256; i += 64) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 256); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(256, i); ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(rx, ry);
    tex.anisotropy = Math.min(8, app.renderer.capabilities.getMaxAnisotropy());
    if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
    return tex;
  }

  function makeConcreteTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#767f8b';
    ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 4200; i += 1) {
      const a = 0.03 + Math.random() * 0.07;
      ctx.fillStyle = Math.random() > 0.5 ? 'rgba(255,255,255,' + a + ')' : 'rgba(34,42,52,' + a + ')';
      const s = 1 + Math.random() * 3;
      ctx.fillRect(Math.random() * 256, Math.random() * 256, s, s);
    }
    ctx.strokeStyle = 'rgba(48,56,66,0.22)';
    ctx.lineWidth = 2;
    for (let i = 0; i <= 256; i += 128) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 256); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(256, i); ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(14, 12);
    tex.anisotropy = Math.min(8, app.renderer.capabilities.getMaxAnisotropy());
    if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
    return tex;
  }

  function makeWoodTexture() {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 256;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#8b6844';
    ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 90; i += 1) {
      ctx.strokeStyle = 'rgba(90,62,36,' + (0.05 + Math.random() * 0.18) + ')';
      ctx.lineWidth = 1 + Math.random() * 3;
      ctx.beginPath();
      const y = Math.random() * 256;
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(80, y + (Math.random() - 0.5) * 14, 170, y + (Math.random() - 0.5) * 14, 256, y + (Math.random() - 0.5) * 8);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(2, 2);
    if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
    return tex;
  }

  function makeBookRowTexture() {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#20160f';
    ctx.fillRect(0, 0, 256, 64);
    const colors = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#94a3b8', '#f97316', '#14b8a6'];
    let x = 2;
    while (x < 252) {
      const w = 8 + Math.random() * 12;
      const h = 38 + Math.random() * 20;
      ctx.fillStyle = colors[Math.floor(Math.random() * colors.length)];
      ctx.fillRect(x, 62 - h, w - 1.5, h);
      x += w;
    }
    const tex = new THREE.CanvasTexture(c);
    if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
    return tex;
  }

  function makeRugTexture(base, accent) {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 7;
    ctx.strokeRect(15, 15, 226, 226);
    ctx.lineWidth = 2;
    ctx.strokeRect(27, 27, 202, 202);
    for (let i = 0; i < 2600; i += 1) {
      const a = 0.02 + Math.random() * 0.06;
      ctx.fillStyle = Math.random() > 0.5 ? 'rgba(255,255,255,' + a + ')' : 'rgba(0,0,0,' + a + ')';
      ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
    }
    const tex = new THREE.CanvasTexture(c);
    /* Sekali saja: kalau di-repeat, garis pinggir jadi pola kotak dan
       permadani terbaca sebagai "ruang" baru, bukan alas santai. */
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.repeat.set(1, 1);
    if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
    return tex;
  }

  /* ================================================================
   * Material & geometry helpers
   * ================================================================ */
  const MATS = {};

  function initMats() {
    MATS.wallOuter = new THREE.MeshStandardMaterial({ color: 0xa9b4c2, roughness: 0.88, metalness: 0.02 });
    MATS.wallBase = new THREE.MeshStandardMaterial({ color: 0x3d4756, roughness: 0.72, metalness: 0.12 });
    MATS.wallTrim = new THREE.MeshStandardMaterial({ color: 0x232c38, roughness: 0.5, metalness: 0.45 });
    MATS.wood = new THREE.MeshStandardMaterial({ map: makeWoodTexture(), roughness: 0.62, metalness: 0.05 });
    MATS.woodDark = new THREE.MeshStandardMaterial({ color: 0x4b3527, roughness: 0.78, metalness: 0.05 });
    MATS.woodLux = new THREE.MeshStandardMaterial({ color: 0x5c3f28, roughness: 0.45, metalness: 0.08 });
    MATS.metal = new THREE.MeshStandardMaterial({ color: 0x39424f, roughness: 0.4, metalness: 0.72 });
    MATS.dark = new THREE.MeshStandardMaterial({ color: 0x1a2330, roughness: 0.55, metalness: 0.35 });
    MATS.chair = new THREE.MeshStandardMaterial({ color: 0x2f3a4b, roughness: 0.84, metalness: 0.06 });
    MATS.leather = new THREE.MeshStandardMaterial({ color: 0x4a2f2c, roughness: 0.6, metalness: 0.04 });
    MATS.paper = new THREE.MeshStandardMaterial({ color: 0xeef2f7, roughness: 0.9, metalness: 0.0 });
    MATS.frame = new THREE.MeshStandardMaterial({ color: 0x2b3646, roughness: 0.5, metalness: 0.62 });
    MATS.slab = new THREE.MeshStandardMaterial({ color: 0x252d38, roughness: 0.92, metalness: 0.08 });
    MATS.pot = new THREE.MeshStandardMaterial({ color: 0x9a6a4f, roughness: 0.85 });
    MATS.stem = new THREE.MeshStandardMaterial({ color: 0x3f6b3a, roughness: 0.8 });
    MATS.leaf = new THREE.MeshStandardMaterial({ color: 0x3f8f4f, roughness: 0.82 });
    MATS.leafDark = new THREE.MeshStandardMaterial({ color: 0x2f7040, roughness: 0.84 });
    MATS.concrete = new THREE.MeshStandardMaterial({ map: makeConcreteTexture(), roughness: 0.88, metalness: 0.04 });
    MATS.ground = new THREE.MeshStandardMaterial({ color: 0x121a24, roughness: 1, metalness: 0 });
    MATS.book = [0xef4444, 0x3b82f6, 0x10b981, 0xf59e0b, 0x8b5cf6, 0xec4899, 0x94a3b8].map(function (c) {
      return new THREE.MeshStandardMaterial({ color: c, roughness: 0.86 });
    });
    MATS.shadow = new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0.18, depthWrite: false
    });
    MATS.bookRow = new THREE.MeshStandardMaterial({ map: makeBookRowTexture(), roughness: 0.9 });
    MATS.glassRoom = new THREE.MeshPhysicalMaterial({
      color: 0xbfe4ff, transparent: true, opacity: 0.22, roughness: 0.06, metalness: 0.0,
      clearcoat: 1, clearcoatRoughness: 0.05, side: THREE.DoubleSide, depthWrite: false
    });
    MATS.lampShade = new THREE.MeshStandardMaterial({
      color: 0xf3d6a0, emissive: 0xffbf73, emissiveIntensity: 1.1, side: THREE.DoubleSide
    });
    MATS.screenGlow = new THREE.MeshStandardMaterial({
      color: 0x071726, emissive: 0x38bdf8, emissiveIntensity: 0.6, roughness: 0.25, metalness: 0.1
    });
  }

  function addBox(parent, w, h, d, mat, x, y, z, cast) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = cast !== false;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }

  function addCyl(parent, rt, rb, h, seg, mat, x, y, z) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }

  function addSphere(parent, r, mat, x, y, z, seg) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, seg || 14, seg ? Math.max(8, seg - 4) : 10), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }

  /* ================================================================
   * Grid navigasi (A*)
   *
   * Lantai gedung dipecah jadi sel NAV_CELL. Semua yang padat
   * digembungkan AGENT_RADIUS lalu menandai sel:
   *   HARD = dinding + luar gedung   -> tidak pernah dilewati
   *   SOFT = meja, kursi, perabot, dekor (dari mesh nyata)
   *          -> hanya boleh dimasuki dalam SOFT_REACH dari titik awal/
   *             tujuan (bangkit dari / duduk di kursi, berdiri di sofa)
   * Rute = A* 8 arah lalu dirapikan (string pulling) lewat sel bebas.
   * ================================================================ */
  const NAV_CELL = 0.25;
  const NAV_SOFT = 1, NAV_HARD = 2;
  const SOFT_REACH = 1.2;
  const SOFT_COST = 8;

  function buildNavGrid() {
    const poly = app.building.polygon;
    const xs = poly.map(function (p) { return p[0]; });
    const zs = poly.map(function (p) { return p[1]; });
    const x0 = Math.min.apply(null, xs), z0 = Math.min.apply(null, zs);
    const nx = Math.ceil((Math.max.apply(null, xs) - x0) / NAV_CELL);
    const nz = Math.ceil((Math.max.apply(null, zs) - z0) / NAV_CELL);
    const cells = new Uint8Array(nx * nz);
    for (let iz = 0; iz < nz; iz += 1) {
      for (let ix = 0; ix < nx; ix += 1) {
        if (!pointInPoly(x0 + (ix + 0.5) * NAV_CELL, z0 + (iz + 0.5) * NAV_CELL, poly)) cells[iz * nx + ix] = NAV_HARD;
      }
    }
    const R = AGENT_RADIUS;
    function mark(b, v) {
      const ia = Math.max(0, Math.ceil((b.x0 - R - x0) / NAV_CELL - 0.5));
      const ib = Math.min(nx - 1, Math.floor((b.x1 + R - x0) / NAV_CELL - 0.5));
      const ja = Math.max(0, Math.ceil((b.z0 - R - z0) / NAV_CELL - 0.5));
      const jb = Math.min(nz - 1, Math.floor((b.z1 + R - z0) / NAV_CELL - 0.5));
      for (let j = ja; j <= jb; j += 1) {
        for (let i = ia; i <= ib; i += 1) {
          if (cells[j * nx + i] < v) cells[j * nx + i] = v;
        }
      }
    }
    app.wallBoxes.forEach(function (b) { mark(b, NAV_HARD); });
    app.solids.forEach(function (b) { mark(b, NAV_SOFT); });
    app.deskObstacles.forEach(function (b) { mark(b, NAV_SOFT); });
    app.furniture.forEach(function (b) { mark(b, NAV_SOFT); });
    app.grid = { x0: x0, z0: z0, nx: nx, nz: nz, cells: cells };
    return app.grid;
  }

  function navCell(x, z) {
    const g = app.grid;
    const ix = Math.min(g.nx - 1, Math.max(0, Math.floor((x - g.x0) / NAV_CELL)));
    const iz = Math.min(g.nz - 1, Math.max(0, Math.floor((z - g.z0) / NAV_CELL)));
    return iz * g.nx + ix;
  }

  function navCenter(i) {
    const g = app.grid;
    return { x: g.x0 + (i % g.nx + 0.5) * NAV_CELL, z: g.z0 + (Math.floor(i / g.nx) + 0.5) * NAV_CELL };
  }

  /* Titik bebas dari dinding & perabot (untuk titik santai acak). */
  function navFree(x, z) {
    return !app.grid || app.grid.cells[navCell(x, z)] === 0;
  }

  /* Titik santai tulisan tangan: bukan di dinding dan badan agent tidak
     masuk ke tapak dekor (sofa, meja kopi, ...). */
  function standable(x, z) {
    if (app.grid && app.grid.cells[navCell(x, z)] === NAV_HARD) return false;
    const r = AGENT_RADIUS * 0.5;
    return !app.solids.some(function (o) { return x > o.x0 - r && x < o.x1 + r && z > o.z0 - r && z < o.z1 + r; });
  }

  /* Sel non-HARD terdekat (BFS); -1 kalau tidak ada. */
  function nearestOpen(start) {
    const g = app.grid;
    const seen = new Uint8Array(g.cells.length);
    const queue = [start];
    seen[start] = 1;
    for (let q = 0; q < queue.length; q += 1) {
      const i = queue[q];
      if (g.cells[i] !== NAV_HARD) return i;
      const ix = i % g.nx;
      [ix > 0 ? i - 1 : -1, ix < g.nx - 1 ? i + 1 : -1, i - g.nx, i + g.nx].forEach(function (n) {
        if (n >= 0 && n < g.cells.length && !seen[n]) { seen[n] = 1; queue.push(n); }
      });
    }
    return -1;
  }

  /* Garis a-b hanya melewati sel bebas (sel titik ujung boleh SOFT). */
  function navLos(a, b) {
    const g = app.grid;
    const ca = navCell(a.x, a.z), cb = navCell(b.x, b.z);
    const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (NAV_CELL / 3));
    for (let k = 0; k <= n; k += 1) {
      const t = n ? k / n : 0;
      const c = navCell(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
      if (g.cells[c] === NAV_HARD || (g.cells[c] === NAV_SOFT && c !== ca && c !== cb)) return false;
    }
    return true;
  }

  /* Rute from -> to (tanpa titik from). [] kalau tidak ada jalan.
     Titik terakhir = to (beserta properti lain seperti face). */
  function findPath(from, to) {
    const g = app.grid;
    if (!g) return [to];
    const nx = g.nx, cells = g.cells;
    const s0 = navCell(from.x, from.z), t0 = navCell(to.x, to.z);
    const s = cells[s0] === NAV_HARD ? nearestOpen(s0) : s0;
    const t = cells[t0] === NAV_HARD ? nearestOpen(t0) : t0;
    if (s < 0 || t < 0) return [];
    const end = t === t0 ? to : Object.assign({}, to, navCenter(t));
    if (s === t) return [end];
    const sx = s % nx, sz = Math.floor(s / nx), tx = t % nx, tz = Math.floor(t / nx);
    const reach = SOFT_REACH / NAV_CELL;
    function ok(i) {
      const c = cells[i];
      if (c === 0) return true;
      if (c === NAV_HARD) return false;
      const ix = i % nx, iz = Math.floor(i / nx);
      return Math.hypot(ix - sx, iz - sz) <= reach || Math.hypot(ix - tx, iz - tz) <= reach;
    }
    function h(i) {
      const dx = Math.abs(i % nx - tx), dz = Math.abs(Math.floor(i / nx) - tz);
      return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
    }
    const cost = new Float32Array(cells.length).fill(Infinity);
    const came = new Int32Array(cells.length).fill(-1);
    const done = new Uint8Array(cells.length);
    // binary heap [f, i]
    const heap = [];
    function push(f, i) {
      heap.push([f, i]);
      let k = heap.length - 1;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (heap[p][0] <= heap[k][0]) break;
        const tmp = heap[p]; heap[p] = heap[k]; heap[k] = tmp; k = p;
      }
    }
    function pop() {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let k = 0;
        for (;;) {
          const l = 2 * k + 1, r = l + 1;
          let m = k;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === k) break;
          const tmp = heap[m]; heap[m] = heap[k]; heap[k] = tmp; k = m;
        }
      }
      return top;
    }
    cost[s] = 0;
    push(h(s), s);
    let found = false;
    while (heap.length) {
      const i = pop()[1];
      if (done[i]) continue;
      done[i] = 1;
      if (i === t) { found = true; break; }
      const ix = i % nx;
      for (let dz = -1; dz <= 1; dz += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dz) continue;
          if ((dx < 0 && ix === 0) || (dx > 0 && ix === nx - 1)) continue;
          const n = i + dz * nx + dx;
          if (n < 0 || n >= cells.length || done[n] || !ok(n)) continue;
          // diagonal tidak boleh memotong sudut sel terhalang
          if (dx && dz && (!ok(i + dx) || !ok(i + dz * nx))) continue;
          const c = cost[i] + (dx && dz ? Math.SQRT2 : 1) * (cells[n] === NAV_SOFT ? SOFT_COST : 1);
          if (c < cost[n]) { cost[n] = c; came[n] = i; push(c + h(n), n); }
        }
      }
    }
    if (!found) return [];
    const chain = [];
    for (let i = came[t]; i !== -1 && i !== s; i = came[i]) chain.unshift(navCenter(i));
    if (s !== s0) chain.unshift(navCenter(s));
    chain.unshift({ x: from.x, z: from.z });
    chain.push(end);
    // string pulling: lompat ke titik terjauh yang masih terlihat
    const out = [];
    for (let i = 0; i < chain.length - 1;) {
      let j = chain.length - 1;
      while (j > i + 1 && !navLos(chain[i], chain[j])) j -= 1;
      out.push(chain[j]);
      i = j;
    }
    return out;
  }

  /* ================================================================
   * Penggabungan geometri statis
   *
   * Sebelum digabung, tiap kotak furnitur = 1 draw call. Kantor ini
   * punya +-1100 objek, dan draw call adalah biaya utama (terutama di
   * WebGL software). Semua mesh statis yang satu material digabung
   * jadi satu geometri per material -> draw call turun drastis.
   * Mesh yang harus bergerak (tubuh agent) tidak ikut digabung.
   * ================================================================ */
  function mergeGeometryList(items) {
    let total = 0;
    const prepped = items.map(function (it) {
      const g = it.geo.index ? it.geo.toNonIndexed() : it.geo.clone();
      g.applyMatrix4(it.matrix);
      total += g.attributes.position.count;
      return g;
    });
    const pos = new Float32Array(total * 3);
    const nor = new Float32Array(total * 3);
    const uv = new Float32Array(total * 2);
    let o3 = 0;
    let o2 = 0;
    prepped.forEach(function (g) {
      const count = g.attributes.position.count;
      pos.set(g.attributes.position.array, o3);
      if (g.attributes.normal) nor.set(g.attributes.normal.array, o3);
      if (g.attributes.uv) uv.set(g.attributes.uv.array, o2);
      o3 += count * 3;
      o2 += count * 2;
    });
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    out.computeBoundingSphere();
    return out;
  }

  /* solids (opsional): kotak tapak tiap mesh setinggi badan agent, untuk
     grid navigasi. Dikumpulkan SEBELUM digabung (setelahnya cuma ada satu
     kotak raksasa per material). Lantai/karpet & lampu gantung dilewati. */
  function mergeStaticMeshes(root, solids) {
    if (!root) return 0;
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const buckets = new Map();
    const originals = [];
    root.traverse(function (o) {
      if (!o.isMesh || o.isSprite) return;
      if (!o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
      if (Array.isArray(o.material)) return;
      const key = o.material.uuid;
      if (!buckets.has(key)) {
        buckets.set(key, { material: o.material, cast: o.castShadow, recv: o.receiveShadow, items: [] });
      }
      if (solids && o.visible) {
        const bb = new THREE.Box3().setFromObject(o);
        if (bb.max.y > 0.15 && bb.min.y < 1.8) solids.push({ x0: bb.min.x, x1: bb.max.x, z0: bb.min.z, z1: bb.max.z });
      }
      const matrix = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
      buckets.get(key).items.push({ geo: o.geometry, matrix: matrix });
      originals.push(o);
    });
    if (!originals.length) return 0;
    originals.forEach(function (o) { if (o.parent) o.parent.remove(o); });
    let merged = 0;
    buckets.forEach(function (b) {
      if (!b.items.length) return;
      const mesh = new THREE.Mesh(mergeGeometryList(b.items), b.material);
      mesh.castShadow = b.cast;
      mesh.receiveShadow = b.recv;
      root.add(mesh);
      merged += 1;
    });
    return merged;
  }

  /* ================================================================
   * Bangunan kantor
   * ================================================================ */
  /* Sidik struktur denah: berubah kalau ruangan/gedung berubah (departemen
     baru, annex tumbuh), bukan sekadar meja bergeser. */
  function structSig(layout) {
    return JSON.stringify([layout.building.polygon, layout.rooms.map(function (r) {
      return [r.id, r.x, r.z, r.w, r.d, r.label, r.accent, r.decor];
    }), layout.props || []]);
  }

  function buildWorld(layout) {
    // ponytail: geometri lama tidak di-dispose; rebuild hanya saat denah
    // berubah struktur (jarang). Dispose kalau rebuild jadi sering.
    if (app.world) app.scene.remove(app.world);
    const world = new THREE.Group();
    const scene = app.scene;
    app.scene = world;            // helper build memanggil app.scene.add(...)
    app.metaById = {};
    (layout.agents || []).forEach(function (a) { app.metaById[a.id] = a; });
    try {
      buildWorldInto(layout);
    } finally {
      app.scene = scene;
    }
    scene.add(world);
    app.world = world;
    app.structSig = structSig(layout);
  }

  function buildWorldInto(layout) {
    app.roomGroups = new Map();
    app.rooms = layout.rooms;
    app.roomById = new Map();
    app.rooms.forEach(function (r) { app.roomById.set(r.id, r); });
    app.playground = app.rooms.find(function (r) { return r.style === 'playground'; }) ||
      app.rooms.find(function (r) { return r.kind === 'lounge'; });
    app.building = layout.building;
    app.hotDesk = layout.hot_desk || null;
    app.layoutVersion = layout.version || '';
    app.wallBoxes = [];
    app.solids = [];
    app.perimeterWalls = [];
    app.zones = [];
    app.zoneById = new Map();
    buildDeskObstacles();
    buildMeetingFurniture(layout.meeting);

    buildShell();
    app.rooms.forEach(function (room) {
      if (room.kind === 'lounge') buildPlayground(room);
      else buildRoom(room);
    });
    // Tanpa ruang santai sama sekali: agent idle berkeliling di lantai gedung.
    if (!app.zones.length) {
      const xs = app.building.polygon.map(function (p) { return p[0]; });
      const zs = app.building.polygon.map(function (p) { return p[1]; });
      registerZone({ id: 'lobby', room: { x: 0, z: 0 }, walled: false, cap: 99, weight: 1, spots: [],
        bounds: { x0: Math.min.apply(null, xs), x1: Math.max.apply(null, xs),
          z0: Math.min.apply(null, zs), z1: Math.max.apply(null, zs) } });
    }
    app.walkBounds = (app.zoneById.get('playground') || app.zones[0]).bounds;

    // Perabot kustom (editor denah): mesh + kotak tabrakan untuk agent.
    app.propTypes = layout.prop_types || {};
    app.propGroup = new THREE.Group();
    (layout.props || []).forEach(function (p) {
      app.propGroup.add(buildProp({ id: p.id, type: p.type, x: p.x, z: p.z, rot: (p.deg || 0) * Math.PI / 180 }));
      const t = app.propTypes[p.type];
      if (t && t[2]) {
        const r = propRect(p);
        app.furniture.push({ kind: 'prop', key: p.id, x0: r[0], x1: r[1], z0: r[2], z1: r[3] });
      }
    });
    app.propGroup.visible = !ED.on;
    app.scene.add(app.propGroup);
    buildNavGrid();
  }

  /* Poligon gedung (huruf Z) -> lantai beton + dinding luar solid. */
  function buildShell() {
    const poly = app.building.polygon;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(260, 260), MATS.ground);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.35;
    ground.receiveShadow = true;
    app.scene.add(ground);

    // Lantai beton mengikuti bentuk gedung (bukan kotak).
    const shape = new THREE.Shape();
    poly.forEach(function (p, i) {
      if (i === 0) shape.moveTo(p[0], -p[1]);
      else shape.lineTo(p[0], -p[1]);
    });
    shape.closePath();
    const floorGeo = new THREE.ShapeGeometry(shape);
    const floor = new THREE.Mesh(floorGeo, MATS.concrete);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.004;
    floor.receiveShadow = true;
    app.scene.add(floor);

    // Dinding luar: solid tebal. Sisi yang menghadap kamera dipotong
    // (cutaway) supaya isi kantor tetap terlihat dari kamera isometrik.
    const entrance = app.building.entrance || { x: 0, z: 10, width: 3.6 };
    const H = app.building.wall_height || 3.35;
    const T = app.building.wall_thickness || 0.45;

    for (let i = 0; i < poly.length; i += 1) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len = Math.hypot(dx, dz);
      const cx = (a[0] + b[0]) / 2;
      const cz = (a[1] + b[1]) / 2;
      const alongX = Math.abs(dx) > Math.abs(dz);
      // normal luar (menunjuk ke luar gedung)
      const nx = alongX ? 0 : (dz > 0 ? 1 : -1);
      const nz = alongX ? (dx > 0 ? 1 : -1) : 0;

      // Cek apakah segmen ini memuat pintu masuk.
      const isEntranceSide = alongX && Math.abs(cz - entrance.z) < 0.01 &&
        entrance.x > Math.min(a[0], b[0]) && entrance.x < Math.max(a[0], b[0]);
      const runs = [];
      if (isEntranceSide) {
        const half = entrance.width / 2;
        const left = entrance.x - half;
        const right = entrance.x + half;
        const from = Math.min(a[0], b[0]);
        const to = Math.max(a[0], b[0]);
        if (left - from > 0.05) runs.push([from, left]);
        if (to - right > 0.05) runs.push([right, to]);
      } else {
        runs.push([Math.min(a[0], b[0]), Math.max(a[0], b[0])]);
      }

      runs.forEach(function (run) {
        if (alongX) {
          const segLen = run[1] - run[0];
          const mid = (run[0] + run[1]) / 2;
          if (segLen < 0.1) return;
          addPerimeterWall(mid, cz, segLen, T, H, alongX, nx, nz);
        } else {
          const segLen = run[1] - run[0];
          const mid = (run[0] + run[1]) / 2;
          if (segLen < 0.1) return;
          addPerimeterWall(cx, mid, segLen, T, H, alongX, nx, nz);
        }
      });
    }

    // Kusen + kanopi pintu masuk
    const e = entrance;
    const frameMat = MATS.frame;
    addBox(app.scene, 0.26, 2.9, T + 0.2, frameMat, e.x - e.width / 2 - 0.13, 1.45, e.z);
    addBox(app.scene, 0.26, 2.9, T + 0.2, frameMat, e.x + e.width / 2 + 0.13, 1.45, e.z);
    addBox(app.scene, e.width + 0.52, 0.2, T + 0.24, frameMat, e.x, 2.92, e.z);
    addBox(app.scene, e.width + 1.8, 0.14, 1.8, frameMat, e.x, 3.1, e.z + 0.7, false);

    const sign = makeLabel('SWARM ENTERPRISE', {
      fontSize: 50, height: 0.62, color: '#e9f6ff',
      bg: 'rgba(12,20,34,0.88)', border: '#38bdf8'
    });
    sign.position.set(e.x, 3.55, e.z + 0.3);
    app.scene.add(sign);

    // Halaman luar: pot beton + tanaman, supaya gedung tidak "melayang".
    const outside = new THREE.Group();
    app.scene.add(outside);
    const south = Math.max.apply(null, poly.map(function (p) { return p[1]; }));
    const east = Math.max.apply(null, poly.map(function (p) { return p[0]; }));
    [[-14, 13.5], [14, 13.5], [-2, 20.5], [12, -21], [-14, -21]].forEach(function (p, i) {
      if (!pointInPoly(p[0], p[1], poly) && !nearPoly(p[0], p[1], poly, 1.6)) {
        createPlanter(outside, p[0], p[1], 1 + (i % 2) * 0.25);
      }
    });
    for (let x = -30; x <= east + 4; x += 9) {
      createTree(outside, x, south + 6 + (Math.round((x + 30) / 9) % 2) * 2.5);
    }
  }

  function pointInPoly(x, z, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
      const a = poly[i], b = poly[j];
      if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }

  function nearPoly(x, z, poly, r) {
    return [[r, 0], [-r, 0], [0, r], [0, -r]].some(function (d) { return pointInPoly(x + d[0], z + d[1], poly); });
  }

  /* Kamera "seluruh kantor": ikut membesar kalau gedung tumbuh (annex). */
  function homeView() {
    const poly = (app.building && app.building.polygon) || [[-26, -18], [26, 18]];
    const xs = poly.map(function (p) { return p[0]; });
    const zs = poly.map(function (p) { return p[1]; });
    const x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    const z0 = Math.min.apply(null, zs), z1 = Math.max.apply(null, zs);
    const s = Math.max(1, (x1 - x0) / 52, (z1 - z0) / 36);
    const cx = (x0 + x1) / 2 - 4, cz = (z0 + z1) / 2;
    return { pos: [cx, 49.05 * s, cz + 44.16 * s], target: [cx, 0, cz] };
  }

  /* Katalog perabot kustom (editor denah). Ukuran tapak (w x d, rot 0)
     dicerminkan di server (PROP_TYPES) untuk validasi tabrakan. */
  const PROP_BUILDERS = {
    plant: function (g) { createPlant(g, 0, 0, 1); },
    planter: function (g) { createPlanter(g, 0, 0, 1); },
    sofa: function (g) { createSofa(g, 0, 0, 0, 0x4a3550); },
    bookshelf: function (g) { createBookshelf(g, 0, 0, 0); },
    beanbag: function (g) { createBeanbag(g, 0, 0, 0x0ea5e9); },
    floorlamp: function (g) { createFloorLamp(g, 0, 0); },
    roundtable: function (g) { createRoundTable(g, 0, 0, 0, { radius: 0.6, chairs: false }); },
    crate: function (g) { createCrate(g, 0, 0, 1); },
    printer: function (g) { createPrinter(g, 0, 0); },
    serverrack: function (g) { createServerRack(g, 0, 0, 0); },
    credenza: function (g) { createCredenza(g, 0, 0, 0); },
    labbench: function (g) { createLabBench(g, 0, 0, 0); },
    rug: function (g) { createRug(g, 0, 0, 3, 2, '#3f5a63', '#7dd3fc'); }
  };

  function buildProp(p) {
    const g = new THREE.Group();
    (PROP_BUILDERS[p.type] || PROP_BUILDERS.crate)(g);
    g.position.set(p.x, 0, p.z);
    g.rotation.y = p.rot || 0;
    g.userData.propId = p.id;
    return g;
  }

  function addPerimeterWall(cx, cz, len, T, H, alongX, nx, nz) {
    const g = new THREE.Group();
    const lowH = 1.15;
    const highH = H - lowH;
    const low = new THREE.Mesh(new THREE.BoxGeometry(alongX ? len : T, lowH, alongX ? T : len), MATS.wallOuter);
    low.position.set(0, lowH / 2, 0);
    low.castShadow = true;
    low.receiveShadow = true;
    g.add(low);

    const high = new THREE.Mesh(new THREE.BoxGeometry(alongX ? len : T, highH, alongX ? T : len), MATS.wallOuter);
    high.position.set(0, lowH + highH / 2, 0);
    high.castShadow = true;
    high.receiveShadow = true;
    g.add(high);

    const cap = new THREE.Mesh(new THREE.BoxGeometry(alongX ? len : T + 0.14, 0.16, alongX ? T + 0.14 : len), MATS.wallTrim);
    cap.position.set(0, H + 0.06, 0);
    g.add(cap);

    const base = new THREE.Mesh(new THREE.BoxGeometry(alongX ? len : T + 0.06, 0.16, alongX ? T + 0.06 : len), MATS.wallTrim);
    base.position.set(0, 0.08, 0);
    g.add(base);

    g.position.set(cx, 0, cz);
    app.scene.add(g);

    app.perimeterWalls.push({
      group: g, high: high, cap: cap,
      center: { x: cx, z: cz }, nx: nx, nz: nz, cut: false
    });

    // Kotak dinding untuk audit "agent menembus dinding".
    app.wallBoxes.push(alongX
      ? { x0: cx - len / 2, x1: cx + len / 2, z0: cz - T / 2, z1: cz + T / 2 }
      : { x0: cx - T / 2, x1: cx + T / 2, z0: cz - len / 2, z1: cz + len / 2 });
  }

  /* ================================================================
   * Ruangan: lantai, dinding hybrid (kusen + kaca), pintu, perabot
   * ================================================================ */
  const WALL = { baseH: 0.78, glassH: 1.62, railH: 0.1, thick: 0.2, top: 2.5 };

  function buildRoom(room) {
    const g = new THREE.Group();
    g.position.set(room.x, 0, room.z);
    app.roomGroups.set(room.id, g);

    const accent = new THREE.Color(room.accent);
    const base = accent.clone().lerp(new THREE.Color('#2a3140'), 0.82);
    const tex = makeCarpetTexture('#' + base.getHexString(), 'rgba(255,255,255,0.05)', 5, 4);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(room.w - 0.12, room.d - 0.12),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.96, metalness: 0.02 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.012;
    floor.receiveShadow = true;
    g.add(floor);

    // Dinding hybrid + bukaan pintu
    buildHybridWalls(g, room, accent);

    // Label ruang melayang
    const label = makeLabel(room.label.toUpperCase(), {
      fontSize: 40, height: 0.62, color: '#f2f8ff',
      bg: 'rgba(9,14,26,0.78)', border: room.accent
    });
    label.position.set(0, 3.0, 0);
    g.add(label);

    // Dekorasi per jenis ruangan
    // Meja rapat selalu ada (kursinya dipakai agent). Dekor lain bisa
    // dimatikan; server mematikannya juga kalau ruangan lebih kecil dari
    // ruangan asal dekornya (room.style).
    if (room.kind === 'meeting') furnishBoard(g, room);
    else if (room.decor === 'none') { /* tanpa dekor */ }
    else if (room.kind === 'executive') furnishExecutive(g, room);
    else if (room.kind === 'hangout') furnishHangout(g, room);
    else if (room.kind === 'department') furnishDepartment(g, room, accent);
    if (room.kind === 'hangout' && !app.zoneById.has(room.style || room.id)) genericZone(room, true);

    mergeStaticMeshes(g, app.solids);
    app.scene.add(g);
  }

  function buildHybridWalls(g, room, accent) {
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: accent.getHex(), transparent: true, opacity: 0.30,
      roughness: 0.10, metalness: 0.0,
      side: THREE.DoubleSide, depthWrite: false
    });
    const railMat = new THREE.MeshStandardMaterial({
      color: accent.clone().multiplyScalar(0.55).getHex(),
      roughness: 0.45, metalness: 0.5
    });

    const sides = [
      { side: 'north', axis: 'x', len: room.w, off: -room.d / 2 },
      { side: 'south', axis: 'x', len: room.w, off: room.d / 2 },
      { side: 'west', axis: 'z', len: room.d, off: -room.w / 2 },
      { side: 'east', axis: 'z', len: room.d, off: room.w / 2 }
    ];

    sides.forEach(function (s) {
      if (sharedNeighbor(room, s.side)) return;   // dinding dipakai bersama
      const door = (room.door && room.door.side === s.side) ? room.door : null;
      const half = s.len / 2;
      const segs = [];
      if (door) {
        const along = s.axis === 'x' ? door.x - room.x : door.z - room.z;
        const gap = door.width || 1.9;
        const lo = Math.max(-half, along - gap / 2);
        const hi = Math.min(half, along + gap / 2);
        if (lo > -half + 0.02) segs.push([-half, lo]);
        if (hi < half - 0.02) segs.push([hi, half]);
        if (door) addDoorFrame(g, s, along, gap, railMat, room);
      } else {
        segs.push([-half, half]);
      }
      segs.forEach(function (seg) {
        const a = seg[0], b = seg[1];
        if (b - a < 0.05) return;
        const mid = (a + b) / 2;
        const len = b - a;
        if (s.axis === 'x') {
          addWallRun(g, len, mid, s.off, 'x', glassMat, railMat);
          app.wallBoxes.push({
            x0: room.x + a, x1: room.x + b,
            z0: room.z + s.off - WALL.thick / 2, z1: room.z + s.off + WALL.thick / 2
          });
        } else {
          addWallRun(g, len, mid, s.off, 'z', glassMat, railMat);
          app.wallBoxes.push({
            x0: room.x + s.off - WALL.thick / 2, x1: room.x + s.off + WALL.thick / 2,
            z0: room.z + a, z1: room.z + b
          });
        }
      });
    });
  }

  function addWallRun(g, len, mid, off, axis, glassMat, railMat) {
    const base = new THREE.Mesh(new THREE.BoxGeometry(
      axis === 'x' ? len : WALL.thick, WALL.baseH, axis === 'x' ? WALL.thick : len), MATS.wallBase);
    base.position.set(axis === 'x' ? mid : off, WALL.baseH / 2, axis === 'x' ? off : mid);
    base.castShadow = true;
    base.receiveShadow = true;
    g.add(base);

    const glass = new THREE.Mesh(new THREE.BoxGeometry(
      axis === 'x' ? len : 0.05, WALL.glassH, axis === 'x' ? 0.05 : len), glassMat);
    glass.position.set(axis === 'x' ? mid : off, WALL.baseH + WALL.glassH / 2, axis === 'x' ? off : mid);
    g.add(glass);

    const rail = new THREE.Mesh(new THREE.BoxGeometry(
      axis === 'x' ? len : WALL.thick + 0.06, WALL.railH, axis === 'x' ? WALL.thick + 0.06 : len), railMat);
    rail.position.set(axis === 'x' ? mid : off, WALL.baseH + WALL.glassH + WALL.railH / 2, axis === 'x' ? off : mid);
    rail.castShadow = true;
    g.add(rail);
  }

  function addDoorFrame(g, s, along, gap, railMat, room) {
    const post = 0.13;
    const h = WALL.baseH + WALL.glassH + WALL.railH;
    [-1, 1].forEach(function (sign) {
      const at = along + sign * (gap / 2 + post / 2);
      const m = new THREE.Mesh(new THREE.BoxGeometry(
        s.axis === 'x' ? post : WALL.thick + 0.08, h, s.axis === 'x' ? WALL.thick + 0.08 : post), railMat);
      m.position.set(s.axis === 'x' ? at : s.off, h / 2, s.axis === 'x' ? s.off : at);
      m.castShadow = true;
      g.add(m);
      const wx0 = s.axis === 'x' ? room.x + at : room.x + s.off;
      const wz0 = s.axis === 'x' ? room.z + s.off : room.z + at;
      app.wallBoxes.push(s.axis === 'x'
        ? { x0: wx0 - post / 2, x1: wx0 + post / 2, z0: wz0 - (WALL.thick + 0.08) / 2, z1: wz0 + (WALL.thick + 0.08) / 2 }
        : { x0: wx0 - (WALL.thick + 0.08) / 2, x1: wx0 + (WALL.thick + 0.08) / 2, z0: wz0 - post / 2, z1: wz0 + post / 2 });
    });
    const header = new THREE.Mesh(new THREE.BoxGeometry(
      s.axis === 'x' ? gap + post * 2 : WALL.thick + 0.08, 0.14, s.axis === 'x' ? WALL.thick + 0.08 : gap + post * 2), railMat);
    header.position.set(s.axis === 'x' ? along : s.off, h - 0.07, s.axis === 'x' ? s.off : along);
    g.add(header);
  }

  /* Ruangan bertetangga dengan jarak < 0.7 memakai satu dinding bersama. */
  function sharedNeighbor(room, side) {
    const rooms = app.rooms;
    const hw = room.w / 2;
    const hd = room.d / 2;
    const value = side === 'north' ? room.z - hd : side === 'south' ? room.z + hd
      : side === 'west' ? room.x - hw : room.x + hw;
    const a0 = side === 'north' || side === 'south' ? room.x - hw : room.z - hd;
    const a1 = side === 'north' || side === 'south' ? room.x + hw : room.z + hd;
    for (let i = 0; i < rooms.length; i += 1) {
      const other = rooms[i];
      if (other.id === room.id || other.kind === 'lounge') continue;
      const ohw = other.w / 2;
      const ohd = other.d / 2;
      const ovalue = side === 'north' ? other.z - ohd : side === 'south' ? other.z + ohd
        : side === 'west' ? other.x - ohw : other.x + ohw;
      if (Math.abs(ovalue - value) >= 0.7) continue;
      const b0 = side === 'north' || side === 'south' ? other.x - ohw : other.z - ohd;
      const b1 = side === 'north' || side === 'south' ? other.x + ohw : other.z + ohd;
      if (Math.min(a1, b1) - Math.max(a0, b0) < 0.5) continue;
      return other;
    }
    return null;
  }

  /* ================================================================
   * Perabot
   * ================================================================ */
  function furnishDepartment(g, room, accent) {
    const w = room.w;
    const d = room.d;
    const backZ = -d / 2 + 0.55;   // sisi belakang ruangan (z lokal)
    const frontZ = d / 2 - 0.6;

    if (room.style === 'research') {
      createBookshelf(g, -w / 2 + 1.1, backZ + 0.2, 0);
      createBookshelf(g, -w / 2 + 2.7, backZ + 0.2, 0);
      createLabBench(g, w / 2 - 0.7, backZ + 0.85, Math.PI / 2);
      createWhiteboard(g, w / 2 - 0.26, 0.3, -Math.PI / 2);
      createPlant(g, -w / 2 + 0.8, frontZ - 0.2, 1.0);
      createPlant(g, w / 2 - 0.8, frontZ - 0.2, 0.85);
    } else if (room.style === 'content') {
      createShelfWall(g, -w / 2 + 0.42, 0.4, 0);
      createWhiteboard(g, w / 2 - 0.28, -1.0, -Math.PI / 2);
      createPlant(g, w / 2 - 0.9, frontZ - 0.1, 0.9);
      createDeskLamp(g, -w / 2 + 1.3, frontZ - 0.35);
    } else if (room.style === 'operations') {
      createMonitorWall(g, 0, backZ + 0.12, 0, w - 2.4);
      // Papan tulis diletakkan di-segment dinding bebas (utara), bukan di
      // bukaan pintu -- pintu timur dipakai agent untuk masuk.
      createWhiteboard(g, w / 2 - 0.28, -2.3, -Math.PI / 2, 2.2);
      createPrinter(g, -w / 2 + 0.75, frontZ - 1.6);
      createPlant(g, w / 2 - 1.1, frontZ - 0.3, 1.05);
      createPlanter(g, -w / 2 + 2.6, frontZ - 0.4, 0.8);
    } else if (room.style === 'eng') {
      createServerRack(g, -w / 2 + 1.3, backZ + 0.55, 0);
      createServerRack(g, -w / 2 + 2.3, backZ + 0.55, 0);
      createServerRack(g, w / 2 - 1.3, backZ + 0.55, 0);
      // Papan tulis pindah ke dinding utara, menjauhi sumbu pintu.
      createWhiteboard(g, -w / 2 + 2.4, -d / 2 + 0.26, 0);
      createCrate(g, w / 2 - 1.0, frontZ - 0.2);
      createPlant(g, w / 2 - 2.4, frontZ - 0.3, 0.85);
    } else if (room.style === 'hrd') {
      // Meja bulat kecil (kafe) diletakkan di sudut selatan, jauh dari
      // barisan meja dan dari dinding.
      createRoundTable(g, -w / 2 + 2.6, frontZ - 0.6, 0, { radius: 0.75, chairs: false });
      createBookshelf(g, w / 2 - 1.0, backZ + 0.25, 0);
      createRug(g, -w / 2 + 2.6, frontZ - 1.3, 4.2, 2.4, '#3f5a63', '#7dd3fc');
      createPlant(g, w / 2 - 0.8, frontZ - 0.2, 1.0);
      createFloorLamp(g, -w / 2 + 0.8, backZ + 0.4);
    } else {
      // Ruangan annex (dibangkitkan server): dekor netral di sisi pintu,
      // jauh dari barisan meja dan jalur pintu -> lorong.
      createPlant(g, -w / 2 + 0.7, -d / 2 + 0.6, 0.95);
      createPlant(g, w / 2 - 0.7, -d / 2 + 0.6, 0.85);
      createWhiteboard(g, w / 2 - 0.26, -0.4, -Math.PI / 2, 1.6);
    }
  }

  function furnishExecutive(g, room) {
    const w = room.w;
    const d = room.d;
    // Karpet mewah
    const rug = createRug(g, 0.4, 0.4, 8.6, 5.6, '#5c2233', '#d8a34a');
    rug.position.y = 0.024;
    // Meja kayu besar sudah dibuat bersama agent; tambahkan credenza + sofa.
    createCredenza(g, w / 2 - 1.6, -d / 2 + 0.55, 0);
    createSofa(g, -w / 2 + 1.6, -d / 2 + 1.4, Math.PI / 2, 0x4a3550);
    createFloorLamp(g, -w / 2 + 0.9, d / 2 - 1.0);
    createPlant(g, w / 2 - 0.9, d / 2 - 1.0, 1.35);
    createPlant(g, -w / 2 + 0.9, -d / 2 + 0.9, 1.1);
    createArt(g, 0, -d / 2 + 0.13, 0, 4.2, 1.5);
    const note = makeLabel('CEO SUITE', {
      fontSize: 34, height: 0.34, color: '#ffe9b8', bg: null
    });
    note.position.set(0.4, 1.55, -d / 2 + 0.2);
    g.add(note);
  }

  function furnishBoard(g, room) {
    const w = room.w;
    const d = room.d;
    createRug(g, 0, 0.2, 7.4, 5.0, '#274a5c', '#a5f3fc');
    createConferenceTable(g, 0.4, 0.2);
    createScreen(g, 0, -d / 2 + 0.12, 0, 3.6);
    /* Credenza pindah ke dinding utara: sebelumnya menumpuk tepat di
     * belakang pintu barat, jadi agent rapat terhalang masuk ruangan. */
    createCredenza(g, -3.4, -d / 2 + 0.45, 0);
    createPlant(g, w / 2 - 0.8, d / 2 - 0.9, 1.1);
    createFloorLamp(g, -w / 2 + 1.0, d / 2 - 1.0);
  }

  /* --- Ruang santai berdinding: pantry, game room, library + hot desk ---
     Perabot dalam koordinat lokal ruangan; registerZone() memindahkan
     rintangan & titik santai ke koordinat dunia. */
  function furnishHangout(g, room) {
    const w = room.w;
    const d = room.d;
    if (room.style === 'pantry') {
      // Meja bar + mesin kopi di dinding barat, kulkas di sudut barat laut.
      addBox(g, 0.7, 0.9, 3.5, MATS.woodDark, -w / 2 + 0.45, 0.45, 0.15);
      addBox(g, 0.78, 0.06, 3.6, MATS.wood, -w / 2 + 0.45, 0.93, 0.15, false);
      addBox(g, 0.42, 0.46, 0.36, MATS.dark, -w / 2 + 0.45, 1.19, -0.9);
      addBox(g, 0.2, 0.08, 0.06, MATS.screenGlow, -w / 2 + 0.68, 1.3, -0.9, false);
      addCyl(g, 0.07, 0.06, 0.13, 10, MATS.paper, -w / 2 + 0.5, 1.03, 0.4);
      addCyl(g, 0.07, 0.06, 0.13, 10, MATS.paper, -w / 2 + 0.4, 1.03, 0.75);
      addBox(g, 0.82, 1.9, 0.78, MATS.paper, -w / 2 + 0.5, 0.95, -d / 2 + 0.55);
      addBox(g, 0.04, 0.5, 0.04, MATS.metal, -w / 2 + 0.93, 1.2, -d / 2 + 0.75, false);
      createRoundTable(g, 0.2, -1.5, 0, { radius: 0.5, chairs: false });
      createRoundTable(g, 0.2, 1.6, 0, { radius: 0.5, chairs: false });
      createPlant(g, w / 2 - 0.7, -d / 2 + 0.6, 0.9);
      createPlant(g, w / 2 - 0.7, d / 2 - 0.6, 1.0);
      createArt(g, 0.4, -d / 2 + 0.13, 0, 2.2, 1.0);
      registerZone({
        id: 'pantry', room: room, walled: true, cap: 4, weight: 1.1,
        bounds: { x0: room.x - 2.1, x1: room.x + 2.7, z0: room.z - 2.4, z1: room.z + 2.4 },
        spots: [
          { x: -1.9, z: -0.9, face: -Math.PI / 2 }, { x: -1.9, z: 0.6, face: -Math.PI / 2 },
          { x: 1.05, z: -1.5, face: -Math.PI / 2 }, { x: -0.65, z: 1.6, face: Math.PI / 2 },
          { x: 1.05, z: 1.6, face: -Math.PI / 2 }
        ]
      });
    } else if (room.style === 'gameroom') {
      // Meja ping-pong (sejajar sumbu z) + tiga mesin arcade di dinding timur.
      const tx = 0.25, tz = -2.4;
      const felt = new THREE.MeshStandardMaterial({ color: 0x1f5f4a, roughness: 0.7 });
      addBox(g, 1.52, 0.06, 2.74, felt, tx, 0.76, tz);
      addBox(g, 1.6, 0.16, 0.02, MATS.paper, tx, 0.86, tz, false);
      [[-0.6, -1.2], [0.6, -1.2], [-0.6, 1.2], [0.6, 1.2]].forEach(function (p) {
        addBox(g, 0.06, 0.72, 0.06, MATS.metal, tx + p[0], 0.37, tz + p[1], false);
      });
      [1.2, 2.3, 3.4].forEach(function (z, i) {
        addBox(g, 0.7, 1.75, 0.7, MATS.dark, w / 2 - 0.45, 0.88, z);
        const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.42), new THREE.MeshStandardMaterial({
          color: 0x08192b, emissive: [0xe879f9, 0x22d3ee, 0xf59e0b][i], emissiveIntensity: 1.1
        }));
        scr.position.set(w / 2 - 0.81, 1.36, z);
        scr.rotation.y = -Math.PI / 2;
        g.add(scr);
        addBox(g, 0.3, 0.06, 0.5, MATS.metal, w / 2 - 0.86, 1.0, z, false);
      });
      createBeanbag(g, -1.2, 3.6, 0xe879f9);
      createPlant(g, -1.35, -3.9, 0.85);
      registerZone({
        id: 'gameroom', room: room, walled: true, cap: 4, weight: 1.0,
        bounds: { x0: room.x - 1.5, x1: room.x + 1.4, z0: room.z - 4.2, z1: room.z + 4.0 },
        spots: [
          { x: tx, z: -4.1, face: 0 }, { x: tx, z: -0.7, face: Math.PI },
          { x: 0.85, z: 1.2, face: Math.PI / 2 }, { x: 0.85, z: 2.3, face: Math.PI / 2 },
          { x: 0.85, z: 3.4, face: Math.PI / 2 }
        ]
      });
    } else if (room.style === 'library') {
      // Meja panjang hot desk (geometri dari server) + bangku di tiap kursi.
      const t = app.hotDesk && app.hotDesk.table;
      if (t) {
        const cx = (t.x0 + t.x1) / 2 - room.x;
        const cz = (t.z0 + t.z1) / 2 - room.z;
        const tw = t.x1 - t.x0;
        const td = t.z1 - t.z0;
        addBox(g, tw, 0.08, td, MATS.wood, cx, 0.76, cz);
        addBox(g, tw - 0.2, 0.7, 0.08, MATS.woodDark, cx, 0.37, cz - td / 2 + 0.2, false);
        addBox(g, tw - 0.2, 0.7, 0.08, MATS.woodDark, cx, 0.37, cz + td / 2 - 0.2, false);
        createDeskLamp(g, cx, cz - td / 2 + 0.4);
        addBox(g, 0.42, 0.03, 0.3, MATS.paper, cx + 0.15, 0.81, cz + 0.4, false);
      }
      ((app.hotDesk && app.hotDesk.spots) || []).forEach(function (sp) {
        addCyl(g, 0.21, 0.21, 0.07, 14, MATS.leather, sp.x - room.x, 0.47, sp.z - room.z);
        addCyl(g, 0.035, 0.035, 0.44, 8, MATS.metal, sp.x - room.x, 0.22, sp.z - room.z, false);
      });
      createBookshelf(g, -w / 2 + 0.3, -1.2, Math.PI / 2);
      createBookshelf(g, -w / 2 + 0.3, 1.0, Math.PI / 2);
      createBookshelf(g, w / 2 - 0.3, -1.2, -Math.PI / 2);
      createBookshelf(g, w / 2 - 0.3, 1.0, -Math.PI / 2);
      createBeanbag(g, -1.9, 2.7, 0x84cc16);
      createBeanbag(g, 1.9, 2.7, 0x0ea5e9);
      createFloorLamp(g, w / 2 - 0.5, -d / 2 + 0.5);
      const seats = ((app.hotDesk && app.hotDesk.spots) || []).map(function (sp) {
        return { x: sp.x - room.x, z: sp.z - room.z, r: 0.45 };
      });
      registerZone({
        id: 'library', room: room, walled: true, cap: 3, weight: 0.8,
        bounds: { x0: room.x - 1.85, x1: room.x + 1.85, z0: room.z - 2.4, z1: room.z + 2.7 },
        spots: [
          { x: -1.75, z: -1.2, face: -Math.PI / 2 }, { x: 1.75, z: -1.2, face: Math.PI / 2 },
          { x: -1.3, z: 2.3, face: Math.PI }, { x: 1.3, z: 2.3, face: Math.PI }
        ]
      });
    }
  }

  /* --- Town Square / Central Playground --- */
  function buildPlayground(room) {
    const g = new THREE.Group();
    g.position.set(room.x, 0, room.z);
    app.roomGroups.set(room.id, g);

    const tex = makeCarpetTexture('#4c4438', 'rgba(255,255,255,0.05)', 8, 6);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(room.w - 0.12, room.d - 0.12),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.96, metalness: 0.02 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.012;
    floor.receiveShadow = true;
    g.add(floor);

    const label = makeLabel(room.label.toUpperCase(), {
      fontSize: 40, height: 0.7, color: '#eafcff',
      bg: 'rgba(9,14,26,0.78)', border: room.accent
    });
    label.position.set(0, 3.6, 0);
    g.add(label);
    if (room.style !== 'playground' || room.decor === 'none') {
      mergeStaticMeshes(g, app.solids);
      app.scene.add(g);
      genericZone(room, false);
      return;
    }

    // Permadani santai besar
    const rug = new THREE.Mesh(
      new THREE.PlaneGeometry(8.8, 5.8),
      new THREE.MeshStandardMaterial({ map: makeRugTexture('#3f5f6b', '#8fd3ff'), roughness: 1 })
    );
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(-3.2, 0.022, 1.2);
    rug.receiveShadow = true;
    g.add(rug);

    // Klaster santai di sisi barat
    createSofa(g, -5.6, -1.6, 0, 0x40506e);
    createSofa(g, -5.6, 3.6, Math.PI, 0x4e4468);
    createCoffeeTable(g, -5.6, 1.0);
    createBeanbag(g, -2.3, 3.2, 0xf59e0b);
    createBeanbag(g, -0.6, -1.4, 0xec4899);
    createFloorLamp(g, -7.2, 0.6);
    createFloorLamp(g, -3.4, 4.6);

    // Pot Tanaman di sekeliling
    [[-7.4, -4.2], [4.4, -4.2], [4.4, 4.6], [-7.4, 4.6], [1.4, -3.4]].forEach(function (p, i) {
      createPlant(g, p[0], p[1], 1 + (i % 2) * 0.2);
    });

    // Totem / patung di tengah-timur town square
    createTotem(g, 2.2, 1.2);

    mergeStaticMeshes(g, app.solids);
    app.scene.add(g);

    // Zona santai utama (koordinat dunia). Terbuka (tanpa dinding).
    registerZone({
      id: 'playground', room: room, walled: false, cap: 9, weight: 1.5,
      bounds: {
        x0: room.x - room.w / 2 + 1.0, x1: room.x + room.w / 2 - 1.0,
        z0: room.z - room.d / 2 + 0.9, z1: room.z + room.d / 2 - 0.9
      },
      // Titik "berhenti santai" dekat sofa / meja kopi / totem.
      spots: [
        { x: -4.2, z: -1.6, face: -Math.PI / 2 }, { x: -4.2, z: 3.6, face: -Math.PI / 2 },
        { x: -6.4, z: 1.0 }, { x: -2.3, z: 2.1, face: Math.PI }, { x: -0.6, z: -2.5 },
        { x: 3.6, z: 1.2, face: -Math.PI / 2 }, { x: 2.2, z: -0.4 }
      ]
    });
  }

  /* Zona santai polos (ruang santai baru / tanpa dekor): seluruh lantai. */
  function genericZone(room, walled) {
    const m = walled ? 1.2 : 1.0;
    registerZone({
      id: room.id, room: room, walled: walled, cap: Math.max(2, Math.round(room.w * room.d / 10)), weight: 1,
      bounds: { x0: room.x - room.w / 2 + m, x1: room.x + room.w / 2 - m, z0: room.z - room.d / 2 + m, z1: room.z + room.d / 2 - m },
      spots: []
    });
  }

  /* --- primitif perabot --- */
  function createBookshelf(parent, x, z, rotY) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = rotY || 0;
    addBox(g, 1.4, 1.9, 0.4, MATS.woodDark, 0, 0.95, 0);
    [0.5, 1.0, 1.5].forEach(function (y) {
      addBox(g, 1.3, 0.06, 0.38, MATS.wood, 0, y, 0.02, false);
    });
    [0.2, 0.7, 1.2, 1.7].forEach(function (y) {
      addBox(g, 1.22, 0.34, 0.05, MATS.bookRow, 0, y, 0.215, false);
    });
    parent.add(g);
    return g;
  }

  function createShelfWall(parent, x, z, rotY) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = rotY || 0;
    addBox(g, 0.34, 2.1, 2.6, MATS.woodDark, 0, 1.05, 0);
    [0.5, 1.0, 1.5].forEach(function (y) {
      addBox(g, 0.32, 0.06, 2.5, MATS.wood, 0, y, 0, false);
    });
    for (let i = 0; i < 8; i += 1) {
      const b = addBox(g, 0.22, 0.34, 0.1 + (i % 3) * 0.04, MATS.book[i % MATS.book.length],
        0.02, 0.62 + (i % 3) * 0.5, -1.0 + i * 0.28, false);
      b.rotation.x = (i % 4 === 0) ? 0.12 : 0;
    }
    parent.add(g);
    return g;
  }

  function createWhiteboard(parent, x, z, rotY, width) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = rotY;
    const wdt = width || 2.6;
    addBox(g, wdt, 1.15, 0.06, new THREE.MeshStandardMaterial({ color: 0xf4f7fb, roughness: 0.5 }), 0, 1.62, 0, false);
    addBox(g, wdt + 0.1, 0.06, 0.09, MATS.metal, 0, 2.22, 0, false);
    addBox(g, wdt + 0.1, 0.06, 0.09, MATS.metal, 0, 1.02, 0, false);
    const notes = [0xef4444, 0xf59e0b, 0x10b981, 0x3b82f6];
    for (let i = 0; i < 4; i += 1) {
      addBox(g, 0.16, 0.16, 0.02, new THREE.MeshStandardMaterial({ color: notes[i], roughness: 0.9 }),
        -0.9 + i * 0.55, 1.72 + (i % 2) * 0.22, 0.05, false);
    }
    parent.add(g);
    return g;
  }

  function createScreen(parent, x, z, rotY, w) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = rotY || 0;
    const width = w || 3.2;
    addBox(g, width + 0.16, 1.55, 0.1, MATS.dark, 0, 1.72, 0);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(width, 1.35), MATS.screenGlow);
    screen.position.set(0, 1.72, 0.06);
    g.add(screen);
    parent.add(g);
    return g;
  }

  function createMonitorWall(parent, x, z, rotY, w) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = rotY || 0;
    const width = w || 6;
    addBox(g, width + 0.2, 1.9, 0.12, MATS.dark, 0, 1.9, 0);
    const cols = Math.max(2, Math.round(width / 1.6));
    const rows = 2;
    const tileW = (width - 0.3) / cols;
    const tileH = 0.72;
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const mat = new THREE.MeshStandardMaterial({
          color: 0x08192b, emissive: [0x38bdf8, 0x10b981, 0xf59e0b][(r + c) % 3],
          emissiveIntensity: 0.45, roughness: 0.3, metalness: 0.1
        });
        const tile = new THREE.Mesh(new THREE.PlaneGeometry(tileW - 0.08, tileH), mat);
        tile.position.set(-width / 2 + 0.15 + tileW * (c + 0.5), 1.9 + (rows === 2 ? (r === 0 ? 0.46 : -0.46) : 0), 0.08);
        g.add(tile);
      }
    }
    parent.add(g);
    return g;
  }

  function createServerRack(parent, x, z, rotY) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = rotY || 0;
    addBox(g, 0.95, 2.05, 0.72, MATS.dark, 0, 1.02, 0);
    addBox(g, 0.99, 0.08, 0.76, MATS.metal, 0, 2.07, 0, false);
    for (let i = 0; i < 7; i += 1) {
      const y = 0.28 + i * 0.24;
      addBox(g, 0.8, 0.16, 0.02, new THREE.MeshStandardMaterial({ color: 0x0f1a27, roughness: 0.6 }),
        0, y, 0.365, false);
      const led = addBox(g, 0.06, 0.04, 0.02,
        new THREE.MeshBasicMaterial({ color: i % 3 === 0 ? 0x10b981 : 0x38bdf8 }), 0.3, y, 0.375, false);
      led.castShadow = false;
    }
    parent.add(g);
    return g;
  }

  function createLabBench(parent, x, z, rotY) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = rotY || 0;
    addBox(g, 2.2, 0.08, 0.8, MATS.paper, 0, 0.9, 0);
    addBox(g, 0.08, 0.9, 0.08, MATS.metal, -1.0, 0.45, -0.32, false);
    addBox(g, 0.08, 0.9, 0.08, MATS.metal, 1.0, 0.45, -0.32, false);
    addBox(g, 0.08, 0.9, 0.08, MATS.metal, -1.0, 0.45, 0.32, false);
    addBox(g, 0.08, 0.9, 0.08, MATS.metal, 1.0, 0.45, 0.32, false);
    addBox(g, 0.34, 0.26, 0.3, MATS.metal, -0.55, 1.07, 0, false);
    addCyl(g, 0.12, 0.14, 0.22, 12, MATS.metal, 0.3, 1.05, 0.05, false);
    addBox(g, 0.26, 0.05, 0.22, MATS.book[1], 0.62, 0.96, 0.02, false);
    parent.add(g);
    return g;
  }

  function createPrinter(parent, x, z) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    addBox(g, 0.9, 0.75, 0.7, MATS.paper, 0, 0.55, 0);
    addBox(g, 0.86, 0.06, 0.66, MATS.dark, 0, 0.95, 0, false);
    addBox(g, 0.4, 0.03, 0.3, MATS.paper, 0.1, 0.99, 0.05, false);
    parent.add(g);
    return g;
  }

  function createCrate(parent, x, z, scale) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.scale.setScalar(scale || 1);
    addBox(g, 0.8, 0.7, 0.8, MATS.woodDark, 0, 0.35, 0);
    addBox(g, 0.84, 0.06, 0.84, MATS.wood, 0, 0.71, 0, false);
    addBox(g, 0.1, 0.72, 0.84, MATS.wood, 0, 0.36, 0, false);
    parent.add(g);
    return g;
  }

  function createCredenza(parent, x, z, rotY) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = rotY || 0;
    addBox(g, 2.6, 0.72, 0.55, MATS.woodLux, 0, 0.45, 0);
    addBox(g, 2.7, 0.06, 0.62, MATS.wood, 0, 0.84, 0, false);
    [-0.8, 0, 0.8].forEach(function (dx) {
      addBox(g, 0.66, 0.5, 0.03, MATS.metal, dx, 0.5, 0.28, false);
    });
    parent.add(g);
    return g;
  }

  function createArt(parent, x, z, rotY, w, h) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = rotY || 0;
    addBox(g, w, h, 0.08, MATS.frame, 0, 1.7, 0, false);
    addBox(g, w - 0.18, h - 0.18, 0.02, new THREE.MeshStandardMaterial({
      color: 0x2b3f6b, roughness: 0.65, emissive: 0x16305c, emissiveIntensity: 0.25
    }), 0, 1.7, 0.05, false);
    parent.add(g);
    return g;
  }

  function createRoundTable(parent, x, z, rotY, opts) {
    const o = opts || {};
    const r = o.radius || 1.05;
    const withChairs = o.chairs !== false;
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = rotY || 0;
    const top = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.09, 24), MATS.wood);
    top.position.y = 0.74;
    top.castShadow = true;
    g.add(top);
    addCyl(g, 0.1, 0.14, 0.72, 12, MATS.metal, 0, 0.36, 0, false);
    addCyl(g, 0.42, 0.42, 0.06, 18, MATS.metal, 0, 0.03, 0, false);
    if (withChairs) {
      for (let i = 0; i < 4; i += 1) {
        const a = (i / 4) * Math.PI * 2 + 0.4;
        createChair(g, Math.cos(a) * (r + 0.5), Math.sin(a) * (r + 0.5), -a + Math.PI / 2);
      }
    }
    parent.add(g);
    return g;
  }

  function createConferenceTable(parent, x, z) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    // Meja panjang conferences: kotak panjang + dua ujung bulat (stadium).
    addBox(g, 5.2, 0.13, 1.5, MATS.woodLux, 0, 0.76, 0);
    addCyl(g, 0.75, 0.75, 0.13, 26, MATS.woodLux, -2.6, 0.76, 0);
    addCyl(g, 0.75, 0.75, 0.13, 26, MATS.woodLux, 2.6, 0.76, 0);
    addBox(g, 0.55, 0.7, 1.5, MATS.woodLux, 0, 0.35, 0);
    addBox(g, 0.9, 0.06, 0.9, MATS.metal, 0, 0.03, 0, false);
    // kursi melingkar di sekeliling meja
    [-2.1, -0.7, 0.7, 2.1].forEach(function (dx) {
      createChair(g, dx, 1.15, 0);
      createChair(g, dx, -1.15, Math.PI);
    });
    /* Kursi ujung: 0.27 di luar ujung meja dan MENGHADAP meja (rotasi
     * dibalik -- sebelumnya kursi menghadap ke luar dan menusuk meja). */
    createChair(g, 3.62, 0, Math.PI / 2);
    createChair(g, -3.62, 0, -Math.PI / 2);
    parent.add(g);
    return g;
  }

  function createChair(parent, x, z, rotY) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = rotY || 0;
    addBox(g, 0.52, 0.08, 0.52, MATS.chair, 0, 0.46, 0);
    addBox(g, 0.52, 0.56, 0.08, MATS.chair, 0, 0.76, 0.24);
    addCyl(g, 0.045, 0.045, 0.38, 8, MATS.metal, 0, 0.24, 0, false);
    addCyl(g, 0.25, 0.25, 0.05, 12, MATS.metal, 0, 0.05, 0, false);
    parent.add(g);
    return g;
  }

  function createPlant(parent, x, z, scale) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.scale.setScalar(scale || 1);
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.2, 0.36, 14), MATS.pot);
    pot.position.y = 0.18;
    pot.castShadow = true;
    g.add(pot);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.035, 8, 18), MATS.pot);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.36;
    g.add(rim);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.5, 6), MATS.stem);
    stem.position.y = 0.54;
    g.add(stem);
    [[0, 0.9, 0, 0.34], [0.2, 0.78, 0.09, 0.25], [-0.18, 0.82, -0.07, 0.24], [0.05, 1.04, 0.03, 0.21],
      [-0.1, 0.66, 0.14, 0.19]].forEach(function (p, i) {
      const leaf = new THREE.Mesh(new THREE.SphereGeometry(p[3], 10, 8), i % 2 ? MATS.leaf : MATS.leafDark);
      leaf.position.set(p[0], p[1], p[2]);
      leaf.scale.y = 0.72;
      leaf.castShadow = true;
      g.add(leaf);
    });
    parent.add(g);
    return g;
  }

  function createPlanter(parent, x, z, scale) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.scale.setScalar(scale || 1);
    addBox(g, 1.5, 0.42, 1.5, MATS.slab, 0, 0.21, 0);
    addBox(g, 1.3, 0.08, 1.3, MATS.stem, 0, 0.44, 0, false);
    const shrub = new THREE.Mesh(new THREE.SphereGeometry(0.52, 12, 9), MATS.leafDark);
    shrub.position.y = 0.78;
    shrub.scale.y = 0.8;
    shrub.castShadow = true;
    g.add(shrub);
    parent.add(g);
    return g;
  }

  function createTree(parent, x, z) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    addCyl(g, 0.14, 0.2, 2.4, 8, MATS.woodDark, 0, 1.2, 0, false);
    const crown = new THREE.Mesh(new THREE.SphereGeometry(1.15, 12, 9), MATS.leafDark);
    crown.position.y = 3.0;
    crown.scale.y = 0.9;
    crown.castShadow = true;
    g.add(crown);
    parent.add(g);
    return g;
  }

  function createSofa(parent, x, z, rotY, colorHex) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = rotY || 0;
    const mat = new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.93, metalness: 0.02 });
    addBox(g, 3.0, 0.35, 1.15, mat, 0, 0.28, 0);
    addBox(g, 1.36, 0.18, 0.95, mat, -0.72, 0.52, 0.02);
    addBox(g, 1.36, 0.18, 0.95, mat, 0.72, 0.52, 0.02);
    addBox(g, 3.0, 0.62, 0.2, mat, 0, 0.72, -0.48);
    addBox(g, 0.2, 0.52, 1.1, mat, -1.4, 0.58, 0);
    addBox(g, 0.2, 0.52, 1.1, mat, 1.4, 0.58, 0);
    [[-1.3, -0.45], [1.3, -0.45], [-1.3, 0.45], [1.3, 0.45]].forEach(function (p) {
      addBox(g, 0.08, 0.12, 0.08, MATS.dark, p[0], 0.06, p[1], false);
    });
    parent.add(g);
    return g;
  }

  function createBeanbag(parent, x, z, colorHex) {
    const mat = new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.96, metalness: 0.0 });
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.62, 16, 12), mat);
    m.position.set(x, 0.38, z);
    m.scale.set(1, 0.62, 1);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    const back = new THREE.Mesh(new THREE.SphereGeometry(0.4, 12, 10), mat);
    back.position.set(x, 0.52, z - 0.18);
    back.scale.set(1, 0.7, 0.7);
    back.castShadow = true;
    parent.add(back);
    return m;
  }

  function createCoffeeTable(parent, x, z) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    addBox(g, 2.2, 0.08, 1.0, MATS.wood, 0, 0.46, 0);
    [[-0.95, -0.4], [0.95, -0.4], [-0.95, 0.4], [0.95, 0.4]].forEach(function (p) {
      addBox(g, 0.07, 0.42, 0.07, MATS.metal, p[0], 0.21, p[1], false);
    });
    addBox(g, 0.34, 0.05, 0.25, MATS.book[0], -0.5, 0.53, 0.02, false);
    addBox(g, 0.3, 0.04, 0.22, MATS.book[1], -0.46, 0.58, 0.05, false);
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.1, 0.09, 12), MATS.paper);
    bowl.position.set(0.5, 0.55, 0);
    bowl.castShadow = true;
    g.add(bowl);
    parent.add(g);
    return g;
  }

  function createFloorLamp(parent, x, z) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    addCyl(g, 0.22, 0.26, 0.05, 12, MATS.metal, 0, 0.03, 0, false);
    addCyl(g, 0.025, 0.025, 2.0, 8, MATS.metal, 0, 1.02, 0, false);
    const shade = new THREE.Mesh(
      new THREE.ConeGeometry(0.36, 0.34, 14, 1, true),
      MATS.lampShade
    );
    shade.position.y = 2.08;
    shade.rotation.x = Math.PI;
    g.add(shade);
    /* Tidak memakai PointLight: lampu-lampu lantai di dalam ruangan tidak
       perlu cahaya nyata, hanya pantulan emissive. Menghemat banyak
       biaya fragment shader (satu PointLight = satu pass ekstra). */
    parent.add(g);
    return g;
  }

  function createDeskLamp(parent, x, z) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    addCyl(g, 0.16, 0.18, 0.04, 10, MATS.metal, 0, 0.02, 0, false);
    addCyl(g, 0.02, 0.02, 1.3, 6, MATS.metal, 0, 0.66, 0, false);
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.24, 12, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x304050, emissive: 0xffd9a0, emissiveIntensity: 0.5, side: THREE.DoubleSide }));
    head.position.set(0.1, 1.34, 0);
    head.rotation.z = -0.7;
    g.add(head);
    parent.add(g);
    return g;
  }

  function createRug(parent, x, z, w, d, base, accent) {
    const rug = new THREE.Mesh(
      new THREE.PlaneGeometry(w, d),
      new THREE.MeshStandardMaterial({ map: makeRugTexture(base, accent), roughness: 1 })
    );
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(x, 0.02, z);
    rug.receiveShadow = true;
    parent.add(rug);
    return rug;
  }

  function createTotem(parent, x, z) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    addCyl(g, 1.35, 1.45, 0.22, 26, MATS.slab, 0, 0.11, 0, false);
    addCyl(g, 0.9, 1.0, 0.16, 26, MATS.stem, 0, 0.3, 0, false);
    addCyl(g, 0.16, 0.24, 2.3, 14, MATS.metal, 0, 1.4, 0, false);
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.42, 18, 14),
      new THREE.MeshStandardMaterial({ color: 0x0e2a3d, emissive: 0x22d3ee, emissiveIntensity: 1.1, roughness: 0.25 }));
    orb.position.y = 2.65;
    orb.castShadow = true;
    g.add(orb);
    const light = new THREE.PointLight(0x22d3ee, 0.7, 9, 2);
    light.position.y = 2.6;
    g.add(light);
    parent.add(g);
    return g;
  }

  /* ================================================================
   * Agent: humanoid low-poly + meja + kursi
   * ================================================================ */
  function makeExclaim() {
    const mat = new THREE.SpriteMaterial({ map: makeExclaimTexture(), transparent: true, depthWrite: false });
    const sp = new THREE.Sprite(mat);
    sp.scale.set(0.5, 0.5, 1);
    sp.userData.baseScale = 0.5;
    return sp;
  }

  function createDesk(agent, x, z, rot, luxury, spec) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = rot || 0;

    // Ukuran meja diambil dari layout (backend) supaya geometri visual
    // persis sama dengan bounding box yang dipakai cek tabrakan.
    const topW = (spec && spec.w) ? spec.w : (luxury ? 3.0 : 2.05);
    const topD = (spec && spec.d) ? spec.d : (luxury ? 1.4 : 1.05);
    const topMat = luxury ? MATS.woodLux : MATS.wood;

    addBox(g, topW, 0.1, topD, topMat, 0, 0.76, 0);
    if (luxury) addBox(g, topW + 0.06, 0.05, topD + 0.06, MATS.leather, 0, 0.82, 0, false);
    addBox(g, 0.1, 0.7, topD - 0.08, MATS.woodDark, -topW / 2 + 0.1, 0.37, 0);
    addBox(g, 0.1, 0.7, topD - 0.08, MATS.woodDark, topW / 2 - 0.1, 0.37, 0);

    const contact = new THREE.Mesh(new THREE.PlaneGeometry(topW + 0.3, topD + 0.5), MATS.shadow);
    contact.rotation.x = -Math.PI / 2;
    contact.position.set(0, 0.03, 0.3);
    g.add(contact);

    // Monitor: badan + layar emissive (menyala saat agent bekerja)
    addBox(g, 0.16, 0.18, 0.1, MATS.metal, 0, 0.9, -topD / 2 + 0.28, false);
    addBox(g, 0.92, 0.56, 0.05, MATS.dark, 0, 1.22, -topD / 2 + 0.26);
    const screenMat = new THREE.MeshStandardMaterial({
      color: 0x071726, emissive: 0x38bdf8, emissiveIntensity: 0.45, roughness: 0.24, metalness: 0.15
    });
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.84, 0.48), screenMat);
    screen.position.set(0, 1.22, -topD / 2 + 0.29);
    g.add(screen);

    // Keyboard +mouse + gelas
    addBox(g, 0.7, 0.03, 0.24, MATS.dark, 0, 0.84, 0.2, false);
    addBox(g, 0.12, 0.05, 0.16, MATS.dark, 0.46, 0.85, 0.2, false);
    const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.06, 0.13, 10), MATS.paper);
    mug.position.set(-0.6, 0.87, 0.16);
    g.add(mug);

    // Kursi kerja
    const chair = new THREE.Group();
    chair.position.set(0, 0, 0.95);
    if (luxury) {
      addBox(chair, 0.62, 0.12, 0.6, MATS.leather, 0, 0.5, 0);
      addBox(chair, 0.6, 0.95, 0.14, MATS.leather, 0, 0.92, 0.28);
      addBox(chair, 0.18, 0.55, 0.18, MATS.leather, -0.3, 0.78, 0.02, false);
      addBox(chair, 0.18, 0.55, 0.18, MATS.leather, 0.3, 0.78, 0.02, false);
    } else {
      addBox(chair, 0.56, 0.08, 0.56, MATS.chair, 0, 0.46, 0);
      addBox(chair, 0.56, 0.55, 0.08, MATS.chair, 0, 0.76, 0.27);
    }
    addCyl(chair, 0.045, 0.045, 0.38, 8, MATS.metal, 0, 0.24, 0, false);
    addCyl(chair, 0.26, 0.26, 0.05, 12, MATS.metal, 0, 0.05, 0, false);
    g.add(chair);

    g.userData.agentId = agent.id;
    mergeStaticMeshes(g);
    app.scene.add(g);
    app.deskById.set(agent.id, g);
    return { group: g, screenMat: screenMat };
  }

  function createHumanoid(agent) {
    const group = new THREE.Group();
    const color = new THREE.Color(agent.color || '#38bdf8');
    const body = new THREE.Group();
    group.add(body);

    const shirt = new THREE.MeshStandardMaterial({
      color: color.getHex(), roughness: 0.55, metalness: 0.08,
      emissive: color.clone().multiplyScalar(0.16).getHex(), emissiveIntensity: 0.5
    });
    const pants = new THREE.MeshStandardMaterial({ color: 0x2b3646, roughness: 0.82, metalness: 0.05 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xe8c39a, roughness: 0.66 });
    const hair = new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.3).getHex(), roughness: 0.9 });

    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.21, 0.62, 10), shirt);
    torso.position.y = 1.08;
    torso.castShadow = true;
    body.add(torso);

    const hips = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.16, 0.24), pants);
    hips.position.y = 0.76;
    hips.castShadow = true;
    body.add(hips);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 18, 14), skin);
    head.position.y = 1.58;
    head.castShadow = true;
    body.add(head);

    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(0.198, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), hair
    );
    cap.position.y = 1.61;
    body.add(cap);

    // Visor: penanda arah pandang (depan = +z lokal)
    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.07, 0.06),
      new THREE.MeshStandardMaterial({
        color: 0x0d1522, emissive: color.getHex(), emissiveIntensity: 0.7, roughness: 0.3
      })
    );
    visor.position.set(0, 1.6, 0.17);
    body.add(visor);

    const armGeo = new THREE.CylinderGeometry(0.05, 0.055, 0.52, 8);
    function makeArm(side) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.23, 1.34, 0);
      const arm = new THREE.Mesh(armGeo, shirt);
      arm.position.y = -0.26;
      arm.castShadow = true;
      pivot.add(arm);
      body.add(pivot);
      return pivot;
    }
    const armL = makeArm(-1);
    const armR = makeArm(1);

    const legGeo = new THREE.CylinderGeometry(0.06, 0.07, 0.68, 8);
    function makeLeg(side) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.1, 0.76, 0);
      const leg = new THREE.Mesh(legGeo, pants);
      leg.position.y = -0.34;
      leg.castShadow = true;
      pivot.add(leg);
      body.add(pivot);
      return pivot;
    }
    const legL = makeLeg(-1);
    const legR = makeLeg(1);

    const contact = new THREE.Mesh(new THREE.CircleGeometry(0.34, 16), MATS.shadow);
    contact.rotation.x = -Math.PI / 2;
    contact.position.y = 0.03;
    group.add(contact);

    const ringMat = new THREE.MeshBasicMaterial({
      color: STATE_COLORS.idle, transparent: true, opacity: 0.68,
      depthWrite: false, side: THREE.DoubleSide
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.4, 32), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.035;
    group.add(ring);

    const selMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.85,
      depthWrite: false, side: THREE.DoubleSide
    });
    const sel = new THREE.Mesh(new THREE.RingGeometry(0.52, 0.6, 40), selMat);
    sel.rotation.x = -Math.PI / 2;
    sel.position.y = 0.045;
    sel.visible = false;
    group.add(sel);

    const label = makeLabel(agent.name, {
      fontSize: 38, height: 0.24, color: '#f2f7ff', bg: 'rgba(7,12,20,0.78)'
    });
    label.position.y = 2.18;
    group.add(label);

    const exclaim = makeExclaim();
    exclaim.position.y = 2.66;
    exclaim.visible = false;
    group.add(exclaim);

    return {
      group: group, body: body, head: head, armL: armL, armR: armR,
      legL: legL, legR: legR, ring: ring, ringMat: ringMat,
      sel: sel, label: label, exclaim: exclaim
    };
  }

  /* ================================================================
   * Obstacle meja & kursi + uji tabragan
   *
   * Setiap meja di layout punya bounding box (AABB) yang mencakup meja
   * DAN kursinya. Agent tidak boleh memotong kotak ini saat berjalan.
   * Satu-satunya pengecualian: kursi milik agent itu sendiri, karena
   * di sanalah tujuan akhir saat agent duduk.
   * ================================================================ */
  const AGENT_RADIUS = 0.26;

  function deskBoxes(desk) {
    const w = desk.w || 2.05;
    const d = desk.d || 1.05;
    const cw = desk.cw || 0.56;
    const cd = desk.cd || 0.56;
    const rot = desk.rot || 0;
    const alongX = Math.abs(rot) < 0.01 || Math.abs(Math.abs(rot) - Math.PI) < 0.01;
    const top = alongX
      ? [desk.x - w / 2, desk.x + w / 2, desk.z - d / 2, desk.z + d / 2]
      : [desk.x - d / 2, desk.x + d / 2, desk.z - w / 2, desk.z + w / 2];
    const ch = desk.chair || [desk.x, desk.z];
    const seat = alongX
      ? [ch[0] - cw / 2, ch[0] + cw / 2, ch[1] - cd / 2, ch[1] + cd / 2]
      : [ch[0] - cd / 2, ch[0] + cd / 2, ch[1] - cw / 2, ch[1] + cw / 2];
    return {
      top: top,
      seat: seat,
      box: [
        Math.min(top[0], seat[0]), Math.max(top[1], seat[1]),
        Math.min(top[2], seat[2]), Math.max(top[3], seat[3])
      ]
    };
  }

  function buildDeskObstacles() {
    app.deskObstacles = [];
    app.rooms.forEach(function (room) {
      (room.desks || []).forEach(function (desk, i) {
        const b = deskBoxes(desk);
        app.deskObstacles.push({
          room: room.id,
          index: i,
          x0: b.box[0], x1: b.box[1], z0: b.box[2], z1: b.box[3],
          cx: (b.box[0] + b.box[1]) / 2,
          cz: (b.box[2] + b.box[3]) / 2,
          r: Math.max(b.box[1] - b.box[0], b.box[3] - b.box[2]) / 2,
          top: b.top,
          seat: b.seat,
          desk: desk
        });
      });
    });
    return app.deskObstacles;
  }

  /* ================================================================
   * Perabot ruang rapat (meja conferencing + kursinya).
   *
   * Ruangan board tidak punya "desks", jadi mejanya tidak masuk ke
   * app.deskObstacles. Kalau tidak dipisah begini, agent bisa menembus
   * meja conferences. Kotak di sini dipakai:
   *   - routeHitsFurniture() -> agent tidak menabrak meja/kursi rapat
   *   - audit()              -> agent tidak berdiri di dalam perabot
   * Kursi target boleh dimasuki (agent duduk di situ), jadi dikecualikan
   * lewat rec.ignoreFurniture.
   * ================================================================ */
  const CHAIR_HALF = 0.26;      // kursi 0.52 x 0.52 (lihat createChair)

  function meetingSlots() {
    const m = app.meeting;
    return (m.seats || []).concat(m.standing || []);
  }

  function furnitureByKey(key) {
    for (let i = 0; i < app.furniture.length; i += 1) {
      if (app.furniture[i].key === key) return app.furniture[i];
    }
    return null;
  }

  function buildMeetingFurniture(meeting) {
    app.meeting = meeting;
    app.furniture = [];
    if (app.hotDesk && app.hotDesk.table) {
      const ht = app.hotDesk.table;
      app.furniture.push({ kind: 'table', key: 'hot_table', x0: ht.x0, x1: ht.x1, z0: ht.z0, z1: ht.z1 });
    }
    const t = app.meeting.table;
    if (t) {
      app.furniture.push({
        kind: 'table', key: 'meeting_table',
        x0: t.x0, x1: t.x1, z0: t.z0, z1: t.z1
      });
    }
    meetingSlots().forEach(function (s, i) {
      app.furniture.push({
        kind: 'chair', key: 'meeting_slot_' + i, slot: i,
        x0: s.x - CHAIR_HALF, x1: s.x + CHAIR_HALF,
        z0: s.z - CHAIR_HALF, z1: s.z + CHAIR_HALF
      });
    });
    return app.furniture;
  }

  /* Segmen a-b vs kotak axis-aligned (slab method). */
  function segHitsBox(ax, az, bx, bz, box, pad) {
    const p = pad || 0;
    const x0 = box[0] - p, x1 = box[1] + p;
    const z0 = box[2] - p, z1 = box[3] + p;
    let tmin = 0, tmax = 1;
    function slab(origin, dir, lo, hi) {
      if (Math.abs(dir) < 1e-12) return origin >= lo && origin <= hi;
      let t1 = (lo - origin) / dir;
      let t2 = (hi - origin) / dir;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      return tmax >= tmin;
    }
    if (!slab(ax, bx - ax, x0, x1)) return false;
    if (!slab(az, bz - az, z0, z1)) return false;
    return tmax >= tmin;
  }

  /* True bila titik (x,z) berada di dalam kotak (dengan padding). */
  function pointInBox(x, z, box, pad) {
    const p = pad || 0;
    return x > box[0] - p && x < box[1] + p && z > box[2] - p && z < box[3] + p;
  }

  /* ================================================================
   * Posisi & rute agent
   * ================================================================ */
  function agentDeskInfo(agent, room) {
    const px = agent.pos && agent.pos[0];
    const pz = agent.pos && agent.pos[2];
    const inside = Number.isFinite(px) && Number.isFinite(pz) &&
      Math.abs(px - room.x) <= room.w / 2 + 0.1 &&
      Math.abs(pz - room.z) <= room.d / 2 + 0.1;
    let desk = null;
    if (inside) {
      desk = { x: px, z: pz, rot: agent.desk_rot || 0 };
      if (agent.chair) desk.chair = agent.chair;
      if (agent.stand) desk.stand = agent.stand;
    }
    if (!desk) {
      const list = room.desks || [];
      desk = list[agent.slot] || list[0] || {
        x: room.x, z: room.z, rot: 0,
        chair: [room.x, room.z + 0.95], stand: [room.x, room.z + 1.8]
      };
    }
    if (!desk.chair) desk.chair = [desk.x, desk.z + 0.95];
    if (!desk.stand) desk.stand = [desk.x, desk.z + 1.8];
    return desk;
  }

  function setupAgentSpots(rec, agent, room) {
    const d = agentDeskInfo(agent, room);
    rec.desk = d;
    rec.seat = { x: d.chair[0], z: d.chair[1] };
    rec.stand = { x: d.stand[0], z: d.stand[1] };
    rec.faceRot = (d.rot || 0) + Math.PI;
    rec.deskFaceRot = rec.faceRot;
    rec.room = room;
    // Indeks meja di daftar ruangan -> dipakai untuk mengabaikan kotak
    // meja sendiri saat agent mendekati kursinya.
    const list = room.desks || [];
    let idx = -1;
    for (let i = 0; i < list.length; i += 1) {
      if (Math.abs(list[i].x - d.x) < 1e-6 && Math.abs(list[i].z - d.z) < 1e-6) { idx = i; break; }
    }
    rec.deskRef = { room: room.id, index: idx };
  }

  /* ================================================================
   * Zona santai: agent idle menyebar ke beberapa zona dengan kapasitas,
   * bukan berkumpul di satu plaza. Zona dipilih acak berbobot sisa
   * kapasitas; setelah 30-80 detik agent bisa pindah zona.
   * ================================================================ */
  function registerZone(z) {
    const r = z.room;
    z.spots = (z.spots || []).map(function (sp) { return { x: r.x + sp.x, z: r.z + sp.z, face: sp.face }; });
    app.zones.push(z);
    app.zoneById.set(z.id, z);
    return z;
  }

  function inZone(zone, pos) {
    if (!zone) return false;
    const b = zone.bounds;
    return pos.x >= b.x0 - 0.05 && pos.x <= b.x1 + 0.05 && pos.z >= b.z0 - 0.05 && pos.z <= b.z1 + 0.05;
  }

  function inPlayground(pos) { return inZone(app.zoneById.get('playground'), pos); }

  function zoneLoad(except) {
    const occ = {};
    app.agentById.forEach(function (o) {
      if (o === except || o.status !== 'idle' || !o.zone) return;
      occ[o.zone.id] = (occ[o.zone.id] || 0) + 1;
    });
    return occ;
  }

  function pickZone(rec) {
    const occ = zoneLoad(rec);
    let total = 0;
    const opts = app.zones.map(function (z) {
      let w = Math.max(0, z.cap - (occ[z.id] || 0)) * (z.weight || 1);
      if (rec.zone === z) w *= 0.6;          // sedikit dorongan untuk pindah
      total += w;
      return { z: z, w: w };
    });
    if (total <= 0) return app.zoneById.get('playground') || app.zones[0];
    let roll = Math.random() * total;
    for (let i = 0; i < opts.length; i += 1) {
      roll -= opts[i].w;
      if (roll <= 0) return opts[i].z;
    }
    return opts[opts.length - 1].z;
  }

  function routeToZone(rec, zone) {
    return walkFrom(rec, [], randomZoneTarget(rec, zone));
  }

  /* pts (awalan, mis. keluar dari kursi rapat) + rute A* ke target.
     Agent yang duduk di kursi mejanya berdiri dulu ke titik 'stand'. */
  function walkFrom(rec, pts, target) {
    const p = rec.group.position;
    if (!pts.length && rec.seat && Math.hypot(p.x - rec.seat.x, p.z - rec.seat.z) < 0.3) {
      pts.push({ x: rec.stand.x, z: rec.stand.z });
    }
    const from = pts.length ? pts[pts.length - 1] : { x: p.x, z: p.z };
    return pts.concat(findPath(from, target));
  }

  /* Titik santai yang sedang dipakai / dituju agent lain? */
  function spotTaken(sp, rec) {
    let taken = false;
    app.agentById.forEach(function (o) {
      if (taken || o === rec) return;
      const p = o.group.position;
      const last = o.waypoints.length ? o.waypoints[o.waypoints.length - 1] : null;
      if (Math.hypot(p.x - sp.x, p.z - sp.z) < 0.55 ||
          (last && Math.hypot(last.x - sp.x, last.z - sp.z) < 0.55)) taken = true;
    });
    return taken;
  }

  function pointFreeOfFurniture(x, z) {
    for (let i = 0; i < app.furniture.length; i += 1) {
      const o = app.furniture[i];
      if (x > o.x0 - AGENT_RADIUS && x < o.x1 + AGENT_RADIUS &&
          z > o.z0 - AGENT_RADIUS && z < o.z1 + AGENT_RADIUS) return false;
    }
    return true;
  }

  function randomZoneTarget(rec, zone) {
    zone = zone || app.zoneById.get('playground') || app.zones[0];
    const b = zone.bounds;
    if (zone.spots.length && Math.random() < (zone.walled ? 0.6 : 0.3)) {
      const free = zone.spots.filter(function (sp) {
        return !spotTaken(sp, rec) && pointFreeOfFurniture(sp.x, sp.z) && standable(sp.x, sp.z);
      });
      if (free.length) {
        const sp = free[Math.floor(Math.random() * free.length)];
        return { x: sp.x, z: sp.z, face: sp.face };
      }
    }
    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < 22; i += 1) {
      const x = b.x0 + Math.random() * (b.x1 - b.x0);
      const z = b.z0 + Math.random() * (b.z1 - b.z0);
      if (!navFree(x, z)) continue;
      let score = Math.random() * 2;
      app.agentById.forEach(function (other) {
        if (other === rec || other.status !== 'idle') return;
        score += Math.min(7, Math.hypot(x - other.group.position.x, z - other.group.position.z));
      });
      if (score > bestScore) { bestScore = score; best = { x: x, z: z }; }
    }
    return best || { x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2 };
  }

  /* Rute balik ke meja: selalu mendarat di 'stand' dulu; agent 'working'
   * baru bergeser masuk ke kursi, agent 'blocked' tetap berdiri di sana. */
  function routeHome(rec, fromMeeting, fromSeat) {
    const pts = walkFrom(rec, fromMeeting ? meetingExitPath(rec, fromSeat) : [], rec.stand);
    if (rec.status === 'working') pts.push({ x: rec.seat.x, z: rec.seat.z, seat: true });
    return pts;
  }

  function routeToPlaza(rec, fromMeeting, fromSeat) {
    const zone = pickZone(rec);
    rec.zone = zone;
    rec.zoneUntil = app.clock + 30 + Math.random() * 50;
    return walkFrom(rec, fromMeeting ? meetingExitPath(rec, fromSeat) : [], randomZoneTarget(rec, zone));
  }

  /* --- Meeting mode ---------------------------------------------------- */

  /* Agent sedang berdiri di ruang rapat? */
  function inMeetingRoom(rec) {
    const m = app.meeting;
    const room = app.roomById.get(m.room);
    if (!room) return false;
    const p = rec.group.position;
    return Math.abs(p.x - room.x) < room.w / 2 && Math.abs(p.z - room.z) < room.d / 2;
  }

  /* Keluar dari kursi rapat: mundur ke titik 'approach' kursi itu dulu
   * (seat = kursi yang DIPAKAI, bisa kursi lama yang sudah dilepas server). */
  function meetingExitPath(rec, seat) {
    const s = seat || rec.meetingSeat;
    return s && s.approach ? [{ x: s.approach.x, z: s.approach.z }] : [];
  }

  /* Rute ke kursi rapat: A* ke titik 'approach' kursi, lalu duduk. */
  function routeToMeeting(rec, fromSeat) {
    const seat = rec.meetingSeat;
    if (!seat) return [];
    const pre = fromSeat && fromSeat !== seat && inMeetingRoom(rec)
      ? meetingExitPath(rec, fromSeat) : [];
    const pts = walkFrom(rec, pre, seat.approach || seat);
    const last = { x: seat.x, z: seat.z };
    if (seat.sit) last.seat = true;
    pts.push(last);
    return pts;
  }

  function createAgent(agent) {
    const room = app.roomById.get(agent.room) || {
      x: 0, z: 0, w: 12, d: 8, accent: agent.color || '#38bdf8',
      kind: 'department', nav: { door: null, aisle: null, hub: null }, desks: []
    };
    const human = createHumanoid(agent);
    const rec = {
      id: agent.id, data: agent,
      group: human.group, body: human.body, head: human.head,
      armL: human.armL, armR: human.armR, legL: human.legL, legR: human.legR,
      ring: human.ring, ringMat: human.ringMat, sel: human.sel,
      label: human.label, exclaim: human.exclaim,
      room: room, status: agent.state || 'idle',
      waypoints: [], moving: false,
      meetingSeat: null, meetingSeatIndex: -1, ignoreFurniture: null,
      speed: 1.9 + Math.random() * 0.6,
      phase: Math.random() * Math.PI * 2,
      walkPhase: Math.random() * Math.PI * 2,
      targetRotY: 0, idleWait: 1 + Math.random() * 3,
      labelBase: 2.1 + Math.random() * 0.18
    };
    setupAgentSpots(rec, agent, room);

    const deskInfo = createDesk(agent, rec.desk.x, rec.desk.z, rec.desk.rot,
      room.kind === 'executive', rec.desk);
    rec.deskGroup = deskInfo.group;
    rec.screenMat = deskInfo.screenMat;

    human.group.userData.agentId = agent.id;

    const slot = resolveMeetingSlot(agent);
    rec.meetingSeatIndex = slot.index;
    rec.meetingSeat = slot.slot;

    if (rec.status === 'working') {
      human.group.position.set(rec.seat.x, 0, rec.seat.z);
      rec.targetRotY = rec.faceRot;
    } else if (rec.status === 'blocked') {
      human.group.position.set(rec.stand.x, 0, rec.stand.z);
      rec.targetRotY = rec.faceRot;
    } else if (rec.status === 'meeting' && rec.meetingSeat) {
      // Halaman baru dibuka saat rapat sedang berjalan: agent langsung
      // duduk di kursinya, tidak jalan dari plaza.
      human.group.position.set(rec.meetingSeat.x, 0, rec.meetingSeat.z);
      rec.faceRot = rec.meetingSeat.face_rot;
      rec.ignoreFurniture = 'meeting_slot_' + rec.meetingSeatIndex;
      rec.targetRotY = rec.faceRot;
    } else {
      rec.zone = pickZone(rec);
      rec.zoneUntil = 20 + Math.random() * 60;
      const p = randomZoneTarget(rec, rec.zone);
      human.group.position.set(p.x, 0, p.z);
      rec.targetRotY = Math.random() * Math.PI * 2;
      rec.idleWait = 0.4 + Math.random() * 3;
    }
    human.group.rotation.y = rec.targetRotY;
    rec.ringMat.color.setHex(STATE_COLORS[rec.status] || STATE_COLORS.idle);
    rec.exclaim.visible = rec.status === 'blocked';
    setScreen(rec);
    app.scene.add(human.group);
    return rec;
  }

  /* Slot rapat untuk satu agent: index dari server, atau urutan peserta
   * dari payload snapshot kalau server lama belum mengirim index. */
  function resolveMeetingSlot(agent) {
    const slots = meetingSlots();
    if (typeof agent.meeting_seat === 'number' && agent.meeting_seat >= 0 &&
        agent.meeting_seat < slots.length) {
      return { index: agent.meeting_seat, slot: slots[agent.meeting_seat] };
    }
    const parts = (app.meetingLive && app.meetingLive.participants) || [];
    const idx = parts.indexOf(agent.id);
    if (idx >= 0 && idx < slots.length) {
      return { index: idx, slot: slots[idx] };
    }
    return { index: -1, slot: null };
  }

  function applyRoute(rec, prev, fromSeat) {
    const wasMeeting = prev === 'meeting';
    if (rec.status === 'meeting') {
      rec.ignoreFurniture = rec.meetingSeat ? 'meeting_slot_' + rec.meetingSeatIndex : null;
      rec.faceRot = rec.meetingSeat ? rec.meetingSeat.face_rot : rec.deskFaceRot;
      const seat = rec.meetingSeat;
      const onSeat = seat && Math.hypot(
        rec.group.position.x - seat.x, rec.group.position.z - seat.z) < 0.25;
      if (onSeat) {
        rec.waypoints = [];
        rec.moving = false;
        rec.targetRotY = rec.faceRot;
        return;
      }
      rec.waypoints = routeToMeeting(rec, fromSeat);
      rec.moving = rec.waypoints.length > 0;
      rec.idleWait = 1 + Math.random() * 2.5;
      return;
    }
    // Keluar dari rapat: kembali ke status sebelumnya (meja / plaza).
    // Pengecualian kursi TIDAK langsung dilepas: agent masih berdiri di
    // atas kursinya, jadi kotaknya ditoleransi sampai agent benar-benar
    // keluar (dicek di updateAgent).
    if (!wasMeeting) rec.ignoreFurniture = null;
    rec.faceRot = rec.deskFaceRot;
    const leaving = wasMeeting && inMeetingRoom(rec);
    if (rec.status === 'idle') {
      rec.waypoints = routeToPlaza(rec, leaving, fromSeat);
      rec.moving = true;
      rec.idleWait = 1 + Math.random() * 2.5;
    } else {
      const alreadyThere = rec.status === 'working'
        ? Math.hypot(rec.group.position.x - rec.seat.x, rec.group.position.z - rec.seat.z) < 0.45
        : Math.hypot(rec.group.position.x - rec.stand.x, rec.group.position.z - rec.stand.z) < 0.45;
      if (alreadyThere && !leaving) {
        rec.waypoints = [];
        rec.moving = false;
        rec.targetRotY = rec.faceRot;
        return;
      }
      rec.waypoints = routeHome(rec, leaving, fromSeat);
      rec.moving = true;
    }
  }

  function applyPose(rec, dt, t) {
    const k = 1 - Math.exp(-10 * dt);
    let legL = 0, legR = 0, armL = 0, armR = 0;
    let bodyY = 0, headX = 0, headY = 0, labelY = rec.labelBase || 2.18;

    if (rec.moving) {
      const s = Math.sin(rec.walkPhase);
      legL = s * 0.55;
      legR = -s * 0.55;
      armL = -s * 0.45;
      armR = s * 0.45;
      bodyY = Math.abs(Math.sin(rec.walkPhase)) * 0.04;
      headX = 0.02;
    } else if (rec.status === 'working') {
      bodyY = -0.32;
      legL = -1.45;
      legR = -1.45;
      armL = -0.86 + Math.sin(t * 7 + rec.phase) * 0.09;
      armR = -0.86 + Math.sin(t * 7 + rec.phase + 0.9) * 0.09;
      headX = 0.1 + Math.sin(t * 2.1 + rec.phase) * 0.07;
      labelY = (rec.labelBase || 2.18) - 0.26;
    } else if (rec.status === 'meeting') {
      // Duduk di kursi rapat: badan membungkuk sedikit, kepalavie
      // sesekali menoleh ke pembicara (bukan mengetik seperti kerja).
      bodyY = -0.30;
      legL = -1.45;
      legR = -1.45;
      armL = -0.78 + Math.sin(t * 1.6 + rec.phase) * 0.06;
      armR = -0.78 + Math.sin(t * 1.6 + rec.phase + 1.4) * 0.06;
      headX = 0.08 + Math.sin(t * 1.3 + rec.phase) * 0.06;
      headY = Math.sin(t * 0.9 + rec.phase) * 0.22;
      labelY = (rec.labelBase || 2.18) - 0.26;
    } else if (rec.status === 'blocked') {
      armL = 0.05;
      armR = -0.05;
      bodyY = 0.012 * Math.sin(t * 2 + rec.phase);
      headX = 0.04 * Math.sin(t * 3 + rec.phase);
      headY = 0.18 * Math.sin(t * 1.6 + rec.phase);
    } else {
      bodyY = 0.012 * Math.sin(t * 1.8 + rec.phase);
      armL = 0.04 * Math.sin(t * 1.8 + rec.phase);
      armR = -armL;
    }

    rec.body.position.y += (bodyY - rec.body.position.y) * k;
    rec.legL.rotation.x += (legL - rec.legL.rotation.x) * k;
    rec.legR.rotation.x += (legR - rec.legR.rotation.x) * k;
    rec.armL.rotation.x += (armL - rec.armL.rotation.x) * k;
    rec.armR.rotation.x += (armR - rec.armR.rotation.x) * k;
    rec.head.rotation.x += (headX - rec.head.rotation.x) * k;
    rec.head.rotation.y += (headY - rec.head.rotation.y) * k;
    rec.label.position.y += (labelY - rec.label.position.y) * k;
  }

  function updateAgent(rec, dt, t) {
    /* Lepas pengecualian kursi rapat begitu agent sudah keluar dari kotak
     * kursi DAN tidak lagi menuju kursinya (agent yang masih jalan ke
     * kursi tetap butuh pengecualian itu). */
    if (rec.ignoreFurniture && rec.status !== 'meeting') {
      const o = furnitureByKey(rec.ignoreFurniture);
      if (!o || !pointInBox(rec.group.position.x, rec.group.position.z,
        [o.x0, o.x1, o.z0, o.z1], 0)) {
        rec.ignoreFurniture = null;
      }
    }
    // Idle: jalan-jalan di zona santai; sesekali pindah ke zona lain.
    if (rec.status === 'idle' && rec.waypoints.length === 0) {
      rec.idleWait -= dt;
      if (rec.idleWait <= 0) {
        if (!rec.zone || app.clock > rec.zoneUntil) {
          const next = pickZone(rec);
          rec.zoneUntil = app.clock + 30 + Math.random() * 50;
          if (next !== rec.zone) {
            rec.zone = next;
            rec.waypoints = routeToZone(rec, next);
          }
        }
        if (!rec.waypoints.length) {
          rec.waypoints = routeToZone(rec, rec.zone);
        }
        rec.idleWait = rec.zone.walled ? 3 + Math.random() * 6 : 1.2 + Math.random() * 3.2;
      }
    }

    if (rec.waypoints.length) {
      rec.moving = true;
      const wp = rec.waypoints[0];
      const dx = wp.x - rec.group.position.x;
      const dz = wp.z - rec.group.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.12) {
        rec.waypoints.shift();
        // Duduk TEPAT di kursi: snap ke koordinat kursi, bukan berhenti
        // 0.1 unit di dekatnya.
        if (wp.seat) {
          rec.group.position.x = wp.x;
          rec.group.position.z = wp.z;
          rec.targetRotY = rec.faceRot;
        }
        if (!rec.waypoints.length) {
          rec.moving = false;
          rec.idleWait = 1.2 + Math.random() * 3.2;
          rec.targetRotY = (rec.status === 'idle')
            ? (wp.face !== undefined ? wp.face : rec.targetRotY)
            : rec.faceRot;
        }
      } else {
        const step = Math.min(dist, rec.speed * dt);
        const nx = rec.group.position.x + (dx / dist) * step;
        const nz = rec.group.position.z + (dz / dist) * step;
        rec.group.position.x = nx;
        rec.group.position.z = nz;
        rec.targetRotY = Math.atan2(dx, dz);
        rec.walkPhase += dt * 8.5;
      }
    } else {
      rec.moving = false;
    }

    let diff = rec.targetRotY - rec.group.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    rec.group.rotation.y += diff * Math.min(1, dt * 9);

    applyPose(rec, dt, t);

    rec.exclaim.visible = rec.status === 'blocked';
    if (rec.exclaim.visible) {
      rec.exclaim.material.opacity = 0.3 + 0.7 * Math.abs(Math.sin(t * 6 + rec.phase));
      const s = 0.5 * (0.92 + 0.12 * Math.sin(t * 6 + rec.phase));
      rec.exclaim.scale.set(s, s, 1);
    }
    rec.ringMat.opacity = rec.status === 'blocked'
      ? 0.42 + 0.46 * Math.abs(Math.sin(t * 5))
      : 0.68;
    if (rec.sel.visible) rec.sel.rotation.z += dt * 0.9;
    setScreen(rec);
  }

  function setScreen(rec) {
    if (!rec.screenMat) return;
    rec.screenMat.emissiveIntensity = rec.status === 'working' ? 1.9
      : (rec.status === 'blocked' ? 0.9 : (rec.status === 'meeting' ? 0.7 : 0.45));
  }

  function syncAgents(agents) {
    const seen = new Set();
    agents.forEach(function (agent) {
      seen.add(agent.id);
      let rec = app.agentById.get(agent.id);
      if (!rec) {
        rec = createAgent(agent);
        app.agentById.set(agent.id, rec);
      }
      const prev = rec.status;
      if (deskMoved(rec, agent)) reseat(rec, agent);
      const room = app.roomById.get(agent.room);
      if (room) {
        agent.room_label = room.label;
        agent.accent = room.accent;
        rec.room = room;
      }
      rec.data = agent;
      /* Override debug (office3d.setState) menang atas status server,
         supaya pose bisa difoto tanpa menunggu status vault berubah. */
      rec.status = app.forcedState[agent.id] || agent.state || 'idle';
      // Slot rapat: kalau berubah (peserta masuk/keluar), agent dialihkan.
      const slot = resolveMeetingSlot(agent);
      const prevSeat = rec.meetingSeat;
      const seatChanged = slot.index !== rec.meetingSeatIndex;
      rec.meetingSeatIndex = slot.index;
      rec.meetingSeat = slot.slot;
      if (prev !== rec.status || seatChanged || rec.needsRoute) {
        rec.needsRoute = false;
        rec.ringMat.color.setHex(STATE_COLORS[rec.status] || STATE_COLORS.idle);
        applyRoute(rec, prev, prevSeat);
      }
      rec.label.material.opacity = (agent.id === app.selectedId || agent.id === app.hoveredId) ? 1 : 0.92;
    });

    app.agentById.forEach(function (rec, id) {
      if (seen.has(id)) return;
      app.scene.remove(rec.group);
      if (app.selectedId === id) closePanel();
      if (rec.deskGroup) {
        app.scene.remove(rec.deskGroup);
        app.deskById.delete(id);
      }
      app.agentById.delete(id);
    });
    app.agents = agents;
  }

  /* ================================================================
   * Pindah meja saat roster/denah berubah (agent baru, ruangan penuh)
   * ================================================================ */
  function deskMoved(rec, agent) {
    if (!agent.pos || !rec.desk) return false;
    return Math.abs(agent.pos[0] - rec.desk.x) > 1e-3 || Math.abs(agent.pos[2] - rec.desk.z) > 1e-3 ||
      (agent.room && rec.room && agent.room !== rec.room.id);
  }

  function reseat(rec, agent) {
    if (rec.deskGroup) {
      app.scene.remove(rec.deskGroup);
      app.deskById.delete(rec.id);
      rec.deskGroup = null;
      rec.screenMat = null;
    }
    const room = app.roomById.get(agent.room) || rec.room;
    setupAgentSpots(rec, agent, room);
    const info = createDesk(agent, rec.desk.x, rec.desk.z, rec.desk.rot, room.kind === 'executive', rec.desk);
    rec.deskGroup = info.group;
    rec.screenMat = info.screenMat;
    setScreen(rec);
    // Meja baru bisa jatuh tepat di posisi agent: geser ke titik berdiri.
    const pos = rec.group.position;
    if (!navFree(pos.x, pos.z)) pos.set(rec.stand.x, 0, rec.stand.z);
    rec.waypoints = [];
    rec.needsRoute = true;
  }

  /* ================================================================
   * Util UI
   * ================================================================ */
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function icon(name, cls) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(NS, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  }

  function initials(name) {
    return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2)
      .map(function (w) { return w[0]; }).join('').toUpperCase();
  }

  function taskTitle(name) {
    return String(name).replace(/\.md$/, '').replace(/^T-\d{4}-\d{2}-\d{2}-/, '').replace(/-/g, ' ');
  }

  function taskDate(name) {
    const m = /^T-(\d{4})-(\d{2})-(\d{2})/.exec(name);
    return m ? m[3] + '/' + m[2] : '';
  }

  function loadPrefs() {
    try {
      const raw = window.localStorage.getItem('hoffice.prefs');
      if (raw) Object.assign(app.prefs, JSON.parse(raw));
    } catch (e) { /* storage diblokir: pakai default */ }
  }

  function savePrefs() {
    try { window.localStorage.setItem('hoffice.prefs', JSON.stringify(app.prefs)); } catch (e) { /* abaikan */ }
  }

  /* ---- Markdown subset. Konten vault ditulis agent, jadi diperlakukan
     sebagai tidak tepercaya: semua di-escape dulu, baru pola markdown
     diubah jadi tag. Link hanya http(s). ---- */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function mdInline(src) {
    const keep = [];
    function stash(html) { keep.push(html); return '\u0000' + (keep.length - 1) + '\u0000'; }
    let s = escapeHtml(src);
    s = s.replace(/`([^`]+)`/g, function (m, c) { return stash('<code>' + c + '</code>'); });
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (m, t, u) {
      return stash('<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + t + '</a>');
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>');
    return s.replace(/\u0000(\d+)\u0000/g, function (m, i) { return keep[+i]; });
  }

  function md(src) {
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let para = [];
    let i = 0;
    function flush() {
      if (para.length) { out.push('<p>' + para.map(mdInline).join('<br>') + '</p>'); para = []; }
    }
    function cells(l) { return l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); }); }
    while (i < lines.length) {
      const line = lines[i];
      let m;
      if (/^\s*```/.test(line)) {
        flush();
        const buf = [];
        i += 1;
        while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i += 1; }
        i += 1;
        out.push('<pre><code>' + escapeHtml(buf.join('\n')) + '</code></pre>');
        continue;
      }
      if (!line.trim()) { flush(); i += 1; continue; }
      if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
        flush();
        const lv = Math.min(5, m[1].length + 2);
        out.push('<h' + lv + '>' + mdInline(m[2]) + '</h' + lv + '>');
        i += 1;
        continue;
      }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flush(); out.push('<hr>'); i += 1; continue; }
      if (/^\s*>/.test(line)) {
        flush();
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
        out.push('<blockquote>' + mdInline(buf.join(' ')) + '</blockquote>');
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].indexOf('-') >= 0) {
        flush();
        const head = cells(line);
        i += 2;
        const body = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { body.push(cells(lines[i])); i += 1; }
        out.push('<table><thead><tr>' + head.map(function (c) { return '<th>' + mdInline(c) + '</th>'; }).join('') +
          '</tr></thead><tbody>' + body.map(function (r) {
            return '<tr>' + r.map(function (c) { return '<td>' + mdInline(c) + '</td>'; }).join('') + '</tr>';
          }).join('') + '</tbody></table>');
        continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        flush();
        const ordered = /^\s*\d/.test(line);
        const items = [];
        while (i < lines.length && (m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]))) {
          const t = /^\[([ xX])\]\s+(.*)$/.exec(m[2]);
          items.push(t
            ? '<li class="task"><span class="check' + (t[1] === ' ' ? '' : ' on') + '" aria-label="' +
              (t[1] === ' ' ? 'belum' : 'selesai') + '"></span><span>' + mdInline(t[2]) + '</span></li>'
            : '<li>' + mdInline(m[2]) + '</li>');
          i += 1;
        }
        out.push((ordered ? '<ol>' : '<ul>') + items.join('') + (ordered ? '</ol>' : '</ul>'));
        continue;
      }
      para.push(line.trim());
      i += 1;
    }
    flush();
    return out.join('');
  }

  function setMd(node, text, emptyMsg) {
    const t = String(text || '').trim();
    node.classList.toggle('is-empty', !t);
    if (!t) { node.textContent = emptyMsg; return; }
    node.innerHTML = md(t);
  }

  /* ================================================================
   * API: cookie sesi + header CSRF untuk POST; 401 -> halaman login.
   * ================================================================ */
  function goLogin() {
    if (app.auth) window.location.replace('/login');
  }

  async function api(path, opts) {
    opts = opts || {};
    const method = opts.method || 'GET';
    const headers = {};
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && app.csrf) headers['X-CSRF-Token'] = app.csrf;
    const res = await fetch(path, {
      method: method, headers: headers, cache: 'no-store', credentials: 'same-origin',
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    });
    if (res.status === 401) { goLogin(); throw new Error('sesi berakhir, silakan login lagi'); }
    let data;
    try { data = await res.json(); } catch (e) { throw new Error('respons server bukan JSON (HTTP ' + res.status + ')'); }
    if (!res.ok || data.success === false) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  /* ================================================================
   * HUD, roster, panel
   * ================================================================ */
  function updateHUD(counts) {
    const c = counts || countByState(app.agents);
    $('cnt-idle').textContent = c.idle || 0;
    $('cnt-working').textContent = c.working || 0;
    $('cnt-blocked').textContent = c.blocked || 0;
    $('cnt-meeting').textContent = c.meeting || 0;
    const depts = c.departments !== undefined ? c.departments
      : deptOrder(app.agents).filter(function (d) { return d !== 'executive'; }).length;
    $('hud-sub').textContent = (c.agents || app.agents.length) + ' agent · ' + depts + ' departemen · ' +
      app.zones.length + ' zona santai';
  }

  function setConnection(mode, text) {
    app.mode = mode;
    const node = $('conn');
    node.classList.remove('live', 'poll', 'off');
    node.classList.add(mode === 'live' ? 'live' : mode === 'poll' ? 'poll' : 'off');
    $('conn-text').textContent = text;
  }

  function renderRoster(agents) {
    const query = ($('roster-search').value || '').toLowerCase().trim();
    const sig = query + '#' + agents.map(function (a) {
      return a.id + ':' + a.name + ':' + a.state + ':' + a.open_count + ':' + a.done_count;
    }).join('|');
    if (sig === app.rosterSig) return;
    app.rosterSig = sig;

    const list = $('roster-list');
    const scrollTop = list.scrollTop;
    list.textContent = '';
    let shown = 0;
    deptOrder(agents).forEach(function (dept) {
      const members = agents.filter(function (a) { return a.dept === dept; });
      const filtered = members.filter(function (a) {
        return !query || [a.name, a.role, a.dept_label, a.room_label].some(function (v) {
          return String(v || '').toLowerCase().indexOf(query) >= 0;
        });
      });
      if (!filtered.length) return;
      const head = el('div', 'dept-head');
      const sw = el('span', 'swatch');
      const homeRoom = app.roomById.get(members[0].room);
      sw.style.background = homeRoom ? homeRoom.accent : members[0].color;
      head.appendChild(sw);
      head.appendChild(document.createTextNode(members[0].dept_label));
      list.appendChild(head);
      filtered.forEach(function (a) {
        shown += 1;
        const row = el('button', 'agent-row' + (a.id === app.selectedId ? ' active' : ''));
        row.type = 'button';
        row.dataset.id = a.id;
        row.title = a.headline ? a.role + '\n' + a.headline : a.role;
        row.setAttribute('aria-label', a.name + ', ' + (STATE_LABEL[a.state] || a.state) + ', ' +
          (a.open_count || 0) + ' tugas terbuka');
        row.appendChild(el('span', 'dot dot-' + (a.state || 'idle')));
        const meta = el('span', 'meta');
        meta.appendChild(el('span', 'nm', a.name));
        meta.appendChild(el('span', 'rl', a.role));
        row.appendChild(meta);
        const q = el('span', 'q');
        const b = el('b', null, String(a.open_count || 0));
        q.appendChild(b);
        q.appendChild(document.createTextNode('/' + (a.done_count || 0)));
        row.appendChild(q);
        row.addEventListener('click', function () { selectAgent(a.id, true); });
        list.appendChild(row);
      });
    });
    if (!shown) {
      list.appendChild(el('p', 'empty', query ? 'Tidak ada agent yang cocok dengan "' + query + '".'
        : 'Belum ada agent di vault. Tambahkan folder <dept>/AGENTS.md untuk merekrut agent.'));
    }
    $('roster-count').textContent = shown + '/' + agents.length;
    list.scrollTop = scrollTop;
  }

  function fillTargetSelect(agents) {
    const sig = agents.map(function (a) { return a.id + a.name; }).join('|');
    if (sig === app.targetSig) return;
    app.targetSig = sig;
    const sel = $('task-target');
    const current = sel.value;
    sel.textContent = '';
    deptOrder(agents).forEach(function (dept) {
      const og = document.createElement('optgroup');
      og.label = agents.find(function (a) { return a.dept === dept; }).dept_label;
      agents.filter(function (a) { return a.dept === dept; }).forEach(function (a) {
        const opt = document.createElement('option');
        opt.value = a.id;
        opt.textContent = a.name + ' — ' + a.role;
        og.appendChild(opt);
      });
      sel.appendChild(og);
    });
    if (current) sel.value = current;
  }

  const TABS = ['overview', 'tasks', 'journal', 'dispatch'];

  function setTab(name, focus) {
    app.panelTab = name;
    TABS.forEach(function (t) {
      const tab = $('tab-' + t);
      const on = t === name;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      $('pane-' + t).hidden = !on;
      if (on && focus) tab.focus();
    });
    $('side-panel').querySelector('.panel-body').scrollTop = 0;
  }

  function fillPanel(agent) {
    const rec = app.agentById.get(agent.id);
    $('panel-name').textContent = agent.name;
    $('panel-role').textContent = agent.role;
    const av = $('panel-avatar');
    av.textContent = initials(agent.name);
    av.style.background = agent.color || '';
    const stateChip = $('panel-state');
    stateChip.className = 'chip state-' + (agent.state || 'idle');
    stateChip.textContent = STATE_LABEL[agent.state] || agent.state;
    $('panel-dept').textContent = agent.dept_label;
    $('panel-room').textContent = agent.room_label;
    $('tab-tasks-count').textContent = (agent.open_count || 0) + (agent.blocked_count || 0);

    const meet = $('panel-meeting');
    meet.hidden = agent.state !== 'meeting';
    if (agent.state === 'meeting') {
      meet.textContent = 'Sedang rapat' + (agent.meeting_topic ? ': ' + agent.meeting_topic : '') +
        (agent.meeting_seat >= 0 ? ' · kursi ' + (agent.meeting_seat + 1) : '');
    }
    const hl = $('panel-headline');
    $('panel-headline-label').textContent = (agent.state === 'working' || agent.state === 'blocked') ? 'Sedang dikerjakan' : 'Aktivitas terakhir';
    let headline = agent.headline || '';
    if (!headline && agent.state === 'idle' && rec && rec.zone) headline = 'Santai di ' + rec.zone.room.label;
    hl.textContent = headline || 'Belum ada baris "Sedang:" di status.md';
    hl.classList.toggle('is-empty', !agent.headline);
    $('panel-open-count').textContent = agent.open_count || 0;
    $('panel-blocked-count').textContent = agent.blocked_count || 0;
    $('panel-done-count').textContent = agent.done_count || 0;
    $('panel-updated').textContent = agent.status_updated ? 'diperbarui ' + fmtTime(agent.status_updated) : '';
    setMd($('panel-status'), agent.status_text, 'Belum ada memory/status.md untuk agent ini.');
    $('panel-identity-wrap').hidden = !String(agent.identity_text || '').trim();
    setMd($('panel-identity'), agent.identity_text, '');

    renderTasks(agent);

    $('panel-journal-name').textContent = agent.last_journal_file || 'Jurnal';
    $('panel-journal-updated').textContent = agent.journal_updated ? fmtTime(agent.journal_updated) : '';
    setMd($('panel-journal'), agent.last_journal_content, 'Belum ada jurnal di memory/journal/.');
  }

  function renderTasks(agent) {
    const done = (agent.done_tasks || []).slice().reverse().slice(0, 15);
    const sig = agent.id + '|' + (agent.open_tasks || []).join(',') + '|' + (agent.blocked_tasks || []).join(',') + '|' + done.join(',');
    if (sig === app.taskSig) return;
    app.taskSig = sig;
    const box = $('panel-tasks');
    box.textContent = '';
    const groups = [
      ['open', 'Dikerjakan', agent.open_tasks || [], agent.open_count || 0],
      ['blocked', 'Terhambat', agent.blocked_tasks || [], agent.blocked_count || 0],
      ['done', 'Selesai terbaru', done, agent.done_count || 0]
    ];
    if (!groups.some(function (g) { return g[2].length; })) {
      const empty = el('div', 'empty');
      empty.appendChild(el('p', null, 'Antrean kosong. Belum ada tiket untuk ' + agent.name + '.'));
      const go = el('button', 'btn btn-ghost', 'Kirim tugas pertama');
      go.type = 'button';
      go.addEventListener('click', function () { setTab('dispatch'); $('task-goal').focus(); });
      empty.appendChild(go);
      box.appendChild(empty);
      return;
    }
    groups.forEach(function (g) {
      if (!g[2].length) return;
      const wrap = el('div', 'task-group');
      const h = el('h3', 'section-title');
      h.appendChild(el('span', null, g[1]));
      h.appendChild(el('span', 'badge mono', String(g[3])));
      wrap.appendChild(h);
      const ul = el('ul', 'task-list ' + g[0]);
      g[2].forEach(function (name, i) {
        const li = el('li');
        const btn = el('button', 'task-btn');
        btn.type = 'button';
        const bodyId = 'task-' + g[0] + '-' + i;
        btn.setAttribute('aria-expanded', 'false');
        btn.setAttribute('aria-controls', bodyId);
        btn.title = name;
        btn.appendChild(el('span', 'bar'));
        btn.appendChild(el('span', 't', taskTitle(name)));
        btn.appendChild(el('span', 'd', taskDate(name)));
        btn.appendChild(icon('chevron', 'ic-sm'));
        const body = el('div', 'task-body md');
        body.id = bodyId;
        body.hidden = true;
        btn.addEventListener('click', function () { toggleTask(agent.id, name, btn, body); });
        li.appendChild(btn);
        li.appendChild(body);
        ul.appendChild(li);
        if (app.openTask && app.openTask.agent === agent.id && app.openTask.name === name) {
          toggleTask(agent.id, name, btn, body);
        }
      });
      wrap.appendChild(ul);
      box.appendChild(wrap);
    });
  }

  async function toggleTask(agentId, name, btn, body) {
    const open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    body.hidden = !open;
    app.openTask = open ? { agent: agentId, name: name } : null;
    if (!open || body.dataset.loaded) return;
    body.textContent = '';
    [1, 2, 3].forEach(function () { body.appendChild(el('div', 'skeleton-row')); });
    try {
      const data = await api('/api/task-file?agent=' + encodeURIComponent(agentId) + '&name=' + encodeURIComponent(name));
      setMd(body, data.content, 'File tugas kosong.');
      body.dataset.loaded = '1';
    } catch (err) {
      body.textContent = 'Gagal membuka tugas: ' + err.message + '. Klik judul untuk mencoba lagi.';
      btn.setAttribute('aria-expanded', 'false');
      app.openTask = null;
    }
  }

  function selectAgent(id, fromRoster) {
    if (ED.on) { edStatus('Tutup editor denah untuk melihat detail agent.'); return; }
    const agent = app.agents.find(function (a) { return a.id === id; });
    if (!agent) return;
    const changed = app.selectedId !== id;
    app.selectedId = id;
    if (changed) { app.taskSig = ''; app.openTask = null; }
    fillPanel(agent);
    if (changed) $('task-target').value = agent.id;
    const panel = $('side-panel');
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    panel.removeAttribute('inert');
    document.body.classList.add('panel-open');
    app.agentById.forEach(function (rec) { rec.sel.visible = rec.id === id; });
    document.querySelectorAll('.agent-row').forEach(function (row) {
      row.classList.toggle('active', row.dataset.id === id);
    });
    if (fromRoster) {
      const row = document.querySelector('.agent-row[data-id="' + CSS.escape(id) + '"]');
      if (row) row.scrollIntoView({ block: 'nearest' });
    }
  }

  function closePanel() {
    const panel = $('side-panel');
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    panel.setAttribute('inert', '');
    document.body.classList.remove('panel-open');
    app.selectedId = null;
    setFollow(false);
    app.agentById.forEach(function (rec) { rec.sel.visible = false; });
    document.querySelectorAll('.agent-row.active').forEach(function (r) { r.classList.remove('active'); });
  }

  /* ================================================================
   * Feed aktivitas (event dihitung server dari diff snapshot)
   * ================================================================ */
  function renderFeed(events) {
    if (!Array.isArray(events) || !events.length) return;
    const maxSeq = events[events.length - 1].seq;
    const list = $('feed-list');
    if (maxSeq < app.feedSeq) app.feedSeq = 0;        // server di-restart
    const firstPaint = app.feedSeq === 0;
    if (firstPaint) list.textContent = '';
    const fresh = events.filter(function (e) { return e.seq > app.feedSeq; });
    if (!fresh.length) return;
    fresh.forEach(function (e) {
      const li = el('li', 'ev k-' + e.kind + (firstPaint ? '' : ' fresh'));
      const t = el('time', null, fmtTime(e.ts).slice(0, 5));
      t.dateTime = e.ts;
      li.appendChild(t);
      li.appendChild(el('span', 'dot'));
      const text = el('span');
      if (e.agent && app.agentById.has(e.agent)) {
        const who = el('a', 'who', e.name || e.agent);
        who.href = '#';
        who.addEventListener('click', function (ev) { ev.preventDefault(); selectAgent(e.agent, true); });
        text.appendChild(who);
        text.appendChild(document.createTextNode(' ' + e.text));
      } else {
        text.textContent = (e.name ? e.name + ' ' : '') + e.text;
      }
      li.appendChild(text);
      list.insertBefore(li, list.firstChild);
    });
    while (list.children.length > 60) list.removeChild(list.lastChild);
    app.feedSeq = maxSeq;
    $('feed-count').textContent = list.children.length + ' event';
  }

  /* ================================================================
   * Rapat: dialog mulai / akhiri
   * ================================================================ */
  function updateMeetingButton() {
    const live = app.meetingLive;
    const btn = $('btn-meeting');
    btn.classList.toggle('is-live', !!live);
    btn.title = live ? 'Rapat berlangsung: ' + (live.topic || 'tanpa topik') : 'Mulai rapat';
  }

  function openMeetingDialog() {
    const live = app.meetingLive;
    $('meeting-active').hidden = !live;
    $('meeting-new').hidden = !!live;
    $('meeting-end').hidden = !live;
    $('meeting-start').hidden = !!live;
    $('meeting-err').textContent = '';
    if (live) {
      $('meeting-title').textContent = 'Rapat berlangsung';
      $('meeting-active-topic').textContent = live.topic || 'Tanpa topik';
      $('meeting-active-meta').textContent = (live.started_at ? 'Mulai ' + fmtTime(live.started_at).slice(0, 5) : '') +
        (live.started_by ? ' oleh ' + live.started_by : '') + ' · ' + live.participants.length + ' peserta';
      const ul = $('meeting-active-people');
      ul.textContent = '';
      live.participants.forEach(function (pid) {
        const a = app.agents.find(function (x) { return x.id === pid; });
        ul.appendChild(el('li', null, a ? a.name : pid));
      });
    } else {
      $('meeting-title').textContent = 'Mulai rapat';
      const box = $('meeting-people');
      box.textContent = '';
      deptOrder(app.agents).forEach(function (dept) {
        const members = app.agents.filter(function (a) { return a.dept === dept; });
        box.appendChild(el('div', 'grp', members[0].dept_label));
        members.forEach(function (a) {
          const lab = el('label');
          const cb = el('input');
          cb.type = 'checkbox';
          cb.value = a.id;
          cb.checked = a.id === app.selectedId;
          cb.addEventListener('change', updatePicked);
          lab.appendChild(cb);
          lab.appendChild(document.createTextNode(a.name));
          box.appendChild(lab);
        });
      });
      updatePicked();
    }
    $('meeting-dialog').showModal();
    if (!live) $('meeting-topic').focus();
  }

  function updatePicked() {
    const n = $('meeting-people').querySelectorAll('input:checked').length;
    const max = meetingSlots().length;
    $('meeting-picked').textContent = n + '/' + max + ' dipilih' + (n > 10 && n <= max ? ' (10 duduk, sisanya berdiri)' : '');
    $('meeting-start').disabled = n > max;
    $('meeting-err').textContent = n > max ? 'Board Meeting Room hanya muat ' + max + ' orang. Kurangi ' + (n - max) + ' peserta.' : '';
  }

  async function startMeeting() {
    const ids = Array.prototype.map.call($('meeting-people').querySelectorAll('input:checked'), function (c) { return c.value; });
    if (!ids.length) { $('meeting-err').textContent = 'Pilih minimal satu peserta.'; return; }
    const btn = $('meeting-start');
    btn.disabled = true;
    btn.classList.add('is-loading');
    try {
      await api('/api/meeting/start', { method: 'POST', body: { participants: ids, topic: $('meeting-topic').value.trim(), from: 'web' } });
      $('meeting-dialog').close();
      $('meeting-topic').value = '';
      toast('Rapat dimulai, ' + ids.length + ' agent menuju Board Meeting Room');
      pollAgents();
    } catch (err) {
      $('meeting-err').textContent = 'Gagal memulai rapat: ' + err.message;
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-loading');
    }
  }

  async function endMeeting() {
    const btn = $('meeting-end');
    btn.disabled = true;
    try {
      await api('/api/meeting/end', { method: 'POST', body: {} });
      $('meeting-dialog').close();
      toast('Rapat diakhiri, peserta kembali ke posisi semula');
      pollAgents();
    } catch (err) {
      toast('Gagal mengakhiri rapat: ' + err.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  /* ================================================================
   * Kamera: lompat ke ruangan (tween) + ikuti agent
   * ================================================================ */

  function flyTo(pos, target, dur) {
    if (!app.controls) return;
    setFollow(false);
    if (app.reducedMotion || !dur) {
      app.camera.position.set(pos[0], pos[1], pos[2]);
      app.controls.target.set(target[0], target[1], target[2]);
      app.controls.update();
      return;
    }
    app.tween = {
      p0: app.camera.position.clone(), t0: app.controls.target.clone(),
      p1: new THREE.Vector3(pos[0], pos[1], pos[2]), t1: new THREE.Vector3(target[0], target[1], target[2]),
      start: performance.now(), dur: dur
    };
  }

  function flyToRoom(id) {
    if (id === '*') { const v = homeView(); flyTo(v.pos, v.target, 900); return; }
    const room = app.roomById.get(id);
    if (!room) return;
    const dist = Math.max(room.w, room.d) * 1.05 + 7;
    flyTo([room.x + dist * 0.45, dist * 0.95, room.z + dist * 0.8], [room.x, 0.4, room.z], 900);
  }

  function setFollow(on) {
    app.follow = !!on && !!app.selectedId;
    if (app.follow) app.tween = null;
    const btn = $('btn-follow');
    btn.setAttribute('aria-pressed', app.follow ? 'true' : 'false');
    btn.querySelector('span').textContent = app.follow ? 'Mengikuti' : 'Ikuti kamera';
  }

  const _delta = new THREE.Vector3();

  function stepCamera(dt) {
    if (!app.controls) return;
    if (app.tween) {
      const tw = app.tween;
      const k = Math.min(1, (performance.now() - tw.start) / tw.dur);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      app.camera.position.lerpVectors(tw.p0, tw.p1, e);
      app.controls.target.lerpVectors(tw.t0, tw.t1, e);
      if (k >= 1) app.tween = null;
      return;
    }
    if (app.follow && app.selectedId) {
      const rec = app.agentById.get(app.selectedId);
      if (!rec) return;
      const p = rec.group.position;
      _delta.set(p.x, 0.9, p.z).sub(app.controls.target);
      if (_delta.lengthSq() > 900) {
        // Agent jauh dari kamera: dekati dulu dengan jarak orbit nyaman.
        flyTo([p.x + 6.3, 8.6, p.z + 8.1], [p.x, 0.9, p.z], 700);
        app.follow = true;
        return;
      }
      _delta.multiplyScalar(app.reducedMotion ? 1 : 1 - Math.exp(-4 * dt));
      app.controls.target.add(_delta);
      app.camera.position.add(_delta);
    }
  }

  function buildRoomMenu() {
    const menu = $('room-menu');
    menu.textContent = '';
    const all = el('button', null);
    all.type = 'button';
    all.dataset.room = '*';
    all.appendChild(icon('home', 'ic-sm'));
    all.appendChild(document.createTextNode('Seluruh kantor'));
    menu.appendChild(all);
    menu.appendChild(el('hr'));
    app.rooms.forEach(function (room) {
      const b = el('button', null);
      b.type = 'button';
      b.dataset.room = room.id;
      const sw = el('span', 'swatch');
      sw.style.background = room.accent;
      b.appendChild(sw);
      b.appendChild(el('span', null, room.label));
      const n = app.agents.filter(function (a) { return a.room === room.id; }).length;
      const z = app.zoneById.get(room.id);
      const meta = z ? 'santai ' + (zoneLoad(null)[z.id] || 0) + '/' + z.cap : (n ? n + ' agent' : '');
      if (meta) b.appendChild(el('span', 'menu-meta mono', meta));
      menu.appendChild(b);
    });
  }

  function toggleRoomMenu(open) {
    const btn = $('btn-rooms');
    const menu = $('room-menu');
    const show = open === undefined ? menu.hidden : open;
    if (show) buildRoomMenu();
    menu.hidden = !show;
    btn.setAttribute('aria-expanded', show ? 'true' : 'false');
    if (show) menu.querySelector('button').focus();
  }

  /* ================================================================
   * Gelembung status di atas kepala (maks 6, terdekat ke kamera)
   * ================================================================ */
  const MAX_BUBBLES = 6;

  function bubbleSprite(text, state) {
    const font = '600 30px ' + getComputedStyle(document.body).fontFamily;
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = font;
    const words = text.split(/\s+/);
    const lines = [''];
    words.forEach(function (w) {
      const cur = lines[lines.length - 1];
      const next = cur ? cur + ' ' + w : w;
      if (measure.measureText(next).width > 420 && cur) {
        if (lines.length === 2) { lines[1] = lines[1].replace(/\s*\S*$/, '') + '…'; return; }
        lines.push(w);
      } else if (!(lines.length === 2 && lines[1].slice(-1) === '…')) {
        lines[lines.length - 1] = next;
      }
    });
    const textW = Math.max.apply(null, lines.map(function (l) { return measure.measureText(l).width; }));
    const c = document.createElement('canvas');
    c.width = Math.ceil(textW) + 48;
    c.height = lines.length * 40 + 44;
    const ctx = c.getContext('2d');
    const h = c.height - 16;
    ctx.fillStyle = 'rgba(11,17,32,0.92)';
    ctx.strokeStyle = STATE_HEX[state] || '#38bdf8';
    ctx.lineWidth = 4;
    roundRect(ctx, 2, 2, c.width - 4, h - 2, 16);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(c.width / 2 - 12, h - 1);
    ctx.lineTo(c.width / 2, c.height - 2);
    ctx.lineTo(c.width / 2 + 12, h - 1);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#f1f5f9';
    ctx.font = font;
    ctx.textBaseline = 'middle';
    lines.forEach(function (l, i) { ctx.fillText(l, 24, 22 + 20 + i * 40 - 2); });
    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;
    if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    const worldH = 0.2 * (c.height / 52);
    sp.scale.set(worldH * c.width / c.height, worldH, 1);
    return sp;
  }

  function updateBubbles() {
    const cam = app.camera.position;
    const wanted = [];
    if (app.prefs.bubbles) {
      app.agentById.forEach(function (rec) {
        const hl = rec.data && rec.data.headline;
        if (hl && (rec.status === 'working' || rec.status === 'blocked')) {
          wanted.push({ rec: rec, d: rec.group.position.distanceToSquared(cam) });
        }
      });
      wanted.sort(function (a, b) { return a.d - b.d; });
    }
    const keep = new Set(wanted.slice(0, MAX_BUBBLES).map(function (w) { return w.rec; }));
    app.agentById.forEach(function (rec) {
      const show = keep.has(rec);
      if (show) {
        const text = rec.data.headline.slice(0, 90);
        const key = text + '|' + rec.status;
        if (rec.bubbleKey !== key) {
          if (rec.bubble) {
            rec.group.remove(rec.bubble);
            rec.bubble.material.map.dispose();
            rec.bubble.material.dispose();
          }
          rec.bubble = bubbleSprite(text, rec.status);
          rec.bubbleKey = key;
          rec.group.add(rec.bubble);
        }
        rec.bubble.visible = true;
        rec.bubble.position.y = rec.label.position.y + 0.42 + rec.bubble.scale.y / 2 + (rec.exclaim.visible ? 0.5 : 0);
      } else if (rec.bubble) {
        rec.bubble.visible = false;
      }
    });
  }

  /* ================================================================
   * Siang / malam mengikuti jam lokal
   * ================================================================ */
  const C_DAY = new THREE.Color(0xfff4e4);
  const C_DUSK = new THREE.Color(0xffb070);
  const C_NIGHT = new THREE.Color(0x8fa8ff);
  const BG_DAY = new THREE.Color(0x0d1622);
  const BG_NIGHT = new THREE.Color(0x03060d);

  function daylightAt(date) {
    const h = date.getHours() + date.getMinutes() / 60;
    const sun = Math.sin((h - 6) / 12 * Math.PI);          // >0 antara 06:00-18:00
    return { d: Math.max(0, Math.min(1, sun * 1.8 + 0.35)), h: h };
  }

  function applyDaylight() {
    const L = app.lights;
    if (!L) return;
    const live = app.prefs.daynight && !app.reducedMotion;
    const now = daylightAt(new Date());
    const d = live ? now.d : 1;
    const dusk = 1 - Math.abs(d - 0.5) * 2;
    L.hemi.intensity = 0.4 + 0.65 * d;
    L.amb.intensity = 0.12 + 0.1 * d;
    L.key.intensity = 0.3 + 0.85 * d;
    L.key.color.copy(C_NIGHT).lerp(C_DAY, d).lerp(C_DUSK, Math.max(0, dusk) * 0.55);
    const az = live ? (now.h - 12) / 12 * Math.PI : 0.6;
    L.key.position.set(Math.sin(az) * 34, 42, 20 + Math.cos(az) * 8);
    L.fill.intensity = 0.3 + 0.15 * d;
    app.scene.background.copy(BG_NIGHT).lerp(BG_DAY, d);
    app.scene.fog.color.copy(app.scene.background);
    if (MATS.lampShade) MATS.lampShade.emissiveIntensity = 1.1 + 1.8 * (1 - d);
    if (app.renderer) app.renderer.toneMappingExposure = 0.92 + 0.1 * d;
    const btn = $('btn-daynight');
    btn.querySelector('use').setAttribute('href', live && d < 0.5 ? '#i-moon' : '#i-sun');
    btn.title = live ? 'Siang/malam mengikuti jam: ' + (d < 0.5 ? 'malam' : 'siang') + ' (N)'
      : (app.reducedMotion ? 'Siang/malam dimatikan oleh setelan kurangi gerakan' : 'Siang/malam mati, pencahayaan siang tetap (N)');
  }

  function applyPrefsUI() {
    $('btn-bubbles').setAttribute('aria-pressed', app.prefs.bubbles ? 'true' : 'false');
    $('btn-daynight').setAttribute('aria-pressed', app.prefs.daynight ? 'true' : 'false');
    $('btn-feed').setAttribute('aria-pressed', app.prefs.feed ? 'true' : 'false');
    $('feed').classList.toggle('off', !app.prefs.feed);
    $('feed').setAttribute('aria-hidden', app.prefs.feed ? 'false' : 'true');
  }

  function togglePref(key) {
    app.prefs[key] = !app.prefs[key];
    savePrefs();
    applyPrefsUI();
    if (key === 'bubbles' && app.camera) updateBubbles();
    if (key === 'daynight') applyDaylight();
  }

  async function logout() {
    try { await api('/api/logout', { method: 'POST', body: {} }); } catch (e) { /* tetap keluar */ }
    window.location.replace('/login');
  }

  function bindUI() {
    $('panel-close').addEventListener('click', closePanel);
    $('task-form').addEventListener('submit', submitTask);
    $('task-goal').addEventListener('input', function () {
      if (this.value.trim().length >= 5) { this.removeAttribute('aria-invalid'); $('task-goal-err').textContent = ''; }
    });
    $('roster-search').addEventListener('input', function () { renderRoster(app.agents); });
    $('roster-toggle').addEventListener('click', function () {
      const collapsed = $('roster').classList.toggle('collapsed');
      this.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });
    $('btn-follow').addEventListener('click', function () { setFollow(!app.follow); });
    $('btn-assign').addEventListener('click', function () { setTab('dispatch'); $('task-goal').focus(); });
    TABS.forEach(function (t) {
      $('tab-' + t).addEventListener('click', function () { setTab(t); });
    });
    document.querySelector('.tabs').addEventListener('keydown', function (ev) {
      const i = TABS.indexOf(app.panelTab);
      if (ev.key === 'ArrowRight') { ev.preventDefault(); setTab(TABS[(i + 1) % TABS.length], true); }
      if (ev.key === 'ArrowLeft') { ev.preventDefault(); setTab(TABS[(i + TABS.length - 1) % TABS.length], true); }
    });
    $('btn-meeting').addEventListener('click', openMeetingDialog);
    $('meeting-start').addEventListener('click', startMeeting);
    $('meeting-end').addEventListener('click', endMeeting);
    $('btn-rooms').addEventListener('click', function () { toggleRoomMenu(); });
    $('room-menu').addEventListener('click', function (ev) {
      const b = ev.target.closest('button[data-room]');
      if (!b) return;
      toggleRoomMenu(false);
      flyToRoom(b.dataset.room);
      $('btn-rooms').focus();
    });
    $('room-menu').addEventListener('keydown', function (ev) {
      const items = Array.prototype.slice.call(this.querySelectorAll('button'));
      const i = items.indexOf(document.activeElement);
      if (ev.key === 'ArrowDown') { ev.preventDefault(); items[(i + 1) % items.length].focus(); }
      if (ev.key === 'ArrowUp') { ev.preventDefault(); items[(i + items.length - 1) % items.length].focus(); }
      if (ev.key === 'Escape') { ev.stopPropagation(); toggleRoomMenu(false); $('btn-rooms').focus(); }
    });
    document.addEventListener('click', function (ev) {
      if (!$('room-menu').hidden && !ev.target.closest('.menu-wrap')) toggleRoomMenu(false);
    });
    $('btn-bubbles').addEventListener('click', function () { togglePref('bubbles'); });
    $('btn-daynight').addEventListener('click', function () { togglePref('daynight'); });
    $('btn-feed').addEventListener('click', function () { togglePref('feed'); });
    $('btn-logout').addEventListener('click', logout);
    bindEditor();
    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', function (ev) {
      if (editorKey(ev)) return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((ev.target && ev.target.tagName) || '');
      if (ev.key === 'Escape' && !$('meeting-dialog').open) {
        if (!$('room-menu').hidden) toggleRoomMenu(false);
        else closePanel();
      }
      if (typing || ev.ctrlKey || ev.metaKey || ev.altKey || $('meeting-dialog').open) return;
      const k = ev.key.toLowerCase();
      if (k === 'b') togglePref('bubbles');
      else if (k === 'n') togglePref('daynight');
      else if (k === 'f') togglePref('feed');
      else if (k === 'e') openEditor();
    });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) pollAgents(); });
    if (window.matchMedia) {
      window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', function (e) {
        app.reducedMotion = e.matches;
        applyDaylight();
      });
    }
  }

  /* ================================================================
   * Scene bootstrap
   * ================================================================ */
  function initThree() {
    if (typeof THREE === 'undefined') {
      fail('Library Three.js tidak termuat',
        'File /vendor/three.min.js tidak ada dan CDN tidak terjangkau. Jalankan server lokal agar aset vendor tersaji.');
      return false;
    }

    const container = $('canvas-container');
    const w = window.innerWidth;
    const h = window.innerHeight;

    app.scene = new THREE.Scene();
    app.scene.background = new THREE.Color(0x0d1622);
    app.scene.fog = new THREE.Fog(0x0d1622, 95, 210);

    app.camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 500);
    /* Default isometrik: seluruh bangunan (x[-26,26] z[-18,18]) harus muat
       di area layar yang tidak tertutup panel roster kiri. */
    app.camera.position.set(-4, 49.05, 44.16);

    try {
      app.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    } catch (err) {
      fail('WebGL tidak tersedia di peramban ini', 'Aktifkan akselerasi perangkat keras atau buka di peramban lain: ' + err.message);
      return false;
    }
    app.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    app.renderer.setSize(w, h);
    app.renderer.shadowMap.enabled = true;
    app.renderer.shadowMap.type = THREE.PCFShadowMap;
    if (THREE.sRGBEncoding !== undefined) app.renderer.outputEncoding = THREE.sRGBEncoding;
    if (THREE.ACESFilmicToneMapping !== undefined) {
      app.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      app.renderer.toneMappingExposure = 1.02;
    }
    container.appendChild(app.renderer.domElement);

    if (THREE.OrbitControls) {
      app.controls = new THREE.OrbitControls(app.camera, app.renderer.domElement);
      app.controls.enableDamping = true;
      app.controls.dampingFactor = 0.06;
      app.controls.minDistance = 14;
      app.controls.maxDistance = 220;
      app.controls.maxPolarAngle = Math.PI / 2.12;
      app.controls.target.set(-4, 0, 0);
      app.controls.addEventListener('start', function () { app.tween = null; });
    }

    const hemi = new THREE.HemisphereLight(0xd6e9ff, 0x2a3038, 1.05);
    const amb = new THREE.AmbientLight(0xffffff, 0.22);
    app.scene.add(hemi);
    app.scene.add(amb);

    const key = new THREE.DirectionalLight(0xfff4e4, 1.15);
    key.position.set(26, 42, 20);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -34;
    key.shadow.camera.right = 34;
    key.shadow.camera.top = 30;
    key.shadow.camera.bottom = -30;
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 130;
    key.shadow.bias = -0.0006;
    app.scene.add(key);

    const fill = new THREE.DirectionalLight(0x9dc4ff, 0.45);
    fill.position.set(-28, 20, -22);
    app.scene.add(fill);
    app.lights = { hemi: hemi, amb: amb, key: key, fill: fill };

    initMats();
    return true;
  }

  /* ------------------------------------------------------------------
   * Mutu adaptif: kalau perangkat ternyata berat (WebGL software,
   * kartu grafis lemah, layar besar), matikan shadow map + point light
   * supaya kantor tetap bisa dipakai, bukan hanya dipandangi.
   * ------------------------------------------------------------------ */
  function enableLowQuality() {
    if (!app.renderer) return;
    app.renderer.shadowMap.enabled = false;
    app.renderer.setPixelRatio(1);
    /* Render pada resolusi lebih kecil lalu diregangkan oleh CSS:
       biaya fill-rate (pembatas utama di WebGL software) turun ~3x
       tanpa mengubah geometri scene. */
    const w = window.innerWidth;
    const h = window.innerHeight;
    app.renderer.setSize(Math.max(320, Math.round(w * 0.6)), Math.max(200, Math.round(h * 0.6)), false);
    app.scene.traverse(function (o) {
      if (o.isPointLight) o.visible = false;
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach(function (m) { m.needsUpdate = true; });
      }
    });
    app.lowQuality = true;
  }

  /* Dinding luar yang menghadap kamera dipotong (cutaway) supaya interior
     tetap terlihat. Sisi yang menjauh tetap solid penuh. */
  function updateCutaway() {
    if (!app.camera) return;
    const cam = app.camera.position;
    app.perimeterWalls.forEach(function (w) {
      const dx = cam.x - w.center.x;
      const dz = cam.z - w.center.z;
      const facing = (w.nx * dx + w.nz * dz) > 0.5;
      if (facing === w.cut) return;
      w.cut = facing;
      w.high.visible = !facing;
      w.cap.visible = !facing;
    });
  }

  /* ================================================================
   * Interaksi 3D
   * ================================================================ */
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let downAt = null;

  function pickAgent(clientX, clientY) {
    if (!app.renderer) return null;
    pointer.x = (clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, app.camera);
    const targets = [];
    app.agentById.forEach(function (rec) { targets.push(rec.group); });
    app.deskById.forEach(function (g) { targets.push(g); });
    const hits = raycaster.intersectObjects(targets, true);
    if (!hits.length) return null;
    let node = hits[0].object;
    while (node && !node.userData.agentId) node = node.parent;
    return node ? node.userData.agentId : null;
  }

  function bindPointer() {
    const canvas = app.renderer.domElement;

    canvas.addEventListener('pointerdown', function (ev) {
      if (ED.on && ev.button !== 0) return;          // kanan/tengah = kamera
      downAt = { x: ev.clientX, y: ev.clientY };
      if (ED.on) editorPointerDown(ev);
    });

    canvas.addEventListener('pointerup', function (ev) {
      if (!downAt) return;
      const moved = Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y);
      downAt = null;
      if (ED.on) { editorPointerUp(ev, moved <= 6); return; }
      if (moved > 6) return;
      const id = pickAgent(ev.clientX, ev.clientY);
      if (id) selectAgent(id, false);
    });

    let hoverTick = 0;
    canvas.addEventListener('pointermove', function (ev) {
      if (ED.on) { editorPointerMove(ev); return; }
      const now = performance.now();
      if (now - hoverTick < 70) return;
      hoverTick = now;
      const id = pickAgent(ev.clientX, ev.clientY);
      if (id === app.hoveredId) return;
      app.hoveredId = id;
      canvas.style.cursor = id ? 'pointer' : 'grab';
      app.agentById.forEach(function (rec) {
        const isHover = rec.id === id;
        rec.group.scale.setScalar(isHover ? 1.05 : 1);
        rec.label.material.opacity = (isHover || rec.id === app.selectedId) ? 1 : 0.92;
      });
    });
  }

  /* ================================================================
   * Animasi
   * ================================================================ */
  function animate(now) {
    requestAnimationFrame(animate);
    const ts = (now || performance.now()) / 1000;
    /* Cap dt at 0.9s: agent tidak pernah melewati waypoint (langkah
       dibatasi jarak ke waypoint), jadi frame lambat hanya memperlambat
       waktu, tidak membuat agent menembus dinding. */
    const dt = app.lastFrame ? Math.min(0.9, ts - app.lastFrame) : 0.016;
    app.lastFrame = ts;
    app.clock = ts;

    app.agentById.forEach(function (rec) { updateAgent(rec, dt, ts); });
    stepCamera(dt);

    app.bubbleTick += dt;
    if (app.bubbleTick > 0.4) {
      app.bubbleTick = 0;
      updateBubbles();
    }
    app.lightTick += dt;
    if (app.lightTick > 15) {
      app.lightTick = 0;
      applyDaylight();
    }

    app.cutawayTick += dt;
    if (app.cutawayTick > 0.2) {
      app.cutawayTick = 0;
      updateCutaway();
    }

    checkQuality(ts);

    if (app.controls) app.controls.update();
    if (ED.on) placeEdTools();
    app.renderer.render(app.scene, app.camera);
  }

  /* Ukur FPS 3 detik pertama; kalau rendah, turunkan mutu render. */
  let qualityFrames = 0;
  let qualityStart = 0;
  function checkQuality(ts) {
    if (app.qualityChecked) return;
    if (!qualityStart) { qualityStart = ts; return; }
    qualityFrames += 1;
    const elapsed = ts - qualityStart;
    if (elapsed < 3) return;
    app.qualityChecked = true;
    app.fps = qualityFrames / elapsed;
    if (app.fps < 18) enableLowQuality();
  }

  function onResize() {
    if (!app.renderer) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    app.camera.aspect = w / h;
    app.camera.updateProjectionMatrix();
    app.renderer.setSize(w, h);
  }

  /* ================================================================
   * Editor denah: perabot, ruangan, penempatan departemen.
   * Draft disimpan di ED.doc; server memvalidasi ulang saat simpan.
   * ================================================================ */
  const ED = {
    on: false, doc: null, catalog: {}, kinds: {}, rules: null, max: 120, maxRooms: 64, dirty: false,
    placing: null, ghost: null, ghostDeg: 0, ghostOk: false, rdraw: null, rotFrom: null,
    selected: null, drag: null, group: null, saving: false,
    selRoom: null, rdrag: null, overlay: null, handles: [], undo: [], last: '', previewed: false
  };
  const DEG = Math.PI / 180;
  const _ray = new THREE.Raycaster();
  const _floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const _hit = new THREE.Vector3();
  const _ndc = new THREE.Vector2();

  function floorPoint(cx, cy) {
    const r = app.renderer.domElement.getBoundingClientRect();
    _ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    _ray.setFromCamera(_ndc, app.camera);
    if (!_ray.ray.intersectPlane(_floor, _hit)) return null;
    // Snap 0.25 m supaya perabot rapi segaris.
    return { x: Math.round(_hit.x * 4) / 4, z: Math.round(_hit.z * 4) / 4 };
  }

  function propRect(p) {
    const t = app.propTypes[p.type] || [1, 1, true];
    // Cermin prop_rect() server: AABB persegi yang diputar.
    const a = (p.deg || 0) * Math.PI / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    const w = t[0] * c + t[1] * s, d = t[0] * s + t[1] * c;
    return [p.x - w / 2, p.x + w / 2, p.z - d / 2, p.z + d / 2];
  }

  function rectHit(a, b, pad) {
    pad = pad || 0;
    return a[0] < b[1] + pad && a[1] > b[0] - pad && a[2] < b[3] + pad && a[3] > b[2] - pad;
  }

  /* Cermin prop_issue() di server: alasan ditolak, atau '' kalau aman. */
  function propIssue(p) {
    const r = propRect(p);
    const PAD = 0.3, M = 0.3;
    const room = app.rooms.find(function (c) {
      return r[0] >= c.x - c.w / 2 + PAD && r[1] <= c.x + c.w / 2 - PAD &&
        r[2] >= c.z - c.d / 2 + PAD && r[3] <= c.z + c.d / 2 - PAD;
    });
    if (!room) return 'harus utuh di dalam satu ruangan (jauhi dinding)';
    if (room.kind === 'meeting') return 'ruang rapat dikunci: kursinya dipakai agent saat rapat';
    const label = room.label;
    if (!app.propTypes[p.type][2]) return '';
    const g = [r[0] - M, r[1] + M, r[2] - M, r[3] + M];
    const desks = room.desks || [];
    for (let i = 0; i < desks.length; i += 1) {
      const d = desks[i];
      const turned = Math.abs(Math.sin(d.rot)) > 0.5;
      const dw = turned ? d.d : d.w, dd = turned ? d.w : d.d;
      const cr = Math.max(d.cw, d.cd) / 2;
      if (rectHit(g, [d.x - dw / 2, d.x + dw / 2, d.z - dd / 2, d.z + dd / 2]) ||
          rectHit(g, [d.chair[0] - cr, d.chair[0] + cr, d.chair[1] - cr, d.chair[1] + cr])) {
        return 'menutupi meja atau kursi agent di ' + label;
      }
      if (segHitsBox(d.stand[0], d.stand[1], d.chair[0], d.chair[1], g, 0)) return 'menghalangi jalur agent ke kursinya';
      if (room.aisle && segHitsBox(room.aisle.x, room.aisle.z, d.stand[0], d.stand[1], g, 0)) return 'menghalangi lorong meja';
    }
    if (room.door && rectHit(g, [room.door.x - 1.2, room.door.x + 1.2, room.door.z - 1.2, room.door.z + 1.2])) {
      return 'menghalangi pintu ' + label;
    }
    const ht = app.hotDesk && app.hotDesk.table;
    if (ht && room.id === app.hotDesk.room && rectHit(g, [ht.x0 - 1.5, ht.x1 + 1.5, ht.z0, ht.z1])) return 'menimpa meja baca hot desk';
    const others = ED.doc ? ED.doc.props : [];
    for (let i = 0; i < others.length; i += 1) {
      const q = others[i];
      if (q.id !== p.id && app.propTypes[q.type][2] && rectHit(r, propRect(q), 0.05)) return 'menimpa perabot lain';
    }
    return '';
  }

  function edStatus(text, kind) {
    const n = $('ed-status');
    n.textContent = text || '';
    n.className = 'ed-status' + (kind ? ' ' + kind : '');
  }

  /* Panggil SETELAH dokumen berubah: keadaan sebelumnya (ED.last) masuk
     tumpukan urungkan. */
  function markDirty() {
    ED.dirty = true;
    $('ed-err').textContent = '';
    if (ED.last) ED.undo.push(ED.last);
    if (ED.undo.length > 60) ED.undo.shift();
    ED.last = JSON.stringify(ED.doc);
    $('ed-undo').disabled = !ED.undo.length;
  }

  function tintGroup(g, color) {
    g.traverse(function (o) {
      if (!o.isMesh) return;
      if (!o.userData.ghostMat) {
        o.userData.ghostMat = o.material.clone();
        o.userData.ghostMat.transparent = true;
        o.userData.ghostMat.opacity = 0.7;
        o.material = o.userData.ghostMat;
      }
      if (o.material.emissive) {
        o.material.emissive.setHex(color);
        o.material.emissiveIntensity = 0.55;
      }
    });
  }

  function renderDraftProps() {
    if (ED.group) app.scene.remove(ED.group);
    ED.group = new THREE.Group();
    ED.doc.props.forEach(function (p) {
      const g = buildProp({ id: p.id, type: p.type, x: p.x, z: p.z, rot: (p.deg || 0) * DEG });
      if (ED.selected === p.id) {
        const t = app.propTypes[p.type] || [1, 1];
        const bad = !!propIssue(p);
        const ring = new THREE.Mesh(new THREE.PlaneGeometry(t[0] + 0.2, t[1] + 0.2),
          new THREE.MeshBasicMaterial({ color: bad ? 0xef4444 : 0x38bdf8, transparent: true, opacity: 0.35, depthWrite: false }));
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.03;
        g.add(ring);
      }
      ED.group.add(g);
    });
    app.scene.add(ED.group);
    $('ed-prop-count').textContent = ED.doc.props.length + '/' + ED.max;
  }

  function renderPalette() {
    const box = $('ed-palette');
    box.textContent = '';
    Object.keys(ED.catalog).forEach(function (type) {
      const c = ED.catalog[type];
      const b = el('button');
      b.type = 'button';
      b.dataset.type = type;
      b.setAttribute('aria-pressed', ED.placing === type ? 'true' : 'false');
      b.appendChild(el('span', null, c.label));
      b.appendChild(el('span', 'sz', c.w + ' × ' + c.d + ' m'));
      b.addEventListener('click', function () {
        if (ED.placing === type) stopPlacing(); else startPlacing(type);
      });
      box.appendChild(b);
    });
  }

  function startPlacing(type) {
    stopPlacing();
    selectProp(null);
    if (ED.doc.props.length >= ED.max) { edStatus('Batas ' + ED.max + ' perabot tercapai.', 'bad'); return; }
    ED.placing = type;
    ED.ghost = buildProp({ type: type, x: 0, z: 0, rot: ED.ghostDeg * DEG });
    ED.ghost.visible = false;
    tintGroup(ED.ghost, 0x22c55e);
    app.scene.add(ED.ghost);
    renderPalette();
    edStatus('Klik lantai untuk menaruh ' + ED.catalog[type].label + '. R / Shift+R memutar, Esc berhenti.');
  }

  function stopPlacing() {
    if (ED.ghost) app.scene.remove(ED.ghost);
    ED.ghost = null;
    if (ED.placing) { ED.placing = null; renderPalette(); edStatus(''); }
  }

  function moveGhost(pt) {
    if (!ED.ghost || !pt) return;
    const p = { id: '', type: ED.placing, x: pt.x, z: pt.z, deg: ED.ghostDeg };
    const why = propIssue(p);
    ED.ghost.visible = true;
    ED.ghost.position.set(pt.x, 0, pt.z);
    ED.ghost.rotation.y = ED.ghostDeg * DEG;
    ED.ghostOk = !why;
    ED.ghostAt = pt;
    tintGroup(ED.ghost, why ? 0xef4444 : 0x22c55e);
    edStatus(why ? 'Tidak bisa di sini: ' + why + '.' : 'Klik untuk menaruh.', why ? 'bad' : 'ok');
  }

  function newPropId() {
    return 'p-' + Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  }

  function placeGhost() {
    if (!ED.ghostOk || !ED.ghostAt) return;
    ED.doc.props.push({ id: newPropId(), type: ED.placing, x: ED.ghostAt.x, z: ED.ghostAt.z, deg: ED.ghostDeg });
    markDirty();
    renderDraftProps();
    if (ED.doc.props.length >= ED.max) stopPlacing();
  }

  function propById(id) {
    return ED.doc.props.find(function (p) { return p.id === id; }) || null;
  }

  function selectProp(id) {
    ED.selected = id;
    ED.rotFrom = null;
    const p = id ? propById(id) : null;
    if (p) {
      if (ED.selRoom) { ED.selRoom = null; renderRoomSelect(); renderRoomOverlay(); }
      $('ed-tools-name').textContent = ED.catalog[p.type].label;
      syncAngle(p);
    }
    $('ed-tools').hidden = !p;
    if (p) {
      ED.toolsW = $('ed-tools').offsetWidth;
      ED.toolsH = $('ed-tools').offsetHeight;
      ED.panelLeft = $('editor').getBoundingClientRect().left;
    }
    if (ED.group) renderDraftProps();
  }

  function normDeg(v) { return Math.round((((v % 360) + 360) % 360) * 10) / 10 % 360; }

  function syncAngle(p) {
    const d = Math.round(p.deg || 0) % 360;
    $('ed-angle').value = d;
    $('ed-angle-val').textContent = d + '°';
  }

  /* Toolbar mengikuti perabot terpilih di layar (dipanggil tiap frame). */
  function placeEdTools() {
    const bar = $('ed-tools');
    const p = ED.selected && propById(ED.selected);
    if (!p || bar.hidden) return;
    const v = new THREE.Vector3(p.x, 1.4, p.z).project(app.camera);
    const off = v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1;
    bar.style.visibility = off ? 'hidden' : '';
    if (off) return;
    // Ukuran dicache saat dipilih; posisi lewat transform supaya tidak
    // memicu reflow tiap frame. Jangan sampai tertutup panel editor.
    const W = ED.toolsW, H = ED.toolsH;
    const vw = window.innerWidth, vh = window.innerHeight;
    const right = ED.panelLeft > vw / 2 ? ED.panelLeft - 8 : vw - 8;
    const x = Math.min(right - W, Math.max(8, (v.x + 1) / 2 * vw - W / 2));
    const y = Math.max(8, (1 - v.y) / 2 * vh - H - 12);
    bar.style.transform = 'translate(' + Math.round(x) + 'px, ' + Math.round(y) + 'px)';
  }

  /* Putar perabot terpilih (atau hantu yang sedang ditaruh) ke sudut deg.
     commit=false: pratinjau saat slider digeser; true: terapkan / batalkan. */
  function setAngle(deg, commit) {
    deg = normDeg(deg);
    if (ED.placing) {
      ED.ghostDeg = deg;
      if (ED.ghost) { ED.ghost.rotation.y = deg * DEG; moveGhost(ED.ghostAt); }
      return;
    }
    const p = ED.selected && propById(ED.selected);
    if (!p) return;
    if (ED.rotFrom === null) ED.rotFrom = p.deg || 0;
    p.deg = deg;
    const why = propIssue(p);
    if (commit) {
      if (why) {
        p.deg = ED.rotFrom;
        edStatus('Tidak bisa diputar: ' + why + '.', 'bad');
      } else if (p.deg !== ED.rotFrom) {
        markDirty();
        edStatus('Diputar ke ' + p.deg + '°.', 'ok');
      }
      ED.rotFrom = null;
      syncAngle(p);
    } else {
      $('ed-angle-val').textContent = Math.round(deg) + '°';
      edStatus(why ? 'Tidak bisa: ' + why + '.' : 'Lepas untuk menerapkan ' + Math.round(deg) + '°.', why ? 'bad' : 'ok');
    }
    renderDraftProps();
  }

  /* Langkah 90 derajat; sudut miring dulu diluruskan ke kelipatan 90. */
  function rotateSelected(step) {
    step = step || 90;
    const cur = ED.placing ? ED.ghostDeg : ((ED.selected && (propById(ED.selected) || {}).deg) || 0);
    const next = cur % 90 ? (step > 0 ? Math.ceil(cur / 90) : Math.floor(cur / 90)) * 90 : cur + step;
    setAngle(next, true);
  }

  /* Salinan di petak bebas terdekat (cincin makin jauh dari aslinya). */
  function duplicateSelected() {
    const p = ED.selected && propById(ED.selected);
    if (!p) return;
    if (ED.doc.props.length >= ED.max) { edStatus('Batas ' + ED.max + ' perabot tercapai.', 'bad'); return; }
    // ponytail: cincin 0,5 m sampai 8 m (maks ~800 cek propIssue), cukup cepat untuk satu klik
    for (let k = 1; k <= 16; k += 1) {
      for (let a = 0; a < 8 * k; a += 1) {
        const ang = a * 2 * Math.PI / (8 * k);
        const q = { id: newPropId(), type: p.type, deg: p.deg || 0,
          x: Math.round((p.x + Math.cos(ang) * k * 0.5) * 4) / 4, z: Math.round((p.z + Math.sin(ang) * k * 0.5) * 4) / 4 };
        if (!propIssue(q)) {
          ED.doc.props.push(q);
          markDirty();
          selectProp(q.id);
          edStatus('Diduplikat. Seret salinannya ke tempat lain.', 'ok');
          return;
        }
      }
    }
    edStatus('Tidak ada tempat kosong di dekatnya untuk salinan.', 'bad');
  }

  function deleteSelected() {
    if (!ED.selected) return;
    ED.doc.props = ED.doc.props.filter(function (p) { return p.id !== ED.selected; });
    selectProp(null);
    markDirty();
    renderDraftProps();
    edStatus('Perabot dihapus.');
  }

  function pickDraftProp(cx, cy) {
    if (!ED.group) return null;
    const r = app.renderer.domElement.getBoundingClientRect();
    _ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    _ray.setFromCamera(_ndc, app.camera);
    const hits = _ray.intersectObjects(ED.group.children, true);
    for (let i = 0; i < hits.length; i += 1) {
      let o = hits[i].object;
      while (o && !o.userData.propId) o = o.parent;
      if (o) return o.userData.propId;
    }
    return null;
  }

  function editorPointerDown(ev) {
    if (ED.placing) return;
    const side = pickHandle(ev.clientX, ev.clientY);
    const pt = floorPoint(ev.clientX, ev.clientY);
    const id = side ? null : pickDraftProp(ev.clientX, ev.clientY);
    if (id) {
      const p = propById(id);
      ED.drag = { id: id, x: p.x, z: p.z, moved: false };
      if (app.controls) app.controls.enabled = false;
      selectProp(id);
      return;
    }
    if (!pt) return;
    const room = side ? roomById(ED.selRoom) : roomAt(pt);
    if (!room) {
      // lantai kosong: tarik untuk menggambar ruangan baru
      ED.rdraw = { at: { x: snapGrid(pt.x), z: snapGrid(pt.z) }, draft: null, why: '', moved: false };
      selectProp(null);
      if (ED.selRoom) selectRoom(null);
      return;
    }
    if (room.id !== ED.selRoom) { selectProp(null); selectRoom(room.id); }
    ED.rdrag = { id: room.id, mode: side || 'move', at: pt, start: Object.assign({}, room), draft: room, why: '', moved: false };
    if (app.controls) app.controls.enabled = false;
  }

  /* Draf ruangan baru dari titik awal tarikan sampai pointer. */
  function drawDraft(draw, pt) {
    const a = draw.at, bx = snapGrid(pt.x), bz = snapGrid(pt.z);
    const x0 = Math.min(a.x, bx), x1 = Math.max(a.x, bx), z0 = Math.min(a.z, bz), z1 = Math.max(a.z, bz);
    return { id: '', label: 'Ruangan baru', kind: 'empty', x: (x0 + x1) / 2, z: (z0 + z1) / 2, w: x1 - x0, d: z1 - z0 };
  }

  function editorPointerMove(ev) {
    if (ED.placing) { moveGhost(floorPoint(ev.clientX, ev.clientY)); return; }
    if (ED.rdraw) {
      const pt = floorPoint(ev.clientX, ev.clientY);
      if (!pt) return;
      const draft = drawDraft(ED.rdraw, pt);
      const d = ED.rdraw.draft;
      if (d ? (draft.x === d.x && draft.z === d.z && draft.w === d.w && draft.d === d.d) : (!draft.w && !draft.d)) return;
      ED.rdraw.draft = draft;
      ED.rdraw.moved = true;
      ED.rdraw.why = ED.doc.rooms.length >= ED.maxRooms ? 'batas ' + ED.maxRooms + ' ruangan tercapai' : roomIssue(draft);
      edStatus(draft.w + ' × ' + draft.d + ' m. ' + (ED.rdraw.why ? 'Belum bisa: ' + ED.rdraw.why + '.' : 'Lepas untuk membuat ruangan.'),
        ED.rdraw.why ? 'bad' : 'ok');
      renderRoomOverlay();
      return;
    }
    if (ED.rdrag) {
      const pt = floorPoint(ev.clientX, ev.clientY);
      if (!pt) return;
      const draft = dragDraft(ED.rdrag, pt);
      const d = ED.rdrag.draft;
      if (draft.x === d.x && draft.z === d.z && draft.w === d.w && draft.d === d.d) return;
      ED.rdrag.draft = draft;
      ED.rdrag.moved = true;
      ED.rdrag.why = roomIssue(draft);
      edStatus(ED.rdrag.why ? 'Tidak bisa: ' + ED.rdrag.why + '.' : draft.w + ' × ' + draft.d + ' m. Lepas untuk menerapkan.',
        ED.rdrag.why ? 'bad' : 'ok');
      renderRoomOverlay();
      return;
    }
    if (!ED.drag) {
      const side = pickHandle(ev.clientX, ev.clientY);
      app.renderer.domElement.style.cursor = side ? (side === 'e' || side === 'w' ? 'ew-resize' : 'ns-resize')
        : (pickDraftProp(ev.clientX, ev.clientY) || roomAt(floorPoint(ev.clientX, ev.clientY)) ? 'move' : 'crosshair');
      return;
    }
    const pt = floorPoint(ev.clientX, ev.clientY);
    const p = propById(ED.drag.id);
    if (!pt || !p || (pt.x === p.x && pt.z === p.z)) return;
    p.x = pt.x;
    p.z = pt.z;
    ED.drag.moved = true;
    const why = propIssue(p);
    edStatus(why ? 'Tidak bisa di sini: ' + why + '.' : 'Lepas untuk memindah.', why ? 'bad' : 'ok');
    renderDraftProps();
  }

  function editorPointerUp(ev, click) {
    if (ED.rdraw) {
      const draw = ED.rdraw;
      ED.rdraw = null;
      renderRoomOverlay();
      if (draw.moved) {
        if (draw.why) edStatus('Ruangan tidak dibuat: ' + draw.why + '.', 'bad');
        else addRoom(draw.draft);
        return;
      }
    }
    if (ED.rdrag) {
      const drag = ED.rdrag;
      ED.rdrag = null;
      if (app.controls) app.controls.enabled = true;
      if (drag.moved && drag.why) {
        edStatus('Dikembalikan: ' + drag.why + '.', 'bad');
      } else if (drag.moved) {
        applyRoomDrag(drag);
        markDirty();
        renderDraftProps();
        renderRoomForm();
        schedulePreview();
        edStatus('Ruangan diperbarui. Membangun ulang denah…');
      }
      renderRoomOverlay();
      if (drag.moved) return;
    }
    if (ED.drag) {
      const p = propById(ED.drag.id);
      if (app.controls) app.controls.enabled = true;
      if (p && ED.drag.moved) {
        const why = propIssue(p);
        if (why) {
          p.x = ED.drag.x;
          p.z = ED.drag.z;
          edStatus('Dikembalikan: ' + why + '.', 'bad');
        } else {
          markDirty();
          edStatus('Perabot dipindah.', 'ok');
        }
      }
      ED.drag = null;
      renderDraftProps();
      return;
    }
    if (!click) return;
    if (ED.placing) { placeGhost(); return; }
    const id = pickDraftProp(ev.clientX, ev.clientY);
    selectProp(id);
    if (!id) {
      const room = roomAt(floorPoint(ev.clientX, ev.clientY));
      selectRoom(room ? room.id : null);
    }
  }

  /* ================================================================
   * Editor ruangan: pilih, seret (pindah), pegangan sisi (ukuran),
   * form (nama, jenis, pintu, warna, dekor), tambah/hapus, urungkan.
   * Tiap perubahan ruangan divalidasi + dibangun server (preview) lalu
   * dunia 3D dibangun ulang dari hasilnya; gagal -> perubahan dibatalkan.
   * ================================================================ */
  const ROOM_GRID = 0.5;
  const SIDE_DIR = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };

  function snapGrid(v) { return Math.round(v / ROOM_GRID) * ROOM_GRID; }

  function roomById(id) {
    return (ED.doc.rooms || []).find(function (r) { return r.id === id; }) || null;
  }

  function roomRect(r) { return [r.x - r.w / 2, r.x + r.w / 2, r.z - r.d / 2, r.z + r.d / 2]; }

  /* Cermin sebagian room_issue() server, untuk warna merah saat diseret. */
  function roomIssue(r) {
    const rules = ED.rules;
    if (r.w < rules.room_min || r.d < rules.room_min) return 'sisi minimal ' + rules.room_min + ' m';
    if (r.w > rules.room_max || r.d > rules.room_max) return 'sisi maksimal ' + rules.room_max + ' m';
    if (r.kind === 'meeting' && (r.w < rules.meeting_min[0] || r.d < rules.meeting_min[1])) {
      return 'ruang rapat minimal ' + rules.meeting_min[0] + ' × ' + rules.meeting_min[1] + ' m';
    }
    const a = roomRect(r);
    const hit = ED.doc.rooms.find(function (o) { return o.id !== r.id && rectHit(a, roomRect(o), -0.01); });
    return hit ? 'menimpa ' + hit.label : '';
  }

  function roomAt(pt) {
    if (!pt) return null;
    return ED.doc.rooms.find(function (r) {
      return Math.abs(pt.x - r.x) < r.w / 2 && Math.abs(pt.z - r.z) < r.d / 2;
    }) || null;
  }

  function renderRoomOverlay() {
    if (ED.overlay) app.scene.remove(ED.overlay);
    const g = new THREE.Group();
    ED.handles = [];
    const drag = ED.rdrag;
    ED.doc.rooms.forEach(function (room) {
      const r = drag && drag.id === room.id ? drag.draft : room;
      const bad = drag && drag.id === room.id && drag.why;
      const sel = room.id === ED.selRoom;
      const color = bad ? 0xef4444 : (sel ? 0x38bdf8 : new THREE.Color(room.accent).getHex());
      const y = 0.06;
      const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(function (c) {
        return new THREE.Vector3(r.x + c[0] * r.w / 2, y, r.z + c[1] * r.d / 2);
      });
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: sel ? 1 : 0.55 })));
      if (!sel) return;
      const fill = new THREE.Mesh(new THREE.PlaneGeometry(r.w, r.d),
        new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.14, depthWrite: false }));
      fill.rotation.x = -Math.PI / 2;
      fill.position.set(r.x, y, r.z);
      g.add(fill);
      Object.keys(SIDE_DIR).forEach(function (side) {
        const d = SIDE_DIR[side];
        const h = new THREE.Mesh(new THREE.BoxGeometry(d[0] ? 0.35 : 1.4, 0.3, d[0] ? 1.4 : 0.35),
          new THREE.MeshBasicMaterial({ color: bad ? 0xef4444 : 0x38bdf8 }));
        h.position.set(r.x + d[0] * r.w / 2, 0.15, r.z + d[1] * r.d / 2);
        h.userData.side = side;
        g.add(h);
        ED.handles.push(h);
      });
    });
    const nr = ED.rdraw && ED.rdraw.draft;
    if (nr && nr.w && nr.d) {
      const col = ED.rdraw.why ? 0xef4444 : 0x22c55e;
      const fill = new THREE.Mesh(new THREE.PlaneGeometry(nr.w, nr.d),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.22, depthWrite: false }));
      fill.rotation.x = -Math.PI / 2;
      fill.position.set(nr.x, 0.07, nr.z);
      g.add(fill);
      const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(function (c) {
        return new THREE.Vector3(nr.x + c[0] * nr.w / 2, 0.08, nr.z + c[1] * nr.d / 2);
      });
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: col })));
    }
    ED.overlay = g;
    app.scene.add(g);
    $('ed-room-count').textContent = ED.doc.rooms.length + '/' + ED.maxRooms;
  }

  function pickHandle(cx, cy) {
    if (!ED.handles || !ED.handles.length) return null;
    const r = app.renderer.domElement.getBoundingClientRect();
    _ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    _ray.setFromCamera(_ndc, app.camera);
    const hits = _ray.intersectObjects(ED.handles, false);
    return hits.length ? hits[0].object.userData.side : null;
  }

  function selectRoom(id) {
    ED.selRoom = id && roomById(id) ? id : null;
    renderRoomSelect();
    renderRoomOverlay();
  }

  /* Draf ruangan dari posisi pointer selama diseret (snap ke grid). */
  function dragDraft(drag, pt) {
    const s = drag.start;
    let x0 = s.x - s.w / 2, x1 = s.x + s.w / 2, z0 = s.z - s.d / 2, z1 = s.z + s.d / 2;
    const min = ED.rules.room_min;
    if (drag.mode === 'move') {
      const nx0 = snapGrid(x0 + pt.x - drag.at.x), nz0 = snapGrid(z0 + pt.z - drag.at.z);
      x1 += nx0 - x0; z1 += nz0 - z0; x0 = nx0; z0 = nz0;
    } else if (drag.mode === 'e') x1 = Math.max(x0 + min, snapGrid(pt.x));
    else if (drag.mode === 'w') x0 = Math.min(x1 - min, snapGrid(pt.x));
    else if (drag.mode === 's') z1 = Math.max(z0 + min, snapGrid(pt.z));
    else if (drag.mode === 'n') z0 = Math.min(z1 - min, snapGrid(pt.z));
    return Object.assign({}, s, { x: (x0 + x1) / 2, z: (z0 + z1) / 2, w: x1 - x0, d: z1 - z0 });
  }

  function applyRoomDrag(drag) {
    const room = roomById(drag.id);
    const d = drag.draft;
    if (drag.mode === 'move') {
      // perabot di dalam ruangan ikut pindah
      const old = roomRect(room);
      ED.doc.props.forEach(function (p) {
        const r = propRect(p);
        if (r[0] >= old[0] && r[1] <= old[1] && r[2] >= old[2] && r[3] <= old[3]) {
          p.x += d.x - room.x;
          p.z += d.z - room.z;
        }
      });
    }
    room.x = d.x; room.z = d.z; room.w = d.w; room.d = d.d;
  }

  function renderRoomSelect() {
    const sel = $('ed-room');
    sel.textContent = '';
    const none = el('option', null, '— pilih ruangan —');
    none.value = '';
    sel.appendChild(none);
    ED.doc.rooms.forEach(function (r) {
      const o = el('option', null, r.label);
      o.value = r.id;
      sel.appendChild(o);
    });
    sel.value = ED.selRoom || '';
    renderRoomForm();
  }

  function renderRoomForm() {
    const room = ED.selRoom && roomById(ED.selRoom);
    $('ed-room-form').hidden = !room;
    if (!room) return;
    $('ed-room-label').value = room.label;
    $('ed-room-kind').value = room.kind;
    $('ed-room-door').value = room.door ? room.door.side : 'south';
    $('ed-room-door').disabled = room.kind === 'lounge';
    $('ed-room-accent').value = room.accent;
    $('ed-room-decor').disabled = room.kind === 'meeting';
    $('ed-room-decor').checked = room.decor !== 'none';
    $('ed-room-size').textContent = room.w + ' × ' + room.d + ' m';
  }

  function renderKindSelect() {
    const sel = $('ed-room-kind');
    sel.textContent = '';
    Object.keys(ED.kinds).forEach(function (k) {
      const o = el('option', null, ED.kinds[k]);
      o.value = k;
      sel.appendChild(o);
    });
  }

  function updateRoomCfg() {
    const room = roomById(ED.selRoom);
    if (!room) return;
    room.label = $('ed-room-label').value.trim() || room.label;
    const kind = $('ed-room-kind').value;
    if (kind !== room.kind) {
      room.kind = kind;
      room.desks = null;                       // susunan meja otomatis untuk jenis baru
      if (kind !== 'department' && kind !== 'executive') room.dept = '';
    }
    room.door = kind === 'lounge' ? null : {
      side: $('ed-room-door').value,
      at: room.door && room.door.side === $('ed-room-door').value ? room.door.at : 0
    };
    room.accent = $('ed-room-accent').value;
    room.decor = $('ed-room-decor').checked ? 'default' : 'none';
    markDirty();
    renderRoomSelect();
    schedulePreview();
  }

  /* Ruangan baru dari kotak yang digambar. Pintu menghadap pusat gedung
     dan tidak menempel ke ruangan lain. */
  function addRoom(rect) {
    const n = ED.doc.rooms.length || 1;
    const cx = ED.doc.rooms.reduce(function (t, r) { return t + r.x; }, 0) / n;
    const cz = ED.doc.rooms.reduce(function (t, r) { return t + r.z; }, 0) / n;
    const dirs = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
    const facing = function (sd) { return dirs[sd][0] * (rect.x - cx) + dirs[sd][1] * (rect.z - cz); };
    const half = (ED.rules.door_width || 1.9) / 2;
    const side = Object.keys(dirs).sort(function (a, b) { return facing(a) - facing(b); }).find(function (sd) {
      // cermin room_issue() server: 0.5-1.1 m di depan pintu harus kosong
      const v = dirs[sd];
      const ox = rect.x + v[0] * (rect.w / 2 + 0.8), oz = rect.z + v[1] * (rect.d / 2 + 0.8);
      const box = v[1] ? [ox - half, ox + half, oz - 0.3, oz + 0.3] : [ox - 0.3, ox + 0.3, oz - half, oz + half];
      return !ED.doc.rooms.some(function (o) { return rectHit(box, roomRect(o)); });
    }) || 'west';
    const room = {
      id: 'r-' + Math.random().toString(36).slice(2, 8), label: 'Ruangan baru', kind: 'empty', style: '', dept: '',
      x: rect.x, z: rect.z, w: rect.w, d: rect.d, accent: '#64748b',
      decor: 'default', door: { side: side, at: 0 }, desks: null
    };
    ED.doc.rooms.push(room);
    markDirty();
    selectProp(null);
    selectRoom(room.id);
    schedulePreview();
    edStatus('Ruangan baru ' + rect.w + ' × ' + rect.d + ' m dibuat. Atur nama dan jenisnya di panel.', 'ok');
  }

  function deleteRoom() {
    const room = roomById(ED.selRoom);
    if (!room) return;
    if (room.kind === 'meeting' && ED.doc.rooms.filter(function (r) { return r.kind === 'meeting'; }).length < 2) {
      edStatus('Ruang rapat terakhir tidak bisa dihapus.', 'bad');
      return;
    }
    const rect = roomRect(room);
    ED.doc.props = ED.doc.props.filter(function (p) {
      const r = propRect(p);
      return !(r[0] >= rect[0] && r[1] <= rect[1] && r[2] >= rect[2] && r[3] <= rect[3]);
    });
    ED.doc.rooms = ED.doc.rooms.filter(function (r) { return r.id !== room.id; });
    Object.keys(ED.doc.departments).forEach(function (k) {
      if (ED.doc.departments[k] === room.id) delete ED.doc.departments[k];
    });
    markDirty();
    selectRoom(null);
    renderDraftProps();
    renderDepts();
    schedulePreview();
    edStatus('Ruangan "' + room.label + '" dihapus. Agent di dalamnya pindah ke ruangan otomatis.');
  }

  /* --- urungkan: snapshot dokumen sebelum tiap perubahan --- */
  function undo(reason) {
    if (!ED.undo.length) return;
    ED.doc = JSON.parse(ED.undo.pop());
    ED.last = JSON.stringify(ED.doc);
    ED.dirty = true;
    $('ed-undo').disabled = !ED.undo.length;
    if (ED.selRoom && !roomById(ED.selRoom)) ED.selRoom = null;
    selectProp(null);
    renderRoomSelect();
    renderRoomOverlay();
    renderDepts();
    renderDraftProps();
    schedulePreview(true);
    edStatus(reason || 'Perubahan terakhir diurungkan.', reason ? 'bad' : '');
  }

  function schedulePreview(fromUndo) {
    clearTimeout(ED.previewTimer);
    ED.previewTimer = setTimeout(function () { runPreview(fromUndo); }, 120);
  }

  async function runPreview(fromUndo) {
    const seq = (ED.previewSeq = (ED.previewSeq || 0) + 1);
    try {
      const res = await api('/api/office-layout', { method: 'POST', body: { doc: ED.doc, preview: true } });
      if (!ED.on || seq !== ED.previewSeq) return;
      ED.doc.rooms = res.layout.doc_rooms;
      ED.last = JSON.stringify(ED.doc);
      ED.previewed = true;
      rebuildWorld(res.layout, null, true);
      renderRoomSelect();
      renderRoomOverlay();
      renderDepts();
    } catch (err) {
      if (!ED.on || seq !== ED.previewSeq) return;
      if (fromUndo) { edStatus('Denah tidak valid: ' + err.message + '.', 'bad'); return; }
      undo('Dibatalkan: ' + err.message + '.');
    }
  }

  function renderDepts() {
    const box = $('ed-depts');
    box.textContent = '';
    deptOrder(app.agents).forEach(function (dept) {
      const a = app.agents.find(function (x) { return x.dept === dept; });
      const row = el('label', 'ed-dept');
      row.appendChild(el('span', null, a.dept_label));
      const sel = el('select');
      sel.setAttribute('aria-label', 'Ruangan untuk ' + a.dept_label);
      const auto = el('option', null, 'Otomatis');
      auto.value = '';
      sel.appendChild(auto);
      ED.doc.rooms.forEach(function (r) {
        if (r.kind !== 'department' && r.kind !== 'executive') return;
        const o = el('option', null, r.label);
        o.value = r.id;
        sel.appendChild(o);
      });
      sel.value = ED.doc.departments[dept] || '';
      sel.addEventListener('change', function () {
        if (sel.value) ED.doc.departments[dept] = sel.value;
        else delete ED.doc.departments[dept];
        markDirty();
        schedulePreview();
      });
      row.appendChild(sel);
      box.appendChild(row);
    });
  }

  async function openEditor() {
    if (ED.on) return;
    let data;
    try {
      data = await api('/api/office-layout');
    } catch (err) {
      toast('Editor denah gagal dibuka: ' + err.message, true);
      return;
    }
    closePanel();
    ED.on = true;
    ED.doc = JSON.parse(JSON.stringify(data.doc));
    ED.catalog = data.catalog;
    ED.kinds = data.kinds;
    ED.rules = data.rules;
    ED.max = data.max_props;
    ED.maxRooms = data.max_rooms;
    ED.dirty = false;
    ED.selected = null;
    ED.selRoom = null;
    ED.undo = [];
    ED.last = JSON.stringify(ED.doc);
    ED.previewed = false;
    $('ed-undo').disabled = true;
    document.body.classList.add('editing');
    $('editor').hidden = false;
    $('btn-edit').setAttribute('aria-pressed', 'true');
    $('ed-err').textContent = '';
    if (app.propGroup) app.propGroup.visible = false;
    if (app.controls) {
      // tombol kiri milik editor; kanan memutar kamera, tengah menggeser
      ED.mouse = Object.assign({}, app.controls.mouseButtons);
      app.controls.mouseButtons = { LEFT: -1, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    }
    renderPalette();
    renderKindSelect();
    renderRoomSelect();
    renderRoomOverlay();
    renderDepts();
    renderDraftProps();
    selectProp(null);
    edStatus(data.props_hidden ? data.props_hidden + ' perabot tersimpan disembunyikan karena sekarang menghalangi agent.' : '',
      data.props_hidden ? 'bad' : '');
    $('editor-close').focus();
  }

  function closeEditor(force) {
    if (!ED.on) return;
    if (ED.dirty && !force && !window.confirm('Buang perubahan denah yang belum disimpan?')) return;
    stopPlacing();
    if (ED.drag && app.controls) app.controls.enabled = true;
    ED.drag = null;
    if (ED.group) app.scene.remove(ED.group);
    ED.group = null;
    if (ED.rdrag && app.controls) app.controls.enabled = true;
    ED.rdrag = null;
    if (ED.overlay) app.scene.remove(ED.overlay);
    ED.overlay = null;
    ED.handles = [];
    clearTimeout(ED.previewTimer);
    ED.previewSeq = (ED.previewSeq || 0) + 1;     // abaikan preview yang masih jalan
    ED.on = false;
    app.renderer.domElement.style.cursor = 'grab';
    if (ED.previewed) {
      // Dunia sedang menampilkan draf: kembalikan denah tersimpan.
      ED.previewed = false;
      api('/api/layout').then(function (l) { rebuildWorld(l, null, true); }).catch(function () { refreshLayout(); });
    }
    if (app.propGroup) app.propGroup.visible = true;
    if (app.controls && ED.mouse) app.controls.mouseButtons = ED.mouse;
    ED.selected = null;
    ED.rdraw = null;
    $('ed-tools').hidden = true;
    document.body.classList.remove('editing');
    $('editor').hidden = true;
    $('btn-edit').setAttribute('aria-pressed', 'false');
    $('btn-edit').focus();
  }

  async function saveEditor() {
    if (ED.saving) return;
    const btn = $('ed-save');
    ED.saving = true;
    btn.disabled = true;
    btn.classList.add('is-loading');
    $('ed-err').textContent = '';
    try {
      const res = await api('/api/office-layout', { method: 'POST', body: { doc: ED.doc } });
      ED.dirty = false;
      ED.previewed = false;                         // draf = denah tersimpan
      closeEditor(true);
      toast('Denah disimpan: ' + res.props + ' perabot');
      refreshLayout();
    } catch (err) {
      $('ed-err').textContent = 'Gagal menyimpan: ' + err.message + '.';
    } finally {
      ED.saving = false;
      btn.disabled = false;
      btn.classList.remove('is-loading');
    }
  }

  function bindEditor() {
    $('btn-edit').addEventListener('click', function () { if (ED.on) closeEditor(); else openEditor(); });
    $('editor-close').addEventListener('click', function () { closeEditor(); });
    $('ed-cancel').addEventListener('click', function () { closeEditor(); });
    $('ed-save').addEventListener('click', saveEditor);
    $('ed-reset').addEventListener('click', function () {
      if (!window.confirm('Kembalikan denah ke bawaan? Semua ruangan, perabot kustom, dan penempatan departemen kembali seperti semula.')) return;
      ED.doc = { version: 2, rooms: [], departments: {}, props: [] };   // [] = denah bawaan
      selectProp(null);
      markDirty();
      selectRoom(null);
      renderDepts();
      renderDraftProps();
      schedulePreview();
      edStatus('Denah bawaan. Klik Simpan untuk menerapkan.');
    });
    $('ed-rot-l').addEventListener('click', function () { rotateSelected(-90); });
    $('ed-rot-r').addEventListener('click', function () { rotateSelected(90); });
    $('ed-angle').addEventListener('input', function () { setAngle(+$('ed-angle').value, false); });
    $('ed-angle').addEventListener('change', function () { setAngle(+$('ed-angle').value, true); });
    $('ed-dup').addEventListener('click', duplicateSelected);
    $('ed-delete').addEventListener('click', deleteSelected);
    $('ed-room').addEventListener('change', function () { selectRoom($('ed-room').value); });
    ['ed-room-label', 'ed-room-kind', 'ed-room-door', 'ed-room-accent', 'ed-room-decor'].forEach(function (id) {
      $(id).addEventListener('change', updateRoomCfg);
    });
    $('ed-room-delete').addEventListener('click', deleteRoom);
    $('ed-undo').addEventListener('click', function () { undo(); });
  }

  /* true = tombol sudah ditangani editor */
  function editorKey(ev) {
    if (!ED.on) return false;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((ev.target && ev.target.tagName) || '');
    if (ev.key === 'Escape') {
      if (ED.placing) stopPlacing();
      else if (ED.selected) selectProp(null);
      else if (ED.selRoom) selectRoom(null);
      else closeEditor();
      return true;
    }
    if (typing) return true;
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') { ev.preventDefault(); undo(); return true; }
    const k = ev.key.toLowerCase();
    if (k === 'r') { rotateSelected(ev.shiftKey ? -90 : 90); return true; }
    if ((ev.ctrlKey || ev.metaKey) && k === 'd') { ev.preventDefault(); duplicateSelected(); return true; }
    if (ev.key === 'Delete' || ev.key === 'Backspace') { deleteSelected(); return true; }
    return true;          // shortcut lain (B/N/F) mati selama mengedit
  }

  /* ================================================================
   * Data feed
   * ================================================================ */
  function applySnapshot(data) {
    if (!data || !Array.isArray(data.agents)) return;
    app.meetingLive = data.meeting || null;
    // Denah berubah: agent bisa menunjuk ruangan yang belum dibangun di
    // klien. Sinkronkan lewat refreshLayout (memakai data snapshot ini).
    if (ED.on) {
      // Editor (bisa sedang pratinjau): posisi meja dari denah yang tampil.
      syncAgents(data.agents.map(function (a) {
        const m = app.metaById[a.id];
        return m ? Object.assign({}, a, { room: m.room, room_label: m.room_label, pos: m.pos, chair: m.chair,
          stand: m.stand, desk_rot: m.desk_rot, accent: m.accent }) : a;
      }).filter(function (a) { return app.metaById[a.id]; }));
    } else if (data.layout_version && app.layoutVersion && data.layout_version !== app.layoutVersion) {
      refreshLayout(data.agents);
    } else {
      syncAgents(data.agents);
    }
    fillTargetSelect(data.agents);
    updateHUD(Object.assign({ agents: data.agents.length }, data.counts || {}));
    renderRoster(data.agents);
    renderFeed(data.events);
    updateMeetingButton();
    app.lastEventAt = Date.now();
    const agent = data.agents.find(function (a) { return a.id === app.selectedId; });
    if (agent) fillPanel(agent);
  }

  /* Roster berubah (agent direkrut/keluar): geometri ruangan tetap, hanya
     jumlah & posisi meja yang dihitung ulang server. */
  async function refreshLayout(fresh) {
    if (app.layoutLoading) return;
    app.layoutLoading = true;
    try {
      const layout = await api('/api/layout');
      if (structSig(layout) !== app.structSig) {
        rebuildWorld(layout, fresh);
        return;
      }
      layout.rooms.forEach(function (r) {
        const cur = app.roomById.get(r.id);
        if (cur) cur.desks = r.desks;
      });
      buildDeskObstacles();
      buildNavGrid();
      app.layoutVersion = layout.version;
      const byId = {};
      (fresh || app.agents).forEach(function (a) { byId[a.id] = a; });
      syncAgents(layout.agents.map(function (meta) {
        return Object.assign({ state: 'idle', open_count: 0, blocked_count: 0, done_count: 0 }, byId[meta.id] || {}, meta);
      }));
      renderRoster(app.agents);
    } catch (err) {
      /* coba lagi pada snapshot berikutnya */
    } finally {
      app.layoutLoading = false;
    }
  }

  /* Ruangan/gedung berubah: bangun ulang dunia 3D di tempat. Agent dibuat
     ulang di meja barunya; panel agent yang terpilih dibuka kembali. */
  function rebuildWorld(layout, fresh, quiet) {
    const byId = {};
    (fresh || app.agents).forEach(function (a) { byId[a.id] = a; });
    const keep = app.selectedId;
    const tab = app.panelTab;
    syncAgents([]);
    buildWorld(layout);
    app.layoutVersion = layout.version;
    syncAgents(layout.agents.map(function (meta) {
      return Object.assign({ state: 'idle', open_count: 0, blocked_count: 0, done_count: 0 }, byId[meta.id] || {}, meta);
    }));
    app.rosterSig = '';
    renderRoster(app.agents);
    updateHUD();
    if (keep && app.agentById.has(keep)) { selectAgent(keep); setTab(tab); }
    if (!quiet) toast('Denah kantor diperbarui: ' + app.rooms.length + ' ruangan');
  }

  async function pollAgents() {
    if (document.hidden) return;
    try {
      applySnapshot(await api('/api/agents'));
      if (app.mode !== 'live') setConnection('poll', 'polling 6 dtk');
    } catch (err) {
      if (app.mode !== 'live') setConnection('off', 'server tidak merespons');
    }
  }

  function connectStream() {
    if (!('EventSource' in window)) {
      setConnection('poll', 'polling 6 dtk');
      app.pollTimer = setInterval(pollAgents, 6000);
      return;
    }
    app.stream = new EventSource('/api/stream');
    app.stream.onmessage = function (ev) {
      try {
        applySnapshot(JSON.parse(ev.data));
        setConnection('live', 'live');
      } catch (err) { /* abaikan frame rusak */ }
    };
    app.stream.addEventListener('logout', function () { app.stream.close(); goLogin(); });
    app.stream.onerror = function () {
      setConnection('poll', 'SSE putus, polling');
      pollAgents();
    };
    app.pollTimer = setInterval(function () {
      if (Date.now() - app.lastEventAt > 20000) pollAgents();
    }, 6000);
  }

  /* ================================================================
   * Dispatch
   * ================================================================ */
  function showDispatch(kind, nodes) {
    const box = $('dispatch-result');
    box.textContent = '';
    const div = el('div', 'result ' + kind);
    nodes.forEach(function (n) { div.appendChild(typeof n === 'string' ? document.createTextNode(n) : n); });
    box.appendChild(div);
  }

  async function submitTask(ev) {
    ev.preventDefault();
    if (app.pendingDispatch) return;
    const target = $('task-target').value;
    const goalEl = $('task-goal');
    const goal = goalEl.value.trim();
    const accept = $('task-accept').value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    if (goal.length < 5) {
      goalEl.setAttribute('aria-invalid', 'true');
      $('task-goal-err').textContent = 'Goal minimal 5 karakter. Tulis hasil konkret yang diminta.';
      goalEl.focus();
      return;
    }
    const btn = $('task-submit');
    app.pendingDispatch = true;
    btn.disabled = true;
    btn.classList.add('is-loading');
    btn.querySelector('span').textContent = 'Mengirim';
    try {
      const body = await api('/api/task', {
        method: 'POST', body: { to: target, goal: goal, accept: accept, priority: $('task-priority').value }
      });
      const agent = app.agents.find(function (a) { return a.id === target; });
      const code = el('code', null, String(body.path || ''));
      showDispatch('ok', ['Tiket masuk ke ', el('strong', null, agent ? agent.name : target), ': ', code]);
      toast('Tiket terkirim ke ' + (agent ? agent.name : target));
      goalEl.value = '';
      $('task-accept').value = '';
      pollAgents();
    } catch (err) {
      showDispatch('err', ['Gagal mengirim: ' + String(err.message || err)]);
    } finally {
      app.pendingDispatch = false;
      btn.disabled = false;
      btn.classList.remove('is-loading');
      btn.querySelector('span').textContent = 'Kirim tiket tugas';
    }
  }

  /* ================================================================
   * Audit navigasi: agent tidak boleh berada di dalam dinding, tidak boleh
   * menabrak meja/kursi, dan harus benar-benar di kursi (working) / di
   * dalam playground (idle).
   * ================================================================ */
  function audit() {
    const violations = [];
    const b = app.walkBounds;
    app.agentById.forEach(function (rec) {
      const p = rec.group.position;
      app.wallBoxes.forEach(function (wb) {
        if (p.x > wb.x0 - 0.02 && p.x < wb.x1 + 0.02 && p.z > wb.z0 - 0.02 && p.z < wb.z1 + 0.02) {
          violations.push({ id: rec.id, kind: 'di-dinding', x: +p.x.toFixed(2), z: +p.z.toFixed(2), wall: [wb.x0, wb.z0, wb.x1, wb.z1].map(function (v) { return +v.toFixed(2); }), path: (rec.waypoints || []).slice(0, 4).map(function (q) { return [+q.x.toFixed(2), +q.z.toFixed(2)]; }) });
        }
      });
      // Agent tidak boleh berada di dalam bounding box meja/kursi milik
      // agent lain. Meja sendiri dikecualikan: di sanalah agent duduk.
      app.deskObstacles.forEach(function (o) {
        if (rec.deskRef && o.room === rec.deskRef.room && o.index === rec.deskRef.index) return;
        if (p.x > o.x0 - 0.10 && p.x < o.x1 + 0.10 &&
            p.z > o.z0 - 0.10 && p.z < o.z1 + 0.10) {
          violations.push({ id: rec.id, kind: 'di-meja', room: o.room, x: +p.x.toFixed(2), z: +p.z.toFixed(2) });
        }
      });
      // Perabot ruang rapat (meja conferencing + kursi). Kursi milik agent
      // yang sedang rapat dikecualikan: di sanalah agent duduk.
      app.furniture.forEach(function (o) {
        if (rec.ignoreFurniture && o.key === rec.ignoreFurniture) return;
        if (p.x > o.x0 - 0.10 && p.x < o.x1 + 0.10 &&
            p.z > o.z0 - 0.10 && p.z < o.z1 + 0.10) {
          violations.push({ id: rec.id, kind: 'di-perabot-rapat', o: o.kind, x: +p.x.toFixed(2), z: +p.z.toFixed(2) });
        }
      });
      // Dekor & perabot dari mesh nyata (rak, sofa, server rack, ...).
      // Kecuali saat duduk/bangkit: kursi rapat juga mesh di sini.
      const sitting = rec.ignoreFurniture || Math.hypot(p.x - rec.seat.x, p.z - rec.seat.z) < 0.6;
      if (!sitting) {
        app.solids.forEach(function (o) {
          if (p.x > o.x0 + 0.05 && p.x < o.x1 - 0.05 && p.z > o.z0 + 0.05 && p.z < o.z1 - 0.05) {
            violations.push({ id: rec.id, kind: 'di-dekor', x: +p.x.toFixed(2), z: +p.z.toFixed(2) });
          }
        });
      }
      if (!rec.moving && rec.status === 'working') {
        const d = Math.hypot(p.x - rec.seat.x, p.z - rec.seat.z);
        if (d > 0.3) violations.push({ id: rec.id, kind: 'bukan-di-kursi', d: +d.toFixed(2) });
      }
      if (!rec.moving && rec.status === 'blocked') {
        const d = Math.hypot(p.x - rec.stand.x, p.z - rec.stand.z);
        if (d > 0.3) violations.push({ id: rec.id, kind: 'bukan-di-stand', d: +d.toFixed(2) });
      }
      if (!rec.moving && rec.status === 'meeting' && rec.meetingSeat) {
        const d = Math.hypot(p.x - rec.meetingSeat.x, p.z - rec.meetingSeat.z);
        if (d > 0.3) violations.push({ id: rec.id, kind: 'bukan-di-kursi-rapat', d: +d.toFixed(2) });
      }
      if (!rec.moving && rec.status === 'idle' && rec.zone && !rec.waypoints.length && rec.idleWait <= 0 && !inZone(rec.zone, p)) {
        violations.push({ id: rec.id, kind: 'keluar-zona', zone: rec.zone.id, x: +p.x.toFixed(2), z: +p.z.toFixed(2) });
      }
    });
    return {
      agents: app.agentById.size,
      walls: app.wallBoxes.length,
      desks: app.deskObstacles.length,
      furniture: app.furniture.length,
      meeting: app.meetingLive ? (app.meetingLive.participants || []).length : 0,
      violations: violations,
      ok: violations.length === 0
    };
  }

  /* ================================================================
   * Boot
   * ================================================================ */
  async function boot() {
    loadPrefs();
    applyPrefsUI();
    if (!initThree()) return;

    let session;
    try {
      session = await api('/api/session');
    } catch (err) {
      fail('Tidak bisa menghubungi server', String(err.message || err));
      return;
    }
    app.csrf = session.csrf || '';
    app.demo = !!session.demo;
    app.auth = !!session.auth;
    $('demo-badge').hidden = !app.demo;
    $('btn-logout').hidden = !app.auth;

    let layout;
    try {
      layout = await api('/api/layout');
    } catch (err) {
      fail('Denah kantor gagal dimuat', String(err.message || err));
      return;
    }
    buildWorld(layout);
    const view = homeView();
    flyTo(view.pos, view.target, 0);

    const snapshot = await api('/api/agents').catch(function () { return null; });
    const source = snapshot ? snapshot.agents : layout.agents;
    app.meetingLive = snapshot ? snapshot.meeting : null;
    syncAgents(source.map(function (a) {
      return Object.assign({
        state: 'idle', open_count: 0, blocked_count: 0, done_count: 0,
        open_tasks: [], blocked_tasks: [], done_tasks: [], status_text: '', headline: ''
      }, a);
    }));
    fillTargetSelect(app.agents);
    renderRoster(app.agents);
    updateHUD(snapshot ? Object.assign({ agents: snapshot.agents.length }, snapshot.counts) : null);
    if (snapshot) renderFeed(snapshot.events);
    updateMeetingButton();
    applyDaylight();

    bindPointer();
    bindUI();
    animate();
    connectStream();
  }

  /* Debug hook untuk smoke test (lihat _tools/office_ui_probe.mjs). */
  window.office3d = {
    screenAt: function (x, z) {
      const v = new THREE.Vector3(x, 0, z).project(app.camera);
      const r = app.renderer.domElement.getBoundingClientRect();
      return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
    },
    editorDoc: function () { return ED.doc; },
    propBox: function (type) {
      const g = buildProp({ type: type, x: 0, z: 0, rot: 0 });
      const b = new THREE.Box3().setFromObject(g);
      return [+(b.max.x - b.min.x).toFixed(2), +(b.max.z - b.min.z).toFixed(2), +(b.min.x + b.max.x).toFixed(2), +(b.min.z + b.max.z).toFixed(2)];
    },
    version: '5.0',
    zones: function () {
      const occ = zoneLoad(null);
      return app.zones.map(function (z) {
        return { id: z.id, walled: !!z.walled, cap: z.cap, idle: occ[z.id] || 0 };
      });
    },
    flyToRoom: flyToRoom,
    follow: function (on) { setFollow(on); return app.follow; },
    bubbles: function () {
      let n = 0;
      app.agentById.forEach(function (rec) { if (rec.bubble && rec.bubble.visible) n += 1; });
      return n;
    },
    agents: function () {
      return app.agents.map(function (a) {
        return { id: a.id, name: a.name, state: a.state, dept: a.dept, room: a.room };
      });
    },
    deskCount: function () { return app.agentById.size; },
    roomCount: function () { return app.rooms.length; },
    /* Ruangan yang sedang dibangun di dunia 3D (uji editor). */
    room: function (id) {
      const r = app.roomById.get(id);
      return r ? { x: r.x, z: r.z, w: r.w, d: r.d, label: r.label, kind: r.kind,
        door: r.door ? r.door.side : null, desks: (r.desks || []).length } : null;
    },
    /* Pose nyata agent (status yang dipakai renderer + jarak ke kursi).
       Dipakai probe audit untuk memastikan agent benar-benar duduk. */
    states: function () {
      return Array.from(app.agentById.values()).map(function (rec) {
        const p = rec.group.position;
        return {
          id: rec.id,
          status: rec.status,
          moving: rec.moving,
          x: +p.x.toFixed(2),
          z: +p.z.toFixed(2),
          seatD: +Math.hypot(p.x - rec.seat.x, p.z - rec.seat.z).toFixed(3),
          standD: +Math.hypot(p.x - rec.stand.x, p.z - rec.stand.z).toFixed(3),
          meetingSlot: rec.meetingSeatIndex,
          meetingD: rec.meetingSeat
            ? +Math.hypot(p.x - rec.meetingSeat.x, p.z - rec.meetingSeat.z).toFixed(3)
            : -1,
          waypoints: rec.waypoints.length
        };
      });
    },
    /* Informasi rapat mode: payload live + slot tiap agent. */
    meeting: function () {
      const seated = [];
      app.agentById.forEach(function (rec) {
        if (rec.status !== 'meeting') return;
        seated.push({
          id: rec.id,
          slot: rec.meetingSeatIndex,
          x: rec.meetingSeat ? rec.meetingSeat.x : null,
          z: rec.meetingSeat ? rec.meetingSeat.z : null,
          moving: rec.moving,
          d: rec.meetingSeat
            ? +Math.hypot(rec.group.position.x - rec.meetingSeat.x,
                          rec.group.position.z - rec.meetingSeat.z).toFixed(3)
            : -1
        });
      });
      return {
        live: app.meetingLive,
        seats: (app.meeting && app.meeting.seats || []).length,
        standing: (app.meeting && app.meeting.standing || []).length,
        furniture: app.furniture.length,
        agents: seated
      };
    },
    obstacles: function () {
      return app.deskObstacles.map(function (o) {
        return {
          room: o.room, index: o.index,
          x0: +o.x0.toFixed(2), x1: +o.x1.toFixed(2),
          z0: +o.z0.toFixed(2), z1: +o.z1.toFixed(2)
        };
      });
    },
    mode: function () { return app.mode; },
    select: function (id) { selectAgent(id, true); },
    close: function () { closePanel(); },
    /* Paksa status agent (khusus uji visual pose idle/working/blocked).
       Tidak dipakai UI produksi; hanya hook debug. */
    setState: function (id, state) {
      const rec = app.agentById.get(id);
      if (!rec) return null;
      const prev = rec.status;
      app.forcedState[id] = state;
      rec.status = state;
      rec.ringMat.color.setHex(STATE_COLORS[state] || STATE_COLORS.idle);
      applyRoute(rec, prev);
      return { id: id, status: state, waypoints: rec.waypoints.length };
    },
    focus: function (id, dist) {
      const rec = app.agentById.get(id);
      if (!rec || !app.controls) return null;
      const p = rec.group.position;
      const d = dist || 9;
      app.controls.target.set(p.x, 0.9, p.z);
      app.camera.position.set(p.x + d * 0.7, d * 0.95, p.z + d * 0.9);
      app.controls.update();
      app.camera.updateMatrixWorld(true);
      return { x: p.x, z: p.z, status: rec.status, moving: rec.moving };
    },
    resetCamera: function () {
      if (!app.controls) return null;
      app.controls.target.set(-4, 0, 0);
      app.camera.position.set(-4, 49.05, 44.16);
      app.controls.update();
      app.camera.updateMatrixWorld(true);
      return true;
    },
    camera: function (opts) {
      if (!app.controls) return null;
      if (opts && opts.pos) app.camera.position.set(opts.pos[0], opts.pos[1], opts.pos[2]);
      if (opts && opts.target) app.controls.target.set(opts.target[0], opts.target[1], opts.target[2]);
      app.controls.update();
      app.camera.updateMatrixWorld(true);
      return { pos: app.camera.position.toArray(), target: app.controls.target.toArray() };
    },
    look: function (roomId, opts) {
      const room = app.roomById.get(roomId);
      if (!room || !app.controls) return null;
      opts = opts || {};
      const dist = opts.dist || 18;
      const ang = opts.angle === undefined ? Math.PI / 4 : opts.angle;
      const height = opts.height || dist * 0.9;
      app.controls.target.set(room.x, 0.5, room.z);
      app.camera.position.set(
        room.x + Math.sin(ang) * dist,
        height,
        room.z + Math.cos(ang) * dist
      );
      app.controls.update();
      app.camera.updateMatrixWorld(true);
      return { room: roomId, x: room.x, z: room.z };
    },
    lounge: function () {
      const p = app.playground;
      return p ? { x: p.x, z: p.z, w: p.w, d: p.d } : null;
    },
    nav: function () {
      return {
        cells: app.grid.cells.length,
        solids: app.solids.length,
        walkBounds: app.walkBounds
      };
    },
    audit: audit,
    quality: function (mode) {
      if (mode === 'high') {
        app.qualityChecked = true;
        app.lowQuality = false;
        app.renderer.shadowMap.enabled = true;
        app.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
        app.renderer.setSize(window.innerWidth, window.innerHeight);
        app.scene.traverse(function (o) {
          if (o.isPointLight) o.visible = true;
          if (o.material) {
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            mats.forEach(function (m) { m.needsUpdate = true; });
          }
        });
      } else if (mode === 'low') {
        enableLowQuality();
      }
      return { lowQuality: !!app.lowQuality };
    },
    info: function () {
      const r = app.renderer.info;
      let meshes = 0;
      app.scene.traverse(function (o) { if (o.isMesh || o.isSprite) meshes += 1; });
      return {
        calls: r.render.calls, triangles: r.render.triangles,
        geometries: r.memory.geometries, textures: r.memory.textures,
        programs: r.programs ? r.programs.length : -1,
        objects: meshes,
        fps: app.fps ? Math.round(app.fps * 100) / 100 : null,
        lowQuality: !!app.lowQuality
      };
    },
    pose: function (id) {
      const rec = app.agentById.get(id);
      if (!rec) return null;
      const p = new THREE.Vector3();
      rec.exclaim.getWorldPosition(p);
      return {
        status: rec.status,
        moving: rec.moving,
        exclaimVisible: rec.exclaim.visible,
        exclaimOpacity: rec.exclaim.material.opacity,
        exclaimPos: [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100, Math.round(p.z * 100) / 100],
        exclaimScale: rec.exclaim.scale.x,
        bodyY: Math.round(rec.body.position.y * 100) / 100
      };
    },
    route: function (id) {
      const rec = app.agentById.get(id);
      if (!rec) return null;
      return {
        status: rec.status,
        moving: rec.moving,
        waypoints: rec.waypoints.map(function (w) { return { x: +w.x.toFixed(2), z: +w.z.toFixed(2) }; }),
        seat: rec.seat,
        stand: rec.stand
      };
    },
    positions: function () {
      const out = {};
      app.agentById.forEach(function (rec, id) {
        out[id] = {
          x: Math.round(rec.group.position.x * 100) / 100,
          z: Math.round(rec.group.position.z * 100) / 100,
          status: rec.status, moving: rec.moving
        };
      });
      return out;
    },
    screenOf: function (id) {
      const rec = app.agentById.get(id);
      if (!rec) return null;
      const p = rec.group.position;
      /* Matriks kamera bisa basi sebelum frame pertama selesai dirender,
         jadi dipaksa diperbarui di sini agar koordinat layar selalu benar. */
      app.camera.updateMatrixWorld(true);
      app.camera.matrixWorldInverse.copy(app.camera.matrixWorld).invert();
      const v = new THREE.Vector3(p.x, 1.2, p.z).project(app.camera);
      return { x: (v.x + 1) / 2 * window.innerWidth, y: (1 - v.y) / 2 * window.innerHeight };
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
