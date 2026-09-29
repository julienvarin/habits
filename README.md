# Habits

Personal habit tracker. Vanilla HTML/CSS/JS + Supabase. Hosted on GitHub Pages.

## Setup (one-time)

1. Create a free project at https://supabase.com.
2. In the Supabase dashboard → SQL editor → paste `schema.sql` → Run.
3. Settings → API → copy the **Project URL** and **anon public key** into `config.js`.
4. Open `index.html` locally to verify, or deploy via GitHub Pages.

## Local dev

Just open `index.html` in a browser, or:

```sh
python3 -m http.server 8000
```

## Deploy

Repo is served from `main` branch root via GitHub Pages.

## Morning tab proxy (recommended)

Google Calendar's iCal feed and most RSS feeds don't send CORS headers, and free
public CORS proxies keep breaking (corsproxy.io now returns 401). The Morning tab
first tries a small Supabase Edge Function (`supabase/functions/morning-proxy`)
and only falls back to public proxies when it isn't deployed.

To deploy it automatically, add a `SUPABASE_ACCESS_TOKEN` repo secret
(supabase.com → Account → Access Tokens). The Pages workflow then sets the
`ICAL_URL` function secret from `JULIEN_CALENDAR_ICAL_URL` and deploys the function.
Manual alternative:

```sh
supabase secrets set ICAL_URL="<your secret iCal URL>" --project-ref <ref>
supabase functions deploy morning-proxy --no-verify-jwt --project-ref <ref>
```
