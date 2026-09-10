(function () {
  'use strict';

  const CACHE_KEY = 'habits.todos.v1';        // last-known-good list, doubles as pre-Supabase migration source
  const QUEUE_KEY = 'habits.todos.queue.v1';  // writes that couldn't reach Supabase
  const SEEN_KEY  = 'habits.todos.seen.v1';   // ids we've confirmed on the server (so deletes propagate)
  const MODE_KEY  = 'habits.todos.mode.v1';   // remembers the Todos/Lists toggle + active list
  let todos        = [];
  let pendingLabel = null;
  let activeFilter = null;
  let eventsReady  = false;
  // Two modes share this view: 'todos' (tasks) and 'lists' (freeform tickable
  // lists — movies to watch, books to read, things to buy…). Rows carry a
  // `kind` of 'todo' or 'list' to keep them apart. In lists mode the row's
  // `label` holds the list name and `activeList` is the one being viewed/added to.
  let viewMode   = 'todos';
  let activeList = null;

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
    for (const t of todos) if (t.kind !== 'list' && t.label) seen.add(t.label);
    return [...seen].sort();
  }

  // Distinct list names among list-kind items.
  function allLists() {
    const seen = new Set();
    for (const t of todos) if (t.kind === 'list' && t.label) seen.add(t.label);
    return [...seen].sort();
  }

  // The item scope the "Clear completed" button acts on for the current mode.
  function inCurrentScope(t) {
    if (viewMode === 'lists') return t.kind === 'list' && t.label === activeList;
    return t.kind !== 'list';
  }

  function loadMode() {
    try {
      const m = JSON.parse(localStorage.getItem(MODE_KEY) || '{}');
      viewMode   = m.viewMode === 'lists' ? 'lists' : 'todos';
      activeList = m.activeList || null;
    } catch { viewMode = 'todos'; activeList = null; }
  }
  function saveMode() {
    localStorage.setItem(MODE_KEY, JSON.stringify({ viewMode, activeList }));
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
      kind: t.kind === 'list' ? 'list' : 'todo',
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
      kind: r.kind === 'list' ? 'list' : 'todo',
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
    let text = (raw || '').trim();
    if (!text) return;

    let label, kind;
    if (viewMode === 'lists') {
      if (!activeList) return;   // nothing to add to until a list is picked/created
      kind  = 'list';
      label = activeList;
    } else {
      kind  = 'todo';
      label = pendingLabel;
      // Extract trailing #label written inline
      const m = text.match(/\s#(\S+)\s*$/);
      if (m) {
        label = m[1];
        text  = text.slice(0, m.index).trim();
      }
      if (!text) return;
    }

    const todo = { id: uid(), text, label: label || null, kind, done: false, createdAt: Date.now() };
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
    const doneIds = todos.filter(x => x.done && inCurrentScope(x)).map(x => x.id);
    const drop    = new Set(doneIds);
    todos = todos.filter(x => !drop.has(x.id));
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

  function setMode(mode) {
    if (mode !== 'todos' && mode !== 'lists') return;
    if (mode === viewMode) return;
    viewMode = mode;
    if (viewMode === 'lists' && !activeList) {
      const lists = allLists();
      if (lists.length) activeList = lists[0];
    }
    saveMode();
    render();
  }

  function setActiveList(name) {
    activeList = name || null;
    saveMode();
    render();
    document.getElementById('todo-input')?.focus();
  }

  // ============================================================
  // Render
  // ============================================================
  function render() {
    const root = document.getElementById('view-todo');
    if (!root) return;

    const seg = `
      <div class="td-seg" role="tablist" aria-label="Todo mode">
        <button class="td-seg-btn ${viewMode === 'todos' ? 'on' : ''}" data-tmode="todos"
                role="tab" aria-selected="${viewMode === 'todos'}">Todos</button>
        <button class="td-seg-btn ${viewMode === 'lists' ? 'on' : ''}" data-tmode="lists"
                role="tab" aria-selected="${viewMode === 'lists'}">Lists</button>
      </div>`;

    root.innerHTML = seg + (viewMode === 'lists' ? listsBody() : todosBody());

    // Re-attach input keydown after innerHTML swap
    document.getElementById('todo-input')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') addTodo(e.target.value);
    });
  }

  // ---- Todos mode ----
  function todosBody() {
    const labels  = allLabels();
    const visible = todos.filter(t => t.kind !== 'list' && (!activeFilter || t.label === activeFilter));
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

    const pendingHtml = pending.length
      ? pending.map(rowHtml).join('')
      : `<div class="td-zero">${
          activeFilter ? `No open todos in #${esc(activeFilter)}` : 'Nothing here yet — add something above!'
        }</div>`;

    const doneSection = doneSectionHtml(done);

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

    return `
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
  }

  // ---- Lists mode ----
  function listsBody() {
    const real = allLists();
    if (activeList && !real.includes(activeList)) {
      // freshly created but still empty — keep it selectable until an item lands
    } else if (!activeList && real.length) {
      activeList = real[0];
    }

    // Chips: every real list, plus a just-created empty one so it stays visible.
    const set = new Set(real);
    if (activeList) set.add(activeList);
    const lists = [...set].sort();

    const chips = `
      <div class="td-filter-bar td-list-bar">
        ${lists.map(l =>
          `<button class="td-f ${activeList === l ? 'on' : ''}"
                  data-tlist="${esc(l)}" style="--lc:${lcolor(l)}">${esc(l)}</button>`
        ).join('')}
        <button class="td-new-lbl" data-taction="new-list">+ list</button>
      </div>`;

    // No lists at all yet.
    if (!lists.length) {
      return `
        ${chips}
        <div class="td-zero">
          Keep lists of things to watch, read, or buy.<br>
          Tap <strong>+ list</strong> to start one.
        </div>`;
    }

    const items   = todos.filter(t => t.kind === 'list' && t.label === activeList);
    const pending = items.filter(t => !t.done);
    const done    = items.filter(t =>  t.done);

    const pendingHtml = pending.length
      ? pending.map(rowHtml).join('')
      : `<div class="td-zero">Nothing in ${esc(activeList)} yet — add something above!</div>`;

    return `
      <div class="td-add-wrap">
        <div class="td-add-row">
          <input id="todo-input" class="td-input" type="text"
                 placeholder="Add to ${esc(activeList)}…" maxlength="200" autocomplete="off" spellcheck="true" />
          <button class="td-add-btn" data-taction="add" aria-label="Add item">+</button>
        </div>
      </div>
      ${chips}
      <div class="td-list">${pendingHtml}</div>
      ${doneSectionHtml(done)}`;
  }

  function doneSectionHtml(done) {
    return done.length ? `
      <details class="td-done-details">
        <summary class="td-done-sum">Done <span class="td-done-ct">${done.length}</span></summary>
        <div class="td-done-list">
          ${done.map(rowHtml).join('')}
          <button class="td-clear-btn" data-taction="clear-done">Clear completed</button>
        </div>
      </details>` : '';
  }

  function rowHtml(t) {
    // List items are grouped under a selected list already, so no per-row tag there.
    const lbl = (t.kind !== 'list' && t.label)
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
      if (action === 'new-list') {
        const name = prompt('List name (e.g. Movies, Books, Buy):')?.trim();
        if (name) setActiveList(name);
        else      document.getElementById('todo-input')?.focus();
        return;
      }

      // Mode toggle (Todos / Lists)
      const mEl = e.target.closest('[data-tmode]');
      if (mEl) { setMode(mEl.dataset.tmode); return; }

      // List selector (lists mode)
      const lEl = e.target.closest('[data-tlist]');
      if (lEl) { setActiveList(lEl.dataset.tlist); return; }

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
    loadMode();
    loadCache();
    render();                                    // paint from cache immediately
    if (!eventsReady) { attachEvents(); eventsReady = true; }
    sync();                                       // fetch/push in background
  }

  window.initTodo   = initTodo;
  window.renderTodo = render;
  window.syncTodos  = sync;
})();
