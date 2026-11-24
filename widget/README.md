# Home-screen widget (Scriptable)

A large iOS widget with one square per habit: emoji, short word, and the
habit's colour once it's done today. Tap a square to tick it, and tap it again
to untick it. Weekly habits show their count (e.g. `Gym 1/3`) and turn a pale
version of their colour once the week's target is met.

## Setup (about 2 minutes)

1. Install **Scriptable** (free) from the App Store.
2. In Scriptable, tap **+**, paste in all of `loader.js` (not
   `habits-widget.js`), and name the script **Habits** (tap the title).
3. Fill in `EMAIL` and `PASSWORD` at the top, then tap ▶︎ to run it. A list of
   today's habits appears; you can tick them from there too. Once you're
   signed in you can clear the password.
4. On the home screen: long-press → **Edit** → **Add Widget** → Scriptable →
   **Large** → Add. Long-press the new widget → **Edit Widget** → Script:
   **Habits**. Leave "When Interacting" on **Run Script**.

## Updating the widget

The loader downloads `widget/habits-widget.js` from the website
(`SITE_URL` + `widget/habits-widget.js`) every time it runs, so to change the
widget, edit that file on your computer and push it to `main`. Once GitHub
Pages has deployed (a minute or two), the next widget refresh or tap uses the
new code. Nothing needs pasting on the phone again. Offline, the loader runs
the last copy it downloaded.

You can also paste `habits-widget.js` itself into Scriptable; its settings
then go at its own top, and it won't update by itself.

It reads the Supabase URL and public key from the deployed site's `config.js`
(`SITE_URL` at the top of the script). If the site moves, change `SITE_URL`,
or fill in `SUPABASE_URL` and `SUPABASE_ANON_KEY` there.

## Sizes

- **Large:** up to 16 habits (2, 3 or 4 columns depending on how many you have).
- **Medium:** up to 8 habits, in one or two rows.
- **Small:** shows the day's count and the emojis still to do. iOS allows only
  one tap target on a small widget, so tapping it opens the list.

## How a tap works

Scriptable widgets can't run code in the background. A tap opens Scriptable,
which ticks the habit and shows the updated grid. Swipe up to go back home.
The widget itself updates when iOS next refreshes it: Scriptable asks for one
every 15 minutes and just after midnight, but iOS sets the exact time. When the
phone is offline, the widget shows the last data it loaded, marked "Offline".
