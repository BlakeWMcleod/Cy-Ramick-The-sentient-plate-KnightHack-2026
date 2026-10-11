/* GFLUX editor: canvas, wiring, library drawer, top bar actions. */
(function () {
  const G = GFLUX.art.G;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } },
  };
  const newId = (p) => p + Math.random().toString(36).slice(2, 9);

  let state = null;
  let view = { x: 0, y: 0, k: 1 };
  let sel = null; // { kind: 'part' | 'wire', id }
  let drag = null;
  let wireColor = 'auto';
  let showFlow = store.get('gflux.flow') !== 'off';
  let bridge = null; // URL of the local KiCad bridge, when running
  const undoStack = [], redoStack = [];
  const artCache = new Map();

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

  /** Where a part's name tag sits (grid units): above the board, or below it
   *  when the part has header pins along its top edge. */
  function labelSpot(inst) {
    const def = GFLUX.getPart(inst.type), box = GFLUX.partBox(inst);
    const pins = GFLUX.partPins(inst);
    const below = pins.some((p) => p.side === 'top') && !pins.some((p) => p.side === 'bottom');
    return { cx: box.x + box.w / 2, cy: below ? box.y + box.h + 1.1 : box.y - 1.1, half: (def.name.length * 7.4 + 22) / 2 / G };
  }

  // Grid cells covered by boards and name tags, rebuilt only when parts move.
  let obstacleSig = '', obstacles = new Set(), bounds = null;
  function refreshObstacles() {
    const sig = state.parts.map((p) => `${p.uid}:${p.x},${p.y},${p.rot}`).join('|');
    if (sig === obstacleSig) return;
    obstacleSig = sig;
    obstacles = new Set();
    bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const inst of state.parts) {
      const b = GFLUX.partBox(inst);
      for (let x = b.x; x <= b.x + b.w; x++) for (let y = b.y; y <= b.y + b.h; y++) obstacles.add(x + ',' + y);
      const tag = labelSpot(inst), ty = Math.round(tag.cy);
      for (let x = Math.ceil(tag.cx - tag.half); x <= Math.floor(tag.cx + tag.half); x++) obstacles.add(x + ',' + ty);
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

  /** Jumper-wire route from pin a to pin b (or a cursor point), through
   *  optional via points, leaving each pin straight out of its header. */
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
      const a = GFLUX.findPin(state, w.a.part, w.a.pin), b = GFLUX.findPin(state, w.b.part, w.b.pin);
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

  // ---------------------------------------------------------------- render

  function autoColor(a, b) {
    const ra = GFLUX.pinRole(state.parts.find((p) => p.uid === a.uid), a.pin);
    const rb = GFLUX.pinRole(state.parts.find((p) => p.uid === b.uid), b.pin);
    const name = (r, ref) => GFLUX.pinByNum(state.parts.find((p) => p.uid === ref.uid).type, ref.pin).name;
    const kinds = [ra.kind, rb.kind], rails = [ra.rail, rb.rail], names = [name(ra, a), name(rb, b)];
    if (rails.includes('GND') || (kinds.includes('gnd') && !kinds.includes('passive'))) return 'K';
    if (rails.includes('3V3') || kinds.includes('v3')) return 'R';
    if (rails.some((r) => r && r !== 'GND') || kinds.includes('v5')) return 'O';
    if (names.includes('SDA')) return 'B';
    if (names.includes('SCL')) return 'Y';
    const cycle = ['G', 'V', 'I', 'W', 'B', 'Y'];
    return cycle[state.wires.length % cycle.length];
  }

  function render() {
    const nl = GFLUX.buildNets(state);
    const flows = showFlow ? GFLUX.rules.flow(state) : new Map();
    $('#world1').setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);
    $('#world2').setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);
    $('#gridPat').setAttribute('patternTransform', `translate(${view.x} ${view.y}) scale(${view.k})`);

    let parts = '', labels = '', pins = '', wires = '', flow = '';
    for (const inst of state.parts) {
      const def = GFLUX.getPart(inst.type);
      if (!artCache.has(inst.type)) artCache.set(inst.type, GFLUX.art.draw(def));
      const selected = sel && sel.kind === 'part' && sel.id === inst.uid;
      parts += `<g class="part${selected ? ' selected' : ''}" data-uid="${inst.uid}" transform="${partTransform(inst)}">${artCache.get(inst.type)}</g>`;
      const box = GFLUX.partBox(inst);
      const tag = labelSpot(inst), cx = tag.cx * G, ty = tag.cy * G;
      if (selected) labels += `<rect class="sel-box" x="${(box.x - 0.9) * G}" y="${(box.y - 0.9) * G}" width="${(box.w + 1.8) * G}" height="${(box.h + 1.8) * G}" rx="14"/>`;
      const lw = def.name.length * 7.4 + 22;
      labels += `<g class="part-label" data-uid="${inst.uid}" data-type="${esc(inst.type)}" transform="translate(${cx} ${ty})">` +
        `<rect x="${-lw / 2}" y="-10" width="${lw}" height="20" rx="10" class="cat-${def.cat}"/>` +
        `<text y="4.5" text-anchor="middle">${esc(def.name)}</text></g>`;
      for (const p of GFLUX.partPins(inst)) {
        const key = GFLUX.pinKey(inst.uid, p.num);
        let cls = 'pin';
        if (nl.byPin.has(key)) cls += ' linked';
        if (drag && drag.mode === 'wire') {
          if (drag.from.uid === inst.uid && drag.from.pin === p.num) cls += ' source';
          else cls += ' ' + drag.checks.get(key).level;
        }
        pins += `<circle class="${cls}" data-uid="${inst.uid}" data-pin="${p.num}" cx="${p.x * G}" cy="${p.y * G}" r="7"/>`;
      }
    }
    const rts = allRoutes();
    for (const w of state.wires) {
      const pts = rts.get(w.id);
      if (!pts) continue;
      const d = pathD(pts), hex = GFLUX.colorHex(w.color);
      const selected = sel && sel.kind === 'wire' && sel.id === w.id;
      const a = pts[0], z = pts[pts.length - 1];
      wires += `<g class="wire${selected ? ' selected' : ''}" data-wid="${w.id}">` +
        `<path class="w-glow" d="${d}"/><path class="w-out" d="${d}"/><path class="w-core" d="${d}" stroke="${hex}"/><path class="w-shine" d="${d}"/>` +
        `<circle class="w-tip" cx="${a.x * G}" cy="${a.y * G}" r="3.6"/><circle class="w-tip" cx="${z.x * G}" cy="${z.y * G}" r="3.6"/>` +
        `<path class="w-hit" d="${d}"/></g>`;
      const f = flows.get(w.id);
      if (f && f.dir) {
        const fd = pathD(f.dir > 0 ? pts : pts.slice().reverse());
        const dark = w.color === 'W' || w.color === 'Y';
        flow += `<path class="flow flow-${f.kind}${dark ? ' on-light' : ''}" d="${fd}"/>`;
      }
    }
    L.parts.innerHTML = parts;
    L.wires.innerHTML = wires;
    L.flow.innerHTML = flow;
    L.labels.innerHTML = labels;
    L.pins.innerHTML = pins;
    renderPreview();
    svg.classList.toggle('wiring', !!(drag && drag.mode === 'wire'));
    $('#legend').hidden = !(drag && drag.mode === 'wire');
    $('#hint').hidden = !!(drag && drag.mode === 'wire');
    $('#stats').textContent = `${state.parts.length} parts · ${state.wires.length} wires · ${Math.round(view.k * 100)}%`;
    $('#btnUndo').disabled = !undoStack.length;
    $('#btnRedo').disabled = !redoStack.length;
    renderSwatches();
  }

  function renderPreview() {
    if (!drag || drag.mode !== 'wire') { L.preview.innerHTML = ''; return; }
    const from = GFLUX.findPin(state, drag.from.uid, drag.from.pin);
    let end = drag.cursor, sideB = null;
    if (drag.hover) {
      const hp = GFLUX.findPin(state, drag.hover.uid, drag.hover.pin);
      if (hp) { end = hp; sideB = hp.side; }
    }
    if (!end) return;
    const pts = route(from, { x: end.x, y: end.y }, drag.via, from.side, sideB, routeUsed);
    const level = drag.hover ? drag.checks.get(GFLUX.pinKey(drag.hover.uid, drag.hover.pin)).level : 'none';
    const col = drag.color === 'auto' ? '#ffffff' : GFLUX.colorHex(drag.color);
    L.preview.innerHTML = `<path class="pv-out" d="${pathD(pts)}"/><path class="pv-core lvl-${level}" d="${pathD(pts)}" stroke="${col}"/>` +
      drag.via.map((v) => `<circle class="pv-via" cx="${v.x * G}" cy="${v.y * G}" r="4"/>`).join('');
  }

  function renderSwatches() {
    $$('#swatches button').forEach((b) => b.classList.toggle('on', b.dataset.color === wireColor));
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

  function addPart(type, at) {
    const def = GFLUX.getPart(type);
    if (!def) return;
    snapshot();
    let pos = at;
    if (!pos) {
      const r = svg.getBoundingClientRect();
      const c = screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
      pos = { x: c.x - def.w / 2, y: c.y - def.h / 2 };
      // Nudge so repeated adds don't stack exactly.
      const n = state.parts.filter((p) => p.type === type).length;
      pos.x += n * 2; pos.y += n * 2;
    }
    const inst = { uid: newId('p'), type, x: Math.round(pos.x), y: Math.round(pos.y), rot: 0 };
    if (def.custom) state.custom = Array.from(new Map(state.custom.concat([stripDef(def)]).map((p) => [p.id, p])).values());
    state.parts.push(inst);
    sel = { kind: 'part', id: inst.uid };
    changed();
    toast(`Added ${def.name}. Drag from its pins to wire it up.`);
  }

  const stripDef = (def) => ({ id: def.id, name: def.name, full: def.full, q: def.q, url: def.url, mpn: def.mpn, pins: def.pinList || def.pins.map((p) => p.name), board: def.board, custom: true, cat: 'custom', tip: def.tip });

  // --------------------------------------------------------------- tooltip

  const tip = $('#tip');
  let tipTimer = null;
  function showPartTip(type, anchor) {
    const def = GFLUX.getPart(type);
    if (!def) return;
    clearTimeout(tipTimer);
    const cat = GFLUX.CATEGORIES.find((c) => c.id === def.cat) || GFLUX.CATEGORIES[0];
    tip.innerHTML = `<div class="tip-cat w-${cat.color}">${esc(cat.name)}</div>` +
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

  function pinFromEl(el) {
    const c = el && el.closest && el.closest('.pin');
    return c ? { uid: c.dataset.uid, pin: c.dataset.pin } : null;
  }

  function startWire(from, e) {
    const nl = GFLUX.buildNets(state);
    const checks = new Map();
    for (const inst of state.parts) {
      for (const p of GFLUX.getPart(inst.type).pins) {
        checks.set(GFLUX.pinKey(inst.uid, p.num), GFLUX.rules.check(state, nl, from, { uid: inst.uid, pin: p.num }));
      }
    }
    const fp = GFLUX.findPin(state, from.uid, from.pin);
    drag = { mode: 'wire', from, via: [], checks, cursor: { x: fp.x, y: fp.y }, hover: null, moved: false, sticky: false, color: wireColor, sx: e.clientX, sy: e.clientY };
    tip.hidden = true;
    render();
  }

  function finishWire(to) {
    const res = drag.checks.get(GFLUX.pinKey(to.uid, to.pin));
    if (res.level === 'blocked') {
      if (res.reason !== 'Same pin') toast('⚠ ' + res.reason, 'bad');
      return false;
    }
    snapshot();
    const color = drag.color === 'auto' ? autoColor(drag.from, to) : drag.color;
    state.wires.push({ id: newId('w'), a: { part: drag.from.uid, pin: drag.from.pin }, b: { part: to.uid, pin: to.pin }, color, via: drag.via });
    if (res.level === 'caution') toast('Heads up: ' + res.reason, 'warn');
    return true;
  }

  function endWire() {
    drag = null;
    pinTip.hidden = true;
    changed();
  }

  svg.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return;
    const world = screenToWorld(e.clientX, e.clientY);
    const pin = pinFromEl(e.target);

    if (drag && drag.mode === 'wire' && drag.sticky) {
      if (pin) { finishWire(pin); endWire(); }
      else { drag.via.push({ x: Math.round(world.x), y: Math.round(world.y) }); render(); }
      return;
    }
    if (pin && e.button === 0) {
      svg.setPointerCapture(e.pointerId);
      startWire(pin, e);
      return;
    }
    const partEl = e.target.closest('.part, .part-label');
    if (partEl && e.button === 0) {
      const inst = state.parts.find((p) => p.uid === partEl.dataset.uid);
      sel = { kind: 'part', id: inst.uid };
      svg.setPointerCapture(e.pointerId);
      drag = { mode: 'part', inst, ox: world.x - inst.x, oy: world.y - inst.y, moved: false };
      render();
      return;
    }
    const wireEl = e.target.closest('.wire');
    if (wireEl) {
      sel = { kind: 'wire', id: wireEl.dataset.wid };
      if (wireColor !== 'auto') wireColor = 'auto';
      render();
      return;
    }
    svg.setPointerCapture(e.pointerId);
    drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
  });

  svg.addEventListener('pointermove', (e) => {
    if (!drag) {
      const label = e.target.closest && e.target.closest('.part-label');
      if (label) showPartTip(label.dataset.type, label); else if (!tip.matches(':hover')) hideTipSoon();
      const pin = pinFromEl(e.target);
      if (pin) {
        const inst = state.parts.find((p) => p.uid === pin.uid);
        showPinTip(`${GFLUX.pinByNum(inst.type, pin.pin).name} · ${GFLUX.getPart(inst.type).name}`, 'none', e.clientX, e.clientY);
      } else pinTip.hidden = true;
      return;
    }
    const world = screenToWorld(e.clientX, e.clientY);
    if (drag.mode === 'pan') {
      view.x = drag.vx + e.clientX - drag.sx;
      view.y = drag.vy + e.clientY - drag.sy;
      drag.moved = drag.moved || Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3;
      render();
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
      const over = pinFromEl(document.elementFromPoint(e.clientX, e.clientY));
      drag.hover = over && !(over.uid === drag.from.uid && over.pin === drag.from.pin) ? over : null;
      if (drag.hover) {
        const res = drag.checks.get(GFLUX.pinKey(drag.hover.uid, drag.hover.pin));
        const inst = state.parts.find((p) => p.uid === drag.hover.uid);
        const icon = { good: '✓', ok: '•', caution: '!', blocked: '✕' }[res.level];
        showPinTip(`${icon} ${GFLUX.pinByNum(inst.type, drag.hover.pin).name}: ${res.reason}`, res.level, e.clientX, e.clientY);
      } else pinTip.hidden = true;
      renderPreview();
    }
  });

  svg.addEventListener('pointerup', (e) => {
    if (!drag) return;
    if (drag.mode === 'wire') {
      if (drag.sticky) return;
      if (drag.hover) { finishWire(drag.hover); endWire(); return; }
      if (!drag.moved) { drag.sticky = true; toast('Click another pin to finish. Click empty grid to add a bend. Press Esc to cancel.'); return; }
      endWire();
      return;
    }
    if (drag.mode === 'pan' && !drag.moved) sel = null;
    if (drag.mode === 'part' && drag.moved) store.set('gflux.autosave', JSON.stringify(state));
    drag = null;
    render();
  });

  svg.addEventListener('pointerleave', () => { if (!drag) { pinTip.hidden = true; hideTipSoon(); } });

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

  function fitView() {
    const r = svg.getBoundingClientRect();
    if (!state.parts.length) { view = { x: r.width / 2, y: r.height / 2, k: 1 }; render(); return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of state.parts) {
      const b = GFLUX.partBox(p);
      x0 = Math.min(x0, b.x - 2); y0 = Math.min(y0, b.y - 3); x1 = Math.max(x1, b.x + b.w + 2); y1 = Math.max(y1, b.y + b.h + 2);
    }
    const leftInset = $('#drawer').classList.contains('open') && r.width > 900 ? $('#drawer').offsetWidth : 0;
    const k = Math.min(1.6, Math.max(0.25, Math.min((r.width - leftInset - 80) / ((x1 - x0) * G), (r.height - 100) / ((y1 - y0) * G))));
    view.k = k;
    view.x = leftInset + (r.width - leftInset) / 2 - ((x0 + x1) / 2) * G * k;
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

  // ------------------------------------------------------------- keyboard

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
    const inst = state.parts.find((p) => p.uid === sel.id);
    snapshot();
    // Rotate about the part's centre.
    const b0 = GFLUX.partBox(inst);
    inst.rot = (inst.rot + 1) % 4;
    const b1 = GFLUX.partBox(inst);
    inst.x = Math.round(b0.x + b0.w / 2 - b1.w / 2);
    inst.y = Math.round(b0.y + b0.h / 2 - b1.h / 2);
    changed();
  }

  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(); return; }
    if (typing) return;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? restore(redoStack, undoStack) : restore(undoStack, redoStack); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); restore(redoStack, undoStack); return; }
    if (e.key === 'Escape') {
      if (drag && drag.mode === 'wire') { endWire(); return; }
      sel = null; closeModal(); render();
    }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); }
    if (e.key.toLowerCase() === 'r' && !mod) rotateSelection();
  });

  // --------------------------------------------------------------- top bar

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
        toast('KiCad bridge failed (' + err.message + '). Downloading the plain KiCad file instead.', 'warn');
      }
    }
    if (!files.length) {
      const name = `${base}.${kind === 'sch' ? 'kicad_sch' : 'kicad_pcb'}`;
      download(name, kind === 'sch' ? sch : pcb);
      files.push(name);
    }
    openModal(kind, files);
  }

  function openModal(kind, files) {
    const what = { sch: 'schematic', pcb: 'PCB', project: 'KiCad project' }[kind];
    const steps = kind === 'pcb'
      ? ['Open the <b>.kicad_pcb</b> file in KiCad\'s PCB Editor.', 'Thin lines (the "ratsnest") show which pads must connect. Draw traces along them with <kbd>X</kbd>, or use the Freerouting plugin to route them for you.', 'Modules plug into female headers, so solder headers onto the board and push your parts in.', bridge ? 'The zip already includes Gerber + drill files, ready to send to a board fab.' : 'Use File → Fabrication Outputs → Gerbers to order the board.']
      : kind === 'sch'
        ? ['Open the <b>.kicad_sch</b> file in KiCad\'s Schematic Editor (or double-click it).', 'Each part is a box. Pins with the same <b>label</b> are connected.', 'Use Tools → Update PCB from Schematic to lay out a board.', bridge ? 'The zip also has a printable PDF.' : 'File → Plot makes a printable PDF.']
        : ['Unzip and double-click the <b>.kicad_pro</b> file to open everything in KiCad.', 'The schematic and board are already linked, so edits flow both ways.', 'The <b>.ino</b> sketch opens in the Arduino IDE.'];
    $('#modal').innerHTML = `<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="mTitle">
      <div class="modal-wires" aria-hidden="true">${GFLUX.COLORS.map((c) => `<i class="w-${c.key}"></i>`).join('')}</div>
      <h2 id="mTitle">Your ${what} is ready</h2>
      <p class="modal-files">${files.map((f) => `<code>${esc(f)}</code>`).join(' ')}</p>
      <ol>${steps.map((s) => `<li>${s}</li>`).join('')}</ol>
      <p class="modal-foot">${bridge ? `Made by KiCad ${esc(bridge.version || '')} on this computer.` : 'Don\'t have KiCad? It\'s free at <a href="https://www.kicad.org/download/" target="_blank" rel="noopener">kicad.org</a>. Run <code>python3 tools/kicad_bridge.py</code> to let GFLUX drive KiCad directly and get PDFs and Gerbers.'}</p>
      <button class="btn primary" data-close>Got it</button></div>`;
    tip.hidden = true;
    $('#modal').hidden = false;
    $('#modal [data-close]').focus();
  }
  function closeModal() { $('#modal').hidden = true; }
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal(); });

  async function detectBridge() {
    const candidates = [];
    if (/^https?:$/.test(location.protocol)) candidates.push(location.origin);
    candidates.push('http://localhost:8765');
    for (const base of candidates) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 1200);
        const res = await fetch(base + '/api/kicad/health', { signal: ctl.signal });
        clearTimeout(timer);
        const data = await res.json();
        if (data.ok) {
          bridge = Object.assign(new String(base), { version: data.version });
          $('#kicadBadge').hidden = false;
          $('#kicadBadge').title = 'KiCad ' + data.version + ' connected through the local bridge';
          $('#kicadBadge span').textContent = 'KiCad ' + (data.version || '').split(/[\s-]/)[0];
          return;
        }
      } catch (e) { /* not running */ }
    }
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
    toastTimer = setTimeout(() => { t.className = 'toast ' + kind; }, kind === 'bad' ? 4200 : 3000);
  }

  // ------------------------------------------------------------------ wiring UI

  function bindUI() {
    $('#projName').addEventListener('input', (e) => { state.name = e.target.value; store.set('gflux.autosave', JSON.stringify(state)); });
    $('#btnNew').onclick = () => {
      if (state.parts.length > 1 && !confirm('Start a new circuit? Unsaved changes will be lost (you can still Undo).')) return;
      snapshot(); loadState(freshProject()); changed(); fitView();
    };
    $('#btnOpen').onclick = () => $('#fileIn').click();
    $('#btnSave').onclick = saveProject;
    $('#btnUndo').onclick = () => restore(undoStack, redoStack);
    $('#btnRedo').onclick = () => restore(redoStack, undoStack);
    $('#btnSch').onclick = () => exportKicad('sch');
    $('#btnPcb').onclick = () => exportKicad('pcb');
    $('#btnZip').onclick = () => exportKicad('project');
    $('#btnFit').onclick = fitView;
    $('#btnZoomIn').onclick = () => { const r = svg.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.25); };
    $('#btnZoomOut').onclick = () => { const r = svg.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 0.8); };
    $('#btnRotate').onclick = rotateSelection;
    $('#btnDelete').onclick = deleteSelection;
    const flowBtn = $('#btnFlow');
    const syncFlow = () => { flowBtn.setAttribute('aria-pressed', String(showFlow)); };
    flowBtn.onclick = () => { showFlow = !showFlow; store.set('gflux.flow', showFlow ? 'on' : 'off'); syncFlow(); render(); };
    syncFlow();

    $('#swatches').innerHTML = `<button data-color="auto" class="sw-auto" title="Auto color (black = GND, red = 3V3, orange = 5V…)">Auto</button>` +
      GFLUX.COLORS.map((c) => `<button data-color="${c.key}" class="w-${c.key}" title="${c.name} wire" aria-label="${c.name} wire"><i></i></button>`).join('');
    $('#swatches').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      wireColor = b.dataset.color;
      if (sel && sel.kind === 'wire' && wireColor !== 'auto') {
        snapshot();
        state.wires.find((w) => w.id === sel.id).color = wireColor;
        changed();
      }
      renderSwatches();
    });

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

    window.addEventListener('resize', render);
  }

  // ------------------------------------------------------------------ boot

  function boot() {
    $('#defs').innerHTML = GFLUX.art.DEFS + $('#defs').innerHTML;
    bindUI();
    let saved = null;
    try { saved = JSON.parse(store.get('gflux.autosave') || 'null'); } catch (e) { saved = null; }
    loadState(saved && Array.isArray(saved.parts) ? saved : freshProject());
    render();
    fitView();
    if (GFLUX.assistant) GFLUX.assistant.mount($('#assistantRoot'), { getState: () => state, toast });
    detectBridge();
    if (!saved) setTimeout(() => toast('Welcome to GFLUX! Open the Library on the left to add parts.'), 400);
  }

  // Exposed for tests and the assistant.
  window.GFLUX.app = { get state() { return state; }, addPart, render, fitView, toast };
  boot();
})();
