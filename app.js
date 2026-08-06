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
    todayWeekOffset: 0,   // 0 = this week, +1 = last week, etc.
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
    // Single row: Mon–Sun of the week selected by state.todayWeekOffset
    const today       = new Date();
    const todayS      = todayStr();
    const todayDow    = (today.getDay() + 6) % 7; // Mon=0
    const thisMonday  = shiftDays(today, -todayDow);
    const weekMonday  = shiftDays(thisMonday, -7 * state.todayWeekOffset);

    const COL_LABELS = ['M','T','W','T','F','S','S'];

    const header = `<div class="cal-row cal-header-row">${COL_LABELS.map(l =>
      `<span class="cal-col-label">${l}</span>`).join('')}</div>`;

    const cells = [];
    for (let d = 0; d < 7; d++) {
      const date = shiftDays(weekMonday, d);
      const ds   = fmtDate(date);
      const on   = hasTick(habitId, ds);
      const isFut = ds > todayS;
      cells.push(
        `<div class="cal-cell ${on?'on':''} ${isFut?'future':''} ${ds===todayS?'today':''}"
              data-action="toggle-day" data-id="${habitId}" data-date="${ds}"
              title="${ds}"><span class="cal-dn">${date.getDate()}</span></div>`);
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
          ${streak > 0
            ? `<span class="card-streak-badge${isRecord ? ' record' : ''}"
                     title="${streak} day${streak===1?'':'s'}${isRecord?' — new record!':''}">🔥 ${streak}</span>`
            : ''}
          <button class="card-edit-btn" data-action="edit" data-id="${h.id}" aria-label="Edit ${esc(h.name)}">···</button>
        </div>

        ${buildCardCal(h.id, h.color)}

        ${done ? `<div class="card-footer"><span class="completed-tag show">✓ Completed Today</span></div>` : ''}
      </div>`;
  }

  // "One big task" tile — today's big task is whatever was written as
  // "one thing to do tomorrow" in yesterday's journal entry.
  function buildBigTaskTile() {
    const jb = window.journalBig;
    if (!jb) return '';
    const text = jb.todayText();
    const done = jb.todayDone();
    if (!text) {
      return `
        <div class="bigtask-tile empty">
          <div class="bigtask-head"><span class="bigtask-icon">◎</span><span class="bigtask-label">One big task</span></div>
          <p class="bigtask-empty">Set “one thing to do tomorrow” in your journal below — it shows up here tomorrow.</p>
        </div>`;
    }
    return `
      <div class="bigtask-tile ${done ? 'done' : ''}">
        <div class="bigtask-head"><span class="bigtask-icon">◎</span><span class="bigtask-label">One big task</span></div>
        <button class="bigtask-check ${done ? 'done' : ''}" data-action="toggle-bigtask"
                aria-label="${done ? 'Mark big task not done' : 'Mark big task done'}">
          <span class="bigtask-box"></span>
          <span class="bigtask-text">${esc(text)}</span>
        </button>
      </div>`;
  }

  function buildWeekNav() {
    const off        = state.todayWeekOffset;
    const today      = new Date();
    const todayDow   = (today.getDay() + 6) % 7;
    const thisMonday = shiftDays(today, -todayDow);
    const weekMonday = shiftDays(thisMonday, -7 * off);
    const weekSunday = shiftDays(weekMonday, 6);
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const sameMonth = weekMonday.getMonth() === weekSunday.getMonth();
    const label = off === 0
      ? 'This week'
      : sameMonth
        ? `${MONTHS[weekMonday.getMonth()]} ${weekMonday.getDate()}–${weekSunday.getDate()}`
        : `${MONTHS[weekMonday.getMonth()]} ${weekMonday.getDate()} – ${MONTHS[weekSunday.getMonth()]} ${weekSunday.getDate()}`;
    return `
      <div class="week-nav">
        <button class="week-nav-btn" data-action="today-week-back" aria-label="Previous week">‹</button>
        <span class="week-nav-label${off > 0 ? ' past' : ''}">${label}</span>
        <button class="week-nav-btn" data-action="today-week-fwd" aria-label="Next week" ${off === 0 ? 'disabled' : ''}>›</button>
      </div>`;
  }

  function renderToday() {
    const root  = document.getElementById('view-today');
    if (state.loading) return;
    const today = todayStr();

    // Ensure the two persistent children exist: habits area + journal area.
    // #view-journal must survive habit re-renders so the textarea keeps focus.
    let habitsWrap  = document.getElementById('today-habits');
    let journalWrap = document.getElementById('view-journal');
    let journalNew  = false;
    if (!habitsWrap || !journalWrap) {
      root.innerHTML = '<div id="today-habits"></div><div id="view-journal"></div>';
      habitsWrap  = document.getElementById('today-habits');
      journalWrap = document.getElementById('view-journal');
      journalNew  = true;
    }

    const bigTile = buildBigTaskTile();

    if (!state.habits.length) {
      habitsWrap.innerHTML = bigTile + `
        <div class="empty">
          <div class="empty-icon">🌱</div>
          <h2>No habits yet</h2>
          <p>Tap the <strong>+</strong> button below to add your first habit.</p>
        </div>`;
    } else {
      const groups = groupBySection(state.habits);
      let html = bigTile + buildWeekNav();

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

      habitsWrap.innerHTML = html;
      initDragAndDrop(habitsWrap);
    }

    // First-time render (or after a wipe from load()/error path): populate journal.
    if (journalNew && window.renderJournal) window.renderJournal();
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
  // Stats: history heatmap block (rendered inside renderStats)
  // ============================================================
  function historyBlock(scope) {
    const year      = new Date().getFullYear();
    const todayS    = todayStr();
    const yearStart = new Date(year, 0, 1);
    const startDow  = (yearStart.getDay() + 6) % 7; // Mon=0
    const gridStart = shiftDays(yearStart, -startDow);
    const MONTHS    = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    function buildYearHeatmap(habitId, color) {
      const monthAtWeek = {};
      const weeks = [];
      for (let w = 0; w < 53; w++) {
        const cells = [];
        for (let d = 0; d < 7; d++) {
          const date   = shiftDays(gridStart, w * 7 + d);
          const ds     = fmtDate(date);
          const inYear = date.getFullYear() === year;
          if (inYear && date.getDate() === 1) monthAtWeek[w] = MONTHS[date.getMonth()];
          cells.push({ ds, inYear, on: inYear && hasTick(habitId, ds), isFut: ds > todayS, isToday: ds === todayS });
        }
        weeks.push(cells);
      }

      const header = weeks.map((_, w) =>
        `<span class="hist-year-mlabel">${monthAtWeek[w] || ''}</span>`
      ).join('');

      const cols = weeks.map(cells =>
        `<div class="hist-year-week">${cells.map(c => {
          if (!c.inYear) return `<div class="hist-year-cell" style="opacity:0"></div>`;
          const cls = [c.on ? 'on' : '', c.isFut ? 'future' : '', c.isToday ? 'today' : ''].filter(Boolean).join(' ');
          return `<div class="hist-year-cell${cls ? ' ' + cls : ''}" style="--c:${color}"
            data-action="toggle-day" data-id="${habitId}" data-date="${c.ds}" title="${c.ds}"></div>`;
        }).join('')}</div>`
      ).join('');

      return `
        <div class="hist-year-scroll">
          <div class="hist-year-inner">
            <div class="hist-year-header">${header}</div>
            <div class="hist-year-weeks">${cols}</div>
          </div>
        </div>`;
    }

    function buildHistoryCard(h) {
      const streak = currentStreak(h.id);
      let yearTicks = 0;
      for (const k of state.entries) {
        if (k.startsWith(h.id + '|') && k.slice(h.id.length + 1).startsWith(String(year))) yearTicks++;
      }
      return `
        <div class="history-card" style="color:${h.color}">
          <div class="history-head">
            <div class="history-swatch"></div>
            <h3>${esc(h.name)}</h3>
            <span class="history-meta">${yearTicks}d${streak > 0 ? ` · 🔥${streak}` : ''}</span>
          </div>
          ${buildYearHeatmap(h.id, h.color)}
        </div>`;
    }

    const habits = scope ? [scope] : state.habits;
    let cardsHtml = '';
    if (scope) {
      cardsHtml = buildHistoryCard(scope);
    } else {
      const groups = groupBySection(habits);
      for (const [section, hs] of groups) {
        const cards = hs.map(buildHistoryCard).join('');
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
    }

    return `<div class="history-year-label">${year}</div>${cardsHtml}`;
  }

  // ============================================================
  // Render: Stats
  // ============================================================
  // ---- Stats: scope + aggregate helpers ----
  let statsHabit = null; // null = all habits; otherwise a habit object
  const ACCENT = '#34c759';
  const WD_FULL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  const createdStr = h => (h.created_at ? fmtDate(new Date(h.created_at)) : '0000-01-01');

  // Share of the scope completed on a given day (0..1), or null if nothing was
  // active yet. For one habit that's 0/1; for "all" it's done/active habits.
  function dayFraction(dstr, scope) {
    if (scope) {
      if (dstr < createdStr(scope)) return null;
      return hasTick(scope.id, dstr) ? 1 : 0;
    }
    let done = 0, active = 0;
    for (const h of state.habits) {
      if (dstr >= createdStr(h)) { active++; if (hasTick(h.id, dstr)) done++; }
    }
    // Journaling counts as one more tracked item in the "all habits" aggregate,
    // active from its first entry onward (see journal.js / journalScore).
    const j = window.journalScore;
    if (j && j.activeOn(dstr)) { active++; if (j.doneOn(dstr)) done++; }
    if (!active) return null;
    return done / active;
  }

  // 7-day trailing completion rate for each of the last `days` days (%)
  function trendSeries(scope, days) {
    const base = new Date(), out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = shiftDays(base, -i);
      let sum = 0, cnt = 0;
      for (let j = 0; j < 7; j++) {
        const f = dayFraction(fmtDate(shiftDays(d, -j)), scope);
        if (f !== null) { sum += f; cnt++; }
      }
      out.push({ d: `${d.getMonth() + 1}/${d.getDate()}`, v: cnt ? Math.round((sum / cnt) * 100) : null });
    }
    // Drop the leading stretch before any data existed
    const first = out.findIndex(p => p.v !== null);
    return first < 0 ? [] : out.slice(first).map(p => ({ ...p, v: p.v ?? 0 }));
  }

  function weekdayRhythm(scope, days) {
    const sums = new Array(7).fill(0), cnts = new Array(7).fill(0), base = new Date();
    for (let i = 0; i < days; i++) {
      const d = shiftDays(base, -i);
      const f = dayFraction(fmtDate(d), scope);
      if (f === null) continue;
      const wd = d.getDay();
      sums[wd] += f; cnts[wd]++;
    }
    return [1, 2, 3, 4, 5, 6, 0].map(wd => ({
      full: WD_FULL[wd], letter: WD_FULL[wd][0],
      v: cnts[wd] ? Math.round((sums[wd] / cnts[wd]) * 100) : 0, has: cnts[wd] > 0,
    }));
  }

  // Mean daily completion rate over a window [startAgo, startAgo+len) days back
  function scopeRate(scope, startAgo, len) {
    let sum = 0, cnt = 0, base = new Date();
    for (let i = startAgo; i < startAgo + len; i++) {
      const f = dayFraction(fmtDate(shiftDays(base, -i)), scope);
      if (f !== null) { sum += f; cnt++; }
    }
    return cnt ? (sum / cnt) * 100 : null;
  }

  function areaFigure(pts, color) {
    if (pts.length < 2) return `<p class="viz-empty">Not enough history yet — keep ticking.</p>`;
    const n = pts.length, W = 340, H = 132, padL = 6, padR = 12, padT = 12, padB = 18;
    const pw = W - padL - padR, ph = H - padT - padB, base = padT + ph;
    const X = i => padL + (i / (n - 1)) * pw;
    const Y = v => padT + (1 - v / 100) * ph;
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ');
    const area = `M${X(0).toFixed(1)},${base} ${pts.map((p, i) => `L${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ')} L${X(n - 1).toFixed(1)},${base} Z`;
    const grid = [0, 50, 100].map(g =>
      `<line class="viz-grid" x1="${padL}" x2="${W - padR}" y1="${Y(g)}" y2="${Y(g)}"/>` +
      `<text class="viz-axis" x="${W - padR + 1}" y="${Y(g) + 3}">${g}</text>`).join('');
    const last = pts[n - 1];
    const geo = { padL, pw, padT, ph, n, W };
    return `
      <div class="viz-wrap">
        <svg class="viz-area" viewBox="0 0 ${W} ${H}" style="--c:${color}"
             data-pts='${JSON.stringify(pts)}' data-geo='${JSON.stringify(geo)}'>
          ${grid}
          <path class="viz-fill" d="${area}"/>
          <path class="viz-line" d="${line}"/>
          <line class="viz-cross" x1="0" x2="0" y1="${padT}" y2="${base}" style="display:none"/>
          <circle class="viz-dot" cx="${X(n - 1).toFixed(1)}" cy="${Y(last.v).toFixed(1)}" r="3.4"/>
          <circle class="viz-cursor" r="3.4" style="display:none"/>
        </svg>
        <div class="viz-tip" style="display:none"></div>
        <div class="viz-xaxis"><span>${esc(pts[0].d)}</span><span>${esc(last.d)}</span></div>
      </div>`;
  }

  function barsFigure(rhythm, color) {
    const W = 340, H = 118, padL = 4, padR = 4, padT = 16, padB = 18;
    const pw = W - padL - padR, ph = H - padT - padB, base = padT + ph;
    const band = pw / 7, barW = Math.min(26, band - 10);
    const maxV = Math.max(...rhythm.map(r => r.v), 1);
    const bestI = rhythm.reduce((b, r, i) => (r.v > rhythm[b].v ? i : b), 0);
    const bars = rhythm.map((r, i) => {
      const cx = padL + band * i + band / 2;
      const h = r.has ? (r.v / 100) * ph : 0;
      const y = base - h;
      const isBest = i === bestI && r.v > 0;
      return `
        <g class="viz-bar" data-full="${esc(r.full)}" data-v="${r.v}">
          <rect class="viz-bar-hit" x="${cx - band / 2}" y="${padT}" width="${band}" height="${ph}"/>
          <rect class="viz-bar-rect${isBest ? ' best' : ''}" x="${(cx - barW / 2).toFixed(1)}" y="${y.toFixed(1)}"
                width="${barW.toFixed(1)}" height="${Math.max(h, r.has ? 2 : 0).toFixed(1)}" rx="3"/>
          ${isBest ? `<text class="viz-bar-cap" x="${cx.toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle">${r.v}%</text>` : ''}
          <text class="viz-axis" x="${cx.toFixed(1)}" y="${base + 12}" text-anchor="middle">${r.letter}</text>
        </g>`;
    }).join('');
    return `
      <div class="viz-wrap">
        <svg class="viz-bars" viewBox="0 0 ${W} ${H}" style="--c:${color}">
          <line class="viz-grid" x1="${padL}" x2="${W - padR}" y1="${base}" y2="${base}"/>
          ${bars}
        </svg>
        <div class="viz-tip" style="display:none"></div>
      </div>`;
  }

  function renderStats() {
    const root = document.getElementById('view-stats');
    if (state.loading) return;

    if (!state.habits.length) {
      statsHabit = null;
      root.innerHTML = `<div class="empty"><h2>No habits yet</h2><p>Add a habit to start tracking your stats.</p></div>`;
      return;
    }
    // Keep scope valid if the selected habit was removed
    if (statsHabit && !state.habits.some(h => h.id === statsHabit.id)) statsHabit = null;
    const scope = statsHabit;
    const color = scope ? scope.color : ACCENT;

    // ---- Filter pills ----
    const pill = (label, active, dataAttr, dot) =>
      `<button class="stats-pill${active ? ' active' : ''}" ${dataAttr}>${dot ? `<span class="stats-dot" style="background:${dot}"></span>` : ''}${esc(label)}</button>`;
    const pills = `
      <div class="stats-filter">
        ${pill('All habits', !scope, 'data-action="stats-filter" data-habit="all"')}
        ${state.habits.map(h => pill(h.name, scope && scope.id === h.id, `data-action="stats-filter" data-habit="${h.id}"`, h.color)).join('')}
      </div>`;

    // ---- KPI tiles ----
    const today = todayStr();
    let tiles;
    if (!scope) {
      const doneToday = state.habits.filter(h => hasTick(h.id, today)).length;
      const total = state.habits.length;
      const r30 = scopeRate(null, 0, 30) ?? 0;
      const best = Math.max(0, ...state.habits.map(h => longestStreak(h.id)));
      tiles = [
        [`${doneToday}<span class="stat-sub">/${total}</span>`, 'Done today'],
        [`${Math.round(r30)}<span class="stat-sub">%</span>`, '30-day rate'],
        [`${best}<span class="stat-sub">d</span>`, 'Best streak'],
        [`${state.entries.size}`, 'Total ticks'],
      ];
    } else {
      tiles = [
        [`${currentStreak(scope.id)}<span class="stat-sub">d</span>`, 'Current streak'],
        [`${longestStreak(scope.id)}<span class="stat-sub">d</span>`, 'Longest streak'],
        [`${completionRate(scope.id, 30)}<span class="stat-sub">%</span>`, '30-day rate'],
        [`${tickDates(scope.id).length}`, 'Total ticks'],
      ];
    }
    // Add journaling KPIs to the top row when viewing all habits.
    if (!scope && window.journalScore) {
      const j = window.journalScore;
      const year = new Date().getFullYear();
      tiles.push(
        [`${j.streak()}<span class="stat-sub">d</span>`, 'Journal streak'],
        [`${j.longest()}<span class="stat-sub">d</span>`, 'Longest journal'],
        [`${j.yearCount(year)}`, `Entries ${year}`],
      );
    }
    // One-big-task KPIs (all-habits scope only).
    if (!scope && window.journalBig) {
      const b = window.journalBig;
      tiles.push(
        [`${b.streak()}<span class="stat-sub">d</span>`, 'Big-task streak'],
        [`${b.doneCount()}`, 'Big tasks done'],
      );
    }
    const overview = `<div class="stats-overview">${tiles.map(([v, l]) =>
      `<div class="stat-tile"><div class="num">${v}</div><div class="lbl">${l}</div></div>`).join('')}</div>`;

    // ---- Consistency trend (with momentum vs prior 4 weeks) ----
    const trend = trendSeries(scope, 56);
    const recent = scopeRate(scope, 0, 28), prior = scopeRate(scope, 28, 28);
    let momentum = '';
    if (recent !== null && prior !== null) {
      const delta = Math.round(recent - prior);
      const dir = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
      const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '→';
      momentum = `<span class="viz-delta ${dir}">${arrow} ${Math.abs(delta)}% vs prev 4 wks</span>`;
    }
    const trendCard = `
      <div class="stats-card">
        <div class="stats-card-head"><span class="stats-card-title">Consistency</span>${momentum}</div>
        <div class="stats-card-sub">7-day completion rate · last 8 weeks</div>
        ${areaFigure(trend, color)}
      </div>`;

    // ---- Weekly rhythm ----
    const rhythm = weekdayRhythm(scope, 84);
    const anyData = rhythm.some(r => r.has);
    const best = rhythm.reduce((b, r) => (r.v > b.v ? r : b), rhythm[0]);
    const rhythmCard = `
      <div class="stats-card">
        <div class="stats-card-head"><span class="stats-card-title">Weekly rhythm</span></div>
        <div class="stats-card-sub">${anyData ? `Most consistent on <strong>${esc(best.full)}</strong>` : 'Completion rate by weekday'}</div>
        ${barsFigure(rhythm, color)}
      </div>`;

    // ---- By-habit breakdown (all scope only) ----
    let breakdown = '';
    if (!scope && state.habits.length > 1) {
      const rows = state.habits
        .map(h => ({ h, r: completionRate(h.id, 30) }))
        .sort((a, b) => b.r - a.r)
        .map(({ h, r }) => `
          <button class="stats-rank" data-action="stats-filter" data-habit="${h.id}">
            <span class="stats-dot" style="background:${h.color}"></span>
            <span class="stats-rank-name">${esc(h.name)}</span>
            <span class="stats-rank-track"><span class="stats-rank-fill" style="width:${r}%;background:${h.color}"></span></span>
            <span class="stats-rank-pct">${r}%</span>
          </button>`).join('');
      breakdown = `
        <div class="stats-card">
          <div class="stats-card-head"><span class="stats-card-title">By habit</span></div>
          <div class="stats-card-sub">30-day completion · tap to focus</div>
          <div class="stats-rank-list">${rows}</div>
        </div>`;
    }

    root.innerHTML = pills + overview + trendCard + rhythmCard + breakdown + historyBlock(scope);
    wireStatsCharts(root);
  }

  // Pointer-driven crosshair/tooltip for the stats charts
  function wireStatsCharts(root) {
    root.querySelectorAll('.viz-area').forEach(svg => {
      const pts = JSON.parse(svg.dataset.pts), geo = JSON.parse(svg.dataset.geo);
      const wrap = svg.closest('.viz-wrap'), tip = wrap.querySelector('.viz-tip');
      const cross = svg.querySelector('.viz-cross'), cursor = svg.querySelector('.viz-cursor');
      const X = i => geo.padL + (i / (geo.n - 1)) * geo.pw;
      const Y = v => geo.padT + (1 - v / 100) * geo.ph;
      const move = e => {
        const rect = svg.getBoundingClientRect();
        const cx = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
        let i = Math.round((cx / rect.width) * (geo.n - 1));
        i = Math.max(0, Math.min(geo.n - 1, i));
        const p = pts[i], x = X(i), y = Y(p.v);
        cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.style.display = '';
        cursor.setAttribute('cx', x); cursor.setAttribute('cy', y); cursor.style.display = '';
        tip.innerHTML = `<strong>${p.v}%</strong> · ${esc(p.d)}`;
        tip.style.display = '';
        tip.style.left = Math.max(0, Math.min(rect.width - tip.offsetWidth, (x / geo.W) * rect.width - tip.offsetWidth / 2)) + 'px';
      };
      const hide = () => { cross.style.display = 'none'; cursor.style.display = 'none'; tip.style.display = 'none'; };
      svg.addEventListener('pointermove', move);
      svg.addEventListener('pointerdown', move);
      svg.addEventListener('pointerleave', hide);
    });
    root.querySelectorAll('.viz-bars').forEach(svg => {
      const wrap = svg.closest('.viz-wrap'), tip = wrap.querySelector('.viz-tip');
      svg.querySelectorAll('.viz-bar').forEach(g => {
        const show = e => {
          const rect = svg.getBoundingClientRect();
          const cx = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
          tip.innerHTML = `<strong>${g.dataset.v}%</strong> · ${esc(g.dataset.full)}`;
          tip.style.display = '';
          tip.style.left = Math.max(0, Math.min(rect.width - tip.offsetWidth, cx - tip.offsetWidth / 2)) + 'px';
          svg.querySelectorAll('.viz-bar').forEach(b => b.classList.toggle('on', b === g));
        };
        g.addEventListener('pointerenter', show);
        g.addEventListener('pointerdown', show);
      });
      svg.addEventListener('pointerleave', () => {
        tip.style.display = 'none';
        svg.querySelectorAll('.viz-bar').forEach(b => b.classList.remove('on'));
      });
    });
  }

  // ============================================================
  // Render all
  // ============================================================
  function renderAll() {
    renderProgress();
    renderToday();
    renderStats();
  }

  // Let journal.js refresh the Stats aggregates after a journal edit.
  window.renderStats = renderStats;

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
  // Morning view
  // ============================================================
  const morningState = {
    weather: null, weatherErr: null,
    calendar: { today: [], tomorrow: [] }, calErr: null,
    news: null, newsErr: null,
    events: null, eventsErr: null,
    reddit: null, redditErr: null,
    ra: null, raErr: null,
    transit: null, transitErr: null,
    record: null, recordErr: null,
    lastFetched: null,
  };

  // Persist calendar/news/events across page reloads (within the tab session)
  const MORNING_CACHE_KEY = 'habits.morning.v1';

  function loadMorningCache() {
    try {
      const raw = sessionStorage.getItem(MORNING_CACHE_KEY);
      if (!raw) return;
      const c = JSON.parse(raw);
      const restoreEvs = evs => (evs || []).map(ev => ({
        ...ev, startTime: ev.startTime ? new Date(ev.startTime) : null,
      }));
      morningState.weather   = c.weather || null;
      morningState.calendar  = { today: restoreEvs(c.calendar?.today), tomorrow: restoreEvs(c.calendar?.tomorrow) };
      morningState.news      = c.news    || null;
      morningState.events    = c.events  || null;
      morningState.reddit    = c.reddit  || null;
      morningState.ra        = c.ra      || null;
      morningState.lastFetched = c.lastFetched || null;
    } catch { /* ignore corrupt cache */ }
  }

  function saveMorningCache() {
    try {
      const serEvs = evs => evs.map(ev => ({
        ...ev, startTime: ev.startTime ? ev.startTime.toISOString() : null,
      }));
      sessionStorage.setItem(MORNING_CACHE_KEY, JSON.stringify({
        weather:  morningState.weather,
        calendar: { today: serEvs(morningState.calendar.today), tomorrow: serEvs(morningState.calendar.tomorrow) },
        news:     morningState.news,
        events:   morningState.events,
        reddit:   morningState.reddit,
        ra:       morningState.ra,
        lastFetched: morningState.lastFetched,
      }));
    } catch { /* ignore quota errors */ }
  }

  loadMorningCache();

  // wttr.in reports World Weather Online (WWO) codes (113–395), NOT WMO codes.
  // Map each to an icon; the human-readable label comes from wttr's own
  // weatherDesc, so a clear day never renders as a thunderstorm.
  const WWO_ICONS = {
    113: '☀️', 116: '🌤️', 119: '☁️', 122: '☁️', 143: '🌫️',
    176: '🌦️', 179: '🌨️', 182: '🌨️', 185: '🌧️', 200: '⛈️',
    227: '🌨️', 230: '❄️', 248: '🌫️', 260: '🌫️',
    263: '🌦️', 266: '🌧️', 281: '🌧️', 284: '🌧️',
    293: '🌦️', 296: '🌧️', 299: '🌧️', 302: '🌧️', 305: '🌧️', 308: '🌧️',
    311: '🌧️', 314: '🌧️', 317: '🌨️', 320: '🌨️',
    323: '🌨️', 326: '🌨️', 329: '❄️', 332: '❄️', 335: '❄️', 338: '❄️',
    350: '🧊', 353: '🌦️', 356: '🌧️', 359: '🌧️',
    362: '🌨️', 365: '🌨️', 368: '🌨️', 371: '❄️',
    374: '🧊', 377: '🧊', 386: '⛈️', 389: '⛈️', 392: '⛈️', 395: '⛈️',
  };

  function weatherInfo(code, desc, hour) {
    const h = hour !== undefined ? hour : new Date().getHours();
    const night = h < 6 || h >= 21;
    let icon = WWO_ICONS[code] || '☁️';
    if (night && code === 113) icon = '🌙';
    else if (night && code === 116) icon = '🌛';
    return { icon, desc: desc || 'Clear' };
  }

  const WEATHER_CITY_KEY = 'habits.weatherCity';

  async function fetchWeather() {
    const city = localStorage.getItem(WEATHER_CITY_KEY) || 'Paris';
    const resp = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`);
    if (!resp.ok) throw new Error(`Weather ${resp.status}`);
    morningState.weather = await resp.json();
  }

  function parseIcal(text) {
    // Unfold continuation lines (RFC 5545 §3.1)
    const unfolded = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
    const now        = new Date();
    const today      = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayStr   = fmtDate(today);
    const tomorrowStr = fmtDate(new Date(today.getTime() + 86400000));
    const todayEvs = [], tomorrowEvs = [];

    const blocks = unfolded.split('BEGIN:VEVENT');
    for (let i = 1; i < blocks.length; i++) {
      const block = blocks[i];
      // Extract property value (handles PROP;PARAM=x:VALUE and PROP:VALUE)
      const get = name => {
        const m = block.match(new RegExp(`^${name}(?:;[^:]*)?:([^\\r\\n]*)`, 'm'));
        return m ? m[1].trim() : null;
      };

      const summary = get('SUMMARY') || '(No title)';
      const dtstart = get('DTSTART');
      if (!dtstart) continue;

      // Parse date string: 20260515 or 20260515T120000[Z]
      const digits  = dtstart.replace(/[^0-9]/g, '');
      const dateStr = `${digits.slice(0,4)}-${digits.slice(4,6)}-${digits.slice(6,8)}`;
      const allDay  = dtstart.length === 8 || /VALUE=DATE/.test(block.split('DTSTART')[1]?.split('\n')[0] || '');

      let startTime = null;
      if (!allDay && digits.length >= 14) {
        const iso = `${digits.slice(0,4)}-${digits.slice(4,6)}-${digits.slice(6,8)}T${digits.slice(8,10)}:${digits.slice(10,12)}:${digits.slice(12,14)}${dtstart.endsWith('Z') ? 'Z' : ''}`;
        startTime = new Date(iso);
      }

      const ev = { summary, dateStr, allDay, startTime };
      if (dateStr === todayStr)    todayEvs.push(ev);
      else if (dateStr === tomorrowStr) tomorrowEvs.push(ev);
    }

    // Sort by start time (all-day events first)
    const sort = evs => evs.sort((a, b) => {
      if (a.allDay && !b.allDay) return -1;
      if (!a.allDay && b.allDay) return 1;
      return (a.startTime || 0) - (b.startTime || 0);
    });

    morningState.calendar = { today: sort(todayEvs), tomorrow: sort(tomorrowEvs) };
  }

  async function fetchCalendarEvents() {
    const url = window.JULIEN_CALENDAR_ICAL_URL;
    if (!url || url.startsWith('REPLACE_ME')) return;
    const proxy = `https://corsproxy.io/?url=${encodeURIComponent(url)}`;
    const resp  = await fetch(proxy);
    if (!resp.ok) throw new Error(`iCal fetch failed (${resp.status})`);
    const text = await resp.text();
    parseIcal(text);
  }

  async function fetchRSSFeed(rssUrl, count) {
    // Prefer corsproxy.io (returns raw XML, handles both RSS <item> and Atom
    // <entry>). Some feeds — e.g. feeds.thelocal.com — get 403'd by the proxy,
    // so fall back to rss2json (server-side parse to JSON) in that case.
    try {
      return await fetchRSSViaProxy(rssUrl, count);
    } catch (_) {
      return await fetchRSSViaJson(rssUrl, count);
    }
  }

  async function fetchRSSViaProxy(rssUrl, count) {
    const proxy = `https://corsproxy.io/?url=${encodeURIComponent(rssUrl)}`;
    const resp  = await fetch(proxy);
    if (!resp.ok) throw new Error(`RSS ${resp.status}`);
    const xml = await resp.text();
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    // RSS 2.0 uses <item>; Atom (e.g. Reddit) uses <entry>. Support both.
    let nodes = [...doc.querySelectorAll('item')];
    if (!nodes.length) nodes = [...doc.querySelectorAll('entry')];
    return nodes.slice(0, count || 5).map(el => {
      const text = sel => el.querySelector(sel)?.textContent?.trim() || '';
      // RSS: <link>url</link>. Atom: <link href="url"/>.
      let link = text('link');
      if (!link) link = el.querySelector('link')?.getAttribute('href') || '';
      const raw  = text('pubDate') || text('published') || text('updated');
      const d    = raw ? new Date(raw) : null;
      const pubDate = d && !isNaN(d)
        ? d.toLocaleDateString([], { month: 'short', day: 'numeric' })
        : '';
      return { title: text('title'), link, pubDate };
    });
  }

  async function fetchRSSViaJson(rssUrl, count) {
    const api  = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}`;
    const resp = await fetch(api);
    if (!resp.ok) throw new Error(`RSS ${resp.status}`);
    const data = await resp.json();
    if (data.status !== 'ok') throw new Error(`RSS ${data.message || 'error'}`);
    return (data.items || []).slice(0, count || 5).map(it => {
      // rss2json returns "YYYY-MM-DD HH:MM:SS" (UTC); normalize for Safari.
      const raw = it.pubDate || '';
      const d   = raw ? new Date(raw.replace(' ', 'T') + 'Z') : null;
      const pubDate = d && !isNaN(d)
        ? d.toLocaleDateString([], { month: 'short', day: 'numeric' })
        : '';
      return { title: it.title || '', link: it.link || '', pubDate };
    });
  }

  async function fetchNews() {
    try {
      morningState.news = await fetchRSSFeed('https://www.lemonde.fr/rss/une.xml', 5);
    } catch (err) {
      morningState.newsErr = err.message;
    }
  }

  async function fetchBerlinEvents() {
    try {
      morningState.events = await fetchRSSFeed('https://feeds.thelocal.com/rss/de', 5);
    } catch (err) {
      morningState.eventsErr = err.message;
    }
  }

  async function fetchReddit() {
    try {
      morningState.reddit = await fetchRSSFeed('https://www.reddit.com/r/worldnews/.rss', 5);
    } catch (err) {
      morningState.redditErr = err.message;
    }
  }

  async function fetchResidentAdvisor() {
    try {
      morningState.ra = await fetchRSSFeed('https://ra.co/xml/rss.xml', 5);
    } catch (err) {
      morningState.raErr = err.message;
    }
  }

  async function fetchBVGDepartures() {
    const now = new Date();
    const dow = now.getDay(); // 0=Sun, 6=Sat
    if (dow === 0 || dow === 6) { morningState.transit = []; return; }
    const STOP_ID = '900078102'; // Rathaus Neukölln U-Bahn (VBB DHID de:11000:900078102)
    // Request U-Bahn only. In this API every product flag defaults to true, so
    // `subway=true` alone does NOT exclude buses/trams — at a busy hub those
    // fill the `results` budget and crowd out the U7 departures we want.
    const products = 'subway=true&suburban=false&tram=false&bus=false&ferry=false&express=false&regional=false';
    const resp = await fetch(
      `https://v6.bvg.transport.rest/stops/${STOP_ID}/departures?duration=90&results=30&${products}`
    );
    if (!resp.ok) throw new Error(`BVG ${resp.status}`);
    const data = await resp.json();
    morningState.transit = (data.departures || [])
      .filter(d => d.line?.name?.replace(/\s+/g, '') === 'U7'
                && d.direction?.toLowerCase().includes('spandau'))
      .slice(0, 3);
  }

  async function fetchDiscogsRecord() {
    const username = window.DISCOGS_USERNAME;
    const token    = window.DISCOGS_TOKEN;
    if (!username || username.startsWith('REPLACE_ME') || !token || token.startsWith('REPLACE_ME')) return;
    const headers = {
      'Authorization': `Discogs token=${token}`,
      'User-Agent': 'HabitsApp/1.0 +https://julienvarin.github.io/habits/',
    };
    // 1. Get total count
    const r1 = await fetch(
      `https://api.discogs.com/users/${encodeURIComponent(username)}/collection/folders/0/releases?per_page=1&page=1`,
      { headers }
    );
    if (!r1.ok) throw new Error(`Discogs ${r1.status}`);
    const d1    = await r1.json();
    const total = d1.pagination?.items || 0;
    if (!total) { morningState.record = null; return; }
    // 2. Pick today's record (stable for the day)
    const today = new Date();
    const seed  = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
    const idx   = seed % total;
    const r2    = await fetch(
      `https://api.discogs.com/users/${encodeURIComponent(username)}/collection/folders/0/releases?per_page=1&page=${idx + 1}&sort=added&sort_order=asc`,
      { headers }
    );
    if (!r2.ok) throw new Error(`Discogs ${r2.status}`);
    const d2  = await r2.json();
    const rel = d2.releases?.[0];
    if (!rel) { morningState.record = null; return; }
    const info      = rel.basic_information;
    const releaseId = info.id;
    const notes     = (rel.notes || []).map(n => n.value).filter(Boolean).join(' · ');
    // 3. Get release details for country
    let country = '';
    try {
      const r3 = await fetch(`https://api.discogs.com/releases/${releaseId}`, { headers });
      if (r3.ok) { const d3 = await r3.json(); country = d3.country || ''; }
    } catch { /* country is optional */ }
    morningState.record = {
      artist:     (info.artists || []).map(a => a.name.replace(/\s*\(\d+\)$/, '')).join(', ') || 'Unknown',
      title:      info.title,
      year:       info.year,
      country,
      styles:     info.styles?.length ? info.styles : (info.genres || []),
      cover:      info.cover_image || info.thumb || '',
      discogsUrl: `https://www.discogs.com/release/${releaseId}`,
      notes,
    };
  }

  function buildYearGrid() {
    const now      = new Date();
    const year     = now.getFullYear();
    const yearStart = new Date(year, 0, 1);
    const isLeap   = new Date(year, 2, 0).getDate() === 29;
    const totalWeeks = isLeap ? 53 : 52;
    const dayOfYear  = Math.floor((now - yearStart) / 86400000); // 0-indexed
    const currentWeek = Math.floor(dayOfYear / 7);               // 0-indexed

    // Pad to next multiple of 13 (grid columns)
    const totalCells = Math.ceil(totalWeeks / 13) * 13;

    const cells = Array.from({ length: totalCells }, (_, w) => {
      if (w >= totalWeeks) return `<div class="year-week-cell empty"></div>`;
      const cls = w < currentWeek ? 'past' : w === currentWeek ? 'current' : '';
      return `<div class="year-week-cell${cls ? ' ' + cls : ''}"></div>`;
    }).join('');

    return `<div class="year-week-grid">${cells}</div>`;
  }

  function greeting(hour) {
    const h = hour !== undefined ? hour : new Date().getHours();
    if (h >= 5 && h < 12)  return 'Good morning';
    if (h >= 12 && h < 18) return 'Good afternoon';
    return 'Good evening';
  }

  function formatAgo(ts) {
    const mins = Math.floor((Date.now() - ts) / 60000);
    if (mins < 1)  return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)  return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  // Shimmer placeholders shown while a card's data loads
  const skelLines = widths =>
    `<div class="skel-list">${widths.map(w => `<div class="skel-line" style="width:${w}"></div>`).join('')}</div>`;
  const skelWeather = () => `
    <div class="skel-weather">
      <div class="skel-wmain">
        <div class="skel-block skel-icon"></div>
        <div class="skel-wtext">
          <div class="skel-line" style="width:52%;height:30px"></div>
          <div class="skel-line" style="width:64%"></div>
        </div>
      </div>
      <div class="skel-wgrid">
        <div class="skel-block"></div><div class="skel-block"></div>
        <div class="skel-block"></div><div class="skel-block"></div>
      </div>
    </div>`;

  function renderMorning() {
    const root = document.getElementById('view-morning');

    // ---- Year progress ----
    const now        = new Date();
    const yearStart  = new Date(now.getFullYear(), 0, 1);
    const yearEnd    = new Date(now.getFullYear() + 1, 0, 1);
    const pct        = ((now - yearStart) / (yearEnd - yearStart) * 100).toFixed(1);
    const dayOfYear  = Math.floor((now - yearStart) / 86400000) + 1;
    const isLeap     = new Date(now.getFullYear(), 2, 0).getDate() === 29;
    const daysInYear = isLeap ? 366 : 365;

    const yearCard = `
      <div class="year-progress-card">
        <div class="year-progress-label">
          <span class="year-title">Day ${dayOfYear} of ${daysInYear}</span>
          <span class="year-meta">${pct}% of ${now.getFullYear()}</span>
        </div>
        ${buildYearGrid()}
      </div>`;

    // ---- Weather ----
    let weatherBody;
    if (morningState.weatherErr) {
      weatherBody = `<p class="morning-error">${esc(morningState.weatherErr)}</p>`;
    } else if (!morningState.weather) {
      weatherBody = skelWeather();
    } else {
      const w     = morningState.weather;
      const cur   = w.current_condition[0];
      const day   = w.weather[0];
      const area  = w.nearest_area[0];
      const city  = area.areaName[0].value;
      const hour  = new Date().getHours();
      const wdesc = cur.weatherDesc?.[0]?.value?.trim() || '';
      const wx    = weatherInfo(parseInt(cur.weatherCode, 10), wdesc, hour);
      const rain  = day.hourly.reduce((s, h) => s + parseFloat(h.precipMM), 0);
      const astro = day.astronomy[0];
      weatherBody = `
        <div class="weather-main">
          <span class="weather-icon">${wx.icon}</span>
          <div>
            <div class="weather-temp-big">${cur.temp_C}<sup>°C</sup></div>
            <div class="weather-desc">${esc(wx.desc)}</div>
            ${cur.FeelsLikeC ? `<div class="weather-feels">Feels like ${cur.FeelsLikeC}°</div>` : ''}
            <button class="weather-location" data-action="change-city" aria-label="Change city">
              <svg class="weather-pin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="2.5"/>
              </svg>
              <span class="weather-city">${esc(city)}</span>
            </button>
          </div>
        </div>
        <div class="weather-details">
          <div class="weather-detail"><span class="wk">High</span><span class="wv">${day.maxtempC}°</span></div>
          <div class="weather-detail"><span class="wk">Low</span><span class="wv">${day.mintempC}°</span></div>
          <div class="weather-detail"><span class="wk">Rain</span><span class="wv">${rain > 0 ? rain.toFixed(1) + ' mm' : 'None'}</span></div>
          <div class="weather-detail"><span class="wk">Wind</span><span class="wv">${cur.windspeedKmph} km/h</span></div>
        </div>
        <div class="weather-sun-row">
          <span><span class="sun-k">Sunrise</span> ${esc(astro.sunrise)}</span>
          <span><span class="sun-k">Sunset</span> ${esc(astro.sunset)}</span>
        </div>`;
    }

    // ---- Calendar ----
    let calBody;
    if (!window.JULIEN_CALENDAR_ICAL_URL || window.JULIEN_CALENDAR_ICAL_URL.startsWith('REPLACE_ME')) {
      calBody = `<p class="cal-setup-note">Add <code>JULIEN_CALENDAR_ICAL_URL</code> to <code>config.js</code> to connect your calendar.</p>`;
    } else if (morningState.calErr) {
      calBody = `<p class="morning-error">${esc(morningState.calErr)}</p>`;
    } else if (!morningState.calendar.today.length && !morningState.calendar.tomorrow.length && !morningState.calErr) {
      calBody = skelLines(['45%','80%','62%','45%','70%']);
    } else {
      function renderDayEvents(evs, label) {
        const items = evs.map(ev => {
          const time = ev.allDay
            ? 'All day'
            : ev.startTime
              ? ev.startTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              : '';
          return `<div class="cal-event">
            <span class="cal-event-time">${time}</span>
            <span class="cal-event-title">${esc(ev.summary)}</span>
          </div>`;
        }).join('');
        return `<div class="cal-day-section">
          <div class="cal-day-label">${label}</div>
          ${items || '<p class="cal-no-meetings">No meetings</p>'}
        </div>`;
      }
      calBody = renderDayEvents(morningState.calendar.today, 'Today') +
                renderDayEvents(morningState.calendar.tomorrow, 'Tomorrow');
    }

    // ---- News ----
    let newsBody;
    if (morningState.newsErr) {
      newsBody = `<p class="morning-error">${esc(morningState.newsErr)}</p>`;
    } else if (!morningState.news) {
      newsBody = skelLines(['88%','72%','80%','66%','78%']);
    } else {
      newsBody = morningState.news.map(item => `
        <div class="news-item">
          <a href="${esc(item.link)}" target="_blank" rel="noopener noreferrer">
            <div class="news-title">${esc(item.title)}</div>
          </a>
        </div>`).join('');
    }

    // ---- Berlin events ----
    let eventsBody;
    if (morningState.eventsErr) {
      eventsBody = `<p class="morning-error">${esc(morningState.eventsErr)}</p>`;
    } else if (!morningState.events) {
      eventsBody = skelLines(['82%','70%','86%','64%']);
    } else {
      eventsBody = morningState.events.map(item => `
        <div class="news-item">
          <a href="${esc(item.link)}" target="_blank" rel="noopener noreferrer">
            <div class="news-title">${esc(item.title)}</div>
          </a>
        </div>`).join('');
    }

    // ---- Reddit ----
    let redditBody;
    if (morningState.redditErr) {
      redditBody = `<p class="morning-error">${esc(morningState.redditErr)}</p>`;
    } else if (!morningState.reddit) {
      redditBody = skelLines(['84%','70%','88%','62%','76%']);
    } else {
      redditBody = morningState.reddit.map(item => `
        <div class="news-item">
          <a href="${esc(item.link)}" target="_blank" rel="noopener noreferrer">
            <div class="news-title">${esc(item.title)}</div>
          </a>
        </div>`).join('');
    }

    // ---- Resident Advisor ----
    let raBody;
    if (morningState.raErr) {
      raBody = `<p class="morning-error">${esc(morningState.raErr)}</p>`;
    } else if (!morningState.ra) {
      raBody = skelLines(['80%','66%','84%','72%']);
    } else {
      raBody = morningState.ra.map(item => `
        <div class="news-item">
          <a href="${esc(item.link)}" target="_blank" rel="noopener noreferrer">
            <div class="news-title">${esc(item.title)}</div>
          </a>
        </div>`).join('');
    }

    // ---- Transit ----
    const todayDow = new Date().getDay();
    let transitBody;
    if (todayDow === 0 || todayDow === 6) {
      transitBody = `<p class="morning-muted">Weekdays only.</p>`;
    } else if (morningState.transitErr) {
      transitBody = `<p class="morning-error">${esc(morningState.transitErr)}</p>`;
    } else if (morningState.transit === null) {
      transitBody = skelLines(['60%','55%','50%']);
    } else if (!morningState.transit.length) {
      transitBody = `<p class="morning-muted">No upcoming U7 → Spandau departures.</p>`;
    } else {
      const nowMs = Date.now();
      transitBody = morningState.transit.map(d => {
        const when    = d.when    ? new Date(d.when)    : null;
        const planned = d.plannedWhen ? new Date(d.plannedWhen) : null;
        const timeStr = (when || planned)?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) || '—';
        const minsAway = when ? Math.round((when - nowMs) / 60000) : null;
        const delayMin = d.delay ? Math.round(d.delay / 60) : 0;
        const delayCls = delayMin > 0 ? 'late' : delayMin < 0 ? 'early' : 'on-time';
        const delayStr = delayMin > 0 ? `+${delayMin}m` : delayMin < 0 ? `${delayMin}m` : 'On time';
        return `<div class="transit-row">
          <span class="transit-time">${timeStr}</span>
          ${minsAway !== null ? `<span class="transit-mins">in ${minsAway} min</span>` : ''}
          <span class="transit-delay ${delayCls}">${delayStr}</span>
        </div>`;
      }).join('');
    }

    // ---- Record of the Day ----
    let recordBody;
    if (!window.DISCOGS_USERNAME || window.DISCOGS_USERNAME.startsWith('REPLACE_ME')) {
      recordBody = `<p class="cal-setup-note">Add <code>DISCOGS_USERNAME</code> and <code>DISCOGS_TOKEN</code> to <code>config.js</code>.</p>`;
    } else if (morningState.recordErr) {
      recordBody = `<p class="morning-error">${esc(morningState.recordErr)}</p>`;
    } else if (morningState.record === null) {
      recordBody = skelLines(['70%','85%','50%']);
    } else if (!morningState.record) {
      recordBody = `<p class="morning-muted">Collection is empty.</p>`;
    } else {
      const r = morningState.record;
      const styleTags = r.styles.map(s => `<span class="record-style-tag">${esc(s)}</span>`).join('');
      recordBody = `
        <div class="record-body">
          ${r.cover ? `<a href="${esc(r.discogsUrl)}" target="_blank" rel="noopener noreferrer" class="record-cover-link">
            <img src="${esc(r.cover)}" class="record-cover" alt="cover" loading="lazy">
          </a>` : ''}
          <div class="record-info">
            <div class="record-artist">${esc(r.artist)}</div>
            <div class="record-title">${esc(r.title)}</div>
            <div class="record-meta">
              ${r.year ? `<span>${r.year}</span>` : ''}
              ${r.country ? `<span>${esc(r.country)}</span>` : ''}
            </div>
            ${styleTags ? `<div class="record-styles">${styleTags}</div>` : ''}
          </div>
        </div>
        ${r.notes ? `<p class="record-notes">${esc(r.notes)}</p>` : ''}`;
    }

    // ---- Freshness / refresh ----
    const refreshing = !morningState.lastFetched;
    const refreshRow = `
      <div class="morning-refresh">
        <span class="morning-updated">${refreshing ? 'Updating…' : `Updated ${formatAgo(morningState.lastFetched)}`}</span>
        <button class="morning-refresh-btn${refreshing ? ' spinning' : ''}" data-action="refresh-morning" aria-label="Refresh" ${refreshing ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>
          </svg>
        </button>
      </div>`;

    root.innerHTML = `
      <div class="morning-grid">
        ${yearCard}
        ${refreshRow}
        <div class="morning-card">
          <div class="morning-card-title">Weather</div>
          ${weatherBody}
        </div>
        <div class="morning-card">
          <div class="morning-card-title">Calendar</div>
          ${calBody}
        </div>
        <div class="morning-card">
          <div class="morning-card-title">U7 → Spandau</div>
          ${transitBody}
        </div>
        <div class="morning-card">
          <div class="morning-card-title">Record of the Day</div>
          ${recordBody}
        </div>
        <div class="morning-card">
          <div class="morning-card-title">Actualités</div>
          ${newsBody}
        </div>
        <div class="morning-card">
          <div class="morning-card-title">Germany / Berlin</div>
          ${eventsBody}
        </div>
        <div class="morning-card">
          <div class="morning-card-title">Reddit</div>
          ${redditBody}
        </div>
        <div class="morning-card">
          <div class="morning-card-title">Resident Advisor</div>
          ${raBody}
        </div>
      </div>`;
  }

  async function initMorningView() {
    const STALE_MS = 30 * 60 * 1000;
    const stale    = !morningState.lastFetched || (Date.now() - morningState.lastFetched > STALE_MS);

    if (stale) {
      morningState.weather  = null; morningState.weatherErr = null;
      morningState.news     = null; morningState.newsErr    = null;
      morningState.events   = null; morningState.eventsErr  = null;
      morningState.reddit   = null; morningState.redditErr  = null;
      morningState.ra       = null; morningState.raErr      = null;
      morningState.calErr   = null;
      morningState.calendar = { today: [], tomorrow: [] };
      morningState.record   = null; morningState.recordErr  = null;
    }
    // Transit is always refreshed (time-sensitive)
    morningState.transit = null; morningState.transitErr = null;

    renderMorning();

    const fetches = [
      fetchBVGDepartures().catch(err => { morningState.transitErr = err.message; }),
    ];
    if (stale) {
      fetches.push(
        fetchWeather().catch(err => { morningState.weatherErr = err.message; }),
        fetchCalendarEvents().catch(err => { morningState.calErr = err.message; }),
        fetchNews(),
        fetchBerlinEvents(),
        fetchReddit(),
        fetchResidentAdvisor(),
        fetchDiscogsRecord().catch(err => { morningState.recordErr = err.message; }),
      );
    }

    await Promise.all(fetches);

    if (stale) {
      morningState.lastFetched = Date.now();
      saveMorningCache();
    }

    renderMorning();
  }

  // ============================================================
  // Event delegation
  // ============================================================
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action, id, date } = el.dataset;

    if (action === 'refresh-morning') {
      morningState.lastFetched = null;
      initMorningView();
    } else if (action === 'change-city') {
      const current = localStorage.getItem(WEATHER_CITY_KEY) || 'Paris';
      const city = prompt('Change weather city:', current);
      if (city && city.trim()) {
        localStorage.setItem(WEATHER_CITY_KEY, city.trim());
        morningState.weather = null;
        morningState.weatherErr = null;
        renderMorning();
        fetchWeather().catch(err => { morningState.weatherErr = err.message; }).then(() => renderMorning());
      }
    } else if (action === 'toggle') {
      if (e.target.closest('[data-action="edit"]')) return;
      toggle(id, todayStr());
    } else if (action === 'toggle-bigtask') {
      if (window.journalBig) { window.journalBig.toggleToday(); renderAll(); }
    } else if (action === 'edit') {
      e.stopPropagation();
      openModal(state.habits.find(h => h.id === id));
    } else if (action === 'toggle-day') {
      toggle(id, date);
    } else if (action === 'today-week-back') {
      state.todayWeekOffset++;
      renderToday();
    } else if (action === 'today-week-fwd') {
      if (state.todayWeekOffset > 0) { state.todayWeekOffset--; renderToday(); }
    } else if (action === 'stats-filter') {
      const h = el.dataset.habit;
      statsHabit = h === 'all' ? null : state.habits.find(x => x.id === h) || null;
      renderStats();
    }
  });

  // Tab switching
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.view;
      if (state.view === v) return;
      if (state.view === 'today' && v !== 'today') state.todayWeekOffset = 0;
      state.view = v;

      document.querySelectorAll('.tab').forEach(t => {
        t.classList.toggle('active', t === btn);
        t.setAttribute('aria-selected', t === btn ? 'true' : 'false');
      });
      document.querySelectorAll('.view').forEach(s => s.classList.remove('active'));
      document.getElementById(`view-${v}`).classList.add('active');

      const titles = { morning:'Morning', today:'Today', todo:'Todo', stats:'Stats' };
      document.getElementById('page-title').textContent =
        v === 'morning' ? greeting() : (titles[v] || v);

      // Show/hide FAB
      document.getElementById('fab').style.display = v === 'today' ? '' : 'none';

      if (v === 'morning') initMorningView();
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

  // Re-fetch when the tab becomes visible / focused (picks up changes made on another device).
  // visibilitychange is more reliable than focus in iOS PWAs.
  function refetchOnReturn() {
    if (document.visibilityState !== 'visible') return;
    if (!state.loading) load();
    if (state.view === 'morning') initMorningView();
    if (window.syncTodos) window.syncTodos();
    if (window.syncJournal) window.syncJournal();
  }
  window.addEventListener('focus', refetchOnReturn);
  document.addEventListener('visibilitychange', refetchOnReturn);

  // ============================================================
  // Date label
  // ============================================================
  document.getElementById('date-label').textContent =
    new Date().toLocaleDateString(undefined, { weekday:'long', month:'short', day:'numeric' });

  // ============================================================
  // Init
  // ============================================================
  load();
  if (window.initTodo) window.initTodo();
  if (window.initJournal) window.initJournal();
})();
