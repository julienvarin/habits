(function () {
  'use strict';

  // ============================================================
  // State
  // ============================================================
  const state = {
    habits:  [],
    entries: new Set(),   // "habitId|YYYY-MM-DD"
    view:    'today',
    loading: true,
  };

  const COLORS = [
    '#3fb950', '#58a6ff', '#bc8cff', '#f78166',
    '#ffa657', '#ff7b72', '#39d353', '#f0b429',
  ];

  // ============================================================
  // Date helpers (local timezone — avoids UTC midnight surprises)
  // ============================================================
  function todayStr()    { return fmtDate(new Date()); }
  function fmtDate(d)    { return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
  function pad(n)        { return String(n).padStart(2,'0'); }
  function shiftDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
  function entryKey(hid, date) { return `${hid}|${date}`; }
  function hasTick(hid, date)  { return state.entries.has(entryKey(hid, date)); }

  // ============================================================
  // Escape helpers
  // ============================================================
  const ESC = { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' };
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ESC[c]); }

  // ============================================================
  // Toast
  // ============================================================
  const toastEl = document.getElementById('toast');
  let toastTimer;
  function toast(msg, duration = 2200) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), duration);
  }

  // ============================================================
  // Offline queue
  // ============================================================
  const Q_KEY = 'habits.queue.v2';
  function queueWrite(op) {
    const q = JSON.parse(localStorage.getItem(Q_KEY) || '[]');
    q.push(op);
    localStorage.setItem(Q_KEY, JSON.stringify(q));
  }
  async function flushQueue() {
    const q = JSON.parse(localStorage.getItem(Q_KEY) || '[]');
    if (!q.length) return;
    const remaining = [];
    for (const op of q) {
      try {
        if (op.t === 'tick')   await db.tick(op.habit_id, op.date);
        else if (op.t === 'untick') await db.untick(op.habit_id, op.date);
      } catch { remaining.push(op); }
    }
    localStorage.setItem(Q_KEY, JSON.stringify(remaining));
  }

  // ============================================================
  // Load
  // ============================================================
  async function load() {
    if (!window.SUPABASE_URL || window.SUPABASE_URL.startsWith('REPLACE_ME')) {
      document.getElementById('view-today').innerHTML = setupBanner();
      return;
    }

    showLoader('view-today');

    try {
      const [habits, entries] = await Promise.all([db.listHabits(), db.listEntries()]);
      state.habits  = habits  || [];
      state.entries = new Set((entries || []).map(e => entryKey(e.habit_id, e.date)));
      state.loading = false;
      renderAll();
      flushQueue();
    } catch (err) {
      console.error(err);
      document.getElementById('view-today').innerHTML = `
        <div class="empty">
          <div class="empty-icon">⚠️</div>
          <h2>Couldn't connect</h2>
          <p>${esc(err.message)}</p>
        </div>`;
    }
  }

  function showLoader(viewId) {
    document.getElementById(viewId).innerHTML = `
      <div class="loader"><div class="spinner"></div><span>Loading…</span></div>`;
  }

  function setupBanner() {
    return `
      <div class="empty">
        <div class="empty-icon">🔧</div>
        <h2>Setup needed</h2>
        <p>Edit <code>config.js</code> and add your Supabase URL and publishable key.</p>
      </div>`;
  }

  // ============================================================
  // Toggle (optimistic update)
  // ============================================================
  async function toggle(habitId, date) {
    const k     = entryKey(habitId, date);
    const wasOn = state.entries.has(k);
    if (wasOn) state.entries.delete(k); else state.entries.add(k);
    renderAll();
    if (navigator.vibrate) navigator.vibrate(12);
    try {
      if (wasOn) await db.untick(habitId, date);
      else        await db.tick(habitId, date);
    } catch (err) {
      queueWrite({ t: wasOn ? 'untick' : 'tick', habit_id: habitId, date });
      toast('Saved offline — will sync on next load');
    }
  }

  // ============================================================
  // Metrics
  // ============================================================
  function tickDates(habitId) {
    const out = [];
    for (const k of state.entries) {
      if (k.startsWith(habitId + '|')) out.push(k.slice(habitId.length + 1));
    }
    return out.sort();
  }

  function currentStreak(habitId) {
    const set = new Set(tickDates(habitId));
    let d = new Date();
    if (!set.has(todayStr())) d = shiftDays(d, -1);
    let n = 0;
    while (set.has(fmtDate(d))) { n++; d = shiftDays(d, -1); }
    return n;
  }

  function longestStreak(habitId) {
    const dates = tickDates(habitId);
    if (!dates.length) return 0;
    let best = 1, cur = 1;
    for (let i = 1; i < dates.length; i++) {
      const diff = (new Date(dates[i]) - new Date(dates[i-1])) / 86400000;
      cur = diff === 1 ? cur + 1 : 1;
      if (cur > best) best = cur;
    }
    return best;
  }

  function completionRate(habitId, days) {
    let hits = 0;
    for (let i = 0; i < days; i++) {
      if (hasTick(habitId, fmtDate(shiftDays(new Date(), -i)))) hits++;
    }
    return Math.round((hits / days) * 100);
  }

  // ============================================================
  // Render: topbar progress (Today view)
  // ============================================================
  function renderProgress() {
    const area = document.getElementById('progress-area');
    if (state.view !== 'today' || state.loading) { area.innerHTML = ''; return; }
    const total = state.habits.length;
    const done  = state.habits.filter(h => hasTick(h.id, todayStr())).length;
    const pct   = total ? Math.round((done / total) * 100) : 0;
    area.innerHTML = total === 0 ? '' : `
      <div class="progress-wrap">
        <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
        <span class="progress-label">${done}/${total}</span>
      </div>`;
  }

  // ============================================================
  // Render: Today (card layout with embedded calendar)
  // ============================================================
  function buildCardCal(habitId, color) {
    // Show last N_WEEKS weeks, aligned to Monday
    const N_WEEKS = 9;
    const today   = new Date();
    const todayS  = todayStr();

    // Find last Monday at or before N_WEEKS*7 days ago
    const endDate   = today;
    // Start from Monday of the week that is (N_WEEKS-1) full weeks before this week
    const todayDow  = (today.getDay() + 6) % 7;  // Mon=0
    const weekStart = shiftDays(today, -todayDow);
    const startDate = shiftDays(weekStart, -(N_WEEKS - 1) * 7);

    // Build N_WEEKS week columns, each with 7 cells (Mon–Sun)
    const DAY_LABELS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

    // Month labels row: one label per week column if the month changes
    const monthCells = [];
    let lastMonth = -1;
    for (let w = 0; w < N_WEEKS; w++) {
      const weekMonday = shiftDays(startDate, w * 7);
      const mo = weekMonday.getMonth();
      if (mo !== lastMonth) {
        monthCells.push(`<div class="cal-month-cell">${weekMonday.toLocaleDateString(undefined,{month:'short'})}</div>`);
        lastMonth = mo;
      } else {
        monthCells.push('<div class="cal-month-cell"></div>');
      }
    }

    // Week columns
    const weekCols = [];
    for (let w = 0; w < N_WEEKS; w++) {
      const cells = [];
      for (let d = 0; d < 7; d++) {
        const date  = shiftDays(startDate, w * 7 + d);
        const ds    = fmtDate(date);
        const on    = hasTick(habitId, ds);
        const isFut = ds > todayS;
        cells.push(
          `<div class="cal-cell ${on?'on':''} ${isFut?'future':''} ${ds===todayS?'today':''}"
                data-action="toggle-day" data-id="${habitId}" data-date="${ds}"
                title="${ds}"></div>`
        );
      }
      weekCols.push(`<div class="cal-week">${cells.join('')}</div>`);
    }

    return `
      <div class="card-cal">
        <div class="cal-month-row" style="margin-left:30px;gap:3px;display:flex;">
          ${monthCells.join('')}
        </div>
        <div class="cal-grid">
          <div class="cal-day-labels">
            ${DAY_LABELS.map(l => `<span>${l}</span>`).join('')}
          </div>
          <div class="cal-weeks">${weekCols.join('')}</div>
        </div>
      </div>`;
  }

  function renderToday() {
    const root  = document.getElementById('view-today');
    if (state.loading) return;
    const today = todayStr();

    if (!state.habits.length) {
      root.innerHTML = `
        <div class="empty">
          <div class="empty-icon">🌱</div>
          <h2>No habits yet</h2>
          <p>Tap the <strong>+</strong> button below to add your first habit.</p>
        </div>`;
      return;
    }

    const cards = state.habits.map(h => {
      const done   = hasTick(h.id, today);
      const streak = currentStreak(h.id);
      const lng    = longestStreak(h.id);
      const isRecord = streak > 0 && streak >= lng && lng > 0;

      return `
        <div class="habit-card ${done ? 'done' : ''}" style="--c:${h.color}">
          <div class="card-header">
            <div class="card-color-dot"></div>
            <h2 class="card-name">${esc(h.name)}</h2>
            <button class="card-edit-btn" data-action="edit" data-id="${h.id}" aria-label="Edit ${esc(h.name)}">✎</button>
          </div>

          <button class="card-complete-btn ${done ? 'done' : ''}"
                  data-action="toggle" data-id="${h.id}">
            ${done ? 'Completed — tap to undo' : 'Mark as complete'}
          </button>

          ${buildCardCal(h.id, h.color)}

          <div class="card-footer">
            <span class="card-streak">
              ${streak > 0
                ? `🔥 <strong>${streak}</strong> day${streak===1?'':'s'}${isRecord?' (new record!)':''}`
                : 'No streak yet'}
            </span>
            <span class="completed-tag ${done ? 'show' : ''}">✓ Completed Today</span>
          </div>
        </div>`;
    }).join('');

    root.innerHTML = `<div class="today-grid">${cards}</div>`;
  }

  // ============================================================
  // Render: History
  // ============================================================
  function renderHistory() {
    const root = document.getElementById('view-history');
    if (state.loading) return;

    if (!state.habits.length) {
      root.innerHTML = `<div class="empty"><div class="empty-icon">📅</div><h2>No habits yet</h2></div>`;
      return;
    }

    const DAYS      = 91;
    const today     = new Date();
    const todayS    = todayStr();
    const startDate = shiftDays(today, -(DAYS - 1));

    // Align to Monday
    const startWeekday = (startDate.getDay() + 6) % 7; // Mon=0

    const cards = state.habits.map(h => {
      const streak = currentStreak(h.id);

      // Build day cells (padded to start on a Monday column)
      const cells = [];
      for (let i = 0; i < startWeekday; i++) cells.push(`<div class="day future"></div>`);
      for (let i = 0; i < DAYS; i++) {
        const d  = shiftDays(startDate, i);
        const ds = fmtDate(d);
        const on = hasTick(h.id, ds);
        const isFuture = ds > todayS;
        cells.push(`
          <div class="day ${on ? 'on' : ''} ${isFuture ? 'future' : ''} ${ds === todayS ? 'today' : ''}"
               data-action="toggle-day" data-id="${h.id}" data-date="${ds}"
               title="${ds}"></div>`);
      }

      // Month labels: one label per column that starts a new month
      const totalCols = Math.ceil((startWeekday + DAYS) / 7);
      const monthLabels = [];
      for (let col = 0; col < totalCols; col++) {
        // Day index for first cell in this column (may be negative for pad)
        const firstDayIdx = col * 7 - startWeekday;
        if (firstDayIdx < 0) { monthLabels.push('<div></div>'); continue; }
        const d = shiftDays(startDate, firstDayIdx);
        const isFirstOfMonth = d.getDate() <= 7 && firstDayIdx < DAYS;
        if (isFirstOfMonth) {
          const label = d.toLocaleDateString(undefined, { month: 'short' });
          monthLabels.push(`<div class="heatmap-month-label">${label}</div>`);
        } else {
          monthLabels.push('<div></div>');
        }
      }

      return `
        <div class="history-card" style="color:${h.color}">
          <div class="history-head">
            <div class="history-swatch"></div>
            <h3>${esc(h.name)}</h3>
            ${streak > 0 ? `<span class="streak">🔥 ${streak}d</span>` : ''}
          </div>
          <div class="heatmap-wrap">
            <div class="heatmap-months">${monthLabels.join('')}</div>
            <div class="heatmap">${cells.join('')}</div>
          </div>
        </div>`;
    }).join('');

    root.innerHTML = cards;
  }

  // ============================================================
  // Render: Stats
  // ============================================================
  function renderStats() {
    const root = document.getElementById('view-stats');
    if (state.loading) return;

    if (!state.habits.length) {
      root.innerHTML = `<div class="empty"><div class="empty-icon">📊</div><h2>No habits yet</h2></div>`;
      return;
    }

    const today    = todayStr();
    const doneToday = state.habits.filter(h => hasTick(h.id, today)).length;
    const total    = state.habits.length;
    const pctToday = total ? Math.round((doneToday / total) * 100) : 0;
    const totalEver = state.entries.size;
    const bestStreak = Math.max(0, ...state.habits.map(h => longestStreak(h.id)));

    const overview = `
      <div class="stats-overview">
        <div class="stat-tile">
          <div class="num">${doneToday}<span style="font-size:16px;font-weight:400;color:var(--fg-dim)">/${total}</span></div>
          <div class="lbl">Done today</div>
        </div>
        <div class="stat-tile">
          <div class="num" style="color:var(--accent)">${pctToday}%</div>
          <div class="lbl">Today's rate</div>
        </div>
        <div class="stat-tile">
          <div class="num">${totalEver}</div>
          <div class="lbl">Total ticks</div>
        </div>
        <div class="stat-tile">
          <div class="num">🔥${bestStreak}</div>
          <div class="lbl">Best streak (any)</div>
        </div>
      </div>`;

    const cards = state.habits.map(h => {
      const cur  = currentStreak(h.id);
      const lng  = longestStreak(h.id);
      const r7   = completionRate(h.id, 7);
      const r30  = completionRate(h.id, 30);
      return `
        <div class="stats-habit-card" style="color:${h.color}">
          <div class="stats-habit-head">
            <h3>${esc(h.name)}</h3>
            ${cur > 0 ? `<span style="font-size:13px;color:var(--fg-dim)">🔥 ${cur}d</span>` : ''}
          </div>
          <div class="stats-metrics">
            <div class="stats-metric"><div class="v">${cur}</div><div class="k">Current<br>streak</div></div>
            <div class="stats-metric"><div class="v">${lng}</div><div class="k">Longest<br>streak</div></div>
            <div class="stats-metric"><div class="v">${r7}%</div><div class="k">Last<br>7 days</div></div>
            <div class="stats-metric"><div class="v">${r30}%</div><div class="k">Last<br>30 days</div></div>
          </div>
          <div style="display:flex;flex-direction:column;gap:8px">
            <div class="rate-bar-wrap">
              <span class="rate-lbl">7 days</span>
              <div class="rate-bar"><div class="rate-fill" style="width:${r7}%"></div></div>
              <span class="rate-pct">${r7}%</span>
            </div>
            <div class="rate-bar-wrap">
              <span class="rate-lbl">30 days</span>
              <div class="rate-bar"><div class="rate-fill" style="width:${r30}%"></div></div>
              <span class="rate-pct">${r30}%</span>
            </div>
          </div>
        </div>`;
    }).join('');

    root.innerHTML = overview + cards;
  }

  // ============================================================
  // Render all
  // ============================================================
  function renderAll() {
    renderProgress();
    renderToday();
    renderHistory();
    renderStats();
  }

  // ============================================================
  // Modal: add / edit habit
  // ============================================================
  function openModal(habit) {
    const isNew = !habit;
    let chosenColor = habit?.color ?? COLORS[state.habits.length % COLORS.length];
    const root = document.getElementById('modal-root');

    root.innerHTML = `
      <div class="modal-bg" id="modal-bg">
        <div class="modal" role="dialog" aria-modal="true" aria-label="${isNew ? 'Add habit' : 'Edit habit'}">
          <div class="modal-handle"></div>
          <h2>${isNew ? 'New habit' : 'Edit habit'}</h2>
          <label class="field-label" for="m-name">Name</label>
          <input id="m-name" type="text" maxlength="80"
                 placeholder="e.g. Read 20 minutes"
                 value="${esc(habit?.name ?? '')}" autocomplete="off" />
          <label class="field-label">Color</label>
          <div class="color-grid" id="color-grid">
            ${COLORS.map(c => `
              <div class="color-swatch ${c === chosenColor ? 'active' : ''}"
                   style="background:${c}" data-color="${c}" role="button" tabindex="0"
                   aria-label="Color ${c}" aria-pressed="${c === chosenColor}"></div>`).join('')}
          </div>
          <div class="modal-actions">
            ${!isNew ? `<button class="btn btn-danger" data-do="delete">Delete</button>` : ''}
            <button class="btn" data-do="cancel">Cancel</button>
            <button class="btn btn-primary" data-do="save">${isNew ? 'Add habit' : 'Save'}</button>
          </div>
        </div>
      </div>`;

    const input = root.querySelector('#m-name');
    setTimeout(() => input.focus(), 60);

    root.querySelector('#color-grid').addEventListener('click', e => {
      const sw = e.target.closest('.color-swatch');
      if (!sw) return;
      chosenColor = sw.dataset.color;
      root.querySelectorAll('.color-swatch').forEach(s => {
        s.classList.toggle('active', s === sw);
        s.setAttribute('aria-pressed', s === sw ? 'true' : 'false');
      });
    });

    root.addEventListener('click', async e => {
      if (e.target.id === 'modal-bg') return closeModal();
      const action = e.target.closest('[data-do]')?.dataset.do;
      if (!action) return;

      if (action === 'cancel') { closeModal(); return; }

      if (action === 'save') {
        const name = input.value.trim();
        if (!name) { input.focus(); input.style.borderColor = 'var(--danger)'; return; }
        try {
          if (isNew) {
            const h = await db.addHabit(name, chosenColor, state.habits.length);
            state.habits.push(h);
          } else {
            await db.updateHabit(habit.id, { name, color: chosenColor });
            const h = state.habits.find(x => x.id === habit.id);
            if (h) Object.assign(h, { name, color: chosenColor });
          }
          closeModal();
          renderAll();
        } catch (err) { toast('Couldn\'t save: ' + err.message); }
        return;
      }

      if (action === 'delete') {
        if (!confirm(`Delete "${habit.name}" and all its history? This cannot be undone.`)) return;
        try {
          await db.deleteHabit(habit.id);
          state.habits = state.habits.filter(x => x.id !== habit.id);
          for (const k of [...state.entries]) {
            if (k.startsWith(habit.id + '|')) state.entries.delete(k);
          }
          closeModal();
          renderAll();
          toast('Habit deleted');
        } catch (err) { toast('Couldn\'t delete: ' + err.message); }
      }
    });

    // Close on Escape
    function onKey(e) { if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', onKey); } }
    document.addEventListener('keydown', onKey);
  }

  function closeModal() {
    document.getElementById('modal-root').innerHTML = '';
  }

  // ============================================================
  // Event delegation
  // ============================================================
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action, id, date } = el.dataset;

    if (action === 'toggle') {
      if (e.target.closest('[data-action="edit"]')) return;
      toggle(id, todayStr());
    } else if (action === 'edit') {
      e.stopPropagation();
      openModal(state.habits.find(h => h.id === id));
    } else if (action === 'toggle-day') {
      toggle(id, date);
    }
  });

  // Tab switching
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.view;
      if (state.view === v) return;
      state.view = v;

      document.querySelectorAll('.tab').forEach(t => {
        t.classList.toggle('active', t === btn);
        t.setAttribute('aria-selected', t === btn ? 'true' : 'false');
      });
      document.querySelectorAll('.view').forEach(s => s.classList.remove('active'));
      document.getElementById(`view-${v}`).classList.add('active');

      const titles = { today:'Today', history:'History', stats:'Stats' };
      document.getElementById('page-title').textContent = titles[v];

      // Show/hide FAB
      document.getElementById('fab').style.display = v === 'today' ? '' : 'none';

      renderProgress();
    });
  });

  // FAB
  document.getElementById('fab').addEventListener('click', () => openModal(null));

  // Sticky header border on scroll
  const mainEl = document.querySelector('#app');
  const topbar = document.getElementById('topbar');
  mainEl.addEventListener('scroll', () => {
    topbar.classList.toggle('scrolled', mainEl.scrollTop > 8);
  }, { passive: true });
  window.addEventListener('scroll', () => {
    topbar.classList.toggle('scrolled', window.scrollY > 8);
  }, { passive: true });

  // Re-fetch on tab focus (picks up changes made on another device)
  window.addEventListener('focus', () => { if (!state.loading) load(); });

  // ============================================================
  // Date label
  // ============================================================
  document.getElementById('date-label').textContent =
    new Date().toLocaleDateString(undefined, { weekday:'long', month:'short', day:'numeric' });

  // ============================================================
  // Init
  // ============================================================
  load();
})();
