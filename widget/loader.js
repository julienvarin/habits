// Habits widget loader for Scriptable. Paste this once; it downloads the
// latest widget code from the website on every run, so changes pushed to
// GitHub (widget/habits-widget.js on main) reach the phone on their own.
// Offline, it runs the last copy it downloaded.

// ---- Settings: fill these in once ----
const EMAIL = "";
const PASSWORD = ""; // optional; clear it once you're signed in
const SITE_URL = "https://julienvarin.github.io/habits/";
// --------------------------------------

const CODE_URL = SITE_URL.replace(/\/?$/, "/") + "widget/habits-widget.js";
const fm = FileManager.local();
const saved = fm.joinPath(fm.documentsDirectory(), "habits-widget-code.js");

let code = null;
try {
  const r = new Request(CODE_URL + "?t=" + Date.now()); // skip caches
  r.timeoutInterval = 8;
  const txt = await r.loadString();
  if (r.response.statusCode === 200 && txt.includes("Habits widget")) {
    code = txt;
    fm.writeString(saved, txt);
  }
} catch (e) { /* offline */ }
if (!code && fm.fileExists(saved)) code = fm.readString(saved);

if (!code) {
  const msg = "Couldn't download the widget code from " + CODE_URL;
  if (config.runsInWidget) {
    const w = new ListWidget();
    w.addText(msg).font = Font.systemFont(12);
    Script.setWidget(w);
  } else {
    const a = new Alert();
    a.title = "Habits widget";
    a.message = msg;
    a.addAction("OK");
    await a.presentAlert();
  }
  Script.complete();
} else {
  globalThis.HABITS_SETTINGS = { EMAIL, PASSWORD, SITE_URL };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction(code)();
}
