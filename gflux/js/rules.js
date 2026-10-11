/* GFLUX wiring rules: which pins a new wire may go to without breaking
 * anything, and which way current flows along each wire (for animation). */
window.GFLUX = window.GFLUX || {};

GFLUX.rules = (function () {
  // Module pins the ESP32 drives (so input-only GPIOs can't serve them).
  const DRIVEN = /^(TRIG|IN|IN\d|DIN|CS|CLK|SCK|MOSI|RST|SCL|R|G|B|ENA|ENB|LRC|BCLK|RX|XSHUT|SIG|SD)$/;
  // Module pins that send data to the ESP32.
  const OUTPUTS = /^(ECHO|OUT|DO|AO|AOUT|TX|DT|VRX|VRY|SW|MISO|INT|SQW|BUSY|DOUT|GPIO1|IRQ|DATA|32K)$/;
  const POSITIVE = (rail) => rail && rail !== 'GND';
  // Two-pin parts that conduct straight through (for tracing current).
  const CONDUCTORS = { resistor: [['1', '2']], led: [['1', '2']], button: [['1', '2']], dcmotor: [['1', '2']], speaker: [['1', '2']], slideswitch: [['2', '1'], ['2', '3']] };

  function info(state, uid, num) {
    const inst = state.parts.find((p) => p.uid === uid);
    const def = GFLUX.getPart(inst.type);
    const pin = def.pins.find((p) => p.num === num);
    const role = GFLUX.pinRole(inst, num);
    return { inst, def, pin, role, label: `${def.name} ${pin.name}` };
  }

  /** All pins electrically joined to `ref` (including itself). */
  function members(state, nl, ref) {
    const net = nl.byPin.get(GFLUX.pinKey(ref.uid, ref.pin));
    return net ? net.pins : [{ uid: ref.uid, pin: ref.pin }];
  }

  /** How safe is a wire from pin `a` to pin `b`?
   *  -> { level: 'good' | 'ok' | 'caution' | 'blocked', reason } */
  function check(state, nl, a, b) {
    if (a.uid === b.uid && a.pin === b.pin) return { level: 'blocked', reason: 'Same pin' };
    const na = nl.byPin.get(GFLUX.pinKey(a.uid, a.pin));
    if (na && na === nl.byPin.get(GFLUX.pinKey(b.uid, b.pin))) return { level: 'blocked', reason: 'Already connected' };

    const A = info(state, a.uid, a.pin), B = info(state, b.uid, b.pin);
    const all = members(state, nl, a).concat(members(state, nl, b)).map((m) => info(state, m.uid, m.pin));
    const rails = new Set(all.map((m) => m.role.rail).filter(Boolean));
    const positives = Array.from(rails).filter(POSITIVE);
    const gpios = all.filter((m) => m.role.gpio != null);
    const powerIns = all.filter((m) => !m.def.passive && !m.role.source && (m.pin.kind === 'v5' || m.pin.kind === 'v3'));

    if (rails.has('GND') && positives.length) return { level: 'blocked', reason: `Short circuit! ${positives[0]} would connect straight to GND` };
    if (positives.length > 1) return { level: 'blocked', reason: `Connects two different supplies (${positives.join(' + ')})` };
    if (gpios.length && rails.size) return { level: 'blocked', reason: `${gpios[0].pin.name} would be tied to ${Array.from(rails)[0]}; the pin could burn out` };
    if (powerIns.length && rails.has('GND')) return { level: 'blocked', reason: `${powerIns[0].label} is a power pin; wiring it to GND does nothing` };
    const only3v3 = all.find((m) => /^(3\.3V|3V3)$/.test(m.pin.name) && !m.role.source);
    if (only3v3 && positives.some((r) => r !== '3V3')) return { level: 'blocked', reason: `${only3v3.def.name} is 3.3 V only. Use the 3V3 pin` };

    if (gpios.length > 1) return { level: 'caution', reason: 'Ties two ESP32 pins together' };
    if (powerIns.length && gpios.length) return { level: 'caution', reason: 'Powering a module from a GPIO. Use 3V3 or VIN instead' };
    const ctl = gpios[0];
    const special = all.find((m) => m.def.caution && m.def.caution[m.pin.name]);
    if (special) return { level: 'caution', reason: special.def.caution[special.pin.name] };
    const mod = A.role.gpio != null ? B : A;
    if (ctl && ctl.def.inputOnly && ctl.def.inputOnly.includes(ctl.pin.name) && DRIVEN.test(mod.pin.name)) {
      return { level: 'caution', reason: `${ctl.pin.name} is input-only and can't drive ${mod.pin.name}` };
    }
    const sigOnRail = all.find((m) => !m.def.passive && m.pin.kind === 'sig' && !m.role.controller);
    if (sigOnRail && rails.size) return { level: 'caution', reason: `${sigOnRail.label} is a signal pin tied to ${Array.from(rails)[0]}` };

    // Good matches: power to supply, ground to ground, signal to GPIO.
    const pair = [A, B];
    const has = (fn) => pair.some(fn);
    if (has((m) => m.role.source)) {
      const src = pair.find((m) => m.role.source), other = pair.find((m) => m !== src);
      if (src.role.rail === 'GND' && other.pin.kind === 'gnd') return { level: 'good', reason: 'Ground to ground' };
      if (POSITIVE(src.role.rail) && (other.pin.kind === 'v5' || other.pin.kind === 'v3')) return { level: 'good', reason: `Power from ${src.pin.name}` };
    }
    if (ctl && mod && mod.def.controller !== true) {
      if (mod.pin.name === 'SDA' || mod.pin.name === 'SCL') {
        const want = ctl.def.i2c && ctl.def.i2c[mod.pin.name];
        return want === ctl.role.gpio ? { level: 'good', reason: `Default I2C ${mod.pin.name} pin` } : { level: 'ok', reason: `Works, but GPIO${want} is the usual ${mod.pin.name}` };
      }
      if (mod.pin.kind === 'sig' || mod.def.passive) return { level: 'good', reason: `Signal to GPIO${ctl.role.gpio}` };
    }
    if (A.def.passive || B.def.passive) return { level: 'ok', reason: 'Connects' };
    if (A.pin.kind === 'gnd' && B.pin.kind === 'gnd') return { level: 'good', reason: 'Ground to ground' };
    return { level: 'ok', reason: 'Connects' };
  }

  /** Current direction per wire.
   *  -> Map(wireId -> { kind: 'power' | 'ground' | 'signal', dir: 1 (a->b) | -1 | 0 }) */
  function flow(state) {
    const nl = GFLUX.buildNets(state);
    const adj = new Map();
    const link = (k1, k2, w) => {
      if (!adj.has(k1)) adj.set(k1, []);
      if (!adj.has(k2)) adj.set(k2, []);
      adj.get(k1).push([k2, w]); adj.get(k2).push([k1, w]);
    };
    for (const w of state.wires) link(GFLUX.pinKey(w.a.part, w.a.pin), GFLUX.pinKey(w.b.part, w.b.pin), w.id);
    for (const inst of state.parts) {
      for (const [p, q] of CONDUCTORS[inst.type] || []) link(GFLUX.pinKey(inst.uid, p), GFLUX.pinKey(inst.uid, q), null);
    }
    // Sources: positive supplies, plus whichever end drives each signal net.
    const sources = [], grounds = [];
    const byUid = new Map(state.parts.map((p) => [p.uid, p]));
    for (const net of nl.nets) {
      const roles = net.pins.map((p) => ({ p, inst: byUid.get(p.uid), role: GFLUX.pinRole(byUid.get(p.uid), p.pin) }));
      for (const r of roles) {
        if (r.role.source && POSITIVE(r.role.rail)) sources.push(GFLUX.pinKey(r.p.uid, r.p.pin));
        if (r.role.source && r.role.rail === 'GND') grounds.push(GFLUX.pinKey(r.p.uid, r.p.pin));
      }
      if (net.rails.length) continue;
      const outs = roles.filter((r) => !r.role.controller && OUTPUTS.test(GFLUX.pinByNum(r.inst.type, r.p.pin).name));
      const drivers = outs.length ? outs : roles.filter((r) => r.role.gpio != null);
      for (const r of drivers) sources.push(GFLUX.pinKey(r.p.uid, r.p.pin));
    }
    const bfs = (starts) => {
      const dist = new Map(starts.map((k) => [k, 0]));
      const queue = starts.slice();
      while (queue.length) {
        const k = queue.shift();
        for (const [n] of adj.get(k) || []) if (!dist.has(n)) { dist.set(n, dist.get(k) + 1); queue.push(n); }
      }
      return dist;
    };
    const fromSrc = bfs(sources), toGnd = bfs(grounds);
    const out = new Map();
    for (const w of state.wires) {
      const ka = GFLUX.pinKey(w.a.part, w.a.pin), kb = GFLUX.pinKey(w.b.part, w.b.pin);
      const net = nl.byPin.get(ka);
      const kind = !net ? 'signal' : net.rails.includes('GND') ? 'ground' : net.rails.some(POSITIVE) ? 'power' : 'signal';
      let dir = 0;
      const da = fromSrc.get(ka), db = fromSrc.get(kb);
      if (kind === 'ground' || da == null || db == null || da === db) {
        const ga = toGnd.get(ka), gb = toGnd.get(kb);
        if (kind === 'ground' && ga != null && gb != null && ga !== gb) dir = ga > gb ? 1 : -1;
        else if (da != null && db != null && da !== db) dir = da < db ? 1 : -1;
      } else dir = da < db ? 1 : -1;
      out.set(w.id, { kind, dir });
    }
    return out;
  }

  return { check, flow };
})();
