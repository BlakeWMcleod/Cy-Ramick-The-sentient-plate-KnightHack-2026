/* GFLUX circuit model helpers shared by the editor, the KiCad exporter and the
 * code generators.
 *
 * Project state:
 *   { name, parts: [{ uid, type, x, y, rot }],
 *     wires: [{ id, a: { part, pin }, b: { part, pin }, color, via: [{ x, y }] }],
 * A wire's `pin` is the pin NUMBER string ("1", "2", ...), because some boards
 * have several pins with the same name (the ESP32 has two GND pins).
 *     custom: [partDef...] }
 * Coordinates are grid units (1 grid = 2.54 mm). (x, y) is the top-left of the
 * part's rotated bounding box, rot is 0..3 quarter turns clockwise.
 */
window.GFLUX = window.GFLUX || {};

GFLUX.pinKey = (uid, pin) => uid + ':' + pin;

/* A wire end is either a pin { part, pin } or a loose end on the grid { x, y }.
 * Loose ends that meet at the same grid point are connected. */
GFLUX.isPinEnd = (end) => end && end.part != null;
GFLUX.pointKey = (x, y) => 'pt:' + x + ',' + y;
GFLUX.endKey = (end) => (GFLUX.isPinEnd(end) ? GFLUX.pinKey(end.part, end.pin) : GFLUX.pointKey(end.x, end.y));

/** Size of a placed part's bounding box after rotation. */
GFLUX.partBox = function (inst) {
  const def = GFLUX.getPart(inst.type);
  const odd = (inst.rot || 0) % 2 === 1;
  return { x: inst.x, y: inst.y, w: odd ? def.h : def.w, h: odd ? def.w : def.h };
};

/** Map a local (unrotated) grid point of a part into its rotated box. */
GFLUX.rotateLocal = function (def, rot, x, y) {
  switch ((rot || 0) % 4) {
    case 1: return { x: def.h - y, y: x };
    case 2: return { x: def.w - x, y: def.h - y };
    case 3: return { x: y, y: def.w - x };
    default: return { x, y };
  }
};

const SIDE_TURN = ['top', 'right', 'bottom', 'left'];
GFLUX.rotateSide = (side, rot) => SIDE_TURN[(SIDE_TURN.indexOf(side) + (rot || 0)) % 4];

/** Pins of a placed part in world grid coordinates. */
GFLUX.partPins = function (inst) {
  const def = GFLUX.getPart(inst.type);
  if (!def) return [];
  return def.pins.map((p) => {
    const r = GFLUX.rotateLocal(def, inst.rot, p.x, p.y);
    return Object.assign({}, p, { x: inst.x + r.x, y: inst.y + r.y, side: GFLUX.rotateSide(p.side, inst.rot), uid: inst.uid });
  });
};

GFLUX.findPin = function (state, uid, num) {
  const inst = state.parts.find((p) => p.uid === uid);
  return inst ? GFLUX.partPins(inst).find((p) => p.num === num) : null;
};

/** Pin definition by number, and the first pin number with a given name. */
GFLUX.pinByNum = (type, num) => GFLUX.getPart(type).pins.find((p) => p.num === num);
GFLUX.pinNumByName = (type, name) => { const p = GFLUX.getPart(type).pins.find((q) => q.name === name); return p ? p.num : null; };

/** Electrical role of a pin on a placed part.
 *  rail: '3V3' | '5V' | 'GND' | 'VBAT' | 'VREG' when the pin is a supply/ground
 *  gpio: GPIO number for controller signal pins */
GFLUX.pinRole = function (inst, pinNum) {
  const def = GFLUX.getPart(inst.type);
  const pin = def.pins.find((p) => p.num === pinNum);
  const pinName = pin.name;
  const role = { kind: def.passive ? 'passive' : pin.kind, rail: null, gpio: null, controller: !!def.controller, source: false };
  if (def.rails && def.rails[pinName]) { role.rail = def.rails[pinName]; role.source = true; }
  else if (!def.passive && pin.kind === 'gnd') role.rail = 'GND';
  if (def.controller && def.gpio && pinName in def.gpio) role.gpio = def.gpio[pinName];
  return role;
};

/** Reference designators (U1, R1, ...): controllers first, then reading order. */
GFLUX.annotate = function (state) {
  const sorted = state.parts.slice().sort((a, b) => {
    const ca = GFLUX.getPart(a.type).controller ? 0 : 1, cb = GFLUX.getPart(b.type).controller ? 0 : 1;
    return ca - cb || a.y - b.y || a.x - b.x;
  });
  const count = {}, refs = new Map();
  for (const inst of sorted) {
    const prefix = GFLUX.getPart(inst.type).ref || 'U';
    count[prefix] = (count[prefix] || 0) + 1;
    refs.set(inst.uid, prefix + count[prefix]);
  }
  return refs;
};

