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
