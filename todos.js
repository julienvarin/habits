(function () {
  'use strict';

  const STORE_KEY = 'habits.todos.v1';
  let todos        = [];
  let pendingLabel = null;
  let activeFilter = null;
  let eventsReady  = false;

  // ============================================================
  // Storage
  // ============================================================
  function loadStore() {
    try { todos = JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); }
    catch { todos = []; }
  }
  function saveStore() { localStorage.setItem(STORE_KEY, JSON.stringify(todos)); }

  // ============================================================
  // Helpers
  // ============================================================
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function allLabels() {
    const seen = new Set();
    for (const t of todos) if (t.label) seen.add(t.label);
    return [...seen].sort();
  }

  // Deterministic color from label name
  const LC = ['#007aff','#34c759','#ff9f0a','#af52de','#ff6723','#ff3b30','#5ac8fa','#30d158'];
  const _cc = {};
  function lcolor(l) {
    if (_cc[l]) return _cc[l];
    let h = 5381;
    for (let i = 0; i < l.length; i++) h = ((h << 5) + h + l.charCodeAt(i)) >>> 0;
    return (_cc[l] = LC[h % LC.length]);
  }

  const _ESC = { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' };
  function esc(s) { return String(s).replace(/[&<>"']/g, c => _ESC[c]); }

  // ============================================================
  // Actions
  // ============================================================
  function addTodo(raw) {
    let text  = (raw || '').trim();
    let label = pendingLabel;
    if (!text) return;

    // Extract trailing #label written inline
    const m = text.match(/\s#(\S+)\s*$/);
    if (m) {
      label = m[1];
      text  = text.slice(0, m.index).trim();
    }
    if (!text) return;

    todos.unshift({ id: uid(), text, label: label || null, done: false, createdAt: Date.now() });
    saveStore();
    pendingLabel = null;
    render();
    const inp = document.getElementById('todo-input');
    if (inp) { inp.value = ''; inp.focus(); }
  }

  function toggleItem(id) {
    const t = todos.find(x => x.id === id);
    if (!t) return;
    t.done  = !t.done;
    t.doneAt = t.done ? Date.now() : null;
    saveStore();
    render();
  }

  function deleteItem(id) {
    todos = todos.filter(x => x.id !== id);
    saveStore();
    render();
  }

  function clearDone() {
    todos = todos.filter(x => !x.done);
    saveStore();
    render();
  }

  function setPendingLabel(lbl) {
    pendingLabel = lbl || null;
    updateLabelRow();
    document.getElementById('todo-input')?.focus();
  }

  // ============================================================
  // Render
  // ============================================================
  function render() {
    loadStore();
    const root = document.getElementById('view-todo');
    if (!root) return;

    const labels  = allLabels();
    const visible = todos.filter(t => !activeFilter || t.label === activeFilter);
    const pending = visible.filter(t => !t.done);
    const done    = visible.filter(t =>  t.done);

    // Label filter bar
    const filterBar = labels.length ? `
      <div class="td-filter-bar">
        <button class="td-f ${!activeFilter ? 'on' : ''}" data-tfilter="">All</button>
        ${labels.map(l =>
          `<button class="td-f ${activeFilter === l ? 'on' : ''}"
                  data-tfilter="${esc(l)}" style="--lc:${lcolor(l)}">${esc(l)}</button>`
        ).join('')}
      </div>` : '';

    // Pending list
    const pendingHtml = pending.length
      ? pending.map(rowHtml).join('')
      : `<div class="td-zero">${
          activeFilter ? `No open todos in #${esc(activeFilter)}` : 'Nothing here yet — add something above!'
        }</div>`;

    // Done section
    const doneSection = done.length ? `
      <details class="td-done-details">
        <summary class="td-done-sum">Done <span class="td-done-ct">${done.length}</span></summary>
        <div class="td-done-list">
          ${done.map(rowHtml).join('')}
          <button class="td-clear-btn" data-taction="clear-done">Clear completed</button>
        </div>
      </details>` : '';

    // Label picks + pending indicator
    const picksHtml = labels.map(l =>
      `<button class="td-lp ${pendingLabel === l ? 'on' : ''}"
              data-tsetlbl="${esc(l)}" style="--lc:${lcolor(l)}">#${esc(l)}</button>`
    ).join('') + `<button class="td-new-lbl" data-taction="new-label">+ label</button>`;

    const pendingLblHtml = pendingLabel
      ? `<div class="td-active-lbl">
          <span class="td-lbl-tag" style="--lc:${lcolor(pendingLabel)}">#${esc(pendingLabel)}</span>
          <button class="td-lbl-clr" data-taction="clear-label">✕</button>
        </div>` : '';

    root.innerHTML = `
      <div class="td-add-wrap">
        <div class="td-add-row">
          <input id="todo-input" class="td-input" type="text"
                 placeholder="Add a todo…" maxlength="200" autocomplete="off" spellcheck="true" />
          <button class="td-add-btn" data-taction="add" aria-label="Add todo">+</button>
        </div>
        <div class="td-lbl-row" id="td-lbl-row">
          <div class="td-lbl-picks" id="td-lbl-picks">${picksHtml}</div>
          ${pendingLblHtml}
        </div>
      </div>
      ${filterBar}
      <div class="td-list">${pendingHtml}</div>
      ${doneSection}`;

    // Re-attach input keydown after innerHTML swap
    document.getElementById('todo-input')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') addTodo(e.target.value);
    });
  }

  function rowHtml(t) {
    const lbl = t.label
      ? `<span class="td-tag" style="--lc:${lcolor(t.label)}">${esc(t.label)}</span>`
      : '';
    return `
      <div class="td-item ${t.done ? 'done' : ''}">
        <button class="td-cb ${t.done ? 'done' : ''}"
                data-taction="toggle" data-id="${t.id}" aria-label="${t.done ? 'Undo' : 'Mark done'}"></button>
        <span class="td-txt">${esc(t.text)}</span>
        ${lbl}
        <button class="td-x" data-taction="delete" data-id="${t.id}" aria-label="Delete">×</button>
      </div>`;
  }

  // Partial update of label row (preserves input focus)
  function updateLabelRow() {
    const picks = document.getElementById('td-lbl-picks');
    const row   = document.getElementById('td-lbl-row');
    if (!picks || !row) return;

    const labels = allLabels();
    picks.innerHTML = labels.map(l =>
      `<button class="td-lp ${pendingLabel === l ? 'on' : ''}"
              data-tsetlbl="${esc(l)}" style="--lc:${lcolor(l)}">#${esc(l)}</button>`
    ).join('') + `<button class="td-new-lbl" data-taction="new-label">+ label</button>`;

    let plEl = row.querySelector('.td-active-lbl');
    if (pendingLabel) {
      if (!plEl) { plEl = document.createElement('div'); plEl.className = 'td-active-lbl'; row.appendChild(plEl); }
      plEl.innerHTML = `<span class="td-lbl-tag" style="--lc:${lcolor(pendingLabel)}">#${esc(pendingLabel)}</span>
        <button class="td-lbl-clr" data-taction="clear-label">✕</button>`;
    } else if (plEl) {
      plEl.remove();
    }
  }

  // ============================================================
  // Event delegation — attached once to the persistent #view-todo
  // ============================================================
  function attachEvents() {
    const root = document.getElementById('view-todo');
    if (!root) return;

    root.addEventListener('click', e => {
      const el     = e.target.closest('[data-taction]');
      const action = el?.dataset.taction;
      const id     = el?.dataset.id;

      if (action === 'toggle')      { toggleItem(id); return; }
      if (action === 'delete')      { deleteItem(id); return; }
      if (action === 'clear-done')  { clearDone();    return; }
      if (action === 'clear-label') { setPendingLabel(null); return; }
      if (action === 'add') {
        const inp = document.getElementById('todo-input');
        if (inp) addTodo(inp.value);
        return;
      }
      if (action === 'new-label') {
        const lbl = prompt('Label name (e.g. work, health, errands):')?.trim();
        if (lbl) setPendingLabel(lbl);
        else     document.getElementById('todo-input')?.focus();
        return;
      }

      // Filter bar
      const fEl = e.target.closest('[data-tfilter]');
      if (fEl) { activeFilter = fEl.dataset.tfilter || null; render(); return; }

      // Label pick
      const lpEl = e.target.closest('[data-tsetlbl]');
      if (lpEl) {
        const lbl = lpEl.dataset.tsetlbl;
        setPendingLabel(pendingLabel === lbl ? null : lbl);
        return;
      }
    });
  }

  // ============================================================
  // Init
  // ============================================================
  function initTodo() {
    loadStore();
    render();
    if (!eventsReady) { attachEvents(); eventsReady = true; }
  }

  window.initTodo   = initTodo;
  window.renderTodo = render;
})();
