(function () {
  'use strict';

  // Meal planner: a week of lunches and dinners, shown as the "Meals" mode of
  // the Todo tab. One meal per day and slot, with its ingredients (one per
  // line) and a tick for when it's been added (shopping done / cooked).
  // Same offline model as weight.js: a local cache paints straight away,
  // writes that can't reach Supabase wait in a queue, and a sync replays the
  // queue, then takes the server's rows with any still-queued writes on top.
  const CACHE_KEY = 'habits.meals.v1';
  const QUEUE_KEY = 'habits.meals.queue.v1';
  const SLOTS = [['lunch', 'Lunch'], ['dinner', 'Dinner']];

  const meals = new Map(); // 'YYYY-MM-DD|slot' -> { date, slot, name, ingredients, done }
  let weekOffset = 0;      // 0 = this week (Mon–Sun), -1 = last week, …
  let missing = false;     // the meals table isn't in Supabase yet (run schema.sql)
  let editing = null;      // { date, slot } while the sheet shows a meal

  function pad(n)          { return String(n).padStart(2, '0'); }
  function fmtDate(d)      { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function shiftDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
  function parseDate(s)    { return new Date(s + 'T00:00:00'); } // avoid UTC parsing
  const key = (date, slot) => `${date}|${slot}`;
  const slotName = slot => (SLOTS.find(s => s[0] === slot) || [, slot])[1];

  const _ESC = { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' };
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => _ESC[c]); }

  function ingredientList(text) {
    return String(text || '').split('\n').map(s => s.replace(/^[-•*]\s*/, '').trim()).filter(Boolean);
  }

  // Monday of the week shown.
  function weekStart() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    const back = (d.getDay() + 6) % 7; // Mon = 0 … Sun = 6
    return shiftDays(d, -back + weekOffset * 7);
  }

  // ============================================================
  // Storage
  // ============================================================
  function loadCache() {
    try {
      meals.clear();
      for (const m of JSON.parse(localStorage.getItem(CACHE_KEY) || '[]')) meals.set(key(m.date, m.slot), m);
    } catch { /* ignore */ }
  }
  function saveCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify([...meals.values()])); } catch { /* ignore */ }
  }
  function loadQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; }
  }
  function saveQueue(q) { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch { /* ignore */ } }
  function queuePush(op) {
    // Only the latest write per day and slot matters.
    const k = key(op.date, op.slot);
    saveQueue(loadQueue().filter(o => key(o.date, o.slot) !== k).concat(op));
  }

  function send(op) {
    if (op.op === 'upsert') {
      const m = op.meal;
      return window.db.upsertMeal({
        date: m.date, slot: m.slot, name: m.name, ingredients: m.ingredients || null,
        done: !!m.done, updated_at: Date.now(),
      });
    }
    if (op.op === 'delete') return window.db.deleteMeal(op.date, op.slot);
    return Promise.resolve();
  }
  function write(op) {
    if (!window.db) { queuePush(op); return; }
    send(op).catch(() => queuePush(op));
  }
  async function flushQueue() {
    const q = loadQueue();
    if (!q.length) return;
    const remaining = [];
    for (const op of q) {
      try { await send(op); } catch { remaining.push(op); }
    }
    saveQueue(remaining);
  }

  function changed() {
    saveCache();
    window.renderTodo?.();
  }

  // ============================================================
  // Sync
  // ============================================================
  async function sync() {
    if (!window.db) return;
    try {
      await flushQueue();
      const rows = await window.db.listMeals();
      missing = false;
      meals.clear();
      for (const r of rows || []) {
        meals.set(key(r.date, r.slot), { date: r.date, slot: r.slot, name: r.name, ingredients: r.ingredients || '', done: !!r.done });
      }
      // Writes still waiting to reach the server win over what it sent back.
      for (const op of loadQueue()) {
        if (op.op === 'upsert') meals.set(key(op.meal.date, op.meal.slot), op.meal);
        else if (op.op === 'delete') meals.delete(key(op.date, op.slot));
      }
      changed();
    } catch (err) {
      missing = /meals|42P01|404/.test(String(err && err.message));
      console.warn('[meals] sync failed — offline, or the meals table is missing in Supabase (run schema.sql):', err);
      window.renderTodo?.();
    }
  }

  // ============================================================
  // Writing
  // ============================================================
  function save(date, slot, name, ingredients) {
    const prev = meals.get(key(date, slot));
    const meal = { date, slot, name, ingredients, done: prev ? prev.done : false };
    meals.set(key(date, slot), meal);
    changed();
    write({ op: 'upsert', meal });
  }
  function toggle(date, slot) {
    const m = meals.get(key(date, slot));
    if (!m) return;
    m.done = !m.done;
    changed();
    write({ op: 'upsert', meal: m });
  }
  function remove(date, slot) {
    const m = meals.get(key(date, slot));
    if (!m) return;
    meals.delete(key(date, slot));
    changed();
    write({ op: 'delete', date, slot });
    window.toast?.(`Removed “${m.name.length > 28 ? m.name.slice(0, 27) + '…' : m.name}”`, 0, {
      label: 'Undo',
      fn: () => { meals.set(key(date, slot), m); changed(); write({ op: 'upsert', meal: m }); },
    });
  }

  // The most recent ingredients written for a meal of this name (case-insensitive),
  // so planning a dish again fills its ingredients in.
  function knownIngredients(name) {
    const n = name.trim().toLowerCase();
    if (!n) return '';
    let best = null;
    for (const m of meals.values()) {
      if (m.name.trim().toLowerCase() === n && m.ingredients && (!best || m.date > best.date)) best = m;
    }
    return best ? best.ingredients : '';
  }
  function pastNames() {
    const seen = new Map();
    for (const m of meals.values()) {
      const k = m.name.trim().toLowerCase();
      if (k && !seen.has(k)) seen.set(k, m.name.trim());
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }

  // ============================================================
  // Render (the Meals mode body of the Todo tab)
  // ============================================================
  function html() {
    const start = weekStart();
    const end = shiftDays(start, 6);
    const today = fmtDate(new Date());
    const sameMonth = start.getMonth() === end.getMonth();
    const range = sameMonth
      ? `${start.getDate()}–${end.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
      : `${start.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${end.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
    const label = weekOffset === 0 ? 'This week' : weekOffset === 1 ? 'Next week' : weekOffset === -1 ? 'Last week' : range;

    let planned = 0, done = 0;
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = shiftDays(start, i);
      const ds = fmtDate(d);
      const rows = SLOTS.map(([slot, name]) => {
        const m = meals.get(key(ds, slot));
        if (!m) {
          return `
            <button class="ml-slot ml-empty" data-maction="edit" data-date="${ds}" data-slot="${slot}">
              <span class="ml-slot-name">${name}</span><span class="ml-add">+ Add</span>
            </button>`;
        }
        planned++; if (m.done) done++;
        const n = ingredientList(m.ingredients).length;
        return `
          <div class="ml-slot ${m.done ? 'done' : ''}">
            <button class="td-cb ${m.done ? 'done' : ''}" data-maction="toggle" data-date="${ds}" data-slot="${slot}"
                    aria-label="${m.done ? 'Mark as not added' : 'Mark as added'}"></button>
            <button class="ml-meal" data-maction="view" data-date="${ds}" data-slot="${slot}">
              <span class="ml-slot-name">${name}</span>
              <span class="ml-meal-name">${esc(m.name)}</span>
              ${n ? `<span class="ml-ing-ct">${n} ingredient${n === 1 ? '' : 's'}</span>` : ''}
            </button>
          </div>`;
      }).join('');
      const past = ds < today;
      days.push(`
        <div class="ml-day ${ds === today ? 'today' : ''} ${past ? 'past' : ''}">
          <div class="ml-day-head">
            <span class="ml-dow">${d.toLocaleDateString(undefined, { weekday: 'long' })}</span>
            <span class="ml-dnum">${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>
            ${ds === today ? '<span class="ml-today">Today</span>' : ''}
          </div>
          ${rows}
        </div>`);
    }

    const warn = missing ? `<div class="td-zero">Meals can't sync yet: the <code>meals</code> table is missing in Supabase. They're kept on this device until it exists.</div>` : '';

    return `
      <div class="ml-head">
        <div class="week-nav">
          <button class="week-nav-btn" data-maction="week" data-step="-1" aria-label="Previous week">‹</button>
          <span class="week-nav-label">${label}</span>
          <button class="week-nav-btn" data-maction="week" data-step="1" aria-label="Next week">›</button>
        </div>
        <span class="ml-sum">${planned ? `${done}/${planned} added` : range}</span>
      </div>
      ${weekOffset !== 0 ? `<button class="link ml-back" data-maction="week" data-step="0">Back to this week</button>` : ''}
      ${warn}
      <div class="ml-week">${days.join('')}</div>`;
  }

  // ============================================================
  // Sheet: view a meal's ingredients, or add/edit one
  // ============================================================
  function dayTitle(date, slot) {
    return `${parseDate(date).toLocaleDateString(undefined, { weekday: 'long' })} ${slotName(slot).toLowerCase()}`;
  }

  function openView(date, slot) {
    const m = meals.get(key(date, slot));
    if (!m) return openEdit(date, slot);
    editing = { date, slot };
    const ings = ingredientList(m.ingredients);
    window.openSheet(m.name, `
      <div class="ml-sheet-sub">${esc(dayTitle(date, slot))}</div>
      <div class="field-label">Ingredients</div>
      ${ings.length
        ? `<ul class="ml-ing">${ings.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`
        : `<div class="ml-ing-none">No ingredients yet. Tap Edit to add them.</div>`}
      <div class="modal-actions">
        <button class="btn" data-med="toggle">${m.done ? 'Not added' : 'Mark added'}</button>
        <button class="btn btn-primary" data-med="edit">Edit</button>
      </div>
      <button class="btn-del" data-med="delete">Remove</button>`);
  }

  function openEdit(date, slot) {
    const m = meals.get(key(date, slot));
    editing = { date, slot };
    const names = pastNames();
    window.openSheet(m ? 'Edit meal' : `Plan ${slotName(slot).toLowerCase()}`, `
      <div class="ml-sheet-sub">${esc(dayTitle(date, slot))}</div>
      <input id="ml-name" class="ed-input ml-name-input" type="text" maxlength="120" placeholder="What's cooking?"
             list="ml-names" autocomplete="off" value="${esc(m ? m.name : '')}" />
      <datalist id="ml-names">${names.map(n => `<option value="${esc(n)}"></option>`).join('')}</datalist>
      <div class="field-label">Ingredients, one per line</div>
      <textarea id="ml-ing" class="ed-input" rows="6" maxlength="2000" placeholder="Pasta&#10;Tomatoes&#10;Basil">${esc(m ? m.ingredients : '')}</textarea>
      <div class="modal-actions">
        <button class="btn" data-med="cancel">Cancel</button>
        <button class="btn btn-primary" data-med="save">Save</button>
      </div>
      ${m ? '<button class="btn-del" data-med="delete">Remove</button>' : ''}`);
    const nameEl = document.getElementById('ml-name');
    const ingEl = document.getElementById('ml-ing');
    // A dish planned before brings its ingredients along (if none typed yet).
    nameEl.addEventListener('change', () => {
      if (ingEl.value.trim()) return;
      const known = knownIngredients(nameEl.value);
      if (known) ingEl.value = known;
    });
    nameEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); ingEl.focus(); } });
    if (!m) setTimeout(() => nameEl.focus(), 50);
  }

  function onSheetClick(e) {
    if (!editing) return;
    const act = e.target.closest('[data-med]')?.dataset.med;
    if (!act) return;
    const { date, slot } = editing;
    if (act === 'edit') { openEdit(date, slot); return; }
    if (act === 'save') {
      const name = document.getElementById('ml-name').value.trim();
      const ingredients = document.getElementById('ml-ing').value.split('\n').map(s => s.trimEnd()).join('\n').trim();
      editing = null;
      window.closeSheet();
      if (name) save(date, slot, name, ingredients);
      else if (meals.has(key(date, slot))) remove(date, slot);
      return;
    }
    editing = null;
    window.closeSheet();
    if (act === 'toggle') toggle(date, slot);
    if (act === 'delete') remove(date, slot);
  }

  // Clicks inside the Meals body, forwarded by todos.js. Returns true if handled.
  function click(e) {
    const el = e.target.closest('[data-maction]');
    if (!el) return false;
    const { maction, date, slot } = el.dataset;
    if (maction === 'week') {
      const step = parseInt(el.dataset.step, 10);
      weekOffset = step === 0 ? 0 : weekOffset + step;
      window.renderTodo?.();
    }
    if (maction === 'toggle') toggle(date, slot);
    if (maction === 'view') openView(date, slot);
    if (maction === 'edit') openEdit(date, slot);
    return true;
  }

  // The tab bar's +: plan the next free slot from today on (this week shown).
  function focusAdd() {
    weekOffset = 0;
    window.renderTodo?.();
    const now = new Date();
    for (let i = 0; i < 14; i++) {
      const ds = fmtDate(shiftDays(now, i));
      for (const [slot] of SLOTS) {
        if (i === 0 && slot === 'lunch' && now.getHours() >= 15) continue;
        if (!meals.has(key(ds, slot))) { openEdit(ds, slot); return; }
      }
    }
  }

  let ready = false;
  function init() {
    loadCache();
    if (!ready) {
      document.getElementById('sheet-list')?.addEventListener('click', onSheetClick);
      // Closing the sheet by its backdrop leaves nothing half-open.
      document.getElementById('sheet')?.addEventListener('click', e => { if (e.target.id === 'sheet') editing = null; });
      ready = true;
    }
    window.renderTodo?.();
    sync();
  }

  window.meals = { init, sync, html, click, focusAdd };
})();
