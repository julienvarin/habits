(function () {
  'use strict';

  const CACHE_KEY = 'habits.todos.v1';        // last-known-good list, doubles as pre-Supabase migration source
  const QUEUE_KEY = 'habits.todos.queue.v1';  // writes that couldn't reach Supabase
  const SEEN_KEY  = 'habits.todos.seen.v1';   // ids we've confirmed on the server (so deletes propagate)
  let todos        = [];
  let pendingLabel = null;
  let activeFilter = null;
  let eventsReady  = false;

  // ============================================================
  // Storage (local cache + offline write queue)
  // ============================================================
  function loadCache() {
    try { todos = JSON.parse(localStorage.getItem(CACHE_KEY) || '[]'); }
    catch { todos = []; }
  }
  function saveCache() { localStorage.setItem(CACHE_KEY, JSON.stringify(todos)); }

  // The set of ids we've seen on the server on a successful sync. Lets us tell a
  // brand-new local item (never synced → push it up) apart from one that used to
  // be on the server and has since been deleted on another device (→ drop it,
  // instead of resurrecting it on every sync).
  function loadSeen() {
    try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')); }
    catch { return new Set(); }
  }
  function saveSeen(ids) { localStorage.setItem(SEEN_KEY, JSON.stringify([...ids])); }

  function queuePush(op) {
    const q = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    q.push(op);
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  }
  async function flushQueue() {
    if (!window.db) return;
    const q = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    if (!q.length) return;
    const remaining = [];
    for (const op of q) {
      try {
        if      (op.op === 'add')    await window.db.addTodo(op.payload);
        else if (op.op === 'update') await window.db.updateTodo(op.id, op.patch);
        else if (op.op === 'delete') await window.db.deleteTodo(op.id);
      } catch {
        remaining.push(op);
      }
    }
    localStorage.setItem(QUEUE_KEY, JSON.stringify(remaining));
  }

  // ============================================================
  // Helpers
  // ============================================================
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function sortTodos(list) {
    return list.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

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

  // Map local todo shape ↔ DB row shape (both use snake_case timestamps on the wire).
  function toRow(t) {
    return {
      id: t.id,
      text: t.text,
      label: t.label,
      done: !!t.done,
      created_at: t.createdAt,
      done_at: t.doneAt || null,
    };
  }
  function fromRow(r) {
    return {
      id: r.id,
      text: r.text,
      label: r.label,
      done: !!r.done,
      createdAt: r.created_at,
      doneAt: r.done_at,
    };
  }

  // ============================================================
  // Sync
  // ============================================================
  async function sync() {
    if (!window.db) return;
    try {
      // 1. Push any queued writes (offline mutations)
      await flushQueue();

      // 2. Fetch remote state — this is authoritative for what still exists.
      const seen      = loadSeen();
      const remote    = (await window.db.listTodos() || []).map(fromRow);
      const remoteIds = new Set(remote.map(t => t.id));
      saveSeen(remoteIds);

      // 3. Reconcile local-only items against the server.
      const merged = remote.slice();
      for (const t of todos) {
        if (remoteIds.has(t.id)) continue;   // server has it — remote copy wins
        if (seen.has(t.id)) continue;        // was on the server, deleted elsewhere — let it go
        // Never seen on the server: a first-time migration from localStorage or
        // an offline create. Push it up (queue on failure) and keep it locally.
        try { await window.db.addTodo(toRow(t)); }
        catch { queuePush({ op: 'add', payload: toRow(t) }); }
        merged.push(t);
      }

      todos = sortTodos(merged);
      saveCache();
      render();
    } catch (err) {
      // Offline, or the `todos` table/columns don't exist in Supabase yet
      // (run schema.sql). Keep cached state, but surface why sync isn't working.
      console.warn('[todos] sync failed — offline, or the todos table is missing in Supabase (run schema.sql):', err);
    }
  }

  // ============================================================
  // Actions (optimistic + queue on failure)
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

    const todo = { id: uid(), text, label: label || null, done: false, createdAt: Date.now() };
    todos.unshift(todo);
    saveCache();
    pendingLabel = null;
    render();

    const inp = document.getElementById('todo-input');
    if (inp) { inp.value = ''; inp.focus(); }

    if (window.db) {
      window.db.addTodo(toRow(todo)).catch(() => queuePush({ op: 'add', payload: toRow(todo) }));
    }
  }

  function toggleItem(id) {
    const t = todos.find(x => x.id === id);
    if (!t) return;
    t.done   = !t.done;
    t.doneAt = t.done ? Date.now() : null;
    saveCache();
    render();

    if (window.db) {
      const patch = { done: t.done, done_at: t.doneAt };
      window.db.updateTodo(id, patch).catch(() => queuePush({ op: 'update', id, patch }));
    }
  }

  function deleteItem(id) {
    todos = todos.filter(x => x.id !== id);
    saveCache();
    render();

    if (window.db) {
      window.db.deleteTodo(id).catch(() => queuePush({ op: 'delete', id }));
    }
  }

  function clearDone() {
    const doneIds = todos.filter(x => x.done).map(x => x.id);
    todos = todos.filter(x => !x.done);
    saveCache();
    render();

    if (window.db) {
      for (const id of doneIds) {
        window.db.deleteTodo(id).catch(() => queuePush({ op: 'delete', id }));
      }
    }
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
    loadCache();
    render();                                    // paint from cache immediately
    if (!eventsReady) { attachEvents(); eventsReady = true; }
    sync();                                       // fetch/push in background
  }

  window.initTodo   = initTodo;
  window.renderTodo = render;
  window.syncTodos  = sync;
})();
