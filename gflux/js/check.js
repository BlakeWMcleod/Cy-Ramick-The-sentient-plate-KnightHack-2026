/* GFLUX finalize checks: everything that would stop the circuit working,
 * each as a very short message ("GND touched PWR",
 * "Missing connection [SDA] on Text screen"). */
window.GFLUX = window.GFLUX || {};

GFLUX.check = (function () {
  const DRIVEN = /^(TRIG|IN|IN\d|DIN|CS|CLK|SCK|MOSI|RST|SCL|R|G|B|ENA|ENB|LRC|BCLK|RX|XSHUT|SIG|SD)$/;

  /** -> [{ level: 'error' | 'warn', kind: 'fault' | 'missing', text, uid? }], errors first.
   *  'fault' = something wired wrong (shown live); 'missing' = not wired yet (shown on Finalize). */
  function run(state) {
    const out = [], seen = new Set();
    const add = (level, text, uid) => {
      if (seen.has(text)) return;
      seen.add(text);
      const kind = /^(Missing connection|Unwired|No ESP32|\d* ?[Ll]oose wire)/.test(text) ? 'missing' : 'fault';
      out.push({ level, kind, text, uid });
    };
    const nl = GFLUX.buildNets(state);
    const byUid = new Map(state.parts.map((p) => [p.uid, p]));
    const nameOf = (uid) => GFLUX.getPart(byUid.get(uid).type).name;
    const pinName = (p) => GFLUX.pinByNum(byUid.get(p.uid).type, p.pin).name;

    if (!state.parts.some((p) => GFLUX.getPart(p.type).controller)) add('error', 'No ESP32 board');

    // Shorts and clashes, net by net.
    for (const net of nl.nets) {
      const roles = net.pins.map((p) => ({ p, def: GFLUX.getPart(byUid.get(p.uid).type), role: GFLUX.pinRole(byUid.get(p.uid), p.pin), name: pinName(p) }));
      const rails = new Set(roles.map((r) => r.role.rail).filter(Boolean));
      const pos = Array.from(rails).filter((r) => r !== 'GND');
      const gpios = roles.filter((r) => r.role.gpio != null);
      if (rails.has('GND') && pos.length) add('error', 'GND touched PWR');
      if (pos.length > 1) add('error', `${pos[0]} touched ${pos[1]}`);
      for (const g of gpios) if (rails.size) add('error', `${g.name} touched ${rails.has('GND') ? 'GND' : 'PWR'}`);
      if (gpios.length > 1) add('error', `${gpios[0].name} touched ${gpios[1].name}`);
      const powerIn = roles.find((r) => !r.def.passive && !r.role.source && (r.p && (r.def.pins.find((q) => q.num === r.p.pin).kind === 'v5' || r.def.pins.find((q) => q.num === r.p.pin).kind === 'v3')));
      if (powerIn && rails.has('GND') && !pos.length) add('error', `${powerIn.name} on GND [${powerIn.def.name}]`);
      if (powerIn && gpios.length && !rails.size) add('warn', `GPIO powering ${powerIn.def.name}`);
      const only3 = roles.find((r) => /^(3\.3V|3V3)$/.test(r.name) && !r.role.source);
      if (only3 && pos.some((r) => r !== '3V3')) add('error', `5V into ${only3.def.name}`);
      const ctl = gpios[0];
      if (ctl && ctl.def.inputOnly && ctl.def.inputOnly.includes(ctl.name) && roles.some((r) => !r.role.controller && DRIVEN.test(r.name))) add('error', `${ctl.name} can't output`);
      // I2C wires crossed (module SDA on the board's SCL pin or the other way round).
      if (ctl && ctl.def.i2c) {
        for (const r of roles) {
          if (r.role.controller || !/^(SDA|SCL)$/.test(r.name)) continue;
          const other = r.name === 'SDA' ? 'SCL' : 'SDA';
          if (ctl.role.gpio === ctl.def.i2c[other]) add('error', `SDA/SCL swapped [${r.def.name}]`);
        }
      }
      // HC-SR04 echo is 5 V logic.
      if (gpios.length && roles.some((r) => r.def.id === 'hcsr04' && r.name === 'ECHO')) add('warn', 'ECHO sends 5V');
    }

    // LEDs straight onto a GPIO or supply.
    for (const inst of state.parts) {
      if (inst.type !== 'led') continue;
      const net = nl.byPin.get(GFLUX.pinKey(inst.uid, '1'));
      if (net && (net.gpio != null || net.rails.some((r) => r !== 'GND'))) add('error', 'LED needs resistor', inst.uid);
    }

    // Missing connections: power, ground and every pin the code uses.
    const linked = (uid, num) => { const n = nl.byPin.get(GFLUX.pinKey(uid, num)); return !!n && n.pins.length > 1; };
    for (const inst of state.parts) {
      const def = GFLUX.getPart(inst.type);
      if (def.controller) continue;
      const pins = def.pins;
      const skip = new Set(def.noAuto || []);
      if (!pins.some((p) => linked(inst.uid, p.num))) {
        if (def.code || def.passive || def.custom) add('error', `Unwired: ${def.name}`, inst.uid);
        continue;
      }
      const need = [];
      if (def.passive && pins.length === 2) need.push(...pins);
      else if (!def.passive) {
        const gnd = pins.filter((p) => p.kind === 'gnd' && !skip.has(p.name));
        if (gnd.length && !gnd.some((p) => linked(inst.uid, p.num))) need.push(gnd[0]);
        const pwr = pins.filter((p) => (p.kind === 'v3' || p.kind === 'v5') && !skip.has(p.name) && !(def.rails && def.rails[p.name]));
        if (pwr.length && !pwr.some((p) => linked(inst.uid, p.num))) need.push(pwr[0]);
        const code = def.code ? [def.code.glob, def.code.setup, def.code.loop].join(' ') : '';
        const used = new Set(Array.from(code.matchAll(/\[\[([^\]]+)\]\]/g)).map((m) => m[1]));
        for (const p of pins) if (used.has(p.name) && !skip.has(p.name)) need.push(p);
        if (used.has('ANY') && !pins.some((p) => p.kind === 'sig' && linked(inst.uid, p.num))) need.push(pins.find((p) => p.kind === 'sig') || pins[0]);
      }
      for (const p of need) if (!linked(inst.uid, p.num)) add('error', `Missing connection [${p.name}] on ${def.name}`, inst.uid);
    }

    // Wires that end on nothing.
    const ends = new Map();
    for (const w of state.wires) for (const e of [w.a, w.b]) if (!GFLUX.isPinEnd(e)) { const k = e.x + ',' + e.y; ends.set(k, (ends.get(k) || 0) + 1); }
    const loose = Array.from(ends.values()).filter((n) => n === 1).length;
    if (loose) add('warn', loose === 1 ? 'Loose wire end' : `${loose} loose wire ends`);

    return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
  }

  /** Shopping list: one row per part type with a count and its Amazon link. */
  function shoppingList(state) {
    const rows = new Map();
    for (const inst of state.parts) {
      const def = GFLUX.getPart(inst.type);
      const row = rows.get(def.id) || { def, qty: 0 };
      row.qty++;
      rows.set(def.id, row);
    }
    return Array.from(rows.values()).map(({ def, qty }) => ({ qty, name: def.name, full: def.full, url: GFLUX.amazonUrl(def) }));
  }

  return { run, shoppingList };
})();
