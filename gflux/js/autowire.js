window.GFLUX = window.GFLUX || {};

GFLUX.autowire = (function () {
  const ANALOG = /^(AO|AOUT|VRX|VRY)$/;
  const OUTPUTS = /^(ECHO|OUT|DO|AO|AOUT|TX|DT|VRX|VRY|MISO|INT|SQW|BUSY|DOUT|GPIO1|IRQ|32K)$/;
  const SPECIAL = { led: true, button: true, pot: true };

  const isCustom = (def) => def.cat === 'custom' || (GFLUX.customParts || []).some((p) => p.id === def.id);
  const dist2 = (a, b) => (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);

  function center(inst) {
    const b = GFLUX.partBox(inst);
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  }

  function nearestController(state, inst) {
    const c = center(inst);
    let best = null, bestD = Infinity;
    for (const p of state.parts) {
      const def = GFLUX.getPart(p.type);
      if (!def || !def.controller || p.uid === inst.uid) continue;
      const d = dist2(center(p), c);
      if (d < bestD) { best = p; bestD = d; }
    }
    return best;
  }

  function placeholders(def) {
    const keys = [];
    if (!def.code) return keys;
    for (const k of ['inc', 'glob', 'setup', 'loop']) {
      const src = [].concat(def.code[k] || []).join('\n');
      src.replace(/\[\[([^\[\]\s]+)\]\]/g, (m, key) => { if (key !== 'n' && !keys.includes(key)) keys.push(key); return m; });
    }
    return keys;
  }

  function busRole(def, name) {
    const has = (n) => def.pins.some((p) => p.name === n);
    if (has('SCK') && (has('MOSI') || has('MISO')) && /^(SCK|MISO|MOSI)$/.test(name)) return 'SPI ' + name;
    if (!has('SCK') && (name === 'SDA' || name === 'SCL')) return 'I2C ' + name;
    return null;
  }

  function plan(state, uid) {
    const out = { controller: null, steps: [], skipped: [], done: false, message: '' };
    const inst = state.parts.find((p) => p.uid === uid);
    const def = inst && GFLUX.getPart(inst.type);
    if (!def) { out.message = 'Part not found'; return out; }
    if (def.controller) { out.message = 'Boards are what other parts get wired to.'; return out; }
    const ctl = nearestController(state, inst);
    if (!ctl) { out.message = 'Add an ESP32 board first, then auto-wire.'; return out; }
    out.controller = ctl.uid;
    if (!def.code && !SPECIAL[def.id] && !isCustom(def)) {
      out.message = `${def.name} has nothing to wire automatically. Wire it by hand.`;
      return out;
    }

    const cdef = GFLUX.getPart(ctl.type);
    const byUid = new Map(state.parts.map((p) => [p.uid, p]));
    const noAuto = new Set(def.noAuto || []);
    const caution = cdef.caution || {};
    const inputOnly = cdef.inputOnly || [];
    const gpioName = (g) => Object.keys(cdef.gpio || {}).find((k) => cdef.gpio[k] === g);
    const i2c = {};
    for (const k of ['SDA', 'SCL']) if (cdef.i2c && cdef.i2c[k] != null) i2c[k] = gpioName(cdef.i2c[k]);
    const reserved = new Set([].concat(cdef.adc || [], Object.values(cdef.spi || {}), Object.values(i2c), Object.values(cdef.uart || {})));

    const hyp = { parts: state.parts, wires: state.wires.slice() };
    let nl = GFLUX.buildNets(hyp);
    const connected = (u, num) => nl.byPin.has(GFLUX.pinKey(u, num));
    const ctlNum = (name) => GFLUX.pinNumByName(ctl.type, name);
    const free = (name) => { const n = ctlNum(name); return n != null && !connected(ctl.uid, n); };
    const gpioLabel = (name) => 'GPIO' + cdef.gpio[name];

    let wanted = 0, open = 0;

    function addStep(pin, toNum, reason, opts) {
      opts = opts || {};
      const from = { uid, pin: pin.num }, to = { uid: ctl.uid, pin: toNum };
      const res = GFLUX.rules.check(hyp, nl, from, to);
      if (res.level === 'blocked') { out.skipped.push({ pin: pin.name, why: res.reason }); return; }
      if (res.level === 'caution' && !opts.quiet) reason += ` (careful: ${res.reason})`;
      out.steps.push({ from, to, resistor: !!opts.resistor, reason });
      hyp.wires.push({ id: 'autowire-' + hyp.wires.length, a: { part: uid, pin: pin.num }, b: { part: ctl.uid, pin: toNum }, color: 'G', via: [] });
      nl = GFLUX.buildNets(hyp);
    }

    function pickGpio(output) {
      const order = (cdef.autoOrder || Object.keys(cdef.gpio || {})).slice();
      if (output) for (const n of inputOnly) if (!order.includes(n)) order.push(n);
      const tier = (n) => (caution[n] ? 2 : 0) + (reserved.has(n) ? 1 : 0);
      const rank = (n) => tier(n) * 2 + (output && inputOnly.includes(n) ? 0 : 1);
      const cands = order
        .filter((n) => cdef.gpio[n] != null && (output || !inputOnly.includes(n)) && free(n))
        .map((n, i) => ({ n, i }))
        .sort((a, b) => rank(a.n) - rank(b.n) || a.i - b.i);
      return cands.length ? cands[0].n : null;
    }

    function wireGpio(pin, output, note, opts) {
      const name = pickGpio(output);
      if (!name) { out.skipped.push({ pin: pin.name, why: `No free GPIO pin left on the board` }); return; }
      addStep(pin, ctlNum(name), gpioLabel(name) + (note ? ` (${note})` : ''), opts);
    }

    function busPin(role) {
      for (const cp of cdef.pins) {
        const net = nl.byPin.get(GFLUX.pinKey(ctl.uid, cp.num));
        if (!net || cdef.gpio[cp.name] == null) continue;
        const shares = net.pins.some((m) => {
          if (m.uid === ctl.uid) return false;
          const d = GFLUX.getPart(byUid.get(m.uid).type);
          return busRole(d, GFLUX.pinByNum(d.id, m.pin).name) === role;
        });
        if (shares) return cp.name;
      }
      const [bus, sig] = role.split(' ');
      const dflt = bus === 'I2C' ? i2c[sig] : cdef.spi && cdef.spi[sig];
      return dflt && free(dflt) ? dflt : null;
    }

    function wireSignal(pin) {
      const name = pin.name;
      const output = OUTPUTS.test(name);
      if (def.id === 'led') return wireGpio(pin, false, 'with a 220 Ω resistor', { resistor: true });
      const role = busRole(def, name);
      if (role) {
        const bp = busPin(role);
        if (bp) return addStep(pin, ctlNum(bp), role);
        return wireGpio(pin, output, `the usual ${role} pin is taken`);
      }
      if ((name === 'RX' || name === 'TX') && cdef.uart && cdef.uart[name]) {
        const up = cdef.uart[name];
        if (free(up)) return addStep(pin, ctlNum(up), 'UART ' + up);
        return wireGpio(pin, output, `${up} is taken, so serial uses another pin`);
      }
      if (ANALOG.test(name) || (def.id === 'pot' && name === 'OUT')) {
        const adc = (cdef.adc || []).filter(free).sort((a, b) => (caution[a] ? 1 : 0) - (caution[b] ? 1 : 0));
        if (!adc.length) { out.skipped.push({ pin: name, why: 'No free analog pin left on the board' }); return; }
        return addStep(pin, ctlNum(adc[0]), 'Analog ' + gpioLabel(adc[0]));
      }
      wireGpio(pin, output);
    }

    const pins = def.pins;
    const keys = placeholders(def);
    const supply = (p) => !noAuto.has(p.name) && !keys.includes(p.name) && !(def.rails && def.rails[p.name]);
    const ctlWorld = new Map(GFLUX.partPins(ctl).map((p) => [p.num, p]));
    const myWorld = new Map(GFLUX.partPins(inst).map((p) => [p.num, p]));

    const gnds = def.id === 'button' ? pins.filter((p) => p.num === '2')
      : pins.filter((p) => p.kind === 'gnd' && supply(p));
    if (gnds.length) {
      wanted++;
      if (!gnds.some((p) => connected(uid, p.num))) {
        open++;
        const ctlGnds = cdef.pins.filter((p) => cdef.rails && cdef.rails[p.name] === 'GND');
        let best = null;
        for (const g of gnds) for (const c of ctlGnds) {
          const d = dist2(myWorld.get(g.num), ctlWorld.get(c.num));
          if (!best || d < best.d) best = { g, c, d };
        }
        if (best) addStep(best.g, best.c.num, 'GND', { quiet: true });
        else out.skipped.push({ pin: gnds[0].name, why: 'The board has no GND pin' });
      }
    }

    const powers = def.id === 'led' ? []
      : pins.filter((p) => (p.kind === 'v3' || p.kind === 'v5') && supply(p));
    if (powers.length) {
      wanted++;
      if (!powers.some((p) => connected(uid, p.num))) {
        open++;
        const p = powers[0];
        const want = /^(3\.3V|3V3)$/i.test(p.name) || def.power !== '5V' ? '3V3' : '5V';
        const railPin = (rail) => cdef.pins.find((q) => cdef.rails && cdef.rails[q.name] === rail);
        const src = railPin(want) || railPin('3V3');
        if (src) addStep(p, src.num, `Power (${src.name})`);
        else out.skipped.push({ pin: p.name, why: 'The board has no supply pin for it' });
      }
    }

    const sigs = [];
    for (const key of keys) {
      let p;
      if (key === 'ANY') {
        p = def.id === 'led' ? pins.find((q) => q.name === '+')
          : def.id === 'button' ? pins.find((q) => q.num === '1')
          : pins.find((q) => q.kind === 'sig' && !noAuto.has(q.name));
      } else p = pins.find((q) => q.name === key);
      if (p && !noAuto.has(p.name) && !sigs.includes(p)) sigs.push(p);
    }
    for (const p of sigs) {
      wanted++;
      if (connected(uid, p.num)) continue;
      open++;
      wireSignal(p);
    }

    for (const p of pins) {
      if (noAuto.has(p.name) && !connected(uid, p.num)) out.skipped.push({ pin: p.name, why: 'Not wired automatically. Connect it yourself' });
    }

    const ref = GFLUX.annotate(state).get(ctl.uid);
    const n = out.steps.length;
    const missed = open - n;
    out.done = wanted > 0 && open === 0;
    if (out.done) out.message = `${def.name} is already wired.`;
    else if (!wanted) out.message = `${def.name} has nothing to wire automatically. Wire it by hand.`;
    else if (!n) out.message = `Could not find safe pins for ${def.name} on ${ref}.`;
    else out.message = `Add ${n} wire${n === 1 ? '' : 's'} from ${def.name} to ${ref}` + (missed > 0 ? `; ${missed} pin${missed === 1 ? '' : 's'} still need wiring by hand.` : '.');
    return out;
  }

  function canWire(state, uid) {
    const p = plan(state, uid);
    return p.steps.length > 0 || p.done;
  }

  return { plan, canWire };
})();
