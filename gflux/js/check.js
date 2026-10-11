/* GFLUX finalize checks: everything that would stop the circuit working,
 * each as a very short message ("GND touched PWR",
 * "Missing connection [SDA] on Text screen"). */
window.GFLUX = window.GFLUX || {};

GFLUX.check = (function () {
  const DRIVEN = /^(TRIG|IN|IN\d|DIN|CS|CLK|SCK|MOSI|RST|SCL|R|G|B|ENA|ENB|LRC|BCLK|RX|XSHUT|SIG|SD)$/;
  // Module pins that send a signal back to the ESP32 (at the module's supply voltage).
  const OUTPUTS = /^(ECHO|OUT|DO|AO|AOUT|TX|DT|VRX|VRY|SW|MISO|INT|SQW|BUSY|DOUT|GPIO1|IRQ|DATA)$/;
  const fmt = (v) => GFLUX.formatVolts(v);

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

    // Voltage on every net that has a supply. Soft supplies (ESP32 VIN) only
    // count when nothing else powers the net.
    const roleList = (net) => net.pins.map((p) => ({ p, inst: byUid.get(p.uid), def: GFLUX.getPart(byUid.get(p.uid).type), role: GFLUX.pinRole(byUid.get(p.uid), p.pin), name: pinName(p) }));
    const netInfo = new Map();
    for (const net of nl.nets) {
      const roles = roleList(net);
      const supplies = roles.filter((r) => r.role.source && r.role.rail !== 'GND').map((r) => ({ r, v: GFLUX.railVoltage(r.inst, r.name) }));
      const hard = supplies.filter((x) => !x.r.role.soft);
      const volts = Array.from(new Set((hard.length ? hard : supplies).map((x) => x.v).filter((v) => v != null)));
      netInfo.set(net, { roles, hard, volts, v: volts.length === 1 ? volts[0] : null });
    }
    const isPowerIn = (r) => !r.def.passive && !r.role.source && (r.def.pins.find((q) => q.num === r.p.pin).kind === 'v5' || r.def.pins.find((q) => q.num === r.p.pin).kind === 'v3');
    // Each part's supply voltage (for signals it sends back).
    const supplyOf = new Map();
    for (const info of netInfo.values()) {
      if (info.v == null) continue;
      for (const r of info.roles) if (isPowerIn(r)) supplyOf.set(r.p.uid, Math.max(supplyOf.get(r.p.uid) || 0, info.v));
    }

    // Shorts, clashes and wrong voltages, net by net.
    for (const net of nl.nets) {
      const { roles, hard, volts, v } = netInfo.get(net);
      const rails = new Set(roles.map((r) => r.role.rail).filter(Boolean));
      const pos = Array.from(rails).filter((r) => r !== 'GND');
      const gpios = roles.filter((r) => r.role.gpio != null);
      if (rails.has('GND') && pos.length) add('error', 'GND touched PWR');
      if (volts.length > 1) add('error', `${fmt(volts[0])} touched ${fmt(volts[1])}`);
      else if (hard.length > 1) add('warn', 'Two supplies joined');
      if (v != null) {
        for (const r of roles) {
          // Supply range of each powered part (ESP32 VIN too, once something else feeds it).
          const range = r.role.source ? (r.role.soft && hard.length && r.def.vin && r.def.vin[r.name]) : (isPowerIn(r) && r.def.volts);
          if (!range) continue;
          const label = r.role.soft ? `${r.def.name} ${r.name}` : r.def.name;
          if (v > range[1] + 0.05) add('error', `${fmt(v)} too high [${label}]`, r.p.uid);
          else if (v < range[0] - 0.05) add('warn', `${fmt(v)} too low [${label}]`, r.p.uid);
        }
        // Buck / boost converters: input must suit the output they're set to.
        for (const r of roles) {
          if (!r.def.converter || r.name !== 'IN+') continue;
          const out = r.inst.vout != null ? +r.inst.vout : r.def.vout;
          if (r.def.converter === 'buck' && v < out + 1.5) add('error', `Buck needs ${fmt(out + 1.5)}+ in`, r.p.uid);
          if (r.def.converter === 'boost' && v >= out) add('error', `Boost input above output`, r.p.uid);
        }
      }
      for (const g of gpios) if (rails.size) add('error', `${g.name} touched ${rails.has('GND') ? 'GND' : 'PWR'}`);
      if (gpios.length > 1) add('error', `${gpios[0].name} touched ${gpios[1].name}`);
      const powerIn = roles.find((r) => !r.def.passive && !r.role.source && (r.p && (r.def.pins.find((q) => q.num === r.p.pin).kind === 'v5' || r.def.pins.find((q) => q.num === r.p.pin).kind === 'v3')));
      if (powerIn && rails.has('GND') && !pos.length) add('error', `${powerIn.name} on GND [${powerIn.def.name}]`);
      if (powerIn && gpios.length && !rails.size) add('warn', `GPIO powering ${powerIn.def.name}`);
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
      // 5 V signals into a 3.3 V ESP32 pin.
      for (const r of roles) {
        if (!gpios.length || r.role.controller || r.def.out3v3 || !OUTPUTS.test(r.name)) continue;
        const sv = supplyOf.get(r.p.uid);
        if (sv && sv > 3.6) add('warn', `${fmt(sv)} signal on ${gpios[0].name}`, r.p.uid);
      }
    }

    // Converters set outside what they can do.
    for (const inst of state.parts) {
      const def = GFLUX.getPart(inst.type);
      if (!def.converter || inst.vout == null) continue;
      const [lo, hi] = def.voutRange;
      if (inst.vout < lo || inst.vout > hi) add('error', `${def.name} set to ${fmt(inst.vout)}`, inst.uid);
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
