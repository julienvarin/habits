(function () {
  'use strict';

  const CACHE_KEY = 'habits.todos.v1';        // last-known-good list, doubles as pre-Supabase migration source
  const QUEUE_KEY = 'habits.todos.queue.v1';  // writes that couldn't reach Supabase
  const SEEN_KEY  = 'habits.todos.seen.v1';   // ids we've confirmed on the server (so deletes propagate)
  const MODE_KEY  = 'habits.todos.mode.v1';   // remembers the Todos/Lists toggle + active list
  let todos        = [];
  let activeFilter = null;
  let eventsReady  = false;
  // Three modes share this view, told apart by each row's `kind`:
  //   'todos'  — tasks (kind 'todo'). `activeFilter` is the single tappable
  //              label chip: it filters the list AND files new todos under it.
  //   'lists'  — freeform tickable lists (kind 'list' — movies, books, buy…),
  //              where the row's `label` is the list name and `activeList` the
  //              one being viewed/added to.
  //   'stress' — a stress board (kind 'stress'): tasks are chips dragged on a
  //              2-D board, X = complexity, Y = stress. `sx`/`sy` (0..1) hold
  //              each chip's position.
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
    for (const t of todos) if (t.kind === 'todo' && t.label) seen.add(t.label);
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
    if (viewMode === 'lists')  return t.kind === 'list' && t.label === activeList;
    if (viewMode === 'stress') return t.kind === 'stress';
    return t.kind === 'todo';
  }

  function loadMode() {
    try {
      const m = JSON.parse(localStorage.getItem(MODE_KEY) || '{}');
      viewMode   = ['todos', 'lists', 'stress'].includes(m.viewMode) ? m.viewMode : 'todos';
      activeList = m.activeList || null;
    } catch { viewMode = 'todos'; activeList = null; }
  }
  function saveMode() {
    localStorage.setItem(MODE_KEY, JSON.stringify({ viewMode, activeList }));
  }

  const _ESC = { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' };
  function esc(s) { return String(s).replace(/[&<>"']/g, c => _ESC[c]); }

  // Map local todo shape ↔ DB row shape (both use snake_case timestamps on the wire).
  function toRow(t) {
    return {
      id: t.id,
      text: t.text,
      label: t.label,
      kind: (t.kind === 'list' || t.kind === 'stress') ? t.kind : 'todo',
      done: !!t.done,
      created_at: t.createdAt,
      done_at: t.doneAt || null,
      stress_x: (typeof t.sx === 'number') ? t.sx : null,
      stress_y: (typeof t.sy === 'number') ? t.sy : null,
    };
  }
  function fromRow(r) {
    return {
      id: r.id,
      text: r.text,
      label: r.label,
      kind: (r.kind === 'list' || r.kind === 'stress') ? r.kind : 'todo',
      done: !!r.done,
      createdAt: r.created_at,
      doneAt: r.done_at,
      sx: (typeof r.stress_x === 'number') ? r.stress_x : undefined,
      sy: (typeof r.stress_y === 'number') ? r.stress_y : undefined,
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
    } else if (viewMode === 'stress') {
      kind  = 'stress';
      label = null;
    } else {
      kind  = 'todo';
      // The active label chip is where new todos land (like the active list).
      label = activeFilter;
      // Extract trailing #label written inline
      const m = text.match(/\s#(\S+)\s*$/);
      if (m) {
        label = m[1];
        text  = text.slice(0, m.index).trim();
      }
      if (!text) return;
    }

    const todo = { id: uid(), text, label: label || null, kind, done: false, createdAt: Date.now() };
    if (kind === 'stress') {
      // Drop new tasks near the calm/simple corner with a little jitter so they
      // don't stack, then let the user drag them into place.
      todo.sx = 0.12 + Math.random() * 0.12;
      todo.sy = 0.12 + Math.random() * 0.12;
    }
    todos.unshift(todo);
    saveCache();
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

  // Persist a stress chip's new board position (optimistic + queue on failure).
  function persistStress(t) {
    if (!window.db) return;
    const patch = { stress_x: t.sx, stress_y: t.sy };
    window.db.updateTodo(t.id, patch).catch(() => queuePush({ op: 'update', id: t.id, patch }));
  }

  function setMode(mode) {
    if (!['todos', 'lists', 'stress'].includes(mode)) return;
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

    const segBtn = (mode, txt) =>
      `<button class="td-seg-btn ${viewMode === mode ? 'on' : ''}" data-tmode="${mode}"
               role="tab" aria-selected="${viewMode === mode}">${txt}</button>`;
    const seg = `
      <div class="td-seg" role="tablist" aria-label="Todo mode">
        ${segBtn('todos', 'Todos')}${segBtn('lists', 'Lists')}${segBtn('stress', 'Stress')}
      </div>`;

    const body = viewMode === 'lists'  ? listsBody()
               : viewMode === 'stress' ? stressBody()
               : todosBody();
    root.innerHTML = seg + body;

    // Re-attach input keydown after innerHTML swap
    document.getElementById('todo-input')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') addTodo(e.target.value);
    });
  }

  // ---- Todos mode ----
  function todosBody() {
    // One tappable set of label chips (like Lists): the active chip both filters
    // the list and is where new todos land. Keep the active label visible even
    // when it has no todos yet, so a freshly-picked label doesn't vanish.
    const labelSet = new Set(allLabels());
    if (activeFilter) labelSet.add(activeFilter);
    const labels = [...labelSet].sort();

    const visible = todos.filter(t => t.kind === 'todo' && (!activeFilter || t.label === activeFilter));
    const pending = visible.filter(t => !t.done);
    const done    = visible.filter(t =>  t.done);

    const chips = `
      <div class="td-filter-bar">
        <button class="td-f ${!activeFilter ? 'on' : ''}" data-tfilter="">All</button>
        ${labels.map(l =>
          `<button class="td-f ${activeFilter === l ? 'on' : ''}"
                  data-tfilter="${esc(l)}">${esc(l)}</button>`
        ).join('')}
        <button class="td-new-lbl" data-taction="new-label" aria-label="New label">+</button>
      </div>`;

    const pendingHtml = pending.length
      ? pending.map(rowHtml).join('')
      : `<div class="td-zero">${
          activeFilter ? `No open todos in ${esc(activeFilter)}` : 'Nothing here yet — add something above!'
        }</div>`;

    const ph = activeFilter ? `Add to ${esc(activeFilter)}…` : 'Add a todo…';

    return `
      <div class="td-add-wrap">
        <div class="td-add-row">
          <input id="todo-input" class="td-input" type="text"
                 placeholder="${ph}" maxlength="200" autocomplete="off" spellcheck="true" />
          <button class="td-add-btn" data-taction="add" aria-label="Add todo">+</button>
        </div>
      </div>
      ${chips}
      <div class="td-list">${pendingHtml}</div>
      ${doneSectionHtml(done)}`;
  }

  // ---- Stress mode ----
  // A 2-D board: X = complexity (simple → complex), Y = stress (calm → stressful).
  // Tasks are chips you drag with a finger to where they sit; position persists.
  function stressBody() {
    const items = todos.filter(t => t.kind === 'stress' && !t.done);

    const chipsHtml = items.map(stressChipHtml).join('');
    const hint = items.length ? '' : `
      <div class="td-stress-hint">
        Add a task above, then drag it:<br>
        right = more complex, up = more stressful.
      </div>`;

    return `
      <div class="td-add-wrap">
        <div class="td-add-row">
          <input id="todo-input" class="td-input" type="text"
                 placeholder="Add a task to place…" maxlength="200" autocomplete="off" spellcheck="true" />
          <button class="td-add-btn" data-taction="add" aria-label="Add task">+</button>
        </div>
      </div>
      <div class="td-stress-wrap">
        <div class="td-axis-y">Stress ↑</div>
        <div class="td-stress-board">
          ${chipsHtml}
          ${hint}
        </div>
        <div class="td-axis-x">Complexity →</div>
      </div>`;
  }

  function stressChipHtml(t) {
    const sx = clamp01(typeof t.sx === 'number' ? t.sx : 0.15);
    const sy = clamp01(typeof t.sy === 'number' ? t.sy : 0.15);
    // Combined "load" drives the colour: calm+simple → green, stressful+complex → red.
    const hue = Math.round(140 * (1 - (sx + sy) / 2));
    const left = (sx * 100).toFixed(2);
    const top  = ((1 - sy) * 100).toFixed(2);   // top of the board is high stress
    return `
      <div class="td-stress-chip" data-id="${t.id}"
           style="left:${left}%; top:${top}%; --hue:${hue}">
        <span class="td-stress-txt">${esc(t.text)}</span>
        <button class="td-stress-x" data-taction="delete" data-id="${t.id}"
                aria-label="Done / remove">×</button>
      </div>`;
  }

  function clamp01(n) { return Math.max(0, Math.min(1, n)); }

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
                  data-tlist="${esc(l)}">${esc(l)}</button>`
        ).join('')}
        <button class="td-new-lbl" data-taction="new-list" aria-label="New list">+</button>
      </div>`;

    // No lists at all yet.
    if (!lists.length) {
      return `
        ${chips}
        <div class="td-zero">
          Keep lists of things to watch, read, or buy.<br>
          Tap <strong>+</strong> to start one.
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
    const lbl = (t.kind === 'todo' && t.label)
      ? `<span class="td-tag">${esc(t.label)}</span>`
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
      if (action === 'add') {
        const inp = document.getElementById('todo-input');
        if (inp) addTodo(inp.value);
        return;
      }
      if (action === 'new-label') {
        const lbl = prompt('Label name (e.g. work, health, errands):')?.trim();
        if (lbl) { activeFilter = lbl; render(); }   // becomes the active chip
        document.getElementById('todo-input')?.focus();
        return;
      }
      if (action === 'new-list') {
        const name = prompt('List name (e.g. Movies, Books, Buy):')?.trim();
        if (name) setActiveList(name);
        else      document.getElementById('todo-input')?.focus();
        return;
      }

      // Mode toggle (Todos / Lists / Stress)
      const mEl = e.target.closest('[data-tmode]');
      if (mEl) { setMode(mEl.dataset.tmode); return; }

      // List selector (lists mode)
      const lEl = e.target.closest('[data-tlist]');
      if (lEl) { setActiveList(lEl.dataset.tlist); return; }

      // Filter bar (also picks the label new todos land under)
      const fEl = e.target.closest('[data-tfilter]');
      if (fEl) { activeFilter = fEl.dataset.tfilter || null; render(); return; }
    });

    attachStressDrag(root);
  }

  // ============================================================
  // Stress board drag (pointer events — works with touch + mouse)
  // ============================================================
  function attachStressDrag(root) {
    let dragEl = null, item = null, board = null, moved = false;

    root.addEventListener('pointerdown', e => {
      if (viewMode !== 'stress') return;
      const chip = e.target.closest('.td-stress-chip');
      if (!chip) return;
      if (e.target.closest('[data-taction]')) return;   // let the × delete
      board = root.querySelector('.td-stress-board');
      if (!board) return;
      item = todos.find(t => t.id === chip.dataset.id);
      if (!item) return;
      dragEl = chip;
      moved  = false;
      chip.classList.add('dragging');
      try { chip.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
    });

    root.addEventListener('pointermove', e => {
      if (!dragEl) return;
      const r  = board.getBoundingClientRect();
      const fx = clamp01((e.clientX - r.left) / r.width);
      const fy = clamp01((e.clientY - r.top)  / r.height);
      // Keep a small margin so chips stay readable at the edges.
      item.sx = Math.max(0.04, Math.min(0.96, fx));
      item.sy = Math.max(0.04, Math.min(0.96, 1 - fy));   // top = high stress
      moved = true;
      dragEl.style.left = (item.sx * 100).toFixed(2) + '%';
      dragEl.style.top  = ((1 - item.sy) * 100).toFixed(2) + '%';
      dragEl.style.setProperty('--hue', String(Math.round(140 * (1 - (item.sx + item.sy) / 2))));
    });

    function endDrag() {
      if (!dragEl) return;
      const it = item, wasMoved = moved;
      dragEl.classList.remove('dragging');
      dragEl = null; item = null;
      if (wasMoved) { saveCache(); persistStress(it); }
    }
    root.addEventListener('pointerup', endDrag);
    root.addEventListener('pointercancel', endDrag);
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
