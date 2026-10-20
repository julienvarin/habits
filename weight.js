(function () {
  'use strict';

  // Body weight: one weigh-in per day (kg, one decimal), plus a goal.
  // Same offline model as the journal: a local cache paints straight away,
  // writes that can't reach Supabase wait in a queue, and a sync replays the
  // queue, then takes the server's list with any still-queued writes on top.
  const CACHE_KEY = 'habits.weight.v1';
  const QUEUE_KEY = 'habits.weight.queue.v1';
  const GOAL_KEY  = 'habits.weight.goal.v1';

  const entries = new Map(); // 'YYYY-MM-DD' -> kg
  let goal = null;           // kg, or null
  let missing = false;       // the weights table isn't in Supabase yet (run schema.sql)

  function pad(n)          { return String(n).padStart(2, '0'); }
  function fmtDate(d)      { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function shiftDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
  function parseDate(s)    { return new Date(s + 'T00:00:00'); } // avoid UTC parsing
  const round1 = n => Math.round(n * 10) / 10;

  // ============================================================
  // Storage
  // ============================================================
  function loadCache() {
    try {
      const arr = JSON.parse(localStorage.getItem(CACHE_KEY) || '[]');
      entries.clear();
      for (const [d, kg] of arr) entries.set(d, kg);
    } catch { /* ignore */ }
    const g = parseFloat(localStorage.getItem(GOAL_KEY));
    goal = g > 0 ? g : null;
  }
  function saveCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify([...entries])); } catch { /* ignore */ }
  }
  function loadQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; }
  }
  function saveQueue(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }
  function queuePush(op) {
    // Only the latest write per day (or for the goal) matters.
    const key = op.date || op.op;
    saveQueue(loadQueue().filter(o => (o.date || o.op) !== key).concat(op));
  }

  function send(op) {
    if (op.op === 'upsert') return window.db.upsertWeight({ date: op.date, kg: op.kg, updated_at: Date.now() });
    if (op.op === 'delete') return window.db.deleteWeight(op.date);
    if (op.op === 'goal')   return window.db.setPref('weight_goal', op.kg == null ? null : String(op.kg));
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
    window.renderWeight?.();
  }

  // ============================================================
  // Sync
  // ============================================================
  async function sync() {
    if (!window.db) return;
    try {
      await flushQueue();
      const [rows, prefs] = await Promise.all([window.db.listWeights(), window.db.listPrefs()]);
      missing = false;
      entries.clear();
      for (const r of rows || []) entries.set(r.date, Number(r.kg));
      const g = (prefs || []).find(p => p.key === 'weight_goal');
      goal = g && parseFloat(g.value) > 0 ? parseFloat(g.value) : null;
      // Writes still waiting to reach the server win over what it sent back.
      for (const op of loadQueue()) {
        if (op.op === 'upsert') entries.set(op.date, op.kg);
        else if (op.op === 'delete') entries.delete(op.date);
        else if (op.op === 'goal') goal = op.kg;
      }
      if (goal) localStorage.setItem(GOAL_KEY, String(goal)); else localStorage.removeItem(GOAL_KEY);
      changed();
    } catch (err) {
      // Offline, or the weights/prefs tables don't exist yet (run schema.sql).
      missing = /weights|prefs|42P01|404/.test(String(err && err.message));
      console.warn('[weight] sync failed — offline, or the weights table is missing in Supabase (run schema.sql):', err);
      window.renderWeight?.();
    }
  }

  // ============================================================
  // Reading
  // ============================================================
  function sortedDates() { return [...entries.keys()].sort(); }

  // Mean of the weigh-ins in the 7 days ending on `dstr`, or null if none.
  function trendOn(dstr) {
    const from = fmtDate(shiftDays(parseDate(dstr), -6));
    let sum = 0, n = 0;
    for (const [d, kg] of entries) if (d >= from && d <= dstr) { sum += kg; n++; }
    return n ? round1(sum / n) : null;
  }

  function latest() {
    const dates = sortedDates();
    if (!dates.length) return null;
    const date = dates[dates.length - 1];
    return { date, kg: entries.get(date) };
  }

  // ============================================================
  // Writing
  // ============================================================
  function set(dstr, kg) {
    kg = round1(kg);
    entries.set(dstr, kg);
    changed();
    write({ op: 'upsert', date: dstr, kg });
  }
  function remove(dstr) {
    if (!entries.has(dstr)) return;
    entries.delete(dstr);
    changed();
    write({ op: 'delete', date: dstr });
  }
  function setGoal(kg) {
    goal = kg > 0 ? round1(kg) : null;
    if (goal) localStorage.setItem(GOAL_KEY, String(goal)); else localStorage.removeItem(GOAL_KEY);
    changed();
    write({ op: 'goal', kg: goal });
  }

  function init() {
    loadCache();
    sync();
  }

  window.weight = {
    init, sync, set, remove, setGoal, trendOn, latest,
    get: dstr => entries.get(dstr) ?? null,
    dates: sortedDates,
    goal: () => goal,
    missing: () => missing,
  };
})();
