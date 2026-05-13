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
    historyOffset: 0,  // 0 = current period, +1 = one period back, etc.
  };

  const COLORS = [
    '#34c759', '#007aff', '#af52de', '#ff6723',
    '#ff9f0a', '#ff3b30', '#30d158', '#ffd60a',
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
  // Section helpers
  // ============================================================
  function existingSections() {
    const seen = new Set();
    const out = [];
    for (const h of state.habits) {
      const s = h.section || '';
      if (s && !seen.has(s)) { seen.add(s); out.push(s); }
    }
    return out.sort();
  }

  function groupBySection(habits) {
    const groups = new Map();
    for (const h of habits) {
      const s = h.section || '';
      if (!groups.has(s)) groups.set(s, []);
      groups.get(s).push(h);
    }
    return groups;
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
  function buildCardCal(habitId) {
    // Single row: current week Mon–Sun
    const today      = new Date();
    const todayS     = todayStr();
    const todayDow   = (today.getDay() + 6) % 7; // Mon=0
    const thisMonday = shiftDays(today, -todayDow);

    const COL_LABELS = ['M','T','W','T','F','S','S'];

    const header = `<div class="cal-row cal-header-row">${COL_LABELS.map(l =>
      `<span class="cal-col-label">${l}</span>`).join('')}</div>`;

    const cells = [];
    for (let d = 0; d < 7; d++) {
      const date = shiftDays(thisMonday, d);
      const ds   = fmtDate(date);
      const on   = hasTick(habitId, ds);
      const isFut = ds > todayS;
      cells.push(
        `<div class="cal-cell ${on?'on':''} ${isFut?'future':''} ${ds===todayS?'today':''}"
              data-action="toggle-day" data-id="${habitId}" data-date="${ds}"
              title="${ds}"></div>`);
    }
    const rows = [`<div class="cal-row">${cells.join('')}</div>`];

    return `<div class="card-cal">${header}${rows.join('')}</div>`;
  }

  function buildHabitCard(h, today) {
    const done   = hasTick(h.id, today);
    const streak = currentStreak(h.id);
    const lng    = longestStreak(h.id);
    const isRecord = streak > 0 && streak >= lng && lng > 0;

    return `
      <div class="habit-card ${done ? 'done' : ''}" style="--c:${h.color}" data-habit-id="${h.id}">
        <div class="card-header">
          <div class="card-drag-handle" aria-label="Drag to reorder">⠿</div>
          <div class="card-color-dot"></div>
          <h2 class="card-name">${esc(h.name)}</h2>
          <button class="card-edit-btn" data-action="edit" data-id="${h.id}" aria-label="Edit ${esc(h.name)}">···</button>
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

    const groups = groupBySection(state.habits);
    let html = '';

    for (const [section, habits] of groups) {
      const cards = habits.map(h => buildHabitCard(h, today)).join('');
      if (groups.size === 1 && !section) {
        // Single group with no section name — no header needed
        html += `<div class="today-grid">${cards}</div>`;
      } else {
        html += `
          <div class="section-group">
            <div class="section-header">${esc(section || 'General')}</div>
            <div class="today-grid">${cards}</div>
          </div>`;
      }
    }

    root.innerHTML = html;
    initDragAndDrop(root);
  }

  // ============================================================
  // Drag & drop reorder within sections
  // ============================================================
  let dragCard = null;

  function initDragAndDrop(root) {
    root.querySelectorAll('.habit-card').forEach(card => {
      card.addEventListener('dragstart', e => {
        dragCard = card;
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });

      card.addEventListener('dragend', () => {
        if (dragCard) dragCard.classList.remove('dragging');
        dragCard = null;
        root.querySelectorAll('.habit-card').forEach(c => c.classList.remove('drag-over'));
      });

      card.addEventListener('dragover', e => {
        e.preventDefault();
        if (!dragCard || dragCard === card) return;
        // Only allow within same grid (same section)
        if (dragCard.closest('.today-grid') !== card.closest('.today-grid')) return;
        e.dataTransfer.dropEffect = 'move';
        card.classList.add('drag-over');
      });

      card.addEventListener('dragleave', () => {
        card.classList.remove('drag-over');
      });

      card.addEventListener('drop', e => {
        e.preventDefault();
        card.classList.remove('drag-over');
        if (!dragCard || dragCard === card) return;
        if (dragCard.closest('.today-grid') !== card.closest('.today-grid')) return;

        const grid = card.closest('.today-grid');
        const allCards = [...grid.querySelectorAll('.habit-card')];
        const fromIdx = allCards.indexOf(dragCard);
        const toIdx = allCards.indexOf(card);

        // Compute new order from DOM positions
        const ids = allCards.map(c => c.dataset.habitId);
        const [movedId] = ids.splice(fromIdx, 1);
        ids.splice(toIdx, 0, movedId);

        dragCard.classList.remove('dragging');
        dragCard = null;

        // Update state and re-render
        persistOrder(ids);
        renderAll();
      });
    });

    // Only allow drag from the handle
    root.querySelectorAll('.card-drag-handle').forEach(handle => {
      handle.addEventListener('mousedown', () => {
        const card = handle.closest('.habit-card');
        card.draggable = true;
        const cleanup = () => { card.draggable = false; };
        document.addEventListener('mouseup', cleanup, { once: true });
        document.addEventListener('dragend', cleanup, { once: true });
      });
      // Touch support
      handle.addEventListener('touchstart', () => {
        handle.closest('.habit-card').draggable = true;
      }, { passive: true });
    });
  }

  async function persistOrder(orderedIds) {
    // Update sort_order in state
    for (let i = 0; i < orderedIds.length; i++) {
      const h = state.habits.find(x => x.id === orderedIds[i]);
      if (h) h.sort_order = i;
    }
    // Re-sort state.habits by sort_order (stable within sections)
    state.habits.sort((a, b) => a.sort_order - b.sort_order);

    // Persist to DB
    for (let i = 0; i < orderedIds.length; i++) {
      try {
        await db.updateHabit(orderedIds[i], { sort_order: i });
      } catch (err) {
        toast('Couldn\'t save order');
        break;
      }
    }
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

    const offset  = state.historyOffset; // 0 = this month, 1 = last month, …
    const todayS  = todayStr();

    // Target month
    const ref = new Date();
    ref.setDate(1);
    ref.setMonth(ref.getMonth() - offset);
    const year  = ref.getFullYear();
    const month = ref.getMonth();
    const monthLabel = ref.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const isLatest = offset === 0;

    // First day of month and total days
    const firstDay   = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const startDow   = (firstDay.getDay() + 6) % 7; // Mon=0

    const COL_LABELS = ['M','T','W','T','F','S','S'];

    function buildMonthGrid(habitId) {
      const header = `<div class="cal-row cal-header-row">${COL_LABELS.map(l =>
        `<span class="cal-col-label">${l}</span>`).join('')}</div>`;

      // Build week rows
      const rows = [];
      let day = 1;
      const totalSlots = startDow + daysInMonth;
      const totalWeeks = Math.ceil(totalSlots / 7);

      for (let w = 0; w < totalWeeks; w++) {
        const cells = [];
        for (let d = 0; d < 7; d++) {
          const slot = w * 7 + d;
          if (slot < startDow || day > daysInMonth) {
            cells.push('<div class="cal-cell empty-cell"></div>');
          } else {
            const ds = `${year}-${pad(month + 1)}-${pad(day)}`;
            const on = hasTick(habitId, ds);
            const isFut = ds > todayS;
            cells.push(
              `<div class="cal-cell ${on?'on':''} ${isFut?'future':''} ${ds===todayS?'today':''}"
                    data-action="toggle-day" data-id="${habitId}" data-date="${ds}"
                    title="${day}"><span class="cal-day-num">${day}</span></div>`);
            day++;
          }
        }
        rows.push(`<div class="cal-row">${cells.join('')}</div>`);
      }

      return `<div class="hist-month-grid">${header}${rows.join('')}</div>`;
    }

    function buildHistoryCard(h) {
      const streak = currentStreak(h.id);
      // Count ticks this month
      let monthTicks = 0;
      for (let d = 1; d <= daysInMonth; d++) {
        if (hasTick(h.id, `${year}-${pad(month+1)}-${pad(d)}`)) monthTicks++;
      }
      return `
        <div class="history-card" style="color:${h.color}">
          <div class="history-head">
            <div class="history-swatch"></div>
            <h3>${esc(h.name)}</h3>
            <span class="history-meta">${monthTicks}d${streak > 0 ? ` · 🔥${streak}` : ''}</span>
          </div>
          ${buildMonthGrid(h.id)}
        </div>`;
    }

    const groups = groupBySection(state.habits);
    let cardsHtml = '';
    for (const [section, habits] of groups) {
      const cards = habits.map(buildHistoryCard).join('');
      if (groups.size === 1 && !section) {
        cardsHtml += cards;
      } else {
        cardsHtml += `
          <div class="section-group">
            <div class="section-header">${esc(section || 'General')}</div>
            ${cards}
          </div>`;
      }
    }

    root.innerHTML = `
      <div class="history-nav">
        <button class="history-nav-btn" data-action="history-back" aria-label="Previous month">‹</button>
        <span class="history-nav-label">${monthLabel}</span>
        <button class="history-nav-btn ${isLatest ? 'disabled' : ''}" data-action="history-fwd" aria-label="Next month" ${isLatest ? 'disabled' : ''}>›</button>
      </div>
      ${cardsHtml}`;
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

    function buildStatsCard(h) {
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
    }

    const groups = groupBySection(state.habits);
    let cardsHtml = '';
    for (const [section, habits] of groups) {
      const cards = habits.map(buildStatsCard).join('');
      if (groups.size === 1 && !section) {
        cardsHtml += cards;
      } else {
        cardsHtml += `
          <div class="section-group">
            <div class="section-header">${esc(section || 'General')}</div>
            ${cards}
          </div>`;
      }
    }

    root.innerHTML = overview + cardsHtml;
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
  let modalAC = null;  // AbortController for current modal listeners

  function openModal(habit) {
    if (modalAC) modalAC.abort();
    modalAC = new AbortController();
    const sig = { signal: modalAC.signal };

    const isNew = !habit;
    let chosenColor = habit?.color ?? COLORS[state.habits.length % COLORS.length];
    let chosenSection = habit?.section ?? '';
    const sections = existingSections();
    const root = document.getElementById('modal-root');

    function renderSectionPills() {
      if (!sections.length) return '';
      return `
        <div class="section-pills" id="section-pills">
          ${sections.map(s => `
            <button type="button" class="section-pill ${s === chosenSection ? 'active' : ''}"
                    data-section="${esc(s)}">${esc(s)}</button>`).join('')}
        </div>`;
    }

    root.innerHTML = `
      <div class="modal-bg" id="modal-bg">
        <div class="modal" role="dialog" aria-modal="true" aria-label="${isNew ? 'Add habit' : 'Edit habit'}">
          <div class="modal-handle"></div>
          <h2>${isNew ? 'New habit' : 'Edit habit'}</h2>
          <label class="field-label" for="m-name">Name</label>
          <input id="m-name" type="text" maxlength="80"
                 placeholder="e.g. Read 20 minutes"
                 value="${esc(habit?.name ?? '')}" autocomplete="off" />
          <label class="field-label" for="m-section">Section</label>
          ${renderSectionPills()}
          <input id="m-section" type="text" maxlength="40"
                 placeholder="e.g. Health, Learning, Mindfulness"
                 value="${esc(chosenSection)}" autocomplete="off" />
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
    const sectionInput = root.querySelector('#m-section');
    setTimeout(() => input.focus(), 60);

    // Section pill click
    const pillsEl = root.querySelector('#section-pills');
    if (pillsEl) {
      pillsEl.addEventListener('click', e => {
        const pill = e.target.closest('.section-pill');
        if (!pill) return;
        const val = pill.dataset.section;
        if (chosenSection === val) {
          chosenSection = '';
          sectionInput.value = '';
        } else {
          chosenSection = val;
          sectionInput.value = val;
        }
        pillsEl.querySelectorAll('.section-pill').forEach(p =>
          p.classList.toggle('active', p.dataset.section === chosenSection));
      }, sig);
    }

    sectionInput.addEventListener('input', () => {
      chosenSection = sectionInput.value.trim();
      if (pillsEl) {
        pillsEl.querySelectorAll('.section-pill').forEach(p =>
          p.classList.toggle('active', p.dataset.section === chosenSection));
      }
    }, sig);

    root.querySelector('#color-grid').addEventListener('click', e => {
      const sw = e.target.closest('.color-swatch');
      if (!sw) return;
      chosenColor = sw.dataset.color;
      root.querySelectorAll('.color-swatch').forEach(s => {
        s.classList.toggle('active', s === sw);
        s.setAttribute('aria-pressed', s === sw ? 'true' : 'false');
      });
    }, sig);

    root.addEventListener('click', async e => {
      if (e.target.id === 'modal-bg') return closeModal();
      const action = e.target.closest('[data-do]')?.dataset.do;
      if (!action) return;

      if (action === 'cancel') { closeModal(); return; }

      if (action === 'save') {
        const name = input.value.trim();
        const section = sectionInput.value.trim() || null;
        if (!name) { input.focus(); input.style.borderColor = 'var(--danger)'; return; }
        try {
          if (isNew) {
            const h = await db.addHabit(name, chosenColor, state.habits.length, section);
            state.habits.push(h);
          } else {
            await db.updateHabit(habit.id, { name, color: chosenColor, section });
            const h = state.habits.find(x => x.id === habit.id);
            if (h) Object.assign(h, { name, color: chosenColor, section });
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
    }, sig);

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeModal();
    }, sig);
  }

  function closeModal() {
    if (modalAC) { modalAC.abort(); modalAC = null; }
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
    } else if (action === 'history-back') {
      state.historyOffset++;
      renderHistory();
    } else if (action === 'history-fwd') {
      if (state.historyOffset > 0) { state.historyOffset--; renderHistory(); }
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
