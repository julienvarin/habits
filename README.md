# Habits

Personal habit tracker. Vanilla HTML/CSS/JS + Supabase. Hosted on GitHub Pages.

## Setup (one-time)

1. Create a free project at https://supabase.com.
2. In the Supabase dashboard → SQL editor → paste `schema.sql` → Run.
3. Settings → API → copy the **Project URL** and **anon public key** into `config.js`.
4. Open `index.html` locally to verify, or deploy via GitHub Pages.

## Morning tab function (Supabase, free tier)

The calendar and U7 departures are fetched by a Supabase Edge Function
(`supabase/functions/morning`), because browsers can't read those feeds
directly and free CORS proxies keep breaking. Weather goes straight to
wttr.in, falling back to Open-Meteo.

The GitHub Pages workflow deploys it automatically once these repo secrets exist
(Settings → Secrets and variables → Actions):

- `SUPABASE_ACCESS_TOKEN`: create one at https://supabase.com/dashboard/account/tokens
- `JULIEN_CALENDAR_ICAL_URL`: Google Calendar → Settings → your calendar →
  "Secret address in iCal format" (pushed to the function as its `ICAL_URL` secret)
- `SUPABASE_URL`: already used for `config.js`

Manual alternative:

```sh
npx supabase login
npx supabase functions deploy morning --project-ref <ref> --no-verify-jwt --use-api
npx supabase secrets set --project-ref <ref> ICAL_URL='<secret ical url>'
```

`<ref>` is the subdomain of your Supabase URL. Edge Functions are included in
the free plan (500k invocations/month).

## Local dev

Just open `index.html` in a browser, or:

```sh
python3 -m http.server 8000
```

## Deploy

Repo is served from `main` branch root via GitHub Pages.