/** Group connected pins into nets.
 *  Returns { nets: [{ name, pins: [{ uid, pin }], rails: [...], gpio }], byPin: Map(pinKey -> net) } */
GFLUX.buildNets = function (state) {
  const parent = new Map();
  const find = (k) => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
  const add = (k) => { if (!parent.has(k)) parent.set(k, k); };
  const uids = new Set(state.parts.map((p) => p.uid));
  const alive = (end) => !GFLUX.isPinEnd(end) || uids.has(end.part);
  for (const w of state.wires) {
    if (!alive(w.a) || !alive(w.b)) continue;
    const ka = GFLUX.endKey(w.a), kb = GFLUX.endKey(w.b);
    add(ka); add(kb);
    parent.set(find(ka), find(kb));
  }
  const groups = new Map();
  for (const k of parent.keys()) {
    const r = find(k);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(k);
  }
  const byUid = new Map(state.parts.map((p) => [p.uid, p]));
  const multiCtl = state.parts.filter((p) => GFLUX.getPart(p.type).controller).length > 1;
  const refs = GFLUX.annotate(state);
  const nets = [], byPin = new Map(), used = new Map();
  let anon = 0;
  for (const keys of groups.values()) {
    // Loose wire ends join nets but aren't pins themselves.
    const pins = keys.filter((k) => !k.startsWith('pt:')).map((k) => { const i = k.indexOf(':'); return { uid: k.slice(0, i), pin: k.slice(i + 1) }; });
    if (!pins.length) continue;
    const rails = new Set(); let gpio = null, ctlName = null;
    for (const p of pins) {
      const role = GFLUX.pinRole(byUid.get(p.uid), p.pin);
      if (role.rail) rails.add(role.rail);
      if (role.gpio != null && gpio == null) { gpio = role.gpio; ctlName = (multiCtl ? refs.get(p.uid) + '_' : '') + GFLUX.pinByNum(byUid.get(p.uid).type, p.pin).name; }
    }
    let name;
    const sourceRail = pins.map((p) => GFLUX.pinRole(byUid.get(p.uid), p.pin)).find((r) => r.source && r.rail !== 'GND');
    if (rails.has('GND')) name = 'GND';
    else if (sourceRail) name = sourceRail.rail;
    else if (ctlName) name = ctlName;
    else name = 'NET' + (++anon);
    const n = (used.get(name) || 0) + 1; used.set(name, n);
    const net = { name: n > 1 ? name + '_' + n : name, pins, rails: Array.from(rails), gpio };
    nets.push(net);
    for (const k of keys) byPin.set(k, net);
  }
  return { nets, byPin };
};

/** GPIO number driving a part pin (by number), looking through one series
 *  resistor (so LED -> 220R -> D5 still resolves to 5). */
GFLUX.gpioFor = function (state, nl, uid, pinNum) {
  const net = nl.byPin.get(GFLUX.pinKey(uid, pinNum));
  if (!net) return null;
  if (net.gpio != null) return net.gpio;
  for (const p of net.pins) {
    const inst = state.parts.find((q) => q.uid === p.uid);
    if (!inst || inst.type !== 'resistor' || p.uid === uid) continue;
    const other = p.pin === '1' ? '2' : '1';
    const far = nl.byPin.get(GFLUX.pinKey(p.uid, other));
    if (far && far.gpio != null) return far.gpio;
  }
  return null;
};

/** Short human description of the circuit, used by the assistant and code comments. */
GFLUX.describeCircuit = function (state) {
  const refs = GFLUX.annotate(state);
  const nl = GFLUX.buildNets(state);
  const byUid = new Map(state.parts.map((p) => [p.uid, p]));
  const lines = ['Parts:'];
  for (const inst of state.parts) {
    const def = GFLUX.getPart(inst.type);
    lines.push(`- ${refs.get(inst.uid)} ${def.name} (${def.full}) pins: ${def.pins.map((p) => p.name).join(', ')}`);
  }
  lines.push('Connections (nets):');
  if (!nl.nets.length) lines.push('- none yet');
  for (const net of nl.nets) {
    const members = net.pins.map((p) => `${refs.get(p.uid)}.${GFLUX.pinByNum(byUid.get(p.uid).type, p.pin).name}`).join(' <-> ');
    lines.push(`- ${net.name}${net.gpio != null ? ' (GPIO' + net.gpio + ')' : ''}: ${members}`);
  }
  return lines.join('\n');
};
