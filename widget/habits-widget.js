// Habits widget for Scriptable (iOS). One square per habit; tap a square to
// tick or untick it for today. See widget/README.md for setup.
//
// Works as a large widget (up to 16 habits), a medium one (up to 8) or a small
// one (progress only; tap it for a list). Run it in the Scriptable app once to
// sign in (emailed code or password, as in the web app).

// ---- Settings -------------------------------------------------------------
// When this runs through loader.js, the loader's settings win (HABITS_SETTINGS),
// so this file can be updated on GitHub without retyping them.
const LOADED = (typeof HABITS_SETTINGS === "object" && HABITS_SETTINGS) || {};
// The site's config.js gives the Supabase URL and public key. Leave both keys
// below empty to read them from there, or fill them in to skip the site.
const SITE_URL = LOADED.SITE_URL || "https://julienvarin.github.io/habits/";
let SUPABASE_URL = "";
let SUPABASE_ANON_KEY = "";
// Your account. If typing in the sign-in boxes doesn't work, put your email
// here (and your password, to skip the emailed code), then run the script.
// Once you're signed in you can clear the password: the widget stays signed in.
const EMAIL = LOADED.EMAIL || "";
const PASSWORD = LOADED.PASSWORD || "";
// ---------------------------------------------------------------------------

const KC_SESSION = "habits.widget.session";
const KC_CONFIG = "habits.widget.config";
const KC_EMAIL = "habits.widget.email";
const fm = FileManager.local();
const CACHE = fm.joinPath(fm.documentsDirectory(), "habits-widget-cache.json");

const params = args.queryParameters || {};
const inWidget = config.runsInWidget;
const family = inWidget ? config.widgetFamily : (params.size || "large");

// ---- Dates (local time, like app.js) ----
const pad = n => String(n).padStart(2, "0");
const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function mondayOf(d) {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  r.setDate(r.getDate() - ((r.getDay() + 6) % 7));
  return r;
}

// ---- Config ----
async function loadConfig() {
  if (SUPABASE_URL && SUPABASE_ANON_KEY) return;
  try {
    const r = new Request(SITE_URL.replace(/\/?$/, "/") + "config.js");
    r.timeoutInterval = 10;
    const js = await r.loadString();
    const url = /SUPABASE_URL\s*=\s*["']([^"']+)["']/.exec(js);
    const key = /SUPABASE_ANON_KEY\s*=\s*["']([^"']+)["']/.exec(js);
    if (url && key && !/REPLACE_ME/.test(url[1] + key[1])) {
      SUPABASE_URL = url[1];
      SUPABASE_ANON_KEY = key[1];
      Keychain.set(KC_CONFIG, JSON.stringify({ url: url[1], key: key[1] }));
      return;
    }
  } catch (e) { /* offline: fall back to the saved copy */ }
  if (Keychain.contains(KC_CONFIG)) {
    const c = JSON.parse(Keychain.get(KC_CONFIG));
    SUPABASE_URL = c.url;
    SUPABASE_ANON_KEY = c.key;
    return;
  }
  throw new Error("No Supabase settings: set SITE_URL or the keys at the top of the script.");
}

// ---- Auth (Supabase email code, as in supabase.js) ----
let session = null;
if (Keychain.contains(KC_SESSION)) {
  try { session = JSON.parse(Keychain.get(KC_SESSION)); } catch (e) { session = null; }
}

function saveSession(data) {
  session = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
  };
  Keychain.set(KC_SESSION, JSON.stringify(session));
}

function clearSession() {
  session = null;
  if (Keychain.contains(KC_SESSION)) Keychain.remove(KC_SESSION);
}

