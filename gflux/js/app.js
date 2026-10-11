/* GFLUX editor: canvas, wiring, menus, library drawer and the link to the
 * GFLUX app (which runs KiCad on this computer). */
(function () {
  const G = GFLUX.art.G;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } },
  };
  const session = {
    get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } },
  };
  const newId = (p) => p + Math.random().toString(36).slice(2, 9);
  const RELEASE = 'https://github.com/BlakeWMcleod/Cy-Ramick-The-sentient-plate-KnightHack-2026/releases/tag/gflux-latest';
  const EXE = 'https://github.com/BlakeWMcleod/Cy-Ramick-The-sentient-plate-KnightHack-2026/releases/download/gflux-latest/GFLUX-Windows.exe';

  let state = null;
  let view = { x: 0, y: 0, k: 1 };
  let sel = null; // { kind: 'part' | 'wire', id }
  let drag = null;
  let wireColor = store.get('gflux.wireColor') || 'auto';
  let bridge = null; // base URL of the GFLUX app while KiCad is usable
  let appBase = null; // base URL of the GFLUX app whenever this page is served by it
  const undoStack = [], redoStack = [];
  const artCache = new Map();

  const ANIM_DEFAULTS = { v: 2, on: true, dim: true, speed: 1, gap: 14, size: 2.5, style: 'pulse', power: true, ground: true, signal: true };
  let anim = Object.assign({}, ANIM_DEFAULTS);
  try {
    const saved = JSON.parse(store.get('gflux.anim') || '{}');
    if (saved.v === 2) Object.assign(anim, saved); // older settings predate the glowing pulses
  } catch (e) { /* keep defaults */ }
  let bgColor = store.get('gflux.bg') || '#ffffff';
  let warpAmt = store.get('gflux.warp') != null ? +store.get('gflux.warp') : 0.6;
  let autoResistor = store.get('gflux.autoResistor') !== 'off';

  const svg = $('#canvas');
  const L = {};
  ['parts', 'wires', 'flow', 'labels', 'preview', 'pins'].forEach((k) => { L[k] = $('#L-' + k); });

  // ------------------------------------------------------------------ state

  function freshProject() {
    return { name: 'my-circuit', parts: [{ uid: newId('p'), type: 'esp32', x: 0, y: 0, rot: 0 }], wires: [], custom: [] };
  }

  function loadState(s) {
    state = Object.assign({ name: 'my-circuit', parts: [], wires: [], custom: [] }, s);
    GFLUX.setCustomParts(mergedCustom());
    state.parts = state.parts.filter((p) => GFLUX.getPart(p.type));
    sel = null;
    $('#projName').value = state.name;
    renderLibrary();
  }

  /** Custom parts from this project plus the user's personal library. */
  function mergedCustom() {
    let mine = [];
    try { mine = JSON.parse(store.get('gflux.customLib') || '[]'); } catch (e) { mine = []; }
    const out = (state.custom || []).slice();
    for (const p of mine) if (!out.some((q) => q.id === p.id)) out.push(p);
    return out;
  }

  function snapshot() {
    undoStack.push(JSON.stringify(state));
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
  }
  function restore(from, to) {
    if (!from.length) return;
    to.push(JSON.stringify(state));
    loadState(JSON.parse(from.pop()));
    changed(false);
  }

  function changed(save = true) {
    if (save) store.set('gflux.autosave', JSON.stringify(state));
    render();
    updateLiveIssues();
  }

  // Wiring mistakes pop up as soon as they happen (things not wired yet wait for Finalize).
  let liveSig = '', liveDismissed = '';
  function updateLiveIssues() {
    const box = document.getElementById('liveIssues');
    if (!box || !GFLUX.check) return;
    const faults = GFLUX.check.run(state).filter((i) => i.kind === 'fault');
    const sig = faults.map((i) => i.text).join('|');
    if (!faults.length || sig === liveDismissed) { box.hidden = true; liveSig = sig; return; }
    if (sig !== liveSig || box.hidden) {
      box.className = 'live-issues' + (faults.every((i) => i.level === 'warn') ? ' warn-only' : '');
      box.innerHTML = `<button class="x" aria-label="Dismiss">×</button><h4>${faults.length === 1 ? '1 problem' : faults.length + ' problems'}</h4>` +
        `<ul>${faults.map((i) => `<li class="${i.level}"${i.uid ? ` data-uid="${i.uid}"` : ''}>${esc(i.text)}</li>`).join('')}</ul>`;
      box.hidden = false;
    }
    liveSig = sig;
  }

  // ------------------------------------------------------- wire ends & refs
  // A ref is what the pointer is on: a pin { uid, pin } or a grid point { pt: { x, y } }.
  // A wire end in the saved state is { part, pin } or { x, y }.

  const refToEnd = (ref) => (ref.pt ? { x: ref.pt.x, y: ref.pt.y } : { part: ref.uid, pin: ref.pin });
  const refKey = (ref) => (ref.pt ? GFLUX.pointKey(ref.pt.x, ref.pt.y) : GFLUX.pinKey(ref.uid, ref.pin));
  const sameRef = (a, b) => !!a && !!b && refKey(a) === refKey(b);
  const instOf = (uid) => state.parts.find((p) => p.uid === uid);

  /** World position (and header side) of a wire end or ref. */
  function endPos(end) {
    if (end.pt) return { x: end.pt.x, y: end.pt.y, side: null };
    const uid = end.uid || end.part;
    if (uid == null) return { x: end.x, y: end.y, side: null };
    return GFLUX.findPin(state, uid, end.pin);
  }

  function refLabel(ref) {
    if (ref.pt) return 'Loose wire end';
    const inst = instOf(ref.uid);
    return `${GFLUX.pinByNum(inst.type, ref.pin).name} · ${GFLUX.getPart(inst.type).name}`;
  }

  /** Wiring safety for any two refs. Loose ends borrow a pin from their net. */
  function checkPair(nl, from, to) {
    if (sameRef(from, to)) return { level: 'blocked', reason: 'Same spot' };
    const proxy = (ref) => {
      if (!ref.pt) return ref;
      const net = nl.byPin.get(refKey(ref));
      return net && net.pins[0] ? net.pins[0] : null;
    };
    const a = proxy(from), b = proxy(to);
    if (!a || !b) return { level: 'ok', reason: 'Loose wire end' };
    const res = GFLUX.rules.check(state, nl, a, b);
    if (res.reason === 'Same pin') return { level: 'blocked', reason: 'Already connected' };
    return res;
  }

  // --------------------------------------------------------------- geometry

  function screenToWorld(cx, cy) {
    const r = svg.getBoundingClientRect();
    return { x: (cx - r.left - view.x) / view.k / G, y: (cy - r.top - view.y) / view.k / G };
  }

  /** Remove repeated points and points in the middle of straight runs. */
  function simplify(pts) {
    const clean = [];
    for (const p of pts) {
      const n = clean.length;
      if (n && clean[n - 1].x === p.x && clean[n - 1].y === p.y) continue;
      if (n >= 2) {
        const a1 = clean[n - 2], b1 = clean[n - 1];
        if ((a1.x === b1.x && b1.x === p.x) || (a1.y === b1.y && b1.y === p.y)) clean.pop();
      }
      clean.push(p);
    }
    return clean;
  }

  const TAG_BTN = 24; // auto-wire button width (px) beside a name tag

  /** Where a part's name tag sits (grid units): above the board, or below it
   *  when the part has header pins along its top edge. */
  function labelSpot(inst) {
    const def = GFLUX.getPart(inst.type), box = GFLUX.partBox(inst);
    const pins = GFLUX.partPins(inst);
    const below = pins.some((p) => p.side === 'top') && !pins.some((p) => p.side === 'bottom');
    const w = def.name.length * 7.4 + 22 + (def.controller ? 0 : TAG_BTN);
    return { cx: box.x + box.w / 2, cy: below ? box.y + box.h + 1.1 : box.y - 1.1, half: w / 2 / G, w };
  }

  // Grid cells covered by boards and name tags, rebuilt only when parts move.
  let obstacleSig = '', obstacles = new Set(), bounds = null;
  function refreshObstacles() {
    const sig = state.parts.map((p) => `${p.uid}:${p.x},${p.y},${p.rot}`).join('|');
    if (sig === obstacleSig) return;
    obstacleSig = sig;
    obstacles = new Set();
    bounds = null;
    for (const inst of state.parts) {
      const b = GFLUX.partBox(inst);
      for (let x = b.x; x <= b.x + b.w; x++) for (let y = b.y; y <= b.y + b.h; y++) obstacles.add(x + ',' + y);
      const tag = labelSpot(inst), ty = Math.round(tag.cy);
      for (let x = Math.ceil(tag.cx - tag.half); x <= Math.floor(tag.cx + tag.half); x++) obstacles.add(x + ',' + ty);
      bounds = bounds || { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      bounds.x0 = Math.min(bounds.x0, b.x); bounds.y0 = Math.min(bounds.y0, b.y);
      bounds.x1 = Math.max(bounds.x1, b.x + b.w); bounds.y1 = Math.max(bounds.y1, b.y + b.h);
    }
  }

  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  /** A* over grid points: goes around boards, prefers few bends and avoids
   *  running on top of wires already laid (`used`). Returns points or null. */
  function astar(s, t, used) {
    const key = (x, y) => x + ',' + y;
    const free = (x, y) => !obstacles.has(key(x, y)) || (x === t.x && y === t.y);
    const M = 8;
    const x0 = Math.min(bounds.x0, s.x, t.x) - M, x1 = Math.max(bounds.x1, s.x, t.x) + M;
    const y0 = Math.min(bounds.y0, s.y, t.y) - M, y1 = Math.max(bounds.y1, s.y, t.y) + M;
    const heap = [], best = new Map(), prev = new Map();
    const push = (n) => { heap.push(n); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p].f <= heap[i].f) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l].f < heap[m].f) m = l; if (r < heap.length && heap[r].f < heap[m].f) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } }
      return top;
    };
    const h = (x, y) => Math.abs(x - t.x) + Math.abs(y - t.y);
    push({ x: s.x, y: s.y, d: -1, g: 0, f: h(s.x, s.y) });
    best.set(s.x + ',' + s.y + ',-1', 0);
    let guard = 0;
    while (heap.length && guard++ < 60000) {
      const n = pop();
      const nk = n.x + ',' + n.y + ',' + n.d;
      if (n.g > best.get(nk)) continue;
      if (n.x === t.x && n.y === t.y) {
        const pts = [];
        for (let k = nk; k; k = prev.get(k)) { const [x, y] = k.split(','); pts.push({ x: +x, y: +y }); }
        return pts.reverse();
      }
      for (let d = 0; d < 4; d++) {
        const x = n.x + DIRS[d][0], y = n.y + DIRS[d][1];
        if (x < x0 || x > x1 || y < y0 || y > y1 || !free(x, y)) continue;
        const g = n.g + 1 + (n.d !== -1 && n.d !== d ? 2.5 : 0) + (used.has(key(x, y)) ? 1.6 : 0);
        const k = x + ',' + y + ',' + d;
        if (best.has(k) && best.get(k) <= g) continue;
        best.set(k, g); prev.set(k, nk);
        push({ x, y, d, g, f: g + h(x, y) });
      }
    }
    return null;
  }

  /** Simple L-shaped fallback when no clear path exists. */
  function lRoute(p, q) { return p.x === q.x || p.y === q.y ? [p, q] : [p, { x: q.x, y: p.y }, q]; }

  const SIDE_DIR = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };

  /** Jumper-wire route between two points, through optional via points,
   *  leaving each pin straight out of its header. */
  function route(a, b, via, sideA, sideB, used = new Set()) {
    refreshObstacles();
    const out = [{ x: a.x, y: a.y }];
    let cur = sideA ? { x: a.x + SIDE_DIR[sideA][0], y: a.y + SIDE_DIR[sideA][1] } : { x: a.x, y: a.y };
    out.push(cur);
    const targets = (via || []).slice();
    targets.push(sideB ? { x: b.x + SIDE_DIR[sideB][0], y: b.y + SIDE_DIR[sideB][1] } : { x: b.x, y: b.y });
    for (const t of targets) {
      const seg = (bounds && astar(cur, t, used)) || lRoute(cur, t);
      for (const p of seg.slice(1)) out.push(p);
      cur = t;
    }
    out.push({ x: b.x, y: b.y });
    return simplify(out);
  }

  /** Mark the grid cells a route passes through. */
  function markUsed(pts, used) {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const dx = Math.sign(b.x - a.x), dy = Math.sign(b.y - a.y);
      for (let x = a.x, y = a.y; ; x += dx, y += dy) { used.add(x + ',' + y); if (x === b.x && y === b.y) break; }
    }
  }

  /** SVG path with rounded bends, like a pre-formed jumper wire. */
  function pathD(pts) {
    const P = pts.map((p) => ({ x: p.x * G, y: p.y * G }));
    if (P.length < 2) return '';
    let d = `M${P[0].x} ${P[0].y}`;
    for (let i = 1; i < P.length - 1; i++) {
      const a = P[i - 1], b = P[i], c = P[i + 1];
      const l1 = Math.hypot(b.x - a.x, b.y - a.y), l2 = Math.hypot(c.x - b.x, c.y - b.y);
      const rad = Math.min(9, l1 / 2, l2 / 2);
      const p1 = { x: b.x - ((b.x - a.x) / l1) * rad, y: b.y - ((b.y - a.y) / l1) * rad };
      const p2 = { x: b.x + ((c.x - b.x) / l2) * rad, y: b.y + ((c.y - b.y) / l2) * rad };
      d += ` L${p1.x} ${p1.y} Q${b.x} ${b.y} ${p2.x} ${p2.y}`;
    }
    const z = P[P.length - 1];
    return d + ` L${z.x} ${z.y}`;
  }

  // All wire routes, recomputed only when parts or wires change.
  let routeSig = '', routes = new Map(), routeUsed = new Set();
  function allRoutes() {
    refreshObstacles();
    const sig = obstacleSig + '#' + JSON.stringify(state.wires);
    if (sig === routeSig) return routes;
    routes = new Map();
    routeUsed = new Set();
    for (const w of state.wires) {
      const a = endPos(w.a), b = endPos(w.b);
      if (!a || !b) continue;
      const pts = route(a, b, w.via, a.side, b.side, routeUsed);
      markUsed(pts, routeUsed);
      routes.set(w.id, pts);
    }
    routeSig = sig;
    return routes;
  }

  function partTransform(inst) {
    const def = GFLUX.getPart(inst.type);
    const x = inst.x * G, y = inst.y * G;
    switch (inst.rot % 4) {
      case 1: return `translate(${x + def.h * G} ${y}) rotate(90)`;
      case 2: return `translate(${x + def.w * G} ${y + def.h * G}) rotate(180)`;
      case 3: return `translate(${x} ${y + def.w * G}) rotate(270)`;
      default: return `translate(${x} ${y})`;
    }
  }

  // ----------------------------------------------------------------- colours

  const hexOf = (c) => (c && c[0] === '#' ? c : GFLUX.colorHex(c));

  const RAINBOW = ['R', 'O', 'Y', 'G', 'B', 'I', 'V'];

  /** Is this wire end a signal (not power/ground) pin on a controller board? */
  function isBoardSignal(end) {
    if (!GFLUX.isPinEnd(end)) return false;
    const inst = instOf(end.part);
    if (!inst || !GFLUX.getPart(inst.type).controller) return false;
    const def = GFLUX.getPart(inst.type), pin = GFLUX.pinByNum(inst.type, end.pin);
    return pin.kind === 'sig' && !(def.rails && def.rails[pin.name]);
  }

  /** Colour for a new wire in Auto mode. Wires leaving the ESP32 go through
   *  the rainbow (ROYGBIV) one after another; power is red, ground black. */
  function autoColor(a, b) {
    for (const ref of [a, b]) {
      if (!ref || ref.pt) continue;
      const def = GFLUX.getPart(instOf(ref.uid).type);
      if (!def.controller) continue;
      const pin = GFLUX.pinByNum(def.id, ref.pin);
      if (pin.kind === 'gnd') return 'K';
      if ((def.rails && def.rails[pin.name]) || pin.kind === 'v3' || pin.kind === 'v5') return 'R';
      const out = state.wires.filter((w) => isBoardSignal(w.a) || isBoardSignal(w.b)).length;
      return RAINBOW[out % RAINBOW.length];
    }
    const roles = [a, b].filter((r) => r && !r.pt).map((r) => ({ role: GFLUX.pinRole(instOf(r.uid), r.pin), name: GFLUX.pinByNum(instOf(r.uid).type, r.pin).name }));
    if (roles.some((r) => r.role.rail === 'GND' || (r.role.kind === 'gnd'))) return 'K';
    if (roles.some((r) => (r.role.rail && r.role.rail !== 'GND') || r.role.kind === 'v3' || r.role.kind === 'v5')) return 'R';
    if (roles.some((r) => r.name === 'SDA')) return 'B';
    if (roles.some((r) => r.name === 'SCL')) return 'Y';
    return ['O', 'G', 'B', 'I', 'V', 'Y'][state.wires.length % 6];
  }

  // ---------------------------------------------------------------- render

  const FLOW_COLOR = { power: '#ffe14d', ground: '#ffffff', signal: '#5ee1ff' };
  const FLOW_SPEED = { power: 46, ground: 30, signal: 36 }; // px per second at 1x

  const pathLen = (pts) => pts.reduce((n, p, i) => (i ? n + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) * G : 0), 0);

  /** Glowing white pulses (radial gradient) travelling the way current flows. */
  function pulseMarkup(d, len, kind) {
    const spacing = Math.max(40, anim.gap * 6), rad = anim.size * 7;
    const dur = Math.max(0.4, len / (FLOW_SPEED[kind] * anim.speed));
    const n = Math.min(14, Math.max(1, Math.round(len / spacing)));
    let s = '';
    for (let i = 0; i < n; i++) {
      const begin = (-dur * i / n).toFixed(3);
      s += `<circle class="pulse" r="${rad}" fill="url(#gx-pulse)">` +
        `<animate attributeName="r" values="${rad * 0.85};${rad * 1.1};${rad * 0.85}" dur="1.6s" begin="${begin}s" repeatCount="indefinite"/>` +
        `<animateMotion dur="${dur.toFixed(3)}s" begin="${begin}s" repeatCount="indefinite" path="${d}"/></circle>`;
    }
    return s;
  }

  /** Moving particles along a wire, pointing the way current flows. Uses SMIL
   *  so it always runs, independent of the OS "reduce motion" CSS setting. */
  function flowMarkup(d, kind, pts) {
    if (anim.style === 'pulse') return pulseMarkup(d, pathLen(pts), kind);
    const gap = +anim.gap, size = +anim.size;
    let dash = size * 2.4, cap = 'butt', width = size;
    if (anim.style === 'dot') { dash = 0.01; cap = 'round'; width = size * 1.8; }
    const period = dash + gap;
    const dur = (period / (FLOW_SPEED[kind] * anim.speed)).toFixed(3);
    const move = `<animate attributeName="stroke-dashoffset" from="0" to="${-period}" dur="${dur}s" repeatCount="indefinite"/>`;
    const common = `d="${d}" stroke-dasharray="${dash} ${gap}" stroke-linecap="${cap}"`;
    return `<path class="flow" ${common} stroke="rgba(0,0,0,.5)" stroke-width="${width + 2}">${move}</path>` +
      `<path class="flow" ${common} stroke="${FLOW_COLOR[kind]}" stroke-width="${width}">${move}</path>`;
  }

  // Auto-wire availability per part, recomputed only when the circuit changes.
  let awSig = '', awCache = new Map();
  function autowireInfo(uid) {
    if (!GFLUX.autowire) return null;
    const sig = obstacleSig + '#' + JSON.stringify(state.wires);
    if (sig !== awSig) { awSig = sig; awCache = new Map(); }
    if (!awCache.has(uid)) {
      let info = null;
      try {
        if (GFLUX.autowire.canWire(state, uid)) info = { done: !!GFLUX.autowire.plan(state, uid).done };
      } catch (e) { info = null; }
      awCache.set(uid, info);
    }
    return awCache.get(uid);
  }

  function render() {
    const nl = GFLUX.buildNets(state);
    const flows = anim.on ? GFLUX.rules.flow(state) : new Map();
    $('#world1').setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);
    $('#world2').setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);

    let parts = '', labels = '', pins = '', wires = '', flow = '';
    const wiring = drag && drag.mode === 'wire';
    const pinClass = (ref) => {
      if (!wiring) return '';
      if (sameRef(ref, drag.from)) return ' source';
      const res = drag.checks.get(refKey(ref));
      return res ? ' ' + res.level : '';
    };
    for (const inst of state.parts) {
      const def = GFLUX.getPart(inst.type);
      if (!artCache.has(inst.type)) artCache.set(inst.type, GFLUX.art.draw(def));
      const selected = sel && sel.kind === 'part' && sel.id === inst.uid;
      parts += `<g class="part${selected ? ' selected' : ''}" data-uid="${inst.uid}" transform="${partTransform(inst)}">${artCache.get(inst.type)}</g>`;
      const box = GFLUX.partBox(inst);
      if (selected) labels += `<rect class="sel-box" x="${(box.x - 0.9) * G}" y="${(box.y - 0.9) * G}" width="${(box.w + 1.8) * G}" height="${(box.h + 1.8) * G}"/>`;
      labels += labelMarkup(inst, def);
      for (const p of GFLUX.partPins(inst)) {
        const ref = { uid: inst.uid, pin: p.num };
        pins += `<circle class="pin${pinClass(ref)}" data-uid="${inst.uid}" data-pin="${p.num}" cx="${p.x * G}" cy="${p.y * G}" r="7"/>`;
      }
    }
    const rts = allRoutes();
    const looseEnds = new Map();
    for (const w of state.wires) {
      const pts = rts.get(w.id);
      if (!pts) continue;
      const d = pathD(pts), hex = hexOf(w.color);
      const selected = sel && sel.kind === 'wire' && sel.id === w.id;
      let ends = '';
      for (const [end, pt] of [[w.a, pts[0]], [w.b, pts[pts.length - 1]]]) {
        if (GFLUX.isPinEnd(end)) ends += `<circle class="w-tip" cx="${pt.x * G}" cy="${pt.y * G}" r="3.6"/>`;
        else looseEnds.set(pt.x + ',' + pt.y, pt);
      }
      wires += `<g class="wire${selected ? ' selected' : ''}" data-wid="${w.id}">` +
        `<path class="w-glow" d="${d}"/><path class="w-edge" d="${d}"/><path class="w-core" d="${d}" stroke="${hex}"/>${ends}` +
        `<path class="w-hit" d="${d}"/></g>`;
      const f = flows.get(w.id);
      if (f && f.dir && anim[f.kind]) {
        const fp = f.dir > 0 ? pts : pts.slice().reverse();
        // The glow only shows inside this wire: masked by the wire's own stroke.
        const m = 'fm-' + w.id;
        flow += `<mask id="${m}" maskUnits="userSpaceOnUse" x="-100000" y="-100000" width="200000" height="200000">` +
          `<path d="${d}" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></mask>` +
          `<g mask="url(#${m})">${flowMarkup(pathD(fp), f.kind, fp)}</g>`;
      }
    }
    for (const pt of looseEnds.values()) {
      wires += `<circle class="w-free" cx="${pt.x * G}" cy="${pt.y * G}" r="4.5"/>`;
      pins += `<circle class="pin free-end${pinClass({ pt })}" data-pt="${pt.x},${pt.y}" cx="${pt.x * G}" cy="${pt.y * G}" r="7"/>`;
    }
    L.parts.innerHTML = parts;
    L.wires.innerHTML = wires;
    L.flow.innerHTML = flow;
    L.labels.innerHTML = labels;
    L.pins.innerHTML = pins;
    renderPreview();
    svg.classList.toggle('wiring', !!wiring);
    svg.classList.toggle('dim-on', !!anim.dim);
    requestGrid();
    $('#legend').hidden = !wiring;
    $('#hint').hidden = !!wiring;
    $('#stats').textContent = `${state.parts.length} parts · ${state.wires.length} wires · ${Math.round(view.k * 100)}%`;
    $$('[data-act="undo"]').forEach((b) => { b.disabled = !undoStack.length; });
    $$('[data-act="redo"]').forEach((b) => { b.disabled = !redoStack.length; });
  }

  function labelMarkup(inst, def) {
    const tag = labelSpot(inst);
    const w = tag.w, nameW = w - (def.controller ? 0 : TAG_BTN);
    let s = `<g class="part-label cat-${def.cat}" data-uid="${inst.uid}" data-type="${esc(inst.type)}" transform="translate(${tag.cx * G} ${tag.cy * G})">` +
      `<rect class="tag" x="${-w / 2}" y="-10" width="${w}" height="20" rx="10"/>` +
      `<rect class="name-hit" x="${-w / 2}" y="-10" width="${nameW}" height="20"/>` +
      `<text x="${-w / 2 + nameW / 2}" y="4.5" text-anchor="middle">${esc(def.name)}</text>`;
    if (!def.controller) {
      const info = autowireInfo(inst.uid);
      if (info) {
        // Lightning-bolt button: wire this part to the ESP32 automatically.
        s += `<g class="autowire${info.done ? ' done' : ''}" data-uid="${inst.uid}" transform="translate(${w / 2 - TAG_BTN + 1} -9)" role="button" aria-label="Auto-wire ${esc(def.name)}">` +
          `<rect x="1" y="1" width="${TAG_BTN - 4}" height="16" rx="8"/><path d="M12.5 2 6 10.5h4.5L9 16l7-8.5h-4.5z"/></g>`;
      }
    }
    return s + '</g>';
  }

  function renderPreview() {
    if (!drag || drag.mode !== 'wire') { L.preview.innerHTML = ''; return; }
    const from = endPos(drag.from);
    let end = drag.cursor, sideB = null;
    if (drag.hover) {
      const hp = endPos(drag.hover);
      if (hp) { end = hp; sideB = hp.side; }
    }
    if (!end || !from) return;
    const pts = route(from, { x: end.x, y: end.y }, drag.via, from.side, sideB, routeUsed);
    const level = drag.hover ? (drag.checks.get(refKey(drag.hover)) || { level: 'ok' }).level : 'none';
    const col = drag.color === 'auto' ? hexOf(autoColor(drag.from, drag.hover)) : hexOf(drag.color);
    L.preview.innerHTML = `<path class="pv-edge" d="${pathD(pts)}"/><path class="pv-core lvl-${level}" d="${pathD(pts)}" stroke="${col}"/>` +
      drag.via.map((v) => `<circle class="pv-via" cx="${v.x * G}" cy="${v.y * G}" r="4"/>`).join('');
  }

  // --------------------------------------------------------- stretchy grid
  // Drawn on a canvas under the SVG; lines bulge away from the mouse.
  const gridCv = $('#gridCanvas'), gctx = gridCv.getContext('2d');
  const warp = { mx: -1e4, my: -1e4, tx: -1e4, ty: -1e4, s: 0, ts: 0 };
  let gridRaf = 0, gridRainbow = 0; // start time of the finalize rainbow sweep (0 = off)
  const requestGrid = () => { if (!gridRaf) gridRaf = requestAnimationFrame(drawGrid); };

  function luminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function drawGrid() {
    gridRaf = 0;
    const dpr = window.devicePixelRatio || 1, w = gridCv.clientWidth, h = gridCv.clientHeight;
    if (gridCv.width !== Math.round(w * dpr) || gridCv.height !== Math.round(h * dpr)) {
      gridCv.width = Math.round(w * dpr); gridCv.height = Math.round(h * dpr);
    }
    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    gctx.clearRect(0, 0, w, h);
    // Ease the bulge toward the mouse so it feels springy.
    if (warp.s < 0.01 && warp.ts > 0) { warp.mx = warp.tx; warp.my = warp.ty; }
    warp.mx += (warp.tx - warp.mx) * 0.3;
    warp.my += (warp.ty - warp.my) * 0.3;
    warp.s += (warp.ts - warp.s) * 0.18;
    let sp = G * view.k;
    while (sp < 10) sp *= 2;
    const ox = ((view.x % sp) + sp) % sp, oy = ((view.y % sp) + sp) % sp;
    const R = 140, K = warpAmt * 0.55 * warp.s;
    const bend = K > 0.002;
    const disp = (x, y) => {
      const dx = x - warp.mx, dy = y - warp.my;
      const f = K * Math.exp(-(dx * dx + dy * dy) / (R * R));
      return [x + dx * f, y + dy * f];
    };
    gctx.lineWidth = gridRainbow ? 1.6 : 1;
    const plain = luminance(bgColor) > 0.4 ? 'rgba(25, 30, 50, 0.11)' : 'rgba(255, 255, 255, 0.11)';
    // During the finalize intro the grid sweeps once around the rainbow.
    const phase = gridRainbow ? (performance.now() - gridRainbow) / 900 : 0;
    const colorAt = (pos) => (gridRainbow ? `hsla(${(phase * 360 + pos * 0.35) % 360}, 90%, 55%, 0.55)` : plain);
    const line = (pos, pts) => {
      if (gridRainbow) { gctx.beginPath(); gctx.strokeStyle = colorAt(pos); }
      pts();
      if (gridRainbow) gctx.stroke();
    };
    gctx.strokeStyle = plain;
    gctx.beginPath();
    for (let x = ox; x <= w; x += sp) {
      line(x, () => {
        if (!bend || Math.abs(x - warp.mx) > R * 2.6) { gctx.moveTo(x + 0.5, 0); gctx.lineTo(x + 0.5, h); return; }
        for (let y = 0; y <= h + 8; y += 8) { const [px, py] = disp(x, y); y ? gctx.lineTo(px + 0.5, py) : gctx.moveTo(px + 0.5, py); }
      });
    }
    for (let y = oy; y <= h; y += sp) {
      line(y, () => {
        if (!bend || Math.abs(y - warp.my) > R * 2.6) { gctx.moveTo(0, y + 0.5); gctx.lineTo(w, y + 0.5); return; }
        for (let x = 0; x <= w + 8; x += 8) { const [px, py] = disp(x, y); x ? gctx.lineTo(px, py + 0.5) : gctx.moveTo(px, py + 0.5); }
      });
    }
    if (!gridRainbow) gctx.stroke();
    if (gridRainbow || Math.abs(warp.tx - warp.mx) > 0.3 || Math.abs(warp.ty - warp.my) > 0.3 || Math.abs(warp.ts - warp.s) > 0.005) requestGrid();
  }

  // ------------------------------------------------ top bar follows the hover
  const CAT_HEX = () => Object.fromEntries(GFLUX.CATEGORIES.map((c) => [c.id, c.color === 'Y' ? '#e6be00' : c.color === 'W' ? '#7d7d86' : hexOf(c.color)]));
  let hoverHex = null;
  /** Tint the top bar with whatever is under the mouse on the grid. */
  function hoverTint(el) {
    let hex = null;
    const pinEl = el.closest && el.closest('.pin');
    const wireEl = el.closest && el.closest('.wire');
    const partEl = el.closest && el.closest('.part, .part-label');
    if (pinEl && !pinEl.dataset.pt) {
      const inst = instOf(pinEl.dataset.uid), pin = GFLUX.pinByNum(inst.type, pinEl.dataset.pin);
      const role = GFLUX.pinRole(inst, pin.num);
      hex = role.rail === 'GND' || pin.kind === 'gnd' ? '#1c1c1c' : role.rail || pin.kind === 'v3' || pin.kind === 'v5' ? hexOf('R') : CAT_HEX()[GFLUX.getPart(inst.type).cat];
    } else if (wireEl) {
      const w = state.wires.find((x) => x.id === wireEl.dataset.wid);
      if (w) hex = hexOf(w.color);
    } else if (partEl) {
      const inst = instOf(partEl.dataset.uid);
      if (inst) hex = CAT_HEX()[GFLUX.getPart(inst.type).cat];
    }
    if (hex === hoverHex) return;
    hoverHex = hex;
    tint(null);
  }

  // -------------------------------------------------------------- library

  function partMatches(def, q) {
    if (!q) return true;
    const hay = [def.name, def.full, def.mpn, def.q, def.cat, def.tip].join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }

  let libCat = 'all';
  function renderLibrary() {
    const q = $('#libSearch').value.trim();
    const cats = GFLUX.CATEGORIES.filter((c) => c.id !== 'custom' || GFLUX.customParts.length);
    $('#libCats').innerHTML = `<button class="chip ${libCat === 'all' ? 'on' : ''}" data-cat="all">All</button>` +
      cats.map((c) => `<button class="chip w-${c.color} ${libCat === c.id ? 'on' : ''}" data-cat="${c.id}">${esc(c.name)}</button>`).join('');
    let html = '';
    for (const cat of cats) {
      if (libCat !== 'all' && libCat !== cat.id) continue;
      const list = GFLUX.allParts().filter((p) => p.cat === cat.id && partMatches(p, q));
      if (!list.length) continue;
      html += `<section class="bin"><h3><span class="bin-wire w-${cat.color}"></span>${esc(cat.name)}</h3><div class="bin-grid">`;
      for (const p of list) {
        html += `<div class="lib-item w-${cat.color}" draggable="true" data-type="${esc(p.id)}" tabindex="0" role="button" aria-label="Add ${esc(p.name)}">` +
          `<span class="lib-name" data-type="${esc(p.id)}">${esc(p.name)}</span><span class="lib-mpn">${esc(p.mpn || '')}</span>` +
          `<span class="lib-add" aria-hidden="true">+</span></div>`;
      }
      html += '</div></section>';
    }
    $('#libList').innerHTML = html || `<p class="empty">No parts match “${esc(q)}”. Try “sensor”, “screen” or “motor”, or create your own below.</p>`;
  }

  /** Nearest spot to (x, y) where a new part won't overlap existing ones,
   *  preferring the left-hand side (the drawer covers the right). */
  function freeSpot(def, x, y, near = false) {
    const boxes = state.parts.map((p) => GFLUX.partBox(p));
    const m = near ? 1 : 3;
    const fits = (px, py) => boxes.every((b) => px + def.w + m < b.x || px > b.x + b.w + m || py + def.h + m + 1 < b.y || py > b.y + b.h + m + 1);
    const cands = [];
    for (let dx = -60; dx <= 60; dx += near ? 1 : 2) for (let dy = -40; dy <= 40; dy += near ? 1 : 2) cands.push([dx, dy, Math.abs(dx) + Math.abs(dy) * (near ? 1 : 2.2) + (!near && dx > 0 ? 14 : 0)]);
    cands.sort((a, b) => a[2] - b[2]);
    for (const [dx, dy] of cands) if (fits(x + dx, y + dy)) return { x: x + dx, y: y + dy };
    return { x, y };
  }

  const drawerOpen = () => $('#drawer').classList.contains('open');
  const rightInset = (r) => (drawerOpen() && r.width > 900 ? $('#drawer').offsetWidth + 100 : 90);

  /** Pan so a part is fully visible beside the drawer. */
  function ensureVisible(inst) {
    const r = svg.getBoundingClientRect(), b = GFLUX.partBox(inst);
    const left = 70, right = r.width - rightInset(r);
    const sx0 = (b.x - 2) * G * view.k + view.x, sx1 = (b.x + b.w + 2) * G * view.k + view.x;
    const sy0 = (b.y - 3) * G * view.k + view.y, sy1 = (b.y + b.h + 3) * G * view.k + view.y;
    if (sx0 >= left && sx1 <= right && sy0 >= 10 && sy1 <= r.height - 60) return;
    view.x += (left + right) / 2 - (sx0 + sx1) / 2;
    view.y += r.height / 2 - (sy0 + sy1) / 2;
  }

  function addPart(type, at) {
    const def = GFLUX.getPart(type);
    if (!def) return;
    if (simRunning) { toast('Stop the running code to add parts.', 'warn'); return; }
    snapshot();
    let pos = at;
    if (!pos) {
      const r = svg.getBoundingClientRect();
      const c = screenToWorld(r.left + (r.width - rightInset(r)) / 2, r.top + r.height / 2);
      pos = freeSpot(def, Math.round(c.x - def.w / 2), Math.round(c.y - def.h / 2));
    }
    const inst = { uid: newId('p'), type, x: Math.round(pos.x), y: Math.round(pos.y), rot: 0 };
    if (def.custom) state.custom = Array.from(new Map(state.custom.concat([stripDef(def)]).map((p) => [p.id, p])).values());
    state.parts.push(inst);
    sel = { kind: 'part', id: inst.uid };
    if (!at) ensureVisible(inst);
    changed();
    toast(def.controller ? `Added ${def.name}.` : `Added ${def.name}. Click ⚡ on its name to wire it up, or drag from its pins.`);
  }

  const stripDef = (def) => ({ id: def.id, name: def.name, full: def.full, q: def.q, url: def.url, mpn: def.mpn, pins: def.pinList || def.pins.map((p) => p.name), board: def.board, custom: true, cat: 'custom', tip: def.tip });

  // ------------------------------------------------------ auto parts & wiring

  /** Put a 220 Ω resistor between `other` and the LED anode `led`. */
  function insertResistor(other, led, color) {
    const rdef = GFLUX.getPart('resistor');
    const pa = endPos(other), pb = endPos(led);
    const mid = { x: Math.round((pa.x + pb.x) / 2 - rdef.w / 2), y: Math.round((pa.y + pb.y) / 2) };
    const spot = freeSpot(rdef, mid.x, mid.y, true);
    // Pin 1 faces the source so the wires don't cross.
    const inst = { uid: newId('p'), type: 'resistor', x: spot.x, y: spot.y, rot: pa.x > pb.x ? 2 : 0 };
    state.parts.push(inst);
    state.wires.push({ id: newId('w'), a: refToEnd(other), b: { part: inst.uid, pin: '1' }, color, via: [] });
    state.wires.push({ id: newId('w'), a: { part: inst.uid, pin: '2' }, b: refToEnd(led), color, via: [] });
    return inst;
  }

  /** True when wiring `other` straight to an LED anode would overdrive it. */
  function needsResistor(nl, led, other) {
    if (!led || led.pt || instOf(led.uid).type !== 'led' || led.pin !== '1' || !other) return false;
    const proxies = other.pt ? ((nl.byPin.get(refKey(other)) || { pins: [] }).pins) : [other];
    return proxies.some((p) => {
      const role = GFLUX.pinRole(instOf(p.uid), p.pin);
      const net = nl.byPin.get(GFLUX.pinKey(p.uid, p.pin));
      return role.gpio != null || (role.rail && role.rail !== 'GND') || (net && (net.gpio != null || net.rails.some((r) => r !== 'GND')));
    });
  }

  function runAutowire(uid) {
    if (!GFLUX.autowire) return;
    const inst = instOf(uid), def = GFLUX.getPart(inst.type);
    const plan = GFLUX.autowire.plan(state, uid);
    if (!plan.controller) { toast('Add an ESP32 board first, then click ⚡ again.', 'warn'); return; }
    if (plan.done || !plan.steps.length) { toast(plan.message || `${def.name} is already wired.`); return; }
    snapshot();
    for (const step of plan.steps) {
      const ctl = { uid: step.to.uid, pin: step.to.pin }, mine = { uid: step.from.uid, pin: step.from.pin };
      const color = wireColor === 'auto' ? autoColor(ctl, mine) : wireColor;
      if (step.resistor && autoResistor) insertResistor(ctl, mine, color);
      else state.wires.push({ id: newId('w'), a: refToEnd(ctl), b: refToEnd(mine), color, via: [] });
    }
    sel = { kind: 'part', id: uid };
    changed();
    const skipped = (plan.skipped || []).length ? ` Skipped: ${plan.skipped.map((s) => s.why || s.pin).join('; ')}.` : '';
    toast(`Wired ${def.name}: ${plan.steps.map((s) => s.reason).join(', ')}.${skipped}`, skipped ? 'warn' : '');
  }

  // --------------------------------------------------------------- tooltip

  const tip = $('#tip');
  let tipTimer = null;
  function showPartTip(type, anchor) {
    const def = GFLUX.getPart(type);
    if (!def) return;
    clearTimeout(tipTimer);
    const cat = GFLUX.CATEGORIES.find((c) => c.id === def.cat) || GFLUX.CATEGORIES[0];
    tip.className = 'tip w-' + cat.color;
    tip.innerHTML = `<div class="tip-cat">${esc(cat.name)}</div>` +
      `<div class="tip-name">${esc(def.name)}</div><div class="tip-full">${esc(def.full)}</div>` +
      (def.tip ? `<p class="tip-help">${esc(def.tip)}</p>` : '') +
      `<a class="tip-buy" href="${esc(GFLUX.amazonUrl(def))}" target="_blank" rel="noopener noreferrer">Find it on Amazon <span aria-hidden="true">↗</span></a>`;
    tip.hidden = false;
    const ar = anchor.getBoundingClientRect(), sr = $('#stage').getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = ar.left + ar.width / 2 - tw / 2 - sr.left, y = ar.top - th - 10 - sr.top;
    if (y < 8) y = ar.bottom + 10 - sr.top;
    x = Math.max(8, Math.min(sr.width - tw - 8, x));
    tip.style.transform = `translate(${x}px, ${Math.max(8, Math.min(sr.height - th - 8, y))}px)`;
  }
  function hideTipSoon() {
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => { tip.hidden = true; }, 280);
  }
  tip.addEventListener('pointerenter', () => clearTimeout(tipTimer));
  tip.addEventListener('pointerleave', hideTipSoon);

  const pinTip = $('#pinTip');
  function showPinTip(text, level, cx, cy) {
    const sr = $('#stage').getBoundingClientRect();
    pinTip.className = 'pin-tip lvl-' + (level || 'none');
    pinTip.textContent = text;
    pinTip.hidden = false;
    pinTip.style.transform = `translate(${cx - sr.left + 16}px, ${cy - sr.top + 14}px)`;
  }

  // ---------------------------------------------------------------- canvas

  function refFromEl(el) {
    const c = el && el.closest && el.closest('.pin');
    if (!c) return null;
    if (c.dataset.pt) { const [x, y] = c.dataset.pt.split(',').map(Number); return { pt: { x, y } }; }
    return { uid: c.dataset.uid, pin: c.dataset.pin };
  }

  function startWire(from, e) {
    const nl = GFLUX.buildNets(state);
    const checks = new Map();
    for (const inst of state.parts) {
      for (const p of GFLUX.getPart(inst.type).pins) {
        const ref = { uid: inst.uid, pin: p.num };
        checks.set(refKey(ref), checkPair(nl, from, ref));
      }
    }
    for (const w of state.wires) {
      for (const end of [w.a, w.b]) {
        if (GFLUX.isPinEnd(end)) continue;
        const ref = { pt: { x: end.x, y: end.y } };
        checks.set(refKey(ref), checkPair(nl, from, ref));
      }
    }
    const fp = endPos(from);
    drag = { mode: 'wire', from, nl, via: [], checks, cursor: { x: fp.x, y: fp.y }, hover: null, moved: false, sticky: false, color: wireColor, sx: e.clientX, sy: e.clientY };
    tip.hidden = true;
    render();
  }

  function finishWire(to) {
    const res = drag.checks.get(refKey(to)) || checkPair(drag.nl, drag.from, to);
    if (res.level === 'blocked') {
      if (res.reason !== 'Same spot') toast('⚠ ' + res.reason, 'bad');
      return false;
    }
    snapshot();
    const color = drag.color === 'auto' ? autoColor(drag.from, to) : drag.color;
    const led = [drag.from, to].find((r) => !r.pt && instOf(r.uid).type === 'led' && r.pin === '1');
    const other = led === drag.from ? to : drag.from;
    if (autoResistor && led && !drag.via.length && needsResistor(drag.nl, led, other)) {
      insertResistor(other, led, color);
      toast('Added a 220 Ω resistor so the LED won\'t burn out.');
    } else {
      state.wires.push({ id: newId('w'), a: refToEnd(drag.from), b: refToEnd(to), color, via: drag.via });
      if (res.level === 'caution') toast('Heads up: ' + res.reason, 'warn');
    }
    return true;
  }

  function endWire() {
    drag = null;
    pinTip.hidden = true;
    changed();
  }

  svg.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return;
    closeMenus();
    // Clicking the canvas takes focus away from inputs, so shortcuts like Ctrl+C work.
    if (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) document.activeElement.blur();
    const world = screenToWorld(e.clientX, e.clientY);
    const ref = refFromEl(e.target);

    if (simRunning) {
      // While code runs, parts act like the real thing (press a button) and the circuit can't be edited.
      const partEl = e.target.closest('.part, .part-label');
      svg.setPointerCapture(e.pointerId);
      if (partEl) {
        drag = { mode: 'simpress', uid: partEl.dataset.uid, sx: e.clientX, sy: e.clientY };
        simHooks.press.forEach((fn) => fn(partEl.dataset.uid, true));
      } else drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
      return;
    }

    if (drag && drag.mode === 'wire' && drag.sticky) {
      if (ref) { finishWire(ref); endWire(); }
      else { drag.via.push({ x: Math.round(world.x), y: Math.round(world.y) }); render(); }
      return;
    }
    const aw = e.target.closest('.autowire');
    if (aw && e.button === 0) { runAutowire(aw.dataset.uid); return; }
    if (ref && e.button === 0) {
      svg.setPointerCapture(e.pointerId);
      startWire(ref, e);
      return;
    }
    const partEl = e.target.closest('.part, .part-label');
    if (partEl && e.button === 0) {
      const inst = instOf(partEl.dataset.uid);
      sel = { kind: 'part', id: inst.uid };
      svg.setPointerCapture(e.pointerId);
      drag = { mode: 'part', inst, ox: world.x - inst.x, oy: world.y - inst.y, moved: false };
      render();
      return;
    }
    const wireEl = e.target.closest('.wire');
    if (wireEl) {
      sel = { kind: 'wire', id: wireEl.dataset.wid };
      render();
      return;
    }
    svg.setPointerCapture(e.pointerId);
    drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
  });

  svg.addEventListener('pointermove', (e) => {
    if (!drag) {
      const label = e.target.closest && e.target.closest('.name-hit');
      if (label) showPartTip(label.parentNode.dataset.type, label); else if (!tip.matches(':hover')) hideTipSoon();
      const ref = refFromEl(e.target);
      if (ref && !ref.pt) showPinTip(refLabel(ref), 'none', e.clientX, e.clientY); else pinTip.hidden = true;
      hoverTint(e.target);
      return;
    }
    const world = screenToWorld(e.clientX, e.clientY);
    if (drag.mode === 'pan') {
      view.x = drag.vx + e.clientX - drag.sx;
      view.y = drag.vy + e.clientY - drag.sy;
      drag.moved = drag.moved || Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3;
      if (drag.moved) render();
    } else if (drag.mode === 'part') {
      const nx = Math.round(world.x - drag.ox), ny = Math.round(world.y - drag.oy);
      if (nx !== drag.inst.x || ny !== drag.inst.y) {
        if (!drag.moved) { snapshot(); drag.moved = true; }
        drag.inst.x = nx; drag.inst.y = ny;
        render();
      }
    } else if (drag.mode === 'wire') {
      drag.moved = drag.moved || Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 4;
      drag.cursor = { x: Math.round(world.x), y: Math.round(world.y) };
      const over = refFromEl(document.elementFromPoint(e.clientX, e.clientY));
      drag.hover = over && !sameRef(over, drag.from) ? over : null;
      if (drag.hover && !drag.hover.pt) {
        const res = drag.checks.get(refKey(drag.hover)) || { level: 'ok', reason: 'Connects' };
        const icon = { good: '✓', ok: '•', caution: '!', blocked: '✕' }[res.level];
        showPinTip(`${icon} ${GFLUX.pinByNum(instOf(drag.hover.uid).type, drag.hover.pin).name}: ${res.reason}`, res.level, e.clientX, e.clientY);
      } else pinTip.hidden = true;
      renderPreview();
    }
  });

  svg.addEventListener('pointerup', (e) => {
    if (!drag) return;
    if (drag.mode === 'simpress') {
      const uid = drag.uid, still = Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) < 6;
      drag = null;
      simHooks.press.forEach((fn) => fn(uid, false));
      if (still) simHooks.click.forEach((fn) => fn(uid));
      return;
    }
    if (drag.mode === 'wire') {
      if (drag.sticky) return;
      if (drag.hover) { finishWire(drag.hover); endWire(); return; }
      if (!drag.moved) { drag.sticky = true; toast('Click another pin to finish, click empty grid to add a bend, or press Esc.'); return; }
      // Let go on empty grid: leave this end of the wire loose there.
      const fp = endPos(drag.from);
      if (fp.x !== drag.cursor.x || fp.y !== drag.cursor.y) finishWire({ pt: drag.cursor });
      endWire();
      return;
    }
    if (drag.mode === 'pan' && !drag.moved) sel = null;
    if (drag.mode === 'part' && drag.moved) store.set('gflux.autosave', JSON.stringify(state));
    drag = null;
    render();
  });

  svg.addEventListener('pointerleave', () => {
    warp.ts = 0; requestGrid();
    if (!drag) { pinTip.hidden = true; hideTipSoon(); hoverHex = null; tint(null); }
  });
  svg.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    warp.tx = e.clientX - r.left; warp.ty = e.clientY - r.top; warp.ts = 1;
    requestGrid();
  });

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018));
    zoomAt(e.clientX, e.clientY, factor);
  }, { passive: false });

  function zoomAt(cx, cy, factor) {
    const r = svg.getBoundingClientRect();
    const k = Math.min(3, Math.max(0.25, view.k * factor));
    const px = cx - r.left, py = cy - r.top;
    view.x = px - ((px - view.x) / view.k) * k;
    view.y = py - ((py - view.y) / view.k) * k;
    view.k = k;
    render();
  }

  /** The view that shows the whole project. */
  function fitTarget() {
    const r = svg.getBoundingClientRect();
    if (!state.parts.length) return { x: r.width / 2, y: r.height / 2, k: 1 };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of state.parts) {
      const b = GFLUX.partBox(p);
      x0 = Math.min(x0, b.x - 2); y0 = Math.min(y0, b.y - 3); x1 = Math.max(x1, b.x + b.w + 2); y1 = Math.max(y1, b.y + b.h + 2);
    }
    for (const pts of allRoutes().values()) for (const q of pts) { x0 = Math.min(x0, q.x - 1); y0 = Math.min(y0, q.y - 1); x1 = Math.max(x1, q.x + 1); y1 = Math.max(y1, q.y + 1); }
    const left = 70, right = r.width - rightInset(r);
    const k = Math.min(1.6, Math.max(0.25, Math.min((right - left - 20) / ((x1 - x0) * G), (r.height - 100) / ((y1 - y0) * G))));
    return { k, x: (left + right) / 2 - ((x0 + x1) / 2) * G * k, y: r.height / 2 - ((y0 + y1) / 2) * G * k };
  }

  /** Smoothly glide the view to `target` (ease-out lerp). */
  function animateView(target, ms) {
    const from = Object.assign({}, view), t0 = performance.now();
    return new Promise((done) => {
      const step = (now) => {
        const t = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - t, 3);
        view = { x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, k: from.k + (target.k - from.k) * e };
        render();
        if (t < 1) requestAnimationFrame(step); else done();
      };
      requestAnimationFrame(step);
    });
  }

  function fitView() {
    const r = svg.getBoundingClientRect();
    if (!state.parts.length) { view = { x: r.width / 2, y: r.height / 2, k: 1 }; render(); return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of state.parts) {
      const b = GFLUX.partBox(p);
      x0 = Math.min(x0, b.x - 2); y0 = Math.min(y0, b.y - 3); x1 = Math.max(x1, b.x + b.w + 2); y1 = Math.max(y1, b.y + b.h + 2);
    }
    const left = 70, right = r.width - rightInset(r);
    const k = Math.min(1.6, Math.max(0.25, Math.min((right - left - 20) / ((x1 - x0) * G), (r.height - 100) / ((y1 - y0) * G))));
    view.k = k;
    view.x = (left + right) / 2 - ((x0 + x1) / 2) * G * k;
    view.y = r.height / 2 - ((y0 + y1) / 2) * G * k;
    render();
  }

  // Drop from library
  const stage = $('#stage');
  stage.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/gflux-part')) e.preventDefault(); });
  stage.addEventListener('drop', (e) => {
    const type = e.dataTransfer.getData('text/gflux-part');
    if (!type) return;
    e.preventDefault();
    const def = GFLUX.getPart(type), w = screenToWorld(e.clientX, e.clientY);
    addPart(type, { x: w.x - def.w / 2, y: w.y - def.h / 2 });
  });

  // ------------------------------------------------------------- editing

  function deleteSelection() {
    if (!sel) return;
    snapshot();
    if (sel.kind === 'part') {
      state.parts = state.parts.filter((p) => p.uid !== sel.id);
      state.wires = state.wires.filter((w) => w.a.part !== sel.id && w.b.part !== sel.id);
    } else state.wires = state.wires.filter((w) => w.id !== sel.id);
    sel = null;
    changed();
  }

  function rotateSelection() {
    if (!sel || sel.kind !== 'part') return;
    const inst = instOf(sel.id);
    snapshot();
    // Rotate about the part's centre.
    const b0 = GFLUX.partBox(inst);
    inst.rot = (inst.rot + 1) % 4;
    const b1 = GFLUX.partBox(inst);
    inst.x = Math.round(b0.x + b0.w / 2 - b1.w / 2);
    inst.y = Math.round(b0.y + b0.h / 2 - b1.h / 2);
    changed();
  }

  let clipboard = null;
  function copySelection() {
    if (!sel || sel.kind !== 'part') { toast('Select a part to copy.', 'warn'); return false; }
    const inst = instOf(sel.id);
    clipboard = { type: inst.type, rot: inst.rot, x: inst.x, y: inst.y };
    store.set('gflux.clipboard', JSON.stringify(clipboard));
    toast(`Copied ${GFLUX.getPart(inst.type).name}.`);
    return true;
  }
  function pasteClipboard() {
    if (!clipboard) { try { clipboard = JSON.parse(store.get('gflux.clipboard') || 'null'); } catch (e) { clipboard = null; } }
    const def = clipboard && GFLUX.getPart(clipboard.type);
    if (!def) { toast('Nothing to paste yet. Select a part and press Ctrl+C.', 'warn'); return; }
    snapshot();
    const spot = freeSpot(def, clipboard.x + 3, clipboard.y + 3, true);
    const inst = { uid: newId('p'), type: clipboard.type, x: spot.x, y: spot.y, rot: clipboard.rot || 0 };
    state.parts.push(inst);
    clipboard = Object.assign({}, clipboard, { x: spot.x, y: spot.y }); // the next paste steps along
    sel = { kind: 'part', id: inst.uid };
    ensureVisible(inst);
    changed();
    toast(`Pasted ${def.name}.`);
  }

  function recolorAll() {
    if (!state.wires.length) return;
    snapshot();
    const ref = (end) => (GFLUX.isPinEnd(end) ? { uid: end.part, pin: end.pin } : null);
    // Board signal wires: a clean rainbow down the headers, in pin order.
    const boardEnd = (w) => (isBoardSignal(w.a) ? w.a : isBoardSignal(w.b) ? w.b : null);
    const out = state.wires.filter(boardEnd).sort((p, q) => {
      const a = endPos(boardEnd(p)), b = endPos(boardEnd(q));
      return a.x - b.x || a.y - b.y;
    });
    out.forEach((w, i) => { w.color = RAINBOW[i % RAINBOW.length]; });
    for (const w of state.wires) if (!boardEnd(w)) w.color = autoColor(ref(w.a), ref(w.b));
    changed();
    toast('Wires recoloured: a rainbow out of the ESP32, black ground, red power.');
  }

  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(); return; }
    if (e.key === 'Escape' && openTab) { closeMenus(); return; }
    if (e.key === 'Escape' && !fin.hidden) { closeFinalize(); return; }
    if (typing) return;
    if (simRunning && !(mod && e.key.toLowerCase() === 's')) return; // stop the code to edit
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? restore(redoStack, undoStack) : restore(undoStack, redoStack); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); restore(redoStack, undoStack); return; }
    if (simRunning) return;
    if (mod && e.key.toLowerCase() === 'c') { copySelection(); return; }
    if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteClipboard(); return; }
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); if (copySelection()) pasteClipboard(); return; }
    if (e.key === 'Escape') {
      if (drag && drag.mode === 'wire') { endWire(); return; }
      sel = null; closeModal(); render();
    }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); }
    if (e.key.toLowerCase() === 'r' && !mod) rotateSelection();
  });

  // --------------------------------------------------------------- files

  function download(name, data, type = 'text/plain') {
    const blob = data instanceof Blob ? data : new Blob([data], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // Must match the project name KiCad sees, or references show as "U?".
  const fileBase = () => (GFLUX.kicad ? GFLUX.kicad.baseName(state) : (state.name || 'my-circuit').trim().replace(/[^\w\-]+/g, '-').replace(/^-+|-+$/g, '') || 'my-circuit');

  function saveProject() {
    store.set('gflux.autosave', JSON.stringify(state));
    download(fileBase() + '.gflux.json', JSON.stringify(Object.assign({ gflux: 1 }, state), null, 2), 'application/json');
    toast('Saved ' + fileBase() + '.gflux.json');
  }

  $('#fileIn').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!Array.isArray(data.parts) || !Array.isArray(data.wires)) throw new Error('not a GFLUX project');
      snapshot();
      loadState(data);
      changed();
      fitView();
      toast('Opened ' + f.name);
    } catch (err) {
      toast('Could not open that file: ' + err.message, 'bad');
    }
  });

  async function exportKicad(kind) {
    if (!GFLUX.kicad) { toast('KiCad export is still loading. Try again in a moment.', 'warn'); return; }
    const base = fileBase();
    const sch = GFLUX.kicad.schematic(state), pcb = GFLUX.kicad.pcb(state);
    const files = [];
    if (kind === 'project') {
      const zipFiles = [
        { name: `${base}/${base}.kicad_pro`, data: GFLUX.kicad.project(state) },
        { name: `${base}/${base}.kicad_sch`, data: sch },
        { name: `${base}/${base}.kicad_pcb`, data: pcb },
      ];
      if (GFLUX.codegen) zipFiles.push({ name: `${base}/${base}/${base}.ino`, data: GFLUX.codegen.sketch(state) });
      download(base + '-kicad.zip', GFLUX.kicad.zip(zipFiles));
      files.push(base + '-kicad.zip');
    } else if (bridge) {
      toast(`KiCad is building your ${kind === 'sch' ? 'schematic' : 'PCB'}…`);
      try {
        const res = await fetch(`${bridge}/api/kicad/${kind === 'sch' ? 'schematic' : 'pcb'}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: base, sch, pcb }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
        const name = `${base}-${kind === 'sch' ? 'schematic' : 'pcb'}.zip`;
        download(name, await res.blob());
        files.push(name);
      } catch (err) {
        toast('KiCad could not build it (' + err.message + '). Downloading the plain KiCad file instead.', 'warn');
      }
    }
    if (!files.length) {
      const name = `${base}.${kind === 'sch' ? 'kicad_sch' : 'kicad_pcb'}`;
      download(name, kind === 'sch' ? sch : pcb);
      files.push(name);
    }
    openExportModal(kind, files);
  }

  function openExportModal(kind, files) {
    const what = { sch: 'schematic', pcb: 'PCB', project: 'KiCad project' }[kind];
    const steps = kind === 'pcb'
      ? ['Open the <b>.kicad_pcb</b> file in KiCad\'s PCB Editor.', 'Thin lines (the "ratsnest") show which pads must connect. Draw traces along them with <kbd>X</kbd>, or use the Freerouting plugin to route them for you.', 'Modules plug into female headers, so solder headers onto the board and push your parts in.', bridge ? 'The zip already includes Gerber + drill files, ready to send to a board fab.' : 'Use File → Fabrication Outputs → Gerbers to order the board.']
      : kind === 'sch'
        ? ['Open the <b>.kicad_sch</b> file in KiCad\'s Schematic Editor (or double-click it).', 'Each part is a box. Pins with the same <b>label</b> are connected.', 'Use Tools → Update PCB from Schematic to lay out a board.', bridge ? 'The zip also has a printable PDF.' : 'File → Plot makes a printable PDF.']
        : ['Unzip and double-click the <b>.kicad_pro</b> file to open everything in KiCad.', 'The schematic and board are already linked, so edits flow both ways.', 'The <b>.ino</b> sketch opens in the Arduino IDE.'];
    showModal(`<div class="modal-wires" aria-hidden="true">${GFLUX.COLORS.map((c) => `<i class="w-${c.key}"></i>`).join('')}</div>
      <h2 id="mTitle">Your ${what} is ready</h2>
      <p class="modal-files">${files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</p>
      <ol>${steps.map((s) => `<li>${s}</li>`).join('')}</ol>
      <p class="modal-foot">${bridge ? `Made by KiCad ${esc(kicadInfo.version || '')} on this computer.` : appBase ? 'KiCad isn\'t connected yet, so these are plain KiCad files. Use the KiCad menu to find or install KiCad.' : `Open GFLUX through the <a href="${RELEASE}" target="_blank" rel="noopener">GFLUX app</a> to have KiCad make PDFs and Gerbers too.`}</p>
      <button class="btn primary" data-close>Got it</button>`);
  }

  function showModal(html) {
    tip.hidden = true;
    $('#modal').innerHTML = `<div class="modal-card" role="dialog" aria-modal="true">${html}</div>`;
    $('#modal').hidden = false;
    const focus = $('#modal [data-close], #modal .btn');
    if (focus) focus.focus();
  }
  function closeModal() { $('#modal').hidden = true; }
  $('#modal').addEventListener('click', (e) => {
    if (e.target.closest('[data-skip-gate]')) session.set('gflux.gateSkip', '1');
    if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal();
  });

  /** Opened straight from index.html (not through the GFLUX app): ask to use the app. */
  function showGate() {
    if (session.get('gflux.gateSkip')) return;
    showModal(`<img class="modal-banner" src="img/banner.png" alt="GFLUX">
      <h2>Open GFLUX with the app</h2>
      <p>GFLUX is meant to run through the <b>GFLUX app</b>. The app opens this editor for you, finds KiCad on your computer (or installs it), and turns <b>Schematic</b> and <b>PCB</b> into real KiCad files, PDFs and Gerbers.</p>
      <div class="modal-actions">
        <a class="btn primary" href="${EXE}">Download GFLUX for Windows</a>
        <a class="btn" href="http://localhost:8765/">The app is running: open it</a>
      </div>
      <p class="modal-foot">Mac or Linux? Get it from the <a href="${RELEASE}" target="_blank" rel="noopener">GFLUX release page</a>.</p>
      <div class="modal-actions"><button class="modal-skip" data-close data-skip-gate>Continue in the browser without KiCad</button></div>`);
  }

  // ------------------------------------------------- KiCad, via the GFLUX app

  let kicadInfo = { state: 'checking' };
  let installPoll = null;

  async function api(path, opts = {}, timeout = 0) {
    const ctl = new AbortController();
    const timer = timeout ? setTimeout(() => ctl.abort(), timeout) : null;
    try {
      const res = await fetch(appBase + path, Object.assign({ cache: 'no-store', signal: ctl.signal }, opts));
      const data = await res.json().catch(() => ({}));
      return { status: res.status, data };
    } finally { if (timer) clearTimeout(timer); }
  }

  /** Is this page served by the GFLUX app? Only then do we ask it about KiCad;
   *  the browser itself never goes looking for KiCad. */
  async function connectApp() {
    if (/^https?:$/.test(location.protocol)) {
      appBase = location.origin;
      try {
        const { data } = await api('/api/kicad/health', {}, 4000);
        if (data && data.bridge) { setKicad(data); return; }
      } catch (e) { /* not the app */ }
    }
    appBase = null;
    setKicad(null);
    showGate();
  }

  function setKicad(data) {
    const status = $('#kicadStatus');
    const chip = { dataset: {} }, chipText = {}; // the top-bar chip became the Finalize button
    $$('.needs-app').forEach((b) => { b.disabled = !appBase; });
    let st, text, detail = '';
    if (!appBase || !data) {
      st = 'browser'; bridge = null;
      kicadInfo = { state: st };
      chipText.textContent = 'KiCad: use the app';
      text = `Not linked to KiCad. Open GFLUX through the <a href="${RELEASE}" target="_blank" rel="noopener">GFLUX app</a> and it will find KiCad for you. Schematic and PCB still download plain KiCad files.`;
    } else if (data.install && data.install.state === 'running') {
      st = 'installing'; bridge = null;
      chipText.textContent = 'Installing KiCad…';
      text = esc(data.install.message || 'Installing KiCad…');
      watchInstall();
    } else if (data.ok) {
      st = 'ok'; bridge = appBase;
      chipText.textContent = 'KiCad ' + String(data.version || '').split(/[\s-]/)[0];
      text = `<b>KiCad ${esc(data.version || '')}</b> found${data.source ? ' (' + esc(data.source) + ')' : ''}. Schematic and PCB are made by KiCad.`;
      if (data.cli) detail = `<small>${esc(data.cli)}</small>`;
    } else {
      st = 'missing'; bridge = null;
      chipText.textContent = 'KiCad not found';
      text = 'The GFLUX app could not find KiCad on this computer.' + (data.problem ? ' ' + esc(data.problem) : '') + ' Use <b>Locate</b> if it is installed somewhere unusual, or <b>Install</b> to get it.';
      if (data.searched && data.searched.length) detail = `<small>Looked in: ${data.searched.slice(0, 4).map(esc).join(', ')}</small>`;
    }
    if (data) kicadInfo = Object.assign({ state: st }, data);
    chip.dataset.state = st;
    status.dataset.state = st;
    status.innerHTML = `<i></i><span>${text}${detail}</span>`;
  }

  function watchInstall() {
    if (installPoll) return;
    installPoll = setInterval(async () => {
      try {
        const { data: st } = await api('/api/kicad/install', {}, 4000);
        if (st.state === 'running') return;
        clearInterval(installPoll); installPoll = null;
        const { data } = await api('/api/kicad/recheck', { method: 'POST' });
        setKicad(data);
        if (data.ok) toast('KiCad is installed! Schematic and PCB now come straight from KiCad.');
        else toast(st.message || 'KiCad install did not finish.', 'bad');
      } catch (e) { /* app busy; keep polling */ }
    }, 4000);
  }

  async function kicadAction(act) {
    if (!appBase) { showGate(); return; }
    try {
      if (act === 'recheck') {
        const { data } = await api('/api/kicad/recheck', { method: 'POST' });
        setKicad(data);
        toast(data.ok ? `Found KiCad ${data.version}.` : 'KiCad still not found. Try Locate or Install.', data.ok ? '' : 'warn');
      } else if (act === 'locate') {
        toast('Pick KiCad in the window that just opened on your computer…');
        const { status, data } = await api('/api/kicad/locate', { method: 'POST' });
        if (status >= 400 && !data.bridge) { toast(data.error || 'Could not open the file picker.', 'bad'); return; }
        setKicad(data);
        toast(data.ok ? `Using KiCad ${data.version}.` : (data.error || data.problem || 'That wasn\'t a working KiCad.'), data.ok ? '' : 'warn');
      } else if (act === 'install') {
        if (kicadInfo.ok) { toast(`KiCad ${kicadInfo.version} is already installed.`); return; }
        if (!confirm('Install KiCad (free, about 1 GB) on this computer? Your system may ask for permission.')) return;
        const { status, data: st } = await api('/api/kicad/install', { method: 'POST' });
        if (status === 403) { toast('Only the GFLUX app window can install KiCad.', 'warn'); return; }
        if (st.state === 'manual') { toast(st.message, 'warn'); return; } // the app opens the download page
        if (st.state === 'done') { kicadAction('recheck'); return; }
        setKicad(Object.assign({}, kicadInfo, { ok: false, install: st }));
        toast(st.message, 'warn');
      }
    } catch (e) {
      toast('Could not reach the GFLUX app: ' + e.message, 'bad');
    }
  }

  // --------------------------------------------------------------- finalize

  const fin = $('#finalize');
  function closeFinalize() { fin.hidden = true; fin.innerHTML = ''; }

  let finalizing = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Glide to show the whole project, sweep the grid through the rainbow with
   *  rainbow screen edges, then the white review screen. */
  async function openFinalize() {
    if (finalizing || simRunning) return;
    finalizing = true;
    closeMenus();
    tip.hidden = true;
    sel = null;
    try {
      await animateView(fitTarget(), 650);
      document.body.classList.add('fin-intro');
      gridRainbow = performance.now();
      requestGrid();
      await sleep(950);
      showReview();
    } finally {
      gridRainbow = 0;
      requestGrid();
      setTimeout(() => document.body.classList.remove('fin-intro'), 200);
      finalizing = false;
    }
  }

  /** White screen with every problem in a few words, then back out or finalize. */
  function showReview() {
    const issues = GFLUX.check.run(state);
    const errors = issues.filter((i) => i.level === 'error').length, warns = issues.length - errors;
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    fin.innerHTML = `<div class="fin-card">
      <h2 class="fin-title">Finalize ${esc(state.name || 'my-circuit')}</h2>
      ${issues.length ? `<p class="fin-sub">${[errors && plural(errors, 'problem'), warns && plural(warns, 'warning')].filter(Boolean).join(' · ')}</p>
      <ul class="fin-list">${issues.map((i) => `<li class="${i.level}"${i.uid ? ` data-uid="${i.uid}"` : ''}>${esc(i.text)}</li>`).join('')}</ul>`
      : '<p class="fin-ok">No problems found</p>'}
      <div class="fin-actions">
        <button class="btn" data-fin="back">Back out</button>
        <button class="btn primary fin-go" data-fin="go">${errors ? 'Finalize anyway' : 'Finalize'}</button>
      </div></div>`;
    fin.hidden = false;
    $('[data-fin="back"]', fin).focus();
  }

  async function finalize() {
    fin.innerHTML = '<div class="fin-card"><h2 class="fin-title">Finalizing…</h2><p class="fin-sub">Building your KiCad files</p></div>';
    const base = fileBase();
    const files = { name: base, sch: GFLUX.kicad.schematic(state), pcb: GFLUX.kicad.pcb(state), pro: GFLUX.kicad.project(state), ino: GFLUX.codegen ? GFLUX.codegen.sketch(state) : undefined };
    const downloadZip = () => download(base + '-kicad.zip', GFLUX.kicad.zip([
      { name: `${base}/${base}.kicad_pro`, data: files.pro }, { name: `${base}/${base}.kicad_sch`, data: files.sch },
      { name: `${base}/${base}.kicad_pcb`, data: files.pcb }].concat(files.ino ? [{ name: `${base}/${base}/${base}.ino`, data: files.ino }] : [])));
    let line;
    if (appBase) {
      try {
        const { status, data } = await api('/api/kicad/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(files) });
        if (status >= 400) throw new Error(data.error || 'HTTP ' + status);
        line = data.opened.length
          ? `Opened the ${data.opened.map((o) => (o === 'pcb' ? 'PCB' : o)).join(' and ')} in KiCad. Saved in <code>${esc(data.folder)}</code>`
          : `Saved in <code>${esc(data.folder)}</code>. ${esc(data.problems.join('; '))}. Use the KiCad menu to find or install KiCad.`;
      } catch (e) {
        downloadZip();
        line = `The GFLUX app couldn't open KiCad (${esc(e.message)}), so the KiCad project was downloaded instead.`;
      }
    } else {
      downloadZip();
      line = `Downloaded the KiCad project. Run GFLUX through the <a href="${RELEASE}" target="_blank" rel="noopener">GFLUX app</a> to open it in KiCad automatically.`;
    }
    const shop = GFLUX.check.shoppingList(state);
    fin.innerHTML = `<div class="fin-card">
      <h2 class="fin-title">Finalized</h2>
      <p class="fin-kicad">${line}</p>
      <h3>Shopping list</h3>
      <ul class="fin-shop">${shop.map((r) => `<li><a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">
        <span class="qty">${r.qty}×</span><span class="nm">${esc(r.name)}</span><span class="buy">Amazon ↗</span><span class="full">${esc(r.full)}</span></a></li>`).join('')}</ul>
      <div class="fin-actions"><button class="btn primary" data-fin="back">Back to editor</button></div></div>`;
  }

  fin.addEventListener('click', (e) => {
    const b = e.target.closest('[data-fin]');
    if (b && b.dataset.fin === 'back') closeFinalize();
    if (b && b.dataset.fin === 'go') finalize();
    const li = e.target.closest('.fin-list li[data-uid]');
    if (li) {
      // Jump to the part with the problem.
      closeFinalize();
      const inst = instOf(li.dataset.uid);
      if (inst) { sel = { kind: 'part', id: inst.uid }; ensureVisible(inst); render(); toast(li.textContent); }
    }
  });

  // ------------------------------------------------------------------ menus

  let openTab = null;
  const topbar = $('#topbar');
  function tint(tab) {
    const t = tab || openTab;
    const hex = t ? getComputedStyle(t).getPropertyValue('--w').trim() : hoverHex;
    if (!hex) { topbar.classList.remove('tinted'); topbar.style.removeProperty('--bar'); return; }
    topbar.classList.add('tinted');
    topbar.style.setProperty('--bar', hex);
  }
  function openMenu(tab) {
    if (openTab && openTab !== tab) closeMenus();
    openTab = tab;
    tab.classList.add('open');
    $('.menu', tab).hidden = false;
    $('.tab-btn', tab).setAttribute('aria-expanded', 'true');
    tint(tab);
    tip.hidden = true;
  }
  function closeMenus() {
    if (!openTab) return;
    openTab.classList.remove('open');
    $('.menu', openTab).hidden = true;
    $('.tab-btn', openTab).setAttribute('aria-expanded', 'false');
    openTab = null;
    tint(null);
  }

  const ACTIONS = {
    new: () => {
      if (state.parts.length > 1 && !confirm('Start a new circuit? You can still Undo.')) return;
      snapshot(); loadState(freshProject()); changed(); fitView();
    },
    open: () => $('#fileIn').click(),
    save: saveProject,
    undo: () => restore(undoStack, redoStack),
    redo: () => restore(redoStack, undoStack),
    sch: () => exportKicad('sch'),
    pcb: () => exportKicad('pcb'),
    zip: () => exportKicad('project'),
    recheck: () => kicadAction('recheck'),
    locate: () => kicadAction('locate'),
    install: () => kicadAction('install'),
    recolor: recolorAll,
    finalize: openFinalize,
    copy: copySelection,
    paste: pasteClipboard,
    duplicate: () => { if (copySelection()) pasteClipboard(); },
  };

  function bindMenus() {
    $$('.tab').forEach((tab) => {
      $('.tab-btn', tab).addEventListener('click', () => (openTab === tab ? closeMenus() : openMenu(tab)));
      tab.addEventListener('pointerenter', () => { if (openTab && openTab !== tab) openMenu(tab); else tint(tab); });
      tab.addEventListener('pointerleave', () => tint(null));
    });
    document.addEventListener('pointerdown', (e) => {
      if (openTab && !e.target.closest('.tab')) closeMenus();
    });
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      if (simRunning && !['save', 'sch', 'pcb', 'zip', 'recheck', 'locate', 'install'].includes(b.dataset.act)) {
        toast('Stop the running code to change the circuit.', 'warn');
        return;
      }
      ACTIONS[b.dataset.act]();
      if (!b.closest('.menu-form')) closeMenus();
    });
  }

  // ------------------------------------------------- animation & colour menus

  function saveAnim() { store.set('gflux.anim', JSON.stringify(anim)); render(); }

  function bindAnimation() {
    const checks = { animOn: 'on', animDim: 'dim', animPower: 'power', animGround: 'ground', animSignal: 'signal' };
    for (const [id, key] of Object.entries(checks)) {
      const el = $('#' + id);
      el.checked = !!anim[key];
      el.addEventListener('change', () => { anim[key] = el.checked; saveAnim(); });
    }
    const ranges = { animSpeed: ['speed', (v) => v + '×'], animGap: ['gap', (v) => v + ' px'], animSize: ['size', (v) => v + ' px'] };
    for (const [id, [key, fmt]] of Object.entries(ranges)) {
      const el = $('#' + id), out = $('#' + id + 'Out');
      el.value = anim[key];
      out.textContent = fmt(anim[key]);
      el.addEventListener('input', () => { anim[key] = +el.value; out.textContent = fmt(anim[key]); saveAnim(); });
    }
    const seg = $('#animStyle');
    const syncSeg = () => $$('button', seg).forEach((b) => b.setAttribute('aria-checked', String(b.dataset.style === anim.style)));
    seg.addEventListener('click', (e) => { const b = e.target.closest('[data-style]'); if (b) { anim.style = b.dataset.style; syncSeg(); saveAnim(); } });
    syncSeg();
  }

  function setWireColor(c) {
    wireColor = c;
    store.set('gflux.wireColor', c);
    if (sel && sel.kind === 'wire' && c !== 'auto') {
      const w = state.wires.find((x) => x.id === sel.id);
      if (w) { snapshot(); w.color = c; changed(); }
    }
    syncColor();
  }

  function syncColor() {
    $$('#swatches button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.color === wireColor)));
    const chip = $('#colorChip');
    chip.classList.toggle('auto', wireColor === 'auto');
    chip.style.setProperty('--chip', wireColor === 'auto' ? 'transparent' : hexOf(wireColor));
  }

  function bindColor() {
    $('#swatches').innerHTML = `<button role="radio" data-color="auto" class="sw-auto">Auto</button>` +
      GFLUX.COLORS.map((c) => `<button role="radio" data-color="${c.key}" class="w-${c.key}" aria-label="${c.name}"><i></i></button>`).join('');
    $('#swatches').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setWireColor(b.dataset.color); });
    const custom = $('#customColor');
    if (wireColor[0] === '#') custom.value = wireColor;
    custom.addEventListener('input', () => setWireColor(custom.value));
    const ar = $('#autoResistor');
    ar.checked = autoResistor;
    ar.addEventListener('change', () => { autoResistor = ar.checked; store.set('gflux.autoResistor', autoResistor ? 'on' : 'off'); });
    syncColor();
  }

  const BACKGROUNDS = [['#ffffff', 'White'], ['#f7f4ec', 'Paper'], ['#eaf6ee', 'Mint'], ['#e9f2fd', 'Sky'],
    ['#f1ecfb', 'Lilac'], ['#fdeef0', 'Blush'], ['#2b303b', 'Slate'], ['#15171d', 'Night']];

  function setBg(c) {
    bgColor = c;
    store.set('gflux.bg', c);
    document.documentElement.style.setProperty('--bg', c);
    $('#bgChip').style.setProperty('--chip', c);
    $$('#bgSwatches button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.bg === c)));
    requestGrid();
  }

  function bindBackground() {
    $('#bgSwatches').innerHTML = BACKGROUNDS.map(([hex, name]) =>
      `<button role="radio" data-bg="${hex}" style="--sw:${hex};--swt:${luminance(hex) > 0.4 ? '#444' : '#ddd'}">${name}</button>`).join('');
    $('#bgSwatches').addEventListener('click', (e) => { const b = e.target.closest('[data-bg]'); if (b) setBg(b.dataset.bg); });
    const custom = $('#customBg');
    custom.value = bgColor;
    custom.addEventListener('input', () => setBg(custom.value));
    const amt = $('#warpAmt'), out = $('#warpOut');
    amt.value = warpAmt;
    out.textContent = Math.round(warpAmt * 100) + '%';
    amt.addEventListener('input', () => { warpAmt = +amt.value; store.set('gflux.warp', String(warpAmt)); out.textContent = Math.round(warpAmt * 100) + '%'; });
    setBg(bgColor);
  }

  // -------------------------------------------------- library scroll colour
  /** The library panel slides through the rainbow as you scroll it. */
  function libScrollTint() {
    const list = $('#libList');
    const max = list.scrollHeight - list.clientHeight;
    const f = max > 0 ? list.scrollTop / max : 0;
    const stops = RAINBOW.map((k) => GFLUX.colorHex(k));
    const pos = f * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(pos)), t = pos - i;
    const mix = (a, b) => Math.round(a + (b - a) * t);
    const A = parseInt(stops[i].slice(1), 16), B = parseInt(stops[i + 1].slice(1), 16);
    const rgb = [16, 8, 0].map((sh) => mix((A >> sh) & 255, (B >> sh) & 255));
    $('#drawer').style.setProperty('--lib', `rgb(${rgb.join(',')})`);
  }

  // ---------------------------------------------------------------- drawer

  function openDrawer(tab) {
    const d = $('#drawer');
    const same = d.classList.contains('open') && d.dataset.tab === tab;
    d.classList.toggle('open', !same);
    d.dataset.tab = tab;
    $$('#rail [data-tab]').forEach((b) => b.setAttribute('aria-pressed', String(!same && b.dataset.tab === tab)));
    $$('.panel').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
    if (!same && tab === 'library') setTimeout(() => $('#libSearch').focus(), 180);
  }

  // ------------------------------------------------------------------ toast

  let toastTimer = null;
  function toast(msg, kind = '') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show ' + kind;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast ' + kind; }, kind === 'bad' ? 4500 : 3400);
  }

  // ------------------------------------------------------------------ UI

  function bindUI() {
    $('#projName').addEventListener('input', (e) => { state.name = e.target.value; store.set('gflux.autosave', JSON.stringify(state)); });
    $('#btnFit').onclick = fitView;
    $('#btnZoomIn').onclick = () => { const r = svg.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.25); };
    $('#btnZoomOut').onclick = () => { const r = svg.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 0.8); };
    $('#btnRotate').onclick = rotateSelection;
    $('#btnDelete').onclick = deleteSelection;
    bindMenus();
    bindAnimation();
    bindColor();
    bindBackground();
    $('#libList').addEventListener('scroll', libScrollTint, { passive: true });

    $$('#rail [data-tab]').forEach((b) => b.addEventListener('click', () => openDrawer(b.dataset.tab)));
    $('#drawerClose').onclick = () => openDrawer($('#drawer').dataset.tab);

    $('#libSearch').addEventListener('input', renderLibrary);
    $('#libCats').addEventListener('click', (e) => {
      const b = e.target.closest('[data-cat]');
      if (b) { libCat = b.dataset.cat; renderLibrary(); }
    });
    const list = $('#libList');
    list.addEventListener('click', (e) => { const it = e.target.closest('.lib-item'); if (it) addPart(it.dataset.type); });
    list.addEventListener('keydown', (e) => { const it = e.target.closest('.lib-item'); if (it && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); addPart(it.dataset.type); } });
    list.addEventListener('dragstart', (e) => {
      const it = e.target.closest('.lib-item');
      if (!it) return;
      e.dataTransfer.setData('text/gflux-part', it.dataset.type);
      e.dataTransfer.effectAllowed = 'copy';
      tip.hidden = true;
    });
    list.addEventListener('pointerover', (e) => { const n = e.target.closest('.lib-name'); if (n) showPartTip(n.dataset.type, n); });
    list.addEventListener('pointerout', (e) => { if (e.target.closest('.lib-name')) hideTipSoon(); });

    $('#customForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const pins = String(f.get('pins')).split(',').map((s) => s.trim().replace(/[~{}"]/g, '')).filter(Boolean);
      if (!pins.length) { toast('Add at least one pin name, e.g. VCC, GND, OUT', 'warn'); return; }
      if (new Set(pins).size !== pins.length) { toast('Pin names must be different from each other.', 'warn'); return; }
      const name = String(f.get('name')).trim();
      const link = String(f.get('link')).trim();
      const def = {
        id: 'c_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') + '_' + Math.random().toString(36).slice(2, 5),
        name, full: String(f.get('full')).trim() || name, mpn: name.replace(/\s+/g, '-').slice(0, 20), pins, custom: true, cat: 'custom',
        board: GFLUX.PCB_COLORS[f.get('board')] || GFLUX.PCB_COLORS.green, art: 'chip', w: Math.max(4, pins.length + 1), h: 4,
        tip: 'Your own part.',
      };
      if (/^https?:\/\//.test(link)) def.url = link; else def.q = link || name;
      let mine = [];
      try { mine = JSON.parse(store.get('gflux.customLib') || '[]'); } catch (err) { mine = []; }
      mine.push(def);
      store.set('gflux.customLib', JSON.stringify(mine));
      GFLUX.setCustomParts(mergedCustom().concat([def]));
      e.target.reset();
      libCat = 'custom';
      renderLibrary();
      addPart(def.id);
    });

    window.addEventListener('resize', () => { render(); requestGrid(); });
  }

  // ------------------------------------------------------------------ boot

  function boot() {
    // Reveal the UI only once the stylesheet is really there (see index.html).
    if (getComputedStyle(document.documentElement).getPropertyValue('--gx-css').trim() !== '1') return;
    document.documentElement.classList.add('gx-ready');
    $('#defs').innerHTML = GFLUX.art.DEFS + $('#defs').innerHTML +
      '<radialGradient id="gx-pulse"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".35" stop-color="#fff" stop-opacity=".32"/><stop offset=".7" stop-color="#fff" stop-opacity=".1"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>';
    bindUI();
    let saved = null;
    try { saved = JSON.parse(store.get('gflux.autosave') || 'null'); } catch (e) { saved = null; }
    loadState(saved && Array.isArray(saved.parts) ? saved : freshProject());
    render();
    fitView();
    if (GFLUX.assistant) GFLUX.assistant.mount($('#assistantRoot'), { getState: () => state, toast });
    showSplash().then(connectApp);
    // Ask Chrome to keep GFLUX's saved work even when the disk gets full.
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    if (!saved) setTimeout(() => toast('Welcome to GFLUX! Open the Library on the right to add parts.'), 400);
  }

  /** Welcome screen on every start, thanking the tools GFLUX was built with. */
  function showSplash() {
    const el = document.getElementById('splash');
    if (!el) return Promise.resolve();
    el.hidden = false;
    const btn = el.querySelector('[data-splash]');
    btn.focus();
    return new Promise((done) => {
      const close = () => { el.hidden = true; document.removeEventListener('keydown', key, true); done(); };
      const key = (e) => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(); } };
      btn.addEventListener('click', close, { once: true });
      document.addEventListener('keydown', key, true);
    });
  }

  // ------------------------------------------------------- simulator hooks
  let simRunning = false;
  const simHooks = { click: [], press: [] };

  /** Replace the project (used by examples); undo brings the old one back. */
  function loadProject(next) {
    snapshot();
    loadState(JSON.parse(JSON.stringify(next)));
    changed();
    fitView();
  }

  // Exposed for tests, the Code panel and the simulator.
  window.GFLUX.app = {
    get state() { return state; },
    addPart, render, fitView, toast, runAutowire, loadProject,
    simLayer: document.getElementById('L-sim'),
    /** fn(uid) when a part is clicked while code runs. */
    onPartClick(fn) { simHooks.click.push(fn); },
    /** fn(uid, pressed) when a part is pressed / released while code runs. */
    onPartPress(fn) { simHooks.press.push(fn); },
    get isRunning() { return simRunning; },
    set isRunning(v) {
      simRunning = !!v;
      document.body.classList.toggle('sim-running', simRunning);
      if (simRunning) { sel = null; if (drag && drag.mode !== 'pan') drag = null; closeFinalize(); }
      render();
    },
  };
  boot();
})();
