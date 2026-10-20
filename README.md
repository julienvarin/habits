# Habits

Personal habit tracker. Vanilla HTML/CSS/JS + Supabase. Hosted on GitHub Pages.

## Setup (one-time)

1. Create a free project at https://supabase.com.
2. In the Supabase dashboard → SQL editor → paste `schema.sql` → Run.
3. Settings → API → copy the **Project URL** and **anon public key** into `config.js`.
4. Open `index.html` locally to verify, or deploy via GitHub Pages.

## Sign-in

The app signs in with an emailed 6-digit code (Supabase Auth, free tier), and
the database only answers to emails listed in `allowed_users` (see the end of
`schema.sql`). One-time setup in the Supabase dashboard:

1. **SQL editor:** run `schema.sql`, then add your email:
   `insert into allowed_users (email) values ('you@example.com');`
2. **Authentication → Users → Add user → Create new user:** your email, any
   password, tick "Auto Confirm User".
3. **Authentication → Sign In / Providers:** turn off "Allow new users to sign up".
4. **Authentication → Emails → Magic Link** template: put the code in the body,
   e.g. `<p>Your Habits code: <strong>{{ .Token }}</strong></p>`.
   (A code rather than a link, because a link would open Safari instead of the
   home-screen app.)

## Database updates

When `SUPABASE_ACCESS_TOKEN` is set (below), every deploy also runs `schema.sql`
against the database through the Supabase Management API. The file is
idempotent, so new tables (e.g. `weights` and `prefs` for the weight tracker)
appear on their own. Without the token, paste `schema.sql` into the SQL editor.

## Supabase functions (free tier)

- `morning`: calendar (iCal), U7 departures and news feeds for the Morning section of Today,
  fetched server-side because browsers can't read them directly.
- `reminder`: the 23:00 push notification when habits are left unticked.

The GitHub Pages workflow deploys both once these repo secrets exist
(Settings → Secrets and variables → Actions):

- `SUPABASE_ACCESS_TOKEN`: create one at https://supabase.com/dashboard/account/tokens
- `JULIEN_CALENDAR_ICAL_URL`: Google Calendar → Settings → your calendar →
  "Secret address in iCal format" (pushed to the function as its `ICAL_URL` secret)
- `SUPABASE_URL`: already used for `config.js`

Manual alternative:

```sh
npx supabase login
npx supabase functions deploy --project-ref <ref> --no-verify-jwt --use-api
npx supabase secrets set --project-ref <ref> ICAL_URL='<secret ical url>'
```

`<ref>` is the subdomain of your Supabase URL.

### Reminder schedule

In the SQL editor (replace `<ref>`), once:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('habits-reminder', '*/15 21,22 * * *', $$
  select net.http_post(
    url := 'https://<ref>.supabase.co/functions/v1/reminder',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  )
$$);
```

The schedule is in UTC and covers 23:00 Berlin in both summer and winter time;
the function only sends at 23:00 local time, at most once a day. Then turn the
reminder on from Stats → Daily reminder (on iPhone, from the home-screen app).

## Local dev

Just open `index.html` in a browser, or:

```sh
python3 -m http.server 8000
```

## Deploy

Repo is served from `main` branch root via GitHub Pages.