async function authReq(path, body) {
  const r = new Request(SUPABASE_URL + "/auth/v1" + path);
  r.method = "POST";
  r.headers = { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" };
  r.body = JSON.stringify(body);
  r.timeoutInterval = 15;
  const data = await r.loadJSON().catch(() => ({}));
  const status = r.response && r.response.statusCode;
  if (!status || status >= 300) {
    const err = new Error(data.msg || data.error_description || data.message || ("HTTP " + status));
    err.status = status;
    throw err;
  }
  return data;
}

async function refresh() {
  try {
    saveSession(await authReq("/token?grant_type=refresh_token", { refresh_token: session.refresh_token }));
  } catch (e) {
    if (e.status === 400 || e.status === 401) clearSession();
    throw e;
  }
}

async function accessToken() {
  if (!session) return null;
  if (session.expires_at - 60 < Date.now() / 1000) await refresh();
  return session && session.access_token;
}

// Asks for one line of text; re-asks while it's empty. Returns the text, or
// { choice: i } for one of `extra` buttons, or null when cancelled.
async function ask(title, message, placeholder, value, keyboard, extra) {
  let empty = 0;
  for (;;) {
    const a = new Alert();
    a.title = title;
    a.message = message;
    const f = keyboard === "password" ? a.addSecureTextField(placeholder, value || "") : a.addTextField(placeholder, value || "");
    if (keyboard === "email") f.setEmailAddressKeyboard();
    if (keyboard === "number") f.setNumberPadKeyboard();
    a.addAction("OK");
    (extra || []).forEach(x => a.addAction(x));
    a.addCancelAction("Cancel");
    const i = await a.presentAlert();
    if (i === -1) return null;
    if (i > 0) return { choice: i - 1 };
    const v = (a.textFieldValue(0) || "").trim();
    if (v) return v;
    if (++empty >= 2) {
      const n = new Alert();
      n.title = "Nothing came through";
      n.message = "Scriptable didn't pass on what you typed. Put your email and password in the EMAIL and PASSWORD lines at the top of the script, then run it again.";
      n.addAction("OK");
      await n.presentAlert();
      return null;
    }
  }
}

// Same two ways in as the web app: an emailed code, or the account password.
async function signIn() {
  if (EMAIL.trim() && PASSWORD) {
    saveSession(await authReq("/token?grant_type=password", { email: EMAIL.trim(), password: PASSWORD }));
    return true;
  }
  const last = Keychain.contains(KC_EMAIL) ? Keychain.get(KC_EMAIL) : "";
  const email = EMAIL.trim() || await ask("Sign in to Habits", "Your account email.", "you@example.com", last, "email");
  if (!email) return false;
  Keychain.set(KC_EMAIL, email);

  let usePassword = false;
  const how = new Alert();
  how.title = "Sign in to Habits";
  how.message = email;
  how.addAction("Email me a code");
  how.addAction("Use password");
  how.addCancelAction("Cancel");
  const h = await how.presentAlert();
  if (h === -1) return false;
  usePassword = h === 1;

  if (!usePassword) {
    await authReq("/otp", { email, create_user: false });
    const code = await ask("Enter the code",
      "Sent to " + email + ". It can take a minute; check spam too.",
      "123456", "", "number", ["Use password instead"]);
    if (!code) return false;
    if (typeof code === "string") {
      saveSession(await authReq("/verify", { type: "email", email, token: code.replace(/\s/g, "") }));
      return true;
    }
  }

  const pw = await ask("Password", email, "Password", "", "password");
  if (!pw || typeof pw !== "string") return false;
  saveSession(await authReq("/token?grant_type=password", { email, password: pw }));
  return true;
}

// ---- REST ----
async function rest(path, method, body, prefer, retried) {
  const token = await accessToken();
  if (!token) throw Object.assign(new Error("Not signed in"), { signedOut: true });
  const r = new Request(SUPABASE_URL + "/rest/v1" + path);
  r.method = method || "GET";
  r.headers = { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + token, "Content-Type": "application/json" };
  if (prefer) r.headers.Prefer = prefer;
  if (body) r.body = JSON.stringify(body);
  r.timeoutInterval = 15;
  const txt = await r.loadString();
  const status = r.response.statusCode;
  if (status === 401 && !retried) {
    await refresh();
    return rest(path, method, body, prefer, true);
  }
  if (status >= 300) throw new Error(status + " " + txt);
  return txt ? JSON.parse(txt) : null;
}

async function fetchState() {
  const monday = fmtDate(mondayOf(new Date()));
  const [habits, entries] = await Promise.all([
    rest("/habits?select=id,name,color,icon,short_label,per_week&archived=eq.false&order=sort_order.asc,created_at.asc"),
    rest("/entries?select=habit_id,date&date=gte." + monday),
  ]);
  const data = { habits, entries, fetchedAt: Date.now() };
  fm.writeString(CACHE, JSON.stringify(data));
  return data;
}

function readCache() {
  try { return fm.fileExists(CACHE) ? JSON.parse(fm.readString(CACHE)) : null; } catch (e) { return null; }
}

// Tick or untick a habit for today, and keep the cache in step so a widget
// refresh that can't reach the network still shows the change.
async function toggle(habitId) {
  const today = fmtDate(new Date());
  const q = "?habit_id=eq." + encodeURIComponent(habitId) + "&date=eq." + today;
  const existing = await rest("/entries" + q + "&select=habit_id");
  const nowOn = !(existing && existing.length);
  if (nowOn) await rest("/entries", "POST", { habit_id: habitId, date: today }, "resolution=ignore-duplicates");
  else await rest("/entries" + q, "DELETE");
  return nowOn;
}

// ---- Habit helpers (mirroring app.js) ----
const isWeekly = h => h.per_week >= 1 && h.per_week <= 6;
const habitWord = h => (h.short_label || "").trim() || String(h.name || "").trim().split(/\s+/)[0] || "";
const habitIcon = h => h.icon || "⭐";

function model(data) {
  const today = fmtDate(new Date());
  const done = new Set();
  const week = {};
  for (const e of data.entries) {
    if (e.date === today) done.add(e.habit_id);
    week[e.habit_id] = (week[e.habit_id] || 0) + 1;
  }
  const habits = data.habits.map(h => ({
    ...h,
    on: done.has(h.id),
    weekCount: week[h.id] || 0,
    weekMet: isWeekly(h) && (week[h.id] || 0) >= h.per_week,
  }));
  const daily = habits.filter(h => !isWeekly(h));
  return { habits, done: daily.filter(h => h.on).length, total: daily.length };
}

// ---- Drawing ----
// The web app's colours (styles.css: --surface, light and dark).
const SURFACE_LIGHT = "#ffffff";
const SURFACE_DARK = "#16161d";
const BG = Color.dynamic(new Color(SURFACE_LIGHT), new Color(SURFACE_DARK));
const TEXT = Color.dynamic(new Color("#1c1c1e"), new Color("#ffffff"));
const MUTED = Color.dynamic(new Color("#8e8e93"), new Color("#98989d"));
const GREEN = new Color("#34c759");

function runUrl(query) {
  return "scriptable:///run/" + encodeURIComponent(Script.name()) + (query ? "?" + query : "");
}

// Widget size in points, from the screen width (Apple's sizes differ by phone).
function widgetSize(fam) {
  const w = Device.screenSize().width;
  const big = w >= 428 ? [364, 382] : w >= 414 ? [360, 379] : w >= 390 ? [338, 354] : w >= 375 ? [329, 345] : [292, 311];
  if (fam === "medium") return [big[0], Math.round(big[1] * 0.46)];
  return big;
}

function header(w, m, compact) {
  const row = w.addStack();
  row.centerAlignContent();
  const t = row.addText("Today");
  t.font = Font.boldSystemFont(compact ? 15 : 17);
  t.textColor = TEXT;
  row.addSpacer();
  const all = m.total && m.done === m.total;
  const s = row.addText(all ? "All done ✓" : m.total ? `${m.done} of ${m.total}` : "");
  s.font = Font.semiboldSystemFont(compact ? 13 : 15);
  s.textColor = all ? GREEN : MUTED;
}

// Mix two #rrggbb colours: t = share of `a` (like CSS color-mix).
function mix(a, b, t) {
  const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return "#" + x.map((v, i) => Math.round(v * t + y[i] * (1 - t)).toString(16).padStart(2, "0")).join("");
}
const tint = (hex, t) => Color.dynamic(new Color(mix(hex, SURFACE_LIGHT, t)), new Color(mix(hex, SURFACE_DARK, t)));

// One square, styled like the quick check (.qc-sq in styles.css): a faint
// tint and a coloured border to do, the habit's colour with a ✓ badge when done.
function cell(row, h, cw, ch) {
  const hex = /^#[0-9a-f]{6}$/i.test(h.color || "") ? h.color : "#34c759";
  const color = new Color(hex);
  const c = row.addStack();
  c.layoutVertically();
  c.size = new Size(cw, ch);
  c.cornerRadius = Math.round(Math.min(cw, ch) * 0.26);
  c.url = runUrl("tick=" + encodeURIComponent(h.id) + "&size=" + family);
  if (h.on) {
    c.backgroundColor = color;
  } else {
    c.backgroundColor = tint(hex, h.weekMet ? 0.35 : 0.12);
    c.borderColor = tint(hex, 0.45);
    c.borderWidth = 2;
  }
  c.setPadding(4, 4, 4, 4);

  // Top row: the ✓ badge, or the same height left empty so the emoji stays centred.
  const badgeSize = Math.max(14, Math.round(Math.min(cw, ch) * 0.24));
  const top = c.addStack();
  top.size = new Size(cw - 8, badgeSize);
  top.addSpacer();
  if (h.on) {
    const b = top.addStack();
    b.size = new Size(badgeSize, badgeSize);
    b.cornerRadius = badgeSize / 2;
    b.backgroundColor = Color.white();
    b.centerAlignContent();
    const t = b.addText("✓");
    t.font = Font.heavySystemFont(Math.round(badgeSize * 0.62));
    t.textColor = color;
  }

  c.addSpacer();
  const iconRow = c.addStack();
  iconRow.addSpacer();
  const ico = iconRow.addText(habitIcon(h));
  ico.font = Font.systemFont(Math.round(Math.min(cw, ch) * 0.36));
  iconRow.addSpacer();

  c.addSpacer(2);
  const wordRow = c.addStack();
  wordRow.addSpacer();
  const word = wordRow.addText(habitWord(h) + (isWeekly(h) ? ` ${Math.min(h.weekCount, h.per_week)}/${h.per_week}` : ""));
  word.font = Font.boldSystemFont(Math.max(10, Math.round(Math.min(cw, ch) * 0.15)));
  word.textColor = h.on ? new Color("#ffffff", 0.9) : MUTED;
  word.lineLimit = 1;
  word.minimumScaleFactor = 0.6;
  wordRow.addSpacer();
  c.addSpacer();
}

function grid(w, m, fam) {
  const [W, H] = widgetSize(fam);
  const pad = fam === "medium" ? 12 : 14;
  const gap = 10;
  const maxCells = fam === "medium" ? 8 : 16;
  const habits = m.habits.slice(0, maxCells);
  const n = habits.length;
  const cols = fam === "medium" ? Math.min(4, Math.max(1, Math.ceil(n / 2)))
    : n <= 4 ? 2 : n <= 6 ? 3 : 4;
  const rows = Math.ceil(n / cols);
  const headerH = fam === "medium" ? 22 : 30;
  const cw = Math.floor((W - 2 * pad - (cols - 1) * gap) / cols);
  const ch = Math.min(Math.floor((H - 2 * pad - headerH - (rows - 1) * gap) / rows), Math.round(cw * 1.4));

  w.addSpacer(fam === "medium" ? 6 : 10);
  for (let r = 0; r < rows; r++) {
    if (r) w.addSpacer(gap);
    const row = w.addStack();
    for (let i = 0; i < cols; i++) {
      const h = habits[r * cols + i];
      if (i) row.addSpacer(gap);
      if (h) cell(row, h, cw, ch);
      else { const blank = row.addStack(); blank.size = new Size(cw, ch); }
    }
  }
  w.addSpacer();
}

function message(w, title, body) {
  w.addSpacer();
  const t = w.addText(title);
  t.font = Font.boldSystemFont(16);
  t.textColor = TEXT;
  if (body) {
    w.addSpacer(4);
    const b = w.addText(body);
    b.font = Font.systemFont(13);
    b.textColor = MUTED;
  }
  w.addSpacer();
}

function buildWidget(m, opts) {
  const w = new ListWidget();
  w.backgroundColor = BG;
  w.url = runUrl("");
  w.setPadding(family === "medium" ? 12 : 14, family === "medium" ? 12 : 14, family === "medium" ? 12 : 14, family === "medium" ? 12 : 14);
  // Re-check every 15 minutes (iOS decides the exact time) and just after midnight.
  const midnight = new Date(); midnight.setHours(24, 0, 30, 0);
  w.refreshAfterDate = new Date(Math.min(Date.now() + 15 * 60 * 1000, +midnight));

  if (opts.signedOut) { message(w, "Habits", "Tap to sign in."); return w; }
  if (!m) { message(w, "Habits", opts.error || "Couldn't load."); return w; }

  if (family === "small") {
    w.addSpacer();
    const big = w.addText(m.total && m.done === m.total ? "✓" : `${m.done}/${m.total}`);
    big.font = Font.boldRoundedSystemFont(40);
    big.textColor = m.total && m.done === m.total ? GREEN : TEXT;
    const sub = w.addText(m.habits.filter(h => !h.on).map(habitIcon).join(" ") || "All done");
    sub.font = Font.systemFont(16);
    sub.lineLimit = 2;
    sub.minimumScaleFactor = 0.6;
    w.addSpacer();
    return w;
  }

  header(w, m, family === "medium");
  if (!m.habits.length) { message(w, "No habits yet", "Add them in the Habits app."); return w; }
  grid(w, m, family);
  if (opts.stale) {
    const s = w.addText("Offline · " + new Date(opts.stale).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    s.font = Font.systemFont(9);
    s.textColor = MUTED;
  }
  return w;
}

async function load() {
  try {
    return { data: await fetchState() };
  } catch (e) {
    if (e.signedOut || !session) return { signedOut: true };
    const cached = readCache();
    return cached ? { data: cached, stale: cached.fetchedAt } : { error: String(e.message || e) };
  }
}

// In the app with no square tapped: a list to tick from (also what the small widget opens).
async function pickFromList() {
  for (;;) {
    const { data } = await load();
    if (!data) return;
    const m = model(data);
    const a = new Alert();
    a.title = m.total && m.done === m.total ? "All done ✓" : `Today · ${m.done} of ${m.total}`;
    m.habits.forEach(h => a.addAction(`${h.on ? "✅" : "⬜️"}  ${habitIcon(h)}  ${h.name}`));
    a.addCancelAction("Done");
    const i = await a.presentSheet();
    if (i === -1) return;
    await toggle(m.habits[i].id);
  }
}

// ---- Main ----
try {
  await loadConfig();

  const signedIn = inWidget || session || await signIn();

  if (!signedIn) {
    // Sign-in cancelled.
  } else if (inWidget) {
    const r = await load();
    Script.setWidget(buildWidget(r.data && model(r.data), r));
  } else if (params.tick) {
    // A square was tapped: toggle it, then show the updated widget.
    await toggle(params.tick);
    const r = await load();
    const w = buildWidget(r.data && model(r.data), r);
    if (family === "medium") await w.presentMedium(); else await w.presentLarge();
  } else {
    await pickFromList();
  }
} catch (e) {
  if (inWidget) {
    const w = new ListWidget();
    w.backgroundColor = BG;
    message(w, "Habits", String(e.message || e));
    Script.setWidget(w);
  } else {
    const a = new Alert();
    a.title = "Habits widget";
    a.message = String(e.message || e);
    a.addAction("OK");
    await a.presentAlert();
  }
}
Script.complete();
