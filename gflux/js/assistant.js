/* GFLUX coding assistant panel.
 *
 * GFLUX.assistant.mount(rootEl, { getState: () => state, toast: (msg) => void })
 *   Renders the Assistant UI into rootEl and returns { refresh, destroy }.
 *
 * Works offline (starter code from GFLUX.codegen). With an Anthropic API key it
 * streams answers from Claude using the official JS SDK, loaded lazily from
 * jsDelivr. The key never leaves the browser except in requests to Anthropic.
 */
(function () {
  'use strict';
  const G = window.GFLUX = window.GFLUX || {};

  const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.128.0/+esm';
  const KEY_STORE = 'gflux.apiKey';
  const MODEL = 'claude-opus-5-5';

  const SYSTEM = [
    'You are GFLUX\'s friendly coding assistant. You help beginners who build ESP32 circuits in the GFLUX circuit editor and program them with the Arduino IDE (Arduino-ESP32 core 3.x).',
    '',
    'Every user message starts with the current circuit (parts and the nets that connect them) and an offline starter sketch whose pin numbers are correct for that circuit.',
    '',
    'How to answer:',
    '- Always return ONE complete .ino sketch in a single ```cpp code block, ready to paste into the Arduino IDE. Never split the code over several blocks and never leave parts out with "..." placeholders.',
    '- Use exactly the GPIO numbers from the provided circuit. Do not invent pins the circuit does not wire.',
    '- After the code, list the libraries to install with the Arduino Library Manager (or say that none are needed).',
    '- If the request needs a part or a wire that is not in the circuit, say exactly which wire to add (part pin -> ESP32 pin, for example "Buzzer SIG -> D25 (GPIO25)") and still give the best code you can, using the pin you suggested.',
    '- Warn about voltage problems when they are relevant, for example a 5 V signal (like an HC-SR04 ECHO pin) going straight into a 3.3 V ESP32 GPIO, and suggest the fix (a voltage divider or level shifter).',
    '- Keep explanations short, plain-language and encouraging. The reader may be writing their first program. Prefer simple, readable code with a few helpful comments over clever code.',
  ].join('\n');

  // ------------------------------------------------------------------ helpers

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children || [])) if (c != null) n.append(c);
    return n;
  }

  const store = {
    get() { try { return window.localStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; } },
    set(v) { try { window.localStorage.setItem(KEY_STORE, v); return true; } catch (e) { return false; } },
    clear() { try { window.localStorage.removeItem(KEY_STORE); } catch (e) { /* ignore */ } },
  };

  // ---------------------------------------------------------------- markdown

  /** Inline markdown on already-escaped text: `code`, **bold**, https links. */
  function inline(escaped) {
    return escaped.split(/(`[^`\n]+`)/g).map((seg, i) => {
      if (i % 2 === 1) return '<code>' + seg.slice(1, -1) + '</code>';
      return seg
        .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[\s(])(https:\/\/[^\s<)]+[^\s<).,;:!?])/g, (m, pre, url) => pre + '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>');
    }).join('');
  }

  const CODE_LANGS = /^(cpp|c\+\+|c|ino|arduino|h|hpp)?$/i;

  /** Minimal, safe markdown: everything is escaped before any tag is added. */
  function renderMarkdown(src) {
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    const html = [];
    let para = [], list = null;
    const flushPara = () => { if (para.length) { html.push('<p>' + para.map((l) => inline(esc(l))).join('<br>') + '</p>'); para = []; } };
    const flushList = () => { if (list) { html.push('<' + list.tag + '>' + list.items.map((t) => '<li>' + inline(esc(t)) + '</li>').join('') + '</' + list.tag + '>'); list = null; } };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
      if (fence) {
        flushPara(); flushList();
        const lang = fence[1] || '';
        const code = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]);
        const isIno = CODE_LANGS.test(lang);
        html.push(
          '<div class="gx-code"><div class="gx-code-bar"><span class="gx-code-lang">' + esc(lang || 'code') + '</span>' +
          '<button type="button" class="gx-code-btn" data-act="copy">Copy</button>' +
          (isIno ? '<button type="button" class="gx-code-btn" data-act="download">Download .ino</button>' : '') +
          '</div><pre><code>' + esc(code.join('\n')) + '</code></pre></div>');
        continue;
      }
      const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
      const num = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (bullet || num) {
        flushPara();
        const tag = bullet ? 'ul' : 'ol';
        if (list && list.tag !== tag) flushList();
        if (!list) list = { tag, items: [] };
        list.items.push((bullet || num)[1]);
        continue;
      }
      const head = /^\s*#{1,6}\s+(.*)$/.exec(line);
      if (head) { flushPara(); flushList(); html.push('<h4>' + inline(esc(head[1])) + '</h4>'); continue; }
      if (!line.trim()) { flushPara(); flushList(); continue; }
      if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += ' ' + line.trim(); continue; }
      flushList();
      para.push(line);
    }
    flushPara(); flushList();
    return html.join('');
  }

  // ------------------------------------------------------------- prompt chips

  function suggestionsFor(state) {
    const types = new Set((state && state.parts || []).map((p) => p.type));
    const has = (...t) => t.some((x) => types.has(x));
    const screen = has('oled', 'lcd', 'tm1637');
    const s = [];
    if (has('hcsr04', 'vl53l0x') && screen) s.push('Show distance on the screen');
    if (has('hcsr04', 'vl53l0x') && has('buzzer')) s.push('Beep when something is close');
    if (has('dht22', 'bme280', 'ds18b20') && screen) s.push('Show temperature on the screen');
    if (has('pir') && has('buzzer')) s.push('Sound an alarm when motion is detected');
    if (has('button') && has('led')) s.push('Toggle the LED with the button');
    if (has('servo') && has('hcsr04', 'vl53l0x')) s.push('Turn the servo when something is close');
    else if (has('servo')) s.push('Sweep the servo back and forth');
    if (has('led')) s.push('Blink the LED');
    if (has('pot') && has('led')) s.push('Dim the LED with the knob');
    if (has('ledring', 'ledstrip')) s.push('Make a rainbow animation');
    if (has('dfplayer')) s.push('Play a song when I press a button');
    if (has('soil') && has('relay')) s.push('Water the plant when the soil is dry');
    if (has('oled') && !s.some((x) => /screen/.test(x))) s.push('Draw a smiley face on the screen');
    if (has('rfid')) s.push('Unlock when the right card is scanned');
    if (has('keypad')) s.push('Make a 4-digit PIN code lock');
    const generic = ['Explain my circuit', 'Check my wiring for mistakes', 'Show readings on a Wi-Fi web page'];
    if (!types.size) return ['What can I build with an ESP32?', 'Which parts do I need for a plant monitor?'];
    return s.slice(0, 5).concat(generic).slice(0, 7);
  }

  // ------------------------------------------------------------------ mount

  function mount(root, opts) {
    opts = opts || {};
    const getState = opts.getState || (() => ({ name: 'My circuit', parts: [], wires: [] }));
    const toast = (m) => { try { (opts.toast || (() => {}))(m); } catch (e) { /* ignore */ } };

    let apiKey = store.get();
    const history = []; // [{ role, content }] sent to the API: completed user/assistant text turns only
    let busy = null;    // { stream, aborted } while a request is running
    let chipSig = '';

    root.innerHTML = '';
    root.classList.add('gx-assistant');

    // -- settings
    const keyInput = el('input', { type: 'password', class: 'gx-as-key', placeholder: 'sk-ant-...', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Anthropic API key' });
    keyInput.value = apiKey;
    const remember = el('input', { type: 'checkbox' });
    remember.checked = !!apiKey;
    const status = el('span', { class: 'gx-as-status' });
    const settings = el('details', { class: 'gx-as-settings' }, [
      el('summary', {}, [el('span', { text: 'AI settings' }), status]),
      el('div', { class: 'gx-as-settings-body' }, [
        el('label', { class: 'gx-as-label', text: 'Anthropic API key' }),
        keyInput,
        el('label', { class: 'gx-as-check' }, [remember, el('span', { text: 'Remember on this device' })]),
        el('p', { class: 'gx-as-fine', html: 'Your key stays in this browser. Requests go straight from your browser to Anthropic, never to a GFLUX server. ' +
          '<a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer">Get an API key</a>' }),
      ]),
    ]);
    if (!apiKey) settings.open = false;

    const updateStatus = () => {
      status.textContent = apiKey ? 'AI on' : 'Offline';
      status.classList.toggle('on', !!apiKey);
    };
    keyInput.addEventListener('input', () => {
      apiKey = keyInput.value.trim();
      if (remember.checked) { if (apiKey) store.set(apiKey); else store.clear(); }
      updateStatus();
    });
    keyInput.addEventListener('change', () => { if (apiKey) toast(remember.checked ? 'API key saved on this device' : 'API key set for this session'); });
    remember.addEventListener('change', () => {
      if (remember.checked && apiKey) { if (store.set(apiKey)) toast('API key saved on this device'); else toast('This browser blocks saving, the key lasts until you reload'); }
      if (!remember.checked) store.clear();
    });

    // -- messages
    const list = el('div', { class: 'gx-as-list', role: 'log', 'aria-live': 'polite' });
    const intro = el('div', { class: 'gx-msg gx-msg-ai gx-msg-intro' }, [
      el('div', { class: 'gx-bubble', html: renderMarkdown('Describe what you want your circuit to do and I\'ll write the ESP32 code.\n\nTap **Starter code** for a sketch that tests every part on your canvas, no AI needed.') }),
    ]);
    list.append(intro);

    // -- chips
    const chips = el('div', { class: 'gx-as-chips', role: 'list', 'aria-label': 'Suggestions' });

    // -- composer
    const input = el('textarea', { class: 'gx-as-input', rows: '2', placeholder: 'e.g. Beep when something is closer than 10 cm', 'aria-label': 'Message' });
    const starterBtn = el('button', { type: 'button', class: 'gx-btn gx-btn-ghost', text: 'Starter code' });
    const sendBtn = el('button', { type: 'button', class: 'gx-btn gx-btn-send', text: 'Send' });
    const stopBtn = el('button', { type: 'button', class: 'gx-btn gx-btn-stop', text: 'Stop', hidden: true });
    const composer = el('div', { class: 'gx-as-compose' }, [
      input,
      el('div', { class: 'gx-as-actions' }, [starterBtn, el('span', { class: 'gx-spacer' }), stopBtn, sendBtn]),
    ]);

    root.append(
      el('div', { class: 'gx-as-head' }, [el('span', { class: 'gx-as-title', text: 'Assistant' }), el('span', { class: 'gx-as-sub', text: 'ESP32 code helper' })]),
      settings, list, chips, composer,
    );
    updateStatus();

    // ---------------------------------------------------------------- rendering

    const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    const scrollDown = (force) => { if (force || nearBottom()) list.scrollTop = list.scrollHeight; };

    function addMessage(role, text, extraClass) {
      const bubble = el('div', { class: 'gx-bubble' });
      const msg = el('div', { class: 'gx-msg ' + (role === 'user' ? 'gx-msg-user' : 'gx-msg-ai') + (extraClass ? ' ' + extraClass : '') }, [bubble]);
      if (role === 'user') bubble.textContent = text;
      else bubble.innerHTML = renderMarkdown(text);
      list.append(msg);
      scrollDown(true);
      return { msg, bubble, set(md) { const stick = nearBottom(); bubble.innerHTML = renderMarkdown(md); if (stick) list.scrollTop = list.scrollHeight; } };
    }

    function renderChips() {
      const items = suggestionsFor(safeState());
      const sig = items.join('|');
      if (sig === chipSig) return;
      chipSig = sig;
      chips.innerHTML = '';
      items.forEach((t, i) => chips.append(el('button', { type: 'button', class: 'gx-chip gx-w' + (i % 9), role: 'listitem', text: t, onclick: () => send(t) })));
    }

    function safeState() {
      try { return getState() || { parts: [], wires: [] }; } catch (e) { return { parts: [], wires: [] }; }
    }

    function projectFileName() {
      const n = String(safeState().name || 'gflux_sketch').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'gflux_sketch';
      return (/^[0-9]/.test(n) ? 'sketch_' + n : n) + '.ino';
    }

    // ---------------------------------------------------------------- starter

    function starterSketch() {
      try { return G.codegen.sketch(safeState()); } catch (e) { return '// Could not generate starter code: ' + (e && e.message ? e.message : e); }
    }

    function starterMarkdown(lead) {
      const state = safeState();
      const sketch = starterSketch();
      let libs = [], todos = [];
      try { libs = G.codegen.libraries(state); todos = G.codegen.analyze(state).todos; } catch (e) { /* ignore */ }
      const out = [lead || 'Here\'s starter code for your circuit. It tests every part and prints readings to the Serial Monitor (115200 baud).', '', '```cpp', sketch, '```', ''];
      if (libs.length) { out.push('**Install these libraries** (Tools > Manage Libraries):'); for (const l of libs) out.push('- ' + l); out.push(''); }
      if (todos.length) { out.push('**Still to wire:**'); for (const t of todos) out.push('- ' + t); out.push(''); }
      out.push('In the Arduino IDE pick the board **ESP32 Dev Module**, then click Upload.');
      return out.join('\n');
    }

    function showStarter() {
      addMessage('assistant', starterMarkdown());
    }

    // ---------------------------------------------------------------- send

    async function send(text) {
      text = String(text == null ? input.value : text).trim();
      if (!text || busy) return;
      input.value = '';
      autosize();
      addMessage('user', text);
      renderChips();

      if (!apiKey) {
        addMessage('assistant', starterMarkdown('AI is off right now, so here\'s the offline starter code for your circuit. It\'s a good base to build on.') +
          '\n\n**Want me to write custom code for that?** Open **AI settings** at the top, paste an Anthropic API key and send your message again. The key stays in your browser.');
        return;
      }
      await askClaude(text);
    }

    function userTurn(text) {
      const state = safeState();
      let circuit = '';
      try { circuit = G.describeCircuit(state); } catch (e) { circuit = '(could not read the circuit)'; }
      return [
        '<circuit name="' + String(state.name || 'My circuit').replace(/"/g, '\'') + '">', circuit, '</circuit>', '',
        '<starter_sketch note="offline-generated, use it as the reference for pin numbers">', starterSketch(), '</starter_sketch>', '',
        text,
      ].join('\n');
    }

    let sdkPromise = null;
    function loadSdk() {
      if (!sdkPromise) {
        sdkPromise = import(SDK_URL).then((m) => m.default || m.Anthropic).catch((e) => { sdkPromise = null; const err = new Error('sdk-load'); err.cause = e; err.gxSdk = true; throw err; });
      }
      return sdkPromise;
    }

    function setBusy(on) {
      sendBtn.hidden = !!on;
      stopBtn.hidden = !on;
      starterBtn.disabled = !!on;
      chips.classList.toggle('is-busy', !!on);
      list.setAttribute('aria-busy', on ? 'true' : 'false');
    }

    async function askClaude(text) {
      const content = userTurn(text);
      const view = addMessage('assistant', '', 'gx-msg-pending');
      view.bubble.innerHTML = '<span class="gx-thinking">Thinking<span>.</span><span>.</span><span>.</span></span>';
      const job = { stream: null, aborted: false };
      busy = job;
      setBusy(true);

      let acc = '', raf = 0;
      const paint = () => { raf = 0; view.set(acc); };
      const finish = (md, cls) => {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        view.msg.classList.remove('gx-msg-pending');
        if (cls) view.msg.classList.add(cls);
        view.set(md);
      };

      try {
        const Anthropic = await loadSdk();
        if (job.aborted) throw Object.assign(new Error('aborted'), { gxAbort: true });
        const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
        const stream = client.beta.messages.stream({
          model: MODEL,
          max_tokens: 64000,
          thinking: { type: 'adaptive' },
          output_config: { effort: 'medium' },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system: SYSTEM,
          messages: history.concat([{ role: 'user', content }]),
        });
        job.stream = stream;
        if (job.aborted) stream.abort();
        stream.on('text', (delta) => {
          acc += delta;
          if (!raf) raf = requestAnimationFrame(paint);
        });
        const final = await stream.finalMessage();
        if (final.stop_reason === 'refusal') {
          finish('Sorry, I can\'t help with that request. Try asking about your circuit in a different way, for example what you want it to do when a sensor changes.', 'gx-msg-note');
          return;
        }
        let md = acc || final.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        history.push({ role: 'user', content }, { role: 'assistant', content: md || '(no answer)' });
        if (final.stop_reason === 'max_tokens') md += '\n\n**Note:** my answer hit the length limit and got cut off. Ask me to "continue" or to make the code shorter.';
        finish(md || 'I didn\'t get an answer back. Please try again.');
      } catch (err) {
        if (job.aborted || (err && (err.gxAbort || err.name === 'APIUserAbortError' || err.name === 'AbortError'))) {
          if (acc.trim()) {
            history.push({ role: 'user', content }, { role: 'assistant', content: acc + '\n\n(stopped by the user)' });
            finish(acc + '\n\n(Stopped.)');
          } else {
            finish('Stopped.', 'gx-msg-note');
          }
          return;
        }
        finish(friendlyError(err), 'gx-msg-error');
      } finally {
        if (busy === job) busy = null;
        setBusy(false);
      }
    }

    function friendlyError(err) {
      const s = err && typeof err.status === 'number' ? err.status : null;
      if (err && err.gxSdk) {
        return '**I couldn\'t load the AI library.** GFLUX downloads it from cdn.jsdelivr.net the first time you ask. Check your internet connection and try again.\n\nThe **Starter code** button still works offline.';
      }
      if (s === 401) return '**That API key didn\'t work** (Anthropic said 401: unauthorized). Open **AI settings**, paste the key again from https://console.anthropic.com/settings/keys and make sure it starts with `sk-ant-`.';
      if (s === 403) return '**This key isn\'t allowed to use that model** (403). Check the key\'s workspace and permissions in the Anthropic Console.';
      if (s === 429) return '**Too many requests right now** (429 rate limit). Wait a minute and try again.';
      if (s === 529 || s === 503) return '**Claude is very busy right now.** Please try again in a moment.';
      if (s === 400) {
        const msg = err && err.error && err.error.error && err.error.error.message ? err.error.error.message : '';
        if (/credit|billing|balance/i.test(msg)) return '**Your Anthropic account is out of credits.** Add credits in the Anthropic Console, then try again.';
        return '**The request was rejected** (400). ' + (msg ? 'Anthropic said: `' + msg.slice(0, 300) + '`' : 'Please try again.');
      }
      if (s && s >= 500) return '**Anthropic had a problem on their side** (' + s + '). Please try again in a moment.';
      if (s == null) {
        const where = location.protocol === 'file:' ? ' You opened GFLUX straight from a file, which some browsers block.' : '';
        return '**I couldn\'t reach Anthropic.** Check your internet connection.' + where + ' Running a local server usually fixes browser blocks: open a terminal in the GFLUX folder and run `python3 tools/kicad_bridge.py`, then open the address it prints (on localhost).';
      }
      return '**Something went wrong** (error ' + s + '). Please try again.';
    }

    function stop() {
      if (!busy) return;
      busy.aborted = true;
      try { if (busy.stream) busy.stream.abort(); } catch (e) { /* ignore */ }
    }

    // ---------------------------------------------------------------- events

    function autosize() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 160) + 'px';
    }
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });
    sendBtn.addEventListener('click', () => send());
    stopBtn.addEventListener('click', stop);
    starterBtn.addEventListener('click', showStarter);
    root.addEventListener('pointerenter', renderChips);
    input.addEventListener('focus', renderChips);

    list.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn || !list.contains(btn)) return;
      const code = btn.closest('.gx-code').querySelector('code').textContent;
      if (btn.dataset.act === 'copy') {
        let ok = false;
        try { await navigator.clipboard.writeText(code); ok = true; } catch (err) {
          const ta = el('textarea', { class: 'gx-offscreen' }); ta.value = code; document.body.append(ta); ta.select();
          try { ok = document.execCommand('copy'); } catch (err2) { ok = false; }
          ta.remove();
        }
        const old = btn.textContent;
        btn.textContent = ok ? 'Copied!' : 'Copy failed';
        setTimeout(() => { btn.textContent = old; }, 1400);
        toast(ok ? 'Code copied' : 'Could not copy, select the code and press Ctrl+C');
      } else if (btn.dataset.act === 'download') {
        const name = projectFileName();
        const url = URL.createObjectURL(new Blob([code.endsWith('\n') ? code : code + '\n'], { type: 'text/plain' }));
        const a = el('a', { href: url, download: name });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        toast('Downloaded ' + name + '. Put it in a folder named ' + name.replace(/\.ino$/, '') + ' to open it in the Arduino IDE.');
      }
    });

    // Chips follow the parts on the canvas.
    renderChips();
    const timer = setInterval(() => {
      if (!root.isConnected) { clearInterval(timer); return; }
      renderChips();
    }, 1500);

    return {
      refresh: renderChips,
      showStarter,
      send: (t) => send(t),
      destroy() { clearInterval(timer); stop(); root.innerHTML = ''; root.classList.remove('gx-assistant'); },
    };
  }

  G.assistant = { mount, renderMarkdown, suggestionsFor, SYSTEM };
})();
