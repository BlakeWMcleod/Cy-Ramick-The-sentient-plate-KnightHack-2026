/* GFLUX simulator: runs a beginner's Arduino sketch in the browser and drives
 * the parts on the canvas. An approximation, not a cycle-accurate emulator.
 *
 *   GFLUX.sim.compile(source)               -> { ok, js, error, line, warnings }
 *   GFLUX.sim.start(state, source, hooks, opts)
 *        -> { stop(), setInput(key, value), getInput(key), serialWrite(text),
 *             model(opts), running, time(), runUntil(ms) (fast clock only), done }
 *      hooks: onUpdate(model, info)  throttled to animation frames
 *             onSerial(text)         everything printed with Serial
 *             onError(msg, line)     compile or runtime error (the program stops)
 *             onWarn(msg, line)      something worth knowing, the program keeps running
 *             onStop(reason)
 *      opts:  { fast: true }  virtual clock that only moves when the sketch waits
 *                             (tests); use runUntil(ms) to step it.
 *   GFLUX.sim.inputsFor(type)               -> input controls a part offers
 *   GFLUX.sim.examples                      -> ready-made circuits + sketches
 *
 * How it works: the Arduino C++ subset is tokenized, parsed into a small AST
 * and turned into async JavaScript. Every user function becomes async and
 * calls to it are awaited, so delay() can pause without freezing the page.
 * Loops yield every few thousand iterations so a loop without delay() still
 * lets the page breathe. A virtual ESP32 maps GPIO numbers to the parts on
 * the same nets (looking through series resistors) and keeps per-part state
 * that the canvas overlays draw. */
