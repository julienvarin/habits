(function () {
  'use strict';

  const CACHE_KEY = 'habits.journal.v1';        // last-known-good entries, doubles as offline store
  const QUEUE_KEY = 'habits.journal.queue.v1';  // writes that couldn't reach Supabase

  // entries: date(YYYY-MM-DD) -> { date, day, learnt, updatedAt }
  const entries   = new Map();
  let   viewDate  = todayStr();  // the day currently being viewed/edited
  let   saveTimer = null;        // debounce handle for the current editor
  let   eventsReady = false;

  // ============================================================
  // Date helpers (local timezone — mirrors app.js, kept self-contained)
  // ============================================================
  function pad(n)         { return String(n).padStart(2, '0'); }
  function fmtDate(d)     { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function todayStr()     { return fmtDate(new Date()); }
  function shiftDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
  function parseDate(s)   { return new Date(s + 'T00:00:00'); } // avoid UTC parsing

  const _ESC = { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' };
  function esc(s) { return String(s).replace(/[&<>"']/g, c => _ESC[c]); }

  // ============================================================
  // Storage (local cache + offline write queue)
  // ============================================================
  function loadCache() {
    entries.clear();
    try {
      const arr = JSON.parse(localStorage.getItem(CACHE_KEY) || '[]');
      for (const e of arr) entries.set(e.date, e);
    } catch { /* corrupt cache — start empty */ }
  }
  function saveCache() {
    localStorage.setItem(CACHE_KEY, JSON.stringify([...entries.values()]));
  }

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
        if      (op.op === 'upsert') await window.db.upsertJournal(op.payload);
        else if (op.op === 'delete') await window.db.deleteJournal(op.date);
      } catch { remaining.push(op); }
    }
    localStorage.setItem(QUEUE_KEY, JSON.stringify(remaining));
  }

  // Map local shape <-> DB row shape
  function toRow(e) {
    return {
      date: e.date,
      day_text: e.day || null,
      learnt_text: e.learnt || null,
      tomorrow_text: e.tomorrow || null,
      big_done: !!e.bigDone,
      updated_at: e.updatedAt,
    };
  }
  function fromRow(r) {
    return {
      date: r.date,
      day: r.day_text || '',
      learnt: r.learnt_text || '',
      tomorrow: r.tomorrow_text || '',
      bigDone: !!r.big_done,
      updatedAt: r.updated_at || 0,
    };
  }

  // ============================================================
  // Sync (last-write-wins per day, keyed on updatedAt)
  // ============================================================
  async function sync() {
    if (!window.db) return;
    try {
      await flushQueue();

      const remote    = (await window.db.listJournal() || []).map(fromRow);
      const remoteMap = new Map(remote.map(e => [e.date, e]));

      // Reconcile local vs remote per day.
      for (const local of [...entries.values()]) {
        const r = remoteMap.get(local.date);
        if (!r) {
          // Local-only (offline create or first migration) — push it up.
          try { await window.db.upsertJournal(toRow(local)); remoteMap.set(local.date, local); }
          catch { /* keep local; next sync retries */ }
        } else if ((local.updatedAt || 0) > (r.updatedAt || 0)) {
          // Local is newer — push and win.
          try { await window.db.upsertJournal(toRow(local)); remoteMap.set(local.date, local); }
          catch { remoteMap.set(local.date, local); }
        }
        // else remote wins (already in remoteMap)
      }

      entries.clear();
      for (const [d, e] of remoteMap) entries.set(d, e);
      saveCache();
      render();
      window.renderStats?.();
    } catch {
      // offline — keep cached state
    }
  }

  // ============================================================
  // Scoring helpers — a day "counts" when its day_text is non-empty
  // ============================================================
  function hasDay(dstr) {
    const e = entries.get(dstr);
    return !!(e && e.day && e.day.trim());
  }
  function journaledDates() {
    const out = [];
    for (const [d, e] of entries) if (e.day && e.day.trim()) out.push(d);
    return out.sort();
  }
  function firstDayDate() {
    const d = journaledDates();
    return d.length ? d[0] : null;
  }
  function currentStreak() {
    const set = new Set(journaledDates());
    let d = new Date();
    if (!set.has(todayStr())) d = shiftDays(d, -1); // today still open — count from yesterday
    let n = 0;
    while (set.has(fmtDate(d))) { n++; d = shiftDays(d, -1); }
    return n;
  }
  function longestStreak() {
    const dates = journaledDates();
    if (!dates.length) return 0;
    let best = 1, cur = 1;
    for (let i = 1; i < dates.length; i++) {
      const diff = (parseDate(dates[i]) - parseDate(dates[i - 1])) / 86400000;
      cur = diff === 1 ? cur + 1 : 1;
      if (cur > best) best = cur;
    }
    return best;
  }

  // Exposed for the Stats tab so "all habits" aggregates include journaling
  // and so the Stats page can surface journal KPIs directly.
  // Journaling is considered "active" from its first entry onward.
  window.journalScore = {
    activeOn: dstr => { const f = firstDayDate(); return f ? dstr >= f : false; },
    doneOn:   dstr => hasDay(dstr),
    firstDate: firstDayDate,
    count:    () => journaledDates().length,
    yearCount: y => journaledDates().filter(d => d.startsWith(String(y))).length,
    streak:   currentStreak,
    longest:  longestStreak,
  };

  // ============================================================
  // "One big task" — the single thing chosen the day before.
  // Written on day D as `tomorrow`, it becomes day D+1's big task.
  // ============================================================
  function tomorrowText(dstr) {
    const e = entries.get(dstr);
    return e && e.tomorrow ? e.tomorrow.trim() : '';
  }
  // The big task assigned for `dstr` is yesterday's "tomorrow" note.
  function bigTaskFor(dstr) {
    return tomorrowText(fmtDate(shiftDays(parseDate(dstr), -1)));
  }
  function bigDoneOn(dstr) {
    const e = entries.get(dstr);
    return !!(e && e.bigDone);
  }
  function bigActiveOn(dstr) {
    return !!bigTaskFor(dstr);
  }
  // Dates that HAVE a big task assigned (i.e. the day after any "tomorrow" note).
  function bigAssignedDates() {
    const out = [];
    for (const [d, e] of entries) {
      if (e.tomorrow && e.tomorrow.trim()) out.push(fmtDate(shiftDays(parseDate(d), 1)));
    }
    return out.sort();
  }
  function bigDoneCount() {
    return bigAssignedDates().filter(bigDoneOn).length;
  }
  function bigStreak() {
    const assigned = new Set(bigAssignedDates());
    let d = new Date();
    // Today's task may still be open — don't let that break the streak.
    if (assigned.has(todayStr()) && !bigDoneOn(todayStr())) d = shiftDays(d, -1);
    let n = 0;
    while (assigned.has(fmtDate(d)) && bigDoneOn(fmtDate(d))) { n++; d = shiftDays(d, -1); }
    return n;
  }
  function setBigDone(dstr, val) {
    const e = getEntry(dstr);
    e.bigDone = val;
    entries.set(dstr, e);
    persist(dstr);
  }

  window.journalBig = {
    todayText:  () => bigTaskFor(todayStr()),
    todayDone:  () => bigDoneOn(todayStr()),
    toggleToday: () => setBigDone(todayStr(), !bigDoneOn(todayStr())),
    activeOn:   bigActiveOn,
    doneOn:     bigDoneOn,
    streak:     bigStreak,
    doneCount:  bigDoneCount,
  };

  // ============================================================
  // Persistence for the current editor
  // ============================================================
  function getEntry(dstr) {
    let e = entries.get(dstr);
    if (!e) e = { date: dstr, day: '', learnt: '', tomorrow: '', bigDone: false, updatedAt: 0 };
    // Normalize entries loaded before these fields existed.
    if (e.tomorrow == null) e.tomorrow = '';
    if (e.bigDone == null)  e.bigDone = false;
    return e;
  }

  function persist(dstr) {
    clearTimeout(saveTimer);
    saveTimer = null;
    const e = entries.get(dstr);
    if (!e) return;

    const empty = !e.day.trim() && !e.learnt.trim() && !(e.tomorrow || '').trim() && !e.bigDone;
    if (empty) {
      entries.delete(dstr);
      saveCache();
      setStatus('');
      if (window.db) {
        window.db.deleteJournal(dstr).catch(() => queuePush({ op: 'delete', date: dstr }));
      }
      window.renderStats?.();
      return;
    }

    e.updatedAt = Date.now();
    saveCache();
    setStatus('Saved');
    const row = toRow(e);
    if (window.db) {
      window.db.upsertJournal(row).catch(() => queuePush({ op: 'upsert', payload: row }));
    }
    window.renderStats?.();
  }

  function scheduleSave(dstr) {
    clearTimeout(saveTimer);
    setStatus('Saving…');
    saveTimer = setTimeout(() => persist(dstr), 700);
  }

  // Flush any pending debounce immediately (called before navigating away / leaving page)
  function flushPending() {
    if (saveTimer) persist(viewDate);
  }

  function setStatus(text) {
    const el = document.getElementById('jr-status');
    if (el) el.textContent = text;
  }

  // ============================================================
  // Render
  // ============================================================
  function dayLabel(dstr) {
    if (dstr === todayStr()) return 'Today';
    if (dstr === fmtDate(shiftDays(new Date(), -1))) return 'Yesterday';
    return parseDate(dstr).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }

  function navHtml() {
    const isToday = viewDate >= todayStr();
    const has     = hasDay(viewDate);
    return `
      <div class="jr-nav">
        <button class="jr-nav-btn" data-jaction="prev" aria-label="Previous day">‹</button>
        <div class="jr-nav-label">
          <span class="jr-nav-day">${esc(dayLabel(viewDate))}${has ? ' <span class="jr-dot" title="Journaled"></span>' : ''}</span>
          <span class="jr-nav-date">${esc(viewDate)}</span>
        </div>
        <button class="jr-nav-btn" data-jaction="next" aria-label="Next day" ${isToday ? 'disabled' : ''}>›</button>
        ${viewDate !== todayStr() ? `<button class="jr-today-btn" data-jaction="today">Today</button>` : ''}
      </div>`;
  }

  function recentHtml() {
    const dates = [...entries.keys()]
      .filter(d => { const e = entries.get(d); return (e.day && e.day.trim()) || (e.learnt && e.learnt.trim()); })
      .sort().reverse()
      .slice(0, 40);
    if (!dates.length) return '';
    const items = dates.map(d => {
      const e       = entries.get(d);
      const preview = (e.day || e.learnt || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      return `
        <button class="jr-recent-item ${d === viewDate ? 'current' : ''}" data-jdate="${esc(d)}">
          <span class="jr-recent-date">${esc(dayLabel(d))}</span>
          <span class="jr-recent-preview">${esc(preview)}</span>
        </button>`;
    }).join('');
    return `
      <div class="jr-recent">
        <div class="jr-recent-title">Past entries</div>
        ${items}
      </div>`;
  }

  function editorHtml() {
    return `
      <div class="jr-editor">
        <div class="jr-field">
          <textarea id="jr-day" class="jr-textarea" rows="4" maxlength="2000"
                    aria-label="What I did today"
                    placeholder="What I did today" spellcheck="true"></textarea>
        </div>
        <div class="jr-field">
          <textarea id="jr-learnt" class="jr-textarea" rows="4" maxlength="2000"
                    aria-label="What I learnt today"
                    placeholder="What I learnt today" spellcheck="true"></textarea>
        </div>
        <div class="jr-field">
          <textarea id="jr-tomorrow" class="jr-textarea" rows="2" maxlength="500"
                    aria-label="One thing to do tomorrow"
                    placeholder="One thing to do tomorrow" spellcheck="true"></textarea>
        </div>
        <div class="jr-status-row"><span id="jr-status" class="jr-status"></span></div>
      </div>`;
  }

  // Rebuild only the non-editor chrome (nav / recent) so typing never
  // disturbs the textarea focus or caret.
  function renderMeta() {
    const n = document.getElementById('jr-nav-wrap'); if (n) n.innerHTML = navHtml();
    const r = document.getElementById('jr-recent-wrap'); if (r) r.innerHTML = recentHtml();
  }

  function render() {
    const root = document.getElementById('view-journal');
    if (!root) return;

    root.innerHTML = `
      <div id="jr-nav-wrap">${navHtml()}</div>
      <div id="jr-editor-wrap">${editorHtml()}</div>
      <div id="jr-recent-wrap">${recentHtml()}</div>`;

    attachClickEvents();
    hydrateEditor();
  }

  // Fill textareas from state and wire input/blur handlers (called once per viewDate)
  function hydrateEditor() {
    const e     = getEntry(viewDate);
    const dayEl = document.getElementById('jr-day');
    const lrnEl = document.getElementById('jr-learnt');
    const tmrEl = document.getElementById('jr-tomorrow');
    if (!dayEl || !lrnEl || !tmrEl) return;

    dayEl.value = e.day;
    lrnEl.value = e.learnt;
    tmrEl.value = e.tomorrow;
    autosize(dayEl); autosize(lrnEl); autosize(tmrEl);

    const onInput = (el, key) => {
      const cur = getEntry(viewDate);
      cur[key] = el.value;
      entries.set(viewDate, cur);   // ensure it's tracked
      autosize(el);
      scheduleSave(viewDate);
      renderMeta();                 // live streak / dot / recent update
    };

    dayEl.addEventListener('input', () => onInput(dayEl, 'day'));
    lrnEl.addEventListener('input', () => onInput(lrnEl, 'learnt'));
    tmrEl.addEventListener('input', () => onInput(tmrEl, 'tomorrow'));
    dayEl.addEventListener('blur',  () => flushPending());
    lrnEl.addEventListener('blur',  () => flushPending());
    tmrEl.addEventListener('blur',  () => flushPending());
  }

  function autosize(el) {
    el.style.height = 'auto';
    el.style.height = Math.max(el.scrollHeight, 88) + 'px';
  }

  function goToDate(dstr) {
    if (dstr > todayStr()) return;          // no future journaling
    flushPending();
    viewDate = dstr;
    render();
  }

  // ============================================================
  // Events
  // ============================================================
  // Delegated click handler — must be re-attached on each render because
  // #view-journal now lives inside #view-today and gets recreated whenever
  // Today re-renders (e.g. after a habit tick).
  function attachClickEvents() {
    const root = document.getElementById('view-journal');
    if (!root) return;

    root.addEventListener('click', e => {
      const nav = e.target.closest('[data-jaction]');
      if (nav) {
        const a = nav.dataset.jaction;
        if (a === 'prev')  goToDate(fmtDate(shiftDays(parseDate(viewDate), -1)));
        if (a === 'next')  goToDate(fmtDate(shiftDays(parseDate(viewDate), 1)));
        if (a === 'today') goToDate(todayStr());
        return;
      }
      const rec = e.target.closest('[data-jdate]');
      if (rec) { goToDate(rec.dataset.jdate); return; }
    });
  }

  // ============================================================
  // Init
  // ============================================================
  function initJournal() {
    loadCache();
    viewDate = todayStr();
    if (!eventsReady) {
      window.addEventListener('beforeunload', flushPending);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushPending();
      });
      eventsReady = true;
    }
    render();
    sync();
  }

  window.initJournal   = initJournal;
  window.renderJournal = render;
  window.syncJournal   = sync;
})();
