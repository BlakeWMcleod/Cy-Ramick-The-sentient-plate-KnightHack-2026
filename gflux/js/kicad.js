window.GFLUX = window.GFLUX || {};

(function () {
  const G = 2.54;
  const PAPER = [['A4', 297, 210], ['A3', 420, 297], ['A2', 594, 420], ['A1', 841, 594], ['A0', 1189, 841]];
  const CHAR = 1.1;

  const q = (s) => '"' + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n') + '"';
  const n = (v) => String(Math.round(v * 10000) / 10000);
  const snap = (v) => Math.round(v / G) * G;
  const snapUp = (v) => Math.ceil(v / G - 1e-9) * G;
  const symId = (id) => String(id).replace(/[^A-Za-z0-9_.-]+/g, '_') || 'part';
  const pinName = (name, num) => String(name || num).replace(/~/g, '-').replace(/\{/g, '(').replace(/\}/g, ')') || String(num);
  const font = (size) => `(font (size ${size} ${size}))`;

  function baseName(state) {
    const s = String((state && state.name) || '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
    return s || 'gflux';
  }

  function uuid(key) {
    const h = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
    const s = String(key);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      for (let j = 0; j < 4; j++) h[j] = Math.imul(h[j] ^ c ^ (j * 0x5bd1), 0x01000193 + j * 0x2c1b3c6d) >>> 0;
    }
    for (let j = 0; j < 4; j++) {
      let x = (h[j] ^ h[(j + 1) % 4] >>> 7) >>> 0;
      x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
      x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
      h[j] = (x ^ (x >>> 16)) >>> 0;
    }
    const hex = h.map((x) => x.toString(16).padStart(8, '0')).join('');
    const v = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${v}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }

  const rootUuid = (state) => uuid('gflux-root:' + baseName(state));
  const symbolUuid = (state, inst) => uuid('gflux-sym:' + baseName(state) + ':' + inst.uid);

  function oneRow(def) {
    if (!def.pins.length) return false;
    const xs = new Set(def.pins.map((p) => p.x)), ys = new Set(def.pins.map((p) => p.y));
    if (xs.size !== 1 && ys.size !== 1) return false;
    const t = def.pins.map((p) => (xs.size === 1 ? p.y : p.x)).sort((a, b) => a - b);
    return t.every((v, i) => i === 0 || v - t[i - 1] === 1);
  }

  function footprintName(def) {
    if (def.id === 'resistor') return 'Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal';
    if (oneRow(def)) {
      const c = String(def.pins.length).padStart(2, '0');
      return `Connector_PinSocket_2.54mm:PinSocket_1x${c}_P2.54mm_Vertical`;
    }
    return 'GFLUX:' + symId(def.id);
  }

  function symbolShape(def) {
    const single = new Set(def.pins.map((p) => p.side)).size <= 1;
    const left = [], right = [];
    for (const p of def.pins) {
      if (single || p.side === 'left' || p.side === 'top') left.push(p); else right.push(p);
    }
    const rows = Math.max(left.length, right.length, 1);
    const top = Math.floor((rows - 1) / 2) * G;
    const width = (list) => list.reduce((m, p) => Math.max(m, pinName(p.name, p.num).length), 0) * CHAR;
    const inner = width(left) + width(right) + (left.length && right.length ? 2 * G : G) + 2;
    const hw = Math.max(2 * G, snapUp(inner / 2));
    const pins = [];
    left.forEach((p, i) => pins.push({ p, side: 'left', x: -hw - G, y: top - i * G }));
    right.forEach((p, i) => pins.push({ p, side: 'right', x: hw + G, y: top - i * G }));
    return { hw, bodyTop: top + G, bodyBottom: top - (rows - 1) * G - G, pins, byNum: new Map(pins.map((s) => [s.p.num, s])) };
  }

  function libSymbol(def, shape) {
    const id = symId(def.id);
    const L = [];
    L.push(`    (symbol ${q('GFLUX:' + id)} (pin_names (offset 0.508)) (in_bom yes) (on_board yes)`);
    L.push(`      (property "Reference" ${q(def.ref || 'U')} (id 0) (at 0 ${n(shape.bodyTop + 1.27)} 0) (effects ${font(1.27)}))`);
    L.push(`      (property "Value" ${q(def.mpn || def.name)} (id 1) (at 0 ${n(shape.bodyBottom - 1.27)} 0) (effects ${font(1.27)}))`);
    L.push(`      (property "Footprint" ${q(footprintName(def))} (id 2) (at 0 0 0) (effects ${font(1.27)} hide))`);
    L.push(`      (property "Datasheet" ${q(GFLUX.amazonUrl(def))} (id 3) (at 0 0 0) (effects ${font(1.27)} hide))`);
    L.push(`      (property "Description" ${q(def.full || def.name)} (id 4) (at 0 0 0) (effects ${font(1.27)} hide))`);
    L.push(`      (symbol ${q(id + '_0_1')}`);
    L.push(`        (rectangle (start ${n(-shape.hw)} ${n(shape.bodyTop)}) (end ${n(shape.hw)} ${n(shape.bodyBottom)}) (stroke (width 0.254) (type default)) (fill (type background)))`);
    L.push('      )');
    L.push(`      (symbol ${q(id + '_1_1')}`);
    for (const s of shape.pins) {
      L.push(`        (pin passive line (at ${n(s.x)} ${n(s.y)} ${s.side === 'left' ? 0 : 180}) (length ${n(G)})`
        + ` (name ${q(pinName(s.p.name, s.p.num))} (effects ${font(1.27)})) (number ${q(s.p.num)} (effects ${font(1.27)})))`);
    }
    L.push('      )');
    L.push('    )');
    return L.join('\n');
  }

  function layoutSheet(items) {
    const MARGIN = 20, GAP = 7.62, TITLE_H = 40;
    for (const [paper, pw, ph] of PAPER) {
      let x = MARGIN, y = MARGIN, rowH = 0, ok = true;
      for (const it of items) {
        if (x > MARGIN && x + it.w > pw - MARGIN) { x = MARGIN; y += rowH + GAP; rowH = 0; }
        it.ox = snapUp(x + it.left);
        it.oy = snapUp(y + it.up);
        x = it.ox + it.right + GAP;
        rowH = Math.max(rowH, it.oy + it.down - y);
        if (it.ox + it.right > pw - MARGIN) ok = false;
      }
      if (ok && y + rowH <= ph - MARGIN - TITLE_H) return { paper, w: pw, h: ph };
    }
    return { paper: 'A0', w: 1189, h: 841 };
  }

  function schematic(state) {
    const name = baseName(state);
    const root = rootUuid(state);
    const refs = GFLUX.annotate(state);
    const nl = GFLUX.buildNets(state);
    const parts = state.parts.filter((p) => GFLUX.getPart(p.type));
    const shapes = new Map();
    for (const inst of parts) if (!shapes.has(inst.type)) shapes.set(inst.type, symbolShape(GFLUX.getPart(inst.type)));

    const order = parts.slice().sort((a, b) => {
      const ra = refs.get(a.uid), rb = refs.get(b.uid);
      const ca = GFLUX.getPart(a.type).controller ? 0 : 1, cb = GFLUX.getPart(b.type).controller ? 0 : 1;
      return ca - cb || a.y - b.y || a.x - b.x || (ra < rb ? -1 : 1);
    });
    const items = order.map((inst) => {
      const def = GFLUX.getPart(inst.type), shape = shapes.get(inst.type);
      let labL = 0, labR = 0;
      for (const s of shape.pins) {
        const net = nl.byPin.get(GFLUX.pinKey(inst.uid, s.p.num));
        if (!net) continue;
        const w = G + net.name.length * CHAR + 1.5;
        if (s.side === 'left') labL = Math.max(labL, w); else labR = Math.max(labR, w);
      }
      const valueHalf = String(def.mpn || def.name).length * CHAR / 2 + 1;
      const left = Math.max(shape.hw + G + labL + (labL ? 0 : 1), valueHalf);
      const right = Math.max(shape.hw + G + labR + (labR ? 0 : 1), valueHalf);
      return { inst, def, shape, left, right, up: shape.bodyTop + 3.5, down: -shape.bodyBottom + 3.5, w: left + right };
    });
    const sheet = layoutSheet(items);

    const out = [];
    out.push(`(kicad_sch (version 20230121) (generator gflux)`);
    out.push('');
    out.push(`  (uuid ${root})`);
    out.push('');
    out.push(`  (paper ${q(sheet.paper)})`);
    out.push('');
    out.push('  (title_block');
    out.push(`    (title ${q(state.name || name)})`);
    out.push(`    (date ${q(new Date().toISOString().slice(0, 10))})`);
    out.push(`    (company "Made with GFLUX")`);
    out.push(`    (comment 1 "Nets are joined by matching labels. Footprints: see the PCB file.")`);
    out.push('  )');
    out.push('');
    out.push('  (lib_symbols');
    for (const [type, shape] of shapes) out.push(libSymbol(GFLUX.getPart(type), shape));
    out.push('  )');
    out.push('');

    const body = [], syms = [];
    for (const it of items) {
      const { inst, def, shape, ox, oy } = it;
      const ref = refs.get(inst.uid);
      const su = symbolUuid(state, inst);
      for (const s of shape.pins) {
        const px = ox + s.x, py = oy - s.y;
        const net = nl.byPin.get(GFLUX.pinKey(inst.uid, s.p.num));
        const key = inst.uid + ':' + s.p.num;
        if (!net) {
          body.push(`  (no_connect (at ${n(px)} ${n(py)}) (uuid ${uuid('nc:' + key)}))`);
          continue;
        }
        const ex = s.side === 'left' ? px - G : px + G;
        body.push(`  (wire (pts (xy ${n(px)} ${n(py)}) (xy ${n(ex)} ${n(py)})) (stroke (width 0) (type default)) (uuid ${uuid('wire:' + key)}))`);
        body.push(`  (label ${q(net.name)} (at ${n(ex)} ${n(py)} ${s.side === 'left' ? 180 : 0}) (fields_autoplaced)`
          + ` (effects ${font(1.27)} (justify ${s.side === 'left' ? 'right' : 'left'} bottom)) (uuid ${uuid('label:' + key)}))`);
      }
      const S = [];
      S.push(`  (symbol (lib_id ${q('GFLUX:' + symId(def.id))}) (at ${n(ox)} ${n(oy)} 0) (unit 1)`);
      S.push(`    (in_bom yes) (on_board yes) (dnp no)`);
      S.push(`    (uuid ${su})`);
      S.push(`    (property "Reference" ${q(ref)} (id 0) (at ${n(ox)} ${n(oy - shape.bodyTop - 1.27)} 0) (effects ${font(1.27)}))`);
      S.push(`    (property "Value" ${q(def.mpn || def.name)} (id 1) (at ${n(ox)} ${n(oy - shape.bodyBottom + 2.54)} 0) (effects ${font(1.27)}))`);
      S.push(`    (property "Footprint" ${q(footprintName(def))} (id 2) (at ${n(ox)} ${n(oy)} 0) (effects ${font(1.27)} hide))`);
      S.push(`    (property "Datasheet" ${q(GFLUX.amazonUrl(def))} (id 3) (at ${n(ox)} ${n(oy)} 0) (effects ${font(1.27)} hide))`);
      S.push(`    (property "Description" ${q(def.full || def.name)} (id 4) (at ${n(ox)} ${n(oy)} 0) (effects ${font(1.27)} hide))`);
      for (const s of shape.pins) S.push(`    (pin ${q(s.p.num)} (uuid ${uuid('pin:' + inst.uid + ':' + s.p.num)}))`);
      S.push(`    (instances (project ${q(name)} (path ${q('/' + root)} (reference ${q(ref)}) (unit 1))))`);
      S.push('  )');
      syms.push(S.join('\n'));
    }
    out.push(body.join('\n'));
    out.push('');
    out.push(syms.join('\n\n'));
    out.push('');
    out.push('  (sheet_instances');
    out.push('    (path "/" (page "1"))');
    out.push('  )');
    out.push(')');
    return out.join('\n') + '\n';
  }

  const LAYERS = [
    [0, 'F.Cu', 'signal'], [31, 'B.Cu', 'signal'],
    [32, 'B.Adhes', 'user', 'B.Adhesive'], [33, 'F.Adhes', 'user', 'F.Adhesive'],
    [34, 'B.Paste', 'user'], [35, 'F.Paste', 'user'],
    [36, 'B.SilkS', 'user', 'B.Silkscreen'], [37, 'F.SilkS', 'user', 'F.Silkscreen'],
    [38, 'B.Mask', 'user'], [39, 'F.Mask', 'user'],
    [40, 'Dwgs.User', 'user', 'User.Drawings'], [41, 'Cmts.User', 'user', 'User.Comments'],
    [42, 'Eco1.User', 'user', 'User.Eco1'], [43, 'Eco2.User', 'user', 'User.Eco2'],
    [44, 'Edge.Cuts', 'user'], [45, 'Margin', 'user'],
    [46, 'B.CrtYd', 'user', 'B.Courtyard'], [47, 'F.CrtYd', 'user', 'F.Courtyard'],
    [48, 'B.Fab', 'user'], [49, 'F.Fab', 'user'],
  ];

  function pcb(state) {
    const name = baseName(state);
    const refs = GFLUX.annotate(state);
    const nl = GFLUX.buildNets(state);
    const parts = state.parts.filter((p) => GFLUX.getPart(p.type));
    const netCode = new Map();
    nl.nets.forEach((net, i) => netCode.set(net, i + 1));

    const OUT = 0.6, CRT = 0.85;
    let minX = Infinity, minY = Infinity;
    for (const inst of parts) {
      const b = GFLUX.partBox(inst);
      minX = Math.min(minX, b.x - OUT); minY = Math.min(minY, b.y - OUT);
    }
    if (!isFinite(minX)) { minX = 0; minY = 0; }
    const dx = 30 - minX * G, dy = 30 - minY * G;
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    const grow = (x0, y0, x1, y1) => { bx0 = Math.min(bx0, x0); by0 = Math.min(by0, y0); bx1 = Math.max(bx1, x1); by1 = Math.max(by1, y1); };

    const out = [];
    out.push('(kicad_pcb (version 20221018) (generator gflux)');
    out.push('');
    out.push('  (general');
    out.push('    (thickness 1.6)');
    out.push('  )');
    out.push('');
    out.push('  (paper "A3")');
    out.push('  (title_block');
    out.push(`    (title ${q(state.name || name)})`);
    out.push(`    (date ${q(new Date().toISOString().slice(0, 10))})`);
    out.push(`    (company "Made with GFLUX")`);
    out.push('  )');
    out.push('');
    out.push('  (layers');
    for (const [id, nm, type, user] of LAYERS) out.push(`    (${id} ${q(nm)} ${type}${user ? ' ' + q(user) : ''})`);
    out.push('  )');
    out.push('');
    out.push('  (setup');
    out.push('    (pad_to_mask_clearance 0)');
    out.push('    (pcbplotparams');
    out.push('      (layerselection 0x00010fc_ffffffff)');
    out.push('      (plot_on_all_layers_selection 0x0000000_00000000)');
    out.push('      (useauxorigin false)');
    out.push('      (outputformat 1)');
    out.push('      (outputdirectory "gerbers/")');
    out.push('    )');
    out.push('  )');
    out.push('');
    out.push('  (net 0 "")');
    nl.nets.forEach((net, i) => out.push(`  (net ${i + 1} ${q(net.name)})`));
    out.push('');

    for (const inst of parts) {
      const def = GFLUX.getPart(inst.type);
      const box = GFLUX.partBox(inst);
      const ref = refs.get(inst.uid);
      const su = symbolUuid(state, inst);
      const fx = box.x * G + dx, fy = box.y * G + dy;
      const w = box.w * G, h = box.h * G;
      const t = (k) => uuid('pcb:' + inst.uid + ':' + k);
      const F = [];
      F.push(`  (footprint ${q(footprintName(def))} (layer "F.Cu")`);
      F.push(`    (tstamp ${t('fp')})`);
      F.push(`    (at ${n(fx)} ${n(fy)})`);
      F.push(`    (descr ${q(def.full || def.name)})`);
      F.push(`    (property "Sheetfile" ${q(name + '.kicad_sch')})`);
      F.push(`    (property "Sheetname" "")`);
      F.push(`    (path ${q('/' + su)})`);
      F.push('    (attr through_hole)');
      F.push(`    (fp_text reference ${q(ref)} (at ${n(w / 2)} ${n(-OUT * G - 1.2)}) (layer "F.SilkS") (tstamp ${t('ref')})`);
      F.push('      (effects (font (size 1 1) (thickness 0.15)))');
      F.push('    )');
      F.push(`    (fp_text value ${q(def.mpn || def.name)} (at ${n(w / 2)} ${n(h / 2)}) (layer "F.Fab") (tstamp ${t('val')})`);
      F.push('      (effects (font (size 1 1) (thickness 0.15)))');
      F.push('    )');
      F.push(`    (fp_rect (start ${n(-OUT * G)} ${n(-OUT * G)}) (end ${n(w + OUT * G)} ${n(h + OUT * G)})`
        + ` (stroke (width 0.12) (type solid)) (fill none) (layer "F.SilkS") (tstamp ${t('silk')}))`);
      F.push(`    (fp_rect (start ${n(-CRT * G)} ${n(-CRT * G)}) (end ${n(w + CRT * G)} ${n(h + CRT * G)})`
        + ` (stroke (width 0.05) (type solid)) (fill none) (layer "F.CrtYd") (tstamp ${t('crt')}))`);
      F.push(`    (fp_rect (start 0 0) (end ${n(w)} ${n(h)})`
        + ` (stroke (width 0.1) (type solid)) (fill none) (layer "F.Fab") (tstamp ${t('fab')}))`);
      for (const p of GFLUX.partPins(inst)) {
        const net = nl.byPin.get(GFLUX.pinKey(inst.uid, p.num));
        const shape = p.num === '1' ? 'rect' : 'circle';
        F.push(`    (pad ${q(p.num)} thru_hole ${shape} (at ${n((p.x - box.x) * G)} ${n((p.y - box.y) * G)}) (size 1.7 1.7) (drill 1)`
          + ` (layers "*.Cu" "*.Mask")${net ? ` (net ${netCode.get(net)} ${q(net.name)})` : ''}`
          + ` (pinfunction ${q(pinName(p.name, p.num))}) (pintype "passive") (tstamp ${t('pad' + p.num)}))`);
      }
      F.push('  )');
      out.push(F.join('\n'));
      out.push('');
      grow(fx - CRT * G, fy - OUT * G - 2.2, fx + w + CRT * G, fy + h + CRT * G);
    }

    if (!isFinite(bx0)) { bx0 = 30; by0 = 30; bx1 = 80; by1 = 60; }
    const M = 3, TEXT = 4;
    const ex0 = bx0 - M, ey0 = by0 - M, ex1 = bx1 + M, ey1 = by1 + M + TEXT;
    out.push(`  (gr_rect (start ${n(ex0)} ${n(ey0)}) (end ${n(ex1)} ${n(ey1)})`
      + ` (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts") (tstamp ${uuid('edge:' + name)}))`);
    out.push(`  (gr_text ${q(state.name || name)} (at ${n(ex0 + M)} ${n(ey1 - M)}) (layer "F.SilkS") (tstamp ${uuid('title:' + name)})`);
    out.push('    (effects (font (size 1.5 1.5) (thickness 0.3)) (justify left))');
    out.push('  )');
    out.push(')');
    return out.join('\n') + '\n';
  }

  function project(state) {
    const name = baseName(state);
    return JSON.stringify({
      board: { design_settings: { defaults: {}, rules: {} } },
      boards: [],
      libraries: { pinned_footprint_libs: [], pinned_symbol_libs: [] },
      meta: { filename: name + '.kicad_pro', version: 1 },
      net_settings: {
        classes: [{ name: 'Default', clearance: 0.2, track_width: 0.25, via_diameter: 0.8, via_drill: 0.4, wire_width: 6, bus_width: 12 }],
        meta: { version: 3 },
      },
      pcbnew: { last_paths: {} },
      schematic: { legacy_lib_dir: '', legacy_lib_list: [] },
      sheets: [[rootUuid(state), '']],
      text_variables: { MADE_WITH: 'GFLUX' },
    }, null, 2) + '\n';
  }

  function files(state) {
    const b = baseName(state);
    return [
      { name: b + '.kicad_pro', data: project(state) },
      { name: b + '.kicad_sch', data: schematic(state) },
      { name: b + '.kicad_pcb', data: pcb(state) },
    ];
  }

  let crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[i] = c >>> 0;
      }
    }
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function zip(list) {
    const enc = new TextEncoder();
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const chunks = [], central = [];
    let offset = 0;
    for (const f of list) {
      const nameBytes = enc.encode(f.name);
      const data = typeof f.data === 'string' ? enc.encode(f.data) : new Uint8Array(f.data);
      const crc = crc32(data);
      const head = new DataView(new ArrayBuffer(30));
      head.setUint32(0, 0x04034b50, true);
      head.setUint16(4, 20, true);
      head.setUint16(6, 0x0800, true);
      head.setUint16(8, 0, true);
      head.setUint16(10, time, true);
      head.setUint16(12, date, true);
      head.setUint32(14, crc, true);
      head.setUint32(18, data.length, true);
      head.setUint32(22, data.length, true);
      head.setUint16(26, nameBytes.length, true);
      head.setUint16(28, 0, true);
      chunks.push(new Uint8Array(head.buffer), nameBytes, data);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, time, true);
      cd.setUint16(14, date, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, data.length, true);
      cd.setUint32(24, data.length, true);
      cd.setUint16(28, nameBytes.length, true);
      cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), nameBytes);
      offset += 30 + nameBytes.length + data.length;
    }
    const cdSize = central.reduce((s, c) => s + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, list.length, true);
    end.setUint16(10, list.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    return new Blob(chunks.concat(central, [new Uint8Array(end.buffer)]), { type: 'application/zip' });
  }

  GFLUX.kicad = { schematic, pcb, project, zip, files, baseName, uuid };
})();
