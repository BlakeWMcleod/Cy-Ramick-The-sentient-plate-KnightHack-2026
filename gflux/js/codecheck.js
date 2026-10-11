/* GFLUX code checks: instant checks in the browser, plus the real Arduino
 * compiler through the GFLUX app. Results show in a small popup with very
 * short messages ("Missing ; · line 12"). Also the four example projects. */
window.GFLUX = window.GFLUX || {};

GFLUX.codecheck = (function () {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const app = () => GFLUX.app || {};
  const INPUT_ONLY = [34, 35, 36, 39];

  /** Code with comments and strings blanked out (same length, same lines). */
  function strip(src) {
    return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (m) => m.replace(/[^\n]/g, ' '));
  }
  const lineAt = (src, i) => src.slice(0, i).split('\n').length;

  /** Fast checks that need no compiler. */
  function quick(src, state) {
    const out = [], code = strip(src);
    // Brackets.
    const stack = [], pairs = { ')': '(', ']': '[', '}': '{' };
    for (let i = 0; i < code.length; i++) {
      const ch = code[i];
      if ('([{'.includes(ch)) stack.push([ch, i]);
      else if (pairs[ch]) {
        const top = stack.pop();
        if (!top || top[0] !== pairs[ch]) { out.push({ level: 'error', line: lineAt(code, i), text: `Extra ${ch}` }); break; }
      }
    }
    if (stack.length) { const [ch, i] = stack[stack.length - 1]; out.push({ level: 'error', line: lineAt(code, i), text: `Unclosed ${ch}` }); }
    if (!/\bvoid\s+setup\s*\(/.test(code)) out.push({ level: 'error', line: 1, text: 'No setup()' });
    if (!/\bvoid\s+loop\s*\(/.test(code)) out.push({ level: 'error', line: 1, text: 'No loop()' });
    if (/\bSerial\.(print|println|printf|write)\b/.test(code) && !/\bSerial\.begin\s*\(/.test(code)) {
      out.push({ level: 'warn', line: lineAt(code, code.search(/\bSerial\.(print|println|printf|write)\b/)), text: 'Serial.begin missing' });
    }
    // Pins: numbers, or names set by `const int X = 5` / `#define X 5`.
    const names = {};
    for (const m of code.matchAll(/\b(?:const\s+)?(?:int|uint8_t|byte|short|long)\s+(\w+)\s*=\s*(\d+)\s*[;,]/g)) names[m[1]] = +m[2];
    for (const m of code.matchAll(/#define\s+(\w+)\s+(\d+)\b/g)) names[m[1]] = +m[2];
    let wired = null;
    if (state && state.parts && state.parts.some((p) => GFLUX.getPart(p.type) && GFLUX.getPart(p.type).controller)) {
      wired = new Set(GFLUX.buildNets(state).nets.map((n) => n.gpio).filter((g) => g != null));
    }
    const seen = new Set();
    for (const m of code.matchAll(/\b(pinMode|digitalWrite|digitalRead|analogRead|analogWrite|ledcAttach\w*|\.attach)\s*\(\s*(\w+)/g)) {
      const arg = m[2], pin = /^\d+$/.test(arg) ? +arg : names[arg];
      if (pin == null || seen.has(m[1] + pin)) continue;
      seen.add(m[1] + pin);
      const line = lineAt(code, m.index);
      const output = /digitalWrite|analogWrite|ledc|attach/.test(m[1]) || (m[1] === 'pinMode' && /OUTPUT/.test(code.slice(m.index, code.indexOf(')', m.index))));
      if (output && INPUT_ONLY.includes(pin)) out.push({ level: 'error', line, text: `GPIO${pin} is input-only` });
      else if (wired && !wired.has(pin) && !seen.has('w' + pin)) { seen.add('w' + pin); out.push({ level: 'warn', line, text: `GPIO${pin} not wired` }); }
    }
    return out;
  }

  /** Library Manager name for a header file, e.g. 'ESP32Servo.h' -> 'ESP32Servo'. */
  function libFor(header) {
    if (!GFLUX.codegen || !GFLUX.codegen.libraryFor) return null;
    return GFLUX.codegen.libraryFor(`#include <${String(header).split('/').pop()}>`);
  }

  /** Compiler message -> a few words. */
  function shorten(it) {
    let line = it.line, m;
    const t = it.msg;
    let text;
    if ((m = /expected [^']*'([^']+)'(?: or '([^']+)')? (?:before|at)/.exec(t))) {
      const tok = [m[1], m[2]].includes(';') ? ';' : (m[2] || m[1]);
      text = `Missing ${tok}`;
      if (it.col <= 1 && line > 1) line -= 1; // reported at the start of the next line
    } else if ((m = /'([^']+)' was not declared in this scope/.exec(t))) text = `${m[1]} not declared`;
    else if ((m = /'([^']+)' does not name a type/.exec(t))) text = `${m[1]} unknown (missing #include?)`;
    else if ((m = /([\w./-]+\.h(?:pp)?): No such file/.exec(t))) {
      text = `Missing library ${libFor(m[1]) || m[1]}`;
    } else if ((m = /no matching function for call to '([^'(]+)/.exec(t))) text = `Bad arguments: ${m[1]}`;
    else if ((m = /too (many|few) arguments to function '([^'(]+)/.exec(t))) text = `Too ${m[1]} arguments: ${m[2]}`;
    else if ((m = /redefinition of '([^']+)'/.exec(t))) text = `${m[1]} defined twice`;
    else if (/expected '}' at end of input/.test(t)) text = 'Missing }';
    else if (/expected primary-expression/.test(t)) text = 'Typo here';
    else if (/invalid conversion/.test(t)) text = 'Wrong value type';
    else if (/control reaches end of non-void/.test(t)) text = 'Missing return';
    else if (/assignment of read-only|lvalue required/.test(t)) text = "Can't change that";
    else text = t.replace(/\s*\[-W[\w-]+\]$/, '').split(/\s+/).slice(0, 6).join(' ');
    return { level: it.level, line, text };
  }

  // ------------------------------------------------------------------- popup

  let box = null, lastCode = null, lastCompile = null, busy = false, poll = null;
  function el() {
    if (!box) {
      box = document.getElementById('codeIssues');
      box.addEventListener('click', onClick);
    }
    return box;
  }

  function render(status, items, actions) {
    const b = el();
    const errors = items.filter((i) => i.level === 'error').length;
    b.className = 'code-issues' + (errors ? '' : items.length ? ' warn-only' : ' all-good');
    b.innerHTML = `<button class="x" aria-label="Dismiss">×</button><h4>Code check</h4>` +
      `<p class="ci-status">${status}</p>` +
      (items.length ? `<ul>${items.map((i) => `<li class="${i.level}"${i.line ? ` data-line="${i.line}"` : ''}>${esc(i.text)}${i.line ? ` <span>· line ${i.line}</span>` : ''}</li>`).join('')}</ul>` : '') +
      (actions || '');
    b.hidden = false;
  }

  function onClick(e) {
    if (e.target.closest('.x')) { el().hidden = true; return; }
    const act = e.target.closest('[data-ci]');
    if (act && act.dataset.ci === 'setup') setup(act.dataset.libs ? JSON.parse(act.dataset.libs) : []);
    if (act && act.dataset.ci === 'again' && lastCode) run(lastCode);
    const li = e.target.closest('li[data-line]');
    if (li && GFLUX.codeEditor) GFLUX.codeEditor.goto(+li.dataset.line);
  }

  const merge = (a, b) => {
    const seen = new Set(), out = [];
    for (const i of a.concat(b)) { const k = i.text + '@' + i.line; if (!seen.has(k)) { seen.add(k); out.push(i); } }
    return out.sort((x, y) => (x.level === y.level ? x.line - y.line : x.level === 'error' ? -1 : 1));
  };

  function fqbnFor(state) {
    const board = state && state.parts.find((p) => GFLUX.getPart(p.type) && GFLUX.getPart(p.type).controller);
    return board && board.type === 'esp32c3' ? 'esp32:esp32:esp32c3' : 'esp32:esp32:esp32';
  }

  /** While typing: instant checks only. The popup shows up only when something is wrong. */
  let liveShown = false;
  function live(code) {
    if (busy) return;
    lastCode = code;
    lastCompile = null;
    const fast = quick(code, app().state);
    if (!fast.length) {
      if (liveShown && box) box.hidden = true;
      liveShown = false;
      return;
    }
    render(`${fast.length} issue${fast.length === 1 ? '' : 's'} found`, fast,
      '<p class="ci-note">Click a line to jump to it. <b>Check with Arduino</b> runs the full compiler.</p>');
    liveShown = true;
  }

  /** Check `code`: instant checks right away, then the Arduino compiler if the app is here. */
  async function run(code) {
    liveShown = false;
    lastCode = code;
    lastCompile = null;
    const state = app().state;
    const fast = quick(code, state);
    if (!app().appBase) {
      render(fast.length ? `${fast.length} issue${fast.length === 1 ? '' : 's'} found` : 'No obvious mistakes',
        fast, '<p class="ci-note">Open GFLUX through the GFLUX app for a full Arduino compile check.</p>');
      return;
    }
    if (busy) return;
    busy = true;
    render('<i class="ci-spin"></i> Compiling with Arduino…', fast);
    try {
      const { status, data } = await app().api('/api/arduino/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, fqbn: fqbnFor(state) }) });
      if (status >= 400) throw new Error(data.error || 'HTTP ' + status);
      lastCompile = data;
      showResult(data, fast);
    } catch (e) {
      render(`Couldn't check with Arduino (${esc(e.message)})`, fast, '<div class="ci-actions"><button class="btn" data-ci="again">Try again</button></div>');
    } finally { busy = false; }
  }

  function showResult(data, fast) {
    const items = merge(fast, (data.issues || []).map(shorten));
    const needs = data.needs || {};
    let actions = '';
    if (needs.cli || needs.core) {
      const libs = GFLUX.codegen ? GFLUX.codegen.libraries(app().state) : [];
      actions = `<div class="ci-actions"><button class="btn primary" data-ci="setup" data-libs='${esc(JSON.stringify(libs))}'>${needs.cli ? 'Set up Arduino' : 'Install ESP32 support'}</button></div>` +
        `<p class="ci-note">${needs.cli ? 'Arduino isn\'t on this computer yet. GFLUX can download it from arduino.cc.' : 'Arduino needs ESP32 support (about 500 MB, once).'}</p>`;
      render(needs.cli ? 'Arduino not found' : 'ESP32 support missing', items, actions);
      return;
    }
    if (needs.headers && needs.headers.length) {
      const libs = needs.headers.map(libFor).filter((l) => l && !/check the Library Manager/.test(l));
      if (libs.length) actions = `<div class="ci-actions"><button class="btn primary" data-ci="setup" data-libs='${esc(JSON.stringify(libs))}'>Install ${libs.length === 1 ? libs[0] : libs.length + ' libraries'}</button></div>`;
    }
    const errors = items.filter((i) => i.level === 'error').length;
    render(data.ok && !errors ? `✓ Compiles for ESP32 <span>(${data.seconds}s)</span>` : `${errors || items.length} problem${(errors || items.length) === 1 ? '' : 's'}`, items, actions);
  }

  async function setup(libs) {
    try {
      await app().api('/api/arduino/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ libs }) });
    } catch (e) { render(`Setup failed: ${esc(e.message)}`, []); return; }
    clearInterval(poll);
    const tick = async () => {
      const { data } = await app().api('/api/arduino/setup');
      if (data.state === 'running') { render(`<i class="ci-spin"></i> ${esc(data.message)}`, []); return; }
      clearInterval(poll);
      if (data.state === 'done' && lastCode) run(lastCode);
      else render(esc(data.message || 'Setup stopped'), [], '<div class="ci-actions"><button class="btn" data-ci="again">Try again</button></div>');
    };
    poll = setInterval(() => tick().catch(() => {}), 2500);
    tick().catch(() => {});
  }

  /** Re-run the instant checks when the circuit changes (the compile result stays). */
  let debounce = null;
  function circuitChanged() {
    if (!lastCode || !box || box.hidden || busy) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const fast = quick(lastCode, app().state);
      if (lastCompile) showResult(lastCompile, fast);
      else if (liveShown) live(lastCode);
      else if (!app().appBase) run(lastCode);
    }, 400);
  }

  // ---------------------------------------------------------------- examples

  const EXAMPLES = [
    {
      title: 'Blink + button', parts: [['led', 22, 2], ['button', 22, 12]],
      code: (p) => `// Example: Blink + button
// The LED blinks. Hold the button down to make it blink fast.
const int LED_PIN = ${p.led['+']};
const int BUTTON_PIN = ${p.button['1']};

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);  // pressed = LOW
}

void loop() {
  bool fast = digitalRead(BUTTON_PIN) == LOW;
  digitalWrite(LED_PIN, HIGH);
  delay(fast ? 100 : 500);
  digitalWrite(LED_PIN, LOW);
  delay(fast ? 100 : 500);
}
`,
    },
    {
      title: 'Distance alarm', parts: [['hcsr04', 22, 0], ['buzzer', 22, 12], ['led', 32, 12]],
      code: (p) => `// Example: Distance alarm
// Beeps and flashes faster as something gets closer than 30 cm.
const int TRIG_PIN = ${p.hcsr04.TRIG};
const int ECHO_PIN = ${p.hcsr04.ECHO};
const int BUZZER_PIN = ${p.buzzer.SIG};
const int LED_PIN = ${p.led['+']};

float readDistanceCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  return pulseIn(ECHO_PIN, HIGH, 30000) * 0.0343 / 2.0;
}

void setup() {
  Serial.begin(115200);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(LED_PIN, OUTPUT);
}

void loop() {
  float cm = readDistanceCm();
  Serial.printf("Distance: %.1f cm\\n", cm);
  if (cm > 0 && cm < 30) {
    int pause = map((int)cm, 0, 30, 40, 400);  // closer = shorter pause
    digitalWrite(BUZZER_PIN, HIGH);
    digitalWrite(LED_PIN, HIGH);
    delay(60);
    digitalWrite(BUZZER_PIN, LOW);
    digitalWrite(LED_PIN, LOW);
    delay(pause);
  } else {
    delay(100);
  }
}
`,
    },
    {
      title: 'Weather screen', parts: [['dht22', 22, 0], ['oled', 22, 10]],
      code: (p) => `// Example: Weather screen
// Shows temperature and humidity on the small screen every 2 seconds.
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <DHT.h>

DHT dht(${p.dht22.DATA}, DHT22);
Adafruit_SSD1306 oled(128, 64, &Wire, -1);

void setup() {
  Serial.begin(115200);
  Wire.begin(${p.oled.SDA}, ${p.oled.SCL});
  dht.begin();
  oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  oled.setTextColor(SSD1306_WHITE);
}

void loop() {
  float temp = dht.readTemperature();
  float humidity = dht.readHumidity();
  oled.clearDisplay();
  oled.setTextSize(2);
  oled.setCursor(0, 8);
  if (isnan(temp)) {
    oled.print("No sensor");
  } else {
    oled.printf("%.1f C", temp);
    oled.setCursor(0, 36);
    oled.printf("%.0f %%", humidity);
  }
  oled.display();
  delay(2000);
}
`,
    },
    {
      title: 'Servo knob', parts: [['pot', 22, 2], ['servo', 22, 12]],
      code: (p) => `// Example: Servo knob
// Turn the knob and the servo follows it.
#include <ESP32Servo.h>

const int KNOB_PIN = ${p.pot.OUT};
const int SERVO_PIN = ${p.servo.SIG};
Servo servo;

void setup() {
  Serial.begin(115200);
  servo.attach(SERVO_PIN);
}

void loop() {
  int raw = analogRead(KNOB_PIN);          // 0..4095
  int angle = map(raw, 0, 4095, 0, 180);   // 0..180 degrees
  servo.write(angle);
  Serial.printf("Knob %d -> %d degrees\\n", raw, angle);
  delay(20);
}
`,
    },
  ];

  const uid = () => 'p' + Math.random().toString(36).slice(2, 9);
  const wid = () => 'w' + Math.random().toString(36).slice(2, 9);

  /** Build an example circuit, wired by the auto-wire planner. -> { state, code, title } */
  function buildExample(i) {
    const ex = EXAMPLES[i];
    const state = { name: ex.title.toLowerCase().replace(/\W+/g, '-'), parts: [{ uid: uid(), type: 'esp32', x: 0, y: 0, rot: 0 }], wires: [], custom: [] };
    for (const [type, x, y] of ex.parts) state.parts.push({ uid: uid(), type, x, y, rot: 0 });
    for (const inst of state.parts.slice(1)) {
      for (const step of GFLUX.autowire.plan(state, inst.uid).steps) {
        const ctl = { part: step.to.uid, pin: step.to.pin }, mine = { part: step.from.uid, pin: step.from.pin };
        if (step.resistor) {
          const r = { uid: uid(), type: 'resistor', x: inst.x - 6, y: inst.y + 5, rot: 0 };
          state.parts.push(r);
          state.wires.push({ id: wid(), a: ctl, b: { part: r.uid, pin: '1' }, color: 'auto', via: [] });
          state.wires.push({ id: wid(), a: { part: r.uid, pin: '2' }, b: mine, color: 'auto', via: [] });
        } else state.wires.push({ id: wid(), a: ctl, b: mine, color: 'auto', via: [] });
      }
    }
    // Pin numbers for the sketch, looked up from the wiring.
    const nl = GFLUX.buildNets(state), pins = {};
    for (const inst of state.parts) {
      const def = GFLUX.getPart(inst.type);
      if (def.controller || inst.type === 'resistor') continue;
      pins[inst.type] = {};
      for (const p of def.pins) pins[inst.type][p.name] = GFLUX.gpioFor(state, nl, inst.uid, p.num);
    }
    // Colours: a rainbow out of the board, black ground, red power.
    const rainbow = ['R', 'O', 'Y', 'G', 'B', 'I', 'V'];
    let n = 0;
    for (const w of state.wires) {
      const ends = [w.a, w.b].filter((e) => e.part != null).map((e) => ({ inst: state.parts.find((p) => p.uid === e.part), pin: e.pin }));
      const pin = ends.map((e) => GFLUX.pinByNum(e.inst.type, e.pin));
      if (pin.some((p) => p.kind === 'gnd')) w.color = 'K';
      else if (pin.some((p) => p.kind === 'v3' || p.kind === 'v5')) w.color = 'R';
      else w.color = rainbow[n++ % rainbow.length];
    }
    return { state, code: ex.code(pins), title: ex.title };
  }

  return { quick, shorten, live, run, circuitChanged, buildExample, EXAMPLES };
})();
