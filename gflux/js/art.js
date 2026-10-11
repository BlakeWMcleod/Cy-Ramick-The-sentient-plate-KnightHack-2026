/* GFLUX part artwork. Draws a part in its own unrotated local frame as an SVG
 * string, so each part looks like the real module from the parts bin. */
window.GFLUX = window.GFLUX || {};

GFLUX.art = (function () {
  const G = 20; // px per grid unit
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const r = (x, y, w, h, fill, extra = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" ${extra}/>`;
  const c = (x, y, rad, fill, extra = '') => `<circle cx="${x}" cy="${y}" r="${rad}" fill="${fill}" ${extra}/>`;
  const t = (x, y, s, size, fill, extra = '') => `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${extra}>${esc(s)}</text>`;
  const SILVER = 'url(#gx-silver)', GOLD = '#d9ac4a';

  /** Feature drawings, given the free inner area (px) of the board. */
  const FEATURES = {
    esp32(a, def) {
      const sw = a.w * 0.82, sx = a.x + (a.w - sw) / 2;
      let s = '';
      // PCB antenna meander above the module can
      let zig = `M${sx + 6} ${a.y + 4}`;
      for (let i = 0; i < 7; i++) zig += ` v14 h${sw / 16} v-14 h${sw / 16}`;
      s += `<path d="${zig}" fill="none" stroke="${GOLD}" stroke-width="2"/>`;
      s += r(sx, a.y + 26, sw, a.h * 0.42, SILVER, 'rx="3" stroke="#7d8288" stroke-width="1"');
      s += t(sx + sw / 2, a.y + 26 + a.h * 0.2, 'ESP32', 15, '#5d636a', 'text-anchor="middle" font-weight="800" letter-spacing="1"');
      s += t(sx + sw / 2, a.y + 26 + a.h * 0.2 + 16, 'WROOM-32', 8, '#6d737a', 'text-anchor="middle" font-weight="700"');
      const by = a.y + a.h - 34;
      s += r(a.x + 6, by, 16, 12, '#ddd', 'rx="2"') + c(a.x + 14, by + 6, 4, '#333');
      s += r(a.x + a.w - 22, by, 16, 12, '#ddd', 'rx="2"') + c(a.x + a.w - 14, by + 6, 4, '#333');
      s += t(a.x + 14, by - 4, 'EN', 7, '#eee', 'text-anchor="middle"') + t(a.x + a.w - 14, by - 4, 'BOOT', 7, '#eee', 'text-anchor="middle"');
      s += c(a.x + a.w / 2 - 14, by + 6, 3, '#e53935') + c(a.x + a.w / 2 + 14, by + 6, 3, '#4fc3f7', 'class="gx-blink"');
      s += r(a.x + a.w / 2 - 18, a.y + a.h + 6, 36, 22, SILVER, 'rx="3" stroke="#777"'); // micro USB
      return s;
    },
    c3(a) {
      return r(a.x + a.w * 0.2, a.y + a.h * 0.2, a.w * 0.6, a.w * 0.6, '#1d1d1f', 'rx="3"') +
        t(a.x + a.w / 2, a.y + a.h * 0.2 + a.w * 0.34, 'C3', 10, '#aaa', 'text-anchor="middle" font-weight="700"') +
        r(a.x + a.w / 2 - 16, a.y + a.h + 4, 32, 14, SILVER, 'rx="6" stroke="#777"');
    },
    ultrasonic(a) {
      const rad = Math.min(a.h * 0.46, a.w * 0.22);
      let s = '';
      for (const fx of [0.25, 0.75]) {
        const x = a.x + a.w * fx, y = a.y + a.h / 2;
        s += c(x, y, rad, SILVER, 'stroke="#6e737a" stroke-width="2"') + c(x, y, rad * 0.72, 'url(#gx-mesh)', 'stroke="#555"');
      }
      s += r(a.x + a.w / 2 - 9, a.y + a.h / 2 - 7, 18, 14, '#c9c9c9', 'rx="2"');
      return s + t(a.x + a.w / 2, a.y + 10, 'HC-SR04', 8, '#fff', 'text-anchor="middle" font-weight="700"');
    },
    led(a, def) {
      const col = def.ledColor || '#ff3b30', x = a.x + a.w / 2, y = a.y + a.h / 2, rad = Math.min(a.w, a.h) * 0.42;
      return c(x, y, rad, col, 'opacity=".9" stroke="rgba(0,0,0,.35)" stroke-width="2"') +
        c(x - rad * 0.3, y - rad * 0.3, rad * 0.3, 'rgba(255,255,255,.7)') +
        (def.ledColor ? `<circle cx="${x}" cy="${y}" r="${rad}" fill="url(#gx-rainbow)" opacity=".75"/>` : '');
    },
    button(a) {
      const x = a.x + a.w / 2, y = a.y + a.h / 2, s = Math.min(a.w, a.h) * 0.9;
      return r(x - s / 2, y - s / 2, s, s, '#2b2b2b', 'rx="3"') + c(x, y, s * 0.3, '#111', 'stroke="#444" stroke-width="2"');
    },
    slide(a) {
      return r(a.x, a.y + a.h * 0.15, a.w, a.h * 0.7, '#222', 'rx="2"') + r(a.x + a.w * 0.2, a.y + a.h * 0.3, a.w * 0.3, a.h * 0.4, '#bbb', 'rx="2"');
    },
    pot(a) {
      const x = a.x + a.w / 2, y = a.y + a.h / 2, rad = Math.min(a.w, a.h) * 0.4;
      return c(x, y, rad, '#2a2a2a', 'stroke="#555" stroke-width="2"') + c(x, y, rad * 0.62, '#3a3a3a') + `<line x1="${x}" y1="${y}" x2="${x}" y2="${y - rad * 0.8}" stroke="#ddd" stroke-width="3" stroke-linecap="round"/>`;
    },
    chip(a, def) {
      const s = Math.min(a.w, a.h) * 0.7, x = a.x + (a.w - s) / 2, y = a.y + (a.h - s) / 2;
      let legs = '';
      for (let i = 1; i < 5; i++) {
        legs += r(x - 3, y + (s * i) / 5 - 1, 3, 2, '#bbb') + r(x + s, y + (s * i) / 5 - 1, 3, 2, '#bbb');
      }
      return legs + r(x, y, s, s, '#1b1b1d', 'rx="2"') + c(x + 4, y + 4, 1.5, '#555') +
        t(a.x + a.w / 2, Math.min(a.y + a.h - 2, y + s + 11), def.mpn.split(/[-+]/)[0], 8, 'rgba(255,255,255,.85)', 'text-anchor="middle" font-weight="700"');
    },
    grille(a) {
      let s = r(a.x + 2, a.y + 2, a.w - 4, a.h - 4, '#f2f2f2', 'rx="3"');
      for (let y = a.y + 8; y < a.y + a.h - 6; y += 7) s += r(a.x + 7, y, a.w - 14, 3, '#cfcfcf', 'rx="1.5"');
      return s;
    },
    probe(a) {
      const y = a.y + a.h / 2;
      return `<path d="M${a.x} ${y} C ${a.x + a.w * 0.4} ${y - 20}, ${a.x + a.w * 0.6} ${y + 20}, ${a.x + a.w} ${y}" stroke="#151515" stroke-width="7" fill="none" stroke-linecap="round"/>` +
        r(a.x + a.w - 6, y - 5, 30, 10, SILVER, 'rx="5"');
    },
    dome(a) {
      const x = a.x + a.w / 2, y = a.y + a.h / 2, rad = Math.min(a.w, a.h) * 0.46;
      let s = c(x, y, rad, '#f7f7f2', 'stroke="#ccc" stroke-width="2"');
      for (let i = -1; i <= 1; i++) s += `<line x1="${x + i * rad * 0.5}" y1="${y - rad * 0.86}" x2="${x + i * rad * 0.5}" y2="${y + rad * 0.86}" stroke="#ddd"/><line y1="${y + i * rad * 0.5}" x1="${x - rad * 0.86}" y2="${y + i * rad * 0.5}" x2="${x + rad * 0.86}" stroke="#ddd"/>`;
      return s;
    },
    ldr(a) {
      const x = a.x + a.w * 0.35, y = a.y + a.h / 2, rad = Math.min(a.w, a.h) * 0.32;
      return c(x, y, rad, '#e9b44c', 'stroke="#a37522" stroke-width="2"') +
        `<path d="M${x - rad * 0.6} ${y - rad * 0.4} h${rad * 1.2} v${rad * 0.4} h-${rad * 1.2} v${rad * 0.4} h${rad * 1.2}" stroke="#7a3d12" stroke-width="2" fill="none"/>` +
        r(a.x + a.w * 0.62, a.y + a.h * 0.25, a.w * 0.28, a.w * 0.28, '#1f6fd1', 'rx="2"') + c(a.x + a.w * 0.76, a.y + a.h * 0.25 + a.w * 0.14, a.w * 0.08, '#e8d38a');
    },
    mic(a) {
      const x = a.x + a.w * 0.35, y = a.y + a.h / 2, rad = Math.min(a.w, a.h) * 0.34;
      return c(x, y, rad, SILVER, 'stroke="#777" stroke-width="2"') + c(x, y, rad * 0.55, '#333') +
        r(a.x + a.w * 0.62, a.y + a.h * 0.25, a.w * 0.28, a.w * 0.28, '#1f6fd1', 'rx="2"');
    },
    soil(a) {
      let s = '';
      for (let i = 0; i < 3; i++) s += r(a.x + 6, a.y + a.h * (0.45 + i * 0.15), a.w - 12, 3, '#d4b26a', 'rx="1.5"');
      return s + r(a.x + 4, a.y + 4, a.w - 8, a.h * 0.3, '#2a2a2a', 'rx="2"') + t(a.x + a.w / 2, a.y + a.h * 0.42, 'v1.2', 8, '#bbb', 'text-anchor="middle"');
    },
    gas(a) {
      const x = a.x + a.w / 2, y = a.y + a.h / 2, rad = Math.min(a.w, a.h) * 0.44;
      return c(x, y, rad, SILVER, 'stroke="#666" stroke-width="2"') + c(x, y, rad * 0.78, 'url(#gx-mesh)');
    },
    ir(a) {
      const y = a.y + a.h / 2, rad = Math.min(a.w, a.h) * 0.22;
      return c(a.x + a.w * 0.32, y, rad, '#1a1a1a', 'stroke="#555" stroke-width="2"') + c(a.x + a.w * 0.68, y, rad, '#e8f2ff', 'stroke="#99a" stroke-width="2"');
    },
    gps(a) {
      const s = Math.min(a.w, a.h) * 0.8, x = a.x + (a.w - s) / 2, y = a.y + (a.h - s) / 2;
      return r(x, y, s, s, '#cdb27a', 'rx="3" stroke="#9c8350" stroke-width="2"') + r(x + s * 0.3, y + s * 0.3, s * 0.4, s * 0.4, SILVER, 'rx="2"') + c(x + s * 0.5, y + s * 0.5, s * 0.07, GOLD);
    },
    touch(a) {
      const x = a.x + a.w / 2, y = a.y + a.h / 2, rad = Math.min(a.w, a.h) * 0.44;
      return c(x, y, rad, 'none', 'stroke="#fff" stroke-width="2" opacity=".85"') + c(x, y, rad * 0.55, 'none', 'stroke="#fff" stroke-width="2" opacity=".6"') + c(x, y, rad * 0.18, '#fff');
    },
    joystick(a) {
      const x = a.x + a.w / 2, y = a.y + a.h / 2, rad = Math.min(a.w, a.h) * 0.45;
      return c(x, y, rad, '#2c2c2c', 'stroke="#555" stroke-width="3"') + c(x, y, rad * 0.55, '#1a1a1a', 'stroke="#3a3a3a" stroke-width="3"') + c(x - 3, y - 3, rad * 0.15, 'rgba(255,255,255,.2)');
    },
    keypad(a) {
      let s = '';
      const k = Math.min(a.w, a.h) / 4, x0 = a.x + (a.w - k * 4) / 2, y0 = a.y + (a.h - k * 4) / 2;
      const keys = '123A456B789C*0#D';
      for (let i = 0; i < 16; i++) {
        const x = x0 + (i % 4) * k, y = y0 + Math.floor(i / 4) * k, ch = keys[i];
        s += r(x + 2, y + 2, k - 4, k - 4, /[A-D]/.test(ch) ? '#d84a3a' : (/[*#]/.test(ch) ? '#3a6fd8' : '#f2f2f2'), 'rx="3"');
        s += t(x + k / 2, y + k / 2 + 4, ch, 11, /[A-D*#]/.test(ch) ? '#fff' : '#333', 'text-anchor="middle" font-weight="700"');
      }
      return s;
    },
    rfid(a) {
      let s = '';
      for (let i = 0; i < 4; i++) s += r(a.x + 4 + i * 5, a.y + 4 + i * 5, a.w - 8 - i * 10, a.h - 8 - i * 10, 'none', 'rx="6" stroke="#d9ac4a" stroke-width="1.6"');
      return s;
    },
    oled(a) {
      const x = a.x + 2, y = a.y + 2, w = a.w - 4, h = a.h - 4;
      return r(x, y, w, h, '#060a12', 'rx="2" stroke="#333" stroke-width="2"') +
        r(x + 6, y + 6, w - 12, h * 0.22, '#0b1426') + t(x + 10, y + h * 0.2, 'GFLUX', 11, '#ffd54a', 'font-weight="800" font-family="var(--font-mono)"') +
        t(x + 10, y + h * 0.6, 'Hello!', 15, '#5ad2ff', 'font-weight="800" font-family="var(--font-mono)"');
    },
    lcd(a) {
      const x = a.x + 4, y = a.y + 6, w = a.w - 8, h = a.h - 12;
      let s = r(x - 4, y - 6, w + 8, h + 12, '#1d1d1d', 'rx="2"') + r(x, y, w, h, '#3b78e7', 'rx="2"');
      const cw = w / 16, ch = h / 2;
      for (let row = 0; row < 2; row++) for (let i = 0; i < 16; i++) s += r(x + i * cw + 1.5, y + row * ch + 3, cw - 3, ch - 6, 'rgba(255,255,255,.12)');
      return s + t(x + 4, y + ch - 6, 'Hello GFLUX!', ch * 0.62, '#fff', 'font-family="var(--font-mono)" font-weight="700"');
    },
    seg(a) {
      let s = r(a.x + 2, a.y + 2, a.w - 4, a.h - 4, '#151515', 'rx="2"');
      return s + t(a.x + a.w / 2, a.y + a.h * 0.78, '12:34', a.h * 0.8, '#ff3d2e', 'text-anchor="middle" font-family="var(--font-mono)" font-weight="800"');
    },
    servo(a) {
      const x = a.x, y = a.y, w = a.w, h = a.h;
      return r(x, y + h * 0.2, w, h * 0.6, '#2f6fd6', 'rx="4"') + r(x - 10, y + h * 0.4, w + 20, h * 0.18, '#2f6fd6', 'rx="3"') +
        c(x + w * 0.3, y + h * 0.5, h * 0.22, '#fff', 'stroke="#ccc" stroke-width="2"') +
        `<path d="M${x + w * 0.3} ${y + h * 0.5} L${x + w * 0.3} ${y - 2}" stroke="#fff" stroke-width="8" stroke-linecap="round"/>` +
        t(x + w * 0.68, y + h * 0.55, 'SG90', 9, '#fff', 'text-anchor="middle" font-weight="700"');
    },
    motor(a) {
      const x = a.x, y = a.y, w = a.w, h = a.h;
      return r(x, y + h * 0.1, w * 0.62, h * 0.8, '#f2c335', 'rx="4"') + r(x + w * 0.62, y + h * 0.25, w * 0.38, h * 0.5, SILVER, 'rx="4"') +
        c(x + w * 0.3, y + h * 0.5, h * 0.16, '#fff', 'stroke="#ccc" stroke-width="2"');
    },
    heatsink(a) {
      let s = r(a.x + a.w * 0.15, a.y, a.w * 0.7, a.h * 0.6, '#1a1a1a', 'rx="2"');
      for (let i = 1; i < 8; i++) s += r(a.x + a.w * 0.15 + (a.w * 0.7 * i) / 8 - 1, a.y + 2, 2, a.h * 0.6 - 4, '#3a3a3a');
      return s + t(a.x + a.w / 2, a.y + a.h * 0.85, 'L298N', 10, '#fff', 'text-anchor="middle" font-weight="800"');
    },
    relay(a) {
      return r(a.x + a.w * 0.1, a.y + a.h * 0.05, a.w * 0.62, a.h * 0.9, '#2366c9', 'rx="2" stroke="#174a94" stroke-width="2"') +
        t(a.x + a.w * 0.41, a.y + a.h * 0.45, 'SRD-05VDC', 7, '#fff', 'text-anchor="middle" font-weight="700"') +
        t(a.x + a.w * 0.41, a.y + a.h * 0.62, 'SL-C', 7, '#fff', 'text-anchor="middle"') + c(a.x + a.w * 0.86, a.y + a.h * 0.3, 3, '#e53935');
    },
    coin(a) {
      const x = a.x + a.w / 2, y = a.y + a.h / 2, rad = Math.min(a.w, a.h) * 0.42;
      return c(x, y, rad, SILVER, 'stroke="#777" stroke-width="2"') + t(x, y + 3, 'CR2032', Math.max(6, rad * 0.35), '#555', 'text-anchor="middle" font-weight="700"');
    },
    buzzer(a) {
      const x = a.x + a.w / 2, y = a.y + a.h / 2, rad = Math.min(a.w, a.h) * 0.44;
      return c(x, y, rad, '#161616', 'stroke="#333" stroke-width="2"') + c(x, y, rad * 0.18, '#444') + t(x + rad * 0.45, y - rad * 0.35, '+', 9, '#bbb');
    },
    speaker(a) {
      const x = a.x + a.w / 2, y = a.y + a.h / 2, rad = Math.min(a.w, a.h) * 0.48;
      return c(x, y, rad, '#2b2b2b', 'stroke="#888" stroke-width="3"') + c(x, y, rad * 0.62, '#3c3c3c') + c(x, y, rad * 0.24, '#555');
    },
    sd(a) {
      return r(a.x + a.w * 0.12, a.y + a.h * 0.12, a.w * 0.76, a.h * 0.62, SILVER, 'rx="2" stroke="#777"') + r(a.x + a.w * 0.25, a.y + a.h * 0.62, a.w * 0.5, a.h * 0.1, '#333');
    },
    battery(a) {
      let s = r(a.x, a.y, a.w, a.h, '#151515', 'rx="4"');
      const cw = a.w / 4;
      for (let i = 0; i < 4; i++) {
        s += r(a.x + i * cw + 3, a.y + 4, cw - 6, a.h - 8, i % 2 ? '#2e7d32' : '#1e88e5', 'rx="3"') + r(a.x + i * cw + 3, a.y + 4, cw - 6, 6, '#c9c9c9', 'rx="2"');
      }
      return s + t(a.x + a.w / 2, a.y + a.h - 6, '4×AA  6V', 9, '#fff', 'text-anchor="middle" font-weight="700"');
    },
    buck(a) {
      return c(a.x + a.w * 0.3, a.y + a.h / 2, Math.min(a.w, a.h) * 0.38, '#333', 'stroke="#d9ac4a" stroke-width="3"') +
        r(a.x + a.w * 0.62, a.y + a.h * 0.2, a.w * 0.18, a.h * 0.6, '#1f6fd1', 'rx="2"') + c(a.x + a.w * 0.71, a.y + a.h * 0.28, 3, '#e8d38a');
    },
    strip(a) {
      let s = '';
      for (let i = 0; i < 4; i++) s += r(a.x + 6 + (i * (a.w - 12)) / 4, a.y + a.h * 0.25, (a.w - 12) / 4 - 8, a.h * 0.5, '#fff', 'stroke="#ccc" rx="2"') + c(a.x + 6 + (i * (a.w - 12)) / 4 + ((a.w - 12) / 4 - 8) / 2, a.y + a.h / 2, 3, ['#e53935', '#43a047', '#1e88e5', '#fdd835'][i]);
      return s;
    },
    ring(a) {
      const x = a.x + a.w / 2, y = a.y + a.h / 2, rad = Math.min(a.w, a.h) * 0.42;
      let s = c(x, y, rad + 6, '#1d1d1d') + c(x, y, rad - 6, 'var(--board-hole, #000)', 'opacity=".25"');
      for (let i = 0; i < 16; i++) {
        const ang = (i / 16) * Math.PI * 2;
        s += r(x + Math.cos(ang) * rad - 3.5, y + Math.sin(ang) * rad - 3.5, 7, 7, `hsl(${i * 22.5},90%,60%)`, 'rx="1.5"');
      }
      return s;
    },
    matrix(a) {
      let s = r(a.x, a.y, a.w, a.h, '#151515', 'rx="2"');
      const k = Math.min(a.w, a.h) / 8;
      for (let i = 0; i < 64; i++) s += c(a.x + (i % 8) * k + k / 2, a.y + Math.floor(i / 8) * k + k / 2, k * 0.32, (i * 7) % 5 === 0 ? '#ff3d2e' : '#4a1410');
      return s;
    },
  };

  /** Resistor and other bodies without a board. */
  function resistor(def) {
    const y = 0, w = def.w * G;
    return `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="#b8b8b8" stroke-width="3" stroke-linecap="round"/>` +
      r(w * 0.2, y - 7, w * 0.6, 14, '#e6c99a', 'rx="7" stroke="#b39566" stroke-width="1.5"') +
      [['#e53935', 0.3], ['#e53935', 0.4], ['#6d3b1d', 0.5], ['#d4af37', 0.68]].map(([col, f]) => r(w * f, y - 7, 4, 14, col)).join('');
  }

  /** Header strip + gold pins, plus silkscreen labels. */
  function pinsAndLabels(def, onBoard) {
    let s = '';
    const bySide = { left: [], right: [], top: [], bottom: [] };
    for (const p of def.pins) bySide[p.side].push(p);
    for (const side of Object.keys(bySide)) {
      const list = bySide[side];
      if (!list.length) continue;
      const vertical = side === 'left' || side === 'right';
      if (onBoard) {
        const xs = list.map((p) => p.x * G), ys = list.map((p) => p.y * G);
        const x0 = Math.min(...xs) - 9, y0 = Math.min(...ys) - 9;
        s += r(x0, y0, Math.max(...xs) - Math.min(...xs) + 18, Math.max(...ys) - Math.min(...ys) + 18, '#141414', 'rx="3"');
      }
      const longest = Math.max(...list.map((p) => p.name.length));
      const turn = !vertical && longest > 3;
      for (const p of list) {
        const x = p.x * G, y = p.y * G;
        s += onBoard ? r(x - 4, y - 4, 8, 8, GOLD, 'rx="1.2"') : c(x, y, 4, '#c8c8c8', 'stroke="#888"');
        if (!onBoard && def.pins.length <= 2) continue;
        const fill = onBoard ? 'rgba(255,255,255,.92)' : 'var(--ink-2)';
        const fs = 7.5;
        if (side === 'left') s += t(x + 12, y + 2.6, p.name, fs, fill, 'class="gx-silk"');
        if (side === 'right') s += t(x - 12, y + 2.6, p.name, fs, fill, 'class="gx-silk" text-anchor="end"');
        if (side === 'top') s += turn ? t(0, 0, p.name, fs, fill, `class="gx-silk" transform="translate(${x + 2.6} ${y + 12}) rotate(90)"`) : t(x, y + 17, p.name, fs, fill, 'class="gx-silk" text-anchor="middle"');
        if (side === 'bottom') s += turn ? t(0, 0, p.name, fs, fill, `class="gx-silk" text-anchor="end" transform="translate(${x + 2.6} ${y - 12}) rotate(90)"`) : t(x, y - 11, p.name, fs, fill, 'class="gx-silk" text-anchor="middle"');
      }
    }
    return s;
  }

  function innerArea(def) {
    const has = (side) => def.pins.some((p) => p.side === side);
    const long = (side) => def.pins.filter((p) => p.side === side).some((p) => p.name.length > 3);
    const inset = (side) => (has(side) ? (side === 'left' || side === 'right' ? 1.9 : (long(side) ? 2.4 : 1.4)) : 0.1);
    const x = inset('left') * G, y = inset('top') * G;
    return { x, y, w: def.w * G - inset('right') * G - x, h: def.h * G - inset('bottom') * G - y };
  }

  /** Full part drawing in local, unrotated px coordinates. */
  function draw(def) {
    const pad = 0.6 * G;
    let s = '';
    if (def.art === 'resistor') return resistor(def) + pinsAndLabels(def, false);
    if (def.board) {
      s += `<rect class="gx-board" x="${-pad}" y="${-pad}" width="${def.w * G + pad * 2}" height="${def.h * G + pad * 2}" rx="${pad}" fill="${def.board}"/>`;
      s += `<rect x="${-pad + 1.5}" y="${-pad + 1.5}" width="${def.w * G + pad * 2 - 3}" height="${def.h * G + pad * 2 - 3}" rx="${pad - 1}" fill="none" stroke="rgba(255,255,255,.16)" stroke-width="1.5"/>`;
      if (def.w >= 6 && def.h >= 5) {
        for (const [mx, my] of [[-pad / 2 + 2, -pad / 2 + 2], [def.w * G + pad / 2 - 2, -pad / 2 + 2]]) {
          if (!def.pins.some((p) => Math.abs(p.x * G - mx) < 14 && Math.abs(p.y * G - my) < 14)) s += c(mx, my, 3.2, 'rgba(0,0,0,.45)', `stroke="${GOLD}" stroke-width="1.4"`);
        }
      }
    } else {
      // Loose component: legs from body to pins.
      const a = innerArea(def);
      for (const p of def.pins) {
        const tx = Math.min(Math.max(p.x * G, a.x + 4), a.x + a.w - 4), ty = Math.min(Math.max(p.y * G, a.y + 4), a.y + a.h - 4);
        s += `<line x1="${p.x * G}" y1="${p.y * G}" x2="${tx}" y2="${ty}" stroke="#b5b5b5" stroke-width="2.5" stroke-linecap="round"/>`;
      }
    }
    const a = def.board ? innerArea(def) : { x: G * 0.2, y: G * 0.1, w: def.w * G - G * 0.4, h: (def.h - 1.2) * G };
    const f = FEATURES[def.art] || FEATURES.chip;
    if (a.w > 6 && a.h > 6) s += f(a, def);
    return s + pinsAndLabels(def, !!def.board);
  }

  /** Shared gradients/patterns, injected once into the canvas <defs>. */
  const DEFS = `
    <linearGradient id="gx-silver" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f4f5f6"/><stop offset=".5" stop-color="#c3c7cc"/><stop offset="1" stop-color="#9ca1a7"/></linearGradient>
    <pattern id="gx-mesh" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="4" fill="#8a8f95"/><circle cx="2" cy="2" r="1.1" fill="#3a3d41"/></pattern>
    <radialGradient id="gx-rainbow"><stop offset="0" stop-color="#fff"/><stop offset=".45" stop-color="#ff5ad1"/><stop offset=".75" stop-color="#49c6ff"/><stop offset="1" stop-color="#7cff6b"/></radialGradient>`;

  return { draw, DEFS, G };
})();
