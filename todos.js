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

  // Midnight (local) marking the start of today — the cutoff between a todo
  // completed "today" and one finished earlier.
  function startOfToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  function isDoneToday(t) {
    return typeof t.doneAt === 'number' && t.doneAt >= startOfToday();
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

  // `when` narrows which completed items are cleared: 'today', 'earlier', or
  // undefined for all of them (keeps the plain "Clear completed" meaning).
  function clearDone(when) {
    const doneIds = todos.filter(x => x.done && inCurrentScope(x) && (
      when === 'today'   ?  isDoneToday(x) :
      when === 'earlier' ? !isDoneToday(x) : true
    )).map(x => x.id);
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
  // Each task is a dot you drag to where it sits (position persists); tapping a
  // dot reveals its title. Below the board, the same tasks are a tickable list —
  // ticking one marks it done and drops its dot off the board.
  function stressBody() {
    const items   = todos.filter(t => t.kind === 'stress');
    const pending = items.filter(t => !t.done);
    const done    = items.filter(t =>  t.done);

    const dotsHtml = pending.map(stressDotHtml).join('');
    const hint = pending.length ? '' : `
      <div class="td-stress-hint">
        Add a task above, then drag its dot:<br>
        right = more complex, up = more stressful.<br>
        Tap a dot to see its title.
      </div>`;

    const listHtml = pending.length
      ? `<div class="td-stress-list">${pending.map(stressListRow).join('')}</div>`
      : '';

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
          ${dotsHtml}
          ${hint}
        </div>
        <div class="td-axis-x">Complexity →</div>
      </div>
      ${listHtml}
      ${stressDoneHtml(done)}`;
  }

  function stressDotHtml(t) {
    const sx = clamp01(typeof t.sx === 'number' ? t.sx : 0.15);
    const sy = clamp01(typeof t.sy === 'number' ? t.sy : 0.15);
    // Combined "load" drives the colour: calm+simple → green, stressful+complex → red.
    const hue  = Math.round(140 * (1 - (sx + sy) / 2));
    const left = (sx * 100).toFixed(2);
    const top  = ((1 - sy) * 100).toFixed(2);   // top of the board is high stress
    // Flip the reveal label below the dot when it sits high, so it isn't clipped.
    const below = sy > 0.62 ? ' label-below' : '';
    return `
      <div class="td-stress-dot${below}" data-id="${t.id}"
           style="left:${left}%; top:${top}%; --hue:${hue}">
        <span class="td-stress-label">${esc(t.text)}</span>
      </div>`;
  }

  // A tickable list row (checkbox + text, no delete cross).
  function stressListRow(t) {
    return `
      <div class="td-item ${t.done ? 'done' : ''}">
        <button class="td-cb ${t.done ? 'done' : ''}"
                data-taction="toggle" data-id="${t.id}" aria-label="${t.done ? 'Undo' : 'Mark done'}"></button>
        <span class="td-txt">${esc(t.text)}</span>
      </div>`;
  }

  function stressDoneHtml(done) {
    return doneSectionsHtml(done, stressListRow);
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

  // Split completed items into two collapsible sections: "Done today" on top,
  // then "Done" for everything finished before today. `row` renders each item
  // (rowHtml for todos/lists, stressListRow for the stress board).
  function doneSectionsHtml(done, row) {
    const today   = done.filter(isDoneToday);
    const earlier = done.filter(t => !isDoneToday(t));
    return doneDetails('Done today', today,   'today',   row)
         + doneDetails('Done',       earlier, 'earlier', row);
  }

  function doneDetails(title, items, when, row) {
    return items.length ? `
      <details class="td-done-details">
        <summary class="td-done-sum">${title} <span class="td-done-ct">${items.length}</span></summary>
        <div class="td-done-list">
          ${items.map(row).join('')}
          <button class="td-clear-btn" data-taction="clear-done" data-when="${when}">Clear completed</button>
        </div>
      </details>` : '';
  }

  function doneSectionHtml(done) {
    return doneSectionsHtml(done, rowHtml);
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
      if (action === 'clear-done')  { clearDone(el.dataset.when); return; }
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
    let dragEl = null, item = null, board = null, moved = false, startX = 0, startY = 0;

    root.addEventListener('pointerdown', e => {
      if (viewMode !== 'stress') return;
      const dot = e.target.closest('.td-stress-dot');
      if (!dot) return;
      board = root.querySelector('.td-stress-board');
      if (!board) return;
      item = todos.find(t => t.id === dot.dataset.id);
      if (!item) return;
      dragEl = dot;
      moved  = false;
      startX = e.clientX; startY = e.clientY;
      try { dot.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
    });

    root.addEventListener('pointermove', e => {
      if (!dragEl) return;
      // Ignore tiny jitter so a tap isn't mistaken for a drag.
      if (!moved) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < 5) return;
        moved = true;
        dragEl.classList.add('dragging');
      }
      const r  = board.getBoundingClientRect();
      const fx = clamp01((e.clientX - r.left) / r.width);
      const fy = clamp01((e.clientY - r.top)  / r.height);
      // Keep a small margin so dots stay inside the board.
      item.sx = Math.max(0.04, Math.min(0.96, fx));
      item.sy = Math.max(0.04, Math.min(0.96, 1 - fy));   // top = high stress
      dragEl.style.left = (item.sx * 100).toFixed(2) + '%';
      dragEl.style.top  = ((1 - item.sy) * 100).toFixed(2) + '%';
      dragEl.style.setProperty('--hue', String(Math.round(140 * (1 - (item.sx + item.sy) / 2))));
    });

    function endDrag() {
      if (!dragEl) return;
      const el = dragEl, it = item, wasMoved = moved;
      el.classList.remove('dragging');
      dragEl = null; item = null;
      if (wasMoved) {
        saveCache(); persistStress(it);
      } else {
        // A tap (no drag): reveal this dot's title, hiding any other.
        const wasShown = el.classList.contains('show');
        board.querySelectorAll('.td-stress-dot.show').forEach(d => d.classList.remove('show'));
        if (!wasShown) el.classList.add('show');
      }
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
