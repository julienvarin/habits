# Home-screen widget (Scriptable)

A large iOS widget with one square per habit: emoji, short word, and the
habit's colour once it's done today. Tap a square to tick it, and tap it again
to untick it. Weekly habits show their count (e.g. `Gym 1/3`) and turn a pale
version of their colour once the week's target is met.

## Setup (about 2 minutes)

1. Install **Scriptable** (free) from the App Store.
2. In Scriptable, tap **+**, paste in all of `habits-widget.js`, and name the
   script **Habits** (tap the title at the top).
3. Tap ▶︎ to run it once. Enter your email, then the 6-digit code you're sent
   (this is the same sign-in as the web app). After that a list of today's
   habits appears, and you can tick them from there too.
4. On the home screen: long-press → **Edit** → **Add Widget** → Scriptable →
   **Large** → Add. Long-press the new widget → **Edit Widget** → Script:
   **Habits**. Leave "When Interacting" on **Run Script**.

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
