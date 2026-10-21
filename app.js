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
    bigTaskDayOffset: 0,  // 0 = today, +1 = yesterday, etc.
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
  // Flame icon — a fire streak marker tinted to the task's colour
  // theme (replaces the fixed-colour 🔥 emoji so it inherits --c).
  // ============================================================
  function flameIcon(color) {
    return `<svg class="flame-ico" viewBox="0 0 16 16" width="1em" height="1em" ` +
      `fill="${color || 'currentColor'}" aria-hidden="true">` +
      `<path d="M8 16c3.314 0 6-2 6-5.5 0-1.5-.5-4-2.5-6 .25 1.5-1.25 2-1.25 2C11 4 9 ` +
      `.5 6 0c.357 2 .5 4-2 6-1.25 1-2 2.729-2 4.5C2 14 4.686 16 8 16m0-1c-1.657 ` +
      `0-3-1-3-2.75 0-.75.25-2 1.25-3C6.125 10 7 10.5 7 10.5c-.375-1.25.5-3.25 ` +
      `2-3.5-.179 1-.25 2 1 3 .625.5 1 1.364 1 2.25C11 14 9.657 15 8 15"/></svg>`;
  }

  // ============================================================
  // Toast
  // ============================================================
  // action: optional { label, fn }, e.g. Undo. Toasts with an action stay a bit
  // longer; onExpire runs when one goes away without its action being tapped.
  const toastEl = document.getElementById('toast');
  const toastAct = document.getElementById('toast-act');
  let toastTimer, toastAction = null, toastExpire = null;
  function toast(msg, duration = 2600, action) {
    if (toastExpire) { const f = toastExpire; toastExpire = null; f(); }
    document.getElementById('toast-msg').textContent = msg;
    toastAction = action ? action.fn : null;
    toastExpire = action && action.onExpire ? action.onExpire : null;
    toastAct.hidden = !action;
    if (action) toastAct.textContent = action.label;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.hidden = true; toastAction = null;
      if (toastExpire) { const f = toastExpire; toastExpire = null; f(); }
    }, action ? 5000 : duration);
  }
  toastAct.addEventListener('click', () => {
    const fn = toastAction;
    toastEl.hidden = true; toastAction = null; toastExpire = null;
    clearTimeout(toastTimer);
    if (fn) fn();
  });
  window.toast = toast;

  function haptic() { if (navigator.vibrate) { try { navigator.vibrate(8); } catch { /* ignore */ } } }

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
      document.getElementById('today-main').innerHTML = setupBanner();
      document.getElementById('habits-body').innerHTML = setupBanner();
      return;
    }

    if (state.loading) { showLoader('today-main'); showLoader('habits-body'); }

    try {
      const [habits, entries] = await Promise.all([db.listHabits(), db.listEntries()]);
      // A habit deleted a moment ago stays hidden while its Undo is on offer.
      state.habits  = (habits || []).filter(h => !pendingHabitDelete || h.id !== pendingHabitDelete.habit.id);
      state.entries = new Set((entries || []).map(e => entryKey(e.habit_id, e.date)));
      state.loading = false;
      renderAll();
      flushQueue();
    } catch (err) {
      console.error(err);
      if (!state.loading) return; // keep what's on screen; it's only a refresh
      const msg = `
        <div class="empty">
          <div class="empty-icon">⚠️</div>
          <h2>Couldn't connect</h2>
          <p>${esc(err.message)}</p>
        </div>`;
      document.getElementById('today-main').innerHTML = msg;
      document.getElementById('habits-body').innerHTML = msg;
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

  // ---- Weekly habits ----
  // A habit with per_week = N (1..6) is done N times a week, Monday–Sunday.
  // Its streak counts weeks in a row that hit N; the week in progress only
  // extends the streak once it's hit, and never breaks it.
  function habitById(id) { return state.habits.find(h => h.id === id); }
  function isWeekly(h) { return !!h && h.per_week >= 1 && h.per_week <= 6; }
  function mondayOf(d) { const r = new Date(d); r.setHours(0, 0, 0, 0); return shiftDays(r, -((r.getDay() + 6) % 7)); }
  function weekCount(habitId, monday) {
    let n = 0;
    for (let i = 0; i < 7; i++) if (hasTick(habitId, fmtDate(shiftDays(monday, i)))) n++;
    return n;
  }
  function weekMet(h, monday) { return weekCount(h.id, monday) >= h.per_week; }

  function currentWeekStreak(h) {
    let monday = mondayOf(new Date());
    let n = 0;
    if (weekMet(h, monday)) n++;
    monday = shiftDays(monday, -7);
    while (weekMet(h, monday)) { n++; monday = shiftDays(monday, -7); }
    return n;
  }

  function longestWeekStreak(h) {
    const dates = tickDates(h.id);
    if (!dates.length) return 0;
    let monday = mondayOf(new Date(dates[0] + 'T00:00:00'));
    const end = mondayOf(new Date());
    let best = 0, cur = 0;
    while (monday <= end) {
      if (weekMet(h, monday)) { cur++; if (cur > best) best = cur; }
      else if (monday < end) cur = 0; // the week in progress doesn't break it
      monday = shiftDays(monday, 7);
    }
    return best;
  }

  // Share of the weekly target reached in the week containing `dstr` (0..1).
  // The week in progress is judged against a pro-rated target, so being at
  // 1/3 on a Tuesday isn't scored as failing.
  function weekFraction(h, dstr) {
    const d = new Date(dstr + 'T00:00:00');
    const monday = mondayOf(d);
    const count = weekCount(h.id, monday);
    const thisMonday = mondayOf(new Date());
    let target = h.per_week;
    if (+monday === +thisMonday) {
      const elapsed = ((new Date().getDay() + 6) % 7) + 1; // Mon=1 … Sun=7
      target = Math.max(1, Math.ceil(h.per_week * elapsed / 7));
    }
    return Math.min(1, count / target);
  }

  function streakLabel(h) {
    const streak = isWeekly(h) ? currentWeekStreak(h) : currentStreak(h.id);
    const unit = isWeekly(h) ? 'w' : '';
    return { streak, text: `${streak}${unit}` };
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
    const weekly = isWeekly(h);
    const done   = hasTick(h.id, today);
    const { streak, text: streakText } = streakLabel(h);
    const lng    = weekly ? longestWeekStreak(h) : longestStreak(h.id);
    const isRecord = streak > 0 && streak >= lng && lng > 0;
    const unitWord = weekly ? 'week' : 'day';
    // Weekly habits show progress for the week on screen (week nav offset).
    const shownMonday = shiftDays(mondayOf(new Date()), -7 * state.todayWeekOffset);
    const wCount = weekly ? weekCount(h.id, shownMonday) : 0;
    const wMet   = weekly && wCount >= h.per_week;
    const that   = state.todayWeekOffset ? 'that' : 'this';
    const met    = weekly ? wMet : done;
    const sub = weekly
      ? (wMet ? `✓ Done ${that} week · ${wCount}/${h.per_week}` : `${wCount}/${h.per_week} ${that} week`)
      : (done ? '✓ Done today' : streak > 0 ? 'Not yet today' : 'Every day');

    return `
      <div class="habit-card ${met ? 'done' : ''}" style="--c:${h.color}" data-habit-id="${h.id}">
        <div class="card-header">
          <div class="card-drag-handle" aria-label="Drag to reorder">⠿</div>
          <button class="card-color-dot" data-action="toggle" data-id="${h.id}"
                  aria-label="${done ? 'Untick' : 'Tick'} ${esc(h.name)} today">${met ? '✓' : esc((h.name.trim()[0] || '·').toUpperCase())}</button>
          <div class="card-main">
            <h2 class="card-name">${esc(h.name)}</h2>
            <div class="card-sub${met ? ' met' : ''}">${sub}</div>
          </div>
          ${streak > 0
            ? `<span class="card-streak-badge${isRecord ? ' record' : ''}"
                     title="${streak} ${unitWord}${streak===1?'':'s'} in a row${isRecord?' — new record!':''}">${flameIcon(h.color)} ${streakText}</span>`
            : ''}
          <button class="card-edit-btn" data-action="edit" data-id="${h.id}" aria-label="Edit ${esc(h.name)}">···</button>
        </div>

        ${buildCardCal(h.id, h.color)}
      </div>`;
  }

  // "One big task" — the big task on day D is whatever was written as
  // "one thing to do tomorrow" in day D-1's journal entry. state.bigTaskDayOffset
  // selects which day the tile shows (0 = today, +1 = yesterday, …).
  function selectedBigTaskDate() {
    return fmtDate(shiftDays(new Date(), -state.bigTaskDayOffset));
  }
  function bigTaskDayLabel(dstr) {
    if (dstr === todayStr()) return 'Today';
    const yStr = fmtDate(shiftDays(new Date(), -1));
    if (dstr === yStr) return 'Yesterday';
    return new Date(dstr + 'T00:00:00').toLocaleDateString(undefined,
      { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function buildBigTaskNav(dstr) {
    const off = state.bigTaskDayOffset;
    return `
      <div class="bigtask-nav">
        ${off > 0 ? `<button class="bigtask-today-btn" data-action="bigtask-today">Today</button>` : ''}
        <button class="bigtask-nav-btn" data-action="bigtask-prev" aria-label="Previous day">‹</button>
        <span class="bigtask-nav-label${off > 0 ? ' past' : ''}">${esc(bigTaskDayLabel(dstr))}</span>
        <button class="bigtask-nav-btn" data-action="bigtask-next" aria-label="Next day" ${off === 0 ? 'disabled' : ''}>›</button>
      </div>`;
  }
  function buildBigTaskTile() {
    const jb = window.journalBig;
    if (!jb) return '';
    const dstr = selectedBigTaskDate();
    const text = jb.textFor(dstr);
    const done = jb.doneFor(dstr);
    const head = `<div class="sec-head" id="bigtask-head"><h2>One big task</h2>${buildBigTaskNav(dstr)}</div>`;
    if (!text) {
      const isToday = state.bigTaskDayOffset === 0;
      const msg = isToday
        ? 'Write “Something to do tomorrow” in your journal below. It shows up here tomorrow.'
        : 'No big task set for this day.';
      return head + `
        <div class="bigtask-tile empty">
          <p class="bigtask-empty"><span class="bt-ico">◎</span><span>${msg}</span></p>
        </div>`;
    }
    return head + `
      <div class="bigtask-tile ${done ? 'done' : ''}">
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

  // ============================================================
  // Hero: today's habits at a glance
  // ============================================================
  function dailyHabits() { return state.habits.filter(h => !isWeekly(h)); }

  function weeklyTotals(monday) {
    const weekly = state.habits.filter(isWeekly);
    return {
      done:  weekly.reduce((n, h) => n + Math.min(weekCount(h.id, monday), h.per_week), 0),
      total: weekly.reduce((n, h) => n + h.per_week, 0),
    };
  }

  function timeLeftToday() {
    const now = new Date(), midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const mins = Math.max(1, Math.round((midnight - now) / 60000));
    return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
  }

  // "Read, Run and Stretch" (and "+2 more" past three).
  function listNames(names) {
    const shown = names.slice(0, 3), more = names.length - shown.length;
    if (more > 0) return `${shown.join(', ')} +${more} more`;
    return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0] || '';
  }

  function ringSvg(frac) {
    const C = 2 * Math.PI * 50, f = Math.max(0, Math.min(1, frac));
    return `<svg viewBox="0 0 120 120" aria-hidden="true">
      <circle cx="60" cy="60" r="50" class="ring-track"/>
      ${f > 0 ? `<circle cx="60" cy="60" r="50" class="ring-fill" stroke-dasharray="${(f * C).toFixed(1)} ${C.toFixed(1)}"/>` : ''}
    </svg>`;
  }

  function buildHero() {
    if (!state.habits.length) {
      return `
        <div class="hero">
          <div class="hero-top"><span class="hero-pill">Today</span></div>
          <div class="hero-mid"><div class="hero-text">
            <div class="hero-label">No habits yet</div>
            <div class="hero-big">Start small</div>
            <div class="hero-of">One thing a day, ticked here.</div>
          </div></div>
          <button class="hero-cta" data-action="add-habit">Add your first habit ›</button>
        </div>`;
    }
    const today = todayStr();
    const daily = dailyHabits();
    const week  = weeklyTotals(mondayOf(new Date()));
    // The ring follows daily habits; with only weekly ones, it follows the week.
    const byDay = daily.length > 0;
    const done  = byDay ? daily.filter(h => hasTick(h.id, today)).length : week.done;
    const total = byDay ? daily.length : week.total;
    const left  = total - done;
    const hour  = new Date().getHours();
    const [status, cls] = !left ? ['All done', '']
      : hour >= 18 ? [`${left} to go tonight`, 'warn']
      : [`${done} of ${total} done`, 'calm'];
    const daysLeft = 7 - ((new Date().getDay() + 6) % 7);
    const unit = byDay ? 'habit' : 'tick';

    // Longest streak running right now, and the last 7 days against the 7 before.
    let best = null;
    for (const h of state.habits) {
      const { streak } = streakLabel(h);
      if (streak > 0 && (!best || streak > best.streak)) best = { h, streak };
    }
    const r7 = scopeRate(null, 0, 7), p7 = scopeRate(null, 7, 7);
    const delta = r7 !== null && p7 !== null ? Math.round(r7 - p7) : null;

    return `
      <div class="hero">
        <div class="hero-top">
          <span class="hero-pill">${byDay ? "Today's habits" : 'This week'}</span>
          <span class="hero-status ${cls}">${status}</span>
        </div>
        <div class="hero-mid">
          <button class="ring" data-action="quick-check" aria-label="Check today's habits">${ringSvg(total ? done / total : 0)}
            <div class="ring-label"><div class="ring-pct">${total ? Math.round((done / total) * 100) : 0}%</div><div class="ring-sub">done</div></div>
          </button>
          <div class="hero-text">
            <div class="hero-label">${left ? (byDay ? 'Left today' : 'Left this week') : (byDay ? 'Today' : 'This week')}</div>
            <div class="hero-big">${left ? `${left}<small> ${unit}${left > 1 ? 's' : ''}</small>` : 'All done'}</div>
            <div class="hero-of">${left ? `of ${total} · ${byDay ? `${timeLeftToday()} left` : `${daysLeft} day${daysLeft > 1 ? 's' : ''} left`}` : 'Everything ticked. Nice.'}</div>
            ${byDay && week.total ? `<div class="hero-of faint">Weekly goals: ${week.done}/${week.total} this week</div>` : ''}
          </div>
        </div>
        <div class="hero-tiles">
          <button class="hero-tile" data-action="go-stats" ${best ? `data-habit="${best.h.id}"` : ''}>
            <div class="ht-label">Best streak${best ? ` · ${esc(best.h.name)}` : ''}</div>
            <div class="ht-val">${best ? `${best.streak}<small> ${isWeekly(best.h) ? 'wk' : 'day'}${best.streak > 1 ? 's' : ''}</small>` : '—'}</div>
          </button>
          <button class="hero-tile" data-action="go-stats">
            <div class="ht-label">Last 7 days</div>
            <div class="ht-val${delta > 0 ? ' good' : delta < 0 ? ' bad' : ''}">${r7 === null ? '—' : `${Math.round(r7)}%`}${delta ? `<small> ${delta > 0 ? '▲' : '▼'}${Math.abs(delta)}</small>` : ''}</div>
          </button>
        </div>
      </div>`;
  }

  // ============================================================
  // Notifications: what needs you today. The bell lists them all
  // (with an unread count); Today shows the most urgent as a tip.
  // Each id is stable for as long as the situation lasts, so
  // "seen" and "dismissed" stick.
  // ============================================================
  const LS_SEEN = 'habits.alertsSeen', LS_HIDDEN = 'habits.tipsHidden';
  let alertList = [];
  let quickOpen = false; // the sheet is showing the quick check (re-rendered on every tick)

  function lsList(key) {
    try { const v = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(v) ? v : []; }
    catch { return []; }
  }
  function lsAdd(key, ids) {
    const list = lsList(key).filter(k => !ids.includes(k)).concat(ids).slice(-80);
    try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* ignore */ }
  }

  function homeAlerts() {
    const out = [];
    if (state.loading) return out;
    const today  = todayStr();
    const hour   = new Date().getHours();
    const monday = mondayOf(new Date());
    const open   = dailyHabits().filter(h => !hasTick(h.id, today));

    if (hour >= 17) {
      for (const h of open) {
        const s = currentStreak(h.id);
        if (s >= 3) out.push({ id: `risk-${h.id}@${today}`, icon: '🔥', go: 'habits',
          title: `Keep your ${s}-day ${h.name} streak`,
          body: "It ends at midnight if it isn't ticked today." });
      }
    }
    if (hour >= 18 && open.length) {
      out.push({ id: `left@${today}`, icon: '⏰', go: 'habits',
        title: open.length === 1 ? `${open[0].name} is still open` : `${open.length} habits still open`,
        body: `${open.length > 1 ? listNames(open.map(h => h.name)) + ' · ' : ''}${timeLeftToday()} left today.` });
    }
    const daysLeft = 7 - ((new Date().getDay() + 6) % 7); // today included
    for (const h of state.habits.filter(isWeekly)) {
      const need = h.per_week - weekCount(h.id, monday);
      if (need > 0 && need === daysLeft) out.push({ id: `week-${h.id}@${fmtDate(monday)}`, icon: '📅', go: 'habits',
        title: `${h.name}: ${need} more this week`,
        body: daysLeft === 1 ? `Today is the last day to reach ${h.per_week}× this week.`
          : `Every day until Sunday keeps the ${h.per_week}× goal.` });
    }
    const jb = window.journalBig, js = window.journalScore;
    if (jb && hour >= 12) {
      const t = jb.textFor(today);
      if (t && !jb.doneFor(today)) out.push({ id: `big@${today}`, icon: '◎', go: 'bigtask',
        title: 'Your one big task is still open', body: t });
    }
    if (js && hour >= 20 && !js.doneOn(today)) {
      out.push({ id: `journal@${today}`, icon: '✍️', go: 'journal', title: "Write today's journal",
        body: "Something you did, something to remember, and tomorrow's big task." });
    } else if (jb && hour >= 20 && !jb.textFor(fmtDate(shiftDays(new Date(), 1)))) {
      out.push({ id: `tomorrow@${today}`, icon: '◎', go: 'journal', title: "Pick tomorrow's big task",
        body: 'Write it under “Something to do tomorrow” in your journal.' });
    }
    const wt = window.weight;
    if (wt && hour >= 6 && hour < 12 && wt.get(today) == null) {
      // Only for someone who weighs in most days
      let recent = 0;
      for (let i = 1; i <= 7; i++) if (wt.get(fmtDate(shiftDays(new Date(), -i))) != null) recent++;
      if (recent >= 3) out.push({ id: `weigh@${today}`, icon: '⚖️', go: 'weight', title: 'Weigh in',
        body: `${recent} weigh-ins in the last 7 days. Log today's to keep the trend sharp.` });
    }
    for (const h of state.habits) {
      const w = isWeekly(h);
      const s = w ? currentWeekStreak(h) : currentStreak(h.id);
      const longest = w ? longestWeekStreak(h) : longestStreak(h.id);
      const live = w ? weekMet(h, monday) : hasTick(h.id, today);
      if (live && s >= (w ? 3 : 7) && s >= longest) out.push({ id: `record-${h.id}-${s}`, icon: '🏆', go: 'stats', habit: h.id,
        title: `Record: ${s} ${w ? 'weeks' : 'days'} of ${h.name}`, body: 'Your longest streak yet. Keep it going.' });
    }
    if (reminderState === 'off') out.push({ id: 'reminder-off', icon: '🔔', go: 'settings',
      title: 'Turn on the evening reminder', body: "A notification at 23:00 when habits aren't ticked yet." });
    return out;
  }

  function alertRowHtml(a, i, cls) {
    return `
      <button class="${cls}" data-action="alert" data-i="${i}">
        <span class="tip-ico">${a.icon}</span>
        <span class="tip-main"><span class="tip-title" style="display:block">${esc(a.title)}</span><span class="tip-body" style="display:block">${esc(a.body)}</span></span>
      </button>`;
  }

  function renderBell() {
    const seen = lsList(LS_SEEN);
    const n = alertList.filter(a => !seen.includes(a.id)).length;
    const c = document.getElementById('home-bell-count');
    c.hidden = !n;
    c.textContent = n > 9 ? '9+' : String(n);
    document.getElementById('home-bell').setAttribute('aria-label', n ? `Notifications, ${n} new` : 'Notifications');
  }

  function buildTip() {
    const hidden = lsList(LS_HIDDEN);
    const i = alertList.findIndex(a => !hidden.includes(a.id));
    if (i < 0) return '<div id="home-tip"></div>';
    const more = alertList.length - 1;
    return `
      <div id="home-tip">
        <div class="tip">
          ${alertRowHtml(alertList[i], i, 'tip-btn')}
          <button class="tip-x" data-action="tip-dismiss" data-i="${i}" aria-label="Dismiss">✕</button>
        </div>
        ${more > 0 ? `<button class="link tip-more" data-action="open-alerts">${more} more in notifications ›</button>` : ''}
      </div>`;
  }

  function openSheet(title, html) {
    quickOpen = false;
    document.getElementById('sheet-title').textContent = title;
    document.getElementById('sheet-list').innerHTML = html;
    document.getElementById('sheet').hidden = false;
  }
  function closeSheet() { quickOpen = false; document.getElementById('sheet').hidden = true; }
  window.openSheet = openSheet;
  window.closeSheet = closeSheet;

  function openAlerts() {
    haptic();
    const html = alertList.length
      ? alertList.map((a, i) => alertRowHtml(a, i, 'alert-row')).join('')
      : `<div class="sheet-empty">
           <div class="sheet-empty-ico">✓</div>
           <div class="tip-title">You're all caught up</div>
           <div class="tip-body">Streaks at risk, habits still open tonight, weekly goals running short, your big task and the journal show up here.</div>
         </div>`;
    openSheet('Notifications', html);
    lsAdd(LS_SEEN, alertList.map(a => a.id));
    renderBell();
  }

  function followAlert(a) {
    haptic();
    closeSheet();
    if (a.go === 'settings') return showView('settings');
    if (a.go === 'weight') return openWeightLog();
    if (a.go === 'stats') {
      statsHabit = state.habits.find(h => h.id === a.habit) || null;
      return showView('stats');
    }
    if (a.go === 'habits') return showView('habits');
    if (state.view !== 'today') showView('today');
    const target = { bigtask: 'bigtask-head', journal: 'view-journal' }[a.go];
    const el = target && document.getElementById(target);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (a.go === 'journal') setTimeout(() => document.getElementById('jr-day')?.focus({ preventScroll: true }), 400);
  }

  function renderToday() {
    const main = document.getElementById('today-main');
    if (state.loading) return;

    alertList = homeAlerts();
    renderBell();

    main.innerHTML = buildHero() + buildTip() + buildBigTaskTile() + buildWeightCard();
  }

  // ============================================================
  // Render: Habits tab (cards with the week calendar, by section)
  // ============================================================
  function renderHabits() {
    const root = document.getElementById('habits-body');
    if (state.loading) return;
    if (!state.habits.length) {
      root.innerHTML = `
        <div class="empty">
          <div class="empty-icon">🌱</div>
          <h2>No habits yet</h2>
          <p>One thing a day, ticked here.</p>
          <button class="qc-cta" data-action="add-habit">Add your first habit ›</button>
        </div>`;
      return;
    }
    const today = todayStr();
    let html = `<div class="habits-nav">${buildWeekNav()}</div>`;
    const groups = groupBySection(state.habits);
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
  // Quick check: the ✓ button's sheet, one square per habit to tick today
  // ============================================================
  function quickCheckHtml() {
    if (!state.habits.length) {
      return `<div class="sheet-empty">
          <div class="sheet-empty-ico">🌱</div>
          <div class="tip-title">No habits yet</div>
          <button class="qc-cta" data-action="add-habit">Add your first habit ›</button>
        </div>`;
    }
    const today  = todayStr();
    const monday = mondayOf(new Date());
    const squares = state.habits.map(h => {
      const on  = hasTick(h.id, today);
      const sub = isWeekly(h) ? `${weekCount(h.id, monday)}/${h.per_week} this week` : (streakLabel(h).streak ? `${streakLabel(h).text}` : '');
      return `
        <button class="qc-sq${on ? ' on' : ''}" style="--c:${h.color}" data-action="quick-toggle" data-id="${h.id}"
                aria-pressed="${on}" aria-label="${esc(h.name)}">
          <span class="qc-mark">${on ? '✓' : esc((h.name.trim()[0] || '·').toUpperCase())}</span>
          <span class="qc-name">${esc(h.name)}</span>
          <span class="qc-sub">${esc(sub)}</span>
        </button>`;
    }).join('');
    return `<div class="qc-grid">${squares}</div>`;
  }

  function renderQuickCheck() {
    if (!quickOpen) return;
    const today = todayStr();
    const daily = dailyHabits();
    const done  = daily.filter(h => hasTick(h.id, today)).length;
    const title = !state.habits.length ? 'Today'
      : daily.length && done === daily.length ? 'Today · all done'
      : daily.length ? `Today · ${done} of ${daily.length}` : 'Today';
    openSheet(title, quickCheckHtml());
    quickOpen = true;
  }

  function openQuickCheck() {
    haptic();
    quickOpen = true;
    renderQuickCheck();
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
  // Stats: month by month
  // ============================================================
  let statsHabit = null; // null = all habits; otherwise a habit object
  let statsMonth = 0;    // 0 = this month, 1 = last month, …
  const ACCENT = '#6d5ae6';
  const JOURNAL_COLOR = '#5e5ce6'; // journaling task accent (indigo)
  const BIGTASK_COLOR = '#ff9f0a'; // one-big-task accent (amber)
  const WD_FULL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  const createdStr = h => (h.created_at ? fmtDate(new Date(h.created_at)) : '0000-01-01');

  // Completion rate (%) of a journal-like module exposing activeOn(dateStr) /
  // doneOn(dateStr) over the given days — used for the by-task breakdown rows.
  function activityRate(mod, days) {
    let done = 0, active = 0;
    for (const ds of days) {
      if (mod.activeOn(ds)) { active++; if (mod.doneOn(ds)) done++; }
    }
    return active ? Math.round((done / active) * 100) : 0;
  }

  // A habit's score for one day: 0/1 for daily habits; for weekly habits the
  // share of that week's target reached (the same value for each day of it).
  function habitDayValue(h, dstr) {
    return isWeekly(h) ? weekFraction(h, dstr) : (hasTick(h.id, dstr) ? 1 : 0);
  }

  // Share of the scope completed on a given day (0..1), or null if nothing was
  // active yet. For one habit that's 0/1; for "all" it's done/active habits.
  function dayFraction(dstr, scope) {
    if (scope) {
      if (dstr < createdStr(scope)) return null;
      return habitDayValue(scope, dstr);
    }
    let done = 0, active = 0;
    for (const h of state.habits) {
      if (dstr >= createdStr(h)) { active++; done += habitDayValue(h, dstr); }
    }
    // Journaling counts as one more tracked item in the "all habits" aggregate,
    // active from its first entry onward (see journal.js / journalScore).
    const j = window.journalScore;
    if (j && j.activeOn(dstr)) { active++; if (j.doneOn(dstr)) done++; }
    if (!active) return null;
    return done / active;
  }

  // Mean daily completion rate over a window [startAgo, startAgo+len) days back
  function scopeRate(scope, startAgo, len) {
    const days = [];
    for (let i = startAgo; i < startAgo + len; i++) days.push(fmtDate(shiftDays(new Date(), -i)));
    return rateOver(days, scope);
  }

  // Mean daily completion rate (%) over a list of days, or null without data.
  function rateOver(days, scope) {
    let sum = 0, cnt = 0;
    for (const ds of days) {
      const f = dayFraction(ds, scope);
      if (f !== null) { sum += f; cnt++; }
    }
    return cnt ? (sum / cnt) * 100 : null;
  }

  function monthStart(off) { const n = new Date(); return new Date(n.getFullYear(), n.getMonth() - off, 1); }
  function daysInMonth(off) { const s = monthStart(off); return new Date(s.getFullYear(), s.getMonth() + 1, 0).getDate(); }
  // The month's days, from the 1st up to its last day or today.
  function monthDays(off) {
    const start = monthStart(off), today = todayStr(), out = [];
    for (let d = new Date(start); d.getMonth() === start.getMonth(); d = shiftDays(d, 1)) {
      const ds = fmtDate(d);
      if (ds > today) break;
      out.push(ds);
    }
    return out;
  }
  // How many months back the data goes (the earliest month you can step to).
  function earliestMonthOff() {
    let first = todayStr();
    for (const h of state.habits) {
      const c = createdStr(h);
      if (c !== '0000-01-01' && c < first) first = c;
      const t = tickDates(h.id)[0];
      if (t && t < first) first = t;
    }
    const f = new Date(first + 'T00:00:00'), n = new Date();
    return Math.max(0, (n.getFullYear() - f.getFullYear()) * 12 + n.getMonth() - f.getMonth());
  }

  // Weekday rhythm over the given days. For a weekly habit it's how often you
  // do it on each weekday; in the all-habits view only daily habits count (a
  // weekly habit's score is the same every day of its week, so it says nothing
  // per weekday).
  function weekdayRhythm(scope, days) {
    const sums = new Array(7).fill(0), cnts = new Array(7).fill(0);
    const dailyOnly = dstr => {
      let done = 0, active = 0;
      for (const h of state.habits) {
        if (isWeekly(h) || dstr < createdStr(h)) continue;
        active++; if (hasTick(h.id, dstr)) done++;
      }
      return active ? done / active : null;
    };
    const valueFor = dstr => !scope ? dailyOnly(dstr)
      : isWeekly(scope) ? (dstr < createdStr(scope) ? null : (hasTick(scope.id, dstr) ? 1 : 0))
      : dayFraction(dstr, scope);
    for (const ds of days) {
      const f = valueFor(ds);
      if (f === null) continue;
      const wd = new Date(ds + 'T00:00:00').getDay();
      sums[wd] += f; cnts[wd]++;
    }
    return [1, 2, 3, 4, 5, 6, 0].map(wd => ({
      full: WD_FULL[wd], letter: WD_FULL[wd][0],
      v: cnts[wd] ? Math.round((sums[wd] / cnts[wd]) * 100) : 0, has: cnts[wd] > 0,
    }));
  }

  // 7-day trailing completion rate for each of the given days (%), null where
  // nothing was tracked yet.
  function paceSeries(scope, days) {
    return days.map(ds => {
      let sum = 0, cnt = 0;
      for (let j = 0; j < 7; j++) {
        const f = dayFraction(fmtDate(shiftDays(new Date(ds + 'T00:00:00'), -j)), scope);
        if (f !== null) { sum += f; cnt++; }
      }
      return cnt ? Math.round((sum / cnt) * 100) : null;
    });
  }

  // The longest run of ticked days inside the given days.
  function bestRun(habitId, days) {
    let best = 0, cur = 0;
    for (const ds of days) { cur = hasTick(habitId, ds) ? cur + 1 : 0; if (cur > best) best = cur; }
    return best;
  }

  // Line chart of the month's pace against last month's (grey), across the
  // whole month so the current one stops at today.
  function paceFigure(cur, old, n, color, labels) {
    const W = 340, H = 140, padL = 6, padR = 22, padT = 12, padB = 6;
    const pw = W - padL - padR, ph = H - padT - padB, base = padT + ph;
    const X = i => padL + (n > 1 ? (i / (n - 1)) * pw : pw / 2);
    const Y = v => padT + (1 - v / 100) * ph;
    const path = pts => {
      let d = '', pen = false;
      pts.forEach((v, i) => {
        if (v === null) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)} `;
        pen = true;
      });
      return d.trim();
    };
    const firstCur = cur.findIndex(v => v !== null);
    if (firstCur < 0) return `<p class="viz-empty">Nothing ticked this month yet.</p>`;
    const lastCur = cur.length - 1;
    const area = `M${X(firstCur).toFixed(1)},${base} ` + cur.map((v, i) => v === null ? '' : `L${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ') + ` L${X(lastCur).toFixed(1)},${base} Z`;
    const grid = [0, 50, 100].map(g =>
      `<line class="viz-grid" x1="${padL}" x2="${W - padR}" y1="${Y(g)}" y2="${Y(g)}"/>` +
      `<text class="viz-axis" x="${W - padR + 4}" y="${Y(g) + 3}">${g}</text>`).join('');
    const geo = { padL, pw, padT, ph, n, W };
    const lastV = cur[lastCur];
    return `
      <div class="viz-wrap">
        <svg class="viz-area" viewBox="0 0 ${W} ${H}" style="--c:${color}"
             data-cur='${JSON.stringify(cur)}' data-old='${JSON.stringify(old)}' data-labels='${JSON.stringify(labels)}' data-geo='${JSON.stringify(geo)}'>
          ${grid}
          ${old.some(v => v !== null) ? `<path class="viz-old" d="${path(old)}"/>` : ''}
          <path class="viz-fill" d="${area}"/>
          <path class="viz-line" d="${path(cur)}"/>
          <line class="viz-cross" x1="0" x2="0" y1="${padT}" y2="${base}" style="display:none"/>
          ${lastV !== null ? `<circle class="viz-dot" cx="${X(lastCur).toFixed(1)}" cy="${Y(lastV).toFixed(1)}" r="4"/>` : ''}
          <circle class="viz-cursor" r="4" style="display:none"/>
        </svg>
        <div class="viz-tip" style="display:none"></div>
        <div class="viz-xaxis"><span>${esc(labels[0])}</span><span>${esc(labels[Math.floor((n - 1) / 2)])}</span><span>${esc(labels[n - 1])}</span></div>
      </div>`;
  }

  // Bars: one per item { letter, full, v, has, month? }. `sel` is highlighted
  // (or the best one, when there's no selection); bars with a month offset can
  // be tapped to go to that month.
  function barsFigure(items, color, sel) {
    const W = 340, H = 122, padL = 4, padR = 4, padT = 18, padB = 18;
    const pw = W - padL - padR, ph = H - padT - padB, base = padT + ph;
    const band = pw / items.length, barW = Math.min(30, band - 12);
    const bestI = sel != null ? sel : items.reduce((b, r, i) => (r.v > items[b].v ? i : b), 0);
    const bars = items.map((r, i) => {
      const cx = padL + band * i + band / 2;
      const h = r.has ? (r.v / 100) * ph : 0;
      const y = base - h;
      const isBest = i === bestI && (r.v > 0 || sel != null);
      return `
        <g class="viz-bar${isBest && sel != null ? ' sel' : ''}" data-full="${esc(r.full)}" data-v="${r.v}" data-has="${r.has ? 1 : 0}"
           ${r.month != null ? `data-action="stats-month" data-month="${r.month}"` : ''}>
          <rect class="viz-bar-hit" x="${cx - band / 2}" y="${padT}" width="${band}" height="${ph + padB}"/>
          <rect class="viz-bar-rect${isBest ? ' best' : ''}" x="${(cx - barW / 2).toFixed(1)}" y="${y.toFixed(1)}"
                width="${barW.toFixed(1)}" height="${Math.max(h, r.has ? 3 : 0).toFixed(1)}" rx="5"/>
          ${isBest && r.has ? `<text class="viz-bar-cap" x="${cx.toFixed(1)}" y="${(y - 5).toFixed(1)}" text-anchor="middle">${r.v}%</text>` : ''}
          <text class="viz-axis${isBest && sel != null ? ' strong' : ''}" x="${cx.toFixed(1)}" y="${base + 13}" text-anchor="middle">${esc(r.letter)}</text>
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

  // One month calendar per habit; tap a day to tick or untick it.
  function monthCalendar(h, off) {
    const start  = monthStart(off), todayS = todayStr();
    const lead   = (start.getDay() + 6) % 7; // Mon=0
    const n      = daysInMonth(off);
    const cells  = [];
    for (let i = 0; i < lead; i++) cells.push('<div class="cal-cell empty-cell"></div>');
    let count = 0;
    for (let d = 1; d <= n; d++) {
      const ds = fmtDate(new Date(start.getFullYear(), start.getMonth(), d));
      const on = hasTick(h.id, ds);
      if (on) count++;
      cells.push(`<div class="cal-cell${on ? ' on' : ''}${ds > todayS ? ' future' : ''}${ds === todayS ? ' today' : ''}"
        data-action="toggle-day" data-id="${h.id}" data-date="${ds}" title="${ds}"><span class="cal-day-num">${d}</span></div>`);
    }
    while (cells.length % 7) cells.push('<div class="cal-cell empty-cell"></div>');
    const rows = [];
    for (let i = 0; i < cells.length; i += 7) rows.push(`<div class="cal-row">${cells.slice(i, i + 7).join('')}</div>`);
    const head = `<div class="cal-row">${['M','T','W','T','F','S','S'].map(l => `<span class="cal-col-label">${l}</span>`).join('')}</div>`;
    const { streak, text: streakText } = streakLabel(h);
    return `
      <div class="history-card" style="--c:${h.color}">
        <div class="history-head">
          <div class="history-swatch"></div>
          <h3>${esc(h.name)}</h3>
          <span class="history-meta">${count}×${isWeekly(h) ? ` · ${h.per_week}×/wk` : ''}${off === 0 && streak > 0 ? ` · ${flameIcon(h.color)} ${streakText}` : ''}</span>
        </div>
        <div class="hist-month-grid">${head}${rows.join('')}</div>
      </div>`;
  }

  function renderStats() {
    const root = document.getElementById('stats-body');
    if (state.loading) return;

    // Keep scope valid if the selected habit was removed
    if (statsHabit && !state.habits.some(h => h.id === statsHabit.id)) statsHabit = null;
    const scope = statsHabit;

    // ---- Filter chips (all, weight, then each habit) ----
    const pill = (label, active, dataAttr, dot) =>
      `<button class="stats-pill${active ? ' active' : ''}" ${dataAttr}>${dot ? `<span class="stats-dot" style="background:${dot}"></span>` : ''}${esc(label)}</button>`;
    const pills = `
      <div class="stats-filter">
        ${pill('All habits', !scope && !statsWeight, 'data-action="stats-filter" data-habit="all"')}
        ${W() ? pill('⚖️ Weight', statsWeight, 'data-action="stats-filter" data-habit="weight"') : ''}
        ${state.habits.map(h => pill(h.name, !statsWeight && scope && scope.id === h.id, `data-action="stats-filter" data-habit="${h.id}"`, h.color)).join('')}
      </div>`;

    if (statsWeight && W()) { renderWeightStats(root, pills); return; }

    if (!state.habits.length) {
      root.innerHTML = pills + `<div class="empty"><div class="empty-icon">📈</div><h2>No habits yet</h2><p>Add a habit with <strong>+</strong> to start tracking your stats.</p></div>`;
      return;
    }
    const color = scope ? scope.color : ACCENT;
    const minOff = earliestMonthOff();
    statsMonth = Math.max(0, Math.min(statsMonth, minOff));
    const off   = statsMonth;
    const days  = monthDays(off);
    const prevDays = monthDays(off + 1);
    const start = monthStart(off);
    const mName = MONTH_NAMES[start.getMonth()];
    const prevName = MONTH_NAMES[monthStart(off + 1).getMonth()];
    const short = d => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

    // ---- Month switcher ----
    const nav = `
      <div class="month-nav">
        <button class="icon-btn" data-action="stats-month" data-month="${off + 1}" aria-label="Previous month" ${off >= minOff ? 'disabled' : ''}>‹</button>
        <div class="month-label">${mName}${start.getFullYear() !== new Date().getFullYear() ? ` ${start.getFullYear()}` : ''}
          <div class="month-sub">${off === 0 ? `${short(days[0])} – today` : `${short(days[0])} – ${short(days[days.length - 1])}`}</div>
        </div>
        <button class="icon-btn" data-action="stats-month" data-month="${off - 1}" aria-label="Next month" ${off === 0 ? 'disabled' : ''}>›</button>
      </div>`;

    // ---- KPI tiles ----
    const rate = rateOver(days, scope), prevRate = rateOver(prevDays, scope);
    const delta = rate !== null && prevRate !== null ? Math.round(rate - prevRate) : null;
    const pct = v => v === null ? '—' : `${Math.round(v)}<span class="stat-sub">%</span>`;
    const deltaTile = [delta === null ? '—' : `${delta > 0 ? '+' : ''}${delta}<span class="stat-sub"> pts</span>`, `vs ${prevName}`, delta > 0 ? 'good' : delta < 0 ? 'bad' : ''];
    let tiles;
    if (!scope) {
      const daily = state.habits.filter(h => !isWeekly(h));
      const perfect = days.filter(ds => {
        const active = daily.filter(h => ds >= createdStr(h));
        return active.length && active.every(h => hasTick(h.id, ds));
      }).length;
      let ticks = 0;
      for (const k of state.entries) { const ds = k.slice(k.indexOf('|') + 1); if (ds >= days[0] && ds <= days[days.length - 1]) ticks++; }
      tiles = [
        [pct(rate), 'Completion'],
        [`${perfect}<span class="stat-sub">/${days.length}</span>`, 'Perfect days'],
        [`${ticks}`, 'Ticks'],
        deltaTile,
      ];
    } else if (isWeekly(scope)) {
      const times = days.filter(ds => hasTick(scope.id, ds)).length;
      // Weeks that start this month and are over (or already met)
      const mondays = days.filter(ds => new Date(ds + 'T00:00:00').getDay() === 1).map(ds => new Date(ds + 'T00:00:00'));
      const judged = mondays.filter(m => fmtDate(shiftDays(m, 6)) < todayStr() || weekMet(scope, m));
      tiles = [
        [`${times}`, 'Times done'],
        [`${judged.filter(m => weekMet(scope, m)).length}<span class="stat-sub">/${judged.length}</span>`, 'Weeks met'],
        [pct(rate), 'Of the target'],
        deltaTile,
      ];
    } else {
      const counted = days.filter(ds => ds >= createdStr(scope));
      const done = counted.filter(ds => hasTick(scope.id, ds)).length;
      tiles = [
        [`${done}<span class="stat-sub">/${counted.length}</span>`, 'Days done'],
        [pct(rate), 'Completion'],
        [`${bestRun(scope.id, days)}<span class="stat-sub">d</span>`, 'Best run'],
        deltaTile,
      ];
    }
    const overview = `<div class="stats-overview">${tiles.map(([v, l, c]) =>
      `<div class="stat-tile"><div class="num${c ? ' ' + c : ''}">${v}</div><div class="lbl">${l}</div></div>`).join('')}</div>`;

    // ---- Day by day, against last month ----
    const n = Math.max(daysInMonth(off), prevDays.length);
    const labels = [];
    for (let i = 0; i < n; i++) labels.push(`${i + 1}`);
    const paceCard = `
      <div class="stats-card">
        <div class="stats-card-head"><span class="stats-card-title">Day by day</span>${delta !== null ? `<span class="viz-delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'}">${delta > 0 ? '▲' : delta < 0 ? '▼' : '→'} ${Math.abs(delta)} pts vs ${prevName}</span>` : ''}</div>
        <div class="stats-card-sub">${scope && isWeekly(scope) ? `Share of the ${scope.per_week}×/week target` : '7-day completion rate'}, each day of the month</div>
        ${paceFigure(paceSeries(scope, days), paceSeries(scope, prevDays), n, color, labels)}
        <div class="legend" style="--c:${color}"><span class="lg-item"><span class="lg-line"></span>${mName}</span><span class="lg-item"><span class="lg-line old"></span>${prevName}</span></div>
      </div>`;

    // ---- Weekly rhythm ----
    const rhythm = weekdayRhythm(scope, days);
    const anyData = rhythm.some(r => r.has);
    const best = rhythm.reduce((b, r) => (r.v > b.v ? r : b), rhythm[0]);
    const rhythmCard = `
      <div class="stats-card">
        <div class="stats-card-head"><span class="stats-card-title">Weekly rhythm</span></div>
        <div class="stats-card-sub">${anyData && best.v > 0 ? `${scope && isWeekly(scope) ? 'Most often on' : 'Most consistent on'} <strong>${esc(best.full)}s</strong>` : 'Completion rate by weekday'}${!scope && state.habits.some(isWeekly) ? ' · daily habits' : ''}</div>
        ${barsFigure(rhythm, color)}
      </div>`;

    // ---- Last 6 months (tap one to go there) ----
    const months = [];
    for (let o = Math.min(off + 5, minOff); o >= Math.max(0, off - 5) && months.length < 6; o--) months.push(o);
    const monthItems = months.map(o => {
      const r = rateOver(monthDays(o), scope);
      const m = monthStart(o);
      return { letter: MONTH_NAMES[m.getMonth()].slice(0, 3), full: `${MONTH_NAMES[m.getMonth()]} ${m.getFullYear()}`, v: r === null ? 0 : Math.round(r), has: r !== null, month: o };
    });
    const monthsCard = monthItems.length > 1 ? `
      <div class="stats-card">
        <div class="stats-card-head"><span class="stats-card-title">Month by month</span></div>
        <div class="stats-card-sub">Completion rate · tap a month to see it</div>
        ${barsFigure(monthItems, color, months.indexOf(off))}
      </div>` : '';

    // ---- By-task breakdown (all scope only) ----
    // Habits are tappable to focus; journaling and the one big task appear here
    // as tasks too (they aren't focusable scopes, so they render as static rows).
    let breakdown = '';
    if (!scope) {
      const items = state.habits.map(h => {
        const r = rateOver(days, h);
        return { name: h.name, color: h.color, r: r === null ? 0 : Math.round(r), habitId: h.id };
      });
      if (window.journalScore && window.journalScore.firstDate())
        items.push({ name: 'Journal', color: JOURNAL_COLOR, r: activityRate(window.journalScore, days) });
      if (window.journalBig && window.journalBig.firstAssignedDate())
        items.push({ name: 'One big task', color: BIGTASK_COLOR, r: activityRate(window.journalBig, days) });
      items.sort((a, b) => b.r - a.r);

      if (items.length > 1) {
        const rows = items.map(it => {
          const inner = `
            <span class="stats-rank-top">
              <span class="stats-dot" style="background:${it.color}"></span>
              <span class="stats-rank-name">${esc(it.name)}</span>
              <span class="stats-rank-pct">${it.r}%</span>
            </span>
            <span class="stats-rank-track"><span class="stats-rank-fill" style="width:${it.r}%;background:${it.color}"></span></span>`;
          return it.habitId
            ? `<button class="stats-rank" data-action="stats-filter" data-habit="${it.habitId}">${inner}</button>`
            : `<div class="stats-rank static">${inner}</div>`;
        }).join('');
        breakdown = `
          <div class="stats-card">
            <div class="stats-card-head"><span class="stats-card-title">By task</span></div>
            <div class="stats-card-sub">Completion in ${mName}${state.habits.some(isWeekly) ? ' (weekly habits: share of target)' : ''} · tap a habit to focus</div>
            <div class="stats-rank-list">${rows}</div>
          </div>`;
      }
    }

    // ---- Calendars ----
    const shown = scope ? [scope] : state.habits;
    const calendars = `
      <div class="sec-head"><h2>Calendar</h2><span class="sec-sub">Tap a day to change it</span></div>
      <div class="cal-grid">${shown.map(h => monthCalendar(h, off)).join('')}</div>`;

    root.innerHTML = nav + pills + overview + paceCard + rhythmCard + monthsCard + breakdown + calendars;
    wireStatsCharts(root);
  }

  // Pointer-driven crosshair/tooltip for the stats charts
  function wireStatsCharts(root) {
    root.querySelectorAll('.viz-area').forEach(svg => {
      const cur = JSON.parse(svg.dataset.cur), old = JSON.parse(svg.dataset.old);
      const labels = JSON.parse(svg.dataset.labels), geo = JSON.parse(svg.dataset.geo);
      const wrap = svg.closest('.viz-wrap'), tip = wrap.querySelector('.viz-tip');
      const cross = svg.querySelector('.viz-cross'), cursor = svg.querySelector('.viz-cursor');
      const X = i => geo.padL + (geo.n > 1 ? (i / (geo.n - 1)) * geo.pw : geo.pw / 2);
      const Y = v => geo.padT + (1 - v / 100) * geo.ph;
      const move = e => {
        const rect = svg.getBoundingClientRect();
        const cx = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
        let i = Math.round(((cx / rect.width) * geo.W - geo.padL) / geo.pw * (geo.n - 1));
        i = Math.max(0, Math.min(geo.n - 1, i));
        const v = cur[i] ?? null, o = old[i] ?? null;
        if (v === null && o === null) return hide();
        const x = X(i);
        cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.style.display = '';
        if (v !== null) { cursor.setAttribute('cx', x); cursor.setAttribute('cy', Y(v)); cursor.style.display = ''; }
        else cursor.style.display = 'none';
        tip.innerHTML = `Day ${esc(labels[i])}${v !== null ? ` · <strong>${v}%</strong>` : ''}${o !== null ? ` · before ${o}%` : ''}`;
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
          tip.innerHTML = `${g.dataset.has === '1' ? `<strong>${g.dataset.v}%</strong>` : 'No data'} · ${esc(g.dataset.full)}`;
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
  // Weight: a card on Today, a log sheet, and a view in Stats
  // ============================================================
  const W = () => window.weight;
  const kgStr = kg => `${kg.toFixed(1)}`;
  function shortDate(dstr) {
    if (dstr === todayStr()) return 'Today';
    if (dstr === fmtDate(shiftDays(new Date(), -1))) return 'Yesterday';
    const d = new Date(dstr + 'T00:00:00');
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
  }
  // Green when a change moves toward the goal, red when it moves away;
  // neutral without a goal.
  function towardGoal(delta, current) {
    const g = W().goal();
    if (!g || !delta || current == null) return '';
    return (g - current) * delta > 0 ? 'good' : 'bad';
  }
  function signed(n) { return `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n).toFixed(1)}`; }

  // 7-day average now against a week ago.
  function weeklyChange() {
    const t = todayStr(), a = W().trendOn(t), b = W().trendOn(fmtDate(shiftDays(new Date(), -7)));
    return a != null && b != null ? Math.round((a - b) * 10) / 10 : null;
  }

  // Line through the 7-day average at each weigh-in, between two dates.
  function weightPoints(from, to) {
    return W().dates().filter(d => d >= from && d <= to).map(d => ({ d, kg: W().get(d), avg: W().trendOn(d) }));
  }

  function sparkSvg(pts) {
    if (pts.length < 2) return '';
    const Wd = 300, H = 54, pad = 4;
    const vals = pts.map(p => p.avg);
    const lo = Math.min(...vals), hi = Math.max(...vals), span = Math.max(hi - lo, 0.6);
    const t0 = +new Date(pts[0].d), t1 = +new Date(pts[pts.length - 1].d) || t0 + 1;
    const X = d => pad + ((+new Date(d) - t0) / Math.max(1, t1 - t0)) * (Wd - pad * 2);
    const Y = v => pad + (1 - (v - (lo + hi - span) / 2) / span) * (H - pad * 2);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.d).toFixed(1)},${Y(p.avg).toFixed(1)}`).join(' ');
    const last = pts[pts.length - 1];
    return `<svg class="wt-spark" viewBox="0 0 ${Wd} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <path d="${line} L${X(last.d).toFixed(1)},${H} L${X(pts[0].d).toFixed(1)},${H} Z" class="wt-spark-fill"/>
      <path d="${line}" class="wt-spark-line"/>
      <circle cx="${X(last.d).toFixed(1)}" cy="${Y(last.avg).toFixed(1)}" r="3.5" class="wt-spark-dot"/>
    </svg>`;
  }

  function buildWeightCard() {
    if (!W()) return '';
    const head = `<div class="sec-head" id="weight-head"><h2>Weight</h2><button class="link" data-action="weight-log">Log</button></div>`;
    const last = W().latest();
    if (!last) {
      return head + `
        <button class="wt-card wt-empty" data-action="weight-log">
          <span class="wt-ico">⚖️</span>
          <span class="wt-main"><span class="wt-title">Track your weight</span>
          <span class="wt-sub">${W().missing() ? 'Run schema.sql in Supabase first (adds the weights table).' : 'Log a weigh-in to see how it moves over time.'}</span></span>
          <span class="chev">›</span>
        </button>`;
    }
    const goal = W().goal();
    const change = weeklyChange();
    const loggedToday = last.date === todayStr();
    // Progress from the first weigh-in toward the goal
    const first = W().get(W().dates()[0]);
    let goalHtml = '';
    if (goal) {
      const left = Math.round((last.kg - goal) * 10) / 10;
      const pct = first !== goal ? Math.max(0, Math.min(1, (first - last.kg) / (first - goal))) : 1;
      goalHtml = `
        <div class="wt-goal">
          <div class="wt-goal-row"><span>${Math.abs(left) < 0.05 ? 'Goal reached 🎉' : `${Math.abs(left).toFixed(1)} kg to go`}</span><span>Goal ${kgStr(goal)} kg</span></div>
          <div class="wt-track"><div class="wt-fill" style="width:${(pct * 100).toFixed(1)}%"></div></div>
        </div>`;
    }
    const pts = weightPoints(fmtDate(shiftDays(new Date(), -30)), todayStr());
    return head + `
      <button class="wt-card" data-action="weight-log">
        <span class="wt-top">
          <span class="wt-ico">⚖️</span>
          <span class="wt-main">
            <span class="wt-big">${kgStr(last.kg)}<small> kg</small></span>
            <span class="wt-sub">${loggedToday ? 'Today' : `${shortDate(last.date)} · tap to log today`}</span>
          </span>
          ${change != null ? `<span class="wt-chip ${towardGoal(change, last.kg)}">${signed(change)} kg<small> / week</small></span>` : ''}
        </span>
        ${sparkSvg(pts)}
        ${goalHtml}
      </button>`;
  }

  // ---- Log sheet: one weigh-in for a day (today by default) ----
  let wtDate = null;
  function openWeightLog(dstr) {
    wtDate = dstr || todayStr();
    const cur = W().get(wtDate);
    const last = W().latest();
    const val = cur ?? (last ? last.kg : null);
    openSheet(cur != null ? 'Edit weigh-in' : 'Log weight', `
      <div class="wt-entry">
        <button class="wt-step" data-action="wt-step" data-d="-0.1" aria-label="Minus 0.1">−</button>
        <label class="wt-field"><input id="wt-kg" type="text" inputmode="decimal" autocomplete="off" placeholder="72.4" value="${val != null ? kgStr(val) : ''}" /><span>kg</span></label>
        <button class="wt-step" data-action="wt-step" data-d="0.1" aria-label="Plus 0.1">+</button>
      </div>
      <div class="wt-date-row">
        <label class="date-chip"><span id="wt-date-label">${esc(shortDate(wtDate))}</span><input id="wt-date" type="date" value="${wtDate}" max="${todayStr()}" aria-label="Date" /></label>
      </div>
      <div class="modal-actions">
        <button class="btn" data-action="sheet-close">Cancel</button>
        <button class="btn btn-primary" data-action="wt-save">Save</button>
      </div>
      ${cur != null ? `<button class="btn-del" data-action="wt-del">Delete this weigh-in</button>` : ''}`);
    const inp = document.getElementById('wt-kg');
    setTimeout(() => { inp.focus(); inp.select(); }, 80);
  }
  function readKg() {
    const v = parseFloat(String(document.getElementById('wt-kg')?.value || '').replace(',', '.'));
    return v > 0 && v < 1000 ? Math.round(v * 10) / 10 : null;
  }
  function saveWeightLog() {
    const kg = readKg();
    if (kg == null) { document.getElementById('wt-kg')?.focus(); return; }
    closeSheet();
    haptic();
    W().set(wtDate, kg);
    toast(`${kgStr(kg)} kg · ${shortDate(wtDate)}`);
  }
  function deleteWeighIn(dstr) {
    const kg = W().get(dstr);
    if (kg == null) return;
    closeSheet();
    W().remove(dstr);
    toast(`Deleted ${kgStr(kg)} kg · ${shortDate(dstr)}`, 0, { label: 'Undo', fn: () => W().set(dstr, kg) });
  }
  document.addEventListener('change', e => {
    if (e.target.id !== 'wt-date' || !e.target.value) return;
    wtDate = e.target.value > todayStr() ? todayStr() : e.target.value;
    document.getElementById('wt-date-label').textContent = shortDate(wtDate);
    const v = W().get(wtDate);
    if (v != null) document.getElementById('wt-kg').value = kgStr(v);
  });

  // ---- Stats: Weight ----
  let statsWeight = false;
  let weightRange = '3m';
  const RANGES = [['1m', '1M', 30], ['3m', '3M', 91], ['6m', '6M', 182], ['1y', '1Y', 365], ['all', 'All', null]];

  function weightFigure(pts, from, to, goal) {
    const Wd = 340, H = 170, padL = 6, padR = 34, padT = 12, padB = 6;
    const pw = Wd - padL - padR, ph = H - padT - padB, base = padT + ph;
    const vals = pts.flatMap(p => [p.kg, p.avg]);
    if (goal) vals.push(goal);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (hi - lo < 2) { const m = (hi + lo) / 2; lo = m - 1; hi = m + 1; }
    lo = Math.floor(lo - 0.3); hi = Math.ceil(hi + 0.3);
    const t0 = +new Date(from + 'T00:00:00'), t1 = Math.max(+new Date(to + 'T00:00:00'), t0 + 86400000);
    const X = d => padL + ((+new Date(d + 'T00:00:00') - t0) / (t1 - t0)) * pw;
    const Y = v => padT + (1 - (v - lo) / (hi - lo)) * ph;
    const step = Math.max(1, Math.ceil((hi - lo) / 4));
    let grid = '';
    for (let v = lo; v <= hi; v += step) {
      grid += `<line class="viz-grid" x1="${padL}" x2="${Wd - padR}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/>` +
              `<text class="viz-axis" x="${Wd - padR + 4}" y="${(Y(v) + 3).toFixed(1)}">${v}</text>`;
    }
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.d).toFixed(1)},${Y(p.avg).toFixed(1)}`).join(' ');
    const dots = pts.map(p => `<circle class="wt-dot" cx="${X(p.d).toFixed(1)}" cy="${Y(p.kg).toFixed(1)}" r="2.6"/>`).join('');
    const goalLine = goal ? `<line class="wt-goal-line" x1="${padL}" x2="${Wd - padR}" y1="${Y(goal).toFixed(1)}" y2="${Y(goal).toFixed(1)}"/>` : '';
    const last = pts[pts.length - 1];
    const geo = { padL, pw, padT, ph, W: Wd, t0, t1, lo, hi };
    const mid = fmtDate(new Date((t0 + t1) / 2));
    return `
      <div class="viz-wrap">
        <svg class="viz-weight" viewBox="0 0 ${Wd} ${H}" style="--c:${ACCENT}" data-pts='${JSON.stringify(pts)}' data-geo='${JSON.stringify(geo)}'>
          ${grid}${goalLine}${dots}
          <path class="viz-line" d="${line}"/>
          <line class="viz-cross" x1="0" x2="0" y1="${padT}" y2="${base}" style="display:none"/>
          <circle class="viz-dot" cx="${X(last.d).toFixed(1)}" cy="${Y(last.avg).toFixed(1)}" r="4"/>
          <circle class="viz-cursor" r="4" style="display:none"/>
        </svg>
        <div class="viz-tip" style="display:none"></div>
        <div class="viz-xaxis"><span>${esc(shortDate(from))}</span><span>${esc(shortDate(mid))}</span><span>${esc(shortDate(to))}</span></div>
      </div>`;
  }

  function renderWeightStats(root, pills) {
    const all = W().dates();
    const [, , days] = RANGES.find(r => r[0] === weightRange) || RANGES[1];
    const to = todayStr();
    const from = days ? fmtDate(shiftDays(new Date(), -days + 1)) : (all[0] || to);
    const pts = weightPoints(from, to);
    const seg = `
      <div class="td-seg" role="tablist" aria-label="Range">
        ${RANGES.map(([k, l]) => `<button class="td-seg-btn ${weightRange === k ? 'on' : ''}" data-action="weight-range" data-range="${k}">${l}</button>`).join('')}
      </div>`;
    if (!all.length) {
      root.innerHTML = pills + `
        <div class="empty"><div class="empty-icon">⚖️</div><h2>No weigh-ins yet</h2>
        <p>${W().missing() ? 'Run <code>schema.sql</code> in the Supabase SQL editor first: it adds the weights table.' : 'Log your weight from Today (or below) to see how it moves.'}</p></div>
        <button class="btn btn-primary wt-log-btn" data-action="weight-log">Log weight</button>`;
      return;
    }
    const goal = W().goal();
    const last = W().latest();
    const lowest = pts.length ? Math.min(...pts.map(p => p.kg)) : null;
    const change = pts.length > 1 ? Math.round((pts[pts.length - 1].avg - pts[0].avg) * 10) / 10 : null;
    const toGoal = goal ? Math.round((last.kg - goal) * 10) / 10 : null;
    const tiles = [
      [`${kgStr(last.kg)}<span class="stat-sub"> kg</span>`, `Latest · ${shortDate(last.date)}`, ''],
      [change == null ? '—' : `${signed(change)}<span class="stat-sub"> kg</span>`, `Change (7-day avg)`, towardGoal(change, last.kg)],
      [lowest == null ? '—' : `${kgStr(lowest)}<span class="stat-sub"> kg</span>`, 'Lowest', ''],
      goal ? [Math.abs(toGoal) < 0.05 ? '✓' : `${Math.abs(toGoal).toFixed(1)}<span class="stat-sub"> kg</span>`, `To goal · ${kgStr(goal)}`, Math.abs(toGoal) < 0.05 ? 'good' : '']
           : ['—', 'Goal · set in Settings', ''],
    ];
    const overview = `<div class="stats-overview">${tiles.map(([v, l, c]) =>
      `<div class="stat-tile"><div class="num${c ? ' ' + c : ''}">${v}</div><div class="lbl">${l}</div></div>`).join('')}</div>`;
    const chart = `
      <div class="stats-card">
        <div class="stats-card-head"><span class="stats-card-title">Trend</span><span class="viz-delta flat">${pts.length} weigh-in${pts.length === 1 ? '' : 's'}</span></div>
        <div class="stats-card-sub">Dots are weigh-ins; the line is the 7-day average, which smooths out day-to-day swings${goal ? '. Dashed: your goal' : ''}.</div>
        ${pts.length ? weightFigure(pts, from, to, goal) : `<p class="viz-empty">No weigh-ins in this range.</p>`}
      </div>`;
    const rows = pts.slice().reverse().map((p, i, arr) => {
      const prev = arr[i + 1];
      const d = prev ? Math.round((p.kg - prev.kg) * 10) / 10 : null;
      return `
        <button class="wt-row" data-action="weight-log" data-date="${p.d}">
          <span class="wt-row-date">${esc(shortDate(p.d))}</span>
          ${d != null && d !== 0 ? `<span class="wt-row-delta ${towardGoal(d, p.kg)}">${signed(d)}</span>` : ''}
          <span class="wt-row-kg">${kgStr(p.kg)} kg</span>
        </button>`;
    }).join('');
    const history = pts.length ? `
      <div class="sec-head"><h2>Weigh-ins</h2><button class="link" data-action="weight-log">Log</button></div>
      <div class="set-list">${rows}</div>` : '';
    root.innerHTML = pills + seg + overview + chart + history;

    // Crosshair + tooltip on the chart
    const svg = root.querySelector('.viz-weight');
    if (!svg) return;
    const ps = JSON.parse(svg.dataset.pts), geo = JSON.parse(svg.dataset.geo);
    const wrap = svg.closest('.viz-wrap'), tip = wrap.querySelector('.viz-tip');
    const cross = svg.querySelector('.viz-cross'), cursor = svg.querySelector('.viz-cursor');
    const X = d => geo.padL + ((+new Date(d + 'T00:00:00') - geo.t0) / (geo.t1 - geo.t0)) * geo.pw;
    const Y = v => geo.padT + (1 - (v - geo.lo) / (geo.hi - geo.lo)) * geo.ph;
    const move = e => {
      const rect = svg.getBoundingClientRect();
      const sx = ((e.clientX - rect.left) / rect.width) * geo.W;
      let best = ps[0];
      for (const p of ps) if (Math.abs(X(p.d) - sx) < Math.abs(X(best.d) - sx)) best = p;
      const x = X(best.d);
      cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.style.display = '';
      cursor.setAttribute('cx', x); cursor.setAttribute('cy', Y(best.avg)); cursor.style.display = '';
      tip.innerHTML = `${esc(shortDate(best.d))} · <strong>${kgStr(best.kg)} kg</strong> · avg ${kgStr(best.avg)}`;
      tip.style.display = '';
      tip.style.left = Math.max(0, Math.min(rect.width - tip.offsetWidth, (x / geo.W) * rect.width - tip.offsetWidth / 2)) + 'px';
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerdown', move);
    svg.addEventListener('pointerleave', () => { cross.style.display = 'none'; cursor.style.display = 'none'; tip.style.display = 'none'; });
  }

  window.renderWeight = () => {
    if (!state.loading) renderToday();
    if (state.view === 'stats' && statsWeight) renderStats();
  };

  // ============================================================
  // Render all
  // ============================================================
  function renderAll() {
    renderToday();
    renderHabits();
    renderQuickCheck();
    renderStats();
  }

  // Let journal.js refresh Stats, the hero and the notifications after a
  // journal edit (Today's journal box is its own node, so typing isn't disturbed).
  window.renderStats = () => { renderStats(); renderToday(); };

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
    let chosenPerWeek = isWeekly(habit) ? habit.per_week : null; // null = daily
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
          <label class="field-label">How often</label>
          <div class="section-pills freq-pills" id="freq-pills">
            ${[null, 1, 2, 3, 4, 5, 6].map(n => `
              <button type="button" class="section-pill ${n === chosenPerWeek ? 'active' : ''}"
                      data-freq="${n ?? ''}">${n ? `${n}×/wk` : 'Daily'}</button>`).join('')}
          </div>
          <label class="field-label">Color</label>
          <div class="color-grid" id="color-grid">
            ${COLORS.map(c => `
              <div class="color-swatch ${c === chosenColor ? 'active' : ''}"
                   style="background:${c}" data-color="${c}" role="button" tabindex="0"
                   aria-label="Color ${c}" aria-pressed="${c === chosenColor}"></div>`).join('')}
          </div>
          <div class="modal-actions">
            <button class="btn" data-do="cancel">Cancel</button>
            <button class="btn btn-primary" data-do="save">${isNew ? 'Add habit' : 'Save'}</button>
          </div>
          ${!isNew ? `<button class="btn-del" data-do="delete">Delete habit</button>` : ''}
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

    root.querySelector('#freq-pills').addEventListener('click', e => {
      const pill = e.target.closest('[data-freq]');
      if (!pill) return;
      chosenPerWeek = pill.dataset.freq ? parseInt(pill.dataset.freq, 10) : null;
      root.querySelectorAll('#freq-pills [data-freq]').forEach(p =>
        p.classList.toggle('active', p === pill));
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
          // Only send per_week when it's set or changing, so habits keep saving
          // before the per_week column exists (see schema.sql).
          const freq = (chosenPerWeek || (habit && habit.per_week)) ? { per_week: chosenPerWeek } : {};
          if (isNew) {
            const h = await db.addHabit(name, chosenColor, state.habits.length, section, freq);
            state.habits.push(h);
          } else {
            await db.updateHabit(habit.id, { name, color: chosenColor, section, ...freq });
            const h = state.habits.find(x => x.id === habit.id);
            if (h) Object.assign(h, { name, color: chosenColor, section, ...freq });
          }
          closeModal();
          renderAll();
        } catch (err) {
          toast(/per_week/.test(err.message)
            ? 'Run the per_week line from schema.sql in Supabase first'
            : 'Couldn\'t save: ' + err.message, 4000);
        }
        return;
      }

      if (action === 'delete') {
        closeModal();
        deleteHabitWithUndo(habit);
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

  // Deleting a habit hides it straight away and offers Undo; the delete (with
  // all its history) only reaches the database once the Undo is gone, or when
  // the app is put away.
  let pendingHabitDelete = null; // { habit, keys, index }

  function deleteHabitWithUndo(habit) {
    commitHabitDelete();
    const index = state.habits.findIndex(x => x.id === habit.id);
    const keys = [...state.entries].filter(k => k.startsWith(habit.id + '|'));
    state.habits = state.habits.filter(x => x.id !== habit.id);
    keys.forEach(k => state.entries.delete(k));
    pendingHabitDelete = { habit, keys, index };
    renderAll();
    toast(`Deleted ${habit.name}`, 0, {
      label: 'Undo',
      fn: () => {
        const p = pendingHabitDelete;
        if (!p || p.habit.id !== habit.id) return;
        pendingHabitDelete = null;
        state.habits.splice(Math.min(p.index, state.habits.length), 0, p.habit);
        p.keys.forEach(k => state.entries.add(k));
        renderAll();
      },
      onExpire: commitHabitDelete,
    });
  }

  function commitHabitDelete() {
    const p = pendingHabitDelete;
    if (!p) return;
    pendingHabitDelete = null;
    db.deleteHabit(p.habit.id).catch(err => {
      state.habits.splice(Math.min(p.index, state.habits.length), 0, p.habit);
      p.keys.forEach(k => state.entries.add(k));
      renderAll();
      toast('Couldn\'t delete: ' + err.message, 4000);
    });
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') commitHabitDelete(); });

  // ============================================================
  // Settings: daily reminder, weather city, account
  // ============================================================
  // reminderState: 'unknown' | 'unsupported' | 'off' | 'on' | 'busy'
  let reminderState = 'unknown';

  function pushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  async function refreshReminderState() {
    if (!pushSupported()) { reminderState = 'unsupported'; return; }
    try {
      const reg = await navigator.serviceWorker.ready;
      reminderState = (await reg.pushManager.getSubscription()) ? 'on' : 'off';
    } catch { reminderState = 'off'; }
  }

  function reminderFnUrl(action) {
    const base = window.SUPABASE_URL;
    return `${base}/functions/v1/reminder${action ? `?action=${action}` : ''}`;
  }

  function b64urlToBytes(b64) {
    const pad = '='.repeat((4 - b64.length % 4) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  }

  async function enableReminder() {
    if (await Notification.requestPermission() !== 'granted') {
      throw new Error('Notifications are blocked. Allow them for Habits in Settings → Notifications.');
    }
    const reg  = await navigator.serviceWorker.ready;
    const resp = await fetch(reminderFnUrl('public-key'), { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(`Reminder setup failed: ${body.error || body.message || `HTTP ${resp.status}`}`);
    }
    const { publicKey } = await resp.json();
    const sub  = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(publicKey) });
    const json = sub.toJSON();
    await window.db.savePushSubscription({ endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth });
  }

  async function disableReminder() {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await window.db.deletePushSubscription(sub.endpoint).catch(() => {});
    await sub.unsubscribe();
  }

  async function testReminder() {
    const resp = await fetch(reminderFnUrl('test'), {
      method: 'POST', headers: await window.auth.headers(), signal: AbortSignal.timeout(20000),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(body.error || `HTTP ${resp.status}`);
    if (!body.sent) throw new Error(body.failed?.[0] || 'No device is subscribed');
  }

  function renderSettings() {
    const root = document.getElementById('settings-body');
    if (reminderState === 'unknown') refreshReminderState().then(() => { renderSettings(); renderToday(); });
    let reminder;
    if (reminderState === 'unsupported') {
      reminder = `
        <div class="set-list"><div class="set-row"><span class="set-main">23:00 reminder</span><span>Not available</span></div></div>
        <p class="set-hint">To get reminders on iPhone, add Habits to your Home Screen (Share → Add to Home Screen) and open it from there.</p>`;
    } else {
      const on   = reminderState === 'on';
      const busy = reminderState === 'busy' || reminderState === 'unknown';
      reminder = `
        <div class="set-list">
          <button class="set-row" data-action="reminder-toggle" role="switch" aria-checked="${on}" ${busy ? 'disabled' : ''}>
            <span class="set-main">23:00 reminder</span><span class="switch${on ? ' on' : ''}"></span>
          </button>
          ${on ? `<button class="set-row" data-action="reminder-test"><span class="set-main">Send a test notification</span><span class="chev">›</span></button>` : ''}
        </div>
        <p class="set-hint">A notification at 23:00 if some habits aren't ticked yet.</p>`;
    }
    const email = window.auth.email();
    const city = localStorage.getItem(WEATHER_CITY_KEY) || morningState.weather?.nearest_area?.[0]?.areaName?.[0]?.value || 'Paris';
    root.innerHTML = `
      <div class="section-label">Daily reminder</div>
      ${reminder}
      <div class="section-label">Weight</div>
      <div class="set-list">
        <button class="set-row" data-action="set-goal"><span class="set-main">Goal weight</span><span>${window.weight?.goal() ? `${window.weight.goal().toFixed(1)} kg` : 'None'} ›</span></button>
      </div>
      <p class="set-hint">Shown as a dashed line on the weight chart, with how far is left on Today.</p>
      <div class="section-label">Morning</div>
      <div class="set-list">
        <button class="set-row" data-action="change-city"><span class="set-main">Weather city</span><span>${esc(city)} ›</span></button>
      </div>
      <div class="section-label">Account</div>
      <div class="set-list">
        <div class="set-row"><span>Signed in as</span><b>${esc(email || '—')}</b></div>
        <button class="set-row danger" data-action="sign-out">Sign out</button>
      </div>`;
  }

  async function handleSettingsAction(action) {
    if (action === 'reminder-toggle') {
      const wasOn = reminderState === 'on';
      reminderState = 'busy'; renderSettings();
      try {
        if (wasOn) { await disableReminder(); toast('Reminder off'); }
        else { await enableReminder(); toast('Reminder on for 23:00'); }
      } catch (err) {
        toast(err.message, 4000);
      }
      await refreshReminderState();
      renderSettings();
      renderToday();
    } else if (action === 'reminder-test') {
      try { await testReminder(); toast('Test sent'); }
      catch (err) { toast(`Test failed: ${err.message}`, 4000); }
    } else if (action === 'sign-out') {
      if (!confirm('Sign out of Habits on this device?')) return;
      if (reminderState === 'on') await disableReminder().catch(() => {});
      await window.auth.signOut();
      try { localStorage.removeItem(MORNING_CACHE_KEY); } catch { /* ignore */ }
      location.reload();
    }
  }

  // ============================================================
  // Morning view
  // ============================================================
  const morningState = {
    weather: null, weatherErr: null,
    calendar: { today: [], tomorrow: [] }, calErr: null, calNotConfigured: false,
    news: null, newsErr: null,
    events: null, eventsErr: null,
    reddit: null, redditErr: null,
    hn: null, hnErr: null,
    transit: null, transitErr: null,
    record: null, recordErr: null, recordDate: null,
    calLoaded: false,
    refreshing: false,
    lastFetched: null,
  };

  // Persist the Morning data across launches so the tab paints instantly with
  // the last good data, then refreshes in the background.
  const MORNING_CACHE_KEY = 'habits.morning.v2';

  function loadMorningCache() {
    try {
      const raw = localStorage.getItem(MORNING_CACHE_KEY);
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
      morningState.hn        = c.hn      || null;
      morningState.record    = c.record  || null;
      morningState.recordDate = c.recordDate || null;
      morningState.calLoaded = !!c.calLoaded;
      morningState.lastFetched = c.lastFetched || null;
      // Yesterday's "today" events are wrong today; refetch instead of showing them.
      if (c.day !== todayStr()) {
        morningState.calendar = { today: [], tomorrow: [] };
        morningState.calLoaded = false;
        morningState.lastFetched = null;
      }
    } catch { /* ignore corrupt cache */ }
  }

  function saveMorningCache() {
    try {
      const serEvs = evs => evs.map(ev => ({
        ...ev, startTime: ev.startTime ? ev.startTime.toISOString() : null,
      }));
      localStorage.setItem(MORNING_CACHE_KEY, JSON.stringify({
        day:      todayStr(),
        weather:  morningState.weather,
        calendar: { today: serEvs(morningState.calendar.today), tomorrow: serEvs(morningState.calendar.tomorrow) },
        news:     morningState.news,
        events:   morningState.events,
        reddit:   morningState.reddit,
        hn:       morningState.hn,
        record:   morningState.record,
        recordDate: morningState.recordDate,
        calLoaded: morningState.calLoaded,
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

  // Open-Meteo reports WMO codes; map them onto the closest WWO code so the
  // fallback reuses WWO_ICONS and the existing render code.
  const WMO_TO_WWO = {
    0: [113, 'Clear'], 1: [116, 'Mainly clear'], 2: [116, 'Partly cloudy'], 3: [122, 'Overcast'],
    45: [248, 'Fog'], 48: [248, 'Freezing fog'],
    51: [263, 'Light drizzle'], 53: [266, 'Drizzle'], 55: [266, 'Heavy drizzle'],
    56: [281, 'Freezing drizzle'], 57: [284, 'Freezing drizzle'],
    61: [296, 'Light rain'], 63: [302, 'Rain'], 65: [308, 'Heavy rain'],
    66: [311, 'Freezing rain'], 67: [314, 'Freezing rain'],
    71: [326, 'Light snow'], 73: [332, 'Snow'], 75: [338, 'Heavy snow'], 77: [179, 'Snow grains'],
    80: [353, 'Light showers'], 81: [356, 'Showers'], 82: [359, 'Heavy showers'],
    85: [368, 'Snow showers'], 86: [371, 'Heavy snow showers'],
    95: [389, 'Thunderstorm'], 96: [392, 'Thunderstorm with hail'], 99: [395, 'Thunderstorm with hail'],
  };

  async function fetchWttr(city) {
    const resp = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`,
      { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error(`Weather ${resp.status}`);
    const data = await resp.json();
    if (!data.current_condition?.[0] || !data.weather?.[0]) throw new Error('Weather: bad response');
    return data;
  }

  // Fallback when wttr.in is down: Open-Meteo, reshaped into wttr's j1 format.
  async function fetchOpenMeteo(city) {
    const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city)}`,
      { signal: AbortSignal.timeout(8000) });
    if (!g.ok) throw new Error(`Geocoding ${g.status}`);
    const place = (await g.json()).results?.[0];
    if (!place) throw new Error(`City not found: ${city}`);
    const params = new URLSearchParams({
      latitude: place.latitude, longitude: place.longitude, timezone: 'auto', forecast_days: '1',
      current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m',
      daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum,sunrise,sunset',
    });
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`Weather ${r.status}`);
    const d = await r.json();
    const [code, desc] = WMO_TO_WWO[d.current.weather_code] || [119, 'Cloudy'];
    const hhmm = iso => (iso || '').slice(11, 16);
    return {
      current_condition: [{
        temp_C: String(Math.round(d.current.temperature_2m)),
        FeelsLikeC: String(Math.round(d.current.apparent_temperature)),
        weatherCode: String(code),
        weatherDesc: [{ value: desc }],
        windspeedKmph: String(Math.round(d.current.wind_speed_10m)),
      }],
      weather: [{
        maxtempC: String(Math.round(d.daily.temperature_2m_max[0])),
        mintempC: String(Math.round(d.daily.temperature_2m_min[0])),
        hourly: [{ precipMM: String(d.daily.precipitation_sum[0] || 0) }],
        astronomy: [{ sunrise: hhmm(d.daily.sunrise[0]), sunset: hhmm(d.daily.sunset[0]) }],
      }],
      nearest_area: [{ areaName: [{ value: place.name }] }],
    };
  }

  async function fetchWeather() {
    const city = localStorage.getItem(WEATHER_CITY_KEY) || 'Paris';
    try {
      morningState.weather = await fetchWttr(city);
    } catch {
      morningState.weather = await fetchOpenMeteo(city);
    }
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

  // The Supabase Edge Function in supabase/functions/morning fetches things the
  // browser can't (no CORS) or that need a secret (the iCal URL) server-side.
  function morningFnUrl(params) {
    const base = window.SUPABASE_URL;
    if (!base || base.startsWith('REPLACE_ME')) return null;
    return `${base}/functions/v1/morning?${new URLSearchParams(params)}`;
  }

  async function fetchCalendarEvents() {
    const url = morningFnUrl({ source: 'ical' });
    if (!url) { morningState.calNotConfigured = true; return; }
    let resp;
    try {
      resp = await fetch(url, { headers: await window.auth.headers(), signal: AbortSignal.timeout(20000) });
    } catch (err) {
      throw new Error(`Calendar unreachable (${err.message})`);
    }
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      if (resp.status === 404 && body.error === 'not_configured') { morningState.calNotConfigured = true; return; }
      if (resp.status === 404) throw new Error('Calendar function not deployed (see README)');
      throw new Error(`Calendar failed (${body.error || 'HTTP ' + resp.status})`);
    }
    morningState.calNotConfigured = false;
    parseIcal(await resp.text());
    morningState.calLoaded = true;
  }

  // opts: { filter?: (item) => boolean } — filter is applied BEFORE slicing to
  // `count`, so callers get `count` matches (not `count` fetched then filtered).
  async function fetchRSSFeed(rssUrl, count, opts) {
    // Prefer the Supabase function (raw XML, handles both RSS <item> and Atom
    // <entry>); fall back to rss2json (server-side parse to JSON), e.g. when
    // Reddit rate-limits the function's cloud IP.
    try {
      return await fetchRSSViaFunction(rssUrl, count, opts);
    } catch (_) {
      return await fetchRSSViaJson(rssUrl, count, opts);
    }
  }

  function applyFeedFilter(items, count, opts) {
    const filter = opts && opts.filter;
    const kept = filter ? items.filter(filter) : items;
    return kept.slice(0, count || 5);
  }

  async function fetchRSSViaFunction(rssUrl, count, opts) {
    const url = morningFnUrl({ source: 'rss', url: rssUrl });
    if (!url) throw new Error('No Supabase function');
    const resp = await fetch(url, { headers: await window.auth.headers(), signal: AbortSignal.timeout(10000) });
    if (!resp.ok) throw new Error(`RSS ${resp.status}`);
    const xml = await resp.text();
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    // RSS 2.0 uses <item>; Atom (e.g. Reddit) uses <entry>. Support both.
    let nodes = [...doc.querySelectorAll('item')];
    if (!nodes.length) nodes = [...doc.querySelectorAll('entry')];
    const all = nodes.map(el => {
      const text = sel => el.querySelector(sel)?.textContent?.trim() || '';
      // RSS: <link>url</link>. Atom: <link href="url"/>.
      let link = text('link');
      if (!link) link = el.querySelector('link')?.getAttribute('href') || '';
      const raw  = text('pubDate') || text('published') || text('updated');
      const d    = raw ? new Date(raw) : null;
      const pubDate = d && !isNaN(d)
        ? d.toLocaleDateString([], { month: 'short', day: 'numeric' })
        : '';
      const author = text('author > name') || text('author') || '';
      return { title: text('title'), link, pubDate, author };
    });
    return applyFeedFilter(all, count, opts);
  }

  async function fetchRSSViaJson(rssUrl, count, opts) {
    const api  = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}`;
    const resp = await fetch(api, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) throw new Error(`RSS ${resp.status}`);
    const data = await resp.json();
    if (data.status !== 'ok') throw new Error(`RSS ${data.message || 'error'}`);
    const all = (data.items || []).map(it => {
      // rss2json returns "YYYY-MM-DD HH:MM:SS" (UTC); normalize for Safari.
      const raw = it.pubDate || '';
      const d   = raw ? new Date(raw.replace(' ', 'T') + 'Z') : null;
      const pubDate = d && !isNaN(d)
        ? d.toLocaleDateString([], { month: 'short', day: 'numeric' })
        : '';
      return { title: it.title || '', link: it.link || '', pubDate, author: it.author || '' };
    });
    return applyFeedFilter(all, count, opts);
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

  // HN's Firebase API is CORS-friendly, so no proxy is needed. beststories.json
  // returns ~200 story ids; fetch the item payload for the first `count` in
  // parallel, and fall back to the discussion permalink for self-posts (no url).
  async function fetchHackerNews(count = 5) {
    try {
      const idsResp = await fetch('https://hacker-news.firebaseio.com/v0/beststories.json', { signal: AbortSignal.timeout(8000) });
      if (!idsResp.ok) throw new Error(`HN ${idsResp.status}`);
      const ids = (await idsResp.json()).slice(0, count);
      const items = await Promise.all(ids.map(async id => {
        const r = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error(`HN ${r.status}`);
        const it = await r.json();
        const d  = it.time ? new Date(it.time * 1000) : null;
        return {
          title: it.title || '',
          link:  it.url || `https://news.ycombinator.com/item?id=${it.id}`,
          pubDate: d ? d.toLocaleDateString([], { month: 'short', day: 'numeric' }) : '',
        };
      }));
      morningState.hn = items;
    } catch (err) {
      morningState.hnErr = err.message;
    }
  }

  async function fetchReddit() {
    try {
      // Skip subreddit meta-posts (stickied megathreads, mod recruitment) — the
      // author of those is typically a *Mods account, and the title starts with
      // /r/<sub> or contains "Discussion Thread" / "looking for new moderators".
      const isMeta = it => {
        const t = (it.title || '').trim();
        const a = (it.author || '').trim();
        if (/^\/?r\//i.test(t)) return true;
        if (/discussion thread|megathread|looking for new moderators|click here to apply/i.test(t)) return true;
        if (/\bMods?\b/.test(a)) return true;
        return false;
      };
      morningState.reddit = await fetchRSSFeed(
        'https://www.reddit.com/r/worldnews/.rss', 5, { filter: it => !isMeta(it) }
      );
    } catch (err) {
      morningState.redditErr = err.message;
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
    // Prefer the Supabase function (talks to BVG/VBB HAFAS directly); fall back
    // to the public transport.rest wrapper, which is often down (503).
    const fnUrl = morningFnUrl({ source: 'departures', stop: STOP_ID, duration: '90', results: '30' });
    const sources = [
      fnUrl && { url: fnUrl, headers: await window.auth.headers() },
      { url: `https://v6.bvg.transport.rest/stops/${STOP_ID}/departures?duration=90&results=30&${products}`, headers: {} },
    ].filter(Boolean);
    let data = null, lastErr = null;
    for (const { url, headers } of sources) {
      try {
        const resp = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
        if (!resp.ok) { lastErr = new Error(`BVG ${resp.status}`); continue; }
        data = await resp.json();
        break;
      } catch (err) { lastErr = err; }
    }
    if (!data) throw new Error(`Departures unavailable (${lastErr?.message || 'unknown error'})`);
    morningState.transit = (data.departures || [])
      .filter(d => d.line?.name?.replace(/\s+/g, '') === 'U7'
                && d.direction?.toLowerCase().includes('spandau'))
      .slice(0, 3);
  }

  async function fetchDiscogsRecord() {
    const username = window.DISCOGS_USERNAME;
    const token    = window.DISCOGS_TOKEN;
    if (!username || username.startsWith('REPLACE_ME') || !token || token.startsWith('REPLACE_ME')) return;
    // The record is stable for the day, so a cached one from today is final.
    if (morningState.record && morningState.recordDate === todayStr()) return;
    const headers = {
      'Authorization': `Discogs token=${token}`,
      'User-Agent': 'HabitsApp/1.0 +https://julienvarin.github.io/habits/',
    };
    const signal = () => AbortSignal.timeout(10000);
    // 1. Get total count
    const r1 = await fetch(
      `https://api.discogs.com/users/${encodeURIComponent(username)}/collection/folders/0/releases?per_page=1&page=1`,
      { headers, signal: signal() }
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
      { headers, signal: signal() }
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
      const r3 = await fetch(`https://api.discogs.com/releases/${releaseId}`, { headers, signal: signal() });
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
    morningState.recordDate = todayStr();
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
    if (morningState.calNotConfigured) {
      calBody = `<p class="cal-setup-note">Set the <code>ICAL_URL</code> secret on the Supabase <code>morning</code> function to connect your calendar.</p>`;
    } else if (morningState.calErr) {
      calBody = `<p class="morning-error">${esc(morningState.calErr)}</p>`;
    } else if (!morningState.calLoaded) {
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

    // ---- Hacker News ----
    let hnBody;
    if (morningState.hnErr) {
      hnBody = `<p class="morning-error">${esc(morningState.hnErr)}</p>`;
    } else if (!morningState.hn) {
      hnBody = skelLines(['82%','68%','86%','60%','74%']);
    } else {
      hnBody = morningState.hn.map(item => `
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
    const refreshing = morningState.refreshing || !morningState.lastFetched;
    const refreshRow = `
      <div class="morning-refresh">
        <span class="morning-updated">${refreshing ? 'Updating…' : `Updated ${formatAgo(morningState.lastFetched)}`}${morningState.outdated?.length ? ` · ${esc(morningState.outdated.join(', '))} outdated` : ''}</span>
        <button class="morning-refresh-btn${refreshing ? ' spinning' : ''}" data-action="refresh-morning" aria-label="Refresh" ${refreshing ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>
          </svg>
        </button>
      </div>`;

    root.innerHTML = `
      <div class="sec-head"><h2>Morning</h2>${refreshRow}</div>
      <div class="morning-grid">
        ${yearCard}
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
          <div class="morning-card-title">Record of the day</div>
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
          <div class="morning-card-title">Hacker News</div>
          ${hnBody}
        </div>
      </div>`;
  }

  let morningRenderQueued = false;
  function queueMorningRender() {
    if (morningRenderQueued) return;
    morningRenderQueued = true;
    requestAnimationFrame(() => { morningRenderQueued = false; renderMorning(); });
  }

  async function initMorningView() {
    if (morningState.refreshing) return;
    const STALE_MS = 30 * 60 * 1000;
    const stale    = !morningState.lastFetched || (Date.now() - morningState.lastFetched > STALE_MS);

    // Transit is always refreshed (time-sensitive), and old departures are useless.
    morningState.transit = null; morningState.transitErr = null;
    morningState.refreshing = true;
    renderMorning();

    // Each source re-renders as soon as it lands. Cached data stays on screen
    // while refreshing; if a refresh fails, the old data is kept and flagged
    // as outdated instead of being replaced by an error.
    const outdated = [];
    const run = (label, errKey, hasData, fn) => {
      morningState[errKey] = null;
      return Promise.resolve()
        .then(fn)
        .catch(err => { morningState[errKey] = err.message; })
        .then(() => {
          if (morningState[errKey] && hasData()) {
            morningState[errKey] = null;
            outdated.push(label);
          }
          queueMorningRender();
        });
    };

    const fetches = [
      run('U7', 'transitErr', () => false, fetchBVGDepartures),
    ];
    if (stale) {
      fetches.push(
        run('Weather',  'weatherErr', () => !!morningState.weather, fetchWeather),
        run('Calendar', 'calErr',     () => morningState.calLoaded, fetchCalendarEvents),
        run('News',     'newsErr',    () => !!morningState.news,    fetchNews),
        run('Events',   'eventsErr',  () => !!morningState.events,  fetchBerlinEvents),
        run('Reddit',   'redditErr',  () => !!morningState.reddit,  fetchReddit),
        run('HN',       'hnErr',      () => !!morningState.hn,      fetchHackerNews),
        run('Record',   'recordErr',  () => !!morningState.record,  fetchDiscogsRecord),
      );
    }

    await Promise.all(fetches);

    morningState.refreshing = false;
    if (stale) {
      morningState.outdated = outdated;
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

    if (action === 'reminder-toggle' || action === 'reminder-test' || action === 'sign-out') {
      handleSettingsAction(action);
    } else if (action === 'refresh-morning') {
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
        renderSettings();
        fetchWeather().catch(err => { morningState.weatherErr = err.message; }).then(() => { renderMorning(); renderSettings(); });
      }
    } else if (action === 'toggle') {
      if (e.target.closest('[data-action="edit"]')) return;
      toggle(id, todayStr());
    } else if (action === 'toggle-bigtask') {
      if (window.journalBig) {
        window.journalBig.toggleFor(selectedBigTaskDate());
        renderAll();
      }
    } else if (action === 'bigtask-prev') {
      state.bigTaskDayOffset++;
      renderToday();
    } else if (action === 'bigtask-next') {
      if (state.bigTaskDayOffset > 0) { state.bigTaskDayOffset--; renderToday(); }
    } else if (action === 'bigtask-today') {
      state.bigTaskDayOffset = 0;
      renderToday();
    } else if (action === 'edit') {
      e.stopPropagation();
      openModal(state.habits.find(h => h.id === id));
    } else if (action === 'toggle-day') {
      toggle(id, date);
    } else if (action === 'today-week-back') {
      state.todayWeekOffset++;
      renderHabits();
    } else if (action === 'today-week-fwd') {
      if (state.todayWeekOffset > 0) { state.todayWeekOffset--; renderHabits(); }
    } else if (action === 'stats-filter') {
      const h = el.dataset.habit;
      statsWeight = h === 'weight';
      statsHabit = h === 'all' || statsWeight ? null : state.habits.find(x => x.id === h) || null;
      renderStats();
    } else if (action === 'weight-log') {
      if (W()) openWeightLog(el.dataset.date);
    } else if (action === 'wt-step') {
      const inp = document.getElementById('wt-kg');
      const base = readKg() ?? W().latest()?.kg ?? 70;
      inp.value = kgStr(Math.max(0.1, base + parseFloat(el.dataset.d)));
      haptic();
    } else if (action === 'wt-save') {
      saveWeightLog();
    } else if (action === 'wt-del') {
      deleteWeighIn(wtDate);
    } else if (action === 'sheet-close') {
      closeSheet();
    } else if (action === 'weight-range') {
      weightRange = el.dataset.range;
      renderStats();
    } else if (action === 'set-goal') {
      const cur = W().goal();
      const v = prompt('Goal weight in kg (leave empty for none):', cur ? kgStr(cur) : '');
      if (v === null) return;
      const kg = parseFloat(v.replace(',', '.'));
      W().setGoal(kg > 0 && kg < 1000 ? kg : null);
      renderSettings();
    } else if (action === 'stats-month') {
      statsMonth = Math.max(0, parseInt(el.dataset.month, 10) || 0);
      renderStats();
    } else if (action === 'go-stats') {
      statsHabit = state.habits.find(x => x.id === el.dataset.habit) || null;
      statsWeight = false;
      statsMonth = 0;
      showView('stats');
    } else if (action === 'add-habit') {
      if (quickOpen) closeSheet();
      openModal(null);
    } else if (action === 'quick-check') {
      openQuickCheck();
    } else if (action === 'quick-toggle') {
      toggle(id, todayStr());
    } else if (action === 'alert') {
      const a = alertList[+el.dataset.i];
      if (a) { lsAdd(LS_SEEN, [a.id]); renderBell(); followAlert(a); }
    } else if (action === 'tip-dismiss') {
      const a = alertList[+el.dataset.i];
      if (a) { haptic(); lsAdd(LS_HIDDEN, [a.id]); lsAdd(LS_SEEN, [a.id]); renderToday(); }
    } else if (action === 'open-alerts') {
      openAlerts();
    }
  });

  document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'wt-kg') saveWeightLog(); });

  document.getElementById('home-bell').addEventListener('click', openAlerts);
  document.getElementById('home-settings').addEventListener('click', () => { haptic(); showView('settings'); });
  document.getElementById('sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });

  // Tab switching
  function showView(v) {
    if (state.view === 'today' && v !== 'today' && state.bigTaskDayOffset) {
      state.bigTaskDayOffset = 0;
      renderToday();
    }
    if (state.view === 'habits' && v !== 'habits' && state.todayWeekOffset) {
      state.todayWeekOffset = 0;
      renderHabits();
    }
    state.view = v;
    document.querySelectorAll('.tab').forEach(t => {
      const on = t.dataset.view === v;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.view').forEach(s => s.classList.toggle('active', s.id === `view-${v}`));
    if (v === 'stats') renderStats();
    if (v === 'settings') renderSettings();
    window.scrollTo(0, 0);
  }

  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      haptic();
      if (state.view === btn.dataset.view) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
      showView(btn.dataset.view);
    });
  });

  // ✓: today's habits as squares to tap
  document.getElementById('fab').addEventListener('click', openQuickCheck);

  // Re-fetch when the tab becomes visible / focused (picks up changes made on another device).
  // visibilitychange is more reliable than focus in iOS PWAs.
  function refetchOnReturn() {
    if (document.visibilityState !== 'visible') return;
    if (!state.loading) load();
    renderHomeHead();
    initMorningView();
    if (window.syncTodos) window.syncTodos();
    if (window.syncJournal) window.syncJournal();
    if (window.weight) window.weight.sync();
  }
  window.addEventListener('focus', refetchOnReturn);
  document.addEventListener('visibilitychange', refetchOnReturn);

  // ============================================================
  // Today's header: the date and a greeting
  // ============================================================
  function renderHomeHead() {
    document.getElementById('home-date').textContent =
      new Date().toLocaleDateString(undefined, { weekday:'long', month:'short', day:'numeric' });
    document.getElementById('home-hello').textContent = greeting();
  }

  // ============================================================
  // Init
  // ============================================================
  renderHomeHead();
  load();
  refreshReminderState().then(() => { if (!state.loading) renderToday(); });
  if (window.initTodo) window.initTodo();
  if (window.initJournal) window.initJournal();
  if (window.weight) window.weight.init();
  initMorningView();
})();