(function () {
  'use strict';
  const G = (typeof window !== 'undefined' ? window : globalThis).GFLUX = (typeof window !== 'undefined' ? window : globalThis).GFLUX || {};

  // ===================================================================
  // Errors
  // ===================================================================

  function simErr(msg, line) {
    const e = new Error(msg);
    e.simLine = line || 0;
    e.isSim = true;
    return e;
  }

  // ===================================================================
  // Tokenizer
  // ===================================================================

  const PUNCT3 = new Set(['>>=', '<<=', '...', '->*']);
  const PUNCT2 = new Set(['->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '::']);
  const PUNCT1 = new Set('+-*/%<>=!~&|^?:;,.()[]{}#'.split(''));
  const isIdStart = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
  const isIdChar = (c) => isIdStart(c) || (c >= '0' && c <= '9');
  const isDigit = (c) => c >= '0' && c <= '9';

  function readQuoted(src, i, q, line) {
    let k = i + 1, out = '';
    while (true) {
      if (k >= src.length || src[k] === '\n') throw simErr(q === '"' ? 'this text in "quotes" is never closed' : 'this \'character\' is never closed', line);
      const c = src[k];
      if (c === q) break;
      if (c === '\\') {
        const d = src[k + 1];
        k += 2;
        switch (d) {
          case 'n': out += '\n'; break;
          case 't': out += '\t'; break;
          case 'r': out += '\r'; break;
          case '0': case '1': case '2': case '3': case '4': case '5': case '6': case '7': {
            let s = d; while (s.length < 3 && /[0-7]/.test(src[k])) s += src[k++];
            out += String.fromCharCode(parseInt(s, 8) & 255); break;
          }
          case 'x': { let s = ''; while (/[0-9a-fA-F]/.test(src[k] || '')) s += src[k++]; out += String.fromCharCode(parseInt(s || '0', 16) & 255); break; }
          case 'a': out += '\x07'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'v': out += '\v'; break;
          case 'e': out += '\x1b'; break;
          case '\n': break;
          default: out += d;
        }
        continue;
      }
      out += c; k++;
    }
    return { value: out, end: k + 1 };
  }

  function tokenize(src, baseLine) {
    src = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
    const out = [];
    const n = src.length;
    let i = 0, line = baseLine || 1, bol = true;
    while (i < n) {
      const c = src[i];
      if (c === '\n') { line++; i++; bol = true; continue; }
      if (c === ' ' || c === '\t' || c === '\f' || c === '\v' || c === ' ' || c === '﻿') { i++; continue; }
      if (c === '\\' && src[i + 1] === '\n') { i += 2; line++; continue; }
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        if (end < 0) throw simErr('a /* comment is never closed with */', line);
        for (let k = i; k < end; k++) if (src[k] === '\n') line++;
        i = end + 2; continue;
      }
      if (c === '#' && bol) {
        const startLine = line;
        let text = '';
        i++;
        while (i < n && src[i] !== '\n') {
          const d = src[i];
          if (d === '\\' && src[i + 1] === '\n') { i += 2; line++; text += ' '; continue; }
          if (d === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; break; }
          if (d === '/' && src[i + 1] === '*') {
            const end = src.indexOf('*/', i + 2);
            if (end < 0) throw simErr('a /* comment is never closed with */', line);
            for (let k = i; k < end; k++) if (src[k] === '\n') line++;
            i = end + 2; text += ' '; continue;
          }
          if (d === '"' || d === '\'') {
            let k = i + 1;
            while (k < n && src[k] !== d && src[k] !== '\n') { if (src[k] === '\\') k++; k++; }
            text += src.slice(i, k + 1); i = k + 1; continue;
          }
          text += d; i++;
        }
        out.push({ t: 'pp', v: text.trim(), line: startLine });
        continue;
      }
      bol = false;
      if (isIdStart(c)) {
        let k = i + 1;
        while (k < n && isIdChar(src[k])) k++;
        const word = src.slice(i, k);
        if ((word === 'L' || word === 'u8' || word === 'u' || word === 'U') && (src[k] === '"' || src[k] === '\'')) { i = k; continue; }
        if (word === 'R' && src[k] === '"') {
          const open = src.indexOf('(', k);
          const delim = src.slice(k + 1, open);
          const close = src.indexOf(')' + delim + '"', open);
          if (open < 0 || close < 0) throw simErr('this raw string R"(...)" is never closed', line);
          const value = src.slice(open + 1, close);
          out.push({ t: 'str', v: value, line });
          for (const ch of value) if (ch === '\n') line++;
          i = close + delim.length + 2; continue;
        }
        out.push({ t: 'id', v: word, line });
        i = k; continue;
      }
      if (isDigit(c) || (c === '.' && isDigit(src[i + 1] || ''))) {
        let k = i, isFloat = false, val;
        if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
          k = i + 2; while (k < n && /[0-9a-fA-F']/.test(src[k])) k++;
          val = parseInt(src.slice(i + 2, k).replace(/'/g, ''), 16);
        } else if (c === '0' && (src[i + 1] === 'b' || src[i + 1] === 'B')) {
          k = i + 2; while (k < n && /[01']/.test(src[k])) k++;
          val = parseInt(src.slice(i + 2, k).replace(/'/g, ''), 2);
        } else {
          while (k < n && (isDigit(src[k]) || src[k] === '\'')) k++;
          if (src[k] === '.') { isFloat = true; k++; while (k < n && isDigit(src[k])) k++; }
          if ((src[k] === 'e' || src[k] === 'E') && /[-+0-9]/.test(src[k + 1] || '')) {
            isFloat = true; k += 2; while (k < n && isDigit(src[k])) k++;
          }
          const txt = src.slice(i, k).replace(/'/g, '');
          if (!isFloat && txt.length > 1 && txt[0] === '0' && /^[0-7]+$/.test(txt)) val = parseInt(txt, 8);
          else val = Number(txt);
        }
        let suf = '';
        while (k < n && /[uUlLfF]/.test(src[k])) suf += src[k++];
        if (/[fF]/.test(suf)) isFloat = true;
        if (k < n && isIdChar(src[k])) throw simErr('"' + src.slice(i, k + 1) + '" isn\'t a valid number', line);
        if (isNaN(val)) throw simErr('"' + src.slice(i, k) + '" isn\'t a valid number', line);
        out.push({ t: 'num', v: val, f: isFloat, u: /u/i.test(suf), line });
        i = k; continue;
      }
      if (c === '"') {
        const r = readQuoted(src, i, '"', line);
        out.push({ t: 'str', v: r.value, line });
        i = r.end; continue;
      }
      if (c === '\'') {
        const r = readQuoted(src, i, '\'', line);
        if (!r.value.length) throw simErr('empty character \'\' (put one letter between the quotes)', line);
        const chars = Array.from(r.value);
        if (chars.length > 1) throw simErr('\'' + r.value + '\' has more than one character. Use "double quotes" for text', line);
        out.push({ t: 'chr', v: chars[0].codePointAt(0), line });
        i = r.end; continue;
      }
      const s3 = src.substr(i, 3), s2 = src.substr(i, 2);
      if (PUNCT3.has(s3)) { out.push({ t: 'op', v: s3, line }); i += 3; continue; }
      if (PUNCT2.has(s2)) { out.push({ t: 'op', v: s2, line }); i += 2; continue; }
      if (PUNCT1.has(c)) { out.push({ t: 'op', v: c, line }); i++; continue; }
      if (c === '@' || c === '$' || c === '`') throw simErr('unexpected character "' + c + '"', line);
      throw simErr('unexpected character "' + c + '" (is it a fancy quote or symbol pasted from a website?)', line);
    }
    out.push({ t: 'eof', v: '', line });
    return out;
  }

  // ===================================================================
  // Preprocessor: #include is dropped, #define is expanded, #if... kept simple
  // ===================================================================

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function builtinMacros() {
    const d = new Date();
    const p2 = (x) => String(x).padStart(2, '0');
    const m = new Map();
    const def = (name, toks) => m.set(name, { params: null, body: toks });
    def('ESP32', [{ t: 'num', v: 1 }]);
    def('ARDUINO', [{ t: 'num', v: 10819 }]);
    def('ARDUINO_ARCH_ESP32', [{ t: 'num', v: 1 }]);
    def('__DATE__', [{ t: 'str', v: MONTHS[d.getMonth()] + ' ' + String(d.getDate()).padStart(2, ' ') + ' ' + d.getFullYear() }]);
    def('__TIME__', [{ t: 'str', v: p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) }]);
    def('__FILE__', [{ t: 'str', v: 'sketch.ino' }]);
    return m;
  }

  function preprocess(toks) {
    const macros = builtinMacros();
    const out = [];
    const cond = [];
    const active = () => cond.every((c) => c.active);

    function argsFrom(list, i, line) {
      // list[i] is '('. Returns { args: [[tokens]], end: index after ')' }
      const args = [[]];
      let depth = 0, k = i + 1;
      for (; k < list.length; k++) {
        const t = list[k];
        if (t.t === 'eof') throw simErr('this macro call is missing its closing )', line);
        if (t.t === 'op' && (t.v === '(' || t.v === '[' || t.v === '{')) depth++;
        if (t.t === 'op' && (t.v === ')' || t.v === ']' || t.v === '}')) {
          if (depth === 0 && t.v === ')') break;
          depth--;
        }
        if (t.t === 'op' && t.v === ',' && depth === 0) { args.push([]); continue; }
        args[args.length - 1].push(t);
      }
      return { args, end: k + 1 };
    }

    function expandList(list, hide) {
      const res = [];
      for (let i = 0; i < list.length; i++) {
        const t = list[i];
        if (t.t !== 'id' || hide.has(t.v) || !macros.has(t.v)) { res.push(t); continue; }
        const mac = macros.get(t.v);
        const line = t.line;
        if (!mac.params) {
          const body = mac.body.map((b) => Object.assign({}, b, { line }));
          const h = new Set(hide); h.add(t.v);
          res.push(...expandList(body, h));
          continue;
        }
        const nx = list[i + 1];
        if (!nx || nx.t !== 'op' || nx.v !== '(') { res.push(t); continue; }
        const { args, end } = argsFrom(list, i + 1, line);
        i = end - 1;
        const body = [];
        for (let b = 0; b < mac.body.length; b++) {
          const bt = mac.body[b];
          if (bt.t === 'op' && bt.v === '#' && mac.body[b + 1] && mac.body[b + 1].t === 'id' && mac.params.includes(mac.body[b + 1].v)) {
            const a = args[mac.params.indexOf(mac.body[b + 1].v)] || [];
            body.push({ t: 'str', v: a.map(tokText).join(' '), line });
            b++; continue;
          }
          if (bt.t === 'op' && bt.v === '##') continue;
          if (bt.t === 'id' && mac.params.includes(bt.v)) {
            const a = args[mac.params.indexOf(bt.v)] || [];
            body.push(...expandList(a, hide).map((x) => Object.assign({}, x, { line })));
          } else body.push(Object.assign({}, bt, { line }));
        }
        const h = new Set(hide); h.add(t.v);
        res.push(...expandList(body, h));
      }
      return res;
    }

    function evalIf(text, line) {
      let tks;
      try { tks = tokenize(text, line).filter((t) => t.t !== 'eof'); } catch (e) { return false; }
      const rep = [];
      for (let i = 0; i < tks.length; i++) {
        const t = tks[i];
        if (t.t === 'id' && t.v === 'defined') {
          let name;
          if (tks[i + 1] && tks[i + 1].v === '(') { name = tks[i + 2] && tks[i + 2].v; i += 3; } else { name = tks[i + 1] && tks[i + 1].v; i += 1; }
          rep.push({ t: 'num', v: macros.has(name) ? 1 : 0 });
          continue;
        }
        rep.push(t);
      }
      const ex = expandList(rep, new Set());
      const js = ex.map((t) => {
        if (t.t === 'num') return String(t.v);
        if (t.t === 'chr') return String(t.v);
        if (t.t === 'id') return t.v === 'true' ? '1' : '0';
        if (t.t === 'op' && /^(\|\||&&|==|!=|<=|>=|<<|>>|[-+*/%<>!~&|^?:()])$/.test(t.v)) return t.v;
        return 'x';
      }).join(' ');
      if (/x/.test(js)) return false;
      try { return !!(new Function('return (' + js + ');'))(); } catch (e) { return false; }
    }

    for (let i = 0; i < toks.length; i++) {
      const tk = toks[i];
      if (tk.t === 'pp') {
        const m = /^(\w*)\s*([\s\S]*)$/.exec(tk.v) || ['', '', ''];
        const dir = m[1], rest = m[2];
        switch (dir) {
          case 'ifdef': case 'ifndef': {
            const name = rest.trim().split(/\s+/)[0];
            const on = active() && (macros.has(name) === (dir === 'ifdef'));
            cond.push({ active: on, taken: on, parent: active() });
            break;
          }
          case 'if': {
            const parent = active();
            const on = parent && evalIf(rest, tk.line);
            cond.push({ active: on, taken: on, parent });
            break;
          }
          case 'elif': {
            const top = cond[cond.length - 1];
            if (!top) throw simErr('#elif without #if', tk.line);
            if (top.taken || !top.parent) top.active = false;
            else { top.active = evalIf(rest, tk.line); top.taken = top.active; }
            break;
          }
          case 'else': {
            const top = cond[cond.length - 1];
            if (!top) throw simErr('#else without #if', tk.line);
            top.active = top.parent && !top.taken; top.taken = true;
            break;
          }
          case 'endif':
            if (!cond.length) throw simErr('#endif without #if', tk.line);
            cond.pop();
            break;
          default:
            if (!active()) break;
            if (dir === 'define') {
              const dm = /^([A-Za-z_]\w*)(\(([^)]*)\))?\s*([\s\S]*)$/.exec(rest);
              if (!dm) throw simErr('this #define needs a name', tk.line);
              const params = dm[2] != null ? dm[3].split(',').map((s) => s.trim()).filter(Boolean) : null;
              const body = tokenize(dm[4], tk.line).filter((t) => t.t !== 'eof');
              macros.set(dm[1], { params, body });
            } else if (dir === 'undef') {
              macros.delete(rest.trim());
            } else if (dir === 'error') {
              throw simErr('#error ' + rest, tk.line);
            }
            // include, pragma, warning, line and anything else: nothing to do
        }
        continue;
      }
      if (!active()) continue;
      if (tk.t === 'id' && macros.has(tk.v)) {
        const mac = macros.get(tk.v);
        if (mac.params) {
          const nx = toks[i + 1];
          if (!nx || nx.t !== 'op' || nx.v !== '(') { out.push(tk); continue; }
          // Collect the call (it may span lines) and expand it as a list.
          let depth = 0, k = i + 1;
          for (; k < toks.length; k++) {
            const t = toks[k];
            if (t.t === 'eof') break;
            if (t.t === 'op' && t.v === '(') depth++;
            if (t.t === 'op' && t.v === ')') { depth--; if (depth === 0) break; }
          }
          out.push(...expandList(toks.slice(i, k + 1), new Set()));
          i = k;
          continue;
        }
        out.push(...expandList([tk], new Set()));
        continue;
      }
      out.push(tk);
    }
    if (cond.length) throw simErr('an #if / #ifdef is missing its #endif', toks[toks.length - 1].line);
    return out;
  }

  function tokText(t) {
    if (t.t === 'str') return JSON.stringify(t.v);
    if (t.t === 'chr') return '\'' + String.fromCharCode(t.v) + '\'';
    return String(t.v);
  }

  // ===================================================================
  // Types
  // ===================================================================

  const T = {
    int: { k: 'int', conv: 'i32' },
    uint: { k: 'int', conv: 'u32' },
    i64: { k: 'int', conv: 'i64' },
    float: { k: 'float' },
    bool: { k: 'bool' },
    char: { k: 'char' },
    str: { k: 'str' },
    void: { k: 'void' },
    any: { k: 'any' },
    fn: { k: 'fn' },
    obj: (cls) => ({ k: 'obj', cls }),
  };
  const withDims = (t, dims) => Object.assign({}, t, { dims });
  const isArr = (t) => !!(t && t.dims && t.dims.length);
  const isIntT = (t) => t && !isArr(t) && (t.k === 'int' || t.k === 'char' || t.k === 'bool');
  const isNumT = (t) => t && !isArr(t) && (t.k === 'int' || t.k === 'char' || t.k === 'bool' || t.k === 'float');
  const isStrT = (t) => t && !isArr(t) && t.k === 'str';
  const elemT = (t) => (isArr(t) ? (t.dims.length > 1 ? withDims(t, t.dims.slice(1)) : Object.assign({}, t, { dims: null })) : T.any);

  // Words that make up builtin types.
  const TYPE_WORDS = new Set(['void', 'bool', 'boolean', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned', 'byte', 'word',
    'size_t', 'ssize_t', 'int8_t', 'uint8_t', 'int16_t', 'uint16_t', 'int32_t', 'uint32_t', 'int64_t', 'uint64_t', 'String', 'auto', 'uint',
    'time_t', 'float_t', 'double_t', 'wchar_t', 'uintptr_t', 'intptr_t', 'u8', 'u16', 'u32', 'esp_err_t', 'gpio_num_t']);
  const QUALS = new Set(['const', 'static', 'volatile', 'constexpr', 'inline', 'extern', 'register', 'mutable', 'IRAM_ATTR', 'DRAM_ATTR',
    'RTC_DATA_ATTR', 'PROGMEM', 'ICACHE_RAM_ATTR', 'ARDUINO_ISR_ATTR', 'RTC_NOINIT_ATTR', 'typename', 'virtual', 'explicit']);

  function typeFromWords(words, line) {
    const has = (w) => words.includes(w);
    const count = (w) => words.filter((x) => x === w).length;
    const uns = has('unsigned');
    if (has('String')) return T.str;
    if (has('auto')) return { k: 'auto' };
    if (has('void')) return T.void;
    if (has('float') || has('double') || has('float_t') || has('double_t')) return T.float;
    if (has('bool') || has('boolean')) return T.bool;
    if (has('char') && !uns && !has('signed')) return T.char;
    if (has('char') && uns) return { k: 'int', conv: 'u8' };
    if (has('char')) return { k: 'int', conv: 'i8' };
    if (has('wchar_t')) return T.char;
    if (has('byte') || has('uint8_t') || has('u8')) return { k: 'int', conv: 'u8' };
    if (has('int8_t')) return { k: 'int', conv: 'i8' };
    if (has('uint16_t') || has('word') || has('u16') || (has('short') && uns)) return { k: 'int', conv: 'u16' };
    if (has('int16_t') || has('short')) return { k: 'int', conv: 'i16' };
    if (has('int64_t') || has('time_t') || (count('long') >= 2 && !uns)) return T.i64;
    if (has('uint64_t') || (count('long') >= 2 && uns)) return { k: 'int', conv: 'u64' };
    if (uns || has('uint32_t') || has('size_t') || has('uint') || has('u32') || has('uintptr_t')) return T.uint;
    return T.int;
  }

  const ELEM_BYTES = (t) => {
    if (!t) return 4;
    if (t.k === 'char' || t.k === 'bool') return 1;
    if (t.k === 'int') return { u8: 1, i8: 1, u16: 2, i16: 2, i64: 8, u64: 8 }[t.conv] || 4;
    if (t.k === 'float') return 4;
    if (t.k === 'str') return 12;
    return 4;
  };

  // ===================================================================
  // Parser
  // ===================================================================

  const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);
  const BIN_PREC = { '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6, '<': 7, '>': 7, '<=': 7, '>=': 7, '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10 };
  const STMT_KEYWORDS = new Set(['if', 'else', 'while', 'do', 'for', 'switch', 'case', 'default', 'break', 'continue', 'return', 'goto', 'try', 'catch', 'throw', 'new', 'delete', 'sizeof', 'this', 'operator', 'template', 'namespace', 'using', 'true', 'false', 'NULL', 'nullptr']);

  class Parser {
    constructor(toks, libClasses) {
      this.toks = toks;
      this.pos = 0;
      this.types = new Map();       // user typedef / struct / enum names -> type
      this.libClasses = libClasses; // Set of class names the runtime models
      this.seenClasses = new Set(); // unknown class names used in declarations
    }
    peek(k) { return this.toks[Math.min(this.pos + (k || 0), this.toks.length - 1)]; }
    next() { return this.toks[this.pos++] || this.toks[this.toks.length - 1]; }
    is(v, k) { const t = this.peek(k); return (t.t === 'op' || t.t === 'id') && t.v === v; }
    isOp(v, k) { const t = this.peek(k); return t.t === 'op' && t.v === v; }
    accept(v) { if (this.is(v)) { this.pos++; return true; } return false; }
    prevLine() { return (this.toks[this.pos - 1] || this.peek()).line; }
    fail(msg, line) { throw simErr(msg, line != null ? line : this.peek().line); }
    expect(v, what) {
      if (this.accept(v)) return;
      const t = this.peek();
      if (v === ';') this.fail('missing ";" at the end of this line', this.prevLine());
      if (v === ')' || v === ']' || v === '}') this.fail(`missing "${v}"` + (what ? ' ' + what : '') + (t.t === 'eof' ? ' before the end of the code' : ` before "${tokText(t)}"`), t.t === 'eof' ? this.prevLine() : t.line);
      this.fail(`expected "${v}"` + (what ? ' ' + what : '') + (t.t === 'eof' ? ' but the code ended' : ` but found "${tokText(t)}"`));
    }
    ident(what) {
      const t = this.peek();
      if (t.t !== 'id') this.fail(`expected ${what || 'a name'}` + (t.t === 'eof' ? ' but the code ended' : ` but found "${tokText(t)}"`));
      this.pos++;
      return t.v;
    }

    isTypeName(name) { return this.types.has(name) || this.libClasses.has(name) || this.seenClasses.has(name); }

    /** Can a type start here? (used to tell declarations from expressions) */
    isDeclStart() {
      const t = this.peek();
      if (t.t !== 'id') return false;
      const v = t.v;
      if (STMT_KEYWORDS.has(v)) return false;
      if (QUALS.has(v)) return true;
      if (TYPE_WORDS.has(v)) return !this.isOp('(', 1) && !this.isOp('.', 1) && !this.isOp('::', 1);
      if (v === 'struct' || v === 'enum' || v === 'typedef' || v === 'class' || v === 'union') return true;
      if (v === 'std' && this.isOp('::', 1)) {
        const t2 = this.peek(2);
        return t2.t === 'id' && (t2.v === 'string' || t2.v === 'vector' || t2.v === 'array' || t2.v === 'map') && (this.peek(3).t === 'id' || this.isOp('<', 3));
      }
      const n1 = this.peek(1);
      if (this.isTypeName(v)) {
        if (n1.t === 'id') return true;
        if (n1.t === 'op' && (n1.v === '*' || n1.v === '&') && this.peek(2).t === 'id') return true;
        if (n1.t === 'op' && n1.v === '<') return true;
        return false;
      }
      if (n1.t === 'id' && !STMT_KEYWORDS.has(n1.v)) return true; // UnknownClass name ...
      if (n1.t === 'op' && n1.v === '::') {
        // Foo::Bar name;  (a type nested in a library class)
        let k = 1;
        while (this.isOp('::', k) && this.peek(k + 1).t === 'id') k += 2;
        return this.peek(k).t === 'id';
      }
      if (n1.t === 'op' && n1.v === '<') {
        // Template<...> name
        let depth = 0;
        for (let k = 1; k < 40; k++) {
          const tk = this.peek(k);
          if (tk.t === 'eof' || (tk.t === 'op' && (tk.v === ';' || tk.v === '{' || tk.v === '('))) return false;
          if (tk.t === 'op' && tk.v === '<') depth++;
          if (tk.t === 'op' && tk.v === '>') { depth--; if (depth === 0) return this.peek(k + 1).t === 'id'; }
          if (tk.t === 'op' && tk.v === '>>') { depth -= 2; if (depth <= 0) return this.peek(k + 1).t === 'id'; }
        }
      }
      if (n1.t === 'op' && n1.v === '*' && this.peek(2).t === 'id' && (this.isOp('=', 3) || this.isOp(';', 3))) {
        this.fail('pointers (*) aren\'t supported in the simulator');
      }
      return false;
    }

    /** Parse type specifiers. Returns a type or null (position restored). */
    parseType() {
      const start = this.pos;
      const q = { isConst: false, isStatic: false };
      const words = [];
      let base = null;
      const line = this.peek().line;
      for (;;) {
        const t = this.peek();
        if (t.t !== 'id') break;
        const v = t.v;
        if (QUALS.has(v)) { if (v === 'const' || v === 'constexpr') q.isConst = true; if (v === 'static') q.isStatic = true; this.pos++; continue; }
        if (base) break;
        if (TYPE_WORDS.has(v)) {
          if (v === 'String' && words.length) break;
          words.push(v); this.pos++; continue;
        }
        if (words.length) break;
        if ((v === 'struct' || v === 'enum' || v === 'union') && this.peek(1).t === 'id' && !this.isOp('{', 2)) {
          this.pos++;
          const name = this.next().v;
          base = this.types.get(name) || (v === 'enum' ? T.int : null);
          if (!base) this.fail(`"${name}" isn't a struct I know about`);
          continue;
        }
        if (v === 'class') this.fail('classes aren\'t supported in the simulator. Use plain functions and variables (structs work)');
        if (v === 'std' && this.isOp('::', 1)) {
          const w = this.peek(2).v;
          if (w === 'string') { this.pos += 3; base = T.str; continue; }
          this.fail(`std::${w} isn't supported in the simulator. Use a plain array instead`);
        }
        if (this.types.has(v)) { this.pos++; base = this.types.get(v); continue; }
        if (this.libClasses.has(v) || this.seenClasses.has(v)) {
          this.pos++;
          if (this.isOp('<')) this.fail(`templates like ${v}<...> aren't supported in the simulator`);
          if (this.isOp('::') && this.peek(1).t === 'id') {
            let name = v; while (this.isOp('::') && this.peek(1).t === 'id') { this.pos++; name += '::' + this.next().v; }
            base = { k: 'obj', cls: name, nested: true };
            continue;
          }
          base = T.obj(v); continue;
        }
        // Unknown identifier used as a type: Foo name / Foo::Bar name / Foo<...> name
        const n1 = this.peek(1);
        if (n1.t === 'op' && n1.v === '<') this.fail(`templates like ${v}<...> aren't supported in the simulator`);
        if (n1.t === 'op' && n1.v === '::') {
          let name = v; this.pos++;
          while (this.isOp('::') && this.peek(1).t === 'id') { this.pos++; name += '::' + this.next().v; }
          if (this.peek().t !== 'id' && !this.isOp('*') && !this.isOp('&')) { this.pos = start; return null; }
          base = { k: 'obj', cls: name, nested: true };
          continue;
        }
        if (n1.t === 'id' || (n1.t === 'op' && (n1.v === '*' || n1.v === '&') && this.peek(2).t === 'id')) {
          this.pos++;
          this.seenClasses.add(v);
          base = T.obj(v);
          continue;
        }
        break;
      }
      if (!base && !words.length) {
        if (q.isConst || q.isStatic) return Object.assign({}, T.int, q, { line });
        this.pos = start;
        return null;
      }
      const ty = base ? base : typeFromWords(words, line);
      return Object.assign({}, ty, q);
    }

    // ------------------------------------------------------------ program
    parseProgram() {
      const items = [];
      while (this.peek().t !== 'eof') {
        const item = this.parseTopLevel();
        if (item) items.push(item);
      }
      return items;
    }

    parseTopLevel() {
      const t = this.peek();
      if (this.accept(';')) return null;
      if (t.t === 'id' && t.v === 'using') { while (!this.isOp(';') && this.peek().t !== 'eof') this.pos++; this.accept(';'); return null; }
      if (t.t === 'id' && (t.v === 'namespace' || t.v === 'template')) this.fail(`"${t.v}" isn't supported in the simulator`);
      if (t.t === 'id' && t.v === 'class') this.fail('classes aren\'t supported in the simulator. Use plain functions and variables (structs work)');
      if (t.t === 'id' && t.v === 'extern' && this.peek(1).t === 'str') { this.pos += 2; return null; }
      const decl = this.parseTypeDefinition();
      if (decl !== undefined) return decl;
      if (!this.isDeclStart()) {
        if (t.t === 'id' && this.isOp('(', 1)) this.fail(`"${t.v}(...)" here needs a return type in front, for example "void ${t.v}(...)"`);
        this.fail(t.t === 'eof' ? 'unexpected end of code' : `"${tokText(t)}" can't go here. Code must be inside a function like setup() or loop()`);
      }
      return this.parseDeclaration(true);
    }

    /** struct / enum / typedef. Returns a node, null, or undefined if not one. */
    parseTypeDefinition() {
      const t = this.peek();
      if (t.t !== 'id') return undefined;
      const line = t.line;
      if (t.v === 'typedef') {
        this.pos++;
        if ((this.is('struct') || this.is('union')) && (this.isOp('{', 1) || (this.peek(1).t === 'id' && this.isOp('{', 2)))) {
          this.pos++;
          if (this.peek().t === 'id') this.pos++;
          const fields = this.parseStructBody();
          const name = this.ident('a name for the struct');
          this.expect(';');
          const ty = { k: 'struct', cls: name, fields };
          this.types.set(name, ty);
          return { s: 'struct', name, fields, line };
        }
        if (this.is('enum') && (this.isOp('{', 1) || (this.peek(1).t === 'id' && this.isOp('{', 2)))) {
          this.pos++;
          if (this.peek().t === 'id') this.pos++;
          const items = this.parseEnumBody();
          const name = this.ident('a name for the enum');
          this.expect(';');
          this.types.set(name, T.int);
          return { s: 'enum', name, items, cls: false, line };
        }
        const ty = this.parseType();
        if (!ty) this.fail('this typedef needs a type');
        if (this.isOp('(')) this.fail('function pointer typedefs aren\'t supported in the simulator');
        while (this.accept('*')) { if (ty.k !== 'char') this.fail('pointers (*) aren\'t supported in the simulator'); Object.assign(ty, T.str); }
        const name = this.ident('a name for the typedef');
        this.expect(';');
        this.types.set(name, ty);
        return null;
      }
      if ((t.v === 'struct' || t.v === 'union') && (this.isOp('{', 1) || (this.peek(1).t === 'id' && this.isOp('{', 2)))) {
        this.pos++;
        const name = this.peek().t === 'id' ? this.next().v : '__anon' + line;
        const ty = { k: 'struct', cls: name, fields: null };
        this.types.set(name, ty);
        ty.fields = this.parseStructBody();
        const node = { s: 'struct', name, fields: ty.fields, line };
        if (this.accept(';')) return node;
        // struct Foo { ... } a, b;
        const decl = this.parseDeclaratorsFor(Object.assign({}, ty), false, line);
        return { s: 'multi', items: [node, decl] };
      }
      if (t.v === 'enum' && (this.isOp('{', 1) || (this.peek(1).t === 'id' && (this.isOp('{', 2) || this.isOp(':', 2))) || (this.is('class', 1) && this.peek(2).t === 'id'))) {
        this.pos++;
        let cls = false;
        if (this.accept('class') || this.accept('struct')) cls = true;
        const name = this.peek().t === 'id' ? this.next().v : null;
        if (this.accept(':')) { this.parseType(); }
        const items = this.parseEnumBody();
        if (name) this.types.set(name, T.int);
        const node = { s: 'enum', name, items, cls, line };
        if (this.accept(';')) return node;
        const decl = this.parseDeclaratorsFor(Object.assign({}, T.int), false, line);
        return { s: 'multi', items: [node, decl] };
      }
      return undefined;
    }

    parseStructBody() {
      this.expect('{');
      const fields = [];
      while (!this.accept('}')) {
        if (this.peek().t === 'eof') this.fail('this struct is missing its closing }');
        const line = this.peek().line;
        const ty = this.parseType();
        if (!ty) this.fail(`expected a field type in the struct but found "${tokText(this.peek())}"`);
        for (;;) {
          let ptr = 0;
          while (this.accept('*')) ptr++;
          const name = this.ident('a field name');
          if (this.isOp('(')) this.fail('functions inside a struct aren\'t supported in the simulator. Write a normal function that takes the struct instead');
          const dims = [];
          while (this.accept('[')) { dims.push(this.isOp(']') ? null : this.parseAssign()); this.expect(']'); }
          let init = null;
          if (this.accept('=')) init = this.isOp('{') ? this.parseInitList() : this.parseAssign();
          let fty = ty;
          if (ptr) { if (ty.k === 'char') fty = Object.assign({}, T.str); else this.fail('pointers (*) aren\'t supported in the simulator', line); }
          fields.push({ name, type: fty, dims, init, line });
          if (!this.accept(',')) break;
        }
        this.expect(';');
      }
      return fields;
    }

    parseEnumBody() {
      this.expect('{');
      const items = [];
      while (!this.accept('}')) {
        const name = this.ident('an enum value name');
        let value = null;
        if (this.accept('=')) value = this.parseTernary();
        items.push({ name, value });
        if (!this.accept(',')) { this.expect('}', 'to close the enum'); break; }
      }
      return items;
    }

    /** Is the '(' at the current position the start of a parameter list? */
    looksLikeParams() {
      if (!this.isOp('(')) return false;
      const t1 = this.peek(1);
      if (t1.t === 'op' && t1.v === ')') return true;
      if (t1.t !== 'id') return false;
      if (QUALS.has(t1.v) || TYPE_WORDS.has(t1.v) || this.types.has(t1.v) || t1.v === 'struct' || t1.v === 'enum') return true;
      if (this.libClasses.has(t1.v) || this.seenClasses.has(t1.v)) {
        const t2 = this.peek(2);
        return t2.t === 'id' || (t2.t === 'op' && (t2.v === '&' || t2.v === '*' || t2.v === ')' || t2.v === ','));
      }
      const t2 = this.peek(2);
      // Unknown type followed by a name: Foo bar
      return t2.t === 'id' || (t2.t === 'op' && (t2.v === '&' || t2.v === '*') && this.peek(3).t === 'id');
    }

    parseDeclaration(topLevel) {
      const line = this.peek().line;
      const ty = this.parseType();
      if (!ty) this.fail(`expected a type but found "${tokText(this.peek())}"`);
      // Function definition or prototype?
      if (topLevel) {
        const save = this.pos;
        let ptr = 0;
        while (this.accept('*')) ptr++;
        const ref = this.accept('&');
        const t = this.peek();
        if (t.t === 'id' && this.isOp('(', 1)) {
          this.pos++;
          if (this.looksLikeParams() || ty.k === 'void') {
            if (ptr && ty.k !== 'char') this.fail('functions that return pointers aren\'t supported in the simulator', t.line);
            const ret = ptr ? Object.assign({}, T.str) : ty;
            return this.parseFunction(ret, t.v, t.line, ref);
          }
        }
        this.pos = save;
      }
      return this.parseDeclaratorsFor(ty, topLevel, line);
    }

    parseDeclaratorsFor(ty, topLevel, line) {
      const decls = [];
      for (;;) {
        let ptr = 0;
        for (;;) {
          if (this.accept('*')) { ptr++; continue; }
          if (ptr && this.accept('const')) continue;
          break;
        }
        let ref = false;
        if (this.accept('&') || this.accept('&&')) ref = true;
        const nameTok = this.peek();
        if (nameTok.t === 'op' && nameTok.v === '(') this.fail('function pointers aren\'t supported in the simulator');
        const name = this.ident('a variable name');
        const dims = [];
        while (this.accept('[')) { dims.push(this.isOp(']') ? null : this.parseExpr()); this.expect(']'); }
        while (this.peek().t === 'id' && QUALS.has(this.peek().v)) this.pos++;
        let init = null, ctor = null;
        if (this.accept('=')) init = this.isOp('{') ? this.parseInitList() : this.parseAssign();
        else if (this.isOp('(')) ctor = this.parseArgs();
        else if (this.isOp('{')) { const il = this.parseInitList(); if (ty.k === 'obj') ctor = il.items; else init = il; }
        decls.push({ name, dims, init, ctor, ptr, ref, line: nameTok.line });
        if (!this.accept(',')) break;
      }
      this.expect(';');
      return { s: 'decl', type: ty, decls, line, top: !!topLevel };
    }

    parseFunction(ret, name, line, retRef) {
      this.expect('(');
      const params = [];
      if (!this.accept(')')) {
        if (this.is('void') && this.isOp(')', 1)) { this.pos += 2; }
        else {
          for (;;) {
            if (this.accept('...')) this.fail('functions with "..." aren\'t supported in the simulator');
            const pline = this.peek().line;
            const ty = this.parseType();
            if (!ty) this.fail(`expected a parameter type but found "${tokText(this.peek())}"`);
            let ptr = 0;
            while (this.accept('*')) { ptr++; this.accept('const'); }
            const ref = this.accept('&') || this.accept('&&');
            let pname = null;
            if (this.peek().t === 'id') pname = this.next().v;
            const dims = [];
            while (this.accept('[')) { dims.push(this.isOp(']') ? null : this.parseExpr()); this.expect(']'); }
            let dflt = null;
            if (this.accept('=')) dflt = this.parseAssign();
            params.push({ type: ty, name: pname, ptr, ref, dims, dflt, line: pline });
            if (this.accept(',')) continue;
            this.expect(')', 'to close the parameter list');
            break;
          }
        }
      }
      while (this.accept('const') || this.accept('override') || this.accept('noexcept')) { /* ignore */ }
      if (this.accept(';')) return { s: 'proto', name, ret, params, line };
      if (!this.isOp('{')) this.fail(`expected "{" to start the body of ${name}()`);
      const body = this.parseBlock();
      return { s: 'func', name, ret, params, body, line, endLine: this.prevLine() };
    }

    // ------------------------------------------------------------ statements
    parseBlock() {
      const line = this.peek().line;
      this.expect('{');
      const body = [];
      while (!this.isOp('}')) {
        if (this.peek().t === 'eof') this.fail('a { is never closed with }', line);
        const st = this.parseStatement();
        if (st) body.push(st);
      }
      this.pos++;
      return { s: 'block', body, line };
    }

    parseStatement() {
      const t = this.peek();
      const line = t.line;
      if (t.t === 'op') {
        if (t.v === '{') return this.parseBlock();
        if (t.v === ';') { this.pos++; return { s: 'empty', line }; }
      }
      if (t.t === 'pp') { this.pos++; return null; }
      if (t.t === 'id') {
        switch (t.v) {
          case 'if': {
            this.pos++; this.expect('('); const c = this.parseExpr(); this.expect(')', 'after the if condition');
            const a = this.parseStatement();
            let b = null;
            if (this.accept('else')) b = this.parseStatement();
            return { s: 'if', c, a, b, line };
          }
          case 'while': {
            this.pos++; this.expect('('); const c = this.parseExpr(); this.expect(')', 'after the while condition');
            return { s: 'while', c, body: this.parseStatement(), line };
          }
          case 'do': {
            this.pos++; const body = this.parseStatement();
            if (!this.accept('while')) this.fail('a do { ... } needs "while (...);" after it');
            this.expect('('); const c = this.parseExpr(); this.expect(')'); this.expect(';');
            return { s: 'do', c, body, line };
          }
          case 'for': return this.parseFor();
          case 'switch': {
            this.pos++; this.expect('('); const e = this.parseExpr(); this.expect(')');
            if (!this.isOp('{')) this.fail('switch needs { ... } with cases');
            const body = this.parseBlock();
            return { s: 'switch', e, body: body.body, line };
          }
          case 'case': {
            this.pos++;
            const v = this.parseTernary();
            if (this.accept('...')) this.fail('case ranges (case 1 ... 5) aren\'t supported in the simulator');
            this.expect(':', 'after the case value');
            return { s: 'case', v, line };
          }
          case 'default': this.pos++; this.expect(':', 'after default'); return { s: 'default', line };
          case 'break': this.pos++; this.expect(';'); return { s: 'break', line };
          case 'continue': this.pos++; this.expect(';'); return { s: 'continue', line };
          case 'return': {
            this.pos++;
            const e = this.isOp(';') ? null : this.parseExpr();
            this.expect(';');
            return { s: 'return', e, line };
          }
          case 'goto': this.fail('goto isn\'t supported in the simulator');
          // falls through (fail throws)
          case 'try': case 'catch': case 'throw': this.fail('try / catch / throw aren\'t supported in the simulator');
          // falls through
          case 'else': this.fail('"else" without a matching "if" (check your { } braces)');
          // falls through
          default: break;
        }
        if (this.isOp(':', 1) && !STMT_KEYWORDS.has(t.v) && !TYPE_WORDS.has(t.v)) this.fail('labels and goto aren\'t supported in the simulator');
        const def = this.parseTypeDefinition();
        if (def !== undefined) return def;
        if (this.isDeclStart()) return this.parseDeclaration(false);
      }
      const e = this.parseExpr();
      this.expect(';');
      return { s: 'expr', e, line };
    }

    parseFor() {
      const line = this.peek().line;
      this.pos++;
      this.expect('(');
      // range-for: for (T x : arr)
      if (this.isDeclStart()) {
        const save = this.pos;
        const ty = this.parseType();
        if (ty) {
          while (this.accept('*')) { /* */ }
          this.accept('&'); this.accept('&&');
          if (this.peek().t === 'id' && this.isOp(':', 1)) {
            const name = this.next().v;
            this.pos++;
            const iter = this.parseExpr();
            this.expect(')');
            return { s: 'forof', type: ty, name, iter, body: this.parseStatement(), line };
          }
        }
        this.pos = save;
      }
      let init = null;
      if (this.accept(';')) init = null;
      else if (this.isDeclStart()) init = this.parseDeclaration(false);
      else { init = { s: 'expr', e: this.parseExpr(), line }; this.expect(';'); }
      const c = this.isOp(';') ? null : this.parseExpr();
      this.expect(';');
      const u = this.isOp(')') ? null : this.parseExpr();
      this.expect(')', 'to close the for (...)');
      return { s: 'for', init, c, u, body: this.parseStatement(), line };
    }

    // ------------------------------------------------------------ expressions
    parseExpr() {
      const line = this.peek().line;
      const a = this.parseAssign();
      if (!this.isOp(',')) return a;
      const list = [a];
      while (this.accept(',')) list.push(this.parseAssign());
      return { n: 'comma', list, line };
    }

    parseAssign() {
      const line = this.peek().line;
      const left = this.parseTernary();
      const t = this.peek();
      if (t.t === 'op' && ASSIGN_OPS.has(t.v)) {
        this.pos++;
        const value = this.isOp('{') ? this.parseInitList() : this.parseAssign();
        return { n: 'assign', op: t.v, target: left, value, line };
      }
      return left;
    }

    parseTernary() {
      const line = this.peek().line;
      const c = this.parseBinary(1);
      if (!this.accept('?')) return c;
      const a = this.parseExpr();
      this.expect(':', 'in the ? : expression');
      const b = this.parseAssign();
      return { n: 'tern', c, a, b, line };
    }

    parseBinary(min) {
      let left = this.parseUnary();
      for (;;) {
        const t = this.peek();
        if (t.t !== 'op') break;
        const prec = BIN_PREC[t.v];
        if (prec == null || prec < min) break;
        this.pos++;
        const right = this.parseBinary(prec + 1);
        left = { n: 'bin', op: t.v, a: left, b: right, line: t.line };
      }
      return left;
    }

    /** '(' type ')' ahead? */
    isCast() {
      if (!this.isOp('(')) return false;
      let k = 1;
      const t1 = this.peek(1);
      if (t1.t !== 'id') return false;
      const known = (v) => TYPE_WORDS.has(v) || QUALS.has(v) || this.types.has(v);
      if (!known(t1.v) && !(t1.v === 'struct' || t1.v === 'enum')) return false;
      if (t1.v === 'String' && !this.isOp(')', 2)) return false;
      while (this.peek(k).t === 'id' && (known(this.peek(k).v) || this.peek(k).v === 'struct' || this.peek(k).v === 'enum' || (k > 1 && this.types.has(this.peek(k).v)))) k++;
      while (this.isOp('*', k)) k++;
      return this.isOp(')', k);
    }

    parseUnary() {
      const t = this.peek();
      const line = t.line;
      if (t.t === 'op') {
        if (t.v === '!' || t.v === '~' || t.v === '-' || t.v === '+') { this.pos++; return { n: 'un', op: t.v, a: this.parseUnary(), line }; }
        if (t.v === '++' || t.v === '--') { this.pos++; return { n: 'pre', op: t.v, a: this.parseUnary(), line }; }
        if (t.v === '&') { this.pos++; return { n: 'addr', a: this.parseUnary(), line }; }
        if (t.v === '*') { this.pos++; this.parseUnary(); this.fail('pointers (*) aren\'t supported in the simulator', line); }
        if (t.v === '(' && this.isCast()) {
          this.pos++;
          const ty = this.parseType();
          let ptr = 0;
          while (this.accept('*')) ptr++;
          this.expect(')');
          if (ptr && ty.k !== 'char') this.fail('pointer casts aren\'t supported in the simulator', line);
          return { n: 'cast', type: ptr ? Object.assign({}, T.str) : ty, a: this.parseUnary(), line };
        }
      }
      if (t.t === 'id') {
        if (t.v === 'sizeof') {
          this.pos++;
          if (this.isOp('(')) {
            const save = this.pos;
            this.pos++;
            if (this.peek().t === 'id' && (TYPE_WORDS.has(this.peek().v) || QUALS.has(this.peek().v) || this.types.has(this.peek().v) || this.libClasses.has(this.peek().v))) {
              const ty = this.parseType();
              if (ty && this.accept(')')) return { n: 'sizeof', type: ty, line };
            }
            this.pos = save;
          }
          return { n: 'sizeof', a: this.parseUnary(), line };
        }
        if (t.v === 'new' || t.v === 'delete') this.fail(`"${t.v}" isn't supported in the simulator. Declare the object as a normal variable, like: Servo myServo;`);
        if (t.v === 'this') this.fail('"this" isn\'t supported in the simulator');
      }
      return this.parsePostfix(this.parsePrimary());
    }

    parseArgs() {
      this.expect('(');
      const args = [];
      if (this.accept(')')) return args;
      for (;;) {
        args.push(this.isOp('{') ? this.parseInitList() : this.parseAssign());
        if (this.accept(',')) continue;
        this.expect(')', 'to close the function call');
        return args;
      }
    }

    parsePostfix(e) {
      for (;;) {
        const t = this.peek();
        if (t.t !== 'op') return e;
        if (t.v === '(') { const args = this.parseArgs(); e = { n: 'call', fn: e, args, line: t.line }; continue; }
        if (t.v === '[') { this.pos++; const i = this.parseExpr(); this.expect(']'); e = { n: 'idx', a: e, i, line: t.line }; continue; }
        if (t.v === '.' || t.v === '->') { this.pos++; const name = this.ident('a member name after "' + t.v + '"'); e = { n: 'mem', a: e, name, line: t.line }; continue; }
        if (t.v === '++' || t.v === '--') { this.pos++; e = { n: 'post', op: t.v, a: e, line: t.line }; continue; }
        return e;
      }
    }

    parseInitList() {
      const line = this.peek().line;
      this.expect('{');
      const items = [];
      while (!this.accept('}')) {
        if (this.isOp('.') && this.peek(1).t === 'id' && this.isOp('=', 2)) this.fail('designated initializers (.name = value) aren\'t supported in the simulator');
        items.push(this.isOp('{') ? this.parseInitList() : this.parseAssign());
        if (!this.accept(',')) { this.expect('}', 'to close the { list }'); break; }
      }
      return { n: 'init', items, line };
    }

    parsePrimary() {
      const t = this.next();
      const line = t.line;
      switch (t.t) {
        case 'num': return { n: 'num', v: t.v, f: t.f, u: t.u, line };
        case 'chr': return { n: 'chr', v: t.v, line };
        case 'str': {
          let v = t.v;
          while (this.peek().t === 'str') v += this.next().v;
          return { n: 'str', v, line };
        }
        case 'id': {
          const v = t.v;
          if (v === 'true' || v === 'false') return { n: 'bool', v: v === 'true', line };
          if (v === 'NULL' || v === 'nullptr') return { n: 'num', v: 0, f: false, line, isNull: true };
          if (v === 'static_cast' || v === 'reinterpret_cast' || v === 'const_cast' || v === 'dynamic_cast') {
            this.expect('<');
            const ty = this.parseType();
            if (!ty) this.fail('expected a type in ' + v + '<...>');
            let ptr = 0;
            while (this.accept('*')) ptr++;
            if (ptr && ty.k !== 'char') this.fail('pointer casts aren\'t supported in the simulator', line);
            this.expect('>');
            this.expect('(');
            const a = this.parseExpr();
            this.expect(')');
            return { n: 'cast', type: ptr ? Object.assign({}, T.str) : ty, a, line };
          }
          if (TYPE_WORDS.has(v) && this.isOp('(')) {
            // functional cast: int(x), float(x), String(x)
            if (v === 'String') return { n: 'id', name: 'String', line };
            const ty = typeFromWords([v], line);
            this.expect('(');
            const a = this.parseExpr();
            this.expect(')');
            return { n: 'cast', type: ty, a, line };
          }
          if (v === 'std' && this.isOp('::')) { this.pos++; const name = this.ident(); return { n: 'id', name, line, std: true }; }
          if (this.isOp('::') && this.peek(1).t === 'id') {
            const parts = [v];
            while (this.isOp('::') && this.peek(1).t === 'id') { this.pos++; parts.push(this.next().v); }
            return { n: 'scope', parts, line };
          }
          return { n: 'id', name: v, line };
        }
        case 'op':
          if (t.v === '(') { const e = this.parseExpr(); this.expect(')'); return { n: 'paren', e, line }; }
          if (t.v === '{') { this.pos--; return this.parseInitList(); }
          if (t.v === '[') this.fail('lambdas ([](){...}) aren\'t supported in the simulator. Use a normal function', line);
          if (t.v === '::') return this.parsePrimary();
          this.fail(`unexpected "${t.v}"`, line);
        // falls through
        case 'eof': this.fail('the code ended in the middle of a statement', this.prevLine());
        // falls through
        default: this.fail(`unexpected "${tokText(t)}"`, line);
      }
      return null;
    }
  }

  // ===================================================================
  // Emitter: AST -> async JavaScript
  // ===================================================================

  const JS_RESERVED = new Set(('abstract arguments await boolean break byte case catch char class const continue debugger default delete do double else enum eval ' +
    'export extends false final finally float for function goto if implements import in instanceof int interface let long native new null package ' +
    'private protected public return short static super switch synchronized this throw throws transient true try typeof var void volatile while ' +
    'with yield undefined NaN Infinity Math Object Array JSON Number Promise Symbol Function Reflect Proxy globalThis setTimeout').split(' '));
  const mangle = (name) => (JS_RESERVED.has(name) || name.startsWith('__') ? name + '$' : name);

  // Arduino / ESP32 constants. Numbers, or strings for SD file modes.
  const CONSTS = {
    HIGH: 1, LOW: 0, INPUT: 1, OUTPUT: 3, INPUT_PULLUP: 5, INPUT_PULLDOWN: 9, OUTPUT_OPEN_DRAIN: 19, PULLUP: 4, PULLDOWN: 8,
    CHANGE: 3, RISING: 1, FALLING: 2, ONLOW: 4, ONHIGH: 5, DEC: 10, HEX: 16, OCT: 8, BIN: 2, LSBFIRST: 0, MSBFIRST: 1,
    LED_BUILTIN: 2, BUILTIN_LED: 2, SDA: 21, SCL: 22, SS: 5, MOSI: 23, MISO: 19, SCK: 18, TX: 1, RX: 3,
    A0: 36, A3: 39, A4: 32, A5: 33, A6: 34, A7: 35, A10: 4, A11: 0, A12: 2, A13: 15, A14: 13, A15: 12, A16: 14, A17: 27, A18: 25, A19: 26,
    T0: 4, T1: 0, T2: 2, T3: 15, T4: 13, T5: 12, T6: 14, T7: 27, T8: 33, T9: 32, DAC1: 25, DAC2: 26,
    PI: Math.PI, HALF_PI: Math.PI / 2, TWO_PI: Math.PI * 2, DEG_TO_RAD: Math.PI / 180, RAD_TO_DEG: 180 / Math.PI, EULER: Math.E, M_PI: Math.PI,
    NO_KEY: 0, IDLE: 0, PRESSED: 1, HOLD: 2, RELEASED: 3,
    DHT11: 11, DHT12: 12, DHT21: 21, DHT22: 22, AM2301: 21,
    NEO_GRB: 0x52, NEO_RGB: 0x06, NEO_RBG: 0x09, NEO_GRBW: 0xd2, NEO_RGBW: 0x1b, NEO_KHZ800: 0, NEO_KHZ400: 0x100,
    SSD1306_SWITCHCAPVCC: 2, SSD1306_EXTERNALVCC: 1, SSD1306_WHITE: 1, SSD1306_BLACK: 0, SSD1306_INVERSE: 2, WHITE: 1, BLACK: 0, INVERSE: 2,
    SH110X_WHITE: 1, SH110X_BLACK: 0, SH110X_INVERSE: 2, SSD1306_LCDWIDTH: 128, SSD1306_LCDHEIGHT: 64,
    SERIAL_8N1: 0x800001c, SERIAL_8E1: 0x800001e, SERIAL_8N2: 0x800003c,
    FILE_READ: 'r', FILE_WRITE: 'w', FILE_APPEND: 'a',
    WL_IDLE_STATUS: 0, WL_NO_SSID_AVAIL: 1, WL_SCAN_COMPLETED: 2, WL_CONNECTED: 3, WL_CONNECT_FAILED: 4, WL_CONNECTION_LOST: 5, WL_DISCONNECTED: 6,
    WIFI_OFF: 0, WIFI_STA: 1, WIFI_AP: 2, WIFI_AP_STA: 3,
    DEVICE_DISCONNECTED_C: -127, DEVICE_DISCONNECTED_F: -196.6, ENABLE_LED_FEEDBACK: 1, DISABLE_LED_FEEDBACK: 0, USE_DEFAULT_FEEDBACK_LED_PIN: 0, NEC: 8,
    IRDATA_FLAGS_IS_REPEAT: 1,
    MPU6050_RANGE_2_G: 0, MPU6050_RANGE_4_G: 1, MPU6050_RANGE_8_G: 2, MPU6050_RANGE_16_G: 3,
    MPU6050_RANGE_250_DEG: 0, MPU6050_RANGE_500_DEG: 1, MPU6050_RANGE_1000_DEG: 2, MPU6050_RANGE_2000_DEG: 3,
    MPU6050_BAND_260_HZ: 0, MPU6050_BAND_184_HZ: 1, MPU6050_BAND_94_HZ: 2, MPU6050_BAND_44_HZ: 3, MPU6050_BAND_21_HZ: 4, MPU6050_BAND_10_HZ: 5, MPU6050_BAND_5_HZ: 6,
    DFPLAYER_EQ_NORMAL: 0, DFPLAYER_EQ_POP: 1, DFPLAYER_EQ_ROCK: 2, DFPLAYER_EQ_JAZZ: 3, DFPLAYER_EQ_CLASSIC: 4, DFPLAYER_EQ_BASS: 5,
    DFPLAYER_DEVICE_U_DISK: 1, DFPLAYER_DEVICE_SD: 2, DFPlayerPlayFinished: 5, DFPlayerError: 6, DFPlayerCardInserted: 7,
    CARD_NONE: 0, CARD_MMC: 1, CARD_SD: 2, CARD_SDHC: 3, CARD_UNKNOWN: 4,
    ADC_0db: 0, ADC_2_5db: 1, ADC_6db: 2, ADC_11db: 3, ADC_ATTENDB_MAX: 3,
    BME280_ADDRESS: 0x77, BME280_ADDRESS_ALTERNATE: 0x76, SEALEVELPRESSURE_HPA: 1013.25,
    UINT8_MAX: 255, INT8_MAX: 127, UINT16_MAX: 65535, INT16_MAX: 32767, INT_MAX: 2147483647, INT_MIN: -2147483648, INT32_MAX: 2147483647,
    UINT32_MAX: 4294967295, LONG_MAX: 2147483647, LONG_MIN: -2147483648, ULONG_MAX: 4294967295, RAND_MAX: 2147483647, FLT_MAX: 3.4028235e38,
    ESP_OK: 0, ESP_FAIL: -1,
  };
  const FLOAT_CONSTS = new Set(['PI', 'HALF_PI', 'TWO_PI', 'DEG_TO_RAD', 'RAD_TO_DEG', 'EULER', 'M_PI', 'SEALEVELPRESSURE_HPA', 'FLT_MAX', 'DEVICE_DISCONNECTED_F']);

  // Global objects the runtime provides.
  const GLOBAL_OBJECTS = new Set(['Serial', 'Serial0', 'Serial1', 'Serial2', 'Wire', 'Wire1', 'SPI', 'SD', 'SPIFFS', 'LittleFS', 'WiFi', 'ESP',
    'IrReceiver', 'IrSender', 'EEPROM', 'BLEDevice', 'mp3', 'NAN_', 'MDNS', 'ArduinoOTA', 'Update']);
  GLOBAL_OBJECTS.delete('mp3'); GLOBAL_OBJECTS.delete('NAN_');

  // Library classes the runtime models (others become quiet stand-ins).
  const LIB_CLASSES = new Set(['Servo', 'ESP32PWM', 'DHT', 'DHTesp', 'Adafruit_SSD1306', 'Adafruit_SH1106G', 'Adafruit_SH1106', 'Adafruit_SH1107',
    'LiquidCrystal_I2C', 'LiquidCrystal', 'TM1637Display', 'Adafruit_NeoPixel', 'MD_MAX72XX', 'LedControl', 'NewPing', 'Adafruit_VL53L0X',
    'VL53L0X', 'VL53L0X_RangingMeasurementData_t', 'Adafruit_BME280', 'Adafruit_BMP280', 'OneWire', 'DallasTemperature', 'DeviceAddress',
    'Adafruit_MPU6050', 'MPU6050', 'sensors_event_t', 'Keypad', 'IRrecv', 'decode_results', 'MFRC522', 'File', 'RTC_DS3231', 'RTC_DS1307',
    'RTC_PCF8523', 'RTC_Millis', 'DateTime', 'TimeSpan', 'HX711', 'TinyGPSPlus', 'DFRobotDFPlayerMini', 'Stepper', 'MAX30105', 'HardwareSerial',
    'BluetoothSerial', 'Preferences', 'WebServer', 'WiFiServer', 'WiFiClient', 'HTTPClient', 'IPAddress', 'Ticker', 'MD_Parola', 'AccelStepper',
    'Adafruit_GFX', 'TwoWire', 'SPIClass', 'WiFiUDP', 'NTPClient', 'TinyGPS', 'SoftwareSerial', 'ESP32Encoder', 'AsyncWebServer', 'BLEServer', 'U8G2']);

  // Free functions: return type letter, '!' = must be awaited.
  //   i int, u unsigned, f float, b bool, c char, s String, v void, a any, n number like the arguments
  const BUILTIN_FNS = {
    millis: 'u', micros: 'u', delay: 'v!', delayMicroseconds: 'v!', yield: 'v!',
    pinMode: 'v', digitalWrite: 'v', digitalRead: 'i', analogRead: 'i', analogWrite: 'v', analogReadMilliVolts: 'i',
    analogReadResolution: 'v', analogWriteResolution: 'v', analogWriteFrequency: 'v', analogSetAttenuation: 'v', analogSetPinAttenuation: 'v', analogSetWidth: 'v',
    ledcSetup: 'u', ledcAttachPin: 'v', ledcAttach: 'b', ledcAttachChannel: 'b', ledcWrite: 'b', ledcWriteTone: 'u', ledcWriteNote: 'u', ledcRead: 'u',
    ledcReadFreq: 'u', ledcDetachPin: 'v', ledcDetach: 'b', ledcChangeFrequency: 'u', ledcFade: 'b',
    tone: 'v', noTone: 'v', pulseIn: 'u', pulseInLong: 'u', shiftOut: 'v', shiftIn: 'i',
    attachInterrupt: 'v', detachInterrupt: 'v', digitalPinToInterrupt: 'i', interrupts: 'v', noInterrupts: 'v', sei: 'v', cli: 'v',
    map: 'i', constrain: 'n', min: 'n', max: 'n', abs: 'n', sq: 'n', sqrt: 'f', pow: 'f', sin: 'f', cos: 'f', tan: 'f', asin: 'f', acos: 'f',
    atan: 'f', atan2: 'f', exp: 'f', log: 'f', log10: 'f', log2: 'f', floor: 'f', ceil: 'f', round: 'f', fabs: 'f', fmod: 'f', fmin: 'f', fmax: 'f',
    trunc: 'f', lround: 'i', cbrt: 'f', hypot: 'f', fabsf: 'f', sqrtf: 'f', powf: 'f', floorf: 'f', ceilf: 'f', roundf: 'f',
    radians: 'f', degrees: 'f', isnan: 'b', isinf: 'b', random: 'i', randomSeed: 'v', esp_random: 'u', rand: 'i', srand: 'v',
    bitRead: 'i', bitWrite: 'v', bitSet: 'v', bitClear: 'v', bit: 'u', lowByte: 'i', highByte: 'i', word: 'i',
    isDigit: 'b', isAlpha: 'b', isAlphaNumeric: 'b', isSpace: 'b', isWhitespace: 'b', isUpperCase: 'b', isLowerCase: 'b', isPunct: 'b',
    isPrintable: 'b', isHexadecimalDigit: 'b', isAscii: 'b', isControl: 'b', isGraph: 'b', isdigit: 'b', isalpha: 'b', isspace: 'b',
    isupper: 'b', islower: 'b', isalnum: 'b', toupper: 'c', tolower: 'c', toUpperCase: 'c', toLowerCase: 'c',
    atoi: 'i', atol: 'i', atof: 'f', strtol: 'i', strtoul: 'u', strtof: 'f', strtod: 'f', strlen: 'i', strcmp: 'i', strncmp: 'i',
    strcasecmp: 'i', strstr: 'a', strchr: 'a', makeKeymap: 'a', touchRead: 'i', hallRead: 'i', temperatureRead: 'f', dacWrite: 'v',
    checkForBeat: 'b', esp_deep_sleep_start: 'v!', esp_light_sleep_start: 'v!', esp_sleep_enable_timer_wakeup: 'v', esp_sleep_enable_ext0_wakeup: 'v',
    esp_restart: 'v!', configTime: 'v', getLocalTime: 'b', time: 'i', printf: 'i', puts: 'i', putchar: 'i', setCpuFrequencyMhz: 'b',
    getCpuFrequencyMhz: 'u', touchAttachInterrupt: 'v', esp_timer_get_time: 'i', disableCore0WDT: 'v', disableCore1WDT: 'v',
    vTaskDelay: 'v!', pdMS_TO_TICKS: 'i', xTaskCreate: 'v', xTaskCreatePinnedToCore: 'v', swap: 'v',
  };
  const typeFromLetter = (l) => ({ i: T.int, u: T.uint, f: T.float, b: T.bool, c: T.char, s: T.str, v: T.void, a: T.any }[l] || T.any);

  // Method return types, only used for printing / integer division.
  const METHOD_TYPES = {
    readTemperature: T.float, readHumidity: T.float, readPressure: T.float, readAltitude: T.float, getTempCByIndex: T.float,
    getTempFByIndex: T.float, getTempC: T.float, getTempF: T.float, computeHeatIndex: T.float, convertCtoF: T.float, convertFtoC: T.float,
    get_units: T.float, get_scale: T.float, toFloat: T.float, toDouble: T.float, parseFloat: T.float, lat: T.float, lng: T.float, meters: T.float,
    feet: T.float, kmph: T.float, mph: T.float, mps: T.float, knots: T.float, deg: T.float, hdop: T.float, getTemperature: T.float,
    getHumidity: T.float, readSealevelPressure: T.float, readTempC: T.float, readTempF: T.float,
    getKey: T.char, waitForKey: T.char, getChar: T.char, charAt: T.char,
    readString: T.str, readStringUntil: T.str, substring: T.str, c_str: T.str, timestamp: T.str, PICC_GetTypeName: T.str, getStatusString: T.str,
    SSID: T.str, macAddress: T.str, getChipModel: T.str, getString: T.str, readStringUntilChar: T.str,
    decode: T.bool, isUpdated: T.bool, isValid: T.bool, equals: T.bool, equalsIgnoreCase: T.bool, startsWith: T.bool, endsWith: T.bool,
    is_ready: T.bool, PICC_IsNewCardPresent: T.bool, PICC_ReadCardSerial: T.bool, isPressed: T.bool, lostPower: T.bool, isEmpty: T.bool,
    isConnected: T.bool, attached: T.bool,
    length: T.int, indexOf: T.int, lastIndexOf: T.int, toInt: T.int, available: T.int, read: T.int, readRange: T.int, getIR: T.uint, getRed: T.uint,
    numPixels: T.int, Color: T.uint, ColorHSV: T.uint, getPixelColor: T.uint, gamma32: T.uint, width: T.int, height: T.int, getCursorX: T.int,
    getCursorY: T.int, year: T.int, month: T.int, day: T.int, hour: T.int, minute: T.int, second: T.int, dayOfTheWeek: T.int, unixtime: T.uint,
    ping_cm: T.uint, ping_in: T.uint, ping: T.uint, ping_median: T.uint, readRangeSingleMillimeters: T.int, readRangeContinuousMillimeters: T.int,
    getDeviceCount: T.int, parseInt: T.int, peek: T.int, getCount: T.int, compareTo: T.int, getInt: T.int, getUInt: T.uint, status: T.int,
    readRangeResult: T.int, getBrightness: T.int, getFreeHeap: T.uint, getAccelerationX: T.int, getAccelerationY: T.int, getAccelerationZ: T.int,
    getRotationX: T.int, getRotationY: T.int, getRotationZ: T.int, readVolume: T.int, readState: T.int, readFileCounts: T.int,
  };
  const ASYNC_METHODS = new Set(['step', 'waitForKey', 'runToPosition', 'runToNewPosition', 'runSpeedToPosition']);

  // Arduino String methods (runtime in $.S). value: [return type, 'inplace' | 'out' | null]
  const STR_METHODS = {
    length: [T.int], charAt: [T.char], substring: [T.str], indexOf: [T.int], lastIndexOf: [T.int], toInt: [T.int], toFloat: [T.float],
    toDouble: [T.float], equals: [T.bool], equalsIgnoreCase: [T.bool], startsWith: [T.bool], endsWith: [T.bool], compareTo: [T.int],
    c_str: [T.str], isEmpty: [T.bool], concat: [T.bool, 'inplace'], toUpperCase: [T.void, 'inplace'], toLowerCase: [T.void, 'inplace'],
    trim: [T.void, 'inplace'], replace: [T.void, 'inplace'], remove: [T.void, 'inplace'], setCharAt: [T.void, 'inplace'], reserve: [T.bool],
    toCharArray: [T.void, 'out'], getBytes: [T.void, 'out'], begin: [T.any], end: [T.any], charCodeAt: [T.int],
  };

  const PRINT_HINT = (t) => (!t || isArr(t) ? null : t.k === 'float' ? '"f"' : t.k === 'char' ? '"c"' : t.k === 'bool' ? '"b"' : t.k === 'int' ? '"i"' : null);

  function applyConv(conv, c) {
    switch (conv) {
      case 'u32': return '((' + c + ') >>> 0)';
      case 'u8': return '((' + c + ') & 255)';
      case 'i8': return '((' + c + ') << 24 >> 24)';
      case 'u16': return '((' + c + ') & 65535)';
      case 'i16': return '((' + c + ') << 16 >> 16)';
      case 'i64': case 'u64': return '$.trunc(' + c + ')';
      default: return '((' + c + ') | 0)';
    }
  }
  const CONV_RANGE = { u32: [0, 4294967295], u8: [0, 255], i8: [-128, 127], u16: [0, 65535], i16: [-32768, 32767], i32: [-2147483648, 2147483647] };

  class Emitter {
    constructor(items, parser) {
      this.items = items;
      this.parser = parser;
      this.scopes = [new Map()];
      this.funcs = new Map();      // name -> [{ js, ret, params, minArgs }]
      this.structs = new Map();    // name -> { js, fields }
      this.enumClasses = new Map();
      this.hoisted = [];
      this.warnings = [];
      this.warned = new Set();
      this.fn = null;
      this.uid = 0;
    }

    warn(msg, line) {
      if (this.warned.has(msg)) return;
      this.warned.add(msg);
      this.warnings.push({ msg, line });
    }
    fail(msg, line) { throw simErr(msg, line); }

    push() { this.scopes.push(new Map()); }
    pop() { this.scopes.pop(); }
    declare(name, sym, line) {
      const top = this.scopes[this.scopes.length - 1];
      if (top.has(name) && top.get(name).kind === 'var' && this.scopes.length > 1) this.fail(`"${name}" is already declared here`, line);
      top.set(name, sym);
      return sym;
    }
    lookup(name) {
      for (let i = this.scopes.length - 1; i >= 0; i--) if (this.scopes[i].has(name)) return this.scopes[i].get(name);
      return null;
    }

    // ---------------------------------------------------------------- program
    program() {
      // Pass 1: function signatures (Arduino lets you call a function before it is written).
      const sigs = [];
      const collect = (it) => { if (!it) return; if (it.s === 'multi') it.items.forEach(collect); else if (it.s === 'func' || it.s === 'proto') sigs.push(it); };
      this.items.forEach(collect);
      for (const f of sigs) {
        const list = this.funcs.get(f.name) || [];
        const params = f.params.map((p) => this.paramType(p));
        const minArgs = f.params.filter((p) => !p.dflt).length;
        const existing = list.find((o) => o.params.length === params.length);
        if (existing) {
          if (f.s === 'func' && existing.defined) this.fail(`${f.name}() is written twice with the same number of inputs`, f.line);
          if (f.s === 'func') { existing.defined = true; existing.node = f; existing.ret = f.ret; existing.params = params; existing.minArgs = minArgs; }
          continue;
        }
        list.push({ name: f.name, ret: f.ret, params, minArgs, defined: f.s === 'func', node: f.s === 'func' ? f : null });
        this.funcs.set(f.name, list);
      }
      for (const [name, list] of this.funcs) {
        const defined = list.filter((o) => o.defined);
        if (!defined.length) {
          const proto = list[0];
          if (name === 'setup' || name === 'loop') continue;
          this.warn(`${name}() is declared but never written, so calling it does nothing`, proto.node ? proto.node.line : 0);
        }
        list.forEach((o, i) => { o.js = list.length > 1 ? mangle(name) + '$' + o.params.length : mangle(name); o.idx = i; });
      }
      const has = (n) => (this.funcs.get(n) || []).some((o) => o.defined);
      if (!has('setup') && !has('loop')) this.fail('your code needs a setup() function and a loop() function, like every Arduino sketch', 1);
      if (!has('setup')) this.fail('your code needs a setup() function (it runs once at the start)', 1);
      if (!has('loop')) this.fail('your code needs a loop() function (it runs over and over)', 1);

      const out = [];
      const funcsOut = [];
      const emitItem = (it) => {
        if (!it) return;
        switch (it.s) {
          case 'multi': it.items.forEach(emitItem); break;
          case 'struct': out.push(this.structDef(it)); break;
          case 'enum': out.push(this.enumDef(it)); break;
          case 'decl': out.push(this.decl(it) + ';'); break;
          case 'func': funcsOut.push(this.func(it)); break;
          case 'proto': break;
          default: break;
        }
      };
      this.items.forEach(emitItem);
      // Declare stubs for prototypes that never got a body.
      for (const [, list] of this.funcs) for (const o of list) if (!o.defined) funcsOut.push(`async function ${o.js}() { return 0; }`);
      const body = [
        'let __ln = 0;',
        '$.lineOf = () => __ln;',
        ...out,
        ...this.hoisted,
        ...funcsOut,
        `return { setup: ${this.funcs.get('setup')[0].js}, loop: ${this.funcs.get('loop')[0].js} };`,
      ];
      return '"use strict";\nreturn (async function () {\n' + body.join('\n') + '\n})();';
    }

    paramType(p) {
      let ty = p.type;
      if (p.ptr) ty = ty.k === 'char' ? Object.assign({}, T.str, { isConst: ty.isConst }) : withDims(ty, [null]);
      if (p.dims && p.dims.length) {
        if (ty.k === 'char' && p.dims.length === 1) ty = Object.assign({}, T.str);
        else ty = withDims(ty, p.dims.map(() => null));
      }
      return ty;
    }

    structDef(it) {
      const js = mangle(it.name) + '$S';
      this.structs.set(it.name, { js, fields: it.fields });
      const ps = it.fields.map((f, i) => 'a' + i);
      const assigns = it.fields.map((f, i) => {
        const fty = this.fieldType(f);
        const dflt = f.init ? this.initFor(fty, f.init, null, f.line) : this.defaultFor(fty, f.dims, f.line);
        return `this.${f.name} = a${i} === undefined ? ${dflt} : a${i};`;
      });
      return `class ${js} { constructor(${ps.join(', ')}) { ${assigns.join(' ')} } }`;
    }

    fieldType(f) {
      if (f.dims && f.dims.length) {
        if (f.type.k === 'char' && f.dims.length === 1) return Object.assign({}, T.str);
        return withDims(f.type, f.dims.map((d) => d));
      }
      return f.type;
    }

    enumDef(it) {
      let v = -1;
      const vals = [];
      for (const item of it.items) {
        v = item.value ? this.constEval(item.value, item.name) : v + 1;
        vals.push([item.name, v]);
        if (!it.cls) this.declare(item.name, { kind: 'const', value: v, type: T.int });
      }
      if (it.cls && it.name) {
        this.enumClasses.set(it.name, new Map(vals));
      }
      return '';
    }

    constEval(node, what) {
      const r = this.ex(node);
      try {
        // Only numbers, operators and $.trunc are allowed here.
        if (!/^[\d\s.+\-*/%()<>&|^~!eE$trunc]*$/.test(r.c.replace(/\$\.trunc|\$\.idiv|\$\.imod|,/g, ''))) throw new Error('x');
        const $ = { trunc: Math.trunc, idiv: (a, b) => Math.trunc(a / b), imod: (a, b) => a % b };
        const v = new Function('$', 'return (' + r.c + ');')($);
        if (typeof v !== 'number' || isNaN(v)) throw new Error('x');
        return v;
      } catch (e) {
        this.fail(`the value of ${what} must be a plain number`, node.line);
      }
      return 0;
    }

    defaultFor(ty, dims, line) {
      if (dims && dims.length) {
        if (ty.k === 'char' && dims.length === 1) return '""';
        const ds = dims.map((d) => (d == null ? 'null' : this.ex(d).c));
        return `$.arr([${ds.join(', ')}], null, () => ${this.defaultFor(ty, null, line)})`;
      }
      if (isArr(ty)) {
        const ds = ty.dims.map((d) => (d == null ? 'null' : (typeof d === 'object' ? this.ex(d).c : String(d))));
        return `$.arr([${ds.join(', ')}], null, () => ${this.defaultFor(elemT(withDims(ty, [ty.dims[ty.dims.length - 1]])), null, line)})`;
      }
      switch (ty.k) {
        case 'bool': return 'false';
        case 'str': return '""';
        case 'struct': return `new ${this.structJs(ty.cls, line)}()`;
        case 'obj': return `$.new(${JSON.stringify(ty.cls)}, [])`;
        default: return '0';
      }
    }

    structJs(name, line) {
      const s = this.structs.get(name);
      if (!s) this.fail(`struct ${name} must be written before it is used`, line);
      return s.js;
    }

    // ---------------------------------------------------------------- functions
    func(node) {
      const sig = (this.funcs.get(node.name) || []).find((o) => o.node === node);
      this.fn = { name: node.name, ret: node.ret, line: node.line };
      this.push();
      const params = node.params.map((p, i) => {
        const ty = sig.params[i];
        const name = p.name || '_unused' + i;
        const js = mangle(name);
        const prim = !isArr(ty) && (ty.k === 'int' || ty.k === 'float' || ty.k === 'bool' || ty.k === 'char' || ty.k === 'str');
        const ref = p.ref && prim && !ty.isConst;
        this.declare(name, { kind: 'var', js, type: ty, ref, isConst: !!ty.isConst && !p.ref }, p.line);
        if (p.dflt) return `${js} = ${this.convert(ty, this.ex(p.dflt))}`;
        return js;
      });
      const body = this.block(node.body.body, true);
      this.pop();
      this.fn = null;
      return `async function ${sig.js}(${params.join(', ')}) {\n${body}\n}`;
    }

    // ---------------------------------------------------------------- statements
    block(stmts, noScope) {
      if (!noScope) this.push();
      const out = stmts.map((s) => this.stmt(s)).filter(Boolean).join('\n');
      if (!noScope) this.pop();
      return out;
    }

    body(st) {
      // A loop or if body, always braced.
      if (!st) return '{}';
      if (st.s === 'block') return '{\n' + this.block(st.body) + '\n}';
      if (st.s === 'decl') this.fail('a declaration needs { } around it here', st.line);
      this.push();
      const s = this.stmt(st);
      this.pop();
      return '{\n' + s + '\n}';
    }

    loopBody(st) {
      const b = this.body(st);
      return '{ if (++$.n > 3000) await $.tick();\n' + b.slice(1);
    }

    stmt(st) {
      if (!st) return '';
      const L = '__ln = ' + st.line + '; ';
      switch (st.s) {
        case 'empty': return '';
        case 'block': return '{\n' + this.block(st.body) + '\n}';
        case 'multi': return st.items.map((x) => this.stmt(x)).join('\n');
        case 'struct': return this.structDef(st);
        case 'enum': return this.enumDef(st);
        case 'decl': { const d = this.decl(st); return d ? L + d + ';' : ''; }
        case 'expr': return L + this.ex(st.e, true).c + ';';
        case 'if': {
          const c = this.cond(st.c);
          let s = L + `if (${c}) ${this.body(st.a)}`;
          if (st.b) s += ' else ' + (st.b.s === 'if' ? '{\n' + this.stmt(st.b) + '\n}' : this.body(st.b));
          return s;
        }
        case 'while': return L + `while (${this.cond(st.c)}) ${this.loopBody(st.body)}`;
        case 'do': { const b = this.loopBody(st.body); return L + `do ${b} while (${this.cond(st.c)});`; }
        case 'for': {
          this.push();
          let init = '';
          if (st.init) init = st.init.s === 'decl' ? this.decl(st.init) : this.ex(st.init.e, true).c;
          const c = st.c ? this.cond(st.c) : '';
          const u = st.u ? this.ex(st.u, true).c : '';
          const b = this.loopBody(st.body);
          this.pop();
          return L + `for (${init}; ${c}; ${u}) ${b}`;
        }
        case 'forof': {
          const it = this.ex(st.iter);
          let ty = st.type;
          if (ty.k === 'auto') ty = isStrT(it.t) ? T.char : (isArr(it.t) ? elemT(it.t) : T.any);
          this.push();
          const js = mangle(st.name);
          this.declare(st.name, { kind: 'var', js, type: ty });
          const b = this.loopBody(st.body);
          this.pop();
          return L + `for (let ${js} of $.iter(${it.c})) ${b}`;
        }
        case 'switch': {
          const e = this.ex(st.e);
          this.push();
          const inner = st.body.map((s) => this.stmt(s)).join('\n');
          this.pop();
          return L + `switch (+(${e.c})) {\n${inner}\n}`;
        }
        case 'case': return `case ${this.ex(st.v).c}:`;
        case 'default': return 'default:';
        case 'break': return 'break;';
        case 'continue': return 'continue;';
        case 'return': {
          if (!this.fn) this.fail('"return" can only be used inside a function', st.line);
          if (!st.e) return L + 'return;';
          const r = this.ex(st.e);
          return L + 'return ' + (this.fn.ret.k === 'void' ? r.c : this.convert(this.fn.ret, r)) + ';';
        }
        default: this.fail('this kind of statement isn\'t supported in the simulator', st.line);
      }
      return '';
    }

    cond(node) { return this.ex(node).c; }

    // ---------------------------------------------------------------- declarations
    decl(st) {
      const parts = [];
      const base = st.type;
      for (const d of st.decls) {
        let ty = Object.assign({}, base);
        delete ty.isStatic;
        let dims = d.dims ? d.dims.slice() : [];
        if (d.ptr) {
          if (base.k === 'char') ty = Object.assign({}, T.str, { isConst: base.isConst });
          else if (base.k === 'obj' || base.k === 'struct') this.fail('pointers (*) aren\'t supported in the simulator. Declare the object directly, like: ' + (base.cls || 'Servo') + ' ' + d.name + ';', d.line);
          else this.fail('pointers (*) aren\'t supported in the simulator', d.line);
        }
        if (d.ref) this.fail('references (&) are only supported for function inputs in the simulator', d.line);
        let charSize = null;
        const leafIsStr = (n) => n.n === 'str' || (n.n === 'init' && n.items.some(leafIsStr));
        if (ty.k === 'char' && dims.length && (d.init ? leafIsStr(d.init) : dims.length === 1)) {
          // char arrays used as text become Strings
          charSize = dims[dims.length - 1];
          dims = dims.slice(0, -1);
          ty = Object.assign({}, T.str, { isConst: base.isConst });
        }
        let init;
        if (ty.k === 'auto') {
          if (!d.init) this.fail('"auto" needs a value, like: auto x = 5;', d.line);
          const r = this.ex(d.init);
          ty = Object.assign({}, r.t.k === 'void' ? T.any : r.t, { isConst: base.isConst });
          init = r.c;
        } else if (dims.length) {
          ty = withDims(ty, dims);
          init = this.arrayInit(ty, d.init, d.line);
        } else {
          init = this.initFor(ty, d.init, d.ctor, d.line);
        }
        if (charSize) ty.charSize = charSize;
        if (base.isStatic && this.fn) {
          const js = '__st_' + mangle(this.fn.name) + '_' + mangle(d.name) + '_' + (++this.uid);
          this.hoisted.push(`let ${js} = ${init};`);
          this.declare(d.name, { kind: 'var', js, type: ty, isConst: !!base.isConst }, d.line);
          continue;
        }
        const js = mangle(d.name);
        if (this.scopes.length === 1 && this.funcs.has(d.name)) this.fail(`"${d.name}" is already the name of a function`, d.line);
        this.declare(d.name, { kind: 'var', js, type: ty, isConst: !!base.isConst }, d.line);
        parts.push(`${js} = ${init}`);
      }
      if (!parts.length) return '';
      return 'let ' + parts.join(', ');
    }

    arrayInit(ty, init, line) {
      const leafT = Object.assign({}, ty, { dims: null });
      const ds = ty.dims.map((d) => (d == null ? 'null' : this.ex(d).c));
      const mk = '() => ' + this.defaultFor(leafT, null, line);
      if (!init) {
        if (ty.dims.some((d) => d == null)) this.fail('this array needs a size, like int values[10];', line);
        return `$.arr([${ds.join(', ')}], null, ${mk})`;
      }
      if (init.n === 'str' && leafT.k === 'char') return `$.arr([${ds.join(', ')}], ${JSON.stringify(Array.from(init.v).map((ch) => ch.charCodeAt(0)).concat([0]))}, ${mk})`;
      if (init.n !== 'init') {
        const r = this.ex(init);
        return `$.copy(${r.c})`;
      }
      const build = (node, level) => {
        if (level === ty.dims.length) return this.initFor(leafT, node, null, node.line);
        if (node.n !== 'init') {
          if (node.n === 'str' && leafT.k === 'str') return JSON.stringify(node.v);
          this.fail('this array needs { } around its values', node.line);
        }
        return '[' + node.items.map((x) => build(x, level + 1)).join(', ') + ']';
      };
      return `$.arr([${ds.join(', ')}], ${build(init, 0)}, ${mk})`;
    }

    /** Value for a declaration or struct field of type ty. */
    initFor(ty, init, ctor, line) {
      if (isArr(ty)) return init ? this.arrayInit(ty, init, line) : this.defaultFor(ty, null, line);
      if (ty.k === 'struct') {
        const js = this.structJs(ty.cls, line);
        const fields = this.structs.get(ty.cls).fields;
        if (init && init.n === 'init') {
          if (init.items.length > fields.length) this.fail(`too many values for struct ${ty.cls}`, line);
          return `new ${js}(${init.items.map((x, i) => this.initFor(this.fieldType(fields[i]), x, null, x.line)).join(', ')})`;
        }
        if (ctor && ctor.length) return `new ${js}(${ctor.map((x, i) => this.initFor(this.fieldType(fields[i] || { type: T.any }), x, null, x.line)).join(', ')})`;
        if (init) return `$.copy(${this.ex(init).c})`;
        return `new ${js}()`;
      }
      if (ty.k === 'obj') {
        if (ctor) return `$.new(${JSON.stringify(ty.cls)}, [${ctor.map((a) => this.arg(a)).join(', ')}])`;
        if (init && init.n === 'init') return `$.new(${JSON.stringify(ty.cls)}, [${init.items.map((a) => this.arg(a)).join(', ')}])`;
        if (init) return this.ex(init).c;
        return `$.new(${JSON.stringify(ty.cls)}, [])`;
      }
      if (init && init.n === 'init') {
        if (init.items.length === 0) return this.defaultFor(ty, null, line);
        if (init.items.length > 1) this.fail('one value expected here, not a { list }', line);
        init = init.items[0];
      }
      if (!init && ctor && ctor.length) {
        if (ty.k === 'str') return `$.String(${ctor.map((a) => this.ex(a)).map((r, i) => (i === 0 ? r.c + ', ' : r.c)).join('')}${ctor.length === 1 ? 'undefined' : ''}, ${PRINT_HINT(this.ex(ctor[0]).t) || 'undefined'})`;
        init = ctor[0];
      }
      if (!init) return this.defaultFor(ty, null, line);
      return this.convert(ty, this.ex(init));
    }

    /** Code for a call argument (keeps objects, arrays and refs as they are). */
    arg(node) {
      if (node.n === 'init') return '[' + node.items.map((x) => this.arg(x)).join(', ') + ']';
      return this.ex(node).c;
    }

    convert(ty, r) {
      if (!ty || isArr(ty) || !r.t) return r.c;
      const from = r.t;
      switch (ty.k) {
        case 'int': {
          const conv = ty.conv || 'i32';
          if (r.lit && from.k !== 'float') {
            const v = Number(r.c);
            const rg = CONV_RANGE[conv];
            if (!rg || (v >= rg[0] && v <= rg[1])) return r.c;
          }
          if (from.k === 'int' && (from.conv || 'i32') === conv) return r.c;
          if (from.k === 'int' && conv === 'i64') return r.c;
          if (from.k === 'char' && (conv === 'i32' || conv === 'u32' || conv === 'i64' || conv === 'u16' || conv === 'i16')) return r.c;
          if (from.k === 'bool') return '(+(' + r.c + '))';
          if (from.k === 'str') return applyConv(conv, '$.S.toInt(' + r.c + ')');
          return applyConv(conv, r.c);
        }
        case 'char':
          if (from.k === 'char') return r.c;
          if (r.lit && from.k === 'int' && Number(r.c) >= 0 && Number(r.c) <= 255) return r.c;
          if (from.k === 'str') return '$.S.at(' + r.c + ', 0)';
          return '((' + r.c + ') & 255)';
        case 'bool':
          if (from.k === 'bool') return r.c;
          return '!!(' + r.c + ')';
        case 'float':
          if (from.k === 'bool') return '(+(' + r.c + '))';
          if (from.k === 'str') return '$.S.toFloat(' + r.c + ')';
          return r.c;
        case 'str':
          if (from.k === 'str') return r.c;
          return '$.toS(' + r.c + ', ' + (PRINT_HINT(from) || 'undefined') + ')';
        default: return r.c;
      }
    }

    toStr(r) { return isStrT(r.t) ? r.c : '$.toS(' + r.c + ', ' + (PRINT_HINT(r.t) || 'undefined') + ')'; }

    // ---------------------------------------------------------------- expressions
    ex(node, stmt) {
      switch (node.n) {
        case 'num': {
          const v = node.v;
          const c = node.f ? (Number.isInteger(v) ? v + '.0' : String(v)) : String(v);
          return { c: v < 0 ? '(' + c + ')' : c, t: node.f ? T.float : (node.u || v > 2147483647 ? T.uint : T.int), lit: true };
        }
        case 'chr': return { c: String(node.v), t: T.char, lit: true };
        case 'str': return { c: JSON.stringify(node.v), t: T.str };
        case 'bool': return { c: node.v ? 'true' : 'false', t: T.bool };
        case 'paren': { const r = this.ex(node.e, stmt); return { c: '(' + r.c + ')', t: r.t, lit: r.lit }; }
        case 'id': return this.ident(node);
        case 'scope': return this.scoped(node);
        case 'call': return this.call(node, stmt);
        case 'idx': {
          const a = this.ex(node.a);
          const i = this.ex(node.i);
          const ic = isIntT(i.t) ? i.c : '((' + i.c + ') | 0)';
          if (isStrT(a.t)) return { c: `$.S.at(${a.c}, ${ic})`, t: T.char };
          if (a.t.k === 'fn') this.fail('a function can\'t be used with [ ]', node.line);
          return { c: `$.at(${a.c}, ${ic})`, t: isArr(a.t) ? elemT(a.t) : T.any, lv: `${a.c}[${ic}]` };
        }
        case 'mem': {
          const a = this.ex(node.a);
          let t = T.any;
          if (a.t.k === 'struct' && !isArr(a.t)) {
            const s = this.structs.get(a.t.cls);
            const f = s && s.fields.find((x) => x.name === node.name);
            if (!f) this.fail(`struct ${a.t.cls} has no field called "${node.name}"`, node.line);
            t = this.fieldType(f);
          } else if (isStrT(a.t)) {
            this.fail(`"${node.name}" on a String needs ( ), like text.${node.name}()`, node.line);
          } else if (isArr(a.t)) {
            this.fail(`arrays don't have ".${node.name}". Use sizeof(arr) / sizeof(arr[0]) for the length`, node.line);
          }
          return { c: `${a.c}.${node.name}`, t };
        }
        case 'un': {
          const a = this.ex(node.a);
          if (node.op === '!') return { c: '!(' + a.c + ')', t: T.bool };
          if (node.op === '~') return { c: '(~(' + a.c + '))', t: T.int };
          if (node.op === '-') return { c: '(-(' + a.c + '))', t: a.t.k === 'float' ? T.float : (isIntT(a.t) ? T.int : a.t), lit: a.lit };
          return { c: '(+(' + a.c + '))', t: a.t };
        }
        case 'pre': case 'post': {
          const lv = this.lvalue(node.a, node.line);
          if (isStrT(lv.t)) this.fail(`can't use ${node.op} on a String`, node.line);
          return { c: node.n === 'pre' ? '(' + node.op + lv.c + ')' : '(' + lv.c + node.op + ')', t: lv.t };
        }
        case 'bin': return this.binary(node.op, this.ex(node.a), this.ex(node.b), node.line);
        case 'assign': return this.assign(node);
        case 'tern': {
          const c = this.ex(node.c), a = this.ex(node.a), b = this.ex(node.b);
          let t = a.t;
          if (isStrT(a.t) || isStrT(b.t)) return { c: `(${c.c} ? ${this.toStr(a)} : ${this.toStr(b)})`, t: T.str };
          if (a.t.k === 'float' || b.t.k === 'float') t = T.float;
          else if (isIntT(a.t) && isIntT(b.t)) t = a.t.k === 'char' && b.t.k === 'char' ? T.char : T.int;
          return { c: `(${c.c} ? ${a.c} : ${b.c})`, t };
        }
        case 'cast': {
          const r = this.ex(node.a);
          let ty = node.type;
          if (ty.k === 'obj' || ty.k === 'struct') return r;
          if (ty.k === 'void') return { c: r.c, t: T.void };
          return { c: this.convert(ty, r), t: ty };
        }
        case 'sizeof': {
          if (node.type) {
            if (node.type.k === 'struct') { const s = this.structs.get(node.type.cls); return { c: String((s ? s.fields.length : 1) * 4), t: T.uint }; }
            return { c: String(ELEM_BYTES(node.type)), t: T.uint };
          }
          const r = this.ex(node.a);
          if (isArr(r.t)) {
            const leaf = Object.assign({}, r.t, { dims: null });
            if (leaf.k === 'str' && leaf.charSize) return { c: `($.count(${r.c}) * (${this.ex(leaf.charSize).c}))`, t: T.uint };
            return { c: `$.sizeof(${r.c}, ${ELEM_BYTES(leaf)})`, t: T.uint };
          }
          if (isStrT(r.t) && r.t.charSize) return { c: '(' + this.ex(r.t.charSize).c + ')', t: T.uint };
          if (isStrT(r.t) && node.a.n === 'str') return { c: String(node.a.v.length + 1), t: T.uint };
          if (r.t.k === 'struct') { const s = this.structs.get(r.t.cls); return { c: String((s ? s.fields.length : 1) * 4), t: T.uint }; }
          return { c: `$.sizeof(${r.c}, ${ELEM_BYTES(r.t)})`, t: T.uint };
        }
        case 'addr': {
          const a = node.a;
          if (a.n === 'id') {
            const sym = this.lookup(a.name);
            if (!sym || sym.kind !== 'var') return this.ex(a);
          }
          const r = this.ex(a);
          const prim = !isArr(r.t) && (r.t.k === 'int' || r.t.k === 'float' || r.t.k === 'bool' || r.t.k === 'char' || r.t.k === 'str');
          if (!prim) return r;
          const lv = this.lvalue(a, node.line);
          return { c: `$.ref(() => ${lv.c}, (v$) => (${lv.c} = v$))`, t: Object.assign({}, r.t, { isRef: true }) };
        }
        case 'init': return { c: '[' + node.items.map((x) => this.arg(x)).join(', ') + ']', t: withDims(T.any, [null]) };
        case 'comma': {
          const rs = node.list.map((x) => this.ex(x, stmt));
          return { c: '(' + rs.map((r) => r.c).join(', ') + ')', t: rs[rs.length - 1].t };
        }
        default: this.fail('this expression isn\'t supported in the simulator', node.line);
      }
      return null;
    }

    ident(node) {
      const name = node.name;
      const sym = node.std ? null : this.lookup(name);
      if (sym) {
        if (sym.kind === 'const') return { c: String(sym.value), t: sym.type, lit: true };
        return { c: sym.ref ? sym.js + '.v' : sym.js, t: sym.type };
      }
      if (this.funcs.has(name) && !node.std) {
        const o = this.funcs.get(name)[0];
        return { c: o.js, t: T.fn };
      }
      if (Object.prototype.hasOwnProperty.call(CONSTS, name)) {
        const v = CONSTS[name];
        if (typeof v === 'string') return { c: JSON.stringify(v), t: T.str };
        return { c: v < 0 ? '(' + v + ')' : String(v), t: FLOAT_CONSTS.has(name) ? T.float : T.int, lit: !FLOAT_CONSTS.has(name) };
      }
      if (GLOBAL_OBJECTS.has(name)) return { c: '$.' + name, t: T.obj(name) };
      if (Object.prototype.hasOwnProperty.call(BUILTIN_FNS, name)) return { c: '$.' + name, t: T.fn };
      if (name === 'NAN') return { c: 'NaN', t: T.float };
      if (name === 'INFINITY') return { c: 'Infinity', t: T.float };
      if (this.enumClasses.has(name)) this.fail(`use ${name}::VALUE to pick a value from the enum`, node.line);
      if (/^[A-Z][A-Z0-9_]*$/.test(name) && name.length > 1) {
        this.warn(`${name} isn't something the simulator knows, so it counts as 0 here`, node.line);
        return { c: `$.k(${JSON.stringify(name)})`, t: T.int };
      }
      this.fail(`"${name}" isn't declared. Check the spelling, or declare it first (for example: int ${name} = 0;)`, node.line);
      return null;
    }

    scoped(node) {
      const [a, b] = node.parts;
      if (this.enumClasses.has(a)) {
        const m = this.enumClasses.get(a);
        if (!m.has(b)) this.fail(`${a} has no value called ${b}`, node.line);
        return { c: String(m.get(b)), t: T.int, lit: true };
      }
      if (node.parts.length === 2 && this.lookup(b) && this.lookup(b).kind === 'const' && !LIB_CLASSES.has(a)) {
        return { c: String(this.lookup(b).value), t: T.int, lit: true };
      }
      return { c: `$.sc(${JSON.stringify(node.parts.join('::'))})`, t: T.any };
    }

    lvalue(node, line) {
      switch (node.n) {
        case 'paren': return this.lvalue(node.e, line);
        case 'id': {
          const sym = this.lookup(node.name);
          if (!sym) {
            if (this.funcs.has(node.name)) this.fail(`can't change ${node.name}, it's a function`, line);
            if (CONSTS[node.name] != null || GLOBAL_OBJECTS.has(node.name)) this.fail(`can't change ${node.name}, it's built in`, line);
            this.fail(`"${node.name}" isn't declared. Declare it first (for example: int ${node.name} = 0;)`, line);
          }
          if (sym.kind !== 'var') this.fail(`can't change ${node.name}, it's a constant`, line);
          if (sym.isConst) this.fail(`can't change ${node.name}, it's declared const`, line);
          return { c: sym.ref ? sym.js + '.v' : sym.js, t: sym.type, simple: true };
        }
        case 'idx': {
          const a = this.lvalue(node.a, line);
          const i = this.ex(node.i);
          if (isStrT(a.t)) return { c: null, t: T.char, strIdx: { base: a, i } };
          const ic = isIntT(i.t) ? i.c : '((' + i.c + ') | 0)';
          return { c: `${a.c}[${ic}]`, t: isArr(a.t) ? elemT(a.t) : T.any, simple: a.simple && (node.i.n === 'id' || node.i.n === 'num' || node.i.n === 'chr') };
        }
        case 'mem': {
          const r = this.ex(node);
          let base = node.a;
          while (base.n === 'mem' || base.n === 'paren') base = base.n === 'mem' ? base.a : base.e;
          return { c: r.c, t: r.t, simple: base.n === 'id' };
        }
        default: this.fail('the left side of "=" must be a variable', line);
      }
      return null;
    }

    assign(node) {
      const lv = this.lvalue(node.target, node.line);
      if (lv.strIdx) {
        // text[i] = 'x'
        if (node.op !== '=') this.fail('only "=" works on one letter of a String', node.line);
        const v = this.ex(node.value);
        const b = lv.strIdx.base;
        return { c: `(${b.c} = $.S.setCharAt(${b.c}, ${lv.strIdx.i.c}, ${v.c}))`, t: T.char };
      }
      if (node.op === '=') {
        let v;
        if (node.value.n === 'init') v = this.initFor(lv.t, node.value, null, node.line);
        else v = this.convert(lv.t, this.ex(node.value));
        return { c: `(${lv.c} = ${v})`, t: lv.t };
      }
      const op = node.op.slice(0, -1);
      const v = this.ex(node.value);
      if (isStrT(lv.t)) {
        if (op !== '+') this.fail(`can't use ${node.op} on a String`, node.line);
        return { c: `(${lv.c} += ${this.toStr(v)})`, t: T.str };
      }
      if (!lv.simple) return { c: `(${lv.c} ${node.op} ${v.c})`, t: lv.t };
      const b = this.binary(op, { c: lv.c, t: lv.t }, v, node.line);
      return { c: `(${lv.c} = ${this.convert(lv.t, b)})`, t: lv.t };
    }

    binary(op, a, b, line) {
      const either = (k) => a.t.k === k || b.t.k === k;
      if (op === '+' && (isStrT(a.t) || isStrT(b.t))) return { c: `(${this.toStr(a)} + ${this.toStr(b)})`, t: T.str };
      if (op === '==' || op === '!=') return { c: `(${a.c} ${op} ${b.c})`, t: T.bool };
      if (op === '<' || op === '>' || op === '<=' || op === '>=') return { c: `(${a.c} ${op} ${b.c})`, t: T.bool };
      if (op === '&&' || op === '||') return { c: `!!(${a.c} ${op} ${b.c})`, t: T.bool };
      const ints = isIntT(a.t) && isIntT(b.t);
      const ut = (a.t.conv === 'u32' || b.t.conv === 'u32') ? T.uint : T.int;
      if (op === '/') {
        if (ints) return { c: `$.idiv(${a.c}, ${b.c})`, t: ut };
        return { c: `(${a.c} / ${b.c})`, t: either('float') ? T.float : T.any };
      }
      if (op === '%') {
        if (ints) return { c: `$.imod(${a.c}, ${b.c})`, t: ut };
        return { c: `(${a.c} % ${b.c})`, t: either('float') ? T.float : T.any };
      }
      if (op === '>>' && a.t.conv === 'u32') return { c: `(${a.c} >>> ${b.c})`, t: T.uint };
      if (op === '&' || op === '|' || op === '^' || op === '<<' || op === '>>') {
        const c = `(${a.c} ${op} ${b.c})`;
        return { c: ut === T.uint && op !== '>>' ? `(${c} >>> 0)` : c, t: ut };
      }
      // + - *
      let t;
      if (either('float')) t = T.float;
      else if (ints) t = ut;
      else t = T.any;
      return { c: `(${a.c} ${op} ${b.c})`, t, lit: a.lit && b.lit && t !== T.any };
    }

    call(node, stmt) {
      const fn = node.fn;
      const line = node.line;
      if (fn.n === 'id') return this.callNamed(fn.name, node, fn.std, stmt);
      if (fn.n === 'mem') return this.callMethod(fn, node, stmt);
      if (fn.n === 'scope') {
        if (fn.parts[0] === 'std') return this.callNamed(fn.parts[fn.parts.length - 1], node, true, stmt);
        return { c: `$.sc(${JSON.stringify(fn.parts.join('::'))})(${node.args.map((a) => this.arg(a)).join(', ')})`, t: METHOD_TYPES[fn.parts[fn.parts.length - 1]] || T.any };
      }
      if (fn.n === 'paren') return this.call(Object.assign({}, node, { fn: fn.e }), stmt);
      this.fail('this can\'t be called like a function', line);
      return null;
    }

    callNamed(name, node, std, stmt) {
      const line = node.line;
      const args = node.args;
      const sym = std ? null : this.lookup(name);
      if (sym && sym.kind === 'var') {
        if (sym.type.k === 'obj') this.fail(`${name} is an object; call one of its functions, like ${name}.begin()`, line);
        this.fail(`${name} is a variable, not a function`, line);
      }
      // User functions
      if (!std && this.funcs.has(name)) {
        const list = this.funcs.get(name);
        const o = list.find((x) => args.length >= x.minArgs && args.length <= x.params.length) || null;
        if (!o) {
          const want = list.map((x) => x.params.length).join(' or ');
          this.fail(`${name}() needs ${want} input${want === '1' ? '' : 's'} but got ${args.length}`, line);
        }
        const codes = args.map((a, i) => {
          const pty = o.params[i];
          const pn = o.node ? o.node.params[i] : null;
          const prim = !isArr(pty) && (pty.k === 'int' || pty.k === 'float' || pty.k === 'bool' || pty.k === 'char' || pty.k === 'str');
          if (pn && pn.ref && prim && !pty.isConst) {
            try {
              const lv = this.lvalue(a, line);
              if (lv.c) return `$.ref(() => ${lv.c}, (v$) => (${lv.c} = v$))`;
            } catch (e) { /* not a variable: pass a box */ }
            return `$.box(${this.convert(pty, this.ex(a))})`;
          }
          if (a.n === 'init') return this.initFor(pty, a, null, line);
          return this.convert(pty, this.ex(a));
        });
        return { c: `(await ${o.js}(${codes.join(', ')}))`, t: o.ret.k === 'void' ? T.void : o.ret };
      }
      // Structs used like constructors
      if (this.structs.has(name)) return { c: this.initFor(this.parser.types.get(name), { n: 'init', items: args, line }, null, line), t: this.parser.types.get(name) };
      // Library classes used like constructors: Keypad(...)
      if (LIB_CLASSES.has(name) || this.parser.seenClasses.has(name)) return { c: `$.new(${JSON.stringify(name)}, [${args.map((a) => this.arg(a)).join(', ')}])`, t: T.obj(name) };
      switch (name) {
        case 'String': {
          if (!args.length) return { c: '""', t: T.str };
          const r = this.ex(args[0]);
          const second = args[1] ? this.ex(args[1]).c : 'undefined';
          return { c: `$.String(${r.c}, ${second}, ${PRINT_HINT(r.t) || 'undefined'})`, t: T.str };
        }
        case 'F': case 'PSTR': case 'FPSTR':
          if (args.length !== 1) this.fail(`${name}() takes one text value`, line);
          return this.ex(args[0]);
        case 'sprintf': case 'snprintf': {
          const skip = name === 'snprintf' ? 2 : 1;
          if (args.length < skip + 1) this.fail(`${name}() needs a buffer and a format text`, line);
          const lv = this.lvalue(args[0], line);
          const rest = args.slice(skip).map((a) => this.arg(a));
          const lim = name === 'snprintf' ? this.ex(args[1]).c : 'undefined';
          return { c: `((${lv.c} = $.sprintf(${lim}, ${rest.join(', ')})).length)`, t: T.int };
        }
        case 'strcpy': case 'strncpy': case 'strcat': case 'strncat': case 'strlcpy': {
          if (args.length < 2) this.fail(`${name}() needs two inputs`, line);
          const lv = this.lvalue(args[0], line);
          const src = this.toStr(this.ex(args[1]));
          const n = args[2] ? this.ex(args[2]).c : null;
          const cut = n ? (name === 'strlcpy' ? `.slice(0, Math.max(0, (${n}) - 1))` : `.slice(0, ${n})`) : '';
          if (name === 'strcat' || name === 'strncat') return { c: `(${lv.c} = ${lv.c} + (${src})${cut})`, t: T.str };
          return { c: `(${lv.c} = (${src})${cut})`, t: T.str };
        }
        case 'dtostrf': {
          if (args.length !== 4) this.fail('dtostrf() needs 4 inputs: value, width, decimals, buffer', line);
          const lv = this.lvalue(args[3], line);
          return { c: `(${lv.c} = $.dtostrf(${this.ex(args[0]).c}, ${this.ex(args[1]).c}, ${this.ex(args[2]).c}))`, t: T.str };
        }
        case 'itoa': case 'ltoa': case 'utoa': case 'ultoa': {
          if (args.length !== 3) this.fail(`${name}() needs 3 inputs: value, buffer, base`, line);
          const lv = this.lvalue(args[1], line);
          return { c: `(${lv.c} = $.itoa(${this.ex(args[0]).c}, ${this.ex(args[2]).c}))`, t: T.str };
        }
        case 'memset': {
          const a = this.ex(args[0]);
          if (isStrT(a.t)) { const lv = this.lvalue(args[0], line); return { c: `(${lv.c} = "")`, t: T.void }; }
          return { c: `$.memset(${a.c}, ${this.ex(args[1]).c})`, t: T.void };
        }
        case 'memcpy': {
          const a = this.ex(args[0]);
          if (isStrT(a.t)) { const lv = this.lvalue(args[0], line); return { c: `(${lv.c} = ${this.toStr(this.ex(args[1]))})`, t: T.void }; }
          return { c: `$.memcpy(${a.c}, ${this.ex(args[1]).c})`, t: T.void };
        }
        case 'printf': return { c: `$.Serial.printf(${args.map((a) => this.arg(a)).join(', ')})`, t: T.int };
        case 'min': case 'max': case 'constrain': case 'abs': case 'sq': {
          const rs = args.map((a) => this.ex(a));
          const t = rs.some((r) => r.t.k === 'float' || r.t.k === 'any') ? (rs.some((r) => r.t.k === 'float') ? T.float : T.any) : T.int;
          return { c: `$.${name}(${rs.map((r) => r.c).join(', ')})`, t };
        }
        case 'bitSet': case 'bitClear': case 'bitWrite': {
          if (args.length < 2) this.fail(`${name}() needs a variable and a bit number`, line);
          const lv = this.lvalue(args[0], line);
          const n = this.ex(args[1]).c;
          const on = name === 'bitSet' ? 'true' : name === 'bitClear' ? 'false' : this.ex(args[2]).c;
          return { c: `(${lv.c} = (${on}) ? (${lv.c} | (1 << ${n})) : (${lv.c} & ~(1 << ${n})))`, t: lv.t };
        }
        case 'swap': {
          if (args.length !== 2) this.fail('swap() needs two variables', line);
          const a = this.lvalue(args[0], line), b = this.lvalue(args[1], line);
          return { c: `([${a.c}, ${b.c}] = [${b.c}, ${a.c}])`, t: T.void };
        }
        default: break;
      }
      if (Object.prototype.hasOwnProperty.call(BUILTIN_FNS, name)) {
        const spec = BUILTIN_FNS[name];
        const codes = args.map((a) => this.arg(a));
        const call = `$.${name}(${codes.join(', ')})`;
        let t = typeFromLetter(spec[0]);
        if (spec[0] === 'n') t = T.any;
        return { c: spec.includes('!') ? `(await ${call})` : call, t };
      }
      if (this.enumClasses.has(name) || (this.lookup(name) && this.lookup(name).kind === 'const')) this.fail(`${name} isn't a function`, line);
      this.warn(`${name}() isn't something the simulator knows, so it does nothing here`, line);
      return { c: `$.unk(${JSON.stringify(name)})(${args.map((a) => this.arg(a)).join(', ')})`, t: T.any };
    }

    callMethod(fn, node, stmt) {
      const line = node.line;
      const name = fn.name;
      const args = node.args;
      const recv = this.ex(fn.a);
      if (isStrT(recv.t)) {
        const m = STR_METHODS[name];
        if (!m) this.fail(`Strings don't have a ${name}() function`, line);
        const codes = args.map((a) => this.ex(a).c);
        if (m[1] === 'inplace') {
          let lv = null;
          try { lv = this.lvalue(fn.a, line); } catch (e) { lv = null; }
          if (lv && lv.c) return { c: `(${lv.c} = $.S.${name}(${[lv.c].concat(codes).join(', ')}), ${name === 'concat' ? 'true' : 'undefined'})`, t: m[0] };
          return { c: `$.S.${name}(${[recv.c].concat(codes).join(', ')})`, t: T.str };
        }
        if (m[1] === 'out') {
          if (!args.length) this.fail(`${name}() needs a buffer`, line);
          const out = this.lvalue(args[0], line);
          return { c: `(${out.c} = $.S.toCharArray(${recv.c}, ${codes[1] || 'Infinity'}, ${isStrT(out.t) ? 'false' : 'true'}))`, t: T.void };
        }
        return { c: `$.S.${name}(${[recv.c].concat(codes).join(', ')})`, t: m[0] };
      }
      if (recv.t.k === 'struct') this.fail(`struct ${recv.t.cls} has no functions; only fields`, line);
      if (isArr(recv.t)) this.fail(`arrays don't have a ${name}() function`, line);
      let codes;
      if ((name === 'print' || name === 'println') && args.length) {
        const r0 = this.ex(args[0]);
        const hint = PRINT_HINT(r0.t);
        codes = [r0.c].concat(args.slice(1).map((a) => this.arg(a)));
        if (hint) { while (codes.length < 2) codes.push('undefined'); codes.push(hint); }
      } else if (name === 'get' && args.length === 2 && fn.a.n === 'id' && fn.a.name === 'EEPROM') {
        const lv = this.lvalue(args[1], line);
        return { c: `(${lv.c} = $.EEPROM.get(${this.ex(args[0]).c}, ${lv.c}))`, t: lv.t };
      } else {
        codes = args.map((a) => this.arg(a));
      }
      let call;
      if (recv.t.k === 'obj') call = `${recv.c}.${name}(${codes.join(', ')})`;
      else call = `$.m(${recv.c}, ${JSON.stringify(name)}, [${codes.join(', ')}])`;
      if (ASYNC_METHODS.has(name)) call = `(await ${call})`;
      return { c: call, t: METHOD_TYPES[name] || T.any };
    }
  }

  // ===================================================================
  // compile()
  // ===================================================================

  function compile(source) {
    try {
      const toks = preprocess(tokenize(source));
      const parser = new Parser(toks, LIB_CLASSES);
      const items = parser.parseProgram();
      const em = new Emitter(items, parser);
      const js = em.program();
      try {
        // Syntax check of the generated code (would only fail on a translator bug).
        new Function('$', js); // eslint-disable-line no-new-func
      } catch (e) {
        return { ok: false, error: 'The simulator couldn\'t translate this code (' + e.message + ')', line: 0, js };
      }
      return { ok: true, js, warnings: em.warnings };
    } catch (e) {
      if (e && e.isSim) return { ok: false, error: e.message, line: e.simLine || 0 };
      return { ok: false, error: 'The simulator couldn\'t read this code (' + (e && e.message ? e.message : e) + ')', line: 0 };
    }
  }

  // ===================================================================
  // Runtime helpers
  // ===================================================================

  const STOP = { simStop: true };
  const perfNow = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  function rtErr(msg) { const e = new Error(msg); e.isSim = true; return e; }

  function fixed(v, d) {
    v = Number(v);
    if (isNaN(v)) return 'nan';
    if (v === Infinity) return 'inf';
    if (v === -Infinity) return '-inf';
    d = Math.max(0, Math.min(20, d | 0));
    const s = v.toFixed(d);
    return s === '-0' || /^-0\.0*$/.test(s) ? s.slice(1) : s;
  }

  /** Arduino's Print rules: floats get 2 decimals, chars print as letters, bools as 1/0. */
  function toS(v, hint, a) {
    if (v == null) return '';
    const ty = typeof v;
    if (ty === 'string') return v;
    if (ty === 'boolean') return v ? '1' : '0';
    if (ty === 'function') return '0';
    if (ty === 'object') {
      if (v.__ref) return toS(v.v, hint, a);
      if (Array.isArray(v)) return v.every((x) => typeof x === 'number' && x >= 0 && x < 256) ? String.fromCharCode(...v.filter((x, i) => v.indexOf(0) < 0 || i < v.indexOf(0))) : v.join(',');
      if (typeof v.toString === 'function' && v.toString !== Object.prototype.toString) return String(v.toString());
      return '[object]';
    }
    if (ty !== 'number') return String(v);
    if (hint === 'c') return v ? String.fromCharCode(v) : '';
    if (hint === 'b') return v ? '1' : '0';
    if (hint === 'f') return fixed(v, a == null ? 2 : a);
    if (hint === 'i' || Number.isInteger(v)) {
      if (a === 16 || a === 8 || a === 2) return (v < 0 ? (v >>> 0) : Math.trunc(v)).toString(a).toUpperCase();
      if (a != null && a !== 10 && hint !== 'i') return fixed(v, a);
      return String(Math.trunc(v));
    }
    return fixed(v, a == null || a > 20 ? 2 : a);
  }

  /** C printf. */
  function cfmt(fmt, args) {
    fmt = toS(fmt);
    let ai = 0;
    const next = () => { let v = args[ai++]; if (v && typeof v === 'object' && v.__ref) v = v.v; return v; };
    return fmt.replace(/%([-+ 0#]*)(\*|\d+)?(?:\.(\*|\d+))?(hh|h|ll|l|L|z|j|t)?([diuoxXfFeEgGcsp%n])/g, (m, flags, width, prec, len, conv) => {
      if (conv === '%') return '%';
      if (conv === 'n') return '';
      if (width === '*') width = next();
      if (prec === '*') prec = next();
      width = width != null ? Number(width) : 0;
      const p = prec != null ? Number(prec) : null;
      let v = next();
      if (typeof v === 'boolean') v = v ? 1 : 0;
      let s;
      let numeric = true;
      switch (conv) {
        case 'd': case 'i': {
          const n = Math.trunc(Number(v) || 0);
          s = String(Math.abs(n));
          if (p != null) s = s.padStart(p, '0');
          s = (n < 0 ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '') + s;
          break;
        }
        case 'u': s = String(len === 'll' ? Math.trunc(Number(v) || 0) : (Math.trunc(Number(v) || 0) >>> 0)); break;
        case 'x': case 'X': case 'o': {
          const n = Math.trunc(Number(v) || 0);
          s = (n < 0 ? (n >>> 0) : n).toString(conv === 'o' ? 8 : 16);
          if (conv === 'X') s = s.toUpperCase();
          if (p != null) s = s.padStart(p, '0');
          if (flags.includes('#') && n !== 0) s = (conv === 'o' ? '0' : conv === 'X' ? '0X' : '0x') + s;
          break;
        }
        case 'f': case 'F': {
          const n = Number(v);
          s = fixed(n, p == null ? 6 : p);
          if (n >= 0 && flags.includes('+')) s = '+' + s;
          else if (n >= 0 && flags.includes(' ')) s = ' ' + s;
          break;
        }
        case 'e': case 'E': {
          const n = Number(v);
          s = isFinite(n) ? n.toExponential(p == null ? 6 : p).replace(/e([+-])(\d)$/, 'e$10$2') : fixed(n, 0);
          if (conv === 'E') s = s.toUpperCase();
          break;
        }
        case 'g': case 'G': {
          const n = Number(v);
          s = isFinite(n) ? String(Number(n.toPrecision(p == null ? 6 : (p || 1)))) : fixed(n, 0);
          if (conv === 'G') s = s.toUpperCase();
          break;
        }
        case 'c': numeric = false; s = typeof v === 'string' ? v.slice(0, 1) : (v ? String.fromCharCode(Number(v)) : ''); break;
        case 's': numeric = false; s = toS(v); if (p != null) s = s.slice(0, p); break;
        case 'p': s = '0x3ffb' + ((Number(v) || 0) & 0xffff).toString(16).padStart(4, '0'); break;
        default: s = '';
      }
      if (s.length < width) {
        if (flags.includes('-')) s = s.padEnd(width);
        else if (flags.includes('0') && numeric && p == null) {
          const sign = /^[-+ ]/.test(s) ? s[0] : '';
          const pre = /^0[xX]/.test(s.slice(sign.length)) ? s.slice(sign.length, sign.length + 2) : '';
          s = sign + pre + s.slice(sign.length + pre.length).padStart(width - sign.length - pre.length, '0');
        } else s = s.padStart(width);
      }
      return s;
    });
  }

  const chrs = (x) => (typeof x === 'number' ? String.fromCharCode(x) : toS(x));

  /** Arduino String methods. Strings are JS strings; methods that change a
   *  String in place are compiled to `s = S.method(s, ...)`. */
  const S = {
    length: (s) => s.length,
    charAt: (s, i) => (i >= 0 && i < s.length ? s.charCodeAt(i) : 0),
    at: (s, i) => (i >= 0 && i < s.length ? s.charCodeAt(i) : 0),
    charCodeAt: (s, i) => s.charCodeAt(i) || 0,
    setCharAt: (s, i, c) => (i >= 0 && i < s.length ? s.slice(0, i) + chrs(c) + s.slice(i + 1) : s),
    substring: (s, a, b) => s.substring(a, b === undefined ? s.length : b),
    indexOf: (s, x, from) => s.indexOf(chrs(x), from || 0),
    lastIndexOf: (s, x, from) => (from === undefined ? s.lastIndexOf(chrs(x)) : s.lastIndexOf(chrs(x), from)),
    toInt: (s) => { const m = /^\s*([-+]?\d+)/.exec(toS(s)); return m ? parseInt(m[1], 10) | 0 : 0; },
    toFloat: (s) => { const m = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(toS(s)); return m ? parseFloat(m[0]) : 0; },
    toDouble: (s) => S.toFloat(s),
    equals: (s, x) => s === toS(x),
    equalsIgnoreCase: (s, x) => s.toLowerCase() === toS(x).toLowerCase(),
    startsWith: (s, x, off) => s.startsWith(toS(x), off || 0),
    endsWith: (s, x) => s.endsWith(toS(x)),
    compareTo: (s, x) => { x = toS(x); return s < x ? -1 : s > x ? 1 : 0; },
    c_str: (s) => s,
    isEmpty: (s) => !s.length,
    concat: (s, x) => s + toS(x),
    toUpperCase: (s) => s.toUpperCase(),
    toLowerCase: (s) => s.toLowerCase(),
    trim: (s) => s.trim(),
    replace: (s, a, b) => { a = chrs(a); return a ? s.split(a).join(chrs(b)) : s; },
    remove: (s, i, n) => (n === undefined ? s.slice(0, i) : s.slice(0, i) + s.slice(i + n)),
    reserve: () => true,
    toCharArray: (s, len, codes) => {
      const t = s.slice(0, Math.max(0, (len == null ? Infinity : len) - 1));
      return codes ? Array.from(t).map((c) => c.charCodeAt(0)).concat([0]) : t;
    },
    getBytes: (s, len, codes) => S.toCharArray(s, len, codes),
    begin: () => 0,
    end: () => 0,
  };

  /** A value that quietly stands in for anything a library doesn't model:
   *  callable, every property is another stand-in, truthy, and 0 as a number. */
  function cham() {
    const f = function () { return cham(); };
    return new Proxy(f, {
      get(t, p) {
        if (p === Symbol.toPrimitive) return (hint) => (hint === 'string' ? '0' : 0);
        if (p === 'valueOf') return () => 0;
        if (p === 'toString') return () => '0';
        if (p === 'then' || typeof p === 'symbol') return undefined;
        if (p === 'length') return 0;
        return cham();
      },
      set() { return true; },
    });
  }

  /** Wrap a library object so missing methods are quiet stand-ins. */
  function wrapObj(obj) {
    return new Proxy(obj, {
      get(t, p, recv) {
        if (p in t) return Reflect.get(t, p, recv);
        if (typeof p === 'symbol' || p === 'then' || p === 'toJSON' || p === 'constructor') return undefined;
        return cham();
      },
    });
  }

  function makeArr(dims, init, mk) {
    const build = (level, src) => {
      let n = dims[level];
      if (n == null) n = src ? src.length : 0;
      n = Math.max(0, Math.trunc(Number(n)) || 0);
      if (n > 200000) throw rtErr('this array is too big for the simulator (an ESP32 has about 300 KB of memory)');
      const a = new Array(n);
      for (let i = 0; i < n; i++) {
        const s = src && i < src.length ? src[i] : undefined;
        a[i] = level + 1 < dims.length ? build(level + 1, Array.isArray(s) ? s : null) : (s !== undefined ? s : mk());
      }
      return a;
    };
    return build(0, Array.isArray(init) ? init : null);
  }

  function deepCopy(x) {
    if (Array.isArray(x)) return x.map(deepCopy);
    if (x && typeof x === 'object' && !x.__ref && x.constructor && /\$S$/.test(x.constructor.name)) {
      const o = Object.create(Object.getPrototypeOf(x));
      for (const k of Object.keys(x)) o[k] = deepCopy(x[k]);
      return o;
    }
    return x;
  }

  const countLeaves = (a) => (Array.isArray(a) ? a.reduce((n, x) => n + countLeaves(x), 0) : 1);

  /** Small seeded random generator, so randomSeed() repeats like on the board. */
  function prng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const macrotask = (typeof setImmediate === 'function')
    ? () => new Promise((r) => setImmediate(r))
    : (typeof MessageChannel === 'function'
      ? (() => {
        const ch = new MessageChannel();
        const q = [];
        ch.port1.onmessage = () => { const r = q.shift(); if (r) r(); };
        return () => new Promise((r) => { q.push(r); ch.port2.postMessage(0); });
      })()
      : () => new Promise((r) => setTimeout(r, 0)));

  /** Program clock. fast: virtual time that moves only when the sketch waits. */
  class Clock {
    constructor(fast) {
      this.fast = !!fast;
      this.virt = 0;
      this.t0 = perfNow();
      this.skew = 0;
    }
    now() { return this.fast ? this.virt : perfNow() - this.t0 + this.skew; }
    bump(ms) { if (this.fast) this.virt += ms; else this.skew += ms; }
  }

  // ===================================================================
  // Inputs each part offers (sliders, buttons...) for the UI and setInput()
  // ===================================================================

  const IR_KEYS = [['1', 0x45], ['2', 0x46], ['3', 0x47], ['4', 0x44], ['5', 0x40], ['6', 0x43], ['7', 0x07], ['8', 0x15], ['9', 0x09],
    ['*', 0x16], ['0', 0x19], ['#', 0x0D], ['▲', 0x18], ['◀', 0x08], ['OK', 0x1C], ['▶', 0x5A], ['▼', 0x52]];
  const KEYPAD_LABELS = '123A456B789C*0#D';
  const CARDS = [{ label: 'Card', uid: 'A3 4F 19 C2' }, { label: 'Key fob', uid: '7B 2E 90 15' }];

  const range = (field, label, min, max, step, unit, dflt) => ({ field, kind: 'range', label, min, max, step, unit: unit || '', dflt });
  const INPUTS = {
    button: [{ field: 'pressed', kind: 'press', label: 'Press', dflt: false }],
    touch: [{ field: 'pressed', kind: 'press', label: 'Touch', dflt: false }],
    slideswitch: [{ field: 'on', kind: 'toggle', label: 'Slide to pin 2', dflt: false }],
    pot: [range('value', 'Knob', 0, 4095, 1, '', 2048)],
    joystick: [range('x', 'Left / right', 0, 4095, 1, '', 2048), range('y', 'Up / down', 0, 4095, 1, '', 2048), { field: 'pressed', kind: 'press', label: 'Click', dflt: false }],
    encoder: [{ field: 'turn', kind: 'turn', label: 'Turn' }, { field: 'pressed', kind: 'press', label: 'Click', dflt: false }],
    keypad: [{ field: 'key', kind: 'keys', label: 'Keys', keys: KEYPAD_LABELS }],
    irrecv: [{ field: 'code', kind: 'remote', label: 'Remote', keys: IR_KEYS }],
    rfid: [{ field: 'card', kind: 'card', label: 'Tap a card', cards: CARDS }],
    pir: [{ field: 'motion', kind: 'toggle', label: 'Someone moving', dflt: false }],
    hall: [{ field: 'magnet', kind: 'toggle', label: 'Magnet near', dflt: false }],
    tcrt5000: [{ field: 'line', kind: 'toggle', label: 'Black line below', dflt: false }],
    ldr: [range('value', 'Light', 0, 4095, 1, '', 2000)],
    sound: [range('value', 'Loudness', 0, 4095, 1, '', 300)],
    soil: [range('value', 'Soil reading (lower = wetter)', 0, 4095, 1, '', 2600)],
    mq2: [range('value', 'Gas level', 0, 4095, 1, '', 400)],
    hcsr04: [range('distance', 'Distance', 2, 400, 1, 'cm', 100)],
    vl53l0x: [range('distance', 'Distance', 30, 2000, 5, 'mm', 500)],
    dht22: [range('temp', 'Temperature', -20, 60, 0.5, '°C', 22.5), range('hum', 'Humidity', 0, 100, 1, '%', 45)],
    bme280: [range('temp', 'Temperature', -20, 60, 0.5, '°C', 22.5), range('hum', 'Humidity', 0, 100, 1, '%', 45), range('pressure', 'Air pressure', 950, 1050, 1, 'hPa', 1013)],
    ds18b20: [range('temp', 'Temperature', -20, 100, 0.5, '°C', 21.5)],
    mpu6050: [range('tiltX', 'Tilt left / right', -90, 90, 1, '°', 0), range('tiltY', 'Tilt forward / back', -90, 90, 1, '°', 0)],
    loadcell: [range('weight', 'Weight', 0, 5000, 10, 'g', 0)],
    heartrate: [{ field: 'finger', kind: 'toggle', label: 'Finger on sensor', dflt: false }, range('bpm', 'Heart rate', 40, 180, 1, 'bpm', 72)],
  };
  const inputsFor = (type) => (INPUTS[type] || []).map((x) => Object.assign({}, x));

  // ===================================================================
  // Virtual ESP32: GPIOs, nets and part models
  // ===================================================================

  const POS_RAILS = new Set(['3V3', '5V', 'VBAT', 'VREG']);
  const MODE = { INPUT: 1, OUTPUT: 3, INPUT_PULLUP: 5, INPUT_PULLDOWN: 9, OUTPUT_OPEN_DRAIN: 19 };

  class Board {
    constructor(state, rt) {
      this.rt = rt;
      this.clock = rt.clock;
      this.state = state;
      this.nl = G.buildNets(state);
      this.byUid = new Map(state.parts.map((p) => [p.uid, p]));
      this.ctl = state.parts.find((p) => { const d = G.getPart(p.type); return d && d.controller; }) || null;
      this.ctlDef = this.ctl ? G.getPart(this.ctl.type) : null;
      this.gpioNet = new Map();
      this.validGpio = new Set();
      if (this.ctl) {
        for (const pin of this.ctlDef.pins) {
          const g = this.ctlDef.gpio && this.ctlDef.gpio[pin.name];
          if (g == null) continue;
          this.validGpio.add(g);
          const net = this.nl.byPin.get(G.pinKey(this.ctl.uid, pin.num));
          if (net && !this.gpioNet.has(g)) this.gpioNet.set(g, net);
        }
      }
      const i2c = (this.ctlDef && this.ctlDef.i2c) || { SDA: 21, SCL: 22 };
      this.i2c = { sda: i2c.SDA, scl: i2c.SCL };
      this.builtinLed = this.ctl && this.ctl.type === 'esp32c3' ? 8 : 2;
      this.pins = new Map();
      this.inputs = {};
      this.models = new Map();
      this.claimed = new Set();
      this.servos = new Map();
      this.devices = new Map();
      this.irq = new Map();
      this.ledcCh = new Map();
      this.timers = [];
      for (const inst of state.parts) {
        const def = G.getPart(inst.type);
        if (!def) continue;
        this.inputs[inst.uid] = {};
        for (const d of INPUTS[inst.type] || []) if ('dflt' in d) this.inputs[inst.uid][d.field] = d.dflt;
        const m = makeModel(this, inst, def);
        if (m) this.models.set(inst.uid, m);
      }
    }

    now() { return this.clock.now(); }
    input(uid, field) { return (this.inputs[uid] || {})[field]; }

    pinName(uid, num) { const inst = this.byUid.get(uid); const p = inst && G.pinByNum(inst.type, num); return p ? p.name : ''; }
    pinNet(uid, name) {
      const inst = this.byUid.get(uid);
      if (!inst) return null;
      for (const p of G.getPart(inst.type).pins) if (p.name === name) { const n = this.nl.byPin.get(G.pinKey(uid, p.num)); if (n) return n; }
      return null;
    }
    gpioOf(uid, name) {
      const inst = this.byUid.get(uid);
      if (!inst) return null;
      for (const p of G.getPart(inst.type).pins) if (p.name === name) { const g = G.gpioFor(this.state, this.nl, uid, p.num); if (g != null) return g; }
      return null;
    }

    // ------------------------------------------------------------- pins
    pin(g) {
      g = Number(g);
      let p = this.pins.get(g);
      if (!p) {
        const now = this.now();
        p = { g, mode: 0, out: 0, duty: null, tone: 0, lvl: 0, acc: 0, t0: now, tl: now, avg: 0, falls: 0, reads: 0, res: 8, warned: false };
        this.pins.set(g, p);
      }
      return p;
    }
    checkPin(g, what) {
      if (typeof g !== 'number' || !isFinite(g)) throw rtErr(`${what}() needs a pin number`);
      if (g < 0) { this.rt.warnOnce(`${what}(${g}): pin -1 means "not wired yet". Wire the part to the ESP32 so it gets a real pin number`); return false; }
      if (this.ctl && !this.validGpio.has(g) && g !== this.builtinLed) {
        this.rt.warnOnce(`${what}(${g}): this board has no GPIO${g} pin you can wire to`);
      }
      return true;
    }
    drives(p) { return p.mode === MODE.OUTPUT || p.mode === MODE.OUTPUT_OPEN_DRAIN || p.duty !== null || p.tone > 0; }
    levelOf(p) { return !this.drives(p) ? 0 : p.tone > 0 ? 0.5 : p.duty !== null ? p.duty : p.out; }
    update(p) {
      const now = this.now();
      const l = this.levelOf(p);
      if (l !== p.lvl) { p.acc += p.lvl * (now - p.tl); p.tl = now; p.lvl = l; }
      this.rt.dirty = true;
    }
    sample() {
      const now = this.now();
      for (const p of this.pins.values()) {
        const span = now - p.t0;
        p.avg = span > 0.5 ? (p.acc + p.lvl * (now - p.tl)) / span : p.lvl;
        p.acc = 0; p.t0 = now; p.tl = now;
      }
    }

    pinMode(g, mode) {
      if (!this.checkPin(g, 'pinMode')) return;
      const p = this.pin(g);
      p.mode = Number(mode);
      if (this.drives(p) && this.ctlDef && (this.ctlDef.inputOnly || []).some((n) => this.ctlDef.gpio[n] === g)) {
        this.rt.warnOnce(`GPIO${g} is input-only on the ESP32, so it can't be an OUTPUT`);
        p.mode = MODE.INPUT;
      }
      this.update(p);
      this.checkIrq();
    }
    digitalWrite(g, v) {
      if (!this.checkPin(g, 'digitalWrite')) return;
      const p = this.pin(g);
      const nv = Number(v) ? 1 : 0;
      if (!this.drives(p) && !p.warned) {
        p.warned = true;
        this.rt.warnOnce(`digitalWrite(${g}, ...) but GPIO${g} isn't an OUTPUT, so nothing happens. Add pinMode(${g}, OUTPUT); in setup()`);
      }
      if (p.out === 1 && nv === 0) p.falls++;
      p.out = nv;
      p.duty = null;
      this.update(p);
      this.checkIrq();
    }
    digitalRead(g) {
      if (!this.checkPin(g, 'digitalRead')) return 0;
      this.rt.poll();
      const p = this.pin(g);
      p.reads++;
      if (p.mode === MODE.OUTPUT) return p.lvl >= 0.5 ? 1 : 0;
      return this.rawDigital(g);
    }
    rawDigital(g) {
      const p = this.pin(g);
      const net = this.gpioNet.get(g);
      const v = net ? this.resolve(net, false, 0, g) : null;
      if (v != null) return v >= 0.5 ? 1 : 0;
      return (p.mode & 4) ? 1 : 0;
    }
    analogRead(g) {
      if (!this.checkPin(g, 'analogRead')) return 0;
      this.rt.poll();
      const p = this.pin(g);
      p.reads++;
      if (this.ctlDef && this.ctlDef.adc && !this.ctlDef.adc.some((n) => this.ctlDef.gpio[n] === g) && this.ctl.type === 'esp32') {
        this.rt.warnOnce(`analogRead(${g}): GPIO${g} isn't one of the ESP32's ADC1 pins (32-39), which are the ones that work with Wi-Fi on`);
      }
      const net = this.gpioNet.get(g);
      if (net) {
        for (const m of this.near(net)) {
          const model = this.models.get(m.uid);
          if (model && model.analog) { const a = model.analog(m.name); if (a != null) return Math.max(0, Math.min(4095, Math.round(a))); }
        }
        const v = this.resolve(net, false, 0, g);
        if (v != null) return Math.round(v * 4095);
      }
      return (p.mode & 4) ? 4095 : 0;
    }
    pwm(g, duty) {
      const p = this.pin(g);
      p.duty = Math.max(0, Math.min(1, duty));
      p.out = p.duty >= 0.5 ? 1 : 0;
      this.update(p);
    }
    tone(g, freq, dur) {
      if (!this.checkPin(g, 'tone')) return;
      const p = this.pin(g);
      p.tone = Math.max(0, Number(freq) || 0);
      this.update(p);
      if (dur) {
        const at = this.now() + Number(dur);
        this.timers = this.timers.filter((t) => t.g !== g);
        this.timers.push({ g, at, fn: () => { p.tone = 0; this.update(p); } });
      }
    }

    /** Pins on a net and on nets one series resistor away. */
    near(net) {
      const out = [];
      const add = (n) => { for (const m of n.pins) out.push({ uid: m.uid, pin: m.pin, name: this.pinName(m.uid, m.pin) }); };
      add(net);
      for (const m of net.pins) {
        const inst = this.byUid.get(m.uid);
        if (!inst || inst.type !== 'resistor') continue;
        const other = this.nl.byPin.get(G.pinKey(m.uid, m.pin === '1' ? '2' : '1'));
        if (other && other !== net) add(other);
      }
      return out;
    }

    /** Level of a net: 0, 1, a PWM level, or null when nothing drives it.
     *  Follows closed switches (buttons, relays) and then series resistors. */
    resolve(start, useAvg, depth, selfG) {
      const seen = new Set([start]);
      const queue = [start];
      while (queue.length) {
        const net = queue.shift();
        if (net.rails.includes('GND')) return 0;
        if (net.rails.some((r) => POS_RAILS.has(r))) return 1;
        if (net.gpio != null && net.gpio !== selfG) {
          const p = this.pins.get(net.gpio);
          if (p && this.drives(p)) return useAvg ? p.avg : p.lvl;
        }
        for (const m of net.pins) {
          const model = this.models.get(m.uid);
          if (!model) continue;
          const name = this.pinName(m.uid, m.pin);
          if (model.drive) { const d = model.drive(name); if (d != null) return d; }
          if (model.links) {
            for (const other of model.links(name)) {
              const n2 = this.pinNet(m.uid, other);
              if (n2 && !seen.has(n2)) { seen.add(n2); queue.push(n2); }
            }
          }
        }
      }
      if ((depth || 0) >= 2) return null;
      for (const net of seen) {
        for (const m of net.pins) {
          const inst = this.byUid.get(m.uid);
          if (!inst || inst.type !== 'resistor') continue;
          const other = this.nl.byPin.get(G.pinKey(m.uid, m.pin === '1' ? '2' : '1'));
          if (!other || seen.has(other)) continue;
          const v = this.resolve(other, useAvg, (depth || 0) + 1, selfG);
          if (v != null) return v;
        }
      }
      return null;
    }
    netLevel(uid, name, useAvg) { const n = this.pinNet(uid, name); return n ? this.resolve(n, useAvg, 0) : null; }

    // ------------------------------------------------------------- interrupts
    attachInterrupt(g, fn, mode) {
      if (typeof fn !== 'function') throw rtErr('attachInterrupt() needs the name of a function to call');
      this.irq.set(Number(g), { fn, mode: Number(mode), last: this.rawDigital(Number(g)) });
    }
    detachInterrupt(g) { this.irq.delete(Number(g)); }
    checkIrq() {
      if (!this.irq.size) return;
      for (const [g, q] of this.irq) {
        const v = this.pin(g).mode === MODE.OUTPUT ? (this.pin(g).lvl >= 0.5 ? 1 : 0) : this.rawDigital(g);
        if (v === q.last) continue;
        const rising = v === 1;
        q.last = v;
        const m = q.mode;
        if (m === 3 || (m === 1 && rising) || (m === 2 && !rising) || (m === 5 && rising) || (m === 4 && !rising)) this.rt.runIsr(q.fn);
      }
    }

    // ------------------------------------------------------------- binding library objects to parts
    findPart(types, pinName, g) {
      types = [].concat(types);
      for (const inst of this.state.parts) {
        if (!types.includes(inst.type)) continue;
        if (g == null || this.gpioOf(inst.uid, pinName) === Number(g)) return inst;
      }
      return null;
    }
    claimNext(types) {
      types = [].concat(types);
      const inst = this.state.parts.find((p) => types.includes(p.type) && !this.claimed.has(p.uid));
      if (inst) this.claimed.add(inst.uid);
      return inst || null;
    }
    i2cOk(inst) {
      if (!inst) return false;
      const sda = this.gpioOf(inst.uid, 'SDA'), scl = this.gpioOf(inst.uid, 'SCL');
      if (sda === this.i2c.sda && scl === this.i2c.scl) return true;
      const name = G.getPart(inst.type).name;
      this.rt.warnOnce(`${name}: its SDA/SCL pins must go to GPIO${this.i2c.sda}/GPIO${this.i2c.scl} (the I2C pins in Wire.begin), so the code can't find it`);
      return false;
    }
    i2cAddrs() {
      const ADDR = { oled: 0x3C, lcd: 0x27, bme280: 0x76, mpu6050: 0x68, rtc: 0x68, vl53l0x: 0x29, heartrate: 0x57 };
      const out = new Set();
      for (const inst of this.state.parts) {
        if (ADDR[inst.type] == null) continue;
        const sda = this.gpioOf(inst.uid, 'SDA'), scl = this.gpioOf(inst.uid, 'SCL');
        if (sda === this.i2c.sda && scl === this.i2c.scl) out.add(ADDR[inst.type]);
      }
      return out;
    }

    poll() {
      const now = this.now();
      if (this.timers.length) {
        const due = this.timers.filter((t) => t.at <= now);
        if (due.length) { this.timers = this.timers.filter((t) => t.at > now); due.forEach((t) => t.fn()); }
      }
      for (const m of this.models.values()) if (m.poll) m.poll(now);
    }

    model(opts) {
      const instant = !!(opts && opts.instant);
      if (!instant) this.sample();
      const out = {};
      for (const [uid, m] of this.models) {
        if (!m.view) continue;
        const v = m.view(!instant);
        if (v) out[uid] = v;
      }
      return out;
    }
  }

  /** Per-part behaviour: drive(pin) for signals it outputs, analog(pin), links(pin)
   *  for switches, view() for what the canvas shows, poll() for things that move on their own. */
  function makeModel(b, inst, def) {
    const uid = inst.uid;
    const inp = (f) => b.input(uid, f);
    const lvl = (name, avg) => b.netLevel(uid, name, avg);
    const on = (x) => (x == null ? 0 : x);
    switch (inst.type) {
      case 'led': return {
        view(avg) {
          const a = lvl('+', avg), c = lvl('-', avg);
          return { led: a == null || c == null ? 0 : Math.max(0, Math.min(1, a - c)), color: def.ledColor || '#ff3b30' };
        },
      };
      case 'rgbled': return {
        view(avg) {
          const k = lvl('GND', avg);
          if (k == null) return { led: 0, color: '#000000', rgb: [0, 0, 0] };
          const ch = ['R', 'G', 'B'].map((n) => Math.max(0, on(lvl(n, avg)) - k));
          const mx = Math.max(...ch);
          const hex = '#' + ch.map((x) => Math.round(mx ? (x / mx) * 255 : 0).toString(16).padStart(2, '0')).join('');
          return { led: mx, color: hex, rgb: ch.map((x) => Math.round(x * 255)) };
        },
      };
      case 'buzzer': return {
        view(avg) {
          const v = on(lvl('SIG', avg));
          const g = b.gpioOf(uid, 'SIG');
          const p = g != null ? b.pins.get(g) : null;
          return { buzz: v > 0.02 ? Math.min(1, v * (p && p.tone ? 2 : 1)) : 0, freq: p && p.tone ? p.tone : 2300 };
        },
      };
      case 'speaker': return {
        view() {
          for (const name of ['+', '-']) {
            const net = b.pinNet(uid, name);
            if (!net) continue;
            for (const m of net.pins) {
              const dev = b.devices.get(m.uid);
              if (dev && dev.playing) return { playing: true, track: dev.track };
            }
          }
          return { playing: false };
        },
      };
      case 'servo': {
        let cur = null, last = null;
        return {
          view() {
            const g = b.gpioOf(uid, 'SIG');
            const s = g != null ? b.servos.get(g) : null;
            const now = b.now();
            if (!s) return cur == null ? null : { angle: cur };
            const target = s.angle;
            if (cur == null) cur = target;
            const dt = last == null ? 0 : Math.max(0, now - last);
            last = now;
            const step = 0.6 * dt; // ~0.1 s per 60 degrees, like an SG90
            cur = Math.abs(target - cur) <= step ? target : cur + Math.sign(target - cur) * step;
            return { angle: cur, target };
          },
        };
      }
      case 'l298n': {
        const motor = (en, a, bb, avg) => {
          const enNet = b.pinNet(uid, en);
          const e = enNet ? on(b.resolve(enNet, avg, 0)) : 1;
          const ia = on(lvl(a, false)) >= 0.5 ? 1 : 0, ib = on(lvl(bb, false)) >= 0.5 ? 1 : 0;
          return e * (ia - ib);
        };
        const m = {
          speeds(avg) { return { a: motor('ENA', 'IN1', 'IN2', avg), b: motor('ENB', 'IN3', 'IN4', avg) }; },
          view(avg) {
            const s = m.speeds(avg);
            const motorOn = (outs) => outs.some((o) => { const n = b.pinNet(uid, o); return n && n.pins.some((p) => b.byUid.get(p.uid).type === 'dcmotor'); });
            return { a: s.a, b: s.b, motorA: motorOn(['OUT1', 'OUT2']), motorB: motorOn(['OUT3', 'OUT4']) };
          },
        };
        return m;
      }
      case 'dcmotor': {
        let angle = 0, last = null;
        return {
          view(avg) {
            let speed = 0;
            for (const [name, sign0] of [['M+', 1], ['M-', -1]]) {
              const net = b.pinNet(uid, name);
              if (!net) continue;
              for (const m of net.pins) {
                if (b.byUid.get(m.uid).type !== 'l298n') continue;
                const drv = b.models.get(m.uid).speeds(avg);
                const out = b.pinName(m.uid, m.pin);
                const s = { OUT1: drv.a, OUT2: -drv.a, OUT3: drv.b, OUT4: -drv.b }[out] || 0;
                speed = s * sign0;
              }
              if (speed) break;
            }
            if (!speed) {
              const p = lvl('M+', avg), n = lvl('M-', avg);
              if (p != null && n != null) speed = p - n;
            }
            const now = b.now();
            if (last != null) angle = (angle + speed * (now - last) * 0.9) % 360;
            last = now;
            return { speed, angle };
          },
        };
      }
      case 'relay': {
        let state = false, flipAt = -1e9;
        const isOn = () => on(lvl('IN', false)) >= 0.5;
        return {
          links(name) {
            const o = isOn();
            if (name === 'COM') return [o ? 'NO' : 'NC'];
            if ((name === 'NO' && o) || (name === 'NC' && !o)) return ['COM'];
            return [];
          },
          view() {
            const o = isOn();
            if (o !== state) { state = o; flipAt = b.now(); }
            return { on: o, flipAt };
          },
        };
      }
      case 'vibe': return { view(avg) { return { on: on(lvl('IN', avg)) }; } };
      case 'stepper': return { view() { const d = b.devices.get(uid); return d ? { angle: d.angle } : null; } };
      case 'oled': case 'lcd': case 'tm1637': case 'matrix': case 'dfplayer':
        return { view() { const d = b.devices.get(uid); return d && d.view ? d.view() : null; } };
      case 'ledring': case 'ledstrip':
        return { view() { const d = b.devices.get(uid); return d && d.view ? d.view() : null; } };
      case 'esp32': case 'esp32c3': return {
        view(avg) {
          if (inst.uid !== (b.ctl && b.ctl.uid)) return null;
          const p = b.pins.get(b.builtinLed);
          if (!p || !b.drives(p)) return { builtin: 0 };
          const v = avg ? p.avg : p.lvl;
          return { builtin: inst.type === 'esp32c3' ? 1 - v : v };
        },
      };
      // --------------------------------------------------- inputs
      case 'button': return {
        links(name) { return inp('pressed') ? (name === '1' ? ['2'] : name === '2' ? ['1'] : []) : []; },
        view() { return { pressed: !!inp('pressed') }; },
      };
      case 'slideswitch': return {
        links(name) {
          const other = inp('on') ? '2' : '1';
          if (name === 'COM') return [other];
          if (name === other) return ['COM'];
          return [];
        },
        view() { return { on: !!inp('on') }; },
      };
      case 'touch': return { drive(n) { return n === 'SIG' ? (inp('pressed') ? 1 : 0) : null; }, view() { return { pressed: !!inp('pressed') }; } };
      case 'pir': return { drive(n) { return n === 'OUT' ? (inp('motion') ? 1 : 0) : null; }, view() { return { motion: !!inp('motion') }; } };
      case 'hall': return { drive(n) { return n === 'SIG' ? (inp('magnet') ? 0 : 1) : null; }, view() { return { magnet: !!inp('magnet') }; } };
      case 'tcrt5000': return {
        drive(n) { return n === 'DO' ? (inp('line') ? 1 : 0) : null; },
        analog(n) { return n === 'AO' ? (inp('line') ? 3600 : 400) : null; },
        view() { return { line: !!inp('line') }; },
      };
      case 'pot': return { analog(n) { return n === 'OUT' ? inp('value') : null; }, view() { return { value: inp('value') }; } };
      case 'ldr': return {
        analog(n) { return n === 'AO' ? inp('value') : null; },
        drive(n) { return n === 'DO' ? (inp('value') < 2048 ? 1 : 0) : null; },
        view() { return { value: inp('value') }; },
      };
      case 'sound': return {
        analog(n) { return n === 'AO' ? inp('value') : null; },
        drive(n) { return n === 'DO' ? (inp('value') > 2048 ? 1 : 0) : null; },
        view() { return { value: inp('value') }; },
      };
      case 'mq2': return {
        analog(n) { return n === 'AO' ? inp('value') : null; },
        drive(n) { return n === 'DO' ? (inp('value') > 2048 ? 0 : 1) : null; },
        view() { return { value: inp('value') }; },
      };
      case 'soil': return { analog(n) { return n === 'AOUT' ? inp('value') : null; }, view() { return { value: inp('value') }; } };
      case 'joystick': return {
        analog(n) { return n === 'VRX' ? inp('x') : n === 'VRY' ? inp('y') : null; },
        drive(n) { return n === 'SW' && inp('pressed') ? 0 : null; },
        view() { return { x: inp('x'), y: inp('y'), pressed: !!inp('pressed') }; },
      };
      case 'encoder': {
        const CW = [[0, 1], [0, 0], [1, 0], [1, 1]], CCW = [[1, 0], [0, 0], [0, 1], [1, 1]];
        const st = { clk: 1, dt: 1, queue: [], seq: null, dir: 0, phase: 0, at: 0, reads: 0, count: 0 };
        const readsNow = () => {
          let n = 0;
          for (const name of ['CLK', 'DT']) { const g = b.gpioOf(uid, name); if (g != null && b.pins.has(g)) n += b.pins.get(g).reads; }
          return n;
        };
        const apply = (now) => { const ph = st.seq[st.phase]; st.clk = ph[0]; st.dt = ph[1]; st.at = now; st.reads = readsNow(); b.checkIrq(); b.rt.dirty = true; };
        return {
          drive(n) { return n === 'CLK' ? st.clk : n === 'DT' ? st.dt : (n === 'SW' && inp('pressed') ? 0 : null); },
          onInput(field, v) { if (field === 'turn') { const k = Math.max(-20, Math.min(20, Math.round(Number(v) || 0))); for (let i = 0; i < Math.abs(k); i++) st.queue.push(Math.sign(k)); } },
          poll(now) {
            if (!st.seq) {
              if (!st.queue.length) return;
              st.dir = st.queue.shift();
              st.seq = st.dir > 0 ? CW : CCW;
              st.phase = 0;
              apply(now);
              return;
            }
            const read = readsNow() > st.reads;
            if (now - st.at >= 1 && (read || now - st.at > 250)) {
              st.phase++;
              if (st.phase >= st.seq.length) { st.seq = null; st.count += st.dir; return; }
              apply(now);
            }
          },
          view() { return { count: st.count, pressed: !!inp('pressed') }; },
        };
      }
      case 'keypad': {
        const held = new Map(); // key index -> release time
        const queue = [];
        let last = null;
        return {
          queue,
          links(name) {
            const out = [];
            for (const i of held.keys()) {
              const r = 'R' + (Math.floor(i / 4) + 1), c = 'C' + ((i % 4) + 1);
              if (name === r) out.push(c);
              if (name === c) out.push(r);
            }
            return out;
          },
          onInput(field, v) {
            const i = KEYPAD_LABELS.indexOf(String(v));
            if (field === 'key' && i >= 0) { queue.push(i); held.set(i, b.now() + 200); last = String(v); b.checkIrq(); }
            if (field === 'hold') {
              if (v == null || v === '' || v === false) { for (const k of held.keys()) if (held.get(k) === Infinity) held.set(k, b.now() + 120); }
              else if (i >= 0) { queue.push(i); held.set(i, Infinity); last = String(v); }
              b.checkIrq();
            }
          },
          poll(now) { for (const [k, t] of held) if (t <= now) { held.delete(k); b.checkIrq(); } },
          view() { return { last, held: Array.from(held.keys()).map((i) => KEYPAD_LABELS[i]) }; },
        };
      }
      case 'irrecv': {
        const queue = [];
        let last = null, at = -1e9;
        return {
          queue,
          drive(n) { return n === 'SIG' ? 1 : null; },
          onInput(field, v) {
            if (field !== 'code') return;
            const k = IR_KEYS.find((x) => x[0] === v || x[1] === Number(v));
            const cmd = k ? k[1] : Number(v) & 255;
            queue.push(cmd); last = k ? k[0] : '0x' + cmd.toString(16); at = b.now();
          },
          view() { return { last, at }; },
        };
      }
      case 'rfid': {
        const m = { pending: null, current: null, at: -1e9 };
        return Object.assign(m, {
          onInput(field, v) { if (field === 'card' && v) { m.pending = String(v).trim().split(/[\s:]+/).map((h) => parseInt(h, 16) & 255); m.at = b.now(); } },
          view() { return { tapAt: m.at }; },
        });
      }
      case 'hcsr04': return { echo: true, lastFalls: -1, view() { return { distance: inp('distance') }; } };
      case 'vl53l0x': case 'dht22': case 'bme280': case 'ds18b20': case 'mpu6050': case 'loadcell':
        return { view() { return Object.assign({}, b.inputs[uid]); } };
      case 'heartrate': return { view() { return { finger: !!inp('finger'), bpm: inp('bpm') }; } };
      default: return null;
    }
  }

  // ===================================================================
  // Library models
  // ===================================================================

  // Survives stop / run, like flash memory survives a reset.
  const PERSIST = { eeprom: new Map(), prefs: new Map(), files: new Map() };

  const SEG = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f, 0x77, 0x7c, 0x39, 0x5e, 0x79, 0x71];
  const SEG_CHARS = new Map(SEG.map((m, i) => [m, '0123456789AbCdEF'[i]]).concat([[0, ' '], [0x40, '-'], [0x08, '_'], [0x63, '°'], [0x76, 'H'], [0x38, 'L'], [0x73, 'P'], [0x3e, 'U'], [0x54, 'n'], [0x5c, 'o'], [0x50, 'r'], [0x78, 't']]));

  function hsv(hue, sat, val) {
    hue = ((Number(hue) || 0) & 0xffff);
    sat = sat == null ? 255 : sat & 255; val = val == null ? 255 : val & 255;
    hue = Math.floor((hue * 1530 + 32768) / 65536);
    let r, g, b;
    if (hue < 510) { b = 0; if (hue < 255) { r = 255; g = hue; } else { r = 510 - hue; g = 255; } }
    else if (hue < 1020) { r = 0; if (hue < 765) { g = 255; b = hue - 510; } else { g = 1020 - hue; b = 255; } }
    else if (hue < 1530) { g = 0; if (hue < 1275) { r = hue - 1020; b = 255; } else { r = 255; b = 1530 - hue; } }
    else { r = 255; g = 0; b = 0; }
    const v1 = 1 + val, s1 = 1 + sat, s2 = 255 - sat;
    return (((((((r * s1) >> 8) + s2) * v1) & 0xff00) << 8) | (((((g * s1) >> 8) + s2) * v1) & 0xff00) | (((((b * s1) >> 8) + s2) * v1) >> 8)) >>> 0;
  }
  const gamma8 = (x) => Math.round(Math.pow((x & 255) / 255, 2.6) * 255);
  const gamma32 = (c) => ((gamma8(c >> 16) << 16) | (gamma8(c >> 8) << 8) | gamma8(c)) >>> 0;
  const rgbColor = (r, g, b) => ((((r & 255) << 16) | ((g & 255) << 8) | (b & 255)) >>> 0);

  function makeLibs(rt) {
    const b = rt.board;
    const now = () => rt.clock.now();
    const partName = (type) => (G.getPart(type) || { name: type }).name;
    const noPart = (what, type, pin, g) => rt.warnOnce(`${what}: no ${partName(type)} ${pin} pin is wired to GPIO${g}, so it won't do anything`);

    class Print {
      print(v, a, hint) { const s = toS(v, hint, a); this._out(s); return s.length; }
      println(v, a, hint) { const s = (arguments.length ? toS(v, hint, a) : '') + '\n'; this._out(s); return s.length; }
      printf(fmt, ...args) { const s = cfmt(fmt, args); this._out(s); return s.length; }
      write(v, len) {
        if (typeof v === 'string') { const s = len != null ? v.slice(0, len) : v; this._out(s); return s.length; }
        if (Array.isArray(v)) { const a = len != null ? v.slice(0, len) : v; this._out(String.fromCharCode(...a.map((x) => x & 255))); return a.length; }
        this._out(String.fromCharCode(Number(v) & 255)); return 1;
      }
      flush() {}
      availableForWrite() { return 128; }
      _out() {}
    }

    class HwSerial extends Print {
      constructor(main) { super(); this.main = main === true; this.rx = ''; this.baud = 0; }
      begin(baud) { this.baud = Number(baud) || 0; return true; }
      end() {}
      _out(s) { if (this.main) rt.serialOut(s); }
      available() { return this.main ? rt.rx.length : this.rx.length; }
      _rx() { return this.main ? rt.rx : this.rx; }
      _set(v) { if (this.main) rt.rx = v; else this.rx = v; }
      read() { const r = this._rx(); if (!r.length) return -1; this._set(r.slice(1)); return r.charCodeAt(0) & 255; }
      peek() { const r = this._rx(); return r.length ? r.charCodeAt(0) & 255 : -1; }
      readString() { const r = this._rx(); this._set(''); return r; }
      readStringUntil(t) {
        const r = this._rx(), ch = chrs(t), i = r.indexOf(ch);
        if (i < 0) { this._set(''); return r; }
        this._set(r.slice(i + 1)); return r.slice(0, i);
      }
      readBytesUntil(t, buf, n) { const s = this.readStringUntil(t).slice(0, n); if (Array.isArray(buf)) { for (let i = 0; i < s.length && i < buf.length; i++) buf[i] = s.charCodeAt(i); } return s.length; }
      readBytes(buf, n) { const r = this._rx().slice(0, n); this._set(this._rx().slice(r.length)); if (Array.isArray(buf)) for (let i = 0; i < r.length && i < buf.length; i++) buf[i] = r.charCodeAt(i); return r.length; }
      parseInt() { const r = this._rx(); const m = /^[^-\d]*(-?\d+)/.exec(r); if (!m) { this._set(''); return 0; } this._set(r.slice(m[0].length)); return parseInt(m[1], 10) | 0; }
      parseFloat() { const r = this._rx(); const m = /^[^-\d.]*(-?\d*\.?\d+)/.exec(r); if (!m) { this._set(''); return 0; } this._set(r.slice(m[0].length)); return parseFloat(m[1]); }
      find(s) { const r = this._rx(); s = toS(s); const i = r.indexOf(s); if (i < 0) { this._set(''); return false; } this._set(r.slice(i + s.length)); return true; }
      setTimeout() {}
      setRxBufferSize() { return 256; }
      setDebugOutput() {}
      toString() { return '1'; }
    }
    class Bluetooth extends HwSerial {
      constructor() { super(false); }
      begin() { rt.warnOnce('Bluetooth is pretend in the simulator: nothing connects'); return true; }
      hasClient() { return false; }
      connected() { return false; }
    }

    class TwoWire {
      constructor() { this.addr = 0; }
      begin(sda, scl) {
        if (sda != null && scl != null && Number(sda) >= 0 && Number(scl) >= 0) b.i2c = { sda: Number(sda), scl: Number(scl) };
        return true;
      }
      setPins(sda, scl) { return this.begin(sda, scl); }
      setClock() {}
      end() { return true; }
      beginTransmission(a) { this.addr = Number(a); }
      write() { return 1; }
      endTransmission() { return b.i2cAddrs().has(this.addr) ? 0 : 2; }
      requestFrom() { return 0; }
      available() { return 0; }
      read() { return -1; }
    }

    class Servo {
      constructor() { this.pin = -1; this.min = 544; this.max = 2400; this.angle = 90; this.us = 1500; }
      attach(pin, min, max) {
        pin = Number(pin);
        if (!b.checkPin(pin, 'servo.attach')) return 0;
        this.pin = pin;
        if (min != null) this.min = Number(min);
        if (max != null) this.max = Number(max);
        b.servos.set(pin, this);
        if (!b.findPart('servo', 'SIG', pin)) noPart(`servo.attach(${pin})`, 'servo', 'SIG', pin);
        return 1;
      }
      detach() { if (b.servos.get(this.pin) === this) b.servos.delete(this.pin); this.pin = -1; }
      attached() { return this.pin >= 0; }
      write(v) {
        v = Number(v);
        if (v >= 500) return this.writeMicroseconds(v);
        this.angle = Math.max(0, Math.min(180, v));
        this.us = Math.round(this.min + (this.max - this.min) * this.angle / 180);
        rt.dirty = true;
      }
      writeMicroseconds(us) { this.us = Number(us); this.angle = Math.max(0, Math.min(180, (this.us - this.min) * 180 / (this.max - this.min))); rt.dirty = true; }
      read() { return Math.round(this.angle); }
      readMicroseconds() { return this.us; }
      setPeriodHertz() {}
    }

    const heatIndex = (t, h, isF) => {
      if (!isF) t = t * 1.8 + 32;
      let hi = 0.5 * (t + 61.0 + ((t - 68.0) * 1.2) + (h * 0.094));
      if (hi > 79) {
        hi = -42.379 + 2.04901523 * t + 10.14333127 * h - 0.22475541 * t * h - 0.00683783 * t * t - 0.05481717 * h * h +
          0.00122874 * t * t * h + 0.00085282 * t * h * h - 0.00000199 * t * t * h * h;
        if (h < 13 && t >= 80 && t <= 112) hi -= ((13 - h) * 0.25) * Math.sqrt((17 - Math.abs(t - 95)) * 0.05882);
        else if (h > 85 && t >= 80 && t <= 87) hi += ((h - 85) * 0.1) * ((87 - t) * 0.2);
      }
      return isF ? hi : (hi - 32) / 1.8;
    };

    class DHT {
      constructor(pin, type) { this.pin = Number(pin); this.type = type; this.inst = null; }
      _bind() { if (!this.inst) this.inst = b.findPart('dht22', 'DATA', this.pin); return this.inst; }
      begin() { if (!this._bind()) noPart(`DHT on GPIO${this.pin}`, 'dht22', 'DATA', this.pin); }
      _v(f) { return this._bind() ? Number(b.input(this.inst.uid, f)) : NaN; }
      read() { return !!this._bind(); }
      readTemperature(isF) { const c = this._v('temp'); return isF ? c * 1.8 + 32 : c; }
      readHumidity() { return this._v('hum'); }
      computeHeatIndex(t, h, isF) { return heatIndex(Number(t), Number(h), isF === undefined ? true : !!isF); }
      convertCtoF(c) { return c * 1.8 + 32; }
      convertFtoC(f) { return (f - 32) / 1.8; }
    }
    class DHTesp {
      constructor() { this.dht = null; }
      setup(pin) { this.dht = new DHT(pin, 22); this.dht.begin(); }
      getTemperature() { return this.dht ? this.dht.readTemperature() : NaN; }
      getHumidity() { return this.dht ? this.dht.readHumidity() : NaN; }
      getTempAndHumidity() { return { temperature: this.getTemperature(), humidity: this.getHumidity() }; }
      getStatus() { return this.dht && this.dht.inst ? 0 : 1; }
      getStatusString() { return this.getStatus() ? 'TIMEOUT' : 'OK'; }
      computeHeatIndex(t, h, isF) { return heatIndex(Number(t), Number(h), !!isF); }
      getMinimumSamplingPeriod() { return 2000; }
      getModel() { return 2; }
    }

    // ----------------------------------------------------------- screens
    class Oled extends Print {
      constructor(w, h) {
        super();
        this.W = Number(w) > 0 ? Number(w) : 128; this.H = Number(h) > 0 ? Number(h) : 64;
        this.inst = null; this.ok = false; this.ops = []; this.shown = []; this.frames = 0;
        this.cx = 0; this.cy = 0; this.sx = 1; this.sy = 1; this.fg = 1; this.bg = -1; this.wrap = true;
        this.inv = false; this.rot = 0; this.dimmed = false; this.on = true; this.overflow = false;
      }
      begin() {
        this.inst = b.claimNext('oled');
        if (!this.inst) { rt.warnOnce('display.begin(): there is no Small screen (OLED) on the canvas'); return false; }
        this.ok = b.i2cOk(this.inst);
        if (this.ok) b.devices.set(this.inst.uid, this);
        return this.ok;
      }
      _push(op) { if (this.ops.length >= 2500) { this.overflow = true; return; } this.ops.push(op); }
      clearDisplay() { this.ops = []; this.overflow = false; }
      display() { this.shown = this.ops.slice(); this.frames++; rt.dirty = true; }
      setTextSize(s, sy) { this.sx = Math.max(1, Number(s) | 0); this.sy = sy != null ? Math.max(1, Number(sy) | 0) : this.sx; }
      setTextColor(c, bg) { this.fg = Number(c); this.bg = bg == null ? -1 : Number(bg); }
      setCursor(x, y) { this.cx = Number(x) | 0; this.cy = Number(y) | 0; }
      setTextWrap(w) { this.wrap = !!w; }
      getCursorX() { return this.cx; }
      getCursorY() { return this.cy; }
      width() { return this.rot & 1 ? this.H : this.W; }
      height() { return this.rot & 1 ? this.W : this.H; }
      setRotation(r) { this.rot = Number(r) & 3; }
      getRotation() { return this.rot; }
      invertDisplay(i) { this.inv = !!i; rt.dirty = true; }
      dim(d) { this.dimmed = !!d; rt.dirty = true; }
      cp437() {}
      setFont() {}
      ssd1306_command(c) { if (c === 0xAE) this.on = false; if (c === 0xAF) this.on = true; rt.dirty = true; }
      oled_command(c) { this.ssd1306_command(c); }
      startscrollright() {} startscrollleft() {} startscrolldiagright() {} startscrolldiagleft() {} stopscroll() {}
      drawPixel(x, y, c) { this._push({ k: 'p', x: +x, y: +y, c: c == null ? 1 : +c }); }
      drawLine(x0, y0, x1, y1, c) { this._push({ k: 'l', x0: +x0, y0: +y0, x1: +x1, y1: +y1, c: +c }); }
      drawFastHLine(x, y, w, c) { this._push({ k: 'r', x: +x, y: +y, w: +w, h: 1, c: +c, f: 1 }); }
      drawFastVLine(x, y, h, c) { this._push({ k: 'r', x: +x, y: +y, w: 1, h: +h, c: +c, f: 1 }); }
      drawRect(x, y, w, h, c) { this._push({ k: 'r', x: +x, y: +y, w: +w, h: +h, c: +c, f: 0 }); }
      fillRect(x, y, w, h, c) { this._push({ k: 'r', x: +x, y: +y, w: +w, h: +h, c: +c, f: 1 }); }
      drawRoundRect(x, y, w, h, r, c) { this._push({ k: 'r', x: +x, y: +y, w: +w, h: +h, rr: +r, c: +c, f: 0 }); }
      fillRoundRect(x, y, w, h, r, c) { this._push({ k: 'r', x: +x, y: +y, w: +w, h: +h, rr: +r, c: +c, f: 1 }); }
      drawCircle(x, y, r, c) { this._push({ k: 'c', x: +x, y: +y, r: +r, c: +c, f: 0 }); }
      fillCircle(x, y, r, c) { this._push({ k: 'c', x: +x, y: +y, r: +r, c: +c, f: 1 }); }
      drawTriangle(x0, y0, x1, y1, x2, y2, c) { this._push({ k: 'g', pts: [+x0, +y0, +x1, +y1, +x2, +y2], c: +c, f: 0 }); }
      fillTriangle(x0, y0, x1, y1, x2, y2, c) { this._push({ k: 'g', pts: [+x0, +y0, +x1, +y1, +x2, +y2], c: +c, f: 1 }); }
      fillScreen(c) { this.ops = []; if (Number(c)) this._push({ k: 'r', x: 0, y: 0, w: this.W, h: this.H, c: 1, f: 1 }); }
      drawBitmap(x, y, bmp, w, h, c, bg) {
        if (!Array.isArray(bmp)) return;
        const bw = Math.ceil(w / 8);
        let d = '';
        for (let j = 0; j < h; j++) {
          let run = -1;
          for (let i = 0; i <= w; i++) {
            const on = i < w && ((bmp[j * bw + (i >> 3)] || 0) & (0x80 >> (i & 7)));
            if (on && run < 0) run = i;
            if (!on && run >= 0) { d += `M${x + run} ${y + j}h${i - run}v1h${run - i}z`; run = -1; }
          }
        }
        if (bg != null) this._push({ k: 'r', x: +x, y: +y, w: +w, h: +h, c: +bg, f: 1 });
        if (d) this._push({ k: 'b', d, c: c == null ? 1 : +c });
      }
      drawXBitmap(x, y, bmp, w, h, c) {
        if (!Array.isArray(bmp)) return;
        const bw = Math.ceil(w / 8);
        const flipped = bmp.map((v) => { let r = 0; for (let i = 0; i < 8; i++) if (v & (1 << i)) r |= 0x80 >> i; return r; });
        void bw;
        this.drawBitmap(x, y, flipped, w, h, c);
      }
      drawChar(x, y, ch, c, bg, size) {
        const save = [this.cx, this.cy, this.fg, this.bg, this.sx, this.sy];
        this.cx = +x; this.cy = +y; this.fg = +c; this.bg = bg == null ? -1 : +bg; this.sx = this.sy = Math.max(1, size | 0);
        this._out(typeof ch === 'number' ? String.fromCharCode(ch) : toS(ch).slice(0, 1));
        [this.cx, this.cy, this.fg, this.bg, this.sx, this.sy] = save;
      }
      getTextBounds(str, x, y, x1, y1, w, h) {
        const lines = toS(str).split('\n');
        const len = Math.max(...lines.map((l) => l.length));
        const set = (r, v) => { if (r && typeof r === 'object' && r.__ref) r.v = v; };
        set(x1, Number(x)); set(y1, Number(y)); set(w, len * 6 * this.sx); set(h, lines.length * 8 * this.sy);
      }
      _out(s) {
        for (const ch of s) {
          if (ch === '\n') { this.cx = 0; this.cy += 8 * this.sy; continue; }
          if (ch === '\r') continue;
          if (this.wrap && this.cx + 6 * this.sx > this.width()) { this.cx = 0; this.cy += 8 * this.sy; }
          const last = this.ops[this.ops.length - 1];
          if (last && last.k === 'x' && last.y === this.cy && last.sx === this.sx && last.sy === this.sy && last.c === this.fg && last.bg === this.bg && last.x + last.s.length * 6 * this.sx === this.cx) last.s += ch;
          else this._push({ k: 'x', x: this.cx, y: this.cy, sx: this.sx, sy: this.sy, c: this.fg, bg: this.bg, s: ch });
          this.cx += 6 * this.sx;
        }
      }
      view() {
        return { on: this.on, inv: this.inv, dim: this.dimmed, w: this.W, h: this.H, ops: this.shown, frames: this.frames,
          text: this.shown.filter((o) => o.k === 'x').map((o) => o.s).join(' ') };
      }
    }

    class Lcd extends Print {
      constructor(addr, cols, rows) {
        super();
        this.parallel = false;
        this.cols = Number(cols) > 0 ? Number(cols) : 16; this.rows = Number(rows) > 0 ? Number(rows) : 2;
        this.inst = null; this.ok = false; this.light = false; this.disp = true; this.custom = {}; this.shift = 0;
        this._grid();
      }
      _grid() { this.grid = []; for (let r = 0; r < Math.max(1, this.rows); r++) this.grid.push(new Array(40).fill(32)); this.col = 0; this.row = 0; }
      _bind() {
        if (this.inst) return;
        this.inst = b.claimNext('lcd');
        if (!this.inst) { rt.warnOnce('lcd.init(): there is no Text screen (LCD) on the canvas'); return; }
        this.ok = this.parallel ? true : b.i2cOk(this.inst);
        if (this.ok) b.devices.set(this.inst.uid, this);
      }
      init() { this._bind(); this.clear(); }
      begin(c, r) { if (Number(c) > 0) { this.cols = Number(c); this.rows = Number(r) || this.rows; this._grid(); } this._bind(); this.clear(); }
      backlight() { this.light = true; rt.dirty = true; }
      noBacklight() { this.light = false; rt.dirty = true; }
      setBacklight(v) { this.light = !!Number(v); rt.dirty = true; }
      clear() { for (const row of this.grid) row.fill(32); this.col = 0; this.row = 0; this.shift = 0; rt.dirty = true; }
      home() { this.col = 0; this.row = 0; this.shift = 0; }
      setCursor(c, r) { this.col = Math.max(0, Number(c) | 0); this.row = Math.max(0, Math.min(this.rows - 1, Number(r) | 0)); }
      _out(s) {
        for (const ch of s) {
          const code = ch.charCodeAt(0);
          if (code === 10 || code === 13) continue;
          if (this.col < 40 && this.row < this.grid.length) this.grid[this.row][this.col] = code;
          this.col++;
        }
        rt.dirty = true;
      }
      createChar(n, bytes) { this.custom[Number(n) & 7] = Array.from(bytes || []).slice(0, 8).map((x) => Number(x) & 31); }
      display() { this.disp = true; rt.dirty = true; }
      noDisplay() { this.disp = false; rt.dirty = true; }
      cursor() {} noCursor() {} blink() {} noBlink() {} autoscroll() {} noAutoscroll() {} leftToRight() {} rightToLeft() {}
      scrollDisplayLeft() { this.shift++; rt.dirty = true; }
      scrollDisplayRight() { this.shift--; rt.dirty = true; }
      printstr(s) { this.print(s); }
      view() {
        const codes = this.grid.slice(0, this.rows).map((row) => {
          const out = [];
          for (let c = 0; c < this.cols; c++) out.push(row[(((c + this.shift) % 40) + 40) % 40]);
          return out;
        });
        return { light: this.light, on: this.disp, cols: this.cols, rows: this.rows, codes, custom: this.custom,
          lines: codes.map((r) => r.map((c) => (c < 8 ? '█' : String.fromCharCode(c))).join('')) };
      }
    }
    class LcdParallel extends Lcd { constructor() { super(0, 16, 2); this.parallel = true; } }

    class TM1637 {
      constructor(clk, dio) {
        this.clk = Number(clk); this.dio = Number(dio); this.segs = [0, 0, 0, 0]; this.bright = 7; this.on = true;
        this.inst = b.findPart('tm1637', 'CLK', this.clk);
        if (this.inst) b.devices.set(this.inst.uid, this);
        else noPart(`TM1637Display(${clk}, ${dio})`, 'tm1637', 'CLK', clk);
      }
      setBrightness(br, on) { this.bright = Number(br) & 7; this.on = on === undefined ? true : !!on; rt.dirty = true; }
      setSegments(segs, len, pos) {
        len = len == null ? 4 : len; pos = pos || 0;
        for (let i = 0; i < len; i++) if (pos + i < 4 && pos + i >= 0) this.segs[pos + i] = (Number(segs[i]) || 0) & 255;
        rt.dirty = true;
      }
      clear() { this.segs = [0, 0, 0, 0]; rt.dirty = true; }
      encodeDigit(d) { return SEG[Number(d) & 15]; }
      showNumberDec(num, lz, len, pos) { this.showNumberDecEx(num, 0, lz, len, pos); }
      showNumberDecEx(num, dots, lz, len, pos) { num = Math.trunc(Number(num) || 0); this._base(num < 0 ? -10 : 10, Math.abs(num), dots, lz, len, pos); }
      showNumberHexEx(num, dots, lz, len, pos) { this._base(16, (Number(num) || 0) & 0xffff, dots, lz, len, pos); }
      _base(base, num, dots, lz, len, pos) {
        let negative = false;
        if (base < 0) { base = -base; negative = true; }
        lz = !!lz; len = len == null ? 4 : Number(len); dots = Number(dots) || 0;
        const digits = [0, 0, 0, 0];
        if (num === 0 && !lz) { digits[len - 1] = SEG[0]; } else {
          for (let i = len - 1; i >= 0; --i) {
            const digit = num % base;
            digits[i] = (digit === 0 && num === 0 && !lz) ? 0 : SEG[digit];
            if (digit === 0 && num === 0 && negative) { digits[i] = 0x40; negative = false; }
            num = Math.floor(num / base);
          }
        }
        for (let i = 0; i < 4; i++) { digits[i] |= (dots & 0x80); dots <<= 1; }
        this.setSegments(digits, len, pos);
      }
      view() {
        return { segs: this.segs.slice(), bright: this.bright, on: this.on, colon: !!(this.segs[1] & 0x80),
          text: this.segs.map((m) => (SEG_CHARS.has(m & 0x7f) ? SEG_CHARS.get(m & 0x7f) : '?')).join('') };
      }
    }

    class NeoPixel {
      constructor(n, pin) {
        this.n = Math.max(0, Number(n) | 0); this.pin = pin == null ? -1 : Number(pin);
        this.px = new Array(this.n).fill(0); this.shown = this.px.slice(); this.br = 255; this.shownBr = 255; this.inst = null;
        this._bind();
      }
      _bind() {
        if (this.pin < 0) return;
        this.inst = b.findPart(['ledring', 'ledstrip'], 'DIN', this.pin);
        if (this.inst) b.devices.set(this.inst.uid, this);
        else rt.warnOnce(`Adafruit_NeoPixel on GPIO${this.pin}: no LED ring or LED strip DIN pin is wired to GPIO${this.pin}`);
      }
      begin() { return true; }
      show() { this.shown = this.px.slice(); this.shownBr = this.br; rt.dirty = true; }
      canShow() { return true; }
      setPin(p) { this.pin = Number(p); this._bind(); }
      updateLength(n) { this.n = Math.max(0, Number(n) | 0); this.px = new Array(this.n).fill(0); }
      updateType() {}
      numPixels() { return this.n; }
      setPixelColor(i, r, g, bl) {
        i = Number(i) | 0;
        if (i < 0 || i >= this.n) return;
        this.px[i] = g === undefined ? (Number(r) >>> 0) & 0xffffff : rgbColor(r, g, bl);
      }
      getPixelColor(i) { return this.px[Number(i) | 0] || 0; }
      fill(c, first, count) {
        c = (Number(c) || 0) & 0xffffff; first = Number(first) || 0;
        const end = count ? Math.min(this.n, first + Number(count)) : this.n;
        for (let i = Math.max(0, first); i < end; i++) this.px[i] = c;
      }
      clear() { this.px.fill(0); }
      setBrightness(v) { this.br = Number(v) & 255; }
      getBrightness() { return this.br; }
      Color(r, g, bl) { return rgbColor(r, g, bl); }
      ColorHSV(h, s, v) { return hsv(h, s, v); }
      gamma32(c) { return gamma32(c); }
      gamma8(x) { return gamma8(x); }
      sine8(x) { return Math.round((Math.sin(((Number(x) & 255) / 256) * Math.PI * 2) + 1) * 127.5); }
      rainbow(first, reps, sat, bright, gammify) {
        first = Number(first) || 0; reps = reps == null ? 1 : Number(reps);
        for (let i = 0; i < this.n; i++) {
          let c = hsv(first + Math.floor((i * reps * 65536) / this.n), sat == null ? 255 : sat, bright == null ? 255 : bright);
          if (gammify === undefined || gammify) c = gamma32(c);
          this.px[i] = c;
        }
      }
      view() { return { pixels: this.shown.map((c) => '#' + (c & 0xffffff).toString(16).padStart(6, '0')), bright: this.shownBr / 255 }; }
    }

    class Matrix {
      constructor(hw, a, bb, c) {
        let din = null, cs;
        if (c !== undefined) { din = Number(a); cs = Number(c); } else cs = Number(a);
        this.inst = (din != null && b.findPart('matrix', 'DIN', din)) || b.findPart('matrix', 'CS', cs);
        this.rows = [0, 0, 0, 0, 0, 0, 0, 0];
        if (this.inst) b.devices.set(this.inst.uid, this);
        else noPart('MD_MAX72XX', 'matrix', din != null ? 'DIN' : 'CS', din != null ? din : cs);
      }
      begin() { return true; }
      control() { return true; }
      update() {}
      transform() { return true; }
      clear() { this.rows.fill(0); rt.dirty = true; }
      setPoint(r, c, s) {
        r = Number(r) | 0; c = Number(c) | 0;
        if (r < 0 || r > 7 || c < 0 || c > 7) return false;
        if (s) this.rows[r] |= (1 << c); else this.rows[r] &= ~(1 << c);
        rt.dirty = true; return true;
      }
      getPoint(r, c) { return !!((this.rows[Number(r) & 7] >> (Number(c) & 7)) & 1); }
      setColumn(c, v) { for (let r = 0; r < 8; r++) this.setPoint(r, c, (Number(v) >> r) & 1); return true; }
      setRow(r, v) { if (arguments.length === 3) { v = arguments[2]; r = arguments[1]; } this.rows[Number(r) & 7] = Number(v) & 255; rt.dirty = true; return true; }
      getColumnCount() { return 8; }
      getDeviceCount() { return 1; }
      setChar() { return 0; }
      view() { return { rows: this.rows.slice() }; }
    }
    class LedControl extends Matrix {
      constructor(din, clk, cs) { super(0, din, clk, cs); }
      shutdown() {} setIntensity() {} setScanLimit() {}
      clearDisplay() { this.clear(); }
      setLed(addr, r, c, s) { if (Number(addr) === 0) this.setPoint(r, c, s); }
      setRow(addr, r, v) { if (Number(addr) !== 0) return; for (let c = 0; c < 8; c++) this.setPoint(r, c, (Number(v) >> (7 - c)) & 1); }
      setColumn(addr, c, v) { if (Number(addr) !== 0) return; for (let r = 0; r < 8; r++) this.setPoint(r, c, (Number(v) >> (7 - r)) & 1); }
      setDigit() {} setChar() {}
      getDeviceCount() { return 1; }
    }

    // ----------------------------------------------------------- sensors
    class NewPing {
      constructor(trig, echo, max) {
        this.trig = Number(trig); this.echo = Number(echo); this.max = max == null ? 500 : Number(max);
        this.inst = b.findPart('hcsr04', 'TRIG', this.trig) || b.findPart('hcsr04', 'ECHO', this.echo);
        if (!this.inst) noPart(`NewPing(${trig}, ${echo})`, 'hcsr04', 'TRIG', trig);
      }
      _cm(max) {
        if (!this.inst) { rt.clock.bump(30); return 0; }
        const d = Number(b.input(this.inst.uid, 'distance'));
        rt.clock.bump((d * 58.3) / 1000);
        return d > (max || this.max) || d > 400 ? 0 : d;
      }
      ping_cm(max) { return Math.round(this._cm(max)); }
      ping_in(max) { return Math.round(this._cm(max) / 2.54); }
      ping(max) { return Math.round(this._cm(max) * 57); }
      ping_median(it, max) { return this.ping(max); }
      convert_cm(us) { return Math.round(us / 57); }
      convert_in(us) { return Math.round(us / 146); }
    }

    class Vl53 {
      constructor() { this.inst = null; this.ok = false; }
      begin() {
        this.inst = b.claimNext('vl53l0x');
        if (!this.inst) { rt.warnOnce('lox.begin(): there is no Laser distance sensor on the canvas'); return false; }
        this.ok = b.i2cOk(this.inst);
        return this.ok;
      }
      init() { return this.begin(); }
      _mm() { if (!this.ok) return 8190; const d = Number(b.input(this.inst.uid, 'distance')); return d > 2000 ? 8190 : Math.round(d); }
      readRange() { return this._mm(); }
      readRangeStatus() { return this._mm() >= 8190 ? 4 : 0; }
      rangingTest(m) { const v = this._mm(); if (m && typeof m === 'object') { m.RangeMilliMeter = v; m.RangeStatus = v >= 8190 ? 4 : 0; } return 0; }
      startRangeContinuous() { return true; } stopRangeContinuous() {} isRangeComplete() { return true; } readRangeResult() { return this._mm(); }
      setMeasurementTimingBudgetMicroSeconds() { return true; } timeoutOccurred() { return false; } setTimeout() {} setAddress() { return true; }
      startContinuous() {} readRangeContinuousMillimeters() { return this._mm(); } readRangeSingleMillimeters() { return this._mm(); }
    }
    class RangingData { constructor() { this.RangeMilliMeter = 0; this.RangeStatus = 0; } }

    class Bme280 {
      constructor() { this.inst = null; this.ok = false; this.hum = true; }
      begin() {
        this.inst = b.claimNext('bme280');
        if (!this.inst) { rt.warnOnce('bme.begin(): there is no Weather sensor (BME280) on the canvas'); return false; }
        this.ok = b.i2cOk(this.inst);
        return this.ok;
      }
      _v(f) { return this.ok ? Number(b.input(this.inst.uid, f)) : NaN; }
      readTemperature() { return this._v('temp'); }
      readHumidity() { return this.hum ? this._v('hum') : NaN; }
      readPressure() { return this._v('pressure') * 100; }
      readAltitude(sea) { const p = this._v('pressure'); return 44330 * (1 - Math.pow(p / (Number(sea) || 1013.25), 0.1903)); }
      seaLevelForAltitude(alt, p) { return p / Math.pow(1 - alt / 44330, 5.255); }
      setSampling() {} takeForcedMeasurement() { return true; } sensorID() { return 0x60; }
    }
    class Bmp280 extends Bme280 { constructor() { super(); this.hum = false; } }

    class OneWire { constructor(pin) { this.pin = Number(pin); } reset() { return 1; } search() { return false; } reset_search() {} select() {} write() {} read() { return 0; } skip() {} }
    class Dallas {
      constructor(ow) {
        this.pin = ow && ow.pin != null ? ow.pin : -1;
        this.inst = this.pin >= 0 ? b.findPart('ds18b20', 'DATA', this.pin) : null;
      }
      begin() { if (!this.inst) noPart(`DallasTemperature on GPIO${this.pin}`, 'ds18b20', 'DATA', this.pin); }
      getDeviceCount() { return this.inst ? 1 : 0; }
      getDS18Count() { return this.getDeviceCount(); }
      requestTemperatures() { return true; }
      requestTemperaturesByIndex() { return true; }
      getTempCByIndex(i) { return this.inst && Number(i || 0) === 0 ? Number(b.input(this.inst.uid, 'temp')) : -127; }
      getTempFByIndex(i) { const c = this.getTempCByIndex(i); return c === -127 ? -196.6 : c * 1.8 + 32; }
      getTempC() { return this.getTempCByIndex(0); }
      getTempF() { return this.getTempFByIndex(0); }
      getAddress(addr, i) { return !!this.inst && Number(i || 0) === 0; }
      setResolution() {} isConversionComplete() { return true; } setWaitForConversion() {} getResolution() { return 12; }
      toCelsius(f) { return (f - 32) / 1.8; } toFahrenheit(c) { return c * 1.8 + 32; }
    }

    class SensorsEvent {
      constructor() {
        this.acceleration = { x: 0, y: 0, z: 0, roll: 0, pitch: 0, heading: 0 };
        this.gyro = { x: 0, y: 0, z: 0 };
        this.magnetic = { x: 0, y: 0, z: 0 };
        this.orientation = { x: 0, y: 0, z: 0 };
        this.temperature = 0; this.timestamp = 0; this.relative_humidity = 0; this.pressure = 0;
      }
    }
    class Mpu {
      constructor() { this.inst = null; this.ok = false; this.lt = null; this.lrx = 0; this.lry = 0; }
      begin() {
        this.inst = b.claimNext('mpu6050');
        if (!this.inst) { rt.warnOnce('mpu.begin(): there is no Tilt & motion sensor (MPU-6050) on the canvas'); return false; }
        this.ok = b.i2cOk(this.inst);
        return this.ok;
      }
      initialize() { this.begin(); }
      testConnection() { return this.ok; }
      _read() {
        if (!this.ok) return { ax: 0, ay: 0, az: 0, gx: 0, gy: 0, gz: 0 };
        const rx = Number(b.input(this.inst.uid, 'tiltX')) * Math.PI / 180, ry = Number(b.input(this.inst.uid, 'tiltY')) * Math.PI / 180;
        const g = 9.81, t = now();
        let gx = 0, gy = 0;
        if (this.lt != null && t > this.lt) { const dt = (t - this.lt) / 1000; gx = (rx - this.lrx) / dt; gy = (ry - this.lry) / dt; }
        this.lt = t; this.lrx = rx; this.lry = ry;
        return { ax: g * Math.sin(ry), ay: g * Math.sin(rx) * Math.cos(ry), az: g * Math.cos(rx) * Math.cos(ry), gx, gy, gz: 0 };
      }
      getEvent(a, gy, t) {
        const r = this._read();
        if (a && a.acceleration) { a.acceleration.x = r.ax; a.acceleration.y = r.ay; a.acceleration.z = r.az; }
        if (gy && gy.gyro) { gy.gyro.x = r.gx; gy.gyro.y = r.gy; gy.gyro.z = r.gz; }
        if (t) t.temperature = 24.5;
        return true;
      }
      _raw(r) { const k = 16384 / 9.81, d = 131 * 180 / Math.PI; return [r.ax * k, r.ay * k, r.az * k, r.gx * d, r.gy * d, r.gz * d].map((v) => Math.max(-32768, Math.min(32767, Math.round(v)))); }
      getMotion6(...refs) { const v = this._raw(this._read()); refs.forEach((r, i) => { if (r && r.__ref) r.v = v[i]; }); }
      getAcceleration(...refs) { const v = this._raw(this._read()); refs.forEach((r, i) => { if (r && r.__ref) r.v = v[i]; }); }
      getRotation(...refs) { const v = this._raw(this._read()); refs.forEach((r, i) => { if (r && r.__ref) r.v = v[i + 3]; }); }
      getAccelerationX() { return this._raw(this._read())[0]; }
      getAccelerationY() { return this._raw(this._read())[1]; }
      getAccelerationZ() { return this._raw(this._read())[2]; }
      getRotationX() { return this._raw(this._read())[3]; }
      getRotationY() { return this._raw(this._read())[4]; }
      getRotationZ() { return this._raw(this._read())[5]; }
      getTemperature() { return 1500; }
      setAccelerometerRange() {} getAccelerometerRange() { return 0; } setGyroRange() {} getGyroRange() { return 0; } setFilterBandwidth() {} getFilterBandwidth() { return 0; }
      setMotionDetectionThreshold() {} setMotionDetectionDuration() {} setInterruptPinLatch() {} setInterruptPinPolarity() {} setMotionInterrupt() {} getMotionInterruptStatus() { return false; }
    }

    class Keypad {
      constructor(map, rows, cols, nr, nc) {
        this.map = Array.isArray(map) ? map.flat(Infinity) : [];
        this.nr = Number(nr) || 4; this.nc = Number(nc) || 4;
        this.inst = Array.isArray(rows) ? b.findPart('keypad', 'R1', rows[0]) : null;
        if (!this.inst && Array.isArray(rows)) noPart('Keypad', 'keypad', 'R1', rows[0]);
        this.listeners = []; this.lastKey = 0;
      }
      _model() { return this.inst ? b.models.get(this.inst.uid) : null; }
      getKey() {
        const m = this._model();
        if (!m || !m.queue.length) return 0;
        const idx = m.queue.shift();
        const r = Math.floor(idx / 4), c = idx % 4;
        if (r >= this.nr || c >= this.nc) return 0;
        const k = Number(this.map[r * this.nc + c]) || 0;
        this.lastKey = k;
        for (const fn of this.listeners) rt.callUser(fn, k);
        return k;
      }
      getChar() { return this.getKey(); }
      async waitForKey() { for (;;) { const k = this.getKey(); if (k) return k; await rt.sleep(10); } }
      getState() { const m = this._model(); return m && m.view().held.length ? 1 : 0; }
      isPressed(k) { const m = this._model(); if (!m) return false; return m.view().held.some((lab) => { const i = KEYPAD_LABELS.indexOf(lab); return Number(this.map[Math.floor(i / 4) * this.nc + (i % 4)]) === Number(k); }); }
      keyStateChanged() { return false; } setDebounceTime() {} setHoldTime() {} addEventListener(fn) { if (typeof fn === 'function') this.listeners.push(fn); }
      getKeys() { return false; } findInList() { return -1; }
    }

    const rev8 = (v) => { let r = 0; for (let i = 0; i < 8; i++) if (v & (1 << i)) r |= 0x80 >> i; return r; };
    class IrRecv {
      constructor(pin) {
        this.pin = pin == null ? -1 : Number(pin); this.inst = null;
        this.decodedIRData = { command: 0, address: 0, protocol: 0, decodedRawData: 0, flags: 0, numberOfBits: 0 };
        if (this.pin >= 0) this._bind();
      }
      _bind() { this.inst = b.findPart('irrecv', 'SIG', this.pin); if (!this.inst) noPart(`IR receiver on GPIO${this.pin}`, 'irrecv', 'SIG', this.pin); }
      begin(pin) { this.pin = Number(pin); this._bind(); }
      enableIRIn() { if (!this.inst && this.pin >= 0) this._bind(); }
      start() {} stop() {} end() {} enableIRInput() {}
      available() { const m = this.inst && b.models.get(this.inst.uid); return !!(m && m.queue.length); }
      decode(res) {
        const m = this.inst && b.models.get(this.inst.uid);
        if (!m || !m.queue.length) return false;
        const cmd = m.queue.shift() & 255;
        const raw = ((((~cmd) & 255) << 24) | (cmd << 16) | (0xff << 8)) >>> 0;
        Object.assign(this.decodedIRData, { command: cmd, address: 0, protocol: 8, decodedRawData: raw, flags: 0, numberOfBits: 32 });
        if (res && typeof res === 'object') { const r = rev8(cmd); res.value = (0x00ff0000 | (r << 8) | ((~r) & 255)) >>> 0; res.decode_type = 3; res.bits = 32; }
        return true;
      }
      resume() {}
      printIRResultShort(out) {
        const d = this.decodedIRData;
        (out && out.println ? out : rt.Serial).println(`Protocol=NEC Address=0x0 Command=0x${d.command.toString(16).toUpperCase()} Raw-Data=0x${d.decodedRawData.toString(16).toUpperCase()} 32 bits LSB first`);
      }
      printIRResultMinimal(out) { (out && out.println ? out : rt.Serial).println(`P=NEC A=0x0 C=0x${this.decodedIRData.command.toString(16).toUpperCase()}`); }
      printIRSendUsage() {}
    }
    class DecodeResults { constructor() { this.value = 0; this.decode_type = 0; this.bits = 0; this.address = 0; this.command = 0; } }

    class Rfid {
      constructor(ss, rst) {
        this.ss = ss == null ? -1 : Number(ss);
        this.inst = this.ss >= 0 ? b.findPart('rfid', 'SDA', this.ss) : b.claimNext('rfid');
        this.uid = { size: 0, uidByte: new Array(10).fill(0), sak: 0 };
        void rst;
      }
      _model() { return this.inst ? b.models.get(this.inst.uid) : null; }
      PCD_Init() { if (!this.inst) noPart(`MFRC522(${this.ss}, ...)`, 'rfid', 'SDA', this.ss); }
      PCD_DumpVersionToSerial() { rt.Serial.println(this.inst ? 'Firmware Version: 0x92 = v2.0' : 'Firmware Version: 0x0 = (unknown)'); }
      PCD_PerformSelfTest() { return !!this.inst; }
      PCD_SetAntennaGain() {} PCD_AntennaOn() {} PCD_AntennaOff() {} PCD_Reset() {}
      PICC_IsNewCardPresent() { const m = this._model(); if (m && m.pending) { m.current = m.pending; m.pending = null; return true; } return false; }
      PICC_ReadCardSerial() {
        const m = this._model();
        if (!m || !m.current) return false;
        this.uid.size = m.current.length;
        this.uid.uidByte = m.current.concat(new Array(Math.max(0, 10 - m.current.length)).fill(0));
        this.uid.sak = 0x08;
        m.current = null;
        return true;
      }
      PICC_HaltA() { return 0; } PCD_StopCrypto1() {}
      PICC_GetType() { return 4; }
      PICC_GetTypeName() { return 'MIFARE 1KB'; }
      PICC_DumpToSerial(u) { u = u || this.uid; rt.Serial.println('Card UID: ' + u.uidByte.slice(0, u.size).map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ')); }
      PCD_Authenticate() { return 0; } MIFARE_Read() { return 0; } MIFARE_Write() { return 0; }
      GetStatusCodeName() { return 'Success.'; }
    }

    // ----------------------------------------------------------- storage
    class File extends Print {
      constructor(path, mode) { super(); this.path = path; this.mode = mode; this.pos = 0; }
      _data() { return PERSIST.files.get(this.path) || ''; }
      _out(s) { if (this.mode !== 'r') PERSIST.files.set(this.path, this._data() + s); }
      available() { return Math.max(0, this._data().length - this.pos); }
      read() { const d = this._data(); return this.pos < d.length ? d.charCodeAt(this.pos++) : -1; }
      peek() { const d = this._data(); return this.pos < d.length ? d.charCodeAt(this.pos) : -1; }
      readString() { const d = this._data().slice(this.pos); this.pos += d.length; return d; }
      readStringUntil(t) { const d = this._data(), ch = chrs(t), i = d.indexOf(ch, this.pos); const s = d.slice(this.pos, i < 0 ? d.length : i); this.pos = i < 0 ? d.length : i + 1; return s; }
      close() {}
      size() { return this._data().length; }
      name() { return this.path.split('/').pop(); }
      path_() { return this.path; }
      position() { return this.pos; }
      seek(p) { this.pos = Number(p) || 0; return true; }
      isDirectory() { return false; }
      openNextFile() { return 0; }
      flush() {}
      toString() { return '1'; }
    }
    class Fs {
      constructor(needsPart) { this.needsPart = needsPart; }
      begin(cs) {
        if (!this.needsPart) return true;
        const pin = cs == null ? 5 : Number(cs);
        if (!b.findPart('sdcard', 'CS', pin)) { noPart(`SD.begin(${pin})`, 'sdcard', 'CS', pin); return false; }
        return true;
      }
      open(path, mode) {
        path = toS(path); mode = mode || 'r';
        if (mode === 'r' && !PERSIST.files.has(path)) return 0;
        if (mode === 'w') PERSIST.files.set(path, '');
        if (mode === 'a' && !PERSIST.files.has(path)) PERSIST.files.set(path, '');
        return wrapObj(new File(path, mode));
      }
      exists(p) { return PERSIST.files.has(toS(p)); }
      remove(p) { return PERSIST.files.delete(toS(p)); }
      rename(a, c) { const d = PERSIST.files.get(toS(a)); if (d == null) return false; PERSIST.files.delete(toS(a)); PERSIST.files.set(toS(c), d); return true; }
      mkdir() { return true; } rmdir() { return true; } end() {} format() { PERSIST.files.clear(); return true; }
      cardType() { return 3; } cardSize() { return 7948206080; } totalBytes() { return 7944011776; } usedBytes() { let n = 0; for (const v of PERSIST.files.values()) n += v.length; return n; }
    }

    class DateTime {
      constructor(a, mo, d, h, mi, s) {
        if (a && typeof a === 'object' && a.t != null) { this.t = a.t; return; }
        if (typeof a === 'string') {
          const iso = /^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d):(\d\d))?/.exec(a);
          if (iso) { this.t = Date.UTC(+iso[1], +iso[2] - 1, +iso[3], +(iso[4] || 0), +(iso[5] || 0), +(iso[6] || 0)) / 1000; return; }
          const dm = /^(\w{3})\s+(\d+)\s+(\d{4})/.exec(a), tm = /(\d\d):(\d\d):(\d\d)/.exec(toS(mo));
          this.t = Date.UTC(dm ? +dm[3] : 2000, dm ? Math.max(0, MONTHS.indexOf(dm[1])) : 0, dm ? +dm[2] : 1, tm ? +tm[1] : 0, tm ? +tm[2] : 0, tm ? +tm[3] : 0) / 1000;
          return;
        }
        if (mo === undefined) { this.t = Number(a) || 0; return; }
        const y = Number(a) < 100 ? Number(a) + 2000 : Number(a);
        this.t = Date.UTC(y, Number(mo) - 1, Number(d) || 1, Number(h) || 0, Number(mi) || 0, Number(s) || 0) / 1000;
      }
      _d() { return new Date(this.t * 1000); }
      year() { return this._d().getUTCFullYear(); }
      month() { return this._d().getUTCMonth() + 1; }
      day() { return this._d().getUTCDate(); }
      hour() { return this._d().getUTCHours(); }
      twelveHour() { const h = this.hour() % 12; return h || 12; }
      isPM() { return this.hour() >= 12; }
      minute() { return this._d().getUTCMinutes(); }
      second() { return this._d().getUTCSeconds(); }
      dayOfTheWeek() { return this._d().getUTCDay(); }
      unixtime() { return Math.floor(this.t); }
      secondstime() { return Math.floor(this.t) - 946684800; }
      isValid() { return true; }
      timestamp() { return this._d().toISOString().slice(0, 19); }
      toString(fmt) {
        const p2 = (x) => String(x).padStart(2, '0');
        return toS(fmt || 'YYYY-MM-DD hh:mm:ss').replace('YYYY', this.year()).replace('YY', p2(this.year() % 100)).replace('MM', p2(this.month()))
          .replace('DD', p2(this.day())).replace('hh', p2(this.hour())).replace('mm', p2(this.minute())).replace('ss', p2(this.second()));
      }
    }
    class Rtc {
      constructor() { this.inst = null; this.ok = true; this.off = 0; }
      begin() {
        this.inst = b.claimNext('rtc');
        if (!this.inst) { rt.warnOnce('rtc.begin(): there is no Clock module (DS3231) on the canvas'); this.ok = false; return false; }
        this.ok = b.i2cOk(this.inst);
        return this.ok;
      }
      _secs() { return rt.startUnix + Math.floor(now() / 1000) + this.off; }
      now() { return wrapObj(new DateTime(this.ok ? this._secs() : 946684800)); }
      adjust(dt) { if (dt && dt.t != null) this.off = dt.t - (rt.startUnix + Math.floor(now() / 1000)); }
      lostPower() { return false; } isrunning() { return true; } getTemperature() { return 24.25; }
      initialized() { return true; } start() {}
    }
    class RtcMillis extends Rtc { begin() { this.ok = true; return true; } }

    class Hx711 {
      constructor() { this.inst = null; this.scale = 1; this.offset = 0; }
      begin(dt) { this.inst = b.findPart('loadcell', 'DT', Number(dt)); if (!this.inst) noPart(`scale.begin(${dt}, ...)`, 'loadcell', 'DT', dt); }
      _raw() { const g = this.inst ? Number(b.input(this.inst.uid, 'weight')) : 0; return Math.round(84000 + g * 420); }
      is_ready() { return !!this.inst; }
      wait_ready() {} wait_ready_retry() { return !!this.inst; } wait_ready_timeout() { return !!this.inst; }
      read() { return this._raw(); }
      read_average() { return this._raw(); }
      get_value() { return this._raw() - this.offset; }
      get_units() { return (this._raw() - this.offset) / this.scale; }
      set_scale(s) { this.scale = Number(s) || 1; }
      get_scale() { return this.scale; }
      tare() { this.offset = this._raw(); }
      set_offset(o) { this.offset = Number(o) || 0; }
      get_offset() { return this.offset; }
      power_down() {} power_up() {} set_gain() {}
    }

    class Gps {
      constructor() {
        this.inst = b.claimNext('gps');
        const self = this;
        const valid = () => !!self.inst;
        const sec = () => Math.floor(now() / 1000);
        const upd = (key) => () => { if (!valid()) return false; const s = sec(); if (self[key] === s) return false; self[key] = s; return true; };
        const dt = () => new Date((rt.startUnix + sec()) * 1000);
        this.location = { isValid: valid, isUpdated: upd('_l'), lat: () => (valid() ? 28.6024 : 0), lng: () => (valid() ? -81.2001 : 0), age: () => (valid() ? 120 : 4294967295) };
        this.date = { isValid: valid, isUpdated: upd('_d'), year: () => dt().getUTCFullYear(), month: () => dt().getUTCMonth() + 1, day: () => dt().getUTCDate(), value: () => 0, age: () => 120 };
        this.time = { isValid: valid, isUpdated: upd('_t'), hour: () => dt().getUTCHours(), minute: () => dt().getUTCMinutes(), second: () => dt().getUTCSeconds(), centisecond: () => 0, value: () => 0, age: () => 120 };
        this.speed = { isValid: valid, isUpdated: upd('_s'), kmph: () => 0, mph: () => 0, mps: () => 0, knots: () => 0, value: () => 0 };
        this.altitude = { isValid: valid, isUpdated: upd('_a'), meters: () => 27.4, feet: () => 89.9, kilometers: () => 0.0274, value: () => 2740 };
        this.satellites = { isValid: valid, isUpdated: upd('_n'), value: () => (valid() ? 8 : 0) };
        this.hdop = { isValid: valid, isUpdated: upd('_h'), value: () => 120, hdop: () => 1.2 };
        this.course = { isValid: valid, isUpdated: upd('_c'), deg: () => 0, value: () => 0 };
      }
      encode() { return false; }
      charsProcessed() { return this.inst ? Math.floor(now() / 2) : 0; }
      sentencesWithFix() { return this.inst ? Math.floor(now() / 1000) : 0; }
      failedChecksum() { return 0; }
      passedChecksum() { return this.sentencesWithFix(); }
      distanceBetween(la1, lo1, la2, lo2) {
        const r = Math.PI / 180, dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
        const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
        return 6372795 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      }
      courseTo() { return 0; }
    }

    class DfPlayer {
      constructor() { this.inst = null; this.vol = 15; this.track = 0; this.playing = false; this.startAt = 0; this.fin = false; }
      begin() {
        this.inst = b.claimNext('dfplayer');
        if (!this.inst) { rt.warnOnce('mp3.begin(): there is no MP3 player on the canvas'); return false; }
        b.devices.set(this.inst.uid, this);
        return true;
      }
      volume(v) { this.vol = Math.max(0, Math.min(30, Number(v) | 0)); rt.dirty = true; }
      volumeUp() { this.volume(this.vol + 1); } volumeDown() { this.volume(this.vol - 1); } readVolume() { return this.vol; }
      play(n) { this.track = n == null ? 1 : Number(n) | 0; this.playing = true; this.startAt = now(); this.fin = false; rt.dirty = true; }
      next() { this.play(this.track + 1); } previous() { this.play(Math.max(1, this.track - 1)); }
      pause() { this.playing = false; rt.dirty = true; } start() { this.playing = true; rt.dirty = true; } stop() { this.playing = false; rt.dirty = true; }
      loop(n) { this.play(n); } playMp3Folder(n) { this.play(n); } playFolder(f, n) { this.play(n); } playLargeFolder(f, n) { this.play(n); }
      randomAll() { this.play(1 + Math.floor(Math.random() * 10)); } advertise() {}
      enableLoop() {} disableLoop() {} enableLoopAll() {} disableLoopAll() {} EQ() {} outputDevice() {} reset() {} sleep() {} setTimeOut() {} enableDAC() {} disableDAC() {}
      readState() { return this.playing ? 1 : 0; } readFileCounts() { return 10; } readCurrentFileNumber() { return this.track; }
      available() { if (this.playing && now() - this.startAt > 30000) { this.playing = false; this.fin = true; rt.dirty = true; } return this.fin; }
      readType() { this.fin = false; return 5; }
      read() { return this.track; }
      view() { return { playing: this.playing, track: this.track, volume: this.vol }; }
    }

    class Stepper {
      constructor(steps, p1, p2, p3, p4) {
        this.steps = Math.abs(Number(steps) | 0) || 2048; this.rpm = 10; this.pos = 0;
        const pins = [p1, p2, p3, p4].filter((x) => x != null).map(Number);
        this.inst = null;
        for (const p of pins) { for (const n of ['IN1', 'IN2', 'IN3', 'IN4']) { const f = b.findPart('stepper', n, p); if (f) { this.inst = f; break; } } if (this.inst) break; }
        if (this.inst) b.devices.set(this.inst.uid, this);
        else noPart('Stepper', 'stepper', 'IN1', p1);
      }
      get angle() { return (this.pos / this.steps) * 360; }
      setSpeed(rpm) { this.rpm = Math.max(0.01, Number(rpm) || 0.01); }
      async step(n) {
        n = Number(n) | 0;
        const ms = 60000 / (this.steps * this.rpm);
        let left = Math.abs(n);
        const dir = Math.sign(n);
        while (left > 0) {
          const chunk = Math.min(left, Math.max(1, Math.ceil(20 / ms)));
          this.pos += dir * chunk; left -= chunk; rt.dirty = true;
          await rt.sleep(chunk * ms);
        }
      }
      version() { return 5; }
    }

    class Pulse {
      constructor() { this.inst = null; this.ok = false; }
      begin() {
        this.inst = b.claimNext('heartrate');
        if (!this.inst) { rt.warnOnce('particleSensor.begin(): there is no Heart-rate sensor on the canvas'); return false; }
        this.ok = b.i2cOk(this.inst);
        return this.ok;
      }
      setup() {} setPulseAmplitudeRed() {} setPulseAmplitudeGreen() {} setPulseAmplitudeIR() {} shutDown() {} wakeUp() {} enableDIETEMPRDY() {}
      _finger() { return this.ok && !!b.input(this.inst.uid, 'finger'); }
      getIR() {
        if (!this._finger()) return 800 + Math.floor(Math.random() * 200);
        const bpm = Number(b.input(this.inst.uid, 'bpm')) || 72;
        const ph = ((now() * bpm) / 60000) % 1;
        return Math.round(52000 + 1500 * Math.exp(-((ph - 0.1) ** 2) / 0.003));
      }
      getRed() { return Math.round(this.getIR() * 0.9); }
      getGreen() { return Math.round(this.getIR() * 0.3); }
      available() { return 1; } check() { return 1; } nextSample() {} getFIFOIR() { return this.getIR(); } getFIFORed() { return this.getRed(); }
      readTemperature() { return 31.5; } readTemperatureF() { return 88.7; }
    }

    class IPAddress {
      constructor(a, b2, c, d) { this.p = [a, b2, c, d].map((x) => Number(x) & 255); }
      toString() { return this.p.join('.'); }
    }
    class WiFiClass {
      constructor() { this.st = 6; this.at = 0; this.ssid = ''; }
      begin(ssid) { this.ssid = toS(ssid); this.at = now() + 1500; this.st = 6; rt.warnOnce('Wi-Fi is pretend in the simulator: it "connects" after a moment, but nothing really goes on the internet'); return this.status(); }
      status() { if (this.at && now() >= this.at) this.st = 3; return this.st; }
      isConnected() { return this.status() === 3; }
      localIP() { return wrapObj(new IPAddress(192, 168, 1, 42)); }
      softAPIP() { return wrapObj(new IPAddress(192, 168, 4, 1)); }
      gatewayIP() { return wrapObj(new IPAddress(192, 168, 1, 1)); }
      macAddress() { return '24:6F:28:A1:B2:C3'; }
      RSSI() { return -55; }
      SSID() { return this.ssid; }
      mode() { return true; } getMode() { return 1; }
      disconnect() { this.st = 6; this.at = 0; return true; }
      softAP(ssid) { this.ssid = toS(ssid); rt.warnOnce('Wi-Fi is pretend in the simulator: nothing can connect to this access point'); return true; }
      setHostname() { return true; } config() { return true; } reconnect() { return true; } setAutoReconnect() {} setSleep() {} persistent() {}
      scanNetworks() { return 0; } hostByName() { return 1; }
    }

    class Prefs {
      constructor() {
        this.ns = '';
        for (const t of ['Char', 'UChar', 'Short', 'UShort', 'Int', 'UInt', 'Long', 'ULong', 'Long64', 'ULong64', 'Float', 'Double', 'Bool', 'String']) {
          this['put' + t] = (k, v) => { PERSIST.prefs.set(this.ns + '/' + toS(k), v); return 1; };
          this['get' + t] = (k, d) => { const key = this.ns + '/' + toS(k); return PERSIST.prefs.has(key) ? PERSIST.prefs.get(key) : (d === undefined ? (t === 'String' ? '' : t === 'Bool' ? false : 0) : d); };
        }
      }
      begin(ns) { this.ns = toS(ns); return true; }
      end() {}
      clear() { for (const k of Array.from(PERSIST.prefs.keys())) if (k.startsWith(this.ns + '/')) PERSIST.prefs.delete(k); return true; }
      remove(k) { return PERSIST.prefs.delete(this.ns + '/' + toS(k)); }
      isKey(k) { return PERSIST.prefs.has(this.ns + '/' + toS(k)); }
      freeEntries() { return 400; }
    }
    class Eeprom {
      begin() { return true; }
      read(a) { const v = PERSIST.eeprom.get('b' + a); return v == null ? 255 : v; }
      write(a, v) { PERSIST.eeprom.set('b' + a, Number(v) & 255); }
      update(a, v) { this.write(a, v); }
      commit() { return true; } end() {}
      put(a, v) { PERSIST.eeprom.set('v' + a, deepCopy(v)); return v; }
      get(a, cur) { return PERSIST.eeprom.has('v' + a) ? deepCopy(PERSIST.eeprom.get('v' + a)) : cur; }
      length() { return 512; }
    }

    class Ticker {
      constructor() { this.timer = null; }
      _set(ms, fn, arg, repeat) {
        this.detach();
        if (typeof fn !== 'function') return;
        const t = { at: now() + ms, every: repeat ? ms : 0, fn: () => rt.callUser(fn, arg) };
        this.timer = t;
        rt.board.timers.push(t);
      }
      attach(s, fn, arg) { this._set(Number(s) * 1000, fn, arg, true); }
      attach_ms(ms, fn, arg) { this._set(Number(ms), fn, arg, true); }
      once(s, fn, arg) { this._set(Number(s) * 1000, fn, arg, false); }
      once_ms(ms, fn, arg) { this._set(Number(ms), fn, arg, false); }
      detach() { if (this.timer) { rt.board.timers = rt.board.timers.filter((t) => t !== this.timer); this.timer = null; } }
      active() { return !!this.timer; }
    }

    return {
      Servo, DHT, DHTesp, Adafruit_SSD1306: Oled, Adafruit_SH1106G: Oled, Adafruit_SH1106: Oled, Adafruit_SH1107: Oled,
      LiquidCrystal_I2C: Lcd, LiquidCrystal: LcdParallel, TM1637Display: TM1637, Adafruit_NeoPixel: NeoPixel, MD_MAX72XX: Matrix,
      LedControl, NewPing, Adafruit_VL53L0X: Vl53, VL53L0X: Vl53, VL53L0X_RangingMeasurementData_t: RangingData, Adafruit_BME280: Bme280,
      Adafruit_BMP280: Bmp280, OneWire, DallasTemperature: Dallas, Adafruit_MPU6050: Mpu, MPU6050: Mpu, sensors_event_t: SensorsEvent,
      Keypad, IRrecv: IrRecv, decode_results: DecodeResults, MFRC522: Rfid, File, RTC_DS3231: Rtc, RTC_DS1307: Rtc, RTC_PCF8523: Rtc,
      RTC_Millis: RtcMillis, DateTime, HX711: Hx711, TinyGPSPlus: Gps, DFRobotDFPlayerMini: DfPlayer, Stepper, MAX30105: Pulse,
      HardwareSerial: HwSerial, SoftwareSerial: HwSerial, BluetoothSerial: Bluetooth, Preferences: Prefs, IPAddress, Ticker, TwoWire,
      _HwSerial: HwSerial, _IrRecv: IrRecv, _Fs: Fs, _WiFi: WiFiClass, _Eeprom: Eeprom, _hsv: hsv,
    };
  }

  // Quiet stand-ins: classes that exist only to be passed around.
  const QUIET_CLASSES = new Set(['DeviceAddress', 'TimeSpan', 'Adafruit_GFX', 'SPIClass', 'ESP32PWM', 'MFRC522::MIFARE_Key', 'MFRC522::StatusCode', 'MFRC522::PICC_Type']);
  const WEB_CLASSES = new Set(['WebServer', 'WiFiServer', 'WiFiClient', 'HTTPClient', 'AsyncWebServer', 'WiFiUDP', 'NTPClient', 'WiFiClientSecure', 'PubSubClient', 'BLEServer', 'BLEDevice']);

  // ===================================================================
  // The `$` object generated code talks to
  // ===================================================================

  const SCOPED = {
    'MD_MAX72XX::GENERIC_HW': 0, 'MD_MAX72XX::FC16_HW': 1, 'MD_MAX72XX::PAROLA_HW': 2, 'MD_MAX72XX::ICSTATION_HW': 3,
    'MD_MAX72XX::INTENSITY': 1, 'MD_MAX72XX::UPDATE': 3, 'MD_MAX72XX::ON': 1, 'MD_MAX72XX::OFF': 0, 'MD_MAX72XX::SHUTDOWN': 0,
    'MD_MAX72XX::SCANLIMIT': 2, 'MD_MAX72XX::TEST': 4, 'MD_MAX72XX::WRAPAROUND': 5, 'MD_MAX72XX::DECODE': 1,
    'DHTesp::DHT11': 1, 'DHTesp::DHT22': 2, 'DHTesp::AM2302': 3, 'DHTesp::AUTO_DETECT': 0, 'DHTesp::RHT03': 4,
    'MFRC522::STATUS_OK': 0, 'MFRC522::STATUS_ERROR': 1, 'MFRC522::PICC_CMD_MF_AUTH_KEY_A': 0x60, 'MFRC522::PICC_CMD_MF_AUTH_KEY_B': 0x61,
    'MFRC522::PICC_TYPE_MIFARE_1K': 4, 'MFRC522::PICC_TYPE_MIFARE_MINI': 3, 'MFRC522::PICC_TYPE_MIFARE_4K': 5,
    'decode_type_t::NEC': 8, 'decode_type_t::UNKNOWN': 0,
  };

  function makeApi(rt) {
    const b = rt.board, clock = rt.clock;
    const libs = makeLibs(rt);
    rt.libs = libs;
    let rand = Math.random;
    let awRes = 8, arRes = 12;
    let lastBeat = -1e9;
    const $ = {
      n: 0,
      lineOf: () => 0,
      trunc: Math.trunc,
      idiv(a, c) { a = +a; c = +c; if (c === 0) throw rtErr('dividing by zero. A real ESP32 would crash and restart here'); return Math.trunc(a / c); },
      imod(a, c) { a = +a; c = +c; if (c === 0) throw rtErr('% by zero. A real ESP32 would crash and restart here'); return a % c; },
      at(a, i) {
        if (Array.isArray(a)) {
          if (!(i >= 0 && i < a.length)) throw rtErr(`array index ${i} is outside the array (it has ${a.length} item${a.length === 1 ? '' : 's'}, numbered 0 to ${a.length - 1})`);
          return a[i];
        }
        if (a == null) throw rtErr('used [ ] on something that doesn\'t exist');
        if (typeof a === 'string') return S.at(a, i);
        return a[i];
      },
      arr: makeArr,
      copy: deepCopy,
      count: countLeaves,
      sizeof(x, eb) { if (Array.isArray(x)) return countLeaves(x) * eb; if (typeof x === 'string') return x.length + 1; return eb; },
      ref(get, set) { return { __ref: true, get v() { return get(); }, set v(x) { set(x); }, toString() { return toS(get()); } }; },
      box(v) { return { __ref: true, v }; },
      iter(x) { if (typeof x === 'string') return Array.from(x).map((c) => c.charCodeAt(0)); if (Array.isArray(x)) return x; return []; },
      S,
      toS,
      String: (v, a, hint) => (typeof v === 'string' ? v : toS(v, hint, a)),
      sprintf: (lim, fmt, ...args) => { const s = cfmt(fmt, args); return lim != null ? s.slice(0, Math.max(0, Number(lim) - 1)) : s; },
      dtostrf(v, w, p) { const s = fixed(v, p); w = Number(w) || 0; return w < 0 ? s.padEnd(-w) : s.padStart(w); },
      itoa(v, base) { v = Math.trunc(Number(v) || 0); base = Number(base) || 10; return (base === 10 ? v : (v >>> 0)).toString(base); },
      memset(a, v) { const fill = (x) => { for (let i = 0; i < x.length; i++) { if (Array.isArray(x[i])) fill(x[i]); else if (typeof x[i] === 'number' || typeof x[i] === 'boolean') x[i] = typeof x[i] === 'boolean' ? !!v : Number(v) & 255; } }; if (Array.isArray(a)) fill(a); },
      memcpy(d, s) { if (Array.isArray(d) && Array.isArray(s)) for (let i = 0; i < Math.min(d.length, s.length); i++) d[i] = deepCopy(s[i]); },
      k: () => 0,
      sc(path) {
        if (Object.prototype.hasOwnProperty.call(SCOPED, path)) return SCOPED[path];
        const [cls, name] = path.split('::');
        if (cls === 'Adafruit_NeoPixel' && /^(Color|ColorHSV|gamma32|gamma8|sine8)$/.test(name)) { const np = new libs.Adafruit_NeoPixel(0, -1); return np[name].bind(np); }
        if (cls === 'NewPing' && name === 'convert_cm') return (us) => Math.round(us / 57);
        if (cls === 'NewPing' && name === 'convert_in') return (us) => Math.round(us / 146);
        if (cls === 'TinyGPSPlus' && name === 'distanceBetween') return libs.TinyGPSPlus.prototype.distanceBetween;
        return cham();
      },
      m(recv, name, args) {
        if (typeof recv === 'string') { if (S[name]) return S[name](recv, ...args); throw rtErr(`Strings don't have a ${name}() function`); }
        if (recv == null) throw rtErr(`can't call ${name}() on something that doesn't exist`);
        if (typeof recv[name] === 'function') return recv[name](...args);
        return cham();
      },
      unk: () => () => cham(),
      new(cls, args) {
        const C = libs[cls];
        if (C && !cls.startsWith('_')) return wrapObj(new C(...(args || [])));
        if (WEB_CLASSES.has(cls)) rt.warnOnce(`${cls} is pretend in the simulator: nothing really goes over the network`);
        else if (!QUIET_CLASSES.has(cls) && !cls.includes('::')) rt.warnOnce(`The ${cls} library isn't simulated, so its functions do nothing here`);
        return cham();
      },

      // ------------------------------------------------ objects
      Serial: wrapObj(new libs._HwSerial(true)),
      Serial0: wrapObj(new libs._HwSerial(false)),
      Serial1: wrapObj(new libs._HwSerial(false)),
      Serial2: wrapObj(new libs._HwSerial(false)),
      Wire: wrapObj(new libs.TwoWire()),
      Wire1: wrapObj(new libs.TwoWire()),
      SPI: cham(),
      SD: wrapObj(new libs._Fs(true)),
      SPIFFS: wrapObj(new libs._Fs(false)),
      LittleFS: wrapObj(new libs._Fs(false)),
      WiFi: wrapObj(new libs._WiFi()),
      IrReceiver: wrapObj(new libs._IrRecv()),
      IrSender: cham(),
      EEPROM: wrapObj(new libs._Eeprom()),
      BLEDevice: cham(), MDNS: cham(), ArduinoOTA: cham(), Update: cham(),
      ESP: wrapObj({
        restart() { throw { simHalt: 'ESP.restart() was called, so the board restarted. Press Run to start again.' }; },
        deepSleep() { throw { simHalt: 'The ESP32 went into deep sleep. Press Run to start again.' }; },
        getFreeHeap: () => 251480, getHeapSize: () => 327680, getMinFreeHeap: () => 240000, getMaxAllocHeap: () => 110580, getChipModel: () => 'ESP32-D0WD-V3',
        getChipRevision: () => 3, getChipCores: () => 2, getCpuFreqMHz: () => 240, getEfuseMac: () => 0x28a16fb2c324, getSketchSize: () => 284512,
        getFreeSketchSpace: () => 1310720, getFlashChipSize: () => 4194304, getSdkVersion: () => 'v5.1', getCycleCount: () => Math.floor(clock.now() * 240000) >>> 0,
      }),

      // ------------------------------------------------ time
      millis() { if (clock.fast) clock.virt += 0.002; return Math.floor(clock.now()) >>> 0; },
      micros() { if (clock.fast) clock.virt += 0.002; return Math.floor(clock.now() * 1000) >>> 0; },
      esp_timer_get_time() { return Math.floor(clock.now() * 1000); },
      delay(ms) { return rt.sleep(Number(ms) || 0); },
      vTaskDelay(t) { return rt.sleep(Number(t) || 0); },
      pdMS_TO_TICKS: (ms) => ms,
      delayMicroseconds(us) { us = Number(us) || 0; if (us >= 2000) return rt.sleep(us / 1000); clock.bump(us / 1000); return undefined; },
      yield() { return rt.sleep(0); },

      // ------------------------------------------------ GPIO
      pinMode: (g, m) => b.pinMode(Number(g), m),
      digitalWrite: (g, v) => b.digitalWrite(Number(g), v),
      digitalRead: (g) => b.digitalRead(Number(g)),
      analogRead(g) { const v = b.analogRead(Number(g)); return arRes >= 12 ? v << (arRes - 12) : v >> (12 - arRes); },
      analogReadMilliVolts(g) { return Math.round((b.analogRead(Number(g)) * 3300) / 4095); },
      analogReadResolution(bits) { arRes = Math.max(1, Math.min(16, Number(bits) || 12)); },
      analogWrite(g, v) {
        g = Number(g);
        if (!b.checkPin(g, 'analogWrite')) return;
        const p = b.pin(g);
        const res = p.awRes || awRes;
        b.pwm(g, (Number(v) || 0) / ((1 << res) - 1));
      },
      analogWriteResolution(a, c) { if (c === undefined) awRes = Number(a) || 8; else b.pin(Number(a)).awRes = Number(c) || 8; },
      analogWriteFrequency() {},
      analogSetAttenuation() {}, analogSetPinAttenuation() {}, analogSetWidth() {},
      ledcSetup(ch, freq, res) { rt.oldLedc = true; b.ledcCh.set(Number(ch), { res: Number(res) || 8, pins: [] }); return freq; },
      ledcAttachPin(pin, ch) {
        let c = b.ledcCh.get(Number(ch));
        if (!c) { c = { res: 8, pins: [] }; b.ledcCh.set(Number(ch), c); }
        c.pins.push(Number(pin));
        const p = b.pin(Number(pin)); p.res = c.res; b.pwm(Number(pin), 0);
      },
      ledcAttach(pin, freq, res) { const p = b.pin(Number(pin)); p.res = Number(res) || 8; b.pwm(Number(pin), 0); return true; },
      ledcAttachChannel(pin, freq, res, ch) { b.ledcCh.set(Number(ch), { res: Number(res) || 8, pins: [Number(pin)] }); return $.ledcAttach(pin, freq, res); },
      _ledcPins(x) {
        x = Number(x);
        if (rt.oldLedc && b.ledcCh.has(x)) return b.ledcCh.get(x).pins;
        return [x];
      },
      ledcWrite(x, duty) { for (const g of $._ledcPins(x)) { const p = b.pin(g); b.pwm(g, (Number(duty) || 0) / ((1 << (p.res || 8)) - 1)); } return true; },
      ledcWriteTone(x, f) { for (const g of $._ledcPins(x)) b.tone(g, f); return f; },
      ledcWriteNote(x, note, oct) {
        const N = { C: 0, Cs: 1, D: 2, Eb: 3, E: 4, F: 5, Fs: 6, G: 7, Gs: 8, A: 9, Bb: 10, B: 11 };
        const idx = typeof note === 'number' ? note : (N[note] || 0);
        const f = 440 * Math.pow(2, (idx - 9) / 12 + (Number(oct) - 4));
        return $.ledcWriteTone(x, f);
      },
      ledcRead(x) { const p = b.pins.get($._ledcPins(x)[0]); return p && p.duty != null ? Math.round(p.duty * ((1 << (p.res || 8)) - 1)) : 0; },
      ledcReadFreq() { return 5000; },
      ledcChangeFrequency(x, f) { return f; },
      ledcDetachPin(g) { const p = b.pin(Number(g)); p.duty = null; p.tone = 0; b.update(p); },
      ledcDetach(g) { $.ledcDetachPin(g); return true; },
      ledcFade() { return true; },
      dacWrite(g, v) { b.pwm(Number(g), (Number(v) & 255) / 255); },
      tone: (g, f, d) => b.tone(Number(g), f, d),
      noTone: (g) => b.tone(Number(g), 0),
      pulseIn: (g, s, t) => rt.pulseIn(Number(g), s, t),
      pulseInLong: (g, s, t) => rt.pulseIn(Number(g), s, t),
      shiftOut() {},
      shiftIn() { return 0; },
      attachInterrupt: (g, fn, mode) => b.attachInterrupt(g, fn, mode),
      detachInterrupt: (g) => b.detachInterrupt(g),
      digitalPinToInterrupt: (g) => g,
      interrupts() {}, noInterrupts() {}, sei() {}, cli() {},
      touchRead: () => 70,
      touchAttachInterrupt() {},
      hallRead: () => 0,
      temperatureRead: () => 45.5,

      // ------------------------------------------------ math
      map(x, a, c, d, e) {
        x = Math.trunc(+x); a = Math.trunc(+a); c = Math.trunc(+c); d = Math.trunc(+d); e = Math.trunc(+e);
        if (c === a) return -1;
        return Math.trunc(((x - a) * (e - d)) / (c - a)) + d;
      },
      constrain: (x, a, c) => (+x < +a ? +a : +x > +c ? +c : +x),
      min: (a, c) => Math.min(+a, +c),
      max: (a, c) => Math.max(+a, +c),
      abs: (x) => Math.abs(+x),
      sq: (x) => (+x) * (+x),
      sqrt: Math.sqrt, pow: Math.pow, sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
      atan2: Math.atan2, exp: Math.exp, log: Math.log, log10: Math.log10, log2: Math.log2, floor: Math.floor, ceil: Math.ceil,
      round: (x) => Math.sign(x) * Math.round(Math.abs(x)), lround: (x) => Math.sign(x) * Math.round(Math.abs(x)), trunc: Math.trunc,
      fabs: Math.abs, fmod: (a, c) => a % c, fmin: Math.min, fmax: Math.max, cbrt: Math.cbrt, hypot: Math.hypot,
      fabsf: Math.abs, sqrtf: Math.sqrt, powf: Math.pow, floorf: Math.floor, ceilf: Math.ceil, roundf: (x) => Math.sign(x) * Math.round(Math.abs(x)),
      radians: (d) => (d * Math.PI) / 180, degrees: (r) => (r * 180) / Math.PI,
      isnan: (x) => isNaN(x), isinf: (x) => x === Infinity || x === -Infinity,
      random(a, c) {
        if (c === undefined) { a = Math.trunc(+a); return a <= 0 ? 0 : Math.floor(rand() * a); }
        a = Math.trunc(+a); c = Math.trunc(+c);
        return a >= c ? a : a + Math.floor(rand() * (c - a));
      },
      randomSeed(s) { rand = prng(Number(s) || 0); },
      esp_random: () => Math.floor(rand() * 4294967296) >>> 0,
      rand: () => Math.floor(rand() * 2147483647),
      srand(s) { rand = prng(Number(s) || 0); },
      bitRead: (v, n) => (Number(v) >>> Number(n)) & 1,
      bit: (n) => (2 ** Number(n)) >>> 0,
      lowByte: (v) => Number(v) & 255,
      highByte: (v) => (Number(v) >> 8) & 255,
      word: (h, l) => (l === undefined ? Number(h) & 0xffff : ((Number(h) & 255) << 8) | (Number(l) & 255)),

      // ------------------------------------------------ characters and C strings
      isDigit: (c) => c >= 48 && c <= 57,
      isAlpha: (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122),
      isAlphaNumeric: (c) => $.isDigit(c) || $.isAlpha(c),
      isSpace: (c) => c === 32 || (c >= 9 && c <= 13),
      isWhitespace: (c) => c === 32 || c === 9,
      isUpperCase: (c) => c >= 65 && c <= 90,
      isLowerCase: (c) => c >= 97 && c <= 122,
      isPunct: (c) => c > 32 && c < 127 && !$.isAlphaNumeric(c),
      isPrintable: (c) => c >= 32 && c < 127,
      isGraph: (c) => c > 32 && c < 127,
      isControl: (c) => c < 32 || c === 127,
      isAscii: (c) => c >= 0 && c < 128,
      isHexadecimalDigit: (c) => $.isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102),
      isdigit: (c) => $.isDigit(c), isalpha: (c) => $.isAlpha(c), isspace: (c) => $.isSpace(c), isupper: (c) => $.isUpperCase(c), islower: (c) => $.isLowerCase(c), isalnum: (c) => $.isAlphaNumeric(c),
      toupper: (c) => ($.isLowerCase(c) ? c - 32 : c),
      tolower: (c) => ($.isUpperCase(c) ? c + 32 : c),
      toUpperCase: (c) => $.toupper(c),
      toLowerCase: (c) => $.tolower(c),
      atoi: (s) => S.toInt(toS(s)), atol: (s) => S.toInt(toS(s)), atof: (s) => S.toFloat(toS(s)),
      strtol: (s, e, base) => parseInt(toS(s), Number(base) || 10) || 0,
      strtoul: (s, e, base) => (parseInt(toS(s), Number(base) || 10) || 0) >>> 0,
      strtof: (s) => S.toFloat(toS(s)), strtod: (s) => S.toFloat(toS(s)),
      strlen: (s) => toS(s).length,
      strcmp: (a, c) => S.compareTo(toS(a), c),
      strncmp: (a, c, n) => S.compareTo(toS(a).slice(0, n), toS(c).slice(0, n)),
      strcasecmp: (a, c) => S.compareTo(toS(a).toLowerCase(), toS(c).toLowerCase()),
      strstr: (a, c) => { a = toS(a); const i = a.indexOf(toS(c)); return i < 0 ? 0 : a.slice(i); },
      strchr: (a, c) => { a = toS(a); const i = a.indexOf(chrs(c)); return i < 0 ? 0 : a.slice(i); },
      makeKeymap: (k) => (Array.isArray(k) ? k.flat(Infinity) : k),

      // ------------------------------------------------ system
      checkForBeat(ir) {
        if (Number(ir) < 50000) return false;
        const inst = b.state.parts.find((p) => p.type === 'heartrate');
        const bpm = inst ? Number(b.input(inst.uid, 'bpm')) || 72 : 72;
        const t = clock.now();
        if (t - lastBeat >= 60000 / bpm) { lastBeat = t; return true; }
        return false;
      },
      esp_deep_sleep_start() { throw { simHalt: 'The ESP32 went into deep sleep. Press Run to start again.' }; },
      esp_light_sleep_start() { return rt.sleep(rt.wakeMs || 0); },
      esp_sleep_enable_timer_wakeup(us) { rt.wakeMs = Number(us) / 1000; },
      esp_sleep_enable_ext0_wakeup() {},
      esp_restart() { throw { simHalt: 'esp_restart() was called, so the board restarted. Press Run to start again.' }; },
      configTime() {},
      getLocalTime() { return false; },
      time() { return rt.startUnix + Math.floor(clock.now() / 1000); },
      printf: (...a) => $.Serial.printf(...a),
      puts: (s) => $.Serial.println(s),
      putchar: (c) => $.Serial.write(c),
      setCpuFrequencyMhz: () => true,
      getCpuFrequencyMhz: () => 240,
      disableCore0WDT() {}, disableCore1WDT() {},
      xTaskCreate() { rt.warnOnce('FreeRTOS tasks aren\'t simulated: only setup() and loop() run'); },
      xTaskCreatePinnedToCore() { rt.warnOnce('FreeRTOS tasks aren\'t simulated: only setup() and loop() run'); },
    };
    for (const name of Object.keys(BUILTIN_FNS)) if (!(name in $)) $[name] = () => 0;
    $.tick = async () => {
      $.n = 0;
      if (rt.stopped) throw STOP;
      if (clock.fast) { clock.virt += 0.05; b.poll(); await rt.gate(); } else b.poll();
      if (perfNow() - rt.lastMacro > 12) { rt.lastMacro = perfNow(); await (clock.fast ? macrotask() : new Promise((r) => setTimeout(r, 0))); }
      if (rt.stopped) throw STOP;
    };
    rt.Serial = $.Serial;
    return $;
  }

  // ===================================================================
  // start()
  // ===================================================================

  const frame = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 33));
  const unframe = (id) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id));

  function friendly(e) {
    if (!e) return 'something went wrong';
    if (e.isSim) return e.message;
    const m = String(e.message || e);
    if (e instanceof RangeError && /call stack/i.test(m)) return 'a function keeps calling itself without stopping';
    let r = /Cannot read propert(?:y|ies) of (?:undefined|null)(?: \(reading '([^']+)'\))?/.exec(m);
    if (r) return r[1] ? `tried to use ".${r[1]}" on something that doesn't exist (often an array index past the end)` : 'used something that doesn\'t exist (often an array index past the end)';
    r = /Cannot set propert(?:y|ies) of (?:undefined|null)/.exec(m);
    if (r) return 'tried to store a value in something that doesn\'t exist (often an array index past the end)';
    r = /([\w$.]+) is not a function/.exec(m);
    if (r) return `${r[1].replace(/^\$\./, '').replace(/\$\d*$/, '')} isn't a function the simulator can run`;
    if (/is not iterable/.test(m)) return 'a for ( : ) loop needs an array';
    return m;
  }

  /** Run a sketch on a virtual ESP32 wired like `state`. */
  function start(state, source, hooks, opts) {
    hooks = hooks || {};
    opts = opts || {};
    const call = (name, ...a) => { try { if (hooks[name]) hooks[name](...a); } catch (e) { if (typeof console !== 'undefined') console.error(e); } };
    const res = source && typeof source === 'object' && source.js ? source : compile(source);
    const dead = { running: false, stop() {}, setInput() {}, getInput() { return undefined; }, serialWrite() {}, model() { return {}; }, time() { return 0; }, runUntil() { return Promise.resolve(); }, done: Promise.resolve(), inputs: () => [] };
    if (!res.ok) {
      call('onError', res.error, res.line || 0);
      call('onStop', 'error');
      return dead;
    }
    const snap = JSON.parse(JSON.stringify(state || {}));
    snap.parts = (snap.parts || []).filter((p) => G.getPart(p.type));
    snap.wires = snap.wires || [];

    const clock = new Clock(opts.fast);
    const rt = {
      clock, stopped: false, finished: false, dirty: true, rx: '', limit: opts.fast ? 0 : Infinity, lastMacro: perfNow(),
      startUnix: Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 1000),
      warned: new Set(), wake: null, timer: null, gateRes: null, untilRes: null, oldLedc: false,
    };
    const lineNow = () => { try { return $.lineOf(); } catch (e) { return 0; } };
    rt.warnOnce = (msg) => { if (rt.warned.has(msg)) return; rt.warned.add(msg); call('onWarn', msg, lineNow()); };
    rt.serialOut = (s) => call('onSerial', s);
    rt.poll = () => rt.board.poll();
    rt.sleep = async (ms) => {
      if (rt.stopped) throw STOP;
      ms = Math.max(0, Number(ms) || 0);
      if (clock.fast) {
        clock.virt += ms;
        rt.board.poll();
        await rt.gate();
        if (perfNow() - rt.lastMacro > 8) { rt.lastMacro = perfNow(); await macrotask(); }
      } else {
        const end = clock.now() + ms;
        for (;;) {
          if (rt.stopped) break;
          const left = end - clock.now();
          if (left <= 0) break;
          await new Promise((r) => { rt.wake = r; rt.timer = setTimeout(r, Math.min(left, 40)); });
          rt.board.poll();
        }
        if (ms === 0) await macrotask();
        rt.lastMacro = perfNow();
      }
      if (rt.stopped) throw STOP;
    };
    rt.gate = async () => {
      while (!rt.stopped && clock.fast && clock.virt >= rt.limit) {
        if (rt.untilRes) { const r = rt.untilRes; rt.untilRes = null; r(); }
        await new Promise((r) => { rt.gateRes = r; });
      }
    };
    const fail = (e) => {
      if (e === STOP || rt.stopped) return;
      if (e && e.simHalt) { call('onWarn', e.simHalt, 0); halt('halt'); return; }
      const line = lineNow();
      const msg = friendly(e);
      call('onError', (line ? 'Line ' + line + ': ' : '') + msg, line);
      halt('error');
    };
    rt.callUser = (fn, ...args) => {
      if (rt.stopped || typeof fn !== 'function') return;
      try { const p = fn(...args); if (p && p.catch) p.catch(fail); } catch (e) { fail(e); }
    };
    rt.runIsr = (fn) => rt.callUser(fn);
    rt.pulseIn = (g, state, timeout) => {
      timeout = timeout == null ? 1000000 : Number(timeout);
      const want = state == null ? 1 : Number(state);
      const net = rt.board.gpioNet.get(g);
      if (net) {
        for (const m of rt.board.near(net)) {
          const model = rt.board.models.get(m.uid);
          if (!model || !model.echo || m.name !== 'ECHO') continue;
          const tg = rt.board.gpioOf(m.uid, 'TRIG');
          const tp = tg != null ? rt.board.pins.get(tg) : null;
          if (!tp || tp.falls === model.lastFalls) {
            rt.warnOnce(tg == null ? 'The distance sensor\'s TRIG pin isn\'t wired to a GPIO, so it never sends a ping' : `pulseIn() on ECHO: send a short HIGH pulse on TRIG (GPIO${tg}) first, then read the echo`);
            clock.bump(Math.min(timeout, 1000000) / 1000);
            return 0;
          }
          model.lastFalls = tp.falls;
          if (want !== 1) return 0;
          const d = Number(rt.board.input(m.uid, 'distance'));
          const us = (2 * d) / 0.0343;
          if (d > 400 || us > timeout) { clock.bump(timeout / 1000); return 0; }
          clock.bump(us / 1000);
          return Math.round(us);
        }
      }
      clock.bump(Math.min(timeout, 1000000) / 1000);
      return 0;
    };

    rt.board = new Board(snap, rt);
    const $ = makeApi(rt);

    let raf = 0;
    const tick = () => {
      raf = 0;
      if (rt.stopped) return;
      if (rt.clock.fast === false) rt.board.poll();
      call('onUpdate', rt.board.model(), { t: clock.now(), line: lineNow() });
      raf = frame(tick);
    };
    let doneRes;
    const done = new Promise((r) => { doneRes = r; });
    function halt(reason) {
      if (rt.stopped) return;
      rt.stopped = true;
      if (rt.timer) clearTimeout(rt.timer);
      if (rt.wake) rt.wake();
      if (rt.gateRes) { const r = rt.gateRes; rt.gateRes = null; r(); }
      if (raf) unframe(raf);
      raf = 0;
      handle.running = false;
      call('onStop', reason || 'stopped');
    }

    async function run() {
      try {
        for (const w of res.warnings || []) call('onWarn', w.msg, w.line);
        const factory = new Function('$', res.js); // eslint-disable-line no-new-func
        const prog = await factory($);
        await prog.setup();
        while (!rt.stopped) {
          await prog.loop();
          $.n += 40;
          if ($.n > 3000) await $.tick();
          else if (clock.fast) { clock.virt += 0.01; rt.board.poll(); await rt.gate(); }
        }
      } catch (e) {
        fail(e);
      } finally {
        rt.finished = true;
        if (rt.untilRes) { const r = rt.untilRes; rt.untilRes = null; r(); }
        doneRes();
      }
    }

    const handle = {
      running: true,
      board: rt.board,
      stop() { halt('stopped'); },
      setInput(key, value) {
        const i = String(key).lastIndexOf('.');
        const uid = String(key).slice(0, i), field = String(key).slice(i + 1);
        const m = rt.board.models.get(uid);
        if (!rt.board.inputs[uid]) return;
        if (m && m.onInput) m.onInput(field, value);
        if (field !== 'turn' && field !== 'key' && field !== 'code' && field !== 'card' && field !== 'hold') rt.board.inputs[uid][field] = value;
        rt.dirty = true;
        rt.board.checkIrq();
      },
      getInput(key) { const i = String(key).lastIndexOf('.'); return rt.board.input(String(key).slice(0, i), String(key).slice(i + 1)); },
      serialWrite(text) { rt.rx += toS(text); },
      model(o) { return rt.board.model(o); },
      time() { return clock.now(); },
      runUntil(ms) {
        if (!clock.fast) return Promise.resolve();
        rt.limit = ms;
        return new Promise((r) => {
          if (rt.finished) { r(); return; }
          rt.untilRes = r;
          if (rt.gateRes) { const g = rt.gateRes; rt.gateRes = null; g(); }
        });
      },
      done,
    };
    if (hooks.onUpdate) raf = frame(tick);
    run();
    return handle;
  }

  // ===================================================================
  // Examples: a circuit wired with auto-wire plus a matching sketch
  // ===================================================================

  function wireUp(state, uid) {
    const plan = G.autowire.plan(state, uid);
    for (const step of plan.steps) {
      const ctlEnd = { part: step.to.uid, pin: step.to.pin }, mine = { part: step.from.uid, pin: step.from.pin };
      const ctl = state.parts.find((p) => p.uid === step.to.uid);
      let color = 'G';
      try { color = (G.art && G.art.pinColor(G.getPart(ctl.type), step.to.pin)) || 'G'; } catch (e) { color = 'G'; }
      const id = () => 'w' + state.wires.length + uid;
      if (step.resistor) {
        const pa = G.findPin(state, step.to.uid, step.to.pin), pb = G.findPin(state, step.from.uid, step.from.pin);
        const rdef = G.getPart('resistor');
        const x = Math.round((pa.x + pb.x) / 2 - rdef.w / 2), y = Math.round((pa.y + pb.y) / 2);
        const r = { uid: uid + 'r', type: 'resistor', x, y, rot: pa.x > pb.x ? 2 : 0 };
        state.parts.push(r);
        state.wires.push({ id: id(), a: ctlEnd, b: { part: r.uid, pin: '1' }, color, via: [] });
        state.wires.push({ id: id(), a: { part: r.uid, pin: '2' }, b: mine, color, via: [] });
      } else {
        state.wires.push({ id: id(), a: ctlEnd, b: mine, color, via: [] });
      }
    }
    return plan;
  }

  function buildCircuit(name, parts) {
    const state = { name, parts: [{ uid: 'exU1', type: 'esp32', x: 20, y: 0, rot: 0 }], wires: [], custom: [] };
    for (const p of parts) state.parts.push({ uid: p.uid, type: p.type, x: p.x, y: p.y, rot: p.rot || 0 });
    for (const p of parts) wireUp(state, p.uid);
    const nl = G.buildNets(state);
    const gpio = (uid, pin) => {
      const inst = state.parts.find((q) => q.uid === uid);
      for (const pd of G.getPart(inst.type).pins) if (pd.name === pin) { const g = G.gpioFor(state, nl, uid, pd.num); if (g != null) return g; }
      return -1;
    };
    return { state, gpio };
  }

  const EXAMPLES = [
    {
      id: 'blink', title: 'Blink + button', blurb: 'An LED blinks. Press the button to make it blink faster.', color: 'O',
      build() {
        const { state, gpio } = buildCircuit('blink-and-button', [
          { uid: 'exLED', type: 'led', x: 38, y: 7 },
          { uid: 'exBTN', type: 'button', x: 38, y: 13 },
        ]);
        const L = gpio('exLED', '+'), B = gpio('exBTN', '1');
        const code = `/*
 * Blink + button
 * The LED blinks. Press the button to switch between slow and fast blinking.
 *
 * Wiring (made by GFLUX auto-wire):
 *   LED +  -> 220 ohm resistor -> GPIO${L}      LED -  -> GND
 *   Button -> GPIO${B} and GND (the code turns on the built-in pull-up)
 */

const int LED_PIN = ${L};
const int BUTTON_PIN = ${B};

bool fastMode = false;          // are we blinking fast?
bool ledOn = false;             // is the LED on right now?
unsigned long lastToggle = 0;   // when the LED last changed (in ms)
int lastButton = HIGH;          // the button reading from the last loop

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);   // the pin reads LOW while the button is pressed
  Serial.println("Press the button to change the blink speed!");
}

void loop() {
  // 1. Check the button. Act only at the moment it goes down.
  int button = digitalRead(BUTTON_PIN);
  if (button == LOW && lastButton == HIGH) {
    fastMode = !fastMode;
    Serial.println(fastMode ? "Fast blinking" : "Slow blinking");
  }
  lastButton = button;

  // 2. Blink without delay(), so the button always feels quick.
  unsigned long interval = fastMode ? 150 : 600;
  if (millis() - lastToggle >= interval) {
    lastToggle = millis();
    ledOn = !ledOn;
    digitalWrite(LED_PIN, ledOn ? HIGH : LOW);
  }

  delay(10);   // a tiny pause also stops the button "bouncing"
}
`;
        return { state, code };
      },
    },
    {
      id: 'distance', title: 'Distance alarm', blurb: 'Beeps faster the closer something gets to the distance sensor.', color: 'G',
      build() {
        const { state, gpio } = buildCircuit('distance-alarm', [
          { uid: 'exSONAR', type: 'hcsr04', x: 36, y: 0 },
          { uid: 'exBUZ', type: 'buzzer', x: 38, y: 8 },
          { uid: 'exLED', type: 'led', x: 38, y: 15 },
        ]);
        const T = gpio('exSONAR', 'TRIG'), E = gpio('exSONAR', 'ECHO'), Z = gpio('exBUZ', 'SIG'), L = gpio('exLED', '+');
        const code = `/*
 * Distance alarm
 * The HC-SR04 measures how far away something is. Closer than 50 cm, the
 * buzzer beeps and the LED flashes, faster and faster as it gets closer.
 *
 * Wiring (made by GFLUX auto-wire):
 *   HC-SR04 TRIG -> GPIO${T}   ECHO -> GPIO${E}   VCC -> VIN (5 V)   GND -> GND
 *   Buzzer SIG -> GPIO${Z}      LED + -> 220 ohm resistor -> GPIO${L}
 */

const int TRIG_PIN = ${T};
const int ECHO_PIN = ${E};
const int BUZZER_PIN = ${Z};
const int LED_PIN = ${L};
const int ALARM_CM = 50;   // start beeping closer than this

// Send a sound ping and time the echo. Returns centimetres, or -1 if nothing echoed back.
float readDistanceCm() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);   // a 10 microsecond ping
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long duration = pulseIn(ECHO_PIN, HIGH, 30000);   // microseconds until the echo came back
  if (duration == 0) return -1;
  return duration * 0.0343 / 2.0;   // sound moves 0.0343 cm per microsecond, there and back
}

void beep(int ms) {
  digitalWrite(BUZZER_PIN, HIGH);
  digitalWrite(LED_PIN, HIGH);
  delay(ms);
  digitalWrite(BUZZER_PIN, LOW);
  digitalWrite(LED_PIN, LOW);
}

void setup() {
  Serial.begin(115200);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(LED_PIN, OUTPUT);
  Serial.println("Distance alarm ready. Move something closer!");
}

void loop() {
  float cm = readDistanceCm();
  if (cm < 0) {
    Serial.println("Nothing in range");
    delay(250);
    return;
  }

  Serial.print("Distance: ");
  Serial.print(cm, 1);
  Serial.println(" cm");

  if (cm < ALARM_CM) {
    int pause = map((int)cm, 2, ALARM_CM, 40, 600);   // closer = shorter pause
    beep(60);
    delay(pause);
  } else {
    delay(250);
  }
}
`;
        return { state, code };
      },
    },
    {
      id: 'weather', title: 'Weather screen', blurb: 'Shows the temperature and humidity on a small screen.', color: 'I',
      build() {
        const { state, gpio } = buildCircuit('weather-screen', [
          { uid: 'exDHT', type: 'dht22', x: 38, y: 1 },
          { uid: 'exOLED', type: 'oled', x: 36, y: 9 },
        ]);
        const D = gpio('exDHT', 'DATA'), SDA = gpio('exOLED', 'SDA'), SCL = gpio('exOLED', 'SCL');
        const code = `/*
 * Weather screen
 * Reads a DHT22 every 2 seconds and shows the temperature and humidity on
 * the OLED screen (and in the Serial Monitor).
 *
 * Wiring (made by GFLUX auto-wire):
 *   DHT22 DATA -> GPIO${D}
 *   OLED SDA -> GPIO${SDA}   SCL -> GPIO${SCL}   (the ESP32's I2C pins)
 *
 * Libraries: Adafruit SSD1306, Adafruit GFX, DHT sensor library
 */

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <DHT.h>

#define DHT_PIN ${D}

Adafruit_SSD1306 display(128, 64, &Wire, -1);
DHT dht(DHT_PIN, DHT22);

void setup() {
  Serial.begin(115200);
  Wire.begin(${SDA}, ${SCL});
  dht.begin();
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("Screen not found. Check the SDA and SCL wires.");
    while (true) delay(1000);
  }
  display.setTextColor(SSD1306_WHITE);
}

void loop() {
  float tempC = dht.readTemperature();
  float humidity = dht.readHumidity();
  if (isnan(tempC) || isnan(humidity)) {
    Serial.println("Could not read the DHT22. Check its DATA wire.");
    delay(2000);
    return;
  }

  display.clearDisplay();
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println("Weather station");
  display.drawFastHLine(0, 10, 128, SSD1306_WHITE);

  display.setTextSize(2);
  display.setCursor(0, 18);
  display.print(tempC, 1);
  display.println(" C");
  display.setCursor(0, 42);
  display.print(humidity, 0);
  display.println(" %");
  display.display();

  Serial.printf("Temperature: %.1f C   Humidity: %.0f %%\\n", tempC, humidity);
  delay(2000);   // the DHT22 only measures every 2 seconds
}
`;
        return { state, code };
      },
    },
    {
      id: 'servo', title: 'Servo knob', blurb: 'Turn the knob and the servo follows it.', color: 'V',
      build() {
        const { state, gpio } = buildCircuit('servo-knob', [
          { uid: 'exPOT', type: 'pot', x: 12, y: 2 },
          { uid: 'exSERVO', type: 'servo', x: 37, y: 8 },
        ]);
        const K = gpio('exPOT', 'OUT'), V = gpio('exSERVO', 'SIG');
        const code = `/*
 * Servo knob
 * Turn the knob and the servo turns to match: knob all the way left = 0 degrees,
 * all the way right = 180 degrees.
 *
 * Wiring (made by GFLUX auto-wire):
 *   Knob OUT -> GPIO${K} (an analog pin)   Servo SIG -> GPIO${V}
 *
 * Library: ESP32Servo
 */

#include <ESP32Servo.h>

const int KNOB_PIN = ${K};
const int SERVO_PIN = ${V};

Servo myServo;
int lastAngle = -1;

void setup() {
  Serial.begin(115200);
  myServo.attach(SERVO_PIN);
  Serial.println("Turn the knob!");
}

void loop() {
  int reading = analogRead(KNOB_PIN);           // 0 to 4095
  int angle = map(reading, 0, 4095, 0, 180);    // turn it into 0 to 180 degrees
  myServo.write(angle);

  if (abs(angle - lastAngle) >= 2) {            // only print when it really moved
    Serial.printf("Knob %4d -> servo %3d degrees\\n", reading, angle);
    lastAngle = angle;
  }
  delay(20);
}
`;
        return { state, code };
      },
    },
  ];

  G.sim = {
    compile,
    start,
    inputsFor,
    examples: EXAMPLES,
    friendly,
    _internals: { tokenize, preprocess, Parser, Emitter, toS, cfmt, S, PERSIST, LIB_CLASSES },
  };
})();
