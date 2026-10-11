/* GFLUX Arduino code generator.
 *
 * GFLUX.codegen.sketch(state)    -> complete .ino text for an ESP32 (Arduino-ESP32 core 3.x)
 * GFLUX.codegen.libraries(state) -> Library Manager names the sketch needs
 * GFLUX.codegen.analyze(state)   -> the intermediate model (used by the assistant)
 *
 * Part snippets come from the `code` field of each part definition (see parts.js):
 *   [[PIN]] -> GPIO wired to the pin with that name, [[ANY]] -> first wired GPIO,
 *   [[n]]   -> instance number of the part among parts of the same type.
 */
(function () {
  'use strict';
  const G = window.GFLUX = window.GFLUX || {};

  // #include file -> Arduino Library Manager name. null = ships with the ESP32 core.
  const LIBS = {
    'Wire.h': null, 'SPI.h': null, 'SD.h': null, 'WiFi.h': null, 'WebServer.h': null, 'Preferences.h': null,
    'Adafruit_GFX.h': 'Adafruit GFX Library',
    'Adafruit_SSD1306.h': 'Adafruit SSD1306',
    'ESP32Servo.h': 'ESP32Servo',
    'DHT.h': 'DHT sensor library',
    'LiquidCrystal_I2C.h': 'LiquidCrystal I2C',
    'TM1637Display.h': 'TM1637',
    'DFRobotDFPlayerMini.h': 'DFRobotDFPlayerMini',
    'IRremote.hpp': 'IRremote',
    'MFRC522.h': 'MFRC522',
    'Adafruit_NeoPixel.h': 'Adafruit NeoPixel',
    'MD_MAX72xx.h': 'MD_MAX72XX',
    'HX711.h': 'HX711 Arduino Library',
    'TinyGPSPlus.h': 'TinyGPSPlus',
    'TinyGPS++.h': 'TinyGPSPlus',
    'RTClib.h': 'RTClib',
    'Adafruit_BME280.h': 'Adafruit BME280 Library',
    'Adafruit_MPU6050.h': 'Adafruit MPU6050',
    'Adafruit_VL53L0X.h': 'Adafruit_VL53L0X',
    'OneWire.h': 'OneWire',
    'DallasTemperature.h': 'DallasTemperature',
    'Keypad.h': 'Keypad',
    'Stepper.h': 'Stepper',
    'MAX30105.h': 'SparkFun MAX3010x Pulse and Proximity Sensor Library',
  };

  /** Keep generated comments from closing early. */
  const safe = (s) => String(s == null ? '' : s).replace(/\*\//g, '* /').replace(/[\r\n]+/g, ' ');

  const headerName = (inc) => {
    const m = /#\s*include\s*[<"]([^>"]+)[>"]/.exec(inc);
    return m ? m[1].trim() : null;
  };

  function libraryFor(inc) {
    const h = headerName(inc);
    if (!h) return null;
    if (h in LIBS) return LIBS[h];
    // Unknown header from a custom part: best guess is the file name.
    return h.replace(/\.(h|hpp)$/i, '') + ' (check the Library Manager)';
  }

  /** Pick the controller everything is generated for (the first board on the canvas). */
  function findController(state) {
    return state.parts.find((p) => { const d = G.getPart(p.type); return d && d.controller; }) || null;
  }

  /** Build the intermediate model: per-part resolved snippets, wiring rows, todos, notes. */
  function analyze(state) {
    state = state || { parts: [], wires: [] };
    state = { name: state.name, parts: (state.parts || []).filter((p) => G.getPart(p.type)), wires: state.wires || [], custom: state.custom || [] };
    const nl = G.buildNets(state);
    const refs = G.annotate(state);
    const ctl = findController(state);
    const ctlDef = ctl ? G.getPart(ctl.type) : null;
    const i2c = (ctlDef && ctlDef.i2c) || { SDA: 21, SCL: 22 };

    // Parts in reference-designator reading order (same order as annotate()).
    const ordered = state.parts.slice().sort((a, b) => {
      const ra = refs.get(a.uid), rb = refs.get(b.uid);
      const pa = ra.replace(/\d+$/, ''), pb = rb.replace(/\d+$/, '');
      return (G.getPart(a.type).controller ? 0 : 1) - (G.getPart(b.type).controller ? 0 : 1) ||
        pa.localeCompare(pb) || parseInt(ra.slice(pa.length), 10) - parseInt(rb.slice(pb.length), 10);
    });
    const instNo = new Map(), typeCount = {};
    for (const p of ordered) { typeCount[p.type] = (typeCount[p.type] || 0) + 1; instNo.set(p.uid, typeCount[p.type]); }

    const usedGpio = new Map(); // gpio -> [ref.pin]
    const wiring = [], todos = [], notes = [], blocks = [];
    let serialPorts = ['Serial2', 'Serial1'];

    for (const inst of ordered) {
      const def = G.getPart(inst.type);
      const ref = refs.get(inst.uid);
      if (def.controller) continue;

      // Wiring rows: every connected pin of the part.
      const rows = [];
      for (const pin of def.pins) {
        const net = nl.byPin.get(G.pinKey(inst.uid, pin.num));
        if (!net) continue;
        const gpio = G.gpioFor(state, nl, inst.uid, pin.num);
        let to;
        if (gpio != null) {
          to = 'GPIO' + gpio + (net.gpio == null ? ' (through resistor)' : '');
          if (inst.type !== 'resistor') {
            if (!usedGpio.has(gpio)) usedGpio.set(gpio, []);
            usedGpio.get(gpio).push(ref + '.' + pin.name);
          }
        } else {
          to = net.name;
        }
        rows.push({ pin: pin.name, to });
      }
      wiring.push({ ref, uid: inst.uid, type: inst.type, name: def.name, mpn: def.mpn || '', rows });

      if (!def.code) { blocks.push({ ref, def, inst, code: null }); continue; }

      const n = instNo.get(inst.uid);
      const missing = new Set();
      const gpioByName = (name) => {
        const pins = def.pins.filter((p) => p.name === name);
        for (const p of pins) { const g = G.gpioFor(state, nl, inst.uid, p.num); if (g != null) return g; }
        return pins.length ? null : undefined; // undefined = no pin with that name
      };
      const anyGpio = () => {
        for (const p of def.pins) { const g = G.gpioFor(state, nl, inst.uid, p.num); if (g != null) return g; }
        return null;
      };
      const fill = (src) => {
        if (!src) return '';
        return String(src).replace(/\[\[([^\[\]\s]+)\]\]/g, (m, key) => {
          if (key === 'n') return String(n);
          if (key === 'ANY') {
            const g = anyGpio();
            if (g != null) return String(g);
            missing.add('a signal pin');
            return `-1 /* TODO: wire ${safe(ref)} to a GPIO */`;
          }
          const g = gpioByName(key);
          if (g != null) return String(g);
          if ((key === 'SDA' || key === 'SCL') && i2c[key] != null) {
            missing.add(key);
            return `${i2c[key]} /* TODO: wire ${key} to GPIO${i2c[key]} */`;
          }
          missing.add(key);
          return `-1 /* TODO: wire ${safe(ref)} ${safe(key)} */`;
        });
      };

      const code = {
        inc: (def.code.inc || []).map(fill),
        glob: fill(def.code.glob),
        setup: fill(def.code.setup),
        loop: fill(def.code.loop),
      };
      // Two UART parts (GPS + MP3 player): give the second one Serial1.
      if (/\bSerial2\b/.test(code.setup + code.loop + code.glob)) {
        const port = serialPorts.shift() || 'Serial1';
        if (port !== 'Serial2') {
          for (const k of ['glob', 'setup', 'loop']) code[k] = code[k].replace(/\bSerial2\b/g, port);
          notes.push(`${ref} uses ${port} because Serial2 is already taken.`);
        }
      }
      for (const m of missing) todos.push(m === 'a signal pin' ? `${ref} (${def.name}): wire it to a GPIO pin` : `${ref} (${def.name}): wire ${m}` + ((m === 'SDA' || m === 'SCL') ? ` to GPIO${i2c[m]}` : ' to a GPIO pin'));
      blocks.push({ ref, def, inst, code });
    }

    // Controller pin cautions for pins that are actually used.
    if (ctlDef) {
      const nameByGpio = {};
      for (const k in (ctlDef.gpio || {})) nameByGpio[ctlDef.gpio[k]] = k;
      for (const [gpio, users] of usedGpio) {
        const pinName = nameByGpio[gpio];
        if (pinName && ctlDef.caution && ctlDef.caution[pinName]) notes.push(`GPIO${gpio} (${users.join(', ')}): ${ctlDef.caution[pinName]}.`);
        if (pinName && (ctlDef.inputOnly || []).includes(pinName)) notes.push(`GPIO${gpio} (${users.join(', ')}) is input-only: fine for sensors, it cannot drive LEDs, buzzers or motors.`);
        if (users.length > 1 && !users.every((u) => /\.(SDA|SCL)$/.test(u))) notes.push(`GPIO${gpio} is shared by ${users.join(', ')}.`);
      }
    }
    // 5 V logic warnings for well-known 5 V outputs.
    for (const w of wiring) {
      if (w.type === 'hcsr04' && w.rows.some((r) => r.pin === 'ECHO' && /^GPIO/.test(r.to)) && w.rows.some((r) => r.pin === 'VCC' && r.to === '5V')) {
        notes.push(`${w.ref} ECHO outputs 5 V. Put a 1 kOhm / 2 kOhm voltage divider on it to protect the 3.3 V GPIO.`);
      }
    }

    return { state, nl, refs, ctl, ctlDef, ctlRef: ctl ? refs.get(ctl.uid) : null, i2c, blocks, wiring, todos, notes };
  }

  function uniq(list) { const seen = new Set(); return list.filter((x) => (seen.has(x) ? false : (seen.add(x), true))); }

  function libraries(state) {
    const a = analyze(state);
    const incs = [];
    for (const b of a.blocks) if (b.code) incs.push(...b.code.inc);
    return uniq(incs.map(libraryFor).filter(Boolean));
  }

  const indent = (text, pad) => String(text).split('\n').map((l) => (l.trim() ? pad + l.trim() : '')).join('\n');

  function sketch(state) {
    const a = analyze(state);
    const name = safe((state && state.name) || 'My GFLUX circuit');
    const out = [];

    // ------------------------------------------------------------ includes
    const incs = [];
    for (const b of a.blocks) if (b.code) incs.push(...b.code.inc.map((s) => s.trim()).filter(Boolean));
    const includes = uniq(incs);
    const libs = uniq(includes.map(libraryFor).filter(Boolean));

    // ------------------------------------------------------------ header
    out.push('/*');
    out.push(` * ${name}`);
    out.push(' * Generated by GFLUX for an ESP32 (Arduino IDE, board "ESP32 Dev Module", esp32 core 3.x).');
    out.push(' *');
    if (!a.ctl) {
      out.push(' * No ESP32 board on the canvas yet. Add one from Boards and wire your parts to it.');
      out.push(' *');
    }
    out.push(' * Wiring');
    const rows = [];
    for (const w of a.wiring) {
      if (!w.rows.length) rows.push([w.ref, w.name, '-', 'not connected yet']);
      for (const r of w.rows) rows.push([w.ref, w.name, r.pin, r.to]);
    }
    if (!rows.length) out.push(' *   (nothing wired yet)');
    else {
      const head = ['Ref', 'Part', 'Pin', 'Goes to'];
      const widths = head.map((h, i) => Math.min(28, Math.max(h.length, ...rows.map((r) => String(r[i]).length))));
      const fmt = (r) => ' *   ' + r.map((c, i) => (i < r.length - 1 ? safe(c).padEnd(widths[i]) : safe(c))).join('  ');
      out.push(fmt(head));
      out.push(' *   ' + widths.map((w) => '-'.repeat(w)).join('  '));
      for (const r of rows) out.push(fmt(r));
    }
    out.push(' *');
    out.push(' * Libraries to install (Arduino IDE > Tools > Manage Libraries...)');
    if (!libs.length) out.push(' *   none, everything used here ships with the ESP32 core');
    for (const l of libs) out.push(` *   - ${safe(l)}`);
    if (a.todos.length) {
      out.push(' *');
      out.push(' * Still needs wiring');
      for (const t of a.todos) out.push(` *   - ${safe(t)}`);
    }
    if (a.notes.length) {
      out.push(' *');
      out.push(' * Heads up');
      for (const t of uniq(a.notes)) out.push(` *   - ${safe(t)}`);
    }
    out.push(' */');
    out.push('');

    for (const inc of includes) out.push(inc);
    if (includes.length) out.push('');

    // ------------------------------------------------------------ globals
    const noCode = [];
    for (const b of a.blocks) {
      if (!b.code) { noCode.push(b); continue; }
      if (!b.code.glob.trim()) continue;
      out.push(`// ${safe(b.ref)}: ${safe(b.def.name)}${b.def.mpn ? ' (' + safe(b.def.mpn) + ')' : ''}`);
      out.push(b.code.glob.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n'));
      out.push('');
    }
    for (const b of noCode) out.push(`// ${safe(b.ref)}: ${safe(b.def.name)} has no code, it just needs to be wired.`);
    if (noCode.length) out.push('');

    // ------------------------------------------------------------ setup
    out.push('void setup() {');
    out.push('  Serial.begin(115200);');
    out.push('  delay(100);');
    const seen = new Set(['Serial.begin(115200);']);
    // One Wire.begin() for every I2C part; prefer a fully wired one over a TODO.
    const wireLines = [];
    for (const b of a.blocks) if (b.code) for (const l of b.code.setup.split('\n')) if (/^\s*Wire\.begin\(/.test(l)) wireLines.push(l.trim());
    const wireBest = wireLines.find((l) => !/TODO/.test(l)) || wireLines[0];
    let wireBegun = false;
    for (const b of a.blocks) {
      if (!b.code || !b.code.setup.trim()) continue;
      const lines = b.code.setup.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        if (!/^Wire\.begin\(/.test(l)) return l;
        if (wireBegun) return null;
        wireBegun = true; return wireBest;
      }).filter((l) => {
        if (!l) return false;
        if (seen.has(l)) return false;
        seen.add(l); return true;
      });
      if (!lines.length) continue;
      out.push(`  // ${safe(b.ref)}: ${safe(b.def.name)}`);
      for (const l of lines) out.push('  ' + l);
    }
    out.push('  Serial.println("' + name.replace(/["\\]/g, '') + ' is running!");');
    out.push('}');
    out.push('');

    // ------------------------------------------------------------ loop
    out.push('void loop() {');
    for (const b of a.blocks) {
      if (!b.code || !b.code.loop.trim()) continue;
      out.push(`  // ${safe(b.ref)}: ${safe(b.def.name)}`);
      out.push(indent(b.code.loop, '  '));
    }
    out.push('  delay(100); // small pause so the Serial Monitor stays readable');
    out.push('}');
    out.push('');
    return out.join('\n');
  }

  G.codegen = { sketch, libraries, analyze, libraryFor };
})();
