/* GFLUX code editor: the right-hand "Code" panel. A plain sketch editor with
 * line numbers, the four example projects, starter code, and Check (instant
 * checks while you type, the real Arduino compiler on demand). */
window.GFLUX = window.GFLUX || {};

GFLUX.codeEditor = (function () {
  let area = null, gutter = null, typing = null;
  let starterShown = ''; // starter code the user has not edited yet
  const app = () => GFLUX.app || {};

  function h(tag, attrs, kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    (kids || []).forEach((c) => n.append(c));
    return n;
  }

  function updateGutter() {
    const lines = area.value.split('\n').length;
    if (gutter.childElementCount !== lines) gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
    gutter.scrollTop = area.scrollTop;
  }

  /** Keep the sketch in the project (saved with it) and re-run the quick checks. */
  function changed(checkNow) {
    updateGutter();
    const st = app().state;
    if (st) { st.code = area.value === starterShown ? undefined : area.value; if (app().save) app().save(); }
    clearTimeout(typing);
    typing = setTimeout(() => GFLUX.codecheck && GFLUX.codecheck.live(area.value), checkNow ? 0 : 600);
  }

  function set(code, checkNow = true) {
    if (!area) return;
    area.value = code;
    area.scrollTop = 0;
    changed(checkNow);
  }

  function starter() {
    const st = app().state;
    if (area.value.trim() && area.value !== starterShown && !confirm('Replace the code in the editor with fresh starter code?')) return;
    starterShown = GFLUX.codegen.sketch(st);
    set(starterShown);
  }

  function loadExample(i) {
    const ex = GFLUX.codecheck.buildExample(i);
    ex.state.code = ex.code;
    app().loadProject(ex.state);
    set(ex.code);
    app().toast(`Example "${ex.title}" loaded: the circuit is wired and the sketch is in the editor.`);
  }

  /** Select line `n` in the editor (from the check popup). */
  function goto(n) {
    if (!area) return;
    const lines = area.value.split('\n');
    const start = lines.slice(0, n - 1).reduce((a, l) => a + l.length + 1, 0);
    area.focus();
    area.setSelectionRange(start, start + (lines[n - 1] || '').length);
    const lh = parseFloat(getComputedStyle(area).lineHeight) || 18;
    area.scrollTop = Math.max(0, (n - 4) * lh);
    updateGutter();
  }

  function mount(root) {
    root.innerHTML = '';
    const examples = h('div', { class: 'ed-examples', role: 'list', 'aria-label': 'Examples' });
    GFLUX.codecheck.EXAMPLES.forEach((ex, i) => examples.append(
      h('button', { type: 'button', class: 'ed-example w-' + ['R', 'Y', 'B', 'V'][i % 4], role: 'listitem', text: ex.title, onclick: () => loadExample(i) })));
    gutter = h('pre', { class: 'ed-gutter', 'aria-hidden': 'true' });
    area = h('textarea', { class: 'ed-area', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', wrap: 'off', 'aria-label': 'Arduino sketch' });
    area.addEventListener('input', () => changed(false));
    area.addEventListener('scroll', () => { gutter.scrollTop = area.scrollTop; });
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') { // indent instead of leaving the editor
        e.preventDefault();
        const s = area.selectionStart;
        area.setRangeText('  ', s, area.selectionEnd, 'end');
        changed(false);
      }
      e.stopPropagation(); // editor keys never reach the canvas shortcuts
    });
    root.append(
      h('div', { class: 'ed-head' }, [h('span', { class: 'ed-title', text: 'Code' }), h('span', { class: 'ed-sub', text: 'Arduino sketch for your ESP32' })]),
      h('div', { class: 'ed-label', text: 'Examples' }), examples,
      h('div', { class: 'ed-box' }, [gutter, area]),
      h('div', { class: 'ed-actions' }, [
        h('button', { type: 'button', class: 'btn', text: 'Starter code', onclick: starter }),
        h('button', { type: 'button', class: 'btn primary', text: 'Check with Arduino', onclick: () => GFLUX.codecheck.run(area.value) }),
      ]),
    );
    load(app().state);
  }

  /** A different project was loaded: show its sketch. */
  function load(state) {
    if (!area) return;
    let code = state && state.code;
    if (!code) code = starterShown = GFLUX.codegen.sketch(state);
    if (area.value === code) return;
    area.value = code;
    area.scrollTop = 0;
    updateGutter();
  }

  return { mount, set, load, goto, get value() { return area ? area.value : ''; } };
})();
