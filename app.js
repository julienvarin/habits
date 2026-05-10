(function () {
  // === State ===
  const state = {
    habits: [],
    entries: new Set(), // "habitId|YYYY-MM-DD"
    view: "today",
    loading: true,
  };

  const COLORS = [
    "#22c55e", "#3b82f6", "#a855f7", "#ec4899",
    "#f59e0b", "#ef4444", "#14b8a6", "#eab308",
  ];

  // === Date helpers (local time) ===
  function todayStr() { return dateStr(new Date()); }
  function dateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  function addDays(d, n) {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
  }
  function key(habitId, date) { return habitId + "|" + date; }
  function has(habitId, date) { return state.entries.has(key(habitId, date)); }

  // === Toast ===
  const toastEl = document.getElementById("toast");
  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1800);
  }

  // === Loading ===
  async function load() {
    if (!window.SUPABASE_URL || window.SUPABASE_URL.startsWith("REPLACE_ME")) {
      document.getElementById("view-today").innerHTML =
        `<div class="empty"><h2>Setup needed</h2><p>Edit <code>config.js</code> and paste your Supabase URL and anon key.</p></div>`;
      return;
    }
    try {
      const [habits, entries] = await Promise.all([db.listHabits(), db.listEntries()]);
      state.habits = habits || [];
      state.entries = new Set((entries || []).map(e => key(e.habit_id, e.date)));
      state.loading = false;
      renderAll();
      flushQueue();
    } catch (err) {
      console.error(err);
      document.getElementById("view-today").innerHTML =
        `<div class="empty"><h2>Couldn't load</h2><p>${escapeHtml(String(err.message))}</p></div>`;
    }
  }

  // === Offline queue ===
  const QKEY = "habits.queue";
  function queueWrite(op) {
    const q = JSON.parse(localStorage.getItem(QKEY) || "[]");
    q.push(op);
    localStorage.setItem(QKEY, JSON.stringify(q));
  }
  async function flushQueue() {
    let q = JSON.parse(localStorage.getItem(QKEY) || "[]");
    if (!q.length) return;
    const remaining = [];
    for (const op of q) {
      try {
        if (op.t === "tick") await db.tick(op.habit_id, op.date);
        else if (op.t === "untick") await db.untick(op.habit_id, op.date);
      } catch (e) {
        remaining.push(op);
      }
    }
    localStorage.setItem(QKEY, JSON.stringify(remaining));
  }

  // === Toggle a tick (optimistic) ===
  async function toggle(habit_id, date) {
    const k = key(habit_id, date);
    const wasOn = state.entries.has(k);
    if (wasOn) state.entries.delete(k); else state.entries.add(k);
    renderAll();
    if (navigator.vibrate) navigator.vibrate(10);
    try {
      if (wasOn) await db.untick(habit_id, date);
      else await db.tick(habit_id, date);
    } catch (err) {
      queueWrite({ t: wasOn ? "untick" : "tick", habit_id, date });
      toast("Saved offline — will sync");
    }
  }

  // === Metrics ===
  function ticksFor(habitId) {
    const dates = [];
    for (const k of state.entries) {
      if (k.startsWith(habitId + "|")) dates.push(k.slice(habitId.length + 1));
    }
    dates.sort();
    return dates;
  }
  function currentStreak(habitId) {
    const set = new Set(ticksFor(habitId));
    let d = new Date();
    if (!set.has(dateStr(d))) d = addDays(d, -1); // grace if today not yet ticked
    let n = 0;
    while (set.has(dateStr(d))) { n++; d = addDays(d, -1); }
    return n;
  }
  function longestStreak(habitId) {
    const dates = ticksFor(habitId);
    if (!dates.length) return 0;
    let best = 1, cur = 1;
    for (let i = 1; i < dates.length; i++) {
      const prev = new Date(dates[i - 1]);
      const here = new Date(dates[i]);
      if ((here - prev) / 86400000 === 1) cur++;
      else cur = 1;
      if (cur > best) best = cur;
    }
    return best;
  }
  function rate(habitId, days) {
    const today = new Date();
    let hit = 0;
    for (let i = 0; i < days; i++) {
      if (has(habitId, dateStr(addDays(today, -i)))) hit++;
    }
    return Math.round((hit / days) * 100);
  }

  // === Render: Today ===
  function renderToday() {
    const root = document.getElementById("view-today");
    const today = todayStr();

    if (!state.habits.length) {
      root.innerHTML = `<div class="empty"><h2>No habits yet</h2><p>Tap the <b>+</b> button to add one.</p></div>`;
      return;
    }

    const last7 = [];
    for (let i = 6; i >= 0; i--) last7.push(dateStr(addDays(new Date(), -i)));

    root.innerHTML = state.habits.map(h => {
      const done = has(h.id, today);
      const cells = last7.map(d => {
        const on = has(h.id, d);
        const isToday = d === today;
        return `<div class="cell ${on ? "on" : ""} ${isToday ? "today" : ""}"></div>`;
      }).join("");
      return `
        <div class="habit-row ${done ? "done" : ""}" style="color:${h.color}" data-id="${h.id}" data-action="toggle">
          <div class="tick"></div>
          <div class="habit-body">
            <div class="habit-name">${escapeHtml(h.name)}</div>
            <div class="habit-meta">🔥 ${currentStreak(h.id)} day${currentStreak(h.id) === 1 ? "" : "s"} · ${rate(h.id, 7)}% this week</div>
          </div>
          <div class="week-strip">${cells}</div>
          <button class="habit-edit-btn" data-action="edit" data-id="${h.id}" aria-label="Edit">✎</button>
        </div>`;
    }).join("");
  }

  // === Render: History ===
  function renderHistory() {
    const root = document.getElementById("view-history");
    if (!state.habits.length) {
      root.innerHTML = `<div class="empty"><h2>No habits yet</h2></div>`;
      return;
    }
    const today = new Date();
    const days = 90;
    // Build columns: oldest first. Pad start so weeks line up (Mon=0..Sun=6).
    const cells = [];
    for (let i = days - 1; i >= 0; i--) cells.push(addDays(today, -i));
    const startWeekday = (cells[0].getDay() + 6) % 7; // Mon=0
    const padStart = startWeekday;

    root.innerHTML = state.habits.map(h => {
      const grid = [];
      for (let i = 0; i < padStart; i++) grid.push(`<div class="day future"></div>`);
      for (const d of cells) {
        const ds = dateStr(d);
        const on = has(h.id, ds);
        const isToday = ds === todayStr();
        grid.push(`<div class="day ${on ? "on" : ""} ${isToday ? "today" : ""}" data-action="toggle-day" data-id="${h.id}" data-date="${ds}" title="${ds}"></div>`);
      }
      return `
        <div class="history-card" style="color:${h.color}">
          <div class="head">
            <span class="swatch"></span>
            <h3>${escapeHtml(h.name)}</h3>
            <span style="color:var(--fg-dim);font-size:12px;">last 90d</span>
          </div>
          <div class="heatmap">${grid.join("")}</div>
        </div>`;
    }).join("");
  }

  // === Render: Stats ===
  function renderStats() {
    const root = document.getElementById("view-stats");
    if (!state.habits.length) {
      root.innerHTML = `<div class="empty"><h2>No habits yet</h2></div>`;
      return;
    }
    const today = todayStr();
    const totalToday = state.habits.filter(h => has(h.id, today)).length;
    const totalAll = state.entries.size;
    const pct = state.habits.length ? Math.round((totalToday / state.habits.length) * 100) : 0;

    const overview = `
      <div class="stats-grid">
        <div class="stat"><div class="num">${totalToday}/${state.habits.length}</div><div class="label">Done today</div></div>
        <div class="stat"><div class="num">${pct}%</div><div class="label">Today's completion</div></div>
        <div class="stat"><div class="num">${totalAll}</div><div class="label">Total ticks ever</div></div>
        <div class="stat"><div class="num">${state.habits.length}</div><div class="label">Active habits</div></div>
      </div>`;

    const cards = state.habits.map(h => `
      <div class="stats-card" style="color:${h.color}">
        <div class="head">
          <span class="swatch"></span>
          <h3>${escapeHtml(h.name)}</h3>
        </div>
        <div class="stats-row">
          <div><div class="v">${currentStreak(h.id)}</div><div class="k">Current streak</div></div>
          <div><div class="v">${longestStreak(h.id)}</div><div class="k">Longest</div></div>
          <div><div class="v">${rate(h.id, 7)}%</div><div class="k">Last 7d</div></div>
          <div><div class="v">${rate(h.id, 30)}%</div><div class="k">Last 30d</div></div>
        </div>
      </div>`).join("");

    root.innerHTML = overview + cards;
  }

  function renderAll() {
    renderToday();
    renderHistory();
    renderStats();
  }

  // === Modal: add/edit habit ===
  function openHabitModal(habit) {
    const isNew = !habit;
    const data = habit ? { ...habit } : { name: "", color: COLORS[state.habits.length % COLORS.length] };
    const root = document.getElementById("modal-root");
    root.innerHTML = `
      <div class="modal-bg" data-close>
        <div class="modal" onclick="event.stopPropagation()">
          <h2>${isNew ? "New habit" : "Edit habit"}</h2>
          <label for="m-name">Name</label>
          <input id="m-name" type="text" maxlength="60" placeholder="e.g. Read 20 minutes" value="${escapeAttr(data.name)}" />
          <label>Color</label>
          <div class="color-picker">
            ${COLORS.map(c => `<div class="swatch ${c === data.color ? "active" : ""}" style="background:${c}" data-color="${c}"></div>`).join("")}
          </div>
          <div class="modal-actions">
            ${!isNew ? `<button class="btn btn-danger" data-do="delete">Delete</button>` : ""}
            <button class="btn" data-close>Cancel</button>
            <button class="btn btn-primary" data-do="save">${isNew ? "Add" : "Save"}</button>
          </div>
        </div>
      </div>`;

    const input = root.querySelector("#m-name");
    setTimeout(() => input.focus(), 50);

    let chosenColor = data.color;
    root.querySelectorAll(".color-picker .swatch").forEach(el => {
      el.addEventListener("click", () => {
        chosenColor = el.dataset.color;
        root.querySelectorAll(".color-picker .swatch").forEach(s => s.classList.remove("active"));
        el.classList.add("active");
      });
    });

    root.addEventListener("click", async (e) => {
      if (e.target.matches("[data-close]")) return closeModal();
      const action = e.target.dataset.do;
      if (!action) return;

      if (action === "save") {
        const name = input.value.trim();
        if (!name) { input.focus(); return; }
        if (isNew) {
          const sort_order = state.habits.length;
          try {
            const created = await db.addHabit(name, chosenColor, sort_order);
            state.habits.push(created);
          } catch (err) { toast("Couldn't save"); console.error(err); }
        } else {
          try {
            await db.updateHabit(habit.id, { name, color: chosenColor });
            const h = state.habits.find(x => x.id === habit.id);
            if (h) { h.name = name; h.color = chosenColor; }
          } catch (err) { toast("Couldn't save"); console.error(err); }
        }
        closeModal();
        renderAll();
      } else if (action === "delete") {
        if (!confirm(`Delete "${habit.name}" and all its history?`)) return;
        try {
          await db.deleteHabit(habit.id);
          state.habits = state.habits.filter(x => x.id !== habit.id);
          for (const k of [...state.entries]) {
            if (k.startsWith(habit.id + "|")) state.entries.delete(k);
          }
        } catch (err) { toast("Couldn't delete"); console.error(err); }
        closeModal();
        renderAll();
      }
    }, { once: false });
  }
  function closeModal() {
    document.getElementById("modal-root").innerHTML = "";
  }

  // === Event delegation ===
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-action]");
    if (t) {
      const action = t.dataset.action;
      const id = t.dataset.id;
      if (action === "toggle") {
        // Don't toggle if user clicked the edit pencil
        if (e.target.closest('[data-action="edit"]')) return;
        toggle(id, todayStr());
      } else if (action === "edit") {
        e.stopPropagation();
        openHabitModal(state.habits.find(h => h.id === id));
      } else if (action === "toggle-day") {
        toggle(id, t.dataset.date);
      }
    }
  });

  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      const v = btn.dataset.view;
      state.view = v;
      document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t === btn));
      document.querySelectorAll(".view").forEach(s => s.classList.remove("active"));
      document.getElementById("view-" + v).classList.add("active");
      document.getElementById("page-title").textContent =
        v === "today" ? "Today" : v === "history" ? "History" : "Stats";
    });
  });

  document.getElementById("fab").addEventListener("click", () => openHabitModal(null));

  // === Date label ===
  document.getElementById("date-label").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "long", month: "short", day: "numeric"
  });

  // === Helpers ===
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  // === Init ===
  load();
  // Refresh on focus to catch ticks made on another device
  window.addEventListener("focus", () => { if (!state.loading) load(); });
})();
